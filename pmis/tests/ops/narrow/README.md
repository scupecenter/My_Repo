Narrowed reset (migration 0366). Run on a scratch database built with `tools/walkthrough/builddb.sh` and seeded with `tests/ops/reset-seed.sql`:
`psql -v ON_ERROR_STOP=1 -f narrow1.sql -f narrow2.sql <db>`. Each file ends in ROLLBACK, so the database is unchanged.
