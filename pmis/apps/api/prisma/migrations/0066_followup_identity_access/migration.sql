-- 0066_followup_identity_access: follow-up group A of the technical decisions of 2026-11-04 (docs/spec/technical-decisions-2026-11-04.md).
-- Mirror: db/sql/065_followup_identity_access.sql (kept byte-identical to prisma/migrations/0066_followup_identity_access/migration.sql).
--
--   1. Q300 (P8): the database refuses an overlapping role assignment, not only the bulk paths of the API. Two rows overlap when they have the same
--      person and role, overlapping validity dates, a shared region and a shared top-level module (split_part(key, '.', 1); all_regions and
--      all_modules share everything), as the API reads it (Q18, Q301). A deferred constraint trigger on user_role_assignments and on its region and
--      module rows checks the assignment at commit (SQLSTATE 23P01), serialised per person and role. Rows that have ended are not checked. Rows that
--      overlap already are NOT refused by this migration: assignment_overlaps_log() reports each pair to the System Log (warn, source assignments);
--      the trigger fires only when a row's dates, person, role or scope rows are written, so ending such a row always works and a level change does not.
--   2. Q303 (P8): an approved change of the email (a sign-in identifier) ends every session of the user (revoke_reason email_changed) and writes a
--      security_notice, as turning two-factor off does. A phone change keeps the sessions.
--   3. Q307 (P8): log_audit_write takes p_admin_override (default false), so admin decisions on another person's identity set audit_log.is_admin_override
--      again: email and phone decisions and every two-factor change of an admin. Only a System Admin or a delegate may pass true (42501 otherwise).
--      The 9-argument signature becomes the 10-argument one with a default, so every existing call keeps working (a second overload would make
--      calls with 9 arguments ambiguous).
--   4. Q294 (P5): a Contractors company whose CoStatus is Suspended or Blacklisted deactivates its external party, like Terminated, Inactive, Expired and
--      Closed. The existing checks refuse a deactivated party on new orders (party_inactive, 0019 / 0026 / 0061). Approved companies that already
--      have the status are deactivated here.
--   5. Q292 (P5, P4b): team_specializations is the single source of team specializations. A specialization may belong to both groups CW and TE
--      (func_groups replaces func_group; Dismantle is CW and TE, Tower RT, Tower GF and Adaption CW, TE TE, GECOL, Fiber and Survey none). The P5
--      list TeamSpecialization mirrors the table (team_spec_sync_list, run by a statement trigger and by admin_save_team_scope_match); a value keeps
--      the code it was first given (list_code), so records keep reading. admin_save_list_value refuses the list (422 managed_elsewhere) and a
--      trigger refuses any other write to its values. Old teams with the text CW are not converted (Q320).
--
-- Every function is SECURITY DEFINER with SET search_path, owner pmis_definer (the identity functions keep pmis_identity_owner), PUBLIC revoked.
-- pmis_app gets no right on any table here.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Q307: log_audit_write with the admin-override flag
-- ---------------------------------------------------------------------------------------------------------------------
DROP FUNCTION log_audit_write(text, text, text, jsonb, jsonb, text, uuid, integer, uuid);
CREATE FUNCTION log_audit_write(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text,
  p_site uuid DEFAULT NULL, p_region integer DEFAULT NULL, p_on_behalf uuid DEFAULT NULL, p_admin_override boolean DEFAULT false) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); nid bigint;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z][a-z0-9_.]{1,79}$' OR p_entity_type IS NULL OR p_entity_type !~ '^[a-z][a-z0-9_]{1,59}$' THEN
    RAISE EXCEPTION 'audit: action and entity type are lower-case codes' USING ERRCODE = 'check_violation';
  END IF;
  IF p_region IS NOT NULL AND NOT public.app_region_check(p_region) THEN RAISE EXCEPTION 'audit: region not visible' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- the flag marks a decision of an administrator: only a System Admin or a delegate may set it, so nobody can dress an ordinary row as privileged
  IF coalesce(p_admin_override, false) AND NOT (public.app_actor_is_system_admin() OR EXISTS (SELECT 1 FROM public.app_user_delegations(a))) THEN
    RAISE EXCEPTION 'audit: only a System Admin or a delegate marks a row as an admin override' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, on_behalf_of, is_admin_override)
  VALUES (p_action, p_entity_type, left(p_entity_id, 200), p_site, p_region, p_before, p_after, left(p_reason, 2000), a, p_on_behalf, coalesce(p_admin_override, false))
  RETURNING audit_log.id INTO nid;
  RETURN nid;
END $$;

ALTER FUNCTION log_audit_write(text, text, text, jsonb, jsonb, text, uuid, integer, uuid, boolean) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION log_audit_write(text, text, text, jsonb, jsonb, text, uuid, integer, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_audit_write(text, text, text, jsonb, jsonb, text, uuid, integer, uuid, boolean) TO pmis_definer, pmis_identity_owner;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION log_audit_write(text, text, text, jsonb, jsonb, text, uuid, integer, uuid, boolean) TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q303 and Q307: the decisions of 0058 with the override flag; an approved email change ends the sessions
-- ---------------------------------------------------------------------------------------------------------------------
-- Same as 0058, except: both audit rows carry the admin-override flag.
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
      jsonb_build_object('phone', r.new_phone, 'request_id', r.id, 'via', 'phone_change_request'), btrim(p_reason), NULL, NULL, public.idm_on_behalf(), true);
  ELSE
    st := 'rejected';
    PERFORM public.log_audit_write('phone_change_rejected', 'user', r.user_id::text,
      jsonb_build_object('requested_phone', r.new_phone, 'request_id', r.id, 'status', 'pending'),
      jsonb_build_object('requested_phone', r.new_phone, 'request_id', r.id, 'status', 'rejected'), btrim(p_reason), NULL, NULL, public.idm_on_behalf(), true);
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

-- Same as 0058, except: both audit rows carry the admin-override flag, and an approval ends every session of the user (Q303) and writes a
-- security notice to the user's inbox. The 3-argument form of 0058 calls this one and keeps its grants.
-- Decide with the documented identity check (Q158). An approval needs a verified address, or p_identity_check: what the admin did to confirm
-- that the address belongs to the user while mail is not available (it is stored and audited). A rejection needs neither.
CREATE OR REPLACE FUNCTION idm_decide_email_change(p_id uuid, p_approve boolean, p_reason text, p_identity_check text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); r public.email_change_requests%ROWTYPE; cur text; st text; chk text := nullif(btrim(coalesce(p_identity_check, '')), '');
        via text; ended int := 0;
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
    -- Q303: the email is a sign-in identifier, so every session of the user ends as after a password change (a phone change keeps them)
    UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'email_changed' WHERE user_id = r.user_id AND revoked_at IS NULL;
    GET DIAGNOSTICS ended = ROW_COUNT;
    PERFORM public.idm_security_notice(r.user_id, 'Your sign-in email was changed',
      'An administrator approved the change of your sign-in email to ' || r.new_email || '. ' || ended || ' session(s) were signed out: sign in again with the new address. '
        || 'If you did not ask for this, tell an administrator.');
    st := 'approved';
    PERFORM public.log_audit_write('email_changed', 'user', r.user_id::text, jsonb_build_object('email', cur, 'request_id', r.id),
      jsonb_build_object('email', r.new_email, 'request_id', r.id, 'verified_via', via, 'sessions_ended', ended)
        || CASE WHEN via = 'admin_check' THEN jsonb_build_object('identity_check', chk) ELSE '{}'::jsonb END,
      btrim(p_reason), NULL, NULL, public.idm_on_behalf(), true);
  ELSE
    st := 'rejected';
    PERFORM public.log_audit_write('email_change_rejected', 'user', r.user_id::text,
      jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'pending'),
      jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'rejected'), btrim(p_reason), NULL, NULL, public.idm_on_behalf(), true);
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

-- Same as 0058, except: every audit row of an admin carries the admin-override flag (turning it on, enforcing it, turning it off).
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
          jsonb_build_object('two_factor', before_label, 'enforced', true), p_reason, NULL, NULL, public.idm_on_behalf(), true);
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
    p_reason, NULL, NULL, public.idm_on_behalf(), true);
  r_state := public.idm_two_factor_label(p_user); r_expires := exp; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q300: a deferred check against overlapping assignments
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON user_role_assignments, user_role_assignment_regions, user_role_assignment_modules TO pmis_definer;

-- True when two different rows of the same person and role overlap: both not yet ended, their dates overlap ([from, to), no end = open), and
-- they share a region and a top-level module (all_regions / all_modules share everything). The one definition of the rule (Q18, Q301).
CREATE OR REPLACE FUNCTION assignment_rows_overlap(p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_role_assignments a JOIN public.user_role_assignments b ON b.id = p_b
    WHERE a.id = p_a AND a.id <> b.id AND a.user_id = b.user_id AND a.role_id = b.role_id
      AND (a.valid_to IS NULL OR a.valid_to > now()) AND (b.valid_to IS NULL OR b.valid_to > now())
      AND b.valid_from < coalesce(a.valid_to, 'infinity'::timestamptz) AND a.valid_from < coalesce(b.valid_to, 'infinity'::timestamptz)
      AND (a.all_regions OR b.all_regions
           OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions ra JOIN public.user_role_assignment_regions rb ON rb.region_id = ra.region_id
                      WHERE ra.assignment_id = a.id AND rb.assignment_id = b.id))
      AND (a.all_modules OR b.all_modules
           OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules ma JOIN public.user_role_assignment_modules mb
                        ON split_part(mb.module_key, '.', 1) = split_part(ma.module_key, '.', 1)
                      WHERE ma.assignment_id = a.id AND mb.assignment_id = b.id))
  )
$$;

CREATE OR REPLACE FUNCTION assignment_overlap_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE aid uuid; a public.user_role_assignments%ROWTYPE; other uuid;
BEGIN
  IF TG_TABLE_NAME = 'user_role_assignments' THEN aid := NEW.id; ELSE aid := NEW.assignment_id; END IF;
  SELECT * INTO a FROM public.user_role_assignments WHERE id = aid;
  IF NOT FOUND OR (a.valid_to IS NOT NULL AND a.valid_to <= now()) THEN RETURN NULL; END IF;   -- gone or ended: nothing to protect
  -- two transactions that each add a row for the same person and role must not both pass: the second waits for the first and then sees its row
  PERFORM pg_advisory_xact_lock(hashtextextended('pmis.assignment_overlap:' || a.user_id::text || ':' || a.role_id::text, 0));
  SELECT o.id INTO other FROM public.user_role_assignments o
  WHERE o.user_id = a.user_id AND o.role_id = a.role_id AND o.id <> a.id AND public.assignment_rows_overlap(a.id, o.id)
  ORDER BY o.valid_from, o.id LIMIT 1;
  IF other IS NOT NULL THEN
    RAISE EXCEPTION 'assignment % overlaps assignment %: the person already holds this role for an overlapping region and module in that period', aid, other
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NULL;
END $$;

-- The rows that overlap already, reported (not refused): one System Log row per pair, at most 500, then one summary. Returns the number of pairs.
CREATE OR REPLACE FUNCTION assignment_overlaps_log() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT a.id AS a_id, b.id AS b_id, a.user_id, a.role_id
           FROM public.user_role_assignments a JOIN public.user_role_assignments b ON b.user_id = a.user_id AND b.role_id = a.role_id AND a.id < b.id
           WHERE public.assignment_rows_overlap(a.id, b.id)
           ORDER BY a.user_id, a.role_id, a.id, b.id
  LOOP
    n := n + 1;
    IF n <= 500 THEN
      PERFORM public.log_system_write('warn', 'assignments',
        'Overlapping role assignments of one person (Q300): end or narrow one of the two rows. The database now refuses new overlaps; these existed before.',
        jsonb_build_object('user_id', r.user_id, 'role_id', r.role_id, 'assignment_ids', jsonb_build_array(r.a_id, r.b_id)), NULL, NULL);
    END IF;
  END LOOP;
  IF n > 500 THEN
    PERFORM public.log_system_write('warn', 'assignments', 'More overlapping role assignment pairs than reported one by one (Q300).', jsonb_build_object('pairs', n, 'reported', 500), NULL, NULL);
  END IF;
  RETURN n;
END $$;

SELECT assignment_overlaps_log();

CREATE CONSTRAINT TRIGGER user_role_assignments_overlap AFTER INSERT ON user_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_overlap_check();
CREATE CONSTRAINT TRIGGER user_role_assignments_overlap_upd AFTER UPDATE ON user_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.valid_from IS DISTINCT FROM NEW.valid_from OR OLD.valid_to IS DISTINCT FROM NEW.valid_to OR OLD.all_regions IS DISTINCT FROM NEW.all_regions
        OR OLD.all_modules IS DISTINCT FROM NEW.all_modules OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.role_id IS DISTINCT FROM NEW.role_id)
  EXECUTE FUNCTION assignment_overlap_check();
CREATE CONSTRAINT TRIGGER user_role_assignment_regions_overlap AFTER INSERT OR UPDATE ON user_role_assignment_regions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_overlap_check();
CREATE CONSTRAINT TRIGGER user_role_assignment_modules_overlap AFTER INSERT OR UPDATE ON user_role_assignment_modules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_overlap_check();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q294: Suspended and Blacklisted deactivate the external party
-- ---------------------------------------------------------------------------------------------------------------------
-- Same as 0025, except: the CoStatus values Suspended and Blacklisted also make the party inactive.
CREATE OR REPLACE FUNCTION catalog_on_approved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; party uuid; ptype text; active boolean;
BEGIN
  -- Q45: the approver and the approval date come from this approval, never typed
  IF NEW.register_key = 'change_control' THEN
    UPDATE public.register_records SET data = data || jsonb_build_object('approval', 'Approved', 'approved_by', NEW.approved_by::text, 'approval_date', current_date::text) WHERE id = NEW.id;
  ELSIF NEW.register_key = 'quality' THEN
    UPDATE public.register_records SET data = data || jsonb_build_object('approved_by', NEW.approved_by::text)
      || CASE WHEN lower(coalesce(d ->> 'result', '')) = 'n/a' THEN jsonb_build_object('na_approved_by', NEW.approved_by::text) ELSE '{}'::jsonb END WHERE id = NEW.id;
  ELSIF NEW.register_key = 'readiness_handover' AND lower(coalesce(d ->> 'om_checklist', '')) = 'n/a' THEN
    UPDATE public.register_records SET data = data || jsonb_build_object('na_approved_by', NEW.approved_by::text) WHERE id = NEW.id;
  ELSIF NEW.register_key = 'contractors' THEN
    -- the approved companies and teams are the external parties and teams that Procurement picks (id = the logical record)
    IF NEW.record_type = 'company' THEN
      ptype := lower(regexp_replace(coalesce(d ->> 'company_type', ''), '[^A-Za-z]+', '_', 'g'));
      IF ptype NOT IN ('cw_contractor', 'te_vendor', 'gecol', 'hlc', 'supplier', 'landlord') THEN ptype := 'other'; END IF;
      -- Q294: a suspended or blacklisted company must not receive orders, like a terminated, inactive, expired or closed one
      active := lower(coalesce(d ->> 'company_status', 'active')) NOT IN ('inactive', 'terminated', 'expired', 'closed', 'suspended', 'blacklisted');
      INSERT INTO public.external_parties (id, name, type, company_type, contract_ref, contract_start, contract_end, is_active)
      VALUES (NEW.entity_id, d ->> 'contractor_name', ptype::"ExternalPartyType", d ->> 'company_type', d ->> 'contract_ref', (d ->> 'contract_start')::date, (d ->> 'contract_end')::date, active)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, company_type = EXCLUDED.company_type, contract_ref = EXCLUDED.contract_ref,
        contract_start = EXCLUDED.contract_start, contract_end = EXCLUDED.contract_end, is_active = EXCLUDED.is_active;
    ELSIF NEW.record_type = 'team' THEN
      SELECT p.id INTO party FROM public.external_parties p WHERE lower(p.name) = lower(d ->> 'contractor') ORDER BY p.is_active DESC LIMIT 1;
      IF party IS NOT NULL THEN
        active := lower(coalesce(d ->> 'team_status', 'active')) NOT IN ('inactive', 'closed');
        INSERT INTO public.external_teams (id, party_id, name, team_type, specialization, is_active)
        VALUES (NEW.entity_id, party, d ->> 'team_name', d ->> 'team_type', d ->> 'specialization', active)
        ON CONFLICT (id) DO UPDATE SET party_id = EXCLUDED.party_id, name = EXCLUDED.name, team_type = EXCLUDED.team_type, specialization = EXCLUDED.specialization, is_active = EXCLUDED.is_active;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Companies approved before this migration with one of the two statuses: their party is deactivated now (the current approved version decides).
DO $$
DECLARE n integer;
BEGIN
  UPDATE public.external_parties p SET is_active = false
  FROM public.register_records r
  WHERE r.entity_id = p.id AND r.is_current AND r.register_key = 'contractors' AND r.record_type = 'company' AND r.state = 'approved'
    AND p.is_active AND lower(coalesce(r.data ->> 'company_status', 'active')) IN ('suspended', 'blacklisted');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    PERFORM public.log_system_write('warn', 'contractors', 'Companies with the status Suspended or Blacklisted were deactivated as external parties (Q294).',
      jsonb_build_object('parties', n), NULL, NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q292: team_specializations is the single source; the P5 list TeamSpecialization mirrors it
-- ---------------------------------------------------------------------------------------------------------------------
-- A specialization may belong to both functional groups (Dismantle is CW and TE). func_groups replaces func_group.
ALTER TABLE team_specializations
  ADD COLUMN func_groups TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (func_groups <@ ARRAY['CW', 'TE']::TEXT[]),
  ADD COLUMN list_code   TEXT;     -- the code of its value in the list TeamSpecialization (fixed once given: records store it)
UPDATE team_specializations SET func_groups = CASE WHEN func_group IS NULL THEN ARRAY[]::TEXT[] ELSE ARRAY[func_group] END;
ALTER TABLE team_specializations DROP COLUMN func_group;
COMMENT ON COLUMN team_specializations.func_groups IS 'Q292: the functional groups (CW, TE) of the specialization; a scope that allows a group allows every active specialization of it.';
COMMENT ON COLUMN team_specializations.list_code IS 'Q292: the code of the mirrored value of the list TeamSpecialization (set by team_spec_sync_list, never changes).';
COMMENT ON TABLE team_specializations IS 'Q143, Q292: the catalogue of team specializations, the single source (the P5 list TeamSpecialization mirrors it). Written only by admin_save_team_scope_match; never deleted.';

-- The groups of the seeded codes, as decided (Q292). A seeded code that differs is set to the decision and reported; a change of eligibility
-- moves the version of the match table, so an editor who read the old one is told to reload.
DO $$
DECLARE v record; n integer := 0;
BEGIN
  FOR v IN SELECT * FROM (VALUES ('TOWER_RT', ARRAY['CW']), ('TOWER_GF', ARRAY['CW']), ('ADAPTION', ARRAY['CW']), ('TE', ARRAY['TE']),
                               ('DISMANTLE', ARRAY['CW', 'TE']), ('GECOL', ARRAY[]::TEXT[]), ('FIBER', ARRAY[]::TEXT[]), ('SURVEY', ARRAY[]::TEXT[])) AS x(code, g)
  LOOP
    UPDATE team_specializations t SET func_groups = v.g WHERE t.code = v.code AND t.func_groups IS DISTINCT FROM v.g;
    IF FOUND THEN
      n := n + 1;
      PERFORM log_system_write('info', 'contractors', 'The functional groups of a team specialization were set as decided (Q292).',
        jsonb_build_object('code', v.code, 'groups', to_jsonb(v.g)), NULL, NULL);
    END IF;
  END LOOP;
  IF n > 0 THEN UPDATE team_scope_match_meta SET version = version + 1, updated_at = now() WHERE id; END IF;
END $$;

-- The whole table as the API returns it: each specialization also lists its groups (group stays for older clients: the first group).
CREATE OR REPLACE FUNCTION team_scope_match_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'specializations', coalesce((SELECT jsonb_agg(t.code ORDER BY t.sort_order, t.code) FROM public.team_specializations t WHERE t.is_active), '[]'::jsonb),
    'groups', '["CW", "TE"]'::jsonb,
    'catalogue', coalesce((SELECT jsonb_agg(jsonb_build_object('code', t.code, 'label_en', t.label_en, 'label_ar', t.label_ar, 'group', t.func_groups[1], 'groups', to_jsonb(t.func_groups),
                                                               'aliases', to_jsonb(t.aliases), 'is_active', t.is_active) ORDER BY t.is_active DESC, t.sort_order, t.code)
                           FROM public.team_specializations t), '[]'::jsonb),
    'scopes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'scope', s.scope, 'exempt', s.exempt,
               'allowed', coalesce((SELECT jsonb_agg(c.specialization ORDER BY t.sort_order, t.code) FROM public.team_scope_match c
                                    JOIN public.team_specializations t ON t.code = c.specialization AND t.is_active WHERE c.scope = s.scope AND c.allowed), '[]'::jsonb),
               'allowed_groups', coalesce((SELECT jsonb_agg(g.func_group ORDER BY g.func_group) FROM public.team_scope_match_groups g WHERE g.scope = s.scope), '[]'::jsonb))
             ORDER BY s.sort_order, s.scope COLLATE "C")
      FROM public.team_scope_match_scopes s), '[]'::jsonb),
    'version', m.version, 'updated_at', m.updated_at, 'updated_by', m.updated_by)
  FROM public.team_scope_match_meta m WHERE m.id
$$;


-- What decides eligibility (Q147: a change of it needs a step-up): the rows, the active codes with their groups and aliases. Labels do not.
CREATE OR REPLACE FUNCTION team_scope_match_rules(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('scopes', j -> 'scopes',
    'codes', coalesce((SELECT jsonb_agg(jsonb_build_object('code', e ->> 'code', 'groups', coalesce(e -> 'groups', '[]'::jsonb), 'aliases', e -> 'aliases') ORDER BY e ->> 'code')
                       FROM jsonb_array_elements(j -> 'catalogue') e WHERE (e ->> 'is_active')::boolean), '[]'::jsonb))
$$;

-- The writer. p_config = {specializations: [name], scopes: [{scope, exempt, allowed: [name], allowed_groups: [CW|TE]}], catalogue?: [{code, label_en,

-- The writer of 0061; a catalogue entry takes groups (CW and TE, both allowed) or the older single group, and the list TeamSpecialization is synced.
CREATE OR REPLACE FUNCTION admin_save_team_scope_match(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m public.team_scope_match_meta%ROWTYPE; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; k text; el jsonb; a jsonb; i integer; j integer;
  codes text[] := ARRAY[]::text[]; cd text; nm text; sc text; seen_scopes text[] := ARRAY[]::text[]; allowed text[]; grps text[]; n integer;
  labels_before jsonb; labels_after jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO m FROM public.team_scope_match_meta WHERE id FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> m.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with specializations and scopes.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('specializations', 'scopes', 'catalogue') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;

  -- shape first: nothing is written while the body is malformed
  IF jsonb_typeof(p_config -> 'specializations') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/specializations', 'required', 'The list of specializations is required.');
  ELSIF jsonb_array_length(p_config -> 'specializations') > 30 THEN
    errs := errs || public.reg_err_item('/specializations', 'too_many', 'At most 30 specializations.');
  ELSE
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'specializations') LOOP
      IF jsonb_typeof(el) <> 'string' OR char_length(btrim(el #>> '{}')) NOT BETWEEN 1 AND 60 THEN
        errs := errs || public.reg_err_item('/specializations/' || i, 'invalid', 'A specialization is a text of 1 to 60 characters.');
      ELSIF public.team_spec_resolve(el #>> '{}', true) IS NULL AND upper(btrim(el #>> '{}')) IN ('CW', 'TE') THEN
        errs := errs || public.reg_err_item('/specializations/' || i, 'is_a_group', btrim(el #>> '{}') || ' is a functional group, not a specialization: allow the group on the scope (allowed_groups).');
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF p_config ? 'catalogue' THEN
    IF jsonb_typeof(p_config -> 'catalogue') <> 'array' OR jsonb_array_length(p_config -> 'catalogue') > 60 THEN
      errs := errs || public.reg_err_item('/catalogue', 'invalid', 'A list of at most 60 specializations.');
    ELSE
      i := 0;
      FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'catalogue') LOOP
        IF jsonb_typeof(el) <> 'object' THEN errs := errs || public.reg_err_item('/catalogue/' || i, 'invalid', 'An object with code and labels.');
        ELSE
          FOR k IN SELECT jsonb_object_keys(el) LOOP
            IF k NOT IN ('code', 'label_en', 'label_ar', 'group', 'groups', 'aliases', 'is_active') THEN errs := errs || public.reg_err_item('/catalogue/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
          END LOOP;
          IF jsonb_typeof(el -> 'code') IS DISTINCT FROM 'string' THEN errs := errs || public.reg_err_item('/catalogue/' || i || '/code', 'required', 'The code is required.'); END IF;
          IF jsonb_typeof(el -> 'label_en') IS DISTINCT FROM 'string' OR char_length(btrim(el ->> 'label_en')) NOT BETWEEN 1 AND 60 THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/label_en', 'invalid', 'A label of 1 to 60 characters.');
          END IF;
          IF el ? 'label_ar' AND jsonb_typeof(el -> 'label_ar') NOT IN ('string', 'null') OR char_length(coalesce(el ->> 'label_ar', '')) > 60 THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/label_ar', 'invalid', 'A label of at most 60 characters.');
          END IF;
          IF el ? 'group' AND jsonb_typeof(el -> 'group') <> 'null' AND coalesce(el ->> 'group', '') NOT IN ('CW', 'TE') THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/group', 'invalid', 'CW, TE or null.');
          END IF;
          IF el ? 'groups' AND (jsonb_typeof(el -> 'groups') <> 'array' OR jsonb_array_length(el -> 'groups') > 2
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'groups') x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') NOT IN ('CW', 'TE'))) THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/groups', 'invalid', 'A list of the groups CW and TE.');
          END IF;
          IF el ? 'aliases' AND (jsonb_typeof(el -> 'aliases') <> 'array' OR jsonb_array_length(el -> 'aliases') > 20
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'aliases') x WHERE jsonb_typeof(x) <> 'string' OR char_length(btrim(x #>> '{}')) NOT BETWEEN 1 AND 60)) THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/aliases', 'invalid', 'At most 20 names of 1 to 60 characters.');
          END IF;
        END IF;
        i := i + 1;
      END LOOP;
    END IF;
  END IF;
  IF jsonb_typeof(p_config -> 'scopes') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/scopes', 'required', 'The list of scopes is required.');
  ELSIF jsonb_array_length(p_config -> 'scopes') > 60 THEN
    errs := errs || public.reg_err_item('/scopes', 'too_many', 'At most 60 scopes.');
  ELSE
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'scopes') LOOP
      IF jsonb_typeof(el) <> 'object' THEN
        errs := errs || public.reg_err_item('/scopes/' || i, 'invalid', 'A row is an object with scope, exempt and allowed.');
      ELSE
        FOR k IN SELECT jsonb_object_keys(el) LOOP
          IF k NOT IN ('scope', 'exempt', 'allowed', 'allowed_groups') THEN errs := errs || public.reg_err_item('/scopes/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
        END LOOP;
        sc := btrim(coalesce(el ->> 'scope', ''));
        IF jsonb_typeof(el -> 'scope') IS DISTINCT FROM 'string' OR char_length(sc) NOT BETWEEN 1 AND 60 THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/scope', 'invalid', 'A scope is a text of 1 to 60 characters.');
        ELSIF sc = ANY (seen_scopes) THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/scope', 'duplicate', 'This scope is listed twice.');
        ELSE seen_scopes := seen_scopes || sc; END IF;
        IF el ? 'exempt' AND jsonb_typeof(el -> 'exempt') <> 'boolean' THEN errs := errs || public.reg_err_item('/scopes/' || i || '/exempt', 'invalid', 'true or false.'); END IF;
        IF jsonb_typeof(el -> 'allowed') IS DISTINCT FROM 'array' THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed', 'required', 'The allowed specializations are required (an empty list allows none).');
        ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'allowed') x WHERE jsonb_typeof(x) <> 'string') THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed', 'invalid', 'A list of specialization codes.');
        END IF;
        IF el ? 'allowed_groups' AND (jsonb_typeof(el -> 'allowed_groups') <> 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'allowed_groups') x WHERE coalesce(x #>> '{}', '') NOT IN ('CW', 'TE'))) THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed_groups', 'invalid', 'A list of the groups CW and TE.');
        END IF;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.team_scope_match_json();
  SELECT jsonb_agg(jsonb_build_array(t.code, t.label_en, t.label_ar, t.is_active) ORDER BY t.code) INTO labels_before FROM public.team_specializations t;

  -- the columns: resolve, create the new codes, order them, deactivate the codes that are not listed
  i := 0; n := (SELECT coalesce(max(sort_order), 0) FROM public.team_specializations);
  FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'specializations') LOOP
    nm := btrim(el #>> '{}');
    cd := public.team_spec_resolve(nm, true);
    IF cd IS NULL THEN
      cd := left(nullif(btrim(regexp_replace(upper(nm), '[^A-Z0-9]+', '_', 'g'), '_'), ''), 30);
      IF cd IS NULL OR cd !~ '^[A-Z]' OR EXISTS (SELECT 1 FROM public.team_specializations t WHERE t.code = cd) THEN n := n + 1; cd := 'SPEC_' || n; END IF;
      INSERT INTO public.team_specializations (code, label_en, sort_order) VALUES (cd, nm, 0);
    END IF;
    IF cd = ANY (codes) THEN
      errs := errs || public.reg_err_item('/specializations/' || i, 'duplicate', 'This specialization is listed twice.');
    ELSE codes := codes || cd; END IF;
    i := i + 1;
  END LOOP;
  UPDATE public.team_specializations t SET is_active = (t.code = ANY (codes)),
    sort_order = coalesce(array_position(codes, t.code) * 10, 1000 + t.sort_order % 1000);

  -- labels, group and aliases of the listed codes
  IF p_config ? 'catalogue' THEN
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'catalogue') LOOP
      cd := upper(btrim(el ->> 'code'));
      IF NOT EXISTS (SELECT 1 FROM public.team_specializations t WHERE t.code = cd) THEN
        errs := errs || public.reg_err_item('/catalogue/' || i || '/code', 'not_a_column', 'Not a code of the specializations (add it to the list first).');
      ELSE
        UPDATE public.team_specializations t SET label_en = btrim(el ->> 'label_en'),
          label_ar = CASE WHEN el ? 'label_ar' THEN nullif(btrim(coalesce(el ->> 'label_ar', '')), '') ELSE t.label_ar END,
          func_groups = CASE WHEN el ? 'groups' THEN (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[]) FROM jsonb_array_elements_text(el -> 'groups') x)
                             WHEN el ? 'group' THEN CASE WHEN el ->> 'group' IS NULL THEN ARRAY[]::text[] ELSE ARRAY[el ->> 'group'] END
                             ELSE t.func_groups END,
          aliases = CASE WHEN el ? 'aliases' THEN (SELECT coalesce(array_agg(DISTINCT btrim(x)), ARRAY[]::text[]) FROM jsonb_array_elements_text(el -> 'aliases') x) ELSE t.aliases END
        WHERE t.code = cd;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  -- one name means one code (codes, labels and aliases of all codes, active or not)
  FOR nm IN
    SELECT x.tok FROM (SELECT t.code, public.p4b_norm(v) AS tok FROM public.team_specializations t
                       CROSS JOIN LATERAL unnest(ARRAY[t.code, t.label_en, t.label_ar] || t.aliases) AS v WHERE public.p4b_norm(v) <> '') x
    GROUP BY x.tok HAVING count(DISTINCT x.code) > 1
  LOOP
    errs := errs || public.reg_err_item('/catalogue', 'name_clash', 'The name "' || nm || '" belongs to more than one specialization.');
  END LOOP;

  -- the rows
  DELETE FROM public.team_scope_match_scopes;   -- the cells and the groups go with their scope (ON DELETE CASCADE)
  i := 0;
  FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'scopes') LOOP
    sc := btrim(el ->> 'scope');
    allowed := ARRAY[]::text[];
    j := 0;
    FOR a IN SELECT * FROM jsonb_array_elements(el -> 'allowed') LOOP
      cd := public.team_spec_resolve(a #>> '{}');
      IF cd IS NULL OR NOT (cd = ANY (codes)) THEN
        errs := errs || public.reg_err_item('/scopes/' || i || '/allowed/' || j, 'unknown_specialization', 'Not one of the listed specializations.');
      ELSE allowed := allowed || cd; END IF;
      j := j + 1;
    END LOOP;
    grps := CASE WHEN el ? 'allowed_groups' THEN ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(el -> 'allowed_groups') x) ELSE ARRAY[]::text[] END;
    INSERT INTO public.team_scope_match_scopes (scope, exempt, sort_order) VALUES (sc, coalesce((el ->> 'exempt')::boolean, false), (i + 1) * 10);
    INSERT INTO public.team_scope_match (scope, specialization, allowed) SELECT sc, c, c = ANY (allowed) FROM unnest(codes) c;
    INSERT INTO public.team_scope_match_groups (scope, func_group) SELECT sc, g FROM unnest(grps) g;
    i := i + 1;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  UPDATE public.team_scope_match_meta SET specializations = codes, version = version + 1, updated_by = public.app_actor(), updated_at = now() WHERE id;
  after := public.team_scope_match_json();
  -- Q147: a change that affects eligibility needs a fresh step-up of the session (labels alone do not)
  IF public.team_scope_match_rules(before) IS DISTINCT FROM public.team_scope_match_rules(after) AND NOT public.log_actor_stepped_up() THEN
    PERFORM public.wf_err('step_up_required', '{}'::jsonb);
  END IF;
  -- the list of the Contractors team field follows the active labels (when it is still a plain list of texts)
  SELECT jsonb_agg(jsonb_build_array(t.code, t.label_en, t.label_ar, t.is_active) ORDER BY t.code) INTO labels_after FROM public.team_specializations t;
  IF labels_after IS DISTINCT FROM labels_before THEN
    UPDATE public.register_fields f SET options = (SELECT jsonb_agg(t.label_en ORDER BY t.sort_order, t.code) FROM public.team_specializations t WHERE t.is_active)
    WHERE f.register_key = 'contractors' AND f.code = 'specialization' AND f.field_type = 'list' AND (f.options IS NULL OR jsonb_typeof(f.options) = 'array');
  END IF;
  PERFORM public.team_spec_sync_list();   -- Q292: the TeamSpecialization list mirrors the table
  PERFORM public.log_audit_write('team_scope_match_update', 'setting', 'team_scope_match', before - 'updated_at' - 'updated_by', after - 'updated_at' - 'updated_by', p_reason);
  RETURN after;
END $$;

-- The check (Q97, Q143, Q144): a scope that allows a group accepts every active specialization of it, whichever groups it has.
CREATE OR REPLACE FUNCTION team_scope_problem(p_scope text, p_team uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sc public.team_scope_match_scopes%ROWTYPE; tname text; legacy text; codes text[]; labels text;
BEGIN
  IF p_team IS NULL OR p_scope IS NULL THEN RETURN NULL; END IF;
  SELECT t.name, nullif(btrim(coalesce(t.specialization, '')), '') INTO tname, legacy FROM public.external_teams t WHERE t.id = p_team;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- an unknown team is refused by reg_clean_data (unknown_team)
  SELECT * INTO sc FROM public.team_scope_match_scopes WHERE scope = p_scope;
  codes := public.team_spec_codes(p_team);
  labels := public.team_spec_labels(codes);
  IF sc.scope IS NULL THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', labels,
      'message', 'The scope ' || p_scope || ' is not in the team / scope match table (Settings), so no team can take it. Ask the System Admin to add it.');
  END IF;
  IF cardinality(codes) = 0 THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', legacy,
      'message', 'The team ' || coalesce(tname, '?') || CASE WHEN legacy IS NULL THEN ' has no specialization'
        ELSE ' has no specialization of the catalogue (' || legacy || ' is not one)' END || ', so it cannot be matched to the scope ' || p_scope || '. Set it in the Contractors register.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_scope_match c WHERE c.scope = p_scope AND c.allowed AND c.specialization = ANY (codes))
     AND NOT EXISTS (SELECT 1 FROM public.team_scope_match_groups g JOIN public.team_specializations t ON g.func_group = ANY (t.func_groups) AND t.is_active
                     WHERE g.scope = p_scope AND t.code = ANY (codes)) THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', labels,
      'message', 'A ' || labels || ' team (' || coalesce(tname, '?') || ') cannot take a ' || p_scope || ' order (Settings, team / scope match).');
  END IF;
  RETURN NULL;
END $$;

-- The list TeamSpecialization follows the table. A value is found by its list_code (the code it was first given: the label of the specialization,
-- else the table code); its label, Arabic label, aliases, groups, order and activity are the table's. A value that belongs to no specialization
-- (the old text CW) stays inactive. Returns how many values changed. Idempotent: nothing is written when nothing differs.
CREATE OR REPLACE FUNCTION team_spec_sync_list() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.team_specializations%ROWTYPE; lc text; changed integer := 0; n integer;
BEGIN
  -- every specialization gets the code of its value once (the label, else the table code when the label is not a usable list code or is taken)
  FOR s IN SELECT * FROM public.team_specializations WHERE list_code IS NULL ORDER BY sort_order, code LOOP
    lc := CASE WHEN s.label_en ~ '[[:cntrl:];]' THEN s.code ELSE s.label_en END;
    IF EXISTS (SELECT 1 FROM public.team_specializations o WHERE o.list_code = lc AND o.code <> s.code) THEN lc := s.code; END IF;
    UPDATE public.team_specializations SET list_code = lc WHERE code = s.code;
  END LOOP;
  -- nothing differs: no write at all (a write to list_values regenerates the templates, which is not cheap)
  IF NOT EXISTS (
       SELECT 1 FROM public.team_specializations t
       LEFT JOIN public.list_values v ON v.catalogue_code = 'TeamSpecialization' AND v.code = t.list_code
       WHERE v.id IS NULL
          OR (v.label_en, v.label_ar, v.aliases, v.groups, v.sort_order, v.is_active) IS DISTINCT FROM (t.label_en, t.label_ar, t.aliases, t.func_groups, t.sort_order, t.is_active))
     AND NOT EXISTS (
       SELECT 1 FROM public.list_values v
       WHERE v.catalogue_code = 'TeamSpecialization' AND v.is_active AND NOT EXISTS (SELECT 1 FROM public.team_specializations x WHERE x.list_code = v.code))
  THEN
    RETURN 0;
  END IF;
  PERFORM set_config('pmis.team_spec_sync', 'on', true);
  INSERT INTO public.list_values (catalogue_code, code, label_en, label_ar, aliases, groups, sort_order, is_active)
  SELECT 'TeamSpecialization', t.list_code, t.label_en, t.label_ar, t.aliases, t.func_groups, t.sort_order, t.is_active
  FROM public.team_specializations t ORDER BY t.sort_order, t.code
  ON CONFLICT (catalogue_code, code) DO UPDATE SET label_en = EXCLUDED.label_en, label_ar = EXCLUDED.label_ar, aliases = EXCLUDED.aliases,
    groups = EXCLUDED.groups, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, version = list_values.version + 1, updated_at = now()
  WHERE (list_values.label_en, list_values.label_ar, list_values.aliases, list_values.groups, list_values.sort_order, list_values.is_active)
    IS DISTINCT FROM (EXCLUDED.label_en, EXCLUDED.label_ar, EXCLUDED.aliases, EXCLUDED.groups, EXCLUDED.sort_order, EXCLUDED.is_active);
  GET DIAGNOSTICS n = ROW_COUNT;
  changed := n;
  IF EXISTS (SELECT 1 FROM public.list_values v WHERE v.catalogue_code = 'TeamSpecialization' AND v.is_active
             AND NOT EXISTS (SELECT 1 FROM public.team_specializations x WHERE x.list_code = v.code)) THEN
    UPDATE public.list_values v SET is_active = false, version = v.version + 1, updated_at = now()
    WHERE v.catalogue_code = 'TeamSpecialization' AND v.is_active AND NOT EXISTS (SELECT 1 FROM public.team_specializations x WHERE x.list_code = v.code);
    GET DIAGNOSTICS n = ROW_COUNT;
    changed := changed + n;
  END IF;
  IF changed > 0 THEN
    UPDATE public.list_catalogues SET version = version + 1, updated_at = now() WHERE code = 'TeamSpecialization';
    PERFORM public.list_refresh_fields('TeamSpecialization');
  END IF;
  PERFORM set_config('pmis.team_spec_sync', '', true);
  RETURN changed;
END $$;

CREATE OR REPLACE FUNCTION team_spec_sync_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN PERFORM public.team_spec_sync_list(); END IF;
  RETURN NULL;
END $$;

-- Nothing writes the values of the mirrored list except the sync (a writer with the right still cannot edit it on its own).
CREATE OR REPLACE FUNCTION list_values_team_spec_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.catalogue_code = 'TeamSpecialization' AND coalesce(current_setting('pmis.team_spec_sync', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the values of the list TeamSpecialization come from the team specializations of Settings (team specialization / scope match) and are never edited on their own'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

SELECT team_spec_sync_list();

CREATE TRIGGER list_values_team_spec_guard BEFORE INSERT OR UPDATE ON list_values FOR EACH ROW EXECUTE FUNCTION list_values_team_spec_guard();
CREATE TRIGGER team_specializations_sync AFTER INSERT OR UPDATE OF code, label_en, label_ar, func_groups, aliases, is_active, sort_order ON team_specializations
  FOR EACH STATEMENT EXECUTE FUNCTION team_spec_sync_trigger();

-- The list writer of 0057, with one change: the list TeamSpecialization is refused (422 managed_elsewhere).
CREATE OR REPLACE FUNCTION admin_save_list_value(p_catalogue text, p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cat public.list_catalogues%ROWTYPE; v public.list_values%ROWTYPE; old_v public.list_values%ROWTYPE; k text; t text; errs jsonb := '[]'::jsonb; actor uuid := public.app_actor();
  tokens text[]; v_aliases text[]; v_groups text[];
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO cat FROM public.list_catalogues WHERE code = p_catalogue FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The list does not exist.')); END IF;
  -- Q292: the values of TeamSpecialization come from the table of Settings, team specialization / scope match (team_specializations): never edited here
  IF cat.code = 'TeamSpecialization' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object(
      'detail', 'The team specializations are managed in Settings, Team specialization / scope match. This list mirrors that table, so its values cannot be edited here.',
      'errors', public.reg_err_item('/', 'managed_elsewhere', 'The team specializations are managed in Settings, Team specialization / scope match; this list mirrors that table and is never edited on its own.')));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('code', 'label_en', 'label_ar', 'aliases', 'groups', 'sort_order', 'is_active') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.'); END IF;
  END LOOP;
  IF p_id IS NOT NULL AND p_patch ? 'code' THEN errs := errs || public.reg_err_item('/code', 'field_read_only', 'The code of a value never changes: deactivate it and add a new value.'); END IF;
  IF p_id IS NULL AND (p_patch ->> 'code' IS NULL OR char_length(p_patch ->> 'code') NOT BETWEEN 1 AND 80 OR p_patch ->> 'code' <> btrim(p_patch ->> 'code') OR p_patch ->> 'code' ~ '[[:cntrl:];]') THEN
    errs := errs || public.reg_err_item('/code', 'invalid', 'A code of 1 to 80 characters, without outer spaces or ";".');
  END IF;
  IF p_patch ? 'label_en' AND char_length(btrim(coalesce(p_patch ->> 'label_en', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || public.reg_err_item('/label_en', 'invalid', 'A label of 1 to 200 characters.'); END IF;
  IF p_patch ? 'aliases' AND (jsonb_typeof(p_patch -> 'aliases') <> 'array' OR jsonb_array_length(p_patch -> 'aliases') > 20
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'aliases') a WHERE jsonb_typeof(a) <> 'string' OR char_length(btrim(a #>> '{}')) NOT BETWEEN 1 AND 80)) THEN
    errs := errs || public.reg_err_item('/aliases', 'invalid', 'Up to 20 texts of 1 to 80 characters.');
  END IF;
  IF p_patch ? 'groups' AND (jsonb_typeof(p_patch -> 'groups') <> 'array' OR jsonb_array_length(p_patch -> 'groups') > 10
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'groups') a WHERE jsonb_typeof(a) <> 'string' OR (a #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_ -]{0,30}$')) THEN
    errs := errs || public.reg_err_item('/groups', 'invalid', 'Up to 10 group codes (letters, digits, space, - and _).');
  END IF;
  IF p_patch ? 'sort_order' AND (jsonb_typeof(p_patch -> 'sort_order') <> 'number' OR (p_patch ->> 'sort_order')::numeric NOT BETWEEN 0 AND 100000) THEN errs := errs || public.reg_err_item('/sort_order', 'invalid', 'A whole number from 0 to 100000.'); END IF;
  IF p_patch ? 'is_active' AND jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN errs := errs || public.reg_err_item('/is_active', 'invalid', 'true or false.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_patch ? 'aliases' THEN SELECT coalesce(array_agg(DISTINCT btrim(a)), ARRAY[]::text[]) INTO v_aliases FROM jsonb_array_elements_text(p_patch -> 'aliases') a; END IF;
  IF p_patch ? 'groups' THEN SELECT coalesce(array_agg(DISTINCT a ORDER BY a), ARRAY[]::text[]) INTO v_groups FROM jsonb_array_elements_text(p_patch -> 'groups') a; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.list_values (catalogue_code, code, label_en, label_ar, aliases, groups, sort_order, is_active, updated_by)
    VALUES (cat.code, p_patch ->> 'code', coalesce(btrim(p_patch ->> 'label_en'), p_patch ->> 'code'), nullif(btrim(p_patch ->> 'label_ar'), ''), coalesce(v_aliases, ARRAY[]::text[]),
            coalesce(v_groups, ARRAY[]::text[]), coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(x.sort_order), 0) + 10 FROM public.list_values x WHERE x.catalogue_code = cat.code)),
            coalesce((p_patch ->> 'is_active')::boolean, true), actor)
    ON CONFLICT (catalogue_code, code) DO NOTHING
    RETURNING * INTO v;
    IF v.id IS NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This list has a value with this code already.')); END IF;
  ELSE
    SELECT * INTO old_v FROM public.list_values WHERE id = p_id AND catalogue_code = cat.code FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The value does not exist in this list.')); END IF;
    IF p_version IS NOT NULL AND p_version <> old_v.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The value changed since you read it. Reload and try again.')); END IF;
    IF p_patch = '{}'::jsonb THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'required', 'Change at least one field.'))); END IF;
    -- a critical list never loses its last active value (that would block every approval of the registers that use it)
    IF cat.critical AND old_v.is_active AND (p_patch ->> 'is_active') = 'false'
       AND NOT EXISTS (SELECT 1 FROM public.list_values x WHERE x.catalogue_code = cat.code AND x.is_active AND x.id <> old_v.id) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'last_active_value', 'A critical list keeps at least one active value.')));
    END IF;
    UPDATE public.list_values SET
      label_en = coalesce(btrim(p_patch ->> 'label_en'), label_en),
      label_ar = CASE WHEN p_patch ? 'label_ar' THEN nullif(btrim(p_patch ->> 'label_ar'), '') ELSE label_ar END,
      aliases = coalesce(v_aliases, list_values.aliases),
      groups = coalesce(v_groups, list_values.groups),
      sort_order = coalesce((p_patch ->> 'sort_order')::int, sort_order),
      is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
      version = version + 1, updated_at = now(), updated_by = actor
    WHERE id = p_id RETURNING * INTO v;
  END IF;

  -- a code, a label or an alias names one value only (ignoring case), so a typed text never means two values
  tokens := ARRAY[lower(v.code), lower(v.label_en)] || CASE WHEN v.label_ar IS NOT NULL THEN ARRAY[lower(v.label_ar)] ELSE ARRAY[]::text[] END
            || (SELECT coalesce(array_agg(lower(a)), ARRAY[]::text[]) FROM unnest(v.aliases) a);
  FOREACH t IN ARRAY tokens LOOP
    IF EXISTS (SELECT 1 FROM public.list_values x WHERE x.catalogue_code = cat.code AND x.id <> v.id
               AND (lower(x.code) = t OR lower(x.label_en) = t OR lower(coalesce(x.label_ar, '')) = t OR EXISTS (SELECT 1 FROM unnest(x.aliases) a WHERE lower(a) = t))) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(CASE WHEN p_patch ? 'aliases' THEN '/aliases' ELSE '/label_en' END, 'duplicate',
        'Another value of this list already uses "' || t || '" as its code, label or alias.')));
    END IF;
  END LOOP;

  PERFORM public.list_refresh_fields(cat.code);
  UPDATE public.list_catalogues SET version = version + 1, updated_at = now(), updated_by = actor WHERE code = cat.code;
  PERFORM public.log_audit_write(CASE WHEN p_id IS NULL THEN 'list_value_create' WHEN old_v.is_active AND NOT v.is_active THEN 'list_value_deactivate' ELSE 'list_value_update' END,
    'list_catalogue', cat.code || ':' || v.code, CASE WHEN p_id IS NULL THEN NULL ELSE public.list_value_json(old_v) END, public.list_value_json(v), p_reason);
  RETURN jsonb_build_object('id', v.id, 'version', v.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['assignment_rows_overlap(uuid,uuid)', 'assignment_overlap_check()', 'assignment_overlaps_log()', 'team_spec_sync_list()',
    'team_spec_sync_trigger()', 'list_values_team_spec_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- none of them is granted to pmis_app: the trigger functions run inside the writers, the report is run by an operator
END $$;
