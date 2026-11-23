-- GSDN Workspace: reset the PROJECT DATA of a server, keeping users, accounts and configuration (owner request and approved scope, 2026-11-23).
-- The reviewable contract of this file is docs/ops/data-reset.md: every table of the public schema is listed there as KEEP, DELETE or MIXED with
-- its reason, and the plan below (pg_temp.reset_plan) must say the same. Run it only through infra/scripts/reset-project-data.sh, as the
-- superuser, while the API is stopped:
--
--   psql -X -v ON_ERROR_STOP=1 -At -F '|' -v execute=false -v reason='...' -v operator='...' -v backup='...' -d pmis -f reset-project-data.sql
--
-- execute=false (dry run): counts only, then ROLLBACK. Nothing is written but the session's own temporary tables, and no lock stronger than a read
--   lock is taken, so it is safe while the API runs.
-- execute=true: ONE transaction. Deletes the DELETE tables and the project rows of the MIXED tables, checks that no KEEP table and no kept row of a
--   MIXED table lost or gained a row (RAISE EXCEPTION otherwise: everything rolls back), ends every open session, writes one audit row
--   (action project_data_reset, counts only) on the audit hash chain, checks the chains moved exactly as expected, then COMMIT.
--
-- Output lines (for the script): PLAN|table|action|rows_now|rows_to_delete|rows_kept, FILE|storage_key (execute only: the stored objects of the
-- deleted rows, to be moved to the quarantine directory after the commit), DONE|audit_id|sessions_ended|files.
--
-- The Audit Log, the security log, their chains, the System Log and the other logs are never deleted or altered here: they are KEEP tables, and
-- their own triggers refuse it anyway. The only guard trigger this file steps over is document_files_guard ("a stored document file is never
-- deleted"), switched off inside the transaction for the one DELETE of the project files and switched on again before the checks; the frozen
-- tables ps_manual_values, ps_manual_plans, dash_snapshot_runs, task_delay_periods and snag_photos are emptied with TRUNCATE (row triggers do not fire on TRUNCATE; nothing references
-- them). See docs/ops/data-reset.md, section "Guards".

\set ON_ERROR_STOP 1
\if :{?execute}
\else
  \echo 'reset-project-data.sql: set -v execute=true|false'
  \quit
\endif
\if :{?reason}
\else
  \set reason ''
\endif
\if :{?operator}
\else
  \set operator ''
\endif
\if :{?backup}
\else
  \set backup ''
\endif

SET client_min_messages = warning;
BEGIN ISOLATION LEVEL REPEATABLE READ;   -- the counts see this transaction only, never a concurrent timer's log row
SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = 0;
SELECT set_config('pmis.reset_execute', :'execute', true) \g /dev/null
SELECT set_config('pmis.reset_reason', :'reason', true) \g /dev/null
SELECT set_config('pmis.reset_operator', :'operator', true) \g /dev/null
SELECT set_config('pmis.reset_backup', :'backup', true) \g /dev/null

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'reset-project-data: run as the database superuser (sudo -u postgres psql)';
  END IF;
  IF current_setting('pmis.reset_execute')::boolean AND char_length(btrim(current_setting('pmis.reset_reason'))) < 10 THEN
    RAISE EXCEPTION 'reset-project-data: a reason of at least 10 characters is required';
  END IF;
END $$;

-- ------------------------------------------------------------------------------------------------------------------------------------------
-- 1. What is kept inside the MIXED tables (computed once, before anything is deleted)
-- ------------------------------------------------------------------------------------------------------------------------------------------
-- Master data that lives in the generic register table: the Contractors register (companies, teams, contracts: the company list behind
-- external_parties, external_teams, external_party_contracts) and the vehicles of the Car Dispatcher. Every other register record is project data.
CREATE TEMP TABLE reset_keep_entities ON COMMIT DROP AS
  SELECT DISTINCT entity_id FROM public.register_records
  WHERE register_key = 'contractors' OR (register_key = 'car_dispatcher' AND record_type = 'vehicle');
CREATE TEMP TABLE reset_keep_records ON COMMIT DROP AS
  SELECT id FROM public.register_records WHERE entity_id IN (SELECT entity_id FROM reset_keep_entities);
-- Document slots and files of kept records (company and team documents); the slots of tasks and of project records go.
CREATE TEMP TABLE reset_keep_slots ON COMMIT DROP AS
  SELECT id FROM public.document_slots WHERE register_entity_id IN (SELECT entity_id FROM reset_keep_entities);
-- Import batches that a kept record still points at (foreign key register_records.historical_direct_batch_id); every other batch goes.
CREATE TEMP TABLE reset_keep_batches ON COMMIT DROP AS
  SELECT DISTINCT historical_direct_batch_id AS id FROM public.register_records
  WHERE id IN (SELECT id FROM reset_keep_records) AND historical_direct_batch_id IS NOT NULL;
-- Comments on kept records.
CREATE TEMP TABLE reset_keep_comments ON COMMIT DROP AS
  SELECT id FROM public.comments WHERE entity_type = 'register_record' AND entity_id IN (SELECT entity_id FROM reset_keep_entities);
-- Stored objects of the deleted rows, never one that a kept row still names. They are moved (never deleted) to the quarantine directory.
CREATE TEMP TABLE reset_files ON COMMIT DROP AS
  SELECT DISTINCT k AS storage_key FROM (
    SELECT storage_key AS k FROM public.document_files WHERE slot_id NOT IN (SELECT id FROM reset_keep_slots)
    UNION ALL SELECT storage_key FROM public.snag_photos
    UNION ALL SELECT storage_key FROM public.document_export_jobs
    UNION ALL SELECT storage_key FROM public.master_reconciliation_runs
  ) x
  WHERE k IS NOT NULL
    AND k NOT IN (SELECT storage_key FROM public.document_files WHERE slot_id IN (SELECT id FROM reset_keep_slots) AND storage_key IS NOT NULL)
    AND k NOT IN (SELECT storage_key FROM public.document_blank_forms WHERE storage_key IS NOT NULL)
    AND k NOT IN (SELECT storage_key FROM public.template_versions WHERE storage_key IS NOT NULL);

-- ------------------------------------------------------------------------------------------------------------------------------------------
-- 2. The plan: every base table of the public schema, with its decision (docs/ops/data-reset.md is the same list, with the reasons)
-- ------------------------------------------------------------------------------------------------------------------------------------------
-- keep_where: the rows that stay ('true' for KEEP, 'false' for DELETE). log = an append-only log: KEEP, it may only grow, by the rows named in
-- the final check (the reset's own audit row, the session-end rows).
CREATE TEMP TABLE reset_plan (tbl text PRIMARY KEY, action text NOT NULL CHECK (action IN ('keep', 'delete', 'mixed', 'log')), keep_where text NOT NULL,
  rows_before bigint, kept_before bigint, rows_after bigint, kept_after bigint) ON COMMIT DROP;

INSERT INTO reset_plan (tbl, action, keep_where)
SELECT t, 'keep', 'true' FROM unnest(ARRAY[
  -- identity and access
  'users', 'local_credentials', 'user_totp', 'user_recovery_codes', 'auth_pending', 'user_sessions', 'email_change_requests', 'phone_change_requests',
  'user_invitations', 'roles', 'role_default_regions', 'role_default_modules', 'role_aliases', 'user_role_assignments', 'user_role_assignment_regions',
  'user_role_assignment_modules', 'user_role_assignment_profiles', 'permission_profiles', 'permission_grants', 'field_permissions', 'groups',
  'group_members', 'delegations', 'delegation_grants', 'delegation_regions', 'departments', 'pmis_context_keys',
  -- staff registry (0142)
  'staff_registry', 'staff_registry_visibility_state', 'staff_registry_visibility_fields', 'staff_registry_visibility_entries',
  -- configuration
  'workflow_definitions', 'workflow_streams', 'workflow_views', 'workflow_view_members', 'stage_definitions', 'task_definitions', 'task_predecessors',
  'phase_gate_rules', 'scenario_task_rules', 'scenario_rule_state', 'sla_rules', 'sla_rule_sets', 'sla_rule_set_items', 'sla_master_columns',
  'work_calendars', 'holidays', 'weight_sets', 'weight_activities', 'weight_items', 'list_catalogues', 'list_values', 'field_definitions',
  'field_list_values', 'field_set_versions', 'document_types', 'document_type_versions', 'document_type_drafts', 'document_type_placements',
  'document_blank_forms', 'template_definitions', 'template_versions', 'template_parts', 'template_task_fields', 'template_task_rules', 'matrix_cells',
  'matrix_cell_assignees', 'matrix_state', 'settings', 'nav_item_catalogue', 'master_columns', 'master_header_aliases', 'regions', 'region_aliases',
  'register_definitions', 'register_fields', 'register_sections', 'register_task_sources', 'register_column_locks', 'task_field_sources',
  'permit_types', 'snag_types', 'snag_severities', 'doc_sequences', 'doc_sequence_counters', 'doc_number_issues', 'warehouse_items',
  'warehouse_item_need_rules', 'warehouse_region_vendors', 'as_built_items', 'as_built_type_sources', 'contractor_rules', 'external_party_type_map',
  'team_specializations', 'team_scope_match', 'team_scope_match_groups', 'team_scope_match_meta', 'team_scope_match_scopes',
  -- master data of companies and their contracts and teams
  'external_parties', 'external_party_contracts', 'external_teams', 'external_team_specializations', 'contractor_alerts_sent',
  -- between users, and personal preferences
  'messages', 'message_threads', 'message_participants', 'announcements', 'announcement_targets', 'announcement_recipients',
  'announcement_responses', 'saved_views', 'saved_view_versions', 'saved_view_targets', 'saved_view_region_targets', 'document_grid_views'
]) t;

INSERT INTO reset_plan (tbl, action, keep_where)
SELECT t, 'log', 'true' FROM unnest(ARRAY[
  'audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads', 'log_integrity_runs', 'system_log',
  'security_alerts', 'security_alert_state', 'job_runs', 'deployments', 'mail_outbox', 'status_transitions', 'status_updates'
]) t;

INSERT INTO reset_plan (tbl, action, keep_where) VALUES
  ('register_records',         'mixed', 'id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('register_steps',           'mixed', 'record_id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('register_level_actors',    'mixed', 'record_id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('register_level_voters',    'mixed', 'record_id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('register_record_locks',    'mixed', 'record_id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('team_scope_checks',        'mixed', 'record_id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('document_slots',           'mixed', 'id IN (SELECT id FROM pg_temp.reset_keep_slots)'),
  ('document_files',           'mixed', 'slot_id IN (SELECT id FROM pg_temp.reset_keep_slots)'),
  ('document_record_snapshots','mixed', 'entity_id IN (SELECT entity_id FROM pg_temp.reset_keep_entities)'),
  ('comments',                 'mixed', 'id IN (SELECT id FROM pg_temp.reset_keep_comments)'),
  ('comment_mentions',         'mixed', 'comment_id IN (SELECT id FROM pg_temp.reset_keep_comments)'),
  ('levels_conversions',       'mixed', 'entity_type = ''register_record'' AND entity_id IN (SELECT id FROM pg_temp.reset_keep_records)'),
  ('import_batches',           'mixed', 'id IN (SELECT id FROM pg_temp.reset_keep_batches)'),
  ('import_batch_rows',        'mixed', 'batch_id IN (SELECT id FROM pg_temp.reset_keep_batches)'),
  ('user_drafts',              'mixed', 'draft_key NOT LIKE ''task.%'' AND (draft_key NOT LIKE ''record.%'' OR draft_key = ''record.contractors.new'''
                                         ' OR substr(draft_key, length(split_part(draft_key, ''.'', 1) || split_part(draft_key, ''.'', 2)) + 3)'
                                         ' IN (SELECT entity_id::text FROM pg_temp.reset_keep_entities UNION ALL SELECT id::text FROM pg_temp.reset_keep_records))'),
  ('stored_object_meta',       'mixed', 'storage_key NOT IN (SELECT storage_key FROM pg_temp.reset_files)');

INSERT INTO reset_plan (tbl, action, keep_where)
SELECT t, 'delete', 'false' FROM unnest(ARRAY[
  'sites', 'clusters', 'task_instances', 'workflow_steps', 'task_level_actors', 'task_level_voters', 'task_delay_periods', 'admin_overrides',
  'site_gate_state', 'site_gate_events', 'site_scope_exceptions', 'site_snapshots', 'site_workflow_migrations', 'site_drafts', 'baseline_versions',
  'baseline_entries', 'change_requests', 'rf_design_records', 'acquisition_candidates', 'procurement_records', 'gecol_records', 'hlc_records',
  'hlc_pr_links', 'hlc_legacy_migrations', 'permit_records', 'quality_inspections', 'issues', 'risks', 'readiness_handover', 'as_built_records',
  'meetings', 'meeting_actions', 'warehouse_serials', 'warehouse_site_qty', 'wh_movements', 'wh_movement_lines', 'vehicle_reservations',
  'assignment_readiness', 'snags', 'snag_photos', 'snag_level_voters', 'document_site_overrides', 'document_task_snapshots', 'document_export_jobs',
  'import_batch_jobs', 'import_uploads', 'master_reconciliation_runs', 'master_reconciliation_rows', 'master_reconciliation_diffs', 'mi_apply_jobs',
  'hrf_stage_marks', 'hgd_marks', 'notifications', 'watches', 'progress_snapshots', 'dash_snapshot_runs', 'ps_manual_values', 'ps_manual_plans'
]) t;

-- Every base table must have a decision, and every decision a table: a table added by a later migration stops the reset until it is classified
-- here and in docs/ops/data-reset.md.
DO $$
DECLARE missing text; extra text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname NOT IN (SELECT tbl FROM reset_plan);
  SELECT string_agg(p.tbl, ', ' ORDER BY p.tbl) INTO extra FROM reset_plan p
  WHERE to_regclass('public.' || quote_ident(p.tbl)) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: tables without a decision (classify them in the plan and in docs/ops/data-reset.md): %', missing; END IF;
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: the plan names tables that do not exist: %', extra; END IF;
END $$;

CREATE FUNCTION pg_temp.reset_count(p_before boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record; total bigint; kept bigint;
BEGIN
  FOR r IN SELECT tbl, keep_where FROM pg_temp.reset_plan ORDER BY tbl LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE %s) FROM public.%I', r.keep_where, r.tbl) INTO total, kept;
    IF p_before THEN UPDATE pg_temp.reset_plan SET rows_before = total, kept_before = kept WHERE tbl = r.tbl;
    ELSE UPDATE pg_temp.reset_plan SET rows_after = total, kept_after = kept WHERE tbl = r.tbl; END IF;
  END LOOP;
END $f$;

-- DELETE FROM tbl WHERE the plan's keep_where is not true: the MIXED tables are reduced with the very predicate the checks use.
CREATE FUNCTION pg_temp.reset_delete_unkept(p_tbl text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE w text; n bigint;
BEGIN
  SELECT keep_where INTO STRICT w FROM pg_temp.reset_plan WHERE tbl = p_tbl AND action = 'mixed';
  EXECUTE format('DELETE FROM public.%I WHERE (%s) IS NOT TRUE', p_tbl, w);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION pg_temp.reset_rows(p_tbl text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.%I', p_tbl) INTO n;
  RETURN n;
END $f$;

SELECT pg_temp.reset_count(true) \g /dev/null

SELECT 'PLAN', tbl, action, rows_before, rows_before - kept_before, kept_before FROM reset_plan
ORDER BY CASE action WHEN 'delete' THEN 1 WHEN 'mixed' THEN 2 WHEN 'keep' THEN 3 ELSE 4 END, tbl;

\if :execute
-- ------------------------------------------------------------------------------------------------------------------------------------------
-- 3. The reset (one transaction; any error rolls everything back)
-- ------------------------------------------------------------------------------------------------------------------------------------------
SELECT 'FILE', storage_key FROM reset_files ORDER BY storage_key;

-- Tables whose row guard refuses every DELETE ("rows are never deleted", "a stored snag photo is never deleted"): project data the owner asked to
-- remove; nothing references them, so TRUNCATE (no CASCADE) empties exactly these tables.
TRUNCATE public.task_delay_periods, public.ps_manual_values, public.ps_manual_plans, public.dash_snapshot_runs, public.snag_photos;

-- Inbox, follows, transient markers, background jobs and the legacy Master reconciliation.
DELETE FROM public.notifications;
DELETE FROM public.watches;
SELECT pg_temp.reset_delete_unkept('user_drafts') \g /dev/null
DELETE FROM public.hgd_marks;
DELETE FROM public.hrf_stage_marks;
DELETE FROM public.mi_apply_jobs;
DELETE FROM public.import_uploads;
DELETE FROM public.master_reconciliation_diffs;
DELETE FROM public.master_reconciliation_rows;
DELETE FROM public.master_reconciliation_runs;
DELETE FROM public.import_batch_jobs;
DELETE FROM public.document_export_jobs;

-- Documents of project data. document_files_guard refuses every DELETE; it is off for this one statement only, inside this transaction
-- (ALTER TABLE takes an exclusive lock: no other session sees the table meanwhile), and back on before the checks below.
ALTER TABLE public.document_files DISABLE TRIGGER document_files_guard;
SELECT pg_temp.reset_delete_unkept('document_files') \g /dev/null
ALTER TABLE public.document_files ENABLE TRIGGER document_files_guard;
SELECT pg_temp.reset_delete_unkept('document_record_snapshots') \g /dev/null
DELETE FROM public.document_task_snapshots;
DELETE FROM public.document_site_overrides;
SELECT pg_temp.reset_delete_unkept('document_slots') \g /dev/null

-- Quality snags, comments, two-level conversions.
DELETE FROM public.snag_level_voters;
DELETE FROM public.snags;
SELECT pg_temp.reset_delete_unkept('comments') \g /dev/null
SELECT pg_temp.reset_delete_unkept('levels_conversions') \g /dev/null

-- Warehouse stock and movements (the item master stays), Car Dispatcher bookings (the vehicles stay), assignment readiness, HLC legacy moves.
DELETE FROM public.wh_movement_lines;
DELETE FROM public.wh_movements;
DELETE FROM public.warehouse_serials;
DELETE FROM public.warehouse_site_qty;
DELETE FROM public.vehicle_reservations;
DELETE FROM public.assignment_readiness;
DELETE FROM public.hlc_legacy_migrations;

-- Register records of project data. Steps, level actors and voters, team scope checks and HLC PR links follow (ON DELETE CASCADE).
SELECT pg_temp.reset_delete_unkept('register_record_locks') \g /dev/null
SELECT pg_temp.reset_delete_unkept('register_records') \g /dev/null

-- The typed register tables (all project data).
DELETE FROM public.rf_design_records;
DELETE FROM public.acquisition_candidates;
DELETE FROM public.procurement_records;
DELETE FROM public.gecol_records;
DELETE FROM public.hlc_records;
DELETE FROM public.permit_records;
DELETE FROM public.quality_inspections;
DELETE FROM public.issues;
DELETE FROM public.risks;
DELETE FROM public.readiness_handover;
DELETE FROM public.as_built_records;
DELETE FROM public.meeting_actions;
DELETE FROM public.meetings;
DELETE FROM public.site_scope_exceptions;
DELETE FROM public.change_requests;

-- Tasks and the site state around them.
DELETE FROM public.site_gate_state;
DELETE FROM public.admin_overrides;
DELETE FROM public.task_level_actors;
DELETE FROM public.task_level_voters;
DELETE FROM public.workflow_steps;
DELETE FROM public.task_instances;
DELETE FROM public.site_workflow_migrations;
DELETE FROM public.baseline_entries;
DELETE FROM public.baseline_versions;
DELETE FROM public.progress_snapshots;

-- Site drafts and import batch rows point at each other (no-action keys, checked at the end of the statement): one statement removes both.
WITH d AS (DELETE FROM public.site_drafts RETURNING 1)
DELETE FROM public.import_batch_rows WHERE batch_id NOT IN (SELECT id FROM reset_keep_batches);
SELECT pg_temp.reset_delete_unkept('import_batches') \g /dev/null

-- The sites last (site_gate_state, site_gate_events, site_snapshots, site_scope_exceptions follow with ON DELETE CASCADE), then the clusters.
DELETE FROM public.sites;
DELETE FROM public.clusters;

-- The envelopes (data keys) of the moved objects. The database backup keeps them, so a restore of the dump plus the quarantine directory gives
-- every file back.
SELECT pg_temp.reset_delete_unkept('stored_object_meta') \g /dev/null

-- ------------------------------------------------------------------------------------------------------------------------------------------
-- 4. The checks (before anything is added to the logs)
-- ------------------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.reset_count(false) \g /dev/null
DO $$
DECLARE bad text;
BEGIN
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.document_files'::regclass AND tgname = 'document_files_guard') <> 'O' THEN
    RAISE EXCEPTION 'reset-project-data: document_files_guard is not enabled again';
  END IF;
  SELECT string_agg(format('%s (%s: %s -> %s)', tbl, action, rows_before, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan
  WHERE action IN ('keep', 'log') AND rows_after <> rows_before;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a KEEP table changed its row count, nothing was reset: %', bad; END IF;
  SELECT string_agg(format('%s (kept %s -> %s, left %s)', tbl, kept_before, kept_after, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan
  WHERE action = 'mixed' AND (kept_after <> kept_before OR rows_after <> kept_after);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a MIXED table lost a kept row or kept a project row, nothing was reset: %', bad; END IF;
  SELECT string_agg(format('%s (%s left)', tbl, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan WHERE action = 'delete' AND rows_after <> 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a DELETE table is not empty, nothing was reset: %', bad; END IF;
END $$;

-- ------------------------------------------------------------------------------------------------------------------------------------------
-- 5. End every session (each end is written to the security log by its own trigger, event session_ended), then the one audit row
-- ------------------------------------------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE reset_sessions ON COMMIT DROP AS SELECT id FROM public.user_sessions WHERE revoked_at IS NULL;
UPDATE public.user_sessions SET revoked_at = now(), revoke_reason = 'project_data_reset' WHERE id IN (SELECT id FROM reset_sessions);

-- As the migrations do: a direct insert with no actor (the operator works on the server, not as a signed-in user). The audit triggers fill the
-- context and seal the row on the hash chain. Counts only: no value of any deleted row.
CREATE TEMP TABLE reset_audit ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  SELECT 'project_data_reset', 'system', 'project_data',
    jsonb_build_object('rows', (SELECT jsonb_object_agg(tbl, rows_before ORDER BY tbl) FROM pg_temp.reset_plan WHERE action IN ('delete', 'mixed'))),
    jsonb_build_object(
      'deleted', (SELECT jsonb_object_agg(tbl, rows_before - rows_after ORDER BY tbl) FROM pg_temp.reset_plan WHERE action IN ('delete', 'mixed') AND rows_before <> rows_after),
      'kept_in_mixed', (SELECT jsonb_object_agg(tbl, kept_after ORDER BY tbl) FROM pg_temp.reset_plan WHERE action = 'mixed'),
      'keep_tables', (SELECT count(*) FROM pg_temp.reset_plan WHERE action IN ('keep', 'log')),
      'sessions_ended', (SELECT count(*) FROM reset_sessions),
      'files_quarantined', (SELECT count(*) FROM reset_files),
      'operator', nullif(current_setting('pmis.reset_operator'), ''),
      'backup', nullif(current_setting('pmis.reset_backup'), ''),
      'via', 'infra/scripts/reset-project-data.sh'),
    left(btrim(current_setting('pmis.reset_reason')), 2000), NULL, false
  RETURNING id)
SELECT id FROM ins;

-- The chain seals (zz_audit_log_seal, zz_security_log_seal) are deferred constraint triggers: run them now, as COMMIT would, so the checks see them.
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE a_before bigint; a_after bigint; c_before bigint; c_after bigint; s_before bigint; s_after bigint; n_sess bigint; bad text;
BEGIN
  SELECT rows_before INTO a_before FROM pg_temp.reset_plan WHERE tbl = 'audit_log';
  SELECT rows_before INTO c_before FROM pg_temp.reset_plan WHERE tbl = 'audit_log_chain';
  SELECT rows_before INTO s_before FROM pg_temp.reset_plan WHERE tbl = 'security_log';
  SELECT count(*) INTO a_after FROM public.audit_log;
  SELECT count(*) INTO c_after FROM public.audit_log_chain;
  SELECT count(*) INTO s_after FROM public.security_log;
  SELECT count(*) INTO n_sess FROM pg_temp.reset_sessions;
  IF a_after <> a_before + 1 OR c_after <> c_before + 1 THEN
    RAISE EXCEPTION 'reset-project-data: the audit log should have grown by exactly one sealed row (log % -> %, chain % -> %)', a_before, a_after, c_before, c_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_log_chain WHERE audit_id = (SELECT id FROM pg_temp.reset_audit)) THEN
    RAISE EXCEPTION 'reset-project-data: the reset audit row is not on the hash chain';
  END IF;
  IF s_after <> s_before + n_sess THEN
    RAISE EXCEPTION 'reset-project-data: the security log should have grown by one session_ended row per ended session (% -> %, % sessions)', s_before, s_after, n_sess;
  END IF;
  -- Nothing else in the logs moved.
  SELECT string_agg(p.tbl, ', ') INTO bad FROM pg_temp.reset_plan p
  WHERE p.action = 'log' AND p.tbl NOT IN ('audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads')
    AND pg_temp.reset_rows(p.tbl) <> p.rows_before;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a log changed during the reset: %', bad; END IF;
END $$;

SELECT 'DONE', (SELECT id FROM reset_audit), (SELECT count(*) FROM reset_sessions), (SELECT count(*) FROM reset_files);
COMMIT;
\else
ROLLBACK;
\endif
