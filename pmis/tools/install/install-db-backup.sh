#!/usr/bin/env bash
# GSDN PMIS: optional database backup with pgBackRest (owner answer Q196). Called by install-ubuntu.sh when the owner chooses it, and
# runnable on its own:   sudo bash pmis/tools/install/install-db-backup.sh
#
# What it sets up: WAL archiving every 5 minutes (archive_timeout; the RPO is 15 minutes), a nightly full backup, repositories
# (this server's other disk, plus a copy in another building), encryption of every repository, point-in-time restore
# (infra/backup/db-restore.sh), a nightly pg_dump copy in a separate restic repository (optional), and a check every 15 minutes that
# raises a System Log alert when a backup or the WAL archive is late. Run with the RUNBOOK (infra/RUNBOOK.md, section 8).
#
# Answers, or the environment for a non-interactive run (an empty answer keeps the default; without a terminal the defaults are used):
#   DB_BACKUP_REPO1          repository on another disk of this server: an absolute path (default /var/backups/gsdn-pmis/pgbackrest).
#                            Put it on a disk that is not the database disk.
#   DB_BACKUP_REPO2          copy in another building: sftp:user@host:/path or s3:https://endpoint[:port]/bucket (MinIO). Default: none.
#   DB_BACKUP_WEEKLY_REPO    optional weekly copy (8 kept), same formats. Default: none.
#   DB_BACKUP_MONTHLY_REPO   optional monthly copy (12 kept), same formats. Default: none.
#   DB_DUMP_RESTIC_REPOSITORY optional nightly pg_dump copy, a restic repository (path, sftp:... or s3:...). Default: none.
#   DB_BACKUP_S3_ACCESS_KEY / DB_BACKUP_S3_SECRET_KEY   for an s3 repository, when its keys are not yet stored (read silently otherwise)
#   DB_BACKUP_RESTART=yes    restart PostgreSQL now when archive_mode or wal_level must change. Without it the installer stops after
#                            writing the configuration and tells you the command. The restart drops every connection for a few seconds.
#
# Files written (no secret in the first two; /etc/pgbackrest is owner root, group postgres, mode 750):
#   /etc/pgbackrest/pgbackrest.conf          repositories and the stanza (no secret)
#   /etc/pgbackrest/conf.d/secret.conf       cipher keys of the repositories, S3 keys, mode 640
#   /etc/pgbackrest/db-backup.env            settings read by the scripts (no secret)
#   /etc/pgbackrest/restic-db.password       password of the pg_dump restic repository, only when that copy is set up
# The cipher keys are created ONCE and never regenerated: a new key cannot read the backups made with the old one. Keep an offline
# copy of every key file (Q198 custody procedure, infra/RUNBOOK.md section 8.4).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
CONF=/etc/gsdn-pmis/pmis.env
DIR=/etc/pgbackrest
CFG=$DIR/pgbackrest.conf
SECRET=$DIR/conf.d/secret.conf
# config-include-path is a command-line-only option of pgBackRest (it is ignored, with a warning, inside the config file): every call
# passes it, or the cipher keys in conf.d are never read.
INC=$DIR/conf.d
ENV_FILE=$DIR/db-backup.env
DUMP_PASS=$DIR/restic-db.password
STANZA=gsdn-pmis
PG_VER=16
PG_CLUSTER=main
LIB=/usr/local/lib/gsdn-pmis
PMIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$PMIS_DIR/infra/backup"
PSQL_OPTS=(-X -v ON_ERROR_STOP=1 -qAt)

[[ -r $CONF ]] || { echo "No installation found ($CONF missing). Run install-ubuntu.sh first." >&2; exit 1; }
for f in db-common.sh db-backup.sh db-backup-check.sh db-dump.sh db-restore.sh; do
  [[ -r $SRC/$f ]] || { echo "Missing $SRC/$f" >&2; exit 1; }
done
[[ -d /etc/postgresql/$PG_VER/$PG_CLUSTER ]] || { echo "PostgreSQL $PG_VER cluster '$PG_CLUSTER' not found." >&2; exit 1; }

# Port and database name of the PMIS, from DATABASE_URL.
DB_URL=$(sed -n 's/^DATABASE_URL=//p' "$CONF")
read -r PMIS_DB_PORT PMIS_DB_NAME < <(python3 -c '
import sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
print(u.port or 5432, u.path.lstrip("/"))' "$DB_URL")
[[ $PMIS_DB_NAME =~ ^[A-Za-z0-9_]+$ ]] || { echo "Unexpected database name in $CONF" >&2; exit 1; }

prev() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -n 1 | tr -d '"'; }

# ask VAR PROMPT DEFAULT: the environment wins; otherwise ask (Enter keeps the default); without a terminal, the default.
ask() {
  local var=$1 q=$2 def=$3 cur=${!1:-}
  [[ -n $cur ]] && return 0
  if [[ -t 0 ]]; then
    local a
    read -rp "$q${def:+ [$def]} (Enter to keep): " a || true
    cur=${a:-$def}
  else
    cur=$def
  fi
  printf -v "$1" '%s' "$cur"
}

echo "==> Answers (the last run is the default)"
ask DB_BACKUP_REPO1 "Repository on another disk of this server (absolute path)" "$(prev DB_BACKUP_REPO1)"
DB_BACKUP_REPO1=${DB_BACKUP_REPO1:-/var/backups/gsdn-pmis/pgbackrest}
ask DB_BACKUP_REPO2 "Copy in another building (sftp:user@host:/path, s3:https://host:port/bucket, or empty for none)" "$(prev DB_BACKUP_REPO2)"
ask DB_BACKUP_WEEKLY_REPO "Weekly copy, 8 kept (same formats, or empty for none)" "$(prev DB_BACKUP_WEEKLY_REPO)"
ask DB_BACKUP_MONTHLY_REPO "Monthly copy, 12 kept (same formats, or empty for none)" "$(prev DB_BACKUP_MONTHLY_REPO)"
ask DB_DUMP_RESTIC_REPOSITORY "Nightly pg_dump copy: restic repository (path, sftp: or s3:, or empty for none)" "$(prev DB_DUMP_RESTIC_REPOSITORY)"

# A spec is an absolute path (posix), sftp:user@host:/path, or s3:https://endpoint[:port]/bucket.
SFTP_RE='^sftp:([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(/[A-Za-z0-9._/-]+)$'
S3_RE='^s3:(https?://[A-Za-z0-9.-]+(:[0-9]+)?)/([a-z0-9][a-z0-9.-]{2,62})$'
check_spec() { # check_spec VALUE ALLOW_EMPTY LABEL
  [[ -z $1 && $2 == 1 ]] && return 0
  [[ $1 == /* || $1 =~ $SFTP_RE || $1 =~ $S3_RE ]] || { echo "$3: use an absolute path, sftp:user@host:/path or s3:https://host/bucket" >&2; exit 1; }
  [[ $1 == *CHANGE-ME* ]] && { echo "$3: replace the placeholder first" >&2; exit 1; }
  return 0
}
check_spec "$DB_BACKUP_REPO1" 0 "Repository 1"
check_spec "$DB_BACKUP_REPO2" 1 "Repository 2"
check_spec "$DB_BACKUP_WEEKLY_REPO" 1 "Weekly copy"
check_spec "$DB_BACKUP_MONTHLY_REPO" 1 "Monthly copy"
if [[ -n $DB_DUMP_RESTIC_REPOSITORY ]]; then
  [[ $DB_DUMP_RESTIC_REPOSITORY == /* || $DB_DUMP_RESTIC_REPOSITORY == sftp:* || $DB_DUMP_RESTIC_REPOSITORY == s3:* ]] \
    || { echo "The pg_dump repository: use an absolute path, sftp: or s3:" >&2; exit 1; }
fi

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq pgbackrest restic python3 >/dev/null
command -v pgbackrest >/dev/null || { echo "pgbackrest did not install" >&2; exit 1; }

echo "==> Directories and keys (created once, never printed)"
install -d -m 750 -o root -g postgres "$DIR"
install -d -m 750 -o root -g postgres "$DIR/conf.d"
install -d -m 750 -o postgres -g postgres /var/log/pgbackrest
install -d -m 750 -o postgres -g postgres /var/lib/gsdn-pmis
install -d -m 750 -o postgres -g postgres /var/lib/postgresql/.ssh 2>/dev/null || true
umask 077
[[ -e $SECRET ]] || install -m 640 -o root -g postgres /dev/null "$SECRET"
# pgBackRest refuses a key outside a section: the file must start with [global]. A file written by an older installer without the
# header gets it inserted (the keys are kept).
if ! grep -q '^\[global\]' "$SECRET"; then
  { echo '[global]'; cat "$SECRET"; } >"$SECRET.new" && cat "$SECRET.new" >"$SECRET" && rm -f "$SECRET.new"
fi
ensure_key() { # ensure_key NAME: creates NAME=<random> in the secret file only when it is missing
  grep -q "^$1=" "$SECRET" || printf '%s=%s\n' "$1" "$(openssl rand -hex 32)" >>"$SECRET"
}
ensure_secret_line() { # ensure_secret_line NAME VALUE: appends only when missing
  grep -q "^$1=" "$SECRET" || printf '%s=%s\n' "$1" "$2" >>"$SECRET"
}
chown root:postgres "$SECRET"
chmod 640 "$SECRET"

# repo_block N SPEC KEEP: the repository lines for pgbackrest.conf, and the cipher key (secret file).
repo_block() {
  local n=$1 spec=$2 keep=$3
  ensure_key "repo$n-cipher-pass"
  if [[ $spec == /* ]]; then
    # pgBackRest runs as postgres and cannot create a folder under a root-owned parent (/var/backups): create the repository
    # folder here, owned by postgres and closed to others (parents stay root-owned).
    install -d -m 750 -o postgres -g postgres "$spec"
    printf 'repo%s-type=posix\nrepo%s-path=%s\n' "$n" "$n" "$spec"
  elif [[ $spec =~ $SFTP_RE ]]; then
    printf 'repo%s-type=sftp\nrepo%s-sftp-host=%s\nrepo%s-sftp-host-user=%s\nrepo%s-path=%s\n' \
      "$n" "$n" "${BASH_REMATCH[2]}" "$n" "${BASH_REMATCH[1]}" "$n" "${BASH_REMATCH[3]}"
    printf 'repo%s-sftp-private-key-file=/var/lib/postgresql/.ssh/pgbackrest_repo%s\n' "$n" "$n"
  elif [[ $spec =~ $S3_RE ]]; then
    printf 'repo%s-type=s3\nrepo%s-s3-endpoint=%s\nrepo%s-s3-bucket=%s\nrepo%s-s3-region=us-east-1\nrepo%s-s3-uri-style=path\nrepo%s-path=/pgbackrest\n' \
      "$n" "$n" "$(printf '%s' "${BASH_REMATCH[1]}" | sed -E 's#^https?://##')" "$n" "${BASH_REMATCH[3]}" "$n" "$n" "$n"
    if ! grep -q "^repo$n-s3-key=" "$SECRET"; then
      local ak=${DB_BACKUP_S3_ACCESS_KEY:-} sk=${DB_BACKUP_S3_SECRET_KEY:-}
      if [[ -z $ak && -t 0 ]]; then read -rp "S3 access key for repository $n: " ak; fi
      if [[ -z $sk && -t 0 ]]; then read -rsp "S3 secret key for repository $n (not shown): " sk; echo; fi
      [[ -n $ak && -n $sk ]] || { echo "Repository $n (s3) needs an access key and a secret key." >&2; exit 1; }
      printf 'repo%s-s3-key=%s\nrepo%s-s3-key-secret=%s\n' "$n" "$ak" "$n" "$sk" >>"$SECRET"
    fi
  fi
  printf 'repo%s-retention-full-type=count\nrepo%s-retention-full=%s\nrepo%s-cipher-type=aes-256-cbc\n' "$n" "$n" "$keep" "$n"
}

echo "==> Writing $CFG"
{
  cat <<EOF
# Written by install-db-backup.sh on $(date -Is). No secret here: the keys are in conf.d/secret.conf.
[global]
log-path=/var/log/pgbackrest
process-max=2
EOF
  repo_block 1 "$DB_BACKUP_REPO1" 14
  [[ -n $DB_BACKUP_REPO2 ]] && repo_block 2 "$DB_BACKUP_REPO2" 14
  [[ -n $DB_BACKUP_WEEKLY_REPO ]] && repo_block 3 "$DB_BACKUP_WEEKLY_REPO" 8
  [[ -n $DB_BACKUP_MONTHLY_REPO ]] && repo_block 4 "$DB_BACKUP_MONTHLY_REPO" 12
  cat <<EOF

[$STANZA]
pg1-path=/var/lib/postgresql/$PG_VER/$PG_CLUSTER
pg1-port=$PMIS_DB_PORT
EOF
} >"$CFG.new"
chown root:postgres "$CFG.new"
chmod 640 "$CFG.new"
mv "$CFG.new" "$CFG"
# Repositories that are set up later, when their keys exist: the numbers DB_BACKUP_WEEKLY_REPO and MONTHLY use are fixed (3 and 4).
[[ -z $DB_BACKUP_WEEKLY_REPO ]] || DB_BACKUP_WEEKLY_REPO=3
[[ -z $DB_BACKUP_MONTHLY_REPO ]] || DB_BACKUP_MONTHLY_REPO=4
DB_BACKUP_REPOS=1
[[ -z $DB_BACKUP_REPO2 ]] || DB_BACKUP_REPOS="1 2"

if [[ -n $DB_DUMP_RESTIC_REPOSITORY ]]; then
  if [[ ! -s $DUMP_PASS ]]; then
    umask 077
    openssl rand -hex 32 >"$DUMP_PASS"
    echo "   Created $DUMP_PASS. Copy it to the offline safe the same day (Q198)."
  fi
  chown root:postgres "$DUMP_PASS"
  chmod 640 "$DUMP_PASS"
fi

echo "==> Settings in $ENV_FILE (no secret)"
{
  echo "# Written by install-db-backup.sh on $(date -Is). Keep it free of secrets."
  echo "PGBACKREST_CONFIG=$CFG"
  echo "PGBACKREST_INCLUDE=$INC"
  echo "DB_BACKUP_STANZA=$STANZA"
  echo "DB_BACKUP_REPOS=\"$DB_BACKUP_REPOS\""
  echo "DB_BACKUP_WEEKLY_REPO=${DB_BACKUP_WEEKLY_REPO:-}"
  echo "DB_BACKUP_MONTHLY_REPO=${DB_BACKUP_MONTHLY_REPO:-}"
  echo "PMIS_DB_PORT=$PMIS_DB_PORT"
  echo "PMIS_DB_NAME=$PMIS_DB_NAME"
  echo "DB_LIVE_PGDATA=/var/lib/postgresql/$PG_VER/$PG_CLUSTER"
  echo "DB_CHECK_STATE=/var/lib/gsdn-pmis/db-backup-check.state"
  echo "DB_BACKUP_REPO1=$DB_BACKUP_REPO1"
  echo "DB_BACKUP_REPO2=${DB_BACKUP_REPO2:-}"
  echo "DB_DUMP_RESTIC_REPOSITORY=${DB_DUMP_RESTIC_REPOSITORY:-}"
  echo "DB_DUMP_RESTIC_PASSWORD_FILE=$DUMP_PASS"
} >"$ENV_FILE.new"
chown root:postgres "$ENV_FILE.new"
chmod 640 "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"

echo "==> Scripts in $LIB"
install -d -m 755 "$LIB"
for f in db-common.sh db-backup.sh db-backup-check.sh db-dump.sh db-restore.sh; do
  install -m 755 "$SRC/$f" "$LIB/$f"   # copies, so the timers do not depend on the checkout
done

echo "==> PostgreSQL: WAL archiving (archive_mode, wal_level, archive_timeout, archive_command)"
psql_su() { sudo -u postgres psql -p "$PMIS_DB_PORT" "${PSQL_OPTS[@]}" -d postgres "$@"; }
psql_su <<SQL >/dev/null
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_timeout = '5min';
ALTER SYSTEM SET archive_command = 'pgbackrest --config=$CFG --config-include-path=$INC --stanza=$STANZA archive-push %p';
SQL
# archive_command and archive_timeout take effect on a reload (no connection drops); archive_mode and wal_level need the restart below.
psql_su -c "SELECT pg_reload_conf()" >/dev/null

NEED_RESTART=$(psql_su -c "SELECT CASE WHEN current_setting('archive_mode') IN ('on','always') AND current_setting('wal_level') IN ('replica','logical') THEN 0 ELSE 1 END")
if [[ $NEED_RESTART == 1 ]]; then
  if [[ ${DB_BACKUP_RESTART:-} == yes ]] || { [[ -t 0 ]] && read -rp "Restart PostgreSQL now to turn on WAL archiving? Every connection drops for a few seconds [y/N]: " a && [[ $a =~ ^[Yy] ]]; }; then
    systemctl restart "postgresql@$PG_VER-$PG_CLUSTER"
  else
    echo "PostgreSQL must be restarted for archive_mode to take effect. Stopping here (the configuration is written)."
    echo "Run: sudo systemctl restart postgresql@$PG_VER-$PG_CLUSTER   then:   sudo bash $0"
    exit 0
  fi
fi

echo "==> Stanza, check"
# pgBackRest prints the offending config line in some errors: mask every cipher or S3 key before it reaches the terminal or a log.
redact() { sed -E 's/((cipher-pass|s3-key|s3-key-secret)=)[^[:space:]]+/\1********/g'; }
pgbr() { sudo -u postgres pgbackrest --config="$CFG" --config-include-path="$INC" --stanza="$STANZA" --log-level-console=warn "$@" 2>&1 | redact; return "${PIPESTATUS[0]}"; }
pgbr stanza-create || { echo "stanza-create failed (see above)." >&2; exit 1; }
pgbr check || { echo "check failed (see above)." >&2; exit 1; }

echo "==> Timers"
unit_timer() { # unit_timer NAME ONCALENDAR DESCRIPTION EXEC_ARG
  cat >/etc/systemd/system/$1.service <<EOF
[Unit]
Description=GSDN PMIS: $3
After=postgresql@$PG_VER-$PG_CLUSTER.service

[Service]
Type=oneshot
User=postgres
Group=postgres
EnvironmentFile=$ENV_FILE
ExecStart=/bin/bash $LIB/$4
Nice=10
IOSchedulingClass=idle
EOF
  cat >/etc/systemd/system/$1.timer <<EOF
[Unit]
Description=$3

[Timer]
OnCalendar=$2
Persistent=true

[Install]
WantedBy=timers.target
EOF
}
unit_timer gsdn-pmis-db-basebackup '*-*-* 02:00:00' "nightly full database backup (pgBackRest)" "db-backup.sh full"
unit_timer gsdn-pmis-db-check '*:0/15' "database backup and WAL archive check (every 15 minutes)" "db-backup-check.sh"
sed -i 's/^Persistent=true$/Persistent=false/' /etc/systemd/system/gsdn-pmis-db-check.timer
if [[ -n $DB_BACKUP_WEEKLY_REPO ]]; then
  unit_timer gsdn-pmis-db-basebackup-weekly 'Sun *-*-* 02:10:00' "weekly full copy of the database (pgBackRest)" "db-backup.sh weekly"
else
  rm -f /etc/systemd/system/gsdn-pmis-db-basebackup-weekly.{service,timer}
fi
if [[ -n $DB_BACKUP_MONTHLY_REPO ]]; then
  unit_timer gsdn-pmis-db-basebackup-monthly '*-*-01 02:20:00' "monthly full copy of the database (pgBackRest)" "db-backup.sh monthly"
else
  rm -f /etc/systemd/system/gsdn-pmis-db-basebackup-monthly.{service,timer}
fi
if [[ -n $DB_DUMP_RESTIC_REPOSITORY ]]; then
  unit_timer gsdn-pmis-db-dump '*-*-* 03:00:00' "nightly pg_dump copy of the database (restic)" "db-dump.sh"
else
  rm -f /etc/systemd/system/gsdn-pmis-db-dump.{service,timer}
fi
systemctl daemon-reload
for t in gsdn-pmis-db-basebackup gsdn-pmis-db-check gsdn-pmis-db-basebackup-weekly gsdn-pmis-db-basebackup-monthly gsdn-pmis-db-dump; do
  if [[ -f /etc/systemd/system/$t.timer ]]; then
    systemctl enable -q --now "$t.timer"
  else
    systemctl disable -q --now "$t.timer" 2>/dev/null || true
  fi
done

cat <<EOF

Database backup is set up (pgBackRest, stanza $STANZA).
  Repositories:       1 = $DB_BACKUP_REPO1${DB_BACKUP_REPO2:+, 2 = $DB_BACKUP_REPO2}${DB_BACKUP_WEEKLY_REPO:+, weekly = 3}${DB_BACKUP_MONTHLY_REPO:+, monthly = 4}
  Check now:          sudo -u postgres pgbackrest --config=$CFG --config-include-path=$INC --stanza=$STANZA info
  First full backup:  sudo systemctl start gsdn-pmis-db-basebackup.service
  Logs:               sudo journalctl -u gsdn-pmis-db-basebackup -n 30 --no-pager   (and Logs > Job runs)
  Alerts:             Logs > System log (source backup), written by gsdn-pmis-db-check every 15 minutes
Open items for the owner: see infra/RUNBOOK.md, section 8 (names, destinations, key custody, first restore drill).
EOF
