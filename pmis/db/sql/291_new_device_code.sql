-- 0292: email code on a new device, slice S3 of the security section (section 3 of the PM-platforms proposal).
--
-- WHY. A stolen password alone should not open a session from a browser the person has never used. When a System Admin turns this on, a password-only sign-in
-- from a browser this account has not signed in from before needs a 6-digit code sent to the account's own email. It is OFF until a System Admin turns it on in
-- Settings > Security > New-device code. Nothing is deleted, no permission changes, and sessions already open keep working.
--
-- WHAT THIS ADDS.
--   1. The setting security.new_device_code = {"enabled": false, "code_minutes": 10, "include_admins": false}, guarded like 0290 / 0291.
--   2. Tables (no right for pmis_app; reached only through the functions below): auth_known_device (one row per account and browser, only a SHA-256 of the
--      device cookie), auth_device_challenge (a pending code: only hashes, 5 tries, expiry), auth_device_pass (one use, one minute: the proof that the new-device
--      step is done), auth_device_bypass (an admin lets one account in once, for at most 60 minutes).
--   3. auth_session_create is replaced by itself plus one block: when the feature applies to the account, the session needs an unused pass of the last minute.
--      The database enforces it, not only the API. When the feature is off (the default) the function behaves exactly as in 0069.
--   4. The feature NEVER applies to: an account with two-factor on (the code of its authenticator is stronger), the break-glass account, a System Admin (unless
--      include_admins is turned on), an account with no email. If the mail server is not set up the API mints a pass with reason no_mail, so nobody is locked out.
--   5. Recovery: a System Admin can let one account in once (admin_new_device_bypass), or turn the feature off. A System Admin is outside the feature by default,
--      so the person who can turn it off can always sign in.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC. The sign-in functions are owned by
-- pmis_identity_owner like auth_pending_*; the admin functions by pmis_definer.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON users TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('security.new_device_code', '{"enabled": false, "code_minutes": 10, "include_admins": false}'::jsonb,
        'New-device email code (0292): off by default. Changed only through admin_set_new_device_code.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_new_device_code ON settings;
DROP TRIGGER IF EXISTS b_settings_new_device_code_update ON settings;
DROP TRIGGER IF EXISTS b_settings_new_device_code_delete ON settings;
CREATE TRIGGER b_settings_new_device_code BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'security.new_device_code') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_new_device_code_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.new_device_code' OR NEW.key = 'security.new_device_code') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_new_device_code_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.new_device_code') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE auth_known_device (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  device_hash CHAR(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  first_seen  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ip          INET,
  PRIMARY KEY (user_id, device_hash)
);

CREATE TABLE auth_device_challenge (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  code_hash   CHAR(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  device_hash CHAR(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ(6) NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ(6),
  used_at     TIMESTAMPTZ(6),
  ip          INET
);
CREATE INDEX auth_device_challenge_user ON auth_device_challenge (user_id, created_at);

CREATE TABLE auth_device_pass (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  via        TEXT NOT NULL CHECK (via IN ('known', 'code', 'bypass', 'no_mail')),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ(6)
);
CREATE INDEX auth_device_pass_user ON auth_device_pass (user_id, created_at);

CREATE TABLE auth_device_bypass (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_known_device, auth_device_challenge, auth_device_pass, auth_device_bypass TO pmis_identity_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_device_bypass TO pmis_definer;
GRANT SELECT ON users TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON auth_known_device, auth_device_challenge, auth_device_pass, auth_device_bypass FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The setting, sanitised (anything that is not a boolean true reads as off)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION new_device_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; en boolean := false; mins int := 10; adm boolean := false;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'security.new_device_code';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  IF jsonb_typeof(v -> 'enabled') = 'boolean' THEN en := (v ->> 'enabled')::boolean; END IF;
  IF jsonb_typeof(v -> 'include_admins') = 'boolean' THEN adm := (v ->> 'include_admins')::boolean; END IF;
  IF jsonb_typeof(v -> 'code_minutes') = 'number' AND (v ->> 'code_minutes') ~ '^[0-9]+$' AND (v ->> 'code_minutes')::int BETWEEN 5 AND 30 THEN mins := (v ->> 'code_minutes')::int; END IF;
  RETURN jsonb_build_object('enabled', en, 'code_minutes', mins, 'include_admins', adm);
END $$;

-- Does the new-device step apply to this account right now?
CREATE OR REPLACE FUNCTION new_device_applies(p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.new_device_cfg();
BEGIN
  IF NOT (c ->> 'enabled')::boolean THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND NOT u.is_break_glass AND u.email IS NOT NULL AND btrim(u.email) <> '') THEN RETURN false; END IF;
  IF NOT (c ->> 'include_admins')::boolean AND coalesce(public.app_user_is_system_admin(p_user), false) THEN RETURN false; END IF;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Sign-in doors (the signed-in context names the user, the password was just checked)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_device_mint(p_user uuid, p_via text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.auth_device_pass WHERE user_id = p_user AND created_at < now() - interval '1 day';
  INSERT INTO public.auth_device_pass (user_id, via) VALUES (p_user, p_via);
END $$;

CREATE OR REPLACE FUNCTION auth_device_guard(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'new-device step must be for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                 AND (c.locked_until IS NULL OR c.locked_until <= now()) AND c.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Returns not_required | known | bypass | no_mail | challenge. The first four leave a one-minute pass when one is needed.
CREATE OR REPLACE FUNCTION auth_device_check(p_user uuid, p_device text, p_can_mail boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM public.auth_device_guard(p_user);
  IF NOT public.new_device_applies(p_user) THEN RETURN 'not_required'; END IF;
  IF p_device IS NULL OR p_device !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid device' USING ERRCODE = 'invalid_parameter_value'; END IF;
  DELETE FROM public.auth_device_bypass WHERE user_id = p_user AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM public.auth_device_mint(p_user, 'bypass'); RETURN 'bypass'; END IF;
  UPDATE public.auth_known_device SET last_seen = now() WHERE user_id = p_user AND device_hash = p_device;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM public.auth_device_mint(p_user, 'known'); RETURN 'known'; END IF;
  IF NOT coalesce(p_can_mail, false) THEN PERFORM public.auth_device_mint(p_user, 'no_mail'); RETURN 'no_mail'; END IF;
  RETURN 'challenge';
END $$;

-- Creates the pending code. Null when the account asked for 10 codes in the last hour.
CREATE OR REPLACE FUNCTION auth_device_challenge_create(p_user uuid, p_token_hash text, p_code_hash text, p_device text, p_ip inet) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE until_at timestamptz; mins int := (public.new_device_cfg() ->> 'code_minutes')::int;
BEGIN
  PERFORM public.auth_device_guard(p_user);
  IF NOT public.new_device_applies(p_user) THEN RAISE EXCEPTION 'new-device code does not apply' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_device !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid challenge' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT count(*) FROM public.auth_device_challenge WHERE user_id = p_user AND created_at > now() - interval '1 hour') >= 10 THEN RETURN NULL; END IF;
  UPDATE public.auth_device_challenge SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  DELETE FROM public.auth_device_challenge WHERE user_id = p_user AND created_at < now() - interval '1 day';
  until_at := now() + make_interval(mins => mins);
  INSERT INTO public.auth_device_challenge (token_hash, user_id, code_hash, device_hash, expires_at, ip) VALUES (p_token_hash, p_user, p_code_hash, p_device, until_at, p_ip);
  RETURN until_at;
END $$;

-- The mail could not be queued (no valid address, queue error): nobody is locked out, so the code is dropped and a no_mail pass is left. The API logs it.
CREATE OR REPLACE FUNCTION auth_device_mail_failed(p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.auth_device_guard(p_user);
  IF NOT public.new_device_applies(p_user) THEN RETURN; END IF;
  UPDATE public.auth_device_challenge SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  PERFORM public.auth_device_mint(p_user, 'no_mail');
END $$;

-- Who is behind a pending code: nothing when unknown, used or past its end. No actor yet.
CREATE OR REPLACE FUNCTION auth_device_challenge_load(p_token_hash text)
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.user_id, c.expires_at FROM public.auth_device_challenge c WHERE c.token_hash = p_token_hash AND c.used_at IS NULL AND c.expires_at > now();
$$;

-- ok | bad | locked | expired. Five wrong codes end the challenge (the person signs in again to get a new one).
CREATE OR REPLACE FUNCTION auth_device_challenge_verify(p_user uuid, p_token_hash text, p_code_hash text, p_ip inet) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c public.auth_device_challenge%ROWTYPE;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'new-device step must be for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials cr WHERE cr.user_id = p_user AND cr.enabled AND (cr.locked_until IS NULL OR cr.locked_until <= now())
                 AND cr.last_success_at > now() - interval '35 minutes')
     OR NOT public.new_device_applies(p_user) THEN
    RETURN 'expired';
  END IF;
  SELECT * INTO c FROM public.auth_device_challenge WHERE token_hash = p_token_hash AND user_id = p_user FOR UPDATE;
  IF NOT FOUND OR c.used_at IS NOT NULL OR c.expires_at <= now() THEN RETURN 'expired'; END IF;
  IF p_code_hash = c.code_hash THEN
    UPDATE public.auth_device_challenge SET attempts = attempts + 1, verified_at = now(), used_at = now() WHERE id = c.id;
    INSERT INTO public.auth_known_device (user_id, device_hash, ip) VALUES (p_user, c.device_hash, p_ip)
      ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = now(), ip = EXCLUDED.ip;
    PERFORM public.auth_device_mint(p_user, 'code');
    RETURN 'ok';
  END IF;
  UPDATE public.auth_device_challenge SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE NULL END WHERE id = c.id;
  RETURN CASE WHEN c.attempts + 1 >= 5 THEN 'locked' ELSE 'bad' END;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The session door: 0069 plus the new-device pass
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_session_create(p_user uuid, p_token_hash text, p_method "AuthMethod", p_csrf text, p_ip inet, p_user_agent text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE sid uuid; two boolean := false; pass_id uuid; pass_via text;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'session must be created for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_csrf IS NULL OR length(p_csrf) < 32 THEN
    RAISE EXCEPTION 'invalid session token' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass
                 AND u.status IN ('active', 'pending_assignment')) THEN
    RAISE EXCEPTION 'account may not sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_method = 'local' THEN
    two := EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required);
    IF NOT two THEN
      -- 0292: when the new-device step applies, a pass of the last minute is needed (one use). A pass made by a code already carries its own password check.
      IF public.new_device_applies(p_user) THEN
        UPDATE public.auth_device_pass SET used_at = now()
         WHERE id = (SELECT p.id FROM public.auth_device_pass p WHERE p.user_id = p_user AND p.used_at IS NULL AND p.created_at > now() - interval '1 minute'
                      ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE)
        RETURNING id, via INTO pass_id, pass_via;
        IF pass_id IS NULL THEN
          RAISE EXCEPTION 'no recent new-device check' USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
      IF pass_via IS DISTINCT FROM 'code' THEN
        IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                       AND (c.locked_until IS NULL OR c.locked_until <= now())
                       AND c.last_success_at > now() - interval '1 minute') THEN
          RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled AND (c.locked_until IS NULL OR c.locked_until <= now())) THEN
          RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.local_credentials c JOIN public.user_totp t ON t.user_id = c.user_id
                     WHERE c.user_id = p_user AND c.enabled AND (c.locked_until IS NULL OR c.locked_until <= now())
                       AND c.last_success_at > now() - interval '6 minutes'
                       AND t.required AND t.secret_enc IS NOT NULL
                       AND t.last_success_at > now() - interval '1 minute' AND t.last_success_at >= c.last_success_at)
         OR NOT EXISTS (SELECT 1 FROM public.auth_pending p WHERE p.user_id = p_user AND p.used_at > now() - interval '1 minute') THEN
        RAISE EXCEPTION 'no recent successful sign-in with a code' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  ELSE
    -- M365 and break-glass sign-in are not built yet; they extend this function with their own proof.
    RAISE EXCEPTION 'sign-in method % not available', p_method USING ERRCODE = 'feature_not_supported';
  END IF;
  INSERT INTO public.user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at, ip, user_agent, two_factor)
  VALUES (p_token_hash, p_user, p_method, p_csrf, now() + interval '12 hours', p_ip, left(p_user_agent, 400), two)
  RETURNING id INTO sid;
  RETURN sid;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin doors
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION new_device_code_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.new_device_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin manages the new-device code.'));
  END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'security.new_device_code';
  RETURN jsonb_build_object('enabled', c -> 'enabled', 'code_minutes', c -> 'code_minutes', 'include_admins', c -> 'include_admins',
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('security.new_device_code'), 'can_edit', true);
END $$;

CREATE OR REPLACE FUNCTION admin_set_new_device_code(p_enabled boolean, p_code_minutes integer, p_include_admins boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin changes the new-device code.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wfe_err1('/enabled', 'required', 'Say whether the new-device code is on.'); END IF;
  IF p_include_admins IS NULL THEN PERFORM public.wfe_err1('/include_admins', 'required', 'Say whether System Admins are included.'); END IF;
  IF p_code_minutes IS NULL OR p_code_minutes NOT BETWEEN 5 AND 30 THEN PERFORM public.wfe_err1('/code_minutes', 'invalid', 'code_minutes is 5 to 30.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('security.new_device_code', '{"enabled": false, "code_minutes": 10, "include_admins": false}'::jsonb,
          'New-device email code (0292): off by default. Changed only through admin_set_new_device_code.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'security.new_device_code' FOR UPDATE;
  cur := public.new_device_code_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled AND (cur ->> 'code_minutes')::int = p_code_minutes AND (cur ->> 'include_admins')::boolean = p_include_admins THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the new-device settings in force.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled, 'code_minutes', p_code_minutes, 'include_admins', p_include_admins),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'security.new_device_code';
  res := public.new_device_code_state();
  PERFORM public.log_audit_write('new_device_code_update', 'setting', 'security.new_device_code',
    jsonb_build_object('enabled', cur -> 'enabled', 'code_minutes', cur -> 'code_minutes', 'include_admins', cur -> 'include_admins'),
    jsonb_build_object('enabled', res -> 'enabled', 'code_minutes', res -> 'code_minutes', 'include_admins', res -> 'include_admins'), btrim(p_reason));
  RETURN res;
END $$;

-- Lets one account sign in from any browser once, for at most p_minutes. System Admin only, reason, audit.
CREATE OR REPLACE FUNCTION admin_new_device_bypass(p_user uuid, p_minutes integer, p_reason text) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); until_at timestamptz;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin lets someone in without the code.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_minutes IS NULL OR p_minutes NOT BETWEEN 1 AND 60 THEN PERFORM public.wfe_err1('/minutes', 'invalid', 'minutes is 1 to 60.'); END IF;
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND u.status = 'active') THEN
    PERFORM public.wfe_err1('/user_id', 'invalid', 'Name an active user.');
  END IF;
  until_at := now() + make_interval(mins => p_minutes);
  INSERT INTO public.auth_device_bypass (user_id, expires_at, created_by) VALUES (p_user, until_at, a)
    ON CONFLICT (user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by, created_at = now();
  PERFORM public.log_audit_write('new_device_bypass', 'user', p_user::text, NULL, jsonb_build_object('minutes', p_minutes), btrim(p_reason));
  RETURN until_at;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['new_device_cfg()', 'new_device_code_state()', 'admin_set_new_device_code(boolean,integer,boolean,text,integer)', 'admin_new_device_bypass(uuid,integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['new_device_applies(uuid)', 'auth_device_mint(uuid,text)', 'auth_device_guard(uuid)', 'auth_device_check(uuid,text,boolean)',
                           'auth_device_challenge_create(uuid,text,text,text,inet)', 'auth_device_challenge_load(text)',
                           'auth_device_challenge_verify(uuid,text,text,inet)', 'auth_device_mail_failed(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_identity_owner', f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION new_device_cfg() TO pmis_identity_owner;
  GRANT EXECUTE ON FUNCTION app_user_is_system_admin(uuid) TO pmis_identity_owner;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION new_device_code_state(), admin_set_new_device_code(boolean, integer, boolean, text, integer), admin_new_device_bypass(uuid, integer, text),
      auth_device_check(uuid, text, boolean), auth_device_challenge_create(uuid, text, text, text, inet), auth_device_challenge_load(text),
      auth_device_challenge_verify(uuid, text, text, inet), auth_device_mail_failed(uuid) TO pmis_app;
    REVOKE ALL ON FUNCTION new_device_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('new_device_code_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'security.new_device_code', 'enabled', false, 'code_minutes', 10, 'include_admins', false,
          'read', 'new_device_code_state', 'write', 'admin_set_new_device_code', 'recovery', 'admin_new_device_bypass',
          'audit', jsonb_build_array('new_device_code_update', 'new_device_bypass')),
        'New-device email code (migration 0292): a code for a browser the account has not used, off by default.');
