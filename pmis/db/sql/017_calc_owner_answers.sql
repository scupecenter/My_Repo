-- 0018_calc_owner_answers: owner answers Q76 to Q84 (docs/spec/owner-answers-2026-10-29.md, section "SLA and gate questions").
-- Mirror: db/sql/017_calc_owner_answers.sql (kept byte-identical).
--
-- Nothing of 0015 to 0017 is edited in place: every function below is CREATE OR REPLACE (owner and grants of the existing ones are kept),
-- the one new table and the new functions get their ownership and rights in the last part.
--
--   Q76  every calculated milestone takes the later of its latest condition date and its gate date (settings only: ms_evaluate already
--        reads calc.milestone_ge_gate, which becomes the empty list, so the milestones stay calculated);
--   Q77  Commissioning Power Safe stays a yes/no field and gate G6 keeps no condition on it (no code: confirmed by a test);
--   Q78  the PTW HSE checks are information only: permit_start no longer reads them, the setting calc.ptw_hse_check_keys is removed.
--        Stop work still holds the gate (gate_eval, condition stop_work_blocks);
--   Q80  the SLA of B-15 (CW FAC) starts from the CW PAC date + sla.dlp_days.cw calendar days (default 90, as the Master's CWDLPDays).
--        New start event grammar DLPD:<task>:<setting key>. The TE FAC (B06) keeps DLP:D16:dlp.months.te, which is the Master's
--        EDATE(TE PAC, TEDLPMonths = 12); dlp.months.* and the printed DLP stay as they are;
--   Q81  a gate LOCKS the tasks of the next stage until it opens (permits valid, no stop work, no suspension), except the tasks of the setting
--        calc.gate_lock_exempt_tasks (seed: the GECOL and HLC tasks C1 to C4). wf_unlock_successors keeps a task locked while its gate is closed
--        (lock_reason 'gate_closed:<gate>') and calc_refresh_site opens it, through the same unlock code, when the gate opens.
--        A gate that closes again (a new stop work, an expired permit, a suspension) does NOT re-lock the tasks that are already open: it raises
--        an alert (calc_gate_watch);
--   Q82  the SLA clock closes at the actual date. A negative duration raises a data-quality alert (System Admins and the stage lead,
--        notification and audit row 'sla_negative_duration');
--   Q84  cal_tentative_reminders(): the 14-day reminder of tentative holidays, for the daily job of the API (which also calls sla_apply_due_sets()).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------------------------------------------------
-- Q76 (owner decision, differs from the Master): no milestone stays blank when its conditions are earlier than its gate.
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('calc.milestone_ge_gate', '[]', 'Milestones that stay uncalculated when their latest condition date is earlier than their gate. Empty since owner answer Q76: every milestone takes the later of the two dates.', now())
ON CONFLICT (key) DO UPDATE SET value = '[]', description = EXCLUDED.description, updated_at = now();

-- Q78 (owner decision): the PTW HSE checks are information only; nothing evaluates them.
DELETE FROM settings WHERE key = 'calc.ptw_hse_check_keys';

-- Q80: CW DLP in calendar days for the SLA start event of B-15 (the Master's CWDLPDays, Setting!B4 = 90).
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('sla.dlp_days.cw', '90', 'Calendar days from the CW PAC date to the CW DLP end, for the SLA start event of B-15 (CW FAC). As the Master (CWDLPDays = 90). The printed DLP (dlp.months.cw) is not affected.', now())
ON CONFLICT (key) DO NOTHING;

-- Q81: tasks that a closed gate does not lock (they run in parallel with civil works): the GECOL and HLC tasks. A code that ends in * is a prefix.
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('calc.gate_lock_exempt_tasks', '["C1","C2","C3","C4"]', 'Task codes that a closed gate does not lock (GECOL and HLC run in parallel with civil works). An entry ending in * is a prefix, for example "C*".', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q80: SLA start event DLPD:<task>:<setting key> = the date of the task plus the calendar days of the setting
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sla_start_ref_valid(p_ref text, p_workflow uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_ref IS NULL THEN false
    WHEN p_ref IN ('PRED', 'OPEN') THEN true
    WHEN p_ref LIKE 'DLP:%:%' OR p_ref LIKE 'DLPD:%:%' THEN
      EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = split_part(p_ref, ':', 2)) AND split_part(p_ref, ':', 3) <> ''
    WHEN p_ref ~ '^G[0-9]+$' THEN EXISTS (SELECT 1 FROM public.phase_gate_rules g WHERE g.workflow_id = p_workflow AND g.link_code = p_ref)
    ELSE EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = p_ref)
  END
$$;

CREATE OR REPLACE FUNCTION sla_resolve_start(p_task uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; d date; months integer; days integer; key text; today date := public.cal_today();
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_ref IS NULL OR p_ref = 'PRED' THEN
    SELECT max(public.sla_task_date(t.site_id, pd.code)) INTO d
    FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id WHERE tp.task_def_id = t.task_def_id;
    RETURN coalesce(d, today);
  ELSIF p_ref = 'OPEN' THEN
    RETURN today;
  ELSIF p_ref ~ '^G[0-9]+$' THEN
    RETURN (SELECT g.gate_date FROM public.gate_eval(t.site_id, p_ref) g);
  ELSIF p_ref LIKE 'DLPD:%:%' THEN
    -- Q80: the task date plus calendar days (the Master's CW DLP end = CW PAC + CWDLPDays)
    key := split_part(p_ref, ':', 3);
    days := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, 90);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE d + days END;
  ELSIF p_ref LIKE 'DLP:%:%' THEN
    key := split_part(p_ref, ':', 3);
    months := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, CASE WHEN key = 'dlp.months.cw' THEN 3 ELSE 12 END);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE (d + make_interval(months => months))::date END;
  END IF;
  RETURN public.sla_task_date(t.site_id, p_ref);
END $$;

-- B-15 (CW FAC) now starts from the CW DLP end counted in calendar days. The rule rows of a published version are frozen while a task uses
-- them (sla_rules_frozen); the start date of a task that already started is stored on the task and does not move, so the trigger is
-- suspended for this one statement. Both the rule rows and the items of every rule-set version (drafts included) are updated.
ALTER TABLE sla_rules DISABLE TRIGGER sla_rules_frozen;
UPDATE sla_rules SET start_ref = 'DLPD:B13:sla.dlp_days.cw' WHERE start_ref = 'DLP:B13:dlp.months.cw';
ALTER TABLE sla_rules ENABLE TRIGGER sla_rules_frozen;
UPDATE sla_rule_set_items SET start_ref = 'DLPD:B13:sla.dlp_days.cw' WHERE start_ref = 'DLP:B13:dlp.months.cw';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q78: the HSE checks of a PTW are not evaluated. A PTW counts from its valid-from date, or from the lift date of an active stop work.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION permit_start(p public.permit_records) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF lower(coalesce(p.status, '')) <> 'approved' OR p.valid_from IS NULL THEN RETURN NULL; END IF;
  IF NOT public.permit_is_ptw(p.permit_type) THEN RETURN p.valid_from; END IF;
  -- the HSE check results of a PTW are information only (owner answer Q78); stop work still holds the permit
  IF p.stop_work THEN
    IF p.stop_lifted_date IS NULL THEN RETURN NULL; END IF;
    RETURN greatest(p.valid_from, p.stop_lifted_date);
  END IF;
  RETURN p.valid_from;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Alerts (Q81, Q82) and the table that remembers whether a gate was open
-- ---------------------------------------------------------------------------------------------------------------------
-- The people who lead the stage of a task: the holders of the approve level of its matrix cell (decision B2: the stage's main role approves),
-- resolved like wf_eligible but without the caller's region filter, so a trigger or a job finds them whoever fired it.
CREATE OR REPLACE FUNCTION calc_stage_leads(p_task uuid) RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; cell uuid;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT c.id INTO cell
  FROM public.task_definitions td
  JOIN public.matrix_cells c ON c.stage_id = td.stage_id AND c.level = 3 AND (c.task_def_id IS NULL OR c.task_def_id = td.id)
       AND (c.region_id IS NULL OR c.region_id = t.region_id)
  WHERE td.id = t.task_def_id
  ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id
  LIMIT 1;
  IF cell IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH ex AS (
    SELECT a.ref_id AS uid FROM public.matrix_cell_assignees a WHERE a.cell_id = cell AND a.kind = 'user'
    UNION
    SELECT ua.user_id
      FROM public.matrix_cell_assignees a
      JOIN public.roles r ON r.id = a.ref_id AND r.is_active AND r.can_hold_matrix_levels
      JOIN public.user_role_assignments ua ON ua.role_id = r.id
      WHERE a.cell_id = cell AND a.kind = 'role' AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
        AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rr WHERE rr.assignment_id = ua.id AND rr.region_id = t.region_id))
    UNION
    SELECT gm.user_id FROM public.matrix_cell_assignees a
      JOIN public.groups g ON g.id = a.ref_id AND g.is_active
      JOIN public.group_members gm ON gm.group_id = g.id
      WHERE a.cell_id = cell AND a.kind = 'group'
  )
  SELECT ex.uid FROM ex WHERE public.wf_user_in_scope(ex.uid, t.region_id);
END $$;

-- A data-quality or gate alert: an in-app notification to every active System Admin and to the stage lead of the task, once each.
CREATE OR REPLACE FUNCTION calc_alert(p_task uuid, p_kind text, p_title text, p_body text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u uuid; n integer := 0;
BEGIN
  FOR u IN
    SELECT gm.user_id FROM public.group_members gm
      JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
      JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL AND NOT x.is_break_glass
    UNION
    SELECT l.user_id FROM public.calc_stage_leads(p_task) l
  LOOP
    PERFORM public.wf_notify(u, p_kind, p_title, p_body, p_task);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- What the calculation layer last saw of each gate on each site: a gate that was open and is closed now is an alert (Q81).
CREATE TABLE site_gate_state (
  site_id   UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE,
  gate_code TEXT NOT NULL,
  is_open   BOOLEAN NOT NULL,
  since     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, gate_code)
);
ALTER TABLE site_gate_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_gate_state FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON site_gate_state FOR SELECT USING (EXISTS (SELECT 1 FROM sites s WHERE s.id = site_id));
CREATE POLICY rls_seed_write ON site_gate_state FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q81: a closed gate locks the tasks of the next stage
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gate_lock_exempt(p_code text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(public.calc_setting('calc.gate_lock_exempt_tasks', '[]'::jsonb)) e
                 WHERE e = p_code OR (right(e, 1) = '*' AND starts_with(p_code, left(e, -1))))
$$;

-- Does a closed gate hold this task? The gate is the one that leads into the task's stage (its to_code). No row = the task is free:
-- no gate in front of the stage, the gate is open or does not apply, or the task is in calc.gate_lock_exempt_tasks.
-- gate_status is 'blocked' (a condition holds it) or 'pending' (the milestone before it has no date yet); reasons are the gate's LockReason items.
CREATE OR REPLACE FUNCTION wf_gate_hold(p_task uuid, OUT gate_code text, OUT gate_status text, OUT reasons jsonb)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; s public.sites%ROWTYPE; tcode text; scode text; g record;
BEGIN
  reasons := '[]'::jsonb;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT td.code, sd.code INTO tcode, scode FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id WHERE td.id = t.task_def_id;
  IF public.gate_lock_exempt(tcode) THEN RETURN; END IF;
  SELECT * INTO s FROM public.sites WHERE id = t.site_id;
  SELECT r.link_code INTO gate_code FROM public.phase_gate_rules r WHERE r.workflow_id = s.workflow_version_id AND r.to_code = scode AND r.is_active ORDER BY r.seq LIMIT 1;
  IF gate_code IS NULL THEN RETURN; END IF;
  SELECT * INTO g FROM public.gate_eval(t.site_id, gate_code);
  IF g.status IN ('open', 'na') THEN gate_code := NULL; RETURN; END IF;
  gate_status := g.status;
  reasons := coalesce(g.reasons, '[]'::jsonb);
  IF jsonb_array_length(reasons) = 0 THEN
    reasons := jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', gate_code, 'message', 'The gate ' || gate_code || ' is not open.', 'count', NULL));
  END IF;
END $$;

-- Opens one locked task: state, audit, and the notice to the holders of its entry level. This is the unlock code of 0015/0016/0017, moved here
-- so that a gate that opens later uses the very same steps (the SLA clock starts from the state change, by the trigger of 0017).
-- A calculated milestone has no holder on purpose (E3): no "no eligible holder" alert for it.
CREATE OR REPLACE FUNCTION wf_open_locked(p_task uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE before jsonb; h record;
BEGIN
  before := public.wf_snap(p_task);
  UPDATE public.task_instances SET state = 'open', current_level = 1, level_opened_at = now(), lock_reason = NULL, version = version + 1, updated_at = now()
  WHERE id = p_task AND state = 'locked';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.wf_audit('task_unlock', p_task, before, public.wf_snap(p_task), p_reason);
  IF EXISTS (SELECT 1 FROM public.task_instances mi JOIN public.task_definitions md ON md.id = mi.task_def_id
             WHERE mi.id = p_task AND md.is_milestone_task AND md.code <> 'MS4') THEN
    RETURN true;
  END IF;
  FOR h IN SELECT e.user_id FROM public.wf_eligible(p_task, 'entry') e LIMIT 20 LOOP
    PERFORM public.wf_notify(h.user_id, 'task_assigned', 'A task is ready to start', public.wf_label(p_task), p_task);
  END LOOP;
  IF NOT public.wf_has_holder(p_task, 'entry') THEN
    PERFORM public.wf_notify_admins('no_eligible_holder', 'No holder for a task level', public.wf_label(p_task) || ': nobody can act on the entry level.', p_task);
  END IF;
  RETURN true;
END $$;

-- Successors whose predecessors are all approved (or N/A, skipped, or not on this site) go from locked to open, unless a closed gate holds
-- them (Q81): they stay locked with lock_reason 'gate_closed:<gate>' and calc_refresh_site opens them when the gate opens.
CREATE OR REPLACE FUNCTION wf_unlock_successors(p_task uuid) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; s record; ids uuid[] := ARRAY[]::uuid[]; hold record;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  FOR s IN
    SELECT si.id FROM public.task_predecessors tp
    JOIN public.task_instances si ON si.site_id = t.site_id AND si.task_def_id = tp.task_def_id AND si.state = 'locked'
    WHERE tp.predecessor_id = t.task_def_id
      AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2
                      JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = p2.predecessor_id
                      WHERE p2.task_def_id = si.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped'))
    ORDER BY si.id
  LOOP
    SELECT * INTO hold FROM public.wf_gate_hold(s.id);
    IF hold.gate_code IS NOT NULL THEN
      UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code
      WHERE id = s.id AND lock_reason IS DISTINCT FROM 'gate_closed:' || hold.gate_code;
      CONTINUE;
    END IF;
    IF public.wf_open_locked(s.id, 'predecessor ' || public.wf_label(p_task) || ' approved') THEN ids := ids || s.id; END IF;
  END LOOP;
  RETURN ids;
END $$;

-- Opens the tasks of a site that waited for a gate and whose gate is open now. Returns how many.
CREATE OR REPLACE FUNCTION calc_release_gated(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; n integer := 0; hold record; g text;
BEGIN
  FOR r IN
    SELECT ti.id, ti.lock_reason FROM public.task_instances ti
    WHERE ti.site_id = p_site AND ti.state = 'locked' AND starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:')
      AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2
                      JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = p2.predecessor_id
                      WHERE p2.task_def_id = ti.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped'))
    ORDER BY ti.id
  LOOP
    SELECT * INTO hold FROM public.wf_gate_hold(r.id);
    IF hold.gate_code IS NULL THEN
      g := substr(r.lock_reason, length('gate_closed:') + 1);
      IF public.wf_open_locked(r.id, 'gate ' || g || ' is open') THEN n := n + 1; END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Remembers each gate of the site as open or closed. A gate that was open and is blocked now does not re-lock the tasks that are already
-- open (owner answer Q81, choice of this implementation: the work in progress is not interrupted); it raises an alert for the System Admins
-- and the stage lead, and an audit row. Alerts only when a task of the next stage is open, because otherwise nothing is affected.
CREATE OR REPLACE FUNCTION calc_gate_watch(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; g record; ev record; was boolean; is_open_ boolean; n integer := 0; rep uuid; open_n integer; site_code_ text; msgs text;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR g IN SELECT r.link_code, r.to_code FROM public.phase_gate_rules r WHERE r.workflow_id = s.workflow_version_id AND r.is_active ORDER BY r.seq LOOP
    SELECT * INTO ev FROM public.gate_eval(p_site, g.link_code);
    is_open_ := ev.status IS DISTINCT FROM 'blocked';
    SELECT st.is_open INTO was FROM public.site_gate_state st WHERE st.site_id = p_site AND st.gate_code = g.link_code;
    IF NOT FOUND THEN
      INSERT INTO public.site_gate_state (site_id, gate_code, is_open) VALUES (p_site, g.link_code, is_open_) ON CONFLICT (site_id, gate_code) DO NOTHING;
      CONTINUE;
    END IF;
    CONTINUE WHEN was = is_open_;
    UPDATE public.site_gate_state SET is_open = is_open_, since = now() WHERE site_id = p_site AND gate_code = g.link_code;
    IF was AND NOT is_open_ THEN
      SELECT count(*), (array_agg(ti.id ORDER BY td.code))[1] INTO open_n, rep
      FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id AND sd.workflow_id = s.workflow_version_id AND sd.code = g.to_code
      WHERE ti.site_id = p_site AND ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND NOT public.gate_lock_exempt(td.code);
      IF open_n > 0 THEN
        SELECT string_agg(e ->> 'message', ' ') INTO msgs FROM jsonb_array_elements(coalesce(ev.reasons, '[]'::jsonb)) e;
        site_code_ := s.site_code;
        PERFORM public.calc_alert(rep, 'gate_closed_again', 'Gate ' || g.link_code || ' closed again on ' || site_code_,
          'Gate ' || g.link_code || ' closed again: ' || coalesce(msgs, ev.status) || ' ' || open_n || ' task(s) of the next stage are already open and stay open.');
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
        VALUES ('gate_closed_again', 'site', p_site::text, p_site, s.region_id, jsonb_build_object('gate', g.link_code, 'open', true),
                jsonb_build_object('gate', g.link_code, 'status', ev.status, 'reasons', coalesce(ev.reasons, '[]'::jsonb), 'open_tasks_kept_open', open_n),
                'the gate closed after it opened: open tasks are not re-locked (Q81)', public.app_actor());
        n := n + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. calc_refresh_site: as 0017, plus the release of the tasks a gate was holding and the gate watch
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calc_refresh_site(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  changed integer := 0; round_ integer := 0; progress boolean; m record; ev record; manual jsonb; before jsonb; pre date; sid uuid; released integer;
BEGIN
  IF current_setting('pmis.calc_busy', true) = '1' THEN RETURN 0; END IF;
  PERFORM set_config('pmis.calc_busy', '1', true);
  manual := public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb);
  LOOP
    progress := false; round_ := round_ + 1;
    EXIT WHEN round_ > 25;
    FOR m IN
      SELECT ti.id, ti.state, ti.actual_date, ti.admin_override, ti.values, ti.levels_required, ti.version, sd.code AS stage_code, sd.seq
      FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site AND ti.state IN ('open', 'entry', 'approved')
      ORDER BY sd.seq
    LOOP
      SELECT * INTO ev FROM public.ms_evaluate(m.id);
      IF manual ? m.stage_code THEN
        -- Site RFI (Q38): pre-filled with the latest condition date while the entry is open and the date was not edited; it then goes through approval.
        IF m.state IN ('open', 'entry') AND ev.ready THEN
          pre := nullif(m.values ->> 'prefilled_date', '')::date;
          IF m.actual_date IS NULL OR m.actual_date IS NOT DISTINCT FROM pre THEN
            IF m.actual_date IS DISTINCT FROM ev.ms_date THEN
              before := jsonb_build_object('actual_date', m.actual_date);
              UPDATE public.task_instances SET actual_date = ev.ms_date, lock_reason = NULL,
                values = coalesce(values, '{}'::jsonb) || jsonb_build_object('prefilled_date', ev.ms_date, 'prefilled', true), version = version + 1, updated_at = now()
              WHERE id = m.id;
              INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
              SELECT 'milestone_prefill', 'task', m.id::text, ti.site_id, ti.region_id, before, jsonb_build_object('actual_date', ev.ms_date), 'pre-filled with the latest condition date (Q38)'
              FROM public.task_instances ti WHERE ti.id = m.id;
              changed := changed + 1; progress := true;
            END IF;
          END IF;
        ELSIF m.state IN ('open', 'entry') AND NOT ev.ready THEN
          UPDATE public.task_instances SET lock_reason = ev.reasons -> 0 ->> 'message' WHERE id = m.id AND lock_reason IS DISTINCT FROM (ev.reasons -> 0 ->> 'message');
        END IF;
        CONTINUE;
      END IF;
      -- calculated milestone (E3)
      IF m.state = 'open' THEN
        IF ev.ready THEN
          before := jsonb_build_object('state', m.state, 'actual_date', m.actual_date);
          UPDATE public.task_instances SET state = 'approved', actual_date = ev.ms_date, approved_date = public.cal_today(), current_level = levels_required,
            ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
            version = version + 1, updated_at = now()
          WHERE id = m.id;
          INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
          VALUES (m.id, 1, 'approve', NULL, 'calculated milestone: no approval of its own (E3)', 'open', 'approved', clock_timestamp());
          INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
          SELECT 'milestone_calculated', 'task', m.id::text, ti.site_id, ti.region_id, before,
                 jsonb_build_object('state', 'approved', 'actual_date', ev.ms_date), 'calculated from its tasks and gate (E3)'
          FROM public.task_instances ti WHERE ti.id = m.id;
          PERFORM public.wf_unlock_successors(m.id);
          changed := changed + 1; progress := true;
        ELSE
          UPDATE public.task_instances SET lock_reason = ev.reasons -> 0 ->> 'message' WHERE id = m.id AND lock_reason IS DISTINCT FROM (ev.reasons -> 0 ->> 'message');
        END IF;
      ELSIF m.state = 'approved' AND NOT m.admin_override AND ev.ready AND ev.ms_date IS DISTINCT FROM m.actual_date THEN
        -- a condition date moved after the milestone was calculated: the calculated date follows (audited)
        before := jsonb_build_object('actual_date', m.actual_date);
        UPDATE public.task_instances SET actual_date = ev.ms_date, version = version + 1, updated_at = now() WHERE id = m.id;
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
        SELECT 'milestone_recalculated', 'task', m.id::text, ti.site_id, ti.region_id, before, jsonb_build_object('actual_date', ev.ms_date), 'a condition date moved'
        FROM public.task_instances ti WHERE ti.id = m.id;
        changed := changed + 1; progress := true;
      END IF;
    END LOOP;
    -- tasks a closed gate was holding (Q81): the gate is open now, so they open through the unlock code of the engine
    released := public.calc_release_gated(p_site);
    IF released > 0 THEN changed := changed + released; progress := true; END IF;
    -- clocks that were waiting for their start event (a gate that was closed, a predecessor without a date)
    FOR sid IN
      SELECT ti.id FROM public.task_instances ti
      WHERE ti.site_id = p_site AND ti.sla_start_date IS NULL AND ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended')
    LOOP
      PERFORM public.sla_task_open(sid);
      IF EXISTS (SELECT 1 FROM public.task_instances WHERE id = sid AND sla_start_date IS NOT NULL) THEN changed := changed + 1; progress := true; END IF;
    END LOOP;
    EXIT WHEN NOT progress;
  END LOOP;
  PERFORM public.calc_gate_watch(p_site);
  PERFORM set_config('pmis.calc_busy', '', true);
  RETURN changed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', '', true);
  RAISE;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q82: the clock closes at the actual date; a negative duration is a data-quality alert
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sla_task_close(p_task uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.sla_rules%ROWTYPE; e date; el integer;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.state IN ('na', 'skipped') THEN
    UPDATE public.task_instances SET due_date = NULL, sla_target_date = NULL, sla_start_date = NULL, sla_end_date = NULL, sla_elapsed_wd = NULL WHERE id = p_task;
    RETURN;
  END IF;
  IF t.sla_start_date IS NULL OR t.sla_rule_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = t.sla_rule_id;
  e := CASE r.end_ref
         WHEN 'gecol.installation_finish' THEN coalesce((SELECT g.installation_finish FROM public.gecol_records g WHERE g.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'hlc.installation_date' THEN coalesce((SELECT h.installation_date FROM public.hlc_records h WHERE h.site_id = t.site_id), t.actual_date, t.approved_date)
         ELSE coalesce(t.actual_date, t.approved_date) END;
  el := public.cal_workdays_between(t.sla_start_date, e, r.calendar_id);
  UPDATE public.task_instances SET sla_end_date = e, sla_elapsed_wd = el WHERE id = p_task;
  IF el < 0 THEN
    -- Q82: the actual date is before the start of the clock. The duration is kept as it is (negative) and flagged for review.
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('sla_negative_duration', 'task', p_task::text, t.site_id, t.region_id,
            jsonb_build_object('sla_start_date', t.sla_start_date, 'sla_end_date', e),
            jsonb_build_object('sla_elapsed_wd', el), 'data quality: the actual date is before the SLA start (Q82)', public.app_actor());
    PERFORM public.calc_alert(p_task, 'sla_negative_duration', 'SLA duration is negative',
      public.wf_label(p_task) || ': the actual date ' || e::text || ' is before the SLA start ' || t.sla_start_date::text || ' (' || el::text || ' working days). Please review the dates.');
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Q84: the reminder of tentative holidays (the daily job of the API also calls sla_apply_due_sets())
-- ---------------------------------------------------------------------------------------------------------------------
-- One in-app notification to every active System Admin for each tentative holiday that falls within p_days days, once per holiday date:
-- running it again the same day (or the next days) adds nothing. A holiday that is confirmed or moved is not reminded / is reminded for its new date.
CREATE OR REPLACE FUNCTION cal_tentative_reminders(p_days integer DEFAULT 14) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h record; u uuid; n integer := 0; lnk text; today date := public.cal_today();
BEGIN
  FOR h IN SELECT x.id, x.date, x.name FROM public.holidays x WHERE x.tentative AND x.confirmed_at IS NULL AND x.date BETWEEN today AND today + p_days ORDER BY x.date LOOP
    lnk := '/admin/settings/calendar?date=' || h.date::text;
    FOR u IN
      SELECT DISTINCT gm.user_id FROM public.group_members gm
        JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
        JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL AND NOT x.is_break_glass
    LOOP
      IF NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = u AND nt.kind = 'holiday_tentative' AND nt.link = lnk) THEN
        INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
        VALUES (u, 'in_app', 'holiday_tentative', 'Confirm a tentative holiday',
                coalesce(h.name, 'A holiday') || ' on ' || h.date::text || ' is still tentative (' || (h.date - today)::text || ' days ahead). Confirm the date on the official announcement.', lnk);
        n := n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and rights. The functions that exist keep theirs (CREATE OR REPLACE). New ones: not executable by PUBLIC, executable by
-- pmis_definer; the owner is pmis_definer for those that write or run as definer. pmis_app gets only what the API calls.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON site_gate_state TO pmis_definer;
GRANT SELECT ON matrix_cells, matrix_cell_assignees, roles, user_role_assignments, user_role_assignment_regions, groups, group_members, users TO pmis_definer;
GRANT INSERT ON notifications, audit_log TO pmis_definer;
GRANT SELECT ON notifications, holidays, settings TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['calc_stage_leads', 'calc_alert', 'gate_lock_exempt', 'wf_gate_hold', 'wf_open_locked',
             'calc_release_gated', 'calc_gate_watch', 'cal_tentative_reminders'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname = ANY (ARRAY['calc_stage_leads', 'calc_alert', 'wf_open_locked', 'calc_release_gated', 'calc_gate_watch', 'cal_tentative_reminders']) THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- the task views read the gate that holds a task; the daily job runs the reminder; nothing else of this migration is called by the API
    GRANT EXECUTE ON FUNCTION gate_lock_exempt(text) TO pmis_app;
    GRANT EXECUTE ON FUNCTION wf_gate_hold(uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION cal_tentative_reminders(integer) TO pmis_app;
    GRANT SELECT ON site_gate_state TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON site_gate_state FROM pmis_app;
  END IF;
END $$;
