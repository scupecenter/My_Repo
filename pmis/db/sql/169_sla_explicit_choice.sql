-- 0170_sla_explicit_choice: every task has an explicit SLA status. Owner decision 2026-11-26 (relayed 19:59 and 20:01): at task creation the SLA is an explicit
-- choice (set it, or say "this task has no SLA"), never silently empty, and every task shows in Settings > SLA. Mirror: db/sql/169_sla_explicit_choice.sql (kept identical).
--
--   1. Table task_sla_choices: one row per task CODE for which somebody explicitly chose "no SLA" (is_none, reason, who, when). Keyed by code, not by version row,
--      so it follows the task through new workflow versions without touching the version copy functions. Nothing is deleted: clearing the choice sets is_none = false.
--   2. Status of a task (sla_task_status): set = it has an active base rule (no scenario, no region) in force today in its version; none = an explicit "no SLA"
--      choice and no rule; undecided = neither (shown as "Not decided"). A task with a rule is always "set", whatever the choice table says.
--   3. sla_task_overview(): one row per ACTIVE task of the version in force and of the open draft version (if any), with its status and its base rule.
--      Read-only. The page reads it through GET /settings/sla-tasks. Gates have no SLA of their own (0017 D4) and are not listed.
--   4. admin_task_sla_none(task, flag, reason): the audited door that records or clears the "no SLA" choice. Needs the sla_rules edit right (System Admin or delegation).
-- No clock, rule, SLA calculation, permission, role or default changes. Existing tasks without a rule are NOT decided for the owner: they show as "Not decided".

CREATE TABLE IF NOT EXISTS task_sla_choices (
  task_code text PRIMARY KEY CHECK (task_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  is_none boolean NOT NULL DEFAULT true,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  chosen_by uuid REFERENCES users (id),
  chosen_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE task_sla_choices IS '0170: an explicit "this task has no SLA" choice per task code. Written only through admin_task_sla_none, read through sla_task_overview.';
ALTER TABLE task_sla_choices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON task_sla_choices FROM pmis_app;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON task_sla_choices TO pmis_definer;
GRANT SELECT ON sla_rules, workflow_definitions, stage_definitions, task_definitions, users TO pmis_definer;

-- Overview of the tasks (active tasks of the version in force and of the open draft).
CREATE OR REPLACE FUNCTION sla_task_overview() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.in_draft, x.stage_sort, x.task_sort, x.code), '[]'::jsonb)
  FROM (
    SELECT td.code, td.sort_order AS task_sort, sd.seq AS stage_sort, (w.status = 'draft') AS in_draft,
      jsonb_build_object(
        'task_code', td.code, 'name_en', td.name_en, 'name_ar', td.name_ar, 'stage_code', sd.code,
        'workflow_version', w.version, 'in_draft', (w.status = 'draft'),
        'mode', CASE WHEN r.id IS NOT NULL THEN 'set' WHEN c.is_none IS TRUE THEN 'none' ELSE 'undecided' END,
        'none_reason', CASE WHEN r.id IS NULL AND c.is_none IS TRUE THEN c.reason END,
        'min_working_days', r.min_working_days, 'max_working_days', r.max_working_days, 'start_event', coalesce(r.start_ref, r.start_event),
        'unit', r.unit) AS j
    FROM public.task_definitions td
    JOIN public.workflow_definitions w ON w.id = td.workflow_id
    JOIN public.stage_definitions sd ON sd.id = td.stage_id
    LEFT JOIN public.task_sla_choices c ON c.task_code = td.code
    LEFT JOIN LATERAL (
      SELECT * FROM public.sla_rules r0
      WHERE r0.task_def_id = td.id AND r0.scenario IS NULL AND r0.region_id IS NULL AND r0.is_active
        AND r0.effective_from <= current_date AND (r0.effective_to IS NULL OR r0.effective_to > current_date)
      ORDER BY r0.effective_from DESC LIMIT 1) r ON true
    WHERE td.is_active AND (w.id = public.sla_workflow() OR w.status = 'draft')
  ) x
$$;

-- Records or clears the "no SLA" choice of a task code. A task that has a rule cannot be marked "no SLA" (remove or deactivate the rule first).
CREATE OR REPLACE FUNCTION admin_task_sla_none(p_task text, p_flag boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before_ jsonb; has_rule boolean;
BEGIN
  PERFORM public.wfe_require('sla_rules', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_task IS NULL OR NOT EXISTS (SELECT 1 FROM public.task_definitions td JOIN public.workflow_definitions w ON w.id = td.workflow_id
                                   WHERE td.code = p_task AND (w.id = public.sla_workflow() OR w.status = 'draft')) THEN
    PERFORM public.wfe_err1('/task_code', 'not_found', 'The task does not exist in the version in force or in the open draft.');
  END IF;
  SELECT to_jsonb(c) INTO before_ FROM public.task_sla_choices c WHERE c.task_code = p_task;
  IF p_flag THEN
    SELECT EXISTS (SELECT 1 FROM public.sla_rules r JOIN public.task_definitions td ON td.id = r.task_def_id
                   JOIN public.workflow_definitions w ON w.id = td.workflow_id
                   WHERE td.code = p_task AND r.scenario IS NULL AND r.region_id IS NULL AND r.is_active
                     AND r.effective_from <= current_date AND (r.effective_to IS NULL OR r.effective_to > current_date)
                     AND (w.id = public.sla_workflow() OR w.status = 'draft')) INTO has_rule;
    IF has_rule THEN PERFORM public.wfe_err1('/task_code', 'conflict', 'The task has an SLA rule. Remove the rule first, then mark the task as having no SLA.'); END IF;
    INSERT INTO public.task_sla_choices (task_code, is_none, reason, chosen_by, chosen_at)
    VALUES (p_task, true, btrim(p_reason), public.app_actor(), now())
    ON CONFLICT (task_code) DO UPDATE SET is_none = true, reason = btrim(p_reason), chosen_by = public.app_actor(), chosen_at = now();
  ELSE
    UPDATE public.task_sla_choices SET is_none = false, reason = btrim(p_reason), chosen_by = public.app_actor(), chosen_at = now() WHERE task_code = p_task;
  END IF;
  PERFORM public.wfe_audit('sla_none_choice', 'task', p_task, before_,
    (SELECT to_jsonb(c) FROM public.task_sla_choices c WHERE c.task_code = p_task), p_reason);
  RETURN jsonb_build_object('task_code', p_task, 'is_none', p_flag);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['sla_task_overview()', 'admin_task_sla_none(text,boolean,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Data reset coverage: every table needs a decision in data_reset_plan() (data_reset_core stops the reset on a table without one, and the
-- Settings reset refuses). data_reset_plan() is redefined from its latest definition (0152) with task_sla_choices added as KEEP (configuration).
-- ---------------------------------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS data_reset_plan();
CREATE FUNCTION data_reset_plan() RETURNS TABLE (tbl text, action text, part text, parts_expr text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t, 'keep', NULL::text, '''{}''::text[]' FROM unnest(ARRAY[
    -- identity and access (the optional identity tables are below)
    'local_credentials', 'user_totp', 'user_recovery_codes', 'auth_pending', 'user_sessions', 'email_change_requests', 'phone_change_requests',
    'user_invitations', 'roles', 'role_default_regions', 'role_default_modules', 'role_aliases', 'permission_profiles', 'permission_grants', 'field_permissions',
    'departments', 'pmis_context_keys',
    'staff_registry_visibility_state', 'staff_registry_visibility_fields', 'staff_registry_visibility_entries',
    'user_mfa_exemptions', 'me_admin_requests',
    -- configuration
    'workflow_definitions', 'workflow_streams', 'workflow_views', 'workflow_view_members', 'stage_definitions', 'task_definitions', 'task_predecessors',
    'phase_gate_rules', 'scenario_task_rules', 'scenario_rule_state', 'sla_rules', 'sla_rule_sets', 'sla_rule_set_items', 'sla_master_columns',
    'work_calendars', 'holidays', 'dlp_versions', 'weight_sets', 'weight_activities', 'weight_items', 'list_catalogues', 'list_values', 'field_definitions',
    'field_list_values', 'field_set_versions', 'document_types', 'document_type_versions', 'document_type_drafts', 'document_type_placements',
    'document_blank_forms', 'library_form_templates', 'template_definitions', 'template_versions', 'template_parts', 'template_task_fields', 'template_task_rules',
    'matrix_cells', 'matrix_cell_assignees', 'matrix_state', 'settings', 'nav_item_catalogue', 'master_columns', 'master_header_aliases', 'regions', 'region_aliases',
    'register_definitions', 'register_fields', 'register_sections', 'register_task_sources', 'register_column_locks', 'task_field_sources',
    'permit_types', 'snag_types', 'snag_severities', 'doc_sequences', 'doc_sequence_counters', 'doc_number_issues', 'warehouse_items',
    'warehouse_item_need_rules', 'warehouse_region_vendors', 'as_built_items', 'as_built_type_sources', 'contractor_rules', 'external_party_type_map',
    'team_specializations', 'team_scope_match', 'team_scope_match_groups', 'team_scope_match_meta', 'team_scope_match_scopes',
    -- master data of companies and their contracts and teams
    'external_parties', 'external_party_contracts', 'external_teams', 'external_team_specializations', 'contractor_alerts_sent',
    'task_sla_choices',
    -- between users, and personal preferences
    'messages', 'message_threads', 'message_participants', 'announcements', 'announcement_targets', 'announcement_recipients',
    'announcement_responses', 'saved_views', 'saved_view_versions', 'saved_view_targets', 'saved_view_region_targets', 'document_grid_views',
    -- the reset itself (0146): the transaction marker (empty outside a running reset)
    'data_reset_marker'
  ]) t
  UNION ALL
  SELECT t, 'log', NULL::text, '''{}''::text[]' FROM unnest(ARRAY[
    'audit_log', 'audit_log_chain', 'audit_field_changes', 'security_log', 'security_log_chain', 'log_chain_heads', 'log_integrity_runs', 'system_log',
    'security_alerts', 'security_alert_state', 'job_runs', 'deployments', 'mail_outbox', 'status_transitions', 'status_updates',
    'data_reset_requests', 'data_reset_request_files'
  ]) t
  UNION ALL
  -- optional identity parts: KEEP unless chosen; users are deactivated (never deleted), the others deleted
  SELECT * FROM (VALUES
    ('users', 'optional', 'users',
     'CASE WHEN public.data_reset_user_kept(t.id) OR t.id IN (SELECT k.id FROM pg_temp.reset_keep_users k) THEN ''{}''::text[] ELSE ARRAY[''users''] END'),
    ('user_role_assignments',         'optional', 'roles', 'ARRAY[''roles'']'),
    ('user_role_assignment_regions',  'optional', 'roles', 'ARRAY[''roles'']'),
    ('user_role_assignment_modules',  'optional', 'roles', 'ARRAY[''roles'']'),
    ('user_role_assignment_profiles', 'optional', 'roles', 'ARRAY[''roles'']'),
    ('delegations',                   'optional', 'roles', 'ARRAY[''roles'']'),
    ('delegation_grants',             'optional', 'roles', 'ARRAY[''roles'']'),
    ('delegation_regions',            'optional', 'roles', 'ARRAY[''roles'']'),
    ('groups',                        'optional', 'roles', 'CASE WHEN public.data_reset_group_kept(t.id) THEN ''{}''::text[] ELSE ARRAY[''roles''] END'),
    ('group_members',                 'optional', 'roles',
     'CASE WHEN EXISTS (SELECT 1 FROM public.groups g WHERE g.id = t.group_id AND g.is_system_admins) THEN ''{}''::text[] ELSE ARRAY[''roles''] END'),
    ('staff_registry',                'optional', 'staff', 'ARRAY[''staff'']'),
    ('absences',                      'optional', 'staff', 'ARRAY[''staff'']')
  ) o(tbl, action, part, parts_expr)
  UNION ALL
  -- MIXED: rows of several parts, or kept master data (the Contractors register, the vehicles)
  SELECT * FROM (VALUES
    ('register_records',          'mixed', '*', '(SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.id)'),
    ('register_steps',            'mixed', '*', '(SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.record_id)'),
    ('register_level_actors',     'mixed', '*', '(SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.record_id)'),
    ('register_level_voters',     'mixed', '*', '(SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.record_id)'),
    ('register_record_locks',     'mixed', '*', '(SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.record_id)'),
    ('team_scope_checks',         'mixed', '*', '(SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.record_id)'),
    ('document_slots',            'mixed', '*', '(SELECT s.parts FROM pg_temp.reset_slot s WHERE s.id = t.id)'),
    ('document_files',            'mixed', '*', '(SELECT s.parts FROM pg_temp.reset_slot s WHERE s.id = t.slot_id)'),
    ('document_record_snapshots', 'mixed', '*',
     'CASE WHEN EXISTS (SELECT 1 FROM pg_temp.reset_ent e WHERE e.entity_id = t.entity_id AND e.kept) THEN ''{}''::text[]'
     ' ELSE coalesce((SELECT e.parts FROM pg_temp.reset_ent e WHERE e.entity_id = t.entity_id), ''{}''::text[]) || ARRAY[''documents''] END'),
    ('comments',                  'mixed', '*', '(SELECT c.parts FROM pg_temp.reset_comment c WHERE c.id = t.id)'),
    ('comment_mentions',          'mixed', '*', '(SELECT c.parts FROM pg_temp.reset_comment c WHERE c.id = t.comment_id)'),
    ('levels_conversions',        'mixed', '*',
     'CASE WHEN t.entity_type = ''register_record'' THEN coalesce((SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.entity_id),'
     ' (SELECT e.parts FROM pg_temp.reset_ent e WHERE e.entity_id = t.entity_id), ARRAY[''sites'']) ELSE ARRAY[''sites''] END'),
    ('import_batches',            'mixed', '*', '(SELECT b.parts FROM pg_temp.reset_batch b WHERE b.id = t.id)'),
    ('import_batch_rows',         'mixed', '*', '(SELECT b.parts FROM pg_temp.reset_batch b WHERE b.id = t.batch_id)'),
    ('user_drafts',               'mixed', '*',
     'CASE WHEN t.draft_key LIKE ''task.%'' THEN ARRAY[''sites''] WHEN t.draft_key LIKE ''record.%'' THEN'
     ' CASE WHEN t.draft_key = ''record.contractors.new'' OR substr(t.draft_key, length(split_part(t.draft_key, ''.'', 1) || split_part(t.draft_key, ''.'', 2)) + 3)'
     ' IN (SELECT e.entity_id::text FROM pg_temp.reset_ent e WHERE e.kept UNION ALL SELECT r.id::text FROM pg_temp.reset_rec r WHERE r.parts = ''{}'')'
     ' THEN ''{}''::text[] ELSE ARRAY[coalesce(public.data_reset_register_part(split_part(t.draft_key, ''.'', 2)), ''sites'')] END ELSE ''{}''::text[] END'),
    ('stored_object_meta',        'mixed', '*', 'coalesce((SELECT f.parts FROM pg_temp.reset_files f WHERE f.storage_key = t.storage_key), ''{}''::text[])')
  ) m(tbl, action, part, parts_expr)
  UNION ALL
  -- DELETE: every row of the table belongs to the parts named (a few tables to several)
  SELECT * FROM (VALUES
    ('sites', 'delete', 'sites', 'ARRAY[''sites'']'), ('clusters', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('task_instances', 'delete', 'sites', 'ARRAY[''sites'']'), ('task_cover_decisions', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('workflow_steps', 'delete', 'sites', 'ARRAY[''sites'']'), ('task_level_actors', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('task_level_voters', 'delete', 'sites', 'ARRAY[''sites'']'), ('task_delay_periods', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('admin_overrides', 'delete', 'sites', 'ARRAY[''sites'']'), ('site_gate_state', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('site_gate_events', 'delete', 'sites', 'ARRAY[''sites'']'), ('site_snapshots', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('site_workflow_migrations', 'delete', 'sites', 'ARRAY[''sites'']'), ('site_drafts', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('baseline_versions', 'delete', 'sites', 'ARRAY[''sites'']'), ('baseline_entries', 'delete', 'sites', 'ARRAY[''sites'']'),
    ('watches', 'delete', '*', 'ARRAY[''notifications'', ''sites''] || CASE WHEN t.register_key IS NULL THEN ''{}''::text[]'
                               ' ELSE ARRAY[coalesce(public.data_reset_register_part(t.register_key), ''sites'')] END'),
    ('change_requests', 'delete', 'change_control', 'ARRAY[''change_control'']'), ('site_scope_exceptions', 'delete', 'change_control', 'ARRAY[''change_control'']'),
    ('rf_design_records', 'delete', 'rf_design', 'ARRAY[''rf_design'']'), ('acquisition_candidates', 'delete', 'acquisition', 'ARRAY[''acquisition'']'),
    ('procurement_records', 'delete', 'procurement', 'ARRAY[''procurement'']'), ('assignment_readiness', 'delete', 'procurement', 'ARRAY[''procurement'']'),
    ('gecol_records', 'delete', 'gecol', 'ARRAY[''gecol'']'),
    ('hlc_records', 'delete', 'hlc', 'ARRAY[''hlc'']'), ('hlc_legacy_migrations', 'delete', 'hlc', 'ARRAY[''hlc'']'),
    ('hlc_pr_links', 'delete', '*', 'coalesce((SELECT r.parts FROM pg_temp.reset_rec r WHERE r.id = t.hlc_record_id), ARRAY[''hlc'']) || ARRAY[''procurement'']'),
    ('permit_records', 'delete', 'permits', 'ARRAY[''permits'']'),
    ('quality_inspections', 'delete', 'quality', 'ARRAY[''quality'']'), ('snags', 'delete', 'quality', 'ARRAY[''quality'']'),
    ('snag_photos', 'delete', 'quality', 'ARRAY[''quality'']'), ('snag_level_voters', 'delete', 'quality', 'ARRAY[''quality'']'),
    ('issues', 'delete', 'issues', 'ARRAY[''issues'']'), ('risks', 'delete', 'risks', 'ARRAY[''risks'']'),
    ('readiness_handover', 'delete', 'readiness', 'ARRAY[''readiness'']'), ('as_built_records', 'delete', 'as_built', 'ARRAY[''as_built'']'),
    ('meetings', 'delete', 'meetings', 'ARRAY[''meetings'']'), ('meeting_actions', 'delete', 'meetings', 'ARRAY[''meetings'']'),
    ('warehouse_serials', 'delete', 'warehouse', 'ARRAY[''warehouse'']'), ('warehouse_site_qty', 'delete', 'warehouse', 'ARRAY[''warehouse'']'),
    ('wh_movements', 'delete', 'warehouse', 'ARRAY[''warehouse'']'), ('wh_movement_lines', 'delete', 'warehouse', 'ARRAY[''warehouse'']'),
    ('vehicle_reservations', 'delete', 'car_dispatcher', 'ARRAY[''car_dispatcher'']'),
    ('document_site_overrides', 'delete', 'documents', 'ARRAY[''documents'']'), ('document_task_snapshots', 'delete', 'documents', 'ARRAY[''documents'']'),
    ('library_generated_docs', 'delete', 'documents', 'ARRAY[''documents'']'),
    ('document_export_jobs', 'delete', 'imports', 'ARRAY[''imports'']'),
    ('import_batch_jobs', 'delete', 'imports', 'coalesce((SELECT b.parts FROM pg_temp.reset_batch b WHERE b.id = t.batch_id), ''{}''::text[]) || ARRAY[''imports'']'),
    ('import_uploads', 'delete', 'imports', 'ARRAY[''imports'']'), ('master_reconciliation_runs', 'delete', 'imports', 'ARRAY[''imports'']'),
    ('master_reconciliation_rows', 'delete', 'imports', 'ARRAY[''imports'']'), ('master_reconciliation_diffs', 'delete', 'imports', 'ARRAY[''imports'']'),
    ('mi_apply_jobs', 'delete', 'imports', 'ARRAY[''imports'']'), ('hrf_stage_marks', 'delete', 'imports', 'ARRAY[''imports'']'),
    ('hgd_marks', 'delete', 'imports', 'ARRAY[''imports'']'),
    ('notifications', 'delete', 'notifications', 'ARRAY[''notifications'']'),
    ('daily_plans', 'delete', 'daily_plan', 'ARRAY[''daily_plan'']'), ('daily_plan_rows', 'delete', 'daily_plan', 'ARRAY[''daily_plan'']'),
    ('progress_snapshots', 'delete', 'kpi', 'ARRAY[''kpi'']'), ('dash_snapshot_runs', 'delete', 'kpi', 'ARRAY[''kpi'']'),
    ('ps_manual_values', 'delete', 'kpi', 'ARRAY[''kpi'']'), ('ps_manual_plans', 'delete', 'kpi', 'ARRAY[''kpi'']')
  ) d(tbl, action, part, parts_expr)
$$;

DO $$
BEGIN
  EXECUTE 'ALTER FUNCTION data_reset_plan() OWNER TO pmis_reset_owner';
  EXECUTE 'REVOKE ALL ON FUNCTION data_reset_plan() FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_plan() TO pmis_reset_owner, pmis_definer';
END $$;
-- the reset role reads every table (counts) and takes the share lock of a KEEP table (UPDATE): the coverage check of data_reset_core refuses a table without these rights
GRANT SELECT, UPDATE ON public.task_sla_choices TO pmis_reset_owner;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('sla_explicit_choice_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner 2026-11-26: the SLA of a task is an explicit choice (set or no SLA) and every task shows in Settings > SLA', 'functions', 'sla_task_overview, admin_task_sla_none'),
        'Migration 0170: table task_sla_choices, the task overview and the door that records a "no SLA" choice.');
