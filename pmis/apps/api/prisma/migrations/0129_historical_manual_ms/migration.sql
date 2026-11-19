-- 0129_historical_manual_ms: in the historical Master load approved directly, a manual milestone (Site RFI, MS4, and any milestone of calc.milestone_manual)
-- that the site has moved past is approved directly with its pre-filled date, as an admin override that the existing revert door takes back; and the
-- historical direct-approval path and its catch-ups no longer send a notice per task (owner decision "Option 2", 2026-11-19; CHANGELOG 168; contract 0.15.40).
-- Mirror: db/sql/128_historical_manual_ms.sql (kept byte-identical).
--
-- WHY (production after 0127): the catch-up opened 317 gates (G3) and inferred 123 dates (MS1); the milestones approved went from 399 to 957. The current
-- stage of the 345 sites of the historical load is now MS1 21, MS2 7, MS3 1 and MS4 316, and on those 316 Site RFI "waits for its L2 approval": the date is
-- pre-filled (the latest condition date, Q38) but the task is open, never submitted, so it is not even in Approvals, while the TE work after it is approved
-- with dates. And the owner counted 6273 unread notifications: the direct approval and the catch-ups open successors one by one, and each opening sends
-- "A task is ready to start" (or "No holder for a task level" to every System Admin) about a site whose work is long done.
--
-- OWNER DECISION "Option 2" (2026-11-19). On a site of a historical Master load approved directly (0126 scope hns_site_in_scope), a manual milestone
-- (calc.milestone_manual, default ["MS4"]) that is open, in entry, or locked but ready, is approved DIRECTLY with its pre-filled date when the site has moved
-- past it: a task after it (a transitive successor in the 0127 "after" graph hgd_after_defs, gate links included) is approved with an actual date. Admin
-- override, audited, revertible, like 0126 / 0127. When it has no pre-filled date (every predecessor approved or N/A, none dated), the 0127 inferred-date rule
-- gives the date (the earliest later task approved with an actual date), flagged inferred. Never on a live site; never a milestone a person submitted (in
-- review or approval), rejected or suspended; never a date a person typed (an actual date that is not the pre-filled one); never approved twice; never
-- again once a System Admin reverted it.
--
-- WHAT APPROVING DOES (milestone task M of site S): state approved, actual_date = the pre-filled date (or the inferred one), approved today, admin_override
-- true (the "Admin override" badge; the calculation never moves the date of an approved manual milestone), the new flags task_instances.historical_manual_ms
-- (+ time) and historical_manual_ms_inferred (the date was inferred) — guard hmm_guard_task, as hgd_guard_task of 0127/0128. One admin_overrides row (entity
-- task, kind historical_manual_ms_approved, before {state, actual_date, prefilled_date}, after {state approved, actual_date, date_source prefilled|inferred,
-- note, evidence_task, evidence_date}), one workflow step admin_override, one audit row task_historical_manual_ms_approved with the evidence. Then its
-- successors unlock. Any other path that changes its date or takes it out of approved clears the flags and closes the override (audit row
-- task_historical_manual_ms_cleared). The flag is new rather than historical_direct_approved (0092): that flag means "approved from a row of a historical
-- batch" and carries the batch (its guard checks the row and the batch); here no row of the file approves the milestone, the rule does, so it has its own
-- flag and its own override kind, which the revert door takes back.
--
-- WHEN IT RUNS: in the settle loop of 0127 (hgd_settle_site, last redefined by 0128), as a fifth step of every round, so the gates, the N/A marks, the inferred
-- dates and the manual milestones iterate until nothing changes (a Site RFI approved lets the gate after it open on the TE evidence, TE Completion follow ...):
--   (a) the one-time catch-up of this migration (hmm_catch_up), on every site in scope, as the System Admin who loaded it; one summary audit row
--       historical_manual_ms_catch_up (the counts of the settle loop plus manual_ms_approved, manual_ms_approved_by_code, manual_ms_inferred, the current
--       stage before and after and waiting_after);
--   (b) at the end of every historical load approved directly, through the existing hooks (hns_apply_sites -> hgd_apply_sites at the end of mi_apply_run and
--       of the last background send); the summary row historical_gates_dates_apply now holds the same new counts.
--
-- RESTORE: POST /overrides/{override_id}/revert (admin_override_revert: a System Admin, never a delegate, a reason, a step-up): the milestone is open again with
-- its pre-filled date (no date when the date was inferred), the flags go, admin_override stays only while another override of the task is active, one
-- workflow step override_revert, one audit row task_historical_manual_ms_restore. The team then submits it for L2 as before. A reverted milestone is never
-- approved by the rule again. The tasks opened after it stay open (Q81, as 0127).
--
-- NOTIFICATIONS. wf_notify (0092) skipped only the notice of the task a direct-approval row had just submitted, behind the session setting pmis.hda_quiet.
-- Now: (1) that marker is a row of hgd_marks (0128), written by imp_submit_stream_rows through hgd_mark, never a session setting; (2) a second definer-only
-- marker, hist_quiet = <site id>, is held while a row of a batch approved directly is submitted and approved (imp_submit_stream_rows) and while the
-- historical rules settle a site (hns_apply_sites around hns_mark_site, hgd_settle_site): every per-task notice of that site (task opened, no holder, gate
-- closed again, ...) is skipped then. Everywhere else, and for every other site, notices are unchanged. Existing notifications are never deleted.
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0129"): hgd_settle_site (0128), hgd_apply_sites (0128), hns_apply_sites
-- (0128), ao_current_matches (0127), admin_override_revert (0127), imp_submit_stream_rows (0092), wf_notify (0092). CREATE OR REPLACE keeps their owner and
-- grants (admin_override_revert stays the API door).
--
-- Function rules: SECURITY DEFINER (except the flag guard, which runs as its writer like hgd_guard_task), search_path = pg_catalog, public, pg_temp, owner
-- pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to pmis_app; no new table right. Contract 0.15.40: the override kind
-- historical_manual_ms_approved (Override.kind).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The flags of the manual milestone approved directly
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN historical_manual_ms boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_manual_ms_at timestamptz,
  ADD COLUMN historical_manual_ms_inferred boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT task_instances_hmm_check CHECK (NOT historical_manual_ms OR (state = 'approved' AND historical_manual_ms_at IS NOT NULL)),
  ADD CONSTRAINT task_instances_hmm_inferred_check CHECK (NOT historical_manual_ms_inferred OR historical_manual_ms);
CREATE INDEX task_instances_hmm_idx ON task_instances (site_id) WHERE historical_manual_ms;
COMMENT ON COLUMN task_instances.historical_manual_ms IS '0129: a manual milestone (Site RFI) the site moved past, approved directly with its pre-filled date by the historical load (admin override, reversible through POST /overrides/{id}/revert)';
COMMENT ON COLUMN task_instances.historical_manual_ms_inferred IS '0129: the milestone had no pre-filled date: the date is the one of the earliest later task approved (inferred date - historical load)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (historical_manual_ms, historical_manual_ms_at, historical_manual_ms_inferred),
           UPDATE (historical_manual_ms, historical_manual_ms_at, historical_manual_ms_inferred) ON task_instances FROM pmis_app;
  END IF;
END $$;

-- The guard of the flags (runs as its writer, like hgd_guard_task). The flags are set only by hgd_settle_site (current user pmis_definer AND the definer-only
-- marker hmm_task of this task in hgd_marks, from locked / open / entry to approved). When the milestone leaves approved or its date changes by any path the
-- flags go (audited and its override closed, unless the restore of hmm_restore_task does it: current user pmis_definer AND the marker hmm_restore of this task).
CREATE OR REPLACE FUNCTION hmm_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical load: the direct approval of a manual milestone is written only by GSDN Workspace (migration 0129)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_manual_ms AND (NEW.state IS DISTINCT FROM 'approved' OR NEW.actual_date IS DISTINCT FROM OLD.actual_date) THEN
    NEW.historical_manual_ms := false;
    NEW.historical_manual_ms_inferred := false;
    -- the restore marker counts only when written by definer code (hmm_restore_task) in this transaction, never from a session setting
    IF NOT (current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hmm_restore', NEW.id::text) ELSE false END)) THEN
      UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = coalesce(public.app_actor(), acted_by),
        revert_reason = left('the milestone left its direct approval (' || NEW.state::text || coalesce(', ' || NEW.actual_date::text, '') || ')', 2000)
      WHERE task_id = NEW.id AND kind = 'historical_manual_ms_approved' AND reverted_at IS NULL;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_historical_manual_ms_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('historical_manual_ms', true, 'state', OLD.state::text, 'actual_date', OLD.actual_date),
        jsonb_build_object('historical_manual_ms', false, 'state', NEW.state::text, 'actual_date', NEW.actual_date),
        'The milestone left its direct approval of the historical load (' || NEW.state::text || '): the mark is cleared.', public.app_actor());
    END IF;
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.historical_manual_ms, NEW.historical_manual_ms_at, NEW.historical_manual_ms_inferred)
     IS NOT DISTINCT FROM (OLD.historical_manual_ms, OLD.historical_manual_ms_at, OLD.historical_manual_ms_inferred) THEN
    RETURN NEW;
  END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hmm_task', NEW.id::text) ELSE false END)
     AND NEW.historical_manual_ms AND NOT OLD.historical_manual_ms AND NEW.state = 'approved' AND OLD.state IN ('locked', 'open', 'entry') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical load: the direct approval of a manual milestone is written only by GSDN Workspace (migration 0129)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER hmm_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.historical_manual_ms OR NEW.historical_manual_ms_at IS NOT NULL OR NEW.historical_manual_ms_inferred) EXECUTE FUNCTION hmm_guard_task();
CREATE TRIGGER hmm_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.historical_manual_ms IS DISTINCT FROM OLD.historical_manual_ms OR NEW.historical_manual_ms_at IS DISTINCT FROM OLD.historical_manual_ms_at
        OR NEW.historical_manual_ms_inferred IS DISTINCT FROM OLD.historical_manual_ms_inferred
        OR (OLD.historical_manual_ms AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.actual_date IS DISTINCT FROM OLD.actual_date)))
  EXECUTE FUNCTION hmm_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The restore of one milestone (internal): the revert door
-- ---------------------------------------------------------------------------------------------------------------------
-- The milestone is open again with its pre-filled date (no date when the date was inferred), at L1, the flags gone; never approved by the rule again.
CREATE OR REPLACE FUNCTION hmm_restore_task(p_task uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; o public.admin_overrides%ROWTYPE; before jsonb; back date;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'historical manual milestone: only a System Admin takes the direct approval back' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT (t.state = 'approved' AND t.historical_manual_ms) THEN
    RETURN jsonb_build_object('task_id', p_task, 'outcome', 'not_marked');
  END IF;
  SELECT * INTO o FROM public.admin_overrides WHERE task_id = p_task AND kind = 'historical_manual_ms_approved' AND reverted_at IS NULL
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  back := CASE WHEN o.after ->> 'date_source' = 'prefilled' THEN nullif(o.after ->> 'actual_date', '')::date END;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = p_actor, revert_reason = left(btrim(p_reason), 2000)
  WHERE task_id = p_task AND kind = 'historical_manual_ms_approved' AND reverted_at IS NULL;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('hmm_restore', p_task::text);
  UPDATE public.task_instances SET state = 'open', actual_date = back, approved_date = NULL, current_level = 1, level_opened_at = now(), lock_reason = NULL,
    values = CASE WHEN back IS NULL THEN values ELSE coalesce(values, '{}'::jsonb) || jsonb_build_object('prefilled_date', back, 'prefilled', true) END,
    historical_manual_ms = false, historical_manual_ms_inferred = false,
    admin_override = EXISTS (SELECT 1 FROM public.admin_overrides x WHERE x.task_id = p_task AND x.reverted_at IS NULL),
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('hmm_restore');
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, 1, 'override_revert', p_actor, left(p_why, 2000), true, left(btrim(p_reason), 2000), coalesce(p_stepup, false), 'approved', 'open', clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_historical_manual_ms_restore', 'task', p_task::text, t.site_id, t.region_id, before || jsonb_build_object('historical_manual_ms', true),
          public.wf_snap(p_task) || jsonb_build_object('historical_manual_ms', false, 'override_id', o.id, 'restored_date', back, 'why', p_why),
          left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(t.site_id);
  RETURN jsonb_build_object('task_id', p_task, 'outcome', 'restored', 'override_id', o.id, 'actual_date', back);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. One site until nothing changes (hgd_settle_site: latest 0128, changes marked 0129: the fifth step, the notice marker of the site)
-- ---------------------------------------------------------------------------------------------------------------------
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
  whym constant text := 'pre-filled date approved directly — historical load';   -- 0129
  hold record; d date; pre date; inf boolean; mm jsonb := '[]'::jsonb;              -- 0129: the manual milestones approved directly
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'historical gates and dates: only the System Admin of the historical load runs the rule' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.hns_site_in_scope(p_site) THEN
    RETURN jsonb_build_object('site_id', p_site, 'in_scope', false, 'gates', gates, 'milestones', mss, 'restored', restored, 'marked', marked, 'manual', mm, 'rounds', 0);
  END IF;
  -- 0129: no per-task notice for this site while the historical rules settle it (definer-only marker read by wf_notify)
  PERFORM public.hgd_mark('hist_quiet', p_site::text);
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

    -- (5) 0129: the manual milestones (calc.milestone_manual: Site RFI) the site moved past (a later task approved with an actual date), approved directly with
    -- the pre-filled date; with none (every predecessor approved or N/A, none dated), with the date of the earliest later task approved (inferred). Never one
    -- a person submitted, rejected or suspended (the states below), never a date a person typed, never one a closed gate or a stop work holds, never again once
    -- a System Admin reverted it.
    FOR m IN
      SELECT ti.id, td.id AS def_id, td.code FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task AND td.workflow_id = s.workflow_version_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site AND ti.state IN ('locked', 'open', 'entry') AND NOT ti.is_na AND (manual ? sd.code) AND NOT ti.historical_manual_ms
        AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind = 'historical_manual_ms_approved' AND o.reverted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = ti.id AND o.state IN ('in_review', 'in_approval'))
        -- security review: a milestone a person ever submitted, reviewed, rejected or reopened keeps its human path (never overridden here)
        AND NOT EXISTS (SELECT 1 FROM public.workflow_steps w WHERE w.task_id = ti.id AND w.action::text IN ('submit', 'approve', 'reject', 'reopen', 'reassign'))
      ORDER BY sd.seq
    LOOP
      SELECT * INTO mev FROM public.ms_evaluate(m.id);
      CONTINUE WHEN jsonb_array_length(coalesce(mev.reasons, '[]'::jsonb)) > 0;   -- something still waits: a predecessor, a closed gate, a stop work
      SELECT * INTO e FROM public.hgd_evidence(p_site, s.workflow_version_id, ARRAY[m.def_id]);
      CONTINUE WHEN e.code IS NULL;   -- the site has not moved past it
      SELECT * INTO cur FROM public.task_instances WHERE id = m.id FOR UPDATE;
      CONTINUE WHEN cur.state NOT IN ('locked', 'open', 'entry') OR cur.is_na OR cur.historical_manual_ms;
      IF cur.state = 'locked' THEN   -- locked but ready: its predecessors are done (no reason above) and no gate holds it
        SELECT * INTO hold FROM public.wf_gate_hold(m.id);
        CONTINUE WHEN hold.gate_code IS NOT NULL;
      END IF;
      -- security review: the pre-filled date is the one the system computes (ms_evaluate: the latest condition date, Q38), never values.prefilled_date,
      -- which an entry can write; a date in the task that differs from it is a person's entry, never taken over
      pre := CASE WHEN coalesce(mev.ready, false) THEN mev.ms_date END;
      CONTINUE WHEN cur.actual_date IS NOT NULL AND cur.actual_date IS DISTINCT FROM pre;
      d := pre;
      inf := d IS NULL;
      IF inf THEN d := e.actual_date; END IF;   -- no condition date at all: the inferred date of 0127
      before := public.wf_snap(m.id);
      PERFORM public.hgd_mark('hmm_task', m.id::text);
      UPDATE public.task_instances SET state = 'approved', actual_date = d, approved_date = public.cal_today(), current_level = levels_required,
        ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
        admin_override = true, historical_manual_ms = true, historical_manual_ms_at = now(), historical_manual_ms_inferred = inf,
        version = version + 1, updated_at = now()
      WHERE id = m.id;
      PERFORM public.hgd_unmark('hmm_task');
      INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
      VALUES ('task', p_site, m.id, 'historical_manual_ms_approved', rs,
              jsonb_build_object('state', cur.state::text, 'actual_date', cur.actual_date, 'prefilled_date', pre),
              jsonb_build_object('state', 'approved', 'actual_date', d, 'date_source', CASE WHEN inf THEN 'inferred' ELSE 'prefilled' END,
                'note', CASE WHEN inf THEN why ELSE whym END, 'evidence_task', e.code, 'evidence_date', e.actual_date), p_actor)
      RETURNING id INTO oid;
      INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
      VALUES (m.id, greatest(cur.current_level, 1), 'admin_override', p_actor,
              left(CASE WHEN inf THEN why || ': no pre-filled date (every predecessor approved or N/A, none dated); the date of the earliest later task approved, '
                        ELSE whym || ': the site moved past it, the earliest later task approved is ' END
                   || e.code || ' on ' || e.actual_date::text || ' (admin override)' || CASE WHEN p_catchup THEN ', migration 0129' ELSE '' END, 2000),
              true, rs, NOT coalesce(p_catchup, false), cur.state, 'approved', clock_timestamp());
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
      VALUES ('task_historical_manual_ms_approved', 'task', m.id::text, p_site, cur.region_id,
              before || jsonb_build_object('historical_manual_ms', false, 'prefilled_date', pre),
              public.wf_snap(m.id) || jsonb_build_object('historical_manual_ms', true, 'historical_manual_ms_inferred', inf, 'reason_code', 'historical_manual_ms',
                'date_source', CASE WHEN inf THEN 'inferred' ELSE 'prefilled' END, 'note', CASE WHEN inf THEN why ELSE whym END, 'task_code', m.code,
                'override_id', oid, 'evidence_task', e.code, 'evidence_date', e.actual_date, 'catch_up', coalesce(p_catchup, false),
                'rule', 'a manual milestone the site moved past (a later task approved with an actual date) is approved directly with its pre-filled date; with none, with the date of the earliest later task approved'),
              rs, p_actor, true);
      ids := ids || m.id;
      mm := mm || jsonb_build_array(jsonb_build_object('task_code', m.code, 'actual_date', d, 'inferred', inf, 'evidence_code', e.code, 'override_id', oid));
      n := n + 1;
    END LOOP;

    FOREACH i IN ARRAY ids LOOP PERFORM public.wf_unlock_successors(i); END LOOP;
    PERFORM set_config('pmis.calc_busy', was_busy, true);
    IF was_busy <> '1' THEN PERFORM public.calc_refresh_site(p_site); END IF;
    EXIT WHEN n = 0;
  END LOOP;
  PERFORM public.hgd_unmark('hist_quiet');   -- 0129
  RETURN jsonb_build_object('site_id', p_site, 'in_scope', true, 'gates', gates, 'milestones', mss, 'restored', restored, 'marked', marked, 'manual', mm, 'rounds', rounds);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The rule on a set of sites, with one summary audit row (hgd_apply_sites: latest 0128, changes marked 0129)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hgd_apply_sites(p_sites uuid[], p_reason text, p_catchup boolean, p_run uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sid uuid; who uuid; r jsonb; e jsonb; uid text := current_setting('app.user_id', true); rg text := current_setting('app.region_ids', true);
  n_scope int := 0; n_changed int := 0; n_left int := 0; n_gates int := 0; n_ms int := 0; n_back int := 0; n_tasks int := 0;
  by_gate jsonb := '{}'::jsonb; by_ms jsonb := '{}'::jsonb; by_code jsonb := '{}'::jsonb; nodate jsonb := '{}'::jsonb; waiting jsonb := '{}'::jsonb;
  st_before jsonb := '{}'::jsonb; st_after jsonb := '{}'::jsonb; k text; w text; c text; ms_before int; ms_after int; res jsonb; actor uuid := public.app_actor();
  n_man int := 0; n_man_inf int := 0; by_man jsonb := '{}'::jsonb;   -- 0129: the manual milestones approved directly
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
        PERFORM public.hgd_unmark('hmm_task');      -- 0129
        PERFORM public.hgd_unmark('hmm_restore');   -- 0129
        PERFORM public.hgd_unmark('hist_quiet');    -- 0129
        PERFORM set_config('pmis.calc_busy', '', true);
        PERFORM public.log_system_write('warn', 'master-import', 'historical load: the gates and dates rule could not run on a site',
          jsonb_build_object('site_id', sid, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), who, NULL);
        r := jsonb_build_object('gates', '[]'::jsonb, 'milestones', '[]'::jsonb, 'restored', '[]'::jsonb, 'marked', '[]'::jsonb, 'manual', '[]'::jsonb, 'failed', true);
        n_left := n_left + 1;
      END;
      IF jsonb_array_length(r -> 'gates') + jsonb_array_length(r -> 'milestones') + jsonb_array_length(r -> 'restored') + jsonb_array_length(r -> 'marked')
         + jsonb_array_length(coalesce(r -> 'manual', '[]'::jsonb)) > 0 THEN   -- 0129
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
      FOR e IN SELECT x FROM jsonb_array_elements(coalesce(r -> 'manual', '[]'::jsonb)) x LOOP   -- 0129
        n_man := n_man + 1;
        IF coalesce((e ->> 'inferred')::boolean, false) THEN n_man_inf := n_man_inf + 1; END IF;
        by_man := jsonb_set(by_man, ARRAY[e ->> 'task_code'], to_jsonb(coalesce((by_man ->> (e ->> 'task_code'))::int, 0) + 1));
      END LOOP;
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
    'manual_ms_approved', n_man, 'manual_ms_approved_by_code', by_man, 'manual_ms_inferred', n_man_inf,   -- 0129
    'current_stage_before', st_before, 'current_stage_after', st_after, 'waiting_after', waiting, 'milestones_without_date', nodate,
    'catch_up', coalesce(p_catchup, false));
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  -- 0129: the catch-up of migration 0129 (definer-only marker hmm_catchup of hmm_catch_up) writes its own summary action
  VALUES (CASE WHEN coalesce(p_catchup, false) THEN CASE WHEN public.hgd_marked('hmm_catchup', '1') THEN 'historical_manual_ms_catch_up' ELSE 'historical_gates_dates_catch_up' END
               ELSE 'historical_gates_dates_apply' END,
          CASE WHEN p_run IS NULL THEN 'site' ELSE 'master_reconciliation_run' END, coalesce(p_run::text, 'all'),
          jsonb_build_object('milestones_approved', ms_before, 'current_stage', st_before),
          res || jsonb_build_object('rule', 'on a site of a historical load approved directly, a gate the site moved past (a task it holds or a later one approved with an actual date) is open, and a milestone with no date of its own takes the date of the earliest later task approved with an actual date; both are admin overrides, revertible; 0129: a manual milestone (Site RFI) the site moved past is approved directly with its pre-filled date (with none, the inferred date), an admin override, revertible'),
          left(coalesce(btrim(p_reason), 'historical load'), 2000), CASE WHEN coalesce(p_catchup, false) THEN NULL ELSE actor END, true);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The end of every historical load approved directly (hns_apply_sites: latest 0128, change marked 0129: the notice marker around the no-source rule)
-- ---------------------------------------------------------------------------------------------------------------------
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
        PERFORM public.hgd_mark('hist_quiet', sid::text);   -- 0129: no per-task notice for this site while the rule marks it
        r := public.hns_mark_site(sid, who, p_reason, p_catchup);
        PERFORM public.hgd_unmark('hist_quiet');            -- 0129
      EXCEPTION WHEN others THEN   -- one site never stops the load or the update of the server: reported in the System Log and counted
        PERFORM public.hgd_unmark('hns_task');
        PERFORM public.hgd_unmark('hist_quiet');   -- 0129
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The revert door (ao_current_matches and admin_override_revert: latest 0127, changes marked 0129)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ao_current_matches(p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.admin_overrides%ROWTYPE; k text; ok boolean := true;
BEGIN
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_id;
  IF NOT FOUND OR o.reverted_at IS NOT NULL THEN RETURN false; END IF;
  IF o.kind = 'historical_no_source_na' THEN   -- 0126: the task is still N/A from the mark
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'na' AND t.historical_no_source);
  END IF;
  IF o.kind = 'historical_gate_open' THEN   -- 0127: the gate is still open by this override
    RETURN EXISTS (SELECT 1 FROM public.site_gate_state g WHERE g.site_id = o.site_id AND g.gate_code = o.after ->> 'gate' AND g.historical_open_override = o.id);
  END IF;
  IF o.kind = 'historical_inferred_date' THEN   -- 0127: the milestone is still approved with the inferred date
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'approved' AND t.historical_inferred_date
                   AND t.actual_date::text IS NOT DISTINCT FROM o.after ->> 'actual_date');
  END IF;
  IF o.kind = 'historical_manual_ms_approved' THEN   -- 0129: the manual milestone is still approved directly with that date
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'approved' AND t.historical_manual_ms
                   AND t.actual_date::text IS NOT DISTINCT FROM o.after ->> 'actual_date');
  END IF;
  FOR k IN SELECT jsonb_object_keys(o.after) LOOP
    IF o.entity = 'task' THEN
      ok := ok AND coalesce(public.ao_task_date(o.task_id, k)::text, '(none)') = coalesce(o.after ->> k, '(none)');
    ELSE
      ok := ok AND coalesce(public.p4a_site_current(o.site_id, k), '(none)') = coalesce(o.after ->> k, '(none)');
    END IF;
  END LOOP;
  RETURN ok;
END $$;

CREATE OR REPLACE FUNCTION admin_override_revert(p_override uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid; o public.admin_overrides%ROWTYPE; rs text; t public.task_instances%ROWTYPE; s public.sites%ROWTYPE; fld text; k text; items jsonb := '[]'::jsonb; applied jsonb;
  before_snap jsonb; moved_region int;
BEGIN
  actor := public.ao_require_admin();
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_override FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.sites x WHERE x.id = o.site_id AND public.app_region_check(x.region_id)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The override does not exist or is not visible to you.'));
  END IF;
  rs := public.ao_reason(p_reason);
  IF o.reverted_at IS NOT NULL THEN
    PERFORM public.wf_err('override_not_revertible', jsonb_build_object('detail', 'This override was reverted already.'));
  END IF;
  IF NOT public.ao_current_matches(o.id) THEN
    PERFORM public.wf_err('override_not_revertible', jsonb_build_object('detail', CASE o.entity WHEN 'task' THEN 'The task date changed since this override.' ELSE 'The site changed since this edit.' END));
  END IF;
  PERFORM public.ao_require_stepup();
  IF o.kind = 'historical_no_source_na' THEN   -- 0126: the N/A "historical load: no source" is restored (the task locked again, opened when it can be)
    PERFORM public.hns_restore_task(o.task_id, rs, 'restored from N/A "historical load: no source" by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'historical_gate_open' THEN   -- 0127: the gate is closed again by its conditions (never opened by the rule again)
    PERFORM public.hgd_restore_gate(o.id, actor, rs, 'the gate opened by the historical load is closed again by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'historical_inferred_date' THEN   -- 0127: the milestone goes back to open without a date (never inferred again)
    PERFORM public.hgd_restore_milestone(o.task_id, actor, rs, 'the inferred date of the historical load is taken back by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'historical_manual_ms_approved' THEN   -- 0129: the manual milestone is open again with its pre-filled date (never approved by the rule again)
    PERFORM public.hmm_restore_task(o.task_id, actor, rs, 'the direct approval of the historical load is taken back by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.entity = 'task' THEN
    t := public.wf_lock_task(o.task_id, NULL);
    SELECT jsonb_object_keys(o.before) INTO fld LIMIT 1;
    before_snap := public.wf_snap(o.task_id);
    UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = rs WHERE id = o.id;
    PERFORM public.ao_task_write(o.task_id, fld, nullif(o.before ->> fld, '')::date,
      EXISTS (SELECT 1 FROM public.admin_overrides x WHERE x.task_id = o.task_id AND x.reverted_at IS NULL));
    PERFORM public.ao_task_step(o.task_id, 'override_revert', rs);
    PERFORM public.log_audit_write('task_override_reverted', 'task', o.task_id::text, before_snap,
      public.wf_snap(o.task_id) || jsonb_build_object('override_id', o.id, 'date_field', fld), rs, t.site_id, t.region_id, NULL, true);
    PERFORM public.ao_task_recalc(o.task_id, fld);
  ELSE
    FOR k IN SELECT jsonb_object_keys(o.before) LOOP
      items := items || jsonb_build_array(jsonb_build_object('item', k, 'text', coalesce(o.before ->> k, '(none)')));
    END LOOP;
    SELECT * INTO s FROM public.sites WHERE id = o.site_id FOR UPDATE;
    applied := public.ao_site_apply(o.site_id, items);
    UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = rs WHERE id = o.id;
    PERFORM public.log_audit_write('site_admin_edit_reverted', 'site', o.site_id::text,
      jsonb_build_object('fields', applied -> 'before', 'columns', applied -> 'columns_before'),
      jsonb_build_object('fields', applied -> 'after', 'columns', applied -> 'columns_after', 'override_id', o.id), rs, o.site_id,
      (SELECT x.region_id FROM public.sites x WHERE x.id = o.site_id), NULL, true);
    moved_region := nullif(applied ->> 'moved_from', '')::int;
    IF moved_region IS NOT NULL THEN
      PERFORM public.log_audit_write('site_region_moved_out', 'site', o.site_id::text, jsonb_build_object('fields', applied -> 'before'),
        jsonb_build_object('fields', applied -> 'after', 'override_id', o.id), rs, o.site_id, moved_region, NULL, true);
    END IF;
  END IF;
  RETURN public.ao_override_json(o.id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The notices of the historical direct approval (imp_submit_stream_rows: latest 0092, changes marked 0129: definer-only markers)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.imp_submit_stream_rows(p_batch uuid, p_rows uuid[], p_stepup boolean, p_async boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; t public.task_instances%ROWTYPE; submitted int := 0; saved int := 0;
  processed int := 0; held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; st text; msg text; pend text; start_d date; draft boolean; flds jsonb;
  row_draft boolean;   -- 0085: a row of the historical load without an actual date is saved, not submitted
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  draft := (b.mode = 'draft');
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update'
             AND x.decision IN ('pending', 'pending_previous_approval') AND x.task_submitted_at IS NULL AND (p_rows IS NULL OR x.id = ANY (p_rows)) ORDER BY x.ord LOOP
    processed := processed + 1;
    BEGIN
      SELECT * INTO t FROM public.task_instances x WHERE x.id = r.task_instance_id FOR UPDATE;
      IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN
        RAISE EXCEPTION 'wf:not_found:{"detail": "The task does not exist or is not visible to you."}';
      END IF;
      IF t.state IN ('in_review', 'in_approval') THEN
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'open_submission' WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'open_submission', 'record_id', NULL));
        CONTINUE;
      ELSIF t.state = 'locked' AND public.swl_site_locked(t.site_id) THEN   -- 0085: an open site never holds the row
        SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
          JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
          JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
          WHERE tp.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = CASE WHEN pend IS NOT NULL THEN 'predecessor_open' ELSE 'gate_locked' END WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key,
          'reason', CASE WHEN pend IS NOT NULL THEN 'predecessor_open' ELSE 'gate_locked' END, 'record_id', NULL));
        CONTINUE;
      ELSIF t.state NOT IN ('open', 'entry', 'locked') THEN
        RAISE EXCEPTION 'wf:task_not_open:{"detail": "The task is no longer open for entry."}';
      END IF;

      flds := coalesce(r.payload -> 'fields', '{}'::jsonb);
      patch := public.imp_task_patch(flds, r.diff);
      PERFORM set_config('app.batch_row', r.id::text, true);
      row_draft := draft OR (b.historical_load AND coalesce((r.payload ->> 'save_only')::boolean, false));
      IF t.state IN ('open', 'locked') AND (NOT row_draft OR flds ? 'actual_start' OR flds ? 'actual_date') THEN
        start_d := public.imp_start_date(r.task_code, flds, t);
        IF start_d IS NULL AND b.historical_load THEN start_d := coalesce(nullif(flds ->> 'actual_date', '')::date, t.actual_date); END IF;   -- 0085 (warning missing_actual_start)
        IF start_d IS NULL THEN
          RAISE EXCEPTION 'wf:actual_start_required:{"detail": "The task is pending: type its Actual Start. GSDN Workspace never uses today as the start of an earlier piece of work (Q209)."}';
        END IF;
        PERFORM public.wf_start(t.id, NULL, start_d);
      END IF;
      PERFORM public.wf_save_entry(t.id, NULL, patch);
      IF row_draft THEN
        PERFORM set_config('app.batch_row', '', true);
        UPDATE public.import_batch_rows SET hold_reason = NULL, decision = 'saved', decided_by = actor, decided_at = now() WHERE id = r.id;
        saved := saved + 1;
        CONTINUE;
      END IF;
      -- 0092: the submit of a row approved directly right after sends no notice (no "task assigned" to L2, no "no holder" to the System Admins): see wf_notify
      -- 0129: the markers are rows of hgd_marks written here (definer code), never a session setting; hist_quiet also skips the notices of the successors that
      -- the direct approval opens on this site (task opened, no holder ...)
      IF b.historical_direct_approve THEN PERFORM public.hgd_mark('hda_quiet', t.id::text); PERFORM public.hgd_mark('hist_quiet', t.site_id::text); END IF;
      IF b.historical_load THEN   -- 0073 (Q462): the mandatory-document check can be waived for this row (see hw_row_waiver)
        PERFORM public.wf_complete_hw(t.id, NULL, 'submit', NULL, p_stepup, r.id);
      ELSE
        PERFORM public.wf_submit(t.id, NULL, NULL, p_stepup);
      END IF;
      IF b.historical_direct_approve THEN   -- 0092: a historical Master import batch marked for direct approval (read from the stored batch, never from the caller)
        PERFORM public.hda_approve_task(t.id, b.id, r.id, p_stepup);
        PERFORM public.hgd_unmark('hda_quiet'); PERFORM public.hgd_unmark('hist_quiet');   -- 0129
      END IF;
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      UPDATE public.import_batch_rows SET hold_reason = NULL, task_submitted_at = now(),
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      PERFORM public.hgd_unmark('hda_quiet'); PERFORM public.hgd_unmark('hist_quiet');   -- 0092, 0129
      IF SQLERRM LIKE 'wf:step_up_required%' THEN
        IF NOT coalesce(p_async, false) THEN RAISE; END IF;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'step_up_required',
          'message', 'This row is a final approval and needs a step-up: send the batch again after confirming your password.'));
        CONTINUE;
      END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The task refused this row. See the System Log (template-check) for the technical reason.' END;
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', task_submitted_at = NULL, hold_reason = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('column', coalesce(r.task_code, 'Task'), 'field', coalesce(r.task_code, 'task'), 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('submitted', submitted, 'saved', saved, 'processed', processed, 'held', held, 'failed', failed);
END $function$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 8. wf_notify (latest 0092, changes marked 0129): the quiet markers are definer-only rows of hgd_marks
-- ---------------------------------------------------------------------------------------------------------------------
-- (1) 0092, marker moved: no notice for the task whose submit is followed at once by its direct approval (the marker hda_quiet of that task, written only by
--     imp_submit_stream_rows), while the task has a row in a batch marked for direct approval that may still be approved directly (hda_batch_ok).
-- (2) 0129: no per-task notice for a site while the historical direct approval or the historical rules work on it (the marker hist_quiet of that site, written
--     only by imp_submit_stream_rows, hns_apply_sites and hgd_settle_site). A session setting of any role never stands in for either marker.
CREATE OR REPLACE FUNCTION wf_notify(p_user uuid, p_kind text, p_title text, p_body text, p_task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_task IS NOT NULL AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hda_quiet', p_task::text) ELSE false END) AND EXISTS (
                 SELECT 1 FROM public.import_batch_rows r JOIN public.import_batches b ON b.id = r.batch_id
                 WHERE r.task_instance_id = p_task AND b.historical_direct_approve AND public.hda_batch_ok(b)) THEN
    RETURN;   -- 0092 (marker 0129)
  END IF;
  IF p_task IS NOT NULL AND (CASE WHEN current_user::text = 'pmis_definer'
                                  THEN public.hgd_marked('hist_quiet', (SELECT t.site_id::text FROM public.task_instances t WHERE t.id = p_task)) ELSE false END) THEN
    RETURN;   -- 0129
  END IF;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link) VALUES (p_user, 'in_app', p_kind, p_title, p_body, p_task, '/tasks/' || p_task::text);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app. The redefined functions
--    keep their owner and grants (CREATE OR REPLACE): admin_override_revert stays the API door.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hmm_guard_task()', 'hmm_restore_task(uuid,uuid,text,text,boolean)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The one-time catch-up (the migration session: each site as the System Admin who loaded it; the settle loop of 0127 with the fifth step)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hmm_catch_up() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE res jsonb;
BEGIN
  IF NOT public.app_ctx_legacy() THEN
    RAISE EXCEPTION 'historical manual milestone: the catch-up runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.hgd_mark('hmm_catchup', '1');   -- the summary row of hgd_apply_sites is historical_manual_ms_catch_up
  res := public.hgd_apply_sites(ARRAY(SELECT DISTINCT x.site_id FROM public.task_instances x JOIN public.import_batches b ON b.id = x.historical_direct_batch_id
                                      WHERE b.historical_load AND b.source = 'master_import' AND b.historical_direct_approve),
    'migration 0129: on a site of the historical load, a manual milestone (Site RFI) the site moved past is approved directly with its pre-filled date (owner decision "Option 2", 2026-11-19)',
    true, NULL);
  PERFORM public.hgd_unmark('hmm_catchup');
  RETURN res;
END $$;
ALTER FUNCTION hmm_catch_up() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION hmm_catch_up() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON FUNCTION hmm_catch_up() FROM pmis_app; END IF;
END $$;

SELECT hmm_catch_up();
