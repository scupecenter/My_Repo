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

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('sla_explicit_choice_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner 2026-11-26: the SLA of a task is an explicit choice (set or no SLA) and every task shows in Settings > SLA', 'functions', 'sla_task_overview, admin_task_sla_none'),
        'Migration 0170: table task_sla_choices, the task overview and the door that records a "no SLA" choice.');
