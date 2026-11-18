-- 0123_historical_register_tasks: the tasks fed by a register, closed by the register records of the historical Master load approved directly (owner report
-- 2026-11-18; owner decisions 2026-11-12 "Direct approval" and "Everything from the one file"; CHANGELOG 162).
-- Mirror: db/sql/122_historical_register_tasks.sql (kept byte-identical).
--
-- WHY. After 0122 the historical Master file was applied again with direct approval and its register sheets (0093). The register rows were approved directly,
-- but 0093 never links a record of the historical load to the task it is the source of (reg_link_task returns NULL for such a row; 0122 finding 1). The
-- tasks whose completion comes from a register (Q43: register_task_sources) therefore stayed open: A3 (Acquisition), B1, B2 (Procurement PR / PO), C3 (HLC
-- requests, Q150), B3, D1 (Permits & HSE access permits), C1, C2 (GECOL), C4 (HLC), D17, Z1 (Readiness & Handover). Site Release (MS1) waits for A3 and every
-- later milestone waits for the previous one, so every site of the file showed the Design & Acquisition stage as current. The owner wants the history of the
-- real Site Master to show in the system with no approval, gate or lock holding it.
--
-- WHAT THIS ADDS.
--   1. When hda_approve_record (0093) approves a register record of a register sheet of the historical load directly, the feed of a normal final approval now
--      runs too (hrt_feed_record): for every active task source of the record's register that the record matches (reg_source_matches: the data conditions and
--      a source date), the site's task takes the record's date as its actual date and is approved directly as the admin override of the historical load
--      (hrt_feed_task: the flag task_instances.historical_direct_approved with the register batch, one audit row `task_historical_direct_approval`, admin
--      override, the reason of the load), its successors unlock (wf_unlock_successors) and the milestones, SLA, gates and the overall status follow through the
--      existing triggers (calc_refresh_site, 0122 site_status_refresh). C3 follows its own rule (Q150, hlc_c3_sync): an HLC request never closes it alone; it is
--      approved with the latest HLC approval date once every HLC request of the scope is approved. The record is linked to the first task it closed
--      (register_records.task_id), as a normal submission links it. The tasks MOB-1 / MOB-2 / MOB-5 keep their own feed (fleet_sync, 0076).
--      One register row with both dates of two sources (a PR-PO row with PR Date and PO / WO Date) closes both tasks (B1 and B2): in normal work they come
--      from two approvals of the same logical record.
--   2. Never twice, never reopened: a task that is approved, N/A or skipped is left alone; a task with its own submission in review or approval (or another
--      record in review linked to it) keeps its normal L2 path; a rejected or suspended task is left alone; a record without the source date, or with a date
--      in the future, closes nothing (the rule of reg_complete_task). A refusal of one task (for example a document rule still pending) is reported in the
--      System Log and never fails the register row.
--   3. A one-time catch-up for the data already loaded (hrt_catch_up, run once below): every register record still approved directly by a historical load
--      (0093 / 0122, the version in force) goes through the same feed, as the System Admin who loaded it (the migration session's legacy context, never a
--      request), with the same guards and audit rows, then one summary audit row `historical_register_tasks_catch_up` with the counts. On a server where the
--      file was not applied again yet there is nothing to catch up (the re-apply then takes path 1); run again, it changes nothing (idempotent).
--   4. Guards. The task flag stays writable only inside definer code (hda_guard_task, now with a second path): the marker pmis.hrt_task of this task and
--      pmis.hrt_record of a register record that is approved directly, of the same site, from a register batch of the Master import marked for direct approval
--      (the batch named on the task), and either the batch may still be approved directly by the signed-in System Admin (hda_batch_ok) or the catch-up of this
--      migration runs in a migration session (marker pmis.hrt_catchup and app_ctx_legacy). The previous state of the task is locked, open or entry.
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0123"): hda_approve_record (0093), hda_guard_task (0092).
-- CREATE OR REPLACE keeps their owner (pmis_definer), search_path and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to
-- pmis_app: the API door stays mi_apply_run / mi_apply_step. No new table right. No contract change.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The direct approval of one task fed by a register record (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- Approves the task p_task with the date p_date taken from the record p_record (source p_code / p_field), as the admin override of the historical load of the
-- register batch p_batch. Returns {task_id, task_code, outcome, unlocked_task_ids}; outcome 'approved' or why the task was left alone. Called only by
-- hrt_feed_record (inside its own block, so a refusal is reported there).
CREATE OR REPLACE FUNCTION hrt_feed_task(p_task uuid, p_record uuid, p_batch uuid, p_date date, p_code text, p_field text, p_catchup boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; r public.register_records%ROWTYPE; n int; lvl int; before jsonb; unlocked uuid[] := ARRAY[]::uuid[];
  note text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR r.id IS NULL OR t.site_id IS DISTINCT FROM r.site_id THEN
    RETURN jsonb_build_object('task_id', p_task, 'task_code', p_code, 'outcome', 'no_task');
  END IF;
  IF t.state = 'approved' THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'already_approved'); END IF;
  IF t.state IN ('na', 'skipped') OR t.is_na THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'not_applicable'); END IF;
  IF t.state IN ('in_review', 'in_approval')
     OR EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = t.id AND o.id <> p_record AND o.state IN ('in_review', 'in_approval')) THEN
    RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'open_submission');   -- keeps its normal L2 path
  END IF;
  IF t.state NOT IN ('locked', 'open', 'entry') THEN
    RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'kept_' || t.state::text);
  END IF;
  IF p_date IS NULL THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'no_date'); END IF;
  IF p_date > public.cal_today() THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'future_date'); END IF;
  before := public.wf_snap(p_task);
  n := coalesce(t.levels_required, public.wf_task_levels(p_task));
  note := 'historical load: approved directly with the register record ' || r.register_key || ' ' || r.id::text || ' (admin override)'
          || CASE WHEN p_catchup THEN ', migration 0123' ELSE '' END;
  PERFORM set_config('pmis.hrt_task', p_task::text, true);
  PERFORM set_config('pmis.hrt_record', p_record::text, true);
  IF p_catchup THEN PERFORM set_config('pmis.hrt_catchup', p_task::text, true); END IF;
  UPDATE public.task_instances SET state = 'approved', actual_date = p_date, current_level = greatest(n, t.current_level),
    path_frozen_at = coalesce(path_frozen_at, now()), submitted_date = coalesce(submitted_date, r.submitted_at::date, current_date), approved_date = current_date,
    ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL, self_approval = false,
    historical_direct_approved = true, historical_direct_batch_id = p_batch, historical_direct_approved_at = now(), version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM set_config('pmis.hrt_task', '', true);
  PERFORM set_config('pmis.hrt_record', '', true);
  PERFORM set_config('pmis.hrt_catchup', '', true);
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
    WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
  VALUES (p_task, greatest(n, 1), 'approve', actor, note, t.state, 'approved', NOT coalesce(p_catchup, false), false, clock_timestamp());
  FOR lvl IN greatest(t.current_level, 1) .. greatest(n, 1) LOOP
    INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, lvl, actor, 'acted')
      ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  END LOOP;
  unlocked := public.wf_unlock_successors(p_task);
  PERFORM public.log_audit_write('task_historical_direct_approval', 'task', p_task::text,
    before || jsonb_build_object('historical_direct_approved', false),
    public.wf_snap(p_task) || jsonb_build_object('historical_direct_approved', true, 'batch_id', p_batch, 'register_record_id', p_record,
      'register_key', r.register_key, 'task_code', p_code, 'source_field', p_field, 'levels_approved', greatest(n, 1) - greatest(t.current_level, 1) + 1,
      'unlocked_task_ids', to_jsonb(unlocked), 'catch_up', coalesce(p_catchup, false),
      'rule', 'a task fed by a register record of the historical load, approved at once with the record''s date as an admin override (no L2)'),
    p_reason, t.site_id, t.region_id, NULL, true);
  RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'approved', 'unlocked_task_ids', to_jsonb(unlocked));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The feed of one register record approved directly (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- The tasks the record p_record closes, as a normal final approval would (Q43, Q150), each approved directly by hrt_feed_task. The record must be approved
-- directly by the register batch p_batch of the historical Master import (read from the stored rows). Live (p_catchup false): the batch may still be approved
-- directly by the signed-in System Admin (hda_batch_ok). Catch-up (p_catchup true): only in a migration session (app_ctx_legacy). Does not link the record:
-- returns {items: [...], link_task_id} and the caller links it.
CREATE OR REPLACE FUNCTION hrt_feed_record(p_record uuid, p_batch uuid, p_catchup boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.register_records%ROWTYPE; b public.import_batches%ROWTYPE; src record; tid uuid; d date; res jsonb; items jsonb := '[]'::jsonb; link uuid; j jsonb;
  hlc_req boolean; s record;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT FOUND OR r.site_id IS NULL OR r.state <> 'approved' OR NOT r.historical_direct_approved OR r.historical_direct_batch_id IS DISTINCT FROM p_batch THEN
    RETURN jsonb_build_object('items', items);
  END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND OR NOT b.historical_direct_approve OR NOT b.historical_load OR b.source <> 'master_import' OR b.register_key IS DISTINCT FROM r.register_key
     OR NOT (CASE WHEN coalesce(p_catchup, false) THEN public.app_ctx_legacy() ELSE public.hda_batch_ok(b) END) THEN
    RAISE EXCEPTION 'historical register tasks: the record is not approved directly by a register sheet of a historical Master import' USING ERRCODE = 'insufficient_privilege';
  END IF;
  hlc_req := r.register_key = 'procurement' AND r.data ->> 'scope' = 'HLC';
  FOR src IN SELECT x.task_code, x.date_field FROM public.register_task_sources x
             WHERE x.register_key = r.register_key AND x.is_active AND x.task_code NOT LIKE 'MOB-%'   -- MOB-x: their own feed (fleet_sync, 0076)
             ORDER BY x.sort_order, x.task_code LOOP
    CONTINUE WHEN src.task_code = 'C3' AND hlc_req;   -- Q150: an HLC request never closes C3 alone (below)
    CONTINUE WHEN NOT public.reg_source_matches(p_record, src.task_code);
    tid := NULL;
    SELECT ti.id INTO tid FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.sites st ON st.id = ti.site_id AND st.workflow_version_id = td.workflow_id
      WHERE ti.site_id = r.site_id AND td.code = src.task_code LIMIT 1;
    CONTINUE WHEN tid IS NULL;
    BEGIN d := (r.data ->> src.date_field)::date; EXCEPTION WHEN others THEN d := NULL; END;
    BEGIN
      res := public.hrt_feed_task(tid, p_record, p_batch, d, src.task_code, src.date_field, p_catchup, p_reason);
    EXCEPTION WHEN others THEN
      j := public.imp_wf_json(SQLERRM);
      PERFORM set_config('pmis.hrt_task', '', true);
      PERFORM set_config('pmis.hrt_record', '', true);
      PERFORM set_config('pmis.hrt_catchup', '', true);
      PERFORM public.log_system_write('warn', 'master-import', 'historical load: a task fed by a register record was not approved',
        jsonb_build_object('task_id', tid, 'task_code', src.task_code, 'register_record_id', p_record, 'batch_id', p_batch, 'sqlstate', SQLSTATE,
          'code', j ->> 'code', 'error', left(SQLERRM, 300)), public.app_actor(), NULL);
      res := jsonb_build_object('task_id', tid, 'task_code', src.task_code, 'outcome', 'refused', 'code', coalesce(j ->> 'code', SQLSTATE));
    END;
    items := items || jsonb_build_array(res);
    IF link IS NULL AND res ->> 'outcome' = 'approved' THEN link := tid; END IF;
  END LOOP;
  IF hlc_req OR r.register_key = 'hlc' THEN
    -- C3 (Q150, as hlc_c3_sync): approved with the latest HLC approval date once every HLC request of the scope is approved by HLC
    tid := NULL;
    SELECT ti.id INTO tid FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.sites st ON st.id = ti.site_id AND st.workflow_version_id = td.workflow_id
      WHERE ti.site_id = r.site_id AND td.code = 'C3' AND ti.state IN ('locked', 'open', 'entry') AND NOT ti.is_na LIMIT 1;
    IF tid IS NOT NULL AND EXISTS (SELECT 1 FROM public.register_task_sources x WHERE x.register_key = 'procurement' AND x.task_code = 'C3' AND x.is_active) THEN
      SELECT * INTO s FROM public.hlc_pr_status(r.site_id, public.hlc_scope_links(r.site_id));
      IF s.complete AND s.last_date IS NOT NULL THEN
        BEGIN
          res := public.hrt_feed_task(tid, p_record, p_batch, s.last_date, 'C3', 'hlc_approval_date (every HLC request of the scope, Q150)', p_catchup, p_reason);
        EXCEPTION WHEN others THEN
          j := public.imp_wf_json(SQLERRM);
          PERFORM set_config('pmis.hrt_task', '', true);
          PERFORM set_config('pmis.hrt_record', '', true);
          PERFORM set_config('pmis.hrt_catchup', '', true);
          PERFORM public.log_system_write('warn', 'master-import', 'historical load: a task fed by a register record was not approved',
            jsonb_build_object('task_id', tid, 'task_code', 'C3', 'register_record_id', p_record, 'batch_id', p_batch, 'sqlstate', SQLSTATE,
              'code', j ->> 'code', 'error', left(SQLERRM, 300)), public.app_actor(), NULL);
          res := jsonb_build_object('task_id', tid, 'task_code', 'C3', 'outcome', 'refused', 'code', coalesce(j ->> 'code', SQLSTATE));
        END;
        items := items || jsonb_build_array(res);
        IF link IS NULL AND hlc_req AND res ->> 'outcome' = 'approved' THEN link := tid; END IF;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('items', items, 'link_task_id', link);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The guard of the task flag (hda_guard_task: latest 0092, changes marked 0123)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hda_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical direct approval: the flag of a task is written only by GSDN Workspace (migration 0092)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_direct_approved AND NEW.state IS DISTINCT FROM 'approved' THEN
    -- a reopening: the flag goes, the batch reference stays for the history; the next approval is a normal one
    IF (NEW.historical_direct_batch_id, NEW.historical_direct_approved_at) IS DISTINCT FROM (OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
      RAISE EXCEPTION 'historical direct approval: the batch of a flagged task never changes (migration 0092)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.historical_direct_approved := false;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('task_historical_direct_approval_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
      jsonb_build_object('historical_direct_approved', true, 'state', OLD.state::text, 'batch_id', OLD.historical_direct_batch_id),
      jsonb_build_object('historical_direct_approved', false, 'state', NEW.state::text, 'batch_id', OLD.historical_direct_batch_id),
      'The task left the approved state (' || NEW.state::text || '): its next approval follows the two levels.', public.app_actor());
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;   -- the migration role (after the clearing above, which applies to every writer)
  IF (NEW.historical_direct_approved, NEW.historical_direct_batch_id, NEW.historical_direct_approved_at)
     IS NOT DISTINCT FROM (OLD.historical_direct_approved, OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
    RETURN NEW;
  END IF;
  IF current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hda_task', true), '') = NEW.id::text
     AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('in_review', 'in_approval')
     AND EXISTS (SELECT 1 FROM public.import_batches b JOIN public.import_batch_rows r ON r.batch_id = b.id AND r.task_instance_id = NEW.id
                 WHERE b.id = NEW.historical_direct_batch_id AND b.historical_direct_approve AND public.hda_batch_ok(b)) THEN
    RETURN NEW;   -- 0092: a task row of a stream batch approved directly (hda_approve_task)
  END IF;
  -- 0123: a task fed by a register record approved directly by a register sheet of the historical load (hrt_feed_task)
  IF current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hrt_task', true), '') = NEW.id::text
     AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('locked', 'open', 'entry')
     AND EXISTS (SELECT 1 FROM public.register_records rr JOIN public.import_batches b ON b.id = rr.historical_direct_batch_id
                 WHERE rr.id::text = coalesce(current_setting('pmis.hrt_record', true), '') AND rr.historical_direct_approved AND rr.state = 'approved'
                   AND rr.site_id = NEW.site_id AND b.id = NEW.historical_direct_batch_id AND b.historical_direct_approve AND b.historical_load
                   AND b.source = 'master_import' AND b.register_key = rr.register_key
                   AND (public.hda_batch_ok(b)
                        OR (coalesce(current_setting('pmis.hrt_catchup', true), '') = NEW.id::text AND public.app_ctx_legacy()))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical direct approval: the flag of a task is written only by GSDN Workspace (migration 0092)' USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The direct approval of one register record (hda_approve_record: latest 0093, changes marked 0123)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hda_approve_record(p_record uuid, p_batch uuid, p_row uuid, p_stepup boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.register_records%ROWTYPE; n int; lvl int; before jsonb; aname text;
  unlocked uuid[] := ARRAY[]::uuid[]; note text := 'historical load: approved directly (admin override)';
  fed jsonb; link uuid; it jsonb;   -- 0123
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND OR NOT b.historical_direct_approve OR b.register_key IS NULL OR NOT public.hda_batch_ok(b) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail',
      'This row cannot be approved directly: the historical-load waiver is closed, or the batch is not a register sheet of a historical Master import of yours marked for direct approval.'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.id = p_row AND x.batch_id = p_batch AND x.register_record_id = p_record) THEN
    RAISE EXCEPTION 'historical direct approval: the row is not a row of this record in this batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- a final approval (as reg_complete)
  r := public.reg_lock(p_record, NULL);
  IF r.register_key IS DISTINCT FROM b.register_key THEN
    RAISE EXCEPTION 'historical direct approval: the record is not of the register of this batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.state = 'approved' THEN RETURN unlocked; END IF;   -- the submit was already final (the sender holds L1 and L2, B5): a normal approval, no flag
  IF r.state NOT IN ('in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The record is ' || r.state || ': it cannot be approved directly.'));
  END IF;
  before := public.reg_snap(p_record);
  n := coalesce(r.levels_required, public.reg_levels(p_record));
  PERFORM set_config('app.batch_row', p_row::text, true);   -- the steps and audit rows name the import row
  FOR lvl IN r.current_level .. greatest(n, r.current_level) LOOP
    PERFORM public.reg_step(p_record, lvl, 'approve', actor, note, r.state, 'approved', true, false);
    INSERT INTO public.register_level_actors (record_id, level, user_id, how) VALUES (p_record, lvl, actor, 'acted')
      ON CONFLICT (record_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  END LOOP;
  IF r.register_key = 'permits_hse' AND lower(coalesce(r.data ->> 'status', '')) = 'n/a' THEN   -- Q45, as reg_complete
    SELECT u.display_name INTO aname FROM public.users u WHERE u.id = actor;
    UPDATE public.register_records SET data = data || jsonb_build_object('na_approved_by', aname) WHERE id = p_record;
  END IF;
  UPDATE public.register_records SET is_current = false WHERE entity_id = r.entity_id AND id <> p_record AND is_current;
  PERFORM set_config('pmis.hda_record', p_record::text, true);
  UPDATE public.register_records SET state = 'approved', current_level = greatest(n, r.current_level), approved_at = now(), approved_by = actor, is_current = true,
    ball_in_court_user_id = NULL, level_opened_at = NULL, self_approval = false,
    historical_direct_approved = true, historical_direct_batch_id = p_batch, historical_direct_approved_at = now()
  WHERE id = p_record;
  PERFORM set_config('pmis.hda_record', '', true);
  PERFORM public.reg_apply(p_record);                                         -- the typed table first: the task's calculations read it
  -- 0123: the feed of the final approval: the tasks this record is the source of are approved directly with the record's date (before reg_complete_task, so
  -- C3 takes the flag too; the record is not linked yet, so reg_complete_task changes no task the feed closed)
  fed := public.hrt_feed_record(p_record, p_batch, false, b.historical_reason);
  FOR it IN SELECT x FROM jsonb_array_elements(coalesce(fed -> 'items', '[]'::jsonb)) x WHERE x ->> 'outcome' = 'approved' LOOP
    unlocked := unlocked || ARRAY(SELECT jsonb_array_elements_text(coalesce(it -> 'unlocked_task_ids', '[]'::jsonb))::uuid);
  END LOOP;
  unlocked := unlocked || public.reg_complete_task(p_record, actor, true, false);
  link := (fed ->> 'link_task_id')::uuid;   -- 0123: linked to the first task it closed, as a normal submission links it
  IF link IS NOT NULL THEN UPDATE public.register_records SET task_id = link WHERE id = p_record AND task_id IS NULL; END IF;
  UPDATE public.register_records SET version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.log_audit_write('register_record_historical_direct_approval', 'register_record', p_record::text,
    before || jsonb_build_object('historical_direct_approved', false),
    public.reg_snap(p_record) || jsonb_build_object('historical_direct_approved', true, 'register_key', r.register_key, 'batch_id', p_batch, 'batch_row_id', p_row,
      'levels_approved', greatest(n, r.current_level) - r.current_level + 1, 'unlocked_task_ids', to_jsonb(unlocked),
      'tasks_fed', coalesce(fed -> 'items', '[]'::jsonb),   -- 0123
      'rule', 'approved at once as an admin override of the historical load (no L2)'),
    b.historical_reason, r.site_id, r.region_id, NULL, true);
  PERFORM set_config('app.batch_row', '', true);
  RETURN unlocked;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The one-time catch-up of the data already loaded (internal; only in a migration session)
-- ---------------------------------------------------------------------------------------------------------------------
-- Every register record still approved directly by a historical load (the version in force, of a site) goes through the feed, as the System Admin who loaded
-- it (app.user_id of the migration session's legacy context, every region). A record whose loader is no longer an active System Admin is counted and left.
-- One summary audit row with the counts. Running it again changes nothing.
CREATE OR REPLACE FUNCTION hrt_catch_up() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  rec record; fed jsonb; it jsonb; link uuid; n_rec int := 0; n_left int := 0; outcomes jsonb := '{}'::jsonb; codes jsonb := '{}'::jsonb; sites uuid[] := ARRAY[]::uuid[];
  ms_before jsonb; ms_after jsonb; uid text := current_setting('app.user_id', true); rg text := current_setting('app.region_ids', true); res jsonb;
BEGIN
  IF NOT public.app_ctx_legacy() THEN
    RAISE EXCEPTION 'historical register tasks: the catch-up runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(jsonb_object_agg(code, n), '{}'::jsonb) INTO ms_before FROM (
    SELECT td.code, count(*) AS n FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.state = 'approved' GROUP BY td.code) x;
  PERFORM set_config('app.region_ids', '*', true);
  FOR rec IN
    SELECT rr.id, rr.historical_direct_batch_id AS batch_id, rr.site_id, rr.approved_by, b.historical_marked_by, b.historical_reason
    FROM public.register_records rr JOIN public.import_batches b ON b.id = rr.historical_direct_batch_id
    WHERE rr.historical_direct_approved AND rr.state = 'approved' AND rr.is_current AND rr.site_id IS NOT NULL
      AND b.historical_direct_approve AND b.historical_load AND b.source = 'master_import' AND b.register_key = rr.register_key
      AND EXISTS (SELECT 1 FROM public.register_task_sources x WHERE x.register_key = rr.register_key AND x.is_active AND x.task_code NOT LIKE 'MOB-%')
    ORDER BY rr.historical_direct_approved_at, rr.id
  LOOP
    n_rec := n_rec + 1;
    IF NOT public.app_user_is_system_admin(coalesce(rec.approved_by, rec.historical_marked_by)) THEN
      n_left := n_left + 1;
      CONTINUE;
    END IF;
    PERFORM set_config('app.user_id', coalesce(rec.approved_by, rec.historical_marked_by)::text, true);
    BEGIN
      fed := public.hrt_feed_record(rec.id, rec.batch_id, true, rec.historical_reason);
    EXCEPTION WHEN others THEN   -- one record never stops the update of the server: reported in the System Log and counted
      PERFORM public.log_system_write('warn', 'master-import', 'migration 0123: a register record of the historical load could not feed its tasks',
        jsonb_build_object('register_record_id', rec.id, 'batch_id', rec.batch_id, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), NULL, NULL);
      fed := jsonb_build_object('items', jsonb_build_array(jsonb_build_object('outcome', 'record_failed')));
    END;
    FOR it IN SELECT x FROM jsonb_array_elements(coalesce(fed -> 'items', '[]'::jsonb)) x LOOP
      outcomes := jsonb_set(outcomes, ARRAY[it ->> 'outcome'], to_jsonb(coalesce((outcomes ->> (it ->> 'outcome'))::int, 0) + 1));
      IF it ->> 'outcome' = 'approved' THEN
        codes := jsonb_set(codes, ARRAY[it ->> 'task_code'], to_jsonb(coalesce((codes ->> (it ->> 'task_code'))::int, 0) + 1));
        IF NOT rec.site_id = ANY (sites) THEN sites := sites || rec.site_id; END IF;
      END IF;
    END LOOP;
    link := (fed ->> 'link_task_id')::uuid;
    IF link IS NOT NULL THEN UPDATE public.register_records SET task_id = link WHERE id = rec.id AND task_id IS NULL; END IF;
  END LOOP;
  PERFORM set_config('app.user_id', coalesce(uid, ''), true);
  PERFORM set_config('app.region_ids', coalesce(rg, ''), true);
  SELECT coalesce(jsonb_object_agg(code, n), '{}'::jsonb) INTO ms_after FROM (
    SELECT td.code, count(*) AS n FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id AND td.is_milestone_task
    WHERE t.state = 'approved' GROUP BY td.code) x;
  res := jsonb_build_object('records', n_rec, 'records_loader_not_admin', n_left, 'tasks', outcomes, 'approved_by_task', codes, 'sites', cardinality(sites),
    'milestones_approved_before', ms_before, 'milestones_approved_after', ms_after);
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, is_admin_override)
  VALUES ('historical_register_tasks_catch_up', 'site', 'all', jsonb_build_object('milestones_approved', ms_before),
          res || jsonb_build_object('rule', 'the tasks fed by the register records of the historical load approved directly are approved at once with the record''s date'),
          'migration 0123: the register records of the historical Master load close their tasks (owner report 2026-11-18)', true);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app. The redefined functions
--    keep their owner and grants (CREATE OR REPLACE).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hrt_feed_task(uuid,uuid,uuid,date,text,text,boolean,text)', 'hrt_feed_record(uuid,uuid,boolean,text)', 'hrt_catch_up()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The one-time catch-up (the migration session: its legacy context names the loader of each record)
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hrt_catch_up();
