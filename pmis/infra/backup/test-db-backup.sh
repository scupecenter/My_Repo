#!/usr/bin/env bash
# GSDN PMIS: test of the database backup scripts on a THROW-AWAY PostgreSQL 16 cluster (never the live one).
# It creates the cluster pmisbk on port 55440 (TEST_PORT), archives WAL with pgBackRest into a temporary repository, takes a full backup,
# writes rows before and after a recovery target, runs the late-backup check (expects it to alert once, then not again), restores to the
# target into a scratch directory on port 55441 and checks the row count. It also checks that db-restore.sh refuses the live port and the
# live data directory. Everything is removed at the end.
#
# Needs root, PostgreSQL 16 (pg_createcluster), pgbackrest, python3. Not run by CI (it needs a real cluster); run it by hand:
#   sudo bash pmis/infra/backup/test-db-backup.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLUSTER=pmisbk
TEST_PORT=55440
RESTORE_PORT=55441
LIVE_PORT=5432
[[ $TEST_PORT != "$LIVE_PORT" && $RESTORE_PORT != "$LIVE_PORT" ]] || { echo "refusing: the test must not use port 5432" >&2; exit 1; }
command -v pgbackrest >/dev/null || { echo "pgbackrest is needed" >&2; exit 1; }
if pg_lsclusters 2>/dev/null | awk '{print $2}' | grep -qx "$CLUSTER"; then
  echo "cluster $CLUSTER already exists; remove it first (pg_dropcluster --stop 16 $CLUSTER)" >&2
  exit 1
fi

WORK=$(mktemp -d /var/tmp/pmis-db-backup-test.XXXXXX)
chmod 755 "$WORK"
chown postgres:postgres "$WORK"   # the scripts run as postgres and create the scratch cluster here
CREATED=0
cleanup() {
  runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$WORK/restore" -m immediate stop >/dev/null 2>&1 || true
  if (( CREATED )); then pg_dropcluster --stop 16 "$CLUSTER" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

CFG="$WORK/pgbackrest.conf"
ENVF="$WORK/db-backup.env"
CHECK_STATE="$WORK/state/check.state"
cat >"$CFG" <<EOF
[global]
repo1-path=$WORK/repo1
repo1-type=posix
repo1-retention-full=14
repo1-retention-full-type=count
repo1-cipher-type=aes-256-cbc
log-path=$WORK/log
[gsdn-pmis]
pg1-path=/var/lib/postgresql/16/$CLUSTER
pg1-port=$TEST_PORT
EOF
# as on the server: the cipher key lives in conf.d/secret.conf, read only through --config-include-path (command-line only)
mkdir -p "$WORK/conf.d"
printf '[global]\nrepo1-cipher-pass=test-only-%s\n' "$(openssl rand -hex 16)" >"$WORK/conf.d/secret.conf"
chown -R root:postgres "$WORK/conf.d"; chmod 750 "$WORK/conf.d"; chmod 640 "$WORK/conf.d/secret.conf"
mkdir -p "$WORK/repo1" "$WORK/log" "$WORK/state"
chown -R postgres:postgres "$WORK/repo1" "$WORK/log" "$WORK/state"
chown root:postgres "$CFG"
chmod 640 "$CFG"
cat >"$ENVF" <<EOF
PGBACKREST_CONFIG=$CFG
PGBACKREST_INCLUDE=$WORK/conf.d
DB_BACKUP_STANZA=gsdn-pmis
DB_BACKUP_REPOS="1"
PMIS_DB_PORT=$TEST_PORT
PMIS_DB_NAME=pmis
DB_LIVE_PGDATA=/var/lib/postgresql/16/$CLUSTER
DB_CHECK_STATE=$CHECK_STATE
EOF
chmod 644 "$ENVF"

ok() { echo "PASS: $*"; }
die() { echo "FAIL: $*" >&2; exit 1; }
as_pg() { runuser -u postgres -- "$@"; }
sqlt() { as_pg psql -X -At -v ON_ERROR_STOP=1 -p "$TEST_PORT" -d pmis -c "$1"; }

pg_createcluster 16 "$CLUSTER" -p "$TEST_PORT" --start >/dev/null
CREATED=1
ok "cluster $CLUSTER created on port $TEST_PORT"

as_pg psql -X -q -v ON_ERROR_STOP=1 -p "$TEST_PORT" -d postgres <<SQL
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_timeout = '60s';
ALTER SYSTEM SET archive_command = 'pgbackrest --config=$CFG --config-include-path=$WORK/conf.d --stanza=gsdn-pmis archive-push %p';
CREATE DATABASE pmis;
SQL
pg_ctlcluster 16 "$CLUSTER" restart
as_pg pgbackrest --config="$CFG" --config-include-path="$WORK/conf.d" --stanza=gsdn-pmis --log-level-console=warn stanza-create
ok "stanza created"

# Stub of the job_runs and System Log functions (the real ones are in db/migrations 0045); same names and signatures.
as_pg psql -X -q -v ON_ERROR_STOP=1 -p "$TEST_PORT" -d pmis <<'SQL'
CREATE TABLE job_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, started_at timestamptz DEFAULT now(),
  finished_at timestamptz, outcome text NOT NULL DEFAULT 'running', rows bigint, error text, detail jsonb, host text);
CREATE TABLE system_log (id bigserial PRIMARY KEY, level text, source text, message text, context jsonb);
CREATE FUNCTION job_run_start(p_name text, p_host text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS
  $$ INSERT INTO job_runs (name, host) VALUES (p_name, p_host) RETURNING id $$;
CREATE FUNCTION job_run_finish(p_id uuid, p_outcome text, p_rows bigint, p_error text, p_detail jsonb DEFAULT NULL) RETURNS void
  LANGUAGE sql AS $$ UPDATE job_runs SET finished_at = now(), outcome = p_outcome, rows = p_rows, error = p_error, detail = p_detail WHERE id = p_id $$;
CREATE FUNCTION log_system_write(p_level text, p_source text, p_message text, p_context jsonb, p_user uuid, p_request_id text) RETURNS void
  LANGUAGE sql AS $$ INSERT INTO system_log (level, source, message, context) VALUES (p_level, p_source, p_message, p_context) $$;
CREATE TABLE evidence (batch int, n int);
INSERT INTO evidence SELECT 1, g FROM generate_series(1, 1000) g;
SQL

run_as_pg() { as_pg env DB_BACKUP_ENV="$ENVF" bash "$@"; }
late_check() { as_pg env DB_BACKUP_ENV="$ENVF" BACKUP_LATE_HOURS=0 bash "$HERE/db-backup-check.sh"; }

run_as_pg "$HERE/db-backup.sh" full >"$WORK/full.out" 2>&1 || { cat "$WORK/full.out"; die "full backup failed"; }
[[ $(sqlt "SELECT count(*) FROM job_runs WHERE name='db_basebackup' AND outcome='ok'") == 1 ]] || die "job_runs row for the full backup missing"
ok "full backup recorded in job_runs"

sqlt "INSERT INTO evidence SELECT 2, g FROM generate_series(1, 500) g; SELECT pg_switch_wal();" >/dev/null
sleep 1
TARGET=$(sqlt "SELECT now()::text")
sleep 2
sqlt "INSERT INTO evidence SELECT 3, g FROM generate_series(1, 300) g; SELECT pg_switch_wal();" >/dev/null
# Only archived WAL can be replayed: the segment with batch 3 is archived by the second switch.
sqlt "SELECT pg_switch_wal();" >/dev/null
sleep 2
ok "rows written before and after the target time $TARGET"

# The check: archiving is fresh, but no full backup is older than BACKUP_LATE_HOURS=0, so it must alert once and then stay quiet.
if late_check >"$WORK/check1.out" 2>&1; then
  die "the check should report a late backup"
fi
[[ $(sqlt "SELECT count(*) FROM system_log WHERE source='backup' AND level='error'") == 1 ]] || die "late backup did not raise a System Log row"
late_check >/dev/null 2>&1 || true
[[ $(sqlt "SELECT count(*) FROM system_log WHERE source='backup'") == 1 ]] || die "the same problem was logged twice"
ok "late backup alerts once and is not repeated"

run_as_pg "$HERE/db-backup-check.sh" >"$WORK/check2.out" 2>&1 || { cat "$WORK/check2.out"; die "healthy check failed"; }
[[ $(sqlt "SELECT count(*) FROM system_log WHERE level='info'") == 1 ]] || die "recovery was not logged"
ok "healthy check passes and logs the recovery"

# Negative: the restore must refuse the live port and the live data directory.
if run_as_pg "$HERE/db-restore.sh" --pgdata "$WORK/x" --port "$LIVE_PORT" >/dev/null 2>&1; then die "restore accepted port 5432"; fi
if run_as_pg "$HERE/db-restore.sh" --pgdata "/var/lib/postgresql/16/$CLUSTER/restore-x" --port "$RESTORE_PORT" >/dev/null 2>&1; then die "restore accepted a path inside the live data directory"; fi
ok "restore refuses port 5432 and the live data directory"

VERIFY="$WORK/verify.sql"
printf '%s\n' "SELECT count(*) AS rows, max(batch) AS last_batch FROM evidence;" "SELECT 'archive_mode=' || current_setting('archive_mode');" >"$VERIFY"
chmod 644 "$VERIFY"
as_pg bash -c "DB_BACKUP_ENV='$ENVF' bash '$HERE/db-restore.sh' --pgdata '$WORK/restore' --port $RESTORE_PORT --target-time '$TARGET' --verify-sql '$VERIFY'" \
  >"$WORK/restore.out" 2>&1 || { cat "$WORK/restore.out"; die "point-in-time restore failed"; }
grep -q '^1500|2$' "$WORK/restore.out" || { cat "$WORK/restore.out"; die "restored rows are not the 1500 rows before the target"; }
ok "point-in-time restore to $TARGET returned 1500 rows (batches 1 and 2; batch 3 excluded)"
# the scratch copy never archives into the live repository: the live ALTER SYSTEM archive settings are gone and archiving is off
grep -q '^archive_mode=off$' "$WORK/restore.out" || { cat "$WORK/restore.out"; die "the restored server has archiving on"; }
if as_pg grep -Eq '^[[:space:]]*archive_(mode|command)[[:space:]]*=' "$WORK/restore/postgresql.auto.conf" 2>/dev/null; then
  die "the restored postgresql.auto.conf still carries the live archive settings"
fi
ok "the restored server runs with archiving off (live archive settings removed from postgresql.auto.conf)"

echo "All database backup tests passed."
