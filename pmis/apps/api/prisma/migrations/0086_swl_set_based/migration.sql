-- 0086: switching the workflow locks of a site in one statement per site (owner report 2026-11-11, CHANGELOG 128).
--
-- WHY. The owner applied the historical load of the Master (469 sites) and got a 504: the request ran for minutes. MEASURED (100 synthetic sites with every
-- task of workflow 1, pmis_app with a signed context, pg_stat_user_functions with track_functions = pl): 88 s for the apply, of which 82 s in swl_open_task.
-- swl_apply (0085) opened the locked tasks of a site one by one; each UPDATE fired the statement trigger z_calc_after_update, which recalculated the whole site
-- (calc_refresh_site: the SLA clock of every open task) after every single task, so a site of 56 tasks was recalculated 56 times, with more open tasks each time.
-- 470 sites took 405 s. The same loop ran for a bulk switch (site_workflow_locks_set), a re-lock, and every new site created "Open".
--
-- WHAT THIS CHANGES. swl_apply opens (or re-locks) the tasks of a site in one UPDATE: the trigger recalculates the site once. Which tasks, the reason kept in
-- lock_bypass_pending, the order of the reported codes, the audit row of the site and the answer are the same as before: the reason of each task (swl_blocker)
-- depends only on the approved / N/A / skipped state of its predecessors and on the gates, which opening or re-locking a task does not change, so reading every
-- reason before the UPDATE gives the reasons the loop read one by one. swl_open_task and swl_relock_task stay for one task (wf_start, wf_save_entry).
-- Redefined from 0085 (changes marked 0086). CREATE OR REPLACE keeps the owner (pmis_definer), the search_path and the grants (PUBLIC revoked, internal).

CREATE OR REPLACE FUNCTION swl_apply(p_site uuid, p_locked boolean, p_reason text, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.sites%ROWTYPE; opened text[] := ARRAY[]::text[]; relocked text[] := ARRAY[]::text[]; actor uuid := public.app_actor();
  ids uuid[]; codes text[]; whys text[];   -- 0086: the tasks of the site, read once
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist.')); END IF;
  IF s.workflow_locks = p_locked THEN
    RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'workflow_locks', s.workflow_locks, 'changed', false, 'tasks_opened', '[]'::jsonb, 'tasks_relocked', '[]'::jsonb);
  END IF;
  PERFORM set_config('pmis.swl_apply', '1', true);
  UPDATE public.sites SET workflow_locks = p_locked, workflow_locks_changed_at = now(), workflow_locks_changed_by = actor, workflow_locks_reason = left(btrim(p_reason), 2000),
    updated_at = clock_timestamp() WHERE id = p_site;
  PERFORM set_config('pmis.swl_apply', '', true);
  IF NOT p_locked THEN
    -- 0086: every locked task the site opens (swl_task_eligible), with the lock it skips (as swl_open_task), in one UPDATE
    SELECT coalesce(array_agg(x.id ORDER BY x.sort_order, x.code), ARRAY[]::uuid[]), coalesce(array_agg(x.code ORDER BY x.sort_order, x.code), ARRAY[]::text[]),
           coalesce(array_agg(x.why ORDER BY x.sort_order, x.code), ARRAY[]::text[])
      INTO ids, codes, whys
      FROM (SELECT ti.id, td.code, td.sort_order, coalesce(public.swl_blocker(ti.id), ti.lock_reason, 'locked') AS why
              FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
             WHERE ti.site_id = p_site AND ti.state = 'locked' AND (NOT td.is_milestone_task OR td.code = 'MS4') AND td.code !~ '^(E[0-9]|MOB-)') x;
    IF cardinality(ids) > 0 THEN
      WITH u AS (
        UPDATE public.task_instances t SET state = 'open', current_level = 1, level_opened_at = now(), lock_reason = NULL, lock_bypass_pending = w.why,
          version = t.version + 1, updated_at = now()
          FROM unnest(ids, whys) AS w(id, why)
         WHERE t.id = w.id AND t.state = 'locked'
        RETURNING t.id)
      SELECT coalesce(array_agg(c.code ORDER BY c.o), ARRAY[]::text[]) INTO opened
        FROM unnest(ids, codes) WITH ORDINALITY AS c(id, code, o) WHERE c.id IN (SELECT u.id FROM u);
    END IF;
  ELSE
    -- 0086: the tasks only the switch opened (as swl_relock_task): still blocked and untouched are locked again; no longer blocked loses the pending lock
    SELECT coalesce(array_agg(x.id ORDER BY x.sort_order, x.code), ARRAY[]::uuid[]), coalesce(array_agg(x.code ORDER BY x.sort_order, x.code), ARRAY[]::text[]),
           coalesce(array_agg(x.b ORDER BY x.sort_order, x.code), ARRAY[]::text[])
      INTO ids, codes, whys
      FROM (SELECT ti.id, td.code, td.sort_order, public.swl_blocker(ti.id) AS b
              FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
             WHERE ti.site_id = p_site AND ti.state = 'open' AND ti.lock_bypass_pending IS NOT NULL) x;
    IF cardinality(ids) > 0 THEN
      UPDATE public.task_instances t SET lock_bypass_pending = NULL
        FROM unnest(ids, whys) AS w(id, b) WHERE t.id = w.id AND w.b IS NULL;
      WITH u AS (
        UPDATE public.task_instances t SET state = 'locked', lock_reason = CASE WHEN starts_with(w.b, 'gate_closed:') THEN w.b END, lock_bypass_pending = NULL,
          level_opened_at = NULL, ball_in_court_user_id = NULL, version = t.version + 1, updated_at = now()
          FROM unnest(ids, whys) AS w(id, b)
         WHERE t.id = w.id AND w.b IS NOT NULL AND t.state = 'open' AND t.lock_bypass_pending IS NOT NULL
           AND t.actual_start IS NULL AND t.actual_date IS NULL AND t.planned_date IS NULL AND t.path_frozen_at IS NULL AND coalesce(t.values, '{}'::jsonb) = '{}'::jsonb
        RETURNING t.id)
      SELECT coalesce(array_agg(c.code ORDER BY c.o), ARRAY[]::text[]) INTO relocked
        FROM unnest(ids, codes) WITH ORDINALITY AS c(id, code, o) WHERE c.id IN (SELECT u.id FROM u);
    END IF;
  END IF;
  PERFORM public.swl_audit('site_workflow_locks_set', 'site', p_site::text,
    jsonb_build_object('workflow_locks', s.workflow_locks, 'changed_at', s.workflow_locks_changed_at, 'reason', s.workflow_locks_reason),
    jsonb_build_object('workflow_locks', p_locked, 'source', p_source, 'tasks_opened', to_jsonb(opened), 'tasks_relocked', to_jsonb(relocked)),
    btrim(p_reason), p_site, s.region_id, NOT p_locked);
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'workflow_locks', p_locked, 'changed', true, 'tasks_opened', to_jsonb(opened), 'tasks_relocked', to_jsonb(relocked));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. A big Master import apply runs in the background (owner report 2026-11-11, CHANGELOG 128)
-- ---------------------------------------------------------------------------------------------------------------------
-- WHY. Even in one statement per site, the historical apply of 470 synthetic sites took 71 s (50 s to open the sites, 21 s to stage the rows), more than the
-- 30 s of a request. WHAT. A file with more sites than imports.async_rows (0074 / 0075, default 50) is checked in the request exactly as before (right, run
-- version and status, mode and reason, step-up, the historical-load option and its waiver, a file applied once), then recorded here; the API answers 202 and
-- the run shows `applying`. The background run (mi_apply_step) is the very same mi_apply_run, in one transaction of its own under a newly signed context of
-- the same person: all or nothing, as in the request. A refusal there (the waiver closed meanwhile, a step-up that expired before the run started, a site
-- the person can no longer see) ends the run `failed` with its message and the file can be applied again (status previewed). The staged batches with more
-- rows than the threshold are then sent in the background as before (0075).
ALTER TABLE master_reconciliation_runs DROP CONSTRAINT IF EXISTS master_reconciliation_runs_status_check;
ALTER TABLE master_reconciliation_runs ADD CONSTRAINT master_reconciliation_runs_status_check CHECK (status IN ('previewed', 'applied', 'staging', 'failed', 'applying'));

CREATE TABLE mi_apply_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES master_reconciliation_runs (id),
  actor_id        uuid NOT NULL REFERENCES users (id),
  session_id      uuid,
  auth_method     text,
  mfa             boolean,
  request_id      text,
  stepup_verified boolean NOT NULL DEFAULT false,
  stepup_until    timestamptz,
  mode            text NOT NULL CHECK (mode IN ('submit', 'draft')),
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 2000),
  hw_reason       text CHECK (hw_reason IS NULL OR char_length(hw_reason) <= 2000),
  sites_total     integer NOT NULL CHECK (sites_total >= 0),
  state           text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  error_code      text,
  error           text,
  outcome         jsonb,
  tries           integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz
);
CREATE UNIQUE INDEX mi_apply_jobs_one_running ON mi_apply_jobs (run_id) WHERE state = 'running';
COMMENT ON TABLE mi_apply_jobs IS '0086: a Master import apply run in the background (status applying). Written only by mi_apply_run / mi_apply_step / mi_apply_abandon; no right for pmis_app.';
ALTER TABLE mi_apply_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mi_apply_jobs FORCE ROW LEVEL SECURITY;   -- no policy: only the definer functions (pmis_definer bypasses row security) read it
REVOKE ALL ON mi_apply_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mi_apply_jobs TO pmis_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON mi_apply_jobs FROM pmis_app; END IF;
END $$;

-- mi_apply_run (latest definition 0085, changes marked 0086: the background run)
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
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total)
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL), btrim(p_reason));
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'batches', '[]'::jsonb, 'queued', 0);
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
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
  END LOOP;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued);
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL), btrim(p_reason));
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- Ends a background apply that could not be done: the run can be applied again (previewed), audited and logged (internal).
CREATE OR REPLACE FUNCTION mi_apply_fail(p_job uuid, p_code text, p_detail text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.mi_apply_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.mi_apply_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.state <> 'running' THEN RETURN; END IF;
  UPDATE public.mi_apply_jobs SET state = 'failed', error_code = left(p_code, 60), error = left(p_detail, 2000), finished_at = clock_timestamp(), heartbeat_at = clock_timestamp()
    WHERE id = p_job;
  UPDATE public.master_reconciliation_runs SET status = 'previewed', version = version + 1 WHERE id = j.run_id AND status = 'applying';
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
  VALUES ('master_import.apply_failed', 'master_reconciliation_run', j.run_id::text, jsonb_build_object('status', 'applying'),
          jsonb_build_object('status', 'previewed', 'job_id', j.id, 'code', p_code), left(coalesce(p_detail, p_code), 2000), coalesce(public.app_actor(), j.actor_id));
  PERFORM public.log_system_write('warn', 'master-import', 'legacy Master import: background apply failed',
    jsonb_build_object('run_id', j.run_id, 'job_id', j.id, 'code', p_code, 'detail', left(p_detail, 500)), j.actor_id, j.request_id);
END $$;

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
      CASE WHEN j.hw_reason IS NOT NULL THEN jsonb_build_object('reason', j.hw_reason) END);
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

-- The background applies left running (a restart of the API, a lost process), for the resume job: only what is needed to sign the person's context again.
CREATE OR REPLACE FUNCTION mi_apply_pending(p_idle integer DEFAULT 0)
RETURNS TABLE (job_id uuid, actor_id uuid, actor_active boolean, stepup_until timestamptz, session_id uuid, auth_method text, mfa boolean, request_id text, heartbeat_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT j.id, j.actor_id, EXISTS (SELECT 1 FROM public.users x WHERE x.id = j.actor_id AND x.status = 'active' AND x.deleted_at IS NULL),
         j.stepup_until, j.session_id, j.auth_method, j.mfa, j.request_id, j.heartbeat_at
  FROM public.mi_apply_jobs j
  WHERE j.state = 'running' AND j.heartbeat_at <= clock_timestamp() - make_interval(secs => greatest(coalesce(p_idle, 0), 0))
  ORDER BY j.created_at
$$;

-- Stops a background apply (granted): by the person who asked for it (after repeated failures), or by the resume job once that person can no longer act.
CREATE OR REPLACE FUNCTION mi_apply_abandon(p_job uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.mi_apply_jobs%ROWTYPE; actor uuid := public.app_actor();
BEGIN
  SELECT * INTO j FROM public.mi_apply_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The apply run does not exist.')); END IF;
  IF j.state <> 'running' THEN RETURN jsonb_build_object('job_id', j.id, 'state', j.state); END IF;
  IF actor IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.users x WHERE x.id = j.actor_id AND x.status = 'active' AND x.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'only the person who applied the file stops its run' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF actor <> j.actor_id THEN
    RAISE EXCEPTION 'only the person who applied the file stops its run' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.mi_apply_fail(p_job, 'stopped', left(coalesce(nullif(btrim(p_reason), ''), 'stopped'), 500));
  RETURN jsonb_build_object('job_id', j.id, 'state', 'failed');
END $$;

-- The background apply of a run, for its screen (granted; NULL for a run never applied in the background, and for anybody who may not use the import).
CREATE OR REPLACE FUNCTION mi_run_applying_json(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('job_id', j.id, 'state', j.state, 'sites_total', j.sites_total, 'started_at', j.created_at, 'updated_at', j.heartbeat_at,
           'finished_at', j.finished_at, 'error_code', j.error_code, 'error', j.error)
  FROM public.mi_apply_jobs j
  WHERE j.run_id = p_run AND public.mi_can_use()
  ORDER BY j.created_at DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Ownership and rights. pmis_app gets the doors of the background run (as imp_upload_step / imp_upload_pending / imp_upload_abandon of 0083) and the
--    progress of a run; mi_apply_fail is internal. mi_apply_run and swl_apply keep their owner and grants (CREATE OR REPLACE).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['mi_apply_fail(uuid,text,text)', 'mi_apply_step(uuid)', 'mi_apply_pending(integer)', 'mi_apply_abandon(uuid,text)', 'mi_run_applying_json(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['mi_apply_step(uuid)', 'mi_apply_pending(integer)', 'mi_apply_abandon(uuid,text)', 'mi_run_applying_json(uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
