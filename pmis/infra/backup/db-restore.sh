#!/usr/bin/env bash
# GSDN Workspace: point-in-time restore of GSDN Workspace database into a SCRATCH cluster (owner answer Q196; RTO 4 hours, CLAUDE.md).
# It never touches the live cluster: the data directory must be new or empty and outside DB_LIVE_PGDATA, and the port must be neither
# 5432 nor the live PMIS port. The restored server runs on the given port, is verified, then stopped (unless --keep-running).
#
# Usage: db-restore.sh --pgdata DIR --port PORT [--target-time 'YYYY-MM-DD HH:MM:SS+02'] [--repo N] [--set LABEL]
#                      [--verify-sql FILE] [--keep-running]
#   --target-time  recover to this moment (omit it to recover to the end of the archived WAL)
#   --repo         repository to restore from (default: the first of DB_BACKUP_REPOS)
#   --set          a backup label from `pgbackrest info` (default: the latest backup that covers the target)
#   --verify-sql   a SQL file run on the restored database; its output is printed
#   --keep-running leave the scratch server running for inspection (default: stop it after the checks)
#
# Example drill: sudo -u postgres /usr/local/lib/gsdn-pmis/db-restore.sh --pgdata /var/restore/pmis-pgdata --port 55433 \
#                  --target-time '2026-11-04 10:15:00+02' --verify-sql /root/verify.sql
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=db-common.sh
. "$HERE/db-common.sh"

PGDATA=''
PORT=''
TARGET=''
REPO=''
SET=''
VERIFY_SQL=''
KEEP=0
usage() { echo "usage: db-restore.sh --pgdata DIR --port PORT [--target-time T] [--repo N] [--set LABEL] [--verify-sql FILE] [--keep-running]" >&2; exit 2; }
while (( $# )); do
  case $1 in
    --pgdata) PGDATA=${2:-}; shift 2 ;;
    --port) PORT=${2:-}; shift 2 ;;
    --target-time) TARGET=${2:-}; shift 2 ;;
    --repo) REPO=${2:-}; shift 2 ;;
    --set) SET=${2:-}; shift 2 ;;
    --verify-sql) VERIFY_SQL=${2:-}; shift 2 ;;
    --keep-running) KEEP=1; shift ;;
    *) usage ;;
  esac
done
[[ -n $PGDATA && -n $PORT ]] || usage
[[ $PGDATA == /* ]] || { echo "db-restore: --pgdata must be an absolute path" >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ ]] || { echo "db-restore: --port must be a number" >&2; exit 2; }
[[ -z $VERIFY_SQL || -r $VERIFY_SQL ]] || { echo "db-restore: cannot read $VERIFY_SQL" >&2; exit 2; }
REPO=${REPO:-${DB_BACKUP_REPOS%% *}}

# Safety: never the live data directory (or a parent of it), never the live port.
PGDATA=$(readlink -m "$PGDATA")
LIVE=$(readlink -m "$DB_LIVE_PGDATA")
case $PGDATA in
  "$LIVE"|"$LIVE"/*) echo "db-restore: $PGDATA is inside the live data directory; refusing" >&2; exit 1 ;;
esac
case $LIVE in
  "$PGDATA"/*) echo "db-restore: $PGDATA contains the live data directory; refusing" >&2; exit 1 ;;
esac
if [[ $PORT == 5432 || $PORT == "$PMIS_DB_PORT" ]]; then
  echo "db-restore: port $PORT is the live port; choose another (for example 55433)" >&2
  exit 1
fi
if pg_isready -q -p "$PORT" 2>/dev/null; then
  echo "db-restore: a server already answers on port $PORT; choose another" >&2
  exit 1
fi
if [[ -e $PGDATA ]]; then
  [[ -d $PGDATA ]] || { echo "db-restore: $PGDATA is not a directory" >&2; exit 1; }
  if [[ -n $(ls -A "$PGDATA") ]]; then
    echo "db-restore: $PGDATA is not empty; choose a new directory" >&2
    exit 1
  fi
else
  mkdir -p "$PGDATA"
fi
chmod 700 "$PGDATA"
[[ -r $PGBACKREST_CONFIG ]] || { echo "db-restore: cannot read $PGBACKREST_CONFIG" >&2; exit 2; }

START=$SECONDS
ARGS=(--pg1-path="$PGDATA")
if [[ -n $TARGET ]]; then ARGS+=(--type=time --target="$TARGET" --target-action=promote); fi
if [[ -n $SET ]]; then ARGS+=(--set="$SET"); fi
echo "db-restore: restoring repository $REPO into $PGDATA (target: ${TARGET:-end of WAL})"
db_pgbackrest --repo="$REPO" "${ARGS[@]}" restore

# The live server's ALTER SYSTEM settings (archive_mode = on, archive_command = pgbackrest archive-push) come back in the restored
# postgresql.auto.conf, which overrides config_file: a scratch copy would then push its WAL into the live repositories and fork the
# stanza's history. Drop every archive_* line (restore_command, which pgBackRest adds for recovery, stays) and force archiving off on
# the command line below as well, which wins over every file.
AUTO="$PGDATA/postgresql.auto.conf"
if [[ -f $AUTO ]]; then
  sed -i -E '/^[[:space:]]*archive_(mode|command|library|timeout)[[:space:]]*=/d' "$AUTO"
fi

# A minimal scratch configuration: the restored tree has no postgresql.conf (Ubuntu keeps it in /etc), and the live one must not be
# read, because its external_pid_file and archive settings belong to the live server.
# Authentication files of the live cluster are read only (Ubuntu keeps them in /etc/postgresql/16/<cluster>).
HBA_DIR=${DB_LIVE_HBA_DIR:-/etc/postgresql/16/$(basename "$LIVE")}
CONF="${PGDATA}.conf"
LOG="${PGDATA}.log"
cat >"$CONF" <<EOF
# Scratch server written by db-restore.sh. Not the live configuration.
port = $PORT
listen_addresses = ''
unix_socket_directories = '/var/run/postgresql'
hba_file = '$HBA_DIR/pg_hba.conf'
ident_file = '$HBA_DIR/pg_ident.conf'
archive_mode = off
shared_buffers = '128MB'
# Not lower than the primary's values, or recovery refuses to start (max_connections, max_worker_processes).
max_connections = 100
max_worker_processes = 8
logging_collector = off
EOF
chmod 600 "$CONF"

echo "db-restore: starting the scratch server on port $PORT"
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$LOG" -w -t 3600 -o "-c config_file=$CONF -c archive_mode=off -c archive_command=" start >/dev/null \
  || { echo "db-restore: the scratch server did not start; last lines of $LOG:" >&2; tail -n 20 "$LOG" >&2 || true; exit 1; }

STATUS=0
db_verify() { psql -X -At -v ON_ERROR_STOP=1 -p "$PORT" -d "$PMIS_DB_NAME" "$@"; }
# Read-only connections are accepted during recovery: wait until the target is reached and the server is promoted.
for _ in $(seq 1 360); do
  [[ $(db_verify -c "SELECT NOT pg_is_in_recovery()" 2>/dev/null || echo f) == t ]] && break
  sleep 5
done
if ! STATE=$(db_verify -c "SELECT now()::text || ' in_recovery=' || pg_is_in_recovery()::text" 2>&1); then
  echo "db-restore: the scratch server does not answer: $STATE" >&2; tail -n 20 "$LOG" >&2 || true; STATUS=1
else
  echo "db-restore: state after restore: $STATE"
fi
if [[ -n $VERIFY_SQL ]]; then
  if ! db_verify -f "$VERIFY_SQL"; then
    echo "db-restore: the verification SQL failed" >&2
    tail -n 30 "$LOG" >&2 || true
    STATUS=1
  fi
fi

if (( KEEP )); then
  echo "db-restore: left running on port $PORT. Stop it with: $PG_BIN/pg_ctl -D $PGDATA -m fast -w stop"
else
  "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w -t 300 stop >/dev/null || STATUS=1
fi
echo "db-restore: done in $((SECONDS - START)) s (status $STATUS)"
exit "$STATUS"
