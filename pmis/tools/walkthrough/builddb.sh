#!/bin/bash
# Builds the scratch database like apps/api/test/global-setup.ts: every prisma migration in order (one transaction per file), app_grants.sql, the 7 regions.
# Usage: builddb.sh [dbname]   Needs PG_HOST/PG_PORT/PG_SUPER (default 127.0.0.1 / 5433 / postgres, trust auth). About 30 s.
set -e
PMIS=${PMIS:-$(cd "$(dirname "$0")/../.." && pwd)}; DB=${1:-pmis_walk}
P="psql -h ${PG_HOST:-127.0.0.1} -p ${PG_PORT:-5433} -U ${PG_SUPER:-postgres} -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
$P -d postgres -tc "select 1 from pg_roles where rolname='pmis_app'" | grep -q 1 || $P -d postgres -c "CREATE ROLE pmis_app LOGIN PASSWORD 'walk-pass'"
$P -d postgres -c "ALTER ROLE pmis_app PASSWORD 'walk-pass'"
for d in $(ls "$PMIS/apps/api/prisma/migrations" | grep '^0' | sort); do
  $P -d "$DB" -1 -f "$PMIS/apps/api/prisma/migrations/$d/migration.sql" >/dev/null 2>/tmp/walk-err.txt || { echo "FAILED $d"; cat /tmp/walk-err.txt; exit 1; }
done
$P -d "$DB" -f "$PMIS/db/sql/app_grants.sql" >/dev/null
$P -d "$DB" -c "INSERT INTO regions (id, code, name_en) VALUES (1,'TRIPOLI','Tripoli'),(2,'MIDDLE','Middle'),(3,'WM','WM'),(4,'ZAWIA','Zawia'),(5,'BENGHAZI','Benghazi'),(6,'GM','GM'),(7,'SEBHA','Sebha') ON CONFLICT (id) DO NOTHING"
echo BUILD_DONE
