#!/usr/bin/env bash
# Telecom Site Delivery Workspace: logical restore drill on a scratch database (no restic, no pgBackRest).
# Dumps SOURCE_DB (custom format), restores it into a new scratch database, compares row counts of every table, drops the scratch
# database, prints a result block to paste into infra/restore-drill.md. Never point it at the live database as the target:
# the scratch name is generated and the script refuses to drop anything that does not start with "drill_".
# Usage: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres drill-logical.sh <source-database>
# Needs pg_dump, pg_restore and psql of the same major version as the server (set PG_BIN to their directory if they are not on PATH).
set -euo pipefail
SRC=${1:?usage: drill-logical.sh <source-database>}
PG_BIN=${PG_BIN:-}
b() { if [[ -n $PG_BIN ]]; then echo "$PG_BIN/$1"; else echo "$1"; fi; }
SCRATCH="drill_$(date +%Y%m%d%H%M%S)"
DUMP=$(mktemp /tmp/drill-XXXXXX.dump)
cleanup() { "$(b psql)" -d postgres -Atqc "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1 || true; rm -f "$DUMP"; }
trap cleanup EXIT
[[ $SCRATCH == drill_* ]] || exit 2
t0=$(date +%s)
"$(b pg_dump)" -d "$SRC" -Fc --no-owner --no-privileges -f "$DUMP"
t1=$(date +%s)
"$(b psql)" -d postgres -Atqc "CREATE DATABASE \"$SCRATCH\""
"$(b pg_restore)" -d "$SCRATCH" --no-owner --no-privileges --exit-on-error "$DUMP" 2>/tmp/drill-restore.err || {
  # roles that do not exist on a scratch server only matter for GRANT lines; anything else is a failure
  if grep -v -E "role .* does not exist|^pg_restore: (while|from TOC|warning)" /tmp/drill-restore.err | grep -q .; then cat /tmp/drill-restore.err >&2; echo "drill: restore FAILED" >&2; exit 1; fi
}
t2=$(date +%s)
counts() {
  "$(b psql)" -d "$1" -Atq <<'SQL'
SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables ORDER BY 1
SQL
}
bad=0; n=0
while read -r tbl; do
  a=$("$(b psql)" -d "$SRC" -Atqc "SELECT count(*) FROM $tbl")
  c=$("$(b psql)" -d "$SCRATCH" -Atqc "SELECT count(*) FROM $tbl")
  n=$((n+1)); [[ $a == "$c" ]] || { echo "MISMATCH $tbl source=$a restored=$c"; bad=$((bad+1)); }
done < <(counts "$SRC")
echo "- Source database: $SRC; dump ${DUMP##*/}, $(stat -c %s "$DUMP") bytes"
echo "- Dump: $((t1-t0)) s; restore into scratch database: $((t2-t1)) s"
echo "- Tables compared (row counts): $n; mismatches: $bad"
if [[ $bad -eq 0 ]]; then echo "- Result: pass"; else echo "- Result: fail"; exit 1; fi
