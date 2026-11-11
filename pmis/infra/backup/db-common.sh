#!/usr/bin/env bash
# GSDN Workspace: shared settings and helpers for the database backup scripts (owner answer Q196). Sourced by db-backup.sh,
# db-backup-check.sh, db-dump.sh and db-restore.sh. Not run on its own. See infra/RUNBOOK.md, section 8 (database backup).
#
# Settings come from the environment, then from DB_BACKUP_ENV (default /etc/pgbackrest/db-backup.env, written by
# tools/install/install-db-backup.sh). That file holds no secret. The scripts run as the postgres user: it reads the pgBackRest
# configuration and the keys (/etc/pgbackrest: owner root, group postgres) and connects to PostgreSQL over the local socket
# (peer authentication), so no password is needed or stored.

DB_BACKUP_ENV=${DB_BACKUP_ENV:-/etc/pgbackrest/db-backup.env}
if [[ -r $DB_BACKUP_ENV ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$DB_BACKUP_ENV"
  set +a
fi

PGBACKREST_CONFIG=${PGBACKREST_CONFIG:-/etc/pgbackrest/pgbackrest.conf}
# Where the cipher keys are (conf.d/secret.conf). config-include-path is command-line only in pgBackRest, so it is passed on every call.
PGBACKREST_INCLUDE=${PGBACKREST_INCLUDE:-$(dirname "$PGBACKREST_CONFIG")/conf.d}
DB_BACKUP_STANZA=${DB_BACKUP_STANZA:-gsdn-pmis}
DB_BACKUP_REPOS=${DB_BACKUP_REPOS:-1}              # repositories that get a full backup every night
DB_BACKUP_WEEKLY_REPO=${DB_BACKUP_WEEKLY_REPO:-}   # optional: weekly full copy (8 kept)
DB_BACKUP_MONTHLY_REPO=${DB_BACKUP_MONTHLY_REPO:-} # optional: monthly full copy (12 kept)
PMIS_DB_PORT=${PMIS_DB_PORT:-5432}
PMIS_DB_NAME=${PMIS_DB_NAME:-pmis}
DB_LIVE_PGDATA=${DB_LIVE_PGDATA:-/var/lib/postgresql/16/main}
DB_CHECK_STATE=${DB_CHECK_STATE:-/var/lib/gsdn-pmis/db-backup/db-backup-check.state}
PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}

# psql as the current (postgres) user, to GSDN Workspace database, over the local socket.
db_psql() { psql -X -q -At -v ON_ERROR_STOP=1 -p "$PMIS_DB_PORT" -d "$PMIS_DB_NAME" "$@"; }

# pgBackRest for this stanza. Options go before the command.
db_pgbackrest() { pgbackrest --config="$PGBACKREST_CONFIG" --config-include-path="$PGBACKREST_INCLUDE" --stanza="$DB_BACKUP_STANZA" --log-level-console=warn "$@"; }

# db_job_start NAME: opens a job_runs row (shown in Logs > Job runs). Prints its id, or nothing when it cannot be written.
db_job_start() {
  db_psql -v name="$1" -v host="$(hostname)" 2>/dev/null <<'SQL' || true
SELECT job_run_start(:'name'::text, :'host'::text);
SQL
}

# db_job_finish ID OUTCOME ROWS ERROR DETAIL_JSON: closes the row. Never fails the caller.
db_job_finish() {
  [[ -n ${1:-} ]] || return 0
  db_psql -v id="$1" -v outcome="$2" -v rows="${3:-}" -v err="${4:-}" -v detail="${5:-}" 2>/dev/null <<'SQL' || true
SELECT job_run_finish(:'id'::uuid, :'outcome'::text, nullif(:'rows', '')::bigint, nullif(:'err', ''), nullif(:'detail', '')::jsonb);
SQL
}
