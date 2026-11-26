-- 0171_issue_task_map: package 4a of the issue work. Where a site is stopped (its latest open, late or blocked task) gets an issue CATEGORY and BLOCKER REASON from an
-- editable map: task code -> category + reason. Owner decision 2026-11-26 (20:16, relayed by Main): the category and reason follow where the site is stopped
-- (stopped in acquisition -> acquisition problem, civil work -> civil, GECOL -> GECOL, likewise the other work groups); the map is seeded from the task group,
-- shown in Settings and editable. Mirror: db/sql/170_issue_task_map.sql (kept identical).
--
--   1. Table issue_task_map: one row per task CODE (follows the task through new workflow versions): category (a value of the list IssueCategory) and reason
--      (a value of the list BlockerReason, optional), `is_active`, who and when. Nothing is deleted: a row is hidden with is_active = false.
--   2. Seed: every task code of the workflow in force gets a row, by its group: A1, A3 acquisition; B1, B2 supply; B3, D1 access; B4-B15 civil; C1, C2 power (GECOL);
--      C3, C4 fiber (HLC); D2-D17 and F1, F2 telecom; anything else Other. The reason is set only where the group says it plainly (acquisition, GECOL, HLC, access, supply);
--      the rest stay without a reason ("Not classified") until the owner maps them. A task code created later has no row and shows as Other / Not classified.
--   3. admin_issue_task_map_save(task, category, reason, is_active, why): the audited door (needs the `settings` edit right, System Admin or delegation).
-- Read only for everything else: the derived "stopped at" rows are computed by the API (no register record is written) and no permission, role or default changes.

CREATE TABLE IF NOT EXISTS issue_task_map (
  task_code text PRIMARY KEY CHECK (task_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),   -- a code of the list IssueCategory (checked by the door, not by a key: list values are editable)
  reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 80), -- a code of the list BlockerReason, or empty = Not classified
  is_active boolean NOT NULL DEFAULT true,
  changed_by uuid REFERENCES users (id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE issue_task_map IS '0171: task code -> issue category and blocker reason for the derived "stopped at" issue rows. Edited only through admin_issue_task_map_save.';
ALTER TABLE issue_task_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY issue_task_map_read ON issue_task_map FOR SELECT USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON issue_task_map FROM pmis_app;
    GRANT SELECT ON issue_task_map TO pmis_app;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON issue_task_map TO pmis_definer;
GRANT SELECT ON list_values TO pmis_definer;

-- Seed: one row per task code of the workflow in force, by the group of the task.
INSERT INTO issue_task_map (task_code, category, reason)
SELECT td.code,
  CASE
    WHEN td.code IN ('A1', 'A3') THEN 'Acquisition'
    WHEN td.code IN ('B1', 'B2') THEN 'Supply'
    WHEN td.code IN ('B3', 'D1') THEN 'Access'
    WHEN td.code ~ '^B[0-9]+' THEN 'Civil'
    WHEN td.code IN ('C1', 'C2') THEN 'Power'
    WHEN td.code IN ('C3', 'C4') THEN 'Fiber'
    WHEN td.code ~ '^(D|F)[0-9]+' THEN 'Telecom'
    ELSE 'Other'
  END,
  CASE
    WHEN td.code IN ('A1', 'A3') THEN 'Land or Acquisition'
    WHEN td.code IN ('B1', 'B2') THEN 'Material Not Delivered'
    WHEN td.code IN ('B3', 'D1') THEN 'Access or Permit'
    WHEN td.code IN ('C1', 'C2') THEN 'Waiting GECOL'
    WHEN td.code IN ('C3', 'C4') THEN 'Waiting HLC'
    ELSE NULL
  END
FROM task_definitions td
WHERE td.workflow_id = public.sla_workflow()
  AND td.is_active AND NOT td.is_milestone_task
ON CONFLICT (task_code) DO NOTHING;

-- The audited door. A value must exist in its list (a hidden value is still accepted so an old map keeps working); a reason is optional.
CREATE OR REPLACE FUNCTION admin_issue_task_map_save(p_task text, p_category text, p_reason text, p_active boolean, p_why text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before_ jsonb; after_ jsonb;
BEGIN
  PERFORM public.wfe_require('settings', 'edit');
  PERFORM public.calc_require_reason(p_why);
  IF p_task IS NULL OR NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE code = p_task) THEN
    PERFORM public.wfe_err1('/task_code', 'not_found', 'No workflow version has a task with this code.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.list_values WHERE catalogue_code = 'IssueCategory' AND code = p_category) THEN
    PERFORM public.wfe_err1('/category', 'invalid', 'Choose a value of the list Issue category.');
  END IF;
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.list_values WHERE catalogue_code = 'BlockerReason' AND code = btrim(p_reason)) THEN
    PERFORM public.wfe_err1('/reason', 'invalid', 'Choose a value of the list Blocker reason, or leave it empty.');
  END IF;
  SELECT to_jsonb(m) INTO before_ FROM public.issue_task_map m WHERE m.task_code = p_task;
  INSERT INTO public.issue_task_map (task_code, category, reason, is_active, changed_by, changed_at)
  VALUES (p_task, p_category, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_active, true), public.app_actor(), now())
  ON CONFLICT (task_code) DO UPDATE SET category = EXCLUDED.category, reason = EXCLUDED.reason, is_active = EXCLUDED.is_active,
    changed_by = EXCLUDED.changed_by, changed_at = now();
  SELECT to_jsonb(m) INTO after_ FROM public.issue_task_map m WHERE m.task_code = p_task;
  PERFORM public.wfe_audit('issue_task_map_saved', 'issue_task_map', p_task, before_, after_, p_why);
  RETURN after_;
END $$;

DO $$
DECLARE f text := 'admin_issue_task_map_save(text,text,text,boolean,text)';
BEGIN
  EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Data reset coverage: every table needs a decision in data_reset_plan() (data_reset_core stops the reset on a table without one, and the
-- Settings reset refuses). data_reset_plan() is redefined from its latest definition (0152) with issue_task_map added as KEEP (configuration).
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
    'issue_task_map',
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
-- the reset role reads every table and takes the share lock of a KEEP table (UPDATE)
GRANT SELECT, UPDATE ON public.issue_task_map TO pmis_reset_owner;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('issue_task_map_applied', 'issue_task_map', NULL,
        jsonb_build_object('decision', 'owner 2026-11-26: the category and reason of a stopped site follow where it is stopped; seeded from the task group, editable in Settings', 'function', 'admin_issue_task_map_save'),
        'Migration 0171: the task -> issue category and reason map and its audited door.');
