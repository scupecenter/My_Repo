-- 0128: security fixes to the historical-load rules of 0126 and 0127 (automated security review of 0127; 0127 is already on main, and migrations are
-- recorded by name only, so the fix is a new migration).
--
-- 1. A gate that a historical load moved past (admin override historical_gate_open, 0127) is no longer opened while a stop work is in force on one of
--    its permits: gate_eval keeps it blocked when a reason of kind stop_work is present, and hgd_settle_site skips such gates.
-- 2. The transaction markers of the historical rules (hns_task, hns_restore of 0126; hgd_task, hgd_restore, hgd_gate of 0127) were session settings
--    (GUC) checked together with current_user = pmis_definer. A setting the application role set for its session could then stand in for a marker
--    whenever it called any definer function. They are now rows of hgd_marks (transaction id, kind, key), written only through hgd_mark / hgd_unmark
--    (definer, closed to PUBLIC); the guards read them through hgd_marked, only when current_user is pmis_definer.
--
-- Redefined from 0126 / 0127 (bodies unchanged except the markers and the stop-work rule): gate_eval, hns_guard_task, hns_mark_site, hns_restore_task,
-- hns_apply_sites, hgd_guard_task, hgd_guard_gate, hgd_restore_milestone, hgd_restore_gate, hgd_settle_site, hgd_apply_sites. CREATE OR REPLACE keeps
-- their owner (pmis_definer), search_path and grants. No new right for pmis_app.

-- 0127 (security review): the transaction markers of the historical rules (0126 and 0127) are rows of hgd_marks, written and read only by definer code
-- (no right for pmis_app), keyed by the transaction id, so a session setting of the application role can never stand in for them.
CREATE TABLE hgd_marks (
  xid  bigint NOT NULL,
  kind text   NOT NULL,
  key  text   NOT NULL,
  PRIMARY KEY (xid, kind)
);
ALTER TABLE hgd_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hgd_marks FORCE ROW LEVEL SECURITY;   -- no policy: only the definer functions (pmis_definer bypasses row security) read it
REVOKE ALL ON hgd_marks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON hgd_marks TO pmis_definer;
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON hgd_marks FROM pmis_app; END IF;
END $do$;

CREATE OR REPLACE FUNCTION hgd_mark(p_kind text, p_key text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.hgd_marks (xid, kind, key) VALUES (txid_current(), p_kind, p_key)
  ON CONFLICT (xid, kind) DO UPDATE SET key = EXCLUDED.key;
$$;

CREATE OR REPLACE FUNCTION hgd_unmark(p_kind text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  DELETE FROM public.hgd_marks WHERE xid = txid_current() AND kind = p_kind;
$$;

CREATE OR REPLACE FUNCTION hgd_marked(p_kind text, p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.hgd_marks m WHERE m.xid = txid_current() AND m.kind = p_kind AND m.key = p_key);
$$;

CREATE OR REPLACE FUNCTION hns_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical load: the no-source flag of a task is written only by GSDN Workspace (migration 0126)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_no_source AND (NEW.state IS DISTINCT FROM 'na' OR NOT NEW.is_na) THEN
    NEW.historical_no_source := false;
    -- the restore marker counts only when set by definer code (hns_restore_task), never from a session-level GUC of the app role
    IF NOT (current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hns_restore', NEW.id::text) ELSE false END)) THEN
      UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = coalesce(public.app_actor(), acted_by),
        revert_reason = left('the task left N/A (' || NEW.state::text || ')', 2000)
      WHERE task_id = NEW.id AND kind = 'historical_no_source_na' AND reverted_at IS NULL;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_historical_no_source_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('historical_no_source', true, 'state', OLD.state::text),
        jsonb_build_object('historical_no_source', false, 'state', NEW.state::text),
        'The task left N/A (' || NEW.state::text || '): the historical no-source mark is cleared.', public.app_actor());
    END IF;
    NEW.admin_override := EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = NEW.id AND o.reverted_at IS NULL AND o.kind <> 'historical_no_source_na');
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.historical_no_source, NEW.historical_no_source_at) IS NOT DISTINCT FROM (OLD.historical_no_source, OLD.historical_no_source_at) THEN RETURN NEW; END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hns_task', NEW.id::text) ELSE false END)
     AND NEW.historical_no_source AND NOT OLD.historical_no_source AND NEW.state = 'na' AND OLD.state IN ('locked', 'open', 'entry') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical load: the no-source flag of a task is written only by GSDN Workspace (migration 0126)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION hns_mark_site(p_site uuid, p_actor uuid, p_reason text, p_catchup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; t record; cur public.task_instances%ROWTYPE; before jsonb; oid uuid; ids uuid[]; i uuid; n int; rounds int := 0;
  marked jsonb := '[]'::jsonb; nodate jsonb; was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
  why constant text := 'historical load: no source';
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'historical no source: only the System Admin of the historical load marks a task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.hns_site_in_scope(p_site) THEN
    RETURN jsonb_build_object('site_id', p_site, 'in_scope', false, 'marked', '[]'::jsonb, 'milestones_without_date', '[]'::jsonb);
  END IF;
  LOOP
    rounds := rounds + 1;
    EXIT WHEN rounds > 5;
    n := 0; ids := ARRAY[]::uuid[];
    PERFORM set_config('pmis.calc_busy', '1', true);
    FOR t IN
      WITH RECURSIVE succ(anc, des) AS (
        SELECT tp.predecessor_id, tp.task_def_id FROM public.task_predecessors tp
        JOIN public.task_definitions d ON d.id = tp.task_def_id AND d.workflow_id = s.workflow_version_id
        UNION
        SELECT c.anc, tp.task_def_id FROM succ c JOIN public.task_predecessors tp ON tp.predecessor_id = c.des
      )
      SELECT ti.id, td.code, ev.code AS ev_code, ev.actual_date AS ev_date
      FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.workflow_id = s.workflow_version_id AND NOT td.is_milestone_task
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      CROSS JOIN LATERAL (
        SELECT ud.code, u.actual_date FROM succ c
        JOIN public.task_instances u ON u.site_id = ti.site_id AND u.task_def_id = c.des
        JOIN public.task_definitions ud ON ud.id = u.task_def_id
        WHERE c.anc = ti.task_def_id AND u.state = 'approved' AND u.actual_date IS NOT NULL
        ORDER BY u.actual_date, ud.code COLLATE "C" LIMIT 1) ev
      WHERE ti.site_id = p_site AND ti.state IN ('locked', 'open', 'entry') AND NOT ti.is_na AND NOT ti.historical_no_source
        AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = ti.id AND o.state IN ('in_review', 'in_approval'))
        AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind = 'historical_no_source_na' AND o.reverted_at IS NOT NULL)
      ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"
    LOOP
      SELECT * INTO cur FROM public.task_instances WHERE id = t.id FOR UPDATE;
      CONTINUE WHEN cur.state NOT IN ('locked', 'open', 'entry') OR cur.is_na OR cur.historical_no_source;
      before := public.wf_snap(t.id);
      PERFORM public.hgd_mark('hns_task', t.id::text);
      UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = why, historical_no_source = true, historical_no_source_at = now(), admin_override = true,
        ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
        version = version + 1, updated_at = now()
      WHERE id = t.id;
      PERFORM public.hgd_unmark('hns_task');
      INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
      VALUES ('task', p_site, t.id, 'historical_no_source_na', left(btrim(p_reason), 2000), jsonb_build_object('state', cur.state::text),
              jsonb_build_object('state', 'na', 'na_reason', why, 'evidence_task', t.ev_code, 'evidence_date', t.ev_date), p_actor)
      RETURNING id INTO oid;
      INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
      VALUES (t.id, greatest(cur.current_level, 1), 'admin_override', p_actor,
              left(why || ': no date in the historical Master file and ' || t.ev_code || ' is approved on ' || t.ev_date::text || ' (admin override)'
                   || CASE WHEN p_catchup THEN ', migration 0126' ELSE '' END, 2000),
              true, left(btrim(p_reason), 2000), NOT coalesce(p_catchup, false), cur.state, 'na', clock_timestamp());
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
      VALUES ('task_historical_no_source_na', 'task', t.id::text, p_site, cur.region_id, before || jsonb_build_object('historical_no_source', false),
              public.wf_snap(t.id) || jsonb_build_object('historical_no_source', true, 'reason_code', 'historical_no_source', 'na_reason', why, 'task_code', t.code,
                'override_id', oid, 'evidence_task', t.ev_code, 'evidence_date', t.ev_date, 'catch_up', coalesce(p_catchup, false),
                'rule', 'no date in the historical Master file, and a later task of the workflow (a transitive successor) is approved with an actual date'),
              left(btrim(p_reason), 2000), p_actor, true);
      ids := ids || t.id;
      marked := marked || jsonb_build_array(jsonb_build_object('task_code', t.code, 'task_id', t.id, 'from', cur.state::text, 'evidence_code', t.ev_code, 'evidence_date', t.ev_date));
      n := n + 1;
    END LOOP;
    FOREACH i IN ARRAY ids LOOP PERFORM public.wf_unlock_successors(i); END LOOP;
    PERFORM set_config('pmis.calc_busy', was_busy, true);
    IF was_busy <> '1' THEN PERFORM public.calc_refresh_site(p_site); END IF;
    EXIT WHEN n = 0;
  END LOOP;
  -- the milestones that stay open with every predecessor done and no date among them (never invented: reported)
  SELECT coalesce(jsonb_agg(td.code ORDER BY sd.seq), '[]'::jsonb) INTO nodate
  FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task
  JOIN public.stage_definitions sd ON sd.id = td.stage_id
  WHERE ti.site_id = p_site AND ti.state IN ('open', 'entry') AND sd.code NOT IN (SELECT jsonb_array_elements_text(public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb)))
    AND EXISTS (SELECT 1 FROM public.ms_evaluate(ti.id) e WHERE NOT e.ready AND jsonb_array_length(e.reasons) = 0);   -- nothing waits, and no date
  RETURN jsonb_build_object('site_id', p_site, 'in_scope', true, 'marked', marked, 'milestones_without_date', nodate);
END $$;

CREATE OR REPLACE FUNCTION hns_restore_task(p_task uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; oid uuid; hold record; opened boolean := false;
BEGIN
  IF actor IS NULL OR NOT public.app_user_is_system_admin(actor) THEN
    RAISE EXCEPTION 'historical no source: only a System Admin restores the task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT (t.state = 'na' AND t.historical_no_source) THEN
    RETURN jsonb_build_object('task_id', p_task, 'outcome', 'not_marked');
  END IF;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = left(btrim(p_reason), 2000)
  WHERE task_id = p_task AND kind = 'historical_no_source_na' AND reverted_at IS NULL RETURNING id INTO oid;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('hns_restore', p_task::text);
  UPDATE public.task_instances SET state = 'locked', is_na = false, na_reason = NULL, current_level = 0, historical_no_source = false,
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('hns_restore');
  IF NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = p2.predecessor_id
                 WHERE p2.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped')) THEN
    SELECT * INTO hold FROM public.wf_gate_hold(p_task);
    IF hold.gate_code IS NOT NULL THEN
      UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code WHERE id = p_task;
    ELSE
      opened := public.wf_open_locked(p_task, 'restored from N/A (historical load: no source)');
    END IF;
  END IF;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, 1, 'override_revert', actor, left(p_why, 2000), true, left(btrim(p_reason), 2000), coalesce(p_stepup, false), 'na',
          (SELECT state FROM public.task_instances WHERE id = p_task), clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_historical_no_source_restore', 'task', p_task::text, t.site_id, t.region_id, before || jsonb_build_object('historical_no_source', true),
          public.wf_snap(p_task) || jsonb_build_object('historical_no_source', false, 'override_id', oid, 'opened', opened, 'why', p_why),
          left(btrim(p_reason), 2000), actor, true);
  PERFORM public.calc_refresh_site(t.site_id);
  RETURN jsonb_build_object('task_id', p_task, 'outcome', 'restored', 'override_id', oid, 'opened', opened);
END $$;

CREATE OR REPLACE FUNCTION hgd_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical load: the inferred date of a milestone is written only by GSDN Workspace (migration 0127)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_inferred_date AND (NEW.state IS DISTINCT FROM 'approved' OR NEW.actual_date IS DISTINCT FROM OLD.actual_date) THEN
    NEW.historical_inferred_date := false;
    -- the restore marker counts only when set by definer code (hgd_restore_milestone), never from a session-level GUC of another role
    IF NOT (current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hgd_restore', NEW.id::text) ELSE false END)) THEN
      UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = coalesce(public.app_actor(), acted_by),
        revert_reason = left('the milestone left its inferred date (' || NEW.state::text || coalesce(', ' || NEW.actual_date::text, '') || ')', 2000)
      WHERE task_id = NEW.id AND kind = 'historical_inferred_date' AND reverted_at IS NULL;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_historical_inferred_date_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('historical_inferred_date', true, 'state', OLD.state::text, 'actual_date', OLD.actual_date),
        jsonb_build_object('historical_inferred_date', false, 'state', NEW.state::text, 'actual_date', NEW.actual_date),
        'The milestone left its inferred date (' || NEW.state::text || '): the historical inferred-date mark is cleared.', public.app_actor());
    END IF;
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.historical_inferred_date, NEW.historical_inferred_at) IS NOT DISTINCT FROM (OLD.historical_inferred_date, OLD.historical_inferred_at) THEN RETURN NEW; END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hgd_task', NEW.id::text) ELSE false END)
     AND NEW.historical_inferred_date AND NOT OLD.historical_inferred_date AND NEW.state = 'approved' AND OLD.state IN ('locked', 'open') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical load: the inferred date of a milestone is written only by GSDN Workspace (migration 0127)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION hgd_guard_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hgd_gate', NEW.site_id::text || ':' || NEW.gate_code) ELSE false END) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical load: a gate opened by the historical load is written only by GSDN Workspace (migration 0127)' USING ERRCODE = 'insufficient_privilege';
END $$;

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
  -- 0127: a gate a historical load approved directly has moved past (an admin override of kind historical_gate_open, revertible) is open whatever its
  -- conditions say; the date is the one its other conditions give (the milestone before it at least); a Change Control suspension below still applies
  -- a stop work in force is never lifted by the historical override (security review of 0127): only the other conditions are
  IF blocked AND EXISTS (SELECT 1 FROM public.site_gate_state x WHERE x.site_id = p_site AND x.gate_code = p_gate AND x.historical_open_override IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(reasons, '[]'::jsonb)) z WHERE z ->> 'kind' = 'stop_work') THEN
    blocked := false; reasons := '[]'::jsonb;
  END IF;
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

CREATE OR REPLACE FUNCTION hgd_restore_milestone(p_task uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; before jsonb; oid uuid;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'historical gates and dates: only a System Admin takes an inferred date back' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT (t.state = 'approved' AND t.historical_inferred_date) THEN
    RETURN jsonb_build_object('task_id', p_task, 'outcome', 'not_marked');
  END IF;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = p_actor, revert_reason = left(btrim(p_reason), 2000)
  WHERE task_id = p_task AND kind = 'historical_inferred_date' AND reverted_at IS NULL RETURNING id INTO oid;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('hgd_restore', p_task::text);
  UPDATE public.task_instances SET state = 'open', actual_date = NULL, approved_date = NULL, current_level = 1, level_opened_at = now(), lock_reason = NULL,
    historical_inferred_date = false,
    admin_override = EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = p_task AND o.reverted_at IS NULL),
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('hgd_restore');
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, 1, 'override_revert', p_actor, left(p_why, 2000), true, left(btrim(p_reason), 2000), coalesce(p_stepup, false), 'approved', 'open', clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_historical_inferred_date_restore', 'task', p_task::text, t.site_id, t.region_id, before || jsonb_build_object('historical_inferred_date', true),
          public.wf_snap(p_task) || jsonb_build_object('historical_inferred_date', false, 'override_id', oid, 'why', p_why),
          left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(t.site_id);   -- returns at once inside a running calculation (hgd_settle_site recalculates the site itself)
  RETURN jsonb_build_object('task_id', p_task, 'outcome', 'restored', 'override_id', oid);
END $$;

CREATE OR REPLACE FUNCTION hgd_restore_gate(p_override uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.admin_overrides%ROWTYPE; s public.sites%ROWTYPE; mt record; gcode text;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'historical gates and dates: only a System Admin closes a gate opened by the historical load' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_override AND kind = 'historical_gate_open' FOR UPDATE;
  IF NOT FOUND OR o.reverted_at IS NOT NULL THEN RETURN jsonb_build_object('override_id', p_override, 'outcome', 'not_open'); END IF;
  gcode := o.after ->> 'gate';
  SELECT * INTO s FROM public.sites WHERE id = o.site_id;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = p_actor, revert_reason = left(btrim(p_reason), 2000) WHERE id = o.id;
  PERFORM public.hgd_mark('hgd_gate', o.site_id::text || ':' || gcode);
  UPDATE public.site_gate_state SET historical_open_override = NULL, historical_open_at = NULL
  WHERE site_id = o.site_id AND gate_code = gcode AND historical_open_override = o.id;
  PERFORM public.hgd_unmark('hgd_gate');
  SELECT ti.id, ti.state, ti.current_level INTO mt FROM public.task_instances ti
  JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task JOIN public.stage_definitions sd ON sd.id = td.stage_id
  JOIN public.phase_gate_rules r ON r.workflow_id = s.workflow_version_id AND r.link_code = gcode AND r.is_active AND r.to_code = sd.code
  WHERE ti.site_id = o.site_id LIMIT 1;
  IF mt.id IS NOT NULL THEN
    INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
    VALUES (mt.id, greatest(mt.current_level, 1), 'override_revert', p_actor, left(p_why || ' (gate ' || gcode || ')', 2000), true, left(btrim(p_reason), 2000),
            coalesce(p_stepup, false), mt.state, mt.state, clock_timestamp());
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('site_historical_gate_restore', 'site', o.site_id::text, o.site_id, s.region_id, jsonb_build_object('gate', gcode, 'historical_open', true, 'override_id', o.id),
          jsonb_build_object('gate', gcode, 'historical_open', false, 'override_id', o.id, 'why', p_why), left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(o.site_id);
  RETURN jsonb_build_object('override_id', o.id, 'outcome', 'closed');
END $$;

CREATE OR REPLACE FUNCTION hgd_settle_site(p_site uuid, p_actor uuid, p_reason text, p_catchup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; g record; gev record; mev record; e record; m record; mt record; cur public.task_instances%ROWTYPE; before jsonb; oid uuid;
  ids uuid[]; i uuid; n int; rounds int := 0; r jsonb;
  gates jsonb := '[]'::jsonb; mss jsonb := '[]'::jsonb; restored jsonb := '[]'::jsonb; marked jsonb := '[]'::jsonb;
  manual jsonb := public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb);
  was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
  rs text := left(btrim(coalesce(p_reason, 'historical load')), 2000);
  why constant text := 'inferred date — historical load';
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'historical gates and dates: only the System Admin of the historical load runs the rule' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.hns_site_in_scope(p_site) THEN
    RETURN jsonb_build_object('site_id', p_site, 'in_scope', false, 'gates', gates, 'milestones', mss, 'restored', restored, 'marked', marked, 'rounds', 0);
  END IF;
  LOOP
    rounds := rounds + 1;
    EXIT WHEN rounds > 12;
    -- (1) 0126: a task with no date the site moved past is N/A "historical load: no source" (its own rounds and recalculation)
    r := public.hns_mark_site(p_site, p_actor, rs, p_catchup);
    marked := marked || coalesce(r -> 'marked', '[]'::jsonb);
    n := jsonb_array_length(coalesce(r -> 'marked', '[]'::jsonb));
    ids := ARRAY[]::uuid[];
    PERFORM set_config('pmis.calc_busy', '1', true);

    -- (2) an inferred milestone that has a date of its own now goes back to its normal rule (the calculation below approves it with that date)
    FOR m IN
      SELECT ti.id, td.code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site AND ti.historical_inferred_date AND ti.state = 'approved' ORDER BY sd.seq
    LOOP
      SELECT * INTO mev FROM public.ms_evaluate(m.id);
      CONTINUE WHEN NOT coalesce(mev.ready, false);
      PERFORM public.hgd_restore_milestone(m.id, p_actor, rs,
        'the milestone has a date of its own now (' || mev.ms_date::text || '): the inferred date of the historical load is taken back', NOT coalesce(p_catchup, false));
      restored := restored || to_jsonb(m.code);
      n := n + 1;
    END LOOP;

    -- (3) the gates the site moved past: blocked by their conditions (not by a suspension), a task they hold or a later one approved with a date
    FOR g IN SELECT x.link_code, x.to_code FROM public.phase_gate_rules x WHERE x.workflow_id = s.workflow_version_id AND x.is_active ORDER BY x.seq LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.site_gate_state y WHERE y.site_id = p_site AND y.gate_code = g.link_code AND y.historical_open_override IS NOT NULL);
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.site_id = p_site AND o.kind = 'historical_gate_open' AND o.after ->> 'gate' = g.link_code
                              AND o.reverted_at IS NOT NULL);   -- reverted by a System Admin: never opened again
      SELECT * INTO gev FROM public.gate_eval(p_site, g.link_code);
      CONTINUE WHEN gev.status IS DISTINCT FROM 'blocked'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(gev.reasons, '[]'::jsonb)) z WHERE z ->> 'kind' IN ('suspension', 'stop_work'));
      SELECT * INTO e FROM public.hgd_evidence(p_site, s.workflow_version_id,
        ARRAY(SELECT td.id FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id
              WHERE sd.workflow_id = s.workflow_version_id AND sd.code = g.to_code AND NOT public.gate_lock_exempt(td.code)));
      CONTINUE WHEN e.code IS NULL;
      INSERT INTO public.admin_overrides (entity, site_id, kind, reason, before, after, acted_by)
      VALUES ('site', p_site, 'historical_gate_open', rs, jsonb_build_object('gate', g.link_code, 'status', 'blocked', 'reasons', coalesce(gev.reasons, '[]'::jsonb)),
              jsonb_build_object('gate', g.link_code, 'status', 'open', 'evidence_task', e.code, 'evidence_date', e.actual_date), p_actor)
      RETURNING id INTO oid;
      PERFORM public.hgd_mark('hgd_gate', p_site::text || ':' || g.link_code);
      INSERT INTO public.site_gate_state (site_id, gate_code, is_open, status, gate_date, historical_open_override, historical_open_at)
      VALUES (p_site, g.link_code, false, gev.status, gev.gate_date, oid, now())
      ON CONFLICT (site_id, gate_code) DO UPDATE SET historical_open_override = EXCLUDED.historical_open_override, historical_open_at = EXCLUDED.historical_open_at;
      PERFORM public.hgd_unmark('hgd_gate');
      SELECT ti.id, ti.state, ti.current_level INTO mt FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task JOIN public.stage_definitions sd ON sd.id = td.stage_id AND sd.code = g.to_code
      WHERE ti.site_id = p_site LIMIT 1;
      IF mt.id IS NOT NULL THEN
        INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
        VALUES (mt.id, greatest(mt.current_level, 1), 'admin_override', p_actor,
                left('historical load: the gate ' || g.link_code || ' is open, the site moved past it (' || e.code || ' is approved on ' || e.actual_date::text
                     || '; admin override)' || CASE WHEN p_catchup THEN ', migration 0127' ELSE '' END, 2000),
                true, rs, NOT coalesce(p_catchup, false), mt.state, mt.state, clock_timestamp());
      END IF;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
      VALUES ('site_historical_gate_open', 'site', p_site::text, p_site, s.region_id,
              jsonb_build_object('gate', g.link_code, 'status', gev.status, 'reasons', coalesce(gev.reasons, '[]'::jsonb), 'historical_open', false),
              jsonb_build_object('gate', g.link_code, 'status', 'open', 'historical_open', true, 'reason_code', 'historical_gate_open', 'override_id', oid,
                'evidence_task', e.code, 'evidence_date', e.actual_date, 'catch_up', coalesce(p_catchup, false),
                'rule', 'a gate of a site of a historical load approved directly is open when a task it holds, or a later one, is approved with an actual date'),
              rs, p_actor, true);
      gates := gates || jsonb_build_array(jsonb_build_object('gate', g.link_code, 'evidence_code', e.code, 'evidence_date', e.actual_date, 'override_id', oid));
      n := n + 1;
    END LOOP;

    -- (4) the calculated milestones with no date of their own (nothing waits, none of their predecessors is dated) the site moved past
    FOR m IN
      SELECT ti.id, td.id AS def_id, td.code FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task AND td.workflow_id = s.workflow_version_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site AND ti.state IN ('locked', 'open') AND NOT ti.is_na AND NOT (manual ? sd.code)
        AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind = 'historical_inferred_date' AND o.reverted_at IS NOT NULL)
      ORDER BY sd.seq
    LOOP
      SELECT * INTO mev FROM public.ms_evaluate(m.id);
      CONTINUE WHEN coalesce(mev.ready, false) OR jsonb_array_length(coalesce(mev.reasons, '[]'::jsonb)) > 0;   -- a real date, or something still waits
      SELECT * INTO e FROM public.hgd_evidence(p_site, s.workflow_version_id, ARRAY[m.def_id]);
      CONTINUE WHEN e.code IS NULL;
      SELECT * INTO cur FROM public.task_instances WHERE id = m.id FOR UPDATE;
      CONTINUE WHEN cur.state NOT IN ('locked', 'open') OR cur.is_na OR cur.historical_inferred_date;
      before := public.wf_snap(m.id);
      PERFORM public.hgd_mark('hgd_task', m.id::text);
      UPDATE public.task_instances SET state = 'approved', actual_date = e.actual_date, approved_date = public.cal_today(), current_level = levels_required,
        ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
        admin_override = true, historical_inferred_date = true, historical_inferred_at = now(), version = version + 1, updated_at = now()
      WHERE id = m.id;
      PERFORM public.hgd_unmark('hgd_task');
      INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
      VALUES ('task', p_site, m.id, 'historical_inferred_date', rs, jsonb_build_object('state', cur.state::text, 'actual_date', cur.actual_date),
              jsonb_build_object('state', 'approved', 'actual_date', e.actual_date, 'note', why, 'evidence_task', e.code, 'evidence_date', e.actual_date), p_actor)
      RETURNING id INTO oid;
      INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
      VALUES (m.id, greatest(cur.current_level, 1), 'admin_override', p_actor,
              left(why || ': no date of its own (every predecessor approved or N/A, none dated); the date of the earliest later task approved, ' || e.code || ' on '
                   || e.actual_date::text || ' (admin override)' || CASE WHEN p_catchup THEN ', migration 0127' ELSE '' END, 2000),
              true, rs, NOT coalesce(p_catchup, false), cur.state, 'approved', clock_timestamp());
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
      VALUES ('task_historical_inferred_date', 'task', m.id::text, p_site, cur.region_id, before || jsonb_build_object('historical_inferred_date', false),
              public.wf_snap(m.id) || jsonb_build_object('historical_inferred_date', true, 'reason_code', 'historical_inferred_date', 'note', why, 'task_code', m.code,
                'override_id', oid, 'evidence_task', e.code, 'evidence_date', e.actual_date, 'catch_up', coalesce(p_catchup, false),
                'rule', 'a milestone with no date of its own takes the date of the earliest later task approved with an actual date'),
              rs, p_actor, true);
      ids := ids || m.id;
      mss := mss || jsonb_build_array(jsonb_build_object('task_code', m.code, 'actual_date', e.actual_date, 'evidence_code', e.code, 'override_id', oid));
      n := n + 1;
    END LOOP;

    FOREACH i IN ARRAY ids LOOP PERFORM public.wf_unlock_successors(i); END LOOP;
    PERFORM set_config('pmis.calc_busy', was_busy, true);
    IF was_busy <> '1' THEN PERFORM public.calc_refresh_site(p_site); END IF;
    EXIT WHEN n = 0;
  END LOOP;
  RETURN jsonb_build_object('site_id', p_site, 'in_scope', true, 'gates', gates, 'milestones', mss, 'restored', restored, 'marked', marked, 'rounds', rounds);
END $$;

CREATE OR REPLACE FUNCTION hgd_apply_sites(p_sites uuid[], p_reason text, p_catchup boolean, p_run uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sid uuid; who uuid; r jsonb; e jsonb; uid text := current_setting('app.user_id', true); rg text := current_setting('app.region_ids', true);
  n_scope int := 0; n_changed int := 0; n_left int := 0; n_gates int := 0; n_ms int := 0; n_back int := 0; n_tasks int := 0;
  by_gate jsonb := '{}'::jsonb; by_ms jsonb := '{}'::jsonb; by_code jsonb := '{}'::jsonb; nodate jsonb := '{}'::jsonb; waiting jsonb := '{}'::jsonb;
  st_before jsonb := '{}'::jsonb; st_after jsonb := '{}'::jsonb; k text; w text; c text; ms_before int; ms_after int; res jsonb; actor uuid := public.app_actor();
BEGIN
  IF coalesce(p_catchup, false) THEN
    IF NOT public.app_ctx_legacy() THEN
      RAISE EXCEPTION 'historical gates and dates: the catch-up runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF actor IS NULL OR NOT public.app_user_is_system_admin(actor) THEN
    RAISE EXCEPTION 'historical gates and dates: only the System Admin of the historical load runs the rule' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO ms_before FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (p_sites) AND t.state = 'approved';
  IF coalesce(p_catchup, false) THEN PERFORM set_config('app.region_ids', '*', true); END IF;
  FOR sid IN SELECT DISTINCT x FROM unnest(coalesce(p_sites, ARRAY[]::uuid[])) x WHERE x IS NOT NULL ORDER BY x LOOP
    CONTINUE WHEN NOT public.hns_site_in_scope(sid);
    n_scope := n_scope + 1;
    k := public.hns_current_stage(sid);
    st_before := jsonb_set(st_before, ARRAY[k], to_jsonb(coalesce((st_before ->> k)::int, 0) + 1));
    who := CASE WHEN coalesce(p_catchup, false) THEN public.hns_site_loader(sid) ELSE actor END;
    IF who IS NULL THEN
      n_left := n_left + 1;
    ELSE
      IF coalesce(p_catchup, false) THEN PERFORM set_config('app.user_id', who::text, true); END IF;
      BEGIN
        r := public.hgd_settle_site(sid, who, p_reason, p_catchup);
      EXCEPTION WHEN others THEN   -- one site never stops the load or the update of the server: reported in the System Log and counted
        PERFORM public.hgd_unmark('hgd_task');
        PERFORM public.hgd_unmark('hgd_gate');
        PERFORM public.hgd_unmark('hgd_restore');
        PERFORM public.hgd_unmark('hns_task');
        PERFORM set_config('pmis.calc_busy', '', true);
        PERFORM public.log_system_write('warn', 'master-import', 'historical load: the gates and dates rule could not run on a site',
          jsonb_build_object('site_id', sid, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), who, NULL);
        r := jsonb_build_object('gates', '[]'::jsonb, 'milestones', '[]'::jsonb, 'restored', '[]'::jsonb, 'marked', '[]'::jsonb, 'failed', true);
        n_left := n_left + 1;
      END;
      IF jsonb_array_length(r -> 'gates') + jsonb_array_length(r -> 'milestones') + jsonb_array_length(r -> 'restored') + jsonb_array_length(r -> 'marked') > 0 THEN
        n_changed := n_changed + 1;
      END IF;
      FOR e IN SELECT x FROM jsonb_array_elements(r -> 'gates') x LOOP
        n_gates := n_gates + 1;
        by_gate := jsonb_set(by_gate, ARRAY[e ->> 'gate'], to_jsonb(coalesce((by_gate ->> (e ->> 'gate'))::int, 0) + 1));
      END LOOP;
      FOR e IN SELECT x FROM jsonb_array_elements(r -> 'milestones') x LOOP
        n_ms := n_ms + 1;
        by_ms := jsonb_set(by_ms, ARRAY[e ->> 'task_code'], to_jsonb(coalesce((by_ms ->> (e ->> 'task_code'))::int, 0) + 1));
      END LOOP;
      n_back := n_back + jsonb_array_length(r -> 'restored');
      FOR e IN SELECT x FROM jsonb_array_elements(r -> 'marked') x LOOP
        n_tasks := n_tasks + 1;
        by_code := jsonb_set(by_code, ARRAY[e ->> 'task_code'], to_jsonb(coalesce((by_code ->> (e ->> 'task_code'))::int, 0) + 1));
      END LOOP;
    END IF;
    k := public.hns_current_stage(sid);
    st_after := jsonb_set(st_after, ARRAY[k], to_jsonb(coalesce((st_after ->> k)::int, 0) + 1));
    IF k <> 'done' THEN   -- what the current stage still waits for
      w := coalesce(public.hgd_waiting(sid), '?');
      waiting := jsonb_set(waiting, ARRAY[k], coalesce(waiting -> k, '{}'::jsonb) || jsonb_build_object(w, coalesce((waiting -> k ->> w)::int, 0) + 1));
    END IF;
    FOR c IN   -- the milestones still open with nothing waiting and no date (no later task approved with a date, or reverted)
      SELECT td.code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = sid AND ti.state IN ('open', 'entry') AND sd.code NOT IN (SELECT jsonb_array_elements_text(public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb)))
        AND EXISTS (SELECT 1 FROM public.ms_evaluate(ti.id) x WHERE NOT x.ready AND jsonb_array_length(x.reasons) = 0)
    LOOP
      nodate := jsonb_set(nodate, ARRAY[c], to_jsonb(coalesce((nodate ->> c)::int, 0) + 1));
    END LOOP;
  END LOOP;
  IF coalesce(p_catchup, false) THEN
    PERFORM set_config('app.user_id', coalesce(uid, ''), true);
    PERFORM set_config('app.region_ids', coalesce(rg, ''), true);
  END IF;
  SELECT count(*) INTO ms_after FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (p_sites) AND t.state = 'approved';
  res := jsonb_build_object('sites_in_scope', n_scope, 'sites_changed', n_changed, 'sites_left', n_left,
    'gates_opened', n_gates, 'gates_opened_by_gate', by_gate, 'milestones_inferred', n_ms, 'milestones_inferred_by_code', by_ms, 'inferred_taken_back', n_back,
    'tasks_na', n_tasks, 'tasks_na_by_code', by_code, 'milestones_approved_before', ms_before, 'milestones_approved_after', ms_after,
    'current_stage_before', st_before, 'current_stage_after', st_after, 'waiting_after', waiting, 'milestones_without_date', nodate,
    'catch_up', coalesce(p_catchup, false));
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  VALUES (CASE WHEN coalesce(p_catchup, false) THEN 'historical_gates_dates_catch_up' ELSE 'historical_gates_dates_apply' END,
          CASE WHEN p_run IS NULL THEN 'site' ELSE 'master_reconciliation_run' END, coalesce(p_run::text, 'all'),
          jsonb_build_object('milestones_approved', ms_before, 'current_stage', st_before),
          res || jsonb_build_object('rule', 'on a site of a historical load approved directly, a gate the site moved past (a task it holds or a later one approved with an actual date) is open, and a milestone with no date of its own takes the date of the earliest later task approved with an actual date; both are admin overrides, revertible'),
          left(coalesce(btrim(p_reason), 'historical load'), 2000), CASE WHEN coalesce(p_catchup, false) THEN NULL ELSE actor END, true);
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION hns_apply_sites(p_sites uuid[], p_reason text, p_catchup boolean, p_run uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sid uuid; who uuid; r jsonb; e jsonb; uid text := current_setting('app.user_id', true); rg text := current_setting('app.region_ids', true);
  n_scope int := 0; n_changed int := 0; n_left int := 0; n_tasks int := 0; by_code jsonb := '{}'::jsonb; nodate jsonb := '{}'::jsonb;
  st_before jsonb := '{}'::jsonb; st_after jsonb := '{}'::jsonb; k text; ms_before int; ms_after int; res jsonb; actor uuid := public.app_actor();
BEGIN
  IF coalesce(p_catchup, false) THEN
    IF NOT public.app_ctx_legacy() THEN
      RAISE EXCEPTION 'historical no source: the catch-up runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF actor IS NULL OR NOT public.app_user_is_system_admin(actor) THEN
    RAISE EXCEPTION 'historical no source: only the System Admin of the historical load runs the rule' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO ms_before FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (p_sites) AND t.state = 'approved';
  IF coalesce(p_catchup, false) THEN PERFORM set_config('app.region_ids', '*', true); END IF;
  FOR sid IN SELECT DISTINCT x FROM unnest(coalesce(p_sites, ARRAY[]::uuid[])) x WHERE x IS NOT NULL ORDER BY x LOOP
    CONTINUE WHEN NOT public.hns_site_in_scope(sid);
    n_scope := n_scope + 1;
    k := public.hns_current_stage(sid);
    st_before := jsonb_set(st_before, ARRAY[k], to_jsonb(coalesce((st_before ->> k)::int, 0) + 1));
    who := CASE WHEN coalesce(p_catchup, false) THEN public.hns_site_loader(sid) ELSE actor END;
    IF who IS NULL THEN
      n_left := n_left + 1;
    ELSE
      IF coalesce(p_catchup, false) THEN PERFORM set_config('app.user_id', who::text, true); END IF;
      BEGIN
        r := public.hns_mark_site(sid, who, p_reason, p_catchup);
      EXCEPTION WHEN others THEN   -- one site never stops the load or the update of the server: reported in the System Log and counted
        PERFORM public.hgd_unmark('hns_task');
        PERFORM public.log_system_write('warn', 'master-import', 'historical load: the no-source rule could not run on a site',
          jsonb_build_object('site_id', sid, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), who, NULL);
        r := jsonb_build_object('marked', '[]'::jsonb, 'milestones_without_date', '[]'::jsonb, 'failed', true);
        n_left := n_left + 1;
      END;
      IF jsonb_array_length(r -> 'marked') > 0 THEN n_changed := n_changed + 1; END IF;
      FOR e IN SELECT x FROM jsonb_array_elements(r -> 'marked') x LOOP
        n_tasks := n_tasks + 1;
        by_code := jsonb_set(by_code, ARRAY[e ->> 'task_code'], to_jsonb(coalesce((by_code ->> (e ->> 'task_code'))::int, 0) + 1));
      END LOOP;
      FOR e IN SELECT x FROM jsonb_array_elements(r -> 'milestones_without_date') x LOOP
        nodate := jsonb_set(nodate, ARRAY[e #>> '{}'], to_jsonb(coalesce((nodate ->> (e #>> '{}'))::int, 0) + 1));
      END LOOP;
    END IF;
    k := public.hns_current_stage(sid);
    st_after := jsonb_set(st_after, ARRAY[k], to_jsonb(coalesce((st_after ->> k)::int, 0) + 1));
  END LOOP;
  IF coalesce(p_catchup, false) THEN
    PERFORM set_config('app.user_id', coalesce(uid, ''), true);
    PERFORM set_config('app.region_ids', coalesce(rg, ''), true);
  END IF;
  SELECT count(*) INTO ms_after FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (p_sites) AND t.state = 'approved';
  res := jsonb_build_object('sites_in_scope', n_scope, 'sites_changed', n_changed, 'sites_left', n_left, 'tasks_na', n_tasks, 'tasks_na_by_code', by_code,
    'milestones_approved_before', ms_before, 'milestones_approved_after', ms_after, 'milestones_without_date', nodate,
    'current_stage_before', st_before, 'current_stage_after', st_after, 'catch_up', coalesce(p_catchup, false));
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  VALUES (CASE WHEN coalesce(p_catchup, false) THEN 'historical_no_source_catch_up' ELSE 'historical_no_source_apply' END,
          CASE WHEN p_run IS NULL THEN 'site' ELSE 'master_reconciliation_run' END, coalesce(p_run::text, 'all'),
          jsonb_build_object('milestones_approved', ms_before, 'current_stage', st_before),
          res || jsonb_build_object('rule', 'a task with no date in the historical Master file is N/A "historical load: no source" when a later task of the site (a transitive successor in the workflow) is approved with an actual date; no date is invented'),
          left(coalesce(btrim(p_reason), 'historical load'), 2000), CASE WHEN coalesce(p_catchup, false) THEN NULL ELSE actor END, true);
  IF NOT coalesce(p_catchup, false) THEN
    -- 0127: then the gates and the milestones without a date of the same sites, until nothing changes (hgd_apply_sites, its own summary row); a failure is
    -- written to the System Log and never undoes the load or the N/A marks
    BEGIN
      res := res || jsonb_build_object('gates_dates', public.hgd_apply_sites(p_sites, p_reason, false, p_run));
    EXCEPTION WHEN others THEN
      PERFORM public.log_system_write('warn', 'master-import', 'historical load: the gates and dates rule could not run',
        jsonb_build_object('run_id', p_run, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor, NULL);
    END;
  END IF;
  RETURN res;
END $$;

-- Ownership and rights of the new objects
ALTER TABLE hgd_marks OWNER TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hgd_mark(text,text)', 'hgd_unmark(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;
-- hgd_marked only answers whether this transaction holds a marker that definer code wrote (it writes nothing); the guard triggers call it, and the
-- executor checks the right on any role that fires them, so it stays executable (a marker can only be written through hgd_mark, closed to PUBLIC)
ALTER FUNCTION hgd_marked(text, text) OWNER TO pmis_definer;
