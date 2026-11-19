-- 0126_historical_no_source_na: in the historical Master load, a task with no date in the owner's file is N/A "historical load: no source" when the site has
-- clearly moved past it (a later task of the workflow is approved with an actual date); never a date invented (owner decision "Option 1", 2026-11-18;
-- CHANGELOG 165; contract 0.15.38).
-- Mirror: db/sql/125_historical_no_source_na.sql (kept byte-identical).
--
-- WHY (production after the re-apply ea121d90 approved directly): the CW tasks (1386) and the TE tasks (3032) with an actual date are approved, but A2 (TSSR
-- Approved) and A4 (LLD Approved Date) have no date in the owner's file (empty columns), A3 is open on 247 sites and A5 on 232. Site Release (MS1) waits for
-- A2, A3, A4 and A5, so MS1 is the first open milestone of every site and every site shows Design & Acquisition as its current stage, although its later
-- CW / TE work is approved with dates. The owner chose "Option 1": such a task is not applicable for the historical load ("no source"), only where the site
-- clearly moved past it; a site that did not move on keeps the task open, and no date is ever invented.
--
-- THE RULE ("moved past", read from the workflow model). The predecessor graph of the workflow (task_predecessors) is connected across the stages: the first
-- tasks of a stage wait for the milestone task of the stage before (B1 <- MS1, B13 <- MS3, D1 <- MS4, D7 <- MS5, D11/D12 <- MS6, F1 <- MS7, D17 <- MS8,
-- D18 <- MS7, Z1 <- MS9 ...), and each milestone task waits for the tasks of its stage. So "a later task" is a transitive successor in that graph, and the
-- stage order adds nothing (every task of a later stage that depends on T is reachable; a task no later work depends on, such as MOB-1, MOB-5 or E1..E3,
-- has no successor and is never touched). A task T of a site S becomes N/A when ALL of these hold:
--   - S was touched by a historical Master load approved directly: a task of S carries the batch of a direct approval (historical_direct_batch_id) of a
--     historical Master import batch (the 0092 / 0093 / 0123 / 0124 paths). Live sites are never touched.
--   - T is in S's workflow version, is not a milestone task (milestones are calculated from their tasks, E3), and is locked, open or in entry, not N/A. A task
--     in review or approval, rejected, suspended, approved or skipped, or with a register record of its own in review or approval, is never touched.
--   - S has a task U, a transitive successor of T in the predecessor graph of S's workflow, that is approved with an actual date (the evidence, stored in the
--     audit row).
--   - No System Admin restored T from this N/A before (a reverted override of T): a restored task is never marked again.
-- Repeated per site until nothing changes (a milestone calculated after a mark can be the evidence of an earlier task whose only path to it ran through an
-- applicability N/A); at most 5 rounds.
--
-- WHAT A MARK DOES (one task): state na, is_na, na_reason "historical load: no source", the new flag task_instances.historical_no_source (+ time), and
-- admin_override = true (the existing override column: the "Admin override" badge, counted in the dashboard override_flagged_count; an N/A task is already
-- outside the Project Status counts and the SLA / on-time figures, so the flag changes no figure). One admin_overrides row (entity task, kind
-- historical_no_source_na, before the state, after na, the reason of the load, the loader) — so the existing revert door restores it — one workflow step
-- admin_override, one audit row task_historical_no_source_na (admin override, the reason code historical_no_source, the evidence task and date). Then the
-- successors unlock (wf_unlock_successors) and the site is recalculated once (calc_refresh_site: the calculated milestones, the gates, the overall status).
-- A milestone task is never marked: it completes by the normal rule (E3) once its predecessors are approved or N/A, with the latest date of its approved
-- counting predecessors. When none of them has a date (all N/A) the milestone has no date and stays open: it is counted (milestones_without_date) and
-- reported; GSDN Workspace never invents one. Site RFI (MS4) keeps its own rule (pre-filled, then approved by L2).
--
-- WHEN IT RUNS:
--   (a) the one-time catch-up of this migration (hns_catch_up), on every site in scope, as the System Admin who loaded it (the marker of the latest historical
--       batch of the site; a site whose loader is no longer an active System Admin is counted and left), one summary audit row historical_no_source_catch_up;
--   (b) at the end of every historical load approved directly (mi_apply_run with approve_directly): on the sites of the file, after every batch was sent and the
--       Acquisition sheet fed A3; when a batch of the file is sent in the background (imp_async), the rule runs when the last running send of the file ends
--       (the trigger hns_after_job on import_batch_jobs), never before, so a dated row of a batch still being sent is never pre-empted. One summary audit row
--       historical_no_source_apply per run.
--   A re-apply keeps it consistent: before the staging, a task marked historical_no_source whose row of the new file carries an actual date is restored
--   (hns_restore_dated, the override reverted, audited), so the row is sent and approved directly like any open task. Running again changes nothing.
--
-- RESTORE (reversible). The mark is an admin override row, so the existing door POST /overrides/{override_id}/revert (admin_override_revert: a System Admin,
-- never a delegate, a reason, a step-up) restores the task: the override is reverted, the task is locked again (opened at once when its predecessors are
-- approved or N/A and no gate holds it), the flag goes, admin_override stays only while another override of the task is active, one workflow step
-- override_revert, one audit row task_historical_no_source_restore. The team then enters the real date through L1 -> L2, or the next historical re-apply
-- approves it from the file. Any other path that takes the task out of N/A clears the flag too (trigger, audit row task_historical_no_source_cleared).
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0126"): ao_current_matches (0088), admin_override_revert (0088),
-- mi_apply_run 7 arguments (0125). CREATE OR REPLACE keeps their owner (pmis_definer), search_path and grants (admin_override_revert and mi_apply_run stay
-- the API doors of pmis_app).
--
-- Function rules: SECURITY DEFINER (except the flag guard, which runs as its writer like hda_guard_task), search_path = pg_catalog, public, pg_temp, owner
-- pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to pmis_app; no new table right. Contract 0.15.38: the override kind
-- historical_no_source_na (Override.kind) and its revert.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The flag of the task
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN historical_no_source boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_no_source_at timestamptz,
  ADD CONSTRAINT task_instances_hns_check CHECK (NOT historical_no_source OR (state = 'na' AND is_na AND historical_no_source_at IS NOT NULL));
CREATE INDEX task_instances_hns_idx ON task_instances (site_id) WHERE historical_no_source;
COMMENT ON COLUMN task_instances.historical_no_source IS '0126: N/A "historical load: no source": no date in the historical Master file and a later task of the site approved with a date (admin override, reversible through POST /overrides/{id}/revert)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (historical_no_source, historical_no_source_at), UPDATE (historical_no_source, historical_no_source_at) ON task_instances FROM pmis_app;
  END IF;
END $$;

-- The guard of the flag (runs as its writer, like hda_guard_task). The flag is set only by hns_mark_site (current user pmis_definer, the transaction marker
-- pmis.hns_task of this task, from locked / open / entry to na). When the task leaves N/A by any path the flag goes (audited unless the restore of
-- hns_restore_task does it, marker pmis.hns_restore), the active override row of the mark is closed, and admin_override stays only while another override of
-- the task is active.
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
    IF NOT (current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hns_restore', true), '') = NEW.id::text) THEN
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
  IF current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hns_task', true), '') = NEW.id::text
     AND NEW.historical_no_source AND NOT OLD.historical_no_source AND NEW.state = 'na' AND OLD.state IN ('locked', 'open', 'entry') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical load: the no-source flag of a task is written only by GSDN Workspace (migration 0126)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER hns_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.historical_no_source OR NEW.historical_no_source_at IS NOT NULL) EXECUTE FUNCTION hns_guard_task();
CREATE TRIGGER hns_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.historical_no_source IS DISTINCT FROM OLD.historical_no_source OR NEW.historical_no_source_at IS DISTINCT FROM OLD.historical_no_source_at
        OR (OLD.historical_no_source AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.is_na IS DISTINCT FROM OLD.is_na)))
  EXECUTE FUNCTION hns_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Scope and evidence (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- The site was touched by a historical Master load approved directly: a task of it carries the batch of a direct approval of a historical Master import batch.
CREATE OR REPLACE FUNCTION hns_site_in_scope(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.task_instances x JOIN public.import_batches b ON b.id = x.historical_direct_batch_id
                 WHERE x.site_id = p_site AND b.historical_load AND b.source = 'master_import' AND b.historical_direct_approve)
$$;

-- The System Admin who loaded the site: the marker of its latest historical batch approved directly, while an active System Admin (else NULL).
CREATE OR REPLACE FUNCTION hns_site_loader(p_site uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN public.app_user_is_system_admin(y.m) THEN y.m END FROM (
    SELECT b.historical_marked_by AS m FROM public.task_instances x JOIN public.import_batches b ON b.id = x.historical_direct_batch_id
    WHERE x.site_id = p_site AND b.historical_load AND b.source = 'master_import' AND b.historical_direct_approve AND b.historical_marked_by IS NOT NULL
    ORDER BY b.historical_marked_at DESC NULLS LAST, b.created_at DESC LIMIT 1) y
$$;

-- The first stage of the site whose milestone is not done (approved, N/A or skipped), by stage order; 'done' when every milestone is. The current stage of
-- SITE 360 (stageDone / stageNa of the sites service), for the counts of the summary rows.
CREATE OR REPLACE FUNCTION hns_current_stage(p_site uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT sd.code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task
                   JOIN public.stage_definitions sd ON sd.id = td.stage_id
                   WHERE ti.site_id = p_site AND ti.state NOT IN ('approved', 'na', 'skipped') AND NOT ti.is_na ORDER BY sd.seq LIMIT 1), 'done')
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The marks of one site (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- Marks every task of the site that the rule makes N/A, as p_actor (the System Admin of the load), then unlocks the successors and recalculates the site
-- (unless the caller's calculation runs). Returns {site_id, in_scope, marked: [{task_code, task_id, from, evidence_code, evidence_date}], milestones_without_date}.
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
      PERFORM set_config('pmis.hns_task', t.id::text, true);
      UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = why, historical_no_source = true, historical_no_source_at = now(), admin_override = true,
        ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
        version = version + 1, updated_at = now()
      WHERE id = t.id;
      PERFORM set_config('pmis.hns_task', '', true);
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The rule on a set of sites, with one summary audit row (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- Live (p_catchup false): as the signed-in System Admin of the load (mi_apply_run after its checks, or the end of its last background send). Catch-up
-- (p_catchup true): only in a migration session, each site as its loader. Returns the counts.
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
        PERFORM set_config('pmis.hns_task', '', true);
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
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The restore of one task (internal): the revert of its override, or a re-apply whose file now dates it
-- ---------------------------------------------------------------------------------------------------------------------
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
  PERFORM set_config('pmis.hns_restore', p_task::text, true);
  UPDATE public.task_instances SET state = 'locked', is_na = false, na_reason = NULL, current_level = 0, historical_no_source = false,
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM set_config('pmis.hns_restore', '', true);
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

-- The rows of a historical load approved directly (mi_apply_run, before the staging): a task marked historical_no_source whose cell "<code>:actual_date"
-- now carries a date is restored, so the staging sends and approves the row. Returns {restored, by_task}.
CREATE OR REPLACE FUNCTION hns_restore_dated(p_rows jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c record; n int := 0; by_code jsonb := '{}'::jsonb;
BEGIN
  FOR c IN
    SELECT DISTINCT ti.id, td.code
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END) e
    JOIN public.sites s ON upper(s.site_code) = upper(btrim(e ->> 'site_code'))
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e -> 'cells') = 'object' THEN e -> 'cells' ELSE '{}'::jsonb END) kv
    JOIN public.task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = split_part(kv.key, ':', 1)
    JOIN public.task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id
    WHERE kv.key ~ '^[^:]+:actual_date$' AND (kv.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND ti.historical_no_source AND ti.state = 'na'
    ORDER BY td.code, ti.id
  LOOP
    IF public.hns_restore_task(c.id, p_reason, 'historical re-apply: the file now carries an actual date for this task', true) ->> 'outcome' = 'restored' THEN
      n := n + 1;
      by_code := jsonb_set(by_code, ARRAY[c.code], to_jsonb(coalesce((by_code ->> c.code)::int, 0) + 1));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('restored', n, 'by_task', by_code);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The end of the last background send of a historical load approved directly (trigger on import_batch_jobs)
-- ---------------------------------------------------------------------------------------------------------------------
-- When the send of a batch of a historical Master load approved directly ends in the background and no other send of the same file is still running, the
-- rule runs on the sites of the file as the System Admin of the load (the batch may still be approved directly by them: hda_batch_ok). A failure is written to
-- the System Log; it never undoes the send.
CREATE OR REPLACE FUNCTION hns_after_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; rid uuid;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = NEW.batch_id;
  IF NOT FOUND OR NOT b.historical_direct_approve OR NOT b.historical_load OR b.source <> 'master_import' OR b.group_id IS NULL OR b.status = 'discarded' THEN
    RETURN NULL;
  END IF;
  IF public.app_actor() IS NULL OR NOT public.hda_batch_ok(b) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j JOIN public.import_batches x ON x.id = j.batch_id
             WHERE x.group_id = b.group_id AND j.state = 'running' AND j.id <> NEW.id) THEN
    RETURN NULL;
  END IF;
  SELECT r.id INTO rid FROM public.master_reconciliation_runs r WHERE r.group_id = b.group_id AND r.status = 'applied' LIMIT 1;
  IF rid IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.hns_apply_sites(ARRAY(SELECT DISTINCT x.site_id FROM public.master_reconciliation_rows x WHERE x.run_id = rid AND x.site_id IS NOT NULL),
      coalesce(b.historical_reason, 'historical load'), false, rid);
  EXCEPTION WHEN others THEN
    PERFORM public.log_system_write('warn', 'master-import', 'historical load: the no-source rule could not run after the background send',
      jsonb_build_object('run_id', rid, 'batch_id', b.id, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), public.app_actor(), NULL);
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER z_hns_after_job AFTER UPDATE OF state ON import_batch_jobs FOR EACH ROW
  WHEN (OLD.state = 'running' AND NEW.state IS DISTINCT FROM 'running') EXECUTE FUNCTION hns_after_job();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The revert door (ao_current_matches and admin_override_revert: latest 0088, changes marked 0126)
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
-- 8. The apply (mi_apply_run: latest 0125, changes marked 0126). The response is unchanged; the counts are in the audit rows.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb, p_registers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); r public.master_reconciliation_runs%ROWTYPE; prev uuid; tv public.template_versions%ROWTYPE; mpart jsonb; mcols jsonb; v_rows jsonb := '[]'::jsonb;
  row_ record; cells jsonb; pres jsonb; c jsonb; cv jsonb; res jsonb; b jsonb; sent jsonb; v_outcome jsonb; batches jsonb := '[]'::jsonb; gid uuid := gen_random_uuid();
  hw jsonb;   -- 0073: the mark of the batches
  q jsonb; queued int := 0;   -- 0075: a batch sent in the background
  su_until timestamptz;        -- 0075: when the verified step-up of this session ends (from the session row, never from the caller), for the audit rows of the run
  bg uuid := CASE WHEN coalesce(current_setting('pmis.mi_apply_job', true), '') ~ '^[0-9a-f-]{36}$' THEN current_setting('pmis.mi_apply_job', true)::uuid END;   -- 0086: the background run of this apply
  lim int; nsites int; jid uuid;   -- 0086
  hda boolean := false;   -- 0092: the historical load is approved directly (admin override, no L2)
  hrg boolean := false; regs jsonb; rres jsonb; rnotes jsonb := '[]'::jsonb;   -- 0093: the register sheets of the same file
  rap boolean := false; disc jsonb := '[]'::jsonb;   -- 0122: re-apply a file already applied, with direct approval; the batches discarded first
  dacells jsonb := '{}'::jsonb; dacodes text[];      -- 0122: the Design & Acquisition task dates read from the RF & Design sheet of the same file
  hrfn jsonb;                                        -- 0125: the rows of the direct approval noted after the staging
  hnsr jsonb; hnsp jsonb;                            -- 0126: the no-source N/A restored by a dated row of the file, and the rule at the end
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  SELECT * INTO r FROM public.master_reconciliation_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The import run does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The run changed since you read it. Reload and try again.')); END IF;
  IF r.status = 'applying' AND bg IS NULL THEN   -- 0086
    PERFORM public.wf_err('upload_processing', jsonb_build_object('detail', 'This file is being applied in the background. Wait until it ends.', 'run_id', p_run));
  END IF;
  IF NOT (r.status = 'previewed' OR (r.status = 'applying' AND bg IS NOT NULL AND EXISTS (SELECT 1 FROM public.mi_apply_jobs j WHERE j.id = bg AND j.run_id = p_run AND j.state = 'running'))) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This run was already applied.'));
  END IF;
  IF coalesce(p_mode, '') NOT IN ('submit', 'draft') OR coalesce(char_length(btrim(p_reason)), 0) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(
      jsonb_build_object('path', CASE WHEN coalesce(p_mode, '') NOT IN ('submit', 'draft') THEN '/mode' ELSE '/reason' END, 'code', 'required',
        'message', CASE WHEN coalesce(p_mode, '') NOT IN ('submit', 'draft') THEN 'mode is submit or draft.' ELSE 'A reason is required.' END))));
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p_historical IS NOT NULL THEN
    -- 0073 (Q462): a System Admin (not a delegate), the waiver open, a reason; draft mode has no document check, so it cannot be marked
    IF p_mode <> 'submit' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'The historical load is for the submit mode.'))));
    END IF;
    PERFORM public.hw_mark_authorize(p_historical ->> 'reason');
    hw := jsonb_build_object('reason', btrim(p_historical ->> 'reason'));
    hda := coalesce(p_historical -> 'approve_directly' = 'true'::jsonb, false);   -- 0092
    hrg := coalesce(p_historical -> 'registers' = 'true'::jsonb, false);          -- 0093
    rap := coalesce(p_historical -> 'reapply' = 'true'::jsonb, false);            -- 0122
    IF rap AND NOT hda THEN   -- 0122: a file already applied is applied again only with the direct approval (the owner decision of 2026-11-17)
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/approve_directly',
        'code', 'required', 'message', 'Re-applying a file that was already applied is done with the direct approval of the historical load.'))));
    END IF;
  END IF;
  -- 0093: the register sheets are read by the API from the file stored with this run (never sent by the caller of the endpoint); they come only with the
  -- historical option, and they must be of this file (its SHA-256)
  IF (p_registers IS NOT NULL OR hrg) AND p_historical IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/registers', 'code', 'invalid',
      'message', 'The register sheets are loaded with the historical load only.'))));
  END IF;
  IF hrg AND (p_registers IS NULL OR jsonb_typeof(p_registers) <> 'object' OR p_registers ->> 'file_sha256' IS DISTINCT FROM r.file_sha256
              OR jsonb_typeof(coalesce(p_registers -> 'parts', '[]'::jsonb)) <> 'array') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The register sheets were not read from the file of this run. Apply the file again.'));
  END IF;
  regs := CASE WHEN hrg THEN p_registers END;
  IF public.app_ctx_stepup() AND bg IS NULL THEN   -- 0075 (0086: in the background, the expiry recorded at the request)
    SELECT us.stepup_at + make_interval(secs => coalesce((SELECT CASE WHEN jsonb_typeof(st.value) = 'number' THEN (st.value #>> '{}')::int END
                                                          FROM public.settings st WHERE st.key = 'stepup_max_age_seconds'), 300))
      INTO su_until FROM public.user_sessions us WHERE us.id = public.log_ctx_uuid('session_id') AND us.user_id = actor AND us.revoked_at IS NULL AND us.stepup_at IS NOT NULL;
  ELSIF bg IS NOT NULL THEN
    SELECT j.stepup_until INTO su_until FROM public.mi_apply_jobs j WHERE j.id = bg;
  END IF;
  SELECT x.id INTO prev FROM public.master_reconciliation_runs x WHERE x.file_sha256 = r.file_sha256 AND x.status = 'applied' AND x.id <> r.id LIMIT 1;
  IF prev IS NOT NULL AND NOT rap THEN   -- 0122: lifted only for a re-apply with direct approval (the historical-load checks above passed)
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.',
      'already_applied', true, 'applied_run_id', prev));   -- 0122: the screen offers the re-apply to a System Admin
  END IF;
  -- 0086: a file with more sites than imports.async_rows is applied in the background, every check above passed: the request records the run and answers 202
  -- (status applying); mi_apply_step does the very same apply in a transaction of its own under the same person's signed context (no 30 s request limit)
  IF bg IS NULL THEN
    BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;
    SELECT count(DISTINCT upper(x.site_code)) INTO nsites FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL;
    IF nsites > lim THEN
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total,
                                        approve_directly, load_registers, registers, reapply)   -- 0092, 0093, 0122
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites,
              hda, hrg, regs, rap)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
          'approve_directly', hda, 'registers', hrg, 'reapply', rap), btrim(p_reason));   -- 0092, 0093, 0122
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'batches', '[]'::jsonb, 'queued', 0, 'approve_directly', hda, 'registers', hrg, 'reapply', rap);
    END IF;
  END IF;
  IF hw IS NOT NULL THEN
    -- 0085: the historical load accepts the data as it is: every site of the file loses its workflow locks first (audited per site, the reason of the load)
    PERFORM public.swl_open_for_load((SELECT array_agg(DISTINCT x.site_id) FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', 'historical_master_import');
  END IF;
  IF rap THEN
    -- 0122: before anything is staged, the open batches of the earlier historical Master loads (and of this file) are discarded (audited per batch): their
    -- rows are never applied, so nothing is entered or approved twice. In the background this runs in the transaction of the apply itself.
    disc := public.hrp_discard_open(r, hw ->> 'reason');
  END IF;
  IF hda THEN
    -- 0125: the staging of the historical load approved directly is marked for this transaction (hrf_staging): the Matrix entry holder (L1) does not stop a
    -- row, and a value outside a register list is kept as typed; the mark ends with the staging (the sending checks the batch of each row, hrf_override_ok)
    INSERT INTO public.hrf_stage_marks (xid, actor_id, run_id) VALUES (txid_current(), actor, p_run)
      ON CONFLICT (xid) DO UPDATE SET actor_id = EXCLUDED.actor_id, run_id = EXCLUDED.run_id, created_at = now();
  END IF;

  SELECT v.* INTO tv FROM public.template_versions v JOIN public.template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current;
  SELECT x INTO mpart FROM jsonb_array_elements(tv.columns) x WHERE x ->> 'kind' = 'master' LIMIT 1;
  mcols := mpart -> 'columns';
  IF hrg THEN
    -- 0122: the Master sheet has no typed column for the Design & Acquisition tasks: its Site Release (V) is a formula over the RF & Design sheet (TSSR
    -- Approved, LLD Approved Date, and for a HUB or Terminal site the MW LOS Survey Date and the Link Budget Date) and the Acquisition sheet. With the register
    -- sheets of the same file, the dates of A2 (TSSR approval), A4 (LLD approval) and A5 (MW LOS and link budget, HUB / Terminal only, the later of the two)
    -- are entered on the site's row like a typed column, so they are staged in the Design & Acquisition batch. Only the non-derived task columns of an active
    -- stream template are used (A3 comes from the Acquisition register and is derived; A1 has no source in the file).
    SELECT coalesce(array_agg(DISTINCT tc ->> 'code'), ARRAY[]::text[]) INTO dacodes
    FROM public.template_definitions td_ JOIN public.template_versions tv_ ON tv_.template_def_id = td_.id AND tv_.is_current, jsonb_array_elements(tv_.columns) tc
    WHERE td_.kind = 'stream' AND td_.is_active AND tc ->> 'kind' = 'task' AND NOT coalesce((tc ->> 'derived')::boolean, false)
      AND tc ->> 'code' IN ('A2:actual_date', 'A4:actual_date', 'A5:actual_date');
    SELECT coalesce(jsonb_object_agg(x.k, x.cl), '{}'::jsonb) INTO dacells FROM (
      SELECT DISTINCT ON (y.k) y.k, y.cl FROM (
        SELECT upper(btrim(e ->> 'site_code')) AS k, (e ->> 'row_no') AS rn,
          (SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb) FROM jsonb_each(jsonb_strip_nulls(jsonb_build_object(
             'A2:actual_date', CASE WHEN (e -> 'data' ->> 'tssr_approved') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN e -> 'data' ->> 'tssr_approved' END,
             'A4:actual_date', CASE WHEN (e -> 'data' ->> 'lld_approved_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN e -> 'data' ->> 'lld_approved_date' END,
             'A5:actual_date', CASE WHEN lower(coalesce(s.site_type, '')) IN ('hub', 'terminal')
                                     AND (e -> 'data' ->> 'mw_los_survey_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND (e -> 'data' ->> 'link_budget_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                                    THEN greatest(e -> 'data' ->> 'mw_los_survey_date', e -> 'data' ->> 'link_budget_date') END))) kv
           WHERE kv.key = ANY (dacodes)) AS cl
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(regs -> 'parts') = 'array' THEN regs -> 'parts' ELSE '[]'::jsonb END) p,
             jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'rows') = 'array' THEN p -> 'rows' ELSE '[]'::jsonb END) e
        LEFT JOIN public.sites s ON upper(s.site_code) = upper(btrim(e ->> 'site_code'))
        WHERE p ->> 'register' = 'rf_design' AND jsonb_typeof(e -> 'data') = 'object' AND nullif(btrim(e ->> 'site_code'), '') IS NOT NULL) y
      WHERE y.cl <> '{}'::jsonb ORDER BY y.k, y.rn) x;
  END IF;
  FOR row_ IN SELECT * FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL ORDER BY x.row_no LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.master_reconciliation_rows y WHERE y.run_id = p_run AND upper(y.site_code) = upper(row_.site_code) AND y.row_no < row_.row_no);
    cells := '{}'::jsonb; pres := '[]'::jsonb;
    FOR c IN SELECT x FROM jsonb_array_elements(mcols) x WHERE x ->> 'kind' = 'task' AND NOT coalesce((x ->> 'derived')::boolean, false) LOOP
      cv := row_.cells -> (c ->> 'master_col');
      CONTINUE WHEN cv IS NULL OR cv -> 'v' IS NULL OR jsonb_typeof(cv -> 'v') = 'null';
      IF coalesce((cv ->> 'f')::boolean, false) THEN
        pres := pres || jsonb_build_array(jsonb_build_object('column', c ->> 'header', 'field', c ->> 'code', 'code', 'formula_not_allowed', 'message', 'Cells must hold values, not formulas.'));
      ELSE
        cells := cells || jsonb_build_object(c ->> 'code', cv -> 'v');
      END IF;
    END LOOP;
    IF dacells ? upper(row_.site_code) THEN cells := (dacells -> upper(row_.site_code)) || cells; END IF;   -- 0122
    CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row_no', row_.row_no, 'site_code', row_.site_code, 'cells', cells, 'pre_errors', pres));
  END LOOP;
  IF jsonb_array_length(v_rows) = 0 AND NOT (hrg AND jsonb_array_length(coalesce(regs -> 'parts', '[]'::jsonb)) > 0) THEN   -- 0093: a file of register sheets only
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  IF hda THEN
    -- 0126: a task marked N/A "historical load: no source" whose row of this file now carries an actual date is restored first (its override reverted,
    -- audited), so the staging below sends the row and approves it directly like any open task
    hnsr := public.hns_restore_dated(v_rows, hw ->> 'reason');
  END IF;
  IF jsonb_array_length(v_rows) > 0 THEN
    res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
      jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  ELSE
    res := jsonb_build_object('group_id', gid, 'batches', '[]'::jsonb, 'skipped', '[]'::jsonb);
  END IF;
  IF hrg THEN
    -- 0093: each register sheet becomes a register batch of the same group (source master_import, the historical mark), after the stream batches, so it is
    -- sent after them; a sheet that cannot be staged is skipped with its reason, never the whole apply
    rres := public.hrg_stage_registers(regs, r, p_mode, gid, hw ->> 'reason');
    res := res || jsonb_build_object('batches', (res -> 'batches') || (rres -> 'batches'), 'skipped', coalesce(res -> 'skipped', '[]'::jsonb) || (rres -> 'skipped'));
    rnotes := rres -> 'notes';
  END IF;
  DELETE FROM public.hrf_stage_marks WHERE xid = txid_current();   -- 0125: the staging ends here
  IF hda THEN
    -- 0092: the batches just staged are marked for direct approval (a System Admin, the step-up, the open waiver, checked again on each batch); every
    -- submitted row of them is then approved at once by the sender, here or in the chunked background send (the mark is read from the batch row there)
    PERFORM public.hda_mark_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');
    hrfn := public.hrf_note_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');   -- 0125: noted and audited
  END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0, 'approved', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
        'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));   -- 0093
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
      'approved', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action IN ('create', 'update') AND x.decision = 'approved'),   -- 0092, 0093
      'rows', (SELECT x.rows_total FROM public.import_batches x WHERE x.id = (b ->> 'id')::uuid),   -- 0093: the rows of the batch, and the rows that changed nothing
      'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));
  END LOOP;
  IF hda AND hrg THEN
    -- 0124: the Acquisition sheet of the same file closes the tasks the Acquisition register is the source of (A3), as Master T reads it (the one selected
    -- candidate's Contract Sign-off Date), approved directly; also when the register refused its row (no Selection Date in the owner's file, Q468)
    FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x WHERE x ->> 'kind' = 'register' AND x ->> 'ref' = 'acquisition' LOOP
      PERFORM public.hms_feed_acquisition((b ->> 'id')::uuid, false, hw ->> 'reason');
    END LOOP;
  END IF;
  IF hda AND queued = 0 THEN
    -- 0126: every batch of the file is sent and A3 is fed: a task with no date in the file is N/A "historical load: no source" where a later task of the
    -- site is approved with a date (hns_mark_site). When a batch is sent in the background, this runs when its last send ends (hns_after_job).
    hnsp := public.hns_apply_sites(ARRAY(SELECT DISTINCT x.site_id FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', false, p_run);
  END IF;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued, 'approve_directly', hda,   -- 0092
    'registers', hrg, 'register_notes', rnotes,   -- 0093
    'reapply', rap, 'discarded', disc);   -- 0122
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
      'approve_directly', hda, 'registers', hrg, 'reapply', rap), btrim(p_reason));   -- 0092, 0093, 0122
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app. The redefined functions
--    keep their owner and grants (CREATE OR REPLACE): admin_override_revert and mi_apply_run stay the API doors.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hns_guard_task()', 'hns_site_in_scope(uuid)', 'hns_site_loader(uuid)', 'hns_current_stage(uuid)', 'hns_mark_site(uuid,uuid,text,boolean)',
                           'hns_apply_sites(uuid[],text,boolean,uuid)', 'hns_restore_task(uuid,text,text,boolean)', 'hns_restore_dated(jsonb,text)', 'hns_after_job()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The one-time catch-up (the migration session: each site as the System Admin who loaded it)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hns_catch_up() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.app_ctx_legacy() THEN
    RAISE EXCEPTION 'historical no source: the catch-up runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.hns_apply_sites(ARRAY(SELECT DISTINCT x.site_id FROM public.task_instances x JOIN public.import_batches b ON b.id = x.historical_direct_batch_id
                                       WHERE b.historical_load AND b.source = 'master_import' AND b.historical_direct_approve),
    'migration 0126: a task with no date in the historical Master file is N/A "historical load: no source" where the site moved past it (owner decision Option 1, 2026-11-18)',
    true, NULL);
END $$;
ALTER FUNCTION hns_catch_up() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION hns_catch_up() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON FUNCTION hns_catch_up() FROM pmis_app; END IF;
END $$;

SELECT hns_catch_up();
