-- 0083: big template uploads staged in the background (technical decision of 2026-11-09, CHANGELOG 122).
--
-- WHY. The owner uploaded a filled "Master (all sheets)" file (TPL-MASTER, about 469 sites) through POST /import-batches and got a 500: the request
-- transaction (TxInterceptor, a Prisma interactive transaction with a 30 s timeout) was closed after 133 s. The upload parses the workbook and stages
-- every part (one batch per stream and per register sheet) inside the request.
--
-- MEASURED (470 synthetic sites, every typed task column of the Master sheet filled, pmis_app with a signed context, pg_stat_user_functions with
-- track_functions = pl): 98 s for the upload, of which 96.7 s in imp_stage_master and 1.4 s in the Node parse. 74 s were the self time of
-- imp_insert_task_batch and 11 s that of imp_stage_stream_batch: both grew a jsonb array with `x := x || jsonb_build_array(...)` in a loop, which copies
-- the whole array at every row (quadratic: 6,580 task rows for the TE part), and the duplicate check grew a jsonb object the same way.
--
-- WHAT THIS CHANGES.
--   1. The same staging, linear (identical batches, rows, errors, warnings, order and audit rows):
--      a. imp_insert_task_batch flattens the results in one statement (same order: by file row, the row error first, then the tasks).
--      b. imp_stage_stream_batch is split into imp_stream_open (every check before the rows: template, version, header, mode, rights, the task of a
--         per-task upload, the historical-load mark), imp_stream_eval (the rows, by imp_stage_task_row, unchanged) and imp_stream_close (the
--         "same task twice in the file" check, then imp_insert_task_batch, the mode and the mark). It is their composition. The duplicate check only
--         follows the rows of a Site ID that appears more than once (only they can name the same task twice), in the same order, with the same message.
--      c. imp_stage_register_batch collects its rows in an array (same rows, same order).
--      d. imp_stage_master_core is split into imp_master_plan (the version and header checks of every sheet, the Master columns shared by several
--         tasks (Q205), the split of the Master sheet into one unit per stream and the register units, the parts that are skipped), imp_master_unit
--         (one unit: a stream batch or a register batch, a refusal is "skipped" as before) and imp_master_finish (the refusal when nothing could be
--         staged, the audit row of the group). It is their composition. imp_stage_batch (9 arguments) is split the same way (imp_batch_plan,
--         imp_batch_post).
--      Measured on the same file: see CHANGELOG 122 (before / after).
--   2. An upload with more data rows than imports.async_rows (the setting of 0074 / 0075, default 50) is staged in the background. The request checks
--      the right, the upload guard (guardXlsx), the hidden _tpl sheet, the version, the header rows and the historical-load option exactly as before,
--      then imp_upload_start checks again what the staging checks before its rows (imp_batch_plan / imp_stream_open, imp_master_plan and every unit's
--      own checks, run and rolled back), stores the parsed rows in import_uploads and answers; the API answers 202 with the upload in status `parsing`
--      and its progress. imp_upload_step stages one unit, or the next rows of a stream unit, per transaction, under a newly signed context of the same
--      person (app_actor() must be the uploader): the rows go through the same functions as the synchronous upload, and each unit ends as the same
--      batch. A unit that is refused is recorded (the "skipped" list of a Master file, or the refusal of a one-batch upload). imp_upload_pending lists
--      the runs to resume after a restart; imp_upload_abandon stops one (the uploader, or the resume job once the uploader can no longer act). The same
--      file (same person, same SHA-256) cannot be staged twice at the same time: 409 upload_processing. The parsed rows are cleared when the run ends.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC; pmis_app is granted only
-- imp_upload_start, imp_upload_step, imp_upload_pending, imp_upload_abandon, imp_upload_json and imp_uploads_running_json. No table right for pmis_app.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1a. The rows of a task batch, flattened in one statement
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.imp_insert_task_batch(p_version_id uuid, p_template text, p_stream text, p_file_name text, p_sha text, p_group uuid, p_sheet text,
  p_results jsonb, p_task uuid, p_task_site uuid, p_source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); bid uuid := gen_random_uuid(); flat jsonb; regions int[]; n_rows int; n_err int;
BEGIN
  -- 0083: one statement instead of `flat := flat || ...` per row (quadratic); the same order: by result, its row error first, then its items
  SELECT coalesce(jsonb_agg(x.f ORDER BY t.n, x.k, x.m), '[]'::jsonb) INTO flat
  FROM jsonb_array_elements(p_results) WITH ORDINALITY AS t(el, n)
  CROSS JOIN LATERAL (
    SELECT 0 AS k, 0::bigint AS m,
           jsonb_build_object('row_no', t.el -> 'row_no', 'sheet', t.el ->> 'sheet', 'site_code', t.el -> 'res' ->> 'site_code', 'region_id', t.el -> 'res' -> 'region_id',
             'site_id', t.el -> 'res' -> 'site_id', 'action', 'error', 'decision', 'pending', 'errors', t.el -> 'res' -> 'row_errors', 'warnings', '[]'::jsonb, 'diff', '{}'::jsonb,
             'payload', '{}'::jsonb, 'key', t.el -> 'res' ->> 'site_code') AS f
    WHERE jsonb_array_length(coalesce(t.el -> 'res' -> 'row_errors', '[]'::jsonb)) > 0
    UNION ALL
    SELECT 1, i.m, i.it || jsonb_build_object('row_no', t.el -> 'row_no', 'sheet', t.el ->> 'sheet', 'site_code', t.el -> 'res' ->> 'site_code', 'region_id', t.el -> 'res' -> 'region_id',
             'site_id', t.el -> 'res' -> 'site_id')
    FROM jsonb_array_elements(coalesce(t.el -> 'res' -> 'items', '[]'::jsonb)) WITH ORDINALITY AS i(it, m)
  ) x;
  SELECT coalesce(array_agg(DISTINCT (f ->> 'region_id')::int) FILTER (WHERE f ->> 'action' <> 'error' AND f ->> 'region_id' IS NOT NULL), ARRAY[]::int[]),
         count(*), count(*) FILTER (WHERE f ->> 'action' = 'error')
    INTO regions, n_rows, n_err FROM jsonb_array_elements(flat) f;
  IF n_rows = 0 THEN RETURN NULL; END IF;      -- nothing in the file can be entered: no empty batch

  INSERT INTO public.import_batches (id, template_version_id, source, file_name, file_sha256, status, uploaded_by, region_scope, rows_total, rows_error, register_key, task_id, site_id,
    stream_code, group_id, part_sheet)
  VALUES (bid, p_version_id, p_source, left(p_file_name, 200), p_sha, 'validated', actor, regions, n_rows, n_err, NULL, p_task, p_task_site, p_stream, p_group, p_sheet);
  INSERT INTO public.import_batch_rows (batch_id, row_no, sheet, site_code, region_id, target_entity, target_id, action, payload, diff, errors, warnings, decision, row_key, site_id,
    hold_reason, task_instance_id, task_code, ord, source_ref)
  SELECT bid, (f ->> 'row_no')::int, f ->> 'sheet', f ->> 'site_code', (f ->> 'region_id')::int, 'task', (f ->> 'task_id')::uuid, f ->> 'action', coalesce(f -> 'payload', '{}'::jsonb),
         f -> 'diff', f -> 'errors', f -> 'warnings', f ->> 'decision', f ->> 'key', (f ->> 'site_id')::uuid, f ->> 'hold_reason', (f ->> 'task_id')::uuid, f ->> 'task_code', t.n::int,
         (f ->> 'sheet') || '!' || (f ->> 'row_no')
  FROM jsonb_array_elements(flat) WITH ORDINALITY AS t(f, n);
  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, after, actor_id)
  VALUES ('import_batch_create', 'import_batch', bid::text, NULL,
          jsonb_build_object('template_id', p_template, 'stream', p_stream, 'sheet', p_sheet, 'source', p_source, 'group_id', p_group, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha,
            'rows', n_rows, 'errors', n_err, 'update', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'update'),
            'unchanged', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'unchanged')), actor);
  RETURN bid;
END $$;

-- int[] <-> jsonb for the context of a stream staging (NULL = every region, as wf_actor_regions answers it)
CREATE OR REPLACE FUNCTION imp_int_array(p jsonb) RETURNS int[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN NULL ELSE ARRAY(SELECT (x #>> '{}')::int FROM jsonb_array_elements(p) x) END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1b. A stream batch: the checks before the rows, the rows, the end
-- ---------------------------------------------------------------------------------------------------------------------
-- Every check imp_stage_stream_batch made before its rows (same order, same refusals). The answer is the context the rows are read with.
CREATE OR REPLACE FUNCTION imp_stream_open(p_template text, p_version integer, p_checksum text, p_task uuid, p_mode text, p_hw jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; r_import int[]; r_view int[]; r_edit int[]; task_site uuid;
  hw_cutoff date;   -- 0073: the cutoff of the open waiver when the batch is marked
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_hw IS NOT NULL THEN
    IF p_mode <> 'submit' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'The historical load is for Submit for Review: a draft has no document check.'))));
    END IF;
    hw_cutoff := public.hw_mark_authorize(p_hw ->> 'reason');   -- 0073 (Q462): a System Admin, a step-up, the waiver open, a reason
  END IF;
  IF p_mode NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'stream';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF p_checksum IS NOT NULL AND v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_view := public.wf_actor_regions('sites', 'view');
  r_edit := public.wf_actor_regions('sites', 'edit');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_view IS NOT NULL AND cardinality(r_view) = 0) OR (r_edit IS NOT NULL AND cardinality(r_edit) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not import tasks of the Site Register.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.site_id INTO task_site FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id);
    IF task_site IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
                   WHERE ti.id = p_task AND sd.stream_code = d.stream_code) THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'This task belongs to another stream: this template is for the stream ' || d.stream_code || '.'));
    END IF;
  END IF;
  RETURN jsonb_build_object('template_id', p_template, 'version_id', v.id, 'stream_code', d.stream_code, 'r_import', to_jsonb(r_import), 'r_view', to_jsonb(r_view),
    'r_edit', to_jsonb(r_edit), 'task_site', task_site, 'hw_cutoff', hw_cutoff);
END $$;

-- The rows (unchanged: imp_stage_task_row for each, in order). The answer is the list of results, without the "same task twice" check (imp_stream_close).
CREATE OR REPLACE FUNCTION imp_stream_eval(p_ctx jsonb, p_rows jsonb, p_mode text, p_sheet text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cols jsonb; r_view int[] := public.imp_int_array(p_ctx -> 'r_view'); r_import int[] := public.imp_int_array(p_ctx -> 'r_import'); r_edit int[] := public.imp_int_array(p_ctx -> 'r_edit');
  task_site uuid := (p_ctx ->> 'task_site')::uuid; hw_cutoff date := (p_ctx ->> 'hw_cutoff')::date; el jsonb; acc jsonb[] := ARRAY[]::jsonb[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT v.columns INTO cols FROM public.template_versions v WHERE v.id = (p_ctx ->> 'version_id')::uuid;
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x LOOP
    acc := array_append(acc, jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', p_sheet),
      'res', public.imp_stage_task_row(cols, el, task_site, r_view, r_import, r_edit, p_mode, hw_cutoff)));
  END LOOP;
  RETURN to_jsonb(acc);
END $$;

-- The end of a stream batch: a task named twice in the file is an error on its later rows (as before), then the batch is written, with its mode and mark.
CREATE OR REPLACE FUNCTION imp_stream_close(p_ctx jsonb, p_results jsonb, p_file_name text, p_sha text, p_group uuid, p_source text, p_sheet text, p_mode text, p_hw jsonb, p_task uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  dup_sites text[]; seen jsonb := '{}'::jsonb; acc jsonb[] := ARRAY[]::jsonb[]; el jsonb; res jsonb; it jsonb; items jsonb; bid uuid; hw_cutoff date := (p_ctx ->> 'hw_cutoff')::date;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- only rows of the same site can name the same task (the task id is the signature); the others keep their items as they are
  SELECT array_agg(s) INTO dup_sites FROM (
    SELECT e -> 'res' ->> 'site_id' AS s FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e WHERE e -> 'res' ->> 'site_id' IS NOT NULL GROUP BY 1 HAVING count(*) > 1) g;
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x LOOP
    IF dup_sites IS NOT NULL AND (el -> 'res' ->> 'site_id') = ANY (dup_sites) THEN
      res := el -> 'res';
      items := '[]'::jsonb;
      FOR it IN SELECT x FROM jsonb_array_elements(coalesce(res -> 'items', '[]'::jsonb)) x LOOP
        IF it ->> 'sig' IS NOT NULL THEN
          IF seen ? (it ->> 'sig') THEN
            it := it || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
              'errors', coalesce(it -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'duplicate_in_file',
                'message', 'Row ' || (seen ->> (it ->> 'sig')) || ' of this file is the same task of the same site.')));
          ELSE
            seen := seen || jsonb_build_object(it ->> 'sig', el ->> 'row_no');
          END IF;
        END IF;
        items := items || jsonb_build_array(it);
      END LOOP;
      el := el || jsonb_build_object('res', res || jsonb_build_object('items', items));
    END IF;
    acc := array_append(acc, el);
  END LOOP;
  bid := public.imp_insert_task_batch((p_ctx ->> 'version_id')::uuid, p_ctx ->> 'template_id', p_ctx ->> 'stream_code', p_file_name, p_sha, p_group, p_sheet, to_jsonb(acc), p_task,
    (p_ctx ->> 'task_site')::uuid, p_source);
  IF bid IS NOT NULL THEN UPDATE public.import_batches SET mode = p_mode WHERE id = bid; END IF;
  IF bid IS NOT NULL AND hw_cutoff IS NOT NULL THEN PERFORM public.hw_mark_batch(bid, p_hw ->> 'reason', hw_cutoff); END IF;   -- 0073
  RETURN bid;
END $$;

CREATE OR REPLACE FUNCTION public.imp_stage_stream_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_group uuid,
  p_source text, p_sheet text, p_mode text, p_hw jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ctx jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  ctx := public.imp_stream_open(p_template, p_version, p_checksum, p_task, p_mode, p_hw);
  RETURN public.imp_stream_close(ctx, public.imp_stream_eval(ctx, p_rows, p_mode, p_sheet), p_file_name, p_sha, p_group, p_source, p_sheet, p_mode, p_hw, p_task);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1c. A register batch collects its rows in an array (the rest is 0050 unchanged)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.imp_stage_register_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; rd public.register_definitions%ROWTYPE; cols jsonb;
  r_import int[]; r_view int[]; r_create int[]; r_edit int[]; bid uuid := gen_random_uuid(); el jsonb; res jsonb; seen jsonb := '{}'::jsonb; results jsonb; task_site uuid; n_err int := 0; n_rows int := 0;
  regions int[]; acc jsonb[] := ARRAY[]::jsonb[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active;
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  IF d.kind <> 'register' THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'Uploads of this template are not available yet.'));
  END IF;
  SELECT * INTO rd FROM public.register_definitions WHERE register_key = d.register_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'The register of this template is not available.')); END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_view := public.wf_actor_regions(rd.module_key, 'view');
  r_create := public.wf_actor_regions(rd.module_key, 'create');
  r_edit := public.wf_actor_regions(rd.module_key, 'edit');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_view IS NOT NULL AND cardinality(r_view) = 0)
     OR (r_create IS NOT NULL AND cardinality(r_create) = 0 AND r_edit IS NOT NULL AND cardinality(r_edit) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not import into this register.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.site_id INTO task_site FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id);
    IF task_site IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
                   JOIN public.register_task_sources s ON s.task_code = td.code AND s.register_key = d.register_key WHERE ti.id = p_task AND s.is_active) THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'This task does not use this template.'));
    END IF;
  END IF;
  cols := v.columns;

  FOR el IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    res := public.imp_stage_register_row(d.register_key, d.match_keys, cols, el, task_site, d.custom_entity, r_view, r_import, r_create, r_edit);
    IF res ->> 'sig' IS NOT NULL AND res ->> 'action' <> 'error' THEN
      IF seen ? (res ->> 'sig') THEN
        res := res || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
          'errors', coalesce(res -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('code', 'duplicate_in_file', 'message', 'Row ' || (seen ->> (res ->> 'sig')) || ' of this file is the same record.')));
      ELSE seen := seen || jsonb_build_object(res ->> 'sig', el ->> 'row_no'); END IF;
    END IF;
    acc := array_append(acc, jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', 'Data'), 'res', res));   -- 0083: an array, not a growing jsonb
  END LOOP;
  results := to_jsonb(acc);

  SELECT coalesce(array_agg(DISTINCT (t -> 'res' ->> 'region_id')::int) FILTER (WHERE t -> 'res' ->> 'action' <> 'error' AND t -> 'res' ->> 'region_id' IS NOT NULL), ARRAY[]::int[]),
         count(*), count(*) FILTER (WHERE t -> 'res' ->> 'action' = 'error')
    INTO regions, n_rows, n_err FROM jsonb_array_elements(results) t;

  INSERT INTO public.import_batches (id, template_version_id, source, file_name, file_sha256, status, uploaded_by, region_scope, rows_total, rows_error, register_key, task_id, site_id)
  VALUES (bid, v.id, 'template', left(p_file_name, 200), p_sha, 'validated', actor, regions, n_rows, n_err, d.register_key, p_task, task_site);
  INSERT INTO public.import_batch_rows (batch_id, row_no, sheet, site_code, region_id, target_entity, target_id, action, payload, diff, errors, decision, row_key, site_id, record_type,
    matched_entity_id, base_record_id, hold_reason)
  SELECT bid, (t ->> 'row_no')::int, t ->> 'sheet', t -> 'res' ->> 'site_code', (t -> 'res' ->> 'region_id')::int, d.register_key, (t -> 'res' ->> 'matched_entity_id')::uuid, t -> 'res' ->> 'action',
         t -> 'res' -> 'payload', t -> 'res' -> 'diff', t -> 'res' -> 'errors', t -> 'res' ->> 'decision', t -> 'res' ->> 'key', (t -> 'res' ->> 'site_id')::uuid, t -> 'res' ->> 'record_type',
         (t -> 'res' ->> 'matched_entity_id')::uuid, (t -> 'res' ->> 'base_record_id')::uuid, t -> 'res' ->> 'hold_reason'
  FROM jsonb_array_elements(results) t ORDER BY (t ->> 'row_no')::int;

  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, after, actor_id)
  VALUES ('import_batch_create', 'import_batch', bid::text, NULL,
          jsonb_build_object('template_id', p_template, 'template_version', v.version, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'rows', n_rows, 'errors', n_err,
            'create', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'create'),
            'update', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'update'),
            'unchanged', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'unchanged')), actor);
  RETURN bid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1d. One-template uploads (imp_stage_batch): the checks, the dispatch, the old-version note
-- ---------------------------------------------------------------------------------------------------------------------
-- The checks imp_stage_batch made before it dispatched (same order, same refusals). The answer: the kind of the template, the version and header checksum
-- the file is read under, and the old version of the file (NULL when current).
CREATE OR REPLACE FUNCTION imp_batch_plan(p_template text, p_version integer, p_checksum text, p_task uuid, p_mode text, p_hw jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.template_definitions%ROWTYPE; cur public.template_versions%ROWTYPE; o public.template_versions%ROWTYPE; compat jsonb; ver int := p_version; cs text := p_checksum; file_v int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF coalesce(p_mode, 'submit') NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active;
  IF FOUND THEN
    SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
    IF p_version <> cur.version THEN
      compat := public.tpl_version_compat(p_template, p_version);
      IF compat IS NULL THEN
        PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file names version ' || p_version || ' of ' || p_template || ', which is not an issued version. Download the template again.'));
      END IF;
      IF NOT (compat ->> 'compatible')::boolean THEN PERFORM public.tpl_refuse_outdated(compat); END IF;
      SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
      IF p_checksum IS NOT NULL AND o.header_checksum <> p_checksum THEN
        PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
      END IF;
      ver := cur.version; cs := CASE WHEN p_checksum IS NULL THEN NULL ELSE cur.header_checksum END; file_v := p_version;
    END IF;
    IF coalesce(p_mode, 'submit') = 'draft' AND d.kind <> 'stream' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid',
        'message', 'Save Draft / Planning is for the Site Register stream templates and the Master sheet; a register file and a New sites file are always submitted.'))));
    END IF;
  END IF;
  IF p_hw IS NOT NULL AND d.kind IS DISTINCT FROM 'stream' THEN   -- 0073 (Q462)
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load_reason', 'code', 'invalid',
      'message', 'Accepting without documents is for the Site Register stream templates only.'))));
  END IF;
  IF d.kind = 'sites' AND p_task IS NOT NULL THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'The New sites template is not used from a task.'));
  END IF;
  RETURN jsonb_build_object('kind', CASE WHEN d.kind = 'stream' THEN 'stream' WHEN d.kind = 'sites' THEN 'sites' ELSE 'register' END, 'version', ver, 'checksum', cs, 'file_v', file_v,
    'other_changes', CASE WHEN compat IS NOT NULL THEN jsonb_array_length(compat -> 'other_changes') END);
END $$;

-- After the batch of a file of an older version: the version of the file and its audit row (as imp_stage_batch wrote them).
CREATE OR REPLACE FUNCTION imp_batch_post(p_batch uuid, p_template text, p_plan jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_batch IS NOT NULL AND (p_plan ->> 'file_v') IS NOT NULL THEN
    UPDATE public.import_batches SET file_template_version = (p_plan ->> 'file_v')::int WHERE id = p_batch;
    PERFORM public.log_audit_write('template.old_version_accepted', 'import_batch', p_batch::text, NULL,
      jsonb_build_object('template_id', p_template, 'file_version', (p_plan ->> 'file_v')::int, 'current_version', (p_plan ->> 'version')::int, 'other_changes', (p_plan ->> 'other_changes')::int), NULL);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.imp_stage_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_mode text, p_hw jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE plan jsonb; bid uuid; ver int; cs text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  plan := public.imp_batch_plan(p_template, p_version, p_checksum, p_task, p_mode, p_hw);
  ver := (plan ->> 'version')::int; cs := plan ->> 'checksum';
  IF plan ->> 'kind' = 'stream' THEN
    bid := public.imp_stage_stream_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows, NULL, 'template', 'Data', coalesce(p_mode, 'submit'), p_hw);
  ELSIF plan ->> 'kind' = 'sites' THEN
    bid := public.imp_stage_site_batch(p_template, ver, cs, p_file_name, p_sha, p_rows);
  ELSE
    bid := public.imp_stage_register_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows);
  END IF;
  PERFORM public.imp_batch_post(bid, p_template, plan);
  RETURN bid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1e. TPL-MASTER: the plan, one unit, the end
-- ---------------------------------------------------------------------------------------------------------------------
-- The checks of every sheet and the split (as imp_stage_master_core did before its loop). Units, in the order of the old loop:
--   {kind: stream, sheet: Master, ref: <stream>, template_id, version, rows}   one batch per stream of the Master sheet
--   {kind: register, sheet, ref: <register>, template_id, version, checksum, rows}
--   {kind: skip, sheet, ref, reason, detail}                                  a register sheet that is not available, or a draft
CREATE OR REPLACE FUNCTION imp_master_plan(p_template text, p_version integer, p_parts jsonb, p_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; o public.template_versions%ROWTYPE;
  part jsonb; vp jsonb; op jsonb; st record; sd public.template_definitions%ROWTYPE; sv public.template_versions%ROWTYPE; srows jsonb; el jsonb; cells jsonb; pres jsonb; codes text[];
  rd public.template_definitions%ROWTYPE; rv public.template_versions%ROWTYPE; compat jsonb; parts jsonb := '[]'::jsonb; mcols jsonb; k text; val jsonb; res jsonb; site uuid; cand jsonb;
  hdr text; file_v int; units jsonb[] := ARRAY[]::jsonb[]; nrows jsonb[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_mode NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'master';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    compat := public.tpl_version_compat(p_template, p_version);
    IF compat IS NULL THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file names version ' || p_version || ' of ' || p_template || ', which is not an issued version. Download the template again.'));
    END IF;
    IF NOT (compat ->> 'compatible')::boolean THEN PERFORM public.tpl_refuse_outdated(compat); END IF;
    SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
    file_v := p_version;
  ELSE
    o := v;
  END IF;
  -- every sheet of the file keeps the header row as its version issued it; it is then read under the current version
  FOR part IN SELECT x FROM jsonb_array_elements(p_parts) x LOOP
    SELECT x INTO op FROM jsonb_array_elements(o.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    IF op IS NULL OR op ->> 'header_checksum' <> part ->> 'header_checksum' THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch',
        'detail', 'The header row of the sheet "' || left(part ->> 'sheet', 40) || '" was changed. Use the template as it was issued.'));
    END IF;
    SELECT x INTO vp FROM jsonb_array_elements(v.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    CONTINUE WHEN vp IS NULL;   -- a sheet the current version no longer has holds no typed column (the compatibility check said so)
    parts := parts || jsonb_build_array(part || jsonb_build_object('header_checksum', vp ->> 'header_checksum'));
  END LOOP;

  FOR part IN SELECT x FROM jsonb_array_elements(parts) x LOOP
    SELECT x INTO vp FROM jsonb_array_elements(v.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    IF vp ->> 'kind' = 'master' THEN
      -- Q205: a shared Master column (mx:<letter>) becomes the column of the one task it fills on the row's site
      mcols := vp -> 'columns';
      nrows := ARRAY[]::jsonb[];
      FOR el IN SELECT x FROM jsonb_array_elements(coalesce(part -> 'rows', '[]'::jsonb)) x LOOP
        cells := coalesce(el -> 'cells', '{}'::jsonb); pres := coalesce(el -> 'pre_errors', '[]'::jsonb);
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(cells) kk WHERE kk LIKE 'mx:%') OR EXISTS (SELECT 1 FROM jsonb_array_elements(pres) x WHERE x ->> 'field' LIKE 'mx:%') THEN
          SELECT x.id INTO site FROM public.sites x WHERE upper(x.site_code) = upper(btrim(coalesce(el ->> 'site_code', ''))) AND public.app_region_check(x.region_id);
          FOR k, val IN SELECT * FROM jsonb_each(cells) LOOP
            CONTINUE WHEN k NOT LIKE 'mx:%';
            cells := cells - k;
            SELECT x INTO cand FROM jsonb_array_elements(mcols) x WHERE x ->> 'code' = k LIMIT 1;
            CONTINUE WHEN cand IS NULL OR coalesce((cand ->> 'derived')::boolean, false);
            hdr := cand ->> 'header';
            res := CASE WHEN site IS NULL THEN jsonb_build_object('status', 'none', 'candidates', '[]'::jsonb) ELSE public.tpl_master_candidates(site, substr(k, 4)) END;
            IF res ->> 'status' IN ('single', 'direct') AND jsonb_array_length(res -> 'candidates') = 1 THEN
              cells := cells || jsonb_build_object((res -> 'candidates' -> 0 ->> 'task') || ':' || (res -> 'candidates' -> 0 ->> 'field'), val);
            ELSIF res ->> 'status' = 'projection' THEN
              CONTINUE;   -- several tasks fill it: the Master value is their projection, shown, never read
            ELSIF res ->> 'status' = 'ambiguous' THEN
              pres := pres || jsonb_build_array(jsonb_build_object('column', hdr, 'field', (res -> 'candidates' -> 0 ->> 'task') || ':' || (res -> 'candidates' -> 0 ->> 'field'),
                'code', 'ambiguous_mapping', 'message', 'This Master column fills more than one task of the site (' ||
                  (SELECT string_agg(x ->> 'task', ', ') FROM jsonb_array_elements(res -> 'candidates') x) ||
                  ') and has no documented projection: the row is refused (Q205). Use the stream template, which has a column per task.'));
            ELSE
              -- no task of the column applies on the site: the first one answers why (not on the site, N/A)
              cells := cells || jsonb_build_object((cand -> 'candidates' -> 0 ->> 'task') || ':' || (cand -> 'candidates' -> 0 ->> 'field'), val);
            END IF;
          END LOOP;
          SELECT coalesce(jsonb_agg(CASE WHEN x ->> 'field' LIKE 'mx:%'
                   THEN x || jsonb_build_object('field', coalesce((SELECT (c -> 'candidates' -> 0 ->> 'task') || ':' || (c -> 'candidates' -> 0 ->> 'field') FROM jsonb_array_elements(mcols) c WHERE c ->> 'code' = x ->> 'field' LIMIT 1), x ->> 'field'))
                   ELSE x END), '[]'::jsonb) INTO pres FROM jsonb_array_elements(pres) x;
        END IF;
        nrows := array_append(nrows, el || jsonb_build_object('cells', cells, 'pre_errors', pres));   -- 0083: an array, not a growing jsonb
      END LOOP;

      FOR st IN SELECT s.code, s.sort_order FROM public.workflow_streams s WHERE s.workflow_id = public.tpl_active_workflow() ORDER BY s.sort_order LOOP
        SELECT * INTO sd FROM public.template_definitions x WHERE x.kind = 'stream' AND x.stream_code = st.code AND x.is_active;
        CONTINUE WHEN NOT FOUND;
        SELECT * INTO sv FROM public.template_versions x WHERE x.template_def_id = sd.id AND x.is_current;
        SELECT array_agg(c ->> 'code') INTO codes FROM jsonb_array_elements(sv.columns) c WHERE c ->> 'kind' = 'task';
        -- 0083: one statement per stream (same rows, same order) instead of a growing jsonb
        SELECT coalesce(jsonb_agg(jsonb_build_object('row_no', r.el -> 'row_no', 'sheet', 'Master', 'site_code', r.el ->> 'site_code', 'cells', r.cells, 'pre_errors', r.pres) ORDER BY r.n), '[]'::jsonb)
          INTO srows
        FROM (
          SELECT u.el, u.n,
                 (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(coalesce(u.el -> 'cells', '{}'::jsonb)) e WHERE e.key = ANY (codes)) AS cells,
                 (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(coalesce(u.el -> 'pre_errors', '[]'::jsonb)) x WHERE x ->> 'field' = ANY (codes)) AS pres
          FROM unnest(nrows) WITH ORDINALITY AS u(el, n)) r
        WHERE NOT (r.cells = '{}'::jsonb AND r.pres = '[]'::jsonb);
        CONTINUE WHEN jsonb_array_length(srows) = 0;
        units := array_append(units, jsonb_build_object('kind', 'stream', 'sheet', 'Master', 'ref', st.code, 'template_id', sd.template_id, 'version', sv.version, 'rows', srows));
      END LOOP;
    ELSE
      SELECT * INTO rd FROM public.template_definitions x WHERE x.kind = 'register' AND x.register_key = vp ->> 'ref' AND x.is_active;
      IF NOT FOUND THEN
        units := array_append(units, jsonb_build_object('kind', 'skip', 'sheet', part ->> 'sheet', 'ref', vp ->> 'ref', 'reason', 'template_unknown_or_inactive',
          'detail', 'The register of this sheet is not available.'));
        CONTINUE;
      END IF;
      IF p_mode = 'draft' THEN
        units := array_append(units, jsonb_build_object('kind', 'skip', 'sheet', part ->> 'sheet', 'ref', rd.register_key, 'reason', 'draft_not_for_registers',
          'detail', 'Save Draft / Planning is for the Master sheet only: a register sheet is always submitted. Upload it again with Submit for Review.'));
        CONTINUE;
      END IF;
      SELECT * INTO rv FROM public.template_versions x WHERE x.template_def_id = rd.id AND x.is_current;
      units := array_append(units, jsonb_build_object('kind', 'register', 'sheet', part ->> 'sheet', 'ref', rd.register_key, 'template_id', rd.template_id, 'version', rv.version,
        'checksum', rv.header_checksum, 'rows', coalesce(part -> 'rows', '[]'::jsonb)));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('version', v.version, 'file_v', file_v, 'units', to_jsonb(units));
END $$;

-- One unit of a Master file: its batch ({batch: ...}) or why it was skipped ({skipped: ...}), as the loop of imp_stage_master_core recorded them.
CREATE OR REPLACE FUNCTION imp_master_unit(p_unit jsonb, p_file_name text, p_sha text, p_mode text, p_source text, p_group uuid, p_hw jsonb, p_file_v integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bid uuid; j jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_unit ->> 'kind' = 'skip' THEN
    RETURN jsonb_build_object('skipped', jsonb_build_object('sheet', p_unit ->> 'sheet', 'kind', 'register', 'ref', p_unit ->> 'ref', 'reason', p_unit ->> 'reason', 'detail', p_unit ->> 'detail'));
  ELSIF p_unit ->> 'kind' = 'stream' THEN
    BEGIN
      bid := public.imp_stage_stream_batch(p_unit ->> 'template_id', (p_unit ->> 'version')::int, NULL, p_file_name, p_sha, NULL, p_unit -> 'rows', p_group, p_source, 'Master', p_mode, p_hw);
      IF bid IS NULL THEN RETURN '{}'::jsonb; END IF;
      UPDATE public.import_batches SET file_template_version = p_file_v WHERE id = bid AND p_file_v IS NOT NULL;
      RETURN jsonb_build_object('batch', jsonb_build_object('id', bid, 'sheet', 'Master', 'kind', 'stream', 'ref', p_unit ->> 'ref', 'template_id', p_unit ->> 'template_id'));
    EXCEPTION WHEN others THEN
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
      RETURN jsonb_build_object('skipped', jsonb_build_object('sheet', 'Master', 'kind', 'stream', 'ref', p_unit ->> 'ref', 'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
    END;
  ELSE
    BEGIN
      bid := public.imp_stage_register_batch(p_unit ->> 'template_id', (p_unit ->> 'version')::int, p_unit ->> 'checksum', p_file_name, p_sha, NULL, p_unit -> 'rows');
      UPDATE public.import_batches SET source = p_source, group_id = p_group, part_sheet = p_unit ->> 'sheet', file_template_version = p_file_v WHERE id = bid;
      UPDATE public.import_batch_rows SET source_ref = (p_unit ->> 'sheet') || '!' || row_no::text, ord = row_no WHERE batch_id = bid;
      RETURN jsonb_build_object('batch', jsonb_build_object('id', bid, 'sheet', p_unit ->> 'sheet', 'kind', 'register', 'ref', p_unit ->> 'ref', 'template_id', p_unit ->> 'template_id'));
    EXCEPTION WHEN others THEN
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
      RETURN jsonb_build_object('skipped', jsonb_build_object('sheet', p_unit ->> 'sheet', 'kind', 'register', 'ref', p_unit ->> 'ref', 'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
    END;
  END IF;
END $$;

-- The end of a Master file: refused when no part could be staged and some were refused; otherwise the audit row of the group (as before).
CREATE OR REPLACE FUNCTION imp_master_finish(p_template text, p_version integer, p_file_v integer, p_mode text, p_source text, p_file_name text, p_sha text, p_group uuid,
  p_batches jsonb, p_skipped jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF jsonb_array_length(p_batches) = 0 AND jsonb_array_length(p_skipped) > 0 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', coalesce(p_skipped -> 0 ->> 'reason', 'import_not_allowed'),
      'detail', coalesce(p_skipped -> 0 ->> 'detail', 'You may not import any part of this file.')));
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES (CASE WHEN p_source = 'master_import' THEN 'import_master_legacy_stage' ELSE 'import_master_upload' END, 'import_group', p_group::text,
          jsonb_build_object('template_id', p_template, 'template_version', p_version, 'file_version', p_file_v, 'mode', p_mode, 'source', p_source, 'file_name', left(p_file_name, 200),
            'file_sha256', p_sha, 'batches', p_batches, 'skipped', p_skipped), actor);
  RETURN jsonb_build_object('group_id', p_group, 'batches', p_batches, 'skipped', p_skipped, 'file_version', p_file_v);
END $$;

CREATE OR REPLACE FUNCTION public.imp_stage_master_core(p_template text, p_version integer, p_file_name text, p_sha text, p_parts jsonb, p_mode text, p_source text, p_group uuid, p_hw jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE plan jsonb; u jsonb; r jsonb; gid uuid := coalesce(p_group, gen_random_uuid()); batches jsonb[] := ARRAY[]::jsonb[]; skipped jsonb[] := ARRAY[]::jsonb[]; file_v int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  plan := public.imp_master_plan(p_template, p_version, p_parts, p_mode);
  file_v := (plan ->> 'file_v')::int;
  FOR u IN SELECT x FROM jsonb_array_elements(plan -> 'units') x LOOP
    r := public.imp_master_unit(u, p_file_name, p_sha, p_mode, p_source, gid, p_hw, file_v);
    IF r ? 'batch' THEN batches := array_append(batches, r -> 'batch'); END IF;
    IF r ? 'skipped' THEN skipped := array_append(skipped, r -> 'skipped'); END IF;
  END LOOP;
  RETURN public.imp_master_finish(p_template, (plan ->> 'version')::int, file_v, p_mode, p_source, p_file_name, p_sha, gid, to_jsonb(batches), to_jsonb(skipped));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Uploads staged in the background
-- ---------------------------------------------------------------------------------------------------------------------
-- One row per upload staged in the background. Written only by the imp_upload_* functions (owner pmis_definer); the application role has no right on it,
-- so the parsed rows of the file (`units`, cleared when the run ends) are never readable by anybody through the API or a direct query. `units` is the plan:
-- one unit per batch to stage ({kind: single | stream | register | skip, ...}); `pos` the units done, `row_pos` the rows of the current stream unit done
-- and `partial` their results (a stream unit is read in chunks of rows, then written as one batch).
CREATE TABLE import_uploads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        uuid NOT NULL REFERENCES users (id),
  session_id      uuid,
  auth_method     text,
  mfa             boolean,
  request_id      text,
  stepup_until    timestamptz,
  kind            text NOT NULL CHECK (kind IN ('single', 'master', 'legacy')),
  template_id     text,
  template_version integer,
  run_id          uuid REFERENCES master_reconciliation_runs (id),
  file_template_version integer,
  file_name       text NOT NULL CHECK (char_length(file_name) <= 200),
  file_sha256     text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  mode            text NOT NULL CHECK (mode IN ('submit', 'draft')),
  task_id         uuid,
  hw_reason       text CHECK (hw_reason IS NULL OR char_length(hw_reason) <= 2000),
  register_key    text,
  stream_code     text,
  entity          text,
  units           jsonb,
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  state           text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  pos             integer NOT NULL DEFAULT 0,
  row_pos         integer NOT NULL DEFAULT 0,
  partial         jsonb,
  ctx             jsonb,
  units_total     integer NOT NULL CHECK (units_total >= 0),
  file_rows       integer NOT NULL CHECK (file_rows >= 0),
  unit_rows_total integer NOT NULL CHECK (unit_rows_total >= 0),
  unit_rows_done  integer NOT NULL DEFAULT 0,
  batches         jsonb NOT NULL DEFAULT '[]'::jsonb,
  skipped         jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code      text,
  error_reason    text,
  error           text,
  chunks          integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz,
  CHECK (kind = 'legacy' OR (template_id IS NOT NULL AND template_version IS NOT NULL)),
  CHECK (kind <> 'legacy' OR run_id IS NOT NULL)
);
CREATE UNIQUE INDEX import_uploads_one_running ON import_uploads (actor_id, file_sha256) WHERE state = 'running';
CREATE INDEX import_uploads_actor ON import_uploads (actor_id, created_at DESC);
COMMENT ON TABLE import_uploads IS '0083: a template upload staged in the background (status parsing). Written only by imp_upload_*; no right for pmis_app; the parsed rows are cleared at the end.';
ALTER TABLE import_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_uploads FORCE ROW LEVEL SECURITY;   -- no policy: only the definer functions (pmis_definer bypasses row security) read it
REVOKE ALL ON import_uploads FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON import_uploads TO pmis_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON import_uploads FROM pmis_app; END IF;
END $$;

-- The rows of a stream unit read in one transaction of the background run.
CREATE OR REPLACE FUNCTION imp_upload_chunk_rows(p_chunk integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT CASE WHEN p_chunk IS NULL OR p_chunk < 1 THEN 100 ELSE least(p_chunk, 2000) END $$;

-- The upload as its uploader sees it (NULL for anybody else, and without a signed-in person). Never the parsed rows.
CREATE OR REPLACE FUNCTION imp_upload_json(p_upload uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('upload_id', u.id, 'kind', u.kind, 'state', u.state, 'template_id', u.template_id, 'template_version', u.template_version,
           'file_template_version', u.file_template_version, 'file_name', u.file_name, 'mode', u.mode, 'task_id', u.task_id, 'historical_load', u.hw_reason IS NOT NULL,
           'register_key', u.register_key, 'stream', u.stream_code, 'entity', u.entity, 'uploaded_by', u.actor_id, 'uploaded_at', u.created_at,
           'group_id', CASE WHEN u.kind = 'master' THEN u.id END, 'warnings', u.warnings, 'batches', u.batches, 'skipped', u.skipped,
           'error', CASE WHEN u.error_code IS NOT NULL OR u.error IS NOT NULL THEN jsonb_build_object('code', u.error_code, 'reason', u.error_reason, 'detail', u.error) END,
           'progress', jsonb_build_object('kind', 'upload', 'state', u.state, 'parts_total', u.units_total, 'parts_done', u.pos,
             'rows_total', u.file_rows,
             'rows_done', CASE WHEN u.state = 'done' THEN u.file_rows WHEN u.unit_rows_total = 0 THEN 0 ELSE floor(u.file_rows::numeric * u.unit_rows_done / u.unit_rows_total)::int END,
             'percent', CASE WHEN u.state = 'done' THEN 100 WHEN u.unit_rows_total = 0 THEN 0 ELSE floor(100.0 * u.unit_rows_done / u.unit_rows_total)::int END,
             'chunks', u.chunks, 'started_at', u.created_at, 'updated_at', u.heartbeat_at, 'finished_at', u.finished_at,
             'error', u.error))
  FROM public.import_uploads u
  WHERE u.id = p_upload AND public.app_actor() IS NOT NULL AND u.actor_id = public.app_actor()
$$;

-- The caller's uploads still being staged (the list of batches shows them first, in status parsing).
CREATE OR REPLACE FUNCTION imp_uploads_running_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(public.imp_upload_json(u.id) ORDER BY u.created_at DESC), '[]'::jsonb)
  FROM public.import_uploads u WHERE public.app_actor() IS NOT NULL AND u.actor_id = public.app_actor() AND u.state = 'running'
$$;

-- Records the background staging of an upload. Every check the staging makes before its rows runs now (and is rolled back), so a file the person may not
-- import is refused by the request, as before; the rows themselves are read by imp_upload_step. p_parts: the parsed rows of a one-template file (an array
-- of rows) or the parts of a TPL-MASTER file (as imp_stage_master takes them). p_file_rows: the data rows of the file (for the progress).
CREATE OR REPLACE FUNCTION imp_upload_start(p_template text, p_version integer, p_checksum text, p_kind text, p_file_name text, p_sha text, p_task uuid, p_mode text,
  p_hw_reason text, p_parts jsonb, p_warnings jsonb, p_file_rows integer, p_stepup_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); prev uuid; plan jsonb; units jsonb; u jsonb; hw jsonb; mode text := coalesce(p_mode, 'submit'); n_units int; n_rows int; refusals jsonb := '[]'::jsonb;
  j jsonb; uid uuid := gen_random_uuid(); d public.template_definitions%ROWTYPE; ok int := 0;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind NOT IN ('single', 'master') THEN RAISE EXCEPTION 'imp_upload_start: kind is single or master' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF p_parts IS NULL OR jsonb_typeof(p_parts) <> 'array' THEN RAISE EXCEPTION 'imp_upload_start: the parts are an array' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'imp_upload_start: the file hash is a sha256' USING ERRCODE = 'invalid_parameter_value'; END IF;
  -- the same file of the same person is staged once at a time
  SELECT x.id INTO prev FROM public.import_uploads x WHERE x.actor_id = actor AND x.file_sha256 = p_sha AND x.state = 'running' LIMIT 1;
  IF prev IS NOT NULL THEN
    PERFORM public.wf_err('upload_processing', jsonb_build_object('detail', 'This file is already being checked. Wait until it ends, then open its batches.', 'upload_id', prev));
  END IF;
  IF p_hw_reason IS NOT NULL THEN hw := jsonb_build_object('reason', btrim(p_hw_reason)); END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;

  IF p_kind = 'master' THEN
    IF hw IS NOT NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load_reason', 'code', 'invalid',
        'message', 'Accepting without documents is for the Site Register stream templates and the Master import of the System Admin, not for a TPL-MASTER file.'))));
    END IF;
    plan := public.imp_master_plan(p_template, p_version, p_parts, mode);
    units := plan -> 'units';
    -- every unit's own checks now (rolled back): a file of which no part may be imported is refused by the request, as the synchronous upload refuses it
    FOR u IN SELECT x FROM jsonb_array_elements(units) x LOOP
      IF u ->> 'kind' = 'skip' THEN
        refusals := refusals || jsonb_build_array(jsonb_build_object('reason', u ->> 'reason', 'detail', u ->> 'detail'));
        CONTINUE;
      END IF;
      BEGIN
        IF u ->> 'kind' = 'stream' THEN
          PERFORM public.imp_stream_open(u ->> 'template_id', (u ->> 'version')::int, NULL, NULL, mode, NULL);
        ELSE
          PERFORM public.imp_stage_register_batch(u ->> 'template_id', (u ->> 'version')::int, u ->> 'checksum', p_file_name, p_sha, NULL, '[]'::jsonb);
        END IF;
        RAISE EXCEPTION 'imp:probe_done';
      EXCEPTION WHEN others THEN
        IF SQLERRM = 'imp:probe_done' THEN ok := ok + 1;
        ELSE
          j := public.imp_wf_json(SQLERRM);
          IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
          refusals := refusals || jsonb_build_array(jsonb_build_object('reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
        END IF;
      END;
    END LOOP;
    IF ok = 0 AND jsonb_array_length(refusals) > 0 THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', coalesce(refusals -> 0 ->> 'reason', 'import_not_allowed'),
        'detail', coalesce(refusals -> 0 ->> 'detail', 'You may not import any part of this file.')));
    END IF;
    IF jsonb_array_length(units) = 0 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'empty',
        'message', 'No cell of the file can be entered: the values are in columns GSDN Workspace does not read.'))));
    END IF;
  ELSE
    plan := public.imp_batch_plan(p_template, p_version, p_checksum, p_task, mode, hw);
    -- the checks of the batch before its rows (a stream template: imp_stream_open writes nothing; a register or New sites file: a staging of no row, rolled back)
    IF plan ->> 'kind' = 'stream' THEN
      PERFORM public.imp_stream_open(p_template, (plan ->> 'version')::int, plan ->> 'checksum', p_task, mode, hw);
    ELSE
      BEGIN
        IF plan ->> 'kind' = 'sites' THEN
          PERFORM public.imp_stage_site_batch(p_template, (plan ->> 'version')::int, plan ->> 'checksum', p_file_name, p_sha, '[]'::jsonb);
        ELSE
          PERFORM public.imp_stage_register_batch(p_template, (plan ->> 'version')::int, plan ->> 'checksum', p_file_name, p_sha, p_task, '[]'::jsonb);
        END IF;
        RAISE EXCEPTION 'imp:probe_done';
      EXCEPTION WHEN others THEN
        IF SQLERRM <> 'imp:probe_done' THEN RAISE; END IF;
      END;
    END IF;
    units := jsonb_build_array(jsonb_build_object('kind', 'single', 'batch_kind', plan ->> 'kind', 'plan', plan, 'rows', p_parts));
  END IF;

  SELECT count(*), coalesce(sum(jsonb_array_length(coalesce(x -> 'rows', '[]'::jsonb))), 0) INTO n_units, n_rows FROM jsonb_array_elements(units) x;
  INSERT INTO public.import_uploads (id, actor_id, session_id, auth_method, mfa, request_id, stepup_until, kind, template_id, template_version, file_template_version, file_name,
    file_sha256, mode, task_id, hw_reason, register_key, stream_code, entity, units, warnings, units_total, file_rows, unit_rows_total)
  VALUES (uid, actor,
          CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
          public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64),
          CASE WHEN coalesce(public.app_ctx_stepup(), false) THEN p_stepup_until END,
          p_kind, p_template, coalesce((plan ->> 'version')::int, p_version), (plan ->> 'file_v')::int, left(p_file_name, 200), p_sha, mode, p_task, hw ->> 'reason',
          CASE WHEN p_kind = 'single' AND d.kind = 'register' THEN d.register_key END, CASE WHEN p_kind = 'single' AND d.kind = 'stream' THEN d.stream_code END,
          CASE WHEN p_kind = 'single' AND d.kind = 'sites' THEN 'site' END,
          units, coalesce(p_warnings, '[]'::jsonb), n_units, greatest(coalesce(p_file_rows, 0), 0), n_rows);
  PERFORM public.log_audit_write('import_upload_parsing', 'import_upload', uid::text, NULL,
    jsonb_build_object('template_id', p_template, 'template_version', coalesce((plan ->> 'version')::int, p_version), 'kind', p_kind, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha,
      'mode', mode, 'rows', p_file_rows, 'parts', n_units, 'historical_load', hw IS NOT NULL), NULL);
  RETURN public.imp_upload_json(uid);
END $$;

-- Ends a run: the audit row of a Master group (imp_master_finish), the state, and the parsed rows are cleared.
CREATE OR REPLACE FUNCTION imp_upload_close(p_upload uuid, p_state text, p_code text, p_reason text, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE u public.import_uploads%ROWTYPE; st text := p_state; code text := p_code; reason text := p_reason; err text := p_error; j jsonb;
BEGIN
  SELECT * INTO u FROM public.import_uploads WHERE id = p_upload FOR UPDATE;
  IF NOT FOUND OR u.state <> 'running' THEN RETURN; END IF;
  IF st = 'done' AND u.kind = 'master' THEN
    IF jsonb_array_length(u.batches) = 0 AND jsonb_array_length(u.skipped) = 0 THEN
      st := 'failed'; code := 'empty'; err := 'No cell of the file can be entered: the values are in columns GSDN Workspace does not read.';
    ELSIF public.app_actor() IS NOT NULL THEN
      BEGIN
        PERFORM public.imp_master_finish(u.template_id, u.template_version, u.file_template_version, u.mode, 'master_template', u.file_name, u.file_sha256, u.id, u.batches, u.skipped);
      EXCEPTION WHEN others THEN
        j := public.imp_wf_json(SQLERRM);
        IF j IS NULL THEN RAISE; END IF;
        st := 'failed'; code := j ->> 'code'; reason := j -> 'extra' ->> 'reason'; err := j -> 'extra' ->> 'detail';
      END;
    END IF;
  END IF;
  UPDATE public.import_uploads SET state = st, error_code = left(code, 60), error_reason = left(reason, 60), error = left(err, 2000), units = NULL, partial = NULL, ctx = NULL,
    finished_at = clock_timestamp(), heartbeat_at = clock_timestamp() WHERE id = p_upload;
  IF u.kind = 'legacy' AND st <> 'done' THEN
    -- the legacy preview could not end: the run says so (it can never be applied); the rows compared so far stay readable
    UPDATE public.master_reconciliation_runs SET status = 'failed', summary = summary || jsonb_build_object('error', jsonb_build_object('code', code, 'detail', left(err, 500)))
      WHERE id = u.run_id AND status = 'staging';
  END IF;
  IF st <> 'done' THEN
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('import_upload_failed', 'import_upload', u.id::text, jsonb_build_object('state', 'running'),
            jsonb_build_object('state', st, 'code', code, 'reason', reason, 'template_id', u.template_id, 'file_sha256', u.file_sha256, 'parts_done', u.pos, 'parts_total', u.units_total,
              'batches', u.batches, 'skipped', u.skipped), left(err, 2000), public.app_actor());
    IF code = 'template_rejected' THEN
      PERFORM public.log_system_write('warn', 'template-check', 'template upload rejected: ' || coalesce(reason, 'template_unknown_or_inactive'),
        jsonb_build_object('reason', reason, 'detail', left(err, 500), 'file_name', u.file_name, 'sha256', u.file_sha256, 'template_id', u.template_id, 'upload_id', u.id, 'background', true),
        public.app_actor(), u.request_id);
    END IF;
  END IF;
END $$;

-- One step of the run: the next unit, or the next rows of a stream unit, under the uploader's own signed context. Refusals of the staging are recorded
-- (a skipped part of a Master file; the refusal of a one-batch upload); any other error rolls the step back (the API tries again, then stops the run).
CREATE OR REPLACE FUNCTION imp_upload_step(p_upload uuid, p_chunk integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); u public.import_uploads%ROWTYPE; unit jsonb; n int; chunk int := public.imp_upload_chunk_rows(p_chunk); slice jsonb; res jsonb; r jsonb; bid uuid; j jsonb;
  hw jsonb; sctx jsonb; plan jsonb; tid text; ver int; cs text; kind text; total int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO u FROM public.import_uploads WHERE id = p_upload FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.import_uploads WHERE id = p_upload) THEN RETURN jsonb_build_object('upload_id', p_upload, 'state', 'busy'); END IF;
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The upload does not exist.'));
  END IF;
  IF u.actor_id <> actor THEN
    RAISE EXCEPTION 'only the person who uploaded the file continues its staging' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF u.state <> 'running' THEN RETURN public.imp_upload_json(p_upload) -> 'progress'; END IF;
  IF u.kind = 'legacy' THEN
    -- the legacy Master preview: the next rows (mi_stage_rows), then the end (mi_stage_close) with the last ones
    unit := u.units -> 0;
    total := jsonb_array_length(coalesce(unit -> 'rows', '[]'::jsonb));
    SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb) INTO slice FROM jsonb_array_elements(unit -> 'rows') WITH ORDINALITY AS t(e, o) WHERE o > u.row_pos AND o <= u.row_pos + chunk;
    n := jsonb_array_length(slice);
    BEGIN
      res := public.mi_stage_rows(u.ctx, slice, coalesce(u.ctx -> 'state', '{}'::jsonb));
      IF u.row_pos + n >= total THEN
        PERFORM public.mi_stage_close(u.ctx, res, unit -> 'staff', u.file_name, u.file_sha256, (unit ->> 'size')::bigint, unit ->> 'storage_key');
      END IF;
    EXCEPTION WHEN others THEN
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN RAISE; END IF;
      PERFORM public.imp_upload_close(p_upload, 'failed', j ->> 'code', j -> 'extra' ->> 'reason', coalesce(j -> 'extra' ->> 'detail', public.imp_wf_message(j, 'The comparison failed.')));
      RETURN public.imp_upload_json(p_upload) -> 'progress';
    END;
    UPDATE public.import_uploads SET row_pos = row_pos + n, ctx = ctx || jsonb_build_object('state', res), unit_rows_done = unit_rows_done + n, chunks = chunks + 1,
      pos = CASE WHEN u.row_pos + n >= total THEN 1 ELSE 0 END, heartbeat_at = clock_timestamp() WHERE id = p_upload;
    IF u.row_pos + n >= total THEN PERFORM public.imp_upload_close(p_upload, 'done', NULL, NULL, NULL); END IF;
    RETURN public.imp_upload_json(p_upload) -> 'progress';
  END IF;
  IF u.hw_reason IS NOT NULL THEN hw := jsonb_build_object('reason', u.hw_reason); END IF;
  unit := u.units -> u.pos;
  IF unit IS NULL THEN
    PERFORM public.imp_upload_close(p_upload, 'done', NULL, NULL, NULL);
    RETURN public.imp_upload_json(p_upload) -> 'progress';
  END IF;
  kind := CASE WHEN unit ->> 'kind' = 'single' THEN unit ->> 'batch_kind' ELSE unit ->> 'kind' END;
  total := jsonb_array_length(coalesce(unit -> 'rows', '[]'::jsonb));

  IF kind = 'stream' THEN
    -- a stream unit: its checks with its first rows, then chunks of rows, then the batch (the same functions as imp_stage_stream_batch)
    IF unit ->> 'kind' = 'single' THEN
      plan := unit -> 'plan'; tid := u.template_id; ver := (plan ->> 'version')::int; cs := plan ->> 'checksum';
    ELSE
      tid := unit ->> 'template_id'; ver := (unit ->> 'version')::int; cs := NULL;
    END IF;
    sctx := u.ctx;
    IF sctx IS NULL THEN
      BEGIN
        sctx := public.imp_stream_open(tid, ver, cs, CASE WHEN unit ->> 'kind' = 'single' THEN u.task_id END, u.mode, CASE WHEN unit ->> 'kind' = 'single' THEN hw END);
      EXCEPTION WHEN others THEN
        j := public.imp_wf_json(SQLERRM);
        IF j IS NULL THEN RAISE; END IF;
        IF unit ->> 'kind' = 'stream' AND j ->> 'code' = 'template_rejected' THEN
          UPDATE public.import_uploads SET skipped = skipped || jsonb_build_array(jsonb_build_object('sheet', 'Master', 'kind', 'stream', 'ref', unit ->> 'ref',
              'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail')),
            pos = pos + 1, row_pos = 0, partial = NULL, ctx = NULL, unit_rows_done = unit_rows_done + total, chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_upload;
        ELSIF unit ->> 'kind' = 'single' THEN
          UPDATE public.import_uploads SET unit_rows_done = unit_rows_done + total, chunks = chunks + 1 WHERE id = p_upload;
          PERFORM public.imp_upload_close(p_upload, 'failed', j ->> 'code', j -> 'extra' ->> 'reason', coalesce(j -> 'extra' ->> 'detail', public.imp_wf_message(j, 'The file is not accepted.')));
          RETURN public.imp_upload_json(p_upload) -> 'progress';
        ELSE
          RAISE;
        END IF;
        IF u.pos + 1 >= u.units_total THEN PERFORM public.imp_upload_close(p_upload, 'done', NULL, NULL, NULL); END IF;
        RETURN public.imp_upload_json(p_upload) -> 'progress';
      END;
    END IF;
    SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb) INTO slice FROM jsonb_array_elements(unit -> 'rows') WITH ORDINALITY AS t(e, o) WHERE o > u.row_pos AND o <= u.row_pos + chunk;
    n := jsonb_array_length(slice);
    res := coalesce(u.partial, '[]'::jsonb) || public.imp_stream_eval(sctx, slice, u.mode, CASE WHEN unit ->> 'kind' = 'single' THEN 'Data' ELSE 'Master' END);
    IF u.row_pos + n < total THEN
      UPDATE public.import_uploads SET row_pos = row_pos + n, partial = res, ctx = sctx, unit_rows_done = unit_rows_done + n, chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_upload;
      RETURN public.imp_upload_json(p_upload) -> 'progress';
    END IF;
    IF unit ->> 'kind' = 'single' THEN
      bid := public.imp_stream_close(sctx, res, u.file_name, u.file_sha256, NULL, 'template', 'Data', u.mode, hw, u.task_id);
      PERFORM public.imp_batch_post(bid, u.template_id, plan);
    ELSE
      bid := public.imp_stream_close(sctx, res, u.file_name, u.file_sha256, u.id, 'master_template', 'Master', u.mode, NULL, NULL);
      IF bid IS NOT NULL THEN UPDATE public.import_batches SET file_template_version = u.file_template_version WHERE id = bid AND u.file_template_version IS NOT NULL; END IF;
    END IF;
    IF bid IS NOT NULL THEN
      r := jsonb_build_object('id', bid, 'sheet', CASE WHEN unit ->> 'kind' = 'single' THEN 'Data' ELSE 'Master' END, 'kind', 'stream', 'ref', coalesce(unit ->> 'ref', u.stream_code),
        'template_id', tid);
    END IF;
    UPDATE public.import_uploads SET batches = CASE WHEN r IS NULL THEN batches ELSE batches || jsonb_build_array(r) END, pos = pos + 1, row_pos = 0, partial = NULL, ctx = NULL,
      unit_rows_done = unit_rows_done + n, chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_upload;
    IF bid IS NULL AND unit ->> 'kind' = 'single' THEN
      PERFORM public.imp_upload_close(p_upload, 'failed', 'empty', NULL, 'No cell of the file can be entered: the values are in columns GSDN Workspace does not read.');
    ELSIF u.pos + 1 >= u.units_total THEN
      PERFORM public.imp_upload_close(p_upload, 'done', NULL, NULL, NULL);
    END IF;
    RETURN public.imp_upload_json(p_upload) -> 'progress';
  END IF;

  -- a register sheet, a skipped sheet of a Master file, or a register or New sites file: one transaction
  IF unit ->> 'kind' = 'single' THEN
    plan := unit -> 'plan';
    BEGIN
      IF kind = 'sites' THEN
        bid := public.imp_stage_site_batch(u.template_id, (plan ->> 'version')::int, plan ->> 'checksum', u.file_name, u.file_sha256, unit -> 'rows');
      ELSE
        bid := public.imp_stage_register_batch(u.template_id, (plan ->> 'version')::int, plan ->> 'checksum', u.file_name, u.file_sha256, u.task_id, unit -> 'rows');
      END IF;
      PERFORM public.imp_batch_post(bid, u.template_id, plan);
    EXCEPTION WHEN others THEN
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN RAISE; END IF;
      UPDATE public.import_uploads SET unit_rows_done = unit_rows_done + total, chunks = chunks + 1 WHERE id = p_upload;
      PERFORM public.imp_upload_close(p_upload, 'failed', j ->> 'code', j -> 'extra' ->> 'reason', coalesce(j -> 'extra' ->> 'detail', public.imp_wf_message(j, 'The file is not accepted.')));
      RETURN public.imp_upload_json(p_upload) -> 'progress';
    END;
    UPDATE public.import_uploads SET batches = batches || jsonb_build_array(jsonb_build_object('id', bid, 'sheet', 'Data', 'kind', kind, 'ref', coalesce(u.register_key, u.entity), 'template_id', u.template_id)),
      pos = pos + 1, unit_rows_done = unit_rows_done + total, chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_upload;
  ELSE
    r := public.imp_master_unit(unit, u.file_name, u.file_sha256, u.mode, 'master_template', u.id, NULL, u.file_template_version);
    UPDATE public.import_uploads SET batches = CASE WHEN r ? 'batch' THEN batches || jsonb_build_array(r -> 'batch') ELSE batches END,
      skipped = CASE WHEN r ? 'skipped' THEN skipped || jsonb_build_array(r -> 'skipped') ELSE skipped END,
      pos = pos + 1, unit_rows_done = unit_rows_done + total, chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_upload;
  END IF;
  IF u.pos + 1 >= u.units_total THEN PERFORM public.imp_upload_close(p_upload, 'done', NULL, NULL, NULL); END IF;
  RETURN public.imp_upload_json(p_upload) -> 'progress';
END $$;

-- The runs left in parsing (a restart of the API, a lost process), for the resume job: only what is needed to sign the person's context again.
CREATE OR REPLACE FUNCTION imp_upload_pending(p_idle integer DEFAULT 0)
RETURNS TABLE (upload_id uuid, actor_id uuid, actor_active boolean, stepup_until timestamptz, session_id uuid, auth_method text, mfa boolean, request_id text, heartbeat_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.actor_id, EXISTS (SELECT 1 FROM public.users x WHERE x.id = u.actor_id AND x.status = 'active' AND x.deleted_at IS NULL),
         u.stepup_until, u.session_id, u.auth_method, u.mfa, u.request_id, u.heartbeat_at
  FROM public.import_uploads u
  WHERE u.state = 'running' AND u.heartbeat_at <= clock_timestamp() - make_interval(secs => greatest(coalesce(p_idle, 0), 0))
  ORDER BY u.created_at
$$;

-- Stops a run: by its uploader (for example after repeated failures of a step), or by the resume job when the uploader can no longer act. The batches
-- staged so far stay (each is a complete batch); the unit that was being staged is recorded as failed.
CREATE OR REPLACE FUNCTION imp_upload_abandon(p_upload uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE u public.import_uploads%ROWTYPE; actor uuid := public.app_actor(); unit jsonb; why text := left(coalesce(nullif(btrim(p_reason), ''), 'stopped'), 500);
BEGIN
  SELECT * INTO u FROM public.import_uploads WHERE id = p_upload FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The upload does not exist.')); END IF;
  IF u.state <> 'running' THEN RETURN jsonb_build_object('upload_id', u.id, 'state', u.state); END IF;
  IF actor IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.users x WHERE x.id = u.actor_id AND x.status = 'active' AND x.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'only the person who uploaded the file stops its staging' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF actor <> u.actor_id THEN
    RAISE EXCEPTION 'only the person who uploaded the file stops its staging' USING ERRCODE = 'insufficient_privilege';
  END IF;
  unit := u.units -> u.pos;
  IF unit IS NOT NULL THEN
    UPDATE public.import_uploads SET skipped = skipped || jsonb_build_array(jsonb_build_object('sheet', coalesce(unit ->> 'sheet', 'Data'), 'kind', coalesce(unit ->> 'batch_kind', unit ->> 'kind'),
      'ref', coalesce(unit ->> 'ref', u.register_key, u.stream_code, u.entity), 'reason', 'part_failed', 'detail', why)) WHERE id = p_upload;
  END IF;
  PERFORM public.imp_upload_close(p_upload, 'failed', 'stopped', NULL, why);
  RETURN jsonb_build_object('upload_id', u.id, 'state', 'failed');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2b. The legacy Master import preview (mi_stage_run, Q1 / Q211): the structure, the rows, the end; in the background for a big file
-- ---------------------------------------------------------------------------------------------------------------------
-- A run being compared in the background shows `staging` (and `failed` when the comparison could not end); only `previewed` can be applied.
ALTER TABLE master_reconciliation_runs DROP CONSTRAINT IF EXISTS master_reconciliation_runs_status_check;
ALTER TABLE master_reconciliation_runs ADD CONSTRAINT master_reconciliation_runs_status_check CHECK (status IN ('previewed', 'applied', 'staging', 'failed'));
-- the "same Site ID twice" check and the "site not in the file" list read the rows of the run by Site ID (they used a growing jsonb object)
CREATE INDEX IF NOT EXISTS master_reconciliation_rows_site_idx ON master_reconciliation_rows (run_id, upper(site_code));

-- 1. identification and structure (unchanged), then the run is written with p_status (previewed in the request, staging in the background).
-- The answer is the context of the rows: the run, the file columns by Master letter, the column metadata.
CREATE OR REPLACE FUNCTION mi_stage_open(p_file_name text, p_sha text, p_size bigint, p_storage_key text, p_sheets jsonb, p_headers jsonb, p_row_count integer, p_status text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); rid uuid := gen_random_uuid(); cols record; fmap jsonb := '{}'::jsonb; missing jsonb := '[]'::jsonb; moved jsonb := '[]'::jsonb;
  extra jsonb := '[]'::jsonb; found int := 0; total int := 0; miss_input jsonb := '[]'::jsonb; h jsonb; cmeta jsonb := '[]'::jsonb;
  v_structure jsonb; expected_sheets jsonb; sheets_missing jsonb; aliased jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  IF p_status NOT IN ('previewed', 'staging') THEN RAISE EXCEPTION 'mi_stage_open: status is previewed or staging' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'invalid', 'message', 'The file hash is missing.'))));
  END IF;
  -- 1. identification: the sheet Master and the Master headers
  IF NOT coalesce(p_sheets ? 'Master', false) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: it has no sheet "Master". Upload the real Master, or a PMIS template through Upload.'));
  END IF;
  FOR cols IN SELECT * FROM public.mi_columns() ORDER BY 1 LOOP
    total := total + 1;
    -- the header as master_columns stores it, or as the three header rows of the Master compose it (group / name: "Identification / Site ID")
    SELECT x INTO h FROM jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) x
      WHERE btrim(x ->> 'header') = cols.header
         OR btrim(x ->> 'header') = (SELECT m.group_mid || ' / ' || m.name FROM public.master_columns m WHERE m.letter = cols.letter AND m.name IS NOT NULL)
         -- G2 (0070): a known renamed header of this column (master_header_aliases), alone or under the group of the column
         OR btrim(x ->> 'header') IN (SELECT m.group_mid || ' / ' || a.alias FROM public.master_columns m JOIN public.master_header_aliases a ON a.letter = m.letter AND a.is_active
                                      WHERE m.letter = cols.letter AND m.group_mid IS NOT NULL)
         OR btrim(x ->> 'header') IN (SELECT a.alias FROM public.master_header_aliases a WHERE a.letter = cols.letter AND a.is_active)
      ORDER BY (btrim(x ->> 'header') = cols.header) DESC LIMIT 1;
    IF h IS NULL THEN
      missing := missing || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'typed', coalesce(cols.typed, false)));
      IF coalesce(cols.typed, false) OR cols.owner = 'key' THEN miss_input := miss_input || jsonb_build_array(cols.header); END IF;
    ELSE
      found := found + 1;
      IF btrim(h ->> 'header') <> cols.header AND btrim(h ->> 'header') IS DISTINCT FROM (SELECT m.group_mid || ' / ' || m.name FROM public.master_columns m WHERE m.letter = cols.letter AND m.name IS NOT NULL) THEN
        aliased := aliased || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'in_file', btrim(h ->> 'header')));
      END IF;
      fmap := fmap || jsonb_build_object(h ->> 'col', cols.letter);
      IF h ->> 'col' <> cols.letter THEN moved := moved || jsonb_build_array(jsonb_build_object('header', cols.header, 'expected', cols.letter, 'found', h ->> 'col')); END IF;
    END IF;
    cmeta := cmeta || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'owner', cols.owner, 'field', cols.field, 'typed', coalesce(cols.typed, false), 'shared', coalesce(cols.shared, false)));
  END LOOP;
  SELECT coalesce(jsonb_agg(x ->> 'header'), '[]'::jsonb) INTO extra FROM jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) x
    WHERE coalesce(btrim(x ->> 'header'), '') <> '' AND NOT EXISTS (SELECT 1 FROM public.master_columns m WHERE m.is_active AND m.header = btrim(x ->> 'header'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(aliased) a WHERE a ->> 'in_file' = btrim(x ->> 'header'));
  SELECT coalesce(jsonb_agg(tp.sheet_name ORDER BY tp.sort_order), '[]'::jsonb) INTO expected_sheets FROM public.template_parts tp WHERE tp.template_id = 'TPL-MASTER';
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO sheets_missing FROM jsonb_array_elements_text(expected_sheets) x WHERE NOT (p_sheets ? x);
  v_structure := jsonb_build_object('identified', NOT (fmap ? '') AND fmap <> '{}'::jsonb AND found * 10 >= total * 9 AND EXISTS (SELECT 1 FROM jsonb_each_text(fmap) e WHERE e.value = 'B'),
    'columns_expected', total, 'columns_found', found, 'aliased', aliased, 'missing', missing, 'moved', moved, 'extra', extra, 'missing_typed', miss_input,
    'sheets', p_sheets, 'register_sheets_missing', sheets_missing, 'has_tpl', p_sheets ? '_tpl');
  IF NOT (v_structure ->> 'identified')::boolean THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: only ' || found || ' of the ' || total ||
      ' Master column headers were found (the Site ID column is required). Upload the real Master as it is, without changing its header rows.'));
  END IF;
  IF jsonb_array_length(miss_input) > 0 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'structure_mismatch', 'detail', 'The Master sheet lacks typed column(s): ' ||
      (SELECT string_agg(x, ', ') FROM (SELECT jsonb_array_elements_text(miss_input) x LIMIT 6) q) || CASE WHEN jsonb_array_length(miss_input) > 6 THEN ' ...' ELSE '' END ||
      '. The file cannot be compared or applied.'));
  END IF;
  IF coalesce(p_row_count, 0) > 5000 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'size_or_rows_exceeded', 'detail', 'The Master sheet has more than 5000 rows.'));
  END IF;
  INSERT INTO public.master_reconciliation_runs (id, file_name, file_sha256, file_size, storage_key, structure, created_by, status)
  VALUES (rid, left(p_file_name, 200), p_sha, p_size, p_storage_key, v_structure, actor, p_status);
  RETURN jsonb_build_object('run_id', rid, 'fmap', fmap, 'cmeta', cmeta, 'moved', jsonb_array_length(moved));
END $$;

-- 2. rows of the file, in order (the same comparison). p_state carries the counters from one chunk to the next; a Site ID already met is read from the rows
-- of the run (the old function kept them in a growing jsonb object). The answer is the new state.
CREATE OR REPLACE FUNCTION mi_stage_rows(p_ctx jsonb, p_rows jsonb, p_state jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  rid uuid := (p_ctx ->> 'run_id')::uuid; fmap jsonb := p_ctx -> 'fmap'; cmeta jsonb := p_ctx -> 'cmeta'; el jsonb; cells jsonb; site public.sites%ROWTYPE;
  scode text; pm jsonb; mv text; pv text; nm text; np text; c jsonb; reason text; kind text; appl boolean; isf boolean; rg int; cst text; dup boolean;
  ord int := coalesce((p_state ->> 'ord')::int, 0); matches int := coalesce((p_state ->> 'matches')::int, 0); compared int := coalesce((p_state ->> 'compared')::int, 0);
  n_rows int := coalesce((p_state ->> 'n_rows')::int, 0); n_sites int := coalesce((p_state ->> 'n_sites')::int, 0); n_unknown int := coalesce((p_state ->> 'n_unknown')::int, 0);
  ignored int := coalesce((p_state ->> 'ignored')::int, 0);
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  -- 2. every row: the cells in Master letters, the site, the comparison with what GSDN Workspace holds
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x LOOP
    -- 0083: the cells in Master letters in one statement (each file column maps to one letter)
    SELECT coalesce(jsonb_object_agg(fmap ->> e.key, e.value), '{}'::jsonb) INTO cells FROM jsonb_each(coalesce(el -> 'cells', '{}'::jsonb)) e WHERE fmap ? e.key;
    scode := nullif(btrim(cells -> 'B' ->> 'v'), '');
    CONTINUE WHEN scode IS NULL;
    n_rows := n_rows + 1;
    SELECT * INTO site FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id);
    dup := EXISTS (SELECT 1 FROM public.master_reconciliation_rows y WHERE y.run_id = rid AND upper(y.site_code) = upper(scode));
    INSERT INTO public.master_reconciliation_rows (run_id, row_no, site_code, site_id, region_id, cells)
    VALUES (rid, (el ->> 'row_no')::int, scode, site.id, site.region_id, cells) ON CONFLICT DO NOTHING;
    IF dup THEN
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, kind, reason)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), scode, site.id, site.region_id, 'B', 'Site ID', 'site', scode, 'exception', 'duplicate_in_file');
      CONTINUE;
    END IF;
    IF site.id IS NULL THEN
      n_unknown := n_unknown + 1; ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, master_col, header, field, master_value, kind, reason)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), scode, 'B', 'Site ID', 'site', scode, 'missing_in_pmis', 'site_not_in_pmis');
      CONTINUE;
    END IF;
    n_sites := n_sites + 1;
    pm := public.mi_pmis_row(site.id);
    FOR c IN SELECT x FROM jsonb_array_elements(cmeta) x LOOP
      CONTINUE WHEN c ->> 'letter' IN ('A', 'B');
      isf := coalesce((cells -> (c ->> 'letter') ->> 'f')::boolean, false);
      mv := cells -> (c ->> 'letter') ->> 'v';
      IF NOT (pm ? (c ->> 'letter')) THEN
        IF mv IS NOT NULL THEN ignored := ignored + 1; END IF;
        CONTINUE;                                                        -- a column GSDN Workspace does not compare (calculated gates, SLA, Dismantle ...)
      END IF;
      pv := pm ->> (c ->> 'letter');
      compared := compared + 1;
      reason := NULL; kind := 'diff'; appl := false;
      IF c ->> 'letter' = 'E' THEN
        IF mv IS NOT NULL THEN
          rg := public.imp_region_resolve(mv);
          IF rg IS NULL THEN kind := 'exception'; reason := 'region_alias_unknown';
          ELSIF rg = site.region_id THEN matches := matches + 1; CONTINUE;
          ELSE reason := 'owned_elsewhere'; END IF;
        ELSE matches := matches + 1; CONTINUE;
        END IF;
      ELSE
        nm := public.mi_norm(mv); np := public.mi_norm(pv);
        cst := CASE WHEN coalesce((c ->> 'shared')::boolean, false) THEN public.tpl_master_candidates(site.id, c ->> 'letter') ->> 'status' END;
        IF cst = 'ambiguous' AND nm IS NULL THEN matches := matches + 1; CONTINUE; END IF;
        IF cst IS DISTINCT FROM 'ambiguous' AND nm IS NOT DISTINCT FROM np THEN matches := matches + 1; CONTINUE; END IF;
        IF cst = 'ambiguous' THEN
          kind := 'exception'; reason := 'ambiguous_mapping';
        ELSIF c ->> 'owner' = 'task' AND coalesce((c ->> 'typed')::boolean, false) THEN
          IF isf THEN kind := 'exception'; reason := 'formula_in_input';
          ELSIF mv IS NULL THEN reason := 'empty_in_master';
          ELSE reason := 'value_differs'; appl := true; END IF;
        ELSIF c ->> 'owner' IN ('task', 'calc') THEN reason := 'calculated';
        ELSIF c ->> 'owner' = 'issues' THEN reason := 'issue_projection';
        ELSE reason := 'owned_elsewhere'; END IF;
      END IF;
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, pmis_value, kind, reason, applicable)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), site.site_code, site.id, site.region_id, c ->> 'letter', c ->> 'header',
              coalesce(c ->> 'field', c ->> 'owner'), left(mv, 1000), left(pv, 1000), kind, reason, appl);
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('ord', ord, 'matches', matches, 'compared', compared, 'n_rows', n_rows, 'n_sites', n_sites, 'n_unknown', n_unknown, 'ignored', ignored);
END $$;

-- 3. and 4. (the same): the sites of the regions the file covers that it does not hold, the Project Staff, the summary, the audit and System Log rows.
CREATE OR REPLACE FUNCTION mi_stage_close(p_ctx jsonb, p_state jsonb, p_staff jsonb, p_file_name text, p_sha text, p_size bigint, p_storage_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); rid uuid := (p_ctx ->> 'run_id')::uuid; site public.sites%ROWTYPE; st jsonb; rr jsonb; regs int[]; v_summary jsonb; staff_mapped int := 0;
  ord int := coalesce((p_state ->> 'ord')::int, 0);
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  -- the regions of the known sites the file holds (a later row of the same site has the same region)
  SELECT coalesce(array_agg(DISTINCT y.region_id), ARRAY[]::int[]) INTO regs FROM public.master_reconciliation_rows y WHERE y.run_id = rid AND y.site_id IS NOT NULL AND y.region_id IS NOT NULL;
  -- 3. the sites of the regions the file covers that the file does not hold
  IF cardinality(regs) > 0 THEN
    FOR site IN SELECT x.* FROM public.sites x WHERE x.is_active AND x.overall_status::text <> 'cancelled' AND x.region_id = ANY (regs) AND public.app_region_check(x.region_id)
                  AND NOT EXISTS (SELECT 1 FROM public.master_reconciliation_rows y WHERE y.run_id = rid AND upper(y.site_code) = upper(x.site_code)) ORDER BY x.site_code LOOP
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, site_code, site_id, region_id, master_col, header, field, pmis_value, kind, reason)
      VALUES (rid, ord, 'Master', site.site_code, site.id, site.region_id, 'B', 'Site ID', 'site', site.site_code, 'missing_in_master', 'site_not_in_master');
    END LOOP;
  END IF;
  -- 4. Q8 / Q10: the Project Staff of the Setting sheet. A mapped role is a suggestion only; nothing is granted.
  FOR st IN SELECT x FROM jsonb_array_elements(coalesce(p_staff, '[]'::jsonb)) x LOOP
    CONTINUE WHEN coalesce(btrim(st ->> 'name'), '') = '' AND coalesce(btrim(st ->> 'role'), '') = '';
    IF coalesce(btrim(st ->> 'role'), '') <> '' THEN
      rr := public.imp_role_resolve(st ->> 'role');
      IF rr ->> 'status' = 'mapped' THEN staff_mapped := staff_mapped + 1;
      ELSE
        ord := ord + 1;
        INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, master_col, header, field, master_value, pmis_value, kind, reason)
        VALUES (rid, ord, 'Setting', (st ->> 'row_no')::int, 'Setting!' || (st ->> 'row_no'), 'J', 'Project Staff / Role', 'role_aliases', left(st ->> 'role', 200), left(st ->> 'name', 200), 'exception',
                CASE rr ->> 'status' WHEN 'ambiguous' THEN 'role_ambiguous' WHEN 'unmapped' THEN 'role_unmapped' ELSE 'role_unknown' END);
      END IF;
    END IF;
    IF coalesce(btrim(st ->> 'region'), '') <> '' AND public.imp_region_resolve(st ->> 'region') IS NULL THEN
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, master_col, header, field, master_value, pmis_value, kind, reason)
      VALUES (rid, ord, 'Setting', (st ->> 'row_no')::int, 'Setting!' || (st ->> 'row_no'), 'K', 'Project Staff / Region', 'region_aliases', left(st ->> 'region', 200), left(st ->> 'name', 200), 'exception', 'region_alias_unknown');
    END IF;
  END LOOP;

  SELECT jsonb_build_object('rows', coalesce((p_state ->> 'n_rows')::int, 0), 'sites_matched', coalesce((p_state ->> 'n_sites')::int, 0), 'sites_unknown', coalesce((p_state ->> 'n_unknown')::int, 0),
    'cells_compared', coalesce((p_state ->> 'compared')::int, 0), 'matches', coalesce((p_state ->> 'matches')::int, 0), 'cells_not_compared', coalesce((p_state ->> 'ignored')::int, 0),
    'diffs', count(*) FILTER (WHERE d.kind = 'diff'), 'missing_in_pmis', count(*) FILTER (WHERE d.kind = 'missing_in_pmis'),
    'missing_in_master', count(*) FILTER (WHERE d.kind = 'missing_in_master'), 'exceptions', count(*) FILTER (WHERE d.kind = 'exception'),
    'applicable', count(*) FILTER (WHERE d.applicable), 'staff_mapped', staff_mapped, 'staff_rows', jsonb_array_length(coalesce(p_staff, '[]'::jsonb)),
    'by_reason', coalesce((SELECT jsonb_object_agg(q.reason, q.n) FROM (SELECT x.reason, count(*) AS n FROM public.master_reconciliation_diffs x WHERE x.run_id = rid GROUP BY x.reason) q), '{}'::jsonb))
    INTO v_summary FROM public.master_reconciliation_diffs d WHERE d.run_id = rid;
  UPDATE public.master_reconciliation_runs SET summary = v_summary, status = 'previewed' WHERE id = rid;
  PERFORM public.log_audit_write('master_import.preview', 'master_reconciliation_run', rid::text, NULL,
    jsonb_build_object('file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'file_size', p_size, 'storage_key', p_storage_key, 'summary', v_summary,
      'structure_moved', (p_ctx ->> 'moved')::int), NULL);
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: previewed',
    jsonb_build_object('run_id', rid, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'rows', coalesce((p_state ->> 'n_rows')::int, 0), 'diffs', v_summary -> 'diffs',
      'exceptions', v_summary -> 'exceptions'), actor, NULL);
END $$;

CREATE OR REPLACE FUNCTION public.mi_stage_run(p_file_name text, p_sha text, p_size bigint, p_storage_key text, p_sheets jsonb, p_headers jsonb, p_rows jsonb, p_staff jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ctx jsonb; state jsonb;
BEGIN
  ctx := public.mi_stage_open(p_file_name, p_sha, p_size, p_storage_key, p_sheets, p_headers, jsonb_array_length(coalesce(p_rows, '[]'::jsonb)), 'previewed');
  state := public.mi_stage_rows(ctx, p_rows, '{}'::jsonb);
  PERFORM public.mi_stage_close(ctx, state, p_staff, p_file_name, p_sha, p_size, p_storage_key);
  RETURN (ctx ->> 'run_id')::uuid;
END $$;

-- A big legacy Master: the identification and structure checks and the run (status staging) now, the rows in the background (imp_upload_step, under the
-- uploader's signed context), the end with the last rows. The same file of the same person is compared once at a time (409 upload_processing).
CREATE OR REPLACE FUNCTION mi_stage_start(p_file_name text, p_sha text, p_size bigint, p_storage_key text, p_sheets jsonb, p_headers jsonb, p_rows jsonb, p_staff jsonb,
  p_stepup_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); ctx jsonb; prev public.import_uploads%ROWTYPE; uid uuid := gen_random_uuid(); n int := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO prev FROM public.import_uploads x WHERE x.actor_id = actor AND x.file_sha256 = p_sha AND x.state = 'running' LIMIT 1;
  IF FOUND THEN
    PERFORM public.wf_err('upload_processing', jsonb_build_object('detail', 'This file is already being compared. Wait until it ends, then open its run.', 'upload_id', prev.id,
      'run_id', prev.run_id));
  END IF;
  ctx := public.mi_stage_open(p_file_name, p_sha, p_size, p_storage_key, p_sheets, p_headers, n, 'staging');
  INSERT INTO public.import_uploads (id, actor_id, session_id, auth_method, mfa, request_id, stepup_until, kind, run_id, file_name, file_sha256, mode, units, ctx,
    units_total, file_rows, unit_rows_total)
  VALUES (uid, actor,
          CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
          public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64),
          CASE WHEN coalesce(public.app_ctx_stepup(), false) THEN p_stepup_until END, 'legacy', (ctx ->> 'run_id')::uuid, left(p_file_name, 200), p_sha, 'submit',
          jsonb_build_array(jsonb_build_object('kind', 'legacy', 'rows', coalesce(p_rows, '[]'::jsonb), 'staff', coalesce(p_staff, '[]'::jsonb), 'size', p_size, 'storage_key', p_storage_key)),
          ctx || jsonb_build_object('state', '{}'::jsonb), 1, n, n);
  PERFORM public.log_audit_write('master_import.staging', 'master_reconciliation_run', ctx ->> 'run_id', NULL,
    jsonb_build_object('file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'file_size', p_size, 'rows', n, 'upload_id', uid), NULL);
  RETURN jsonb_build_object('run_id', ctx ->> 'run_id', 'upload_id', uid);
END $$;

-- The comparison progress of a run compared in the background (any user of the legacy import may read it; never the rows of the file).
CREATE OR REPLACE FUNCTION mi_run_staging_json(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('upload_id', u.id, 'state', u.state, 'rows_total', u.file_rows, 'rows_done', CASE WHEN u.state = 'done' THEN u.file_rows ELSE u.unit_rows_done END,
           'percent', CASE WHEN u.state = 'done' OR u.file_rows = 0 THEN 100 ELSE floor(100.0 * u.unit_rows_done / u.file_rows)::int END,
           'started_at', u.created_at, 'updated_at', u.heartbeat_at, 'finished_at', u.finished_at, 'error', u.error)
  FROM public.import_uploads u
  WHERE u.run_id = p_run AND u.kind = 'legacy' AND public.mi_can_use()
  ORDER BY u.created_at DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON users TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['imp_insert_task_batch', 'imp_int_array', 'imp_stream_open', 'imp_stream_eval', 'imp_stream_close',
             'imp_stage_stream_batch', 'imp_stage_register_batch', 'imp_batch_plan', 'imp_batch_post', 'imp_stage_batch', 'imp_master_plan', 'imp_master_unit',
             'imp_master_finish', 'imp_stage_master_core', 'imp_upload_chunk_rows', 'imp_upload_json', 'imp_uploads_running_json', 'imp_upload_start', 'imp_upload_close',
             'imp_upload_step', 'imp_upload_pending', 'imp_upload_abandon', 'mi_stage_open', 'mi_stage_rows', 'mi_stage_close', 'mi_stage_run', 'mi_stage_start',
             'mi_run_staging_json'])
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      -- imp_stage_batch (both signatures) and mi_stage_run stay the doors of the synchronous uploads, as before
      IF f.proname IN ('imp_upload_start', 'imp_upload_step', 'imp_upload_pending', 'imp_upload_abandon', 'imp_upload_json', 'imp_uploads_running_json', 'imp_stage_batch',
                       'mi_stage_run', 'mi_stage_start', 'mi_run_staging_json') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f.sig);
      END IF;
    END IF;
  END LOOP;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('import_upload_async_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'imports.async_rows', 'status', 'parsing', 'units', jsonb_build_array('stream', 'register', 'single'), 'stream_chunk_rows', 100,
          'linear_staging', jsonb_build_array('imp_insert_task_batch', 'imp_stage_stream_batch', 'imp_stage_register_batch', 'imp_stage_master_core')),
        'Technical decision of 2026-11-09 (CHANGELOG 122): big template uploads are staged in the background; the staging of a big Master file is linear (migration 0083).');
