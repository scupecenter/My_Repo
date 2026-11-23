# Project data reset: the contract

Owner request (2026-11-23): "reset all data in the system except the users and accounts". Scope approved by the owner the same day: keep identity,
configuration, the staff registry and all logs; delete the project data (sites and everything hanging off them, registers, documents, imports,
notifications, snapshots).

This page is the reviewable contract of the operator script. The script must say the same as this page, table for table:

| File | What it is |
|---|---|
| `infra/scripts/reset-project-data.sh` | Run as root on the server. Dry run by default; `--execute` backs up, stops the API, resets, quarantines the files. |
| `infra/scripts/reset-project-data.sql` | The database part: the plan (`reset_plan`), the deletes, the checks, the session end and the audit row, in one transaction. |
| `tests/ops/reset-project-data.test.mjs` | Test on a scratch database built from every migration, with synthetic data (`tests/ops/reset-seed.sql`). |

No migration and no contract change: the script uses the existing tables, triggers and audit chain.

## How to run it

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
5. `reset-project-data.sql` in ONE transaction (see below); its output is kept in `pre-reset-<timestamp>.log`;
6. the stored files of the deleted rows are moved (`mv`, a rename on the same filesystem, never a delete) to
   `<STORAGE_DIR>-pre-reset-<timestamp>`, with a manifest `<...>.manifest` (MOVED / MISSING / SKIPPED per key). The script stops before the
   backup if `STORAGE_DIR` is a mount point (the quarantine would be a copy, not a rename);
7. the API starts again; the summary prints the audit row id, the number of ended sessions, the files moved, the restore commands and how to
   delete the quarantine later.

Restore (printed by the script with the real paths): stop the API, `dropdb`, `createdb`, `pg_restore -d <db> --exit-on-error <dump>`,
`cp -a -n <quarantine>/. <STORAGE_DIR>/`, start the API. A restore loses the reset's own audit row and anything written after the backup.

## The transaction

1. Coverage: every base table of the `public` schema must be in the plan, and every table of the plan must exist; otherwise the reset stops
   (a table added by a later migration has to be classified here and in the plan first).
2. Counts before: total rows, and kept rows (the `keep_where` of the plan) for every table.
3. Deletes in foreign-key order, never `TRUNCATE ... CASCADE`. The stored-object keys of the deleted rows are printed first (`FILE|key`); a key
   that a kept row still names (a kept document file, a blank form, a template version) is never listed.
4. Checks, before anything is added to the logs: every KEEP and log table has exactly its row count of before; every MIXED table holds exactly
   its kept rows (none lost, none left over); every DELETE table is empty; `document_files_guard` is enabled again. Any difference:
   `RAISE EXCEPTION`, everything rolls back.
5. Every open session ends (`revoked_at = now()`, `revoke_reason = 'project_data_reset'`); the session trigger writes one `session_ended` row per
   session to the security log, on its hash chain.
6. One audit row, as the migrations write theirs (a direct insert with no actor, since the operator acts on the server, not as a signed-in user;
   `log_audit_write` needs a signed-in actor): action `project_data_reset`, entity `system` / `project_data`, `before` = rows per DELETE and MIXED
   table, `after` = rows deleted per table, kept rows per MIXED table, sessions ended, files quarantined, the operator's login and the backup path.
   Counts only, never a value of a deleted row. The reason is the operator's `--reason`. The audit triggers seal it on the chain.
7. Final check: the Audit Log and its chain grew by exactly one row (the reset row, sealed); the security log grew by exactly one row per ended
   session; no other log moved. Then COMMIT.

The transaction runs at REPEATABLE READ, so a timer that writes a job run meanwhile cannot make the counts differ.

## Guards

- The Audit Log, its chain and field changes, the security log and its chain, the System Log, job runs, deployments, the mail outbox and the
  integrity runs are KEEP: nothing in the reset deletes or updates them, and their own triggers refuse it anyway.
- The row backstops of the workflow and register tables (`wf_backstop`, `reg_backstop`, `idm_backstop`) let the superuser through
  (`app_is_seeding()`, the same path the migrations use); the reset runs only as the superuser.
- `document_files_guard` refuses every DELETE ("a stored document file is never deleted; withdraw or supersede it"). It protects the normal
  workflow; the owner's approved scope explicitly removes the documents of project data. It is switched off with `ALTER TABLE ... DISABLE TRIGGER`
  for the one DELETE of the project files only, inside the transaction (the exclusive lock means no other session sees the table meanwhile), and
  the checks fail the reset if it is not enabled again. The files themselves are not deleted: they are moved to the quarantine directory.
- `task_delay_periods`, `ps_manual_values`, `ps_manual_plans`, `dash_snapshot_runs` ("rows are never deleted") and `snag_photos` ("a stored snag
  photo is never deleted") are project data the owner asked to remove (delay periods, manual Project Status values and plans, KPI snapshot runs, QC
  photos). Nothing references them; they are emptied with one `TRUNCATE` without CASCADE (row triggers do not fire on TRUNCATE; PostgreSQL refuses
  a TRUNCATE of a table that another, not truncated, table references).
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
| settings | KEEP | All settings, UI identity and notification policy included. |
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

- **MinIO storage.** The script quarantines files on local disk only; with `S3_ENDPOINT` set it stops before any change. A MinIO variant
  (`mc mv` to a `pre-reset-<timestamp>/` prefix) is not written.
- **External party contracts** (`external_party_contracts`, contract records of the Contractors register) are kept as master data of the
  companies. If the owner sees contracts as project data, they move to DELETE.
- **status_transitions, status_updates, mail_outbox** stay (append-only by design). `status_transitions` then holds history of deleted tasks
  and records (no foreign key; joins drop them). `mail_outbox` may hold queued mails about deleted tasks that are still sent after the reset.
  `status_updates` holds weekly status texts of the old project.
- **contractor_alerts_sent** stays: its order-mismatch rows name deleted orders (harmless, new orders get new ids).
- **Quarantine retention.** Project documents are kept for the life of the project plus 10 years (non-functional requirements). The quarantine
  directory and the two backups should be kept (in the encrypted backup store) until the owner decides; the script never deletes them.
- **Backup encryption.** `pre-reset-*.dump` and the tar are written root-only (0600) but not encrypted; copy them to the encrypted backup store.
- **Staff registry.** There is no separate staff registry table on main (the employee ID lives on `users`); when it is added it must be
  classified KEEP here and in the plan, or the reset refuses to run.
