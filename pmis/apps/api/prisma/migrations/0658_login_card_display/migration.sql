-- 0658: login card display settings (Settings > Screens > Login page; proposal item 13, owner asks Instinct to own the spec, 2026-11-28).
-- Mirror of this file: apps/api/prisma/migrations/0658_login_card_display/migration.sql (kept byte-identical).
--
-- WHAT. ui.login_page gains render-only fields: show_remember, show_language_switch, show_theme_switch, show_help (booleans, default true) and a
-- welcome title and subtitle in English and Arabic (empty = the built-in text). The sign-in mechanism, limits, sessions and every security
-- setting are untouched: these fields only decide what the signed-out card draws.
-- HOW. Additive, idempotent function replacement (login_page_cfg, login_page_public, admin_set_login_page) plus two helpers. The write door keeps its
-- rights, reason, step-up, version check and audit; a body without the new keys keeps the current values. Public read returns the new fields too
-- (nothing about users). No table, no grant widening.

CREATE OR REPLACE FUNCTION login_page_card_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['show_remember', 'show_language_switch', 'show_theme_switch', 'show_help', 'welcome_title_en', 'welcome_title_ar', 'welcome_subtitle_en', 'welcome_subtitle_ar'] $$;

-- The card fields as stored, sanitised: bad values read as the defaults.
CREATE OR REPLACE FUNCTION login_page_card(v jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb := '{}'::jsonb; k text;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  FOREACH k IN ARRAY ARRAY['show_remember', 'show_language_switch', 'show_theme_switch', 'show_help'] LOOP
    r := r || jsonb_build_object(k, CASE WHEN jsonb_typeof(v -> k) = 'boolean' THEN (v ->> k)::boolean ELSE true END);
  END LOOP;
  FOREACH k IN ARRAY ARRAY['welcome_title_en', 'welcome_title_ar'] LOOP
    r := r || jsonb_build_object(k, CASE WHEN jsonb_typeof(v -> k) = 'string' AND char_length(btrim(v ->> k)) <= 80 THEN btrim(v ->> k) ELSE '' END);
  END LOOP;
  FOREACH k IN ARRAY ARRAY['welcome_subtitle_en', 'welcome_subtitle_ar'] LOOP
    r := r || jsonb_build_object(k, CASE WHEN jsonb_typeof(v -> k) = 'string' AND char_length(btrim(v ->> k)) <= 160 THEN btrim(v ->> k) ELSE '' END);
  END LOOP;
  RETURN r;
END $$;

-- Validation of the card fields present in a write body (absent keys keep their value).
CREATE OR REPLACE FUNCTION login_page_card_check(p_body jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['show_remember', 'show_language_switch', 'show_theme_switch', 'show_help'] LOOP
    IF p_body ? k AND jsonb_typeof(p_body -> k) <> 'boolean' THEN
      PERFORM public.wfe_err1('/' || k, 'invalid', 'Say whether this part of the login card is shown (true) or hidden (false).');
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['welcome_title_en', 'welcome_title_ar'] LOOP
    IF p_body ? k AND (jsonb_typeof(p_body -> k) <> 'string' OR char_length(btrim(p_body ->> k)) > 80) THEN
      PERFORM public.wfe_err1('/' || k, 'invalid', 'The welcome title is a text of at most 80 characters (empty uses the built-in text).');
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['welcome_subtitle_en', 'welcome_subtitle_ar'] LOOP
    IF p_body ? k AND (jsonb_typeof(p_body -> k) <> 'string' OR char_length(btrim(p_body ->> k)) > 160) THEN
      PERFORM public.wfe_err1('/' || k, 'invalid', 'The welcome subtitle is a text of at most 160 characters (empty uses the built-in text).');
    END IF;
  END LOOP;
END $$;

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
                            'animation', a, 'default_locale', d, 'support_links', links) || public.login_page_card(v);
END $$;

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
    'support_links', c -> 'support_links') || (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(c) e WHERE e.key = ANY (public.login_page_card_keys()));
END $$;

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
   WHERE key NOT IN ('announcement_en', 'announcement_ar', 'announcement_kind', 'animation', 'default_locale', 'support_links') AND key <> ALL (public.login_page_card_keys());
  IF bad IS NULL THEN PERFORM public.login_page_card_check(p_body); END IF;
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
          'Owner request 2026-11-26 (0197): the sign-in page settings {announcement_en, announcement_ar, announcement_kind, animation, default_locale, support_links}. Changed only through admin_set_login_page.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'ui.login_page' FOR UPDATE;
  cur := public.login_page_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('ui.login_page') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  nxt := nxt || public.login_page_card(cur || (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(p_body) e WHERE e.key = ANY (public.login_page_card_keys())));
  IF cur = nxt THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the login page settings.'));
  END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'ui.login_page';
  res := public.login_page_state();
  PERFORM public.log_audit_write('login_page_update', 'setting', 'ui.login_page', cur, public.login_page_cfg(), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['login_page_card_keys()', 'login_page_card(jsonb)', 'login_page_card_check(jsonb)', 'login_page_cfg()', 'login_page_public()', 'admin_set_login_page(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION login_page_public() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_login_page(jsonb, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION login_page_card_keys() FROM pmis_app;
    REVOKE ALL ON FUNCTION login_page_card(jsonb) FROM pmis_app;
    REVOKE ALL ON FUNCTION login_page_card_check(jsonb) FROM pmis_app;
    REVOKE ALL ON FUNCTION login_page_cfg() FROM pmis_app;
  END IF;
END $$;
