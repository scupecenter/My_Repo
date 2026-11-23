-- 0143_users_groups_api: the last users, groups and sign-in routes of the web on the real API (CHANGELOG 193; contract 0.15.60).
-- Mirror: db/sql/142_users_groups_api.sql (kept byte-identical).
--
-- WHAT THIS ADDS.
--   1. Per-user MFA exemption (CLAUDE.md "Per-user MFA exemption (owner request 2026-10-25)", ADR 0002 item 3). A System Admin, or a delegate holding
--      users.administer for all regions (the delegable right users.two_factor, Q620), removes GSDN Workspace's own MFA requirement for one registered
--      user, until revoked or until an end date. Table user_mfa_exemptions (one row per user, the current state; the audit log keeps the history), written
--      only by idm_set_mfa_exempt (contract x-db-path), read through idm_mfa_exemption_state. The check itself is auth_mfa_required: the setting
--      require_mfa (ADR 0002 item 3, default false, "off until IT enables MFA") and no exemption in force. It changes only GSDN Workspace's check (for
--      local sign-in: a TOTP code at sign-in and at step-up, ADR 0002 item 10); MFA enforced by Entra Conditional Access is never touched here.
--      Rules in the database: a reason, the acting admin's own step-up (signed context), nobody exempts themselves, an admin or a delegate (or a former
--      one) is exempted by a System Admin only (idm_assert_user_change_allowed), an end date must be in the future, revoking needs an exemption in force,
--      one audit row with before and after, and an in-app notice to the user (the mail is queued by the API through the mail outbox).
--   2. Create a group (contract createGroup, x-db-path idm_group_create): name, description, members, reason. groups.create (all regions) and step-up;
--      members also need groups.edit (all regions) and go through idm_group_add_member, so the existing ceilings apply unchanged: nobody adds themselves
--      (also the beneficiary trigger of 0009), no pending, deleted or break-glass member, the post-state check idm_assert_group_within_actor (privileged
--      groups are System-Admin only). A create cannot make a privileged group (the body has no System Admins flag; delegations to a group are made later,
--      with their own rules). A name equal to another group's name ignoring case is refused (Q622).
--   3. POST /me/notify-admins (contract notifyAdmins): a signed-in user, typically "Pending assignment", asks the System Admins for an assignment. One
--      request per cooldown (setting notify_admins.cooldown_minutes, default 60, Q623) checked in the database (me_admin_requests), plain text only (no
--      markup, no control characters, at most 500 characters, Q624), an in-app notice (kind assignment_request) to every active System Admin, a mail to
--      them (always; with the dedup key of mail_on_notification), and an audit row. Both new notification kinds join mail_kind_catalogue.
--   POST /auth/employee-id has no database part: the staff registry and the M365 sign-in do not exist on the server yet (Q625); the API answers 409.
--
-- Owners: the identity writers (idm_set_mfa_exempt, idm_group_create, the readers of the exemption) are owned by pmis_identity_owner, as every idm_*
-- function: the backstop triggers of 0009 let only that role write users, groups and group_members. me_notify_admins writes no identity table and is
-- owned by pmis_definer. Every function is SECURITY DEFINER with search_path pg_catalog, public, pg_temp; PUBLIC is revoked; pmis_app may execute only
-- the entry functions (idm_set_mfa_exempt, idm_mfa_exemption_state, auth_mfa_required, idm_group_create, me_notify_admins).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. MFA exemption
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE user_mfa_exemptions (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE,
  until          TIMESTAMPTZ(6),                    -- null = until revoked
  reason         TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  granted_by     UUID NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  granted_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ(6),
  revoked_by     UUID REFERENCES users(id) ON UPDATE CASCADE,
  revoke_reason  TEXT,
  CONSTRAINT user_mfa_exemptions_not_self CHECK (granted_by <> user_id),
  CONSTRAINT user_mfa_exemptions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
ALTER TABLE user_mfa_exemptions ENABLE ROW LEVEL SECURITY;   -- no policy: only the owner of the idm_* functions (BYPASSRLS) reads or writes it
GRANT SELECT, INSERT, UPDATE ON user_mfa_exemptions TO pmis_identity_owner;

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('require_mfa', 'false'::jsonb, 'ADR 0002 item 3: GSDN Workspace requires MFA at sign-in and step-up (local accounts: a TOTP code). Off until IT enables MFA. A per-user MFA exemption skips it.', now()),
  ('notify_admins.cooldown_minutes', '60'::jsonb, 'Q623: minutes between two "notify the System Admins" requests of one user (1 to 1440).', now())
ON CONFLICT (key) DO NOTHING;
-- Both are security settings with no screen yet (Q621): the generic configuration rights on settings must not change them, so they are guarded like the
-- keys of 0072 (settings_guarded_keys: only definer code or the migration role on the server). An admin door can be added later.
CREATE TRIGGER b_settings_users_groups_api BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key IN ('require_mfa', 'notify_admins.cooldown_minutes')) EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_users_groups_api_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key IN ('require_mfa', 'notify_admins.cooldown_minutes') OR NEW.key IN ('require_mfa', 'notify_admins.cooldown_minutes'))
  EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_users_groups_api_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key IN ('require_mfa', 'notify_admins.cooldown_minutes')) EXECUTE FUNCTION settings_guarded_keys();

-- The exemption in force for a user (no row = not exempt). Internal.
CREATE OR REPLACE FUNCTION idm_mfa_exempt_now(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_mfa_exemptions e WHERE e.user_id = p_user AND e.revoked_at IS NULL AND (e.until IS NULL OR e.until > now()))
$$;

-- What the Users & Roles screen and GET /users/{id}/mfa-exemption show. Rows only for the user themselves or a holder of admin.users view; nothing
-- otherwise (the API answers 403 module_forbidden first).
CREATE OR REPLACE FUNCTION idm_mfa_exemption_state(p_user uuid)
RETURNS TABLE (exempt boolean, until timestamptz, reason text, granted_by uuid, granted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT x.on_now, CASE WHEN x.on_now THEN x.until END, CASE WHEN x.on_now THEN x.reason END, CASE WHEN x.on_now THEN x.granted_by END,
         CASE WHEN x.on_now THEN x.granted_at END
  FROM (SELECT e.until, e.reason, e.granted_by, e.granted_at, (e.revoked_at IS NULL AND (e.until IS NULL OR e.until > now())) AS on_now
        FROM public.user_mfa_exemptions e WHERE e.user_id = p_user
        UNION ALL
        SELECT NULL, NULL, NULL, NULL, false WHERE NOT EXISTS (SELECT 1 FROM public.user_mfa_exemptions e WHERE e.user_id = p_user)) x
  WHERE p_user = public.app_ctx_user()
     OR (public.app_actor() IS NOT NULL AND public.app_has_permission(public.app_actor(), 'admin.users', 'view'))
$$;

-- GSDN Workspace's MFA check for one user (sign-in and step-up): require_mfa is on and no exemption is in force. Only for the user of the signed
-- context (the sign-in transaction names the person signing in), so nobody learns another person's state through it.
CREATE OR REPLACE FUNCTION auth_mfa_required(p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_user IS NULL OR public.app_ctx_user() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'mfa check: only for the user of the signed context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(public.log_setting('require_mfa', 'false'::jsonb) = 'true'::jsonb, false) AND NOT public.idm_mfa_exempt_now(p_user);
END $$;

-- PUT /users/{id}/mfa-exemption (p_exempt true) and POST /users/{id}/mfa-exemption/revoke (p_exempt false). Returns the audit action written and the id of
-- the in-app notice, whose dedup key (notification:<id>) the API uses for the mail to the user.
CREATE OR REPLACE FUNCTION idm_set_mfa_exempt(p_user uuid, p_exempt boolean, p_until timestamptz, p_reason text)
RETURNS TABLE (r_action text, r_notification uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.idm_actor('users', 'administer'); o public.user_mfa_exemptions%ROWTYPE; was boolean := false; bef jsonb; aft jsonb;
        rs text := btrim(coalesce(p_reason, '')); act text; nid uuid;
BEGIN
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required',
      'message', 'A reason of 3 to 1000 characters is required.'))));
  END IF;
  PERFORM public.idm_need_global('users', 'administer');
  IF p_user = a THEN RAISE EXCEPTION 'mfa exemption: you cannot exempt yourself; another admin does it' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p_exempt IS NULL THEN RAISE EXCEPTION 'exempt is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND NOT u.is_break_glass AND u.deleted_at IS NULL) THEN RAISE EXCEPTION 'user not found'; END IF;
  -- an admin or a delegate (or someone who was one) is a System Admin's business only
  PERFORM public.idm_assert_user_change_allowed(p_user);

  SELECT * INTO o FROM public.user_mfa_exemptions WHERE user_id = p_user FOR UPDATE;
  IF FOUND THEN was := o.revoked_at IS NULL AND (o.until IS NULL OR o.until > now()); END IF;
  bef := CASE WHEN was THEN jsonb_build_object('exempt', true, 'until', o.until, 'granted_by', o.granted_by) ELSE jsonb_build_object('exempt', false) END;

  IF p_exempt THEN
    IF p_until IS NOT NULL AND p_until <= now() THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/until', 'code', 'must_be_future',
        'message', 'The end date must be in the future (or empty: until revoked).'))));
    END IF;
    INSERT INTO public.user_mfa_exemptions (user_id, until, reason, granted_by, granted_at) VALUES (p_user, p_until, rs, a, now())
      ON CONFLICT (user_id) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,
        revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL;
    act := CASE WHEN was THEN 'mfa_exemption_changed' ELSE 'mfa_exemption_granted' END;
    aft := jsonb_build_object('exempt', true, 'until', p_until, 'granted_by', a);
    nid := gen_random_uuid();
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, id)
    VALUES (p_user, 'in_app', 'mfa_exemption', 'You are exempt from the GSDN Workspace MFA requirement',
      CASE WHEN p_until IS NULL THEN 'An administrator exempted your account from the GSDN Workspace MFA requirement until it is revoked.'
           ELSE 'An administrator exempted your account from the GSDN Workspace MFA requirement until ' || to_char(p_until AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.' END
        || ' MFA required by Microsoft 365 is not changed.', '/profile', nid);
  ELSE
    IF NOT was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This user is not exempt from MFA, so there is nothing to revoke.')); END IF;
    UPDATE public.user_mfa_exemptions SET revoked_at = now(), revoked_by = a, revoke_reason = rs WHERE user_id = p_user;
    act := 'mfa_exemption_revoked';
    aft := jsonb_build_object('exempt', false);
    nid := gen_random_uuid();
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, id)
    VALUES (p_user, 'in_app', 'mfa_exemption', 'Your MFA exemption was revoked',
      'An administrator revoked the exemption of your account from the GSDN Workspace MFA requirement. Sign-in and step-up follow the normal MFA rule again.', '/profile', nid);
  END IF;
  UPDATE public.users SET updated_at = now() WHERE id = p_user;
  PERFORM public.log_audit_write(act, 'user', p_user::text, bef, aft, rs, NULL, NULL, public.idm_on_behalf(), true);
  r_action := act; r_notification := nid; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Create a group
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_group_create(p_name text, p_desc text, p_members uuid[], p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.idm_actor('groups', 'create'); nm text := btrim(coalesce(p_name, '')); ds text := nullif(btrim(coalesce(p_desc, '')), '');
        rs text := btrim(coalesce(p_reason, '')); mem uuid[]; m uuid; i int := 0; gid uuid; errs jsonb := '[]'::jsonb; st text;
BEGIN
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    errs := errs || jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.');
  END IF;
  IF char_length(nm) < 2 OR char_length(nm) > 120 THEN errs := errs || jsonb_build_object('path', '/name', 'code', 'invalid', 'message', '2 to 120 characters.'); END IF;
  IF ds IS NOT NULL AND char_length(ds) > 500 THEN errs := errs || jsonb_build_object('path', '/description', 'code', 'invalid', 'message', 'At most 500 characters.'); END IF;
  IF cardinality(coalesce(p_members, ARRAY[]::uuid[])) > 500 THEN errs := errs || jsonb_build_object('path', '/member_ids', 'code', 'invalid', 'message', 'At most 500 members.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM public.idm_need_global('groups', 'create');
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;

  SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO mem FROM unnest(coalesce(p_members, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;
  IF cardinality(mem) > 0 THEN
    PERFORM public.idm_actor('groups', 'edit');
    PERFORM public.idm_need_global('groups', 'edit');
    IF a = ANY (mem) THEN RAISE EXCEPTION 'you cannot add yourself to a group' USING ERRCODE = 'insufficient_privilege'; END IF;
    FOREACH m IN ARRAY coalesce(p_members, ARRAY[]::uuid[]) LOOP
      SELECT CASE WHEN u.id IS NULL OR u.deleted_at IS NOT NULL OR u.is_break_glass THEN 'not_found' WHEN u.status = 'pending_assignment' THEN 'pending_assignment' END
        INTO st FROM (SELECT 1) one LEFT JOIN public.users u ON u.id = m;
      IF st IS NOT NULL THEN
        errs := errs || jsonb_build_object('path', '/member_ids/' || i, 'code', st,
          'message', CASE st WHEN 'not_found' THEN 'No such user.' ELSE 'A pending user cannot join a group.' END);
      END IF;
      i := i + 1;
    END LOOP;
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.groups g WHERE lower(g.name) = lower(nm)) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A group with this name exists already.'));
  END IF;
  INSERT INTO public.groups (name, description, is_active) VALUES (nm, ds, true) RETURNING id INTO gid;
  PERFORM public.log_audit_write('group_created', 'group', gid::text, NULL,
    jsonb_build_object('name', nm, 'description', ds, 'member_ids', to_jsonb(mem)), rs, NULL, NULL, public.idm_on_behalf(), true);
  -- the members through the existing door: its own rights check, the self rule and the post-state ceiling (one audit row per member)
  FOREACH m IN ARRAY mem LOOP
    PERFORM public.idm_group_add_member(gid, m, rs);
  END LOOP;
  PERFORM public.idm_assert_group_within_actor(gid);
  RETURN gid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Notify the System Admins
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE me_admin_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  message     TEXT CHECK (message IS NULL OR char_length(message) <= 500),
  recipients  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX me_admin_requests_user ON me_admin_requests (user_id, created_at DESC);
ALTER TABLE me_admin_requests ENABLE ROW LEVEL SECURITY;   -- no policy: only me_notify_admins (owner pmis_definer, BYPASSRLS)
GRANT SELECT, INSERT ON me_admin_requests TO pmis_definer;

-- Returns the number of System Admins notified. The actor is the user of the signed context (a pending account has no app_actor()).
CREATE OR REPLACE FUNCTION me_notify_admins(p_message text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid := public.app_ctx_user(); u public.users%ROWTYPE; msg text; cool int; last_at timestamptz; rid uuid; n int := 0; mailed int := 0; adm uuid; adm_email text; nid uuid;
        who text; v jsonb;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'no signed-in user' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO u FROM public.users WHERE id = uid;
  IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.is_break_glass OR u.status NOT IN ('pending_assignment', 'active') THEN
    RAISE EXCEPTION 'no signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- plain text only: control characters (except line breaks) become spaces, no markup at all (Q624)
  msg := nullif(btrim(regexp_replace(replace(coalesce(p_message, ''), E'\r\n', E'\n'), '[\x01-\x09\x0B-\x1F\x7F]', ' ', 'g')), '');
  IF msg IS NOT NULL AND char_length(msg) > 500 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/message', 'code', 'too_long', 'message', 'At most 500 characters.'))));
  END IF;
  IF msg IS NOT NULL AND (msg ~ '[<>]' OR msg ~* '&(#[0-9]+|#x[0-9a-f]+|[a-z]+);') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/message', 'code', 'markup_not_allowed',
      'message', 'Write plain text: the characters < and > and HTML entities are not accepted.'))));
  END IF;
  v := public.log_setting('notify_admins.cooldown_minutes', '60'::jsonb);
  cool := CASE WHEN jsonb_typeof(v) = 'number' AND (v #>> '{}')::numeric BETWEEN 1 AND 1440 THEN (v #>> '{}')::numeric::int ELSE 60 END;
  -- one request at a time per user: two parallel calls of the same person wait for each other here
  PERFORM pg_advisory_xact_lock(hashtextextended('pmis.notify_admins:' || uid::text, 0));
  SELECT max(r.created_at) INTO last_at FROM public.me_admin_requests r WHERE r.user_id = uid;
  IF last_at IS NOT NULL AND last_at > now() - make_interval(mins => cool) THEN
    PERFORM public.wf_err('rate_limited', jsonb_build_object('retry_after', greatest(1, ceil(extract(epoch FROM (last_at + make_interval(mins => cool) - now())))::int)));
  END IF;
  INSERT INTO public.me_admin_requests (user_id, message) VALUES (uid, msg) RETURNING id INTO rid;
  who := u.display_name || coalesce(' (' || btrim(u.employee_id) || ')', '');
  FOR adm, adm_email IN SELECT DISTINCT x.id, x.email FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
             JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL WHERE x.id <> uid ORDER BY x.id LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (adm, 'in_app', 'assignment_request', 'Assignment requested',
      left(who || ' asks for an assignment (status: ' || replace(u.status::text, '_', ' ') || ').' || coalesce(E'\n' || msg, ''), 2000), '/admin/users/' || uid::text)
    RETURNING id INTO nid;
    n := n + 1;
    -- always mailed; the dedup key is the one of mail_on_notification, so listing the kind in mail.notification_kinds never sends a second mail
    BEGIN
      IF public.mail_address_ok(adm_email) AND public.mail_enqueue_internal('identity.assignment_request', adm_email, adm,
           left('[PMIS] Assignment requested: ' || regexp_replace(u.display_name, '[\r\n]+', ' ', 'g'), 200),
           who || ' asks for an assignment in GSDN Workspace (status: ' || replace(u.status::text, '_', ' ') || ').' || coalesce(E'\n\nMessage:\n' || msg, '')
             || E'\n\nOpen: {{app_url}}/admin/users/' || uid::text || E'\n\nGSDN Workspace.',
           'notification:' || nid::text, false, jsonb_build_object('request_id', rid, 'notification_id', nid)) IS NOT NULL THEN
        mailed := mailed + 1;
      END IF;
    EXCEPTION WHEN others THEN
      PERFORM public.log_system_write('warn', 'mail', 'assignment request mail not queued', jsonb_build_object('request_id', rid, 'error', left(SQLERRM, 200)), uid, NULL);
    END;
  END LOOP;
  UPDATE public.me_admin_requests SET recipients = n WHERE id = rid;
  -- a pending account has no app_actor(), so the row is written here (as idm_set_employee_id does) with the signed user as the actor
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('admins_notified', 'user', uid::text, jsonb_build_object('request_id', rid, 'recipients', n, 'mails', mailed, 'message_length', coalesce(char_length(msg), 0),
    'status', u.status), uid);
  RETURN n;
END $$;
GRANT UPDATE ON me_admin_requests TO pmis_definer;

-- The two notification kinds this release starts writing (mfa_exemption to the exempted user, assignment_request to the System Admins) join the mail
-- catalogue (rule of 0072: "added here by the release that starts writing them"). Redefined in full from its latest body (0140); only the last two kinds are new.
-- Both kinds are also mailed by this release in every case, with the dedup key notification:<id> that mail_on_notification uses, so an admin who also lists
-- them in mail.notification_kinds never causes a second mail.
CREATE OR REPLACE FUNCTION mail_kind_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('kind', k, 'recommended', ord <= 6) ORDER BY ord)
  FROM unnest(ARRAY[
    'task_assigned', 'register_assigned', 'snag_review', 'task_rejected', 'register_rejected', 'snag_rejected',
    'email_change_decided', 'email_change_requested', 'followed_change', 'gate_closed_again', 'holiday_tentative', 'import_batch', 'levels_converted', 'mention',
    'no_eligible_holder', 'order_team_mismatch', 'party_type_review', 'permit_transferred', 'phone_change_decided', 'phone_change_requested', 'site_draft_approved',
    'site_draft_assigned', 'site_draft_returned', 'site_region_moved', 'sla_negative_duration', 'snag_closed', 'snag_raised', 'team_safety_cert',
    'absence_alert', 'reassigned',
    'mfa_exemption', 'assignment_request'
  ]) WITH ORDINALITY AS t(k, ord)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['idm_mfa_exempt_now(uuid)', 'idm_mfa_exemption_state(uuid)', 'auth_mfa_required(uuid)', 'idm_set_mfa_exempt(uuid,boolean,timestamptz,text)',
    'idm_group_create(text,text,uuid[],text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  ALTER FUNCTION me_notify_admins(text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION me_notify_admins(text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON user_mfa_exemptions, me_admin_requests FROM pmis_app;
    -- not granted: idm_mfa_exempt_now (internal)
    GRANT EXECUTE ON FUNCTION idm_mfa_exemption_state(uuid), auth_mfa_required(uuid), idm_set_mfa_exempt(uuid, boolean, timestamptz, text),
      idm_group_create(text, text, uuid[], text), me_notify_admins(text) TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The progress of an integrity check (redefined in full from its latest body, 0055; only the progress expression changes)
-- ---------------------------------------------------------------------------------------------------------------------
-- The progress was floor(100 * checked / total): once a chain holds more than 100 positions per step, a step that checked rows still read 0 %,
-- as if nothing had moved (the audit chain of a fresh database passed 200 positions with this release). While a run is not at its end the progress
-- is now 1 to 99, and 100 only at the end. Same signature, owner and rights.
CREATE OR REPLACE FUNCTION log_integrity_step(p_run uuid, p_max_rows integer) RETURNS log_integrity_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.log_integrity_runs%ROWTYPE; upto bigint; s record; nb jsonb;
BEGIN
  SELECT * INTO r FROM public.log_integrity_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The integrity check does not exist.')); END IF;
  IF NOT public.log_integrity_driver_ok(r) THEN RAISE EXCEPTION 'log integrity: not the driver of this check' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF r.status <> 'running' OR r.checked_through >= r.to_seq THEN RETURN r; END IF;
  upto := least(r.to_seq, r.checked_through + least(greatest(coalesce(p_max_rows, 10000), 1), 50000));
  SELECT * INTO s FROM public.log_chain_verify_slice(r.log, r.checked_through, upto, r.last_hash);
  nb := r.breaks;
  IF jsonb_array_length(nb) < 100 THEN
    nb := nb || (SELECT coalesce(jsonb_agg(q.b ORDER BY q.o), '[]'::jsonb)
                 FROM (SELECT e.value AS b, e.ordinality AS o FROM jsonb_array_elements(s.breaks) WITH ORDINALITY e ORDER BY e.ordinality LIMIT 100 - jsonb_array_length(r.breaks)) q);
  END IF;
  UPDATE public.log_integrity_runs SET checked_through = upto, last_hash = s.last_hash, row_count = r.row_count + s.checked, breaks = nb,
    break_count = r.break_count + jsonb_array_length(s.breaks), head_hash = coalesce(s.last_hash, r.head_hash)
  WHERE id = p_run RETURNING * INTO r;
  UPDATE public.job_runs SET rows = r.row_count, detail = jsonb_build_object('run_id', r.id, 'log', r.log, 'trigger', r.trigger, 'from_seq', r.from_seq, 'to_seq', r.to_seq,
    'checked_through', r.checked_through, 'break_count', r.break_count,
    'progress', CASE WHEN r.to_seq < r.from_seq OR r.checked_through >= r.to_seq THEN 100
                     -- 0143: a step that checked rows never reads 0 %, and a run that has not reached the end never reads 100 %
                     ELSE least(99, greatest(1, floor(100.0 * (r.checked_through - r.from_seq + 1) / (r.to_seq - r.from_seq + 1))))::int END)
  WHERE id = r.job_run_id AND outcome = 'running';
  RETURN r;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('users_groups_api_applied', 'workflow', NULL,
        jsonb_build_object('tables', jsonb_build_array('user_mfa_exemptions', 'me_admin_requests'),
          'doors', jsonb_build_array('idm_set_mfa_exempt', 'idm_mfa_exemption_state', 'auth_mfa_required', 'idm_group_create', 'me_notify_admins'),
          'settings', jsonb_build_object('require_mfa', false, 'notify_admins.cooldown_minutes', 60)),
        'Owner request 2026-10-25 (per-user MFA exemption), groups and the pending user''s request to the System Admins on the real API (migration 0143).');
