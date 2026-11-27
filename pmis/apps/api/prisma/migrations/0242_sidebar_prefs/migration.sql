-- 0242: the personal sidebar (owner approval 2026-11-27, the PM-platforms proposal item 4; contract 0.15.231)
--
-- The user chooses what their side menu shows, the order of its screens, the badge style and the pinned shortcuts; the choices
-- save in their profile (users.ui_prefs -> 'sidebar'), so they follow them to every device. The organization layout (ui.nav_layout,
-- contract 0.15.1) still decides which headings exist and which screen sits in which heading, and the server's permission list
-- still filters first: the personal overlay only hides screens, reorders them inside their heading, restyles the badges and pins
-- shortcuts. It never adds a screen the caller may not see.
--
--   1. ui_nav_check(jsonb): checks the sidebar object key by key (unknown key, a badge style outside the list, a list that is
--      not an array, an entry that is not a menu key, more than 20 pins: an error) and returns the clean object. Duplicates
--      drop out. A menu key is a short lowercase id (the web knows the real list and ignores a key it does not have).
--   2. idm_update_own_profile (last defined in 0196): ui_prefs gains the key `sidebar`, an object. The appearance dimensions
--      keep their replace semantics (the profile form sends the whole set); `sidebar` is independent: a ui_prefs body without
--      it keeps the stored sidebar, a body with it replaces it. While the administrator set one appearance for everyone a
--      sidebar-only change stays allowed (it is not an appearance dimension). Audited per key in profile_updated like the
--      dimensions.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The sidebar object
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ui_nav_check(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o jsonb := '{}'::jsonb; bad text; v text; name text; el jsonb; seen text[]; items jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN o; END IF;
  IF jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar must be an object'; END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p) key
   WHERE key NOT IN ('hidden', 'order', 'badge_style', 'pins');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: unknown key: %', bad; END IF;
  IF p ? 'badge_style' THEN
    IF jsonb_typeof(p -> 'badge_style') <> 'string' OR NOT ((p ->> 'badge_style') IN ('full', 'dot', 'none')) THEN
      RAISE EXCEPTION 'profile: ui_prefs.sidebar: badge_style must be full, dot or none';
    END IF;
    o := o || jsonb_build_object('badge_style', p ->> 'badge_style');
  END IF;
  FOREACH name IN ARRAY ARRAY['hidden', 'order', 'pins'] LOOP
    CONTINUE WHEN NOT (p ? name);
    IF jsonb_typeof(p -> name) <> 'array' THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: % must be a list of menu keys', name; END IF;
    seen := '{}'; items := '[]'::jsonb;
    FOR el IN SELECT * FROM jsonb_array_elements(p -> name) LOOP
      IF jsonb_typeof(el) <> 'string' OR el #>> '{}' !~ '^[a-z0-9_.]{1,60}$' THEN
        RAISE EXCEPTION 'profile: ui_prefs.sidebar: % holds an entry that is not a menu key', name;
      END IF;
      IF NOT (el #>> '{}' = ANY (seen)) THEN seen := seen || (el #>> '{}'); items := items || jsonb_build_array(el); END IF;
    END LOOP;
    IF jsonb_array_length(items) > 200 THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: % holds at most 200 entries', name; END IF;
    IF name = 'pins' AND jsonb_array_length(items) > 20 THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: pins holds at most 20 shortcuts'; END IF;
    o := o || jsonb_build_object(name, items);
  END LOOP;
  RETURN o;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The self-service profile door: the body of 0196 plus the key ui_prefs.sidebar
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_update_own_profile(p_changes jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.idm_self_actor(); u public.users%ROWTYPE; n int; bad text; b jsonb := '{}'::jsonb; aft jsonb := '{}'::jsonb;
        v_name text; v_locale text; v_theme text; v_brand text; v_prefs jsonb; v_side jsonb; k text; bsub jsonb; asub jsonb;
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
  -- not allow a personal choice a dimension is refused, an empty object (back to the defaults) stays allowed.
  -- 0242: the key `sidebar` (an object, ui_nav_check) sits next to the dimensions; a body without it keeps the stored sidebar,
  -- and a sidebar-only change stays allowed while the appearance is locked.
  IF p_changes ? 'ui_prefs' THEN
    IF jsonb_typeof(p_changes -> 'ui_prefs') <> 'object' THEN RAISE EXCEPTION 'profile: ui_prefs must be an object of appearance dimensions'; END IF;
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_changes -> 'ui_prefs') key
     WHERE key <> 'sidebar' AND NOT (public.ui_pref_options() ? key);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'profile: ui_prefs: unknown appearance dimension: %', bad; END IF;
    FOR k IN SELECT jsonb_object_keys(p_changes -> 'ui_prefs') LOOP
      CONTINUE WHEN k = 'sidebar';
      IF jsonb_typeof(p_changes -> 'ui_prefs' -> k) <> 'string'
         OR NOT ((p_changes -> 'ui_prefs' ->> k) IN (SELECT jsonb_array_elements_text(public.ui_pref_options() -> k))) THEN
        RAISE EXCEPTION 'profile: ui_prefs: % has a value outside the allowed list', k;
      END IF;
    END LOOP;
    IF p_changes -> 'ui_prefs' ? 'sidebar' THEN
      v_side := public.ui_nav_check(p_changes -> 'ui_prefs' -> 'sidebar');
    ELSE
      v_side := coalesce(u.ui_prefs -> 'sidebar', '{}'::jsonb);
    END IF;
    -- a sidebar-only body keeps the stored dimensions; any other body replaces them (the appearance form sends the whole set,
    -- an empty object returns every dimension to the organization defaults)
    IF (p_changes -> 'ui_prefs' ? 'sidebar') AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes -> 'ui_prefs') dk WHERE public.ui_pref_options() ? dk) THEN
      v_prefs := public.ui_prefs_sanitize(u.ui_prefs);
    ELSE
      v_prefs := public.ui_prefs_sanitize(p_changes -> 'ui_prefs');
    END IF;
    IF v_side <> '{}'::jsonb THEN v_prefs := v_prefs || jsonb_build_object('sidebar', v_side); END IF;
    -- the lock judges the body's dimensions, not the kept ones: a sidebar-only body stays allowed
    IF NOT (public.ui_identity_cfg() ->> 'allow_user_choice')::boolean
       AND EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes -> 'ui_prefs') kk WHERE public.ui_pref_options() ? kk) THEN
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

COMMENT ON COLUMN users.ui_prefs IS '0196: the personal appearance dimensions (density, font_scale, radius, motion, icon_style, menu_style, accent); {} = the organization defaults of ui.identity.defaults. 0242: the key sidebar (the personal side menu: hidden, order, badge_style, pins). Written only by idm_update_own_profile.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  ALTER FUNCTION ui_nav_check(jsonb) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION ui_nav_check(jsonb) FROM PUBLIC;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', 'ui_nav_check(jsonb)');
  -- the profile door (owner pmis_identity_owner) reads the sidebar check through the helper
  GRANT EXECUTE ON FUNCTION ui_nav_check(jsonb) TO pmis_identity_owner;
  ALTER FUNCTION idm_update_own_profile(jsonb) OWNER TO pmis_identity_owner;
  REVOKE ALL ON FUNCTION idm_update_own_profile(jsonb) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION idm_update_own_profile(jsonb) TO pmis_app;
    REVOKE ALL ON FUNCTION ui_nav_check(jsonb) FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_identity_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'users.ui_prefs (sidebar)', 'read', 'ui_nav_check', 'write', 'idm_update_own_profile (ui_prefs.sidebar)',
          'audit', 'profile_updated'),
        'Owner approval 2026-11-27 (PM-platforms proposal, item 4): the personal sidebar (show, order, badge style, pinned shortcuts) saved in the profile (migration 0242).');
