-- 0477_media_geotag: where a photo was taken, and panorama and drone files (Media gallery; contract 0.15.539).
-- Mirror: db/sql/476_media_geotag.sql (kept identical to prisma/migrations/0477_media_geotag/migration.sql).
--
-- Additive: one derived table, one setting, six functions. No existing table or function changes.
--   media_geo: one row per scanned image (a document file or a QC snag photo): the GPS point read from the file (EXIF) or, for a snag photo without one,
--     the device point the in-app camera sent (source device), the capture time, the altitude, and the kind of media (photo, panorama, drone). It is derived
--     data, like document_texts: the file stays the evidence, nothing is edited, and a row goes when its file row goes (ON DELETE CASCADE).
--   Row level security: a row is visible only when its file or photo is (the same policies as document_files and snag_photos).
--   Written only by the definer doors below: media_geo_put (the uploader of the file, or a settings admin) and, for old files, media_geo_pending +
--     media_geo_put by an admin scan. The distance to the site and the far flag are computed when read, from sites.latitude and longitude and the setting.
--   Setting media.geotag (Settings > Documents > Media): enabled, max_distance_m, flag_missing, panorama, panorama_min_ratio, panorama_min_width_px,
--     drone_makes. Changed only through admin_set_media_geo (System Admin or a delegate of settings edit for all regions, a reason, If-Match, strict
--     validation, one audit row media_geo_update); read by media_geo_state() (any signed-in user).

SELECT set_config('app.region_ids', '*', true);
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

CREATE TABLE IF NOT EXISTS media_geo (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_file_id    uuid UNIQUE REFERENCES document_files (id) ON DELETE CASCADE,
  snag_photo_id  uuid UNIQUE REFERENCES snag_photos (id) ON DELETE CASCADE,
  lat            numeric(9,6),
  lon            numeric(9,6),
  alt_m          numeric(8,1),
  taken_at       timestamptz,
  source         text NOT NULL CHECK (source IN ('exif', 'device', 'none')),
  media_kind     text NOT NULL DEFAULT 'photo' CHECK (media_kind IN ('photo', 'panorama', 'drone')),
  make           text,
  model          text,
  width_px       integer CHECK (width_px IS NULL OR width_px > 0),
  height_px      integer CHECK (height_px IS NULL OR height_px > 0),
  scanned_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((doc_file_id IS NULL) <> (snag_photo_id IS NULL)),
  CHECK ((lat IS NULL) = (lon IS NULL)),
  CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180)),
  CHECK ((source = 'none') = (lat IS NULL))
);
COMMENT ON TABLE media_geo IS 'Contract 0.15.539: the GPS point, the capture time and the media kind (photo, panorama, drone) read from an image file. Derived and rebuildable; the file stays the evidence.';

ALTER TABLE media_geo ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_geo FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON media_geo;
CREATE POLICY rls_select ON media_geo FOR SELECT
  USING ((doc_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM document_files f WHERE f.id = doc_file_id))
      OR (snag_photo_id IS NOT NULL AND EXISTS (SELECT 1 FROM snag_photos p WHERE p.id = snag_photo_id)));
-- No insert, update or delete policy: only the definer functions below (BYPASSRLS owner) write.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('media.geotag',
        '{"enabled": true, "max_distance_m": 1000, "flag_missing": false, "panorama": true, "panorama_min_ratio": 2.0, "panorama_min_width_px": 3000, "drone_makes": ["DJI", "Autel", "Parrot", "Skydio"]}'::jsonb,
        'Media geotag (0477): the far-from-site distance, panorama detection and drone makers. Changed only through admin_set_media_geo.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_media_geo ON settings;
DROP TRIGGER IF EXISTS b_settings_media_geo_update ON settings;
DROP TRIGGER IF EXISTS b_settings_media_geo_delete ON settings;
CREATE TRIGGER b_settings_media_geo BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'media.geotag') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_media_geo_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'media.geotag' OR NEW.key = 'media.geotag') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_media_geo_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'media.geotag') EXECUTE FUNCTION settings_guarded_keys();

-- strict = the write door (a bad value is a 422), lenient = the reader (a bad value reads as the default).
CREATE OR REPLACE FUNCTION media_geo_normalize(p jsonb, p_strict boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d jsonb := '{"enabled": true, "max_distance_m": 1000, "flag_missing": false, "panorama": true, "panorama_min_ratio": 2.0, "panorama_min_width_px": 3000, "drone_makes": ["DJI", "Autel", "Parrot", "Skydio"]}'::jsonb;
  bad text; out jsonb := '{}'::jsonb; k text; arr jsonb := '[]'::jsonb; el jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    IF p_strict THEN PERFORM public.wfe_err1('/', 'invalid', 'The geotag settings must be an object.'); END IF;
    RETURN d;
  END IF;
  IF p_strict THEN
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p) key
     WHERE key NOT IN ('enabled', 'max_distance_m', 'flag_missing', 'panorama', 'panorama_min_ratio', 'panorama_min_width_px', 'drone_makes');
    IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  END IF;
  FOREACH k IN ARRAY ARRAY['enabled', 'flag_missing', 'panorama'] LOOP
    IF jsonb_typeof(p -> k) = 'boolean' THEN out := out || jsonb_build_object(k, p -> k);
    ELSIF p_strict THEN PERFORM public.wfe_err1('/' || k, 'invalid', format('%s is true or false.', k));
    ELSE out := out || jsonb_build_object(k, d -> k); END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'max_distance_m') = 'number' AND (p ->> 'max_distance_m')::numeric = trunc((p ->> 'max_distance_m')::numeric) AND (p ->> 'max_distance_m')::numeric BETWEEN 50 AND 100000 THEN
    out := out || jsonb_build_object('max_distance_m', (p ->> 'max_distance_m')::int);
  ELSIF p_strict THEN PERFORM public.wfe_err1('/max_distance_m', 'invalid', 'max_distance_m is a whole number of metres from 50 to 100000.');
  ELSE out := out || jsonb_build_object('max_distance_m', 1000); END IF;
  IF jsonb_typeof(p -> 'panorama_min_ratio') = 'number' AND (p ->> 'panorama_min_ratio')::numeric BETWEEN 1.5 AND 4 THEN
    out := out || jsonb_build_object('panorama_min_ratio', round((p ->> 'panorama_min_ratio')::numeric, 2));
  ELSIF p_strict THEN PERFORM public.wfe_err1('/panorama_min_ratio', 'invalid', 'panorama_min_ratio is the width over the height, from 1.5 to 4.');
  ELSE out := out || jsonb_build_object('panorama_min_ratio', 2.0); END IF;
  IF jsonb_typeof(p -> 'panorama_min_width_px') = 'number' AND (p ->> 'panorama_min_width_px')::numeric = trunc((p ->> 'panorama_min_width_px')::numeric) AND (p ->> 'panorama_min_width_px')::numeric BETWEEN 1000 AND 30000 THEN
    out := out || jsonb_build_object('panorama_min_width_px', (p ->> 'panorama_min_width_px')::int);
  ELSIF p_strict THEN PERFORM public.wfe_err1('/panorama_min_width_px', 'invalid', 'panorama_min_width_px is a whole number from 1000 to 30000.');
  ELSE out := out || jsonb_build_object('panorama_min_width_px', 3000); END IF;
  IF jsonb_typeof(p -> 'drone_makes') = 'array' AND jsonb_array_length(p -> 'drone_makes') <= 20 THEN
    FOR el IN SELECT value FROM jsonb_array_elements(p -> 'drone_makes') LOOP
      IF jsonb_typeof(el) = 'string' AND (el #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$' AND NOT arr @> jsonb_build_array(el) THEN arr := arr || jsonb_build_array(el);
      ELSIF p_strict THEN PERFORM public.wfe_err1('/drone_makes', 'invalid', 'Each maker is 1 to 40 letters, digits, spaces, dots, dashes or underscores, once.'); END IF;
    END LOOP;
  ELSIF p_strict THEN PERFORM public.wfe_err1('/drone_makes', 'invalid', 'drone_makes is a list of up to 20 makers.');
  ELSE arr := d -> 'drone_makes'; END IF;
  RETURN out || jsonb_build_object('drone_makes', arr);
END $$;

CREATE OR REPLACE FUNCTION media_geo_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.media_geo_normalize((SELECT value FROM public.settings WHERE key = 'media.geotag'), false)
$$;

CREATE OR REPLACE FUNCTION media_geo_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'media.geotag';
  RETURN public.media_geo_cfg() || jsonb_build_object(
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('media.geotag'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_media_geo(p_body jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; nxt jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  nxt := public.media_geo_normalize(p_body, true);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('media.geotag', public.media_geo_normalize(NULL, false), 'Media geotag (0477). Changed only through admin_set_media_geo.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'media.geotag' FOR UPDATE;
  cur := public.media_geo_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('media.geotag') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur = nxt THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the geotag settings.'));
  END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'media.geotag';
  res := public.media_geo_state();
  PERFORM public.log_audit_write('media_geo_update', 'setting', 'media.geotag', cur, public.media_geo_cfg(), btrim(p_reason));
  RETURN res;
END $$;

-- One scanned image. p_meta: lat, lon, alt_m, taken_at, source (exif, device, none), media_kind, make, model, width_px, height_px. A bad value is dropped,
-- never an error (the file is already stored; a scan must not fail an upload). The uploader of the file writes the first row; a settings admin
-- (all regions) writes or replaces any row (the scan of older files).
CREATE OR REPLACE FUNCTION media_geo_put(p_kind text, p_id uuid, p_meta jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); admin boolean; owner uuid;
  la numeric; lo numeric; al numeric; src text; kind text; ta timestamptz; w int; h int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  admin := public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL;
  IF p_kind = 'document_file' THEN SELECT uploaded_by INTO owner FROM public.document_files WHERE id = p_id;
  ELSIF p_kind = 'snag_photo' THEN SELECT uploaded_by INTO owner FROM public.snag_photos WHERE id = p_id;
  ELSE RAISE EXCEPTION 'unknown media kind' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT admin AND (owner IS DISTINCT FROM actor OR EXISTS (SELECT 1 FROM public.media_geo g WHERE g.doc_file_id = p_id OR g.snag_photo_id = p_id)) THEN
    RAISE EXCEPTION 'not allowed to write the location of this file' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_meta -> 'lat') = 'number' AND jsonb_typeof(p_meta -> 'lon') = 'number'
     AND (p_meta ->> 'lat')::numeric BETWEEN -90 AND 90 AND (p_meta ->> 'lon')::numeric BETWEEN -180 AND 180
     AND NOT ((p_meta ->> 'lat')::numeric = 0 AND (p_meta ->> 'lon')::numeric = 0) THEN
    la := round((p_meta ->> 'lat')::numeric, 6); lo := round((p_meta ->> 'lon')::numeric, 6);
  END IF;
  IF jsonb_typeof(p_meta -> 'alt_m') = 'number' AND (p_meta ->> 'alt_m')::numeric BETWEEN -500 AND 99999 THEN al := round((p_meta ->> 'alt_m')::numeric, 1); END IF;
  src := CASE WHEN la IS NULL THEN 'none' WHEN p_meta ->> 'source' = 'device' THEN 'device' ELSE 'exif' END;
  kind := CASE WHEN p_meta ->> 'media_kind' IN ('panorama', 'drone') THEN p_meta ->> 'media_kind' ELSE 'photo' END;
  IF jsonb_typeof(p_meta -> 'taken_at') = 'string' AND (p_meta ->> 'taken_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
    BEGIN ta := (p_meta ->> 'taken_at')::timestamptz; EXCEPTION WHEN others THEN ta := NULL; END;
  END IF;
  IF jsonb_typeof(p_meta -> 'width_px') = 'number' AND (p_meta ->> 'width_px')::numeric BETWEEN 1 AND 200000 THEN w := (p_meta ->> 'width_px')::numeric::int; END IF;
  IF jsonb_typeof(p_meta -> 'height_px') = 'number' AND (p_meta ->> 'height_px')::numeric BETWEEN 1 AND 200000 THEN h := (p_meta ->> 'height_px')::numeric::int; END IF;
  IF p_kind = 'document_file' THEN
    INSERT INTO public.media_geo (doc_file_id, lat, lon, alt_m, taken_at, source, media_kind, make, model, width_px, height_px, scanned_at)
    VALUES (p_id, la, lo, al, ta, src, kind, left(p_meta ->> 'make', 40), left(p_meta ->> 'model', 60), w, h, clock_timestamp())
    ON CONFLICT (doc_file_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, alt_m = EXCLUDED.alt_m, taken_at = EXCLUDED.taken_at, source = EXCLUDED.source,
      media_kind = EXCLUDED.media_kind, make = EXCLUDED.make, model = EXCLUDED.model, width_px = EXCLUDED.width_px, height_px = EXCLUDED.height_px, scanned_at = EXCLUDED.scanned_at;
  ELSE
    INSERT INTO public.media_geo (snag_photo_id, lat, lon, alt_m, taken_at, source, media_kind, make, model, width_px, height_px, scanned_at)
    VALUES (p_id, la, lo, al, ta, src, kind, left(p_meta ->> 'make', 40), left(p_meta ->> 'model', 60), w, h, clock_timestamp())
    ON CONFLICT (snag_photo_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, alt_m = EXCLUDED.alt_m, taken_at = EXCLUDED.taken_at, source = EXCLUDED.source,
      media_kind = EXCLUDED.media_kind, make = EXCLUDED.make, model = EXCLUDED.model, width_px = EXCLUDED.width_px, height_px = EXCLUDED.height_px, scanned_at = EXCLUDED.scanned_at;
  END IF;
END $$;

-- Images that have no row yet (not withdrawn, not rejected), oldest first, for the admin scan. A snag photo brings the device point of the in-app camera.
CREATE OR REPLACE FUNCTION media_geo_pending(p_limit integer) RETURNS TABLE (kind text, id uuid, storage_key text, mime_type text, size_bytes bigint, device_lat numeric, device_lon numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  RETURN QUERY
  SELECT x.k, x.i, x.sk, x.mt, x.sz, x.dlat, x.dlon FROM (
    SELECT 'document_file'::text AS k, f.id AS i, f.storage_key AS sk, f.mime_type AS mt, f.size_bytes AS sz, NULL::numeric AS dlat, NULL::numeric AS dlon, f.uploaded_at AS at
      FROM public.document_files f LEFT JOIN public.media_geo g ON g.doc_file_id = f.id
     WHERE g.id IS NULL AND f.withdrawn_at IS NULL AND f.is_current AND f.mime_type LIKE 'image/%' AND f.storage_key IS NOT NULL
    UNION ALL
    SELECT 'snag_photo'::text, p.id, p.storage_key, p.mime_type, p.size_bytes, p.device_lat, p.device_lon, p.uploaded_at
      FROM public.snag_photos p LEFT JOIN public.media_geo g ON g.snag_photo_id = p.id
     WHERE g.id IS NULL AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.mime_type LIKE 'image/%' AND p.storage_key IS NOT NULL
  ) x ORDER BY x.at, x.i LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
END $$;

CREATE OR REPLACE FUNCTION media_geo_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('settings', false);
  RETURN jsonb_build_object(
    'scanned', (SELECT count(*) FROM public.media_geo),
    'with_location', (SELECT count(*) FROM public.media_geo WHERE lat IS NOT NULL),
    'panorama', (SELECT count(*) FROM public.media_geo WHERE media_kind = 'panorama'),
    'drone', (SELECT count(*) FROM public.media_geo WHERE media_kind = 'drone'),
    'pending', (SELECT count(*) FROM public.document_files f LEFT JOIN public.media_geo g ON g.doc_file_id = f.id
                 WHERE g.id IS NULL AND f.withdrawn_at IS NULL AND f.is_current AND f.mime_type LIKE 'image/%' AND f.storage_key IS NOT NULL)
              + (SELECT count(*) FROM public.snag_photos p LEFT JOIN public.media_geo g ON g.snag_photo_id = p.id
                 WHERE g.id IS NULL AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.mime_type LIKE 'image/%' AND p.storage_key IS NOT NULL),
    'last_scanned_at', (SELECT max(scanned_at) FROM public.media_geo));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['media_geo_normalize(jsonb,boolean)', 'media_geo_cfg()', 'media_geo_state()', 'admin_set_media_geo(jsonb,text,integer)', 'media_geo_put(text,uuid,jsonb)',
                           'media_geo_pending(integer)', 'media_geo_status()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION media_geo_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_media_geo(jsonb, text, integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION media_geo_put(text, uuid, jsonb) TO pmis_app;
    GRANT EXECUTE ON FUNCTION media_geo_pending(integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION media_geo_status() TO pmis_app;
    REVOKE ALL ON FUNCTION media_geo_normalize(jsonb, boolean) FROM pmis_app;
    REVOKE ALL ON FUNCTION media_geo_cfg() FROM pmis_app;
    GRANT SELECT ON media_geo TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON media_geo FROM pmis_app;
  END IF;
  ALTER TABLE media_geo OWNER TO pmis_definer;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('media_geo_applied', 'workflow', NULL,
        jsonb_build_object('table', 'media_geo', 'setting', 'media.geotag', 'read', 'media_geo_state', 'write', 'admin_set_media_geo', 'audit', jsonb_build_array('media_geo_update')),
        'Media geotag: the photo location, the far-from-site flag and the panorama and drone kinds, set from Settings > Documents > Media (migration 0477).');

-- Data reset coverage (0152): data_reset_core stops on a table without a decision in data_reset_plan(). media_geo is derived from the files, so it goes
-- with them (DELETE; the documents part for a document file, the quality part for a snag photo). The stored function text is patched in place
-- (idempotent), never rebuilt from an old base. A row also goes with its file by ON DELETE CASCADE.
DO $$
DECLARE def text; marker text := '(''document_site_overrides'', ''delete'', ''documents'', ''ARRAY[''''documents'''']''),';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('media_geo' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no document_site_overrides row to patch'; END IF;
    EXECUTE replace(def, marker, marker || ' (''media_geo'', ''delete'', ''*'', ''CASE WHEN t.snag_photo_id IS NOT NULL THEN ARRAY[''''quality''''] ELSE ARRAY[''''documents''''] END''),');
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_reset_owner') THEN
    EXECUTE 'GRANT SELECT, DELETE ON public.media_geo TO pmis_reset_owner';
  END IF;
END $$;

-- The delete order of data_reset_core lists every table once. media_geo points at document_files and snag_photos, so it goes before document_files.
DO $$
DECLARE r record; def text; marker text := '''document_files'', ''document_record_snapshots'',';
BEGIN
  FOR r IN SELECT oid FROM pg_proc WHERE proname = 'data_reset_core' AND pronamespace = 'public'::regnamespace LOOP
    def := pg_get_functiondef(r.oid);
    IF position('media_geo' IN def) = 0 AND position(marker IN def) > 0 THEN
      EXECUTE replace(def, marker, '''media_geo'', ' || marker);
    END IF;
  END LOOP;
END $$;
