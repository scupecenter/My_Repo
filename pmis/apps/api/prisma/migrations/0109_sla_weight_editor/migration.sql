-- 0099: SLA and project weight inside the workflow editor (F14, owner request 2026-11-15; contract 0.15.19; CHANGELOG 144).
--
-- WHY. The editor (0090, 0096) shows the SLA of a task read-only with a link to Settings > SLA, and a task has no "counts in project weight" or weight group.
-- The owner wants the SLA and the weight set in the same dialog as the task, gate or milestone, through the same audited doors.
--
-- WHAT THIS ADDS.
--   1. sla_rules: unit (working or calendar days), warning threshold in percent, breach owner role, escalation role, pause while waiting for the client,
--      and an active flag with the reason of a deactivation. A rule is versioned by effective date (0005/0017): a save closes the open row and inserts a
--      new one; a task keeps the rule id it took at opening (sla_rules_frozen forbids changing a used rule's clock fields, not these).
--   2. task_definitions: counts_in_weight, weight_value (percent, 0..100) and weight_group (CW, TE, HOTO...). Weights live in the workflow version, so a
--      draft changes them and publishing copies them with the version.
--   3. wf_weight_totals(workflow): the total of each weight group over the active tasks that count. The editor warns in a draft when a group is not 100;
--      the API refuses to publish while a group is not 100 (a database guard on the publish door is not in this migration; see the PR Open list).
--   4. admin_sla_rule_save, admin_sla_rule_remove (hard delete when no task refers to the rule, else deactivate with a reason) and admin_wf_task_weight.
--   5. admin_wf_create_draft (0090) copies the new columns to a new draft, as it already copies the rules (0008).
--
-- SECURITY. Each door is SECURITY DEFINER, checks app_actor_is_admin through wfe_require (System Admin or a delegation for all regions), needs a reason
-- (calc_require_reason), checks the ETag of the workflow version (wfe_lock) and writes an audit row with before and after values (wfe_audit).
-- The API adds the step-up before calling them.

ALTER TABLE sla_rules
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'working' CHECK (unit IN ('working', 'calendar')),
  ADD COLUMN IF NOT EXISTS warning_pct smallint CHECK (warning_pct IS NULL OR warning_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS breach_owner_role text CHECK (breach_owner_role IS NULL OR length(breach_owner_role) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS escalation_role text CHECK (escalation_role IS NULL OR length(escalation_role) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS pause_on_client_wait boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inactive_reason text;

ALTER TABLE task_definitions
  ADD COLUMN IF NOT EXISTS counts_in_weight boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weight_value numeric(7, 3) NOT NULL DEFAULT 0 CHECK (weight_value >= 0 AND weight_value <= 100),
  ADD COLUMN IF NOT EXISTS weight_group text CHECK (weight_group IS NULL OR weight_group ~ '^[A-Z0-9_-]{1,20}$');

-- Totals of the weight groups of one workflow version. Only active tasks that count, grouped by weight_group.
CREATE OR REPLACE FUNCTION wf_weight_totals(p_wf uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('group', s.g, 'total', s.t, 'tasks', s.n, 'ok', s.t = 100) ORDER BY s.g), '[]'::jsonb)
  FROM (SELECT td.weight_group AS g, sum(td.weight_value) AS t, count(*) AS n
        FROM public.task_definitions td
        WHERE td.workflow_id = p_wf AND td.is_active AND td.counts_in_weight AND td.weight_group IS NOT NULL
        GROUP BY td.weight_group) s
$$;

-- A task's base SLA rule as the editor reads and writes it.
CREATE OR REPLACE FUNCTION wf_sla_rule_json(r public.sla_rules, p_task text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', r.id, 'task_code', p_task, 'min_working_days', r.min_working_days, 'max_working_days', r.max_working_days,
    'start_event', coalesce(r.start_ref, r.start_event), 'unit', r.unit, 'calendar_code', (SELECT c.code FROM public.work_calendars c WHERE c.id = r.calendar_id),
    'warning_pct', r.warning_pct, 'breach_owner_role', r.breach_owner_role, 'escalation_role', r.escalation_role, 'pause_on_client_wait', r.pause_on_client_wait,
    'effective_from', r.effective_from, 'effective_to', r.effective_to, 'is_active', r.is_active, 'inactive_reason', r.inactive_reason)
$$;

-- 4a. Save a task's base SLA rule (no scenario, no region override). Versioned: the open row is closed the day before and a new row starts today.
-- A same-day correction updates the row in place (the audit keeps both values). Only the base rule is written here; overrides stay in Settings > SLA.
CREATE OR REPLACE FUNCTION admin_sla_rule_save(p_version integer, p_etag integer, p_task text, p_payload jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; cur public.sla_rules%ROWTYPE; cal uuid; nr public.sla_rules%ROWTYPE;
  mn integer; mx integer; st text; unit text; wp integer; before_ jsonb := NULL; cal_code text; today date := current_date; found_cur boolean := false;
  owner_r text; esc_r text; pause_w boolean;
BEGIN
  PERFORM public.wfe_require('sla_rules', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN PERFORM public.wfe_err1('/', 'invalid', 'The SLA rule is an object.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  mn := (p_payload ->> 'min_working_days')::integer; mx := (p_payload ->> 'max_working_days')::integer;
  IF mn IS NULL OR mx IS NULL OR mn < 0 OR mx < mn OR mx > 365 THEN PERFORM public.wfe_err1('/max_working_days', 'invalid', 'Use 0 <= min <= max <= 365.'); END IF;
  st := coalesce(p_payload ->> 'start_event', '');
  IF NOT public.sla_start_ref_valid(st, w.id) THEN PERFORM public.wfe_err1('/start_event', 'invalid', 'The start event is not known in this version.'); END IF;
  unit := coalesce(p_payload ->> 'unit', 'working');
  IF unit NOT IN ('working', 'calendar') THEN PERFORM public.wfe_err1('/unit', 'invalid', 'The unit is working or calendar days.'); END IF;
  cal_code := coalesce(p_payload ->> 'calendar_code', 'default');
  SELECT id INTO cal FROM public.work_calendars WHERE code = cal_code;
  IF NOT FOUND THEN PERFORM public.wfe_err1('/calendar_code', 'invalid', 'The calendar does not exist.'); END IF;
  wp := CASE WHEN p_payload ->> 'warning_pct' IS NULL THEN NULL ELSE (p_payload ->> 'warning_pct')::integer END;
  IF wp IS NOT NULL AND (wp < 0 OR wp > 100) THEN PERFORM public.wfe_err1('/warning_pct', 'invalid', 'The warning threshold is 0 to 100 percent.'); END IF;
  owner_r := nullif(btrim(coalesce(p_payload ->> 'breach_owner_role', '')), '');
  esc_r := nullif(btrim(coalesce(p_payload ->> 'escalation_role', '')), '');
  pause_w := coalesce((p_payload ->> 'pause_on_client_wait')::boolean, false);

  SELECT * INTO cur FROM public.sla_rules
    WHERE task_def_id = t.id AND scenario IS NULL AND region_id IS NULL AND is_active AND effective_from <= today AND (effective_to IS NULL OR effective_to > today)
    ORDER BY effective_from DESC LIMIT 1;
  found_cur := FOUND;
  IF found_cur THEN before_ := public.wf_sla_rule_json(cur, p_task); END IF;

  IF found_cur AND cur.effective_from = today AND NOT public.sla_rule_in_use(cur.id) THEN
    -- same-day correction of a row no task has used yet: updated in place
    UPDATE public.sla_rules SET min_working_days = mn, max_working_days = mx, start_event = st, start_ref = st, calendar_id = cal, unit = unit,
      warning_pct = wp, breach_owner_role = owner_r, escalation_role = esc_r, pause_on_client_wait = pause_w,
      reason = btrim(p_reason), changed_by = public.app_actor(), changed_at = now()
      WHERE id = cur.id RETURNING * INTO nr;
  ELSE
    -- a new version: the open row ends the day before today's, the new row starts today (the tasks that took the old row keep it)
    IF found_cur THEN UPDATE public.sla_rules SET effective_to = today WHERE id = cur.id; END IF;
    INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, start_ref, scenario, region_id, calendar_id, effective_from,
      reason, changed_by, unit, warning_pct, breach_owner_role, escalation_role, pause_on_client_wait, is_active)
    VALUES (t.id, mn, mx, st, st, NULL, NULL, cal, today, btrim(p_reason), public.app_actor(), unit, wp, owner_r, esc_r, pause_w, true)
    RETURNING * INTO nr;
  END IF;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('sla_rule_saved', 'sla_rule', p_task, before_, public.wf_sla_rule_json(nr, p_task), p_reason);
  RETURN jsonb_build_object('rule', public.wf_sla_rule_json(nr, p_task), 'weight_totals', public.wf_weight_totals(w.id), 'version', w.version);
END $$;

-- 4b. Remove a task's base SLA rule. Unused (no task refers to it) = deleted for real. Used = deactivated: closed at today and flagged, with the reason.
-- Tasks that already took the rule keep it; a deactivated rule is never picked for a new task.
CREATE OR REPLACE FUNCTION admin_sla_rule_remove(p_version integer, p_etag integer, p_task text, p_rule uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; r public.sla_rules%ROWTYPE; used integer; outcome text;
BEGIN
  PERFORM public.wfe_require('sla_rules', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = p_rule AND task_def_id = t.id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The SLA rule does not belong to this task.')); END IF;
  SELECT count(*) INTO used FROM public.task_instances ti WHERE ti.sla_rule_id = r.id;
  IF used = 0 THEN
    DELETE FROM public.sla_rules WHERE id = r.id;
    outcome := 'deleted';
  ELSE
    UPDATE public.sla_rules SET is_active = false, inactive_reason = btrim(p_reason), effective_to = LEAST(coalesce(effective_to, current_date), current_date)
      WHERE id = r.id;
    outcome := 'deactivated';
  END IF;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('sla_rule_' || outcome, 'sla_rule', p_task, public.wf_sla_rule_json(r, p_task),
    jsonb_build_object('outcome', outcome, 'tasks_using_rule', used), p_reason);
  RETURN jsonb_build_object('outcome', outcome, 'tasks_using_rule', used,
    'why', CASE WHEN used = 0 THEN NULL ELSE 'Tasks already use this rule: it is deactivated, not deleted.' END,
    'version', w.version, 'weight_totals', public.wf_weight_totals(w.id));
END $$;

-- 4c. Weight of a task in a draft: counts or not, the percent, and the group. A group must total 100 before publishing; the draft only warns.
CREATE OR REPLACE FUNCTION admin_wf_task_weight(p_version integer, p_etag integer, p_task text, p_counts boolean, p_weight numeric, p_group text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; before_ jsonb; grp text := nullif(btrim(coalesce(p_group, '')), '');
BEGIN
  PERFORM public.wfe_require('weights', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_counts IS NULL THEN PERFORM public.wfe_err1('/counts_in_weight', 'required', 'counts_in_weight is true or false.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The weight is changed in a draft version: copy the published version to a draft first.')); END IF;
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  IF p_counts AND (p_weight IS NULL OR p_weight < 0 OR p_weight > 100) THEN PERFORM public.wfe_err1('/weight_value', 'invalid', 'The weight is 0 to 100 percent.'); END IF;
  IF p_counts AND grp IS NULL THEN PERFORM public.wfe_err1('/weight_group', 'required', 'A task that counts needs a weight group.'); END IF;
  IF grp IS NOT NULL AND grp !~ '^[A-Z0-9_-]{1,20}$' THEN PERFORM public.wfe_err1('/weight_group', 'invalid', 'The group is up to 20 capitals, digits, _ or -.'); END IF;
  IF NOT p_counts THEN p_weight := 0; END IF;
  before_ := jsonb_build_object('counts_in_weight', t.counts_in_weight, 'weight_value', t.weight_value, 'weight_group', t.weight_group);
  IF (p_counts, p_weight, grp) IS NOT DISTINCT FROM (t.counts_in_weight, t.weight_value, t.weight_group) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  UPDATE public.task_definitions SET counts_in_weight = p_counts, weight_value = p_weight, weight_group = grp, reason = btrim(p_reason), changed_by = public.app_actor()
    WHERE id = t.id;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_weight', 'task_definition', p_task, before_,
    jsonb_build_object('counts_in_weight', p_counts, 'weight_value', p_weight, 'weight_group', grp), p_reason);
  RETURN jsonb_build_object('version', public.wfe_version_json(w.id), 'weight_totals', public.wf_weight_totals(w.id));
END $$;

-- 5. A new draft copies the weights and the SLA options of its parent (admin_create_workflow_draft copies the tasks and the rules, not these columns).
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
  UPDATE public.task_definitions n SET counts_in_weight = o.counts_in_weight, weight_value = o.weight_value, weight_group = o.weight_group
    FROM public.task_definitions o WHERE o.workflow_id = w.id AND n.workflow_id = nid AND o.code = n.code;
  UPDATE public.sla_rules r SET unit = o.unit, warning_pct = o.warning_pct, breach_owner_role = o.breach_owner_role, escalation_role = o.escalation_role,
    pause_on_client_wait = o.pause_on_client_wait, is_active = o.is_active, inactive_reason = o.inactive_reason
    FROM public.sla_rules o JOIN public.task_definitions ot ON ot.id = o.task_def_id JOIN public.task_definitions nt ON nt.workflow_id = nid AND nt.code = ot.code
    WHERE ot.workflow_id = w.id AND r.task_def_id = nt.id AND r.min_working_days = o.min_working_days AND r.max_working_days = o.max_working_days
      AND r.start_event = o.start_event AND r.effective_from = o.effective_from AND r.scenario IS NOT DISTINCT FROM o.scenario
      AND r.region_id IS NOT DISTINCT FROM o.region_id;
  RETURN public.wfe_version_json(nid);
END $$;

-- 6. Owner and grants, as the editor doors (0090, 0096).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['wf_weight_totals(uuid)', 'wf_sla_rule_json(sla_rules,text)', 'admin_sla_rule_save(integer,integer,text,jsonb,text)',
    'admin_sla_rule_remove(integer,integer,text,uuid,text)', 'admin_wf_task_weight(integer,integer,text,boolean,numeric,text,text)',
    'admin_wf_create_draft(integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION wf_weight_totals(uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_sla_rule_save(integer,integer,text,jsonb,text), admin_sla_rule_remove(integer,integer,text,uuid,text),
      admin_wf_task_weight(integer,integer,text,boolean,numeric,text,text), admin_wf_create_draft(integer,text) TO pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('sla_weight_editor_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner request 2026-11-15: SLA and project weight in the workflow editor', 'functions', 'admin_sla_rule_save, admin_sla_rule_remove, admin_wf_task_weight'),
        'Migration 0109: SLA options on rules, weight columns on tasks, weight totals, and the doors that write them.');
