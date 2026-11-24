-- 0146_settings_data_reset: the project data reset as a function in Settings, with two System Admins (owner decisions 2026-11-24; contract 0.15.62, CHANGELOG 198).
-- Mirror: db/sql/145_settings_data_reset.sql (kept byte-identical). The contract of the reset (every table, KEEP / DELETE / MIXED) is docs/ops/data-reset.md.
--
--   1. One plan, one delete: the plan of infra/scripts/reset-project-data.sql (every base table of the public schema with its decision) moves into
--      data_reset_plan(), and the counts, the deletes, the checks, the end of the sessions and the audit row into data_reset_core(). The operator script and
--      the Settings run both call data_reset_core: there is no second copy of the table list. data_reset_plan, data_reset_core and data_reset_deleting are
--      owned by a dedicated role pmis_reset_owner (NOLOGIN, BYPASSRLS), the only role with SELECT on every table and DELETE on the project tables, so no other
--      SECURITY DEFINER function gains those rights; EXECUTE on data_reset_core is granted to pmis_definer only (the Settings doors) and the superuser (the
--      script). The row guards that refuse every DELETE (doc_files_guard, snag_photos_guard, dash_owner_rows_frozen) and the backstops (reg_backstop,
--      wf_backstop) let pmis_reset_owner through only while data_reset_marker holds the id of the running transaction (inserted and removed by
--      data_reset_core); the script no longer disables a trigger or truncates a table.
--   2. Four eyes (owner decision 1): a System Admin acting without delegation requests the reset (reason, step-up, typed phrase "RESET <database>"); a
--      DIFFERENT System Admin approves it (own step-up and reason); then the requester or the approver starts it (step-up, the phrase again, a successful
--      database backup recorded in the System Log within the guarded window). A request expires (guarded setting data_reset.settings, default 30 minutes);
--      any System Admin may cancel. With one active System Admin no request can be made: the operator script on the server is the way.
--   3. Backup precondition (owner decision 2): a System Log row of source backup, level info, context script = db-backup, event = backup_ok and type full or
--      diff (written by infra/backup/db-backup.sh after a successful pgBackRest backup) within data_reset.settings.backup_max_age_hours (default 24). The
--      source backup is reserved for the server's scripts: log_system_write (latest 0045) refuses it from a pmis_app session.
--   4. The run is one transaction (data_reset_core inside admin_data_reset_execute): an advisory lock (key 353383097684) shared with the script, EXCLUSIVE locks
--      on every DELETE and MIXED table and SHARE locks on every other table of the plan (no writer anywhere until the commit), the same checks as the
--      script; every session ends except the runner's own. While a request is running the API answers
--      503 (data_reset_maintenance). The files of the deleted rows are moved by the API after the commit; their list and outcome stay on the request.
--   5. The security log gets the event project_data_reset (one row per step: requested, approved, cancelled, started, completed, failed, files).
--
-- Every door is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked; pmis_app executes the doors and the
-- readers only. pmis_app has no right on the three new tables (app_grants.sql).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. The reset role
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_reset_owner') THEN
    CREATE ROLE pmis_reset_owner NOLOGIN BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO pmis_reset_owner;
DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO pmis_reset_owner', current_database()); END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------------
-- The transaction marker of a running reset: the guards let pmis_reset_owner delete only while it names the current transaction.
CREATE TABLE data_reset_marker (
  txid       bigint PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE data_reset_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status            text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'approved', 'running', 'files_pending', 'completed', 'failed', 'cancelled', 'expired')),
  version           integer NOT NULL DEFAULT 1,
  database_name     text NOT NULL,
  requested_by      uuid NOT NULL REFERENCES users(id),
  requested_session uuid NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_reason    text NOT NULL,
  expires_at        timestamptz NOT NULL,
  approved_by       uuid REFERENCES users(id),
  approved_session  uuid,
  approved_at       timestamptz,
  approve_reason    text,
  cancelled_by      uuid REFERENCES users(id),
  cancelled_at      timestamptz,
  cancel_reason     text,
  run_by            uuid REFERENCES users(id),
  run_session       uuid,
  run_started_at    timestamptz,
  db_committed_at   timestamptz,
  finished_at       timestamptz,
  backup            jsonb,
  plan_at_request   jsonb,
  result            jsonb,
  quarantine_dir    text,
  files_total       integer,
  error             text,
  CONSTRAINT data_reset_four_eyes CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT data_reset_approved_session CHECK (approved_session IS NULL OR approved_session <> requested_session),
  CONSTRAINT data_reset_runner CHECK (run_by IS NULL OR run_by = requested_by OR run_by = approved_by)
);
-- one open request at a time (an expired one is closed by the next door that meets it)
CREATE UNIQUE INDEX data_reset_requests_one_open ON data_reset_requests ((true)) WHERE status IN ('requested', 'approved', 'running', 'files_pending');
CREATE INDEX data_reset_requests_at ON data_reset_requests (requested_at DESC);

CREATE TABLE data_reset_request_files (
  request_id  uuid NOT NULL REFERENCES data_reset_requests(id),
  storage_key text NOT NULL,
  outcome     text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'moved', 'missing', 'refused')),
  detail      text,
  decided_at  timestamptz,
  PRIMARY KEY (request_id, storage_key)
);

-- The requests and their file lists are evidence: never deleted, a decided file outcome never changes.
CREATE OR REPLACE FUNCTION data_reset_rows_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END IF;
  -- one table per branch: PL/pgSQL resolves the fields of OLD and NEW only in the branch it runs
  IF TG_TABLE_NAME = 'data_reset_request_files' THEN
    IF OLD.outcome <> 'pending' OR NEW.request_id <> OLD.request_id OR NEW.storage_key <> OLD.storage_key THEN
      RAISE EXCEPTION 'a decided file outcome of a data reset never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.request_reason <> OLD.request_reason
       OR NEW.database_name <> OLD.database_name OR OLD.status IN ('completed', 'failed', 'cancelled', 'expired') THEN
      RAISE EXCEPTION 'a closed data reset request, or who and why it was requested, never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_reset_requests_guard BEFORE UPDATE OR DELETE ON data_reset_requests FOR EACH ROW EXECUTE FUNCTION data_reset_rows_guard();
CREATE TRIGGER data_reset_request_files_guard BEFORE UPDATE OR DELETE ON data_reset_request_files FOR EACH ROW EXECUTE FUNCTION data_reset_rows_guard();
CREATE OR REPLACE FUNCTION data_reset_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is never truncated', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER data_reset_requests_no_truncate BEFORE TRUNCATE ON data_reset_requests FOR EACH STATEMENT EXECUTE FUNCTION data_reset_no_truncate();
CREATE TRIGGER data_reset_request_files_no_truncate BEFORE TRUNCATE ON data_reset_request_files FOR EACH STATEMENT EXECUTE FUNCTION data_reset_no_truncate();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON data_reset_marker, data_reset_requests, data_reset_request_files FROM pmis_app;
  END IF;
END $$;
REVOKE ALL ON data_reset_marker, data_reset_requests, data_reset_request_files FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON data_reset_requests, data_reset_request_files TO pmis_definer;
GRANT SELECT ON data_reset_requests TO pmis_reset_owner;
GRANT SELECT, INSERT, DELETE ON data_reset_marker TO pmis_reset_owner;
GRANT SELECT ON users, groups, group_members, user_sessions, settings, system_log TO pmis_definer;
GRANT INSERT ON notifications, audit_log TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;

-- The guarded setting (settings_guarded_keys of 0072): the request expiry and the backup window.
INSERT INTO settings (key, value, description, updated_at)
VALUES ('data_reset.settings', '{"request_expiry_minutes": 30, "backup_max_age_hours": 24, "version": 1}'::jsonb,
        'Project data reset in Settings (migration 0146): minutes a request stays open (5 to 240) and the age limit of the last successful database backup in hours (1 to 72).',
        now())
ON CONFLICT (key) DO NOTHING;
CREATE TRIGGER b_settings_data_reset BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'data_reset.settings') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_data_reset_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'data_reset.settings' OR NEW.key = 'data_reset.settings') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_data_reset_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'data_reset.settings') EXECUTE FUNCTION settings_guarded_keys();

-- The security log event of every step.
ALTER TABLE security_log DROP CONSTRAINT security_log_event_check;
ALTER TABLE security_log ADD CONSTRAINT security_log_event_check CHECK (event IN ('sign_in_started', 'sign_in_succeeded', 'callback_account_mismatch',
  'sign_in_failed', 'sign_in_locked', 'sign_in_rate_limited', 'signed_out', 'session_expired', 'session_ended', 'session_revoked_by_admin', 'mfa_exemption_granted',
  'mfa_exemption_revoked', 'step_up_passed', 'step_up_failed', 'break_glass_used', 'two_factor_passed', 'two_factor_failed', 'recovery_code_used',
  'two_factor_enrolled', 'password_changed', 'password_reset', 'project_data_reset'));

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The plan: every base table of the public schema with its decision (docs/ops/data-reset.md is the same list, with the reasons)
-- ---------------------------------------------------------------------------------------------------------------------
-- keep_where: the rows that stay ('true' for KEEP, 'false' for DELETE). log = an append-only log: KEEP, it may only grow, by the rows named in the final
-- check (the reset's own audit row, the session-end rows). The MIXED predicates name the temporary keep sets that data_reset_core builds first.
CREATE OR REPLACE FUNCTION data_reset_plan() RETURNS TABLE (tbl text, action text, keep_where text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t, 'keep', 'true' FROM unnest(ARRAY[
    -- identity and access
    'users', 'local_credentials', 'user_totp', 'user_recovery_codes', 'auth_pending', 'user_sessions', 'email_change_requests', 'phone_change_requests',
    'user_invitations', 'roles', 'role_default_regions', 'role_default_modules', 'role_aliases', 'user_role_assignments', 'user_role_assignment_regions',
    'user_role_assignment_modules', 'user_role_assignment_profiles', 'permission_profiles', 'permission_grants', 'field_permissions', 'groups',
    'group_members', 'delegations', 'delegation_grants', 'delegation_regions', 'departments', 'pmis_context_keys',
    'absences',   -- staff absence records (0140): about people, not sites; KEEP (docs/ops/data-reset.md, Open)
    -- staff registry (0142)
    'staff_registry', 'staff_registry_visibility_state', 'staff_registry_visibility_fields', 'staff_registry_visibility_entries',
    'user_mfa_exemptions', 'me_admin_requests',  -- 0143: MFA exemptions (identity) and the requests of users to the System Admins (people/admin data)
    -- configuration
    'workflow_definitions', 'workflow_streams', 'workflow_views', 'workflow_view_members', 'stage_definitions', 'task_definitions', 'task_predecessors',
    'phase_gate_rules', 'scenario_task_rules', 'scenario_rule_state', 'sla_rules', 'sla_rule_sets', 'sla_rule_set_items', 'sla_master_columns',
    'work_calendars', 'holidays', 'dlp_versions', 'weight_sets', 'weight_activities', 'weight_items', 'list_catalogues', 'list_values', 'field_definitions',
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
    'announcement_responses', 'saved_views', 'saved_view_versions', 'saved_view_targets', 'saved_view_region_targets', 'document_grid_views',
    -- the reset itself (0146): the transaction marker (empty outside a running reset)
    'data_reset_marker'
  ]) t
  UNION ALL
  SELECT t, 'log', 'true' FROM unnest(ARRAY[
    'audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads', 'log_integrity_runs', 'system_log',
    'security_alerts', 'security_alert_state', 'job_runs', 'deployments', 'mail_outbox', 'status_transitions', 'status_updates',
    'data_reset_requests', 'data_reset_request_files'   -- 0146: the requests of the Settings reset and the outcome of their files (evidence)
  ]) t
  UNION ALL
  SELECT * FROM (VALUES
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
    ('stored_object_meta',       'mixed', 'storage_key NOT IN (SELECT storage_key FROM pg_temp.reset_files)')
  ) v(tbl, action, keep_where)
  UNION ALL
  SELECT t, 'delete', 'false' FROM unnest(ARRAY[
    'sites', 'clusters', 'task_instances', 'task_cover_decisions', 'workflow_steps', 'task_level_actors', 'task_level_voters', 'task_delay_periods', 'admin_overrides',
    'site_gate_state', 'site_gate_events', 'site_scope_exceptions', 'site_snapshots', 'site_workflow_migrations', 'site_drafts', 'baseline_versions',
    'baseline_entries', 'change_requests', 'rf_design_records', 'acquisition_candidates', 'procurement_records', 'gecol_records', 'hlc_records',
    'hlc_pr_links', 'hlc_legacy_migrations', 'permit_records', 'quality_inspections', 'issues', 'risks', 'readiness_handover', 'as_built_records',
    'meetings', 'meeting_actions', 'warehouse_serials', 'warehouse_site_qty', 'wh_movements', 'wh_movement_lines', 'vehicle_reservations',
    'assignment_readiness', 'snags', 'snag_photos', 'snag_level_voters', 'document_site_overrides', 'document_task_snapshots', 'document_export_jobs',
    'import_batch_jobs', 'import_uploads', 'master_reconciliation_runs', 'master_reconciliation_rows', 'master_reconciliation_diffs', 'mi_apply_jobs',
    'hrf_stage_marks', 'hgd_marks', 'notifications', 'watches', 'progress_snapshots', 'dash_snapshot_runs', 'ps_manual_values', 'ps_manual_plans'
  ]) t
$$;

-- The rights of the reset role: read every table of the plan (the counts), delete from the DELETE and MIXED tables, lock the others against writers
-- (UPDATE, which LOCK ... IN SHARE MODE requires; the role updates only user_sessions, to end them), write the one audit row.
-- A table added by a later migration has no right here: the coverage check of data_reset_core stops the reset first (classify it, then grant).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.tbl, p.action FROM data_reset_plan() p WHERE to_regclass('public.' || quote_ident(p.tbl)) IS NOT NULL LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO pmis_reset_owner', r.tbl);
    IF r.action IN ('delete', 'mixed') THEN EXECUTE format('GRANT DELETE ON public.%I TO pmis_reset_owner', r.tbl); END IF;
    -- UPDATE only because LOCK TABLE ... IN SHARE MODE needs it: no code of the role updates a KEEP table (the sessions apart, below)
    IF r.action IN ('keep', 'log') THEN EXECUTE format('GRANT UPDATE ON public.%I TO pmis_reset_owner', r.tbl); END IF;
  END LOOP;
END $$;
GRANT INSERT ON audit_log TO pmis_reset_owner;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_reset_owner;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The guards let the running reset through (latest definitions: doc_files_guard 0038, snag_photos_guard 0056, dash_owner_rows_frozen 0059,
--    reg_backstop 0019, wf_backstop 0015; the bodies are unchanged but for the line that lets the running reset delete)
-- ---------------------------------------------------------------------------------------------------------------------
-- True only inside data_reset_core: the marker row of this transaction is visible to it alone (pmis_app cannot write the marker table).
CREATE OR REPLACE FUNCTION data_reset_deleting() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.data_reset_marker m WHERE m.txid = txid_current())
$$;

CREATE OR REPLACE FUNCTION doc_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'pmis_reset_owner' AND public.data_reset_deleting() THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a stored document file is never deleted (withdraw or supersede it)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'is_current' - 'superseded_by' - 'withdrawn_at' - 'withdrawn_by' - 'approved_date' - 'stored_name')
     IS DISTINCT FROM (to_jsonb(OLD) - 'is_current' - 'superseded_by' - 'withdrawn_at' - 'withdrawn_by' - 'approved_date' - 'stored_name') THEN
    RAISE EXCEPTION 'the content columns of a stored document file never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION snag_photos_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'pmis_reset_owner' AND public.data_reset_deleting() THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a stored snag photo is never deleted (withdraw it)' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'withdrawn_at' - 'withdrawn_by' - 'rejected_at' - 'review_note' - 'evidence_status' - 'evidence_note' - 'evidence_decided_by' - 'evidence_decided_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at' - 'withdrawn_by' - 'rejected_at' - 'review_note' - 'evidence_status' - 'evidence_note' - 'evidence_decided_by' - 'evidence_decided_at') THEN
    RAISE EXCEPTION 'the content columns of a stored snag photo never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.evidence_status = 'accepted' AND NEW.evidence_status <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted snag photo stays accepted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dash_owner_rows_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'pmis_reset_owner' AND public.data_reset_deleting() THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END IF;
  IF TG_TABLE_NAME = 'task_delay_periods' THEN
    o := to_jsonb(OLD); n := to_jsonb(NEW);
    IF (o ->> 'voided_at') IS NULL AND (n ->> 'voided_at') IS NOT NULL
       AND (n - 'voided_at' - 'voided_by' - 'void_reason') = (o - 'voided_at' - 'voided_by' - 'void_reason') THEN
      RETURN NEW;
    END IF;
    IF (o ->> 'status') = 'proposed' AND (n ->> 'status') IN ('approved', 'rejected') AND (o ->> 'voided_at') IS NULL AND (n ->> 'voided_at') IS NULL
       AND (n - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'external_party_id') = (o - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'external_party_id')
       AND ((o ->> 'external_party_id') IS NULL OR (o -> 'external_party_id') = (n -> 'external_party_id')) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% rows are never rewritten', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;

CREATE OR REPLACE FUNCTION reg_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_definer' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'DELETE' AND current_user = 'pmis_reset_owner' AND public.data_reset_deleting() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is written only through reg_* functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION wf_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_definer' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'DELETE' AND current_user = 'pmis_reset_owner' AND public.data_reset_deleting() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is written only through wf_* functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The core: counts (dry run) or the reset (one transaction of the caller)
-- ---------------------------------------------------------------------------------------------------------------------
-- p_execute false: the plan with the counts, nothing written (only temporary tables, dropped again). p_execute true: the reset; the caller commits.
-- p_detail: what the audit row records besides the counts (the script: operator, backup path, via; the Settings run: the request, the two admins, the backup).
-- p_keep_session: the session that is not ended (the runner's own in Settings; NULL for the script: every session ends).
-- p_request: the Settings request being run (NULL for the script, which is refused while a Settings request is approved or running).
-- Returns {plan: [{tbl, action, rows, delete, keep}], files: [...], audit_id, sessions_ended}.
CREATE OR REPLACE FUNCTION data_reset_core(p_execute boolean, p_reason text, p_detail jsonb, p_keep_session uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record; missing text; extra text; bad text; total bigint; kept bigint; aid bigint; n_sess bigint; res jsonb;
  a_before bigint; a_after bigint; c_before bigint; c_after bigint; s_before bigint; s_after bigint;
BEGIN
  IF p_execute IS NULL THEN RAISE EXCEPTION 'reset-project-data: execute must be true or false'; END IF;
  IF p_execute THEN
    IF char_length(btrim(coalesce(p_reason, ''))) < 10 THEN
      RAISE EXCEPTION 'reset-project-data: a reason of at least 10 characters is required' USING ERRCODE = 'check_violation';
    END IF;
    -- one reset at a time, the script and Settings alike (held until the end of the transaction)
    IF NOT pg_try_advisory_xact_lock(353383097684) THEN
      RAISE EXCEPTION 'reset-project-data: another reset is running' USING ERRCODE = 'lock_not_available';
    END IF;
    IF p_request IS NULL AND EXISTS (SELECT 1 FROM public.data_reset_requests q
        WHERE q.status = 'running' OR (q.status = 'approved' AND q.expires_at > clock_timestamp())) THEN
      RAISE EXCEPTION 'reset-project-data: a reset approved in Settings is waiting to run or running; cancel it in Settings > Data reset first'
        USING ERRCODE = 'object_in_use';
    END IF;
    PERFORM set_config('lock_timeout', '60s', true);
  END IF;

  -- 1. Coverage: every base table has a decision, every decision a table (a table added by a later migration stops the reset until it is classified).
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname NOT IN (SELECT p.tbl FROM public.data_reset_plan() p);
  SELECT string_agg(p.tbl, ', ' ORDER BY p.tbl) INTO extra FROM public.data_reset_plan() p WHERE to_regclass('public.' || quote_ident(p.tbl)) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: tables without a decision (classify them in data_reset_plan and in docs/ops/data-reset.md): %', missing; END IF;
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: the plan names tables that do not exist: %', extra; END IF;
  SELECT string_agg(p.tbl, ', ' ORDER BY p.tbl) INTO bad FROM public.data_reset_plan() p
  WHERE NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'SELECT')
     OR (p.action IN ('delete', 'mixed') AND NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'DELETE'))
     OR (p.action IN ('keep', 'log') AND NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'UPDATE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: the reset role has no right on (grant it in the migration that classified them): %', bad; END IF;
  SELECT string_agg(c.relname || '.' || t.tgname, ', ') INTO bad FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'O'
    AND c.relname IN (SELECT p.tbl FROM public.data_reset_plan() p);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a trigger is disabled, nothing was reset: %', bad; END IF;

  -- 2. Locks: no other session writes any table of the plan until the end of the transaction (plain reads go on). The project tables in EXCLUSIVE mode,
  -- every other table (KEEP and the logs) in SHARE mode, so a timer or a sign-in waits instead of changing a count under the checks. Every statement
  -- after the locks reads what was committed before them (READ COMMITTED), so nothing written just before the reset can stay hidden from it.
  IF p_execute THEN
    FOR r IN SELECT p.tbl, p.action FROM public.data_reset_plan() p ORDER BY p.tbl LOOP
      EXECUTE format('LOCK TABLE public.%I IN %s MODE', r.tbl, CASE WHEN r.action IN ('delete', 'mixed') THEN 'EXCLUSIVE' ELSE 'SHARE' END);
    END LOOP;
    INSERT INTO public.data_reset_marker (txid) VALUES (txid_current());
  END IF;

  -- 3. What is kept inside the MIXED tables (computed once, before anything is deleted)
  -- Master data that lives in the generic register table: the Contractors register (companies, teams, contracts) and the vehicles of the Car Dispatcher.
  CREATE TEMP TABLE reset_keep_entities ON COMMIT DROP AS
    SELECT DISTINCT entity_id FROM public.register_records
    WHERE register_key = 'contractors' OR (register_key = 'car_dispatcher' AND record_type = 'vehicle');
  CREATE TEMP TABLE reset_keep_records ON COMMIT DROP AS
    SELECT id FROM public.register_records WHERE entity_id IN (SELECT entity_id FROM pg_temp.reset_keep_entities);
  -- Document slots and files of kept records (company and team documents); the slots of tasks and of project records go.
  CREATE TEMP TABLE reset_keep_slots ON COMMIT DROP AS
    SELECT id FROM public.document_slots WHERE register_entity_id IN (SELECT entity_id FROM pg_temp.reset_keep_entities);
  -- Import batches that a kept record still points at (foreign key register_records.historical_direct_batch_id); every other batch goes.
  CREATE TEMP TABLE reset_keep_batches ON COMMIT DROP AS
    SELECT DISTINCT historical_direct_batch_id AS id FROM public.register_records
    WHERE id IN (SELECT id FROM pg_temp.reset_keep_records) AND historical_direct_batch_id IS NOT NULL;
  -- Comments on kept records.
  CREATE TEMP TABLE reset_keep_comments ON COMMIT DROP AS
    SELECT id FROM public.comments WHERE entity_type = 'register_record' AND entity_id IN (SELECT entity_id FROM pg_temp.reset_keep_entities);
  -- Stored objects of the deleted rows, never one that a kept row still names. They are moved (never deleted) to the quarantine directory.
  CREATE TEMP TABLE reset_files ON COMMIT DROP AS
    SELECT DISTINCT k AS storage_key FROM (
      SELECT storage_key AS k FROM public.document_files WHERE slot_id NOT IN (SELECT id FROM pg_temp.reset_keep_slots)
      UNION ALL SELECT storage_key FROM public.snag_photos
      UNION ALL SELECT storage_key FROM public.document_export_jobs
      UNION ALL SELECT storage_key FROM public.master_reconciliation_runs
    ) x
    WHERE k IS NOT NULL
      AND k NOT IN (SELECT storage_key FROM public.document_files WHERE slot_id IN (SELECT id FROM pg_temp.reset_keep_slots) AND storage_key IS NOT NULL)
      AND k NOT IN (SELECT storage_key FROM public.document_blank_forms WHERE storage_key IS NOT NULL)
      AND k NOT IN (SELECT storage_key FROM public.template_versions WHERE storage_key IS NOT NULL);

  CREATE TEMP TABLE reset_plan ON COMMIT DROP AS
    SELECT p.tbl, p.action, p.keep_where, NULL::bigint AS rows_before, NULL::bigint AS kept_before, NULL::bigint AS rows_after, NULL::bigint AS kept_after
    FROM public.data_reset_plan() p;

  -- 4. Counts before: total rows and kept rows (the keep_where of the plan) of every table
  FOR r IN SELECT tbl, keep_where FROM pg_temp.reset_plan ORDER BY tbl LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE %s) FROM public.%I', r.keep_where, r.tbl) INTO total, kept;
    UPDATE pg_temp.reset_plan SET rows_before = total, kept_before = kept WHERE tbl = r.tbl;
  END LOOP;

  IF NOT p_execute THEN
    SELECT jsonb_build_object(
      'plan', (SELECT jsonb_agg(jsonb_build_object('tbl', tbl, 'action', action, 'rows', rows_before, 'delete', rows_before - kept_before, 'keep', kept_before)
                 ORDER BY CASE action WHEN 'delete' THEN 1 WHEN 'mixed' THEN 2 WHEN 'keep' THEN 3 ELSE 4 END, tbl) FROM pg_temp.reset_plan),
      'files', (SELECT count(*) FROM pg_temp.reset_files)) INTO res;
    DROP TABLE pg_temp.reset_plan, pg_temp.reset_files, pg_temp.reset_keep_comments, pg_temp.reset_keep_batches, pg_temp.reset_keep_slots,
      pg_temp.reset_keep_records, pg_temp.reset_keep_entities;
    RETURN res;
  END IF;

  -- 5. The deletes, in foreign-key order (any error rolls everything back). The guard triggers let this role through while the marker names this
  -- transaction: the delay periods, manual Project Status values and plans, KPI snapshot runs, QC photos and project documents are project data the owner
  -- asked to remove; their files are moved, never deleted.
  DELETE FROM public.task_delay_periods;
  DELETE FROM public.ps_manual_values;
  DELETE FROM public.ps_manual_plans;
  DELETE FROM public.dash_snapshot_runs;
  DELETE FROM public.snag_photos;
  -- Inbox, follows, transient markers, background jobs and the legacy Master reconciliation.
  DELETE FROM public.notifications;
  DELETE FROM public.watches;
  PERFORM public.data_reset_delete_unkept('user_drafts');
  DELETE FROM public.hgd_marks;
  DELETE FROM public.hrf_stage_marks;
  DELETE FROM public.mi_apply_jobs;
  DELETE FROM public.import_uploads;
  DELETE FROM public.master_reconciliation_diffs;
  DELETE FROM public.master_reconciliation_rows;
  DELETE FROM public.master_reconciliation_runs;
  DELETE FROM public.import_batch_jobs;
  DELETE FROM public.document_export_jobs;
  -- Documents of project data.
  PERFORM public.data_reset_delete_unkept('document_files');
  PERFORM public.data_reset_delete_unkept('document_record_snapshots');
  DELETE FROM public.document_task_snapshots;
  DELETE FROM public.document_site_overrides;
  PERFORM public.data_reset_delete_unkept('document_slots');
  -- Quality snags, comments, two-level conversions.
  DELETE FROM public.snag_level_voters;
  DELETE FROM public.snags;
  PERFORM public.data_reset_delete_unkept('comments');
  PERFORM public.data_reset_delete_unkept('levels_conversions');
  -- Warehouse stock and movements (the item master stays), Car Dispatcher bookings (the vehicles stay), assignment readiness, HLC legacy moves.
  DELETE FROM public.wh_movement_lines;
  DELETE FROM public.wh_movements;
  DELETE FROM public.warehouse_serials;
  DELETE FROM public.warehouse_site_qty;
  DELETE FROM public.vehicle_reservations;
  DELETE FROM public.assignment_readiness;
  DELETE FROM public.hlc_legacy_migrations;
  -- Register records of project data. Steps, level actors and voters, team scope checks and HLC PR links follow (ON DELETE CASCADE).
  PERFORM public.data_reset_delete_unkept('register_record_locks');
  PERFORM public.data_reset_delete_unkept('register_records');
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
  DELETE FROM public.task_cover_decisions;
  DELETE FROM public.workflow_steps;
  DELETE FROM public.task_instances;
  DELETE FROM public.site_workflow_migrations;
  DELETE FROM public.baseline_entries;
  DELETE FROM public.baseline_versions;
  DELETE FROM public.progress_snapshots;
  -- Site drafts and import batch rows point at each other (no-action keys, checked at the end of the statement): one statement removes both.
  WITH d AS (DELETE FROM public.site_drafts RETURNING 1)
  DELETE FROM public.import_batch_rows WHERE batch_id NOT IN (SELECT id FROM pg_temp.reset_keep_batches);
  PERFORM public.data_reset_delete_unkept('import_batches');
  -- The sites last (site_gate_state, site_gate_events, site_snapshots, site_scope_exceptions follow with ON DELETE CASCADE), then the clusters.
  DELETE FROM public.sites;
  DELETE FROM public.clusters;
  -- The envelopes (data keys) of the moved objects. The database backup keeps them, so a restore of the dump plus the quarantine gives every file back.
  PERFORM public.data_reset_delete_unkept('stored_object_meta');

  -- 6. The checks (before anything is added to the logs)
  FOR r IN SELECT tbl, keep_where FROM pg_temp.reset_plan ORDER BY tbl LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE %s) FROM public.%I', r.keep_where, r.tbl) INTO total, kept;
    UPDATE pg_temp.reset_plan SET rows_after = total, kept_after = kept WHERE tbl = r.tbl;
  END LOOP;
  SELECT string_agg(format('%s (%s: %s -> %s)', tbl, action, rows_before, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan
  WHERE action IN ('keep', 'log') AND rows_after <> rows_before;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a KEEP table changed its row count, nothing was reset: %', bad; END IF;
  SELECT string_agg(format('%s (kept %s -> %s, left %s)', tbl, kept_before, kept_after, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan
  WHERE action = 'mixed' AND (kept_after <> kept_before OR rows_after <> kept_after);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a MIXED table lost a kept row or kept a project row, nothing was reset: %', bad; END IF;
  SELECT string_agg(format('%s (%s left)', tbl, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan WHERE action = 'delete' AND rows_after <> 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a DELETE table is not empty, nothing was reset: %', bad; END IF;

  -- 7. End every session but the kept one (each end is written to the security log by its own trigger), then the one audit row
  CREATE TEMP TABLE reset_sessions ON COMMIT DROP AS
    SELECT id FROM public.user_sessions WHERE revoked_at IS NULL AND id IS DISTINCT FROM p_keep_session;
  UPDATE public.user_sessions SET revoked_at = now(), revoke_reason = 'project_data_reset', revoked_by = public.app_actor()
  WHERE id IN (SELECT id FROM pg_temp.reset_sessions);
  SELECT count(*) INTO n_sess FROM pg_temp.reset_sessions;

  -- Counts only: no value of any deleted row. The script acts on the server with no actor (as the migrations do); a Settings run has its actor.
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  SELECT 'project_data_reset', 'system', 'project_data',
    jsonb_build_object('rows', (SELECT jsonb_object_agg(tbl, rows_before ORDER BY tbl) FROM pg_temp.reset_plan WHERE action IN ('delete', 'mixed'))),
    jsonb_build_object(
      'deleted', (SELECT jsonb_object_agg(tbl, rows_before - rows_after ORDER BY tbl) FROM pg_temp.reset_plan WHERE action IN ('delete', 'mixed') AND rows_before <> rows_after),
      'kept_in_mixed', (SELECT jsonb_object_agg(tbl, kept_after ORDER BY tbl) FROM pg_temp.reset_plan WHERE action = 'mixed'),
      'keep_tables', (SELECT count(*) FROM pg_temp.reset_plan WHERE action IN ('keep', 'log')),
      'sessions_ended', n_sess,
      'session_kept', p_keep_session,
      'files_quarantined', (SELECT count(*) FROM pg_temp.reset_files)) || coalesce(p_detail, '{}'::jsonb),
    left(btrim(p_reason), 2000), public.app_actor(), false
  RETURNING id INTO aid;

  -- The chain seals (zz_audit_log_seal, zz_security_log_seal) are deferred constraint triggers: run them now, as COMMIT would, so the checks see them.
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT rows_before INTO a_before FROM pg_temp.reset_plan WHERE tbl = 'audit_log';
  SELECT rows_before INTO c_before FROM pg_temp.reset_plan WHERE tbl = 'audit_log_chain';
  SELECT rows_before INTO s_before FROM pg_temp.reset_plan WHERE tbl = 'security_log';
  SELECT count(*) INTO a_after FROM public.audit_log;
  SELECT count(*) INTO c_after FROM public.audit_log_chain;
  SELECT count(*) INTO s_after FROM public.security_log;
  IF a_after <> a_before + 1 OR c_after <> c_before + 1 THEN
    RAISE EXCEPTION 'reset-project-data: the audit log should have grown by exactly one sealed row (log % -> %, chain % -> %)', a_before, a_after, c_before, c_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_log_chain WHERE audit_id = aid) THEN
    RAISE EXCEPTION 'reset-project-data: the reset audit row is not on the hash chain';
  END IF;
  IF s_after <> s_before + n_sess THEN
    RAISE EXCEPTION 'reset-project-data: the security log should have grown by one session-end row per ended session (% -> %, % sessions)', s_before, s_after, n_sess;
  END IF;
  -- Nothing else in the logs moved.
  FOR r IN SELECT tbl, rows_before FROM pg_temp.reset_plan
           WHERE action = 'log' AND tbl NOT IN ('audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads') LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.tbl) INTO total;
    IF total <> r.rows_before THEN RAISE EXCEPTION 'reset-project-data: a log changed during the reset: %', r.tbl; END IF;
  END LOOP;

  SELECT jsonb_build_object(
    'plan', (SELECT jsonb_agg(jsonb_build_object('tbl', tbl, 'action', action, 'rows', rows_before, 'delete', rows_before - kept_before, 'keep', kept_before)
               ORDER BY CASE action WHEN 'delete' THEN 1 WHEN 'mixed' THEN 2 WHEN 'keep' THEN 3 ELSE 4 END, tbl) FROM pg_temp.reset_plan),
    'deleted', (SELECT jsonb_object_agg(tbl, rows_before - rows_after ORDER BY tbl) FROM pg_temp.reset_plan WHERE action IN ('delete', 'mixed') AND rows_before <> rows_after),
    'files', (SELECT coalesce(jsonb_agg(storage_key ORDER BY storage_key), '[]'::jsonb) FROM pg_temp.reset_files),
    'audit_id', aid, 'sessions_ended', n_sess) INTO res;
  DELETE FROM public.data_reset_marker WHERE txid = txid_current();
  DROP TABLE pg_temp.reset_plan, pg_temp.reset_files, pg_temp.reset_keep_comments, pg_temp.reset_keep_batches, pg_temp.reset_keep_slots,
    pg_temp.reset_keep_records, pg_temp.reset_keep_entities, pg_temp.reset_sessions;
  RETURN res;
END $$;

-- DELETE FROM tbl WHERE the plan's keep_where is not true: the MIXED tables are reduced with the very predicate the checks use.
CREATE OR REPLACE FUNCTION data_reset_delete_unkept(p_tbl text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w text; n bigint;
BEGIN
  IF NOT public.data_reset_deleting() THEN RAISE EXCEPTION 'reset-project-data: only inside a running reset' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT p.keep_where INTO STRICT w FROM public.data_reset_plan() p WHERE p.tbl = p_tbl AND p.action = 'mixed';
  EXECUTE format('DELETE FROM public.%I WHERE (%s) IS NOT TRUE', p_tbl, w);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The source 'backup' of the System Log is reserved for the server's backup scripts (latest log_system_write: 0045; the API never writes it)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_system_write(p_level text, p_source text, p_message text, p_context jsonb, p_user uuid, p_request_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- 0146: the backup precondition of the data reset reads these rows, so a pmis_app session (the API) can never write one
  IF lower(btrim(coalesce(p_source, ''))) = 'backup' AND pg_has_role(session_user, 'pmis_app', 'MEMBER') THEN
    RAISE EXCEPTION 'the System Log source backup is written by the server''s backup scripts only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.system_log (level, source, message, context, user_id, request_id)
  VALUES (p_level::"LogLevel", left(coalesce(p_source, 'api'), 40), left(coalesce(p_message, ''), 2000),
    CASE WHEN p_context IS NULL OR length(p_context::text) <= 20000 THEN p_context ELSE jsonb_build_object('truncated', true) END,
    p_user, left(coalesce(p_request_id, public.log_ctx('request_id')), 64));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Helpers of the Settings doors (owner pmis_definer, not granted to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
-- wf:data_reset:{"status": <http status>, "code": <problem code>, "detail": <text>} (mapped by the API, apps/api/src/common/db-errors.ts)
CREATE OR REPLACE FUNCTION data_reset_err(p_status integer, p_code text, p_detail text, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.wf_err('data_reset', jsonb_build_object('status', p_status, 'code', p_code, 'detail', p_detail) || coalesce(p_extra, '{}'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION data_reset_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'request_expiry_minutes', coalesce((SELECT (s.value ->> 'request_expiry_minutes')::integer FROM public.settings s WHERE s.key = 'data_reset.settings'), 30),
    'backup_max_age_hours', coalesce((SELECT (s.value ->> 'backup_max_age_hours')::integer FROM public.settings s WHERE s.key = 'data_reset.settings'), 24),
    'version', coalesce((SELECT (s.value ->> 'version')::integer FROM public.settings s WHERE s.key = 'data_reset.settings'), 0))
$$;

CREATE OR REPLACE FUNCTION data_reset_admin_count() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(DISTINCT gm.user_id)::integer FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
  JOIN public.users u ON u.id = gm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
$$;

-- The advisory lock of a running reset (data_reset_core, the script or Settings), seen from any session.
CREATE OR REPLACE FUNCTION data_reset_lock_held() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
    WHERE l.locktype = 'advisory' AND l.granted AND l.classid = 82 AND l.objid = 1195779412 AND l.objsubid = 1
      AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = current_database()))
$$;

-- The latest successful database backup: a System Log row written by infra/backup/db-backup.sh (source backup, level info, script db-backup, event backup_ok,
-- type full or diff). The latest problem of the backup check (level error, newer than that success) is shown beside it.
CREATE OR REPLACE FUNCTION data_reset_backup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ok record; bad record; hours integer := (public.data_reset_cfg() ->> 'backup_max_age_hours')::integer;
BEGIN
  SELECT l.id, l.at, l.message, l.context INTO ok FROM public.system_log l
  WHERE l.source = 'backup' AND l.level = 'info' AND l.context ->> 'script' = 'db-backup' AND l.context ->> 'event' = 'backup_ok'
    AND l.context ->> 'type' IN ('full', 'diff')
  ORDER BY l.at DESC, l.id DESC LIMIT 1;
  SELECT l.id, l.at, l.message INTO bad FROM public.system_log l
  WHERE l.source = 'backup' AND l.level = 'error' AND (ok.at IS NULL OR l.at > ok.at)
  ORDER BY l.at DESC, l.id DESC LIMIT 1;
  RETURN jsonb_build_object(
    'ok', ok.at IS NOT NULL AND ok.at > clock_timestamp() - make_interval(hours => hours),
    'max_age_hours', hours,
    'last_success', CASE WHEN ok.at IS NULL THEN NULL ELSE jsonb_build_object('system_log_id', ok.id, 'at', ok.at,
      'type', ok.context ->> 'type', 'mode', ok.context ->> 'mode', 'repository', ok.context ->> 'repos', 'stanza', ok.context ->> 'stanza') END,
    'last_problem', CASE WHEN bad.at IS NULL THEN NULL ELSE jsonb_build_object('system_log_id', bad.id, 'at', bad.at, 'message', left(bad.message, 500)) END);
END $$;

CREATE OR REPLACE FUNCTION data_reset_user_json(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_user IS NULL THEN NULL ELSE
    (SELECT jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', u.employee_id) FROM public.users u WHERE u.id = p_user) END
$$;

CREATE OR REPLACE FUNCTION data_reset_stalled(r public.data_reset_requests) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.status = 'running' AND r.db_committed_at IS NULL AND NOT public.data_reset_lock_held() AND r.run_started_at < clock_timestamp() - interval '2 minutes'
$$;

CREATE OR REPLACE FUNCTION data_reset_req_json(r public.data_reset_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'version', r.version, 'database_name', r.database_name,
    'requested_by', public.data_reset_user_json(r.requested_by), 'requested_at', r.requested_at, 'request_reason', r.request_reason,
    'expires_at', r.expires_at, 'expired', r.status IN ('requested', 'approved') AND r.expires_at <= clock_timestamp(),
    'approved_by', public.data_reset_user_json(r.approved_by), 'approved_at', r.approved_at, 'approve_reason', r.approve_reason,
    'cancelled_by', public.data_reset_user_json(r.cancelled_by), 'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'run_by', public.data_reset_user_json(r.run_by), 'run_started_at', r.run_started_at, 'db_committed_at', r.db_committed_at, 'finished_at', r.finished_at,
    'stalled', public.data_reset_stalled(r),
    'backup', r.backup, 'plan_at_request', r.plan_at_request, 'result', r.result, 'quarantine_dir', r.quarantine_dir, 'error', r.error,
    'files', jsonb_build_object(
      'total', coalesce(r.files_total, 0),
      'moved', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'moved'),
      'missing', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'missing'),
      'refused', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'refused'),
      'pending', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'pending'),
      'problems', (SELECT coalesce(jsonb_agg(jsonb_build_object('storage_key', x.storage_key, 'outcome', x.outcome, 'detail', x.detail) ORDER BY x.storage_key), '[]'::jsonb)
                   FROM (SELECT f.storage_key, f.outcome, f.detail FROM public.data_reset_request_files f
                         WHERE f.request_id = r.id AND f.outcome IN ('missing', 'refused') ORDER BY f.storage_key LIMIT 200) x)))
$$;

-- The actor of a door: a System Admin acting without delegation, in a live session of their own (the session id of the verified context), with a step-up
-- when p_stepup. Returns the actor and the session.
CREATE OR REPLACE FUNCTION data_reset_require_admin(p_stepup boolean, OUT actor uuid, OUT sid uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  actor := public.app_actor();
  IF actor IS NULL THEN PERFORM public.data_reset_err(403, 'action_forbidden', 'Sign in as a System Admin.'); END IF;
  IF public.app_ctx_on_behalf() IS NOT NULL THEN
    PERFORM public.data_reset_err(403, 'delegate_forbidden', 'The project data reset is for a System Admin acting without delegation; a delegate can never request, approve or run it.');
  END IF;
  IF NOT public.app_user_is_system_admin(actor) THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only a System Admin may use the project data reset.');
  END IF;
  BEGIN sid := nullif(public.app_ctx_get('session_id'), '')::uuid; EXCEPTION WHEN others THEN sid := NULL; END;
  IF sid IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_sessions s WHERE s.id = sid AND s.user_id = actor AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'The project data reset needs a signed-in session of your own.');
  END IF;
  IF p_stepup AND NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
END $$;

CREATE OR REPLACE FUNCTION data_reset_require_reason(p_reason text, p_min integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF char_length(btrim(coalesce(p_reason, ''))) < p_min OR char_length(btrim(p_reason)) > 2000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required',
      format('A reason of %s to 2000 characters is required.', p_min))));
  END IF;
  RETURN btrim(p_reason);
END $$;

CREATE OR REPLACE FUNCTION data_reset_require_phrase(p_confirm text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_confirm IS DISTINCT FROM 'RESET ' || current_database() THEN
    PERFORM public.data_reset_err(422, 'confirmation_mismatch', format('Type RESET %s to confirm.', current_database()),
      jsonb_build_object('errors', public.reg_err_item('/confirm_text', 'confirmation_mismatch', format('Type RESET %s.', current_database())),
                         'confirmation_phrase', 'RESET ' || current_database()));
  END IF;
END $$;

-- Requests left open past their expiry are closed by the next door that meets them.
CREATE OR REPLACE FUNCTION data_reset_expire() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- only when there is something to close: a read during a run must not wait for the run's lock on the table
  IF EXISTS (SELECT 1 FROM public.data_reset_requests WHERE status IN ('requested', 'approved') AND expires_at <= clock_timestamp()) THEN
    UPDATE public.data_reset_requests SET status = 'expired', version = version + 1, finished_at = clock_timestamp()
    WHERE status IN ('requested', 'approved') AND expires_at <= clock_timestamp();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION data_reset_log(p_action text, p_id uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
  VALUES (p_action, 'data_reset_request', p_id::text, p_before, p_after, left(p_reason, 2000), public.app_actor());
  PERFORM public.sec_log_write('project_data_reset', 'info', public.app_actor(), NULL,
    jsonb_build_object('step', replace(p_action, 'data_reset_', ''), 'request_id', p_id), '{}'::jsonb);
END $$;

-- The request for update: locked, closed when expired, version checked (If-Match).
CREATE OR REPLACE FUNCTION data_reset_lock_request(p_id uuid, p_version integer) RETURNS public.data_reset_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.data_reset_requests;
BEGIN
  SELECT * INTO r FROM public.data_reset_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.data_reset_err(404, 'not_found', 'No such data reset request.'); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  RETURN r;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The doors (granted to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
-- Is a reset running? The API answers 503 while it is (checked outside a request transaction, no actor needed). A run whose transaction died (the API
-- stopped) holds no lock: after two minutes it no longer counts, and the screen offers to close it as failed.
CREATE OR REPLACE FUNCTION data_reset_maintenance() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.data_reset_lock_held() OR EXISTS (SELECT 1 FROM public.data_reset_requests r
    WHERE r.status = 'running' AND r.db_committed_at IS NULL AND r.run_started_at > clock_timestamp() - interval '2 minutes')
$$;

-- The screen: the plan with its counts, the backup, the System Admins, the open request and the last closed one. A System Admin only (no delegate).
CREATE OR REPLACE FUNCTION data_reset_state_json() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; plan jsonb; open_r public.data_reset_requests; last_r public.data_reset_requests; admins integer; me uuid;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  me := who.actor;
  PERFORM public.data_reset_expire();
  -- while a run is open the plan is not counted (the counts would be of the data being deleted, and a read must not write while the run starts)
  IF public.data_reset_maintenance() THEN
    plan := jsonb_build_object('plan', '[]'::jsonb, 'files', 0);
  ELSE
    BEGIN
      plan := public.data_reset_core(false, NULL, NULL, NULL, NULL);
    EXCEPTION WHEN others THEN
      -- a table without a decision (a later migration) or a right missing: the screen says why, and the run is refused (plan_incomplete)
      plan := jsonb_build_object('plan', '[]'::jsonb, 'files', 0, 'error', left(SQLERRM, 1000));
    END;
  END IF;
  SELECT * INTO open_r FROM public.data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending') ORDER BY requested_at DESC LIMIT 1;
  SELECT * INTO last_r FROM public.data_reset_requests WHERE status NOT IN ('requested', 'approved', 'running', 'files_pending') ORDER BY requested_at DESC LIMIT 1;
  admins := public.data_reset_admin_count();
  RETURN jsonb_build_object(
    'database', current_database(),
    'confirmation_phrase', 'RESET ' || current_database(),
    'settings', public.data_reset_cfg(),
    'system_admins_active', admins,
    'single_admin', admins < 2,
    'script_running', public.data_reset_lock_held(),
    'maintenance', public.data_reset_maintenance(),
    'backup', public.data_reset_backup(),
    'plan', jsonb_build_object(
      'tables', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', e ->> 'tbl', 'action', e ->> 'action', 'rows', (e ->> 'rows')::bigint,
                   'delete', (e ->> 'delete')::bigint, 'keep', (e ->> 'keep')::bigint)), '[]'::jsonb) FROM jsonb_array_elements(plan -> 'plan') e),
      'delete_rows', (SELECT coalesce(sum((e ->> 'delete')::bigint), 0) FROM jsonb_array_elements(plan -> 'plan') e),
      'keep_rows', (SELECT coalesce(sum((e ->> 'keep')::bigint), 0) FROM jsonb_array_elements(plan -> 'plan') e),
      'files', (plan ->> 'files')::bigint,
      'error', plan ->> 'error'),
    'request', CASE WHEN open_r.id IS NULL THEN NULL ELSE public.data_reset_req_json(open_r) END,
    'last_request', CASE WHEN last_r.id IS NULL THEN NULL ELSE public.data_reset_req_json(last_r) END,
    'can', jsonb_build_object(
      'request', open_r.id IS NULL AND admins >= 2,
      'approve', coalesce(open_r.status = 'requested' AND open_r.requested_by <> me AND open_r.expires_at > clock_timestamp(), false),
      'start', coalesce(open_r.status = 'approved' AND me IN (open_r.requested_by, open_r.approved_by) AND open_r.expires_at > clock_timestamp(), false),
      'cancel', coalesce(open_r.status IN ('requested', 'approved') OR public.data_reset_stalled(open_r), false),
      'retry_files', coalesce(open_r.status = 'files_pending' AND NOT public.data_reset_lock_held(), false)));
END $$;

CREATE OR REPLACE FUNCTION data_reset_request_get(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.data_reset_requests;
BEGIN
  PERFORM public.data_reset_require_admin(false);
  PERFORM public.data_reset_expire();
  SELECT * INTO r FROM public.data_reset_requests WHERE id = p_id;
  IF NOT FOUND THEN PERFORM public.data_reset_err(404, 'not_found', 'No such data reset request.'); END IF;
  RETURN public.data_reset_req_json(r);
END $$;

-- 1. Request: System Admin, step-up, reason (10+), the typed phrase, a second active System Admin, no other open request, no reset running.
CREATE OR REPLACE FUNCTION admin_data_reset_request(p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests; plan jsonb;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 10);
  PERFORM public.data_reset_require_phrase(p_confirm);
  IF public.data_reset_admin_count() < 2 THEN
    PERFORM public.data_reset_err(409, 'single_admin', 'A second active System Admin must approve the reset. With one System Admin, the reset is done on the server with the operator script (infra/scripts/reset-project-data.sh).');
  END IF;
  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, 'reset_running', 'A reset is running.'); END IF;
  PERFORM public.data_reset_expire();
  IF EXISTS (SELECT 1 FROM public.data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending')) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'Another data reset request is open. Cancel it or let it finish first.');
  END IF;
  plan := public.data_reset_core(false, NULL, NULL, NULL, NULL);
  INSERT INTO public.data_reset_requests (database_name, requested_by, requested_session, request_reason, expires_at, plan_at_request)
  VALUES (current_database(), who.actor, who.sid, why,
          clock_timestamp() + make_interval(mins => (public.data_reset_cfg() ->> 'request_expiry_minutes')::integer),
          jsonb_build_object('delete_rows', (SELECT coalesce(sum((e ->> 'delete')::bigint), 0) FROM jsonb_array_elements(plan -> 'plan') e),
                             'files', (plan ->> 'files')::bigint,
                             'sites', (SELECT (e ->> 'rows')::bigint FROM jsonb_array_elements(plan -> 'plan') e WHERE e ->> 'tbl' = 'sites')))
  RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_request', r.id, NULL,
    jsonb_build_object('status', r.status, 'expires_at', r.expires_at, 'plan', r.plan_at_request, 'database', r.database_name), why);
  -- every other active System Admin is told in-app (the inbox is project data: the reset itself empties it)
  INSERT INTO public.notifications (user_id, kind, title, body, link)
  SELECT DISTINCT gm.user_id, 'data_reset_request', 'A project data reset waits for your approval',
         format('%s asked to reset the project data of %s. Reason: %s', (SELECT u.display_name FROM public.users u WHERE u.id = who.actor), current_database(), left(why, 300)),
         '/admin/settings/data/reset'
  FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
  JOIN public.users u ON u.id = gm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
  WHERE gm.user_id <> who.actor;
  RETURN public.data_reset_req_json(r);
END $$;

-- 2. Approve: a DIFFERENT System Admin (another user, another session), step-up, reason (10+), the request still open and not expired.
CREATE OR REPLACE FUNCTION admin_data_reset_approve(p_id uuid, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 10);
  PERFORM public.data_reset_expire();
  r := public.data_reset_lock_request(p_id, p_version);
  IF r.requested_by = who.actor OR r.requested_session = who.sid THEN
    PERFORM public.data_reset_err(403, 'self_approval_forbidden', 'A different System Admin must approve the reset; nobody approves their own request.');
  END IF;
  IF r.status = 'expired' THEN PERFORM public.data_reset_err(409, 'request_expired', 'The request expired. Make a new request.'); END IF;
  IF r.status <> 'requested' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s, not waiting for approval.', r.status)); END IF;
  IF NOT public.app_user_is_system_admin(r.requested_by) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The admin who made the request is no longer an active System Admin. Cancel the request.');
  END IF;
  UPDATE public.data_reset_requests SET status = 'approved', version = version + 1, approved_by = who.actor, approved_session = who.sid,
         approved_at = clock_timestamp(), approve_reason = why
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_approve', r.id, jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', r.status, 'requested_by', r.requested_by, 'expires_at', r.expires_at), why);
  RETURN public.data_reset_req_json(r);
END $$;

-- 3. Cancel: any System Admin, step-up, reason (3+), while the request waits (requested or approved), or a run whose transaction died (closed as failed).
CREATE OR REPLACE FUNCTION admin_data_reset_cancel(p_id uuid, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests; was text;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 3);
  PERFORM public.data_reset_expire();
  r := public.data_reset_lock_request(p_id, p_version);
  was := r.status;
  IF r.status IN ('requested', 'approved') THEN
    UPDATE public.data_reset_requests SET status = 'cancelled', version = version + 1, cancelled_by = who.actor, cancelled_at = clock_timestamp(),
           cancel_reason = why, finished_at = clock_timestamp()
    WHERE id = r.id RETURNING * INTO r;
  ELSIF public.data_reset_stalled(r) THEN
    -- the run's transaction died before its commit (the API stopped): nothing was reset, the request is closed as failed
    UPDATE public.data_reset_requests SET status = 'failed', version = version + 1, cancelled_by = who.actor, cancelled_at = clock_timestamp(),
           cancel_reason = why, finished_at = clock_timestamp(), error = 'The run was interrupted before its commit: nothing was reset.'
    WHERE id = r.id RETURNING * INTO r;
  ELSE
    PERFORM public.data_reset_err(409, CASE WHEN r.status = 'expired' THEN 'request_expired' ELSE 'invalid_transition' END,
      format('The request is %s: it cannot be cancelled.', r.status));
  END IF;
  PERFORM public.data_reset_log('data_reset_cancel', r.id, jsonb_build_object('status', was), jsonb_build_object('status', r.status), why);
  RETURN public.data_reset_req_json(r);
END $$;

-- 4. Start: the requester or the approver, step-up, the typed phrase again, the request approved and not expired, a successful backup within the window,
-- no reset running, the plan covering every table. The run itself is admin_data_reset_execute, in its own transaction.
CREATE OR REPLACE FUNCTION admin_data_reset_start(p_id uuid, p_confirm text, p_version integer, p_quarantine text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests; bk jsonb;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  PERFORM public.data_reset_require_phrase(p_confirm);
  PERFORM public.data_reset_expire();
  r := public.data_reset_lock_request(p_id, p_version);
  IF who.actor NOT IN (r.requested_by, coalesce(r.approved_by, r.requested_by)) THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the System Admin who requested the reset or the one who approved it may start it.');
  END IF;
  IF r.status = 'expired' THEN PERFORM public.data_reset_err(409, 'request_expired', 'The request expired. Make a new request.'); END IF;
  IF r.status <> 'approved' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s, not approved.', r.status)); END IF;
  IF NOT public.app_user_is_system_admin(r.requested_by) OR NOT public.app_user_is_system_admin(r.approved_by) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The requester or the approver is no longer an active System Admin. Cancel the request.');
  END IF;
  bk := public.data_reset_backup();
  IF NOT (bk ->> 'ok')::boolean THEN
    PERFORM public.data_reset_err(409, 'backup_missing', format('No successful database backup is recorded in the System Log within the last %s hours. Run a backup first (db-backup.sh full).', bk ->> 'max_age_hours'),
      jsonb_build_object('backup', bk));
  END IF;
  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, 'reset_running', 'A reset is running.'); END IF;
  IF p_quarantine IS NULL OR p_quarantine !~ '^/' OR char_length(p_quarantine) > 1000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/quarantine_dir', 'invalid', 'An absolute path.')));
  END IF;
  BEGIN
    PERFORM public.data_reset_core(false, NULL, NULL, NULL, NULL);
  EXCEPTION WHEN others THEN
    PERFORM public.data_reset_err(409, 'plan_incomplete', SQLERRM);
  END;
  UPDATE public.data_reset_requests SET status = 'running', version = version + 1, run_by = who.actor, run_session = who.sid,
         run_started_at = clock_timestamp(), backup = bk -> 'last_success', quarantine_dir = p_quarantine
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_start', r.id, jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', r.status, 'backup', r.backup, 'requested_by', r.requested_by, 'approved_by', r.approved_by), r.request_reason);
  RETURN public.data_reset_req_json(r);
END $$;

-- 5. Execute: the reset itself, in the transaction of the caller (the API runs it in a transaction of its own right after the start, as the runner, in the
-- runner's session). Every session but the runner's ends. Afterwards the request waits for the file move (files_pending), or is completed when no file.
CREATE OR REPLACE FUNCTION admin_data_reset_execute(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests; res jsonb; n integer;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  r := public.data_reset_lock_request(p_id, NULL);
  IF r.status <> 'running' OR r.db_committed_at IS NOT NULL THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s: the database part runs once, after a start.', r.status));
  END IF;
  IF r.run_by <> who.actor OR r.run_session <> who.sid THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the session that started the reset runs it.');
  END IF;
  IF r.run_started_at < clock_timestamp() - interval '2 minutes' THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The start is too old: cancel it and start again.');
  END IF;
  res := public.data_reset_core(true, r.request_reason,
    jsonb_build_object('via', 'settings', 'request_id', r.id, 'requested_by', r.requested_by, 'approved_by', r.approved_by, 'run_by', r.run_by,
                       'approve_reason', r.approve_reason, 'backup', r.backup, 'quarantine_dir', r.quarantine_dir),
    r.run_session, r.id);
  INSERT INTO public.data_reset_request_files (request_id, storage_key)
  SELECT r.id, k FROM jsonb_array_elements_text(res -> 'files') k;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.data_reset_requests SET
    status = CASE WHEN n = 0 THEN 'completed' ELSE 'files_pending' END, version = version + 1, db_committed_at = clock_timestamp(),
    finished_at = CASE WHEN n = 0 THEN clock_timestamp() END, files_total = n,
    result = jsonb_build_object('audit_id', res -> 'audit_id', 'sessions_ended', res -> 'sessions_ended', 'deleted', res -> 'deleted')
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.sec_log_write('project_data_reset', 'success', who.actor, NULL,
    jsonb_build_object('step', 'completed', 'request_id', r.id, 'audit_id', res -> 'audit_id', 'sessions_ended', res -> 'sessions_ended', 'files', n), '{}'::jsonb);
  RETURN public.data_reset_req_json(r);
END $$;

-- 6. Failed: the run's transaction rolled back (nothing was reset); the API records the error in a new transaction. Only the runner, only before a commit.
CREATE OR REPLACE FUNCTION admin_data_reset_fail(p_id uuid, p_error text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  r := public.data_reset_lock_request(p_id, NULL);
  IF r.status <> 'running' OR r.db_committed_at IS NOT NULL OR r.run_by <> who.actor THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s.', r.status));
  END IF;
  UPDATE public.data_reset_requests SET status = 'failed', version = version + 1, finished_at = clock_timestamp(),
         error = left(coalesce(nullif(btrim(p_error), ''), 'The reset failed.'), 2000)
  WHERE id = r.id RETURNING * INTO r;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
  VALUES ('data_reset_fail', 'data_reset_request', r.id::text, jsonb_build_object('status', 'running'), jsonb_build_object('status', 'failed', 'error', r.error),
          'The reset rolled back: nothing was reset.', who.actor);
  PERFORM public.sec_log_write('project_data_reset', 'failure', who.actor, NULL, jsonb_build_object('step', 'failed', 'request_id', r.id), '{}'::jsonb);
  RETURN public.data_reset_req_json(r);
END $$;

-- 7. The files to move: the runner right after the commit, or any System Admin later with a step-up and a reason (a retry of the file move only; the
-- database part never runs twice). Returns the quarantine directory and the keys still pending.
CREATE OR REPLACE FUNCTION admin_data_reset_files_claim(p_id uuid, p_retry boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(coalesce(p_retry, false));
  r := public.data_reset_lock_request(p_id, NULL);
  IF r.status <> 'files_pending' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s: no file waits to be moved.', r.status)); END IF;
  IF coalesce(p_retry, false) THEN
    why := public.data_reset_require_reason(p_reason, 3);
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('data_reset_files_retry', 'data_reset_request', r.id::text, NULL,
            jsonb_build_object('pending', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'pending')), why, who.actor);
  ELSIF r.run_by <> who.actor THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the runner moves the files right after the reset; anyone else retries with a step-up.');
  END IF;
  RETURN jsonb_build_object('quarantine_dir', r.quarantine_dir,
    'keys', (SELECT coalesce(jsonb_agg(f.storage_key ORDER BY f.storage_key), '[]'::jsonb) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'pending'));
END $$;

-- 8. The outcome of the moved files ([{storage_key, outcome: moved | missing | refused, detail}]); when no file is pending the request is completed.
CREATE OR REPLACE FUNCTION admin_data_reset_files_record(p_id uuid, p_results jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests; left_n bigint;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  r := public.data_reset_lock_request(p_id, NULL);
  IF r.status <> 'files_pending' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s.', r.status)); END IF;
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) e WHERE jsonb_typeof(e) <> 'object' OR e ->> 'outcome' NOT IN ('moved', 'missing', 'refused')
                OR jsonb_typeof(e -> 'storage_key') <> 'string') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/results', 'invalid', 'A list of {storage_key, outcome, detail}.')));
  END IF;
  UPDATE public.data_reset_request_files f SET outcome = e ->> 'outcome', detail = left(e ->> 'detail', 500), decided_at = clock_timestamp()
  FROM jsonb_array_elements(p_results) e
  WHERE f.request_id = r.id AND f.storage_key = e ->> 'storage_key' AND f.outcome = 'pending';
  SELECT count(*) INTO left_n FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'pending';
  IF left_n = 0 THEN
    UPDATE public.data_reset_requests SET status = 'completed', version = version + 1, finished_at = clock_timestamp() WHERE id = r.id RETURNING * INTO r;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('data_reset_files', 'data_reset_request', r.id::text, jsonb_build_object('status', 'files_pending'),
            jsonb_build_object('status', 'completed', 'quarantine_dir', r.quarantine_dir,
              'moved', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'moved'),
              'missing', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'missing'),
              'refused', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'refused')),
            'The files of the deleted rows were moved to the quarantine directory (never deleted).', who.actor);
    PERFORM public.sec_log_write('project_data_reset', 'info', who.actor, NULL, jsonb_build_object('step', 'files', 'request_id', r.id), '{}'::jsonb);
  END IF;
  RETURN public.data_reset_req_json(r);
END $$;

-- 9. The guarded setting: System Admin (no delegate), step-up, reason, If-Match, never while a request is open.
CREATE OR REPLACE FUNCTION admin_set_data_reset_settings(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; cur jsonb; errs jsonb := '[]'::jsonb; k text; v jsonb; nxt jsonb;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 3);
  PERFORM 1 FROM public.settings WHERE key = 'data_reset.settings' FOR UPDATE;
  cur := public.data_reset_cfg();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  PERFORM public.data_reset_expire();
  IF EXISTS (SELECT 1 FROM public.data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending')) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'A data reset request is open: change the settings after it is closed.');
  END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with request_expiry_minutes and backup_max_age_hours.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('request_expiry_minutes', 'backup_max_age_hours') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  FOR k IN SELECT unnest(ARRAY['request_expiry_minutes', 'backup_max_age_hours']) LOOP
    v := p_body -> k;
    IF v IS NULL OR jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) THEN
      errs := errs || public.reg_err_item('/' || k, 'required', 'A whole number.');
    ELSIF k = 'request_expiry_minutes' AND (v #>> '{}')::numeric NOT BETWEEN 5 AND 240 THEN
      errs := errs || public.reg_err_item('/' || k, 'out_of_range', 'From 5 to 240 minutes.');
    ELSIF k = 'backup_max_age_hours' AND (v #>> '{}')::numeric NOT BETWEEN 1 AND 72 THEN
      errs := errs || public.reg_err_item('/' || k, 'out_of_range', 'From 1 to 72 hours.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  nxt := jsonb_build_object('request_expiry_minutes', (p_body ->> 'request_expiry_minutes')::integer,
                            'backup_max_age_hours', (p_body ->> 'backup_max_age_hours')::integer, 'version', (cur ->> 'version')::integer + 1);
  INSERT INTO public.settings (key, value, updated_by, updated_at) VALUES ('data_reset.settings', nxt, who.actor, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
  VALUES ('data_reset_settings_update', 'setting', 'data_reset.settings', cur, nxt, why, who.actor);
  RETURN public.data_reset_cfg();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('settings_data_reset_applied', 'workflow', NULL,
        jsonb_build_object('plan', 'data_reset_plan (the single list of the operator script and of Settings)',
                           'core', 'data_reset_core (owner pmis_reset_owner): counts, deletes, checks, sessions, one audit row',
                           'doors', 'admin_data_reset_request / approve / cancel / start / execute / fail / files_claim / files_record, admin_set_data_reset_settings',
                           'backup_rule', 'system_log source backup, level info, script db-backup, event backup_ok, type full or diff, within data_reset.settings.backup_max_age_hours'),
        'Project data reset in Settings with two System Admins (migration 0146, contract 0.15.62).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['data_reset_plan()', 'data_reset_deleting()', 'data_reset_core(boolean,text,jsonb,uuid,uuid)', 'data_reset_delete_unkept(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_reset_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  -- the guards call data_reset_deleting in the session of whoever deletes (it answers true only inside the running reset)
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_deleting() TO PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_plan() TO pmis_reset_owner, pmis_definer';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_delete_unkept(text) TO pmis_reset_owner';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_core(boolean,text,jsonb,uuid,uuid) TO pmis_definer';
  FOREACH f IN ARRAY ARRAY[
    'data_reset_rows_guard()', 'data_reset_no_truncate()', 'data_reset_err(integer,text,text,jsonb)', 'data_reset_cfg()', 'data_reset_admin_count()', 'data_reset_lock_held()',
    'data_reset_backup()', 'data_reset_user_json(uuid)', 'data_reset_stalled(data_reset_requests)', 'data_reset_req_json(data_reset_requests)',
    'data_reset_require_admin(boolean)', 'data_reset_require_reason(text,integer)', 'data_reset_require_phrase(text)', 'data_reset_expire()',
    'data_reset_log(text,uuid,jsonb,jsonb,text)', 'data_reset_lock_request(uuid,integer)', 'data_reset_maintenance()', 'data_reset_state_json()',
    'data_reset_request_get(uuid)', 'admin_data_reset_request(text,text)', 'admin_data_reset_approve(uuid,text,integer)', 'admin_data_reset_cancel(uuid,text,integer)',
    'admin_data_reset_start(uuid,text,integer,text)', 'admin_data_reset_execute(uuid)', 'admin_data_reset_fail(uuid,text)',
    'admin_data_reset_files_claim(uuid,boolean,text)', 'admin_data_reset_files_record(uuid,jsonb)', 'admin_set_data_reset_settings(jsonb,text,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'data_reset_maintenance()', 'data_reset_state_json()', 'data_reset_request_get(uuid)', 'admin_data_reset_request(text,text)',
      'admin_data_reset_approve(uuid,text,integer)', 'admin_data_reset_cancel(uuid,text,integer)', 'admin_data_reset_start(uuid,text,integer,text)',
      'admin_data_reset_execute(uuid)', 'admin_data_reset_fail(uuid,text)', 'admin_data_reset_files_claim(uuid,boolean,text)',
      'admin_data_reset_files_record(uuid,jsonb)', 'admin_set_data_reset_settings(jsonb,text,integer)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
