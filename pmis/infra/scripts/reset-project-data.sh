#!/usr/bin/env bash
# GSDN Workspace: reset the PROJECT DATA of a server, keeping users, accounts and configuration (owner request, scope approved 2026-11-23).
# The contract (every table, KEEP / DELETE / MIXED, with the reason) is docs/ops/data-reset.md; the database part is reset-project-data.sql, a
# wrapper of data_reset_core (migration 0146). With two or more System Admins the same reset is also offered in Settings > Data reset (four eyes).
#
# Run as root on the server:
#   sudo bash pmis/infra/scripts/reset-project-data.sh                       dry run (the default): counts per table, changes nothing
#   sudo bash pmis/infra/scripts/reset-project-data.sh --execute --reason "Owner request 2026-11-23: start the real data load"
#
# --execute asks for the confirmation phrase "RESET <database>" on the terminal. Without a terminal it refuses, unless both
# --yes-i-have-a-backup <dump> (an existing pg_dump -Fc file that pg_restore --list reads) and --confirm "RESET <database>" are given.
# With --execute, in this order, stopping at the first failure:
#   1. checks the free space in the backup directory (database size + documents size + 10 % + 256 MiB);
#   2. stops the API (gsdn-pmis-api) and waits until no application connection is left (it is started again on exit, whatever happens);
#   3. takes a full backup: pg_dump -Fc to /var/backups/gsdn-pmis/pre-reset-<timestamp>.dump, verified with pg_restore --list,
#      and a tar of the documents directory (STORAGE_DIR, default /var/lib/gsdn-pmis/files), verified with tar -t;
#   4. runs reset-project-data.sql in ONE transaction (deletes, keep checks, ends every session, one audit row on the hash chain): it calls
#      data_reset_core (migration 0146), the same database function as Settings > Data reset, so both use one plan; it refuses while a reset
#      approved in Settings waits to run or runs, and Settings refuses while this one runs;
#   5. moves (never deletes) the stored files of the deleted rows to <STORAGE_DIR>-pre-reset-<timestamp> on the same filesystem;
#      as the owner of the store (runuser), refusing symbolic links, ".." and paths that leave the store (reset-project-data-quarantine.sh);
#   6. starts the API and prints the summary, the restore commands and how to delete the quarantine later.
#
# Environment overrides (tests and non-standard installations): CONF_DIR (default /etc/gsdn-pmis), BACKUP_DIR (default /var/backups/gsdn-pmis),
# SERVICE (default gsdn-pmis-api), PSQL_CMD (default: sudo -u postgres psql -p <port> -d <database>; when set it must name the database itself).
set -euo pipefail

CONF_DIR=${CONF_DIR:-/etc/gsdn-pmis}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/gsdn-pmis}
SERVICE=${SERVICE:-gsdn-pmis-api}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SQL_FILE=$HERE/reset-project-data.sql
# shellcheck source=SCRIPTDIR/reset-project-data-quarantine.sh
. "$HERE/reset-project-data-quarantine.sh"   # quarantine_files: the symlink-safe move, run as the owner of the store

die() { echo "ERROR: $*" >&2; exit 1; }
usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit "${1:-0}"
}

MODE=dry REASON='' OWN_BACKUP='' CONFIRM=''
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) MODE=dry ;;
    --execute) MODE=execute ;;
    --reason) [[ $# -ge 2 ]] || die "--reason needs a text"; REASON=$2; shift ;;
    --yes-i-have-a-backup) [[ $# -ge 2 ]] || die "--yes-i-have-a-backup needs the path of a pg_dump -Fc file"; OWN_BACKUP=$2; shift ;;
    --confirm) [[ $# -ge 2 ]] || die "--confirm needs the phrase"; CONFIRM=$2; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 2 ;;
  esac
  shift
done

[[ -n ${PSQL_CMD-} || $EUID -eq 0 ]] || die "Run as root: sudo bash $0 ${MODE/dry/--dry-run}"
[[ -r $SQL_FILE ]] || die "$SQL_FILE is missing (run the script from the repository checkout)."
[[ -r $CONF_DIR/pmis.env ]] || die "No installation found ($CONF_DIR/pmis.env is missing)."

env_value() { sed -n "s/^$1=//p" "$CONF_DIR/pmis.env" | tail -n 1; }
URL=$(env_value DATABASE_URL)
[[ -n $URL ]] || die "DATABASE_URL is missing in $CONF_DIR/pmis.env."
read -r DB_PORT DB_NAME < <(python3 -c '
import sys, urllib.parse as u
p = u.urlsplit(sys.stdin.read().strip()); print(p.port or 5433, p.path.lstrip("/") or "pmis")' <<<"$URL")
[[ $DB_NAME =~ ^[a-z_][a-z0-9_]*$ && $DB_PORT =~ ^[0-9]+$ ]] || die "Cannot read the database name and port from DATABASE_URL."
STORAGE_DIR=$(env_value STORAGE_DIR); STORAGE_DIR=${STORAGE_DIR:-/var/lib/gsdn-pmis/files}; STORAGE_DIR=${STORAGE_DIR%/}
S3_ENDPOINT=$(env_value S3_ENDPOINT)
PHRASE="RESET $DB_NAME"

psql_su() {
  if [[ -n ${PSQL_CMD-} ]]; then
    # shellcheck disable=SC2086 # PSQL_CMD is a command line on purpose
    $PSQL_CMD -X -q -At -F '|' -v ON_ERROR_STOP=1 "$@"
  else
    sudo -u postgres env PGOPTIONS="-c client_min_messages=warning" psql -X -q -At -F '|' -v ON_ERROR_STOP=1 -p "$DB_PORT" -d "$DB_NAME" "$@"
  fi
}

# print_plan FILE: the PLAN lines of the SQL output as a table
print_plan() {
  awk -F'|' '$1 == "PLAN" {
      a = ($3 == "delete") ? "DELETE" : ($3 == "mixed") ? "MIXED" : ($3 == "log") ? "KEEP-LOG" : "KEEP";
      if (a == "DELETE") { printf "  %-8s %-30s %10d rows to delete\n", a, $2, $5; del += $5 }
      else if (a == "MIXED") { printf "  %-8s %-30s %10d rows to delete, %d kept\n", a, $2, $5, $6; del += $5 }
      else { printf "  %-8s %-30s %10d rows kept\n", a, $2, $4 }
    }
    END { printf "\n  Total rows to delete: %d\n", del }' "$1"
}

WORK=$(mktemp -d)
STOPPED=0
cleanup() {
  local rc=$?
  if [[ $STOPPED == 1 ]]; then
    echo "Starting $SERVICE again."
    systemctl start "$SERVICE" || echo "WARNING: could not start $SERVICE: start it with: sudo systemctl start $SERVICE" >&2
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------------------------------------------------------------
# Dry run (always first)
# ------------------------------------------------------------------------------------------------------------------------------------------------
echo "GSDN Workspace project data reset: database $DB_NAME (port $DB_PORT), documents in $STORAGE_DIR"
echo
psql_su -v execute=false < "$SQL_FILE" > "$WORK/plan.txt" || die "The dry run failed (see the message above). Nothing was changed."
print_plan "$WORK/plan.txt"
echo
if [[ $MODE == dry ]]; then
  echo "Dry run: nothing was changed. To reset, run again with --execute --reason \"<why, at least 10 characters>\"."
  exit 0
fi

# ------------------------------------------------------------------------------------------------------------------------------------------------
# Execute: checks before anything changes
# ------------------------------------------------------------------------------------------------------------------------------------------------
[[ ${#REASON} -ge 10 ]] || die "--execute needs --reason \"<why>\" (at least 10 characters); it is written to the audit row."
if [[ -t 0 ]]; then
  [[ -z $OWN_BACKUP ]] || pg_restore --list "$OWN_BACKUP" >/dev/null 2>&1 || die "$OWN_BACKUP is not a pg_dump -Fc file that pg_restore can read."
else
  [[ -n $OWN_BACKUP ]] || die "Refusing --execute from non-interactive input (no terminal). Run it on a terminal, or give --yes-i-have-a-backup <dump> and --confirm \"$PHRASE\"."
  [[ -s $OWN_BACKUP ]] || die "$OWN_BACKUP does not exist or is empty."
  pg_restore --list "$OWN_BACKUP" >/dev/null 2>&1 || die "$OWN_BACKUP is not a pg_dump -Fc file that pg_restore can read."
  [[ $CONFIRM == "$PHRASE" ]] || die "Without a terminal, --confirm \"$PHRASE\" is required."
fi
[[ -z $S3_ENDPOINT ]] || die "The documents are in MinIO (S3_ENDPOINT is set). This script quarantines files on local disk only; see docs/ops/data-reset.md, Open."
[[ $EUID -eq 0 ]] || die "--execute runs as root only (it stops the service and writes the backups)."
if ! command -v pg_dump >/dev/null || ! command -v pg_restore >/dev/null; then die "pg_dump and pg_restore are needed (postgresql-client-16)."; fi
[[ -d $STORAGE_DIR ]] || die "The documents directory $STORAGE_DIR does not exist."
# The quarantine is made as root next to the store and the files are moved by the store's owner: refuse anything a non-root user could redirect.
STORE_PARENT=$(dirname "$STORAGE_DIR")
[[ ! -L $STORAGE_DIR ]] || die "$STORAGE_DIR is a symbolic link. Set STORAGE_DIR to the real directory. Nothing was changed."
[[ ! -L $STORE_PARENT ]] || die "$STORE_PARENT (the parent of the store and of the quarantine) is a symbolic link. Nothing was changed."
[[ $(realpath -e -- "$STORAGE_DIR") == "$STORAGE_DIR" ]] || die "$STORAGE_DIR goes through a symbolic link ($(realpath -e -- "$STORAGE_DIR")). Nothing was changed."
read -r P_UID P_MODE < <(stat -c '%u %a' "$STORE_PARENT")
[[ $P_UID == 0 && $(( 8#$P_MODE & 8#022 )) == 0 ]] \
  || die "$STORE_PARENT must be owned by root and not writable by group or others (it is uid $P_UID, mode $P_MODE). Nothing was changed."
STORE_OWNER=$(stat -c %U "$STORAGE_DIR"); STORE_GROUP=$(stat -c %G "$STORAGE_DIR")
command -v runuser >/dev/null || die "runuser is needed (util-linux): the files are moved as $STORE_OWNER, never as root."

TS=$(date +%Y%m%d-%H%M%S)
QUARANTINE=$STORAGE_DIR-pre-reset-$TS
DUMP=$BACKUP_DIR/pre-reset-$TS.dump
TAR=$BACKUP_DIR/pre-reset-$TS-files.tar
LOG=$BACKUP_DIR/pre-reset-$TS.log
[[ ! -e $QUARANTINE && ! -L $QUARANTINE && ! -e $QUARANTINE.manifest && ! -L $QUARANTINE.manifest ]] || die "$QUARANTINE already exists."
[[ $(stat -c %d "$STORAGE_DIR") == $(stat -c %d "$(dirname "$STORAGE_DIR")") ]] \
  || die "$STORAGE_DIR is a mount point: the quarantine $QUARANTINE would be on another filesystem (a copy, not a rename). Stop."

install -d -m 700 -o root -g root "$BACKUP_DIR"
DB_BYTES=$(psql_su -c "SELECT pg_database_size(current_database())")
FILES_BYTES=$(du -sb "$STORAGE_DIR" | cut -f1)
NEED=$(( (DB_BYTES + FILES_BYTES) * 11 / 10 + 256 * 1024 * 1024 ))
FREE=$(df -PB1 "$BACKUP_DIR" | awk 'NR == 2 {print $4}')
echo "Backup space: need about $((NEED / 1024 / 1024)) MiB in $BACKUP_DIR, $((FREE / 1024 / 1024)) MiB free."
(( FREE >= NEED )) || die "Not enough free space in $BACKUP_DIR. Free some space or set BACKUP_DIR to another disk. Nothing was changed."

if [[ -t 0 ]]; then
  echo
  echo "This deletes the project data listed above (sites, tasks, registers, documents, imports, notifications) on $(hostname)."
  echo "Users, accounts, configuration, messages and all logs stay. Every open session is ended."
  read -r -p "Type exactly \"$PHRASE\" to continue: " TYPED
  [[ $TYPED == "$PHRASE" ]] || die "The phrase did not match. Nothing was changed."
fi

# ------------------------------------------------------------------------------------------------------------------------------------------------
# Stop the API, back up, reset, quarantine
# ------------------------------------------------------------------------------------------------------------------------------------------------
if systemctl is-active --quiet "$SERVICE"; then
  echo "Stopping $SERVICE."
  STOPPED=1
  systemctl stop "$SERVICE"
fi
for _ in $(seq 1 30); do
  LEFT=$(psql_su -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename <> 'postgres'")
  [[ $LEFT == 0 ]] && break
  sleep 1
done
[[ $LEFT == 0 ]] || die "$LEFT application connection(s) to $DB_NAME are still open after stopping $SERVICE. Nothing was changed."

echo "Backing up the database to $DUMP"
# shellcheck disable=SC2024 # on purpose: root writes the dump, the postgres user cannot write the root-only backup directory
( umask 077; sudo -u postgres pg_dump -p "$DB_PORT" -Fc "$DB_NAME" > "$DUMP" ) || die "pg_dump failed. Nothing was changed."
pg_restore --list "$DUMP" > "$WORK/dump.list" || die "pg_restore --list cannot read $DUMP. Nothing was changed."
if ! grep -q 'TABLE DATA public audit_log ' "$WORK/dump.list" || ! grep -q 'TABLE DATA public users ' "$WORK/dump.list"; then
  die "$DUMP does not list the audit_log and users data. Nothing was changed."
fi
echo "Backing up the documents to $TAR"
( umask 077; tar -C "$(dirname "$STORAGE_DIR")" -cf "$TAR" "$(basename "$STORAGE_DIR")" ) || die "tar of $STORAGE_DIR failed. Nothing was changed."
tar -tf "$TAR" >/dev/null || die "tar -t cannot read $TAR. Nothing was changed."

echo "Resetting the project data (one transaction)."
OPERATOR=${SUDO_USER:-$(id -un)}
if ! psql_su -v execute=true -v reason="$REASON" -v operator="$OPERATOR" -v backup="$DUMP" < "$SQL_FILE" > "$WORK/reset.txt"; then
  die "The reset failed and was rolled back: nothing was changed (see the message above). The backups stay in $BACKUP_DIR."
fi
cp "$WORK/reset.txt" "$LOG"; chmod 600 "$LOG"
IFS='|' read -r _ AUDIT_ID SESSIONS NFILES < <(grep '^DONE|' "$WORK/reset.txt")

echo "Moving the files of the deleted rows to $QUARANTINE"
mkdir -m 700 -- "$QUARANTINE" || die "Cannot create $QUARANTINE. The reset is done; move the files listed in $LOG (FILE lines) by hand."
chown -- "$STORE_OWNER:$STORE_GROUP" "$QUARANTINE"
[[ -d $QUARANTINE && ! -L $QUARANTINE ]] || die "$QUARANTINE is not a plain directory. The reset is done; no file was moved."
( umask 077; : > "$QUARANTINE.manifest" )
sed -n 's/^FILE|//p' "$WORK/reset.txt" > "$WORK/keys.txt"
read -r MOVED MISSING BAD < <(QUAR_AS=$STORE_OWNER quarantine_files "$STORAGE_DIR" "$QUARANTINE" "$WORK/keys.txt" "$QUARANTINE.manifest") \
  || die "The quarantine move failed. The reset is done; see $QUARANTINE.manifest and the FILE lines of $LOG."

if [[ $STOPPED == 1 ]]; then
  echo "Starting $SERVICE."
  systemctl start "$SERVICE" && STOPPED=0
fi

cat <<EOF

Done. The project data of $DB_NAME is reset.
  Audit row:            id $AUDIT_ID (action project_data_reset), sealed on the Audit Log hash chain
  Sessions ended:       $SESSIONS (everyone signs in again)
  Files listed:         $NFILES; moved $MOVED, not found on disk $MISSING, refused and left in place $BAD (see $QUARANTINE.manifest)
  Database backup:      $DUMP (verified with pg_restore --list)
  Documents backup:     $TAR (verified with tar -t)
  Reset output:         $LOG

Copy the two backups to the encrypted backup store; they hold the password hashes and the documents (still encrypted with FILE_ENC_KEY).

Restore everything as it was before the reset (the reset's own audit row and anything written after the backup are lost by a restore):
  sudo systemctl stop $SERVICE
  sudo -u postgres dropdb -p $DB_PORT $DB_NAME
  sudo -u postgres createdb -p $DB_PORT $DB_NAME
  sudo -u postgres pg_restore -p $DB_PORT -d $DB_NAME --exit-on-error $DUMP
  sudo cp -a -n $QUARANTINE/. $STORAGE_DIR/
  sudo systemctl start $SERVICE

Delete the quarantined files later, only once the owner confirms they are no longer needed (project documents: life of the project plus 10 years):
  sudo rm -rf $QUARANTINE $QUARANTINE.manifest
EOF
