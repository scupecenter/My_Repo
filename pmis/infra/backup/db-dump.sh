#!/usr/bin/env bash
# GSDN PMIS: nightly logical copy of the PMIS database (pg_dump, custom format), as an extra to the pgBackRest backups (owner answer Q196).
# The dump is streamed straight into its own restic repository (DB_DUMP_RESTIC_REPOSITORY, with its own password file, so its keys
# are kept apart from the pgBackRest keys). Retention: 14 daily, 8 weekly and 12 monthly snapshots (tag db-dump).
# Run at 03:00 by gsdn-pmis-db-dump.timer, as postgres. Writes one job_runs row (name db_dump).
#
# The dump is a copy for restoring single objects or as a second route. It is not the point-in-time base: use db-restore.sh for that.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=db-common.sh
. "$HERE/db-common.sh"

: "${DB_DUMP_RESTIC_REPOSITORY:?db-dump: set DB_DUMP_RESTIC_REPOSITORY in $DB_BACKUP_ENV}"
: "${DB_DUMP_RESTIC_PASSWORD_FILE:?db-dump: set DB_DUMP_RESTIC_PASSWORD_FILE in $DB_BACKUP_ENV}"
[[ -r $DB_DUMP_RESTIC_PASSWORD_FILE ]] || { echo "db-dump: cannot read $DB_DUMP_RESTIC_PASSWORD_FILE" >&2; exit 2; }
command -v restic >/dev/null || { echo "db-dump: restic is not installed (apt-get install restic)" >&2; exit 2; }
command -v pg_dump >/dev/null || { echo "db-dump: pg_dump is not installed" >&2; exit 2; }
export RESTIC_REPOSITORY=$DB_DUMP_RESTIC_REPOSITORY
export RESTIC_PASSWORD_FILE=$DB_DUMP_RESTIC_PASSWORD_FILE

RUN_ID=$(db_job_start db_dump)
fail() {
  echo "db-dump: $*" >&2
  db_job_finish "$RUN_ID" failed "" "$*" ""
  exit 1
}

if ! restic cat config >/dev/null 2>&1; then
  restic init >/dev/null 2>&1 || fail "restic init failed (check the repository and its password file)"
fi
STAMP=$(date +%Y%m%d-%H%M)
if ! pg_dump -p "$PMIS_DB_PORT" -d "$PMIS_DB_NAME" -Fc --no-owner --no-privileges \
  | restic backup --stdin --stdin-filename "$PMIS_DB_NAME-$STAMP.dump" --tag db-dump --host "$(hostname)" >/dev/null; then
  fail "pg_dump or restic backup failed"
fi
restic forget --tag db-dump --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune >/dev/null \
  || fail "dump taken, but restic forget (retention 14/8/12) failed"

echo "db-dump: $PMIS_DB_NAME-$STAMP.dump stored; retention 14 daily, 8 weekly, 12 monthly"
db_job_finish "$RUN_ID" ok "" "" '{"retention":"14d/8w/12m"}'
