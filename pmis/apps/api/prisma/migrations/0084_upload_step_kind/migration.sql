-- 0084: fix of 0083 (owner report 2026-11-10). imp_upload_step declared a PL/pgSQL variable named "kind", the name of a column of import_uploads, so
-- the step of a big one-template upload (a single register, New sites or stream batch) stopped with 42702 "column reference "kind" is ambiguous" in
-- its UPDATE of import_uploads, and the run ended after three failed tries. The variable is renamed v_kind; nothing else changes. CREATE OR REPLACE keeps
-- the owner (pmis_definer), the search_path, and the grants (PUBLIC revoked, EXECUTE for pmis_app) set by 0083.

CREATE OR REPLACE FUNCTION imp_upload_step(p_upload uuid, p_chunk integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); u public.import_uploads%ROWTYPE; unit jsonb; n int; chunk int := public.imp_upload_chunk_rows(p_chunk); slice jsonb; res jsonb; r jsonb; bid uuid; j jsonb;
  hw jsonb; sctx jsonb; plan jsonb; tid text; ver int; cs text; v_kind text; total int;
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
  v_kind := CASE WHEN unit ->> 'kind' = 'single' THEN unit ->> 'batch_kind' ELSE unit ->> 'kind' END;
  total := jsonb_array_length(coalesce(unit -> 'rows', '[]'::jsonb));

  IF v_kind = 'stream' THEN
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
      IF v_kind = 'sites' THEN
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
    UPDATE public.import_uploads SET batches = batches || jsonb_build_array(jsonb_build_object('id', bid, 'sheet', 'Data', 'kind', v_kind, 'ref', coalesce(u.register_key, u.entity), 'template_id', u.template_id)),
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
