-- 0122_historical_reapply: re-apply a historical Master file with direct approval, and the overall status of a site that follows its milestones (owner decision
-- 2026-11-17; CHANGELOG 161; contract 0.15.36).
-- Mirror: db/sql/121_historical_reapply.sql (kept byte-identical).
--
-- WHY. The real Site Master was loaded as a historical load on 2026-11-10 and 2026-11-11, before 0092 ("Direct approval") and 0093 (the register sheets of the
-- same file) existed. Those loads left four Master batches open (two validated, two in approval, streams CW and TE only), and mi_apply_run refuses a file that
-- was already applied, so the owner could not load the same file again with the new options. Separately, sites.overall_status never left 'not_started': only
-- the cancel flows write it, while the dashboard derives the status from the milestones. The owner decided: "Re-apply the file with direct approval", the old
-- open Master batches discarded so nothing is approved twice, and the overall status of each site computed from its milestones.
--
-- WHAT THIS ADDS.
--   1. `historical_load.reapply` of POST /master-import/runs/{run_id}/apply (mi_apply_run, p_historical ->> 'reapply'). It is accepted only with
--      `approve_directly` (so only with the historical load: a System Admin, never a delegate, a step-up, a reason, the historical-load waiver open, the checks
--      of hw_mark_authorize, 0073; submit mode). With it, the refusal "this file was already applied (same SHA-256)" is lifted for that run; without it the
--      refusal stays and now carries `already_applied` and `applied_run_id`, so the screen can offer the re-apply. A run must still be in status previewed (a
--      run already applied is never applied again: upload the file again, or use another previewed run of the same file).
--   2. Before anything is staged, hrp_discard_open sets every still-open Master import batch (status validated, in_review, in_approval, partially_approved;
--      source master_import) that is a historical load (any earlier file: the recommended choice, so the 2026-11-10 file cannot be sent later either) or is of
--      the same file to 'discarded', with one audit row each (`import_batch.discarded_for_reapply`, admin override, the reason of the load). Their rows that were
--      never sent become 'rejected' with the note "discarded: ..." (never applied). Rows already sent keep their decision: a task those rows submitted keeps its
--      own state (approved stays approved; one still in review keeps its L2 path, see below). A batch with a background send still running refuses the
--      re-apply (409 upload_processing). In the background apply (0086) the discard runs inside the apply's own transaction (mi_apply_step passes the choice
--      stored on mi_apply_jobs.reapply), so the discard and the new staging commit together or not at all.
--   3. The load itself is the apply of 0092 / 0093 unchanged: the stream batches of the Master sheet and the register sheets, staged, marked historical and
--      for direct approval, sent and approved at once. No task is approved twice and no approved task is reopened: the staging compares each row with the
--      task (a row equal to the approved task is 'unchanged'; a row that differs from an approved task is refused on its row by imp_submit_stream_rows,
--      "The task is no longer open for entry"); a task still in review or approval from an earlier submission is held (open_submission) and keeps its normal
--      L2 path. A second identical re-apply of another previewed run of the same file therefore changes nothing (its rows are unchanged).
--   4. The mapping gap of the Design & Acquisition stream. The Master sheet has no typed column for the stage-1 tasks: the Site Release date (V) is a formula
--      over the RF & Design sheet (TSSR Approved, LLD Approved Date; for HUB / Terminal the MW LOS Survey Date and Link Budget Date) and the Acquisition sheet.
--      That is why the earlier loads produced CW and TE batches only. With the register sheets of the same file (0093), mi_apply_run now enters the dates of A2,
--      A4 and A5 from the RF & Design rows on the site's Master row (only the non-derived task columns of an active stream template), so they are staged in a
--      Design & Acquisition batch and approved directly like the others. Not covered (open): A1 (no source in the file), and the tasks fed by a register (A3,
--      B1, B2, B3, C1 to C4, D1, D17, Z1): 0093 approves the register rows without linking them to their task in a historical load, so those tasks stay
--      open and their milestones cannot complete yet. The closure stream (B15, D18) loads when the file has their dates.
--   5. The overall status of a site (sites.overall_status) follows its milestones, with the rule of the dashboard (dash_build_facts): cancelled stays as the
--      cancel flows set it; otherwise completed when the final milestone is done, on_hold when the latest approved Suspension is later than the latest
--      approved Resumption (Change Control, 0062), in_progress when any milestone is done or any task is approved, else not_started. site_status_derive
--      computes it; site_status_refresh writes it when it changed, called at the end of calc_refresh_site (every task state change, Change Control
--      suspension and resumption, site creation ... already call it), and by a trigger when a cancellation is withdrawn (0062 restores the earlier status,
--      which may be stale). The dashboard takes the same rule: dash_build_facts also counts a site with an approved task as in_progress. The status is a
--      derived value, recomputed from the data: a change is not audited row by row; the one-time backfill of all sites writes one audit row with the counts.
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0122"): mi_apply_run 7 arguments (0093), mi_apply_step (0093),
-- calc_refresh_site (0018), dash_build_facts (0039). CREATE OR REPLACE keeps their owner (pmis_definer), search_path and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to
-- pmis_app: the API doors stay mi_apply_run / mi_apply_step. No new table right.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The re-apply choice stored on the background apply (0086)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE mi_apply_jobs
  ADD COLUMN reapply boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT mi_apply_jobs_reapply_check CHECK (NOT reapply OR approve_directly);
COMMENT ON COLUMN mi_apply_jobs.reapply IS '0122: a historical Master file applied again with direct approval; the open Master batches are discarded inside the background apply';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The discard of the open Master batches before a re-apply (internal; called only by mi_apply_run)
-- ---------------------------------------------------------------------------------------------------------------------
-- Discards every open Master import batch that is a historical load, or of the file of p_run. A System Admin with a step-up under the open waiver (checked again
-- here, from the session context). Returns [{id, stream_code, register_key, status_before, rows_rejected, rows_sent_open}].
CREATE OR REPLACE FUNCTION hrp_discard_open(p_run public.master_reconciliation_runs, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid; b public.import_batches%ROWTYPE; n_rej int; n_open int; out_ jsonb[] := ARRAY[]::jsonb[]; note_ text;
BEGIN
  actor := public.hw_require_admin_stepup();   -- a System Admin (never a delegate) with a step-up
  IF NOT public.hw_waiver_open_now() THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The historical-load waiver is closed: the file cannot be applied again.'));
  END IF;
  IF p_run.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.master_reconciliation_runs x WHERE x.id = p_run.id AND x.file_sha256 = p_run.file_sha256) THEN
    RAISE EXCEPTION 'historical re-apply: not a run of the Master import' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/reason', 'code', 'required',
      'message', 'A reason is required.'))));
  END IF;
  -- a batch whose rows are being sent or decided in the background now is never discarded under that run
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j JOIN public.import_batches x ON x.id = j.batch_id
             WHERE j.state = 'running' AND x.source = 'master_import' AND x.status IN ('validated', 'in_review', 'in_approval', 'partially_approved')
               AND (x.historical_load OR x.file_sha256 = p_run.file_sha256)) THEN
    PERFORM public.wf_err('upload_processing', jsonb_build_object('detail',
      'A batch of an earlier Master load is still being sent in the background. Wait until it ends, then apply the file again.'));
  END IF;
  note_ := 'discarded: the Master file was applied again with direct approval (run ' || p_run.id::text || ')';
  FOR b IN SELECT * FROM public.import_batches x
           WHERE x.source = 'master_import' AND x.status IN ('validated', 'in_review', 'in_approval', 'partially_approved')
             AND (x.historical_load OR x.file_sha256 = p_run.file_sha256)
           ORDER BY x.created_at, x.id FOR UPDATE LOOP
    -- the rows never sent are never applied now; a row already sent keeps its decision (its task or record keeps its own state and path)
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = note_, hold_reason = NULL
      WHERE batch_id = b.id AND decision IN ('pending', 'pending_previous_approval') AND task_submitted_at IS NULL AND register_record_id IS NULL;
    GET DIAGNOSTICS n_rej = ROW_COUNT;
    SELECT count(*) INTO n_open FROM public.import_batch_rows x
      LEFT JOIN public.task_instances t ON t.id = x.task_instance_id
      LEFT JOIN public.register_records rr ON rr.id = x.register_record_id
      WHERE x.batch_id = b.id AND (x.task_submitted_at IS NOT NULL OR x.register_record_id IS NOT NULL)
        AND (t.state IN ('in_review', 'in_approval') OR rr.state IN ('in_review', 'in_approval'));
    UPDATE public.import_batches SET status = 'discarded', note = left(note_, 500), closed_at = now(), version = version + 1 WHERE id = b.id;
    PERFORM public.log_audit_write('import_batch.discarded_for_reapply', 'import_batch', b.id::text,
      jsonb_build_object('status', b.status, 'stream_code', b.stream_code, 'register_key', b.register_key, 'file_sha256', b.file_sha256, 'historical_load', b.historical_load),
      jsonb_build_object('status', 'discarded', 'reapply_run_id', p_run.id, 'file_sha256', p_run.file_sha256, 'rows_rejected', n_rej, 'rows_sent_open', n_open,
        'rule', 'the open batches of the earlier Master loads are discarded before the file is applied again with direct approval; their rows are not applied'),
      btrim(p_reason), NULL, NULL, NULL, true);
    out_ := array_append(out_, jsonb_build_object('id', b.id, 'stream_code', b.stream_code, 'register_key', b.register_key, 'status_before', b.status,
      'rows_rejected', n_rej, 'rows_sent_open', n_open));
  END LOOP;
  RETURN to_jsonb(out_);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The overall status of a site, from its milestones (the dashboard rule of dash_build_facts, as of today)
-- ---------------------------------------------------------------------------------------------------------------------
-- The status the site's data gives, cancellation aside: completed (the final milestone done), on_hold (an approved Suspension later than the latest approved
-- Resumption), in_progress (a milestone done or a task approved), not_started. A milestone or task counts when approved with its date on or before today.
CREATE OR REPLACE FUNCTION site_status_derive(p_site uuid) RETURNS "OverallStatus"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH s AS (SELECT x.id, x.workflow_version_id AS wf FROM public.sites x WHERE x.id = p_site),
  ms AS (
    SELECT sd.seq, (t.id IS NOT NULL AND t.state = 'approved' AND NOT t.is_na AND coalesce(t.actual_date, t.approved_date) <= public.cal_today()) AS done
    FROM s JOIN public.stage_definitions sd ON sd.workflow_id = s.wf AND sd.is_active
    LEFT JOIN public.task_definitions td ON td.stage_id = sd.id AND td.is_milestone_task
    LEFT JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id),
  h AS (
    SELECT max(c.approval_date) FILTER (WHERE c.kind = 'suspension') AS sdate, max(c.approval_date) FILTER (WHERE c.kind = 'resumption') AS rdate
    FROM public.change_requests c
    WHERE c.site_id = p_site AND c.status IN ('approved', 'applied') AND c.approval_date IS NOT NULL AND c.approval_date <= public.cal_today())
  SELECT (CASE
    WHEN coalesce((SELECT bool_or(ms.done) FROM ms WHERE ms.seq = (SELECT max(m2.seq) FROM ms m2)), false) THEN 'completed'
    WHEN coalesce((SELECT h.sdate IS NOT NULL AND (h.rdate IS NULL OR h.sdate > h.rdate) FROM h), false) THEN 'on_hold'
    WHEN coalesce((SELECT bool_or(ms.done) FROM ms), false)
      OR EXISTS (SELECT 1 FROM public.task_instances t WHERE t.site_id = p_site AND t.state = 'approved' AND NOT t.is_na
                   AND coalesce(t.actual_date, t.approved_date) <= public.cal_today()) THEN 'in_progress'
    ELSE 'not_started' END)::"OverallStatus"
$$;

-- Writes the derived status when it changed (a cancelled site keeps 'cancelled'). Returns true when the status moved.
CREATE OR REPLACE FUNCTION site_status_refresh(p_site uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur "OverallStatus"; nxt "OverallStatus";
BEGIN
  SELECT s.overall_status INTO cur FROM public.sites s WHERE s.id = p_site;
  IF NOT FOUND OR cur = 'cancelled' THEN RETURN false; END IF;
  nxt := public.site_status_derive(p_site);
  IF nxt IS NOT DISTINCT FROM cur THEN RETURN false; END IF;
  UPDATE public.sites SET overall_status = nxt, updated_at = clock_timestamp() WHERE id = p_site AND overall_status = cur;
  RETURN FOUND;
END $$;

-- AFTER UPDATE OF overall_status on sites, when a cancellation is withdrawn (0062 restores the status the site had before it, which the work may have moved
-- since): the status is derived again.
CREATE OR REPLACE FUNCTION site_status_after_uncancel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.site_status_refresh(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER z_site_status_uncancel AFTER UPDATE OF overall_status ON sites FOR EACH ROW
  WHEN (OLD.overall_status = 'cancelled' AND NEW.overall_status <> 'cancelled') EXECUTE FUNCTION site_status_after_uncancel();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The redefined functions
-- ---------------------------------------------------------------------------------------------------------------------
-- mi_apply_run (latest 0093; changes marked 0122)
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
  IF hda THEN
    -- 0092: the batches just staged are marked for direct approval (a System Admin, the step-up, the open waiver, checked again on each batch); every
    -- submitted row of them is then approved at once by the sender, here or in the chunked background send (the mark is read from the batch row there)
    PERFORM public.hda_mark_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');
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


-- mi_apply_step (latest 0093; changes marked 0122)
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
      CASE WHEN j.hw_reason IS NOT NULL THEN jsonb_build_object('reason', j.hw_reason, 'approve_directly', j.approve_directly, 'registers', j.load_registers,
        'reapply', j.reapply) END,   -- 0122: the re-apply chosen at the request
      j.registers);   -- 0092, 0093: the choices and the register sheets stored at the request (the sheets read by the API from the run's file)
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


-- calc_refresh_site (latest 0018; changes marked 0122)
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
  PERFORM public.site_status_refresh(p_site);   -- 0122: the stored overall status follows the milestones (the dashboard rule)
  PERFORM set_config('pmis.calc_busy', '', true);
  RETURN changed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', '', true);
  RAISE;
END $$;


-- dash_build_facts (latest 0039; changes marked 0122)
CREATE OR REPLACE FUNCTION dash_build_facts(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE live boolean := (p_ref = public.cal_today());
BEGIN
  DROP TABLE IF EXISTS _dsite; DROP TABLE IF EXISTS _dbase; DROP TABLE IF EXISTS _dms;
  CREATE TEMP TABLE _dsite ON COMMIT DROP AS
    SELECT s.id, s.site_code, s.region_id, c.cluster_code, s.delivery_scenario::text AS scenario, s.workflow_version_id AS wf,
           (s.overall_status = 'cancelled') AS cancelled,
           NULL::text AS status, NULL::integer AS cur_seq, NULL::text AS cur_code
    FROM public.sites s LEFT JOIN public.clusters c ON c.id = s.cluster_id
    WHERE s.is_active AND (p_scope IS NULL OR s.region_id = ANY (p_scope)) AND (p_region IS NULL OR s.region_id = p_region)
      AND (p_cluster IS NULL OR c.cluster_code = p_cluster) AND (p_scenario IS NULL OR s.delivery_scenario::text = p_scenario);
  CREATE UNIQUE INDEX ON _dsite (id);

  CREATE TEMP TABLE _dbase ON COMMIT DROP AS
    SELECT DISTINCT ON (be.site_id, be.milestone_code) be.site_id, be.milestone_code AS code, be.baseline_date AS base
    FROM public.baseline_entries be JOIN public.baseline_versions bv ON bv.id = be.version_id AND bv.status = 'approved'
    WHERE be.site_id IN (SELECT id FROM _dsite)
    ORDER BY be.site_id, be.milestone_code, bv.version DESC;
  CREATE UNIQUE INDEX ON _dbase (site_id, code);

  CREATE TEMP TABLE _dms ON COMMIT DROP AS
    WITH raw AS (
      SELECT s.id AS site_id, s.wf, sd.code, sd.seq, sd.stream_code,
        CASE WHEN t.id IS NULL OR t.state IN ('na', 'skipped') OR t.is_na THEN 'na'
             WHEN t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref THEN 'done'
             ELSE 'open' END AS state,
        CASE WHEN t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref THEN coalesce(t.actual_date, t.approved_date) END AS d,
        b.base
      FROM _dsite s
      JOIN public.stage_definitions sd ON sd.workflow_id = s.wf AND sd.is_active
      LEFT JOIN public.task_definitions td ON td.stage_id = sd.id AND td.is_milestone_task
      LEFT JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id
      LEFT JOIN _dbase b ON b.site_id = s.id AND b.code = sd.code
    ), prev AS (
      SELECT r.*,
        max(r.seq) FILTER (WHERE r.state <> 'na') OVER w AS prev_app, max(r.seq) FILTER (WHERE r.state = 'done') OVER w AS prev_done
      FROM raw r WINDOW w AS (PARTITION BY r.site_id ORDER BY r.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
    )
    SELECT p.site_id, p.code, p.seq, p.stream_code, p.state, p.d, p.base,
      CASE WHEN p.state = 'done' AND p.base IS NOT NULL THEN (SELECT cb.wd FROM _dcal cb WHERE cb.d = p.d) - (SELECT ca.wd FROM _dcal ca WHERE ca.d = p.base) END AS var_wd,
      (p.prev_app IS NOT DISTINCT FROM p.prev_done) AS gate_open,
      (live AND p.state = 'open' AND (p.prev_app IS NOT DISTINCT FROM p.prev_done) AND bl.site_id IS NOT NULL) AS blocked
    FROM prev p LEFT JOIN (
      SELECT DISTINCT gs.site_id, g.to_code, g.workflow_id FROM public.site_gate_state gs JOIN public.phase_gate_rules g ON g.link_code = gs.gate_code AND g.is_active
      WHERE NOT gs.is_open AND gs.site_id IN (SELECT id FROM _dsite)) bl ON bl.site_id = p.site_id AND bl.to_code = p.code AND bl.workflow_id = p.wf;
  CREATE INDEX ON _dms (site_id, seq);
  ANALYZE _dsite;
  ANALYZE _dms;

  UPDATE _dsite s SET status = x.status, cur_seq = x.cur_seq, cur_code = x.cur_code
  FROM (
    SELECT s2.id,
      CASE WHEN s2.cancelled THEN 'cancelled'
           WHEN coalesce(f.final_done, false) THEN 'completed'
           WHEN h.sdate IS NOT NULL AND (h.rdate IS NULL OR h.sdate > h.rdate) THEN 'on_hold'
           WHEN coalesce(f.any_done, false) OR coalesce(ta.any_approved, false) THEN 'in_progress'   -- 0122: or any task approved by the reference date
           ELSE 'not_started' END AS status,
      f.cur_seq, f.cur_code
    FROM _dsite s2
    LEFT JOIN (SELECT m.site_id, bool_or(m.state = 'done') AS any_done, max(m.seq) FILTER (WHERE m.state = 'done') AS cur_seq,
                      (array_agg(m.code ORDER BY m.seq DESC) FILTER (WHERE m.state = 'done'))[1] AS cur_code,
                      coalesce(bool_or(m.state = 'done') FILTER (WHERE m.seq = mx.seq), false) AS final_done
               FROM _dms m JOIN (SELECT site_id, max(seq) AS seq FROM _dms GROUP BY site_id) mx ON mx.site_id = m.site_id GROUP BY m.site_id) f ON f.site_id = s2.id
    LEFT JOIN (SELECT c.site_id, max(c.approval_date) FILTER (WHERE c.kind = 'suspension') AS sdate, max(c.approval_date) FILTER (WHERE c.kind = 'resumption') AS rdate
               FROM public.change_requests c WHERE c.status IN ('approved', 'applied') AND c.approval_date IS NOT NULL AND c.approval_date <= p_ref
                 AND c.site_id IN (SELECT id FROM _dsite) GROUP BY c.site_id) h ON h.site_id = s2.id
    LEFT JOIN (SELECT t.site_id, true AS any_approved FROM public.task_instances t   -- 0122
               WHERE t.site_id IN (SELECT id FROM _dsite) AND t.state = 'approved' AND NOT t.is_na AND coalesce(t.actual_date, t.approved_date) <= p_ref
               GROUP BY t.site_id) ta ON ta.site_id = s2.id
  ) x WHERE x.id = s.id;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app (the discard, the status and
--    its trigger are internal). The redefined functions keep their owner and grants (CREATE OR REPLACE).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hrp_discard_open(master_reconciliation_runs,text)', 'site_status_derive(uuid)', 'site_status_refresh(uuid)', 'site_status_after_uncancel()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. One-time backfill: the overall status of every site that is not cancelled, from its milestones; one audit row with the counts (no site data in it)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE before_ jsonb; after_ jsonb; moved int := 0; sid uuid;
BEGIN
  SELECT coalesce(jsonb_object_agg(st, n), '{}'::jsonb) INTO before_ FROM (SELECT overall_status::text AS st, count(*) AS n FROM sites GROUP BY 1) x;
  FOR sid IN SELECT id FROM sites WHERE overall_status <> 'cancelled' ORDER BY id LOOP
    IF site_status_refresh(sid) THEN moved := moved + 1; END IF;
  END LOOP;
  SELECT coalesce(jsonb_object_agg(st, n), '{}'::jsonb) INTO after_ FROM (SELECT overall_status::text AS st, count(*) AS n FROM sites GROUP BY 1) x;
  INSERT INTO audit_log (action, entity_type, entity_id, before, after, reason)
  VALUES ('site_overall_status_backfill', 'site', 'all', jsonb_build_object('by_status', before_),
          jsonb_build_object('by_status', after_, 'sites_changed', moved, 'rule', 'cancelled kept; completed / on_hold / in_progress / not_started from the milestones (dashboard rule)'),
          'migration 0122: the overall status of a site follows its milestones (owner decision 2026-11-17)');
END $$;
