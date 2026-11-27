CREATE OR REPLACE FUNCTION admin_save_snag_type(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE st public.snag_types%ROWTYPE; pr jsonb := p_patch -> 'photo_rules'; errs jsonb := '[]'::jsonb; f text; before_ jsonb; nid uuid; ver int; rule_ text; k text;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  FOR k IN SELECT jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) LOOP
    IF k NOT IN ('code', 'name_en', 'name_ar', 'photo_rules', 'stream', 'blocking_rule', 'blocks_preliminary_acceptance', 'is_active') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'unknown_key', 'message', 'Unknown field.'));
    END IF;
  END LOOP;
  IF pr IS NOT NULL AND jsonb_typeof(pr) = 'object' THEN
    IF pr ? 'min_count' AND (jsonb_typeof(pr -> 'min_count') <> 'number' OR (pr ->> 'min_count')::numeric NOT BETWEEN 0 AND 50) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/min_count', 'code', 'invalid', 'message', 'min_count is 0 to 50.'));
    END IF;
    IF pr ? 'max_size_mb' AND (jsonb_typeof(pr -> 'max_size_mb') <> 'number' OR (pr ->> 'max_size_mb')::numeric NOT BETWEEN 1 AND 200) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/max_size_mb', 'code', 'invalid', 'message', 'max_size_mb is 1 to 200.'));
    END IF;
    IF pr ? 'formats' THEN
      IF jsonb_typeof(pr -> 'formats') <> 'array' OR jsonb_array_length(pr -> 'formats') = 0 THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/formats', 'code', 'invalid', 'message', 'At least one format: JPG, PNG, HEIC, WEBM, MP4 or MOV.'));
      ELSE
        FOR f IN SELECT jsonb_array_elements_text(pr -> 'formats') LOOP
          IF upper(f) NOT IN ('JPG', 'PNG', 'HEIC', 'WEBM', 'MP4', 'MOV') THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/formats', 'code', 'invalid', 'message', 'Formats are JPG, PNG, HEIC, WEBM, MP4 and MOV.'));
          END IF;
        END LOOP;
      END IF;
    END IF;
    IF pr ? 'shot_types' AND (jsonb_typeof(pr -> 'shot_types') <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(pr -> 'shot_types') x WHERE jsonb_typeof(x) <> 'string' OR char_length(x #>> '{}') NOT BETWEEN 1 AND 40)) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/shot_types', 'code', 'invalid', 'message', 'Shot types are short names.'));
    END IF;
  ELSIF pr IS NOT NULL AND pr <> 'null'::jsonb THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules', 'code', 'invalid', 'message', 'photo_rules is an object.'));
  END IF;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) < 2 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/name_en', 'code', 'required', 'message', 'The English name is required.'));
  END IF;
  IF p_patch ? 'stream' AND p_patch -> 'stream' <> 'null'::jsonb AND coalesce(p_patch ->> 'stream', '') NOT IN ('CW', 'TE') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/stream', 'code', 'invalid', 'message', 'The stream is CW, TE or null (both).'));
  END IF;
  IF p_patch ? 'blocking_rule' AND coalesce(p_patch ->> 'blocking_rule', '') NOT IN ('always', 'by_severity', 'never') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/blocking_rule', 'code', 'invalid', 'message', 'always, by_severity or never.'));
  END IF;
  IF p_id IS NULL THEN
    IF coalesce(p_patch ->> 'code', '') !~ '^[A-Z][A-Z0-9_]{1,30}$' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'invalid', 'message', 'The code is capital letters, digits and underscores.'));
    ELSIF EXISTS (SELECT 1 FROM public.snag_types x WHERE x.code = p_patch ->> 'code') THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A snag type with this code exists already.'));
    END IF;
    IF NOT (p_patch ? 'name_en') THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/name_en', 'code', 'required', 'message', 'The English name is required.')); END IF;
  ELSIF p_patch ? 'code' THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'immutable', 'message', 'The code never changes.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  rule_ := CASE WHEN p_patch ? 'blocking_rule' THEN p_patch ->> 'blocking_rule'
                WHEN p_patch ? 'blocks_preliminary_acceptance' THEN CASE WHEN (p_patch ->> 'blocks_preliminary_acceptance')::boolean THEN 'always' ELSE 'never' END END;
  IF p_id IS NULL THEN
    INSERT INTO public.snag_types (code, name_en, name_ar, min_photos, required_shots, formats, max_size_mb, blocks_preliminary_acceptance, is_active, stream, blocking_rule)
    VALUES (p_patch ->> 'code', btrim(p_patch ->> 'name_en'), p_patch ->> 'name_ar', coalesce((pr ->> 'min_count')::int, 1), coalesce(pr -> 'shot_types', '[]'::jsonb),
            coalesce(ARRAY(SELECT lower(x) FROM jsonb_array_elements_text(pr -> 'formats') x), ARRAY['jpg', 'png', 'heic']), coalesce((pr ->> 'max_size_mb')::int, 20),
            coalesce(rule_, 'by_severity') <> 'never', coalesce((p_patch ->> 'is_active')::boolean, true), nullif(p_patch ->> 'stream', ''), coalesce(rule_, 'by_severity'))
    RETURNING id, version INTO nid, ver;
    PERFORM public.log_audit_write('snag_type_create', 'snag_type', nid::text, NULL, (SELECT to_jsonb(x) FROM public.snag_types x WHERE x.id = nid), btrim(p_reason));
    RETURN jsonb_build_object('id', nid, 'version', ver);
  END IF;
  SELECT * INTO st FROM public.snag_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The snag type does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> st.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  before_ := to_jsonb(st);
  UPDATE public.snag_types SET
    name_en = CASE WHEN p_patch ? 'name_en' THEN btrim(p_patch ->> 'name_en') ELSE name_en END,
    name_ar = CASE WHEN p_patch ? 'name_ar' THEN p_patch ->> 'name_ar' ELSE name_ar END,
    min_photos = CASE WHEN pr ? 'min_count' THEN (pr ->> 'min_count')::int ELSE min_photos END,
    required_shots = CASE WHEN pr ? 'shot_types' THEN pr -> 'shot_types' ELSE required_shots END,
    formats = CASE WHEN pr ? 'formats' THEN ARRAY(SELECT lower(x) FROM jsonb_array_elements_text(pr -> 'formats') x) ELSE formats END,
    max_size_mb = CASE WHEN pr ? 'max_size_mb' THEN (pr ->> 'max_size_mb')::int ELSE max_size_mb END,
    blocking_rule = coalesce(rule_, blocking_rule),
    blocks_preliminary_acceptance = coalesce(rule_, blocking_rule) <> 'never',
    stream = CASE WHEN p_patch ? 'stream' THEN nullif(p_patch ->> 'stream', '') ELSE stream END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::boolean ELSE is_active END,
    version = version + 1
  WHERE id = p_id RETURNING version INTO ver;
  PERFORM public.log_audit_write(CASE WHEN st.is_active AND p_patch ? 'is_active' AND NOT (p_patch ->> 'is_active')::boolean THEN 'snag_type_deactivate' ELSE 'snag_type_update' END,
    'snag_type', p_id::text, before_, (SELECT to_jsonb(x) FROM public.snag_types x WHERE x.id = p_id), btrim(p_reason));
  RETURN jsonb_build_object('id', p_id, 'version', ver);
END $$;

ALTER FUNCTION public.admin_save_snag_type(uuid, jsonb, text, integer) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION public.admin_save_snag_type(uuid, jsonb, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_save_snag_type(uuid, jsonb, text, integer) FROM pmis_app;
GRANT EXECUTE ON FUNCTION public.admin_save_snag_type(uuid, jsonb, text, integer) TO pmis_app;
