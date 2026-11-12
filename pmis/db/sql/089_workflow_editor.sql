-- 0090: the workflow editor (owner decision 4 of 2026-11-12): task definitions, predecessors, milestones, gates, versions, publishing and site migration, all from
-- the system (Settings > Workflow), with a reason, a step-up (API), the audit and the structural freeze (B9).
--
-- WHY. CLAUDE.md "Task definitions are editable" and "Milestones and phase gates are configurable": the admin adds, renames, reorders and deactivates tasks inside a
-- stage, changes their predecessors, decides whether a task counts toward its stage milestone, edits the light data of milestones and gates, and publishes a new
-- version for structural changes. Until now the tables and the guards existed (0001, 0007, 0008) but nothing could write them except the migration role.
--
-- WHAT THIS ADDS.
--   1. workflow_definitions.parent_version, light_revision and row_version (the ETag of the editor; every write to a version bumps it).
--   2. wf_freeze_state / admin_set_structural_freeze / admin_lift_structural_freeze: the structural freeze of decision B9 (setting workflow.structural_freeze, guarded
--      like the other guarded keys). While it is active a draft cannot be published (409 freeze_active). Light changes and new tasks inside a stage stay allowed.
--   3. The read doors: workflow_versions_json, workflow_version_json, wf_task_definitions_json.
--   4. The write doors (all System Admin or a delegate of workflow.edit / workflow.publish / workflow.migrate for ALL regions, a reason of 3+ characters, audited
--      with before and after):
--        admin_wf_create_draft      copy of a published version (wraps admin_create_workflow_draft of 0008 and records the parent)
--        admin_wf_task_create       a new task inside a stage of a draft or of a published version (B8); code, EN/AR names, counts toward the milestone, predecessors
--        admin_wf_task_update       rename EN/AR, counts toward the milestone, deactivate / reactivate, move to another stage (draft only)
--        admin_wf_task_order        the order of the tasks of one stage
--        admin_wf_task_predecessors replace the predecessors of a task (cycles and foreign versions are refused with the path of the problem)
--        admin_wf_milestone_light   names, counts in Project Status, custom fields (applies at once, also on a published version)
--        admin_wf_gate_light        names, conditions, the gate SLA, custom fields (applies at once, also on a published version)
--        admin_wf_publish           draft -> published, with the validation (workflow_invalid), the freeze (freeze_active) and the Master impact confirmation
--        admin_wf_migration_sites / admin_wf_migration_preview / admin_wf_migrate_sites   the preview (hash) and the migration of open sites; every moved site is logged
--        site_workflow_migrations   the log of the moves (read through wf_site_migrations_json)
--   5. The five definition tables are no longer writable by pmis_app (they were, behind the guard triggers): they change only through the functions above.
--
-- The parallel-run month is the window of the structural freeze (pilot start to the end of the parallel-run month). While it is on, adding a counting task, a light
-- change of a milestone or gate that has a Master column, a publish and a migration need the Master impact confirmation (the phrase "master-impact").
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC; pmis_app gets only the doors.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns and the migration log
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE workflow_definitions
  ADD COLUMN parent_version integer,
  ADD COLUMN light_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN row_version integer NOT NULL DEFAULT 1;
COMMENT ON COLUMN workflow_definitions.parent_version IS '0090: the version this draft was copied from (null for the seeded version)';
COMMENT ON COLUMN workflow_definitions.light_revision IS '0090: number of light changes (names, gate conditions and SLA, counts in Project Status, custom fields) applied to the version';
COMMENT ON COLUMN workflow_definitions.row_version IS '0090: the ETag of the version in the editor; bumped by every write to the version or its tasks, milestones and gates';

CREATE TABLE site_workflow_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id),
  from_version_id uuid NOT NULL REFERENCES workflow_definitions (id),
  to_version_id uuid NOT NULL REFERENCES workflow_definitions (id),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  migrated_by uuid REFERENCES users (id),
  migrated_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reverted_at timestamptz,
  CHECK (from_version_id <> to_version_id)
);
CREATE INDEX site_workflow_migrations_site_idx ON site_workflow_migrations (site_id, migrated_at DESC);
CREATE INDEX site_workflow_migrations_to_idx ON site_workflow_migrations (to_version_id, migrated_at DESC);
COMMENT ON TABLE site_workflow_migrations IS '0090: one row per site moved to another workflow version (admin_wf_migrate_sites). Read only through wf_site_migrations_json (admin, region ceiling).';
ALTER TABLE site_workflow_migrations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON workflow_definitions, stage_definitions, task_definitions, task_predecessors, phase_gate_rules FROM pmis_app;
    REVOKE ALL ON site_workflow_migrations FROM pmis_app;
  END IF;
END $$;

GRANT SELECT ON users, sites, settings, task_instances, baseline_entries TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON site_workflow_migrations TO pmis_definer;
GRANT UPDATE ON workflow_definitions, stage_definitions, task_definitions, phase_gate_rules TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_predecessors TO pmis_definer;
GRANT SELECT, INSERT ON task_definitions TO pmis_definer;
CREATE POLICY site_workflow_migrations_definer ON site_workflow_migrations FOR ALL TO pmis_definer USING (true) WITH CHECK (true);

-- The freeze setting changes only through its functions (the guard function of 0072).
INSERT INTO settings (key, value, description, updated_at)
VALUES ('workflow.structural_freeze', 'null'::jsonb,
        'Decision B9 (0090): the structural freeze window of the workflow {starts_on, ends_on, lifted_at, lifted_by, lift_reason}; null = no window. Changed only through admin_set_structural_freeze / admin_lift_structural_freeze.', now())
ON CONFLICT (key) DO NOTHING;
CREATE TRIGGER b_settings_wf_freeze BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'workflow.structural_freeze') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_wf_freeze_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'workflow.structural_freeze' OR NEW.key = 'workflow.structural_freeze') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_wf_freeze_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'workflow.structural_freeze') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Helpers (internal: no grant to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
-- The right to change the workflow definition. The definition is global: a delegation limited to some regions is not enough.
CREATE OR REPLACE FUNCTION wfe_require(p_module text, p_action "PermissionAction") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_admin(p_module, p_action) THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering %.% required', p_module, p_action USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF public.app_actor_region_filter(p_module, p_action) IS NOT NULL THEN
    RAISE EXCEPTION 'admin path: the workflow definition is global; a delegation for all regions is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Finds and locks a version by its number; the ETag (row_version) is checked when given.
CREATE OR REPLACE FUNCTION wfe_lock(p_version integer, p_etag integer) RETURNS public.workflow_definitions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE;
BEGIN
  SELECT * INTO w FROM public.workflow_definitions WHERE version = p_version FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The workflow version does not exist.')); END IF;
  IF p_etag IS NOT NULL AND p_etag <> w.row_version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The workflow version changed since you read it. Reload and try again.'));
  END IF;
  RETURN w;
END $$;

CREATE OR REPLACE FUNCTION wfe_bump(p_wf uuid, p_light boolean DEFAULT false) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.workflow_definitions SET row_version = row_version + 1, light_revision = light_revision + CASE WHEN p_light THEN 1 ELSE 0 END WHERE id = p_wf
$$;

CREATE OR REPLACE FUNCTION wfe_audit(p_action text, p_entity text, p_id text, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.log_audit_write(p_action, p_entity, p_id, p_before, p_after, btrim(p_reason));
END $$;

CREATE OR REPLACE FUNCTION wfe_err1(p_path text, p_code text, p_msg text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(p_path, p_code, p_msg))); END $$;

CREATE OR REPLACE FUNCTION wfe_user_ref(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN u.id IS NULL THEN NULL
         ELSE jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', nullif(btrim(u.employee_id), '')) END
  FROM (SELECT p_user AS id) k LEFT JOIN public.users u ON u.id = k.id
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The structural freeze (B9)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_freeze_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; s date; e date; lifted boolean; act boolean;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'workflow.structural_freeze';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN
    RETURN jsonb_build_object('active', false, 'starts_on', NULL, 'ends_on', NULL, 'lifted', false, 'lifted_at', NULL, 'lifted_by', NULL, 'lift_reason', NULL,
      'blocked_operations', jsonb_build_array('publishWorkflowVersion'), 'version', public.settings_etag('workflow.structural_freeze'));
  END IF;
  s := nullif(v ->> 'starts_on', '')::date;
  e := nullif(v ->> 'ends_on', '')::date;
  lifted := v ->> 'lifted_at' IS NOT NULL;
  act := s IS NOT NULL AND e IS NOT NULL AND current_date BETWEEN s AND e AND NOT lifted;
  RETURN jsonb_build_object('active', act, 'starts_on', s, 'ends_on', e, 'lifted', lifted, 'lifted_at', v -> 'lifted_at',
    'lifted_by', public.wfe_user_ref(nullif(v ->> 'lifted_by', '')::uuid), 'lift_reason', v -> 'lift_reason',
    'blocked_operations', jsonb_build_array('publishWorkflowVersion'), 'version', public.settings_etag('workflow.structural_freeze'));
END $$;

-- The parallel run is on while today is inside the window, whether or not the freeze was lifted.
CREATE OR REPLACE FUNCTION wfe_parallel_run_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT current_date BETWEEN nullif(value ->> 'starts_on', '')::date AND nullif(value ->> 'ends_on', '')::date
                   FROM public.settings WHERE key = 'workflow.structural_freeze' AND jsonb_typeof(value) = 'object'), false)
$$;

CREATE OR REPLACE FUNCTION wfe_need_master_confirm(p_confirm text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.wfe_parallel_run_active() AND coalesce(p_confirm, '') <> 'master-impact' THEN
    PERFORM public.wf_err('master_impact_unconfirmed', jsonb_build_object('detail',
      'The parallel-run month is on and this change can move Master dates or columns. Confirm the Master impact to continue.', 'confirmation_phrase', 'master-impact'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_set_structural_freeze(p_starts date, p_ends date, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  PERFORM public.calc_require_reason(p_reason);
  IF p_starts IS NULL OR p_ends IS NULL OR p_ends < p_starts THEN
    PERFORM public.wfe_err1('/ends_on', 'invalid', 'The window needs a start date and an end date that is not before it.');
  END IF;
  PERFORM 1 FROM public.settings WHERE key = 'workflow.structural_freeze' FOR UPDATE;
  cur := public.wf_freeze_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  UPDATE public.settings SET value = jsonb_build_object('starts_on', p_starts, 'ends_on', p_ends), updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'workflow.structural_freeze';
  res := public.wf_freeze_state();
  PERFORM public.wfe_audit('structural_freeze_set', 'setting', 'workflow.structural_freeze', cur, res, p_reason);
  RETURN res;
END $$;

-- System Admin only (decision B9): a delegate cannot lift it.
CREATE OR REPLACE FUNCTION admin_lift_structural_freeze(p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; v jsonb;
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'only a System Admin lifts the structural freeze' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  PERFORM 1 FROM public.settings WHERE key = 'workflow.structural_freeze' FOR UPDATE;
  cur := public.wf_freeze_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur ->> 'starts_on' IS NULL OR (cur ->> 'lifted')::boolean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'There is no active freeze to lift.'));
  END IF;
  SELECT value INTO v FROM public.settings WHERE key = 'workflow.structural_freeze';
  UPDATE public.settings SET value = v || jsonb_build_object('lifted_at', clock_timestamp(), 'lifted_by', public.app_actor(), 'lift_reason', btrim(p_reason)),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'workflow.structural_freeze';
  res := public.wf_freeze_state();
  PERFORM public.wfe_audit('structural_freeze_lifted', 'setting', 'workflow.structural_freeze', cur, res, p_reason);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Validation and the JSON of a version
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfe_validation(p_wf uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE probs jsonb := '[]'::jsonb; warns jsonb := '[]'::jsonb; r record; parent integer; pr boolean := public.wfe_parallel_run_active();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = p_wf AND is_active) THEN
    probs := probs || to_jsonb('a workflow version needs at least one active milestone'::text);
  END IF;
  FOR r IN SELECT g.link_code FROM public.phase_gate_rules g
            WHERE g.workflow_id = p_wf AND g.is_active
              AND (NOT EXISTS (SELECT 1 FROM public.stage_definitions s WHERE s.workflow_id = p_wf AND s.code = g.from_code AND s.is_active)
                OR NOT EXISTS (SELECT 1 FROM public.stage_definitions s WHERE s.workflow_id = p_wf AND s.code = g.to_code AND s.is_active)) ORDER BY g.seq LOOP
    probs := probs || to_jsonb('gate ' || r.link_code || ' points at a milestone that does not exist or is inactive in this version');
  END LOOP;
  FOR r IN SELECT td.code AS tcode, st.code AS scode FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
            WHERE td.workflow_id = p_wf AND td.is_active AND NOT st.is_active ORDER BY st.seq, td.sort_order LOOP
    probs := probs || to_jsonb('task ' || r.tcode || ' is active but its milestone ' || r.scode || ' is not');
  END LOOP;
  FOR r IN SELECT td.code AS tcode, pd.code AS pcode FROM public.task_predecessors tp
            JOIN public.task_definitions td ON td.id = tp.task_def_id JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
            WHERE td.workflow_id = p_wf AND td.is_active AND NOT pd.is_active ORDER BY td.code, pd.code LOOP
    probs := probs || to_jsonb('task ' || r.tcode || ' waits for the inactive task ' || r.pcode);
  END LOOP;
  FOR r IN SELECT st.code FROM public.stage_definitions st
            WHERE st.workflow_id = p_wf AND st.is_active
              AND NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.stage_id = st.id AND td.is_active AND td.counts_toward_milestone) ORDER BY st.seq LOOP
    warns := warns || to_jsonb('milestone ' || r.code || ' has no active task that counts toward it');
  END LOOP;
  SELECT parent_version INTO parent FROM public.workflow_definitions WHERE id = p_wf;
  IF parent IS NOT NULL THEN
    FOR r IN SELECT td.code FROM public.task_definitions td
              WHERE td.workflow_id = p_wf AND td.is_active AND td.counts_toward_milestone
                AND NOT EXISTS (SELECT 1 FROM public.task_definitions o JOIN public.workflow_definitions ow ON ow.id = o.workflow_id AND ow.version = parent WHERE o.code = td.code)
              ORDER BY td.code LOOP
      warns := warns || to_jsonb('the new counting task ' || r.code || ' may move its milestone date later than the Master');
    END LOOP;
  END IF;
  RETURN jsonb_build_object('valid', jsonb_array_length(probs) = 0, 'problems', probs, 'warnings', warns,
    'master_impact', jsonb_build_object('affected_columns', '[]'::jsonb, 'parallel_run_active', pr, 'confirmation_phrase', CASE WHEN pr THEN 'master-impact' END));
END $$;

CREATE OR REPLACE FUNCTION wfe_summary_json(w public.workflow_definitions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'version', w.version, 'status', w.status::text, 'is_current', w.id = public.active_workflow_id(), 'light_revision', w.light_revision, 'parent_version', w.parent_version,
    'site_count', (SELECT count(*) FROM public.sites s WHERE s.workflow_version_id = w.id), 'reason', w.reason,
    'published_by', CASE WHEN w.status = 'published' THEN public.wfe_user_ref(w.changed_by) END,
    'published_at', w.published_at, 'version_etag', w.row_version, 'created_at', w.created_at, 'effective_from', w.effective_from)
$$;

CREATE OR REPLACE FUNCTION wfe_version_json(p_wf uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; base integer;
BEGIN
  SELECT * INTO w FROM public.workflow_definitions WHERE id = p_wf;
  SELECT min(version) INTO base FROM public.workflow_definitions;
  RETURN public.wfe_summary_json(w) || jsonb_build_object(
    'can_edit', public.app_actor_is_admin('workflow_versions', 'edit') AND public.app_actor_region_filter('workflow_versions', 'edit') IS NULL,
    'can_publish', public.app_actor_is_admin('workflow_versions', 'administer') AND public.app_actor_region_filter('workflow_versions', 'administer') IS NULL,
    'milestones', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'code', s.code, 'seq', s.seq, 'name_en', s.name_en, 'name_ar', s.name_ar, 'is_active', s.is_active,
        'formula_kind', CASE WHEN EXISTS (SELECT 1 FROM public.stage_definitions b JOIN public.workflow_definitions bw ON bw.id = b.workflow_id AND bw.version = base WHERE b.code = s.code) THEN 'master' ELSE 'generic' END,
        'counts_in_project_status', s.counts_in_project_status, 'master_export_column', s.master_export_column, 'custom', s.custom) ORDER BY s.seq)
      FROM public.stage_definitions s WHERE s.workflow_id = p_wf), '[]'::jsonb),
    'gates', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'code', g.link_code, 'seq', g.seq, 'from_milestone', g.from_code, 'to_milestone', g.to_code, 'name_en', g.name_en, 'name_ar', g.name_ar, 'is_active', g.is_active,
        'conditions', CASE WHEN jsonb_typeof(g.conditions) = 'array' THEN g.conditions ELSE '[]'::jsonb END,
        'sla_min_wd', g.min_wd, 'sla_max_wd', g.max_wd, 'master_export_column', g.master_export_column, 'custom', g.custom) ORDER BY g.seq)
      FROM public.phase_gate_rules g WHERE g.workflow_id = p_wf), '[]'::jsonb),
    'placements', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'task_code', td.code, 'stage_code', st.code, 'sort_order', td.sort_order, 'name_en', td.name_en, 'name_ar', td.name_ar, 'is_active', td.is_active,
        'is_milestone_task', td.is_milestone_task, 'has_documents', td.has_documents, 'counts_toward_milestone', td.counts_toward_milestone, 'task_version', td.version,
        'predecessors', coalesce((SELECT jsonb_agg(pd.code ORDER BY pd.code) FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
                                  WHERE tp.task_def_id = td.id), '[]'::jsonb)) ORDER BY st.seq, td.sort_order, td.code)
      FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id WHERE td.workflow_id = p_wf), '[]'::jsonb),
    'validation', public.wfe_validation(p_wf));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Read doors (any signed-in user: the definition is configuration that every screen already shows)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workflow_versions_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN coalesce((SELECT jsonb_agg(public.wfe_summary_json(w) ORDER BY w.version DESC) FROM public.workflow_definitions w), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION workflow_version_json(p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w uuid;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT id INTO w FROM public.workflow_definitions WHERE version = p_version;
  IF w IS NULL THEN RETURN NULL; END IF;
  RETURN public.wfe_version_json(w);
END $$;

-- GET /settings/task-definitions: the tasks of a version (default: the current one) with their placement.
CREATE OR REPLACE FUNCTION wf_task_definitions_json(p_version integer, p_include_inactive boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w uuid;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_version IS NULL THEN w := public.active_workflow_id(); ELSE SELECT id INTO w FROM public.workflow_definitions WHERE version = p_version; END IF;
  IF w IS NULL THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', td.id, 'code', td.code, 'name_en', td.name_en, 'name_ar', td.name_ar, 'stage_code', st.code, 'sort_order', td.sort_order,
      'predecessors', coalesce((SELECT jsonb_agg(pd.code ORDER BY pd.code) FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
                                 WHERE tp.task_def_id = td.id), '[]'::jsonb),
      'has_documents', td.has_documents, 'is_milestone_task', td.is_milestone_task, 'counts_toward_milestone', td.counts_toward_milestone,
      'approval_levels', td.approval_levels, 'condition_rule', td.condition_rule, 'default_external_party', td.default_external_party::text,
      'is_active', td.is_active, 'version', td.version) ORDER BY st.seq, td.sort_order, td.code)
    FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
    WHERE td.workflow_id = w AND (p_include_inactive OR td.is_active)), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Write doors
-- ---------------------------------------------------------------------------------------------------------------------
-- A copy of a published version, for structural changes.
CREATE OR REPLACE FUNCTION admin_wf_create_draft(p_parent integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; nid uuid;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'create');
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO w FROM public.workflow_definitions WHERE version = p_parent;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The parent version does not exist.')); END IF;
  IF w.status <> 'published' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a published version can be copied to a draft.')); END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_definitions WHERE status = 'draft') THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A draft exists already: publish it or ask a System Admin to discard it before starting another.'));
  END IF;
  nid := public.admin_create_workflow_draft(w.id, p_reason);
  UPDATE public.workflow_definitions SET parent_version = p_parent WHERE id = nid;
  RETURN public.wfe_version_json(nid);
END $$;

-- A new task inside a stage (decision B8). Allowed on a draft and on a published version.
CREATE OR REPLACE FUNCTION admin_wf_task_create(p_version integer, p_etag integer, p_stage text, p_code text, p_name_en text, p_name_ar text, p_counts boolean,
  p_has_documents boolean, p_after text, p_preds text[], p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; st public.stage_definitions%ROWTYPE; nid uuid := gen_random_uuid(); so integer; a public.task_definitions%ROWTYPE;
  pc text; pid uuid; warns jsonb := '[]'::jsonb; counts boolean := coalesce(p_counts, true);
BEGIN
  PERFORM public.wfe_require('task_definitions', 'create');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  IF p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_-]{0,19}$' THEN PERFORM public.wfe_err1('/code', 'invalid', 'A code of 1 to 20 characters: capital letters, digits, - and _, starting with a letter.'); END IF;
  IF char_length(btrim(coalesce(p_name_en, ''))) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
  IF p_name_ar IS NOT NULL AND char_length(p_name_ar) > 200 THEN PERFORM public.wfe_err1('/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
  SELECT * INTO st FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_stage;
  IF NOT FOUND THEN PERFORM public.wfe_err1('/stage_code', 'unknown', 'This milestone does not exist in the version.'); END IF;
  IF NOT st.is_active THEN PERFORM public.wfe_err1('/stage_code', 'inactive', 'This milestone is inactive.'); END IF;
  IF EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = w.id AND code = p_code) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A task with this code exists already in the version (codes are never reused).'));
  END IF;
  IF counts AND w.status = 'published' THEN
    PERFORM public.wfe_need_master_confirm(p_confirm);
    warns := warns || to_jsonb('counting_task_may_move_milestone'::text);
  END IF;
  IF p_after IS NOT NULL THEN
    SELECT * INTO a FROM public.task_definitions WHERE workflow_id = w.id AND code = p_after AND stage_id = st.id;
    IF NOT FOUND THEN PERFORM public.wfe_err1('/after_task_code', 'unknown', 'The task to place it after is not in this milestone.'); END IF;
    so := a.sort_order;
  ELSE
    SELECT coalesce(max(sort_order), 0) + 10 INTO so FROM public.task_definitions WHERE stage_id = st.id;
  END IF;
  INSERT INTO public.task_definitions (id, workflow_id, code, stage_id, sort_order, name_en, name_ar, has_documents, is_milestone_task, counts_toward_milestone, is_active, reason, changed_by)
  VALUES (nid, w.id, p_code, st.id, so, btrim(p_name_en), nullif(btrim(coalesce(p_name_ar, '')), ''), coalesce(p_has_documents, true), false, counts, true, btrim(p_reason), public.app_actor());
  IF p_after IS NOT NULL THEN
    -- renumber the stage so that the new task follows the one it was placed after
    WITH o AS (SELECT id, row_number() OVER (ORDER BY sort_order, CASE WHEN id = nid THEN 1 ELSE 0 END, code) AS n FROM public.task_definitions WHERE stage_id = st.id)
    UPDATE public.task_definitions t SET sort_order = o.n * 10 FROM o WHERE t.id = o.id AND t.sort_order <> o.n * 10;
  END IF;
  FOREACH pc IN ARRAY coalesce(p_preds, ARRAY[]::text[]) LOOP
    SELECT id INTO pid FROM public.task_definitions WHERE workflow_id = w.id AND code = pc;
    IF pid IS NULL THEN PERFORM public.wfe_err1('/predecessors', 'unknown', 'The predecessor ' || pc || ' is not a task of this version.'); END IF;
    INSERT INTO public.task_predecessors (task_def_id, predecessor_id) VALUES (nid, pid) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_create', 'task_definition', p_code, NULL,
    jsonb_build_object('version', w.version, 'status', w.status, 'stage', p_stage, 'name_en', btrim(p_name_en), 'name_ar', p_name_ar, 'counts_toward_milestone', counts,
                       'has_documents', coalesce(p_has_documents, true), 'predecessors', to_jsonb(coalesce(p_preds, ARRAY[]::text[]))), p_reason);
  RETURN jsonb_build_object('task_id', nid, 'task_code', p_code, 'warnings', warns, 'version', public.wfe_version_json(w.id));
END $$;

-- Rename EN/AR, counts toward the milestone, deactivate or reactivate, move to another stage (draft only). p_patch carries only the keys to change.
CREATE OR REPLACE FUNCTION admin_wf_task_update(p_version integer, p_etag integer, p_task text, p_patch jsonb, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; st public.stage_definitions%ROWTYPE; before_ jsonb; nm_en text; nm_ar text; ct boolean; act boolean; sid uuid;
  dep text;
BEGIN
  PERFORM public.wfe_require('task_definitions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  before_ := jsonb_build_object('name_en', t.name_en, 'name_ar', t.name_ar, 'counts_toward_milestone', t.counts_toward_milestone, 'is_active', t.is_active, 'stage_id', t.stage_id);
  nm_en := CASE WHEN p_patch ? 'name_en' THEN btrim(p_patch ->> 'name_en') ELSE t.name_en END;
  nm_ar := CASE WHEN p_patch ? 'name_ar' THEN nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') ELSE t.name_ar END;
  ct := CASE WHEN p_patch ? 'counts_toward_milestone' THEN (p_patch ->> 'counts_toward_milestone')::boolean ELSE t.counts_toward_milestone END;
  act := CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::boolean ELSE t.is_active END;
  sid := t.stage_id;
  IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
  IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
  IF p_patch ? 'stage_code' THEN
    SELECT * INTO st FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_patch ->> 'stage_code';
    IF NOT FOUND THEN PERFORM public.wfe_err1('/stage_code', 'unknown', 'This milestone does not exist in the version.'); END IF;
    IF st.id <> t.stage_id THEN
      IF w.status = 'published' THEN PERFORM public.wfe_err1('/stage_code', 'structural', 'Moving a task to another milestone is a structural change: do it in a draft version.'); END IF;
      sid := st.id;
    END IF;
  END IF;
  IF ct IS DISTINCT FROM t.counts_toward_milestone AND ct AND w.status = 'published' THEN PERFORM public.wfe_need_master_confirm(p_confirm); END IF;
  IF NOT act AND t.is_active THEN
    SELECT string_agg(x.code, ', ' ORDER BY x.code) INTO dep FROM public.task_predecessors tp JOIN public.task_definitions x ON x.id = tp.task_def_id
     WHERE tp.predecessor_id = t.id AND x.is_active;
    IF dep IS NOT NULL THEN PERFORM public.wfe_err1('/is_active', 'has_dependents', 'Active tasks still wait for this task: ' || dep || '. Change their predecessors first.'); END IF;
    IF t.is_milestone_task AND w.status = 'published' THEN PERFORM public.wfe_err1('/is_active', 'milestone_task', 'A milestone task cannot be deactivated on a published version.'); END IF;
  END IF;
  IF (nm_en, nm_ar, ct, act, sid) IS NOT DISTINCT FROM (t.name_en, t.name_ar, t.counts_toward_milestone, t.is_active, t.stage_id) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  UPDATE public.task_definitions SET name_en = nm_en, name_ar = nm_ar, counts_toward_milestone = ct, is_active = act, stage_id = sid,
         sort_order = CASE WHEN sid <> t.stage_id THEN coalesce((SELECT max(sort_order) FROM public.task_definitions WHERE stage_id = sid), 0) + 10 ELSE sort_order END,
         reason = btrim(p_reason), changed_by = public.app_actor()
   WHERE id = t.id;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_update', 'task_definition', p_task, before_,
    jsonb_build_object('version', w.version, 'status', w.status, 'name_en', nm_en, 'name_ar', nm_ar, 'counts_toward_milestone', ct, 'is_active', act, 'stage_id', sid), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- The order of the tasks of one stage: p_codes must be every task of the stage (active and inactive), once each.
CREATE OR REPLACE FUNCTION admin_wf_task_order(p_version integer, p_etag integer, p_stage text, p_codes text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; st public.stage_definitions%ROWTYPE; cur text[]; before_ jsonb;
BEGIN
  PERFORM public.wfe_require('task_definitions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO st FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_stage;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The milestone does not exist in this version.')); END IF;
  SELECT array_agg(code ORDER BY sort_order, code) INTO cur FROM public.task_definitions WHERE stage_id = st.id;
  cur := coalesce(cur, ARRAY[]::text[]);
  IF p_codes IS NULL OR cardinality(p_codes) <> cardinality(cur) OR (SELECT count(DISTINCT c) FROM unnest(p_codes) c) <> cardinality(p_codes)
     OR NOT (p_codes <@ cur) THEN
    PERFORM public.wfe_err1('/task_codes', 'mismatch', 'List every task of the milestone exactly once.');
  END IF;
  IF p_codes = cur THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The order does not change.')); END IF;
  before_ := jsonb_build_object('stage', p_stage, 'order', to_jsonb(cur));
  UPDATE public.task_definitions t SET sort_order = o.n * 10, reason = btrim(p_reason), changed_by = public.app_actor()
    FROM (SELECT c, n FROM unnest(p_codes) WITH ORDINALITY AS u(c, n)) o
   WHERE t.stage_id = st.id AND t.code = o.c AND t.sort_order <> o.n * 10;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_order', 'stage_definition', p_stage, before_, jsonb_build_object('version', w.version, 'stage', p_stage, 'order', to_jsonb(p_codes)), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- Replaces the predecessors of a task. A cycle or a foreign task is refused as a field error on /predecessors.
CREATE OR REPLACE FUNCTION admin_wf_task_predecessors(p_version integer, p_etag integer, p_task text, p_codes text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; pc text; pid uuid; before_ text[]; seen text[] := ARRAY[]::text[]; pact boolean;
BEGIN
  PERFORM public.wfe_require('task_definitions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  SELECT coalesce(array_agg(p.code ORDER BY p.code), ARRAY[]::text[]) INTO before_
    FROM public.task_predecessors tp JOIN public.task_definitions p ON p.id = tp.predecessor_id WHERE tp.task_def_id = t.id;
  FOREACH pc IN ARRAY coalesce(p_codes, ARRAY[]::text[]) LOOP
    IF pc = p_task THEN PERFORM public.wfe_err1('/predecessors', 'self', 'A task cannot wait for itself.'); END IF;
    IF pc = ANY (seen) THEN PERFORM public.wfe_err1('/predecessors', 'duplicate', 'The predecessor ' || pc || ' is listed twice.'); END IF;
    seen := seen || pc;
    SELECT id, is_active INTO pid, pact FROM public.task_definitions WHERE workflow_id = w.id AND code = pc;
    IF pid IS NULL THEN PERFORM public.wfe_err1('/predecessors', 'unknown', 'The predecessor ' || pc || ' is not a task of this version.'); END IF;
    IF t.is_active AND NOT pact THEN PERFORM public.wfe_err1('/predecessors', 'inactive', 'The predecessor ' || pc || ' is inactive.'); END IF;
  END LOOP;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(seen) x) IS NOT DISTINCT FROM (CASE WHEN cardinality(before_) = 0 THEN NULL ELSE before_ END) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The predecessors do not change.'));
  END IF;
  BEGIN
    DELETE FROM public.task_predecessors WHERE task_def_id = t.id;
    FOREACH pc IN ARRAY seen LOOP
      INSERT INTO public.task_predecessors (task_def_id, predecessor_id) SELECT t.id, id FROM public.task_definitions WHERE workflow_id = w.id AND code = pc;
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE '%cycle%' THEN
      PERFORM public.wfe_err1('/predecessors', 'cycle', 'These predecessors would create a cycle: a task cannot, directly or through others, wait for a task that waits for it.');
    END IF;
    RAISE;
  END;
  UPDATE public.task_definitions SET reason = btrim(p_reason), changed_by = public.app_actor(), changed_at = now() WHERE id = t.id AND (reason IS DISTINCT FROM btrim(p_reason));
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_predecessors', 'task_definition', p_task, jsonb_build_object('predecessors', to_jsonb(before_)),
    jsonb_build_object('version', w.version, 'status', w.status, 'predecessors', (SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) FROM unnest(seen) x)), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- Light change of a milestone: names, counts in Project Status, custom fields. Applies at once, on a draft and on a published version.
CREATE OR REPLACE FUNCTION admin_wf_milestone_light(p_version integer, p_etag integer, p_code text, p_patch jsonb, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; s public.stage_definitions%ROWTYPE; before_ jsonb; nm_en text; nm_ar text; cps boolean; cu jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO s FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_code;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The milestone does not exist in this version.')); END IF;
  before_ := jsonb_build_object('name_en', s.name_en, 'name_ar', s.name_ar, 'counts_in_project_status', s.counts_in_project_status, 'custom', s.custom);
  nm_en := CASE WHEN p_patch ? 'name_en' THEN btrim(p_patch ->> 'name_en') ELSE s.name_en END;
  nm_ar := CASE WHEN p_patch ? 'name_ar' THEN nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') ELSE s.name_ar END;
  cps := CASE WHEN p_patch ? 'counts_in_project_status' THEN (p_patch ->> 'counts_in_project_status')::boolean ELSE s.counts_in_project_status END;
  cu := CASE WHEN p_patch ? 'custom' THEN s.custom || coalesce(p_patch -> 'custom', '{}'::jsonb) ELSE s.custom END;
  IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
  IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
  IF (nm_en, nm_ar, cps, cu) IS NOT DISTINCT FROM (s.name_en, s.name_ar, s.counts_in_project_status, s.custom) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  IF s.master_export_column IS NOT NULL THEN PERFORM public.wfe_need_master_confirm(p_confirm); END IF;
  UPDATE public.stage_definitions SET name_en = nm_en, milestone_name = nm_en, name_ar = nm_ar, counts_in_project_status = cps, custom = cu WHERE id = s.id;
  PERFORM public.wfe_bump(w.id, true);
  PERFORM public.wfe_audit('workflow_milestone_light', 'stage_definition', p_code, before_,
    jsonb_build_object('version', w.version, 'status', w.status, 'name_en', nm_en, 'name_ar', nm_ar, 'counts_in_project_status', cps, 'custom', cu), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- The conditions of a gate: an array of {type, ref, accept_na}; type is one of milestone, task, permit, date_field, stop_work_blocks.
CREATE OR REPLACE FUNCTION wfe_gate_conditions_ok(p_conditions jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; i integer := 0; errs jsonb := '[]'::jsonb; k text;
BEGIN
  IF jsonb_typeof(p_conditions) <> 'array' THEN RETURN public.reg_err_item('/conditions', 'invalid', 'A list of conditions.'); END IF;
  IF jsonb_array_length(p_conditions) > 30 THEN RETURN public.reg_err_item('/conditions', 'too_many', 'At most 30 conditions.'); END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
    IF jsonb_typeof(c) <> 'object' OR coalesce(c ->> 'type', '') NOT IN ('milestone', 'task', 'permit', 'date_field', 'stop_work_blocks') THEN
      errs := errs || public.reg_err_item('/conditions/' || i, 'invalid_type', 'The type is milestone, task, permit, date_field or stop_work_blocks.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(c) LOOP
        IF k NOT IN ('type', 'ref', 'accept_na') THEN errs := errs || public.reg_err_item('/conditions/' || i || '/' || k, 'unknown_field', 'Unknown field.'); END IF;
      END LOOP;
      IF c ->> 'type' <> 'stop_work_blocks' AND char_length(btrim(coalesce(c ->> 'ref', ''))) = 0 THEN
        errs := errs || public.reg_err_item('/conditions/' || i || '/ref', 'required', 'A reference is required.');
      END IF;
      IF c ? 'accept_na' AND jsonb_typeof(c -> 'accept_na') <> 'boolean' THEN errs := errs || public.reg_err_item('/conditions/' || i || '/accept_na', 'invalid', 'true or false.'); END IF;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN errs;
END $$;

-- Light change of a gate: names, conditions, the gate SLA, custom fields. Applies at once, on a draft and on a published version.
CREATE OR REPLACE FUNCTION admin_wf_gate_light(p_version integer, p_etag integer, p_code text, p_patch jsonb, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; g public.phase_gate_rules%ROWTYPE; before_ jsonb; nm_en text; nm_ar text; cond jsonb; mn integer; mx integer; cu jsonb; errs jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO g FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = p_code;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The gate does not exist in this version.')); END IF;
  before_ := jsonb_build_object('name_en', g.name_en, 'name_ar', g.name_ar, 'conditions', g.conditions, 'sla_min_wd', g.min_wd, 'sla_max_wd', g.max_wd, 'custom', g.custom);
  nm_en := CASE WHEN p_patch ? 'name_en' THEN btrim(p_patch ->> 'name_en') ELSE g.name_en END;
  nm_ar := CASE WHEN p_patch ? 'name_ar' THEN nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') ELSE g.name_ar END;
  cond := CASE WHEN p_patch ? 'conditions' THEN p_patch -> 'conditions' ELSE g.conditions END;
  mn := CASE WHEN p_patch ? 'sla_min_wd' THEN (p_patch ->> 'sla_min_wd')::integer ELSE g.min_wd END;
  mx := CASE WHEN p_patch ? 'sla_max_wd' THEN (p_patch ->> 'sla_max_wd')::integer ELSE g.max_wd END;
  cu := CASE WHEN p_patch ? 'custom' THEN g.custom || coalesce(p_patch -> 'custom', '{}'::jsonb) ELSE g.custom END;
  IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
  IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
  IF mn < 0 OR mx < mn THEN PERFORM public.wfe_err1('/sla_max_wd', 'invalid', 'The maximum working days cannot be below the minimum, and neither can be negative.'); END IF;
  IF p_patch ? 'conditions' THEN
    errs := public.wfe_gate_conditions_ok(cond);
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;
  IF (nm_en, nm_ar, cond, mn, mx, cu) IS NOT DISTINCT FROM (g.name_en, g.name_ar, g.conditions, g.min_wd, g.max_wd, g.custom) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  IF g.master_export_column IS NOT NULL THEN PERFORM public.wfe_need_master_confirm(p_confirm); END IF;
  UPDATE public.phase_gate_rules SET name_en = nm_en, name_ar = nm_ar, conditions = cond, min_wd = mn, max_wd = mx, custom = cu WHERE id = g.id;
  PERFORM public.wfe_bump(w.id, true);
  PERFORM public.wfe_audit('workflow_gate_light', 'phase_gate_rule', p_code, before_,
    jsonb_build_object('version', w.version, 'status', w.status, 'name_en', nm_en, 'name_ar', nm_ar, 'conditions', cond, 'sla_min_wd', mn, 'sla_max_wd', mx, 'custom', cu), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- Draft -> published. New sites use it from now on; sites never change version silently (the migration is separate).
CREATE OR REPLACE FUNCTION admin_wf_publish(p_version integer, p_etag integer, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; v jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a draft can be published.')); END IF;
  IF (public.wf_freeze_state() ->> 'active')::boolean THEN
    PERFORM public.wf_err('freeze_active', jsonb_build_object('detail', 'Structural changes are frozen from the pilot start to the end of the parallel-run month. A System Admin can lift the freeze.'));
  END IF;
  v := public.wfe_validation(w.id);
  IF NOT (v ->> 'valid')::boolean THEN PERFORM public.wf_err('workflow_invalid', jsonb_build_object('detail', 'The version cannot be published.', 'problems', v -> 'problems')); END IF;
  PERFORM public.wfe_need_master_confirm(p_confirm);
  UPDATE public.workflow_definitions SET status = 'published', reason = btrim(p_reason), changed_by = public.app_actor(), effective_from = current_date,
         published_at = now(), row_version = row_version + 1
   WHERE id = w.id;
  PERFORM public.wfe_audit('workflow_publish', 'workflow_definition', w.version::text, jsonb_build_object('status', 'draft', 'parent_version', w.parent_version),
    jsonb_build_object('status', 'published', 'version', w.version, 'parent_version', w.parent_version, 'warnings', v -> 'warnings'), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Site migration: selection, preview (with a hash) and the move, with a log
-- ---------------------------------------------------------------------------------------------------------------------
-- p_sel: {site_ids: [...]} or {filter: {region_id: [...], from_version: n, overall_status: [...]}}. Only sites on another version, inside the actor's regions.
CREATE OR REPLACE FUNCTION admin_wf_migration_sites(p_sel jsonb, p_target integer) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t uuid; rf int[]; ids uuid[]; f jsonb := coalesce(p_sel -> 'filter', '{}'::jsonb);
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  SELECT id INTO t FROM public.workflow_definitions WHERE version = p_target AND status = 'published';
  IF t IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The target version must be published.')); END IF;
  rf := public.app_actor_region_filter('workflow_versions', 'administer');
  IF p_sel ? 'site_ids' THEN
    SELECT array_agg(s.id) INTO ids FROM public.sites s WHERE s.id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(p_sel -> 'site_ids') x)
      AND s.workflow_version_id <> t AND (rf IS NULL OR s.region_id = ANY (rf));
  ELSE
    SELECT array_agg(s.id) INTO ids FROM public.sites s
     WHERE s.workflow_version_id <> t AND (rf IS NULL OR s.region_id = ANY (rf))
       AND (NOT f ? 'region_id' OR s.region_id IN (SELECT (x)::int FROM jsonb_array_elements_text(f -> 'region_id') x))
       AND (NOT f ? 'from_version' OR s.workflow_version_id IN (SELECT id FROM public.workflow_definitions WHERE version = (f ->> 'from_version')::integer))
       AND (CASE WHEN f ? 'overall_status' THEN s.overall_status::text IN (SELECT x FROM jsonb_array_elements_text(f -> 'overall_status') x)
                 ELSE s.is_active AND s.overall_status IN ('not_started', 'in_progress', 'on_hold') END);
  END IF;
  IF coalesce(cardinality(ids), 0) > 1000 THEN PERFORM public.wfe_err1('/selection', 'too_many_rows', 'At most 1000 sites at a time.'); END IF;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END $$;

CREATE OR REPLACE FUNCTION admin_wf_migration_preview(p_sites uuid[], p_target integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t uuid; rows_ jsonb; sites_ jsonb; h text; mi jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  SELECT id INTO t FROM public.workflow_definitions WHERE version = p_target AND status = 'published';
  IF t IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The target version must be published.')); END IF;
  IF coalesce(cardinality(p_sites), 0) = 0 THEN
    RETURN jsonb_build_object('preview_hash', encode(sha256(convert_to('empty|' || p_target, 'UTF8')), 'hex'), 'to_version', p_target, 'sites', '[]'::jsonb,
      'master_impact', (public.wfe_validation(t) -> 'master_impact'));
  END IF;
  WITH plan AS (SELECT * FROM public.admin_workflow_migration_plan(p_sites, t)),
  per AS (
    SELECT s.id AS site_id, s.site_code, wd.version AS from_version,
      coalesce(jsonb_agg(p.task_code ORDER BY p.task_code) FILTER (WHERE p.change = 'remap' AND p.detail NOT LIKE '%stage %'), '[]'::jsonb) AS kept,
      coalesce(jsonb_agg(p.task_code ORDER BY p.task_code) FILTER (WHERE p.change = 'keep_completed'), '[]'::jsonb) AS kept_done,
      coalesce(jsonb_agg(p.task_code ORDER BY p.task_code) FILTER (WHERE p.change = 'remap' AND p.detail LIKE '%stage %'), '[]'::jsonb) AS moved,
      coalesce(jsonb_agg(p.task_code ORDER BY p.task_code) FILTER (WHERE p.change = 'add_locked'), '[]'::jsonb) AS added,
      coalesce(jsonb_agg(p.task_code ORDER BY p.task_code) FILTER (WHERE p.change = 'mark_na'), '[]'::jsonb) AS retired,
      coalesce(jsonb_agg(p.task_code ORDER BY p.task_code) FILTER (WHERE p.change = 'baseline_orphan'), '[]'::jsonb) AS orphans
    FROM public.sites s JOIN public.workflow_definitions wd ON wd.id = s.workflow_version_id
    LEFT JOIN plan p ON p.site_code = s.site_code
    WHERE s.id = ANY (p_sites) AND s.workflow_version_id <> t
    GROUP BY s.id, s.site_code, wd.version)
  SELECT coalesce(jsonb_agg(jsonb_build_object('site_id', site_id, 'site_code', site_code, 'from_version', from_version, 'migratable', true, 'blockers', '[]'::jsonb,
           'tasks_kept', kept || kept_done, 'tasks_moved', moved, 'tasks_added', added, 'tasks_retired', retired, 'baseline_orphans', orphans, 'date_changes', '[]'::jsonb)
           ORDER BY site_code), '[]'::jsonb)
    INTO sites_ FROM per;
  h := encode(sha256(convert_to(p_target::text || '|' || sites_::text, 'UTF8')), 'hex');
  mi := public.wfe_validation(t) -> 'master_impact';
  RETURN jsonb_build_object('preview_hash', h, 'to_version', p_target, 'master_impact', mi, 'sites', sites_);
END $$;

CREATE OR REPLACE FUNCTION admin_wf_migrate_sites(p_sites uuid[], p_target integer, p_hash text, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t uuid; pv jsonb; n integer; before_ jsonb; mid uuid := gen_random_uuid();
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  PERFORM public.calc_require_reason(p_reason);
  SELECT id INTO t FROM public.workflow_definitions WHERE version = p_target AND status = 'published';
  IF t IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The target version must be published.')); END IF;
  pv := public.admin_wf_migration_preview(p_sites, p_target);
  IF p_hash IS DISTINCT FROM pv ->> 'preview_hash' THEN
    PERFORM public.wf_err('stale_preview', jsonb_build_object('detail', 'The sites or the definition changed since the preview. Preview again.'));
  END IF;
  IF jsonb_array_length(pv -> 'sites') = 0 THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'No selected site needs this version.')); END IF;
  PERFORM public.wfe_need_master_confirm(p_confirm);
  CREATE TEMP TABLE _wf_mig_from ON COMMIT DROP AS
    SELECT s.id AS site_id, s.workflow_version_id AS from_id FROM public.sites s WHERE s.id IN (SELECT (x ->> 'site_id')::uuid FROM jsonb_array_elements(pv -> 'sites') x);
  n := public.admin_migrate_sites_to_workflow(ARRAY(SELECT site_id FROM _wf_mig_from), t, p_reason);
  INSERT INTO public.site_workflow_migrations (id, site_id, from_version_id, to_version_id, reason, migrated_by, summary)
  SELECT gen_random_uuid(), f.site_id, f.from_id, t, btrim(p_reason), public.app_actor(),
         (SELECT x - 'site_id' - 'site_code' - 'from_version' - 'migratable' - 'blockers' FROM jsonb_array_elements(pv -> 'sites') x WHERE (x ->> 'site_id')::uuid = f.site_id)
    FROM _wf_mig_from f JOIN public.sites s ON s.id = f.site_id AND s.workflow_version_id = t;
  RETURN jsonb_build_object('id', mid, 'sites_migrated', n, 'to_version', p_target);
END $$;

CREATE OR REPLACE FUNCTION wf_site_migrations_json(p_site uuid, p_to_version integer, p_limit integer, p_offset integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE rf int[]; tot integer; items jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  rf := public.app_actor_region_filter('workflow_versions', 'administer');
  SELECT count(*) INTO tot FROM public.site_workflow_migrations m JOIN public.sites s ON s.id = m.site_id JOIN public.workflow_definitions tv ON tv.id = m.to_version_id
   WHERE (p_site IS NULL OR m.site_id = p_site) AND (p_to_version IS NULL OR tv.version = p_to_version) AND (rf IS NULL OR s.region_id = ANY (rf));
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'migrated_at') DESC, x ->> 'id'), '[]'::jsonb) INTO items FROM (
    SELECT jsonb_build_object('id', m.id, 'site_id', m.site_id, 'site_code', s.site_code, 'from_version', fv.version, 'to_version', tv.version, 'reason', m.reason,
             'migrated_by', public.wfe_user_ref(m.migrated_by), 'migrated_at', m.migrated_at, 'date_changes', '[]'::jsonb, 'reverted_at', m.reverted_at, 'revertible', false) AS x
      FROM public.site_workflow_migrations m JOIN public.sites s ON s.id = m.site_id
      JOIN public.workflow_definitions fv ON fv.id = m.from_version_id JOIN public.workflow_definitions tv ON tv.id = m.to_version_id
     WHERE (p_site IS NULL OR m.site_id = p_site) AND (p_to_version IS NULL OR tv.version = p_to_version) AND (rf IS NULL OR s.region_id = ANY (rf))
     ORDER BY m.migrated_at DESC, m.id LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0))) q;
  RETURN jsonb_build_object('items', items, 'total', tot);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights. pmis_app gets the doors only; the helpers and the preview pieces stay internal.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'wfe_require(text,"PermissionAction")', 'wfe_lock(integer,integer)', 'wfe_bump(uuid,boolean)', 'wfe_audit(text,text,text,jsonb,jsonb,text)', 'wfe_err1(text,text,text)',
    'wfe_user_ref(uuid)', 'wf_freeze_state()', 'wfe_parallel_run_active()', 'wfe_need_master_confirm(text)', 'admin_set_structural_freeze(date,date,text,integer)',
    'admin_lift_structural_freeze(text,integer)', 'wfe_validation(uuid)', 'wfe_summary_json(workflow_definitions)', 'wfe_version_json(uuid)', 'workflow_versions_json()',
    'workflow_version_json(integer)', 'wf_task_definitions_json(integer,boolean)', 'admin_wf_create_draft(integer,text)',
    'admin_wf_task_create(integer,integer,text,text,text,text,boolean,boolean,text,text[],text,text)', 'admin_wf_task_update(integer,integer,text,jsonb,text,text)',
    'admin_wf_task_order(integer,integer,text,text[],text)', 'admin_wf_task_predecessors(integer,integer,text,text[],text)',
    'admin_wf_milestone_light(integer,integer,text,jsonb,text,text)', 'wfe_gate_conditions_ok(jsonb)', 'admin_wf_gate_light(integer,integer,text,jsonb,text,text)',
    'admin_wf_publish(integer,integer,text,text)', 'admin_wf_migration_sites(jsonb,integer)', 'admin_wf_migration_preview(uuid[],integer)',
    'admin_wf_migrate_sites(uuid[],integer,text,text,text)', 'wf_site_migrations_json(uuid,integer,integer,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'wf_freeze_state()', 'admin_set_structural_freeze(date,date,text,integer)', 'admin_lift_structural_freeze(text,integer)', 'workflow_versions_json()', 'workflow_version_json(integer)',
      'wf_task_definitions_json(integer,boolean)', 'admin_wf_create_draft(integer,text)', 'admin_wf_task_create(integer,integer,text,text,text,text,boolean,boolean,text,text[],text,text)',
      'admin_wf_task_update(integer,integer,text,jsonb,text,text)', 'admin_wf_task_order(integer,integer,text,text[],text)', 'admin_wf_task_predecessors(integer,integer,text,text[],text)',
      'admin_wf_milestone_light(integer,integer,text,jsonb,text,text)', 'admin_wf_gate_light(integer,integer,text,jsonb,text,text)', 'admin_wf_publish(integer,integer,text,text)',
      'admin_wf_migration_sites(jsonb,integer)', 'admin_wf_migration_preview(uuid[],integer)', 'admin_wf_migrate_sites(uuid[],integer,text,text,text)',
      'wf_site_migrations_json(uuid,integer,integer,integer)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('workflow_editor_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner decision 4 of 2026-11-12: the workflow editor', 'functions', 'admin_wf_*', 'freeze', 'workflow.structural_freeze (B9)'),
        'Migration 0090: task definitions, predecessors, milestones, gates, versions and site migration are edited in the system.');
