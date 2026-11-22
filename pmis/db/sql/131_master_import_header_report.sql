-- 0132: the refusal "This file is not the Site Master" names the columns it did not find and the headers of the file it does not know.
--
-- WHY. A new Master (2026-11-22) was refused with "only 167 of the 187 Master column headers were found" and no list, so nobody could tell which
-- headers had been renamed. The legacy import already accepts known renamed headers (master_header_aliases, 0070), but only once they are known.
--
-- WHAT CHANGES. mi_stage_open (last defined in 0083) keeps its body, its checks and its rights; only:
--   - the not_a_master problem lists the Master columns not found (letter and header, at most 30) and the headers of the file that match no Master
--     column (at most 30), and carries both lists as `missing` / `extra`;
--   - `extra` no longer counts a header that matched in its composed form ("group / name").
-- No header text of the file is stored by this change: the problem goes to the uploader and the System Log line already written for a refusal.
-- Owner, search_path and grants of mi_stage_open are unchanged (CREATE OR REPLACE keeps them); they are restated below.

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
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(aliased) a WHERE a ->> 'in_file' = btrim(x ->> 'header'))
    AND NOT (fmap ? coalesce(x ->> 'col', ''));   -- 0132: a header matched in its composed form ("group / name") is not extra
  SELECT coalesce(jsonb_agg(tp.sheet_name ORDER BY tp.sort_order), '[]'::jsonb) INTO expected_sheets FROM public.template_parts tp WHERE tp.template_id = 'TPL-MASTER';
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO sheets_missing FROM jsonb_array_elements_text(expected_sheets) x WHERE NOT (p_sheets ? x);
  v_structure := jsonb_build_object('identified', NOT (fmap ? '') AND fmap <> '{}'::jsonb AND found * 10 >= total * 9 AND EXISTS (SELECT 1 FROM jsonb_each_text(fmap) e WHERE e.value = 'B'),
    'columns_expected', total, 'columns_found', found, 'aliased', aliased, 'missing', missing, 'moved', moved, 'extra', extra, 'missing_typed', miss_input,
    'sheets', p_sheets, 'register_sheets_missing', sheets_missing, 'has_tpl', p_sheets ? '_tpl');
  IF NOT (v_structure ->> 'identified')::boolean THEN
    -- 0132: name the columns that were not found and the headers of the file that are not known, so a renamed Master can be fixed (aliases)
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: only ' || found || ' of the ' || total ||
      ' Master column headers were found (at least 90% and the Site ID column are required). Upload the real Master as it is, without changing its header rows.' ||
      CASE WHEN jsonb_array_length(missing) > 0 THEN ' Not found (' || jsonb_array_length(missing) || '): ' ||
        (SELECT string_agg((m ->> 'letter') || ' "' || (m ->> 'header') || '"', '; ') FROM (SELECT m FROM jsonb_array_elements(missing) m LIMIT 30) q) ||
        CASE WHEN jsonb_array_length(missing) > 30 THEN '; ...' ELSE '' END || '.' ELSE '' END ||
      CASE WHEN jsonb_array_length(extra) > 0 THEN ' Headers in the file that are not known (' || jsonb_array_length(extra) || '): ' ||
        (SELECT string_agg('"' || (x #>> '{}') || '"', '; ') FROM (SELECT x FROM jsonb_array_elements(extra) x LIMIT 30) q) ||
        CASE WHEN jsonb_array_length(extra) > 30 THEN '; ...' ELSE '' END || '.' ELSE '' END,
      'missing', missing, 'extra', extra, 'columns_found', found, 'columns_expected', total));
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


ALTER FUNCTION mi_stage_open(text, text, bigint, text, jsonb, jsonb, integer, text) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION mi_stage_open(text, text, bigint, text, jsonb, jsonb, integer, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON FUNCTION mi_stage_open(text, text, bigint, text, jsonb, jsonb, integer, text) FROM pmis_app;
  END IF;
END $$;
