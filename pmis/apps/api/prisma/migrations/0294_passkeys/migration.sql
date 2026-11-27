-- 0294: passkeys (WebAuthn) as an optional alternative second step, slice S4 of the security section (section 3 of the PM-platforms proposal).
--
-- WHY. An account that already uses the authenticator-app code can sign in with a passkey (fingerprint, face, device PIN or a security key) instead of typing the code.
-- It is OFF until a System Admin turns it on in Settings > Security > Passkeys. Never forced: a person adds a passkey only from their own profile. Nothing is deleted,
-- no permission changes, sessions already open keep working, and the password and the authenticator code and its recovery codes keep working exactly as before.
--
-- WHAT THIS ADDS.
--   1. The setting security.passkeys = {"enabled": false}, guarded like 0290 to 0292.
--   2. auth_passkey (only public data: credential id, public key, sign counter; a passkey is revoked, never deleted) and auth_passkey_challenge (a random challenge,
--      only its SHA-256, 5 minutes, single use). No right for pmis_app; reached only through the functions below.
--   3. Doors. Sign-in (owner pmis_identity_owner, the signing-in context must be the user): auth_passkey_creds, auth_passkey_challenge_create, auth_passkey_challenge_take,
--      auth_passkey_used (atomic sign-counter check, a counter that does not move forward is refused as a clone signal). Signed-in (owner pmis_definer, audited):
--      passkey_state, admin_set_passkeys, passkey_add, passkey_list, passkey_revoke, admin_passkey_revoke.
--   4. No lockout: a passkey is only an alternative to the code. When the setting is off, or a passkey is revoked, the code path is untouched. A System Admin can revoke
--      every passkey of one account (audited); a person can revoke their own.
--   5. The WebAuthn signature check itself is done by the API (pinned @simplewebauthn/server behind src/security/webauthn.ts); the database holds the single-use challenge
--      and the counter, so replay is refused here and not only in the API.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON users TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('security.passkeys', '{"enabled": false}'::jsonb, 'Passkeys as an alternative second step (0294): off by default. Changed only through admin_set_passkeys.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_passkeys ON settings;
DROP TRIGGER IF EXISTS b_settings_passkeys_update ON settings;
DROP TRIGGER IF EXISTS b_settings_passkeys_delete ON settings;
CREATE TRIGGER b_settings_passkeys BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'security.passkeys') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_passkeys_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.passkeys' OR NEW.key = 'security.passkeys') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_passkeys_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.passkeys') EXECUTE FUNCTION settings_guarded_keys();

CREATE TABLE auth_passkey (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  credential_id TEXT NOT NULL UNIQUE CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 1400),
  public_key    TEXT NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]+$' AND char_length(public_key) BETWEEN 16 AND 4096),
  sign_count    BIGINT NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports    TEXT[] NOT NULL DEFAULT '{}',
  device_type   TEXT NOT NULL DEFAULT 'singleDevice' CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  label         TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ(6),
  revoked_at    TIMESTAMPTZ(6),
  revoked_by    UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX auth_passkey_user ON auth_passkey (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_passkey_challenge (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_hash CHAR(64) NOT NULL UNIQUE CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ(6) NOT NULL,
  used_at        TIMESTAMPTZ(6)
);
CREATE INDEX auth_passkey_challenge_user ON auth_passkey_challenge (user_id, created_at);

GRANT SELECT, INSERT, UPDATE ON auth_passkey, auth_passkey_challenge TO pmis_identity_owner, pmis_definer;
GRANT SELECT ON users TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON auth_passkey, auth_passkey_challenge FROM pmis_app;
  END IF;
END $$;

-- The setting, sanitised (anything that is not a boolean true reads as off)
CREATE OR REPLACE FUNCTION passkey_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; en boolean := false;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'security.passkeys';
  IF v IS NOT NULL AND jsonb_typeof(v) = 'object' AND jsonb_typeof(v -> 'enabled') = 'boolean' THEN en := (v ->> 'enabled')::boolean; END IF;
  RETURN jsonb_build_object('enabled', en);
END $$;

-- The caller is the signing-in user (pending sign-in context) or the signed-in user themselves.
CREATE OR REPLACE FUNCTION passkey_guard(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_user IS NULL OR (coalesce(public.app_ctx_user()::text, '') <> p_user::text AND coalesce(public.app_actor()::text, '') <> p_user::text) THEN
    RAISE EXCEPTION 'passkey step must be for the signing-in or signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Sign-in and enrolment doors (the person's own context)
-- ---------------------------------------------------------------------------------------------------------------------
-- The active passkeys of the user, only while the feature is on (off reads as none: the code path is the only one).
CREATE OR REPLACE FUNCTION auth_passkey_creds(p_user uuid)
RETURNS TABLE (credential_id text, public_key text, sign_count bigint, transports text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.passkey_guard(p_user);
  IF NOT (public.passkey_cfg() ->> 'enabled')::boolean THEN RETURN; END IF;
  RETURN QUERY SELECT k.credential_id, k.public_key, k.sign_count, k.transports FROM public.auth_passkey k WHERE k.user_id = p_user AND k.revoked_at IS NULL ORDER BY k.created_at;
END $$;

-- Stores the hash of a fresh challenge for 5 minutes. At most 10 open challenges per user and purpose (the oldest stop counting).
CREATE OR REPLACE FUNCTION auth_passkey_challenge_create(p_user uuid, p_hash text, p_purpose text) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE until_at timestamptz := now() + interval '5 minutes';
BEGIN
  PERFORM public.passkey_guard(p_user);
  IF NOT (public.passkey_cfg() ->> 'enabled')::boolean THEN RAISE EXCEPTION 'passkeys are off' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_purpose NOT IN ('register', 'authenticate') THEN RAISE EXCEPTION 'bad purpose' USING ERRCODE = 'invalid_parameter_value'; END IF;
  UPDATE public.auth_passkey_challenge SET used_at = now()
   WHERE user_id = p_user AND purpose = p_purpose AND used_at IS NULL
     AND id NOT IN (SELECT id FROM public.auth_passkey_challenge WHERE user_id = p_user AND purpose = p_purpose AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 9);
  INSERT INTO public.auth_passkey_challenge (challenge_hash, user_id, purpose, expires_at) VALUES (p_hash, p_user, p_purpose, until_at);
  RETURN until_at;
END $$;

-- True once, for an unused, unexpired challenge of this user and purpose. Single use, so a captured response cannot be replayed.
CREATE OR REPLACE FUNCTION auth_passkey_challenge_take(p_user uuid, p_hash text, p_purpose text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM public.passkey_guard(p_user);
  UPDATE public.auth_passkey_challenge SET used_at = now()
   WHERE challenge_hash = p_hash AND user_id = p_user AND purpose = p_purpose AND used_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- ok | clone | unknown | refused. Only inside a pending two-step sign-in of an account that has two-step verification on and enrolled, while the feature is on.
-- The counter must move forward (both zero is allowed: many authenticators never count), atomically. On ok it leaves the same proof the authenticator code leaves
-- (user_totp.last_success_at, the replay step of the code is NOT touched), which auth_session_create already requires: the session door is unchanged.
CREATE OR REPLACE FUNCTION auth_passkey_used(p_user uuid, p_credential text, p_new_count bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM public.passkey_guard(p_user);
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN RETURN 'refused'; END IF;
  IF NOT (public.passkey_cfg() ->> 'enabled')::boolean THEN RETURN 'refused'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.auth_pending pd WHERE pd.user_id = p_user AND pd.kind = 'two_factor' AND pd.used_at IS NULL AND pd.expires_at > now())
     OR EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN
    RETURN 'refused';
  END IF;
  IF p_new_count IS NULL OR p_new_count < 0 THEN RETURN 'clone'; END IF;
  UPDATE public.auth_passkey SET sign_count = p_new_count, last_used_at = now()
   WHERE user_id = p_user AND credential_id = p_credential AND revoked_at IS NULL AND (sign_count < p_new_count OR (sign_count = 0 AND p_new_count = 0));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN
    UPDATE public.user_totp SET last_success_at = now(), failed_count = 0 WHERE user_id = p_user;
    RETURN 'ok';
  END IF;
  RETURN CASE WHEN EXISTS (SELECT 1 FROM public.auth_passkey WHERE user_id = p_user AND credential_id = p_credential AND revoked_at IS NULL) THEN 'clone' ELSE 'unknown' END;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Signed-in doors (audited)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION passkey_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.passkey_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'security.passkeys';
  RETURN jsonb_build_object('enabled', c -> 'enabled',
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', CASE WHEN coalesce(public.app_actor_is_system_admin(), false) THEN coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb) ELSE 'null'::jsonb END,
    'version', public.settings_etag('security.passkeys'), 'can_edit', coalesce(public.app_actor_is_system_admin(), false));
END $$;

CREATE OR REPLACE FUNCTION admin_set_passkeys(p_enabled boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin changes passkeys.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wfe_err1('/enabled', 'required', 'Say whether passkeys are on.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('security.passkeys', '{"enabled": false}'::jsonb, 'Passkeys as an alternative second step (0294): off by default. Changed only through admin_set_passkeys.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'security.passkeys' FOR UPDATE;
  cur := public.passkey_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This is already the passkey setting in force.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'security.passkeys';
  res := public.passkey_state();
  PERFORM public.log_audit_write('passkeys_update', 'setting', 'security.passkeys', jsonb_build_object('enabled', cur -> 'enabled'), jsonb_build_object('enabled', res -> 'enabled'), btrim(p_reason));
  RETURN res;
END $$;

-- Own passkeys (or, for a System Admin, those of one account): never the key material.
CREATE OR REPLACE FUNCTION passkey_list(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_user IS DISTINCT FROM public.app_actor() AND NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You can list only your own passkeys.'));
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'label', k.label, 'created_at', k.created_at, 'last_used_at', k.last_used_at,
                                  'device_type', k.device_type, 'backed_up', k.backed_up) ORDER BY k.created_at)
                     FROM public.auth_passkey k WHERE k.user_id = p_user AND k.revoked_at IS NULL), '[]'::jsonb);
END $$;

-- Adds a verified passkey to the signed-in user. The API has checked the WebAuthn response and the step-up. At most 10 active passkeys per account.
CREATE OR REPLACE FUNCTION passkey_add(p_credential text, p_public_key text, p_count bigint, p_transports text[], p_device_type text, p_backed_up boolean, p_label text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); k public.auth_passkey%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT (public.passkey_cfg() ->> 'enabled')::boolean THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Passkeys are not turned on.')); END IF;
  IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 1 AND 80 THEN PERFORM public.wfe_err1('/label', 'invalid', 'Give the passkey a name of 1 to 80 characters.'); END IF;
  IF (SELECT count(*) FROM public.auth_passkey WHERE user_id = a AND revoked_at IS NULL) >= 10 THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'At most 10 passkeys per account. Remove one first.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_passkey WHERE credential_id = p_credential) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This passkey is already registered.'));
  END IF;
  INSERT INTO public.auth_passkey (user_id, credential_id, public_key, sign_count, transports, device_type, backed_up, label)
  VALUES (a, p_credential, p_public_key, greatest(coalesce(p_count, 0), 0), coalesce(p_transports, '{}'), coalesce(p_device_type, 'singleDevice'), coalesce(p_backed_up, false), btrim(p_label))
  RETURNING * INTO k;
  PERFORM public.log_audit_write('passkey_added', 'user', a::text, NULL, jsonb_build_object('passkey_id', k.id, 'label', k.label), 'Passkey added by the account holder.');
  RETURN jsonb_build_object('id', k.id, 'label', k.label, 'created_at', k.created_at, 'last_used_at', k.last_used_at, 'device_type', k.device_type, 'backed_up', k.backed_up);
END $$;

-- Revokes one own passkey. Never needs the feature to be on (a person can always remove their own).
CREATE OR REPLACE FUNCTION passkey_revoke(p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); n int;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.auth_passkey SET revoked_at = now(), revoked_by = a WHERE id = p_id AND user_id = a AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN
    PERFORM public.log_audit_write('passkey_revoked', 'user', a::text, NULL, jsonb_build_object('passkey_id', p_id, 'by', 'account_holder'), 'Passkey removed by the account holder.');
  END IF;
  RETURN n = 1;
END $$;

-- Recovery: a System Admin revokes every passkey of one account (lost device). The code path is untouched. Returns how many were revoked.
CREATE OR REPLACE FUNCTION admin_passkey_revoke(p_user uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); n int;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin removes someone else''s passkeys.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL) THEN PERFORM public.wfe_err1('/user_id', 'invalid', 'Name an existing user.'); END IF;
  UPDATE public.auth_passkey SET revoked_at = now(), revoked_by = a WHERE user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.log_audit_write('passkeys_revoked_by_admin', 'user', p_user::text, NULL, jsonb_build_object('revoked', n), btrim(p_reason));
  RETURN n;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['passkey_cfg()', 'passkey_state()', 'admin_set_passkeys(boolean,text,integer)', 'passkey_list(uuid)',
                           'passkey_add(text,text,bigint,text[],text,boolean,text)', 'passkey_revoke(uuid)', 'admin_passkey_revoke(uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['passkey_guard(uuid)', 'auth_passkey_creds(uuid)', 'auth_passkey_challenge_create(uuid,text,text)', 'auth_passkey_challenge_take(uuid,text,text)', 'auth_passkey_used(uuid,text,bigint)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_identity_owner', f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION passkey_cfg() TO pmis_identity_owner;
  GRANT EXECUTE ON FUNCTION passkey_guard(uuid) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION app_ctx_user() TO pmis_identity_owner;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION passkey_state(), admin_set_passkeys(boolean, text, integer), passkey_list(uuid), passkey_add(text, text, bigint, text[], text, boolean, text),
      passkey_revoke(uuid), admin_passkey_revoke(uuid, text), auth_passkey_creds(uuid), auth_passkey_challenge_create(uuid, text, text),
      auth_passkey_challenge_take(uuid, text, text), auth_passkey_used(uuid, text, bigint) TO pmis_app;
    REVOKE ALL ON FUNCTION passkey_cfg(), passkey_guard(uuid) FROM pmis_app;
  END IF;
END $$;

-- Data reset coverage: both new tables are identity/access state, KEEP. The stored data_reset_plan() text is patched in place (idempotent), never rebuilt from an old base.
DO $$
DECLARE def text; marker text := '''auth_pending'','; add text := '''auth_passkey'', ''auth_passkey_challenge'',';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('auth_passkey' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no auth_pending row to patch'; END IF;
    EXECUTE replace(def, marker, marker || ' ' || add);
  END IF;
END $$;
GRANT SELECT, UPDATE ON public.auth_passkey, public.auth_passkey_challenge TO pmis_reset_owner;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('passkeys_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'security.passkeys', 'enabled', false, 'read', 'passkey_state', 'write', 'admin_set_passkeys', 'recovery', 'admin_passkey_revoke',
          'audit', jsonb_build_array('passkeys_update', 'passkey_added', 'passkey_revoked', 'passkeys_revoked_by_admin')),
        'Passkeys as an optional alternative second step (migration 0294), off by default.');
