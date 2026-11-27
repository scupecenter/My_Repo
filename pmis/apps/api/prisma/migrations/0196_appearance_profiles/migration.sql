-- 0196_appearance_profiles: full-appearance profile presets and the per-user appearance dimensions
-- Mirror: db/sql/195_appearance_profiles.sql (kept identical to prisma/migrations/0196_appearance_profiles/migration.sql).
-- (owner approval 2026-11-27: the PM-platforms research proposal, items 1-3; contract 0.15.105).
--
-- WHY. The owner approved the research proposal: an appearance "profile type" is one bundle — the colour scheme (the design of 0130
-- and the light/dark theme), the accent, the icon style, the density, the corner and button shape, the motion level and the menu
-- style — applied to the whole app at once, with ready presets (classic, comfortable, night, compact), every dimension also
-- changeable on its own, a live preview before applying, and the organization defaults and the personal-choice switch in
-- Settings > Identity. The presets are web-side bundles over these stored dimensions; the database stores only the dimensions.
--
-- WHAT THIS ADDS.
--   1. users.ui_prefs (jsonb, NOT NULL DEFAULT '{}'): the personal appearance dimensions; empty = follow the organization
--      defaults. Written only through idm_update_own_profile (the users backstop of 0008 is unchanged: pmis_app gets no column
--      right on it).
--   2. ui_pref_options(): the allowed value of every dimension, and ui_pref_defaults(): the built-in standard of each. One list
--      for the SQL, the API and the web (ui_identity_state returns it).
--   3. ui_prefs_sanitize(jsonb): keeps only known dimensions with an allowed value.
--   4. The setting ui.identity gains `defaults`: the organization default of any subset of the dimensions (absent = the
--      built-in). ui_identity_cfg() sanitizes it; admin_set_ui_identity takes it (the 4-argument form is dropped; the API is the
--      only caller); ui_identity_state() returns the resolved defaults and the options; the audit carries the defaults too.
--   5. ui_effective_prefs(jsonb): the built-ins, then the organization defaults, then the user's own while the admin allows a
--      personal choice. Granted to pmis_app (the session load reads it, like ui_effective_brand): it reveals only the defaults.
--   6. idm_update_own_profile (last defined in 0164): the same body plus the key ui_prefs (an object with any subset of the
--      dimensions). An unknown dimension or a value outside the allowed list is a plain error (422 at the API); while the admin
--      does not allow a personal choice a non-empty object is refused (42501 'ui_prefs_locked'), an empty object (back to the
--      defaults) stays allowed. Audited dimension by dimension with before and after like the other keys.
-- No new table, no new permission, no role or grant change. The status colours are not a preference and stay fixed. The
-- light/dark theme (users.theme) and the design (users.ui_brand) keep their own columns and doors.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN ui_prefs jsonb NOT NULL DEFAULT '{}'::jsonb
  CONSTRAINT users_ui_prefs_check CHECK (jsonb_typeof(ui_prefs) = 'object');
COMMENT ON COLUMN users.ui_prefs IS '0196: the personal appearance dimensions (density, font_scale, radius, motion, icon_style, menu_style, accent); {} = the organization defaults of ui.identity.defaults. Written only by idm_update_own_profile.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The dimensions: allowed values and built-in defaults
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ui_pref_options() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'density',    ARRAY['comfortable', 'standard', 'compact'],
    'font_scale', ARRAY['small', 'standard', 'large'],
    'radius',     ARRAY['sharp', 'standard', 'rounded'],
    'motion',     ARRAY['full', 'reduced'],
    'icon_style', ARRAY['light', 'regular', 'bold'],
    'menu_style', ARRAY['default', 'rail', 'autohide'],
    'accent',     ARRAY['default', 'teal', 'blue', 'violet', 'green', 'orange', 'red', 'amber'])
$$;

CREATE OR REPLACE FUNCTION ui_pref_defaults() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"density": "standard", "font_scale": "standard", "radius": "standard", "motion": "full", "icon_style": "regular", "menu_style": "default", "accent": "default"}'::jsonb
$$;

-- Keeps the known dimensions with an allowed value; anything else drops out.
CREATE OR REPLACE FUNCTION ui_prefs_sanitize(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o jsonb := '{}'::jsonb; k text; v text; opts jsonb := public.ui_pref_options();
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN o; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF opts ? k AND jsonb_typeof(p -> k) = 'string' THEN
      v := p ->> k;
      IF v IN (SELECT jsonb_array_elements_text(opts -> k)) THEN o := o || jsonb_build_object(k, v); END IF;
    END IF;
  END LOOP;
  RETURN o;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The setting gains the organization defaults
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ui_identity_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; d text; a boolean; df jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'ui.identity';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  d := CASE WHEN jsonb_typeof(v -> 'default_brand') = 'string' AND (v ->> 'default_brand') = ANY (public.ui_brands()) THEN v ->> 'default_brand' ELSE 'current' END;
  a := CASE WHEN jsonb_typeof(v -> 'allow_user_choice') = 'boolean' THEN (v ->> 'allow_user_choice')::boolean ELSE true END;
  df := public.ui_prefs_sanitize(v -> 'defaults');
  RETURN jsonb_build_object('default_brand', d, 'allow_user_choice', a, 'defaults', df);
END $$;

-- The preferences a user sees: the built-ins, then the organization defaults, then their own while a personal choice is allowed.
CREATE OR REPLACE FUNCTION ui_effective_prefs(p_user_prefs jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.ui_identity_cfg(); r jsonb;
BEGIN
  r := public.ui_pref_defaults() || (c -> 'defaults');
  IF (c ->> 'allow_user_choice')::boolean THEN r := r || public.ui_prefs_sanitize(p_user_prefs); END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION ui_identity_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.ui_identity_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'ui.identity';
  RETURN jsonb_build_object(
    'default_brand', c -> 'default_brand',
    'allow_user_choice', c -> 'allow_user_choice',
    'brands', to_jsonb(public.ui_brands()),
    'defaults', public.ui_pref_defaults() || (c -> 'defaults'),
    'pref_options', public.ui_pref_options(),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('ui.identity'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

-- The write door (the 4-argument form is dropped; the API is the only caller).
DROP FUNCTION admin_set_ui_identity(text, boolean, text, integer);
CREATE OR REPLACE FUNCTION admin_set_ui_identity(p_default text, p_allow boolean, p_defaults jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; df jsonb := '{}'::jsonb; k text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- System Admin, or a delegate of settings edit for all regions (the appearance applies to everyone)
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_default IS NULL OR NOT (p_default = ANY (public.ui_brands())) THEN
    PERFORM public.wfe_err1('/default_brand', 'invalid', 'The default design must be one of the UI designs.');
  END IF;
  IF p_allow IS NULL THEN PERFORM public.wfe_err1('/allow_user_choice', 'required', 'Say whether users may choose their own appearance.'); END IF;
  IF p_defaults IS NOT NULL THEN
    IF jsonb_typeof(p_defaults) <> 'object' THEN PERFORM public.wfe_err1('/defaults', 'invalid', 'The defaults must be an object of appearance dimensions.'); END IF;
    FOR k IN SELECT key FROM jsonb_object_keys(p_defaults) key LOOP
      IF NOT (public.ui_pref_options() ? k) THEN PERFORM public.wfe_err1('/defaults', 'invalid', 'Unknown appearance dimension: ' || k); END IF;
      IF jsonb_typeof(p_defaults -> k) <> 'string' OR NOT ((p_defaults ->> k) IN (SELECT jsonb_array_elements_text(public.ui_pref_options() -> k))) THEN
        PERFORM public.wfe_err1('/defaults/' || k, 'invalid', 'A value outside the allowed list.');
      END IF;
    END LOOP;
    df := public.ui_prefs_sanitize(p_defaults);
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('ui.identity', '{"default_brand": "current", "allow_user_choice": true}'::jsonb,
          'Owner decision 2026-11-19 (0130): the organization default UI design {default_brand, allow_user_choice}; 0196 adds defaults (the organization default of every appearance dimension). Changed only through admin_set_ui_identity.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'ui.identity' FOR UPDATE;
  cur := public.ui_identity_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'default_brand') = p_default AND (cur ->> 'allow_user_choice')::boolean = p_allow AND (cur -> 'defaults') = (public.ui_pref_defaults() || df) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the identity settings.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('default_brand', p_default, 'allow_user_choice', p_allow, 'defaults', df),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'ui.identity';
  res := public.ui_identity_state();
  PERFORM public.log_audit_write('ui_identity_update', 'setting', 'ui.identity',
    jsonb_build_object('default_brand', cur -> 'default_brand', 'allow_user_choice', cur -> 'allow_user_choice', 'defaults', cur -> 'defaults'),
    jsonb_build_object('default_brand', res -> 'default_brand', 'allow_user_choice', res -> 'allow_user_choice', 'defaults', res -> 'defaults'), btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The self-service profile door: the body of 0164 plus the key ui_prefs
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_update_own_profile(p_changes jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.idm_self_actor(); u public.users%ROWTYPE; n int; bad text; b jsonb := '{}'::jsonb; aft jsonb := '{}'::jsonb;
        v_name text; v_locale text; v_theme text; v_brand text; v_prefs jsonb; k text; bsub jsonb; asub jsonb;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN RAISE EXCEPTION 'profile: changes must be an object'; END IF;
  IF p_changes ? 'phone' THEN
    RAISE EXCEPTION 'profile: phone cannot be changed on your own account directly: ask for a phone change, an administrator approves it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_changes) key
   WHERE key NOT IN ('display_name', 'locale', 'theme', 'ui_brand', 'ui_prefs');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'profile: % cannot be changed on your own account: an administrator changes it', bad USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  v_name := u.display_name; v_locale := u.locale; v_theme := u.theme; v_brand := u.ui_brand; v_prefs := u.ui_prefs;
  IF p_changes ? 'display_name' THEN
    v_name := btrim(p_changes ->> 'display_name');
    IF jsonb_typeof(p_changes -> 'display_name') <> 'string' OR v_name = '' OR length(v_name) > 200 THEN
      RAISE EXCEPTION 'profile: display_name must have 1 to 200 characters';
    END IF;
  END IF;
  IF p_changes ? 'locale' THEN
    v_locale := p_changes ->> 'locale';
    IF v_locale IS NULL OR v_locale NOT IN ('en', 'ar') THEN RAISE EXCEPTION 'profile: locale must be en or ar'; END IF;
  END IF;
  IF p_changes ? 'theme' THEN
    v_theme := p_changes ->> 'theme';
    IF v_theme IS NULL OR v_theme NOT IN ('light', 'dark') THEN RAISE EXCEPTION 'profile: theme must be light or dark'; END IF;
  END IF;
  -- 0130: the personal design; null = follow the organization default. A personal design is refused while the admin does not allow one.
  IF p_changes ? 'ui_brand' THEN
    IF jsonb_typeof(p_changes -> 'ui_brand') = 'null' THEN
      v_brand := NULL;
    ELSIF jsonb_typeof(p_changes -> 'ui_brand') <> 'string' OR NOT ((p_changes ->> 'ui_brand') = ANY (public.ui_brands())) THEN
      RAISE EXCEPTION 'profile: ui_brand must be null or one of the UI designs';
    ELSE
      v_brand := p_changes ->> 'ui_brand';
      IF NOT (public.ui_identity_cfg() ->> 'allow_user_choice')::boolean THEN
        RAISE EXCEPTION 'profile: ui_brand_locked: the administrator set one design for everyone' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  -- 0196: the personal appearance dimensions (any subset). An unknown dimension or a bad value is an error; while the admin does
  -- not allow a personal choice a non-empty object is refused, an empty one (back to the defaults) stays allowed.
  IF p_changes ? 'ui_prefs' THEN
    IF jsonb_typeof(p_changes -> 'ui_prefs') <> 'object' THEN RAISE EXCEPTION 'profile: ui_prefs must be an object of appearance dimensions'; END IF;
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_changes -> 'ui_prefs') key
     WHERE NOT (public.ui_pref_options() ? key);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'profile: ui_prefs: unknown appearance dimension: %', bad; END IF;
    FOR k IN SELECT jsonb_object_keys(p_changes -> 'ui_prefs') LOOP
      IF jsonb_typeof(p_changes -> 'ui_prefs' -> k) <> 'string'
         OR NOT ((p_changes -> 'ui_prefs' ->> k) IN (SELECT jsonb_array_elements_text(public.ui_pref_options() -> k))) THEN
        RAISE EXCEPTION 'profile: ui_prefs: % has a value outside the allowed list', k;
      END IF;
    END LOOP;
    v_prefs := public.ui_prefs_sanitize(p_changes -> 'ui_prefs');
    IF v_prefs <> '{}'::jsonb AND NOT (public.ui_identity_cfg() ->> 'allow_user_choice')::boolean THEN
      RAISE EXCEPTION 'profile: ui_prefs_locked: the administrator set one appearance for everyone' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF v_name IS DISTINCT FROM u.display_name THEN b := b || jsonb_build_object('display_name', u.display_name); aft := aft || jsonb_build_object('display_name', v_name); END IF;
  IF v_locale IS DISTINCT FROM u.locale THEN b := b || jsonb_build_object('locale', u.locale); aft := aft || jsonb_build_object('locale', v_locale); END IF;
  IF v_theme IS DISTINCT FROM u.theme THEN b := b || jsonb_build_object('theme', u.theme); aft := aft || jsonb_build_object('theme', v_theme); END IF;
  IF v_brand IS DISTINCT FROM u.ui_brand THEN b := b || jsonb_build_object('ui_brand', u.ui_brand); aft := aft || jsonb_build_object('ui_brand', v_brand); END IF;
  IF v_prefs IS DISTINCT FROM u.ui_prefs THEN
    bsub := '{}'::jsonb; asub := '{}'::jsonb;
    FOR k IN SELECT DISTINCT key FROM (SELECT jsonb_object_keys(v_prefs) UNION SELECT jsonb_object_keys(u.ui_prefs)) s(key) LOOP
      IF (v_prefs -> k) IS DISTINCT FROM (u.ui_prefs -> k) THEN
        bsub := bsub || jsonb_build_object(k, u.ui_prefs -> k);
        asub := asub || jsonb_build_object(k, v_prefs -> k);
      END IF;
    END LOOP;
    IF asub <> '{}'::jsonb THEN b := b || jsonb_build_object('ui_prefs', bsub); aft := aft || jsonb_build_object('ui_prefs', asub); END IF;
  END IF;
  IF aft = '{}'::jsonb THEN RETURN 0; END IF;
  UPDATE public.users SET display_name = v_name, locale = v_locale, theme = v_theme, ui_brand = v_brand, ui_prefs = v_prefs, updated_at = now() WHERE id = a;
  PERFORM public.log_audit_write('profile_updated', 'user', a::text, b, aft || jsonb_build_object('via', 'self_service'), NULL);
  SELECT count(*)::int INTO n FROM jsonb_object_keys(aft);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_pref_options()', 'ui_pref_defaults()', 'ui_prefs_sanitize(jsonb)', 'ui_effective_prefs(jsonb)', 'ui_identity_cfg()', 'ui_identity_state()', 'admin_set_ui_identity(text,boolean,jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- the profile door (owner pmis_identity_owner) reads the setting and the lists through the helpers
  GRANT EXECUTE ON FUNCTION ui_pref_options(), ui_pref_defaults(), ui_prefs_sanitize(jsonb) TO pmis_identity_owner;
  ALTER FUNCTION idm_update_own_profile(jsonb) OWNER TO pmis_identity_owner;
  REVOKE ALL ON FUNCTION idm_update_own_profile(jsonb) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION ui_effective_prefs(jsonb) TO pmis_app;
    GRANT EXECUTE ON FUNCTION ui_identity_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_ui_identity(text, boolean, jsonb, text, integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION idm_update_own_profile(jsonb) TO pmis_app;
    REVOKE ALL ON FUNCTION ui_pref_options(), ui_pref_defaults(), ui_prefs_sanitize(jsonb), ui_identity_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_identity_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'ui.identity (defaults)', 'column', 'users.ui_prefs', 'dimensions', ui_pref_options(), 'defaults', ui_pref_defaults(),
          'read', jsonb_build_array('ui_identity_state', 'ui_effective_prefs'), 'write', 'admin_set_ui_identity (defaults)', 'self', 'idm_update_own_profile (ui_prefs)',
          'audit', jsonb_build_array('ui_identity_update', 'profile_updated')),
        'Owner approval 2026-11-27 (PM-platforms proposal, items 1-3): appearance dimensions with organization defaults and a personal choice; presets and the live preview are web-side (migration 0196).');
