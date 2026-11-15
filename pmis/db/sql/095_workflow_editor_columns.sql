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
  PERFORM public.wfe_freeze_guard();
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

-- 6. The structural freeze (B9) now stops every structural door, as the contract says (0096): replacing the structure of a draft, removing or deactivating a milestone
-- or a gate, moving a task to another milestone, and choosing the closing task. Publishing was already stopped (0090). Light changes and new tasks inside a milestone stay allowed.
CREATE OR REPLACE FUNCTION wfe_freeze_guard() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (public.wf_freeze_state() ->> 'active')::boolean THEN
    PERFORM public.wf_err('freeze_active', jsonb_build_object('detail', 'Structural changes are frozen. A System Admin can lift the freeze.'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_wf_structure_replace(p_version integer, p_etag integer, p_structure jsonb, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; ms jsonb; gs jsonb; mv jsonb; e jsonb; o integer; c text; ex public.stage_definitions%ROWTYPE; gx public.phase_gate_rules%ROWTYPE;
  mcodes text[] := ARRAY[]::text[]; gcodes text[] := ARRAY[]::text[]; act boolean; before_ jsonb; after_ jsonb; errs jsonb; nm_en text; nm_ar text; fm text; tm text; mn integer; mx integer; cond jsonb;
  tid uuid; sid uuid; act_by text;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  PERFORM public.wfe_freeze_guard();
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Structural changes are made in a draft version: copy the published version to a draft first.')); END IF;
  IF jsonb_typeof(p_structure) <> 'object' OR jsonb_typeof(p_structure -> 'milestones') <> 'array' OR jsonb_typeof(p_structure -> 'gates') <> 'array' THEN
    PERFORM public.wfe_err1('/milestones', 'required', 'Send the complete list of milestones and of gates.');
  END IF;
  IF jsonb_array_length(p_structure -> 'milestones') > 60 OR jsonb_array_length(p_structure -> 'gates') > 80 THEN PERFORM public.wfe_err1('/milestones', 'too_many_rows', 'Too many milestones or gates.'); END IF;
  ms := p_structure -> 'milestones';
  gs := p_structure -> 'gates';
  before_ := public.wfe_structure_snapshot(w.id);
  UPDATE public.stage_definitions SET seq = seq + 100000 WHERE workflow_id = w.id;

  FOR e, o IN SELECT x, (n)::integer FROM jsonb_array_elements(ms) WITH ORDINALITY AS t(x, n) LOOP
    c := e ->> 'code';
    IF c IS NULL OR c !~ '^[A-Z][A-Z0-9_-]{0,19}$' THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/code', 'invalid', 'A code of 1 to 20 characters: capital letters, digits, - and _, starting with a letter.'); END IF;
    IF c = ANY (mcodes) THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/code', 'duplicate', 'The milestone ' || c || ' is listed twice.'); END IF;
    mcodes := mcodes || c;
    act := coalesce((e ->> 'is_active')::boolean, true);
    SELECT * INTO ex FROM public.stage_definitions WHERE workflow_id = w.id AND code = c;
    nm_en := CASE WHEN e ? 'name_en' THEN btrim(e ->> 'name_en') WHEN FOUND THEN ex.name_en END;
    nm_ar := CASE WHEN e ? 'name_ar' THEN nullif(btrim(coalesce(e ->> 'name_ar', '')), '') WHEN FOUND THEN ex.name_ar END;
    IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
    IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
    IF ex.id IS NOT NULL THEN
      UPDATE public.stage_definitions SET seq = o, name_en = nm_en, milestone_name = nm_en, name_ar = nm_ar, is_active = act,
             counts_in_project_status = coalesce((e ->> 'counts_in_project_status')::boolean, ex.counts_in_project_status) WHERE id = ex.id;
    ELSE
      INSERT INTO public.stage_definitions (workflow_id, code, seq, name_en, name_ar, milestone_name, counts_in_project_status, approval_levels, is_active)
      VALUES (w.id, c, o, nm_en, nm_ar, nm_en, coalesce((e ->> 'counts_in_project_status')::boolean, true), 2, act);
    END IF;
  END LOOP;
  IF cardinality(mcodes) = 0 THEN PERFORM public.wfe_err1('/milestones', 'required', 'A version needs at least one milestone.'); END IF;
  SELECT string_agg(st.code, ', ' ORDER BY st.code) INTO c FROM public.stage_definitions st WHERE st.workflow_id = w.id AND NOT (st.code = ANY (mcodes));
  IF c IS NOT NULL THEN PERFORM public.wfe_err1('/milestones', 'missing', 'List every milestone of the version (missing: ' || c || '). To remove one, send it with is_active false.'); END IF;

  FOR mv IN SELECT x FROM jsonb_array_elements(coalesce(p_structure -> 'task_moves', '[]'::jsonb)) AS t(x) LOOP
    PERFORM public.wfe_require('task_definitions', 'edit');
    SELECT id INTO tid FROM public.task_definitions WHERE workflow_id = w.id AND code = mv ->> 'task_code';
    IF tid IS NULL THEN PERFORM public.wfe_err1('/task_moves', 'unknown', 'The task ' || coalesce(mv ->> 'task_code', '?') || ' is not a task of this version.'); END IF;
    SELECT id INTO sid FROM public.stage_definitions WHERE workflow_id = w.id AND code = mv ->> 'stage_code' AND is_active;
    IF sid IS NULL THEN PERFORM public.wfe_err1('/task_moves', 'unknown_stage', 'The milestone ' || coalesce(mv ->> 'stage_code', '?') || ' does not exist or is inactive.'); END IF;
    UPDATE public.task_definitions SET stage_id = sid, sort_order = coalesce((SELECT max(sort_order) FROM public.task_definitions WHERE stage_id = sid), 0) + 10,
           reason = btrim(p_reason), changed_by = public.app_actor()
     WHERE id = tid AND stage_id <> sid;
  END LOOP;
  SELECT string_agg(td.code, ', ' ORDER BY td.code) INTO c FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
   WHERE st.workflow_id = w.id AND NOT st.is_active AND td.is_active;
  IF c IS NOT NULL THEN PERFORM public.wfe_err1('/milestones', 'has_active_tasks', 'Active tasks (' || c || ') are in an inactive milestone: move them to another milestone first (task_moves) or deactivate them.'); END IF;

  FOR e, o IN SELECT x, (n)::integer FROM jsonb_array_elements(gs) WITH ORDINALITY AS t(x, n) LOOP
    c := e ->> 'code';
    IF c IS NULL OR c !~ '^[A-Z][A-Z0-9_-]{0,19}$' THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/code', 'invalid', 'A code of 1 to 20 characters: capital letters, digits, - and _, starting with a letter.'); END IF;
    IF c = ANY (gcodes) THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/code', 'duplicate', 'The gate ' || c || ' is listed twice.'); END IF;
    gcodes := gcodes || c;
    act := coalesce((e ->> 'is_active')::boolean, true);
    SELECT * INTO gx FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = c;
    nm_en := CASE WHEN e ? 'name_en' THEN btrim(e ->> 'name_en') WHEN FOUND THEN gx.name_en END;
    nm_ar := CASE WHEN e ? 'name_ar' THEN nullif(btrim(coalesce(e ->> 'name_ar', '')), '') WHEN FOUND THEN gx.name_ar END;
    fm := CASE WHEN e ? 'from_milestone' THEN e ->> 'from_milestone' WHEN FOUND THEN gx.from_code END;
    tm := CASE WHEN e ? 'to_milestone' THEN e ->> 'to_milestone' WHEN FOUND THEN gx.to_code END;
    mn := CASE WHEN e ? 'sla_min_wd' THEN (e ->> 'sla_min_wd')::integer WHEN FOUND THEN gx.min_wd ELSE 0 END;
    mx := CASE WHEN e ? 'sla_max_wd' THEN (e ->> 'sla_max_wd')::integer WHEN FOUND THEN gx.max_wd ELSE 0 END;
    cond := CASE WHEN e ? 'conditions' THEN e -> 'conditions' WHEN FOUND THEN coalesce(gx.conditions, '[]'::jsonb) ELSE '[]'::jsonb END;
    IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
    IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
    IF fm IS NULL OR tm IS NULL OR fm = tm OR NOT (fm = ANY (mcodes)) OR NOT (tm = ANY (mcodes)) THEN
      PERFORM public.wfe_err1('/gates/' || (o - 1) || '/from_milestone', 'invalid', 'A gate sits between two different milestones of the version.');
    END IF;
    IF act AND (NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = fm AND is_active) OR NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = tm AND is_active)) THEN
      PERFORM public.wfe_err1('/gates/' || (o - 1) || '/from_milestone', 'inactive', 'An active gate needs two active milestones.');
    END IF;
    IF mn < 0 OR mx < mn THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/sla_max_wd', 'invalid', 'The maximum working days cannot be below the minimum, and neither can be negative.'); END IF;
    errs := public.wfe_gate_conditions_ok(cond);
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
    IF gx.id IS NOT NULL THEN
      UPDATE public.phase_gate_rules SET seq = o, name_en = nm_en, name_ar = nm_ar, from_code = fm, to_code = tm, conditions = cond, min_wd = mn, max_wd = mx, is_active = act WHERE id = gx.id;
    ELSE
      INSERT INTO public.phase_gate_rules (workflow_id, link_code, seq, name_en, name_ar, from_code, to_code, conditions, min_wd, max_wd, is_active)
      VALUES (w.id, c, o, nm_en, nm_ar, fm, tm, cond, mn, mx, act);
    END IF;
  END LOOP;
  UPDATE public.phase_gate_rules SET is_active = false WHERE workflow_id = w.id AND NOT (link_code = ANY (gcodes)) AND is_active;

  after_ := public.wfe_structure_snapshot(w.id);
  IF after_ = before_ THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.')); END IF;
  PERFORM public.wfe_need_master_confirm(p_confirm);
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_structure_replace', 'workflow_definition', w.version::text, before_ || jsonb_build_object('version', w.version),
    after_ || jsonb_build_object('version', w.version, 'status', w.status), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

CREATE OR REPLACE FUNCTION admin_wf_item_remove(p_version integer, p_etag integer, p_kind text, p_code text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; refs text[]; hard boolean; tid uuid; sid uuid; act text;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_kind NOT IN ('task', 'milestone', 'gate') THEN PERFORM public.wfe_err1('/kind', 'invalid', 'kind is task, milestone or gate.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF p_kind IN ('milestone', 'gate') THEN PERFORM public.wfe_freeze_guard(); END IF;
  IF (p_kind = 'task' AND NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = w.id AND code = p_code))
     OR (p_kind = 'milestone' AND NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_code))
     OR (p_kind = 'gate' AND NOT EXISTS (SELECT 1 FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = p_code)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist in this version.'));
  END IF;
  refs := public.wfe_item_refs(p_kind, w.id, p_code);
  IF w.status <> 'draft' THEN refs := array_append(refs, 'published_version'); END IF;
  hard := cardinality(refs) = 0;
  IF p_kind = 'task' THEN
    SELECT id INTO tid FROM public.task_definitions WHERE workflow_id = w.id AND code = p_code;
    IF hard THEN
      DELETE FROM public.task_predecessors WHERE task_def_id = tid OR predecessor_id = tid;
      DELETE FROM public.task_definitions WHERE id = tid;
    ELSE
      UPDATE public.task_definitions SET is_active = false, reason = btrim(p_reason), changed_by = public.app_actor() WHERE id = tid;
    END IF;
  ELSIF p_kind = 'milestone' THEN
    SELECT id INTO sid FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_code;
    IF hard THEN
      DELETE FROM public.stage_definitions WHERE id = sid;
    ELSE
      IF EXISTS (SELECT 1 FROM public.task_definitions WHERE stage_id = sid AND is_active) THEN
        PERFORM public.wfe_err1('/code', 'has_active_tasks', 'Move or deactivate the active tasks of this milestone first.');
      END IF;
      UPDATE public.stage_definitions SET is_active = false WHERE id = sid;
      UPDATE public.phase_gate_rules SET is_active = false WHERE workflow_id = w.id AND (from_code = p_code OR to_code = p_code);
    END IF;
  ELSE
    IF hard THEN DELETE FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = p_code;
    ELSE UPDATE public.phase_gate_rules SET is_active = false WHERE workflow_id = w.id AND link_code = p_code; END IF;
  END IF;
  act := CASE WHEN hard THEN 'deleted' ELSE 'deactivated' END;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('wf_item_' || act, 'workflow_' || p_kind, p_code, jsonb_build_object('version', w.version), jsonb_build_object('version', w.version, 'outcome', act, 'why', to_jsonb(refs)), p_reason);
  RETURN jsonb_build_object('outcome', act, 'why', to_jsonb(refs), 'version', public.wfe_version_json(w.id));
END $$;

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
      PERFORM public.wfe_freeze_guard();
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

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['wfe_site_dates_changed()', 'wfe_freeze_guard()', 'admin_wf_task_closing(integer,integer,text,boolean,text)', 'admin_wf_structure_replace(integer,integer,jsonb,text,text)',
    'admin_wf_item_remove(integer,integer,text,text,text)', 'admin_wf_task_update(integer,integer,text,jsonb,text,text)'] LOOP
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
