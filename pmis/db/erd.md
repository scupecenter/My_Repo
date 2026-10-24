# GSDN PMIS - Entity Relationship Diagram

Source of truth: `apps/api/prisma/schema.prisma` (71 models, PostgreSQL 16). Field names are snake_case and shared with the importer mapping (`tools/master-import/mapping.csv`). Task codes (`task_definitions.code`, for example `CW_STA`, `TE_PAC`) must be aligned with the domain-analyst task catalogue once it exists in `docs/spec/`.

```mermaid
erDiagram
  REGIONS ||--o{ SITES : has
  USERS ||--o{ USER_ROLE_ASSIGNMENTS : holds
  ROLES ||--o{ USER_ROLE_ASSIGNMENTS : by_role
  SUB_ROLES ||--o{ USER_ROLE_ASSIGNMENTS : by_sub_role
  USER_ROLE_ASSIGNMENTS ||--o{ USER_ROLE_ASSIGNMENT_REGIONS : limits
  REGIONS ||--o{ USER_ROLE_ASSIGNMENT_REGIONS : in
  USER_ROLE_ASSIGNMENTS ||--o{ USER_ROLE_ASSIGNMENT_MODULES : sees
  ROLES ||--o{ SUB_ROLES : contains
  GROUPS ||--o{ GROUP_MEMBERS : has
  USERS ||--o{ GROUP_MEMBERS : joins
  USERS ||--o{ DELEGATIONS : from_to

  CLUSTERS ||--o{ SITES : groups
  SITES ||--o{ TASK_INSTANCES : has
  STAGE_DEFINITIONS ||--o{ TASK_DEFINITIONS : contains
  TASK_DEFINITIONS ||--o{ TASK_INSTANCES : instantiates
  EXTERNAL_PARTIES ||--o{ TASK_INSTANCES : responsible
  EXTERNAL_PARTIES ||--o{ EXTERNAL_TEAMS : has
  TASK_INSTANCES ||--o{ WORKFLOW_STEPS : logs
  TASK_INSTANCES ||--o{ COMMENTS : thread
  STAGE_DEFINITIONS ||--o{ MATRIX_CELLS : levels
  TASK_DEFINITIONS ||--o{ MATRIX_CELLS : overrides
  MATRIX_CELLS ||--o{ MATRIX_CELL_ASSIGNEES : holders

  DOCUMENT_TYPES ||--o{ DOCUMENT_TYPE_PLACEMENTS : placed
  TASK_DEFINITIONS ||--o{ DOCUMENT_TYPE_PLACEMENTS : on
  SNAG_TYPES ||--o{ DOCUMENT_TYPE_PLACEMENTS : on
  DOCUMENT_TYPES ||--o{ DOCUMENT_SLOTS : slot_of
  TASK_INSTANCES ||--o{ DOCUMENT_SLOTS : needs
  DOCUMENT_SLOTS ||--o{ DOCUMENT_FILES : versions

  SITES ||--o{ SNAGS : has
  SNAG_TYPES ||--o{ SNAGS : typed
  TASK_INSTANCES ||--o{ SNAGS : blocks
  SNAGS ||--o{ SNAG_PHOTOS : evidence

  TEMPLATE_DEFINITIONS ||--o{ TEMPLATE_VERSIONS : versions
  TEMPLATE_VERSIONS ||--o{ IMPORT_BATCHES : used_by
  IMPORT_BATCHES ||--o{ IMPORT_BATCH_ROWS : rows

  BASELINE_VERSIONS ||--o{ BASELINE_ENTRIES : entries
  SITES ||--o{ BASELINE_ENTRIES : planned
  SITES ||--o{ CHANGE_REQUESTS : changes

  SITES ||--o| RF_DESIGN_RECORDS : rf
  SITES ||--o{ ACQUISITION_CANDIDATES : candidates
  SITES ||--o{ PROCUREMENT_RECORDS : pr_po_wo
  SITES ||--o| GECOL_RECORDS : power
  SITES ||--o| HLC_RECORDS : fiber
  SITES ||--o{ PERMIT_RECORDS : permits
  SITES ||--o{ QUALITY_INSPECTIONS : quality
  SITES ||--o{ ISSUES : issues
  SITES ||--o| READINESS_HANDOVER : handover
  SITES ||--o| AS_BUILT_RECORDS : as_built
  WAREHOUSE_ITEMS ||--o{ WAREHOUSE_SERIALS : serials
  WAREHOUSE_ITEMS ||--o{ WAREHOUSE_SITE_QTY : qty
  MEETINGS ||--o{ MEETING_ACTIONS : actions
  WORK_CALENDARS ||--o{ HOLIDAYS : has
  WORK_CALENDARS ||--o{ SLA_RULES : counts_in
  TASK_DEFINITIONS ||--o{ SLA_RULES : versions
  REGIONS ||--o{ SLA_RULES : override
  SLA_RULES ||--o{ TASK_INSTANCES : snapshot
  TASK_DEFINITIONS ||--o{ TASK_PREDECESSORS : needs
  FIELD_DEFINITIONS ||--o{ FIELD_LIST_VALUES : options
  FIELD_DEFINITIONS ||--o{ FIELD_PERMISSIONS : access
  TASK_DEFINITIONS ||--o{ FIELD_DEFINITIONS : task_scoped
  ROLES ||--o{ FIELD_PERMISSIONS : by_role
  PERMISSION_PROFILES ||--o{ FIELD_PERMISSIONS : by_profile
  PERMISSION_PROFILES ||--o{ PERMISSION_GRANTS : grid
  PERMISSION_PROFILES ||--o{ USER_ROLE_ASSIGNMENT_PROFILES : applied
  USER_ROLE_ASSIGNMENTS ||--o{ USER_ROLE_ASSIGNMENT_PROFILES : has
  WEIGHT_SETS ||--o{ WEIGHT_ACTIVITIES : has
  WEIGHT_ACTIVITIES ||--o{ WEIGHT_ITEMS : has
  WEIGHT_SETS ||--o{ PROGRESS_SNAPSHOTS : used_by
```

Not drawn (no foreign keys by design): `audit_log`, `system_log`, `settings`, `holidays`, `notifications`, `phase_gate_rules`, `risks`. Audit and system logs hold ids as plain values so that deleting or deactivating a row can never touch history.

## Aggregates

**Identity and access.** `users` are created at first Microsoft 365 sign-in (`m365_object_id`, `email`) and stay `pending_assignment`, seeing nothing, until an admin assigns roles. The 4-digit `employee_id` is unique. Role assignment is many-to-many: each `user_role_assignments` row links one user to exactly one role or one sub-role (CHECK) with its own `permission_level`, `team`, `valid_from`/`valid_to` (null = until removed), `is_primary` (at most one per user), `assigned_by` and `assigned_at`. Scopes are children of the assignment: `user_role_assignment_regions` and `user_role_assignment_modules`; scope is an explicit opt-in: `all_regions` / `all_modules` flags (default false) or child rows; no rows and flag false means no access, enforced by a deferred constraint trigger. There is deliberately no user-level default for role, level, region or module, because it would conflict with the union rule and create two places to edit. Effective access is the union of the user's active assignments (user active, valid dates current): `app_resolve_region_ids(user_id)` returns `*` only if an active assignment has `all_regions = true`, else the union list, else an empty string (no access); `app_resolve_modules(user_id)` does the same for modules. The API puts the first into `app.region_ids` for RLS. `groups` and `group_members` are named sets of users; the System Admins group is flagged. `delegations` record scope (full or partial), valid_from/valid_to and a revoked flag. The "at least one active admin" and "no re-delegation" rules are enforced in the service layer and verified by tests.

**Sites and clusters.** `sites` carries the Master identity block (site code, owner id, name, region, sub region, coordinates, type, RF scenario, uplink, tower data), the delivery scenario, batch, phase, the six scope flags (Master AA:AF) and the current/next milestone and overall status. `clusters` hold the KPI acceptance date once, applied to all member sites. Extra RF data lives in `rf_design_records`; acquisition candidates in `acquisition_candidates`.

**Tasks and workflow.** `stage_definitions` (10 milestones, `approval_levels` default 3) own `task_definitions`, which carry SLA, applicability `condition_rule` (scope flags and scenario) and a default external party type. A `task_instances` row exists per site and task, with state, current level, the resolved ball-in-court (user, group or role), the responsible `external_parties` row (for example A&T Global), baseline/planned/actual/submitted/approved dates and a JSON `values` bag for task-specific results. `region_id` is denormalised from the site so row-level security and region queries never need a join. `workflow_steps` is the per-task history: level, action (including `auto_skip`, `claim`, `admin_override`), resolved holder, `claimed_by`, mandatory rejection note, override flag and reason, and the `on_behalf_of` delegator. `comments` form the thread.

**Responsibility matrix.** `matrix_cells` (stage or task x level 1..3, optional region) with a rule `any_one` or `all_members`; `matrix_cell_assignees` mixes users, roles, sub-roles and groups. A task-level cell overrides the stage default. When one person holds consecutive levels the engine writes an `auto_skip` step.

**Document Library, slots and files.** `document_types` are data: kind, mandatory flag, condition JSON, formats, size, min/max files, photo rules, expiry, blank form, applies-to policy, active flag (deactivate only). `document_type_placements` place a type on tasks, QC snag types or registers. `document_slots` are instantiated per task (one per required document, per candidate where needed) with status and reject reason; `document_files` keep every version (`file_group_id` + `version`, `is_current`), the automatic stored name, storage key and SHA-256.

**QC snags.** `snag_types` configure photo requirements (min count, shots, formats, size) and whether they block preliminary acceptance. `snags` belong to a site and optionally a task (the count drives the lock reason). `snag_photos` store EXIF date, an `unknown_capture_date` flag, a `before_snag_raised` rejection flag, GPS, distance, geofence result and radius (default 300 m), in-app-camera flag and the stamp metadata. Acceptance documents and QC photos are deliberately separate tables.

**Templates and import.** `template_definitions` (the `template_id` embedded in hidden sheet `_tpl`) and `template_versions` (version, header checksum, column spec). `import_batches` record every upload, including the Master import (`source = master_import`), and `import_batch_rows` hold the parsed payload, the diff against current data, errors, and the row-level decision (pending, approved, rejected). Nothing is written to target tables until rows are approved; the importer never writes directly.

**Baseline, calendar and change control.** `baseline_versions` and `baseline_entries` hold one date per site per milestone per version; `phase_gate_rules` hold min/max working days per link. `holidays` feed working-day math (weekend Friday/Saturday is code, not data). `change_requests` cover scope and date changes and Suspension/Resumption pairs; on resumption `shift_working_days` is computed and applied to the gates.

**Registers.** Lean tables, each its own module: `procurement_records` (PR/PO/WO), `external_parties` and `external_teams` (contractors, vendors, GECOL, HLC), `gecol_records`, `hlc_records`, `permit_records` (permits and HSE checks as JSON), `warehouse_items`/`warehouse_serials`/`warehouse_site_qty`, `quality_inspections`, `issues` (many per site), `risks`, `readiness_handover`, `as_built_records` (quantities JSON), `meetings`/`meeting_actions`. Region-bearing registers carry `region_id` for RLS. Global rows (risks, meetings, clusters, default matrix cells, project-wide change requests, unallocated warehouse serials) are marked by an explicit `is_global` flag with CHECK constraints; a NULL region alone never makes a row global, and only `*` sessions may write global rows. Site-bound children use composite FKs `(site_id, region_id)` to `sites`, RESTRICT on delete so a deleted site cannot orphan or expose rows. `comments.region_id` is NOT NULL, tied to the task by composite FK with ON DELETE CASCADE.

**Editable task definitions.** Milestones (`stage_definitions`), phase gates (`phase_gate_rules`) and the milestone tasks are fixed: `is_protected` plus triggers forbid inserting, deleting, renaming, reordering or deactivating them (only `approval_levels` and the gate min/max are editable); the migration/seed role `pmis_migrator` creates them (protection bypass depends on the database role, never on a session setting). Ordinary `task_definitions` belong to a fixed stage that never changes and can be added, renamed, reordered (`sort_order`), re-linked (`task_predecessors`, cycles rejected), flagged `counts_toward_milestone` (default true) and deactivated. Every change bumps `version`, stamps `effective_from`, and requires a `reason` and `changed_by`. The admin function `admin_add_task_to_open_sites()` (definer, full-access session only, audited) adds a new task to the open sites chosen by the API, taking its SLA rule from `sla_rule_for()`; document slots, template and matrix cells come from the existing placement, template and matrix tables when the task opens.

**Custom fields.** `field_definitions` (entity type covering sites, tasks and every register, code, EN/AR labels, data type, required, validation JSON, default, section, sort, in_templates/in_exports/in_list_filters, Master export column, version) and `field_list_values` (editable options). Values live in a `custom` JSONB column on each entity table, with a GIN index and a validation trigger that checks type, required, list membership, min/max/pattern and unknown keys. A field is deactivated, never deleted once it holds values (checked across all regions by a definer function); a deactivated field keeps its values read-only. `field_permissions` give field x role or permission profile -> hidden/read/edit (most permissive wins; no rule = the entity permission decides). `field_set_versions` counts changes per entity type, and `template_versions.field_set_version` records the count at build time so older templates are rejected.

**Permission grid.** `permission_profiles` are named sets; `permission_grants` are profile x module/screen x action (view, create, edit, delete, approve, export, import, download_documents, view_audit, administer). Profiles attach to assignments many-to-many (`user_role_assignment_profiles`). `app_resolve_permissions(user)` returns the union over the user's active assignments, each limited to its own modules; `app_has_permission()` treats a grant on `sites` as covering `sites.*`; `app_resolve_field_access()` resolves field rules. All three are definer functions callable for oneself (`app.user_id`) or from a full-access session. Regions stay with RLS.

**SLA and calendar.** `work_calendars` hold the weekend days (default Friday and Saturday) and own their `holidays`. `sla_rules` are versioned per task: min (target) and max (limit) working days, `start_event` (task code, milestone or gate code), optional scenario and region overrides, calendar, effective_from/to, reason, changed_by/at. An exclusion constraint forbids overlapping ranges for the same task and scope. A rule used by tasks is frozen (only `effective_to` may change; edits create a new version). `task_instances.sla_rule_id` is the snapshot taken when the task opens; `sla_rule_for()` picks the most specific rule, and re-pointing open tasks is an admin-only path (`app.allow_sla_repoint`, never for approved tasks).

**Weights and progress.** `weight_sets` (project_status, health_index, delay_attribution) are versioned with effective dates, a reason, author and draft/published status. `weight_activities` and `weight_items` carry the weights, unit, measure rule and source. Publishing is enforced in the database by a deferred constraint trigger: activities of a set total 100 and the items of each activity total 100 (tolerance 0.001). Published sets are immutable and cannot overlap in time. `progress_snapshots` (weekly, project-wide or per region) store `weight_set_id` and the computed values, so old reports keep their numbers and can be re-run with another set.

**Logs, notifications and settings.** `audit_log` is append-only (BEFORE UPDATE/DELETE/TRUNCATE triggers plus REVOKE on the app role, `db/sql/001`) with actor, on-behalf-of, before/after JSON, reason and override flag. `system_log` is separate, with a 12-month purge by a job role that cannot touch the audit log. `notifications` are in-app and email. `settings` is a key/value table for admin toggles such as `require_mfa`, `geofence_radius_m`, default approval levels.

**Region security.** The API sets `app.region_ids` per transaction; policies in `db/sql/002_region_rls.sql` filter `sites` and every region-bearing table (fail closed when unset; `*` = all).
