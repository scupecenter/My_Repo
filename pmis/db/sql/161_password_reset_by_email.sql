-- 0162: "Forgot password" by email (owner request 2026-11-26, in his own channel). Built the safest way; the admin-issued temporary password (idm_reset_local_password) stays as it is.
--   * One reset link per account: the token is 32 random bytes made by the API, only its SHA-256 is stored (reset_hash). A new request replaces the old link.
--   * Short-lived (30 minutes) and single use: the hash is cleared when the password is set; a wrong or expired token changes nothing.
--   * No user enumeration: auth_pwreset_request never tells the caller whether an account matched; the API answers the same either way.
--   * Only accounts that sign in with a local password and are active, local credentials enabled, not break-glass, not deleted,
--     not linked to Microsoft 365, a valid email on file, and NOT a System Admin (admins get a new password from another admin, as today).
--   * One link per account every 2 minutes (the mail cap per recipient per hour of the mail queue applies as well).
--   * The new password is set by auth_pwreset_complete (the API has already checked the password policy): all sessions of the account end, pending sign-ins end, the
--     failed-attempt count and a lockout in force are NOT cleared (a reset cannot undo a lockout), two-factor stays required at the next sign-in, the API queues a notice mail to the account, and an audit row is written. No row of local_credentials is readable or writable by pmis_app: only these functions.
ALTER TABLE local_credentials
  ADD COLUMN reset_hash         CHAR(64) CHECK (reset_hash IS NULL OR reset_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reset_requested_at TIMESTAMPTZ(6),
  ADD COLUMN reset_expires_at   TIMESTAMPTZ(6);
CREATE UNIQUE INDEX local_credentials_reset_hash ON local_credentials (reset_hash) WHERE reset_hash IS NOT NULL;

-- Stores the link of an eligible account and returns who it is for (user id and email), so the API can queue the mail with the pmis_app mail interface.
-- No row when nothing matches, the account is not eligible or a link was issued less than 2 minutes ago. Callers must not show the difference to the user.
CREATE OR REPLACE FUNCTION auth_pwreset_request(p_identifier text, p_hash text, p_ip inet) RETURNS TABLE (user_id uuid, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u record;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'a SHA-256 hash is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT x.id, x.email AS em, c.reset_requested_at AS asked INTO u
  FROM public.users x JOIN public.local_credentials c ON c.user_id = x.id
  WHERE c.enabled AND NOT x.is_break_glass AND x.deleted_at IS NULL AND x.m365_object_id IS NULL AND x.status = 'active'
    AND NOT coalesce(public.app_user_is_system_admin(x.id), false)
    AND ((p_identifier ~ '^[0-9]{4}$' AND x.employee_id = p_identifier)
      OR (position('@' in p_identifier) > 0 AND x.email = lower(btrim(p_identifier)))
      OR (p_identifier ~ '^\+[1-9][0-9]{7,14}$' AND x.phone = p_identifier))
  LIMIT 1;
  IF NOT FOUND OR NOT public.mail_address_ok(u.em) THEN RETURN; END IF;
  IF u.asked IS NOT NULL AND u.asked > now() - interval '2 minutes' THEN RETURN; END IF;
  UPDATE public.local_credentials SET reset_hash = p_hash, reset_requested_at = now(), reset_expires_at = now() + interval '30 minutes' WHERE local_credentials.user_id = u.id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, actor_id, after)
  VALUES ('password_reset_requested', 'user', u.id::text, u.id, jsonb_build_object('ip', host(p_ip)));
  RETURN QUERY SELECT u.id, u.em;
END $$;

-- The account behind a valid, unused, unexpired link: what the API needs to check the password policy. No row otherwise.
CREATE OR REPLACE FUNCTION auth_pwreset_context(p_hash text)
RETURNS TABLE (user_id uuid, email text, employee_id text, phone text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.email, u.employee_id, u.phone, c.password_hash
  FROM public.local_credentials c JOIN public.users u ON u.id = c.user_id
  WHERE p_hash ~ '^[0-9a-f]{64}$' AND c.reset_hash = p_hash AND c.reset_expires_at > now() AND c.enabled
    AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
$$;

-- Sets the password once. Returns the user id, or NULL when the link is unknown, used or expired (nothing changes).
CREATE OR REPLACE FUNCTION auth_pwreset_complete(p_hash text, p_new_hash text, p_ip inet) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE uid uuid; ended int;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_new_hash IS NULL OR p_new_hash NOT LIKE '$argon2id$%' THEN RETURN NULL; END IF;
  UPDATE public.local_credentials c SET password_hash = p_new_hash, must_change = false, set_at = now(), set_by = c.user_id,
         reset_hash = NULL, reset_requested_at = NULL, reset_expires_at = NULL
  FROM public.users u
  WHERE c.reset_hash = p_hash AND c.reset_expires_at > now() AND c.enabled AND u.id = c.user_id
    AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
  RETURNING c.user_id INTO uid;
  IF uid IS NULL THEN RETURN NULL; END IF;
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = uid, revoke_reason = 'password_reset_by_email' WHERE user_id = uid AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = uid AND used_at IS NULL;
  INSERT INTO public.audit_log (action, entity_type, entity_id, actor_id, after)
  VALUES ('password_reset_by_email', 'user', uid::text, uid, jsonb_build_object('ip', host(p_ip), 'sessions_ended', ended));
  RETURN uid;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auth_pwreset_request(text,text,inet)', 'auth_pwreset_context(text)', 'auth_pwreset_complete(text,text,inet)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
END $$;
