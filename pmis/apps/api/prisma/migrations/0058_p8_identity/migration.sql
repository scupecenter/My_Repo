-- 0058_p8_identity: identity and profile follow-up of the owner answers of 2026-11-04 (work package P8: Q156 / D156, Q158, Q161).
-- Mirror: db/sql/057_p8_identity.sql (kept identical to prisma/migrations/0058_p8_identity/migration.sql).
--
-- 1. Phone change is a request an admin approves (D156: the phone is a sign-in identifier). idm_update_own_profile no longer takes the
--    phone (403 field_read_only through the API). The user asks with the password re-entered (idm_request_phone_change): one pending
--    request per user, E.164 or null (remove the phone), different from the current one, free (no account and no other pending request
--    uses it). A System Admin or a delegate holding users.edit for all regions approves or rejects it with a reason
--    (idm_decide_phone_change), never on their own account, a delegate never for an admin or a delegate; uniqueness is checked again;
--    only an approval changes users.phone. The user may cancel while pending (idm_cancel_phone_change). Deciders are told in the inbox
--    (phone_change_requested), the user when it is decided (phone_change_decided). Every step is audited through log_audit_write.
-- 2. Email change (Q158): the new address is verified before it becomes the login email. The API mails a one-time code to the new
--    address (idm_email_change_set_verification stores only its SHA-256, valid email_change.verify_hours, default 24, 1 to 168); the user
--    enters it (idm_email_change_verify, five wrong codes end the code: a new one must be sent). An approval needs a verified address;
--    while mail is not available the admin records the documented identity check instead (p_identity_check, the "documented admin
--    procedure" of the answer): never an unverified approval. idm_decide_email_change(uuid, boolean, text) of 0044 keeps its signature and
--    refuses an unverified approval. The old and the new address are told by mail (API, MailPort).
-- 3. Two-factor off (Q161): turning it off yourself (auth_totp_self_disable, now returning how many sessions ended) ends your other
--    sessions as turning it on does, and an admin "off" (idm_set_two_factor) ends all the user's sessions. Both write a security notice
--    to the user's inbox (security_notice); recovery codes are deleted as before; refused while enforced, as before.
--
-- pmis_app keeps no table right on email_change_requests and gets none on phone_change_requests (REVOKE ALL here and in
-- db/sql/app_grants.sql). Every function is SECURITY DEFINER, owner pmis_identity_owner, with SET search_path.

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- The signed-in actor of a self-service call (app.user_id set to the verified actor). Internal.
CREATE OR REPLACE FUNCTION idm_self_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL OR coalesce(current_setting('app.user_id', true), '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN a;
END $$;

-- "X on behalf of System Admin": the delegator of a delegate actor, null for a System Admin (as idm_audit of 0009). Internal.
CREATE OR REPLACE FUNCTION idm_on_behalf() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN public.app_actor_is_system_admin() THEN NULL
              ELSE (SELECT d.from_user_id FROM public.app_user_delegations(public.app_actor()) x(id) JOIN public.delegations d ON d.id = x.id LIMIT 1) END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Profile: the phone is no longer self-edited
-- ---------------------------------------------------------------------------------------------------------------------
-- Same as 0044 except: phone is refused like the admin-owned fields (it changes through a phone change request), and the audit row goes
-- through log_audit_write.
CREATE OR REPLACE FUNCTION idm_update_own_profile(p_changes jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor(); u public.users%ROWTYPE; n int; bad text; b jsonb := '{}'::jsonb; aft jsonb := '{}'::jsonb;
        v_name text; v_locale text; v_theme text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN RAISE EXCEPTION 'profile: changes must be an object'; END IF;
  IF p_changes ? 'phone' THEN
    RAISE EXCEPTION 'profile: phone cannot be changed on your own account directly: ask for a phone change, an administrator approves it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_changes) key
   WHERE key NOT IN ('display_name', 'locale', 'theme');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'profile: % cannot be changed on your own account: an administrator changes it', bad USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  v_name := u.display_name; v_locale := u.locale; v_theme := u.theme;
  IF p_changes ? 'display_name' THEN
    v_name := btrim(p_changes ->> 'display_name');
    IF jsonb_typeof(p_changes -> 'display_name') <> 'string' OR v_name = '' OR length(v_name) > 200 THEN
      RAISE EXCEPTION 'profile: display_name must have 1 to 200 characters';
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
  IF v_locale IS DISTINCT FROM u.locale THEN b := b || jsonb_build_object('locale', u.locale); aft := aft || jsonb_build_object('locale', v_locale); END IF;
  IF v_theme IS DISTINCT FROM u.theme THEN b := b || jsonb_build_object('theme', u.theme); aft := aft || jsonb_build_object('theme', v_theme); END IF;
  IF aft = '{}'::jsonb THEN RETURN 0; END IF;
  UPDATE public.users SET display_name = v_name, locale = v_locale, theme = v_theme, updated_at = now() WHERE id = a;
  PERFORM public.log_audit_write('profile_updated', 'user', a::text, b, aft || jsonb_build_object('via', 'self_service'), NULL);
  SELECT count(*)::int INTO n FROM jsonb_object_keys(aft);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Phone change: a request that an admin approves
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE phone_change_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  old_phone        TEXT CHECK (old_phone IS NULL OR old_phone ~ '^\+[1-9][0-9]{7,14}$'),
  new_phone        TEXT CHECK (new_phone IS NULL OR new_phone ~ '^\+[1-9][0-9]{7,14}$'),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ(6),
  decided_by       UUID REFERENCES users(id) ON UPDATE CASCADE,
  decision_reason  TEXT,
  CONSTRAINT phone_change_differs CHECK (new_phone IS DISTINCT FROM old_phone),
  CONSTRAINT phone_change_decided_pair CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT phone_change_reason CHECK (status NOT IN ('approved', 'rejected') OR coalesce(btrim(decision_reason), '') <> '')
);
CREATE UNIQUE INDEX phone_change_one_pending ON phone_change_requests (user_id) WHERE status = 'pending';
CREATE UNIQUE INDEX phone_change_pending_number ON phone_change_requests (new_phone) WHERE status = 'pending' AND new_phone IS NOT NULL;
CREATE INDEX phone_change_requests_user ON phone_change_requests (user_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE ON phone_change_requests TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON phone_change_requests FROM pmis_app;
  END IF;
END $$;

-- The signed-in user asks for a new phone (E.164) or for no phone (null). The API has just checked the password (auth_local_result in this
-- transaction); the database checks that the success is recent. One pending request per user; the number must be free. Deciders are told.
CREATE OR REPLACE FUNCTION idm_request_phone_change(p_new_phone text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor(); p text := nullif(btrim(coalesce(p_new_phone, '')), ''); u public.users%ROWTYPE; rid uuid; d uuid;
BEGIN
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL AND NOT is_break_glass FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = a AND c.enabled AND c.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'phone change: confirm your password first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p IS NOT NULL AND p !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'new_phone: must be in E.164 form (+218...)'; END IF;
  IF p IS NOT DISTINCT FROM u.phone THEN RAISE EXCEPTION 'new_phone: this is already your phone'; END IF;
  IF EXISTS (SELECT 1 FROM public.phone_change_requests r WHERE r.user_id = a AND r.status = 'pending') THEN
    RAISE EXCEPTION 'a phone change is already pending: cancel it first';
  END IF;
  IF p IS NOT NULL AND (EXISTS (SELECT 1 FROM public.users o WHERE o.phone = p AND o.id <> a)
     OR EXISTS (SELECT 1 FROM public.phone_change_requests r WHERE r.new_phone = p AND r.status = 'pending')) THEN
    RAISE EXCEPTION 'new_phone: already used or requested by another account';
  END IF;
  INSERT INTO public.phone_change_requests (user_id, old_phone, new_phone) VALUES (a, u.phone, p) RETURNING id INTO rid;
  PERFORM public.log_audit_write('phone_change_requested', 'user', a::text, jsonb_build_object('phone', u.phone),
    jsonb_build_object('requested_phone', p, 'request_id', rid, 'status', 'pending'), NULL);
  FOR d IN SELECT x FROM public.idm_email_change_deciders() x WHERE x <> a LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (d, 'in_app', 'phone_change_requested', 'Phone change to approve',
            u.display_name || coalesce(' (' || btrim(u.employee_id) || ')', '') || ' asks to '
              || CASE WHEN p IS NULL THEN 'remove their phone.' ELSE 'change their phone to ' || p || '.' END,
            '/admin/users?phone_changes=pending');
  END LOOP;
  RETURN rid;
END $$;

-- The user withdraws their own pending request.
CREATE OR REPLACE FUNCTION idm_cancel_phone_change(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor(); r public.phone_change_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.phone_change_requests WHERE id = p_id AND user_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'phone change request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'this phone change is not pending'; END IF;
  UPDATE public.phone_change_requests SET status = 'cancelled', decided_at = now(), decided_by = a WHERE id = p_id;
  PERFORM public.log_audit_write('phone_change_cancelled', 'user', a::text,
    jsonb_build_object('requested_phone', r.new_phone, 'request_id', r.id, 'status', 'pending'),
    jsonb_build_object('requested_phone', r.new_phone, 'request_id', r.id, 'status', 'cancelled'), NULL);
END $$;

-- An admin approves (users.phone changes) or rejects a pending request, always with a reason. Never on one's own account; a delegate never
-- for an admin or a delegate; the change is global, so a region-limited delegate cannot decide. Uniqueness is checked again.
CREATE OR REPLACE FUNCTION idm_decide_phone_change(p_id uuid, p_approve boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); r public.phone_change_requests%ROWTYPE; cur text; st text;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  IF p_approve IS NULL THEN RAISE EXCEPTION 'a decision is required'; END IF;
  SELECT * INTO r FROM public.phone_change_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'phone change request not found'; END IF;
  IF r.user_id = a THEN
    RAISE EXCEPTION 'you cannot decide a phone change on your own account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.idm_assert_user_change_allowed(r.user_id);
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'this phone change is not pending'; END IF;
  IF p_approve THEN
    SELECT phone INTO cur FROM public.users WHERE id = r.user_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
    IF r.new_phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.users o WHERE o.phone = r.new_phone AND o.id <> r.user_id) THEN
      RAISE EXCEPTION 'new_phone: already used or requested by another account';
    END IF;
    UPDATE public.users SET phone = r.new_phone, updated_at = now() WHERE id = r.user_id;
    st := 'approved';
    PERFORM public.log_audit_write('phone_changed', 'user', r.user_id::text, jsonb_build_object('phone', cur, 'request_id', r.id),
      jsonb_build_object('phone', r.new_phone, 'request_id', r.id, 'via', 'phone_change_request'), btrim(p_reason), NULL, NULL, public.idm_on_behalf());
  ELSE
    st := 'rejected';
    PERFORM public.log_audit_write('phone_change_rejected', 'user', r.user_id::text,
      jsonb_build_object('requested_phone', r.new_phone, 'request_id', r.id, 'status', 'pending'),
      jsonb_build_object('requested_phone', r.new_phone, 'request_id', r.id, 'status', 'rejected'), btrim(p_reason), NULL, NULL, public.idm_on_behalf());
  END IF;
  UPDATE public.phone_change_requests SET status = st, decided_at = now(), decided_by = a, decision_reason = btrim(p_reason) WHERE id = p_id;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (r.user_id, 'in_app', 'phone_change_decided',
          CASE WHEN p_approve THEN 'Your phone change was approved' ELSE 'Your phone change was rejected' END,
          CASE WHEN p_approve THEN coalesce('Your sign-in phone is now ' || r.new_phone || '. ', 'Your phone was removed. ')
               ELSE coalesce('Your phone stays ' || r.old_phone || '. ', 'Your account still has no phone. ') END
            || 'Reason: ' || btrim(p_reason),
          '/profile');
  RETURN st;
END $$;

-- Reads (pmis_app has no table right). The user's own requests, newest first.
CREATE OR REPLACE FUNCTION idm_my_phone_changes()
RETURNS TABLE (id uuid, old_phone text, new_phone text, status text, requested_at timestamptz, decided_at timestamptz, decision_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor();
BEGIN
  RETURN QUERY SELECT r.id, r.old_phone, r.new_phone, r.status, r.requested_at, r.decided_at, r.decision_reason
    FROM public.phone_change_requests r WHERE r.user_id = a ORDER BY r.requested_at DESC, r.id;
END $$;

-- The requests an admin decides (same right as deciding), filtered by status (NULL = all), newest first.
CREATE OR REPLACE FUNCTION idm_phone_change_list(p_status text)
RETURNS TABLE (id uuid, user_id uuid, display_name text, employee_id text, old_phone text, new_phone text, status text,
               requested_at timestamptz, decided_at timestamptz, decided_by uuid, decided_by_name text, decision_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit');
BEGIN
  PERFORM public.idm_need_global('users', 'edit');
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected', 'cancelled') THEN RAISE EXCEPTION 'unknown status'; END IF;
  RETURN QUERY SELECT r.id, r.user_id, u.display_name, btrim(u.employee_id), r.old_phone, r.new_phone, r.status, r.requested_at, r.decided_at,
      r.decided_by, dby.display_name, r.decision_reason
    FROM public.phone_change_requests r JOIN public.users u ON u.id = r.user_id LEFT JOIN public.users dby ON dby.id = r.decided_by
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.requested_at DESC, r.id;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Email change: the new address is verified before an approval (Q158)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE email_change_requests
  ADD COLUMN verify_hash        TEXT CHECK (verify_hash IS NULL OR verify_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN verify_sent_at     TIMESTAMPTZ(6),
  ADD COLUMN verify_expires_at  TIMESTAMPTZ(6),
  ADD COLUMN verify_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (verify_attempts BETWEEN 0 AND 5),
  ADD COLUMN verified_at        TIMESTAMPTZ(6),
  ADD COLUMN verified_via       TEXT CHECK (verified_via IN ('code', 'admin_check')),
  ADD COLUMN identity_check     TEXT CHECK (identity_check IS NULL OR length(identity_check) BETWEEN 3 AND 1000);
ALTER TABLE email_change_requests ADD CONSTRAINT email_change_verified_pair CHECK ((verified_at IS NULL) = (verified_via IS NULL));
ALTER TABLE email_change_requests ADD CONSTRAINT email_change_check_documented CHECK (verified_via IS DISTINCT FROM 'admin_check' OR identity_check IS NOT NULL);
-- Requests approved before this migration were approved without a check; every new approval needs one.
ALTER TABLE email_change_requests ADD CONSTRAINT email_change_approved_verified CHECK (status <> 'approved' OR verified_at IS NOT NULL) NOT VALID;

-- How long a mailed code stays valid (setting email_change.verify_hours, 1 to 168, 24 when absent). Internal.
CREATE OR REPLACE FUNCTION idm_email_verify_hours() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(s.value) = 'number' AND (s.value #>> '{}')::numeric BETWEEN 1 AND 168
                               THEN round((s.value #>> '{}')::numeric)::int END
                     FROM public.settings s WHERE s.key = 'email_change.verify_hours'), 24)
$$;

-- The API mailed a new code to the requested address: only its SHA-256 (hex) is kept. The requester's own pending, unverified request only.
-- A new code replaces the old one and resets the attempts. Returns when it expires.
CREATE OR REPLACE FUNCTION idm_email_change_set_verification(p_id uuid, p_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor(); r public.email_change_requests%ROWTYPE; exp timestamptz;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'verification: a SHA-256 hash is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO r FROM public.email_change_requests WHERE id = p_id AND user_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'email change request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'this email change is not pending'; END IF;
  IF r.verified_at IS NOT NULL THEN RAISE EXCEPTION 'this email change is already verified'; END IF;
  exp := now() + make_interval(hours => public.idm_email_verify_hours());
  UPDATE public.email_change_requests SET verify_hash = p_hash, verify_sent_at = now(), verify_expires_at = exp, verify_attempts = 0 WHERE id = p_id;
  PERFORM public.log_audit_write('email_change_verification_sent', 'user', a::text, NULL,
    jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'expires_at', exp), NULL);
  RETURN exp;
END $$;

-- The user enters the code that reached the new address. 'ok' (verified now), 'bad' (wrong, counted), 'locked' (five wrong: send a new
-- code), 'expired', 'none' (nothing pending or no code sent) or 'verified' (already). A wrong code is counted and must be committed.
CREATE OR REPLACE FUNCTION idm_email_change_verify(p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor(); r public.email_change_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.email_change_requests WHERE user_id = a AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF r.verified_at IS NOT NULL THEN RETURN 'verified'; END IF;
  IF r.verify_hash IS NULL THEN RETURN 'none'; END IF;
  IF r.verify_attempts >= 5 THEN RETURN 'locked'; END IF;
  IF r.verify_expires_at <= now() THEN RETURN 'expired'; END IF;
  IF p_hash IS NULL OR p_hash <> r.verify_hash THEN
    UPDATE public.email_change_requests SET verify_attempts = verify_attempts + 1 WHERE id = r.id;
    RETURN CASE WHEN r.verify_attempts + 1 >= 5 THEN 'locked' ELSE 'bad' END;
  END IF;
  UPDATE public.email_change_requests SET verified_at = now(), verified_via = 'code', verify_hash = NULL WHERE id = r.id;
  PERFORM public.log_audit_write('email_change_verified', 'user', a::text, jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'verified', false),
    jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'verified', true, 'via', 'code'), NULL);
  RETURN 'ok';
END $$;

-- Decide with the documented identity check (Q158). An approval needs a verified address, or p_identity_check: what the admin did to confirm
-- that the address belongs to the user while mail is not available (it is stored and audited). A rejection needs neither.
CREATE OR REPLACE FUNCTION idm_decide_email_change(p_id uuid, p_approve boolean, p_reason text, p_identity_check text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); r public.email_change_requests%ROWTYPE; cur text; st text; chk text := nullif(btrim(coalesce(p_identity_check, '')), '');
        via text;
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
    IF r.verified_at IS NULL AND chk IS NULL THEN
      RAISE EXCEPTION 'email_not_verified: the new address is not verified; record the identity check you made';
    END IF;
    IF chk IS NOT NULL AND (length(chk) < 3 OR length(chk) > 1000) THEN RAISE EXCEPTION 'identity_check: 3 to 1000 characters'; END IF;
    SELECT email INTO cur FROM public.users WHERE id = r.user_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
    IF EXISTS (SELECT 1 FROM public.users o WHERE o.email = r.new_email AND o.id <> r.user_id) THEN
      RAISE EXCEPTION 'email: already used by another account';
    END IF;
    IF r.verified_at IS NULL THEN
      UPDATE public.email_change_requests SET verified_at = now(), verified_via = 'admin_check', identity_check = chk, verify_hash = NULL WHERE id = p_id;
      via := 'admin_check';
    ELSE
      via := r.verified_via;
    END IF;
    UPDATE public.users SET email = r.new_email, updated_at = now() WHERE id = r.user_id;
    st := 'approved';
    PERFORM public.log_audit_write('email_changed', 'user', r.user_id::text, jsonb_build_object('email', cur, 'request_id', r.id),
      jsonb_build_object('email', r.new_email, 'request_id', r.id, 'verified_via', via)
        || CASE WHEN via = 'admin_check' THEN jsonb_build_object('identity_check', chk) ELSE '{}'::jsonb END,
      btrim(p_reason), NULL, NULL, public.idm_on_behalf());
  ELSE
    st := 'rejected';
    PERFORM public.log_audit_write('email_change_rejected', 'user', r.user_id::text,
      jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'pending'),
      jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'rejected'), btrim(p_reason), NULL, NULL, public.idm_on_behalf());
  END IF;
  UPDATE public.email_change_requests SET status = st, decided_at = now(), decided_by = a, decision_reason = btrim(p_reason), verify_hash = NULL WHERE id = p_id;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (r.user_id, 'in_app', 'email_change_decided',
          CASE WHEN p_approve THEN 'Your email change was approved' ELSE 'Your email change was rejected' END,
          CASE WHEN p_approve THEN 'Your sign-in email is now ' || r.new_email || '. ' ELSE 'Your email stays ' || r.old_email || '. ' END
            || 'Reason: ' || btrim(p_reason),
          '/profile');
  RETURN st;
END $$;

-- The 0044 signature stays (same grants): it is the 4-argument decision without an identity check, so an unverified approval is refused.
CREATE OR REPLACE FUNCTION idm_decide_email_change(p_id uuid, p_approve boolean, p_reason text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.idm_decide_email_change(p_id, p_approve, p_reason, NULL::text)
$$;

-- The reads now carry the verification state (never the hash). New return types: dropped and created again.
DROP FUNCTION idm_my_email_changes();
CREATE FUNCTION idm_my_email_changes()
RETURNS TABLE (id uuid, old_email text, new_email text, status text, requested_at timestamptz, decided_at timestamptz, decision_reason text,
               verified_at timestamptz, verified_via text, verify_sent_at timestamptz, verify_expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_self_actor();
BEGIN
  RETURN QUERY SELECT r.id, r.old_email, r.new_email, r.status, r.requested_at, r.decided_at, r.decision_reason,
      r.verified_at, r.verified_via, r.verify_sent_at, r.verify_expires_at
    FROM public.email_change_requests r WHERE r.user_id = a ORDER BY r.requested_at DESC, r.id;
END $$;

DROP FUNCTION idm_email_change_list(text);
CREATE FUNCTION idm_email_change_list(p_status text)
RETURNS TABLE (id uuid, user_id uuid, display_name text, employee_id text, old_email text, new_email text, status text,
               requested_at timestamptz, decided_at timestamptz, decided_by uuid, decided_by_name text, decision_reason text,
               verified_at timestamptz, verified_via text, verify_sent_at timestamptz, verify_expires_at timestamptz, identity_check text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit');
BEGIN
  PERFORM public.idm_need_global('users', 'edit');
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected', 'cancelled') THEN RAISE EXCEPTION 'unknown status'; END IF;
  RETURN QUERY SELECT r.id, r.user_id, u.display_name, btrim(u.employee_id), r.old_email, r.new_email, r.status, r.requested_at, r.decided_at,
      r.decided_by, dby.display_name, r.decision_reason, r.verified_at, r.verified_via, r.verify_sent_at, r.verify_expires_at, r.identity_check
    FROM public.email_change_requests r JOIN public.users u ON u.id = r.user_id LEFT JOIN public.users dby ON dby.id = r.decided_by
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.requested_at DESC, r.id;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Two-factor off ends the other sessions and raises a security notice (Q161)
-- ---------------------------------------------------------------------------------------------------------------------
-- The security notice in the user's inbox. Internal.
CREATE OR REPLACE FUNCTION idm_security_notice(p_user uuid, p_title text, p_body text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (p_user, 'in_app', 'security_notice', p_title, p_body, '/profile');
END $$;

-- Same checks as 0044. Also: the user's other sessions end (revoke_reason two_factor_disabled; this one stays), a security notice is
-- written, and the audit row (through log_audit_write) records how many sessions ended. Returns that number.
DROP FUNCTION auth_totp_self_disable(uuid, uuid);
CREATE FUNCTION auth_totp_self_disable(p_user uuid, p_session uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE before_n int; ended int;
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
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = p_user, revoke_reason = 'two_factor_disabled'
    WHERE user_id = p_user AND id <> p_session AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.idm_security_notice(p_user, 'Two-factor was turned off on your account',
    'Two-factor sign-in was turned off from My profile. ' || ended || ' other session(s) were signed out and your recovery codes no longer work. '
      || 'If this was not you, change your password and tell an administrator.');
  PERFORM public.log_audit_write('two_factor_self_disabled', 'user', p_user::text,
    jsonb_build_object('two_factor', 'on', 'enforced', false, 'recovery_codes_remaining', before_n),
    jsonb_build_object('two_factor', 'off', 'enforced', false, 'recovery_codes_remaining', 0, 'sessions_ended', ended, 'via', 'self_service'), NULL);
  RETURN ended;
END $$;

-- Same signature, result and checks as 0044. Change: turning it off also ends every session of the user (the admin is not one of them),
-- with revoke_reason two_factor_disabled, and writes a security notice. Audit rows go through log_audit_write.
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
        PERFORM public.log_audit_write('two_factor_enforced', 'user', p_user::text, jsonb_build_object('two_factor', before_label, 'enforced', false),
          jsonb_build_object('two_factor', before_label, 'enforced', true), p_reason, NULL, NULL, public.idm_on_behalf());
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
    UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'two_factor_disabled'
      WHERE user_id = p_user AND revoked_at IS NULL;
    GET DIAGNOSTICS ended = ROW_COUNT;
    PERFORM public.idm_security_notice(p_user, 'Two-factor was turned off on your account',
      'An administrator turned two-factor sign-in off for your account. Your sessions were signed out and your recovery codes no longer work. '
        || 'If you did not expect this, tell an administrator.');
  END IF;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.log_audit_write(CASE WHEN p_enabled THEN 'two_factor_enabled' ELSE 'two_factor_disabled' END, 'user', p_user::text,
    jsonb_build_object('two_factor', before_label, 'recovery_codes_remaining', before_n, 'enforced', was_enforced),
    jsonb_build_object('two_factor', public.idm_two_factor_label(p_user), 'recovery_codes_remaining', public.auth_totp_remaining(p_user), 'sessions_ended', ended,
                       'enforced', public.auth_totp_enforced(p_user))
      || CASE WHEN p_enabled THEN jsonb_build_object('enrol_code', 'issued', 'enrol_code_expires_at', exp) ELSE '{}'::jsonb END,
    p_reason, NULL, NULL, public.idm_on_behalf());
  r_state := public.idm_two_factor_label(p_user); r_expires := exp; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['idm_self_actor()','idm_on_behalf()','idm_update_own_profile(jsonb)','idm_request_phone_change(text)',
    'idm_cancel_phone_change(uuid)','idm_decide_phone_change(uuid,boolean,text)','idm_my_phone_changes()','idm_phone_change_list(text)',
    'idm_email_verify_hours()','idm_email_change_set_verification(uuid,text)','idm_email_change_verify(text)',
    'idm_decide_email_change(uuid,boolean,text,text)','idm_decide_email_change(uuid,boolean,text)','idm_my_email_changes()',
    'idm_email_change_list(text)','idm_security_notice(uuid,text,text)','auth_totp_self_disable(uuid,uuid)',
    'idm_set_two_factor(uuid,boolean,text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: idm_self_actor, idm_on_behalf, idm_email_verify_hours and idm_security_notice (internal)
    FOREACH f IN ARRAY ARRAY['idm_update_own_profile(jsonb)','idm_request_phone_change(text)','idm_cancel_phone_change(uuid)',
      'idm_decide_phone_change(uuid,boolean,text)','idm_my_phone_changes()','idm_phone_change_list(text)',
      'idm_email_change_set_verification(uuid,text)','idm_email_change_verify(text)','idm_decide_email_change(uuid,boolean,text,text)',
      'idm_decide_email_change(uuid,boolean,text)','idm_my_email_changes()','idm_email_change_list(text)','auth_totp_self_disable(uuid,uuid)',
      'idm_set_two_factor(uuid,boolean,text,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
