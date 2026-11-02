-- 0033_totp_two_factor: two-factor authentication (TOTP) for local accounts (owner decision 2026-11-02, ADR 0014).
-- Mirror: db/sql/032_totp_two_factor.sql (kept identical to prisma/migrations/0033_totp_two_factor/migration.sql).
--
-- A code from an authenticator app (RFC 6238, 6 digits, 30 s, SHA-1, one step either side) is asked after the password, and again at step-up.
-- Only a System Admin, or a delegate holding the right `users.two_factor` (delegation grant users.administer), turns it on or off for a
-- user, with a reason and their own step-up; nobody changes their own setting. An admin can reset it (lost phone).
--
-- Where the secrets live. The TOTP secret is encrypted by the API (AES-256-GCM, key TOTP_ENC_KEY from the server environment) before it
-- reaches the database, so the database holds ciphertext only. Recovery codes are stored as a keyed hash (HMAC-SHA-256, key derived from
-- TOTP_ENC_KEY); the database never sees a recovery code in clear and the API never reads the hashes back: auth_totp_use_recovery matches
-- and consumes inside the database. pmis_app has no table right on user_totp, user_recovery_codes or auth_pending: it reaches them only
-- through the auth_totp_* / auth_pending_* functions and the idm_* functions below (SECURITY DEFINER, owner pmis_identity_owner).
--
-- Sign-in, as the database enforces it. For a user whose two-factor is on, auth_session_create refuses unless (a) a password check
-- succeeded in the last 6 minutes, (b) a TOTP or recovery-code success was recorded after it, in the last minute, and (c) a pending
-- sign-in (auth_pending, 5 minutes, single use) was consumed in the last minute. So the API cannot mint a session by skipping the code.
--
-- Counters. Wrong codes are counted apart from wrong passwords (a correct password must not reset the code counter, or a thief with the
-- password could guess codes for ever). Five wrong codes in a row lock the account for 15 minutes through local_credentials.locked_until,
-- the same lock as passwords, and end every pending sign-in of the user. Replay guard: user_totp.last_step is the last accepted time step;
-- auth_totp_result accepts a step only when it is greater, in one atomic UPDATE.

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE user_totp (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  required            BOOLEAN NOT NULL DEFAULT false,            -- two-factor is on (set by an admin)
  secret_enc          TEXT,                                      -- active secret, encrypted by the API; NULL = not enrolled yet
  pending_secret_enc  TEXT,                                      -- secret shown in the QR code, not confirmed yet
  pending_owner       TEXT,                                      -- SHA-256 of the pending sign-in that started the enrolment
  pending_started_at  TIMESTAMPTZ(6),
  enrolled_at         TIMESTAMPTZ(6),
  last_step           BIGINT,                                    -- replay guard: last accepted 30-second step
  failed_count        INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_success_at     TIMESTAMPTZ(6),
  set_by              UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  set_at              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT user_totp_enrolled_pair CHECK ((secret_enc IS NULL) = (enrolled_at IS NULL)),
  CONSTRAINT user_totp_off_holds_nothing CHECK (required OR (secret_enc IS NULL AND pending_secret_enc IS NULL)),
  CONSTRAINT user_totp_pending_owned CHECK ((pending_secret_enc IS NULL) = (pending_owner IS NULL))
);

CREATE TABLE user_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  code_hash   CHAR(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ(6),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX user_recovery_codes_open ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- A sign-in that passed the password and waits for the code (kind two_factor) or for enrolment (kind enrol). Only the SHA-256 of the
-- cookie token is stored. It cannot create a session; it only lets the 2FA endpoints know who is signing in.
CREATE TABLE auth_pending (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('two_factor', 'enrol')),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ(6) NOT NULL,
  used_at     TIMESTAMPTZ(6),
  ip          INET
);
CREATE INDEX auth_pending_user ON auth_pending (user_id, created_at);

ALTER TABLE user_sessions ADD COLUMN two_factor BOOLEAN NOT NULL DEFAULT false;   -- the session passed a code at sign-in

GRANT SELECT, INSERT, UPDATE, DELETE ON user_totp, user_recovery_codes, auth_pending TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON user_totp, user_recovery_codes, auth_pending FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Reading the state. No secret in the answer, so the user list and the session can ask for any user.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_totp_remaining(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*)::int FROM public.user_recovery_codes WHERE user_id = p_user AND used_at IS NULL
$$;

CREATE OR REPLACE FUNCTION auth_totp_state(p_user uuid)
RETURNS TABLE (required boolean, enrolled boolean, recovery_remaining integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(t.required, false), coalesce(t.secret_enc IS NOT NULL, false),
         CASE WHEN t.secret_enc IS NOT NULL THEN public.auth_totp_remaining(p_user) ELSE 0 END
  FROM (SELECT 1) one LEFT JOIN public.user_totp t ON t.user_id = p_user
$$;

-- The encrypted secrets and the replay guard of the signed-in (or signing-in) user, for the API to verify a code.
CREATE OR REPLACE FUNCTION auth_totp_secret(p_user uuid)
RETURNS TABLE (secret_enc text, pending_secret_enc text, last_step bigint, locked_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own two-factor secret' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT t.secret_enc, t.pending_secret_enc, t.last_step, c.locked_until
    FROM public.user_totp t JOIN public.local_credentials c ON c.user_id = t.user_id
    WHERE t.user_id = p_user AND t.required AND c.enabled;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Wrong codes: counted apart from passwords; five lock the account for 15 minutes (the password lock) and end pending sign-ins.
-- Internal: not granted to pmis_app.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_totp_note_failure(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN
  UPDATE public.user_totp SET failed_count = failed_count + 1 WHERE user_id = p_user RETURNING failed_count INTO n;
  IF n IS NOT NULL AND n >= 5 THEN
    UPDATE public.user_totp SET failed_count = 0 WHERE user_id = p_user;
    UPDATE public.local_credentials SET locked_until = now() + interval '15 minutes' WHERE user_id = p_user;
    UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
    INSERT INTO public.audit_log (action, entity_type, entity_id, actor_id) VALUES ('two_factor_locked', 'user', p_user::text, p_user);
  END IF;
END $$;

-- Records the outcome of a TOTP check done by the API. Returns 'ok', 'bad' (wrong code), 'replay' (valid code, step already used)
-- or 'locked'. A locked account is refused without counting. Success needs a step greater than the last accepted one (atomic).
-- A wrong code also counts while enrolment is not confirmed yet (the pending secret is being checked).
CREATE OR REPLACE FUNCTION auth_totp_result(p_user uuid, p_success boolean, p_step bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own two-factor code' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required) THEN RETURN 'bad'; END IF;
  IF NOT p_success THEN
    PERFORM public.auth_totp_note_failure(p_user);
    RETURN 'bad';
  END IF;
  IF p_step IS NULL THEN RAISE EXCEPTION 'a time step is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
  UPDATE public.user_totp SET last_step = p_step, failed_count = 0, last_success_at = now()
    WHERE user_id = p_user AND secret_enc IS NOT NULL AND (last_step IS NULL OR last_step < p_step);
  IF FOUND THEN RETURN 'ok'; END IF;
  PERFORM public.auth_totp_note_failure(p_user);
  RETURN 'replay';
END $$;

-- A recovery code instead of a TOTP code: matched and consumed here, once. A wrong one counts like a wrong TOTP code.
CREATE OR REPLACE FUNCTION auth_totp_use_recovery(p_user uuid, p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE left_n int;
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own recovery code' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL) THEN RETURN 'bad'; END IF;
  UPDATE public.user_recovery_codes SET used_at = now() WHERE user_id = p_user AND code_hash = p_hash AND used_at IS NULL;
  IF NOT FOUND THEN
    PERFORM public.auth_totp_note_failure(p_user);
    RETURN 'bad';
  END IF;
  UPDATE public.user_totp SET failed_count = 0, last_success_at = now() WHERE user_id = p_user;
  left_n := public.auth_totp_remaining(p_user);
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_recovery_used', 'user', p_user::text, jsonb_build_object('recovery_codes_remaining', left_n + 1),
          jsonb_build_object('recovery_codes_remaining', left_n), p_user);
  RETURN 'ok';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Enrolment (a user whose two-factor is on and not set up yet) and recovery codes
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_totp_begin_enrol(p_user uuid, p_secret_enc text, p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_secret_enc IS NULL OR p_secret_enc !~ '^v1:[A-Za-z0-9+/=_-]{20,}$' THEN
    RAISE EXCEPTION 'invalid secret envelope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner IS NULL OR p_owner !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid pending sign-in' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The first sign-in that starts an enrolment keeps it for 10 minutes: another sign-in (even with the right password)
  -- cannot replace the secret shown in that QR code. The same sign-in may restart it.
  UPDATE public.user_totp SET pending_secret_enc = p_secret_enc, pending_owner = p_owner, pending_started_at = now()
  WHERE user_id = p_user AND required AND secret_enc IS NULL
    AND (pending_owner IS NULL OR pending_owner = p_owner OR pending_started_at < now() - interval '10 minutes');
  IF NOT FOUND THEN RAISE EXCEPTION 'two-factor is not waiting for enrolment, or another sign-in is enrolling' USING ERRCODE = 'insufficient_privilege'; END IF;
END $$;

-- The code was checked by the API against the pending secret. Moves it to the active secret, stores the 10 recovery-code hashes.
CREATE OR REPLACE FUNCTION auth_totp_confirm_enrol(p_user uuid, p_step bigint, p_hashes text[], p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_step IS NULL OR p_hashes IS NULL OR cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION 'a step and 10 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN
    RAISE EXCEPTION 'account is locked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.user_totp SET secret_enc = pending_secret_enc, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL,
    enrolled_at = now(), last_step = p_step, failed_count = 0, last_success_at = now()
    WHERE user_id = p_user AND required AND secret_enc IS NULL AND pending_secret_enc IS NOT NULL AND pending_owner = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to confirm' USING ERRCODE = 'insufficient_privilege'; END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  INSERT INTO public.user_recovery_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) h;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_enrolled', 'user', p_user::text, jsonb_build_object('two_factor', 'pending_enrolment'),
          jsonb_build_object('two_factor', 'on', 'recovery_codes_remaining', 10), p_user);
END $$;

-- New recovery codes (the old ones stop working). The API has checked a valid TOTP code, and recorded it with auth_totp_result, just before.
CREATE OR REPLACE FUNCTION auth_totp_regenerate_recovery(p_user uuid, p_hashes text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE before_n int;
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own recovery codes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_hashes IS NULL OR cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION '10 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL
                 AND t.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'a valid code is required first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  before_n := public.auth_totp_remaining(p_user);
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  INSERT INTO public.user_recovery_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) h;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_recovery_regenerated', 'user', p_user::text, jsonb_build_object('recovery_codes_remaining', before_n),
          jsonb_build_object('recovery_codes_remaining', 10), p_user);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Pending sign-in (password passed, code or enrolment still to do)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_pending_create(p_user uuid, p_token_hash text, p_kind text, p_ip inet) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE until_at timestamptz := now() + interval '5 minutes';
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'pending sign-in must be created for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_kind NOT IN ('two_factor', 'enrol') THEN
    RAISE EXCEPTION 'invalid pending token' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass
                 AND u.status IN ('active', 'pending_assignment')) THEN
    RAISE EXCEPTION 'account may not sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                 AND (c.locked_until IS NULL OR c.locked_until <= now()) AND c.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'two_factor' AND NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'two-factor is not set up for this user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'enrol' AND NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NULL) THEN
    RAISE EXCEPTION 'two-factor is not waiting for enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.auth_pending WHERE user_id = p_user AND expires_at < now() - interval '1 day';
  INSERT INTO public.auth_pending (token_hash, user_id, kind, expires_at, ip) VALUES (p_token_hash, p_user, p_kind, until_at, p_ip);
  RETURN until_at;
END $$;

-- Who is behind a pending token: nothing when it is unknown, used or past its 5 minutes. No actor yet (the session does not exist).
CREATE OR REPLACE FUNCTION auth_pending_load(p_token_hash text)
RETURNS TABLE (user_id uuid, kind text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.user_id, p.kind, p.expires_at FROM public.auth_pending p
  WHERE p.token_hash = p_token_hash AND p.used_at IS NULL AND p.expires_at > now()
$$;

-- Single use: true once, then false.
CREATE OR REPLACE FUNCTION auth_pending_consume(p_token_hash text, p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own pending sign-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.auth_pending SET used_at = now()
    WHERE token_hash = p_token_hash AND user_id = p_user AND used_at IS NULL AND expires_at > now();
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Sessions: the guard of 013 plus the code
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_session_create(p_user uuid, p_token_hash text, p_method "AuthMethod", p_csrf text,
  p_ip inet, p_user_agent text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid; two boolean := false;
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
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
      IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                     AND (c.locked_until IS NULL OR c.locked_until <= now())
                     AND c.last_success_at > now() - interval '1 minute') THEN
        RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSE
      -- Two-factor is on: password (within 6 minutes: the pending sign-in lasts 5), then a code success after it (within 1 minute),
      -- then a pending sign-in consumed within the minute. Enrolment counts: confirming the first code is the code success.
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
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin writes (System Admin, or a delegate holding users.two_factor = delegation grant users.administer)
-- ---------------------------------------------------------------------------------------------------------------------
-- Common checks of the admin functions. Returns the actor.
CREATE OR REPLACE FUNCTION idm_two_factor_guard(p_user uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'administer');
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'administer');
  IF p_user = a THEN
    RAISE EXCEPTION 'two-factor: you cannot change your own account; another admin does it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.idm_assert_user_change_allowed(p_user);
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user AND NOT is_break_glass AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials WHERE user_id = p_user AND enabled) THEN
    RAISE EXCEPTION 'two-factor needs a local account with sign-in on';
  END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION idm_two_factor_label(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN NOT s.required THEN 'off' WHEN s.enrolled THEN 'on' ELSE 'pending_enrolment' END FROM public.auth_totp_state(p_user) s
$$;

-- Turns two-factor on or off for a user. On: the user enrols at the next sign-in, and the user's open sessions end (so no session
-- lives on without a code). Off: the secret and the recovery codes are deleted. Setting what is already set changes nothing.
CREATE OR REPLACE FUNCTION idm_set_two_factor(p_user uuid, p_enabled boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); before_label text := public.idm_two_factor_label(p_user);
        before_n int := public.auth_totp_remaining(p_user); ended int := 0;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'enabled is required'; END IF;
  IF p_enabled THEN
    IF before_label <> 'off' THEN RETURN before_label; END IF;
    INSERT INTO public.user_totp (user_id, required, set_by, set_at) VALUES (p_user, true, a, now())
      ON CONFLICT (user_id) DO UPDATE SET required = true, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL,
        failed_count = 0, last_success_at = NULL, set_by = a, set_at = now();
    UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'two_factor_enabled'
      WHERE user_id = p_user AND revoked_at IS NULL AND auth_method = 'local';
    GET DIAGNOSTICS ended = ROW_COUNT;
  ELSE
    IF before_label = 'off' THEN RETURN before_label; END IF;
    DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
    UPDATE public.user_totp SET required = false, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL,
      failed_count = 0, last_success_at = NULL, set_by = a, set_at = now() WHERE user_id = p_user;
    UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  END IF;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit(CASE WHEN p_enabled THEN 'two_factor_enabled' ELSE 'two_factor_disabled' END, 'user', p_user::text,
    jsonb_build_object('two_factor', before_label, 'recovery_codes_remaining', before_n),
    jsonb_build_object('two_factor', public.idm_two_factor_label(p_user), 'recovery_codes_remaining', public.auth_totp_remaining(p_user), 'sessions_ended', ended),
    p_reason);
  RETURN public.idm_two_factor_label(p_user);
END $$;

-- Lost phone: clears the secret and the recovery codes, forces a new enrolment at the next sign-in, ends the user's sessions.
CREATE OR REPLACE FUNCTION idm_reset_two_factor(p_user uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); before_label text := public.idm_two_factor_label(p_user);
        before_n int := public.auth_totp_remaining(p_user); ended int;
BEGIN
  IF before_label = 'off' THEN RAISE EXCEPTION 'two-factor is not on for this user: nothing to reset'; END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  UPDATE public.user_totp SET secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL, failed_count = 0,
    last_success_at = NULL, set_by = a, set_at = now() WHERE user_id = p_user;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'two_factor_reset'
    WHERE user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit('two_factor_reset', 'user', p_user::text,
    jsonb_build_object('two_factor', before_label, 'recovery_codes_remaining', before_n),
    jsonb_build_object('two_factor', 'pending_enrolment', 'recovery_codes_remaining', 0, 'sessions_ended', ended), p_reason);
  RETURN 'pending_enrolment';
END $$;

-- The sole admin lost the phone and no other admin exists: the installer (migration role or superuser, like idm_bootstrap_admin)
-- clears the admin's secret on the server. p_disable = true also turns two-factor off.
CREATE OR REPLACE FUNCTION idm_installer_reset_two_factor(p_email text, p_disable boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE uid uuid; before_label text;
BEGIN
  IF NOT pg_has_role(session_user, 'pmis_migrator', 'member') THEN
    RAISE EXCEPTION 'this reset is for the installer only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO uid FROM public.users WHERE email = lower(btrim(p_email)) AND NOT is_break_glass;
  IF uid IS NULL THEN RAISE EXCEPTION 'user not found'; END IF;
  before_label := public.idm_two_factor_label(uid);
  IF before_label = 'off' THEN RETURN; END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = uid;
  UPDATE public.user_totp SET required = NOT coalesce(p_disable, false), secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL,
    last_step = NULL, failed_count = 0, last_success_at = NULL, set_at = now() WHERE user_id = uid;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = uid AND used_at IS NULL;
  UPDATE public.user_sessions SET revoked_at = now(), revoke_reason = 'two_factor_reset' WHERE user_id = uid AND revoked_at IS NULL;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason)
  VALUES (CASE WHEN p_disable THEN 'two_factor_disabled' ELSE 'two_factor_reset' END, 'user', uid::text,
          jsonb_build_object('two_factor', before_label),
          jsonb_build_object('two_factor', public.idm_two_factor_label(uid)), 'installer');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auth_totp_remaining(uuid)','auth_totp_state(uuid)','auth_totp_secret(uuid)','auth_totp_note_failure(uuid)',
    'auth_totp_result(uuid,boolean,bigint)','auth_totp_use_recovery(uuid,text)','auth_totp_begin_enrol(uuid,text,text)',
    'auth_totp_confirm_enrol(uuid,bigint,text[],text)','auth_totp_regenerate_recovery(uuid,text[])','auth_pending_create(uuid,text,text,inet)',
    'auth_pending_load(text)','auth_pending_consume(text,uuid)','idm_two_factor_guard(uuid,text)','idm_two_factor_label(uuid)',
    'idm_set_two_factor(uuid,boolean,text)','idm_reset_two_factor(uuid,text)','idm_installer_reset_two_factor(text,boolean)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: auth_totp_note_failure (internal), idm_two_factor_guard (internal), idm_installer_reset_two_factor (installer only)
    FOREACH f IN ARRAY ARRAY['auth_totp_remaining(uuid)','auth_totp_state(uuid)','auth_totp_secret(uuid)',
      'auth_totp_result(uuid,boolean,bigint)','auth_totp_use_recovery(uuid,text)','auth_totp_begin_enrol(uuid,text,text)',
      'auth_totp_confirm_enrol(uuid,bigint,text[],text)','auth_totp_regenerate_recovery(uuid,text[])','auth_pending_create(uuid,text,text,inet)',
      'auth_pending_load(text)','auth_pending_consume(text,uuid)','idm_two_factor_label(uuid)',
      'idm_set_two_factor(uuid,boolean,text)','idm_reset_two_factor(uuid,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
