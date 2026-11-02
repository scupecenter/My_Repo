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

## Entries

No drill has been run yet. The first drill is due within one quarter of the first nightly backup.
