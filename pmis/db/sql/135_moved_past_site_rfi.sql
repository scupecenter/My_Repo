-- 0136_moved_past_site_rfi: on ANY site, a manual milestone (Site RFI, MS4: calc.milestone_manual) the site has moved past is approved directly with its
-- pre-filled date (the rule of 0129, which held only at the end of a completed historical load approved directly), as an admin override made by a rule of
-- GSDN Workspace; it runs from now on in the calculation path before the gate and D8 rules of 0134, and once on the existing sites. The ongoing hook of 0134
-- now stands aside only while a Master import apply is actually running (owner decision 2026-11-22; CHANGELOG 179; contract 0.15.52).
-- Mirror: db/sql/135_moved_past_site_rfi.sql (kept byte-identical).
--
-- WHY (production, read-only diagnosis 2026-11-22, counts only): the backfill of 0134 opened 0 gates. On the 58 sites whose TE Completion (MS5) is locked
-- gate_closed:G5, gate_eval(site, 'G5') answers pending with the reason predecessor_not_approved: Site RFI (MS4, a manual milestone) is not approved,
-- although the TE work after it (D6, D7, D9, D10) is approved with actual dates. gmp_open_gates (0134) acts only on a gate blocked by its conditions, so
-- nothing happened. 0129 approves such a Site RFI only on a site of a historical load approved directly, at the end of a completed load; the production loads
-- never completed (their Master batches stay validated, never closed), so it never ran. Second bug: gmp_site_deferred (0134) defers the ongoing hook while a
-- historical batch approved directly with rows of the site is not closed; two Master batches staged on production stay validated, so the hook was deferred
-- on all 469 sites for good.
--
-- OWNER DECISION (2026-11-22): "Site RFI is approved automatically on any site that moved past it", the 0129 rule generalised to any site (live or
-- historical), from now on and once now.
--
-- RULE "MANUAL MILESTONE MOVED PAST" (mmp_approve_site). A milestone task of calc.milestone_manual (default ["MS4"]) of the site's workflow, in state locked,
-- open or entry, not N/A, that:
--   * nothing still waits for: ms_evaluate gives no reason (every predecessor approved, N/A or skipped; the gate before it open: a closed, pending or
--     suspended gate or a stop work keeps it); when locked, no gate holds it (wf_gate_hold), as 0129;
--   * the site moved past: a later task (a transitive successor in the 0127 graph hgd_after_defs, gate links included) is approved with an actual date
--     (hgd_evidence, as 0127 / 0129);
--   * no person touched: no workflow step submit, review, approve, reject, reopen or reassign; no register record in review or approval; no date override
--     of a person (an admin_overrides row of kind edit_date, even reverted); its actual date is empty or the pre-filled one the system computes
--     (ms_evaluate, never values.prefilled_date, which an entry can write);
--   * never reverted: no reverted override of kind manual_ms_moved_past or historical_manual_ms_approved on the task (revert = never again, by either rule);
-- is approved directly with the pre-filled date (the latest condition date, Q38); with no pre-filled date (every predecessor approved or N/A, none dated),
-- with the date of the earliest later task approved, flagged inferred (as 0129). It writes: state approved, actual_date, approved today, admin_override true
-- (the badge; the calculation never moves the date of an approved manual milestone), the new flags task_instances.manual_ms_moved_past (+ time) and
-- manual_ms_moved_past_inferred (guard mmp_guard_task: current user pmis_definer AND the definer-only marker mmp_task of the row); one admin_overrides row
-- (entity task, kind manual_ms_moved_past, before {state, actual_date, prefilled_date}, after {state approved, actual_date, date_source prefilled|inferred,
-- note, evidence_task, evidence_date}, acted_by NULL: the rule of GSDN Workspace, no person), one workflow step admin_override (acted_by NULL), one audit
-- row task_manual_ms_moved_past (actor NULL, is_admin_override); then its successors unlock (wf_unlock_successors). Any other path that changes its date or
-- takes it out of approved clears the flags and closes the override (audit row task_manual_ms_moved_past_cleared). A NEW kind and NEW flags (not 0129's
-- historical_manual_ms_approved / historical_manual_ms) so the history stays distinguishable: the historical flag means "by the historical load".
--
-- WHEN IT RUNS:
--   (a) from now on, in the hook of the calculation path gmp_apply_site (called by calc_refresh_site at the end of each round): the manual milestone first,
--       then the gates (gmp_open_gates, 0134), then D8 (nmw_mark_site, 0134); any change is progress, so the next round releases the held tasks and
--       calculates the milestones: MS4 approved -> G5 evaluated -> blocked by its permits only -> opened by the gate rule -> MS5 calculated -> D8 N/A (no
--       microwave) -> MS6 calculated. A failure is written to the System Log and never stops the calculation.
--   (b) once, now (mmp_backfill, migration session only, app_ctx_legacy): every active, not cancelled site that holds a task behind a closed gate (any reason,
--       pending included), an open D8, or an unapproved manual milestone with a later task approved with a date: per site, manual milestone -> gates -> D8
--       -> calc_refresh_site until nothing changes (at most 12 rounds), notifications muted per site (hist_quiet, as 0129 / 0134); one summary audit row
--       manual_ms_moved_past_backfill with counts only (no site data; none when no site is in scope).
--
-- DEFERRAL (gmp_site_deferred, latest 0134, redefined): the hook stands aside ONLY while a Master import apply is actually running: the transaction markers
-- as before (hist_quiet of the site, hist_load of swl_open_for_load), or an mi_apply_jobs row (0086) in state running (any run). The condition "a historical
-- batch approved directly with rows of the site is not closed" is dropped: a staged batch that is never finished no longer defers the rules for good.
--
-- RESTORE: POST /overrides/{override_id}/revert (admin_override_revert: a System Admin, never a delegate, a reason, a step-up): mmp_restore_task opens the
-- milestone again at L1 with its pre-filled date (no date when it was inferred), the flags gone, admin_override kept only while another override of the task
-- is active; one workflow step override_revert, one audit row task_manual_ms_moved_past_restore. The tasks opened after it stay open and the milestones
-- calculated after it are never taken back (Q81, as 0127 / 0129). A milestone reverted under either kind (this one or historical_manual_ms_approved) is never
-- approved again by either rule (this one, and step 5 of hgd_settle_site of 0129).
--
-- ACTOR. admin_overrides.acted_by may be NULL, and reverted_by NULL on an automatic closing, for the rule kinds only (CHECK of 0134, extended to the new kind).
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0136"): gmp_site_deferred (0134), gmp_apply_site (0134), hgd_settle_site
-- (0134), ao_current_matches (0134), admin_override_revert (0134). CREATE OR REPLACE keeps their owner and grants (admin_override_revert stays the API door;
-- the others stay internal).
--
-- Function rules: SECURITY DEFINER (except the guard, which runs as its writer like hmm_guard_task / nmw_guard_task), search_path = pg_catalog, public,
-- pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC and pmis_app. No new table; no new right for pmis_app (the flag columns are revoked here too;
-- app_grants.sql keeps task_instances and admin_overrides unwritable). Contract 0.15.52: the override kind manual_ms_moved_past (Override.kind), no
-- Override.acted_by for it.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Overrides made by a rule have no acting person (the rule kinds of 0134 and the new one)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE admin_overrides DROP CONSTRAINT admin_overrides_rule_actor_check;
ALTER TABLE admin_overrides ADD CONSTRAINT admin_overrides_rule_actor_check
  CHECK (acted_by IS NOT NULL OR kind IN ('gate_moved_past_open', 'no_microwave_na', 'manual_ms_moved_past'));
ALTER TABLE admin_overrides DROP CONSTRAINT admin_overrides_revert_check;
ALTER TABLE admin_overrides ADD CONSTRAINT admin_overrides_revert_check CHECK ((reverted_at IS NULL) = (reverted_by IS NULL)
  OR (reverted_at IS NOT NULL AND reverted_by IS NULL AND kind IN ('gate_moved_past_open', 'no_microwave_na', 'manual_ms_moved_past')));
COMMENT ON COLUMN admin_overrides.acted_by IS '0134 / 0136: NULL only for an override made by a rule of GSDN Workspace (kinds gate_moved_past_open, no_microwave_na and manual_ms_moved_past, owner decisions 2026-11-22)';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The flags of the manual milestone approved because the site moved past it, and their guard
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN manual_ms_moved_past boolean NOT NULL DEFAULT false,
  ADD COLUMN manual_ms_moved_past_at timestamptz,
  ADD COLUMN manual_ms_moved_past_inferred boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT task_instances_mmp_check CHECK (NOT manual_ms_moved_past OR (state = 'approved' AND manual_ms_moved_past_at IS NOT NULL)),
  ADD CONSTRAINT task_instances_mmp_inferred_check CHECK (NOT manual_ms_moved_past_inferred OR manual_ms_moved_past);
CREATE INDEX task_instances_mmp_idx ON task_instances (site_id) WHERE manual_ms_moved_past;
COMMENT ON COLUMN task_instances.manual_ms_moved_past IS '0136: a manual milestone (Site RFI) the site moved past, approved directly with its pre-filled date by a rule of GSDN Workspace on any site (owner decision 2026-11-22; admin override, reversible through POST /overrides/{id}/revert)';
COMMENT ON COLUMN task_instances.manual_ms_moved_past_inferred IS '0136: the milestone had no pre-filled date: the date is the one of the earliest later task approved (inferred date)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (manual_ms_moved_past, manual_ms_moved_past_at, manual_ms_moved_past_inferred),
           UPDATE (manual_ms_moved_past, manual_ms_moved_past_at, manual_ms_moved_past_inferred) ON task_instances FROM pmis_app;
  END IF;
END $$;

-- The guard of the flags (runs as its writer, like hmm_guard_task). The flags are set only by mmp_approve_site (current user pmis_definer AND the
-- definer-only marker mmp_task of this task in hgd_marks, from locked / open / entry to approved). When the milestone leaves approved or its date changes by
-- any path the flags go (audited and its override closed), unless the restore of mmp_restore_task does it (current user pmis_definer AND the marker
-- mmp_restore of this task). A session setting never stands in for a marker.
CREATE OR REPLACE FUNCTION mmp_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'moved past: the direct approval of a manual milestone is written only by GSDN Workspace (migration 0136)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.manual_ms_moved_past AND (NEW.state IS DISTINCT FROM 'approved' OR NEW.actual_date IS DISTINCT FROM OLD.actual_date) THEN
    NEW.manual_ms_moved_past := false;
    NEW.manual_ms_moved_past_inferred := false;
    IF NOT (current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('mmp_restore', NEW.id::text) ELSE false END)) THEN
      UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = coalesce(public.app_actor(), acted_by),
        revert_reason = left('the milestone left its direct approval (' || NEW.state::text || coalesce(', ' || NEW.actual_date::text, '') || ')', 2000)
      WHERE task_id = NEW.id AND kind = 'manual_ms_moved_past' AND reverted_at IS NULL;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_manual_ms_moved_past_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('manual_ms_moved_past', true, 'state', OLD.state::text, 'actual_date', OLD.actual_date),
        jsonb_build_object('manual_ms_moved_past', false, 'state', NEW.state::text, 'actual_date', NEW.actual_date),
        'The milestone left its direct approval (the site moved past it) (' || NEW.state::text || '): the mark is cleared.', public.app_actor());
    END IF;
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.manual_ms_moved_past, NEW.manual_ms_moved_past_at, NEW.manual_ms_moved_past_inferred)
     IS NOT DISTINCT FROM (OLD.manual_ms_moved_past, OLD.manual_ms_moved_past_at, OLD.manual_ms_moved_past_inferred) THEN
    RETURN NEW;
  END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('mmp_task', NEW.id::text) ELSE false END)
     AND NEW.manual_ms_moved_past AND NOT OLD.manual_ms_moved_past AND NEW.state = 'approved' AND OLD.state IN ('locked', 'open', 'entry') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'moved past: the direct approval of a manual milestone is written only by GSDN Workspace (migration 0136)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER mmp_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.manual_ms_moved_past OR NEW.manual_ms_moved_past_at IS NOT NULL OR NEW.manual_ms_moved_past_inferred) EXECUTE FUNCTION mmp_guard_task();
CREATE TRIGGER mmp_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.manual_ms_moved_past IS DISTINCT FROM OLD.manual_ms_moved_past OR NEW.manual_ms_moved_past_at IS DISTINCT FROM OLD.manual_ms_moved_past_at
        OR NEW.manual_ms_moved_past_inferred IS DISTINCT FROM OLD.manual_ms_moved_past_inferred
        OR (OLD.manual_ms_moved_past AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.actual_date IS DISTINCT FROM OLD.actual_date)))
  EXECUTE FUNCTION mmp_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The rule: the manual milestones the site moved past (internal). Returns [{task_code, task_id, actual_date, inferred, evidence_code, override_id}].
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mmp_approve_site(p_site uuid, p_backfill boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; m record; mev record; e record; hold record; cur public.task_instances%ROWTYPE; before jsonb; oid uuid; d date; pre date; inf boolean;
  done jsonb := '[]'::jsonb;
  manual jsonb := public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb);
  why constant text := 'inferred date — the site moved past it';
  whym constant text := 'pre-filled date approved directly — the site moved past it';
  rs constant text := 'owner decision 2026-11-22: Site RFI is approved automatically on any site that moved past it (a later task is approved with an actual date); admin override by a rule of GSDN Workspace';
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN done; END IF;
  FOR m IN
    SELECT ti.id, td.id AS def_id, td.code FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task AND td.workflow_id = s.workflow_version_id
    JOIN public.stage_definitions sd ON sd.id = td.stage_id
    WHERE ti.site_id = p_site AND ti.state IN ('locked', 'open', 'entry') AND NOT ti.is_na AND (manual ? sd.code)
      AND NOT ti.manual_ms_moved_past AND NOT ti.historical_manual_ms
      -- reverted by a System Admin under either kind: never approved by a rule again
      AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind IN ('manual_ms_moved_past', 'historical_manual_ms_approved')
                        AND o.reverted_at IS NOT NULL)
      -- a date a person set through an admin date override (even reverted) keeps the human path
      AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind = 'edit_date')
      AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = ti.id AND o.state IN ('in_review', 'in_approval'))
      -- a milestone a person ever submitted, reviewed, approved, rejected, reopened or reassigned keeps its human path (never overridden here)
      AND NOT EXISTS (SELECT 1 FROM public.workflow_steps w WHERE w.task_id = ti.id AND w.action::text IN ('submit', 'review', 'approve', 'reject', 'reopen', 'reassign'))
    ORDER BY sd.seq
  LOOP
    SELECT * INTO mev FROM public.ms_evaluate(m.id);
    CONTINUE WHEN jsonb_array_length(coalesce(mev.reasons, '[]'::jsonb)) > 0;   -- something still waits: a predecessor, a closed or pending gate, a stop work
    SELECT * INTO e FROM public.hgd_evidence(p_site, s.workflow_version_id, ARRAY[m.def_id]);
    CONTINUE WHEN e.code IS NULL;   -- the site has not moved past it
    SELECT * INTO cur FROM public.task_instances WHERE id = m.id FOR UPDATE;
    CONTINUE WHEN cur.state NOT IN ('locked', 'open', 'entry') OR cur.is_na OR cur.manual_ms_moved_past OR cur.historical_manual_ms;
    IF cur.state = 'locked' THEN   -- locked but ready: its predecessors are done (no reason above) and no gate holds it
      SELECT * INTO hold FROM public.wf_gate_hold(m.id);
      CONTINUE WHEN hold.gate_code IS NOT NULL;
    END IF;
    -- the pre-filled date is the one the system computes (ms_evaluate: the latest condition date, Q38), never values.prefilled_date, which an entry can
    -- write; a date in the task that differs from it is a person's entry, never taken over
    pre := CASE WHEN coalesce(mev.ready, false) THEN mev.ms_date END;
    CONTINUE WHEN cur.actual_date IS NOT NULL AND cur.actual_date IS DISTINCT FROM pre;
    d := pre;
    inf := d IS NULL;
    IF inf THEN d := e.actual_date; END IF;   -- no condition date at all: the inferred date of 0127 / 0129
    before := public.wf_snap(m.id);
    PERFORM public.hgd_mark('mmp_task', m.id::text);
    UPDATE public.task_instances SET state = 'approved', actual_date = d, approved_date = public.cal_today(), current_level = levels_required,
      ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
      admin_override = true, manual_ms_moved_past = true, manual_ms_moved_past_at = now(), manual_ms_moved_past_inferred = inf,
      version = version + 1, updated_at = now()
    WHERE id = m.id;
    PERFORM public.hgd_unmark('mmp_task');
    INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
    VALUES ('task', p_site, m.id, 'manual_ms_moved_past', rs,
            jsonb_build_object('state', cur.state::text, 'actual_date', cur.actual_date, 'prefilled_date', pre),
            jsonb_build_object('state', 'approved', 'actual_date', d, 'date_source', CASE WHEN inf THEN 'inferred' ELSE 'prefilled' END,
              'note', CASE WHEN inf THEN why ELSE whym END, 'evidence_task', e.code, 'evidence_date', e.actual_date), NULL)
    RETURNING id INTO oid;
    INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
    VALUES (m.id, greatest(cur.current_level, 1), 'admin_override', NULL,
            left(CASE WHEN inf THEN why || ': no pre-filled date (every predecessor approved or N/A, none dated); the date of the earliest later task approved, '
                      ELSE whym || ': the earliest later task approved is ' END
                 || e.code || ' on ' || e.actual_date::text || ' (admin override by the rule of 2026-11-22)'
                 || CASE WHEN p_backfill THEN ', migration 0136' ELSE '' END, 2000),
            true, rs, false, cur.state, 'approved', clock_timestamp());
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
    VALUES ('task_manual_ms_moved_past', 'task', m.id::text, p_site, cur.region_id,
            before || jsonb_build_object('manual_ms_moved_past', false, 'prefilled_date', pre),
            public.wf_snap(m.id) || jsonb_build_object('manual_ms_moved_past', true, 'manual_ms_moved_past_inferred', inf, 'reason_code', 'manual_ms_moved_past',
              'date_source', CASE WHEN inf THEN 'inferred' ELSE 'prefilled' END, 'note', CASE WHEN inf THEN why ELSE whym END, 'task_code', m.code,
              'override_id', oid, 'evidence_task', e.code, 'evidence_date', e.actual_date, 'backfill', coalesce(p_backfill, false),
              'rule', 'a manual milestone the site moved past (a later task approved with an actual date) is approved directly with its pre-filled date; with none, with the date of the earliest later task approved'),
            rs, NULL, true);
    PERFORM public.wf_unlock_successors(m.id);
    done := done || jsonb_build_array(jsonb_build_object('task_code', m.code, 'task_id', m.id, 'actual_date', d, 'inferred', inf, 'evidence_code', e.code,
                                                         'override_id', oid));
  END LOOP;
  RETURN done;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The three rules of a site, in order (internal): the manual milestone, then the gates, then D8. Returns {manual, gates, d8}.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mmp_rules_site(p_site uuid, p_backfill boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mm jsonb; g jsonb; d jsonb;
BEGIN
  mm := public.mmp_approve_site(p_site, p_backfill);
  g := public.gmp_open_gates(p_site, p_backfill);
  d := public.nmw_mark_site(p_site, p_backfill);
  RETURN jsonb_build_object('manual', mm, 'gates', g, 'd8', d);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The restore of one milestone (internal): the revert door
-- ---------------------------------------------------------------------------------------------------------------------
-- The milestone is open again with its pre-filled date (no date when the date was inferred), at L1, the flags gone; never approved by a rule again.
CREATE OR REPLACE FUNCTION mmp_restore_task(p_task uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; o public.admin_overrides%ROWTYPE; before jsonb; back date;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'moved past: only a System Admin takes the direct approval of a manual milestone back' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT (t.state = 'approved' AND t.manual_ms_moved_past) THEN
    RETURN jsonb_build_object('task_id', p_task, 'outcome', 'not_marked');
  END IF;
  SELECT * INTO o FROM public.admin_overrides WHERE task_id = p_task AND kind = 'manual_ms_moved_past' AND reverted_at IS NULL
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  back := CASE WHEN o.after ->> 'date_source' = 'prefilled' THEN nullif(o.after ->> 'actual_date', '')::date END;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = p_actor, revert_reason = left(btrim(p_reason), 2000)
  WHERE task_id = p_task AND kind = 'manual_ms_moved_past' AND reverted_at IS NULL;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('mmp_restore', p_task::text);
  UPDATE public.task_instances SET state = 'open', actual_date = back, approved_date = NULL, current_level = 1, level_opened_at = now(), lock_reason = NULL,
    values = CASE WHEN back IS NULL THEN values ELSE coalesce(values, '{}'::jsonb) || jsonb_build_object('prefilled_date', back, 'prefilled', true) END,
    manual_ms_moved_past = false, manual_ms_moved_past_inferred = false,
    admin_override = EXISTS (SELECT 1 FROM public.admin_overrides x WHERE x.task_id = p_task AND x.reverted_at IS NULL),
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('mmp_restore');
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, 1, 'override_revert', p_actor, left(p_why, 2000), true, left(btrim(p_reason), 2000), coalesce(p_stepup, false), 'approved', 'open', clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_manual_ms_moved_past_restore', 'task', p_task::text, t.site_id, t.region_id, before || jsonb_build_object('manual_ms_moved_past', true),
          public.wf_snap(p_task) || jsonb_build_object('manual_ms_moved_past', false, 'override_id', o.id, 'restored_date', back, 'why', p_why),
          left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(t.site_id);
  RETURN jsonb_build_object('task_id', p_task, 'outcome', 'restored', 'override_id', o.id, 'actual_date', back);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The hook stands aside only while a Master import apply is running (gmp_site_deferred: latest 0134, changed 0136)
-- ---------------------------------------------------------------------------------------------------------------------
-- The historical rules (0126 / 0127 / 0129) are working on the site in this transaction (the definer-only marker hist_quiet of the site, or hist_load of a
-- historical Master load written by swl_open_for_load), or a Master import apply runs in the background (an mi_apply_jobs row in state running, 0086).
-- 0136: a historical batch approved directly that is not closed no longer defers the hook (staged batches that never finish deferred it for good).
CREATE OR REPLACE FUNCTION gmp_site_deferred(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hist_quiet', p_site::text) OR public.hgd_marked('hist_load', '1') ELSE false END)
    OR EXISTS (SELECT 1 FROM public.mi_apply_jobs j WHERE j.state = 'running')
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The hook of the calculation path (gmp_apply_site: latest 0134, changes marked 0136). Returns the number of changes.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gmp_apply_site(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer := 0; r jsonb;
BEGIN
  -- cheap first: nothing held by a gate, no D8 still to decide and (0136) no manual milestone still to approve on the site
  IF NOT EXISTS (SELECT 1 FROM public.task_instances h WHERE h.site_id = p_site AND h.state = 'locked' AND starts_with(coalesce(h.lock_reason, ''), 'gate_closed:'))
     AND NOT EXISTS (SELECT 1 FROM public.task_instances h JOIN public.task_definitions td ON td.id = h.task_def_id AND td.code = 'D8'
                     WHERE h.site_id = p_site AND h.state IN ('locked', 'open') AND NOT h.is_na)
     AND NOT EXISTS (SELECT 1 FROM public.task_instances h JOIN public.task_definitions td ON td.id = h.task_def_id AND td.is_milestone_task   -- 0136
                     JOIN public.stage_definitions sd ON sd.id = td.stage_id
                     WHERE h.site_id = p_site AND h.state IN ('locked', 'open', 'entry') AND NOT h.is_na
                       AND public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb) ? sd.code) THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND s.is_active AND s.overall_status::text <> 'cancelled') THEN RETURN 0; END IF;
  IF public.gmp_site_deferred(p_site) THEN RETURN 0; END IF;
  BEGIN
    -- 0136: the manual milestone first, then the gates, then D8 (mmp_rules_site)
    r := public.mmp_rules_site(p_site, false);
    n := jsonb_array_length(r -> 'manual') + jsonb_array_length(r -> 'gates') + jsonb_array_length(r -> 'd8');
  EXCEPTION WHEN others THEN   -- the rule never stops the calculation (nor the approval that triggered it): reported in the System Log
    PERFORM public.log_system_write('warn', 'calc', 'the moved-past rules (manual milestone, gate, no microwave) could not run on a site',
      jsonb_build_object('site_id', p_site, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), public.app_actor(), NULL);
    RETURN 0;
  END;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The historical settle loop never approves again a manual milestone reverted under either kind (hgd_settle_site: latest 0134, change marked 0136)
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
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.site_id = p_site AND o.kind IN ('historical_gate_open', 'gate_moved_past_open')
                              AND o.after ->> 'gate' = g.link_code AND o.reverted_at IS NOT NULL);   -- reverted by a System Admin (0134: either kind): never opened again
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
        -- 0136: reverted by a System Admin under either kind (this one or manual_ms_moved_past): never approved by a rule again
        AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind IN ('historical_manual_ms_approved', 'manual_ms_moved_past')
                          AND o.reverted_at IS NOT NULL)
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
-- 9. The revert door knows the new kind (ao_current_matches and admin_override_revert: latest 0134, changes marked 0136)
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
  IF o.kind = 'gate_moved_past_open' THEN   -- 0134: the gate is still open by this override
    RETURN EXISTS (SELECT 1 FROM public.site_gate_state g WHERE g.site_id = o.site_id AND g.gate_code = o.after ->> 'gate' AND g.historical_open_override = o.id);
  END IF;
  IF o.kind = 'no_microwave_na' THEN   -- 0134: the task is still N/A from the mark
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'na' AND t.no_microwave_na);
  END IF;
  IF o.kind = 'manual_ms_moved_past' THEN   -- 0136: the manual milestone is still approved by the rule with that date
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'approved' AND t.manual_ms_moved_past
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
  IF o.kind = 'gate_moved_past_open' THEN   -- 0134: the gate follows its conditions again (never opened by the rule again)
    PERFORM public.hgd_restore_gate(o.id, actor, rs, 'the gate opened because the site moved past it is closed again by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'no_microwave_na' THEN   -- 0134: MW alignment is restored from N/A (locked again, opened when it can be; never marked by the rule again)
    PERFORM public.nmw_restore_task(o.task_id, actor, rs, 'restored from N/A "no microwave on site" by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'manual_ms_moved_past' THEN   -- 0136: the manual milestone is open again with its pre-filled date (never approved by either rule again)
    PERFORM public.mmp_restore_task(o.task_id, actor, rs, 'the direct approval of a manual milestone the site moved past is taken back by a System Admin (revert of the override)', true);
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
-- 10. The one-time backfill (migration session only): the manual milestone, then the gates, then D8, then the calculation, per site until nothing changes;
--     notices muted per site; one summary audit row with counts only (no site data)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mmp_backfill() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sid uuid; r jsonb; e jsonb; n int; rounds int; changed boolean;
  rg text := current_setting('app.region_ids', true); was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
  manual jsonb := public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb);
  n_scan int := 0; n_changed int := 0; n_failed int := 0; n_man int := 0; n_man_inf int := 0; n_gates int := 0; n_d8 int := 0;
  by_man jsonb := '{}'::jsonb; by_gate jsonb := '{}'::jsonb; ms_before jsonb; ms_after jsonb; sites uuid[]; res jsonb;
BEGIN
  IF NOT public.app_ctx_legacy() THEN
    RAISE EXCEPTION 'moved past: the backfill runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- the active, not cancelled sites that hold a task behind a closed gate (any reason, pending included), a D8 still to decide, or a manual milestone not
  -- approved with a later task approved with an actual date
  sites := ARRAY(
    SELECT DISTINCT ti.site_id FROM public.task_instances ti JOIN public.sites s ON s.id = ti.site_id AND s.is_active AND s.overall_status::text <> 'cancelled'
    JOIN public.task_definitions td ON td.id = ti.task_def_id
    JOIN public.stage_definitions sd ON sd.id = td.stage_id
    WHERE (ti.state = 'locked' AND starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:'))
       OR (td.code = 'D8' AND NOT td.is_milestone_task AND ti.state IN ('locked', 'open') AND NOT ti.is_na)
       OR (td.is_milestone_task AND (manual ? sd.code) AND td.workflow_id = s.workflow_version_id AND ti.state IN ('locked', 'open', 'entry') AND NOT ti.is_na
           AND (SELECT x.code FROM public.hgd_evidence(ti.site_id, s.workflow_version_id, ARRAY[td.id]) x) IS NOT NULL)
    ORDER BY 1);
  SELECT coalesce(jsonb_object_agg(x.code, x.n), '{}'::jsonb) INTO ms_before FROM (
    SELECT td.code, count(*) AS n FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (sites) AND t.state = 'approved' GROUP BY td.code) x;
  PERFORM set_config('app.region_ids', '*', true);
  FOREACH sid IN ARRAY sites LOOP
    n_scan := n_scan + 1; changed := false; rounds := 0;
    BEGIN
      PERFORM public.hgd_mark('hist_quiet', sid::text);   -- no per-task notice for this site while the backfill settles it (wf_notify, 0129)
      PERFORM public.calc_refresh_site(sid);               -- the hook stands aside (hist_quiet): the rounds below apply the rules
      LOOP
        rounds := rounds + 1;
        EXIT WHEN rounds > 12;
        PERFORM set_config('pmis.calc_busy', '1', true);
        r := public.mmp_rules_site(sid, true);
        PERFORM set_config('pmis.calc_busy', was_busy, true);
        n := jsonb_array_length(r -> 'manual') + jsonb_array_length(r -> 'gates') + jsonb_array_length(r -> 'd8');
        EXIT WHEN n = 0;
        changed := true;
        FOR e IN SELECT x FROM jsonb_array_elements(r -> 'manual') x LOOP
          n_man := n_man + 1;
          IF coalesce((e ->> 'inferred')::boolean, false) THEN n_man_inf := n_man_inf + 1; END IF;
          by_man := jsonb_set(by_man, ARRAY[e ->> 'task_code'], to_jsonb(coalesce((by_man ->> (e ->> 'task_code'))::int, 0) + 1));
        END LOOP;
        FOR e IN SELECT x FROM jsonb_array_elements(r -> 'gates') x LOOP
          n_gates := n_gates + 1;
          by_gate := jsonb_set(by_gate, ARRAY[e ->> 'gate'], to_jsonb(coalesce((by_gate ->> (e ->> 'gate'))::int, 0) + 1));
        END LOOP;
        n_d8 := n_d8 + jsonb_array_length(r -> 'd8');
        PERFORM public.calc_refresh_site(sid);
      END LOOP;
      PERFORM public.hgd_unmark('hist_quiet');
    EXCEPTION WHEN others THEN   -- one site never stops the update of the server: reported in the System Log and counted (its changes are rolled back)
      PERFORM set_config('pmis.calc_busy', was_busy, true);
      PERFORM public.log_system_write('warn', 'calc', 'migration 0136: the moved-past backfill (manual milestone, gate, no microwave) could not run on a site',
        jsonb_build_object('site_id', sid, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), NULL, NULL);
      n_failed := n_failed + 1; changed := false;
    END;
    IF changed THEN n_changed := n_changed + 1; END IF;
  END LOOP;
  PERFORM set_config('app.region_ids', coalesce(rg, ''), true);
  SELECT coalesce(jsonb_object_agg(x.code, x.n), '{}'::jsonb) INTO ms_after FROM (
    SELECT td.code, count(*) AS n FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (sites) AND t.state = 'approved' GROUP BY td.code) x;
  res := jsonb_build_object('sites_scanned', n_scan, 'sites_changed', n_changed, 'sites_failed', n_failed,
    'manual_ms_approved', n_man, 'manual_ms_approved_by_code', by_man, 'manual_ms_inferred', n_man_inf,
    'gates_opened', n_gates, 'gates_opened_by_gate', by_gate, 'd8_na', n_d8,
    'milestones_approved_before', ms_before, 'milestones_approved_after', ms_after);
  IF n_scan = 0 THEN RETURN res; END IF;   -- nothing in scope (a new, empty database): nothing to report, no row
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('manual_ms_moved_past_backfill', 'site', 'all', jsonb_build_object('milestones_approved', ms_before),
          res || jsonb_build_object('rule', 'owner decision 2026-11-22: Site RFI (a manual milestone) the site moved past is approved directly as an admin override (pre-filled date, else the date of the earliest later task approved, inferred); then the gates the site moved past open and MW alignment without microwave is N/A (0134); all revertible'),
          'migration 0136: Site RFI the site moved past, on any site (owner decision 2026-11-22)', NULL, true);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC and pmis_app (none is an API door). The redefined
--     functions keep their owner and grants (CREATE OR REPLACE): admin_override_revert stays the API door, the others stay internal.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['mmp_guard_task()', 'mmp_approve_site(uuid,boolean)', 'mmp_rules_site(uuid,boolean)',
                           'mmp_restore_task(uuid,uuid,text,text,boolean)', 'mmp_backfill()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 12. The one-time backfill on the existing sites
-- ---------------------------------------------------------------------------------------------------------------------
SELECT mmp_backfill();
