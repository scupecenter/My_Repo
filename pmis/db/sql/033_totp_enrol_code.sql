-- 0034_totp_enrol_code: a one-time enrolment code, so a password alone can never enrol a phone (owner decision 2026-11-02, ADR 0014 amendment).
-- Mirror: db/sql/033_totp_enrol_code.sql (kept identical to prisma/migrations/0034_totp_enrol_code/migration.sql).
--
-- The gap this closes (trust on first use). In 0033 a user whose two-factor is on but not set up yet enrols with nothing but the password:
-- someone who knows the password and signs in before the user's first enrolment would put their own authenticator on the account.
-- Now an admin who turns two-factor on (or resets it) receives a one-time code from the API, shown once, and hands it to the user in person
-- or by phone. Enrolment needs that code at the first step (the QR code is never shown without it) and again at the second, where it is used up.
--
-- Where the code lives. The API makes the code (8 characters, 32-letter alphabet without look-alikes, shown as XXXX-XXXX) and sends the database
-- only its keyed hash: HMAC-SHA-256 over "<user id>:<code>" with a key derived (HKDF) from TOTP_ENC_KEY, like the recovery codes but with its
-- own key label, so a code of one user matches nobody else. The hash sits in user_totp.enrol_code_hash; pmis_app has no right on that table
-- (the REVOKE ALL of 0033 stays), so it cannot read the hash. Matching and consuming happen here, in SECURITY DEFINER functions owned by
-- pmis_identity_owner. A wrong or expired code counts toward the same failure counter as a wrong TOTP code: five in a row lock the account for 15 minutes.
-- The code lasts the number of hours in the setting `two_factor.enrol_code_hours` (default 72). A new code replaces the old one, which stops working.
--
-- Signature changes. Five functions of 0033 take the hash now (or return the expiry or a result), and CREATE OR REPLACE cannot change an argument
-- list or a return type, so their old forms are dropped first. The old forms must not stay: they are granted to pmis_app and would enrol without
-- a code. Owners and grants are set again below, as in 0033. Nothing else of 0033 is touched.
--
-- Existing installations: a user who is waiting for enrolment when this migration runs has no code (the database cannot make one: it does not
-- hold the key). Enrolment is refused for that user until an admin issues a code (POST /users/{id}/two-factor/enrol-code).

-- ---------------------------------------------------------------------------------------------------------------------
-- Table: the code of a user who is waiting for enrolment (one at a time; a new one replaces it)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE user_totp
  ADD COLUMN enrol_code_hash        CHAR(64) CHECK (enrol_code_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN enrol_code_expires_at  TIMESTAMPTZ(6),
  ADD CONSTRAINT user_totp_enrol_code_pair CHECK ((enrol_code_hash IS NULL) = (enrol_code_expires_at IS NULL)),
  ADD CONSTRAINT user_totp_enrol_code_waiting CHECK (enrol_code_hash IS NULL OR (required AND secret_enc IS NULL));

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('two_factor.enrol_code_hours', '72', 'Hours a one-time two-factor enrolment code stays valid after an admin issues it (1 to 720).', now())
ON CONFLICT (key) DO NOTHING;
GRANT SELECT ON settings TO pmis_identity_owner;

-- ---------------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- Hours a new code lasts: the setting, kept between 1 and 720, 72 when it is absent or not a number.
CREATE OR REPLACE FUNCTION idm_enrol_code_hours() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT greatest(1, least(720, coalesce(
    (SELECT CASE WHEN jsonb_typeof(s.value) = 'number' THEN round((s.value #>> '{}')::numeric)::int END
       FROM public.settings s WHERE s.key = 'two_factor.enrol_code_hours'), 72)))
$$;

CREATE OR REPLACE FUNCTION idm_need_enrol_code_hash(p_hash text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'an enrolment code hash is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END $$;

-- Does the hash match the open code of a user who is waiting for enrolment? 'ok', 'bad' (no code, another code, nobody waiting) or 'expired'.
-- A miss counts toward the failure counter (five lock the account for 15 minutes). The callers return the answer instead of raising, so the count is kept.
-- Internal: not granted to pmis_app.
CREATE OR REPLACE FUNCTION auth_totp_check_enrol_code(p_user uuid, p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h text; exp timestamptz;
BEGIN
  SELECT t.enrol_code_hash, t.enrol_code_expires_at INTO h, exp FROM public.user_totp t
   WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NULL FOR UPDATE;
  IF h IS NULL OR h <> p_hash THEN
    PERFORM public.auth_totp_note_failure(p_user);
    RETURN 'bad';
  END IF;
  IF exp <= now() THEN
    PERFORM public.auth_totp_note_failure(p_user);
    RETURN 'expired';
  END IF;
  RETURN 'ok';
END $$;

-- What may be shown about the code of a user: when it ends (NULL = none outstanding). Never the hash.
CREATE OR REPLACE FUNCTION auth_totp_enrol_code_state(p_user uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.enrol_code_expires_at FROM public.user_totp t WHERE t.user_id = p_user AND t.enrol_code_hash IS NOT NULL
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Enrolment, step 1: the secret for the QR code is stored only after the enrolment code matched
-- ---------------------------------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_totp_begin_enrol(uuid, text, text);
CREATE OR REPLACE FUNCTION auth_totp_begin_enrol(p_user uuid, p_secret_enc text, p_owner text, p_code_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r text;
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
  PERFORM public.idm_need_enrol_code_hash(p_code_hash);
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NULL) THEN
    RAISE EXCEPTION 'two-factor is not waiting for enrolment, or another sign-in is enrolling' USING ERRCODE = 'insufficient_privilege';
  END IF;
  r := public.auth_totp_check_enrol_code(p_user, p_code_hash);
  IF r <> 'ok' THEN RETURN r; END IF;
  -- The first sign-in that starts an enrolment keeps it for 10 minutes: another sign-in (even with the right code)
  -- cannot replace the secret shown in that QR code. The same sign-in may restart it.
  UPDATE public.user_totp SET pending_secret_enc = p_secret_enc, pending_owner = p_owner, pending_started_at = now()
  WHERE user_id = p_user AND required AND secret_enc IS NULL
    AND (pending_owner IS NULL OR pending_owner = p_owner OR pending_started_at < now() - interval '10 minutes');
  IF NOT FOUND THEN RAISE EXCEPTION 'two-factor is not waiting for enrolment, or another sign-in is enrolling' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN 'ok';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Enrolment, step 2: the enrolment code is checked again and used up together with the activation (one function, one transaction)
-- ---------------------------------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_totp_confirm_enrol(uuid, bigint, text[], text);
CREATE OR REPLACE FUNCTION auth_totp_confirm_enrol(p_user uuid, p_step bigint, p_hashes text[], p_owner text, p_code_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r text;
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_step IS NULL OR p_hashes IS NULL OR cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION 'a step and 10 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM public.idm_need_enrol_code_hash(p_code_hash);
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  r := public.auth_totp_check_enrol_code(p_user, p_code_hash);
  IF r <> 'ok' THEN RETURN r; END IF;
  UPDATE public.user_totp SET secret_enc = pending_secret_enc, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL,
    enrol_code_hash = NULL, enrol_code_expires_at = NULL,
    enrolled_at = now(), last_step = p_step, failed_count = 0, last_success_at = now()
    WHERE user_id = p_user AND required AND secret_enc IS NULL AND pending_secret_enc IS NOT NULL AND pending_owner = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to confirm' USING ERRCODE = 'insufficient_privilege'; END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  INSERT INTO public.user_recovery_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) h;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_enrolled', 'user', p_user::text, jsonb_build_object('two_factor', 'pending_enrolment', 'enrol_code', 'active'),
          jsonb_build_object('two_factor', 'on', 'recovery_codes_remaining', 10, 'enrol_code', 'used'), p_user);
  RETURN 'ok';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin writes. Same guard as 0033 (System Admin, or a delegate holding users.administer; reason; never one's own account).
-- Turning on and reset take the hash of a new code from the API and return the end of its validity, which is NULL when nothing changed.
-- ---------------------------------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS idm_set_two_factor(uuid, boolean, text);
CREATE OR REPLACE FUNCTION idm_set_two_factor(p_user uuid, p_enabled boolean, p_reason text, p_code_hash text DEFAULT NULL)
RETURNS TABLE (r_state text, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); before_label text := public.idm_two_factor_label(p_user);
        before_n int := public.auth_totp_remaining(p_user); ended int := 0; exp timestamptz;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'enabled is required'; END IF;
  IF p_enabled THEN
    IF before_label <> 'off' THEN
      r_state := before_label; r_expires := NULL; RETURN NEXT; RETURN;
    END IF;
    PERFORM public.idm_need_enrol_code_hash(p_code_hash);
    exp := now() + make_interval(hours => public.idm_enrol_code_hours());
    INSERT INTO public.user_totp (user_id, required, set_by, set_at, enrol_code_hash, enrol_code_expires_at) VALUES (p_user, true, a, now(), p_code_hash, exp)
      ON CONFLICT (user_id) DO UPDATE SET required = true, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL,
        failed_count = 0, last_success_at = NULL, set_by = a, set_at = now(), enrol_code_hash = p_code_hash, enrol_code_expires_at = exp;
    UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'two_factor_enabled'
      WHERE user_id = p_user AND revoked_at IS NULL AND auth_method = 'local';
    GET DIAGNOSTICS ended = ROW_COUNT;
  ELSE
    IF before_label = 'off' THEN
      r_state := before_label; r_expires := NULL; RETURN NEXT; RETURN;
    END IF;
    DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
    UPDATE public.user_totp SET required = false, secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL,
      failed_count = 0, last_success_at = NULL, set_by = a, set_at = now(), enrol_code_hash = NULL, enrol_code_expires_at = NULL WHERE user_id = p_user;
    UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  END IF;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit(CASE WHEN p_enabled THEN 'two_factor_enabled' ELSE 'two_factor_disabled' END, 'user', p_user::text,
    jsonb_build_object('two_factor', before_label, 'recovery_codes_remaining', before_n),
    jsonb_build_object('two_factor', public.idm_two_factor_label(p_user), 'recovery_codes_remaining', public.auth_totp_remaining(p_user), 'sessions_ended', ended)
      || CASE WHEN p_enabled THEN jsonb_build_object('enrol_code', 'issued', 'enrol_code_expires_at', exp) ELSE '{}'::jsonb END,
    p_reason);
  r_state := public.idm_two_factor_label(p_user); r_expires := exp; RETURN NEXT;
END $$;

DROP FUNCTION IF EXISTS idm_reset_two_factor(uuid, text);
CREATE OR REPLACE FUNCTION idm_reset_two_factor(p_user uuid, p_reason text, p_code_hash text DEFAULT NULL)
RETURNS TABLE (r_state text, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); before_label text := public.idm_two_factor_label(p_user);
        before_n int := public.auth_totp_remaining(p_user); ended int; exp timestamptz;
BEGIN
  IF before_label = 'off' THEN RAISE EXCEPTION 'two-factor is not on for this user: nothing to reset'; END IF;
  PERFORM public.idm_need_enrol_code_hash(p_code_hash);
  exp := now() + make_interval(hours => public.idm_enrol_code_hours());
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  UPDATE public.user_totp SET secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL, last_step = NULL, failed_count = 0,
    last_success_at = NULL, set_by = a, set_at = now(), enrol_code_hash = p_code_hash, enrol_code_expires_at = exp WHERE user_id = p_user;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'two_factor_reset'
    WHERE user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit('two_factor_reset', 'user', p_user::text,
    jsonb_build_object('two_factor', before_label, 'recovery_codes_remaining', before_n),
    jsonb_build_object('two_factor', 'pending_enrolment', 'recovery_codes_remaining', 0, 'sessions_ended', ended,
                       'enrol_code', 'issued', 'enrol_code_expires_at', exp), p_reason);
  r_state := 'pending_enrolment'; r_expires := exp; RETURN NEXT;
END $$;

-- A new code for a user who is waiting for enrolment (the old one was lost, expired, or the admin does not trust it). The old code stops working,
-- a half-made enrolment is dropped (its QR code is useless without the new code) and every pending sign-in ends. Only for a user in
-- 'pending_enrolment': an enrolled user needs a reset, a user with two-factor off needs it turned on.
CREATE OR REPLACE FUNCTION idm_issue_two_factor_enrol_code(p_user uuid, p_reason text, p_code_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_two_factor_guard(p_user, p_reason); before_label text := public.idm_two_factor_label(p_user); exp timestamptz; old_exp timestamptz;
BEGIN
  IF before_label <> 'pending_enrolment' THEN
    RAISE EXCEPTION 'no enrolment code can be issued: the user is not waiting for enrolment';
  END IF;
  PERFORM public.idm_need_enrol_code_hash(p_code_hash);
  SELECT t.enrol_code_expires_at INTO old_exp FROM public.user_totp t WHERE t.user_id = p_user FOR UPDATE;
  exp := now() + make_interval(hours => public.idm_enrol_code_hours());
  UPDATE public.user_totp SET enrol_code_hash = p_code_hash, enrol_code_expires_at = exp, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL,
    failed_count = 0, set_by = a, set_at = now() WHERE user_id = p_user;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  PERFORM public.idm_audit('two_factor_enrol_code_issued', 'user', p_user::text,
    jsonb_build_object('two_factor', before_label,
      'enrol_code', CASE WHEN old_exp IS NULL THEN 'none' WHEN old_exp > now() THEN 'active' ELSE 'expired' END),
    jsonb_build_object('two_factor', 'pending_enrolment', 'enrol_code', 'issued', 'enrol_code_expires_at', exp), p_reason);
  RETURN exp;
END $$;

-- The installer reset on the server (migration role or superuser). Resetting also issues a code: the caller (tools/install/reset-two-factor.sh,
-- through `node dist/cli.js enrol-code`) makes it and prints it once. p_disable = true turns two-factor off and needs no code.
DROP FUNCTION IF EXISTS idm_installer_reset_two_factor(text, boolean);
CREATE OR REPLACE FUNCTION idm_installer_reset_two_factor(p_email text, p_disable boolean DEFAULT false, p_code_hash text DEFAULT NULL) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE uid uuid; before_label text; exp timestamptz;
BEGIN
  IF NOT pg_has_role(session_user, 'pmis_migrator', 'member') THEN
    RAISE EXCEPTION 'this reset is for the installer only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO uid FROM public.users WHERE email = lower(btrim(p_email)) AND NOT is_break_glass;
  IF uid IS NULL THEN RAISE EXCEPTION 'user not found'; END IF;
  before_label := public.idm_two_factor_label(uid);
  IF before_label = 'off' THEN RETURN NULL; END IF;
  IF NOT coalesce(p_disable, false) THEN
    PERFORM public.idm_need_enrol_code_hash(p_code_hash);
    exp := now() + make_interval(hours => public.idm_enrol_code_hours());
  END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = uid;
  UPDATE public.user_totp SET required = NOT coalesce(p_disable, false), secret_enc = NULL, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL, enrolled_at = NULL,
    last_step = NULL, failed_count = 0, last_success_at = NULL, set_at = now(),
    enrol_code_hash = CASE WHEN coalesce(p_disable, false) THEN NULL ELSE p_code_hash END, enrol_code_expires_at = exp WHERE user_id = uid;
  UPDATE public.auth_pending SET used_at = now() WHERE user_id = uid AND used_at IS NULL;
  UPDATE public.user_sessions SET revoked_at = now(), revoke_reason = 'two_factor_reset' WHERE user_id = uid AND revoked_at IS NULL;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason)
  VALUES (CASE WHEN p_disable THEN 'two_factor_disabled' ELSE 'two_factor_reset' END, 'user', uid::text,
          jsonb_build_object('two_factor', before_label),
          jsonb_build_object('two_factor', public.idm_two_factor_label(uid))
            || CASE WHEN exp IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('enrol_code', 'issued', 'enrol_code_expires_at', exp) END,
          'installer');
  RETURN exp;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants (as in 0033)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['idm_enrol_code_hours()','idm_need_enrol_code_hash(text)','auth_totp_check_enrol_code(uuid,text)','auth_totp_enrol_code_state(uuid)',
    'auth_totp_begin_enrol(uuid,text,text,text)','auth_totp_confirm_enrol(uuid,bigint,text[],text,text)','idm_set_two_factor(uuid,boolean,text,text)',
    'idm_reset_two_factor(uuid,text,text)','idm_issue_two_factor_enrol_code(uuid,text,text)','idm_installer_reset_two_factor(text,boolean,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: idm_enrol_code_hours, idm_need_enrol_code_hash and auth_totp_check_enrol_code (internal), idm_installer_reset_two_factor (installer only)
    FOREACH f IN ARRAY ARRAY['auth_totp_enrol_code_state(uuid)','auth_totp_begin_enrol(uuid,text,text,text)','auth_totp_confirm_enrol(uuid,bigint,text[],text,text)',
      'idm_set_two_factor(uuid,boolean,text,text)','idm_reset_two_factor(uuid,text,text)','idm_issue_two_factor_enrol_code(uuid,text,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
