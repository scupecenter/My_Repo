# Restore drill record

The procedure is in `infra/RUNBOOK.md`, section 6. Run it every quarter, on a scratch directory and a scratch database, never on the live
store. Add one entry per drill, newest first. No secret goes in this file: no key, no password, no connection string.

## Entry template

- Date and operator:
- Server and scratch location:
- Snapshot id (`restic snapshots --tag files`) and its date:
- Restore: duration (minutes), files restored, bytes:
- Database restored from the dump of (date), scratch database name:
- `storage-cli.js verify` result: `{"checked": N, "bad": N}`, and the plain legacy files that were not yet encrypted:
- Time to a working download (minutes), checked through the API in the scratch environment:
- Result: pass / fail. If fail, the incident reference and the owner informed (name and date):

## Database (pgBackRest, RUNBOOK section 8.7)

Entry template:

- Date and operator:
- Server and scratch location (scratch directory, scratch port, never 5432):
- Target time used for the point-in-time restore, and the backup label (`pgbackrest info`):
- Restore: duration (minutes) from `db-restore.sh` ("done in N s"), RTO check (4 hours in working hours):
- Verification SQL result (row counts of the key tables, latest audit row):
- pg_dump copy: date of the dump restored, scratch database, row counts compared with the restored point-in-time database:
- Keys: the offline copy was read and worked (yes/no; never write the key):
- Result: pass / fail. If fail, the incident reference and the owner informed (name and date):

Entries (newest first): none yet. The first drill is due before go-live (RUNBOOK 8.8, checklist).

The automated test on a throw-away cluster (`sudo bash pmis/infra/backup/test-db-backup.sh`) is not a drill: it proves the scripts, not the
owner's repositories and keys. Record it separately if it is run on a server.

## Entries

No drill has been run yet. The first drill is due within one quarter of the first nightly backup.
