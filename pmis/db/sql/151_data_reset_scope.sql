-- 0152_data_reset_scope: the project data reset becomes selectable (owner decision 2026-11-24; contract 0.15.71, CHANGELOG 207).
-- Mirror: db/sql/151_data_reset_scope.sql (kept byte-identical). The contract of the reset is docs/ops/data-reset.md.
--
--   1. Parts. data_reset_parts() is the catalogue of what can be reset, each part with a stable code, its labels EN/AR and the parts it depends on
--      (depends_on: when one of them is reset, this part is reset too). data_reset_closure(parts) adds every dependent part until nothing changes; the
--      database computes it, the API never trusts the client's list. No list (NULL) means "everything (as today)": every project part, no identity part.
--   2. The plan. data_reset_plan() gives every table a part (column part) and, for every table that loses rows, the parts of each row (parts_expr, an SQL
--      expression over the row t). A row goes when its parts overlap the closure; the MIXED tables (register records, documents, comments, batches,
--      drafts, envelopes) are distributed row by row over the parts. The coverage check still refuses an unclassified table, and now also a register key
--      without a part. data_reset_core(..., p_parts, p_keep_users) counts per table and per part, deletes in foreign-key order with the predicate the checks
--      use, and checks every table as before. The old five-argument data_reset_core stays as the "everything" call of the operator script.
--   3. Three optional identity parts (never in "everything"): users (every account is deactivated, status disabled, except the members of a System Admins
--      group, the break-glass account, the requester and the two approvers; rows stay, sessions end, one summarised audit row), roles (role assignments with
--      their regions, modules and profiles, delegations with their grants and regions, every group but a System Admins group and its members; a group named
--      by the Responsibility Matrix or by a staff registry visibility entry is emptied, not deleted; role definitions, permission profiles and their grants
--      stay), staff (the staff registry and the absences; the visibility settings stay, they name roles, groups and users, none of which is deleted). The
--      identity writes go through idm_data_reset_identity, owned by pmis_identity_owner (the 0009 backstops let only that role write users, groups and group
--      members; no trigger is weakened); it runs only inside a running reset (data_reset_deleting) and only the reset role may call it. The staff registry
--      guard lets the reset role through inside the running reset, as the other delete guards do since 0146.
--   4. The request stores the scope: the requested parts, the normalised closure (jsonb) and its SHA-256 (scope_hash). The approval binds to that hash
--      (approved_scope_hash, a CHECK keeps both equal); an approver who saw another scope is refused (409 scope_changed), and so is a request whose closure
--      would be different today (the dependency map changed). The scope of a request never changes (the row guard); a changed scope is a new request.
--   5. data_reset_dry_run(parts): the counts per part and per table for a chosen scope, for the picker of Settings > Data > Data reset.
--
-- Every door is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp; owners as in 0146 (pmis_reset_owner for the core and its helpers,
-- pmis_definer for the doors, pmis_identity_owner for the identity writes), PUBLIC revoked, the grants re-applied. No new table.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The catalogue of parts, the closure and the scope hash
-- ---------------------------------------------------------------------------------------------------------------------
-- depends_on: the parts whose reset takes this part with it (every site-scoped part depends on sites). kind: project (in "everything") or identity.
CREATE OR REPLACE FUNCTION data_reset_parts()
RETURNS TABLE (code text, grp text, kind text, ord integer, label_en text, label_ar text, depends_on text[])
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM (VALUES
    ('sites',              'project',   'project',  10, 'Sites, tasks, milestones, gates and baselines', 'المواقع ومهامها ومعالمها وبواباتها والخطط الأساسية', '{}'::text[]),
    ('documents',          'project',   'project',  20, 'Documents and generated forms (Library)', 'المستندات والنماذج المولّدة (المكتبة)', '{sites}'::text[]),
    ('imports',            'project',   'project',  30, 'Imports, upload batches and exports', 'الاستيرادات ودفعات الرفع والتصديرات', '{sites}'::text[]),
    ('notifications',      'project',   'project',  40, 'Notifications, inbox and follows', 'الإشعارات وصندوق الوارد والمتابعات', '{}'::text[]),
    ('daily_plan',         'project',   'project',  50, 'Daily Plan', 'الخطة اليومية', '{sites}'::text[]),
    ('kpi',                'project',   'project',  60, 'Project Status and KPI snapshots', 'حالة المشروع ولقطات مؤشرات الأداء', '{sites}'::text[]),
    ('procurement',        'registers', 'project', 100, 'Procurement (PR / PO / WO, assignments)', 'المشتريات (PR / PO / WO والتكليفات)', '{sites}'::text[]),
    ('gecol',              'registers', 'project', 110, 'GECOL Power', 'كهرباء GECOL', '{sites}'::text[]),
    ('hlc',                'registers', 'project', 120, 'HLC fiber', 'ألياف HLC', '{sites}'::text[]),
    ('permits',            'registers', 'project', 130, 'Permits & HSE', 'التصاريح والسلامة', '{sites}'::text[]),
    ('warehouse',          'registers', 'project', 140, 'Warehouse (movements and stock; the item master stays)', 'المخزن (الحركات والأرصدة؛ يبقى دليل الأصناف)', '{sites}'::text[]),
    ('quality',            'registers', 'project', 150, 'Quality Control (inspections and QC snags)', 'ضبط الجودة (الفحوص وملاحظات الجودة)', '{sites}'::text[]),
    ('issues',             'registers', 'project', 160, 'Issue Log', 'سجل المشاكل', '{sites}'::text[]),
    ('risks',              'registers', 'project', 170, 'Risk Register', 'سجل المخاطر', '{sites}'::text[]),
    ('change_control',     'registers', 'project', 180, 'Change Control (and the scope exceptions it made)', 'ضبط التغيير (واستثناءات النطاق الناتجة عنه)', '{sites}'::text[]),
    ('readiness',          'registers', 'project', 190, 'Readiness & Handover', 'الجاهزية والتسليم', '{sites}'::text[]),
    ('as_built',           'registers', 'project', 200, 'As-Built (the item list stays)', 'كما نُفّذ (تبقى قائمة البنود)', '{sites}'::text[]),
    ('meetings',           'registers', 'project', 210, 'Meetings', 'الاجتماعات', '{sites}'::text[]),
    ('rf_design',          'registers', 'project', 220, 'RF & Design', 'الترددات والتصميم', '{sites}'::text[]),
    ('acquisition',        'registers', 'project', 230, 'Acquisition', 'الاستحواذ', '{sites}'::text[]),
    ('dismantle',          'registers', 'project', 240, 'Dismantle', 'الفك', '{sites}'::text[]),
    ('deliverables',       'registers', 'project', 250, 'Deliverables', 'المخرجات', '{sites}'::text[]),
    ('car_dispatcher',     'registers', 'project', 260, 'Car Dispatcher bookings (the vehicles stay)', 'حجوزات السيارات (تبقى المركبات)', '{sites,procurement}'::text[]),
    ('financial_advances', 'registers', 'project', 270, 'Financial Advances', 'العهد المالية', '{sites,procurement}'::text[]),
    ('users',              'identity',  'identity', 900, 'Users: deactivate every account except the System Admins', 'المستخدمون: تعطيل كل الحسابات عدا مديري النظام', '{}'::text[]),
    ('roles',              'identity',  'identity', 910, 'Roles, groups and delegations (role definitions and profiles stay)', 'الأدوار والمجموعات والتفويضات (تبقى تعريفات الأدوار والملفات)', '{}'::text[]),
    ('staff',              'identity',  'identity', 920, 'Staff registry and absences', 'سجل الموظفين والغيابات', '{}'::text[])
  ) v(code, grp, kind, ord, label_en, label_ar, depends_on)
$$;

-- "Everything (as today)": every project part, no identity part (sorted by code: the normal form of a scope).
CREATE OR REPLACE FUNCTION data_reset_project_parts() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY(SELECT p.code FROM public.data_reset_parts() p WHERE p.kind = 'project' ORDER BY p.code)
$$;

-- The closure of a choice: the chosen parts plus, until nothing changes, every part that depends on one of them. Sorted by code. NULL = everything.
-- An unknown code, a NULL element or an empty choice is refused (22023).
CREATE OR REPLACE FUNCTION data_reset_closure(p_parts text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s text[]; nxt text[]; bad text;
BEGIN
  IF p_parts IS NULL THEN RETURN public.data_reset_project_parts(); END IF;
  IF cardinality(p_parts) = 0 THEN RAISE EXCEPTION 'reset-project-data: choose at least one part' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT string_agg(coalesce(x, 'NULL'), ', ' ORDER BY x) INTO bad FROM unnest(p_parts) x
  WHERE x IS NULL OR x NOT IN (SELECT p.code FROM public.data_reset_parts() p);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: unknown part: %', bad USING ERRCODE = 'invalid_parameter_value'; END IF;
  s := ARRAY(SELECT DISTINCT x FROM unnest(p_parts) x ORDER BY x);
  LOOP
    nxt := ARRAY(SELECT DISTINCT c FROM (SELECT unnest(s) AS c UNION SELECT p.code FROM public.data_reset_parts() p WHERE p.depends_on && s) z ORDER BY c);
    EXIT WHEN nxt = s;
    s := nxt;
  END LOOP;
  RETURN s;
END $$;

-- The hash an approval binds to: SHA-256 of the normalised closure (sorted codes).
CREATE OR REPLACE FUNCTION data_reset_scope_hash(p_closure text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to('pmis-data-reset-scope:1:' || array_to_string(ARRAY(SELECT x FROM unnest(p_closure) x ORDER BY x), ','), 'UTF8')), 'hex')
$$;

-- The scope as stored on a request and shown on the screen: the requested parts, the closure, what the closure added, the hash.
CREATE OR REPLACE FUNCTION data_reset_scope_json(p_parts text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c text[] := public.data_reset_closure(p_parts); req text[];
BEGIN
  req := CASE WHEN p_parts IS NULL THEN c ELSE ARRAY(SELECT DISTINCT x FROM unnest(p_parts) x ORDER BY x) END;
  RETURN jsonb_build_object('version', 1, 'requested', to_jsonb(req), 'parts', to_jsonb(c),
    'added', to_jsonb(ARRAY(SELECT x FROM unnest(c) x WHERE x <> ALL (req) ORDER BY x)),
    'everything', c @> public.data_reset_project_parts(), 'identity', to_jsonb(ARRAY(SELECT x FROM unnest(c) x WHERE x IN ('users', 'roles', 'staff') ORDER BY x)),
    'hash', public.data_reset_scope_hash(c));
END $$;

-- The part of a register (register_records.register_key, document_slots.register_key, drafts record.<key>.*). NULL: the Contractors register (master data,
-- kept) and any key without a part (the coverage check of data_reset_core refuses those).
CREATE OR REPLACE FUNCTION data_reset_register_part(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_key IN ('procurement', 'procurement_hlc') THEN 'procurement'
    WHEN p_key IN ('permits_hse', 'permits_hse_acq', 'permits_hse_om', 'permits_hse_te') THEN 'permits'
    WHEN p_key IN ('quality', 'quality_te') THEN 'quality'
    WHEN p_key = 'readiness_handover' THEN 'readiness'
    WHEN p_key = 'site_creation' THEN 'sites'
    WHEN p_key IN ('gecol', 'hlc', 'warehouse', 'issues', 'risks', 'change_control', 'as_built', 'meetings', 'rf_design', 'acquisition', 'dismantle',
                   'deliverables', 'car_dispatcher', 'financial_advances', 'daily_plan') THEN p_key
  END
$$;

-- A user the users part never deactivates: a member of a System Admins group (whatever its state), the break-glass account, an account already disabled,
-- soft-deleted or purged.
CREATE OR REPLACE FUNCTION data_reset_user_kept(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status <> 'disabled' AND u.deleted_at IS NULL AND u.purged_at IS NULL AND NOT u.is_break_glass)
      OR EXISTS (SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins WHERE gm.user_id = p_user)
$$;

-- A group the roles part keeps: a System Admins group (with its members), and a group that kept configuration names (a holder of the Responsibility Matrix,
-- a staff registry visibility entry): that one is emptied, not deleted, so no kept row names a deleted group.
CREATE OR REPLACE FUNCTION data_reset_group_kept(p_group uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = p_group AND g.is_system_admins)
      OR EXISTS (SELECT 1 FROM public.matrix_cell_assignees a WHERE a.kind = 'group' AND a.ref_id = p_group)
      OR EXISTS (SELECT 1 FROM public.staff_registry_visibility_entries e WHERE e.kind = 'group' AND e.ref_id = p_group)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The plan (redefined from 0151): every base table with its decision, its part and the parts of each of its rows
-- ---------------------------------------------------------------------------------------------------------------------
-- action: keep, log (KEEP, append-only), delete (emptied by "everything"), mixed (kept rows stay in "everything"), optional (KEEP unless its identity part
-- is chosen). part: the part the table belongs to ('*' when its rows belong to several parts; NULL for KEEP and log). parts_expr: the parts of a row t,
-- over the temporary sets that data_reset_core builds before any delete; a row goes when its parts overlap the closure.
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The delete helper reads the predicate of the running reset (the checks use the very same one)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION data_reset_delete_unkept(p_tbl text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w text; n bigint;
BEGIN
  IF NOT public.data_reset_deleting() THEN RAISE EXCEPTION 'reset-project-data: only inside a running reset' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT p.keep_where INTO STRICT w FROM pg_temp.reset_plan p WHERE p.tbl = p_tbl AND p.action IN ('delete', 'mixed', 'optional');
  IF w = 'true' THEN RETURN 0; END IF;
  EXECUTE format('DELETE FROM public.%I t WHERE (%s) IS NOT TRUE', p_tbl, w);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The staff registry guard lets the running reset through (latest definition 0142; the body is unchanged but for that line)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION people_staff_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'pmis_reset_owner' AND public.data_reset_deleting() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'staff registry rows are never deleted: deactivate the row instead' USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The identity writes (owner pmis_identity_owner, as every idm_* function): only inside a running reset, only for the reset role
-- ---------------------------------------------------------------------------------------------------------------------
-- p_parts: the closure (only users and roles are read). p_keep: accounts never deactivated (the requester, the approver, the runner). The System Admins group
-- and its members are never touched, so the last-admin guard (idm_last_admin_check) holds and no System Admin loses admin rights. Returns what was done.
CREATE OR REPLACE FUNCTION idm_data_reset_identity(p_parts text[], p_keep uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE res jsonb := '{}'::jsonb; n_asg bigint; n_del bigint; n_grp bigint; n_mem bigint; emptied jsonb; who jsonb;
BEGIN
  IF NOT public.data_reset_deleting() THEN
    RAISE EXCEPTION 'reset-project-data: the identity parts run only inside a running reset' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF 'roles' = ANY (p_parts) THEN
    DELETE FROM public.delegation_grants;
    DELETE FROM public.delegation_regions;
    DELETE FROM public.delegations;
    GET DIAGNOSTICS n_del = ROW_COUNT;
    DELETE FROM public.user_role_assignment_profiles;
    DELETE FROM public.user_role_assignment_regions;
    DELETE FROM public.user_role_assignment_modules;
    DELETE FROM public.user_role_assignments;
    GET DIAGNOSTICS n_asg = ROW_COUNT;
    SELECT coalesce(jsonb_agg(g.id ORDER BY g.id), '[]'::jsonb) INTO emptied FROM public.groups g
    WHERE NOT g.is_system_admins AND public.data_reset_group_kept(g.id) AND EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = g.id);
    DELETE FROM public.group_members gm WHERE NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = gm.group_id AND g.is_system_admins);
    GET DIAGNOSTICS n_mem = ROW_COUNT;
    DELETE FROM public.groups g WHERE NOT public.data_reset_group_kept(g.id);
    GET DIAGNOSTICS n_grp = ROW_COUNT;
    res := res || jsonb_build_object('roles', jsonb_build_object('assignments_deleted', n_asg, 'delegations_deleted', n_del, 'group_members_deleted', n_mem,
      'groups_deleted', n_grp, 'groups_emptied', emptied));
  END IF;
  IF 'users' = ANY (p_parts) THEN
    -- deactivated as the normal path does (status disabled; the sessions end with the reset's session step); never deleted, reactivated later with
    -- idm_set_user_status
    WITH d AS (
      UPDATE public.users u SET status = 'disabled', updated_at = now()
      WHERE NOT public.data_reset_user_kept(u.id) AND u.id <> ALL (coalesce(p_keep, '{}'::uuid[]))
      RETURNING u.id, u.employee_id)
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'employee_id', d.employee_id) ORDER BY d.employee_id, d.id), '[]'::jsonb) INTO who FROM d;
    res := res || jsonb_build_object('users', jsonb_build_object('deactivated', jsonb_array_length(who), 'accounts', who));
  END IF;
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The core (redefined from 0151): the scope, the counts per table and per part, the deletes, the identity parts, the checks
-- ---------------------------------------------------------------------------------------------------------------------
-- p_parts: the chosen parts (NULL = everything as today); the closure is computed here. p_keep_users: accounts the users part never deactivates.
-- Returns {scope, plan: [{tbl, action, part, rows, delete, keep}], parts: [{code, rows, tables}], files, and after a run deleted, files (keys), audit_id,
-- sessions_ended, identity}.
CREATE OR REPLACE FUNCTION data_reset_core(p_execute boolean, p_reason text, p_detail jsonb, p_keep_session uuid, p_request uuid, p_parts text[], p_keep_users uuid[])
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record; missing text; extra text; bad text; total bigint; kept bigint; aid bigint; n_sess bigint; res jsonb; t text;
  a_before bigint; a_after bigint; c_before bigint; c_after bigint; s_before bigint; s_after bigint;
  scope text[]; sj jsonb; ident jsonb := '{}'::jsonb; a_mark bigint; n_side bigint := 0; exempt text[] := '{}'::text[]; started timestamptz := clock_timestamp();
  -- foreign-key order: children before parents; each table is reduced with the predicate of the scope (cascade-only children follow their parents)
  ord text[] := ARRAY[
    'task_delay_periods', 'ps_manual_values', 'ps_manual_plans', 'dash_snapshot_runs', 'snag_photos', 'notifications', 'watches', 'user_drafts', 'hgd_marks',
    'hrf_stage_marks', 'mi_apply_jobs', 'import_uploads', 'master_reconciliation_diffs', 'master_reconciliation_rows', 'master_reconciliation_runs',
    'import_batch_jobs', 'document_export_jobs', 'document_files', 'document_record_snapshots', 'document_task_snapshots', 'document_site_overrides',
    'document_slots', 'snag_level_voters', 'snags', 'comments', 'levels_conversions', 'wh_movement_lines', 'wh_movements', 'warehouse_serials',
    'warehouse_site_qty', 'vehicle_reservations', 'assignment_readiness', 'hlc_legacy_migrations', 'hlc_pr_links', 'register_record_locks', 'register_records',
    'rf_design_records', 'acquisition_candidates', 'procurement_records', 'gecol_records', 'hlc_records', 'permit_records', 'quality_inspections', 'issues',
    'risks', 'readiness_handover', 'as_built_records', 'meeting_actions', 'meetings', 'site_scope_exceptions', 'change_requests', 'site_gate_state',
    'admin_overrides', 'task_level_actors', 'task_level_voters', 'task_cover_decisions', 'library_generated_docs', 'daily_plan_rows', 'daily_plans',
    'workflow_steps', 'task_instances', 'site_workflow_migrations', 'baseline_entries', 'baseline_versions', 'progress_snapshots', 'site_drafts',
    'import_batches', 'sites', 'clusters', 'absences', 'staff_registry', 'stored_object_meta'];
  -- removed only through their parent (ON DELETE CASCADE), or in one statement with site_drafts, or by the identity owner
  cascaded text[] := ARRAY['register_steps', 'register_level_actors', 'register_level_voters', 'team_scope_checks', 'comment_mentions', 'site_gate_events',
    'site_snapshots', 'import_batch_rows'];
  ident_tbls text[] := ARRAY['users', 'user_role_assignments', 'user_role_assignment_regions', 'user_role_assignment_modules', 'user_role_assignment_profiles',
    'delegations', 'delegation_grants', 'delegation_regions', 'groups', 'group_members'];
BEGIN
  IF p_execute IS NULL THEN RAISE EXCEPTION 'reset-project-data: execute must be true or false'; END IF;
  scope := public.data_reset_closure(p_parts);
  sj := public.data_reset_scope_json(p_parts);
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

  -- 1. Coverage: every base table has a decision, every decision a table, every table that loses rows a place in the delete order, every register key a
  -- part (a table or a register added by a later migration stops the reset until it is classified).
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname NOT IN (SELECT p.tbl FROM public.data_reset_plan() p);
  SELECT string_agg(p.tbl, ', ' ORDER BY p.tbl) INTO extra FROM public.data_reset_plan() p WHERE to_regclass('public.' || quote_ident(p.tbl)) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: tables without a decision (classify them in data_reset_plan and in docs/ops/data-reset.md): %', missing; END IF;
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: the plan names tables that do not exist: %', extra; END IF;
  SELECT string_agg(p.tbl, ', ' ORDER BY p.tbl) INTO bad FROM public.data_reset_plan() p
  WHERE p.action IN ('delete', 'mixed', 'optional') AND p.tbl <> ALL (ord) AND p.tbl <> ALL (cascaded) AND p.tbl <> ALL (ident_tbls);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: tables without a place in the delete order of data_reset_core: %', bad; END IF;
  SELECT string_agg(DISTINCT k, ', ' ORDER BY k) INTO bad FROM (
    SELECT d.register_key AS k FROM public.register_definitions d UNION SELECT rr.register_key FROM public.register_records rr
    UNION SELECT s.register_key FROM public.document_slots s WHERE s.register_key IS NOT NULL) x
  WHERE k <> 'contractors' AND public.data_reset_register_part(k) IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: register keys without a part (classify them in data_reset_register_part): %', bad; END IF;
  SELECT string_agg(p.tbl, ', ' ORDER BY p.tbl) INTO bad FROM public.data_reset_plan() p
  WHERE NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'SELECT')
     OR (p.action IN ('delete', 'mixed') AND NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'DELETE'))
     OR (p.action IN ('keep', 'log', 'optional') AND NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'UPDATE'))
     OR (p.action = 'optional' AND p.part = 'staff' AND NOT has_table_privilege('pmis_reset_owner', 'public.' || quote_ident(p.tbl), 'DELETE'))
     OR (p.action = 'optional' AND p.part = 'roles' AND NOT has_table_privilege('pmis_identity_owner', 'public.' || quote_ident(p.tbl), 'DELETE'))
     OR (p.action = 'optional' AND p.part = 'users' AND NOT has_table_privilege('pmis_identity_owner', 'public.' || quote_ident(p.tbl), 'UPDATE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: the reset role has no right on (grant it in the migration that classified them): %', bad; END IF;
  SELECT string_agg(c.relname || '.' || tg.tgname, ', ') INTO bad FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
  WHERE c.relnamespace = 'public'::regnamespace AND NOT tg.tgisinternal AND tg.tgenabled <> 'O'
    AND c.relname IN (SELECT p.tbl FROM public.data_reset_plan() p);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a trigger is disabled, nothing was reset: %', bad; END IF;

  -- 2. Locks: no other session writes any table of the plan until the end of the transaction (plain reads go on): EXCLUSIVE on the tables that may lose
  -- rows (an optional table only when its part is chosen), SHARE on every other one. Then the marker of this transaction.
  IF p_execute THEN
    FOR r IN SELECT p.tbl, p.action, p.part FROM public.data_reset_plan() p ORDER BY p.tbl LOOP
      EXECUTE format('LOCK TABLE public.%I IN %s MODE', r.tbl,
        CASE WHEN r.action IN ('delete', 'mixed') OR (r.action = 'optional' AND r.part = ANY (scope)) THEN 'EXCLUSIVE' ELSE 'SHARE' END);
    END LOOP;
    INSERT INTO public.data_reset_marker (txid) VALUES (txid_current());
  END IF;

  -- 3. The parts of the shared rows, computed once before anything is deleted
  CREATE TEMP TABLE reset_keep_users ON COMMIT DROP AS SELECT DISTINCT x AS id FROM unnest(coalesce(p_keep_users, '{}'::uuid[])) x WHERE x IS NOT NULL;
  -- Register entities: the Contractors register (companies, teams, contracts) and the vehicles of the Car Dispatcher are master data (kept, parts {});
  -- every other entity belongs to the part of its register.
  CREATE TEMP TABLE reset_ent ON COMMIT DROP AS
    SELECT rr.entity_id, bool_or(rr.register_key = 'contractors' OR (rr.register_key = 'car_dispatcher' AND rr.record_type = 'vehicle')) AS kept,
           CASE WHEN bool_or(rr.register_key = 'contractors' OR (rr.register_key = 'car_dispatcher' AND rr.record_type = 'vehicle')) THEN '{}'::text[]
                ELSE array_agg(DISTINCT coalesce(public.data_reset_register_part(rr.register_key), 'sites')) END AS parts
    FROM public.register_records rr GROUP BY rr.entity_id;
  ALTER TABLE pg_temp.reset_ent ADD PRIMARY KEY (entity_id);
  CREATE TEMP TABLE reset_rec ON COMMIT DROP AS
    SELECT rr.id, rr.entity_id, e.parts FROM public.register_records rr JOIN pg_temp.reset_ent e ON e.entity_id = rr.entity_id;
  ALTER TABLE pg_temp.reset_rec ADD PRIMARY KEY (id);
  -- Document slots: a slot of a register record goes with that record and with the documents part; a slot of a task or a site with the documents part;
  -- the slots of kept records (company and team documents) stay.
  CREATE TEMP TABLE reset_slot ON COMMIT DROP AS
    SELECT s.id, CASE WHEN s.register_entity_id IS NULL THEN ARRAY['documents']
                      WHEN e.kept THEN '{}'::text[]
                      ELSE coalesce(e.parts, ARRAY[coalesce(public.data_reset_register_part(s.register_key), 'sites')]) || ARRAY['documents'] END AS parts
    FROM public.document_slots s LEFT JOIN pg_temp.reset_ent e ON e.entity_id = s.register_entity_id;
  ALTER TABLE pg_temp.reset_slot ADD PRIMARY KEY (id);
  -- Comments: on a task with the sites part, on a record with its record (kept records keep theirs).
  CREATE TEMP TABLE reset_comment ON COMMIT DROP AS
    SELECT c.id, CASE WHEN c.task_id IS NOT NULL THEN ARRAY['sites']
                      WHEN c.entity_type = 'register_record' THEN coalesce(e.parts, rc.parts, ARRAY['sites'])
                      ELSE ARRAY['sites'] END AS parts
    FROM public.comments c LEFT JOIN pg_temp.reset_ent e ON e.entity_id = c.entity_id LEFT JOIN pg_temp.reset_rec rc ON rc.id = c.entity_id;
  ALTER TABLE pg_temp.reset_comment ADD PRIMARY KEY (id);
  -- Import batches: a batch that nothing points at belongs to the imports part; a batch that rows point at (tasks, site drafts directly or through its rows,
  -- register records) goes only with them: with their part when they are of one part, with the sites part when of several (the sites part takes every
  -- project part along); a batch a kept record points at stays.
  CREATE TEMP TABLE reset_batch ON COMMIT DROP AS
    WITH refs AS (
      SELECT ti.historical_batch_id AS b, 'sites'::text AS p, false AS k FROM public.task_instances ti WHERE ti.historical_batch_id IS NOT NULL
      UNION ALL SELECT ti.admin_approve_batch_id, 'sites', false FROM public.task_instances ti WHERE ti.admin_approve_batch_id IS NOT NULL
      UNION ALL SELECT ti.historical_direct_batch_id, 'sites', false FROM public.task_instances ti WHERE ti.historical_direct_batch_id IS NOT NULL
      UNION ALL SELECT sd.batch_id, 'sites', false FROM public.site_drafts sd WHERE sd.batch_id IS NOT NULL
      UNION ALL SELECT ibr.batch_id, 'sites', false FROM public.site_drafts sd JOIN public.import_batch_rows ibr ON ibr.id = sd.batch_row_id
      UNION ALL SELECT rr.historical_direct_batch_id, x.p, e.kept
        FROM public.register_records rr JOIN pg_temp.reset_ent e ON e.entity_id = rr.entity_id
        LEFT JOIN LATERAL unnest(CASE WHEN e.kept THEN ARRAY[NULL::text] ELSE e.parts END) x(p) ON true
        WHERE rr.historical_direct_batch_id IS NOT NULL)
    SELECT b.id, CASE WHEN bool_or(coalesce(f.k, false)) THEN '{}'::text[]
                      WHEN count(f.b) = 0 THEN ARRAY['imports']
                      WHEN count(DISTINCT f.p) = 1 THEN array_agg(DISTINCT f.p)
                      ELSE ARRAY['sites'] END AS parts
    FROM public.import_batches b LEFT JOIN refs f ON f.b = b.id GROUP BY b.id;
  ALTER TABLE pg_temp.reset_batch ADD PRIMARY KEY (id);

  -- The plan of this scope: a row is kept when its parts do not overlap the closure.
  CREATE TEMP TABLE reset_plan ON COMMIT DROP AS
    SELECT p.tbl, p.action, p.part, p.parts_expr,
           CASE WHEN p.action IN ('keep', 'log') THEN 'true' ELSE format('NOT ((%s) && %L::text[])', p.parts_expr, scope) END AS keep_where,
           NULL::bigint AS rows_before, NULL::bigint AS kept_before, NULL::bigint AS rows_after, NULL::bigint AS kept_after
    FROM public.data_reset_plan() p;
  ALTER TABLE pg_temp.reset_plan ADD PRIMARY KEY (tbl);

  -- Stored objects of the deleted rows, never one that a kept row still names. They are moved (never deleted) to the quarantine directory.
  CREATE TEMP TABLE reset_files_raw (storage_key text, parts text[], kept boolean) ON COMMIT DROP;
  FOR r IN SELECT p.tbl, p.parts_expr, p.keep_where FROM pg_temp.reset_plan p
           WHERE p.tbl IN ('document_files', 'snag_photos', 'document_export_jobs', 'master_reconciliation_runs') LOOP
    EXECUTE format('INSERT INTO pg_temp.reset_files_raw SELECT t.storage_key, (%s), coalesce((%s), false) FROM public.%I t WHERE t.storage_key IS NOT NULL',
      r.parts_expr, r.keep_where, r.tbl);
  END LOOP;
  CREATE TEMP TABLE reset_files ON COMMIT DROP AS
    SELECT f.storage_key, ARRAY(SELECT DISTINCT x FROM pg_temp.reset_files_raw f2, unnest(f2.parts) x WHERE f2.storage_key = f.storage_key ORDER BY x) AS parts
    FROM (SELECT DISTINCT storage_key FROM pg_temp.reset_files_raw) f
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.reset_files_raw k WHERE k.storage_key = f.storage_key AND k.kept)
      AND f.storage_key NOT IN (SELECT b.storage_key FROM public.document_blank_forms b WHERE b.storage_key IS NOT NULL)
      AND f.storage_key NOT IN (SELECT v.storage_key FROM public.template_versions v WHERE v.storage_key IS NOT NULL);
  ALTER TABLE pg_temp.reset_files ADD PRIMARY KEY (storage_key);

  -- 4. Counts before: total and kept rows of every table, and the rows of each part (a row of several parts counts in each)
  CREATE TEMP TABLE reset_part_rows (code text, tbl text, n bigint) ON COMMIT DROP;
  FOR r IN SELECT p.tbl, p.action, p.parts_expr, p.keep_where FROM pg_temp.reset_plan p ORDER BY p.tbl LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE %s) FROM public.%I t', r.keep_where, r.tbl) INTO total, kept;
    UPDATE pg_temp.reset_plan SET rows_before = total, kept_before = kept WHERE tbl = r.tbl;
    IF r.action NOT IN ('keep', 'log') THEN
      EXECUTE format('INSERT INTO pg_temp.reset_part_rows SELECT x.code, %L, count(*) FROM public.%I t CROSS JOIN LATERAL unnest(%s) AS x(code) GROUP BY x.code',
        r.tbl, r.tbl, r.parts_expr);
    END IF;
  END LOOP;

  IF NOT p_execute THEN
    SELECT jsonb_build_object(
      'scope', sj,
      'plan', (SELECT jsonb_agg(jsonb_build_object('tbl', tbl, 'action', action, 'part', part, 'rows', rows_before, 'delete', rows_before - kept_before, 'keep', kept_before)
                 ORDER BY CASE action WHEN 'delete' THEN 1 WHEN 'mixed' THEN 2 WHEN 'optional' THEN 3 WHEN 'keep' THEN 4 ELSE 5 END, tbl) FROM pg_temp.reset_plan),
      'parts', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'rows', x.n, 'tables', x.tables) ORDER BY x.code), '[]'::jsonb)
                FROM (SELECT code, sum(n) AS n, jsonb_object_agg(tbl, n ORDER BY tbl) AS tables FROM pg_temp.reset_part_rows WHERE n > 0 GROUP BY code) x),
      'files', (SELECT count(*) FROM pg_temp.reset_files)) INTO res;
    DROP TABLE pg_temp.reset_part_rows, pg_temp.reset_files, pg_temp.reset_files_raw, pg_temp.reset_plan, pg_temp.reset_batch, pg_temp.reset_comment,
      pg_temp.reset_slot, pg_temp.reset_rec, pg_temp.reset_ent, pg_temp.reset_keep_users;
    RETURN res;
  END IF;

  -- 5. The deletes, in foreign-key order, each table reduced with the predicate the checks use (any error rolls everything back). The guard triggers let
  -- this role through while the marker names this transaction. Deleting register rows that feed the dates of kept tasks lets the calculation layer
  -- recalculate them (milestones, gate states), as any change of those registers does (audited; see the checks).
  SELECT coalesce(max(id), 0) INTO a_mark FROM public.audit_log;
  FOREACH t IN ARRAY ord LOOP
    IF t = 'site_drafts' THEN
      -- site drafts and import batch rows point at each other (no-action keys, checked at the end of the statement): one statement removes both
      EXECUTE format('WITH d AS (DELETE FROM public.site_drafts t WHERE (%s) IS NOT TRUE RETURNING 1) DELETE FROM public.import_batch_rows t WHERE (%s) IS NOT TRUE',
        (SELECT p.keep_where FROM pg_temp.reset_plan p WHERE p.tbl = 'site_drafts'), (SELECT p.keep_where FROM pg_temp.reset_plan p WHERE p.tbl = 'import_batch_rows'));
    ELSE
      PERFORM public.data_reset_delete_unkept(t);
    END IF;
  END LOOP;
  -- The identity parts, through the identity owner (users are deactivated, assignments, delegations and groups removed).
  IF scope && ARRAY['users', 'roles'] THEN
    ident := public.idm_data_reset_identity(scope, ARRAY(SELECT k.id FROM pg_temp.reset_keep_users k));
  END IF;
  -- What the system itself wrote meanwhile: the milestones of kept tasks recalculated by the calculation layer, and the saved views of a deactivated owner
  -- moved to the direct manager (sv_owner_left, on every deactivation). Anything else in the Audit Log rolls the reset back.
  SELECT string_agg(DISTINCT a.action, ', ') INTO bad FROM public.audit_log a
  WHERE a.id > a_mark AND a.action NOT IN ('milestone_prefill', 'milestone_calculated', 'milestone_recalculated', 'saved_view.owner_left');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: unexpected audit rows during the reset, nothing was reset: %', bad; END IF;
  SELECT count(*) INTO n_side FROM public.audit_log a WHERE a.id > a_mark;
  -- the state the calculation layer keeps for kept sites (gate states, calculated milestone steps, gate events) may grow; no kept row may go
  IF NOT ('sites' = ANY (scope)) THEN exempt := exempt || ARRAY['workflow_steps', 'site_gate_state', 'site_gate_events']; END IF;
  IF 'users' = ANY (scope) THEN exempt := exempt || ARRAY['saved_view_targets', 'saved_view_versions']; END IF;

  -- 6. The checks (before anything is added to the logs)
  FOR r IN SELECT tbl, keep_where FROM pg_temp.reset_plan ORDER BY tbl LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE %s) FROM public.%I t', r.keep_where, r.tbl) INTO total, kept;
    UPDATE pg_temp.reset_plan SET rows_after = total, kept_after = kept WHERE tbl = r.tbl;
  END LOOP;
  SELECT string_agg(format('%s (%s: %s -> %s)', tbl, action, rows_before, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan
  WHERE action IN ('keep', 'log') AND rows_after <> rows_before AND tbl <> ALL (exempt);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a KEEP table changed its row count, nothing was reset: %', bad; END IF;
  -- the users part deactivates (the rows stay): every account it names is deactivated, none added or lost
  SELECT string_agg(format('%s (%s -> %s rows, %s left to deactivate)', tbl, rows_before, rows_after, rows_after - kept_after), ', ') INTO bad FROM pg_temp.reset_plan
  WHERE tbl = 'users' AND (rows_after <> rows_before OR kept_after <> rows_after);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: the users part did not deactivate exactly its accounts, nothing was reset: %', bad; END IF;
  -- every other table that may lose rows holds exactly its kept rows (none lost, none left over); a table the system may add rows to (see above) keeps
  -- every kept row
  SELECT string_agg(format('%s (kept %s -> %s, left %s)', tbl, kept_before, kept_after, rows_after), ', ' ORDER BY tbl) INTO bad FROM pg_temp.reset_plan
  WHERE action IN ('delete', 'mixed', 'optional') AND tbl <> 'users'
    AND (CASE WHEN tbl = ANY (exempt) THEN kept_after < kept_before ELSE kept_after <> kept_before END OR rows_after <> kept_after);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'reset-project-data: a table lost a kept row or kept a row of the scope, nothing was reset: %', bad; END IF;

  -- 7. End every session but the kept one (each end is written to the security log by its own trigger), then the one audit row
  CREATE TEMP TABLE reset_sessions ON COMMIT DROP AS
    SELECT id FROM public.user_sessions WHERE revoked_at IS NULL AND id IS DISTINCT FROM p_keep_session;
  UPDATE public.user_sessions SET revoked_at = now(), revoke_reason = 'project_data_reset', revoked_by = public.app_actor()
  WHERE id IN (SELECT id FROM pg_temp.reset_sessions);
  SELECT count(*) INTO n_sess FROM pg_temp.reset_sessions;

  -- Counts only: no value of any deleted row. The identity parts list the accounts deactivated (id and employee ID: the rows stay). The script acts on the
  -- server with no actor (as the migrations do); a Settings run has its actor.
  SELECT rows_before INTO a_before FROM pg_temp.reset_plan WHERE tbl = 'audit_log';
  SELECT rows_before INTO c_before FROM pg_temp.reset_plan WHERE tbl = 'audit_log_chain';
  SELECT rows_before INTO s_before FROM pg_temp.reset_plan WHERE tbl = 'security_log';
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  SELECT 'project_data_reset', 'system', 'project_data',
    jsonb_build_object('rows', (SELECT jsonb_object_agg(tbl, rows_before ORDER BY tbl) FROM pg_temp.reset_plan WHERE action IN ('delete', 'mixed', 'optional'))),
    jsonb_build_object(
      'scope', sj,
      'deleted', (SELECT jsonb_object_agg(tbl, rows_before - rows_after ORDER BY tbl) FROM pg_temp.reset_plan
                  WHERE action IN ('delete', 'mixed', 'optional') AND tbl <> 'users' AND rows_before > rows_after),
      'kept_in_mixed', (SELECT jsonb_object_agg(tbl, kept_after ORDER BY tbl) FROM pg_temp.reset_plan WHERE action = 'mixed'),
      'keep_tables', (SELECT count(*) FROM pg_temp.reset_plan WHERE action IN ('keep', 'log')),
      'identity', ident,
      'system_rows', n_side,
      'sessions_ended', n_sess,
      'session_kept', p_keep_session,
      'files_quarantined', (SELECT count(*) FROM pg_temp.reset_files)) || coalesce(p_detail, '{}'::jsonb),
    left(btrim(p_reason), 2000), public.app_actor(), false
  RETURNING id INTO aid;

  -- The chain seals (zz_audit_log_seal, zz_security_log_seal) are deferred constraint triggers: run them now, as COMMIT would, so the checks see them.
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO a_after FROM public.audit_log;
  SELECT count(*) INTO c_after FROM public.audit_log_chain;
  SELECT count(*) INTO s_after FROM public.security_log;
  IF a_after <> a_before + n_side + 1 OR c_after <> c_before + n_side + 1 THEN
    RAISE EXCEPTION 'reset-project-data: the audit log should have grown by exactly the reset row and % system rows, sealed (log % -> %, chain % -> %)',
      n_side, a_before, a_after, c_before, c_after;
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
    'scope', sj,
    'plan', (SELECT jsonb_agg(jsonb_build_object('tbl', tbl, 'action', action, 'part', part, 'rows', rows_before, 'delete', rows_before - kept_before, 'keep', kept_before)
               ORDER BY CASE action WHEN 'delete' THEN 1 WHEN 'mixed' THEN 2 WHEN 'optional' THEN 3 WHEN 'keep' THEN 4 ELSE 5 END, tbl) FROM pg_temp.reset_plan),
    'parts', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'rows', x.n, 'tables', x.tables) ORDER BY x.code), '[]'::jsonb)
              FROM (SELECT code, sum(n) AS n, jsonb_object_agg(tbl, n ORDER BY tbl) AS tables FROM pg_temp.reset_part_rows WHERE n > 0 GROUP BY code) x),
    'deleted', (SELECT jsonb_object_agg(tbl, rows_before - rows_after ORDER BY tbl) FROM pg_temp.reset_plan
                WHERE action IN ('delete', 'mixed', 'optional') AND tbl <> 'users' AND rows_before > rows_after),
    'identity', ident,
    'files', (SELECT coalesce(jsonb_agg(storage_key ORDER BY storage_key), '[]'::jsonb) FROM pg_temp.reset_files),
    'audit_id', aid, 'sessions_ended', n_sess) INTO res;
  DELETE FROM public.data_reset_marker WHERE txid = txid_current();
  DROP TABLE pg_temp.reset_part_rows, pg_temp.reset_files, pg_temp.reset_files_raw, pg_temp.reset_plan, pg_temp.reset_batch, pg_temp.reset_comment,
    pg_temp.reset_slot, pg_temp.reset_rec, pg_temp.reset_ent, pg_temp.reset_keep_users, pg_temp.reset_sessions;
  RETURN res;
END $$;

-- The call of 0146 (the operator script without --parts): everything as today.
CREATE OR REPLACE FUNCTION data_reset_core(p_execute boolean, p_reason text, p_detail jsonb, p_keep_session uuid, p_request uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.data_reset_core(p_execute, p_reason, p_detail, p_keep_session, p_request, NULL::text[], NULL::uuid[])
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The request stores its scope; the approval binds to its hash
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE data_reset_requests
  ADD COLUMN requested_parts text[],
  ADD COLUMN scope jsonb,
  ADD COLUMN scope_hash text,
  ADD COLUMN approved_scope_hash text;
-- A request still open when this migration runs was made for everything: it says so (the old guard below still allows it).
UPDATE data_reset_requests SET requested_parts = data_reset_project_parts(), scope = data_reset_scope_json(NULL), scope_hash = data_reset_scope_hash(data_reset_project_parts()),
  approved_scope_hash = CASE WHEN status <> 'requested' THEN data_reset_scope_hash(data_reset_project_parts()) END
WHERE status IN ('requested', 'approved', 'running', 'files_pending');
ALTER TABLE data_reset_requests
  ADD CONSTRAINT data_reset_scope_shape CHECK ((scope IS NULL) = (scope_hash IS NULL) AND (scope IS NULL) = (requested_parts IS NULL)
    AND (scope_hash IS NULL OR scope_hash ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT data_reset_scope_bound CHECK (approved_scope_hash IS NULL OR approved_scope_hash = scope_hash),
  ADD CONSTRAINT data_reset_scope_approved CHECK (scope_hash IS NULL OR status IN ('requested', 'cancelled', 'expired') OR approved_scope_hash IS NOT NULL);

-- The requests and their file lists are evidence: never deleted, a decided file outcome never changes; who asked, why and for which scope never changes,
-- and the approved hash is written once (latest definition 0146; the scope columns are new).
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
       OR NEW.database_name <> OLD.database_name OR OLD.status IN ('completed', 'failed', 'cancelled', 'expired')
       OR NEW.requested_parts IS DISTINCT FROM OLD.requested_parts OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
       OR (OLD.approved_scope_hash IS NOT NULL AND NEW.approved_scope_hash IS DISTINCT FROM OLD.approved_scope_hash) THEN
      RAISE EXCEPTION 'a closed data reset request, or who, why and for which scope it was requested, never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The doors (redefined from 0146 where the scope enters; the others are unchanged)
-- ---------------------------------------------------------------------------------------------------------------------
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
    -- before 0152 a request had no scope: it was everything as it was then
    'scope', coalesce(r.scope, jsonb_build_object('version', 0, 'legacy', true, 'everything', true)), 'scope_hash', r.scope_hash,
    'approved_scope_hash', r.approved_scope_hash,
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

-- The parts of a request body (NULL = everything): 422 with the path /parts for an empty list or an unknown code.
CREATE OR REPLACE FUNCTION data_reset_require_parts(p_parts text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bad text;
BEGIN
  IF p_parts IS NULL THEN RETURN NULL; END IF;
  IF cardinality(p_parts) = 0 OR cardinality(p_parts) > 64 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parts', 'required', 'Choose at least one part (or send no list for everything).')));
  END IF;
  SELECT string_agg(coalesce(x, 'null'), ', ' ORDER BY x) INTO bad FROM unnest(p_parts) x WHERE x IS NULL OR x NOT IN (SELECT p.code FROM public.data_reset_parts() p);
  IF bad IS NOT NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parts', 'unknown_part', format('Unknown part: %s.', bad))));
  END IF;
  RETURN ARRAY(SELECT DISTINCT x FROM unnest(p_parts) x ORDER BY x);
END $$;

-- The plan of a scope for the screen: the tables, the totals, the files and the catalogue of parts with their rows (from one dry run of data_reset_core).
CREATE OR REPLACE FUNCTION data_reset_plan_json(p_parts text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE plan jsonb; err text; sj jsonb := public.data_reset_scope_json(p_parts); c text[] := public.data_reset_closure(p_parts); req text[];
BEGIN
  req := CASE WHEN p_parts IS NULL THEN c ELSE p_parts END;
  IF public.data_reset_maintenance() THEN
    -- while a run is open the plan is not counted (the counts would be of the data being deleted, and a read must not write while the run starts)
    plan := jsonb_build_object('plan', '[]'::jsonb, 'parts', '[]'::jsonb, 'files', 0);
  ELSE
    BEGIN
      plan := public.data_reset_core(false, NULL, NULL, NULL, NULL, p_parts, NULL);
    EXCEPTION WHEN others THEN
      -- a table without a decision (a later migration) or a right missing: the screen says why, and the run is refused (plan_incomplete)
      err := left(SQLERRM, 1000);
      plan := jsonb_build_object('plan', '[]'::jsonb, 'parts', '[]'::jsonb, 'files', 0);
    END;
  END IF;
  RETURN jsonb_build_object(
    'scope', sj,
    'tables', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', e ->> 'tbl', 'action', e ->> 'action', 'part', e ->> 'part', 'rows', (e ->> 'rows')::bigint,
                 'delete', (e ->> 'delete')::bigint, 'keep', (e ->> 'keep')::bigint)), '[]'::jsonb) FROM jsonb_array_elements(plan -> 'plan') e),
    'delete_rows', (SELECT coalesce(sum((e ->> 'delete')::bigint), 0) FROM jsonb_array_elements(plan -> 'plan') e WHERE e ->> 'tbl' <> 'users'),
    'keep_rows', (SELECT coalesce(sum((e ->> 'keep')::bigint), 0) FROM jsonb_array_elements(plan -> 'plan') e),
    'accounts_to_deactivate', coalesce((SELECT (e ->> 'delete')::bigint FROM jsonb_array_elements(plan -> 'plan') e WHERE e ->> 'tbl' = 'users'), 0),
    'files', (plan ->> 'files')::bigint,
    'error', err,
    'parts', (SELECT jsonb_agg(jsonb_build_object('code', p.code, 'group', p.grp, 'kind', p.kind, 'label_en', p.label_en, 'label_ar', p.label_ar,
                'depends_on', to_jsonb(p.depends_on),
                'dependents', to_jsonb(ARRAY(SELECT d.code FROM public.data_reset_parts() d WHERE p.code = ANY (d.depends_on) ORDER BY d.ord)),
                'rows', coalesce((x ->> 'rows')::bigint, 0), 'tables', coalesce(x -> 'tables', '{}'::jsonb),
                'requested', p.code = ANY (req), 'selected', p.code = ANY (c), 'added', p.code = ANY (c) AND NOT (p.code = ANY (req)))
              ORDER BY p.ord)
              FROM public.data_reset_parts() p LEFT JOIN LATERAL (SELECT e AS x FROM jsonb_array_elements(plan -> 'parts') e WHERE e ->> 'code' = p.code) y ON true));
END $$;

-- The screen: the plan of everything with its counts and the catalogue of parts, the backup, the System Admins, the open request and the last closed one.
CREATE OR REPLACE FUNCTION data_reset_state_json() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; plan jsonb; open_r public.data_reset_requests; last_r public.data_reset_requests; admins integer; me uuid;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  me := who.actor;
  PERFORM public.data_reset_expire();
  plan := public.data_reset_plan_json(NULL);
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
    'plan', plan,
    'everything', to_jsonb(public.data_reset_project_parts()),
    'request', CASE WHEN open_r.id IS NULL THEN NULL ELSE public.data_reset_req_json(open_r) END,
    'last_request', CASE WHEN last_r.id IS NULL THEN NULL ELSE public.data_reset_req_json(last_r) END,
    'can', jsonb_build_object(
      'request', open_r.id IS NULL AND admins >= 2,
      'approve', coalesce(open_r.status = 'requested' AND open_r.requested_by <> me AND open_r.expires_at > clock_timestamp(), false),
      'start', coalesce(open_r.status = 'approved' AND me IN (open_r.requested_by, open_r.approved_by) AND open_r.expires_at > clock_timestamp(), false),
      'cancel', coalesce(open_r.status IN ('requested', 'approved') OR public.data_reset_stalled(open_r), false),
      'retry_files', coalesce(open_r.status = 'files_pending' AND NOT public.data_reset_lock_held(), false)));
END $$;

-- The dry run of a chosen scope (the picker): counts per part and per table, the closure and its hash. A System Admin acting without delegation.
CREATE OR REPLACE FUNCTION data_reset_dry_run(p_parts text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parts text[];
BEGIN
  PERFORM public.data_reset_require_admin(false);
  parts := public.data_reset_require_parts(p_parts);
  RETURN public.data_reset_plan_json(parts);
END $$;

-- 1. Request: System Admin, step-up, reason (10+), the typed phrase, the parts (none = everything; the closure is computed here), a second active System Admin,
-- no other open request, no reset running.
DROP FUNCTION IF EXISTS admin_data_reset_request(text, text);
CREATE FUNCTION admin_data_reset_request(p_reason text, p_confirm text, p_parts text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests; plan jsonb; parts text[]; sj jsonb; labels text;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 10);
  PERFORM public.data_reset_require_phrase(p_confirm);
  parts := public.data_reset_require_parts(p_parts);
  IF public.data_reset_admin_count() < 2 THEN
    PERFORM public.data_reset_err(409, 'single_admin', 'A second active System Admin must approve the reset. With one System Admin, the reset is done on the server with the operator script (infra/scripts/reset-project-data.sh).');
  END IF;
  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, 'reset_running', 'A reset is running.'); END IF;
  PERFORM public.data_reset_expire();
  IF EXISTS (SELECT 1 FROM public.data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending')) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'Another data reset request is open. Cancel it or let it finish first.');
  END IF;
  sj := public.data_reset_scope_json(parts);
  plan := public.data_reset_plan_json(parts);
  INSERT INTO public.data_reset_requests (database_name, requested_by, requested_session, request_reason, expires_at, plan_at_request,
                                          requested_parts, scope, scope_hash)
  VALUES (current_database(), who.actor, who.sid, why,
          clock_timestamp() + make_interval(mins => (public.data_reset_cfg() ->> 'request_expiry_minutes')::integer),
          jsonb_build_object('delete_rows', (plan ->> 'delete_rows')::bigint, 'files', (plan ->> 'files')::bigint,
                             'accounts_to_deactivate', (plan ->> 'accounts_to_deactivate')::bigint,
                             'sites', (SELECT (e ->> 'delete')::bigint FROM jsonb_array_elements(plan -> 'tables') e WHERE e ->> 'table' = 'sites'),
                             'parts', (SELECT coalesce(jsonb_object_agg(e ->> 'code', (e ->> 'rows')::bigint), '{}'::jsonb) FROM jsonb_array_elements(plan -> 'parts') e
                                       WHERE (e ->> 'selected')::boolean)),
          ARRAY(SELECT x FROM jsonb_array_elements_text(sj -> 'requested') x), sj, sj ->> 'hash')
  RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_request', r.id, NULL,
    jsonb_build_object('status', r.status, 'expires_at', r.expires_at, 'plan', r.plan_at_request, 'database', r.database_name, 'scope', r.scope), why);
  SELECT string_agg(p.label_en, '; ' ORDER BY p.ord) INTO labels FROM public.data_reset_parts() p WHERE p.code IN (SELECT jsonb_array_elements_text(sj -> 'parts'));
  -- every other active System Admin is told in-app (the inbox is project data: the reset itself may empty it)
  INSERT INTO public.notifications (user_id, kind, title, body, link)
  SELECT DISTINCT gm.user_id, 'data_reset_request', 'A project data reset waits for your approval',
         format('%s asked to reset %s of %s. Reason: %s', (SELECT u.display_name FROM public.users u WHERE u.id = who.actor),
                CASE WHEN (sj ->> 'everything')::boolean AND jsonb_array_length(sj -> 'identity') = 0 THEN 'the project data' ELSE left(labels, 400) END,
                current_database(), left(why, 300)),
         '/admin/settings/data/reset'
  FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
  JOIN public.users u ON u.id = gm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
  WHERE gm.user_id <> who.actor;
  RETURN public.data_reset_req_json(r);
END $$;

-- The scope of a request is still the one it was made for: the closure of its requested parts is the stored one (the dependency map did not change) and
-- the hash matches. Otherwise 409 scope_changed: a changed scope is a new request.
CREATE OR REPLACE FUNCTION data_reset_check_scope(r public.data_reset_requests, p_seen_hash text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c text[];
BEGIN
  IF r.scope_hash IS NULL THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The request was made before the reset had a scope. Cancel it and make a new request.');
  END IF;
  c := public.data_reset_closure(r.requested_parts);
  IF public.data_reset_scope_hash(c) <> r.scope_hash OR to_jsonb(c) <> (r.scope -> 'parts') THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'What the requested parts take along changed since the request (a newer version of the reset). Cancel it and make a new request.');
  END IF;
  IF p_seen_hash IS NOT NULL AND p_seen_hash <> r.scope_hash THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The scope you approve is not the scope of this request. Read the request again.');
  END IF;
  IF r.approved_scope_hash IS NOT NULL AND r.approved_scope_hash <> r.scope_hash THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The approval was given for another scope. Cancel the request and make a new one.');
  END IF;
END $$;

-- 2. Approve: a DIFFERENT System Admin (another user, another session), step-up, reason (10+), the request still open and not expired, the scope the
-- approver saw (p_scope_hash; when sent it must be the request's). The approval binds to the request's scope hash.
DROP FUNCTION IF EXISTS admin_data_reset_approve(uuid, text, integer);
CREATE FUNCTION admin_data_reset_approve(p_id uuid, p_reason text, p_version integer, p_scope_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 10);
  IF p_scope_hash IS NOT NULL AND p_scope_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/scope_hash', 'invalid', 'The scope_hash of the request you read.')));
  END IF;
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
  PERFORM public.data_reset_check_scope(r, p_scope_hash);
  UPDATE public.data_reset_requests SET status = 'approved', version = version + 1, approved_by = who.actor, approved_session = who.sid,
         approved_at = clock_timestamp(), approve_reason = why, approved_scope_hash = r.scope_hash
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_approve', r.id, jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', r.status, 'requested_by', r.requested_by, 'expires_at', r.expires_at, 'scope_hash', r.approved_scope_hash,
                       'scope', r.scope -> 'parts'), why);
  RETURN public.data_reset_req_json(r);
END $$;

-- 4. Start: as in 0146, and the scope still the approved one.
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
  PERFORM public.data_reset_check_scope(r, NULL);
  IF r.approved_scope_hash IS DISTINCT FROM r.scope_hash THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The approval does not cover the scope of this request. Cancel it and make a new request.');
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
    PERFORM public.data_reset_core(false, NULL, NULL, NULL, NULL, r.requested_parts, NULL);
  EXCEPTION WHEN others THEN
    PERFORM public.data_reset_err(409, 'plan_incomplete', SQLERRM);
  END;
  UPDATE public.data_reset_requests SET status = 'running', version = version + 1, run_by = who.actor, run_session = who.sid,
         run_started_at = clock_timestamp(), backup = bk -> 'last_success', quarantine_dir = p_quarantine
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_start', r.id, jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', r.status, 'backup', r.backup, 'requested_by', r.requested_by, 'approved_by', r.approved_by, 'scope_hash', r.scope_hash), r.request_reason);
  RETURN public.data_reset_req_json(r);
END $$;

-- 5. Execute: the reset of the request's scope, in the transaction of the caller (as in 0146). The requester, the approver and the runner are never
-- deactivated by the users part.
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
  PERFORM public.data_reset_check_scope(r, NULL);
  res := public.data_reset_core(true, r.request_reason,
    jsonb_build_object('via', 'settings', 'request_id', r.id, 'requested_by', r.requested_by, 'approved_by', r.approved_by, 'run_by', r.run_by,
                       'approve_reason', r.approve_reason, 'backup', r.backup, 'quarantine_dir', r.quarantine_dir, 'scope_hash', r.scope_hash),
    r.run_session, r.id, r.requested_parts, ARRAY[r.requested_by, r.approved_by, r.run_by]);
  IF res -> 'scope' ->> 'hash' IS DISTINCT FROM r.scope_hash THEN
    RAISE EXCEPTION 'reset-project-data: the scope that ran is not the approved one, nothing was reset';
  END IF;
  INSERT INTO public.data_reset_request_files (request_id, storage_key)
  SELECT r.id, k FROM jsonb_array_elements_text(res -> 'files') k;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.data_reset_requests SET
    status = CASE WHEN n = 0 THEN 'completed' ELSE 'files_pending' END, version = version + 1, db_committed_at = clock_timestamp(),
    finished_at = CASE WHEN n = 0 THEN clock_timestamp() END, files_total = n,
    result = jsonb_build_object('audit_id', res -> 'audit_id', 'sessions_ended', res -> 'sessions_ended', 'deleted', res -> 'deleted',
                                'identity', res -> 'identity', 'scope', res -> 'scope' -> 'parts')
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.sec_log_write('project_data_reset', 'success', who.actor, NULL,
    jsonb_build_object('step', 'completed', 'request_id', r.id, 'audit_id', res -> 'audit_id', 'sessions_ended', res -> 'sessions_ended', 'files', n,
                       'scope_hash', r.scope_hash), '{}'::jsonb);
  RETURN public.data_reset_req_json(r);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT DELETE ON staff_registry, absences TO pmis_reset_owner;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('settings_data_reset_scope_applied', 'workflow', NULL,
        jsonb_build_object('parts', (SELECT jsonb_agg(code ORDER BY ord) FROM data_reset_parts()),
                           'everything', to_jsonb(data_reset_project_parts()),
                           'identity', 'users (deactivate all but the System Admins), roles (assignments, groups, delegations), staff (registry, absences): never in everything',
                           'binding', 'data_reset_requests.scope_hash = approved_scope_hash (CHECK), data_reset_check_scope at approve, start and execute'),
        'Selectable project data reset (migration 0152, contract 0.15.71).');

DO $$
DECLARE f text;
BEGIN
  -- the plan, the core and their helpers: the reset role
  FOREACH f IN ARRAY ARRAY['data_reset_plan()', 'data_reset_core(boolean,text,jsonb,uuid,uuid)', 'data_reset_core(boolean,text,jsonb,uuid,uuid,text[],uuid[])',
                           'data_reset_delete_unkept(text)', 'data_reset_parts()', 'data_reset_project_parts()', 'data_reset_closure(text[])',
                           'data_reset_scope_hash(text[])', 'data_reset_scope_json(text[])', 'data_reset_register_part(text)', 'data_reset_user_kept(uuid)',
                           'data_reset_group_kept(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_reset_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_plan() TO pmis_reset_owner, pmis_definer';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_delete_unkept(text) TO pmis_reset_owner';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_core(boolean,text,jsonb,uuid,uuid) TO pmis_definer';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_core(boolean,text,jsonb,uuid,uuid,text[],uuid[]) TO pmis_definer';
  -- the catalogue and the closure are pure: the doors, the identity owner and the application may read them (the screen shows the same map)
  FOREACH f IN ARRAY ARRAY['data_reset_parts()', 'data_reset_project_parts()', 'data_reset_closure(text[])', 'data_reset_scope_hash(text[])',
                           'data_reset_scope_json(text[])', 'data_reset_register_part(text)'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_reset_owner, pmis_definer, pmis_identity_owner', f);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_user_kept(uuid) TO pmis_reset_owner, pmis_identity_owner';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_group_kept(uuid) TO pmis_reset_owner, pmis_identity_owner';
  -- the identity writes: the identity owner, called only by the reset role
  EXECUTE 'ALTER FUNCTION idm_data_reset_identity(text[],uuid[]) OWNER TO pmis_identity_owner';
  EXECUTE 'REVOKE ALL ON FUNCTION idm_data_reset_identity(text[],uuid[]) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION idm_data_reset_identity(text[],uuid[]) TO pmis_reset_owner';
  -- the doors and their helpers: the definer
  FOREACH f IN ARRAY ARRAY[
    'data_reset_rows_guard()', 'data_reset_req_json(data_reset_requests)', 'data_reset_require_parts(text[])', 'data_reset_plan_json(text[])',
    'data_reset_state_json()', 'data_reset_dry_run(text[])', 'admin_data_reset_request(text,text,text[])', 'data_reset_check_scope(data_reset_requests,text)',
    'admin_data_reset_approve(uuid,text,integer,text)', 'admin_data_reset_start(uuid,text,integer,text)', 'admin_data_reset_execute(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['data_reset_state_json()', 'data_reset_dry_run(text[])', 'admin_data_reset_request(text,text,text[])',
                             'admin_data_reset_approve(uuid,text,integer,text)', 'admin_data_reset_start(uuid,text,integer,text)', 'admin_data_reset_execute(uuid)',
                             'data_reset_parts()', 'data_reset_project_parts()', 'data_reset_closure(text[])'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
