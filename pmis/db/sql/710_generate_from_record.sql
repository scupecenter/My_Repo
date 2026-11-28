-- 0711 (spec: docs/plans/spec-generate-from-record.md): a document generated from an approved register record.
-- Additive only: one nullable column, one relaxed NOT NULL with a CHECK, four new functions. No existing function, grant, role or default changes.
--   * library_generated_docs.register_entity_id (nullable, no FK: register_records.entity_id is not unique) and task_id nullable with a CHECK that one is set.
--   * lib_record_context / lib_check_generate_record / lib_preview_record / lib_generate_record.
-- Rights: the "library.forms" create grant for the record's region only. The record must be approved and current. Data reset: library_generated_docs stays
-- DELETE in the documents part (no new table).

ALTER TABLE library_generated_docs ADD COLUMN IF NOT EXISTS register_entity_id uuid;
ALTER TABLE library_generated_docs ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE library_generated_docs ADD CONSTRAINT library_generated_docs_owner_check CHECK (task_id IS NOT NULL OR register_entity_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS library_generated_docs_record_idx ON library_generated_docs (register_entity_id, doc_type_id, generated_at DESC) WHERE register_entity_id IS NOT NULL;
COMMENT ON COLUMN library_generated_docs.register_entity_id IS '0711: the logical register record this document was generated from (NULL for a task document).';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT (register_entity_id) ON library_generated_docs TO pmis_app;
  END IF;
END $$;
GRANT SELECT ON register_records, register_fields TO pmis_definer;

-- The JSON of a generated document: the task join becomes a LEFT JOIN (a record document has no task) and register_entity_id is added. Same keys otherwise.
CREATE OR REPLACE FUNCTION lib_generated_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', g.id, 'number', g.number, 'status', g.status, 'template_id', g.template_id, 'template_code', t.code, 'template_version', t.version,
    'site_id', g.site_id, 'site_code', s.site_code, 'region_id', g.region_id, 'task_id', g.task_id, 'task_code', td.code, 'register_entity_id', g.register_entity_id,
    'doc_code', dt.code, 'remarks', g.remarks, 'sha256', g.sha256, 'size_bytes', coalesce(octet_length(g.html), 0),
    'generated_by', public.wfe_user_ref(g.generated_by), 'generated_at', g.generated_at,
    'void_reason', g.void_reason, 'voided_by', public.wfe_user_ref(g.voided_by), 'voided_at', g.voided_at)
  FROM public.library_generated_docs g
  JOIN public.library_form_templates t ON t.id = g.template_id
  JOIN public.sites s ON s.id = g.site_id
  LEFT JOIN public.task_instances ti ON ti.id = g.task_id
  LEFT JOIN public.task_definitions td ON td.id = ti.task_def_id
  JOIN public.document_types dt ON dt.id = g.doc_type_id
  WHERE g.id = p_id
$$;

-- The record part of a form context: register, status, level, approval date and the active fields by code (text values; dates YYYY-MM-DD).
CREATE OR REPLACE FUNCTION lib_record_context(p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.register_records%ROWTYPE; f jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_entity AND is_current AND state = 'approved';
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  SELECT coalesce(jsonb_object_agg(rf.code, coalesce(r.data ->> rf.code, '')), '{}'::jsonb) INTO f
    FROM public.register_fields rf WHERE rf.register_key = r.register_key AND rf.is_active;
  RETURN jsonb_build_object('register_key', r.register_key, 'entity_id', r.entity_id, 'status', r.state, 'level', r.current_level,
    'version_no', r.version_no, 'approved_at', to_char(r.approved_at, 'YYYY-MM-DD'), 'fields', f);
END $$;

CREATE OR REPLACE FUNCTION lib_check_generate_record(p_template uuid, p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.library_form_templates%ROWTYPE; r public.register_records%ROWTYPE; regs int[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  IF NOT FOUND OR t.status <> 'approved' THEN PERFORM public.lib_err('not_found', 'The form does not exist or is not approved.'); END IF;
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_entity ORDER BY version_no DESC LIMIT 1;
  IF NOT FOUND OR r.site_id IS NULL OR NOT public.app_region_check(r.region_id) THEN
    PERFORM public.lib_err('not_found', 'The record does not exist or is not visible to you.');
  END IF;
  regs := public.wf_actor_regions('library.forms', 'create'::"PermissionAction");
  IF NOT (regs IS NULL OR r.region_id = ANY (regs)) THEN
    PERFORM public.lib_err('not_eligible_holder', 'Only a holder of "Documents: generate" for the region generates a document from a record.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.register_records x WHERE x.entity_id = p_entity AND x.is_current AND x.state = 'approved') THEN
    PERFORM public.lib_err('validation_failed', 'record_not_approved: the record must be approved before its document is generated.');
  END IF;
  RETURN jsonb_build_object('template', t.id, 'site', r.site_id, 'region_id', r.region_id, 'entity', p_entity);
END $$;

CREATE OR REPLACE FUNCTION lib_preview_record(p_template uuid, p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; t public.library_form_templates%ROWTYPE;
BEGIN
  c := public.lib_check_generate_record(p_template, p_entity);
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  RETURN jsonb_build_object('data', public.lib_form_context(p_template, (c ->> 'site')::uuid, NULL, 'PREVIEW', NULL) || jsonb_build_object('record', public.lib_record_context(p_entity)),
                            'html', t.html, 'bindings', t.bindings, 'task_id', NULL, 'template', public.lib_form_template_json(p_template));
END $$;

CREATE OR REPLACE FUNCTION lib_generate_record(p_template uuid, p_entity uuid, p_remarks text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; t public.library_form_templates%ROWTYPE; gid uuid := gen_random_uuid(); num text; ctx jsonb; sid uuid; rid integer;
BEGIN
  IF p_remarks IS NOT NULL AND char_length(p_remarks) > 1000 THEN
    PERFORM public.lib_err('validation_failed', 'Remarks are at most 1000 characters.', public.reg_err_item('/remarks', 'invalid', 'At most 1000 characters.'));
  END IF;
  c := public.lib_check_generate_record(p_template, p_entity);
  sid := (c ->> 'site')::uuid; rid := (c ->> 'region_id')::integer;
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  num := public.doc_next_number((SELECT key FROM public.doc_sequences WHERE form_code = t.code AND is_active), NULL, 'library_generated_doc', gid);
  IF num IS NULL THEN PERFORM public.lib_err('invalid_transition', 'The form has no active numbering sequence: approve the form again in Settings > Documents > Form templates.'); END IF;
  ctx := public.lib_form_context(p_template, sid, NULL, num, nullif(btrim(coalesce(p_remarks, '')), '')) || jsonb_build_object('record', public.lib_record_context(p_entity));
  INSERT INTO public.library_generated_docs (id, template_id, number, site_id, region_id, task_id, register_entity_id, doc_type_id, status, remarks, data, generated_by)
  VALUES (gid, t.id, num, sid, rid, NULL, p_entity, t.doc_type_id, 'generated', nullif(btrim(coalesce(p_remarks, '')), ''), ctx, public.app_actor());
  PERFORM public.log_audit_write('library_document_generate', 'library_generated_doc', gid::text, NULL,
    jsonb_build_object('number', num, 'template', t.code, 'template_version', t.version, 'register_entity_id', p_entity, 'doc_type_id', t.doc_type_id), NULL, sid, rid);
  RETURN jsonb_build_object('id', gid, 'number', num, 'data', ctx, 'html', t.html, 'bindings', t.bindings);
END $$;
