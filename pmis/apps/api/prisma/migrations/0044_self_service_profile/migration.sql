-- 0044_self_service_profile: the self-service "My profile" page (owner decisions 2026-11-02, ADR 0014 amendment 2).
-- Mirror: db/sql/043_self_service_profile.sql (kept identical to prisma/migrations/0044_self_service_profile/migration.sql).
--
-- What a user may now do for their own account, and only through the functions below (SECURITY DEFINER, owner pmis_identity_owner):
--   1. Profile: change their own display name, phone (E.164, unique), language and theme (idm_update_own_profile). Email, employee ID,
--      status, roles, team, regions, department and manager stay admin-owned: the function refuses any other field.
--   2. Email: ask for a new email with the password re-entered (idm_request_email_change). The request waits as "pending"; only a System
--      Admin or a delegate holding users.edit for all regions approves or rejects it with a reason (idm_decide_email_change), never on
--      their own account, and a delegate never for an admin or a delegate. Only an approval changes users.email. The user may cancel
--      while it is pending (idm_cancel_email_change). Admins are told in the inbox when a request arrives, the user when it is decided.
--   3. Two-factor: turn it on with a full signed-in local session and a fresh step-up of that session, without an admin enrolment code
--      (auth_totp_self_begin_enrol, auth_totp_self_confirm_enrol), and turn it off with the password plus a code or a recovery code
--      (auth_totp_self_disable) unless an admin enforced it. The admin path of 0033 and 0034 (enrolment code) is unchanged.
--
-- Enforced by an admin. user_totp.enforced is true when an admin turned two-factor on (every row that is on when this migration runs was
-- turned on by an admin, so they all start enforced). An admin can also mark or unmark it (idm_set_two_factor_enforced: reason, never
-- one's own account, a delegate never for an admin). While it is enforced, auth_totp_self_disable refuses with 'two_factor_enforced'.
-- A trigger keeps enforced false whenever two-factor is off, so no path (the installer reset included) can leave an "enforced off" row.
--
-- Why the self path needs no enrolment code. The code of 0034 closes trust on first use at SIGN-IN: someone who knows only the password
-- must not put their phone on an account that waits for enrolment. The self path never runs at sign-in: it needs a live local session
-- (which already passed the password, and the code when one was set) and a step-up of that same session in the last
-- stepup_max_age_seconds, checked here and not only in the API. The secret shown in the QR code belongs to that session (pending_owner
-- 'session:<id>') for 10 minutes and nobody else can confirm it. Confirming ends the user's other sessions (they never passed a code)
-- and marks the current one as having passed a code. auth_session_create is not touched: once two-factor is on, every new session needs
-- the code exactly as before.
--
-- Why turning it off needs the password and a code. A stolen open session alone must not remove the second factor: the API checks the
-- password (auth_local_result, counted toward the same lock as sign-in) and a TOTP or recovery code (auth_totp_result /
-- auth_totp_use_recovery, counted and replay-guarded), and auth_totp_self_disable refuses unless both successes were recorded in the last
-- minute, the code after the password, for this user.
--
-- pmis_app keeps no table right on user_totp and gets none on email_change_requests (REVOKE ALL here and in db/sql/app_grants.sql).

-- ---------------------------------------------------------------------------------------------------------------------
-- Two-factor: the enforced flag, and a pending secret while two-factor is still off (self enrolment)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE user_totp ADD COLUMN enforced BOOLEAN NOT NULL DEFAULT false;
UPDATE user_totp SET enforced = true WHERE required;

-- 0033 forbade any secret while two-factor is off. A self enrolment holds its pending secret before it is on, so only the active secret
-- is forbidden now; the pending one must then belong to a session ('session:<uuid>'), never to a sign-in.
ALTER TABLE user_totp DROP CONSTRAINT user_totp_off_holds_nothing;
ALTER TABLE user_totp ADD CONSTRAINT user_totp_off_holds_nothing CHECK (required OR secret_enc IS NULL);
ALTER TABLE user_totp ADD CONSTRAINT user_totp_off_pending_is_self CHECK (required OR pending_owner IS NULL OR pending_owner LIKE 'session:%');
ALTER TABLE user_totp ADD CONSTRAINT user_totp_enforced_needs_on CHECK (NOT enforced OR required);

CREATE OR REPLACE FUNCTION user_totp_enforced_follows() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT NEW.required THEN NEW.enforced := false; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_enforced_follows BEFORE INSERT OR UPDATE ON user_totp FOR EACH ROW EXECUTE FUNCTION user_totp_enforced_follows();

-- What may be shown about it (no secret): for the user list, the profile and the session.
CREATE OR REPLACE FUNCTION auth_totp_enforced(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT t.enforced AND t.required FROM public.user_totp t WHERE t.user_id = p_user), false)
$$;

-- The step-up window (setting stepup_max_age_seconds, kept between 30 and 3600, 300 when absent), as the API reads it.
CREATE OR REPLACE FUNCTION idm_stepup_seconds() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(s.value) = 'number' AND (s.value #>> '{}')::numeric BETWEEN 30 AND 3600
                               THEN round((s.value #>> '{}')::numeric)::int END
                     FROM public.settings s WHERE s.key = 'stepup_max_age_seconds'), 300)
$$;

-- The caller's own live local session (not revoked, not past its limits), optionally with a step-up inside the window. Internal.
CREATE OR REPLACE FUNCTION auth_self_session_ok(p_user uuid, p_session uuid, p_need_stepup boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_sessions s
                 WHERE s.id = p_session AND s.user_id = p_user AND s.auth_method = 'local' AND s.revoked_at IS NULL
                   AND s.expires_at > now() AND s.last_activity_at > now() - interval '8 hours'
                   AND (NOT p_need_stepup OR s.stepup_at > now() - make_interval(secs => public.idm_stepup_seconds())))
$$;

-- Common checks of the self paths: the signed-in user acts on their own row, with a local account that may sign in. Internal.
CREATE OR REPLACE FUNCTION auth_self_guard(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_user IS NULL OR coalesce(current_setting('app.user_id', true), '') <> p_user::text OR public.app_actor() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'only your own two-factor, signed in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass) THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled) THEN
    RAISE EXCEPTION 'two-factor needs a local account with sign-in on';
  END IF;
END $$;

-- Self enrolment, step 1: a new pending secret for the QR code, owned by this session for 10 minutes. 'ok' or 'locked'.
CREATE OR REPLACE FUNCTION auth_totp_self_begin_enrol(p_user uuid, p_session uuid, p_secret_enc text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.auth_self_guard(p_user);
  IF p_secret_enc IS NULL OR p_secret_enc !~ '^v1:[A-Za-z0-9+/=_-]{20,}$' THEN
    RAISE EXCEPTION 'invalid secret envelope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required) THEN
    RAISE EXCEPTION 'two-factor is already on for this account';
  END IF;
  IF NOT public.auth_self_session_ok(p_user, p_session, true) THEN
    RAISE EXCEPTION 'a fresh step-up of this session is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  INSERT INTO public.user_totp (user_id, required, enforced, pending_secret_enc, pending_owner, pending_started_at, set_by, set_at)
  VALUES (p_user, false, false, p_secret_enc, 'session:' || p_session::text, now(), p_user, now())
  ON CONFLICT (user_id) DO UPDATE SET pending_secret_enc = EXCLUDED.pending_secret_enc, pending_owner = EXCLUDED.pending_owner,
    pending_started_at = now()
    WHERE NOT public.user_totp.required;
  IF NOT FOUND THEN RAISE EXCEPTION 'two-factor is already on for this account'; END IF;
  RETURN 'ok';
END $$;

-- The pending secret of this session's self enrolment (for the API to check the first code). Nothing when there is none or it is old.
CREATE OR REPLACE FUNCTION auth_totp_self_pending_secret(p_user uuid, p_session uuid)
RETURNS TABLE (pending_secret_enc text, locked_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.auth_self_guard(p_user);
  RETURN QUERY SELECT t.pending_secret_enc, c.locked_until
    FROM public.user_totp t JOIN public.local_credentials c ON c.user_id = t.user_id AND c.enabled
    WHERE t.user_id = p_user AND NOT t.required AND t.pending_secret_enc IS NOT NULL
      AND t.pending_owner = 'session:' || p_session::text AND t.pending_started_at > now() - interval '10 minutes';
END $$;

-- A wrong first code of a self enrolment: counted like any wrong code (five lock the account for 15 minutes). 'bad' or 'locked'.
CREATE OR REPLACE FUNCTION auth_totp_self_enrol_failed(p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.auth_self_guard(p_user);
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  PERFORM public.auth_totp_note_failure(p_user);
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  RETURN 'bad';
END $$;

-- Self enrolment, step 2: the API checked the first code against the pending secret of this session. Two-factor goes on (not enforced),
-- 10 recovery-code hashes are stored, the user's other sessions and pending sign-ins end, and this session counts as having passed a code.
-- Returns how many other sessions ended.
CREATE OR REPLACE FUNCTION auth_totp_self_confirm_enrol(p_user uuid, p_session uuid, p_step bigint, p_hashes text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ended int;
BEGIN
  PERFORM public.auth_self_guard(p_user);
  IF p_step IS NULL OR p_hashes IS NULL OR cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION 'a step and 10 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN
    RAISE EXCEPTION 'account is locked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.auth_self_session_ok(p_user, p_session, false) THEN
    RAISE EXCEPTION 'only the session that started the enrolment can confirm it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.user_totp SET required = true, enforced = false, secret_enc = pending_secret_enc, pending_secret_enc = NULL, pending_owner = NULL,
    pending_started_at = NULL, enrol_code_hash = NULL, enrol_code_expires_at = NULL, enrolled_at = now(), last_step = p_step, failed_count = 0,
    last_success_at = now(), set_by = p_user, set_at = now()
  WHERE user_id = p_user AND NOT required AND pending_secret_enc IS NOT NULL AND pending_owner = 'session:' || p_session::text
    AND pending_started_at > now() - interval '10 minutes';
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to confirm' USING ERRCODE = 'insufficient_privilege'; END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  INSERT INTO public.user_recovery_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) h;
  UPDATE public.user_sessions SET two_factor = true WHERE id = p_session;
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = p_user, revoke_reason = 'two_factor_enabled'
    WHERE user_id = p_user AND id <> p_session AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_self_enabled', 'user', p_user::text, jsonb_build_object('two_factor', 'off', 'enforced', false),
          jsonb_build_object('two_factor', 'on', 'enforced', false, 'recovery_codes_remaining', 10, 'sessions_ended', ended, 'via', 'self_service'), p_user);
  RETURN ended;
END $$;

-- Self disable: refused while an admin enforces it; otherwise needs a password success and, after it, a code success in the last minute
-- (both recorded by the API's checks in this transaction). Deletes the secret and the recovery codes and ends pending sign-ins.
CREATE OR REPLACE FUNCTION auth_totp_self_disable(p_user uuid, p_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE before_n int;
BEGIN
  PERFORM public.auth_self_guard(p_user);
  IF EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.enforced) THEN
    RAISE EXCEPTION 'two_factor_enforced: an administrator enforces two-factor on this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'two-factor is not on for your account';
  END IF;
  IF NOT public.auth_self_session_ok(p_user, p_session, false) THEN
    RAISE EXCEPTION 'only from your own signed-in session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c JOIN public.user_totp t ON t.user_id = c.user_id
                 WHERE c.user_id = p_user AND c.enabled AND (c.locked_until IS NULL OR c.locked_until <= now())
                   AND c.last_success_at > now() - interval '1 minute'
                   AND t.last_success_at > now() - interval '1 minute' AND t.last_success_at >= c.last_success_at) THEN
    RAISE EXCEPTION 'the password and a code are required first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  before_n := public.auth_totp_remaining(p_user);
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  UPDATE public.user_totp SET required = false, enforced = false, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL,
    pending_started_at = NULL, enrolled_at = NULL, last_step = NULL, failed_count = 0, last_success_at = NULL,
    enrol_code_hash = NULL, enrol_code_expires_at = NULL, set_by = p_user, set_at = now()
  WHERE user_id = p_user;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_self_disabled', 'user', p_user::text, jsonb_build_object('two_factor', 'on', 'enforced', false, 'recovery_codes_remaining', before_n),
          jsonb_build_object('two_factor', 'off', 'enforced', false, 'recovery_codes_remaining', 0, 'via', 'self_service'), p_user);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Two-factor, admin side: turning it on now enforces it; the enforced mark on its own
-- ---------------------------------------------------------------------------------------------------------------------
-- Same signature, result and checks as 0034. Changes: turning it on sets enforced; "on" for a user who is already on (for example one who
-- turned it on themselves) marks it enforced instead of doing nothing; turning it off clears it (also done by the trigger).
CREATE OR REPLACE FUNCTION idm_set_two_factor(p_user uuid, p_enabled boolean, p_reason text, p_code_hash text DEFAULT NULL)
RETURNS TABLE (r_state text, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); before_label text := public.idm_two_factor_label(p_user);
        before_n int := public.auth_totp_remaining(p_user); ended int := 0; exp timestamptz; was_enforced boolean := public.auth_totp_enforced(p_user);
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'enabled is required'; END IF;
  IF p_enabled THEN
    IF before_label <> 'off' THEN
      IF NOT was_enforced THEN
        UPDATE public.user_totp SET enforced = true, set_by = a, set_at = now() WHERE user_id = p_user;
        UPDATE public.users SET updated_at = now() WHERE id = p_user;
        PERFORM public.idm_audit('two_factor_enforced', 'user', p_user::text, jsonb_build_object('two_factor', before_label, 'enforced', false),
          jsonb_build_object('two_factor', before_label, 'enforced', true), p_reason);
      END IF;
      r_state := before_label; r_expires := NULL; RETURN NEXT; RETURN;
    END IF;
    PERFORM public.idm_need_enrol_code_hash(p_code_hash);
    exp := now() + make_interval(hours => public.idm_enrol_code_hours());
    INSERT INTO public.user_totp (user_id, required, enforced, set_by, set_at, enrol_code_hash, enrol_code_expires_at) VALUES (p_user, true, true, a, now(), p_code_hash, exp)
      ON CONFLICT (user_id) DO UPDATE SET required = true, enforced = true, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL,
        failed_count = 0, last_success_at = NULL, set_by = a, set_at = now(), enrol_code_hash = p_code_hash, enrol_code_expires_at = exp;
    UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'two_factor_enabled'
      WHERE user_id = p_user AND revoked_at IS NULL AND auth_method = 'local';
    GET DIAGNOSTICS ended = ROW_COUNT;
  ELSE
    IF before_label = 'off' THEN
      r_state := before_label; r_expires := NULL; RETURN NEXT; RETURN;
    END IF;
    DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
    UPDATE public.user_totp SET required = false, enforced = false, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL,
      failed_count = 0, last_success_at = NULL, set_by = a, set_at = now(), enrol_code_hash = NULL, enrol_code_expires_at = NULL WHERE user_id = p_user;
    UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  END IF;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit(CASE WHEN p_enabled THEN 'two_factor_enabled' ELSE 'two_factor_disabled' END, 'user', p_user::text,
    jsonb_build_object('two_factor', before_label, 'recovery_codes_remaining', before_n, 'enforced', was_enforced),
    jsonb_build_object('two_factor', public.idm_two_factor_label(p_user), 'recovery_codes_remaining', public.auth_totp_remaining(p_user), 'sessions_ended', ended,
                       'enforced', public.auth_totp_enforced(p_user))
      || CASE WHEN p_enabled THEN jsonb_build_object('enrol_code', 'issued', 'enrol_code_expires_at', exp) ELSE '{}'::jsonb END,
    p_reason);
  r_state := public.idm_two_factor_label(p_user); r_expires := exp; RETURN NEXT;
END $$;

-- Marks or unmarks "enforced by admin" on a user whose two-factor is on (or waiting for enrolment). Same guard as the toggle: System
-- Admin or a delegate holding users.administer for all regions, a reason, never one's own account, a delegate never for an admin or a
-- delegate. Setting what is set changes nothing and writes no audit row. Returns the new value.
CREATE OR REPLACE FUNCTION idm_set_two_factor_enforced(p_user uuid, p_enforced boolean, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); cur boolean; on_now boolean;
BEGIN
  IF p_enforced IS NULL THEN RAISE EXCEPTION 'enforced is required'; END IF;
  SELECT t.required, t.enforced INTO on_now, cur FROM public.user_totp t WHERE t.user_id = p_user FOR UPDATE;
  IF NOT coalesce(on_now, false) THEN
    RAISE EXCEPTION 'two-factor is off for this user: turn it on first';
  END IF;
  IF cur = p_enforced THEN RETURN cur; END IF;
  UPDATE public.user_totp SET enforced = p_enforced, set_by = a, set_at = now() WHERE user_id = p_user;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit(CASE WHEN p_enforced THEN 'two_factor_enforced' ELSE 'two_factor_unenforced' END, 'user', p_user::text,
    jsonb_build_object('two_factor', public.idm_two_factor_label(p_user), 'enforced', cur),
    jsonb_build_object('two_factor', public.idm_two_factor_label(p_user), 'enforced', p_enforced), p_reason);
  RETURN p_enforced;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Profile: the fields a user edits on their own account
-- ---------------------------------------------------------------------------------------------------------------------
-- p_changes holds only the keys to change: display_name (1 to 200 characters), phone (E.164 or null), locale (en, ar), theme (light,
-- dark). Any other key (email, employee_id, status, team, region, roles, department, manager ...) is refused: those are admin-owned.
-- Audited once with the before and after values of the keys that really changed; nothing changed = no write, no audit row.
CREATE OR REPLACE FUNCTION idm_update_own_profile(p_changes jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); u public.users%ROWTYPE; n int; bad text; b jsonb := '{}'::jsonb; aft jsonb := '{}'::jsonb;
        v_name text; v_phone text; v_locale text; v_theme text;
BEGIN
  IF a IS NULL OR coalesce(current_setting('app.user_id', true), '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN RAISE EXCEPTION 'profile: changes must be an object'; END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_changes) key
   WHERE key NOT IN ('display_name', 'phone', 'locale', 'theme');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'profile: % cannot be changed on your own account: an administrator changes it', bad USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  v_name := u.display_name; v_phone := u.phone; v_locale := u.locale; v_theme := u.theme;
  IF p_changes ? 'display_name' THEN
    v_name := btrim(p_changes ->> 'display_name');
    IF jsonb_typeof(p_changes -> 'display_name') <> 'string' OR v_name = '' OR length(v_name) > 200 THEN
      RAISE EXCEPTION 'profile: display_name must have 1 to 200 characters';
    END IF;
  END IF;
  IF p_changes ? 'phone' THEN
    IF jsonb_typeof(p_changes -> 'phone') = 'null' THEN v_phone := NULL;
    ELSIF jsonb_typeof(p_changes -> 'phone') = 'string' AND (p_changes ->> 'phone') ~ '^\+[1-9][0-9]{7,14}$' THEN v_phone := p_changes ->> 'phone';
    ELSE RAISE EXCEPTION 'profile: phone must be in E.164 form (+218...)';
    END IF;
    IF v_phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.users o WHERE o.phone = v_phone AND o.id <> a) THEN
      RAISE EXCEPTION 'phone: already used by another account';
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
  IF v_name IS DISTINCT FROM u.display_name THEN b := b || jsonb_build_object('display_name', u.display_name); aft := aft || jsonb_build_object('display_name', v_name); END IF;
  IF v_phone IS DISTINCT FROM u.phone THEN b := b || jsonb_build_object('phone', u.phone); aft := aft || jsonb_build_object('phone', v_phone); END IF;
  IF v_locale IS DISTINCT FROM u.locale THEN b := b || jsonb_build_object('locale', u.locale); aft := aft || jsonb_build_object('locale', v_locale); END IF;
  IF v_theme IS DISTINCT FROM u.theme THEN b := b || jsonb_build_object('theme', u.theme); aft := aft || jsonb_build_object('theme', v_theme); END IF;
  IF aft = '{}'::jsonb THEN RETURN 0; END IF;
  UPDATE public.users SET display_name = v_name, phone = v_phone, locale = v_locale, theme = v_theme, updated_at = now() WHERE id = a;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('profile_updated', 'user', a::text, b, aft || jsonb_build_object('via', 'self_service'), a);
  SELECT count(*)::int INTO n FROM jsonb_object_keys(aft);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Email change: a request that an admin approves
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE email_change_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  old_email        TEXT NOT NULL,
  new_email        TEXT NOT NULL CHECK (new_email = lower(btrim(new_email)) AND length(new_email) <= 254 AND new_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ(6),
  decided_by       UUID REFERENCES users(id) ON UPDATE CASCADE,
  decision_reason  TEXT,
  CONSTRAINT email_change_decided_pair CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT email_change_reason CHECK (status NOT IN ('approved', 'rejected') OR coalesce(btrim(decision_reason), '') <> '')
);
CREATE UNIQUE INDEX email_change_one_pending ON email_change_requests (user_id) WHERE status = 'pending';
CREATE UNIQUE INDEX email_change_pending_address ON email_change_requests (new_email) WHERE status = 'pending';
CREATE INDEX email_change_requests_user ON email_change_requests (user_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE ON email_change_requests TO pmis_identity_owner;
GRANT INSERT ON notifications TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON email_change_requests FROM pmis_app;
  END IF;
END $$;

-- Who decides email changes, and is told about new requests: active System Admins, and active users holding an all-regions delegation
-- covering users.edit. Internal.
CREATE OR REPLACE FUNCTION idm_email_change_deciders() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id FROM public.users u
  WHERE u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
    AND (public.app_user_is_system_admin(u.id)
         OR EXISTS (SELECT 1 FROM public.app_user_delegations(u.id) x(id) JOIN public.delegations d ON d.id = x.id
                    WHERE d.all_regions AND public.deleg_covers(d.id, 'users', 'edit')))
$$;

-- The signed-in user asks for a new email. The API has just checked the password (auth_local_result in this transaction); the database
-- checks that the success is recent. The address must be well formed, differ from the current one, and be free (no account and no other
-- pending request uses it). One pending request per user. Admins are told in the inbox.
CREATE OR REPLACE FUNCTION idm_request_email_change(p_new_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); e text := lower(btrim(coalesce(p_new_email, ''))); u public.users%ROWTYPE; rid uuid; d uuid;
BEGIN
  IF a IS NULL OR coalesce(current_setting('app.user_id', true), '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL AND NOT is_break_glass FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = a AND c.enabled AND c.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'email change: confirm your password first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(e) > 254 OR e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN RAISE EXCEPTION 'email: not a valid address'; END IF;
  IF e = u.email THEN RAISE EXCEPTION 'email: this is already your email'; END IF;
  IF EXISTS (SELECT 1 FROM public.email_change_requests r WHERE r.user_id = a AND r.status = 'pending') THEN
    RAISE EXCEPTION 'an email change is already pending: cancel it first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users o WHERE o.email = e)
     OR EXISTS (SELECT 1 FROM public.email_change_requests r WHERE r.new_email = e AND r.status = 'pending') THEN
    RAISE EXCEPTION 'email: already used by another account';
  END IF;
  INSERT INTO public.email_change_requests (user_id, old_email, new_email) VALUES (a, u.email, e) RETURNING id INTO rid;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('email_change_requested', 'user', a::text, jsonb_build_object('email', u.email),
          jsonb_build_object('requested_email', e, 'request_id', rid, 'status', 'pending'), a);
  FOR d IN SELECT x FROM public.idm_email_change_deciders() x WHERE x <> a LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (d, 'in_app', 'email_change_requested', 'Email change to approve',
            u.display_name || coalesce(' (' || btrim(u.employee_id) || ')', '') || ' asks to change their email to ' || e || '.',
            '/admin/users?email_changes=pending');
  END LOOP;
  RETURN rid;
END $$;

-- The user withdraws their own pending request.
CREATE OR REPLACE FUNCTION idm_cancel_email_change(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); r public.email_change_requests%ROWTYPE;
BEGIN
  IF a IS NULL OR coalesce(current_setting('app.user_id', true), '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.email_change_requests WHERE id = p_id AND user_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'email change request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'this email change is not pending'; END IF;
  UPDATE public.email_change_requests SET status = 'cancelled', decided_at = now(), decided_by = a WHERE id = p_id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('email_change_cancelled', 'user', a::text, jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'pending'),
          jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'cancelled'), a);
END $$;

-- An admin approves (the login email changes) or rejects a pending request, always with a reason. Never on one's own account; a delegate
-- never for an admin or a delegate; the change is global, so a region-limited delegate cannot decide. Uniqueness is checked again.
CREATE OR REPLACE FUNCTION idm_decide_email_change(p_id uuid, p_approve boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); r public.email_change_requests%ROWTYPE; cur text; st text;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  IF p_approve IS NULL THEN RAISE EXCEPTION 'a decision is required'; END IF;
  SELECT * INTO r FROM public.email_change_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'email change request not found'; END IF;
  IF r.user_id = a THEN
    RAISE EXCEPTION 'you cannot decide an email change on your own account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.idm_assert_user_change_allowed(r.user_id);
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'this email change is not pending'; END IF;
  IF p_approve THEN
    SELECT email INTO cur FROM public.users WHERE id = r.user_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
    IF EXISTS (SELECT 1 FROM public.users o WHERE o.email = r.new_email AND o.id <> r.user_id) THEN
      RAISE EXCEPTION 'email: already used by another account';
    END IF;
    UPDATE public.users SET email = r.new_email, updated_at = now() WHERE id = r.user_id;
    st := 'approved';
    PERFORM public.idm_audit('email_changed', 'user', r.user_id::text, jsonb_build_object('email', cur, 'request_id', r.id),
      jsonb_build_object('email', r.new_email, 'request_id', r.id), btrim(p_reason));
  ELSE
    st := 'rejected';
    PERFORM public.idm_audit('email_change_rejected', 'user', r.user_id::text,
      jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'pending'),
      jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'rejected'), btrim(p_reason));
  END IF;
  UPDATE public.email_change_requests SET status = st, decided_at = now(), decided_by = a, decision_reason = btrim(p_reason) WHERE id = p_id;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (r.user_id, 'in_app', 'email_change_decided',
          CASE WHEN p_approve THEN 'Your email change was approved' ELSE 'Your email change was rejected' END,
          CASE WHEN p_approve THEN 'Your sign-in email is now ' || r.new_email || '. ' ELSE 'Your email stays ' || r.old_email || '. ' END
            || 'Reason: ' || btrim(p_reason),
          '/profile');
  RETURN st;
END $$;

-- Reads (pmis_app has no table right). The user's own requests, newest first.
CREATE OR REPLACE FUNCTION idm_my_email_changes()
RETURNS TABLE (id uuid, old_email text, new_email text, status text, requested_at timestamptz, decided_at timestamptz, decision_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL OR coalesce(current_setting('app.user_id', true), '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT r.id, r.old_email, r.new_email, r.status, r.requested_at, r.decided_at, r.decision_reason
    FROM public.email_change_requests r WHERE r.user_id = a ORDER BY r.requested_at DESC, r.id;
END $$;

-- The requests an admin decides (same right as deciding), filtered by status (NULL = all), newest first.
CREATE OR REPLACE FUNCTION idm_email_change_list(p_status text)
RETURNS TABLE (id uuid, user_id uuid, display_name text, employee_id text, old_email text, new_email text, status text,
               requested_at timestamptz, decided_at timestamptz, decided_by uuid, decided_by_name text, decision_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit');
BEGIN
  PERFORM public.idm_need_global('users', 'edit');
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected', 'cancelled') THEN RAISE EXCEPTION 'unknown status'; END IF;
  RETURN QUERY SELECT r.id, r.user_id, u.display_name, btrim(u.employee_id), r.old_email, r.new_email, r.status, r.requested_at, r.decided_at,
      r.decided_by, dby.display_name, r.decision_reason
    FROM public.email_change_requests r JOIN public.users u ON u.id = r.user_id LEFT JOIN public.users dby ON dby.id = r.decided_by
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.requested_at DESC, r.id;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['auth_totp_enforced(uuid)','idm_stepup_seconds()','auth_self_session_ok(uuid,uuid,boolean)','auth_self_guard(uuid)',
    'auth_totp_self_begin_enrol(uuid,uuid,text)','auth_totp_self_pending_secret(uuid,uuid)','auth_totp_self_enrol_failed(uuid)',
    'auth_totp_self_confirm_enrol(uuid,uuid,bigint,text[])','auth_totp_self_disable(uuid,uuid)','idm_set_two_factor(uuid,boolean,text,text)',
    'idm_set_two_factor_enforced(uuid,boolean,text)','idm_update_own_profile(jsonb)','idm_email_change_deciders()',
    'idm_request_email_change(text)','idm_cancel_email_change(uuid)','idm_decide_email_change(uuid,boolean,text)',
    'idm_my_email_changes()','idm_email_change_list(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  REVOKE ALL ON FUNCTION user_totp_enforced_follows() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: idm_stepup_seconds, auth_self_session_ok, auth_self_guard and idm_email_change_deciders (internal)
    FOREACH f IN ARRAY ARRAY['auth_totp_enforced(uuid)','auth_totp_self_begin_enrol(uuid,uuid,text)','auth_totp_self_pending_secret(uuid,uuid)',
      'auth_totp_self_enrol_failed(uuid)','auth_totp_self_confirm_enrol(uuid,uuid,bigint,text[])','auth_totp_self_disable(uuid,uuid)',
      'idm_set_two_factor(uuid,boolean,text,text)','idm_set_two_factor_enforced(uuid,boolean,text)','idm_update_own_profile(jsonb)',
      'idm_request_email_change(text)','idm_cancel_email_change(uuid)','idm_decide_email_change(uuid,boolean,text)',
      'idm_my_email_changes()','idm_email_change_list(text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
