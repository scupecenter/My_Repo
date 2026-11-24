# Project data reset: the contract

Owner request (2026-11-23): "reset all data in the system except the users and accounts". Scope approved by the owner the same day: keep identity,
configuration, the staff registry and all logs; delete the project data (sites and everything hanging off them, registers, documents, imports,
notifications, snapshots). Owner decisions 2026-11-24: the same reset is also a function of Settings, run by two System Admins (four eyes), and only
after a recent successful database backup.

This page is the reviewable contract of the reset, both ways. Both say the same as this page, table for table, because both call one database function:

| File | What it is |
|---|---|
| `apps/api/prisma/migrations/0146_settings_data_reset/migration.sql` (mirror `db/sql/145_settings_data_reset.sql`) | The plan `data_reset_plan()` (every table with its decision) and the reset `data_reset_core()` (counts, deletes, checks, session end, audit row), shared by both ways; the Settings doors `admin_data_reset_*`. |
| `infra/scripts/reset-project-data.sh` | The operator way. Run as root on the server. Dry run by default; `--execute` backs up, stops the API, resets, quarantines the files. |
| `infra/scripts/reset-project-data.sql` | The operator's database wrapper: one transaction around `data_reset_core`, printing the plan, the files and the result. |
| Settings > Data > Data reset (`apps/web/src/pages/settings/DataReset.tsx`, `apps/api/src/settings/data-reset.*`) | The in-app way (contract 0.15.62): request, approve, run, progress, result. |
| `tests/ops/reset-project-data.test.mjs` | Test of the operator way on a scratch database built from every migration, with synthetic data (`tests/ops/reset-seed.sql`); it also checks that this page lists every table of `data_reset_plan()` with the same decision. |
| `apps/api/test/settings-data-reset.test.ts`, `tests/db-security/cases/E10_settings_data_reset.sql` | Tests of the Settings way (the API on the same synthetic data) and the database refusals. |

## Which way

- **Two or more active System Admins:** Settings > Data > Data reset (below). Nothing is done on the server by hand; the backup is the nightly
  pgBackRest backup that the System Log records.
- **One active System Admin** (the screen says so; a request is refused with 409 `single_admin`): the operator script on the server. There is no bypass.
- Both are never run at the same time: they share the advisory lock `353383097684` of `data_reset_core`. The script refuses while a reset approved in
  Settings waits to run or runs; Settings refuses (409 `reset_running`) while the script runs, and the script stops the API anyway.

## In Settings (two System Admins)

Every step is a System Admin acting without delegation (a delegate gets 403 on every route; the menu entry is hidden for everyone but System Admins), in
a live session of their own, with a step-up (`stepup_max_age_seconds`). Every write is audited with before and after and written to the security log
(event `project_data_reset`, `detail.step` = `request`, `approve`, `cancel`, `start`, `completed`, `failed`, `files`).

1. **Request** (`POST /settings/data-reset/requests`): a reason of at least 10 characters and the typed phrase `RESET <database>`. Refused while another
   request is open (one open request at a time, a unique index), with fewer than two active System Admins, or while a reset runs. The request expires
   after `data_reset.settings.request_expiry_minutes` (default 30). The other active System Admins are told in-app.
2. **Approve** (`POST .../approve`, If-Match): a DIFFERENT System Admin (another user and another session, checked by the database and by a CHECK
   constraint; 403 `self_approval_forbidden`), with a reason of at least 10 characters. Approving runs nothing.
3. **Cancel** (`POST .../cancel`, If-Match): any System Admin, with a reason, while the request is requested or approved.
4. **Run** (`POST .../run`, If-Match): the requester or the approver (decision: either of the two people who agreed, never a third admin), with the
   typed phrase again, while the request is approved and not expired. Refused (409, nothing changes) when:
   - the System Log has no successful database backup within `data_reset.settings.backup_max_age_hours` (default 24; `backup_missing`, see "Backup rule");
   - the documents are in S3/MinIO (`storage_not_supported`; see Open);
   - the quarantine directory cannot be made inside the document store (`quarantine_unavailable`);
   - a table has no decision in the plan (`plan_incomplete`), or a reset runs (`reset_running`).

   The API answers 202 and runs the database part in the background, as the runner, in a transaction of its own (one hour at most):
   `admin_data_reset_execute` calls `data_reset_core` (the transaction below) and keeps the runner's own session; every other session ends. Afterwards
   the API moves the files (below) and records each outcome on the request. The screen follows `GET /settings/data-reset/requests/{id}` every two
   seconds.
5. **Result and restore**: the screen shows the audit row id, the sessions ended, the files moved, missing and refused, the quarantine directory, and
   the restore steps (below).

States: `requested` → `approved` → `running` → `files_pending` → `completed`; `cancelled`, `expired` (closed by the next door that meets it), `failed`
(the transaction rolled back: nothing was reset; the error is on the request). A request is evidence: never deleted, a closed one never changes.

**Maintenance.** While a run's transaction is open (`data_reset_maintenance()`: a request `running` for less than two minutes, or the advisory lock
held), every API route except `GET /settings/data-reset`, `GET /settings/data-reset/requests/{id}`, `GET /auth/session` and `GET /health` answers 503
`maintenance` (`Retry-After: 30`), before the session guard and before any transaction. The run waits until the requests already in flight in its
process have finished (15 seconds at most). A run whose API process stopped holds no lock: after two minutes it no longer counts, the screen shows it as
interrupted (`stalled`), and Cancel closes it as failed (nothing was reset, the transaction died with the process).

**The database part runs once.** `admin_data_reset_execute` refuses a request that is not `running` or was already committed, a caller that is not the
runner in the runner's session, and a start older than two minutes; a second start of the same request is 409 or 412 (the version moved).

**Files.** After the commit the API (the owner of the store) moves the stored files of the deleted rows into `<STORAGE_DIR>/.pre-reset-<UTC timestamp>`
with the rules of `reset-project-data-quarantine.sh` (`apps/api/src/settings/data-reset-files.ts`): the key format, no empty, `.` or `..` component, no
symbolic link on any component, a regular file only, the resolved path inside the resolved store, never over an existing file, never a delete. A refused
or missing key is left in place and recorded. The list is written next to it (`<quarantine>.manifest`) and on the request (`data_reset_request_files`).
The quarantine is inside the store, not beside it as with the script, because the API may write only the store (systemd `ReadWritePaths`; the data root
is root 0755) and so the move stays a rename on one filesystem; no storage key can name it (a key never starts with a dot). If the move fails as a
whole (the store cannot be read), the request stays `files_pending`: `POST .../retry-files` (any System Admin, reason, step-up, audited) moves the keys
still pending; the database part is never run again. A key found already in the quarantine counts as moved.

**Backup rule.** `infra/backup/db-backup.sh` writes, after a successful pgBackRest backup to at least one repository, one System Log row: source `backup`,
level `info`, message `Database backup completed (<mode>, <type>) to repository <n>`, context `{"script": "db-backup", "event": "backup_ok", "mode",
"type", "repos", "failed", "stanza"}`. The run needs such a row with `type` `full` or `diff` younger than `backup_max_age_hours`. Before migration 0146
the scripts wrote only a `job_runs` row on success and System Log rows only for problems (`db-backup-check.sh`, level `error`, and `info` "healthy
again"), so a server needs the updated `db-backup.sh` and one backup after it. The source `backup` is reserved for the server's scripts:
`log_system_write` refuses it from a `pmis_app` session, so the API (or anything that holds its connection) can never fake a backup. The screen shows the
last success (time, type, repository) and the latest backup-check error newer than it.

**Settings.** `data_reset.settings` (guarded: only `admin_set_data_reset_settings`, a System Admin, reason, step-up, If-Match, never while a request is
open): `request_expiry_minutes` 5 to 240 (default 30), `backup_max_age_hours` 1 to 72 (default 24).

**Restore after a Settings reset** (the screen prints the paths): the database from the backup the run relied on, to the moment before the reset
(`run_started_at`): `db-restore.sh --pgdata <scratch> --port <scratch port> --target-time '<run_started_at>' --keep-running` (infra/RUNBOOK.md, section
8), then stop the API, replace the live database with a dump of the restored one (`pg_dump -Fc` from the scratch port, `dropdb`, `createdb`,
`pg_restore --exit-on-error`), start the API; the files with `sudo -u gsdn-pmis cp -a -n <quarantine>/. <STORAGE_DIR>/`. A restore loses the reset's
audit row and anything written after the target time.

## How to run the operator script

```bash
sudo bash pmis/infra/scripts/reset-project-data.sh                 # dry run: per table, rows to delete and rows kept; changes nothing
sudo bash pmis/infra/scripts/reset-project-data.sh --execute --reason "Owner request 2026-11-23: start the real data load"
```

`--execute` on a terminal asks for the phrase `RESET <database>` (for example `RESET pmis`). Without a terminal it refuses, unless both
`--yes-i-have-a-backup <dump>` (an existing `pg_dump -Fc` file that `pg_restore --list` reads) and `--confirm "RESET <database>"` are given.
The database name and port come from `DATABASE_URL` in `/etc/gsdn-pmis/pmis.env` (written by the installer; port 5433 when the URL has none),
the documents directory from `STORAGE_DIR` (default `/var/lib/gsdn-pmis/files`). The superuser is reached with `sudo -u postgres psql`.

Steps of `--execute`, stopping at the first failure (nothing changes before step 4 succeeds):

1. dry run (the plan is printed), reason check (at least 10 characters), confirmation;
2. free space check in `/var/backups/gsdn-pmis`: database size + documents size + 10 % + 256 MiB;
3. `systemctl stop gsdn-pmis-api`, then wait until no application connection is left (the service is started again on exit, whatever happens);
4. full backup: `pg_dump -Fc` to `/var/backups/gsdn-pmis/pre-reset-<timestamp>.dump`, verified with `pg_restore --list` (the list must hold the
   `audit_log` and `users` data), and `tar` of the documents directory to `pre-reset-<timestamp>-files.tar`, verified with `tar -t`;
5. `reset-project-data.sql` in ONE transaction (`data_reset_core`, see below); its output is kept in `pre-reset-<timestamp>.log`;
6. the stored files of the deleted rows are moved (`mv`, a rename on the same filesystem, never a delete) to
   `<STORAGE_DIR>-pre-reset-<timestamp>`, with a manifest `<...>.manifest` (MOVED / MISSING / REFUSED per key). The script stops before the
   backup if `STORAGE_DIR` is a mount point (the quarantine would be a copy, not a rename), if `STORAGE_DIR` or its parent is a symbolic link
   or `STORAGE_DIR` resolves elsewhere, or if the parent is not owned by root or is writable by group or others. The move itself
   (`infra/scripts/reset-project-data-quarantine.sh`) runs as the owner of the store through `runuser`, never as root, and refuses a key that is
   empty, absolute, has an empty, `.` or `..` component or is not in the API's key format, a key with a symbolic link on any component under the
   store, a target that is not a regular file, and a target whose resolved path leaves the store. A refused key is listed in the manifest and the
   summary and left in place, never deleted;
7. the API starts again; the summary prints the audit row id, the number of ended sessions, the files moved, the restore commands and how to
   delete the quarantine later.

Restore (printed by the script with the real paths): stop the API, `dropdb`, `createdb`, `pg_restore -d <db> --exit-on-error <dump>`,
`cp -a -n <quarantine>/. <STORAGE_DIR>/`, start the API. A restore loses the reset's own audit row and anything written after the backup.

## The transaction (`data_reset_core`, both ways)

`data_reset_core` and `data_reset_plan` are owned by the role `pmis_reset_owner` (NOLOGIN, BYPASSRLS), the only role with SELECT on every table of the
plan and DELETE on the DELETE and MIXED tables; EXECUTE is granted to `pmis_definer` (the Settings doors) only, and the superuser (the script) may call
anything. No other definer function gains these rights.

1. Only with execute: a reason of at least 10 characters; the advisory lock `353383097684` (one reset at a time, the script and Settings alike); for the
   script, no Settings request approved or running; `lock_timeout` 60 s.
2. Coverage: every base table of the `public` schema must be in the plan, every table of the plan must exist, the reset role must hold its rights on
   each, and no trigger of a plan table may be disabled; otherwise the reset stops (a table added by a later migration has to be classified here and in
   `data_reset_plan` first, and granted to the reset role).
3. Only with execute: locks on every table of the plan, in name order: EXCLUSIVE on the DELETE and MIXED tables, SHARE on the KEEP and log tables.
   Plain reads go on; every writer (a timer, a sign-in, another API process) waits until the commit. Then the marker `data_reset_marker` (the id of
   this transaction). The transaction runs at READ COMMITTED (the script's wrapper and the API alike): every statement after the locks sees all that
   was committed before them, and nothing can be committed into a table of the plan until the reset ends, so no row written just before the reset can
   stay behind unseen, and no timer can change a count under the checks. The reset role holds UPDATE on the KEEP and log tables only because
   `LOCK ... IN SHARE MODE` requires it; its code updates no KEEP table but `user_sessions` (to end the sessions).
4. Counts before: total rows, and kept rows (the `keep_where` of the plan) for every table. A dry run returns here (the temporary tables are dropped).
5. Deletes in foreign-key order, never `TRUNCATE`, no trigger disabled. The stored-object keys of the deleted rows are returned; a key that a kept row
   still names (a kept document file, a blank form, a template version) is never listed.
6. Checks, before anything is added to the logs: every KEEP and log table has exactly its row count of before; every MIXED table holds exactly
   its kept rows (none lost, none left over); every DELETE table is empty. Any difference: `RAISE EXCEPTION`, everything rolls back.
7. Every open session ends except the kept one (Settings: the runner's own session; the script: none kept) (`revoked_at = now()`,
   `revoke_reason = 'project_data_reset'`, `revoked_by` = the runner in Settings, NULL for the script); the session trigger writes one row per session
   to the security log, on its hash chain (`session_ended`, or `session_revoked_by_admin` when another admin ended it).
8. One audit row: action `project_data_reset`, entity `system` / `project_data`, `before` = rows per DELETE and MIXED table, `after` = rows deleted per
   table, kept rows per MIXED table, sessions ended, the kept session, files quarantined, and the caller's detail (the script: the operator's login, the
   backup path, `via` the script; Settings: `via` `settings`, the request, the requester, the approver, the runner, the approval reason, the backup row,
   the quarantine directory). Actor: none for the script (the operator acts on the server, as the migrations do), the runner in Settings. Counts only,
   never a value of a deleted row. The reason is the operator's `--reason` or the request's reason. The audit triggers seal it on the chain.
9. Final check: the Audit Log and its chain grew by exactly one row (the reset row, sealed); the security log grew by exactly one row per ended
   session; no other log moved. The marker is removed. The caller commits.

A dry run takes no lock stronger than a read lock and writes nothing but its own temporary tables, so it is safe while the API runs.

## Guards

- The Audit Log, its chain and field changes, the security log and its chain, the System Log, job runs, deployments, the mail outbox and the
  integrity runs are KEEP: nothing in the reset deletes or updates them, and their own triggers refuse it anyway.
- The row guards that refuse every DELETE (`doc_files_guard` "a stored document file is never deleted", `snag_photos_guard`, `dash_owner_rows_frozen`
  of `task_delay_periods`, `ps_manual_values`, `ps_manual_plans`, `dash_snapshot_runs`) and the backstops (`reg_backstop`, `wf_backstop`) let a DELETE
  through only when the current role is `pmis_reset_owner` AND `data_reset_marker` holds the id of the current transaction (`data_reset_deleting()`).
  Only `data_reset_core` writes the marker (pmis_app has no right on it), inside its own transaction, and removes it before the commit; an
  uncommitted marker is invisible to every other session. Before migration 0146 the script disabled `document_files_guard` and truncated the frozen
  tables; it no longer does either. The files themselves are not deleted: they are moved to the quarantine directory.
- The rows of `data_reset_requests` and `data_reset_request_files` are never deleted; a closed request and a decided file outcome never change.
- Tables that are append-only by design and are logs stay KEEP (`status_transitions`, `status_updates`, `mail_outbox`; see Open).

## Decisions per table

KEEP = every row stays. MIXED = the kept rows named in the last column stay, the rest go. DELETE = emptied. "Kept records" means the register
records of the Contractors register (companies, teams, contracts) and the vehicles of the Car Dispatcher: they are master data, not project data.

### Identity and access (KEEP)

| Table | Decision | Reason |
|---|---|---|
| users | KEEP | Accounts (the employee ID on the account is the staff registry link; there is no separate registry table on main). |
| local_credentials | KEEP | Passwords: users sign in as before. |
| user_totp | KEEP | Two-factor secrets and the enforced flag. |
| user_recovery_codes | KEEP | Two-factor recovery codes. |
| auth_pending | KEEP | Pending sign-ins (5 minutes, single use); identity, expires by itself. |
| user_sessions | KEEP | Rows stay; every open session is ended (revoked, reason `project_data_reset`). Safer: nobody keeps a page of deleted data open. |
| email_change_requests | KEEP | Identity requests. |
| phone_change_requests | KEEP | Identity requests. |
| user_invitations | KEEP | Invitations (owner: keep). |
| user_mfa_exemptions | KEEP | Per-user MFA exemptions (migration 0143): identity; the history stays in the Audit Log. |
| me_admin_requests | KEEP | Requests of users to the System Admins (POST /me/notify-admins, migration 0143): people and admin data, and the cooldown of each user. |
| roles | KEEP | Roles. |
| role_default_regions | KEEP | Role defaults. |
| role_default_modules | KEEP | Role defaults. |
| role_aliases | KEEP | Master StaffRole to role mapping (reference data). |
| user_role_assignments | KEEP | Role assignments. |
| user_role_assignment_regions | KEEP | Assignment scope. |
| user_role_assignment_modules | KEEP | Assignment scope. |
| user_role_assignment_profiles | KEEP | Assignment profiles. |
| permission_profiles | KEEP | Permission profiles. |
| permission_grants | KEEP | Grants of the profiles. |
| field_permissions | KEEP | Field-level rules. |
| groups | KEEP | Groups, System Admins included. |
| group_members | KEEP | Group members. |
| delegations | KEEP | Delegations. |
| delegation_grants | KEEP | Delegated actions. |
| delegation_regions | KEEP | Delegated regions. |
| departments | KEEP | Departments (direct managers and MFA exemptions are columns of `users`). |
| staff_registry | KEEP | The staff registry (0142): employee cards, kept like accounts. |
| staff_registry_visibility_state | KEEP | Staff registry visibility settings (0142). |
| staff_registry_visibility_fields | KEEP | Staff registry per-field defaults (0142). |
| staff_registry_visibility_entries | KEEP | Staff registry allow/deny entries (0142). |
| pmis_context_keys | KEEP | Session-context signing keys. |
| absences | KEEP | Staff absence records (migration 0140): they concern people, not sites; kept on the safe side (see Open). |

### Configuration (KEEP)

| Table | Decision | Reason |
|---|---|---|
| workflow_definitions | KEEP | Workflow versions. |
| workflow_streams | KEEP | Streams of a version. |
| workflow_views | KEEP | Stream views. |
| workflow_view_members | KEEP | Stream view members. |
| stage_definitions | KEEP | Milestones. |
| task_definitions | KEEP | Task definitions. |
| task_predecessors | KEEP | Task dependencies. |
| phase_gate_rules | KEEP | Gates and their conditions. |
| scenario_task_rules | KEEP | Scenario applicability rules. |
| scenario_rule_state | KEEP | Version counter of those rules. |
| sla_rules | KEEP | SLA rules. |
| sla_rule_sets | KEEP | SLA rule set versions. |
| sla_rule_set_items | KEEP | SLA rule set items. |
| sla_master_columns | KEEP | SLA to Master column map (reference). |
| work_calendars | KEEP | Calendar (weekend). |
| holidays | KEEP | Holidays. |
| dlp_versions | KEEP | Versions of the Defects Liability Period months (migration 0145): configuration; a PAC keeps the version in force on its date. |
| weight_sets | KEEP | Project Status weight sets. |
| weight_activities | KEEP | Weights per activity. |
| weight_items | KEEP | Weights per item. |
| list_catalogues | KEEP | Dropdown lists. |
| list_values | KEEP | List values. |
| field_definitions | KEEP | Custom field definitions. |
| field_list_values | KEEP | Custom field list values. |
| field_set_versions | KEEP | Field set version counters (template regeneration). |
| document_types | KEEP | Document Library definitions. |
| document_type_versions | KEEP | Published Document Library versions. |
| document_type_drafts | KEEP | Unpublished library drafts (configuration in progress). |
| document_type_placements | KEEP | Where a document type applies. |
| document_blank_forms | KEEP | Blank forms (their stored files stay). |
| template_definitions | KEEP | Templates. |
| template_versions | KEEP | Template versions (their stored files stay). |
| template_parts | KEEP | Sheet names of TPL-MASTER. |
| template_task_fields | KEEP | Task fields of stream templates. |
| template_task_rules | KEEP | Task template rules. |
| matrix_cells | KEEP | Responsibility Matrix rows. |
| matrix_cell_assignees | KEEP | Matrix holders. |
| matrix_state | KEEP | Matrix revision (ETag). |
| settings | KEEP | All settings, UI identity, notification policy, the Daily Plan settings (`daily_plan.settings`, migration 0149) and `table.display` (the Display defaults of the site-data tables, migration 0148, W8: configuration; no new table) included. |
| nav_item_catalogue | KEEP | Menu keys. |
| master_columns | KEEP | Master columns. |
| master_header_aliases | KEEP | Accepted Master header aliases. |
| regions | KEEP | Regions (seed). |
| region_aliases | KEEP | Region aliases (reference). |
| register_definitions | KEEP | Registers. |
| register_fields | KEEP | Register columns. |
| register_sections | KEEP | Register form sections. |
| register_task_sources | KEEP | Register to task date sources. |
| register_column_locks | KEEP | Column locks of register fields (configuration, not records). |
| task_field_sources | KEEP | Task fields fed by registers. |
| permit_types | KEEP | Permit types. |
| snag_types | KEEP | Snag types and photo rules. |
| snag_severities | KEEP | Snag severities. |
| doc_sequences | KEEP | Numbering sequences. |
| doc_sequence_counters | KEEP | Counters: kept so a number is never issued twice ("Numbers are never reused"). |
| doc_number_issues | KEEP | Every number issued, also of deleted forms: kept so a number is never reused. |
| warehouse_items | KEEP | Warehouse item master. |
| warehouse_item_need_rules | KEEP | Design-based need rules. |
| warehouse_region_vendors | KEEP | Setting tblRegionVendor. |
| as_built_items | KEEP | As-Built item list. |
| as_built_type_sources | KEEP | As-Built item groups. |
| contractor_rules | KEEP | Contractors register settings. |
| external_party_type_map | KEEP | Company Type to party type map. |
| team_specializations | KEEP | Team specializations. |
| team_scope_match | KEEP | Team scope rules. |
| team_scope_match_groups | KEEP | Team scope rules. |
| team_scope_match_meta | KEEP | Team scope rules version. |
| team_scope_match_scopes | KEEP | Team scope rules. |
| data_reset_marker | KEEP | The marker of a running reset (migration 0146): empty outside the reset's own transaction. |

### Master data of companies, between users, preferences (KEEP)

| Table | Decision | Reason |
|---|---|---|
| external_parties | KEEP | The company list (written by the approval of Contractors records). |
| external_party_contracts | KEEP | Company contracts (see Open). |
| external_teams | KEEP | Company and internal teams. |
| external_team_specializations | KEEP | Team specializations. |
| contractor_alerts_sent | KEEP | Dedup of contractor alerts (certificate expiry, order mismatch); harmless, see Open. |
| messages | KEEP | Messages between users (append-only). |
| message_threads | KEEP | Message threads. |
| message_participants | KEEP | Thread participants. |
| announcements | KEEP | Announcements. |
| announcement_targets | KEEP | Announcement targets. |
| announcement_recipients | KEEP | Announcement recipients. |
| announcement_responses | KEEP | Answers (append-only). |
| saved_views | KEEP | Saved views (user preferences). |
| saved_view_versions | KEEP | Saved view history (append-only). |
| saved_view_targets | KEEP | Saved view sharing. |
| saved_view_region_targets | KEEP | Saved view sharing. |
| document_grid_views | KEEP | Personal column layout of the documents grid. |

### Logs (KEEP, append-only)

| Table | Decision | Reason |
|---|---|---|
| audit_log | KEEP | Audit Log, 10 years, never deleted. Grows by the reset row only. |
| audit_log_chain | KEEP | Its hash chain. Grows by the reset row only. |
| audit_field_changes | KEEP | Field-level rows of the Audit Log. |
| security_log | KEEP | Sign-in and security log. Grows by one `session_ended` row per ended session. |
| security_log_chain | KEEP | Its hash chain. |
| log_chain_heads | KEEP | Heads of both chains (they move forward). |
| log_integrity_runs | KEEP | Integrity check runs. |
| system_log | KEEP | System/Error Log. |
| security_alerts | KEEP | Security alerts. |
| security_alert_state | KEEP | Alert state. |
| job_runs | KEEP | Job runs (append-only). |
| deployments | KEEP | Deployment log. |
| mail_outbox | KEEP | Outgoing mail log with its own retention purge; see Open. |
| status_transitions | KEEP | Approved state transitions (append-only by design, derived from step ledgers); see Open. |
| status_updates | KEEP | Weekly status updates by region or team (append-only by design, never removed); see Open. |
| data_reset_requests | KEEP | The requests of the Settings reset (migration 0146): who asked, who approved, who ran, the backup, the result. Evidence, never deleted. |
| data_reset_request_files | KEEP | The files of each Settings reset and where they went (moved, missing, refused). Evidence, never deleted. |

### MIXED

| Table | Kept rows | Reason |
|---|---|---|
| register_records | kept records (Contractors register; Car Dispatcher `vehicle`) | Companies, teams, contracts and vehicles are master data; every other record (procurement, GECOL, HLC, permits, warehouse, quality, issues, risks, change control, readiness, as-built, meetings, deliverables, dismantle, bookings, financial advances, RF and acquisition) is project data. |
| register_steps | of kept records | Approval history of the kept records. |
| register_level_actors | of kept records | Same. |
| register_level_voters | of kept records | Same. |
| register_record_locks | of kept records | Record locks follow their record. |
| team_scope_checks | of kept records | Scope checks of procurement orders go with them. |
| document_slots | slots of kept records | Company and team documents stay; slots of tasks and project records go. |
| document_files | files of kept slots | Same; the files of project data are quarantined. |
| document_record_snapshots | of kept records | Snapshot of a record's documents. |
| comments | comments on kept records | Task comments and comments on project records go. |
| comment_mentions | mentions of kept comments | Follow their comment. |
| levels_conversions | conversions of kept records | Two-level conversions of tasks and project records go. |
| import_batches | batches a kept record points at (`historical_direct_batch_id`) | Needed by the foreign key of the kept row; every other batch goes. |
| import_batch_rows | rows of kept batches | Follow their batch. |
| user_drafts | `form.*` drafts, `record.contractors.new` and drafts of kept records | Drafts of tasks and of project records point at deleted rows (the API shows a draft only while its target is readable). |
| stored_object_meta | every key not quarantined | The encryption envelopes of the quarantined files go (the dump keeps them for a restore). |

### Project data (DELETE)

| Table | Reason |
|---|---|
| sites | Sites: the root of the project data. |
| clusters | Clusters are created by site creation and carry the KPI Acceptance date per cluster. |
| task_instances | Site tasks. |
| task_cover_decisions | Lead decisions on a task (keep, reassign, act on behalf; migration 0140); they follow their task. |
| daily_plans | My Work > Daily Plan: one plan header per region and day (version, lock, reminder; migration 0149). Project data. |
| daily_plan_rows | The manual values, reasons, remarks, added and removed sites and the frozen rows of a locked day (migration 0149); they follow their plan and their site. |
| workflow_steps | Task step ledger. |
| task_level_actors | Task level holders. |
| task_level_voters | Task level votes. |
| task_delay_periods | Delay periods (TRUNCATE, see Guards). |
| admin_overrides | Admin overrides of sites and tasks. |
| site_gate_state | Gate state per site. |
| site_gate_events | Gate events per site. |
| site_scope_exceptions | Scope exceptions per site. |
| site_snapshots | Weekly site snapshots (KPI). |
| site_workflow_migrations | Site moves between workflow versions. |
| site_drafts | Proposed sites. |
| baseline_versions | Baseline plan versions (the project plan; no seed). |
| baseline_entries | Baseline dates per site. |
| change_requests | Change Control. |
| rf_design_records | RF & Design register. |
| acquisition_candidates | Acquisition register. |
| procurement_records | Procurement register (assignments included). |
| gecol_records | GECOL register. |
| hlc_records | HLC register. |
| hlc_pr_links | HLC PR links. |
| hlc_legacy_migrations | HLC legacy moves. |
| permit_records | Permits & HSE register. |
| quality_inspections | Quality register. |
| issues | Issue Log. |
| risks | Risk Register. |
| readiness_handover | Readiness & Handover register. |
| as_built_records | As-Built values (the item list stays). |
| meetings | Meetings. |
| meeting_actions | Meeting actions. |
| warehouse_serials | Serial stock (the item master stays). |
| warehouse_site_qty | Stock per site. |
| wh_movements | Warehouse movements (DN, RN, PL, adjustments). |
| wh_movement_lines | Movement lines. |
| vehicle_reservations | Car Dispatcher bookings (the vehicles stay). |
| assignment_readiness | Ready to mobilize per assignment. |
| snags | QC snags. |
| snag_photos | QC photos (TRUNCATE, see Guards; files quarantined). |
| snag_level_voters | Snag votes. |
| document_site_overrides | Document "not required" per site. |
| document_task_snapshots | Snapshot of a task's documents. |
| document_export_jobs | Export jobs, Master and log exports (files quarantined). |
| import_batch_jobs | Background runs of batches. |
| import_uploads | Background uploads. |
| master_reconciliation_runs | Legacy Master uploads (stored file quarantined). |
| master_reconciliation_rows | Their rows. |
| master_reconciliation_diffs | Their differences. |
| mi_apply_jobs | Master import apply jobs. |
| hrf_stage_marks | Staging marks of a Master load (transient). |
| hgd_marks | Transaction markers (transient). |
| notifications | Inbox. |
| watches | Follows. |
| progress_snapshots | Project Status snapshots. |
| dash_snapshot_runs | KPI snapshot runs (TRUNCATE, see Guards). |
| ps_manual_values | Manual Project Status values (TRUNCATE, see Guards). |
| ps_manual_plans | Manual Project Status plans (TRUNCATE, see Guards). |

Outside the `public` schema nothing is touched (`pmis_admin.migrations`, the installer's record of applied migrations, stays).

## Open

- **MinIO storage.** The script and Settings quarantine files on local disk only; with `S3_ENDPOINT` set the script stops before any change and
  Settings refuses the run (409 `storage_not_supported`). A MinIO variant (a copy to a `pre-reset-<timestamp>/` prefix, then a delete of the
  originals once the copy is verified) is not written: a copy-then-delete is not the rename the rules ask for.
- **Settings quarantine place.** `<STORAGE_DIR>/.pre-reset-<timestamp>` (inside the store) instead of the script's `<STORAGE_DIR>-pre-reset-<timestamp>`
  (beside it), because the API cannot write the data root. If the owner wants the same place for both, the installer must give the service a
  writable quarantine root on the same filesystem.
- **Settings while a reset runs.** A compromised `pmis_app` can take the advisory lock `353383097684` itself and keep every route at 503 (a denial of
  service, never a deletion); it can already do worse. Nothing in the API takes that lock outside `data_reset_core`.
- **Backup rows.** A server needs the updated `db-backup.sh` (migration 0146 era) and one successful backup after it before a Settings run is
  possible. The operator script keeps its own pre-reset `pg_dump`.
- **External party contracts** (`external_party_contracts`, contract records of the Contractors register) are kept as master data of the
  companies. If the owner sees contracts as project data, they move to DELETE.
- **status_transitions, status_updates, mail_outbox** stay (append-only by design). `status_transitions` then holds history of deleted tasks
  and records (no foreign key; joins drop them). `mail_outbox` may hold queued mails about deleted tasks that are still sent after the reset.
  `status_updates` holds weekly status texts of the old project.
- **contractor_alerts_sent** stays: its order-mismatch rows name deleted orders (harmless, new orders get new ids).
- **Quarantine retention.** Project documents are kept for the life of the project plus 10 years (non-functional requirements). The quarantine
  directory and the two backups should be kept (in the encrypted backup store) until the owner decides; the script never deletes them.
- **Backup encryption.** `pre-reset-*.dump` and the tar are written root-only (0600) but not encrypted; copy them to the encrypted backup store.
- **Absences** (`absences`, migration 0140) are kept: they belong to people, not to sites, and past and planned leave stays useful for the
  new project. If the owner sees them as project data, they move to DELETE (nothing references them).
- **Staff registry.** There is no separate staff registry table on main (the employee ID lives on `users`); when it is added it must be
  classified KEEP here and in the plan, or the reset refuses to run.
