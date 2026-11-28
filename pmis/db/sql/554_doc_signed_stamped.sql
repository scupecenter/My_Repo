-- 0555_doc_signed_stamped: the signed and stamped copy of a document (first version: markers, not an e-signature engine). Documents are downloaded, signed and stamped on
-- paper or by the counterpart, then uploaded again as a new version of the same file; this records which version is the signed and stamped copy.
--   1. Setting documents.marks: per document type code, whether the type needs a signed copy and a stamped copy (default none). Changed only through
--      admin_set_document_type_marks (System Admin or a delegation covering document_types.edit, with a reason, audited). Hide, never delete: a type that is later
--      deactivated keeps its flags.
--   2. Markers of one uploaded version: doc_mark_file records "signed" and "stamped" for a file the caller uploaded (append-only, as an audit row, so no table is added
--      and the data reset plan is unchanged); doc_file_marks reads the latest marker of a list of files. A version without a marker is simply unmarked.
--   3. Nothing blocks: no gate, approval or slot status depends on the markers. A slot of a type that needs them shows "awaiting signed copy" until a current version
--      carries them.
-- Additive and idempotent. Mirror: db/sql/554_doc_signed_stamped.sql (kept identical to prisma/migrations/0555_doc_signed_stamped/migration.sql).

SELECT set_config('app.region_ids', '*', true);
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON document_types, document_slots, document_files TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('documents.marks', '{"types": {}, "version": 0}'::jsonb,
        'Document types that need a signed copy and a stamped copy (0555). Changed only through admin_set_document_type_marks.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_doc_marks ON settings;
DROP TRIGGER IF EXISTS b_settings_doc_marks_update ON settings;
DROP TRIGGER IF EXISTS b_settings_doc_marks_delete ON settings;
CREATE TRIGGER b_settings_doc_marks BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'documents.marks') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_doc_marks_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'documents.marks' OR NEW.key = 'documents.marks') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_doc_marks_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'documents.marks') EXECUTE FUNCTION settings_guarded_keys();

-- GET: {types: {<doc code>: {signature, stamp}}, version}. Every signed-in caller reads it (the upload dialog and the slot rows need it).
CREATE OR REPLACE FUNCTION doc_marks_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'document marks: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'documents.marks';
  RETURN jsonb_build_object('types', coalesce(s.value -> 'types', '{}'::jsonb), 'version', coalesce((s.value ->> 'version')::integer, 0));
END $$;

-- PUT: the two flags of one document type. Both false removes the entry.
CREATE OR REPLACE FUNCTION admin_set_document_type_marks(p_code text, p_signature boolean, p_stamp boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; types jsonb; nxt jsonb;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_code IS NULL OR NOT EXISTS (SELECT 1 FROM public.document_types d WHERE d.code = p_code) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/code', 'unknown_document', 'Not a document type.')));
  END IF;
  IF p_signature IS NULL OR p_stamp IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'required', 'signature and stamp are true or false.')));
  END IF;
  PERFORM 1 FROM public.settings WHERE key = 'documents.marks' FOR UPDATE;
  cur := public.doc_marks_cfg();
  types := cur -> 'types';
  IF p_signature OR p_stamp THEN types := types || jsonb_build_object(p_code, jsonb_build_object('signature', p_signature, 'stamp', p_stamp));
  ELSE types := types - p_code; END IF;
  nxt := jsonb_build_object('types', types, 'version', (cur ->> 'version')::integer + 1);
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'documents.marks';
  PERFORM public.log_audit_write('document_type_marks_update', 'setting', 'documents.marks', cur - 'version', nxt - 'version', btrim(p_reason));
  RETURN nxt;
END $$;

-- The markers of a file the caller uploaded (the upload dialog calls it right after the upload; a later call may correct it). Append-only: one audit row each.
CREATE OR REPLACE FUNCTION doc_mark_file(p_file uuid, p_signed boolean, p_stamped boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); f public.document_files%ROWTYPE; s public.document_slots%ROWTYPE; res jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'document marks: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO f FROM public.document_files WHERE id = p_file;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = f.slot_id;
  IF NOT public.app_region_read(s.is_global, s.region_id) THEN PERFORM public.wf_err('not_found'); END IF;
  IF f.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded a version marks it as the signed or stamped copy.'));
  END IF;
  res := jsonb_build_object('signed', coalesce(p_signed, false), 'stamped', coalesce(p_stamped, false));
  PERFORM public.log_audit_write('document_file_marked', 'document_file', p_file::text, NULL, res, 'Signed / stamped copy marker', NULL, s.region_id);
  RETURN res;
END $$;

-- The latest marker of each file: {<file id>: {signed, stamped}}. Files with no marker are left out.
CREATE OR REPLACE FUNCTION doc_file_marks(p_files uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'document marks: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN coalesce((SELECT jsonb_object_agg(x.entity_id, x.after) FROM (
    SELECT DISTINCT ON (a.entity_id) a.entity_id, a.after FROM public.audit_log a
    WHERE a.action = 'document_file_marked' AND a.entity_id = ANY (SELECT u::text FROM unnest(p_files) u) ORDER BY a.entity_id, a.id DESC) x), '{}'::jsonb);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['doc_marks_cfg()', 'admin_set_document_type_marks(text,boolean,boolean,text)', 'doc_mark_file(uuid,boolean,boolean)', 'doc_file_marks(uuid[])'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION doc_marks_cfg(), admin_set_document_type_marks(text,boolean,boolean,text), doc_mark_file(uuid,boolean,boolean), doc_file_marks(uuid[]) TO pmis_app;
  END IF;
END $$;
