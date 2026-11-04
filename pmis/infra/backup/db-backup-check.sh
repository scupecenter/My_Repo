#!/usr/bin/env bash
# GSDN PMIS: alert when a database backup or the WAL archive is late (owner answer Q196; RPO 15 minutes, CLAUDE.md).
# Run every 15 minutes by gsdn-pmis-db-check.timer, as postgres. It checks:
#   1. WAL archiving: archive_mode is on, a WAL segment was archived within WAL_LATE_SECONDS (default 1200 = 20 minutes), and the last
#      archive attempt did not fail after the last success.
#   2. Each daily repository (DB_BACKUP_REPOS) has a full backup younger than BACKUP_LATE_HOURS (default 26), and pgBackRest reports the
#      stanza healthy (status code 0).
#   3. The weekly repository has a full backup younger than 8 days, the monthly one younger than 32 days (only when configured).
#   4. The nightly pg_dump copy (only when DB_DUMP_RESTIC_REPOSITORY is set) is younger than BACKUP_LATE_HOURS.
# A problem is written to the System Log (source backup, level error). The same problem is written again at most every
# ALERT_REPEAT_SECONDS (default 21600). When the problems clear, an info row says so.
# Exit status: 0 all good, 1 a problem was found (and logged), 2 the check itself could not run.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=db-common.sh
. "$HERE/db-common.sh"

WAL_LATE_SECONDS=${WAL_LATE_SECONDS:-1200}
BACKUP_LATE_HOURS=${BACKUP_LATE_HOURS:-26}
ALERT_REPEAT_SECONDS=${ALERT_REPEAT_SECONDS:-21600}
PROBLEMS=()

command -v python3 >/dev/null || { echo "db-backup-check: python3 is required" >&2; exit 2; }

# raise_log LEVEL MESSAGE: one System Log row (source backup), written as the database superuser.
raise_log() {
  local ctx
  ctx=$(printf '{"script":"db-backup-check","stanza":"%s"}' "$DB_BACKUP_STANZA")
  db_psql -v lvl="$1" -v msg="$2" -v ctx="$ctx" >/dev/null 2>&1 <<'SQL'
SELECT log_system_write(:'lvl'::text, 'backup', :'msg'::text, :'ctx'::jsonb, NULL, NULL);
SQL
}

# 1. WAL archiving
ARCH=$(db_psql 2>/dev/null <<'SQL'
SELECT current_setting('archive_mode'),
  coalesce(extract(epoch FROM now() - last_archived_time)::bigint, -1),
  (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))::int
FROM pg_stat_archiver;
SQL
) || { echo "db-backup-check: cannot query PostgreSQL on port $PMIS_DB_PORT" >&2; exit 2; }
IFS='|' read -r ARCH_MODE ARCH_AGE ARCH_FAILING <<<"$ARCH"
case $ARCH_MODE in
  on|always) ;;
  *) PROBLEMS+=("WAL archiving is off (archive_mode=$ARCH_MODE)") ;;
esac
if [[ $ARCH_AGE == -1 ]]; then
  PROBLEMS+=("no WAL segment has been archived yet")
elif (( ARCH_AGE > WAL_LATE_SECONDS )); then
  PROBLEMS+=("last WAL archived ${ARCH_AGE} s ago (limit ${WAL_LATE_SECONDS} s)")
fi
if [[ $ARCH_FAILING == 1 ]]; then
  PROBLEMS+=("WAL archive command failed after the last archived segment (see the PostgreSQL log)")
fi

# 2 and 3. Full backups per repository, from pgBackRest's own JSON report.
check_repo() { # check_repo NUMBER MAX_AGE_SECONDS LABEL
  local r=$1 max=$2 label=$3 out st age
  if ! out=$(db_pgbackrest --repo="$r" info --output=json 2>/dev/null); then
    PROBLEMS+=("$label (repository $r): pgbackrest info failed")
    return 0
  fi
  read -r st age < <(printf '%s' "$out" | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
s = d[0] if d else {}
code = s.get("status", {}).get("code", 99)
fulls = [b["timestamp"]["stop"] for b in s.get("backup", []) if b.get("type") == "full"]
print(code, int(time.time()) - max(fulls) if fulls else -1)
' 2>/dev/null) || true
  if [[ -z ${st:-} ]]; then
    PROBLEMS+=("$label (repository $r): cannot read the backup report")
  elif [[ $st != 0 ]]; then
    PROBLEMS+=("$label (repository $r): pgBackRest stanza status code $st")
  elif [[ $age == -1 ]]; then
    PROBLEMS+=("$label (repository $r): no full backup yet")
  elif (( age > max )); then
    PROBLEMS+=("$label (repository $r): last full backup $((age / 3600)) h ago (limit $((max / 3600)) h)")
  fi
  return 0
}
for r in $DB_BACKUP_REPOS; do
  check_repo "$r" $((BACKUP_LATE_HOURS * 3600)) "daily backup"
done
if [[ -n $DB_BACKUP_WEEKLY_REPO ]]; then
  check_repo "$DB_BACKUP_WEEKLY_REPO" $((8 * 86400)) "weekly copy"
fi
if [[ -n $DB_BACKUP_MONTHLY_REPO ]]; then
  check_repo "$DB_BACKUP_MONTHLY_REPO" $((32 * 86400)) "monthly copy"
fi

# 4. The pg_dump copy in restic (optional).
if [[ -n ${DB_DUMP_RESTIC_REPOSITORY:-} ]]; then
  DUMP_AGE=$(RESTIC_REPOSITORY=$DB_DUMP_RESTIC_REPOSITORY RESTIC_PASSWORD_FILE=${DB_DUMP_RESTIC_PASSWORD_FILE:-} \
    restic snapshots --tag db-dump --json 2>/dev/null | python3 -c '
import datetime, json, re, sys
snaps = json.load(sys.stdin)
if not snaps:
    print(-1)
else:
    newest = max(datetime.datetime.fromisoformat(re.sub(r"\.\d+", "", s["time"])).timestamp() for s in snaps)
    print(int(datetime.datetime.now().timestamp() - newest))
' 2>/dev/null) || DUMP_AGE=''
  if [[ -z $DUMP_AGE ]]; then
    PROBLEMS+=("pg_dump copy: cannot read the restic snapshots")
  elif [[ $DUMP_AGE == -1 ]]; then
    PROBLEMS+=("pg_dump copy: no dump yet")
  elif (( DUMP_AGE > BACKUP_LATE_HOURS * 3600 )); then
    PROBLEMS+=("pg_dump copy: last dump $((DUMP_AGE / 3600)) h ago (limit $BACKUP_LATE_HOURS h)")
  fi
fi

# Report, with at most one alert per problem set per ALERT_REPEAT_SECONDS.
mkdir -p "$(dirname "$DB_CHECK_STATE")" 2>/dev/null || true
NOW=$(date +%s)
LAST_KEY=''
LAST_AT=0
if [[ -r $DB_CHECK_STATE ]]; then read -r LAST_KEY LAST_AT <"$DB_CHECK_STATE" || true; fi

if (( ${#PROBLEMS[@]} == 0 )); then
  if [[ -n $LAST_KEY ]]; then
    raise_log info "Database backups and WAL archiving are healthy again" || true
    rm -f "$DB_CHECK_STATE"
  fi
  echo "db-backup-check: all checks passed"
  exit 0
fi

MSG="Database backup check: $(IFS='; '; echo "${PROBLEMS[*]}")"
KEY=$(printf '%s' "$MSG" | sha256sum | cut -c1-16)
if [[ $KEY != "$LAST_KEY" ]] || (( NOW - ${LAST_AT:-0} >= ALERT_REPEAT_SECONDS )); then
  if raise_log error "$MSG"; then
    printf '%s %s\n' "$KEY" "$NOW" >"$DB_CHECK_STATE"
  else
    echo "db-backup-check: could not write the System Log row" >&2
  fi
fi
echo "$MSG" >&2
exit 1
