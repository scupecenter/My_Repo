-- 0087: the historical load of the Master, approved directly (owner decision 2026-11-12, "Direct approval"; CHANGELOG 129).
--
-- WHY. The owner loads the history of the real Site Master through "Master import and comparison" (mi_apply_run) and wants to see it in the system without any
-- approval or gate holding it. The gates and locks are already open for a historical load (0085 / 0086: the sites of the file are opened), and the documents
-- are waived (0073), but every task row with an actual date is still *submitted* and waits for an L2 decision. The owner chose "Direct approval": a new option
-- of the historical load approves each submitted task at once, as an admin override, with no L2 step. It applies ONLY to that load (a System Admin, a step-up,
-- the historical-load waiver open, a reason: the checks of hw_mark_authorize, 0073). All normal work keeps L1 then L2.
--
-- WHAT THIS ADDS.
--   1. `historical_load.approve_directly` of POST /master-import/runs/{run_id}/apply (mi_apply_run, p_historical ->> 'approve_directly'; submit mode and the
--      historical option are required). mi_apply_run marks the batches it has just staged `import_batches.historical_direct_approve` (hda_mark_batches), before
--      it sends them. The background apply (0086) stores the choice on `mi_apply_jobs.approve_directly` and mi_apply_step passes it on from that row; the
--      chunked send of a big batch (0075, imp_async_step) reads it from the batch row. A caller never passes it at chunk time.
--   2. imp_submit_stream_rows (the one sender of the synchronous and the chunked send) approves a submitted row of a marked batch at once (hda_approve_task):
--      the same data effects as a final L2 approval in wf_complete_hw (state approved, approved_date, the level actors, a workflow_steps row "approve" with the
--      note "historical load: approved directly (admin override)", the uploaded slots approved, the successors unlocked; the SLA, the milestones and the gates
--      follow through the existing triggers, calc_refresh_site). The rows without an actual date stay saved, as before; a refusal stays the error of its row.
--   3. The flag `task_instances.historical_direct_approved` (+ batch, time) and one audit row per task `task_historical_direct_approval` (is_admin_override, the
--      reason of the load). Shown as the "Admin override" badge; counted in the dashboard `override_flagged_count` and treated like the other overrides
--      (historical_no_documents, lock_bypassed) in the SLA / on-time figures. It is NOT `admin_override`: that column hides a task from Project Status
--      (dash_build_items, `NOT (p_excl AND t.admin_override)`) and freezes a calculated milestone (calc_refresh_site), and the owner wants the data shown.
--      A task that leaves the approved state (a reopening) loses the flag (audited), so its next approval is a normal one.
--   4. Guards. The batch mark and the task flag are written only inside these definer functions (current_user pmis_definer and a transaction marker set by
--      them, the pattern of swl_sites_guard / swl_task_trg, 0085), and every write checks again, from stored rows only, that the batch came from the Master
--      import, is marked historical by the signed-in System Admin under the open waiver. No security function is weakened: wf_require_actor, the grants and
--      the eligibility of wf_complete are untouched; the direct approval is its own function, internal (no grant), reached only from imp_submit_stream_rows
--      for a batch with the mark, which only mi_apply_run sets. pmis_app gets no new table right.
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0087"): mi_apply_run (0086), mi_apply_step (0086), imp_submit_stream_rows
-- (0085), imp_submit_stream_finish (0075), dash_build_tasks (0085), dash_core (0085). CREATE OR REPLACE keeps their owner (pmis_definer), search_path and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to
-- pmis_app: the API door stays mi_apply_run / mi_apply_step.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches
  ADD COLUMN historical_direct_approve boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT import_batches_hda_check CHECK (NOT historical_direct_approve OR (historical_load AND source = 'master_import' AND stream_code IS NOT NULL));
COMMENT ON COLUMN import_batches.historical_direct_approve IS '0087: a historical Master import batch whose submitted rows are approved at once (admin override, no L2). Written only by hda_mark_batches (mi_apply_run).';

ALTER TABLE task_instances
  ADD COLUMN historical_direct_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_direct_batch_id uuid REFERENCES import_batches (id),
  ADD COLUMN historical_direct_approved_at timestamptz,
  ADD CONSTRAINT task_instances_hda_check CHECK (NOT historical_direct_approved OR (historical_direct_batch_id IS NOT NULL AND historical_direct_approved_at IS NOT NULL AND state = 'approved'));
CREATE INDEX task_instances_hda_idx ON task_instances (site_id) WHERE historical_direct_approved;
COMMENT ON COLUMN task_instances.historical_direct_approved IS '0087: approved directly by the historical Master import (admin override, no L2): the "Admin override" badge, an override in the SLA KPIs, counted in progress';

ALTER TABLE mi_apply_jobs
  ADD COLUMN approve_directly boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT mi_apply_jobs_hda_check CHECK (NOT approve_directly OR (hw_reason IS NOT NULL AND mode = 'submit'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (historical_direct_approve), UPDATE (historical_direct_approve) ON import_batches FROM pmis_app;
    REVOKE INSERT (historical_direct_approved, historical_direct_batch_id, historical_direct_approved_at),
           UPDATE (historical_direct_approved, historical_direct_batch_id, historical_direct_approved_at) ON task_instances FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The batch: may it be approved directly now (read from the stored rows), and the mark
-- ---------------------------------------------------------------------------------------------------------------------
-- True when the batch may be approved directly by the signed-in person now: marked historical by this System Admin under the waiver that is open now, from the
-- Master import (internal). Both the mark and every direct approval read it.
CREATE OR REPLACE FUNCTION hda_batch_ok(p_batch public.import_batches) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_batch.historical_load AND p_batch.source = 'master_import' AND p_batch.stream_code IS NOT NULL AND p_batch.mode = 'submit'
    AND public.app_actor() IS NOT NULL AND p_batch.historical_marked_by = public.app_actor() AND p_batch.uploaded_by = public.app_actor()
    AND public.app_user_is_system_admin(p_batch.historical_marked_by)
    AND public.hw_waiver_open_now() AND p_batch.historical_cutoff = public.hw_waiver_cutoff()
    AND p_batch.historical_marked_at >= nullif((public.hw_waiver_cfg() ->> 'opened_at'), '')::timestamptz, false)
$$;

-- Marks the batches mi_apply_run has just staged (internal; called only by mi_apply_run, after hw_mark_authorize). Audited per batch with the admin-override flag.
CREATE OR REPLACE FUNCTION hda_mark_batches(p_batches uuid[], p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; n int := 0;
BEGIN
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  FOR b IN SELECT * FROM public.import_batches x WHERE x.id = ANY (coalesce(p_batches, ARRAY[]::uuid[])) ORDER BY x.created_at, x.id FOR UPDATE LOOP
    IF b.status <> 'validated' OR NOT public.hda_batch_ok(b) THEN
      RAISE EXCEPTION 'historical direct approval: only a validated historical Master import batch of the signed-in System Admin is marked' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM set_config('pmis.hda_mark', b.id::text, true);
    UPDATE public.import_batches SET historical_direct_approve = true WHERE id = b.id;
    PERFORM set_config('pmis.hda_mark', '', true);
    PERFORM public.log_audit_write('import_batch.historical_direct_approval', 'import_batch', b.id::text, jsonb_build_object('historical_direct_approve', false),
      jsonb_build_object('historical_direct_approve', true, 'batch_id', b.id, 'cutoff_date', b.historical_cutoff,
        'rule', 'every submitted row of this batch is approved at once as an admin override (no L2)'), btrim(p_reason), NULL, NULL, NULL, true);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- BEFORE INSERT OR UPDATE on import_batches: the mark is set only by hda_mark_batches (the definer role and its transaction marker for this batch) and never changes.
CREATE OR REPLACE FUNCTION hda_guard_batch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.historical_direct_approve THEN
      RAISE EXCEPTION 'historical direct approval: a batch is never created marked (migration 0087)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.historical_direct_approve THEN
    IF NOT NEW.historical_direct_approve THEN
      RAISE EXCEPTION 'historical direct approval: the mark of a batch never changes (migration 0087)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.historical_direct_approve AND NOT (current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hda_mark', true), '') = NEW.id::text
                                            AND OLD.status = 'validated' AND public.hda_batch_ok(NEW)) THEN
    RAISE EXCEPTION 'historical direct approval: a batch is marked only by the historical Master import of a System Admin (migration 0087)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hda_guard_batch_ins BEFORE INSERT ON import_batches FOR EACH ROW WHEN (NEW.historical_direct_approve) EXECUTE FUNCTION hda_guard_batch();
CREATE TRIGGER hda_guard_batch_upd BEFORE UPDATE ON import_batches FOR EACH ROW
  WHEN (NEW.historical_direct_approve IS DISTINCT FROM OLD.historical_direct_approve) EXECUTE FUNCTION hda_guard_batch();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The direct approval of one task, and the guard of its flag
-- ---------------------------------------------------------------------------------------------------------------------
-- Approves a task that the row p_row of the marked batch p_batch has just submitted (internal; called only by imp_submit_stream_rows, inside the row's own
-- block, so a refusal is the error of that row). The data effects are those of the final approval in wf_complete_hw (0073): the level actors, a workflow step,
-- the state, the dates, the slots and files, the successors. Who may act is decided by the mark (hda_batch_ok), not by the Responsibility Matrix: this is
-- the admin override the owner chose for the historical load, so wf_require_actor is not called and is not changed. Returns the unlocked successors.
CREATE OR REPLACE FUNCTION hda_approve_task(p_task uuid, p_batch uuid, p_row uuid, p_stepup boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; t public.task_instances%ROWTYPE; n int; lvl int; before jsonb; unlocked uuid[] := ARRAY[]::uuid[];
  note text := 'historical load: approved directly (admin override)';
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND OR NOT b.historical_direct_approve OR NOT public.hda_batch_ok(b) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail',
      'This row cannot be approved directly: the historical-load waiver is closed, or the batch is not a historical Master import of yours marked for direct approval.'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.import_batch_rows r WHERE r.id = p_row AND r.batch_id = p_batch AND r.task_instance_id = p_task) THEN
    RAISE EXCEPTION 'historical direct approval: the row is not a row of this task in this batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- a final approval (as wf_complete_hw)
  t := public.wf_lock_task(p_task, NULL);
  IF t.state = 'approved' THEN RETURN unlocked; END IF;   -- the submit was already final (the sender holds L1 and L2, B5): a normal approval, no flag
  IF t.state NOT IN ('in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is ' || t.state::text || ': it cannot be approved directly.'));
  END IF;
  before := public.wf_snap(p_task);
  n := coalesce(t.levels_required, public.wf_task_levels(p_task));
  FOR lvl IN t.current_level .. greatest(n, t.current_level) LOOP
    PERFORM public.wf_step(p_task, lvl, 'approve', actor, note, t.state, 'approved', true, false);
    INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, lvl, actor, 'acted')
      ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  END LOOP;
  PERFORM set_config('pmis.hda_task', p_task::text, true);
  UPDATE public.task_instances SET state = 'approved', current_level = greatest(n, t.current_level), approved_date = current_date, ball_in_court_user_id = NULL,
    level_opened_at = NULL, self_approval = false, historical_direct_approved = true, historical_direct_batch_id = p_batch, historical_direct_approved_at = now(),
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM set_config('pmis.hda_task', '', true);
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
    WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
  unlocked := public.wf_unlock_successors(p_task);
  PERFORM public.log_audit_write('task_historical_direct_approval', 'task', p_task::text,
    before || jsonb_build_object('historical_direct_approved', false),
    public.wf_snap(p_task) || jsonb_build_object('historical_direct_approved', true, 'batch_id', p_batch, 'batch_row_id', p_row, 'levels_approved', n - t.current_level + 1,
      'unlocked_task_ids', to_jsonb(unlocked), 'rule', 'approved at once as an admin override of the historical load (no L2)'),
    b.historical_reason, t.site_id, t.region_id, NULL, true);
  RETURN unlocked;
END $$;

-- BEFORE INSERT OR UPDATE on task_instances. Not a definer: current_user is the writer. The flag is set only inside hda_approve_task (the definer role and its
-- marker for this task), on an approved task with a row in a marked batch; it clears (audited) when the task leaves the approved state.
CREATE OR REPLACE FUNCTION hda_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical direct approval: the flag of a task is written only by GSDN Workspace (migration 0087)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_direct_approved AND NEW.state IS DISTINCT FROM 'approved' THEN
    -- a reopening: the flag goes, the batch reference stays for the history; the next approval is a normal one
    IF (NEW.historical_direct_batch_id, NEW.historical_direct_approved_at) IS DISTINCT FROM (OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
      RAISE EXCEPTION 'historical direct approval: the batch of a flagged task never changes (migration 0087)' USING ERRCODE = 'insufficient_privilege';
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
  IF NOT (current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hda_task', true), '') = NEW.id::text
          AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('in_review', 'in_approval')
          AND EXISTS (SELECT 1 FROM public.import_batches b JOIN public.import_batch_rows r ON r.batch_id = b.id AND r.task_instance_id = NEW.id
                      WHERE b.id = NEW.historical_direct_batch_id AND b.historical_direct_approve AND public.hda_batch_ok(b))) THEN
    RAISE EXCEPTION 'historical direct approval: the flag of a task is written only by GSDN Workspace (migration 0087)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hda_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.historical_direct_approved OR NEW.historical_direct_batch_id IS NOT NULL OR NEW.historical_direct_approved_at IS NOT NULL) EXECUTE FUNCTION hda_guard_task();
CREATE TRIGGER hda_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.historical_direct_approved IS DISTINCT FROM OLD.historical_direct_approved OR NEW.historical_direct_batch_id IS DISTINCT FROM OLD.historical_direct_batch_id
        OR NEW.historical_direct_approved_at IS DISTINCT FROM OLD.historical_direct_approved_at OR (OLD.historical_direct_approved AND NEW.state IS DISTINCT FROM OLD.state))
  EXECUTE FUNCTION hda_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The redefined functions: the apply (request and background), the sender, the end of a send, the KPIs
-- ---------------------------------------------------------------------------------------------------------------------
-- mi_apply_run (latest definition 0086, changes marked 0087: the option approve_directly, the mark of the staged batches, the approved rows of a batch)
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb)
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
  hda boolean := false;   -- 0087: the historical load is approved directly (admin override, no L2)
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
    hda := coalesce(p_historical -> 'approve_directly' = 'true'::jsonb, false);   -- 0087
  END IF;
  IF public.app_ctx_stepup() AND bg IS NULL THEN   -- 0075 (0086: in the background, the expiry recorded at the request)
    SELECT us.stepup_at + make_interval(secs => coalesce((SELECT CASE WHEN jsonb_typeof(st.value) = 'number' THEN (st.value #>> '{}')::int END
                                                          FROM public.settings st WHERE st.key = 'stepup_max_age_seconds'), 300))
      INTO su_until FROM public.user_sessions us WHERE us.id = public.log_ctx_uuid('session_id') AND us.user_id = actor AND us.revoked_at IS NULL AND us.stepup_at IS NOT NULL;
  ELSIF bg IS NOT NULL THEN
    SELECT j.stepup_until INTO su_until FROM public.mi_apply_jobs j WHERE j.id = bg;
  END IF;
  SELECT x.id INTO prev FROM public.master_reconciliation_runs x WHERE x.file_sha256 = r.file_sha256 AND x.status = 'applied' AND x.id <> r.id LIMIT 1;
  IF prev IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.'));
  END IF;
  -- 0086: a file with more sites than imports.async_rows is applied in the background, every check above passed: the request records the run and answers 202
  -- (status applying); mi_apply_step does the very same apply in a transaction of its own under the same person's signed context (no 30 s request limit)
  IF bg IS NULL THEN
    BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;
    SELECT count(DISTINCT upper(x.site_code)) INTO nsites FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL;
    IF nsites > lim THEN
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total,
                                        approve_directly)   -- 0087
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites,
              hda)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
          'approve_directly', hda), btrim(p_reason));   -- 0087
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'batches', '[]'::jsonb, 'queued', 0, 'approve_directly', hda);
    END IF;
  END IF;
  IF hw IS NOT NULL THEN
    -- 0085: the historical load accepts the data as it is: every site of the file loses its workflow locks first (audited per site, the reason of the load)
    PERFORM public.swl_open_for_load((SELECT array_agg(DISTINCT x.site_id) FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', 'historical_master_import');
  END IF;

  SELECT v.* INTO tv FROM public.template_versions v JOIN public.template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current;
  SELECT x INTO mpart FROM jsonb_array_elements(tv.columns) x WHERE x ->> 'kind' = 'master' LIMIT 1;
  mcols := mpart -> 'columns';
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
    CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row_no', row_.row_no, 'site_code', row_.site_code, 'cells', cells, 'pre_errors', pres));
  END LOOP;
  IF jsonb_array_length(v_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
    jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  IF hda THEN
    -- 0087: the batches just staged are marked for direct approval (a System Admin, the step-up, the open waiver, checked again on each batch); every
    -- submitted row of them is then approved at once by the sender, here or in the chunked background send (the mark is read from the batch row there)
    PERFORM public.hda_mark_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');
  END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
      'approved', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'update' AND x.decision = 'approved')));   -- 0087
  END LOOP;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued, 'approve_directly', hda);   -- 0087
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
      'approve_directly', hda), btrim(p_reason));   -- 0087
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- mi_apply_step (latest definition 0086, changes marked 0087: the direct-approval choice stored on the run)
-- The background apply (granted): the same mi_apply_run, under the signed context of the person who asked for it. busy = another process holds it.
CREATE OR REPLACE FUNCTION mi_apply_step(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); j public.mi_apply_jobs%ROWTYPE; res jsonb; e jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO j FROM public.mi_apply_jobs WHERE id = p_job FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.mi_apply_jobs WHERE id = p_job) THEN RETURN jsonb_build_object('job_id', p_job, 'state', 'busy'); END IF;
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The apply run does not exist.'));
  END IF;
  IF j.actor_id <> actor THEN RAISE EXCEPTION 'only the person who applied the file continues its run' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF j.state <> 'running' THEN RETURN jsonb_build_object('job_id', j.id, 'state', j.state); END IF;
  UPDATE public.mi_apply_jobs SET tries = tries + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  PERFORM set_config('pmis.mi_apply_job', p_job::text, true);
  BEGIN
    res := public.mi_apply_run(j.run_id, NULL, j.mode, j.reason, j.stepup_verified,
      CASE WHEN j.hw_reason IS NOT NULL THEN jsonb_build_object('reason', j.hw_reason, 'approve_directly', j.approve_directly) END);   -- 0087: the choice stored at the request
  EXCEPTION WHEN others THEN
    PERFORM set_config('pmis.mi_apply_job', '', true);
    e := public.imp_wf_json(SQLERRM);
    IF e IS NULL THEN RAISE; END IF;   -- not a refusal of the apply: the API tries again, then stops the run (mi_apply_abandon)
    PERFORM public.mi_apply_fail(p_job, e ->> 'code', coalesce(e -> 'extra' ->> 'detail',
      CASE WHEN e ->> 'code' = 'step_up_required' THEN 'The confirmation of your password expired before the background run started. Apply the file again.' END, e ->> 'code'));
    RETURN jsonb_build_object('job_id', j.id, 'state', 'failed', 'code', e ->> 'code');
  END;
  PERFORM set_config('pmis.mi_apply_job', '', true);
  UPDATE public.mi_apply_jobs SET state = 'done', outcome = res, finished_at = clock_timestamp(), heartbeat_at = clock_timestamp() WHERE id = p_job;
  RETURN jsonb_build_object('job_id', j.id, 'state', 'done', 'outcome', res);
END $$;

-- imp_submit_stream_rows (latest definition 0085, changes marked 0087: a submitted row of a marked batch is approved directly)
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
      -- 0087: the submit of a row approved directly right after sends no notice (no "task assigned" to L2, no "no holder" to the System Admins): see wf_notify
      IF b.historical_direct_approve THEN PERFORM set_config('pmis.hda_quiet', t.id::text, true); END IF;
      IF b.historical_load THEN   -- 0073 (Q462): the mandatory-document check can be waived for this row (see hw_row_waiver)
        PERFORM public.wf_complete_hw(t.id, NULL, 'submit', NULL, p_stepup, r.id);
      ELSE
        PERFORM public.wf_submit(t.id, NULL, NULL, p_stepup);
      END IF;
      IF b.historical_direct_approve THEN   -- 0087: a historical Master import batch marked for direct approval (read from the stored batch, never from the caller)
        PERFORM public.hda_approve_task(t.id, b.id, r.id, p_stepup);
        PERFORM set_config('pmis.hda_quiet', '', true);
      END IF;
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      UPDATE public.import_batch_rows SET hold_reason = NULL, task_submitted_at = now(),
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      PERFORM set_config('pmis.hda_quiet', '', true);   -- 0087
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

-- imp_submit_stream_finish (latest definition 0075, changes marked 0087: a batch approved directly is closed, the audit row counts the direct approvals)
CREATE OR REPLACE FUNCTION imp_submit_stream_finish(p_batch uuid, p_prev_status text, p_submitted integer, p_saved integer, p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := public.imp_stream_status_after_send(p_batch, p_prev_status, p_submitted);
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    closed_at = CASE WHEN new_st = 'applied' OR (new_st = 'approved' AND b.historical_direct_approve) THEN now() ELSE closed_at END,   -- 0087
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_submit', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('mode', b.mode, 'submitted', p_submitted, 'saved', p_saved, 'held', p_held, 'failed', p_failed, 'status', new_st)
      || CASE WHEN b.historical_direct_approve THEN jsonb_build_object('approved_directly',   -- 0087
           (SELECT count(*) FROM public.task_instances t JOIN public.import_batch_rows x ON x.task_instance_id = t.id AND x.batch_id = p_batch
             WHERE t.historical_direct_batch_id = p_batch AND t.historical_direct_approved)) ELSE '{}'::jsonb END, NULL);
  RETURN new_st;
END $$;


-- dash_build_tasks (latest definition 0085, changes marked 0087: a direct approval of the historical load is an override for the SLA / on-time figures)
CREATE OR REPLACE FUNCTION public.dash_build_tasks(p_ref date, p_stream text, p_excl boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE eff date;
BEGIN
  SELECT max(d) INTO eff FROM _dcal WHERE d <= p_ref AND is_wd;
  DROP TABLE IF EXISTS _dtask;
  CREATE TEMP TABLE _dtask ON COMMIT DROP AS
    WITH base AS (
      SELECT t.id, t.site_id, s.region_id, td.code AS task_code, sd.code AS stage_code, sd.stream_code,
             t.state::text AS state, (t.admin_override OR t.historical_no_documents OR t.lock_bypassed OR t.historical_direct_approved) AS admin_override, t.sla_target_date, t.due_date, t.sla_elapsed_wd, t.sla_end_date,
             r.max_working_days AS sla_max, t.return_count, coalesce(t.actual_date, t.approved_date) AS done_date,
             t.external_party_id, td.default_external_party::text AS default_party,
             CASE WHEN t.sla_start_date IS NULL OR t.sla_start_date > p_ref OR t.state IN ('locked', 'na', 'skipped') OR t.is_na
                       OR (p_excl AND (t.admin_override OR t.historical_no_documents OR t.lock_bypassed OR t.historical_direct_approved)) THEN 'none'
                  WHEN t.state = 'approved' AND coalesce(t.sla_end_date, t.actual_date, t.approved_date, p_ref) <= p_ref THEN 'closed'
                  WHEN t.due_date IS NULL THEN 'none'
                  ELSE 'open' END AS phase
      FROM _dsite s
      JOIN public.task_instances t ON t.site_id = s.id
      JOIN public.task_definitions td ON td.id = t.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
      WHERE NOT s.cancelled AND t.state NOT IN ('locked', 'na', 'skipped') AND (p_stream IS NULL OR sd.stream_code = p_stream)
    )
    SELECT b.id, b.site_id, b.region_id, b.task_code, b.stage_code, b.stream_code, b.state, b.admin_override, b.due_date, b.return_count, b.done_date,
      b.external_party_id, b.default_party, b.phase,
      CASE WHEN b.phase = 'closed' THEN CASE WHEN b.sla_elapsed_wd IS NULL OR b.sla_max IS NULL THEN NULL WHEN b.sla_elapsed_wd <= b.sla_max THEN 'on_time' ELSE 'late' END
           WHEN b.phase = 'open' THEN CASE WHEN eff <= coalesce(b.sla_target_date, b.due_date) THEN 'on_time' WHEN eff <= b.due_date THEN 'at_risk' ELSE 'late' END END AS cls,
      CASE WHEN b.phase = 'closed' AND b.sla_elapsed_wd IS NOT NULL AND b.sla_max IS NOT NULL THEN greatest(0, b.sla_elapsed_wd - b.sla_max)
           WHEN b.phase = 'open' AND eff > b.due_date THEN greatest(0, (SELECT wd FROM _dcal WHERE d = p_ref) - cd.wd) ELSE 0 END AS days_over
    FROM base b LEFT JOIN _dcal cd ON cd.d = b.due_date;
  CREATE INDEX ON _dtask (phase, cls);
END $function$;

-- dash_core (latest definition 0085, changes marked 0087: counted in override_flagged_count and in its own historical_direct_flagged_count)
CREATE OR REPLACE FUNCTION public.dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid, p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean, p_view text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; hist int; wf_versions int[];
  rows_none jsonb; rows_region jsonb; ms jsonb; live boolean := (p_ref = public.cal_today()); blk_ok boolean; appr text[]; gt jsonb;
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  blk_ok := CASE WHEN p_snap IS NULL THEN live
                 ELSE EXISTS (SELECT 1 FROM public.site_snapshots ss WHERE ss.snapshot_date = p_snap AND public.dash_local_date(ss.created_at) = p_snap) END;
  IF p_snap IS NULL AND (p_stream IS NOT NULL OR p_sections && ARRAY['streams']) THEN PERFORM public.dash_build_streams(p_ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  IF p_view IS NOT NULL THEN
    PERFORM public.dash_build_view(p_view);
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM public.task_instances t JOIN _dview v ON v.id = t.task_def_id
                                           WHERE t.site_id = s.id AND t.state NOT IN ('na', 'skipped') AND NOT t.is_na);
  END IF;
  all_regions := p_scope IS NULL OR NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id <> ALL (p_scope));
  wide := all_regions AND p_region IS NULL AND p_cluster IS NULL AND p_scenario IS NULL AND p_stream IS NULL AND p_view IS NULL;
  need_tasks := p_sections && ARRAY['sla', 'delay', 'health', 'regions'];
  IF p_sections && ARRAY['headline', 'health', 'regions', 'ps'] THEN
    IF p_snap IS NOT NULL THEN
      SELECT weight_set_id INTO snap_ws FROM public.site_snapshots WHERE snapshot_date = p_snap AND weight_set_id IS NOT NULL LIMIT 1;
      ws := coalesce(p_ws, snap_ws, public.weight_set_in_force('project_status', p_ref));
      IF p_ws IS NULL AND snap_ws IS NOT NULL THEN PERFORM public.dash_build_items_snap(p_snap, ws); ELSE PERFORM public.dash_build_items(p_ref, ws, p_excl); END IF;
    ELSE
      ws := coalesce(p_ws, public.weight_set_in_force('project_status', p_ref));
      PERFORM public.dash_build_items(p_ref, ws, p_excl);
    END IF;
    rows_none := public.dash_ps_rows('none', wide);
    rows_region := public.dash_ps_rows('region', wide);
    ps_card := public.dash_ps_card(wide, rows_none);
  END IF;
  IF need_tasks THEN
    PERFORM public.dash_build_tasks(p_ref, p_stream, p_excl);
    IF p_view IS NOT NULL THEN
      DELETE FROM _dtask x WHERE NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN _dview v ON v.id = ti.task_def_id WHERE ti.id = x.id);
    END IF;
  END IF;

  SELECT array_agg(DISTINCT wd.version ORDER BY wd.version) INTO wf_versions FROM _dsite s JOIN public.workflow_definitions wd ON wd.id = s.wf;
  SELECT count(*) INTO flagged FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.admin_override OR t.historical_no_documents OR t.lock_bypassed OR t.historical_direct_approved;   -- 0085: a lock bypass too; 0087: a direct approval too
  SELECT count(*) INTO hist FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.historical_no_documents;   -- 0073 (Q462)
  out_ := jsonb_build_object('meta', jsonb_build_object('project_wide', wide, 'workflow_versions', coalesce(to_jsonb(wf_versions), '[]'::jsonb), 'override_flagged_count', flagged, 'historical_flagged_count', hist,
    'lock_bypass_flagged_count', (SELECT count(*) FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.lock_bypassed),
    'historical_direct_flagged_count', (SELECT count(*) FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.historical_direct_approved),   -- 0087
    'overrides_excluded', p_excl, 'weight_set_id', ws, 'blocked_gates_available', blk_ok));

  IF p_sections && ARRAY['headline'] THEN
    out_ := out_ || jsonb_build_object('headline', public.dash_sec_status(p_ref) || jsonb_build_object('final_closure', public.dash_sec_closure(p_ref), 'project_status', ps_card));
  END IF;
  IF p_sections && ARRAY['pipeline', 'headline'] THEN
    ms := public.dash_sec_milestones(p_ref, CASE WHEN p_stream IN (SELECT DISTINCT stream_code FROM _dms WHERE stream_code IS NOT NULL) THEN p_stream END);
    IF p_view IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(x.e ORDER BY x.n), '[]'::jsonb) INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n) WHERE x.e ->> 'code' IN (SELECT code FROM _dviewms);
    END IF;
    -- Q186: a blocked count that cannot be known for the date is null ("historically unavailable"), not 0
    SELECT coalesce(jsonb_agg(CASE WHEN blk_ok THEN x.e || jsonb_build_object('blocked_available', true)
                                   ELSE x.e || jsonb_build_object('blocked', NULL, 'blocked_available', false) END ORDER BY x.n), '[]'::jsonb)
    INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n);
    out_ := out_ || jsonb_build_object('milestones', ms);
  END IF;
  IF p_sections && ARRAY['streams'] THEN out_ := out_ || jsonb_build_object('streams', public.dash_sec_streams()); END IF;
  IF p_sections && ARRAY['sla'] THEN out_ := out_ || jsonb_build_object('sla', public.dash_sec_sla(p_ref)); END IF;
  IF p_sections && ARRAY['gates'] THEN
    IF live THEN gt := public.dash_sec_gates(p_ref) || jsonb_build_object('status', 'live');
    ELSIF blk_ok THEN
      gt := jsonb_build_object('available', false, 'status', 'snapshot', 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb,
        'blocked_total', (SELECT count(*) FROM _dms m JOIN _dsite s ON s.id = m.site_id AND NOT s.cancelled WHERE m.blocked));
    ELSE
      gt := jsonb_build_object('available', false, 'status', 'historically_unavailable', 'blocked_total', NULL, 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb);
    END IF;
    out_ := out_ || jsonb_build_object('gates', gt);
  END IF;
  IF p_sections && ARRAY['issues'] THEN
    out_ := out_ || jsonb_build_object('issues', CASE WHEN p_issues THEN public.dash_sec_issues(p_ref, p_issue_scope) ELSE NULL END);
  END IF;
  IF p_sections && ARRAY['health', 'regions'] THEN
    hl := public.dash_sec_health(p_ref, wide, p_issue_scope, p_issues, rows_none, rows_region);
    -- D16: the draft label sits on each factor the owner has not approved; the index itself carries none (Q121)
    SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO appr FROM jsonb_array_elements_text(public.calc_setting('dashboard.health_approved_factors', '["D", "I"]'::jsonb)) x;
    hl := hl || jsonb_build_object('draft', false,
      'components', coalesce((SELECT jsonb_agg(c.e || jsonb_build_object('draft', NOT ((c.e ->> 'code') = ANY (appr))) ORDER BY c.n)
                              FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)), '[]'::jsonb),
      'draft_factors', coalesce((SELECT jsonb_agg(c.e ->> 'code' ORDER BY c.n) FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)
                                 WHERE NOT ((c.e ->> 'code') = ANY (appr))), '[]'::jsonb),
      'approved_factors', to_jsonb(appr));
  END IF;
  IF p_sections && ARRAY['health'] THEN out_ := out_ || jsonb_build_object('health', hl); END IF;
  IF p_sections && ARRAY['delay'] THEN out_ := out_ || jsonb_build_object('delay', public.dash_sec_delay(p_ref)); END IF;
  IF p_sections && ARRAY['regions'] THEN out_ := out_ || jsonb_build_object('regions', public.dash_sec_regions(hl, true, rows_region)); END IF;
  IF p_sections && ARRAY['ps'] THEN
    out_ := out_ || jsonb_build_object('ps', jsonb_build_object('card', ps_card, 'rows', CASE WHEN p_group = 'region' THEN rows_region WHEN p_group = 'site' THEN public.dash_ps_rows('site', wide) ELSE '[]'::jsonb END,
      'sites_in_scope', (SELECT count(*) FROM _dsite WHERE NOT cancelled)));
  END IF;
  RETURN out_;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- wf_notify (0015, changes marked 0087): no in-app notice for the task whose submit is followed at once by its direct approval
-- ---------------------------------------------------------------------------------------------------------------------
-- WHY. A historical load of 469 sites submits thousands of tasks that are approved in the same transaction; each submit sent "task assigned" to the L2 holders, or
-- "no holder" to every System Admin, about tasks that are already approved. The notice is skipped only for the task named by the sender's marker
-- (imp_submit_stream_rows) AND only while that task has a row in a batch marked for direct approval that may still be approved directly (hda_batch_ok): a marker
-- set anywhere else never hides a notice.
CREATE OR REPLACE FUNCTION wf_notify(p_user uuid, p_kind text, p_title text, p_body text, p_task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_task IS NOT NULL AND coalesce(current_setting('pmis.hda_quiet', true), '') = p_task::text
     AND EXISTS (SELECT 1 FROM public.import_batch_rows r JOIN public.import_batches b ON b.id = r.batch_id
                 WHERE r.task_instance_id = p_task AND b.historical_direct_approve AND public.hda_batch_ok(b)) THEN
    RETURN;   -- 0087
  END IF;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link) VALUES (p_user, 'in_app', p_kind, p_title, p_body, p_task, '/tasks/' || p_task::text);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app (the mark, the direct
--    approval and the guards are internal). The redefined functions keep their owner and grants (CREATE OR REPLACE).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hda_batch_ok(import_batches)', 'hda_mark_batches(uuid[],text)', 'hda_guard_batch()', 'hda_approve_task(uuid,uuid,uuid,boolean)', 'hda_guard_task()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;
