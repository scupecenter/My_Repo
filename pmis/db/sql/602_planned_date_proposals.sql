-- 0603: planned dates proposed from the predecessors and the working calendars (A4). Mirror: db/sql/602_planned_date_proposals.sql (kept byte-identical).
-- Nothing is stored per task: a proposal is computed on read from what exists (task_predecessors, the SLA rule of the task and its work calendar, the actual or planned
-- dates of the predecessors). A task is proposed a date only when it has at least one predecessor, every predecessor has a date, its SLA rule is known, it has no actual
-- date and it is not closed (approved, na, skipped). The proposed date is the latest predecessor date (actual, else planned, else the proposal of that predecessor when
-- the cascade is on) plus the SLA maximum (or minimum) working days on the calendar of the rule. A slip therefore moves every task downstream of it. Nothing changes
-- until the engineer confirms: plan_apply writes planned_date of the chosen tasks of one site (needs edit on sites in the region), one audit record each.
-- Rules live in the setting plan.rules (enabled, basis max|min, cascade), saved through admin_save_plan_rules (System Admin or admin.settings edit, reason, If-Match).

CREATE OR REPLACE FUNCTION plan_rules_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'enabled', coalesce((v ->> 'enabled')::boolean, true),
    'basis', CASE WHEN v ->> 'basis' IN ('max', 'min') THEN v ->> 'basis' ELSE 'max' END,
    'cascade', coalesce((v ->> 'cascade')::boolean, true),
    'version', coalesce((v ->> 'version')::int, 0),
    'updated_at', (SELECT s.updated_at FROM public.settings s WHERE s.key = 'plan.rules'),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'plan.rules'))
  FROM (SELECT coalesce((SELECT s.value FROM public.settings s WHERE s.key = 'plan.rules'), '{}'::jsonb) AS v) x
$$;

CREATE OR REPLACE FUNCTION admin_save_plan_rules(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; k text; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM 1 FROM public.settings WHERE key = 'plan.rules' FOR UPDATE;
  cur := public.plan_rules_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with enabled, basis and cascade.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('enabled', 'basis', 'cascade') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.'); END IF;
  IF jsonb_typeof(p_config -> 'cascade') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/cascade', 'required', 'true or false.'); END IF;
  IF (p_config ->> 'basis') IS NULL OR (p_config ->> 'basis') NOT IN ('max', 'min') THEN errs := errs || public.reg_err_item('/basis', 'invalid', 'max or min.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := cur - 'updated_at' - 'updated_by';
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('plan.rules', jsonb_build_object('enabled', p_config -> 'enabled', 'basis', p_config -> 'basis', 'cascade', p_config -> 'cascade', 'version', v + 1),
          'A4: how planned dates are proposed from predecessors and work calendars (see migration 0603).', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  after := public.plan_rules_json();
  PERFORM public.log_audit_write('plan_rules_update', 'setting', 'plan.rules', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END $$;

-- The proposals of one site. proposed_date is NULL when no proposal can be made; reason says why (no_predecessor, predecessor_undated, no_rule, has_actual, closed).
-- basis_task_code is the predecessor that decides the start; basis_kind says which date of it was used (actual, planned, proposed).
CREATE OR REPLACE FUNCTION plan_proposals(p_site uuid) RETURNS TABLE (
  task_id uuid, task_code text, state text, planned_date date, proposed_date date, slip_days integer, reason text, basis_task_code text, basis_kind text, working_days integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rules jsonb := public.plan_rules_json(); s public.sites%ROWTYPE; r record; p record; best_date date; best_code text; best_kind text; undated boolean; eff jsonb := '{}'::jsonb; ed date; dd date; wd integer; rule public.sla_rules%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND OR NOT (rules ->> 'enabled')::boolean THEN RETURN; END IF;
  FOR r IN
    WITH RECURSIVE depth AS (
      SELECT td.id, 0 AS d FROM public.task_definitions td WHERE td.workflow_id = s.workflow_version_id
        AND NOT EXISTS (SELECT 1 FROM public.task_predecessors tp WHERE tp.task_def_id = td.id)
      UNION ALL
      SELECT tp.task_def_id, depth.d + 1 FROM public.task_predecessors tp JOIN depth ON depth.id = tp.predecessor_id WHERE depth.d < 60)
    SELECT ti.id AS tid, ti.task_def_id, td.code, ti.state::text AS st, ti.planned_date AS pd, ti.actual_date AS ad, max(depth.d) AS d
    FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN depth ON depth.id = ti.task_def_id
    WHERE ti.site_id = p_site GROUP BY ti.id, ti.task_def_id, td.code, ti.state, ti.planned_date, ti.actual_date
    ORDER BY max(depth.d), td.code
  LOOP
    task_id := r.tid; task_code := r.code; state := r.st; planned_date := r.pd; proposed_date := NULL; slip_days := NULL; reason := NULL; basis_task_code := NULL; basis_kind := NULL; working_days := NULL;
    best_date := NULL; undated := false; best_code := NULL; best_kind := NULL;
    FOR p IN SELECT tp.predecessor_id, pd.code AS pcode, pi.actual_date AS pad, pi.planned_date AS ppd, (eff ->> tp.predecessor_id::text)::date AS peff
             FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
             LEFT JOIN public.task_instances pi ON pi.task_def_id = tp.predecessor_id AND pi.site_id = p_site
             WHERE tp.task_def_id = r.task_def_id AND coalesce(pi.state::text, '') NOT IN ('na', 'skipped') LOOP
      dd := NULL;
      IF p.pad IS NOT NULL THEN dd := p.pad; basis_kind := 'actual';
      ELSIF (rules ->> 'cascade')::boolean AND p.peff IS NOT NULL THEN dd := p.peff; basis_kind := CASE WHEN p.peff IS DISTINCT FROM p.ppd THEN 'proposed' ELSE 'planned' END;
      ELSIF p.ppd IS NOT NULL THEN dd := p.ppd; basis_kind := 'planned'; END IF;
      IF dd IS NULL THEN undated := true;
      ELSIF best_date IS NULL OR dd > best_date THEN best_date := dd; best_code := p.pcode; best_kind := basis_kind; END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.task_predecessors tp WHERE tp.task_def_id = r.task_def_id) THEN reason := 'no_predecessor';
    ELSIF r.ad IS NOT NULL THEN reason := 'has_actual';
    ELSIF r.st IN ('approved', 'na', 'skipped') THEN reason := 'closed';
    ELSIF undated OR best_date IS NULL THEN reason := 'predecessor_undated';
    ELSE
      SELECT * INTO rule FROM public.sla_rules sr WHERE sr.id = public.sla_rule_for(r.task_def_id, s.delivery_scenario, s.region_id, public.cal_today());
      IF NOT FOUND THEN reason := 'no_rule';
      ELSE
        wd := CASE WHEN rules ->> 'basis' = 'min' THEN rule.min_working_days ELSE rule.max_working_days END;
        proposed_date := public.cal_add_workdays(best_date, wd, rule.calendar_id);
        slip_days := CASE WHEN r.pd IS NULL THEN NULL ELSE proposed_date - r.pd END;
        basis_task_code := best_code; basis_kind := best_kind; working_days := wd;
      END IF;
    END IF;
    ed := coalesce(r.ad, proposed_date, r.pd);
    IF ed IS NOT NULL THEN eff := eff || jsonb_build_object(r.task_def_id::text, ed); END IF;
    RETURN NEXT;
  END LOOP;
END $$;

-- The engineer confirms: planned_date of the chosen tasks of one site takes the proposal. Tasks whose proposal no longer exists or equals the planned date are skipped.
CREATE OR REPLACE FUNCTION plan_apply(p_site uuid, p_task_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; r record; before jsonb; n integer := 0; skipped integer := 0; tid uuid;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  PERFORM public.wf_require_grant(s.region_id, 'edit');
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 OR cardinality(p_task_ids) > 500 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/task_ids', 'invalid', 'Choose 1 to 500 tasks of the site.')));
  END IF;
  FOREACH tid IN ARRAY p_task_ids LOOP
    SELECT * INTO r FROM public.plan_proposals(p_site) q WHERE q.task_id = tid;
    IF NOT FOUND OR r.proposed_date IS NULL OR r.proposed_date IS NOT DISTINCT FROM r.planned_date THEN skipped := skipped + 1; CONTINUE; END IF;
    before := public.wf_snap(tid);
    UPDATE public.task_instances SET planned_date = r.proposed_date, version = version + 1, updated_at = now() WHERE id = tid AND site_id = p_site;
    PERFORM public.wf_audit('task_planned_date_proposal_applied', tid, before, public.wf_snap(tid),
      'basis ' || coalesce(r.basis_task_code, '') || ' (' || coalesce(r.basis_kind, '') || ') + ' || coalesce(r.working_days, 0) || ' working days');
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('applied', n, 'skipped', skipped);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['plan_rules_json()', 'admin_save_plan_rules(jsonb,text,integer)', 'plan_proposals(uuid)', 'plan_apply(uuid,uuid[])'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;
