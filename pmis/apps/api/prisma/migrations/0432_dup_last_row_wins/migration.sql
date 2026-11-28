-- 0432 (data-entry review 2026-11-27, decision approved by the owner 2026-11-27 10:30): "last row wins" for a record that is in the upload file twice. Additive: one setting, three functions,
-- two existing functions replaced (imp_stage_register_batch, imp_batch_counts); no table, column, permission or stored row changes.
--
-- WHAT. Today the FIRST row of a record wins and the later row is refused with `duplicate_in_file` (0037). The setting `imports.duplicate_rows` = {"default": "first", "registers": {}} adds the other
-- choice, "last", per register or for all: the EARLIER row is set aside and the LATER row is staged (create / update / unchanged as any row). OFF by default: nothing changes until an admin chooses "last".
-- NOTHING IS LOST. The set-aside row stays in the batch as an error row with the code `overridden_by_later_row` (its cells stay in the payload, as every error row), so the batch review lists
-- it BEFORE approval (new count c_overridden) and the error report carries it. A row set aside is never approved, saved or exported.
-- SETTING DOOR. Changes only through admin_set_imp_duplicate_policy (reason, version, audit), like templates.change_notice (0367). The mode of one register is imp_duplicate_mode(register_key).
-- COVERED: register templates (imp_stage_register_batch, used by the sync and the async upload). EXCLUDED, unchanged: master, sites, stream, list-values and holiday templates; the first row still wins there.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('imports.duplicate_rows', '{"default": "first", "registers": {}}'::jsonb,
        '0432: a record that is in an upload file twice: "first" (the first row wins, the later is refused) or "last" (the later row wins, the earlier is set aside and listed). Default for all, and per register.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION imp_duplicate_mode(p_register text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; m text;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'imports.duplicate_rows';
  m := coalesce(v -> 'registers' ->> p_register, v ->> 'default', 'first');
  RETURN CASE WHEN m = 'last' THEN 'last' ELSE 'first' END;
END $$;

CREATE OR REPLACE FUNCTION imp_duplicate_policy_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; d text; regs jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'imports.duplicate_rows';
  d := CASE WHEN s.value ->> 'default' = 'last' THEN 'last' ELSE 'first' END;
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) INTO regs
    FROM (SELECT e.key AS k, CASE WHEN e.value #>> '{}' = 'last' THEN 'last' ELSE 'first' END AS v
            FROM jsonb_each(CASE WHEN jsonb_typeof(s.value -> 'registers') = 'object' THEN s.value -> 'registers' ELSE '{}'::jsonb END) e
            JOIN public.register_definitions rd ON rd.register_key = e.key) q;
  RETURN jsonb_build_object('default', d, 'registers', regs, 'updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('imports.duplicate_rows'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_imp_duplicate_policy(p_default text, p_registers jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; e record; regs jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_default IS NULL OR p_default NOT IN ('first', 'last') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/default', 'invalid', 'first or last.')));
  END IF;
  IF p_registers IS NULL OR jsonb_typeof(p_registers) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/registers', 'invalid', 'An object of register key to first or last.')));
  END IF;
  FOR e IN SELECT key, value FROM jsonb_each(p_registers) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.register_definitions WHERE register_key = e.key) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/registers/' || e.key, 'unknown_register', 'This register does not exist.')));
    END IF;
    IF jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') NOT IN ('first', 'last') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/registers/' || e.key, 'invalid', 'first or last.')));
    END IF;
    regs := regs || jsonb_build_object(e.key, e.value);
  END LOOP;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('imports.duplicate_rows', '{"default": "first", "registers": {}}'::jsonb, '0432: duplicate rows inside one upload file.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'imports.duplicate_rows' FOR UPDATE;
  cur := public.imp_duplicate_policy_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur ->> 'default' = p_default AND cur -> 'registers' = regs THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These values are already set.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('default', p_default, 'registers', regs), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'imports.duplicate_rows';
  res := public.imp_duplicate_policy_json();
  PERFORM public.log_audit_write('imp_duplicate_policy_update', 'setting', 'imports.duplicate_rows',
    jsonb_build_object('default', cur -> 'default', 'registers', cur -> 'registers'), jsonb_build_object('default', res -> 'default', 'registers', res -> 'registers'), btrim(p_reason));
  RETURN res;
END $$;

DROP TRIGGER IF EXISTS b_settings_dup_rows ON settings;
DROP TRIGGER IF EXISTS b_settings_dup_rows_update ON settings;
DROP TRIGGER IF EXISTS b_settings_dup_rows_delete ON settings;
CREATE TRIGGER b_settings_dup_rows BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'imports.duplicate_rows') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dup_rows_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.duplicate_rows' OR NEW.key = 'imports.duplicate_rows') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dup_rows_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.duplicate_rows') EXECUTE FUNCTION settings_guarded_keys();

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['imp_duplicate_mode(text)', 'imp_duplicate_policy_json()', 'admin_set_imp_duplicate_policy(text, jsonb, text, integer)'] LOOP
    EXECUTE 'ALTER FUNCTION ' || f || ' OWNER TO pmis_definer';
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO pmis_definer';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO pmis_app'; END IF;
  END LOOP;
END $$;

-- The counts of a batch gain c_overridden (the rows set aside by "last row wins").
CREATE OR REPLACE FUNCTION imp_batch_counts(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; c record; st text;
BEGIN
  IF NOT public.imp_batch_visible(p_batch) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH x AS (
    SELECT r.action, (r.action = 'error' AND coalesce(r.errors, '[]'::jsonb) @> '[{"code": "duplicate_in_file"}]'::jsonb) AS dup, (r.action = 'error' AND coalesce(r.errors, '[]'::jsonb) @> '[{"code": "overridden_by_later_row"}]'::jsonb) AS ovr, r.admin_approved, r.incomplete, (r.region_id IS NULL OR public.app_region_check(r.region_id)) AS vis,   -- the row rule of 0037
      CASE WHEN r.action IN ('error', 'unchanged') THEN r.decision
           WHEN r.task_instance_id IS NOT NULL THEN
             CASE WHEN r.decision = 'pending' AND r.task_submitted_at IS NOT NULL AND ti.state = 'approved' THEN 'approved'
                  WHEN r.decision = 'pending' AND r.task_submitted_at IS NOT NULL AND ti.state IN ('open', 'entry', 'na', 'skipped') THEN 'rejected'
                  ELSE r.decision END
           WHEN r.decision = 'pending' AND rr.state = 'approved' THEN 'approved'
           WHEN r.decision = 'pending' AND rr.state = 'voided' THEN 'rejected'
           WHEN r.decision = 'pending' AND rr.state = 'entry' AND rr.submitted_at IS NOT NULL THEN 'rejected'
           ELSE r.decision END AS eff
    FROM public.import_batch_rows r
    LEFT JOIN public.register_records rr ON rr.id = r.register_record_id
    LEFT JOIN public.task_instances ti ON ti.id = r.task_instance_id
    WHERE r.batch_id = p_batch)
  SELECT count(*) FILTER (WHERE vis AND action = 'create') AS c_create, count(*) FILTER (WHERE vis AND action = 'update') AS c_update,
         count(*) FILTER (WHERE vis AND action = 'unchanged') AS c_unchanged, count(*) FILTER (WHERE vis AND action = 'error') AS c_error,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'pending') AS c_pending,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'approved') AS c_approved,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'rejected') AS c_rejected,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'pending_previous_approval') AS c_held,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'saved') AS c_saved,
         count(*) FILTER (WHERE vis AND dup) AS c_duplicate, count(*) FILTER (WHERE vis AND ovr) AS c_overridden,
         count(*) FILTER (WHERE vis AND admin_approved) AS c_admin_approved, count(*) FILTER (WHERE vis AND admin_approved AND incomplete) AS c_incomplete,
         -- the status of the batch, from every row (as imp_status_of)
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff IN ('pending', 'pending_previous_approval')) AS s_open,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'approved') AS s_ok,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'rejected') AS s_rej
    INTO c FROM x;
  -- the status, as imp_status_of (0074) decides it
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j WHERE j.batch_id = p_batch AND j.state = 'running') THEN st := 'processing';
  ELSIF b.status NOT IN ('in_approval', 'partially_approved', 'approved', 'rejected') THEN st := b.status;
  ELSE
    st := CASE WHEN c.s_open > 0 AND c.s_ok + c.s_rej = 0 THEN 'in_approval' WHEN c.s_open > 0 THEN 'partially_approved'
               WHEN c.s_ok > 0 THEN 'approved' ELSE 'rejected' END;
  END IF;
  RETURN jsonb_build_object('status', st, 'c_create', c.c_create, 'c_update', c.c_update, 'c_unchanged', c.c_unchanged, 'c_error', c.c_error,
    'c_pending', c.c_pending, 'c_approved', c.c_approved, 'c_rejected', c.c_rejected, 'c_held', c.c_held, 'c_saved', c.c_saved,
    'c_duplicate', c.c_duplicate, 'c_overridden', c.c_overridden, 'c_admin_approved', c.c_admin_approved, 'c_incomplete', c.c_incomplete);
END $$;

ALTER FUNCTION imp_batch_counts(uuid) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION imp_batch_counts(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION imp_batch_counts(uuid) TO pmis_app; END IF;
END $$;

-- The staging of a register file: the 082 body, with the duplicate rule choosing between the first and the last row.
CREATE OR REPLACE FUNCTION public.imp_stage_register_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; rd public.register_definitions%ROWTYPE; cols jsonb;
  r_import int[]; r_view int[]; r_create int[]; r_edit int[]; bid uuid := gen_random_uuid(); el jsonb; res jsonb; seen jsonb := '{}'::jsonb; results jsonb; task_site uuid; n_err int := 0; n_rows int := 0;
  regions int[]; acc jsonb[] := ARRAY[]::jsonb[]; dup_mode text; seen_ix jsonb := '{}'::jsonb; prev_ix int; prev jsonb;
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
  -- 0432: a record that is in the file twice. 'first' (default, as before): the later row is refused. 'last': the earlier row is set aside (still visible) and the later one is used.
  dup_mode := public.imp_duplicate_mode(d.register_key);

  FOR el IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    res := public.imp_stage_register_row(d.register_key, d.match_keys, cols, el, task_site, d.custom_entity, r_view, r_import, r_create, r_edit);
    IF res ->> 'sig' IS NOT NULL AND res ->> 'action' <> 'error' THEN
      IF seen ? (res ->> 'sig') AND dup_mode = 'last' THEN
        -- the EARLIER row stays visible as a refused row with its own code, so nothing is lost; this row is the one staged
        prev_ix := (seen_ix ->> (res ->> 'sig'))::int;
        prev := acc[prev_ix];
        acc[prev_ix] := jsonb_set(prev, '{res}', (prev -> 'res') || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
          'errors', coalesce(prev -> 'res' -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('code', 'overridden_by_later_row', 'message', 'A later row of this file (row ' || (el ->> 'row_no') || ') is the same record and is used instead of this one.'))));
        seen := seen || jsonb_build_object(res ->> 'sig', el ->> 'row_no');
      ELSIF seen ? (res ->> 'sig') THEN
        res := res || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
          'errors', coalesce(res -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('code', 'duplicate_in_file', 'message', 'Row ' || (seen ->> (res ->> 'sig')) || ' of this file is the same record.')));
      ELSE seen := seen || jsonb_build_object(res ->> 'sig', el ->> 'row_no'); END IF;
    END IF;
    acc := array_append(acc, jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', 'Data'), 'res', res));   -- 0083: an array, not a growing jsonb
    IF res ->> 'sig' IS NOT NULL AND res ->> 'action' <> 'error' THEN seen_ix := seen_ix || jsonb_build_object(res ->> 'sig', cardinality(acc)); END IF;
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
