-- 009: local sign-in (owner decision 2026-10-28, ADR 0012). Users created in the PMIS sign in with an identifier
-- (4-digit employee ID, email or E.164 phone) and a password. Microsoft 365 comes later and lives beside it.
--
-- Password hashes (argon2id, PHC string) are made and checked by the API. pmis_app cannot read or write local_credentials:
-- it goes through the auth_local_* functions (sign-in bookkeeping, own password) and the idm_* functions (admin writes),
-- all owned by pmis_identity_owner. Sessions live in user_sessions (instead of Redis, ADR 0012 §4); the cookie holds a
-- random token and only its SHA-256 is stored.

-- ---------------------------------------------------------------------------------------------------------------------
-- Users: local accounts have no Entra object id yet; phone is a sign-in identifier
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN m365_object_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD CONSTRAINT users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE users ADD CONSTRAINT users_email_lower CHECK (email = lower(email));
CREATE UNIQUE INDEX users_phone_key ON users (phone);

CREATE TYPE "AuthMethod" AS ENUM ('local', 'm365', 'break_glass');

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE local_credentials (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  password_hash    TEXT NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  must_change      BOOLEAN NOT NULL DEFAULT true,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  set_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  set_by           UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  failed_count     INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until     TIMESTAMPTZ(6),
  last_success_at  TIMESTAMPTZ(6)
);

CREATE TABLE user_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash        CHAR(64) NOT NULL UNIQUE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  auth_method       "AuthMethod" NOT NULL,
  csrf_token        TEXT NOT NULL,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ(6) NOT NULL,
  stepup_at         TIMESTAMPTZ(6),
  ip                INET,
  user_agent        TEXT,
  current_screen    TEXT,
  revoked_at        TIMESTAMPTZ(6),
  revoked_by        UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  revoke_reason     TEXT
);
CREATE INDEX user_sessions_user_open ON user_sessions (user_id) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON local_credentials, user_sessions TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON local_credentials FROM pmis_app;
    -- The API owns its sessions (as it would own Redis keys); it never deletes them, revoke sets revoked_at.
    REVOKE ALL ON user_sessions FROM pmis_app;
    GRANT SELECT, INSERT, UPDATE ON user_sessions TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Sign-in bookkeeping (no actor yet: these run before the session exists)
-- ---------------------------------------------------------------------------------------------------------------------
-- Resolve an identifier to a local account. Returns no row when nothing matches or local sign-in is off for the user,
-- so the API answers the same way in both cases.
CREATE OR REPLACE FUNCTION auth_local_lookup(p_identifier text)
RETURNS TABLE (user_id uuid, password_hash text, must_change boolean, locked_until timestamptz, status "UserStatus")
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, c.password_hash, c.must_change, c.locked_until, u.status
  FROM public.users u JOIN public.local_credentials c ON c.user_id = u.id
  WHERE c.enabled AND NOT u.is_break_glass AND (
        (p_identifier ~ '^[0-9]{4}$' AND u.employee_id = p_identifier)
     OR (position('@' in p_identifier) > 0 AND u.email = lower(btrim(p_identifier)))
     OR (p_identifier ~ '^\+[1-9][0-9]{7,14}$' AND u.phone = p_identifier))
  LIMIT 1
$$;

-- The signed-in user's own hash, for step-up and password change.
CREATE OR REPLACE FUNCTION auth_local_own_hash(p_user uuid)
RETURNS TABLE (password_hash text, locked_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own credentials' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT c.password_hash, c.locked_until FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled;
END $$;

-- Record a password check. 5 failures in a row lock the account for 15 minutes.
CREATE OR REPLACE FUNCTION auth_local_result(p_user uuid, p_success boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN
  IF p_success THEN
    UPDATE public.local_credentials SET failed_count = 0, locked_until = NULL, last_success_at = now() WHERE user_id = p_user;
    UPDATE public.users SET last_login_at = now(), updated_at = now() WHERE id = p_user;
  ELSE
    UPDATE public.local_credentials SET failed_count = failed_count + 1 WHERE user_id = p_user RETURNING failed_count INTO n;
    IF n >= 5 THEN
      UPDATE public.local_credentials SET failed_count = 0, locked_until = now() + interval '15 minutes' WHERE user_id = p_user;
      INSERT INTO public.audit_log (action, entity_type, entity_id, actor_id) VALUES ('local_sign_in_locked', 'user', p_user::text, p_user);
    END IF;
  END IF;
END $$;

-- The signed-in user sets a new password (the API has already checked the current one and the policy).
CREATE OR REPLACE FUNCTION auth_local_set_own_password(p_user uuid, p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own password' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.local_credentials SET password_hash = p_hash, must_change = false, set_at = now(), set_by = p_user,
    failed_count = 0, locked_until = NULL WHERE user_id = p_user AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'local sign-in is not enabled for this user'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, actor_id) VALUES ('password_changed', 'user', p_user::text, p_user);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin writes (System Admin or a delegation of users.create / users.edit, ADR 0003 §7)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_create_local_user(p_email text, p_display text, p_employee_id text, p_phone text, p_hash text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'create'); uid uuid;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'create');
  IF coalesce(btrim(p_display), '') = '' OR coalesce(btrim(p_email), '') = '' THEN RAISE EXCEPTION 'name and email are required'; END IF;
  IF p_employee_id IS NOT NULL AND p_employee_id !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'employee id is 4 digits'; END IF;
  INSERT INTO public.users (email, display_name, employee_id, phone, status, updated_at)
  VALUES (lower(btrim(p_email)), btrim(p_display), p_employee_id, nullif(btrim(p_phone), ''), 'pending_assignment', now())
  RETURNING id INTO uid;
  INSERT INTO public.local_credentials (user_id, password_hash, must_change, set_by) VALUES (uid, p_hash, true, a);
  PERFORM public.idm_audit('user_created_local', 'user', uid::text, NULL,
    jsonb_build_object('email', lower(btrim(p_email)), 'display_name', btrim(p_display), 'employee_id', p_employee_id, 'phone', p_phone), p_reason);
  RETURN uid;
END $$;

-- A temporary password set by an admin: the user must change it at the next sign-in; their open sessions end.
CREATE OR REPLACE FUNCTION idm_reset_local_password(p_user uuid, p_hash text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit');
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  IF p_user = a THEN RAISE EXCEPTION 'use change password for your own account' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_assert_user_change_allowed(p_user);
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user AND NOT is_break_glass) THEN RAISE EXCEPTION 'user not found'; END IF;
  -- Whoever sets a password can sign in as the user, so a delegate may do it only for an account that holds no rights:
  -- no current or future assignment and no Entra link. Everything else is System Admin only.
  IF NOT public.app_actor_is_system_admin() THEN
    IF EXISTS (SELECT 1 FROM public.user_role_assignments r WHERE r.user_id = p_user AND (r.valid_to IS NULL OR r.valid_to > now())) THEN
      RAISE EXCEPTION 'this user holds assignments: System Admin only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users WHERE id = p_user AND m365_object_id IS NOT NULL) THEN
      RAISE EXCEPTION 'this user signs in with Microsoft 365: System Admin only' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  INSERT INTO public.local_credentials (user_id, password_hash, must_change, set_by) VALUES (p_user, p_hash, true, a)
  ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = true, enabled = true, set_at = now(),
    set_by = a, failed_count = 0, locked_until = NULL;
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'password_reset' WHERE user_id = p_user AND revoked_at IS NULL;
  PERFORM public.idm_audit('password_reset', 'user', p_user::text, NULL, jsonb_build_object('must_change', true), p_reason);
END $$;

-- First System Admin of a new installation. Migration role or superuser only (the installer), never the app.
CREATE OR REPLACE FUNCTION idm_bootstrap_admin(p_email text, p_display text, p_employee_id text, p_phone text, p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE uid uuid; gid uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'pmis_migrator', 'member') THEN
    RAISE EXCEPTION 'bootstrap is for the installer only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO gid FROM public.groups WHERE is_system_admins LIMIT 1;
  IF gid IS NULL THEN
    INSERT INTO public.groups (name, description, is_system_admins) VALUES ('System Admins', 'Full control (created by the installer)', true) RETURNING id INTO gid;
  END IF;
  SELECT id INTO uid FROM public.users WHERE email = lower(btrim(p_email));
  IF uid IS NULL THEN
    INSERT INTO public.users (email, display_name, employee_id, phone, status, updated_at)
    VALUES (lower(btrim(p_email)), btrim(p_display), p_employee_id, nullif(btrim(p_phone), ''), 'active', now()) RETURNING id INTO uid;
  ELSE
    UPDATE public.users SET status = 'active', updated_at = now() WHERE id = uid;
  END IF;
  INSERT INTO public.local_credentials (user_id, password_hash, must_change) VALUES (uid, p_hash, false)
  ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = false, enabled = true, set_at = now(),
    failed_count = 0, locked_until = NULL;
  INSERT INTO public.group_members (group_id, user_id) VALUES (gid, uid) ON CONFLICT DO NOTHING;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason)
  VALUES ('admin_bootstrapped', 'user', uid::text, jsonb_build_object('email', lower(btrim(p_email))), 'installer');
  RETURN uid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auth_local_lookup(text)','auth_local_own_hash(uuid)','auth_local_result(uuid,boolean)',
    'auth_local_set_own_password(uuid,text)','idm_create_local_user(text,text,text,text,text,text)',
    'idm_reset_local_password(uuid,text,text)','idm_bootstrap_admin(text,text,text,text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['auth_local_lookup(text)','auth_local_own_hash(uuid)','auth_local_result(uuid,boolean)',
      'auth_local_set_own_password(uuid,text)','idm_create_local_user(text,text,text,text,text,text)',
      'idm_reset_local_password(uuid,text,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
