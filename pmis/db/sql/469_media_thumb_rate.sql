-- 0470_media_thumb_rate: SEC-2 of the security review, a per-user limit on thumbnail generation (Settings > Documents > Media, setting media.gallery).
-- Mirror: db/sql/469_media_thumb_rate.sql (kept identical to prisma/migrations/0470_media_thumb_rate/migration.sql).
--
-- One new key in the existing setting, thumbnails.rate_per_min: how many thumbnails one person may make per minute (10 to 2000, default 240).
-- Only the making of a thumbnail counts; a thumbnail already kept beside the original is served without counting. Above the limit the API answers
-- 429 rate_limited with Retry-After and the gallery shows the type icon until the next minute.
-- Additive: the normaliser is replaced with the same body plus the key, so a stored value without the key reads as the default (no data change,
-- the setting row is untouched). Doors, grants and the audit action are unchanged.

CREATE OR REPLACE FUNCTION media_gallery_normalize(p jsonb, p_strict boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d jsonb := '{"enabled": true, "snag_photos": true, "document_kinds": ["photo", "scanned_document"], "register_keys": [], "include_site_documents": true, "exclude_doc_codes": [], "image_only": true, "show_withdrawn": false, "page_size": 48, "thumbnails": {"enabled": true, "small_px": 240, "medium_px": 640, "quality": 78, "format": "webp", "max_source_mb": 50, "rate_per_min": 240}}'::jsonb;
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
     WHERE key NOT IN ('enabled', 'small_px', 'medium_px', 'quality', 'format', 'max_source_mb', 'rate_per_min');
    IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/thumbnails', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  END IF;
  IF jsonb_typeof(t -> 'enabled') = 'boolean' THEN tout := tout || jsonb_build_object('enabled', t -> 'enabled');
  ELSIF p_strict THEN PERFORM public.wfe_err1('/thumbnails/enabled', 'invalid', 'Say whether thumbnails are made (true) or not (false).');
  ELSE tout := tout || jsonb_build_object('enabled', td -> 'enabled'); END IF;
  FOR k, x IN SELECT * FROM (VALUES ('small_px', '[64,512]'::jsonb), ('medium_px', '[128,2048]'::jsonb), ('quality', '[40,95]'::jsonb), ('max_source_mb', '[1,200]'::jsonb), ('rate_per_min', '[10,2000]'::jsonb)) v(a, b) LOOP
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

ALTER FUNCTION media_gallery_normalize(jsonb, boolean) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION media_gallery_normalize(jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_gallery_normalize(jsonb, boolean) TO pmis_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON FUNCTION media_gallery_normalize(jsonb, boolean) FROM pmis_app;
  END IF;
END $$;
