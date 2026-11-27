-- 0255: Search inside uploaded document contents (contract 0.15.104). Additive: one table, one index, four functions, no change to existing tables.
-- document_texts holds the normalised text extracted from a current, clean-scan PDF or DOCX. It is derived data: the file bytes are only read, the text is
-- written by the indexing job through a definer door (document_text_put), and nothing is ever deleted by hand (a row goes when its file row goes).
-- Row level security is the same as document_files: a row is visible only when its document slot is. Global search also scopes by the caller's regions.

CREATE TABLE IF NOT EXISTS document_texts (
  file_id      uuid PRIMARY KEY REFERENCES document_files (id) ON DELETE CASCADE,
  slot_id      uuid NOT NULL REFERENCES document_slots (id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('done', 'empty', 'unsupported', 'too_large', 'failed')),
  text_norm    text NOT NULL DEFAULT '',
  chars        integer NOT NULL DEFAULT 0,
  extracted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_texts_slot ON document_texts (slot_id);
CREATE INDEX IF NOT EXISTS document_texts_trgm ON document_texts USING gin (text_norm gin_trgm_ops) WHERE status = 'done';

ALTER TABLE document_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_texts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON document_texts;
CREATE POLICY rls_select ON document_texts FOR SELECT USING (EXISTS (SELECT 1 FROM document_slots p WHERE p.id = slot_id));
-- No insert, update or delete policy: only the definer functions below (BYPASSRLS owner) write.

-- Files still to index: current files whose stored object is clean and that have no text row yet (or a failed one older than a day).
CREATE OR REPLACE FUNCTION document_text_pending(p_limit integer)
RETURNS TABLE (file_id uuid, storage_key text, original_name text, mime_type text, size_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT f.id, f.storage_key, f.original_name, f.mime_type, f.size_bytes
  FROM public.document_files f
  JOIN public.stored_object_meta m ON m.storage_key = f.storage_key AND m.scan_status = 'clean'
  LEFT JOIN public.document_texts t ON t.file_id = f.id
  WHERE f.is_current AND f.storage_key IS NOT NULL AND (t.file_id IS NULL OR (t.status = 'failed' AND t.extracted_at < now() - interval '1 day'))
  ORDER BY f.uploaded_at DESC LIMIT greatest(1, least(p_limit, 200));
$$;

-- The only writer: stores the extracted text of one file. The text is normalised here with search_norm() so that search and index agree.
CREATE OR REPLACE FUNCTION document_text_put(p_file uuid, p_status text, p_text text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_slot uuid; v_norm text;
BEGIN
  IF p_status NOT IN ('done', 'empty', 'unsupported', 'too_large', 'failed') THEN RAISE EXCEPTION 'document_text_put: bad status'; END IF;
  SELECT slot_id INTO v_slot FROM public.document_files WHERE id = p_file;
  IF v_slot IS NULL THEN RETURN; END IF;
  v_norm := CASE WHEN p_status = 'done' THEN left(public.search_norm(coalesce(p_text, '')), 200000) ELSE '' END;
  INSERT INTO public.document_texts (file_id, slot_id, status, text_norm, chars, extracted_at)
  VALUES (p_file, v_slot, p_status, v_norm, length(v_norm), now())
  ON CONFLICT (file_id) DO UPDATE SET status = EXCLUDED.status, text_norm = EXCLUDED.text_norm, chars = EXCLUDED.chars, extracted_at = EXCLUDED.extracted_at;
END $$;

-- Settings > Documents > Search index: the counts, for a System Admin.
CREATE OR REPLACE FUNCTION document_text_status_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'search index: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'indexed', (SELECT count(*) FROM public.document_texts WHERE status = 'done'),
    'empty', (SELECT count(*) FROM public.document_texts WHERE status = 'empty'),
    'unsupported', (SELECT count(*) FROM public.document_texts WHERE status = 'unsupported'),
    'too_large', (SELECT count(*) FROM public.document_texts WHERE status = 'too_large'),
    'failed', (SELECT count(*) FROM public.document_texts WHERE status = 'failed'),
    'pending', (SELECT count(*) FROM public.document_files f JOIN public.stored_object_meta m ON m.storage_key = f.storage_key AND m.scan_status = 'clean'
                LEFT JOIN public.document_texts t ON t.file_id = f.id WHERE f.is_current AND f.storage_key IS NOT NULL AND t.file_id IS NULL),
    'last_extracted_at', (SELECT max(extracted_at) FROM public.document_texts));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['document_text_pending(integer)', 'document_text_put(uuid,text,text)', 'document_text_status_json()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION document_text_pending(integer), document_text_put(uuid, text, text), document_text_status_json() TO pmis_app;
    GRANT SELECT ON document_texts TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_texts FROM pmis_app;
  END IF;
  ALTER TABLE document_texts OWNER TO pmis_definer;
END $$;

-- Data reset coverage: data_reset_core stops (and the Settings reset refuses) on a table without a decision in data_reset_plan(). document_texts is the
-- search text of an uploaded file, so it goes with the documents part (DELETE). The stored function text is patched in place (idempotent), never rebuilt
-- from an old base, so every table and part added by other migrations stays.
DO $$
DECLARE def text; marker text := '(''document_site_overrides'', ''delete'', ''documents'', ''ARRAY[''''documents'''']''),';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('document_texts' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no document_site_overrides row to patch'; END IF;
    EXECUTE replace(def, marker, marker || ' (''document_texts'', ''delete'', ''documents'', ''ARRAY[''''documents'''']''),');
  END IF;
END $$;

-- the reset role reads every table and deletes the rows of a DELETE table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_reset_owner') THEN
    EXECUTE 'GRANT SELECT, DELETE ON public.document_texts TO pmis_reset_owner';
  END IF;
END $$;

-- The delete order of data_reset_core lists every table once. document_texts points at document_files, so it goes before it. Patched in place (idempotent).
DO $$
DECLARE r record; def text; marker text := '''document_files'', ''document_record_snapshots'',';
BEGIN
  FOR r IN SELECT oid FROM pg_proc WHERE proname = 'data_reset_core' AND pronamespace = 'public'::regnamespace LOOP
    def := pg_get_functiondef(r.oid);
    IF position('document_texts' IN def) = 0 AND position(marker IN def) > 0 THEN
      EXECUTE replace(def, marker, '''document_texts'', ' || marker);
    END IF;
  END LOOP;
END $$;
