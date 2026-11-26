-- 0185_login_page: the login page settings (Settings > Screens > Login page) and the public sign-in page config
-- (owner request 2026-11-26, contract 0.15.97). Mirror: db/sql/184_login_page.sql (kept identical).
--
-- WHY. The owner approved a polish of the sign-in pages (2026-11-26): a calm telecom-themed animated background, a short
-- admin-controlled announcement (for example scheduled maintenance), a default language for the signed-out pages and
-- support links under the form. The admin edits all of it from Settings; nothing about the sign-in mechanism changes.
--
-- WHAT THIS ADDS.
--   1. The setting ui.login_page = {announcement_en, announcement_ar, announcement_kind (info|maintenance), animation,
--      default_locale (en|ar|null), support_links (up to 5 of {label_en, label_ar, url; http(s) or mailto only})},
--      guarded by settings_guarded_keys (0072) like 0130: it changes only through admin_set_login_page.
--   2. login_page_cfg(): internal helper (the sanitised setting).
--   3. login_page_state(): the signed-in read door (it drives the settings screen and the post-login splash):
--      the config plus updated_at, updated_by, version and can_edit.
--   4. login_page_public(): the public door for the signed-out pages. It returns ONLY what the sign-in page shows
--      (announcement, animation, default_locale, support_links): no version, no audit data, nothing about users.
--   5. admin_set_login_page(p_body, p_reason, p_version): the write door. System Admin or a delegate of `settings` edit
--      for ALL regions (the rule of 0130), a reason of 3+ characters, the version (If-Match, precondition_failed),
--      strict keys and per-field validation (422), saving the values in force is invalid_transition; one audit row
--      login_page_update with before and after. The step-up is enforced by the API (PUT /settings/login-page).
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC; the new
-- functions are owned by pmis_definer. pmis_app gets login_page_state, login_page_public and admin_set_login_page only.
-- No new table.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The setting (changes only through admin_set_login_page)
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('ui.login_page',
        '{"announcement_en": "", "announcement_ar": "", "announcement_kind": "info", "animation": true, "default_locale": null, "support_links": []}'::jsonb,
        'Owner request 2026-11-26 (0185): the sign-in page settings {announcement_en, announcement_ar, announcement_kind, animation, default_locale, support_links}. Changed only through admin_set_login_page.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_ui_login_page ON settings;
DROP TRIGGER IF EXISTS b_settings_ui_login_page_update ON settings;
DROP TRIGGER IF EXISTS b_settings_ui_login_page_delete ON settings;
CREATE TRIGGER b_settings_ui_login_page BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'ui.login_page') EXECUTE FUNCTION settings_guarded_keys();
-- an UPDATE is guarded on the old and the new key, so the row cannot be renamed away (security review 2026-11-05)
CREATE TRIGGER b_settings_ui_login_page_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ui.login_page' OR NEW.key = 'ui.login_page') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_ui_login_page_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ui.login_page') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The sanitised setting (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- One support link as stored, sanitised; null when the entry cannot be read as a link at all.
CREATE OR REPLACE FUNCTION login_page_link(l jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE en text; ar text; u text;
BEGIN
  IF l IS NULL OR jsonb_typeof(l) <> 'object' THEN RETURN NULL; END IF;
  en := CASE WHEN jsonb_typeof(l -> 'label_en') = 'string' THEN btrim(l ->> 'label_en') ELSE '' END;
  ar := CASE WHEN jsonb_typeof(l -> 'label_ar') = 'string' THEN btrim(l ->> 'label_ar') ELSE '' END;
  u := CASE WHEN jsonb_typeof(l -> 'url') = 'string' THEN btrim(l ->> 'url') ELSE '' END;
  IF en = '' OR char_length(en) > 60 OR char_length(ar) > 60 THEN RETURN NULL; END IF;
  IF u = '' OR char_length(u) > 300 OR u !~* '^(https?://|mailto:)' THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('label_en', en, 'label_ar', ar, 'url', u);
END $$;

-- The setting as stored, sanitised: bad values read as the defaults of the owner request.
CREATE OR REPLACE FUNCTION login_page_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; en text; ar text; k text; a boolean; d jsonb; links jsonb; l jsonb; one jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'ui.login_page';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  en := CASE WHEN jsonb_typeof(v -> 'announcement_en') = 'string' AND char_length(btrim(v ->> 'announcement_en')) <= 280 THEN btrim(v ->> 'announcement_en') ELSE '' END;
  ar := CASE WHEN jsonb_typeof(v -> 'announcement_ar') = 'string' AND char_length(btrim(v ->> 'announcement_ar')) <= 280 THEN btrim(v ->> 'announcement_ar') ELSE '' END;
  k := CASE WHEN (v ->> 'announcement_kind') IN ('info', 'maintenance') THEN v ->> 'announcement_kind' ELSE 'info' END;
  a := CASE WHEN jsonb_typeof(v -> 'animation') = 'boolean' THEN (v ->> 'animation')::boolean ELSE true END;
  d := CASE WHEN (v ->> 'default_locale') IN ('en', 'ar') THEN to_jsonb(v ->> 'default_locale') ELSE 'null'::jsonb END;
  links := '[]'::jsonb;
  IF jsonb_typeof(v -> 'support_links') = 'array' THEN
    FOR l IN SELECT value FROM jsonb_array_elements(v -> 'support_links') LOOP
      one := public.login_page_link(l);
      IF one IS NOT NULL AND jsonb_array_length(links) < 5 THEN links := links || jsonb_build_array(one); END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('announcement_en', en, 'announcement_ar', ar, 'announcement_kind', k,
                            'animation', a, 'default_locale', d, 'support_links', links);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The read doors
-- ---------------------------------------------------------------------------------------------------------------------
-- The signed-in read door: the settings screen and the post-login splash.
CREATE OR REPLACE FUNCTION login_page_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.login_page_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'ui.login_page';
  RETURN c || jsonb_build_object(
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('ui.login_page'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

-- The public door: ONLY what the signed-out pages show. No version, no audit data, nothing about users (owner: security first, 2026-11-26).
CREATE OR REPLACE FUNCTION login_page_public() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.login_page_cfg(); ann jsonb;
BEGIN
  ann := CASE WHEN (c ->> 'announcement_en') = '' AND (c ->> 'announcement_ar') = '' THEN 'null'::jsonb
              ELSE jsonb_build_object('en', c -> 'announcement_en', 'ar', c -> 'announcement_ar', 'kind', c -> 'announcement_kind') END;
  RETURN jsonb_build_object(
    'announcement', ann,
    'animation', c -> 'animation',
    'default_locale', c -> 'default_locale',
    'support_links', c -> 'support_links');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The write door
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_set_login_page(p_body jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; nxt jsonb; bad text; l jsonb; links jsonb := '[]'::jsonb; one jsonb;
        v_en text; v_ar text; v_kind text; v_anim boolean; v_loc jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- System Admin, or a delegate of settings edit for all regions (the sign-in page is the same for everyone)
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wfe_err1('/', 'invalid', 'The login page settings must be an object.');
  END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_body) key
   WHERE key NOT IN ('announcement_en', 'announcement_ar', 'announcement_kind', 'animation', 'default_locale', 'support_links');
  IF bad IS NOT NULL THEN
    PERFORM public.wfe_err1('/', 'unknown_field', format('Unknown keys: %s', bad));
  END IF;
  -- announcement texts (either may be empty; both empty hides the banner)
  v_en := p_body ->> 'announcement_en'; v_ar := p_body ->> 'announcement_ar';
  IF v_en IS NULL OR jsonb_typeof(p_body -> 'announcement_en') <> 'string' OR char_length(btrim(v_en)) > 280 THEN
    PERFORM public.wfe_err1('/announcement_en', 'invalid', 'The English announcement is a text of at most 280 characters (empty hides it).');
  END IF;
  IF v_ar IS NULL OR jsonb_typeof(p_body -> 'announcement_ar') <> 'string' OR char_length(btrim(v_ar)) > 280 THEN
    PERFORM public.wfe_err1('/announcement_ar', 'invalid', 'The Arabic announcement is a text of at most 280 characters (empty hides it).');
  END IF;
  v_kind := p_body ->> 'announcement_kind';
  IF v_kind IS NULL OR v_kind NOT IN ('info', 'maintenance') THEN
    PERFORM public.wfe_err1('/announcement_kind', 'invalid', 'The announcement kind is info or maintenance.');
  END IF;
  IF jsonb_typeof(p_body -> 'animation') <> 'boolean' THEN
    PERFORM public.wfe_err1('/animation', 'invalid', 'Say whether the background animation is on (true) or off (false).');
  END IF;
  v_anim := (p_body ->> 'animation')::boolean;
  IF jsonb_typeof(p_body -> 'default_locale') = 'null' THEN
    v_loc := 'null'::jsonb;
  ELSIF (p_body ->> 'default_locale') IN ('en', 'ar') THEN
    v_loc := to_jsonb(p_body ->> 'default_locale');
  ELSE
    PERFORM public.wfe_err1('/default_locale', 'invalid', 'The default language is en, ar or null (the visitor chooses).');
  END IF;
  IF jsonb_typeof(p_body -> 'support_links') <> 'array' OR jsonb_array_length(p_body -> 'support_links') > 5 THEN
    PERFORM public.wfe_err1('/support_links', 'invalid', 'The support links are a list of at most 5 links.');
  END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p_body -> 'support_links') LOOP
    one := public.login_page_link(l);
    IF one IS NULL OR jsonb_typeof(l) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('label_en', 'label_ar', 'url')) THEN
      PERFORM public.wfe_err1('/support_links', 'invalid', 'Each support link is {label_en (1 to 60 characters), label_ar, url} with an http(s) or mailto address of at most 300 characters.');
    END IF;
    links := links || jsonb_build_array(one);
  END LOOP;
  nxt := jsonb_build_object('announcement_en', btrim(v_en), 'announcement_ar', btrim(v_ar), 'announcement_kind', v_kind,
                            'animation', v_anim, 'default_locale', v_loc, 'support_links', links);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('ui.login_page',
          '{"announcement_en": "", "announcement_ar": "", "announcement_kind": "info", "animation": true, "default_locale": null, "support_links": []}'::jsonb,
          'Owner request 2026-11-26 (0185): the sign-in page settings {announcement_en, announcement_ar, announcement_kind, animation, default_locale, support_links}. Changed only through admin_set_login_page.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'ui.login_page' FOR UPDATE;
  cur := public.login_page_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('ui.login_page') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur = nxt THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the login page settings.'));
  END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'ui.login_page';
  res := public.login_page_state();
  PERFORM public.log_audit_write('login_page_update', 'setting', 'ui.login_page', cur, public.login_page_cfg(), btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['login_page_link(jsonb)', 'login_page_cfg()', 'login_page_state()', 'login_page_public()', 'admin_set_login_page(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION login_page_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION login_page_public() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_login_page(jsonb, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION login_page_link(jsonb) FROM pmis_app;
    REVOKE ALL ON FUNCTION login_page_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('login_page_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'ui.login_page', 'default', jsonb_build_object('announcement_en', '', 'announcement_ar', '', 'announcement_kind', 'info', 'animation', true, 'default_locale', 'null', 'support_links', '[]'::jsonb),
          'read', 'login_page_state', 'public', 'login_page_public', 'write', 'admin_set_login_page', 'audit', jsonb_build_array('login_page_update')),
        'Owner request 2026-11-26: the sign-in page settings (announcement, animation, default language, support links), edited from Settings > Screens > Login page; the public read shows only what the page renders (migration 0185).');
