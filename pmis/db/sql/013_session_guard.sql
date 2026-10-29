-- 013: sign-in hardening found by the P1 database security suite (tests/db-security, cases LK-04/05/06 and SS-01).
--
-- 1. auth_local_lookup returned the row and the password hash of a disabled, suspended or deleted account. The API
--    refused them afterwards, but the hash left the database. The lookup now returns only accounts that may sign in.
-- 2. The application role could INSERT any row into user_sessions, so one statement minted a live session for any user
--    from a token of its choice. Sessions are now created only by auth_session_create, which checks that the user may
--    sign in and that a successful password check for that user was recorded in the same minute. The application role
--    keeps UPDATE on the activity, step-up and revoke columns only, and a revoked session can never be revived.
--
-- Residual risk (P1-DB-03): the password itself is checked in the API (argon2id), so the database trusts the API's
-- auth_local_result. A fully compromised application role can still call auth_local_result(.., true) first. The signed
-- session context of P1-DB-03 closes that, together with the forged app.region_ids / app.user_id limits (ADR 0003 §6).

CREATE OR REPLACE FUNCTION auth_local_lookup(p_identifier text)
RETURNS TABLE (user_id uuid, password_hash text, must_change boolean, locked_until timestamptz, status "UserStatus")
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, c.password_hash, c.must_change, c.locked_until, u.status
  FROM public.users u JOIN public.local_credentials c ON c.user_id = u.id
  WHERE c.enabled AND NOT u.is_break_glass AND u.deleted_at IS NULL
    AND u.status IN ('active', 'pending_assignment') AND (
        (p_identifier ~ '^[0-9]{4}$' AND u.employee_id = p_identifier)
     OR (position('@' in p_identifier) > 0 AND u.email = lower(btrim(p_identifier)))
     OR (p_identifier ~ '^\+[1-9][0-9]{7,14}$' AND u.phone = p_identifier))
  LIMIT 1
$$;

-- Creates a session after a successful sign-in. Absolute limit 12 hours (ADR 0012 §4), set here, not by the caller.
CREATE OR REPLACE FUNCTION auth_session_create(p_user uuid, p_token_hash text, p_method "AuthMethod", p_csrf text,
  p_ip inet, p_user_agent text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid;
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
    IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                   AND (c.locked_until IS NULL OR c.locked_until <= now())
                   AND c.last_success_at > now() - interval '1 minute') THEN
      RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- M365 and break-glass sign-in are not built yet; they extend this function with their own proof.
    RAISE EXCEPTION 'sign-in method % not available', p_method USING ERRCODE = 'feature_not_supported';
  END IF;
  INSERT INTO public.user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at, ip, user_agent)
  VALUES (p_token_hash, p_user, p_method, p_csrf, now() + interval '12 hours', p_ip, left(p_user_agent, 400))
  RETURNING id INTO sid;
  RETURN sid;
END $$;

-- A revoked session stays revoked, for every role.
CREATE OR REPLACE FUNCTION user_sessions_no_revive() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason)
                                     IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked session cannot be changed back' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_sessions_no_revive BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION user_sessions_no_revive();

DO $$
BEGIN
  ALTER FUNCTION auth_session_create(uuid,text,"AuthMethod",text,inet,text) OWNER TO pmis_identity_owner;
  REVOKE ALL ON FUNCTION auth_session_create(uuid,text,"AuthMethod",text,inet,text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION auth_session_create(uuid,text,"AuthMethod",text,inet,text) TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON user_sessions FROM pmis_app;
    GRANT UPDATE (last_activity_at, stepup_at, current_screen, revoked_at, revoked_by, revoke_reason) ON user_sessions TO pmis_app;
  END IF;
END $$;
