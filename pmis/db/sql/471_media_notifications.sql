-- 0472_media_notifications: notices for the Media gallery, through the existing notification mechanism (the notifications table, its policy gate, the personal
-- settings, the bell and the e-mail rules); nothing is added to the notification engine and no table is created.
--   1. New photo on a followed site: the follow store is the existing one (watches, entity_type 'site'; Follow button). The kind is the existing followed_change.
--      A trigger on document_files tells each follower (not the person who uploaded) who can still read the slot: the site's region scope, or the register's module
--      for a register slot. It follows the gallery's own rules: the media.gallery switches, the document kinds, the registers and the excluded codes, images only.
--   2. Photos below the minimum: media_notify_tick() runs in the hourly notification step (jobs.service, same transaction and lock as notif_policy_tick). A photo slot
--      (document type kind photo, min_files) that is still below its minimum after min_photos_after_hours is counted per site; the record owner (the ball in court of
--      the task, or the creator of the register record) and the Team Leads of the region (notif_escalation_targets) get one notice per site. The same site is told
--      again only after min_photos_repeat_days. Kind system (a kind the policy does not govern); the title and body say what it is.
--   3. Export ready: a trigger on document_export_jobs when a media export (scope.kind = media_export) turns done tells the person who asked.
--   Settings: media.gallery gets notify_new_photo, notify_min_photos, notify_export_ready (default on), min_photos_after_hours (1 to 720, default 24) and
--   min_photos_repeat_days (1 to 90, default 7), edited in Settings > Documents > Media through admin_set_media_gallery (reason, step-up, audit, version).
-- Additive and safe to repeat. A stored value without the new keys reads as the defaults (lenient reader); a write that leaves them out keeps the defaults.
-- Mirror: db/sql/471_media_notifications.sql (kept identical to prisma/migrations/0472_media_notifications/migration.sql).

GRANT SELECT ON watches, document_slots, document_files, document_types, document_export_jobs, sites, register_definitions, register_records, task_instances, users TO pmis_definer;
GRANT SELECT, INSERT ON notifications TO pmis_definer;

CREATE OR REPLACE FUNCTION media_gallery_normalize(p jsonb, p_strict boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d jsonb := '{"enabled": true, "snag_photos": true, "document_kinds": ["photo", "scanned_document"], "register_keys": [], "include_site_documents": true, "exclude_doc_codes": [], "image_only": true, "show_withdrawn": false, "page_size": 48, "export_max_mb": 500, "notify_new_photo": true, "notify_min_photos": true, "notify_export_ready": true, "min_photos_after_hours": 24, "min_photos_repeat_days": 7, "thumbnails": {"enabled": true, "small_px": 240, "medium_px": 640, "quality": 78, "format": "webp", "max_source_mb": 50}}'::jsonb;
  t jsonb; td jsonb; k text; bad text; out jsonb := '{}'::jsonb; tout jsonb := '{}'::jsonb; x jsonb; arr jsonb; el jsonb; n numeric;
  kinds text[] := ARRAY['photo', 'scanned_document', 'email', 'report', 'excel_template'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    IF p_strict THEN PERFORM public.wfe_err1('/', 'invalid', 'The Media settings must be an object.'); END IF;
    RETURN d;
  END IF;
  IF p_strict THEN
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p) key
     WHERE key NOT IN ('enabled', 'snag_photos', 'document_kinds', 'register_keys', 'include_site_documents', 'exclude_doc_codes', 'image_only', 'show_withdrawn', 'page_size', 'export_max_mb', 'notify_new_photo', 'notify_min_photos', 'notify_export_ready', 'min_photos_after_hours', 'min_photos_repeat_days', 'thumbnails');
    IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  END IF;
  -- booleans
  FOREACH k IN ARRAY ARRAY['enabled', 'snag_photos', 'include_site_documents', 'image_only', 'show_withdrawn', 'notify_new_photo', 'notify_min_photos', 'notify_export_ready'] LOOP
    IF jsonb_typeof(p -> k) = 'boolean' THEN out := out || jsonb_build_object(k, p -> k);
    ELSIF p_strict AND NOT (k LIKE 'notify\_%' AND NOT p ? k) THEN PERFORM public.wfe_err1('/' || k, 'invalid', format('%s is true or false.', k));
    ELSE out := out || jsonb_build_object(k, d -> k); END IF;
  END LOOP;
  -- page size
  IF jsonb_typeof(p -> 'page_size') = 'number' AND (p ->> 'page_size')::numeric = trunc((p ->> 'page_size')::numeric) AND (p ->> 'page_size')::numeric BETWEEN 12 AND 200 THEN
    out := out || jsonb_build_object('page_size', (p ->> 'page_size')::int);
  ELSIF p_strict THEN PERFORM public.wfe_err1('/page_size', 'invalid', 'The page size is a whole number from 12 to 200.');
  ELSE out := out || jsonb_build_object('page_size', 48); END IF;
  -- size cap of an export of a selection, in MB
  IF jsonb_typeof(p -> 'export_max_mb') = 'number' AND (p ->> 'export_max_mb')::numeric = trunc((p ->> 'export_max_mb')::numeric) AND (p ->> 'export_max_mb')::numeric BETWEEN 10 AND 5000 THEN
    out := out || jsonb_build_object('export_max_mb', (p ->> 'export_max_mb')::int);
  ELSIF p_strict AND p ? 'export_max_mb' THEN PERFORM public.wfe_err1('/export_max_mb', 'invalid', 'The export size limit is a whole number of MB from 10 to 5000.');
  ELSE out := out || jsonb_build_object('export_max_mb', 500); END IF;
  -- when a photo slot counts as late, and how often the same site is told again
  FOR k, x IN SELECT * FROM (VALUES ('min_photos_after_hours', '[1,720]'::jsonb), ('min_photos_repeat_days', '[1,90]'::jsonb)) v(a, b) LOOP
    IF jsonb_typeof(p -> k) = 'number' AND (p ->> k)::numeric = trunc((p ->> k)::numeric) AND (p ->> k)::numeric BETWEEN (x ->> 0)::numeric AND (x ->> 1)::numeric THEN
      out := out || jsonb_build_object(k, (p ->> k)::int);
    ELSIF p_strict AND p ? k THEN PERFORM public.wfe_err1('/' || k, 'invalid', format('%s is a whole number from %s to %s.', k, x ->> 0, x ->> 1));
    ELSE out := out || jsonb_build_object(k, (d ->> k)::int); END IF;
  END LOOP;
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

-- 1: a new photo on a followed site.
CREATE OR REPLACE FUNCTION media_notify_new_photo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cfg jsonb; s public.document_slots%ROWTYPE; dt public.document_types%ROWTYPE; modk text; u uuid; code text;
BEGIN
  IF NEW.is_current IS NOT TRUE OR NEW.withdrawn_at IS NOT NULL OR NEW.mime_type NOT LIKE 'image/%' THEN RETURN NULL; END IF;
  cfg := public.media_gallery_cfg();
  IF coalesce((cfg ->> 'enabled')::boolean, false) IS NOT TRUE OR coalesce((cfg ->> 'notify_new_photo')::boolean, false) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = NEW.slot_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO dt FROM public.document_types WHERE id = s.doc_type_id;
  IF dt.form_kind IS NOT NULL OR NOT (dt.kind::text IN (SELECT jsonb_array_elements_text(cfg -> 'document_kinds'))) THEN RETURN NULL; END IF;
  IF dt.code IN (SELECT jsonb_array_elements_text(cfg -> 'exclude_doc_codes')) THEN RETURN NULL; END IF;
  IF s.register_key IS NULL THEN
    IF coalesce((cfg ->> 'include_site_documents')::boolean, true) IS NOT TRUE THEN RETURN NULL; END IF;
  ELSIF jsonb_array_length(cfg -> 'register_keys') > 0 AND NOT (s.register_key IN (SELECT jsonb_array_elements_text(cfg -> 'register_keys'))) THEN RETURN NULL;
  END IF;
  SELECT rd.module_key INTO modk FROM public.register_definitions rd WHERE rd.register_key = s.register_key;
  SELECT si.site_code INTO code FROM public.sites si WHERE si.id = s.site_id;
  FOR u IN SELECT DISTINCT w.user_id FROM public.watches w
           WHERE w.entity_type = 'site' AND w.entity_id = s.site_id AND w.user_id IS DISTINCT FROM NEW.uploaded_by LOOP
    IF (s.register_key IS NULL AND public.wf_user_in_scope(u, s.region_id)) OR (s.register_key IS NOT NULL AND modk IS NOT NULL AND public.reg_user_in_scope(u, s.region_id, modk)) THEN
      INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
      VALUES (u, 'in_app', 'followed_change', 'New photo on a followed site', coalesce(code, '') || ' / ' || dt.name_en, '/library/media?q=' || coalesce(code, ''));
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS media_notify_new_photo ON document_files;
CREATE TRIGGER media_notify_new_photo AFTER INSERT ON document_files FOR EACH ROW EXECUTE FUNCTION media_notify_new_photo();

-- 2: photo slots below their minimum, once per site and person inside the repeat window. Returns the number of notices written.
CREATE OR REPLACE FUNCTION media_notify_tick() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cfg jsonb; hrs integer; rep integer; n integer := 0;
BEGIN
  cfg := public.media_gallery_cfg();
  IF coalesce((cfg ->> 'enabled')::boolean, false) IS NOT TRUE OR coalesce((cfg ->> 'notify_min_photos')::boolean, false) IS NOT TRUE THEN RETURN 0; END IF;
  hrs := coalesce((cfg ->> 'min_photos_after_hours')::integer, 24); rep := coalesce((cfg ->> 'min_photos_repeat_days')::integer, 7);
  WITH late AS (
    SELECT s.id AS slot_id, s.site_id, s.region_id, s.task_id, s.register_entity_id, t.ball_in_court_user_id
    FROM public.document_slots s
    JOIN public.document_types dt ON dt.id = s.doc_type_id
    LEFT JOIN public.task_instances t ON t.id = s.task_id
    WHERE dt.kind::text = 'photo' AND dt.form_kind IS NULL AND dt.is_mandatory
      AND NOT (dt.code IN (SELECT jsonb_array_elements_text(cfg -> 'exclude_doc_codes')))
      AND s.status IN ('missing', 'uploaded', 'rejected')
      AND s.created_at < now() - make_interval(hours => hrs)
      AND (t.id IS NULL OR (NOT t.is_na AND t.state::text <> 'locked'))
      AND (SELECT count(*) FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current AND f.withdrawn_at IS NULL AND f.mime_type LIKE 'image/%') < dt.min_files
  ), who AS (
    SELECT l.site_id, l.region_id, l.slot_id, l.ball_in_court_user_id AS uid FROM late l
    UNION
    SELECT l.site_id, l.region_id, l.slot_id, (SELECT r.created_by FROM public.register_records r WHERE r.entity_id = l.register_entity_id ORDER BY r.is_current DESC, r.version_no DESC LIMIT 1)
    FROM late l WHERE l.register_entity_id IS NOT NULL
    UNION
    SELECT l.site_id, l.region_id, l.slot_id, e.user_id FROM late l CROSS JOIN LATERAL public.notif_escalation_targets(l.region_id) e
  ), per AS (
    SELECT w.uid, w.site_id, w.region_id, count(DISTINCT w.slot_id)::int AS slots
    FROM who w JOIN public.users u ON u.id = w.uid AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
    WHERE w.uid IS NOT NULL AND public.wf_user_in_scope(w.uid, w.region_id)
    GROUP BY w.uid, w.site_id, w.region_id
  )
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT p.uid, 'in_app', 'system', 'Photos below the minimum at ' || si.site_code,
         p.slots || ' photo slot(s) of this site have fewer photos than their minimum.', '/library/media?q=' || si.site_code
  FROM per p JOIN public.sites si ON si.id = p.site_id
  WHERE NOT EXISTS (SELECT 1 FROM public.notifications x WHERE x.user_id = p.uid AND x.kind = 'system' AND x.title = 'Photos below the minimum at ' || si.site_code
                    AND x.created_at > now() - make_interval(days => rep));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- 3: a media export is ready.
CREATE OR REPLACE FUNCTION media_notify_export_ready() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cfg jsonb;
BEGIN
  IF NEW.status <> 'done' OR OLD.status = 'done' OR coalesce(NEW.scope ->> 'kind', '') <> 'media_export' THEN RETURN NULL; END IF;
  cfg := public.media_gallery_cfg();
  IF coalesce((cfg ->> 'notify_export_ready')::boolean, false) IS NOT TRUE THEN RETURN NULL; END IF;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (NEW.requested_by, 'in_app', 'system', 'Your photo export is ready', coalesce(NEW.file_count, 0) || ' file(s). It is kept until it expires.', '/library/media?export=' || NEW.id::text);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS media_notify_export_ready ON document_export_jobs;
CREATE TRIGGER media_notify_export_ready AFTER UPDATE OF status ON document_export_jobs FOR EACH ROW EXECUTE FUNCTION media_notify_export_ready();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION media_notify_tick() TO pmis_app;
    REVOKE ALL ON FUNCTION media_notify_new_photo() FROM pmis_app;
    REVOKE ALL ON FUNCTION media_notify_export_ready() FROM pmis_app;
  END IF;
END $$;
