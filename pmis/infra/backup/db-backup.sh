#!/usr/bin/env bash
# GSDN PMIS: base backups of the PMIS database with pgBackRest (owner answer Q196; RPO 15 minutes and RTO 4 hours, CLAUDE.md).
# PostgreSQL archives the WAL continuously (archive_command = pgbackrest archive-push, set by tools/install/install-db-backup.sh).
# A point-in-time restore needs one base backup and the WAL after it. This script takes the base backups.
#
# Usage: db-backup.sh full | diff | weekly | monthly
#   full     nightly full backup to every repository in DB_BACKUP_REPOS (default: repository 1)
#   diff     differential backup to the same repositories (optional, between two full backups)
#   weekly   full backup to DB_BACKUP_WEEKLY_REPO (the weekly copy, 8 kept)
#   monthly  full backup to DB_BACKUP_MONTHLY_REPO (the monthly copy, 12 kept)
# Every repository is tried even when another one fails. The exit status is 1 when any of them failed.
# Each run writes one job_runs row (name db_basebackup), shown in Logs > Job runs.
#
# Run by the timers as postgres, or by hand: sudo -u postgres /usr/local/lib/gsdn-pmis/db-backup.sh full
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=db-common.sh
. "$HERE/db-common.sh"

MODE=${1:-}
case $MODE in
  full)    REPOS=$DB_BACKUP_REPOS;        TYPE=full ;;
  diff)    REPOS=$DB_BACKUP_REPOS;        TYPE=diff ;;
  weekly)  REPOS=$DB_BACKUP_WEEKLY_REPO;  TYPE=full ;;
  monthly) REPOS=$DB_BACKUP_MONTHLY_REPO; TYPE=full ;;
  *) echo "usage: db-backup.sh full | diff | weekly | monthly" >&2; exit 2 ;;
esac
[[ -n $REPOS ]] || { echo "db-backup: no repository is configured for '$MODE' (DB_BACKUP_* in $DB_BACKUP_ENV)" >&2; exit 2; }
[[ -r $PGBACKREST_CONFIG ]] || { echo "db-backup: cannot read $PGBACKREST_CONFIG" >&2; exit 2; }
command -v pgbackrest >/dev/null || { echo "db-backup: pgbackrest is not installed (tools/install/install-db-backup.sh)" >&2; exit 2; }

RUN_ID=$(db_job_start db_basebackup)
OK=''
FAILED=''
for r in $REPOS; do
  if ! [[ $r =~ ^[1-9][0-9]?$ ]]; then
    echo "db-backup: '$r' is not a repository number" >&2
    FAILED+=" $r"
    continue
  fi
  if err=$(db_pgbackrest --repo="$r" --type="$TYPE" backup 2>&1); then
    echo "db-backup: $MODE ($TYPE) to repository $r: ok"
    OK+=" $r"
  else
    echo "db-backup: $MODE ($TYPE) to repository $r FAILED: $(printf '%s' "$err" | tail -n 3)" >&2
    FAILED+=" $r"
  fi
done

DETAIL="{\"mode\":\"$MODE\",\"ok\":\"${OK# }\",\"failed\":\"${FAILED# }\"}"
if [[ -z $FAILED ]]; then
  db_job_finish "$RUN_ID" ok "" "" "$DETAIL"
  exit 0
fi
db_job_finish "$RUN_ID" failed "" "backup failed for repository${FAILED}" "$DETAIL"
exit 1
