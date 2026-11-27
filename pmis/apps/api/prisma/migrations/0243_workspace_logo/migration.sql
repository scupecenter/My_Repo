-- 0243: the workspace logo in the identity (owner approval 2026-11-27, the PM-platforms proposal item 5; contract 0.15.107).
--
-- WHY. The product owner approved item 5 of the PM-platforms proposal: the workspace logo belongs to the identity, so the System Admin
-- (or an all-regions delegate of `settings` edit) uploads it in Settings > Identity and every signed-in user sees it in the sidebar
-- instead of the built-in letter badge. No logo (or a disabled one) keeps today's badge: nothing changes until an admin uploads one.
--
-- WHAT THIS ADDS.
--   1. The table ui_assets: small identity images keyed by name ('logo' today). mime is one of png/jpeg/svg+xml/webp, the bytes are
--      capped at 256 KiB, and the row carries enabled (hide never delete: removing the logo disables the row; it is never deleted),
--      a per-row version (If-Match), updated_at and updated_by. pmis_app gets NO table rights: the guard triggers refuse any write
--      outside the audited door (app_in_admin_path, like settings_guarded_keys of 0072) and reads go through doors too.
--   2. ui_asset_state(p_key): the metadata read door (any signed-in user): {key, mime, enabled, version, updated_at, updated_by} or
--      null when the row does not exist. It never returns the bytes.
--   3. ui_asset_get(p_key): the bytes read door (any signed-in user): (mime, bytes, version) of an ENABLED row, else no rows (the API
--      answers 404). The logo is the organization identity, not user data, so every signed-in user may read it.
--   4. admin_put_ui_asset(p_key, p_mime, p_bytes, p_reason, p_version): the upload door. System Admin or a delegate of `settings`
--      edit for ALL regions (the logo applies to everyone, the rule of 0081/0130), a reason of 3+ characters, If-Match on the row
--      version (a missing row takes no version), key/mime/size validated (422 wfe_err1); an upload always enables. Audited
--      ui_asset_update with before and after metadata (never the bytes).
--   5. admin_set_ui_asset_enabled(p_key, p_enabled, p_reason, p_version): enables/disables without a new upload (the row and its
--      bytes stay). Same checks; a missing row is 422 not_found; a no-op is invalid_transition. Audited ui_asset_update.
--   6. ui_identity_state() gains `logo` (ui_asset_state('logo')), so GET /settings/identity and GET /me identity.logo carry it and
--      the sidebar renders the image without an extra round trip.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC; the new functions are
-- owned by pmis_definer. pmis_app gets ui_asset_state, ui_asset_get, admin_put_ui_asset, admin_set_ui_asset_enabled and
-- ui_identity_state only.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The table (changes only through admin_put_ui_asset / admin_set_ui_asset_enabled)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE ui_assets (
  key text PRIMARY KEY CONSTRAINT ui_assets_key_check CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  mime text NOT NULL CONSTRAINT ui_assets_mime_check CHECK (mime IN ('image/png', 'image/jpeg', 'image/svg+xml', 'image/webp')),
  bytes bytea NOT NULL CONSTRAINT ui_assets_bytes_check CHECK (octet_length(bytes) BETWEEN 1 AND 262144),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CONSTRAINT ui_assets_version_check CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id)
);
COMMENT ON TABLE ui_assets IS '0243: small identity images keyed by name (logo). Read through ui_asset_state/ui_asset_get; written only by admin_put_ui_asset/admin_set_ui_asset_enabled (audited ui_asset_update). Disabling hides; rows are never deleted.';
REVOKE ALL ON ui_assets FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ui_assets TO pmis_definer;

CREATE OR REPLACE FUNCTION ui_assets_guarded() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.app_in_admin_path() THEN
    RAISE EXCEPTION 'permission denied: the ui asset % changes only through its audited function (migration 0198)', coalesce(NEW.key, OLD.key) USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER b_ui_assets_guarded BEFORE INSERT OR UPDATE OR DELETE ON ui_assets FOR EACH ROW EXECUTE FUNCTION ui_assets_guarded();
ALTER FUNCTION ui_assets_guarded() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION ui_assets_guarded() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The read doors
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ui_asset_state(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a public.ui_assets%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO a FROM public.ui_assets WHERE key = p_key;
  IF a.key IS NULL THEN RETURN 'null'::jsonb; END IF;
  RETURN jsonb_build_object(
    'key', a.key,
    'mime', a.mime,
    'enabled', a.enabled,
    'version', a.version,
    'updated_at', to_jsonb(a.updated_at),
    'updated_by', coalesce(public.wfe_user_ref(a.updated_by), 'null'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION ui_asset_get(p_key text) RETURNS TABLE(mime text, bytes bytea, version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY SELECT a.mime, a.bytes, a.version FROM public.ui_assets a WHERE a.key = p_key AND a.enabled;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The write doors
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_put_ui_asset(p_key text, p_mime text, p_bytes bytea, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- System Admin, or a delegate of settings edit for all regions (the logo applies to everyone)
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_key IS NULL OR p_key !~ '^[a-z0-9_]{1,40}$' THEN PERFORM public.wfe_err1('/key', 'invalid', 'The asset key must be a short lowercase name.'); END IF;
  IF p_mime IS NULL OR NOT (p_mime IN ('image/png', 'image/jpeg', 'image/svg+xml', 'image/webp')) THEN PERFORM public.wfe_err1('/file', 'invalid', 'The logo must be a PNG, JPEG, SVG or WebP image.'); END IF;
  IF p_bytes IS NULL OR octet_length(p_bytes) = 0 THEN PERFORM public.wfe_err1('/file', 'required', 'Choose an image file.'); END IF;
  IF octet_length(p_bytes) > 262144 THEN PERFORM public.wfe_err1('/file', 'invalid', 'The logo must be 256 KiB at most.'); END IF;
  PERFORM 1 FROM public.ui_assets WHERE key = p_key FOR UPDATE;
  cur := public.ui_asset_state(p_key);
  IF cur = 'null'::jsonb THEN
    IF p_version IS NOT NULL THEN PERFORM public.wf_err('precondition_failed'); END IF;
    INSERT INTO public.ui_assets (key, mime, bytes, enabled, version, updated_at, updated_by)
    VALUES (p_key, p_mime, p_bytes, true, 1, clock_timestamp(), public.app_actor());
  ELSE
    IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
    UPDATE public.ui_assets SET mime = p_mime, bytes = p_bytes, enabled = true, version = version + 1,
           updated_by = public.app_actor(), updated_at = clock_timestamp()
     WHERE key = p_key;
  END IF;
  res := public.ui_asset_state(p_key);
  PERFORM public.log_audit_write('ui_asset_update', 'ui_asset', p_key,
    CASE WHEN cur = 'null'::jsonb THEN 'null'::jsonb ELSE cur - 'updated_at' - 'updated_by' END,
    res - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION admin_set_ui_asset_enabled(p_key text, p_enabled boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wfe_err1('/enabled', 'required', 'Say whether the logo shows.'); END IF;
  PERFORM 1 FROM public.ui_assets WHERE key = p_key FOR UPDATE;
  cur := public.ui_asset_state(p_key);
  IF cur = 'null'::jsonb THEN PERFORM public.wfe_err1('/key', 'not_found', 'No logo has been uploaded.'); END IF;
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The logo is already in this state.'));
  END IF;
  UPDATE public.ui_assets SET enabled = p_enabled, version = version + 1,
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = p_key;
  res := public.ui_asset_state(p_key);
  PERFORM public.log_audit_write('ui_asset_update', 'ui_asset', p_key, cur - 'updated_at' - 'updated_by', res - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The identity read gains the logo
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
    'defaults', public.ui_pref_defaults() || (c -> 'defaults'),
    'pref_options', public.ui_pref_options(),
    'logo', public.ui_asset_state('logo'),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('ui.identity'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_asset_state(text)', 'ui_asset_get(text)', 'admin_put_ui_asset(text,text,bytea,text,integer)', 'admin_set_ui_asset_enabled(text,boolean,text,integer)', 'ui_identity_state()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION ui_asset_state(text), ui_asset_get(text), admin_put_ui_asset(text, text, bytea, text, integer), admin_set_ui_asset_enabled(text, boolean, text, integer), ui_identity_state() TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Data reset coverage: the logo is organization identity, so KEEP with the configuration tables. The stored function
--    text is patched in place (idempotent), never rebuilt from an old base, so every table another migration adds stays.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE def text; marker text := '''nav_item_catalogue'', ';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('ui_assets' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no nav_item_catalogue row to patch'; END IF;
    EXECUTE replace(def, marker, marker || '''ui_assets'', ');
  END IF;
END $$;

-- the reset role reads every table and takes the share lock of a KEEP table (UPDATE)
GRANT SELECT, UPDATE ON public.ui_assets TO pmis_reset_owner;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_identity_applied', 'workflow', NULL,
        jsonb_build_object('table', 'ui_assets (the workspace logo)', 'read', jsonb_build_array('ui_asset_state', 'ui_asset_get', 'ui_identity_state (logo)'),
          'write', jsonb_build_array('admin_put_ui_asset', 'admin_set_ui_asset_enabled'), 'audit', jsonb_build_array('ui_asset_update')),
        'Owner approval 2026-11-27 (PM-platforms proposal, item 5): the workspace logo in the identity; the admin uploads it in Settings > Identity and it replaces the built-in sidebar badge (migration 0198).');
