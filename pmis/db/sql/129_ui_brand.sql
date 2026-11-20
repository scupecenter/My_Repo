-- 0130: switchable UI designs ("brands") and the Identity & themes settings (owner decision 2026-11-19, contract 0.15.41).
--
-- WHY. The product owner approved a prototype: the current look of the system stays the default and unchanged; three more designs are optional and switchable
-- (aljeel = the company brand, executive = a light sidebar, field = high contrast for site teams). Each user may pick a design for themselves, and the System Admin
-- (or an all-regions delegate of `settings` edit) sets the organization default and may lock it (no personal choice). The light/dark theme (users.theme) stays a
-- separate, independent choice. Status colours never change with the design (the web tokens of a brand never touch them).
--
-- WHAT THIS ADDS.
--   1. users.ui_brand (text, null = follow the organization default; CHECK on the four designs). pmis_app gets no column right on it: the users backstop of 0009
--      refuses a direct write, and it changes only through idm_update_own_profile.
--   2. The setting ui.identity = {"default_brand": "current", "allow_user_choice": true}, guarded by settings_guarded_keys (0072) like 0081 / 0090: it changes only
--      through admin_set_ui_identity.
--   3. ui_brands() and ui_identity_cfg(): internal helpers (the list of designs; the sanitised setting).
--   4. ui_effective_brand(p_user_brand): the design the user sees = their own when the admin allows a personal choice and they chose one, else the default.
--      Granted to pmis_app: the session load reads it before a session context exists. It reveals only the organization default.
--   5. ui_identity_state(): the read door (any signed-in user; it drives the UI): {default_brand, allow_user_choice, brands, can_edit, updated_at, updated_by, version}.
--   6. admin_set_ui_identity(p_default, p_allow, p_reason, p_version): the write door. System Admin or a delegate of `settings` edit for ALL regions (the rule of the
--      side menu layout, 0081), a reason of 3+ characters, the version (If-Match, precondition_failed), one audit row ui_identity_update with before and after.
--      The step-up is enforced by the API (PUT /settings/identity), like the structural freeze.
--   7. idm_update_own_profile (last defined in 0058): the same body plus the key ui_brand (null or one of the four). While the admin does not allow a personal
--      choice, a non-null value is refused (42501 "ui_brand_locked"); null (back to the default) stays allowed. Audited with before and after like the other keys.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC; the new functions are owned by pmis_definer,
-- idm_update_own_profile stays owned by pmis_identity_owner. pmis_app gets ui_effective_brand, ui_identity_state and admin_set_ui_identity only. No new table.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN ui_brand text
  CONSTRAINT users_ui_brand_check CHECK (ui_brand IS NULL OR ui_brand IN ('current', 'aljeel', 'executive', 'field'));
COMMENT ON COLUMN users.ui_brand IS '0130: the UI design the user chose (current, aljeel, executive, field); null = follow the organization default (setting ui.identity). Written only by idm_update_own_profile.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The setting (changes only through admin_set_ui_identity)
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON users TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('ui.identity', '{"default_brand": "current", "allow_user_choice": true}'::jsonb,
        'Owner decision 2026-11-19 (0130): the organization default UI design {default_brand: current|aljeel|executive|field, allow_user_choice}. Changed only through admin_set_ui_identity.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_ui_identity ON settings;
DROP TRIGGER IF EXISTS b_settings_ui_identity_update ON settings;
DROP TRIGGER IF EXISTS b_settings_ui_identity_delete ON settings;
CREATE TRIGGER b_settings_ui_identity BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'ui.identity') EXECUTE FUNCTION settings_guarded_keys();
-- an UPDATE is guarded on the old and the new key, so the row cannot be renamed away (security review 2026-11-05)
CREATE TRIGGER b_settings_ui_identity_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ui.identity' OR NEW.key = 'ui.identity') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_ui_identity_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ui.identity') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Helpers (internal)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ui_brands() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['current', 'aljeel', 'executive', 'field']::text[]
$$;

-- The setting as stored, sanitised: an unknown default reads as current, a missing flag as true (the defaults of the owner decision).
CREATE OR REPLACE FUNCTION ui_identity_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; d text; a boolean;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'ui.identity';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  d := CASE WHEN jsonb_typeof(v -> 'default_brand') = 'string' AND (v ->> 'default_brand') = ANY (public.ui_brands()) THEN v ->> 'default_brand' ELSE 'current' END;
  a := CASE WHEN jsonb_typeof(v -> 'allow_user_choice') = 'boolean' THEN (v ->> 'allow_user_choice')::boolean ELSE true END;
  RETURN jsonb_build_object('default_brand', d, 'allow_user_choice', a);
END $$;

-- The design a user sees: their own choice while the admin allows one, else the organization default.
CREATE OR REPLACE FUNCTION ui_effective_brand(p_user_brand text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.ui_identity_cfg();
BEGIN
  IF (c ->> 'allow_user_choice')::boolean AND p_user_brand IS NOT NULL AND p_user_brand = ANY (public.ui_brands()) THEN RETURN p_user_brand; END IF;
  RETURN c ->> 'default_brand';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The read door and the write door
-- ---------------------------------------------------------------------------------------------------------------------
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
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('ui.identity'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_ui_identity(p_default text, p_allow boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- System Admin, or a delegate of settings edit for all regions (the design applies to everyone)
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_default IS NULL OR NOT (p_default = ANY (public.ui_brands())) THEN
    PERFORM public.wfe_err1('/default_brand', 'invalid', 'The default design must be one of current, aljeel, executive, field.');
  END IF;
  IF p_allow IS NULL THEN PERFORM public.wfe_err1('/allow_user_choice', 'required', 'Say whether users may choose their own design.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('ui.identity', '{"default_brand": "current", "allow_user_choice": true}'::jsonb,
          'Owner decision 2026-11-19 (0130): the organization default UI design {default_brand: current|aljeel|executive|field, allow_user_choice}. Changed only through admin_set_ui_identity.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'ui.identity' FOR UPDATE;
  cur := public.ui_identity_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'default_brand') = p_default AND (cur ->> 'allow_user_choice')::boolean = p_allow THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the identity settings.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('default_brand', p_default, 'allow_user_choice', p_allow),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'ui.identity';
  res := public.ui_identity_state();
  PERFORM public.log_audit_write('ui_identity_update', 'setting', 'ui.identity',
    jsonb_build_object('default_brand', cur -> 'default_brand', 'allow_user_choice', cur -> 'allow_user_choice'),
    jsonb_build_object('default_brand', res -> 'default_brand', 'allow_user_choice', res -> 'allow_user_choice'), btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The self-service profile door: the body of 0058 plus the key ui_brand
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_update_own_profile(p_changes jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.idm_self_actor(); u public.users%ROWTYPE; n int; bad text; b jsonb := '{}'::jsonb; aft jsonb := '{}'::jsonb;
        v_name text; v_locale text; v_theme text; v_brand text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN RAISE EXCEPTION 'profile: changes must be an object'; END IF;
  IF p_changes ? 'phone' THEN
    RAISE EXCEPTION 'profile: phone cannot be changed on your own account directly: ask for a phone change, an administrator approves it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_changes) key
   WHERE key NOT IN ('display_name', 'locale', 'theme', 'ui_brand');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'profile: % cannot be changed on your own account: an administrator changes it', bad USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  v_name := u.display_name; v_locale := u.locale; v_theme := u.theme; v_brand := u.ui_brand;
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
      RAISE EXCEPTION 'profile: ui_brand must be null or one of current, aljeel, executive, field';
    ELSE
      v_brand := p_changes ->> 'ui_brand';
      IF NOT (public.ui_identity_cfg() ->> 'allow_user_choice')::boolean THEN
        RAISE EXCEPTION 'profile: ui_brand_locked: the administrator set one design for everyone' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  IF v_name IS DISTINCT FROM u.display_name THEN b := b || jsonb_build_object('display_name', u.display_name); aft := aft || jsonb_build_object('display_name', v_name); END IF;
  IF v_locale IS DISTINCT FROM u.locale THEN b := b || jsonb_build_object('locale', u.locale); aft := aft || jsonb_build_object('locale', v_locale); END IF;
  IF v_theme IS DISTINCT FROM u.theme THEN b := b || jsonb_build_object('theme', u.theme); aft := aft || jsonb_build_object('theme', v_theme); END IF;
  IF v_brand IS DISTINCT FROM u.ui_brand THEN b := b || jsonb_build_object('ui_brand', u.ui_brand); aft := aft || jsonb_build_object('ui_brand', v_brand); END IF;
  IF aft = '{}'::jsonb THEN RETURN 0; END IF;
  UPDATE public.users SET display_name = v_name, locale = v_locale, theme = v_theme, ui_brand = v_brand, updated_at = now() WHERE id = a;
  PERFORM public.log_audit_write('profile_updated', 'user', a::text, b, aft || jsonb_build_object('via', 'self_service'), NULL);
  SELECT count(*)::int INTO n FROM jsonb_object_keys(aft);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_brands()', 'ui_identity_cfg()', 'ui_effective_brand(text)', 'ui_identity_state()', 'admin_set_ui_identity(text,boolean,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- the profile door (owner pmis_identity_owner) reads the setting through the helpers
  GRANT EXECUTE ON FUNCTION ui_brands(), ui_identity_cfg() TO pmis_identity_owner;
  ALTER FUNCTION idm_update_own_profile(jsonb) OWNER TO pmis_identity_owner;
  REVOKE ALL ON FUNCTION idm_update_own_profile(jsonb) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION ui_effective_brand(text) TO pmis_app;
    GRANT EXECUTE ON FUNCTION ui_identity_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_ui_identity(text, boolean, text, integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION idm_update_own_profile(jsonb) TO pmis_app;
    REVOKE ALL ON FUNCTION ui_brands() FROM pmis_app;
    REVOKE ALL ON FUNCTION ui_identity_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_identity_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'ui.identity', 'column', 'users.ui_brand', 'brands', to_jsonb(ui_brands()), 'default_brand', 'current', 'allow_user_choice', true,
          'read', 'ui_identity_state', 'write', 'admin_set_ui_identity', 'self', 'idm_update_own_profile (ui_brand)', 'audit', jsonb_build_array('ui_identity_update', 'profile_updated')),
        'Owner decision 2026-11-19: the current look stays the default; aljeel, executive and field are optional designs, chosen per user; the admin can lock one design (migration 0130).');
