-- 0096: the three-column workflow editor (owner request 2026-11-14): the closing task of a milestone and the date_field gate condition, end to end.
--
-- WHY. (1) The gate condition type `date_field` was accepted by the editor (0090) but gate_eval answered "condition type not supported", so a gate with such a
-- condition stayed blocked for ever. (2) The task that closes a milestone (task_definitions.is_milestone_task) was immutable: a new milestone could never get one.
--
-- WHAT THIS ADDS.
--   1. wfe_gate_date_value / wfe_gate_date_na: the date a `date_field` condition reads on a site. ref is task:<CODE>.<actual_start|actual_date|planned_date|baseline_date>,
--      site.<rf_survey_date|acquisition_date> or site.custom.<code> (a date custom field).
--   2. wfe_gate_conditions_ok: `date_field` conditions are checked (ref shape, offset_wd integer between -365 and 365 working days, accept_na); other types unchanged.
--   3. gate_eval (0052) handles `date_field`: the gate date is the later of its other conditions and ref + offset_wd working days (calendar of the project); a date that
--      is not set holds the gate (blocked, reason condition_not_met); accept_na lets a task that is N/A or skipped pass.
--   4. A trigger on sites refreshes the calculated dates when a date a gate reads changes (custom, rf_survey_date, acquisition_date).
--   5. admin_wf_task_closing: sets (or clears) the closing task of a milestone in a DRAFT version, one closing task per milestone, with the same checks as the other
--      admin_wf_* doors (System Admin or an all-regions delegate of task_definitions.edit, reason, ETag, audit) and the structural freeze (409 freeze_active).
--      task_definitions_guard lets the flag change only while that door runs (session flag pmis.wfe_closing).
-- Function rules: SECURITY DEFINER where it writes, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC.

SELECT set_config('app.region_ids', '*', true);

-- 1. The date a condition reads
CREATE OR REPLACE FUNCTION wfe_gate_date_value(p_site uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; code_ text; fld text; v text; d date;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND OR p_ref IS NULL THEN RETURN NULL; END IF;
  IF p_ref LIKE 'task:%' THEN
    code_ := split_part(substr(p_ref, 6), '.', 1);
    fld := split_part(substr(p_ref, 6), '.', 2);
    SELECT CASE fld WHEN 'actual_start' THEN ti.actual_start WHEN 'actual_date' THEN ti.actual_date WHEN 'planned_date' THEN ti.planned_date WHEN 'baseline_date' THEN ti.baseline_date END
      INTO d
      FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
     WHERE ti.site_id = p_site AND td.code = code_ AND td.workflow_id = s.workflow_version_id;
    RETURN d;
  ELSIF p_ref = 'site.rf_survey_date' THEN RETURN s.rf_survey_date;
  ELSIF p_ref = 'site.acquisition_date' THEN RETURN s.acquisition_date;
  ELSIF p_ref LIKE 'site.custom.%' THEN
    v := s.custom ->> substr(p_ref, 13);
    IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN v::date; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION wfe_gate_date_na(p_site uuid, p_ref text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_ref LIKE 'task:%' AND EXISTS (
    SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.sites s ON s.id = ti.site_id
     WHERE ti.site_id = p_site AND td.code = split_part(substr(p_ref, 6), '.', 1) AND td.workflow_id = s.workflow_version_id AND (ti.state IN ('na', 'skipped') OR ti.is_na))
$$;

-- 2. The conditions of a gate (0090 plus date_field and offset_wd)
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
        IF k NOT IN ('type', 'ref', 'accept_na', 'offset_wd') THEN errs := errs || public.reg_err_item('/conditions/' || i || '/' || k, 'unknown_field', 'Unknown field.'); END IF;
      END LOOP;
      IF c ->> 'type' <> 'stop_work_blocks' AND char_length(btrim(coalesce(c ->> 'ref', ''))) = 0 THEN
        errs := errs || public.reg_err_item('/conditions/' || i || '/ref', 'required', 'A reference is required.');
      END IF;
      IF c ? 'accept_na' AND jsonb_typeof(c -> 'accept_na') <> 'boolean' THEN errs := errs || public.reg_err_item('/conditions/' || i || '/accept_na', 'invalid', 'true or false.'); END IF;
      IF c ->> 'type' = 'date_field' THEN
        IF coalesce(c ->> 'ref', '') !~ '^(task:[A-Za-z0-9_-]{1,40}\.(actual_start|actual_date|planned_date|baseline_date)|site\.(rf_survey_date|acquisition_date)|site\.custom\.[a-z][a-z0-9_]{0,59})$' THEN
          errs := errs || public.reg_err_item('/conditions/' || i || '/ref', 'invalid_ref', 'A date: task:<code>.<actual_start|actual_date|planned_date|baseline_date>, site.rf_survey_date, site.acquisition_date or site.custom.<code>.');
        END IF;
        IF c ? 'offset_wd' AND (jsonb_typeof(c -> 'offset_wd') <> 'number' OR (c ->> 'offset_wd') !~ '^-?[0-9]{1,3}$' OR abs((c ->> 'offset_wd')::integer) > 365) THEN
          errs := errs || public.reg_err_item('/conditions/' || i || '/offset_wd', 'invalid', 'A whole number of working days between -365 and 365.');
        END IF;
      ELSIF c ? 'offset_wd' THEN
        errs := errs || public.reg_err_item('/conditions/' || i || '/offset_wd', 'unknown_field', 'The offset applies to date_field conditions only.');
      END IF;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN errs;
END $$;

-- 3. gate_eval: as 0052 plus the date_field condition
CREATE OR REPLACE FUNCTION gate_eval(p_site uuid, p_gate text, OUT status text, OUT gate_date date, OUT base_date date, OUT shifted boolean, OUT reasons jsonb)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; g public.phase_gate_rules%ROWTYPE; m record; cond jsonb; g0 date; d date; nd date; i integer; rs jsonb; blocked boolean;
  ptype text; best date; b date; w record; k integer;
BEGIN
  reasons := '[]'::jsonb; shifted := false;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN status := 'na'; RETURN; END IF;
  SELECT * INTO g FROM public.phase_gate_rules WHERE workflow_id = s.workflow_version_id AND link_code = p_gate AND is_active;
  IF NOT FOUND THEN status := 'na'; RETURN; END IF;
  SELECT * INTO m FROM public.ms_resolve(p_site, g.from_code);
  IF m.state = 'na' THEN status := 'na'; RETURN; END IF;
  IF m.state = 'pending' THEN
    status := 'pending';
    reasons := jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', coalesce(m.stage_code, g.from_code),
      'message', 'The milestone ' || coalesce(m.stage_code, g.from_code) || ' has no date yet.', 'count', NULL));
    RETURN;
  END IF;
  g0 := m.ms_date; base_date := g0; d := g0;
  FOR i IN 1..20 LOOP
    nd := g0; blocked := false; rs := '[]'::jsonb;
    FOR cond IN SELECT * FROM jsonb_array_elements(coalesce(g.conditions, '[]'::jsonb)) LOOP
      ptype := cond ->> 'ref';
      IF cond ->> 'type' = 'permit' THEN
        IF coalesce((cond ->> 'accept_na')::boolean, true)
           AND EXISTS (SELECT 1 FROM public.permit_records pr WHERE pr.site_id = p_site AND pr.permit_type = ptype AND public.permit_na_ok(pr)) THEN
          CONTINUE;
        END IF;
        SELECT min(public.permit_start(pr)) INTO best FROM public.permit_records pr
        WHERE pr.site_id = p_site AND pr.permit_type = ptype AND public.permit_start(pr) IS NOT NULL
          AND public.permit_valid_on(pr, greatest(d, public.permit_start(pr)));
        IF best IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype,
            'message', ptype || ' must be approved and valid on the gate date.', 'count', NULL));
        ELSE
          nd := greatest(nd, best);
        END IF;
      ELSIF cond ->> 'type' = 'stop_work_blocks' THEN
        IF EXISTS (SELECT 1 FROM public.permit_records pr WHERE pr.site_id = p_site AND pr.permit_type = ptype AND pr.stop_work AND pr.stop_lifted_date IS NULL) THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'stop_work', 'ref_code', ptype, 'message', 'Stop work is active on ' || ptype || '.', 'count', NULL));
        END IF;
      ELSIF cond ->> 'type' = 'milestone' THEN
        SELECT * INTO m FROM public.ms_resolve(p_site, ptype);
        IF m.state = 'approved' THEN nd := greatest(nd, m.ms_date);
        ELSIF m.state = 'pending' THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', ptype, 'message', 'The milestone ' || ptype || ' has no date yet.', 'count', NULL));
        END IF;
      ELSIF cond ->> 'type' = 'task' THEN
        b := public.sla_task_date(p_site, ptype);
        IF b IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', ptype, 'message', 'Task ' || ptype || ' is not approved yet.', 'count', NULL));
        ELSE nd := greatest(nd, b); END IF;
      ELSIF cond ->> 'type' = 'date_field' THEN
        -- 0096: a date of the site (a task date, a site date or a date custom field) plus an offset in working days; a date that is not set yet holds the gate.
        IF coalesce((cond ->> 'accept_na')::boolean, false) AND public.wfe_gate_date_na(p_site, ptype) THEN CONTINUE; END IF;
        b := public.wfe_gate_date_value(p_site, ptype);
        IF b IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype, 'message', 'The date ' || ptype || ' is not set yet.', 'count', NULL));
        ELSE
          nd := greatest(nd, public.cal_add_workdays(b, coalesce((cond ->> 'offset_wd')::integer, 0)));
        END IF;
      ELSE
        blocked := true;
        rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype, 'message', 'The condition type ' || coalesce(cond ->> 'type', '?') || ' is not supported.', 'count', NULL));
      END IF;
    END LOOP;
    EXIT WHEN nd = d;
    d := nd;
  END LOOP;
  reasons := rs;
  IF blocked THEN status := 'blocked'; RETURN; END IF;

  -- Change Control (rules.md section 2.3, Q180): the effective-date windows [suspended_from, resumed_on).
  FOR k IN 1..20 LOOP
    SELECT * INTO w FROM public.cc_suspension_windows(p_site, d) x
    WHERE x.suspended_from <= d AND (x.resumed_on IS NULL OR d < x.resumed_on)
    ORDER BY x.suspended_from DESC LIMIT 1;
    EXIT WHEN NOT FOUND;
    IF w.resumed_on IS NULL THEN
      status := 'blocked';
      reasons := reasons || jsonb_build_array(jsonb_build_object('kind', 'suspension', 'ref_code', NULL, 'message', 'The site is suspended since ' || w.suspended_from::text || ' and has no approved resumption.', 'count', NULL));
      RETURN;
    END IF;
    d := w.resumed_on; shifted := true;
  END LOOP;
  gate_date := d;
  status := 'open';
END $$;

-- 4. A change of a date a gate reads refreshes the calculated dates of the site
CREATE OR REPLACE FUNCTION wfe_site_dates_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('pmis.calc_busy', true) IS DISTINCT FROM '1'
     AND EXISTS (SELECT 1 FROM public.phase_gate_rules g WHERE g.workflow_id = NEW.workflow_version_id AND g.is_active AND g.conditions::text LIKE '%date_field%') THEN
    PERFORM public.calc_refresh_site(NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_wfe_site_dates AFTER UPDATE OF custom, rf_survey_date, acquisition_date ON sites FOR EACH ROW
  WHEN (OLD.custom IS DISTINCT FROM NEW.custom OR OLD.rf_survey_date IS DISTINCT FROM NEW.rf_survey_date OR OLD.acquisition_date IS DISTINCT FROM NEW.acquisition_date)
  EXECUTE FUNCTION wfe_site_dates_changed();

-- 5. The closing task of a milestone
-- Tasks: may be added to a published version; the code and the version never change; the closing flag changes only through admin_wf_task_closing (0096); a task moves
-- between stages only in a draft; deletion only in a draft (published: deactivate); milestone tasks are not deactivated on a published version.
CREATE OR REPLACE FUNCTION task_definitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION 'tasks of a published version are deactivated, not deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.code, NEW.workflow_id) IS DISTINCT FROM (OLD.code, OLD.workflow_id)
     OR (NEW.is_milestone_task IS DISTINCT FROM OLD.is_milestone_task AND coalesce(current_setting('pmis.wfe_closing', true), '') <> '1') THEN
    RAISE EXCEPTION 'task code, version and milestone flag are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF wf_is_published(OLD.workflow_id) THEN
    IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
      RAISE EXCEPTION 'moving a task between stages is structural: change it in a draft version' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.is_milestone_task AND NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'a milestone task cannot be deactivated on a published version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION admin_wf_task_closing(p_version integer, p_etag integer, p_task text, p_closing boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; st public.stage_definitions%ROWTYPE; before_ text;
BEGIN
  PERFORM public.wfe_require('task_definitions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_closing IS NULL THEN PERFORM public.wfe_err1('/closing', 'required', 'closing is true or false.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The closing task is chosen in a draft version: copy the published version to a draft first.')); END IF;
  IF (public.wf_freeze_state() ->> 'active')::boolean THEN
    PERFORM public.wf_err('freeze_active', jsonb_build_object('detail', 'Structural changes are frozen. A System Admin can lift the freeze.'));
  END IF;
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  SELECT * INTO st FROM public.stage_definitions WHERE id = t.stage_id;
  IF p_closing AND NOT t.is_active THEN PERFORM public.wfe_err1('/task_code', 'inactive', 'An inactive task cannot close a milestone.'); END IF;
  SELECT string_agg(code, ',' ORDER BY code) INTO before_ FROM public.task_definitions WHERE stage_id = st.id AND is_milestone_task;
  IF (p_closing AND t.is_milestone_task AND before_ = t.code) OR (NOT p_closing AND NOT t.is_milestone_task) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  PERFORM set_config('pmis.wfe_closing', '1', true);
  IF p_closing THEN
    UPDATE public.task_definitions SET is_milestone_task = false, reason = btrim(p_reason), changed_by = public.app_actor() WHERE stage_id = st.id AND is_milestone_task AND id <> t.id;
  END IF;
  UPDATE public.task_definitions SET is_milestone_task = p_closing, reason = btrim(p_reason), changed_by = public.app_actor() WHERE id = t.id;
  PERFORM set_config('pmis.wfe_closing', '', true);
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_closing', 'task_definition', p_task, jsonb_build_object('version', w.version, 'stage', st.code, 'closing', coalesce(before_, '')),
    jsonb_build_object('version', w.version, 'stage', st.code, 'closing', CASE WHEN p_closing THEN p_task ELSE '' END), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['wfe_site_dates_changed()', 'admin_wf_task_closing(integer,integer,text,boolean,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_wf_task_closing(integer,integer,text,boolean,text) TO pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('workflow_editor_columns_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner request 2026-11-14: three-column workflow editor', 'functions', 'admin_wf_task_closing, gate_eval date_field'),
        'Migration 0096: the closing task of a milestone is editable in a draft; the date_field gate condition works end to end.');
