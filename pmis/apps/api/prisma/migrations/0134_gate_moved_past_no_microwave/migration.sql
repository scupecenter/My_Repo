-- 0134_gate_moved_past_no_microwave: on ANY site, a phase gate the site has moved past is open as an admin override (the rule of 0127, which held only for a
-- historical load approved directly), and MW alignment (D8) is N/A on a site without microwave (the approved TE installation D6 has no MW antenna), also an
-- admin override; both revertible through the existing door, both applied once to the existing sites and from now on in the calculation path (owner
-- decisions 2026-11-22; CHANGELOG 176; contract 0.15.43).
-- Mirror: db/sql/133_gate_moved_past_no_microwave.sql (kept byte-identical).
--
-- WHY (production, read-only diagnosis 2026-11-22): the Master counts 282 sites On-Air (task D10 approved with the On-Air date), GSDN Workspace 273 (milestone
-- MS6 approved); 51 sites have D10 approved but MS6 locked. MS6 waits for D7, D8, D9 and D10. On 58 sites the TE installation D6 is approved with an actual date
-- through the normal approve step, yet TE Completion (MS5, calculated) is locked with lock_reason gate_closed:G5: the gate G5 (MS4 -> MS5, TE Installation
-- Readiness) waits for the permits "Access - TE" and "PTW - TE", which were never recorded in Permits & HSE for these sites, although the site clearly moved past
-- the gate (D6, D7, D9, D10 approved with dates). On 48 of the 51 sites D8 (MW alignment, Master CX / CY) is open with no date; it belongs to microwave sites only
-- (D6 carries v:mw_antenna, Master CN, filled for about 21% of the sites). These sites are not of a historical load, so 0126 / 0127 / 0129 never applied.
--
-- OWNER DECISIONS (2026-11-22):
--   1. A phase gate the site moved past is OPEN, the same rule as 0127, now for any site: an admin override of the site (kind gate_moved_past_open, the "Admin
--      override" badge, audited, revertible through POST /overrides/{id}/revert by a System Admin with a reason and a step-up; never applied again once
--      reverted). The permits stay unrecorded (no permit record is invented). The engine then opens the held tasks and calculates the milestones through the
--      normal path (calc_release_gated, wf_unlock_successors, calc_refresh_site). A stop work in force still holds the gate (0128: gate_eval keeps such a gate
--      blocked whatever the override says, and the rule never opens one).
--   2. MW alignment (D8) is N/A on a site without microwave: when the site's D6 is approved and its MW antenna is empty (rule below), an open or ready D8 is N/A
--      with na_reason 'no microwave on site (D6 MW antenna empty)', an admin override of the task (kind no_microwave_na), audited, revertible like the 0126 N/A.
--      Never a D8 with a date, a submission or a human workflow step, never on a site whose D6 has an MW antenna, nothing while D6 is not approved. The engine then
--      opens D9 / D10 if locked and calculates MS6.
--
-- RULE 1, "MOVED PAST" (the evidence of 0127, hgd_evidence over hgd_after_defs): the gate F -> T is moved past when a task the gate holds (a task of stage T not in
-- calc.gate_lock_exempt_tasks) or a later task (predecessor edges and the gate links) is approved with an actual date. The rule looks only at a gate that holds a
-- task of the site right now (a task locked with lock_reason 'gate_closed:<gate>') and that gate_eval reports blocked by its conditions; never a gate blocked by a
-- Change Control suspension or by a stop work in force; never a gate already open by an override (0127 or this one); never a gate whose override of either kind
-- (historical_gate_open, gate_moved_past_open) a System Admin reverted. It writes, as 0127 does: one admin_overrides row (entity site, kind
-- gate_moved_past_open, before {gate, status blocked, reasons}, after {gate, status open, evidence_task, evidence_date}, acted_by NULL: the rule of GSDN
-- Workspace, no person), site_gate_state.historical_open_override (+ time) of the gate (the column of 0127 that gate_eval reads; its guard hgd_guard_gate:
-- current user pmis_definer AND the definer-only marker hgd_gate of the row), one workflow step admin_override on the milestone task of stage T, one audit row
-- site_gate_moved_past_open (is_admin_override).
--
-- RULE 2, "NO MICROWAVE". D8 of the site's workflow (not a milestone task) in state locked or open (never entry, in review, in approval, rejected or suspended),
-- not N/A, every predecessor approved, N/A or skipped (D8 "would open": the order D7 -> D8 -> D9 is kept), no actual / start / submitted / approved date, no
-- measured RSL entered (values.measured_rsl and values.mw_rsl_dbm blank), no register record of the task in review or approval, no workflow step submit, approve,
-- reject, reopen or reassign, never marked and reverted before; and the site's D6 approved with its MW antenna (values.mw_antenna) EMPTY. The value domain of
-- v:mw_antenna is the list ["Done", "Pending", "N/A"] (0051 task fields, Master CN); the Master file may also carry a date or free text. EMPTY (nmw_mw_absent) =
-- the key is missing, JSON null, an empty array, the number 0, false, or a text that is blank or (trimmed, any case) one of 'n/a', 'na', 'no', 'none',
-- 'not applicable', '0', '-'. Anything else ("Done", "Pending", "Yes", a date, a type, a non-zero number) is an MW antenna: D8 is never touched. It writes:
-- state na, is_na, na_reason, the new flag task_instances.no_microwave_na (+ time; guard nmw_guard_task as hns_guard_task of 0128: current user pmis_definer AND
-- the definer-only marker nmw_task), admin_override true (the badge); one admin_overrides row (entity task, kind no_microwave_na, before {state}, after {state
-- na, na_reason, d6_mw_antenna}, acted_by NULL), one workflow step admin_override, one audit row task_no_microwave_na; then wf_unlock_successors. Any other path
-- that takes D8 out of N/A clears the flag and closes the override (audit row task_no_microwave_na_cleared).
--
-- WHEN IT RUNS:
--   (a) from now on, inside calc_refresh_site (the calculation path that every task state change, permit and Change Control change already runs): at the end
--       of each round, gmp_apply_site(site) applies rule 1 then rule 2; a change counts as progress, so the next round releases the held tasks
--       (calc_release_gated) and calculates the milestones (MS5, then MS6). A failure is written to the System Log and never stops the calculation. The hook
--       stands aside while the historical rules work on the site (the definer-only marker hist_quiet of 0129 is held, or a historical batch approved directly
--       with rows of the site is still open): there 0126 / 0127 / 0129 decide, as before, at the end of the load.
--   (b) once, now, on the existing sites (gmp_backfill, migration session only): every active, not cancelled site holding a task behind a closed gate or an
--       open D8, rule 1 then rule 2 then calc_refresh_site until nothing changes (at most 12 rounds), notifications muted per site (hist_quiet, as 0129), one
--       summary audit row gate_moved_past_no_microwave_backfill with counts only (no site data; no row when no site is in scope).
--
-- RESTORE: POST /overrides/{override_id}/revert (admin_override_revert: a System Admin, never a delegate, a reason, a step-up). gate_moved_past_open: the gate
-- follows its conditions again (hgd_restore_gate of 0127, generalised to this kind; open tasks are not re-locked, Q81), audit row site_gate_moved_past_restore.
-- no_microwave_na: the task is locked again and opened when its predecessors are done and no gate holds it (nmw_restore_task, as hns_restore_task), audit row
-- task_no_microwave_na_restore. A milestone calculated after them is never taken back (as 0126 / 0127). A reverted gate or D8 is never ruled again (by this
-- rule, nor the gate by the historical rule of 0127: hgd_settle_site now skips a gate reverted under either kind).
--
-- ACTOR. A rule override has no acting person: admin_overrides.acted_by may now be NULL for the two rule kinds only (CHECK), the audit rows carry actor_id NULL
-- (as the catch-ups of 0127 / 0129), and the API omits acted_by (the screens say "automatic rule"). An automatic closing of a no_microwave_na override with no
-- signed-in actor may leave reverted_by NULL, for the two rule kinds only (CHECK).
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0134"): calc_refresh_site (0122; also search_path now ends in pg_temp),
-- swl_open_for_load (0085: the marker hist_load), hgd_restore_gate (0128), hgd_settle_site (0129), ao_current_matches (0129), admin_override_revert (0129).
-- CREATE OR REPLACE keeps their owner and grants (admin_override_revert stays the API door; calc_refresh_site and swl_open_for_load stay internal).
--
-- Function rules: SECURITY DEFINER (except the guard, which runs as its writer like hns_guard_task), search_path = pg_catalog, public, pg_temp, owner
-- pmis_definer, EXECUTE revoked from PUBLIC and pmis_app. No new table; no new right for pmis_app (the flag columns are revoked here too; app_grants.sql keeps
-- task_instances, site_gate_state and admin_overrides unwritable). Contract 0.15.43: the override kinds gate_moved_past_open and no_microwave_na (Override.kind),
-- Override.acted_by absent for them.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Overrides made by a rule have no acting person (the two kinds of this migration only)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE admin_overrides ALTER COLUMN acted_by DROP NOT NULL;
ALTER TABLE admin_overrides ADD CONSTRAINT admin_overrides_rule_actor_check CHECK (acted_by IS NOT NULL OR kind IN ('gate_moved_past_open', 'no_microwave_na'));
ALTER TABLE admin_overrides DROP CONSTRAINT admin_overrides_revert_check;
ALTER TABLE admin_overrides ADD CONSTRAINT admin_overrides_revert_check CHECK ((reverted_at IS NULL) = (reverted_by IS NULL)
  OR (reverted_at IS NOT NULL AND reverted_by IS NULL AND kind IN ('gate_moved_past_open', 'no_microwave_na')));
COMMENT ON COLUMN admin_overrides.acted_by IS '0134: NULL only for an override made by a rule of GSDN Workspace (kinds gate_moved_past_open and no_microwave_na, owner decisions 2026-11-22)';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The flag of MW alignment made N/A for want of microwave, and its guard
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN no_microwave_na boolean NOT NULL DEFAULT false,
  ADD COLUMN no_microwave_na_at timestamptz,
  ADD CONSTRAINT task_instances_nmw_check CHECK (NOT no_microwave_na OR (state = 'na' AND is_na AND no_microwave_na_at IS NOT NULL));
CREATE INDEX task_instances_nmw_idx ON task_instances (site_id) WHERE no_microwave_na;
COMMENT ON COLUMN task_instances.no_microwave_na IS '0134: MW alignment (D8) N/A because the approved TE installation (D6) has no MW antenna (owner decision 2026-11-22; admin override, reversible through POST /overrides/{id}/revert)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (no_microwave_na, no_microwave_na_at), UPDATE (no_microwave_na, no_microwave_na_at) ON task_instances FROM pmis_app;
  END IF;
END $$;

-- The guard (runs as its writer, like hns_guard_task). The flag is set only by nmw_mark_site (current user pmis_definer AND the definer-only marker nmw_task of
-- this task in hgd_marks, from locked / open to na). When the task leaves N/A by any path the flag goes (audited, its override closed), unless the restore of
-- nmw_restore_task does it (current user pmis_definer AND the marker nmw_restore of this task). A session setting never stands in for a marker.
CREATE OR REPLACE FUNCTION nmw_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'no microwave: the N/A of MW alignment is written only by GSDN Workspace (migration 0134)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.no_microwave_na AND (NEW.state IS DISTINCT FROM 'na' OR NOT NEW.is_na) THEN
    NEW.no_microwave_na := false;
    IF NOT (current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('nmw_restore', NEW.id::text) ELSE false END)) THEN
      UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = coalesce(public.app_actor(), acted_by),
        revert_reason = left('the task left N/A (' || NEW.state::text || ')', 2000)
      WHERE task_id = NEW.id AND kind = 'no_microwave_na' AND reverted_at IS NULL;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_no_microwave_na_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('no_microwave_na', true, 'state', OLD.state::text),
        jsonb_build_object('no_microwave_na', false, 'state', NEW.state::text),
        'The task left N/A (' || NEW.state::text || '): the no-microwave mark is cleared.', public.app_actor());
    END IF;
    NEW.admin_override := EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = NEW.id AND o.reverted_at IS NULL AND o.kind <> 'no_microwave_na');
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.no_microwave_na, NEW.no_microwave_na_at) IS NOT DISTINCT FROM (OLD.no_microwave_na, OLD.no_microwave_na_at) THEN RETURN NEW; END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('nmw_task', NEW.id::text) ELSE false END)
     AND NEW.no_microwave_na AND NOT OLD.no_microwave_na AND NEW.state = 'na' AND NEW.is_na AND OLD.state IN ('locked', 'open') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'no microwave: the N/A of MW alignment is written only by GSDN Workspace (migration 0134)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER nmw_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.no_microwave_na OR NEW.no_microwave_na_at IS NOT NULL) EXECUTE FUNCTION nmw_guard_task();
CREATE TRIGGER nmw_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.no_microwave_na IS DISTINCT FROM OLD.no_microwave_na OR NEW.no_microwave_na_at IS DISTINCT FROM OLD.no_microwave_na_at
        OR (OLD.no_microwave_na AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.is_na IS DISTINCT FROM OLD.is_na)))
  EXECUTE FUNCTION nmw_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Helpers (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- The MW antenna of D6 is EMPTY (no microwave on the site). Conservative: only a missing / null / blank value or an explicit "no" answer counts as empty.
CREATE OR REPLACE FUNCTION nmw_mw_absent(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) = 'null' THEN true
    WHEN jsonb_typeof(p) = 'string' THEN lower(btrim(p #>> '{}')) IN ('', 'n/a', 'na', 'no', 'none', 'not applicable', '0', '-')
    WHEN jsonb_typeof(p) = 'number' THEN (p #>> '{}')::numeric = 0
    WHEN jsonb_typeof(p) = 'boolean' THEN NOT (p #>> '{}')::boolean
    WHEN jsonb_typeof(p) = 'array' THEN jsonb_array_length(p) = 0
    ELSE false
  END
$$;

-- A value entered on the task (the measured RSL of D8) is blank.
CREATE OR REPLACE FUNCTION nmw_blank(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p IS NULL OR jsonb_typeof(p) = 'null' OR (jsonb_typeof(p) = 'string' AND btrim(p #>> '{}') = '')
$$;

-- The historical rules (0126 / 0127 / 0129) are working on the site: their definer-only marker hist_quiet of the site is held, this transaction applies a
-- historical Master load (the definer-only marker hist_load, written by swl_open_for_load below at the start of the load), or a historical batch approved
-- directly that has rows of the site is not closed yet (its background sends are still running; the historical rules run at their end). The ongoing hook
-- stands aside then; the next calculation of the site after the load applies it.
CREATE OR REPLACE FUNCTION gmp_site_deferred(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('hist_quiet', p_site::text) OR public.hgd_marked('hist_load', '1') ELSE false END)
    OR EXISTS (SELECT 1 FROM public.import_batches b
               JOIN public.import_batch_rows r ON r.batch_id = b.id
               JOIN public.task_instances t ON t.id = r.task_instance_id
               WHERE b.historical_load AND b.historical_direct_approve AND b.closed_at IS NULL AND t.site_id = p_site)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Rule 1: the gates the site moved past (internal). Returns [{gate, evidence_code, evidence_date, override_id}].
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gmp_open_gates(p_site uuid, p_backfill boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; g record; gev record; e record; mt record; oid uuid; opened jsonb := '[]'::jsonb;
  rs constant text := 'owner decision 2026-11-22: the site moved past the gate (a task it holds, or a later one, is approved with an actual date); the gate is open as an admin override, its conditions stay unrecorded';
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN opened; END IF;
  FOR g IN
    SELECT x.link_code, x.to_code FROM public.phase_gate_rules x
    WHERE x.workflow_id = s.workflow_version_id AND x.is_active
      AND EXISTS (SELECT 1 FROM public.task_instances h WHERE h.site_id = p_site AND h.state = 'locked' AND h.lock_reason = 'gate_closed:' || x.link_code)
    ORDER BY x.seq
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.site_gate_state y WHERE y.site_id = p_site AND y.gate_code = g.link_code AND y.historical_open_override IS NOT NULL);
    -- reverted by a System Admin (this kind or the historical one): never opened again
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.site_id = p_site AND o.kind IN ('historical_gate_open', 'gate_moved_past_open')
                            AND o.after ->> 'gate' = g.link_code AND o.reverted_at IS NOT NULL);
    SELECT * INTO gev FROM public.gate_eval(p_site, g.link_code);
    -- blocked by its conditions only: never a Change Control suspension, never a stop work in force (stop work stays blocking)
    CONTINUE WHEN gev.status IS DISTINCT FROM 'blocked'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(gev.reasons, '[]'::jsonb)) z WHERE z ->> 'kind' IN ('suspension', 'stop_work'));
    SELECT * INTO e FROM public.hgd_evidence(p_site, s.workflow_version_id,
      ARRAY(SELECT td.id FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id
            WHERE sd.workflow_id = s.workflow_version_id AND sd.code = g.to_code AND NOT public.gate_lock_exempt(td.code)));
    CONTINUE WHEN e.code IS NULL;
    INSERT INTO public.admin_overrides (entity, site_id, kind, reason, before, after, acted_by)
    VALUES ('site', p_site, 'gate_moved_past_open', rs, jsonb_build_object('gate', g.link_code, 'status', 'blocked', 'reasons', coalesce(gev.reasons, '[]'::jsonb)),
            jsonb_build_object('gate', g.link_code, 'status', 'open', 'evidence_task', e.code, 'evidence_date', e.actual_date), NULL)
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
      VALUES (mt.id, greatest(mt.current_level, 1), 'admin_override', NULL,
              left('the gate ' || g.link_code || ' is open, the site moved past it (' || e.code || ' is approved on ' || e.actual_date::text
                   || '; admin override by the rule of 2026-11-22)' || CASE WHEN p_backfill THEN ', migration 0134' ELSE '' END, 2000),
              true, rs, false, mt.state, mt.state, clock_timestamp());
    END IF;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
    VALUES ('site_gate_moved_past_open', 'site', p_site::text, p_site, s.region_id,
            jsonb_build_object('gate', g.link_code, 'status', gev.status, 'reasons', coalesce(gev.reasons, '[]'::jsonb), 'override_open', false),
            jsonb_build_object('gate', g.link_code, 'status', 'open', 'override_open', true, 'reason_code', 'gate_moved_past_open', 'override_id', oid,
              'evidence_task', e.code, 'evidence_date', e.actual_date, 'backfill', coalesce(p_backfill, false),
              'rule', 'a gate the site moved past (a task it holds, or a later one, approved with an actual date) is open as an admin override; a stop work in force still holds it'),
            rs, NULL, true);
    opened := opened || jsonb_build_array(jsonb_build_object('gate', g.link_code, 'evidence_code', e.code, 'evidence_date', e.actual_date, 'override_id', oid));
  END LOOP;
  RETURN opened;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Rule 2: MW alignment (D8) N/A on a site without microwave (internal). Returns [{task_code, task_id, from, override_id}].
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nmw_mark_site(p_site uuid, p_backfill boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t record; cur public.task_instances%ROWTYPE; before jsonb; oid uuid; marked jsonb := '[]'::jsonb;
  why constant text := 'no microwave on site (D6 MW antenna empty)';
  rs constant text := 'owner decision 2026-11-22: MW alignment (D8) does not apply to a site without microwave (the approved TE installation D6 has no MW antenna)';
BEGIN
  FOR t IN
    SELECT ti.id, td.code, d6.values -> 'mw_antenna' AS mw
    FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.code = 'D8' AND NOT td.is_milestone_task
    JOIN public.sites s ON s.id = ti.site_id AND s.workflow_version_id = td.workflow_id
    JOIN public.task_definitions d6d ON d6d.workflow_id = td.workflow_id AND d6d.code = 'D6'
    JOIN public.task_instances d6 ON d6.site_id = ti.site_id AND d6.task_def_id = d6d.id AND d6.state = 'approved'
    WHERE ti.site_id = p_site AND ti.state IN ('locked', 'open') AND NOT ti.is_na AND NOT ti.no_microwave_na
      AND ti.actual_date IS NULL AND ti.actual_start IS NULL AND ti.submitted_date IS NULL AND ti.approved_date IS NULL
      AND public.nmw_blank(ti.values -> 'measured_rsl') AND public.nmw_blank(ti.values -> 'mw_rsl_dbm')
      AND public.nmw_mw_absent(d6.values -> 'mw_antenna')
      -- a gate holding D8 (its conditions, a stop work or a suspension) keeps it: the rule never steps past a gate
      AND coalesce(ti.lock_reason, '') NOT LIKE 'gate_closed:%'
      AND (SELECT h.gate_code FROM public.wf_gate_hold(ti.id) h) IS NULL
      -- D8 would open: every predecessor is done (the order D7 -> D8 -> D9 is kept)
      AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = p2.predecessor_id
                      WHERE p2.task_def_id = ti.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped'))
      AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = ti.id AND o.state IN ('in_review', 'in_approval'))
      -- a task a person ever submitted, approved, rejected, reopened or reassigned keeps its human path
      AND NOT EXISTS (SELECT 1 FROM public.workflow_steps w WHERE w.task_id = ti.id AND w.action::text IN ('submit', 'approve', 'reject', 'reopen', 'reassign'))
      -- reverted by a System Admin: never marked again
      AND NOT EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = ti.id AND o.kind = 'no_microwave_na' AND o.reverted_at IS NOT NULL)
  LOOP
    SELECT * INTO cur FROM public.task_instances WHERE id = t.id FOR UPDATE;
    CONTINUE WHEN cur.state NOT IN ('locked', 'open') OR cur.is_na OR cur.no_microwave_na OR cur.actual_date IS NOT NULL;
    before := public.wf_snap(t.id);
    PERFORM public.hgd_mark('nmw_task', t.id::text);
    UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = why, no_microwave_na = true, no_microwave_na_at = now(), admin_override = true,
      ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
      version = version + 1, updated_at = now()
    WHERE id = t.id;
    PERFORM public.hgd_unmark('nmw_task');
    INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
    VALUES ('task', p_site, t.id, 'no_microwave_na', rs, jsonb_build_object('state', cur.state::text),
            jsonb_build_object('state', 'na', 'na_reason', why, 'd6_mw_antenna', t.mw), NULL)
    RETURNING id INTO oid;
    INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
    VALUES (t.id, greatest(cur.current_level, 1), 'admin_override', NULL,
            left(why || ': the TE installation D6 is approved without an MW antenna (admin override by the rule of 2026-11-22)'
                 || CASE WHEN p_backfill THEN ', migration 0134' ELSE '' END, 2000),
            true, rs, false, cur.state, 'na', clock_timestamp());
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
    VALUES ('task_no_microwave_na', 'task', t.id::text, p_site, cur.region_id, before || jsonb_build_object('no_microwave_na', false),
            public.wf_snap(t.id) || jsonb_build_object('no_microwave_na', true, 'reason_code', 'no_microwave_na', 'na_reason', why, 'task_code', t.code,
              'override_id', oid, 'd6_mw_antenna', t.mw, 'backfill', coalesce(p_backfill, false),
              'rule', 'MW alignment (D8) is N/A when the approved TE installation (D6) has no MW antenna (missing, blank, 0, No, N/A or None)'),
            rs, NULL, true);
    PERFORM public.wf_unlock_successors(t.id);
    marked := marked || jsonb_build_array(jsonb_build_object('task_code', t.code, 'task_id', t.id, 'from', cur.state::text, 'override_id', oid));
  END LOOP;
  RETURN marked;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The hook of the calculation path (internal, called by calc_refresh_site at the end of each round). Returns the number of changes.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gmp_apply_site(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer := 0;
BEGIN
  -- cheap first: nothing held by a gate and no D8 still to decide on the site
  IF NOT EXISTS (SELECT 1 FROM public.task_instances h WHERE h.site_id = p_site AND h.state = 'locked' AND starts_with(coalesce(h.lock_reason, ''), 'gate_closed:'))
     AND NOT EXISTS (SELECT 1 FROM public.task_instances h JOIN public.task_definitions td ON td.id = h.task_def_id AND td.code = 'D8'
                     WHERE h.site_id = p_site AND h.state IN ('locked', 'open') AND NOT h.is_na) THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND s.is_active AND s.overall_status::text <> 'cancelled') THEN RETURN 0; END IF;
  IF public.gmp_site_deferred(p_site) THEN RETURN 0; END IF;
  BEGIN
    n := jsonb_array_length(public.gmp_open_gates(p_site, false));
    n := n + jsonb_array_length(public.nmw_mark_site(p_site, false));
  EXCEPTION WHEN others THEN   -- the rule never stops the calculation (nor the approval that triggered it): reported in the System Log
    PERFORM public.log_system_write('warn', 'calc', 'the gate moved-past / no-microwave rule could not run on a site',
      jsonb_build_object('site_id', p_site, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), public.app_actor(), NULL);
    RETURN 0;
  END;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The restore of a D8 made N/A (internal): the revert door
-- ---------------------------------------------------------------------------------------------------------------------
-- The task is locked again, opened at once when its predecessors are done and no gate holds it; never marked by the rule again.
CREATE OR REPLACE FUNCTION nmw_restore_task(p_task uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; before jsonb; oid uuid; hold record; opened boolean := false;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'no microwave: only a System Admin restores the task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT (t.state = 'na' AND t.no_microwave_na) THEN
    RETURN jsonb_build_object('task_id', p_task, 'outcome', 'not_marked');
  END IF;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = p_actor, revert_reason = left(btrim(p_reason), 2000)
  WHERE task_id = p_task AND kind = 'no_microwave_na' AND reverted_at IS NULL RETURNING id INTO oid;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('nmw_restore', p_task::text);
  UPDATE public.task_instances SET state = 'locked', is_na = false, na_reason = NULL, current_level = 0, no_microwave_na = false,
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('nmw_restore');
  IF NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = p2.predecessor_id
                 WHERE p2.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped')) THEN
    SELECT * INTO hold FROM public.wf_gate_hold(p_task);
    IF hold.gate_code IS NOT NULL THEN
      UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code WHERE id = p_task;
    ELSE
      opened := public.wf_open_locked(p_task, 'restored from N/A (no microwave on site)');
    END IF;
  END IF;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, 1, 'override_revert', p_actor, left(p_why, 2000), true, left(btrim(p_reason), 2000), coalesce(p_stepup, false), 'na',
          (SELECT state FROM public.task_instances WHERE id = p_task), clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_no_microwave_na_restore', 'task', p_task::text, t.site_id, t.region_id, before || jsonb_build_object('no_microwave_na', true),
          public.wf_snap(p_task) || jsonb_build_object('no_microwave_na', false, 'override_id', oid, 'opened', opened, 'why', p_why),
          left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(t.site_id);
  RETURN jsonb_build_object('task_id', p_task, 'outcome', 'restored', 'override_id', oid, 'opened', opened);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The calculation path runs the two rules (calc_refresh_site: latest 0122, changes marked 0134; search_path now ends in pg_temp)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calc_refresh_site(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changed integer := 0; round_ integer := 0; progress boolean; m record; ev record; manual jsonb; before jsonb; pre date; sid uuid; released integer;
  ruled integer;   -- 0134
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
    -- 0134: a gate the site moved past is open, and MW alignment is N/A on a site without microwave (owner decisions 2026-11-22; admin overrides by
    -- the rule, revertible); a change is progress, so the next round releases the held tasks and calculates the milestones
    ruled := public.gmp_apply_site(p_site);
    IF ruled > 0 THEN changed := changed + ruled; progress := true; END IF;
    EXIT WHEN NOT progress;
  END LOOP;
  PERFORM public.calc_gate_watch(p_site);
  PERFORM public.site_status_refresh(p_site);   -- 0122: the stored overall status follows the milestones (the dashboard rule)
  PERFORM set_config('pmis.calc_busy', '', true);
  RETURN changed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', '', true);
  RAISE;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8b. A historical Master load marks its transaction (swl_open_for_load: latest 0085, change marked 0134)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION swl_open_for_load(p_sites uuid[], p_reason text, p_source text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sid uuid; n int := 0;
BEGIN
  IF p_sites IS NULL OR cardinality(p_sites) = 0 THEN RETURN 0; END IF;
  PERFORM public.hw_require_admin_stepup();
  -- 0134: this transaction applies a historical Master load: the hook of the calculation (gmp_apply_site) stands aside until it ends, so the historical
  -- rules of 0126 / 0127 / 0129 decide its sites as before (definer-only marker; one row of hgd_marks per load transaction, never read again)
  IF p_source = 'historical_master_import' THEN PERFORM public.hgd_mark('hist_load', '1'); END IF;
  FOR sid IN SELECT s.id FROM public.sites s WHERE s.id = ANY (p_sites) AND s.workflow_locks ORDER BY s.site_code LOOP
    PERFORM public.swl_apply(sid, false, 'Historical load: ' || btrim(coalesce(p_reason, '')), p_source);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. The restore of a gate override takes either kind (hgd_restore_gate: latest 0128, changes marked 0134)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hgd_restore_gate(p_override uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.admin_overrides%ROWTYPE; s public.sites%ROWTYPE; mt record; gcode text;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'gates: only a System Admin closes a gate opened by an override' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_override AND kind IN ('historical_gate_open', 'gate_moved_past_open') FOR UPDATE;   -- 0134: either kind
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
  VALUES (CASE o.kind WHEN 'gate_moved_past_open' THEN 'site_gate_moved_past_restore' ELSE 'site_historical_gate_restore' END /* 0134 */, 'site', o.site_id::text, o.site_id, s.region_id, jsonb_build_object('gate', gcode, 'historical_open', true, 'override_id', o.id),
          jsonb_build_object('gate', gcode, 'historical_open', false, 'override_id', o.id, 'why', p_why), left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(o.site_id);
  RETURN jsonb_build_object('override_id', o.id, 'outcome', 'closed');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The historical settle loop never reopens a gate reverted under either kind (hgd_settle_site: latest 0129, change marked 0134)
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
-- 11. The revert door (ao_current_matches and admin_override_revert: latest 0129, changes marked 0134)
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
-- 12. The one-time backfill (migration session only): rule 1, then rule 2, then the calculation, per site until nothing changes; notices muted per site;
--     one summary audit row with counts only (no site data)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gmp_backfill() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sid uuid; g jsonb; m jsonb; e jsonb; n int; rounds int; changed boolean;
  rg text := current_setting('app.region_ids', true); was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
  n_scan int := 0; n_changed int := 0; n_failed int := 0; n_gates int := 0; n_d8 int := 0; by_gate jsonb := '{}'::jsonb;
  ms_before jsonb; ms_after jsonb; sites uuid[]; res jsonb;
BEGIN
  IF NOT public.app_ctx_legacy() THEN
    RAISE EXCEPTION 'gate moved past / no microwave: the backfill runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- the active, not cancelled sites that hold a task behind a closed gate or a D8 still to decide
  sites := ARRAY(
    SELECT DISTINCT ti.site_id FROM public.task_instances ti JOIN public.sites s ON s.id = ti.site_id AND s.is_active AND s.overall_status::text <> 'cancelled'
    JOIN public.task_definitions td ON td.id = ti.task_def_id
    WHERE (ti.state = 'locked' AND starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:'))
       OR (td.code = 'D8' AND ti.state IN ('locked', 'open') AND NOT ti.is_na)
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
        g := public.gmp_open_gates(sid, true);
        m := public.nmw_mark_site(sid, true);
        PERFORM set_config('pmis.calc_busy', was_busy, true);
        n := jsonb_array_length(g) + jsonb_array_length(m);
        EXIT WHEN n = 0;
        changed := true;
        FOR e IN SELECT x FROM jsonb_array_elements(g) x LOOP
          n_gates := n_gates + 1;
          by_gate := jsonb_set(by_gate, ARRAY[e ->> 'gate'], to_jsonb(coalesce((by_gate ->> (e ->> 'gate'))::int, 0) + 1));
        END LOOP;
        n_d8 := n_d8 + jsonb_array_length(m);
        PERFORM public.calc_refresh_site(sid);
      END LOOP;
      PERFORM public.hgd_unmark('hist_quiet');
    EXCEPTION WHEN others THEN   -- one site never stops the update of the server: reported in the System Log and counted (its changes are rolled back)
      PERFORM set_config('pmis.calc_busy', was_busy, true);
      PERFORM public.log_system_write('warn', 'calc', 'migration 0134: the gate moved-past / no-microwave backfill could not run on a site',
        jsonb_build_object('site_id', sid, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), NULL, NULL);
      n_failed := n_failed + 1; changed := false;
    END;
    IF changed THEN n_changed := n_changed + 1; END IF;
  END LOOP;
  PERFORM set_config('app.region_ids', coalesce(rg, ''), true);
  SELECT coalesce(jsonb_object_agg(x.code, x.n), '{}'::jsonb) INTO ms_after FROM (
    SELECT td.code, count(*) AS n FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.site_id = ANY (sites) AND t.state = 'approved' GROUP BY td.code) x;
  res := jsonb_build_object('sites_scanned', n_scan, 'sites_changed', n_changed, 'sites_failed', n_failed, 'gates_opened', n_gates,
    'gates_opened_by_gate', by_gate, 'd8_na', n_d8, 'milestones_approved_before', ms_before, 'milestones_approved_after', ms_after);
  IF n_scan = 0 THEN RETURN res; END IF;   -- nothing in scope (a new, empty database): nothing to report, no row
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('gate_moved_past_no_microwave_backfill', 'site', 'all', jsonb_build_object('milestones_approved', ms_before),
          res || jsonb_build_object('rule', 'owner decisions 2026-11-22: a gate the site moved past is open as an admin override (a stop work in force still holds it); MW alignment (D8) is N/A as an admin override when the approved TE installation (D6) has no MW antenna; both revertible'),
          'migration 0134: gates the site moved past and MW alignment without microwave (owner decisions 2026-11-22)', NULL, true);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 13. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC and pmis_app (none is an API door). The redefined
--     functions keep their owner and grants (CREATE OR REPLACE): admin_override_revert stays the API door, calc_refresh_site stays internal.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['nmw_guard_task()', 'nmw_mw_absent(jsonb)', 'nmw_blank(jsonb)', 'gmp_site_deferred(uuid)', 'gmp_open_gates(uuid,boolean)',
                           'nmw_mark_site(uuid,boolean)', 'gmp_apply_site(uuid)', 'nmw_restore_task(uuid,uuid,text,text,boolean)', 'gmp_backfill()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 14. The one-time backfill on the existing sites
-- ---------------------------------------------------------------------------------------------------------------------
SELECT gmp_backfill();
