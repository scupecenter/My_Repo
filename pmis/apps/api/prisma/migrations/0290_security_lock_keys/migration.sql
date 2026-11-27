-- 0290: admin lock keys (owner decision 2026-11-27, relayed by Main: section 3 of the PM-platforms proposal, slice S1).
--
-- WHY. A System Admin needs two switches that make the system safer in one step: no public sharing, and no data export. Both are OFF by default, so nothing
-- changes for anyone until an admin turns one on in Settings > Security > Lock keys. Nothing is deleted, no permission is widened, no sign-in changes.
--
-- WHAT THIS ADDS.
--   1. The setting security.locks = {"block_public_sharing": false, "disable_export": false}, guarded by settings_guarded_keys (0072) like 0130 / 0180: it changes
--      only through admin_set_security_locks.
--   2. security_locks_cfg(): the sanitised setting (a missing or wrong-typed key reads as false = off).
--   3. security_lock_active(p_key): true when one lock is on. The API checks 'disable_export' before every export handler; a future feature that creates a public
--      link must call it with 'block_public_sharing' (documented in the contract and in docs/handover). Granted to pmis_app: it reveals one boolean the UI also reads.
--   4. security_locks_state(): the read door for any signed-in user (the UI hides export buttons while a lock is on).
--   5. admin_set_security_locks(p_block_sharing, p_disable_export, p_reason, p_version): the write door. System Admin only (not a delegate: a lock changes what
--      every user can do), a reason of 3+ characters, the version (If-Match, precondition_failed), one audit row security_locks_update with before and after.
--      The step-up is enforced by the API (PUT /settings/security-locks). Turning a lock off is as easy as turning it on, so an admin can never be locked out.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC, owned by pmis_definer. No new table.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('security.locks', '{"block_public_sharing": false, "disable_export": false}'::jsonb,
        'Owner decision 2026-11-27 (0290): admin lock keys {block_public_sharing, disable_export}, both off by default. Changed only through admin_set_security_locks.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_security_locks ON settings;
DROP TRIGGER IF EXISTS b_settings_security_locks_update ON settings;
DROP TRIGGER IF EXISTS b_settings_security_locks_delete ON settings;
CREATE TRIGGER b_settings_security_locks BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'security.locks') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_security_locks_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.locks' OR NEW.key = 'security.locks') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_security_locks_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.locks') EXECUTE FUNCTION settings_guarded_keys();

-- The setting as stored, sanitised: anything that is not a boolean true reads as off.
CREATE OR REPLACE FUNCTION security_locks_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'security.locks';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  RETURN jsonb_build_object(
    'block_public_sharing', coalesce(jsonb_typeof(v -> 'block_public_sharing') = 'boolean' AND (v ->> 'block_public_sharing')::boolean, false),
    'disable_export', coalesce(jsonb_typeof(v -> 'disable_export') = 'boolean' AND (v ->> 'disable_export')::boolean, false));
END $$;

-- One lock: true when it is on. An unknown key is an error, so a typo in a caller never reads as "off".
CREATE OR REPLACE FUNCTION security_lock_active(p_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.security_locks_cfg();
BEGIN
  IF p_key IS NULL OR NOT (c ? p_key) THEN RAISE EXCEPTION 'unknown lock key' USING ERRCODE = 'invalid_parameter_value'; END IF;
  RETURN (c ->> p_key)::boolean;
END $$;

CREATE OR REPLACE FUNCTION security_locks_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.security_locks_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'security.locks';
  RETURN jsonb_build_object(
    'block_public_sharing', c -> 'block_public_sharing',
    'disable_export', c -> 'disable_export',
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('security.locks'),
    'can_edit', coalesce(public.app_actor_is_system_admin(), false));
END $$;

CREATE OR REPLACE FUNCTION admin_set_security_locks(p_block_sharing boolean, p_disable_export boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin changes the lock keys.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_block_sharing IS NULL THEN PERFORM public.wfe_err1('/block_public_sharing', 'required', 'Say whether public sharing is blocked.'); END IF;
  IF p_disable_export IS NULL THEN PERFORM public.wfe_err1('/disable_export', 'required', 'Say whether export is disabled.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('security.locks', '{"block_public_sharing": false, "disable_export": false}'::jsonb,
          'Owner decision 2026-11-27 (0290): admin lock keys {block_public_sharing, disable_export}, both off by default. Changed only through admin_set_security_locks.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'security.locks' FOR UPDATE;
  cur := public.security_locks_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'block_public_sharing')::boolean = p_block_sharing AND (cur ->> 'disable_export')::boolean = p_disable_export THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the lock keys in force.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('block_public_sharing', p_block_sharing, 'disable_export', p_disable_export),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'security.locks';
  res := public.security_locks_state();
  PERFORM public.log_audit_write('security_locks_update', 'setting', 'security.locks',
    jsonb_build_object('block_public_sharing', cur -> 'block_public_sharing', 'disable_export', cur -> 'disable_export'),
    jsonb_build_object('block_public_sharing', res -> 'block_public_sharing', 'disable_export', res -> 'disable_export'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['security_locks_cfg()', 'security_lock_active(text)', 'security_locks_state()', 'admin_set_security_locks(boolean,boolean,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION security_lock_active(text), security_locks_state(), admin_set_security_locks(boolean, boolean, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION security_locks_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('security_locks_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'security.locks', 'block_public_sharing', false, 'disable_export', false,
          'read', 'security_locks_state', 'write', 'admin_set_security_locks', 'check', 'security_lock_active', 'audit', jsonb_build_array('security_locks_update')),
        'Owner decision 2026-11-27: admin lock keys (block public sharing, disable export), both off by default (migration 0290).');
