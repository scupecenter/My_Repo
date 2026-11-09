-- 0081_nav_layout: the editable side menu (owner request of 2026-11-09; docs/spec/technical-decisions-2026-11-04.md, "Decided 2026-11-09: editable side menu").
-- Contract 0.15.1, CHANGELOG 119. Mirror: db/sql/080_nav_layout.sql (kept byte-identical).
--
-- WHAT. One shared order of the side menu for everyone: main headings, sub-headings (one level under a main heading) and the existing screens in them. It is kept in
-- the setting nav.layout (jsonb) and edited on the main screen by a System Admin or a delegate of `settings` edit for all regions (the rule of the calendar
-- confirmation of 0072 and of Settings, Imports of 0075). Every user still sees only the screens they may use: the web applies the permission and module filter after
-- the layout, and hides a heading whose screens are all hidden. Personal favourites are unchanged (they stay in the browser).
--
--   1. nav_item_catalogue: the keys of the screens the menu may hold (the sidebar entries of apps/web/src/components/navItems.ts). It is used only to validate a layout:
--      labels, icons, routes and permissions stay in the web code. A release that adds a screen adds its key here in its own migration; until then the web appends the
--      new screen at the end of its default heading, so a saved layout never hides a screen and never breaks. pmis_app reads the table and writes nothing.
--   2. nav_layout_json(): every signed-in user reads the layout (null while the code's default applies), the catalogue, who changed it and when, the ETag
--      (settings_etag of 0072) and whether the caller may edit it.
--   3. admin_set_nav_layout(layout, reason, version): a System Admin or a delegate of `settings` edit for all regions; a reason (3+ characters); the version (If-Match).
--      A null layout returns to the code's default (audited nav_layout_reset); any other layout is validated (nav_layout_clean) and saved (audited nav_layout_update),
--      both through log_audit_write with the layout, who and when before and after. Saving the layout in force (or resetting the default) is invalid_transition.
--   4. The rules of a layout: {"headings": [...]}; 1 to 30 main headings, at most 100 headings in all, at most 200 entries in a heading; a heading is
--      {id, name_en, name_ar, icon, children}: id ^[a-z][a-z0-9_-]{0,39}$ and unique among all headings, both names required (1 to 60 characters after trimming),
--      icon null or a short code of the web icon set; the children of a main heading are screen keys and sub-headings, those of a sub-heading only screen keys (no
--      deeper level); a key must be in the catalogue and appear once only. At most 64 KiB in all. No URL and no new screen can be added: only the order changes.
--   5. The key is guarded against direct writes like the keys of 0072 and 0075: an INSERT on the new key, an UPDATE on the old or the new key (no rename away) and a
--      DELETE are refused to any writer but the definer functions and the migration role (settings_guarded_keys of 0072).
--
-- Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked. pmis_app gets EXECUTE on the two doors
-- nav_layout_json and admin_set_nav_layout only, SELECT on the catalogue, and no new right on settings.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The catalogue of the menu entries (validation only)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nav_item_catalogue (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  default_group text NOT NULL CHECK (default_group ~ '^[a-z][a-z0-9_-]{0,39}$'),
  ord integer NOT NULL,
  added_in text NOT NULL
);
COMMENT ON TABLE nav_item_catalogue IS '0081: the keys of the screens the side menu may hold (apps/web navItems.ts). Validation of nav.layout only; labels, icons, routes and rights stay in the web. Extended by the migration of a release that adds a screen. Read-only for pmis_app.';

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
SELECT k, g, ord::int, '0081' FROM unnest(
  ARRAY['my_work', 'inbox', 'approvals', 'workload', 'status_updates', 'dashboard', 'messages', 'sites', 'dismantle', 'procurement', 'gecol', 'hlc', 'permits_hse',
        'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness', 'as_built', 'meetings', 'rf_design', 'acquisition', 'contractors', 'car_dispatcher',
        'financial_advances', 'contractor_reports', 'templates', 'admin.users', 'absence', 'admin.settings', 'announcements', 'audit', 'logs.field_changes',
        'admin.security_log', 'logs.online', 'logs.alerts', 'logs.job_runs', 'logs.deployments', 'logs.activity_report', 'logs.integrity', 'logs.mail'],
  ARRAY['work', 'work', 'work', 'work', 'work', 'work', 'work', 'site_register', 'site_register', 'registers', 'registers', 'registers', 'registers',
        'registers', 'registers', 'registers', 'registers', 'registers', 'registers', 'registers', 'registers', 'registers', 'registers', 'registers', 'registers',
        'registers', 'registers', 'data', 'admin', 'work', 'admin', 'admin', 'logs', 'logs',
        'logs', 'logs', 'logs', 'logs', 'logs', 'logs', 'logs', 'logs']) WITH ORDINALITY AS t(k, g, ord)
ON CONFLICT (key) DO NOTHING;

-- The setting starts as the default of the code (JSON null), so the version read before the first save is the version the first save checks.
INSERT INTO settings (key, value, description, updated_at)
VALUES ('nav.layout', 'null'::jsonb, 'The shared order of the side menu (0081): null while the default of the code applies. Changed only through admin_set_nav_layout.', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Rights of the definer role for what the new functions read and write
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON nav_item_catalogue TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Validation: the clean layout, or the field errors
-- ---------------------------------------------------------------------------------------------------------------------
-- Returns {"layout": <clean layout or null>, "errors": [...]}. Names are trimmed, a missing icon is null; nothing else is changed. The paths start at /layout.
CREATE OR REPLACE FUNCTION nav_layout_clean(p_layout jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  errs jsonb := '[]'::jsonb; heads jsonb := '[]'::jsonb; h jsonb; c jsonb; s jsonb; e jsonb; kids jsonb; subkids jsonb; hp text; cp text; sp text; k text;
  i integer := 0; j integer; m integer; n_heads integer := 0; ids text[] := ARRAY[]::text[]; keys text[] := ARRAY[]::text[]; known text[];
BEGIN
  IF p_layout IS NULL OR jsonb_typeof(p_layout) <> 'object' THEN
    RETURN jsonb_build_object('layout', NULL, 'errors', public.reg_err_item('/layout', 'invalid', 'A menu layout is an object with a list of headings.'));
  END IF;
  IF octet_length(p_layout::text) > 65536 THEN
    RETURN jsonb_build_object('layout', NULL, 'errors', public.reg_err_item('/layout', 'too_large', 'The menu layout is larger than 64 KiB.'));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_layout) LOOP
    IF k <> 'headings' THEN errs := errs || public.reg_err_item('/layout/' || k, 'unknown_field', 'Unknown field.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_layout -> 'headings') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('layout', NULL, 'errors', errs || public.reg_err_item('/layout/headings', 'required', 'A list of main headings.'));
  END IF;
  IF jsonb_array_length(p_layout -> 'headings') < 1 OR jsonb_array_length(p_layout -> 'headings') > 30 THEN
    RETURN jsonb_build_object('layout', NULL, 'errors', errs || public.reg_err_item('/layout/headings', 'too_many', 'From 1 to 30 main headings.'));
  END IF;
  SELECT array_agg(key) INTO known FROM public.nav_item_catalogue;
  known := coalesce(known, ARRAY[]::text[]);

  FOR h IN SELECT * FROM jsonb_array_elements(p_layout -> 'headings') LOOP
    hp := '/layout/headings/' || i;
    -- the heading itself (a main heading: depth 1)
    s := public.nav_layout_heading(h, hp, ids);
    errs := errs || (s -> 'errors');
    IF s ->> 'id' IS NOT NULL THEN ids := ids || (s ->> 'id'); END IF;
    n_heads := n_heads + 1;
    kids := '[]'::jsonb;
    IF jsonb_typeof(h) = 'object' AND jsonb_typeof(h -> 'children') = 'array' THEN
      IF jsonb_array_length(h -> 'children') > 200 THEN errs := errs || public.reg_err_item(hp || '/children', 'too_many', 'At most 200 entries in a heading.'); END IF;
      j := 0;
      FOR c IN SELECT * FROM jsonb_array_elements(h -> 'children') LOOP
        cp := hp || '/children/' || j;
        IF jsonb_typeof(c) = 'string' THEN
          k := c #>> '{}';
          IF NOT (k = ANY (known)) THEN errs := errs || public.reg_err_item(cp, 'unknown_item', 'This is not a screen of the menu.');
          ELSIF k = ANY (keys) THEN errs := errs || public.reg_err_item(cp, 'duplicate_item', 'This screen is already in the menu.');
          ELSE keys := keys || k; kids := kids || to_jsonb(k); END IF;
        ELSIF jsonb_typeof(c) = 'object' THEN
          -- a sub-heading (depth 2): its children are screen keys only
          s := public.nav_layout_heading(c, cp, ids);
          errs := errs || (s -> 'errors');
          IF s ->> 'id' IS NOT NULL THEN ids := ids || (s ->> 'id'); END IF;
          n_heads := n_heads + 1;
          subkids := '[]'::jsonb;
          IF jsonb_typeof(c -> 'children') = 'array' THEN
            IF jsonb_array_length(c -> 'children') > 200 THEN errs := errs || public.reg_err_item(cp || '/children', 'too_many', 'At most 200 entries in a heading.'); END IF;
            m := 0;
            FOR e IN SELECT * FROM jsonb_array_elements(c -> 'children') LOOP
              sp := cp || '/children/' || m;
              IF jsonb_typeof(e) = 'object' THEN errs := errs || public.reg_err_item(sp, 'too_deep', 'A sub-heading holds screens only: no deeper level.');
              ELSIF jsonb_typeof(e) <> 'string' THEN errs := errs || public.reg_err_item(sp, 'invalid', 'A screen key.');
              ELSE
                k := e #>> '{}';
                IF NOT (k = ANY (known)) THEN errs := errs || public.reg_err_item(sp, 'unknown_item', 'This is not a screen of the menu.');
                ELSIF k = ANY (keys) THEN errs := errs || public.reg_err_item(sp, 'duplicate_item', 'This screen is already in the menu.');
                ELSE keys := keys || k; subkids := subkids || to_jsonb(k); END IF;
              END IF;
              m := m + 1;
            END LOOP;
          END IF;
          kids := kids || jsonb_build_array(jsonb_build_object('id', c ->> 'id', 'name_en', btrim(coalesce(c ->> 'name_en', '')), 'name_ar', btrim(coalesce(c ->> 'name_ar', '')),
            'icon', CASE WHEN jsonb_typeof(c -> 'icon') = 'string' THEN c -> 'icon' ELSE 'null'::jsonb END, 'children', subkids));
        ELSE
          errs := errs || public.reg_err_item(cp, 'invalid', 'A screen key or a sub-heading.');
        END IF;
        j := j + 1;
      END LOOP;
    END IF;
    IF jsonb_typeof(h) = 'object' THEN
      heads := heads || jsonb_build_array(jsonb_build_object('id', h ->> 'id', 'name_en', btrim(coalesce(h ->> 'name_en', '')), 'name_ar', btrim(coalesce(h ->> 'name_ar', '')),
        'icon', CASE WHEN jsonb_typeof(h -> 'icon') = 'string' THEN h -> 'icon' ELSE 'null'::jsonb END, 'children', kids));
    END IF;
    i := i + 1;
  END LOOP;
  IF n_heads > 100 THEN errs := errs || public.reg_err_item('/layout/headings', 'too_many', 'At most 100 headings in all.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN RETURN jsonb_build_object('layout', NULL, 'errors', errs); END IF;
  RETURN jsonb_build_object('layout', jsonb_build_object('headings', heads), 'errors', '[]'::jsonb);
END $$;

-- The fields of one heading: {"id": <id or null>, "errors": [...]}. p_ids: the ids already used (an id is unique among main and sub-headings).
CREATE OR REPLACE FUNCTION nav_layout_heading(p_h jsonb, p_path text, p_ids text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; id_ text; f text; v text;
BEGIN
  IF p_h IS NULL OR jsonb_typeof(p_h) <> 'object' THEN
    RETURN jsonb_build_object('id', NULL, 'errors', public.reg_err_item(p_path, 'invalid', 'A heading is an object.'));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_h) LOOP
    IF k NOT IN ('id', 'name_en', 'name_ar', 'icon', 'children') THEN errs := errs || public.reg_err_item(p_path || '/' || k, 'unknown_field', 'Unknown field.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_h -> 'id') IS DISTINCT FROM 'string' OR (p_h ->> 'id') !~ '^[a-z][a-z0-9_-]{0,39}$' THEN
    errs := errs || public.reg_err_item(p_path || '/id', 'invalid', 'A heading id: lower-case letters, digits, - and _, up to 40 characters.');
  ELSE
    id_ := p_h ->> 'id';
    IF id_ = ANY (p_ids) THEN errs := errs || public.reg_err_item(p_path || '/id', 'duplicate_id', 'Two headings have the same id.'); id_ := NULL; END IF;
  END IF;
  FOREACH f IN ARRAY ARRAY['name_en', 'name_ar'] LOOP
    v := CASE WHEN jsonb_typeof(p_h -> f) = 'string' THEN btrim(p_h ->> f) END;
    IF v IS NULL OR char_length(v) < 1 THEN errs := errs || public.reg_err_item(p_path || '/' || f, 'required', 'The heading needs a name in English and in Arabic.');
    ELSIF char_length(v) > 60 THEN errs := errs || public.reg_err_item(p_path || '/' || f, 'too_long', 'At most 60 characters.'); END IF;
  END LOOP;
  IF p_h ? 'icon' AND jsonb_typeof(p_h -> 'icon') <> 'null' AND (jsonb_typeof(p_h -> 'icon') <> 'string' OR (p_h ->> 'icon') !~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$') THEN
    errs := errs || public.reg_err_item(p_path || '/icon', 'invalid', 'An icon of the icon set, or none.');
  END IF;
  IF jsonb_typeof(p_h -> 'children') IS DISTINCT FROM 'array' THEN errs := errs || public.reg_err_item(p_path || '/children', 'required', 'A list of entries (it may be empty).'); END IF;
  RETURN jsonb_build_object('id', id_, 'errors', errs);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The read door and the write door
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nav_layout_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; lay jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'nav.layout';
  lay := CASE WHEN jsonb_typeof(s.value) = 'object' THEN s.value END;
  RETURN jsonb_build_object(
    'layout', coalesce(lay, 'null'::jsonb),
    'is_default', lay IS NULL,
    'catalogue', coalesce((SELECT jsonb_agg(c.key ORDER BY c.ord, c.key) FROM public.nav_item_catalogue c), '[]'::jsonb),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', CASE WHEN s.updated_by IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_by) END,
    'version', public.settings_etag('nav.layout'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

-- p_layout null: back to the code's default (nav_layout_reset). Otherwise the validated layout (nav_layout_update).
CREATE OR REPLACE FUNCTION admin_set_nav_layout(p_layout jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; chk jsonb; new_ jsonb; reset_ boolean := (p_layout IS NULL OR jsonb_typeof(p_layout) = 'null');
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF NOT reset_ THEN
    chk := public.nav_layout_clean(p_layout);
    IF jsonb_array_length(chk -> 'errors') > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', chk -> 'errors')); END IF;
    new_ := chk -> 'layout';
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('nav.layout', 'null'::jsonb, 'The shared order of the side menu (0081): null while the default of the code applies. Changed only through admin_set_nav_layout.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'nav.layout' FOR UPDATE;
  cur := public.nav_layout_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF reset_ AND (cur ->> 'is_default')::boolean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The menu already follows the default layout.'));
  END IF;
  IF NOT reset_ AND (cur -> 'layout') = new_ THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This is already the layout of the menu.'));
  END IF;
  UPDATE public.settings SET value = coalesce(new_, 'null'::jsonb), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'nav.layout';
  res := public.nav_layout_json();
  PERFORM public.log_audit_write(CASE WHEN reset_ THEN 'nav_layout_reset' ELSE 'nav_layout_update' END, 'setting', 'nav.layout',
    jsonb_build_object('layout', cur -> 'layout', 'is_default', cur -> 'is_default', 'updated_at', cur -> 'updated_at', 'updated_by', cur -> 'updated_by'),
    jsonb_build_object('layout', res -> 'layout', 'is_default', res -> 'is_default', 'updated_at', res -> 'updated_at', 'updated_by', res -> 'updated_by'), btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The key changes only through admin_set_nav_layout (the guard function of 0072; an UPDATE is guarded on the old and the new key, so it cannot be renamed away)
-- ---------------------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS b_settings_nav_layout ON settings;
DROP TRIGGER IF EXISTS b_settings_nav_layout_update ON settings;
DROP TRIGGER IF EXISTS b_settings_nav_layout_delete ON settings;
CREATE TRIGGER b_settings_nav_layout BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'nav.layout') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_nav_layout_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'nav.layout' OR NEW.key = 'nav.layout') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_nav_layout_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'nav.layout') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['nav_layout_clean(jsonb)', 'nav_layout_heading(jsonb,text,text[])', 'nav_layout_json()', 'admin_set_nav_layout(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION nav_layout_json() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_nav_layout(jsonb, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION nav_layout_clean(jsonb) FROM pmis_app;
    REVOKE ALL ON FUNCTION nav_layout_heading(jsonb, text, text[]) FROM pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON nav_item_catalogue FROM pmis_app;
    GRANT SELECT ON nav_item_catalogue TO pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('nav_layout_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'nav.layout', 'catalogue', (SELECT count(*) FROM nav_item_catalogue), 'write', 'admin_set_nav_layout', 'read', 'nav_layout_json',
          'audit', jsonb_build_array('nav_layout_update', 'nav_layout_reset')),
        'Owner request of 2026-11-09, CHANGELOG 119: the side menu order is edited on the main screen by a System Admin or an all-regions settings delegate (migration 0081).');
