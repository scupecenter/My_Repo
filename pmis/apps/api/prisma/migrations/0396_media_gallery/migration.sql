-- 0396_media_gallery: the settings of the central Media gallery (Library > Media, owner decision GAL-1, 2026-11-27).
-- Mirror: db/sql/395_media_gallery.sql (kept identical to prisma/migrations/0396_media_gallery/migration.sql).
--
-- The gallery has no storage and no table of its own: it reads document_files and snag_photos through the API with the rights of the owning slot.
-- What an admin may configure is one setting, media.gallery, changed only through admin_set_media_gallery:
--   enabled, snag_photos (QC snag photos), document_kinds (kinds of document type shown), register_keys (empty = every register),
--   include_site_documents (task and site slots), exclude_doc_codes, image_only, show_withdrawn, page_size, and
--   thumbnails {enabled, small_px, medium_px, quality, format webp|jpeg, max_source_mb}.
-- New sources are added by configuration (a kind, a register key, a document code), never by code.
--
-- Doors: media_gallery_state() (any signed-in user; drives the screen), admin_set_media_gallery(body, reason, version)
-- (System Admin or a delegate of settings edit for all regions, reason of 3+ characters, If-Match version, strict validation,
-- one audit row media_gallery_update with before and after). Additive: one setting, three functions, no table.

SELECT set_config('app.region_ids', '*', true);
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON register_definitions TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('media.gallery',
        '{"enabled": true, "snag_photos": true, "document_kinds": ["photo", "scanned_document"], "register_keys": [], "include_site_documents": true, "exclude_doc_codes": [], "image_only": true, "show_withdrawn": false, "page_size": 48, "thumbnails": {"enabled": true, "small_px": 240, "medium_px": 640, "quality": 78, "format": "webp", "max_source_mb": 50}}'::jsonb,
        'Owner decision GAL-1 (0396): the Media gallery settings. Changed only through admin_set_media_gallery.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_media_gallery ON settings;
DROP TRIGGER IF EXISTS b_settings_media_gallery_update ON settings;
DROP TRIGGER IF EXISTS b_settings_media_gallery_delete ON settings;
CREATE TRIGGER b_settings_media_gallery BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'media.gallery') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_media_gallery_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'media.gallery' OR NEW.key = 'media.gallery') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_media_gallery_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'media.gallery') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- The normaliser: strict = the write door (a bad value is a 422), lenient = the reader (a bad value reads as the default).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION media_gallery_normalize(p jsonb, p_strict boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d jsonb := '{"enabled": true, "snag_photos": true, "document_kinds": ["photo", "scanned_document"], "register_keys": [], "include_site_documents": true, "exclude_doc_codes": [], "image_only": true, "show_withdrawn": false, "page_size": 48, "thumbnails": {"enabled": true, "small_px": 240, "medium_px": 640, "quality": 78, "format": "webp", "max_source_mb": 50}}'::jsonb;
  t jsonb; td jsonb; k text; bad text; out jsonb := '{}'::jsonb; tout jsonb := '{}'::jsonb; x jsonb; arr jsonb; el jsonb; n numeric;
  kinds text[] := ARRAY['photo', 'scanned_document', 'email', 'report', 'excel_template'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    IF p_strict THEN PERFORM public.wfe_err1('/', 'invalid', 'The Media settings must be an object.'); END IF;
    RETURN d;
  END IF;
  IF p_strict THEN
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p) key
     WHERE key NOT IN ('enabled', 'snag_photos', 'document_kinds', 'register_keys', 'include_site_documents', 'exclude_doc_codes', 'image_only', 'show_withdrawn', 'page_size', 'thumbnails');
    IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  END IF;
  -- booleans
  FOREACH k IN ARRAY ARRAY['enabled', 'snag_photos', 'include_site_documents', 'image_only', 'show_withdrawn'] LOOP
    IF jsonb_typeof(p -> k) = 'boolean' THEN out := out || jsonb_build_object(k, p -> k);
    ELSIF p_strict THEN PERFORM public.wfe_err1('/' || k, 'invalid', format('%s is true or false.', k));
    ELSE out := out || jsonb_build_object(k, d -> k); END IF;
  END LOOP;
  -- page size
  IF jsonb_typeof(p -> 'page_size') = 'number' AND (p ->> 'page_size')::numeric = trunc((p ->> 'page_size')::numeric) AND (p ->> 'page_size')::numeric BETWEEN 12 AND 200 THEN
    out := out || jsonb_build_object('page_size', (p ->> 'page_size')::int);
  ELSIF p_strict THEN PERFORM public.wfe_err1('/page_size', 'invalid', 'The page size is a whole number from 12 to 200.');
  ELSE out := out || jsonb_build_object('page_size', 48); END IF;
  -- document kinds
  arr := '[]'::jsonb;
  IF jsonb_typeof(p -> 'document_kinds') = 'array' AND jsonb_array_length(p -> 'document_kinds') <= 5 THEN
    FOR el IN SELECT value FROM jsonb_array_elements(p -> 'document_kinds') LOOP
      IF jsonb_typeof(el) = 'string' AND (el #>> '{}') = ANY (kinds) AND NOT arr @> jsonb_build_array(el) THEN arr := arr || jsonb_build_array(el);
      ELSIF p_strict THEN PERFORM public.wfe_err1('/document_kinds', 'invalid', 'Each kind is photo, scanned_document, email, report or excel_template, once.'); END IF;
    END LOOP;
  ELSIF p_strict THEN PERFORM public.wfe_err1('/document_kinds', 'invalid', 'The document kinds are a list of at most 5 kinds.');
  ELSE arr := d -> 'document_kinds'; END IF;
  out := out || jsonb_build_object('document_kinds', arr);
  -- register keys (empty = every register)
  arr := '[]'::jsonb;
  IF jsonb_typeof(p -> 'register_keys') = 'array' AND jsonb_array_length(p -> 'register_keys') <= 60 THEN
    FOR el IN SELECT value FROM jsonb_array_elements(p -> 'register_keys') LOOP
      IF jsonb_typeof(el) = 'string' AND (el #>> '{}') ~ '^[a-z][a-z0-9_]{1,60}$' AND NOT arr @> jsonb_build_array(el)
         AND (NOT p_strict OR EXISTS (SELECT 1 FROM public.register_definitions r WHERE r.register_key = el #>> '{}')) THEN arr := arr || jsonb_build_array(el);
      ELSIF p_strict THEN PERFORM public.wfe_err1('/register_keys', 'invalid', 'Each register key must name an existing register, once.'); END IF;
    END LOOP;
  ELSIF p_strict THEN PERFORM public.wfe_err1('/register_keys', 'invalid', 'The register keys are a list of at most 60 registers (empty means every register).'); END IF;
  out := out || jsonb_build_object('register_keys', arr);
  -- excluded document codes
  arr := '[]'::jsonb;
  IF jsonb_typeof(p -> 'exclude_doc_codes') = 'array' AND jsonb_array_length(p -> 'exclude_doc_codes') <= 100 THEN
    FOR el IN SELECT value FROM jsonb_array_elements(p -> 'exclude_doc_codes') LOOP
      IF jsonb_typeof(el) = 'string' AND (el #>> '{}') ~ '^[A-Za-z0-9_-]{1,60}$' AND NOT arr @> jsonb_build_array(el) THEN arr := arr || jsonb_build_array(el);
      ELSIF p_strict THEN PERFORM public.wfe_err1('/exclude_doc_codes', 'invalid', 'Each excluded document code is 1 to 60 letters, digits, - or _, once.'); END IF;
    END LOOP;
  ELSIF p_strict THEN PERFORM public.wfe_err1('/exclude_doc_codes', 'invalid', 'The excluded codes are a list of at most 100 document codes.'); END IF;
  out := out || jsonb_build_object('exclude_doc_codes', arr);
  -- thumbnails
  t := p -> 'thumbnails'; td := d -> 'thumbnails';
  IF t IS NULL OR jsonb_typeof(t) <> 'object' THEN
    IF p_strict THEN PERFORM public.wfe_err1('/thumbnails', 'invalid', 'The thumbnail settings are an object.'); END IF;
    t := '{}'::jsonb;
  ELSIF p_strict THEN
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(t) key
     WHERE key NOT IN ('enabled', 'small_px', 'medium_px', 'quality', 'format', 'max_source_mb');
    IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/thumbnails', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  END IF;
  IF jsonb_typeof(t -> 'enabled') = 'boolean' THEN tout := tout || jsonb_build_object('enabled', t -> 'enabled');
  ELSIF p_strict THEN PERFORM public.wfe_err1('/thumbnails/enabled', 'invalid', 'Say whether thumbnails are made (true) or not (false).');
  ELSE tout := tout || jsonb_build_object('enabled', td -> 'enabled'); END IF;
  FOR k, x IN SELECT * FROM (VALUES ('small_px', '[64,512]'::jsonb), ('medium_px', '[128,2048]'::jsonb), ('quality', '[40,95]'::jsonb), ('max_source_mb', '[1,200]'::jsonb)) v(a, b) LOOP
    IF jsonb_typeof(t -> k) = 'number' AND (t ->> k)::numeric = trunc((t ->> k)::numeric) AND (t ->> k)::numeric BETWEEN (x ->> 0)::numeric AND (x ->> 1)::numeric THEN
      tout := tout || jsonb_build_object(k, (t ->> k)::int);
    ELSIF p_strict THEN PERFORM public.wfe_err1('/thumbnails/' || k, 'invalid', format('%s is a whole number from %s to %s.', k, x ->> 0, x ->> 1));
    ELSE tout := tout || jsonb_build_object(k, td -> k); END IF;
  END LOOP;
  IF (t ->> 'format') IN ('webp', 'jpeg') THEN tout := tout || jsonb_build_object('format', t -> 'format');
  ELSIF p_strict THEN PERFORM public.wfe_err1('/thumbnails/format', 'invalid', 'The thumbnail format is webp or jpeg.');
  ELSE tout := tout || jsonb_build_object('format', td -> 'format'); END IF;
  IF p_strict AND (tout ->> 'small_px')::int >= (tout ->> 'medium_px')::int THEN
    PERFORM public.wfe_err1('/thumbnails/small_px', 'invalid', 'The small size must be smaller than the medium size.');
  ELSIF (tout ->> 'small_px')::int >= (tout ->> 'medium_px')::int THEN
    tout := tout || jsonb_build_object('small_px', 240, 'medium_px', 640);
  END IF;
  RETURN out || jsonb_build_object('thumbnails', tout);
END $$;

CREATE OR REPLACE FUNCTION media_gallery_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.media_gallery_normalize((SELECT value FROM public.settings WHERE key = 'media.gallery'), false)
$$;

CREATE OR REPLACE FUNCTION media_gallery_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'media.gallery';
  RETURN public.media_gallery_cfg() || jsonb_build_object(
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('media.gallery'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_media_gallery(p_body jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; nxt jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  nxt := public.media_gallery_normalize(p_body, true);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('media.gallery', public.media_gallery_normalize(NULL, false), 'Owner decision GAL-1 (0396): the Media gallery settings. Changed only through admin_set_media_gallery.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'media.gallery' FOR UPDATE;
  cur := public.media_gallery_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('media.gallery') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur = nxt THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the Media settings.'));
  END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'media.gallery';
  res := public.media_gallery_state();
  PERFORM public.log_audit_write('media_gallery_update', 'setting', 'media.gallery', cur, public.media_gallery_cfg(), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['media_gallery_normalize(jsonb,boolean)', 'media_gallery_cfg()', 'media_gallery_state()', 'admin_set_media_gallery(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION media_gallery_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_media_gallery(jsonb, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION media_gallery_normalize(jsonb, boolean) FROM pmis_app;
    REVOKE ALL ON FUNCTION media_gallery_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('media_gallery_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'media.gallery', 'read', 'media_gallery_state', 'write', 'admin_set_media_gallery', 'audit', jsonb_build_array('media_gallery_update')),
        'Owner decision GAL-1, 2026-11-27: the central Media gallery settings, edited from Settings > Documents > Media (migration 0396).');
