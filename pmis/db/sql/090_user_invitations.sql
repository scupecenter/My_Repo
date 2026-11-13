-- 0091: invite a new user by email, with role and properties chosen at invite time (owner decision 2026-11-12, decision 5; CHANGELOG 133).
-- Mirror: db/sql/090_user_invitations.sql (kept identical to prisma/migrations/0091_user_invitations/migration.sql).
--
-- WHAT. An admin (System Admin or a delegate holding users.create for all regions) invites a person by email and chooses, at that moment, what the account
-- will hold: role assignments (permission level, team, regions, modules, profiles, validity), department, direct manager, groups and whether two-factor is
-- enforced. The person opens the mailed link, chooses a password that follows the policy, and the account is created in one step with everything chosen.
--
-- WHERE THE SECRET LIVES. The API makes a random token (32 bytes) and sends the link by mail. The database stores only the SHA-256 of the token
-- (user_invitations.token_hash). The hash is cleared when the invitation is accepted, revoked or has expired, so a used link matches nothing. pmis_app has no
-- table right on user_invitations: it reaches it only through the inv_* functions below (SECURITY DEFINER, owner pmis_identity_owner).
--
-- THE RIGHTS RULE. Inviting is a grant of rights, so the same ceilings as idm_assign, idm_set_user_org and idm_group_add_member apply, checked for the person
-- who invites at the moment of the invitation (and again when somebody resends it): users.create (all regions) for the invitation itself; assignments.create
-- for any role row, with the post-state ceiling of idm_assert_assignment_within_actor (no admin level, no privileged role, only the regions, modules, profiles
-- and end date the inviter holds); users.edit (all regions) for a manager or a department; groups.edit (all regions) for groups, never the admin group or a
-- delegation target for a delegate; users.administer for enforcing two-factor. Nobody can invite with wider rights than their own.
--
-- TWO-FACTOR. An invitation never carries an enrolment code and never lets a password alone enrol a phone: when two-factor is enforced for the invited person,
-- the account is created with two-factor on, enforced and not enrolled, and an admin issues the one-time enrolment code afterwards
-- (POST /users/{id}/two-factor/enrol-code), handed over in person or by phone, exactly as for any other user.
--
-- WHEN THE LINK IS USED. inv_accept has no signed-in actor (the person has no account yet). It checks again that the invitation is pending and not expired,
-- that the person who sent it is still an active user (and still a System Admin when the invitation grants admin-level rights, privileged roles or groups),
-- that the email, employee ID and phone are still free, then creates the user, the local credentials (the person's own password, no forced change), the
-- assignments, the organisation fields, the group memberships and the two-factor row in one statement, and writes the audit rows. A role, department,
-- manager or group that is no longer valid is skipped and the audit row lists what was skipped (never more rights than chosen).

-- ---------------------------------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE user_invitations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  display_name       TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  employee_id        TEXT CHECK (employee_id IS NULL OR employee_id ~ '^[0-9]{4}$'),
  phone              TEXT CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  assignments        JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assignments) = 'array'),
  department_id      UUID REFERENCES departments(id) ON UPDATE CASCADE,
  manager_id         UUID REFERENCES users(id) ON UPDATE CASCADE,
  group_ids          UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  require_two_factor BOOLEAN NOT NULL DEFAULT false,
  elevated           BOOLEAN NOT NULL DEFAULT false,   -- grants admin-level rights, a privileged role or a privileged group: only a System Admin may stand behind it
  token_hash         CHAR(64) UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at         TIMESTAMPTZ(6) NOT NULL,
  reason             TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
  invited_by         UUID NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  sent_by            UUID NOT NULL REFERENCES users(id) ON UPDATE CASCADE,   -- whoever created or last resent it: the rights are checked against this person
  send_count         INTEGER NOT NULL DEFAULT 1 CHECK (send_count >= 1),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_sent_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  accepted_at        TIMESTAMPTZ(6),
  accepted_user_id   UUID REFERENCES users(id) ON UPDATE CASCADE,
  revoked_at         TIMESTAMPTZ(6),
  revoked_by         UUID REFERENCES users(id) ON UPDATE CASCADE,
  revoke_reason      TEXT,
  CONSTRAINT user_invitations_pending_has_token CHECK (status <> 'pending' OR token_hash IS NOT NULL),
  CONSTRAINT user_invitations_closed_has_no_token CHECK (status = 'pending' OR token_hash IS NULL),
  CONSTRAINT user_invitations_accepted_pair CHECK ((status = 'accepted') = (accepted_user_id IS NOT NULL AND accepted_at IS NOT NULL))
);
-- One open invitation per email, employee ID and phone (a closed one frees them).
CREATE UNIQUE INDEX user_invitations_pending_email ON user_invitations (email) WHERE status = 'pending';
CREATE UNIQUE INDEX user_invitations_pending_employee_id ON user_invitations (employee_id) WHERE status = 'pending' AND employee_id IS NOT NULL;
CREATE UNIQUE INDEX user_invitations_pending_phone ON user_invitations (phone) WHERE status = 'pending' AND phone IS NOT NULL;
CREATE INDEX user_invitations_listing ON user_invitations (created_at DESC, id DESC);

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;   -- no policy: only the owner of the inv_* functions (BYPASSRLS) reads or writes it

GRANT SELECT, INSERT, UPDATE ON user_invitations TO pmis_identity_owner;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON user_invitations FROM pmis_app;
  END IF;
END $$;

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('invitations.expiry_hours', '72', 'Hours an invitation link stays valid after it is sent or resent (1 to 720).', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- Helpers (internal: not granted to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inv_hours() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT greatest(1, least(720, coalesce(
    (SELECT CASE WHEN jsonb_typeof(s.value) = 'number' THEN round((s.value #>> '{}')::numeric)::int END
       FROM public.settings s WHERE s.key = 'invitations.expiry_hours'), 72)))
$$;

-- Pending invitations whose time has come become expired, and their token stops matching.
CREATE OR REPLACE FUNCTION inv_expire_due() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.user_invitations SET status = 'expired', token_hash = NULL WHERE status = 'pending' AND expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- The ceiling of idm_assert_assignment_within_actor, for one chosen row (jsonb) instead of a stored assignment.
-- Row: role_id, permission_level, team, all_regions, region_ids, all_modules, module_keys, profile_ids, valid_from, valid_to.
CREATE OR REPLACE FUNCTION inv_assert_row_within_actor(p_row jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rf int[]; e timestamptz; r int; m text; pr uuid; actor uuid := public.app_actor(); v_role uuid := (p_row->>'role_id')::uuid;
        v_all_regions boolean := coalesce((p_row->>'all_regions')::boolean, false); v_all_modules boolean := coalesce((p_row->>'all_modules')::boolean, false);
        v_regions int[] := coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_row->'region_ids', '[]'::jsonb))::int), ARRAY[]::int[]);
        v_modules text[] := coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_row->'module_keys', '[]'::jsonb))), ARRAY[]::text[]);
        v_profiles uuid[] := coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_row->'profile_ids', '[]'::jsonb))::uuid), ARRAY[]::uuid[]);
        v_to timestamptz := nullif(p_row->>'valid_to', '')::timestamptz;
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  IF p_row->>'permission_level' = 'admin' THEN RAISE EXCEPTION 'only a System Admin can hold or grant admin level' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF public.idm_role_privileged(v_role) THEN RAISE EXCEPTION 'this role carries delegations or wider rights: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  rf := public.app_actor_region_filter('assignments', 'create');
  IF rf IS NOT NULL THEN
    IF v_all_regions THEN RAISE EXCEPTION 'resulting assignment has all regions: wider than your delegated regions' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF cardinality(v_regions) = 0 THEN RAISE EXCEPTION 'a regional delegate must name at least one region' USING ERRCODE = 'insufficient_privilege'; END IF;
    FOREACH r IN ARRAY v_regions LOOP
      IF NOT (r = ANY (rf)) THEN RAISE EXCEPTION 'region % is outside your delegated regions', r USING ERRCODE = 'insufficient_privilege'; END IF;
    END LOOP;
  END IF;
  IF v_all_modules AND NOT public.idm_actor_all_modules() THEN RAISE EXCEPTION 'resulting assignment has all modules: you do not hold all modules' USING ERRCODE = 'insufficient_privilege'; END IF;
  FOREACH m IN ARRAY v_modules LOOP
    IF NOT public.app_has_permission(actor, m, 'view') THEN RAISE EXCEPTION 'module % is outside your own scope', m USING ERRCODE = 'insufficient_privilege'; END IF;
  END LOOP;
  FOREACH pr IN ARRAY v_profiles LOOP
    IF NOT public.idm_profile_within_actor(pr) THEN RAISE EXCEPTION 'profile % is wider than your own rights', pr USING ERRCODE = 'insufficient_privilege'; END IF;
  END LOOP;
  e := public.app_actor_delegation_end('assignments', 'create');
  IF e IS NOT NULL AND e <> 'infinity' AND (v_to IS NULL OR v_to > e) THEN
    RAISE EXCEPTION 'resulting end date is beyond your own delegation (ends %)', e USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Everything an invitation chooses, checked against the rights of the signed-in actor. Returns true when it is "elevated" (admin level, a privileged role or a
-- privileged group), which needs the actor's fresh step-up (the API asks for it through inv_elevated before it writes).
CREATE OR REPLACE FUNCTION inv_check_payload(p_assignments jsonb, p_groups uuid[], p_manager uuid, p_department uuid, p_two_factor boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; g uuid; v_role uuid; elevated boolean := false; v_level text; v_team text; rg int;
BEGIN
  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN RAISE EXCEPTION 'assignments: must be a list'; END IF;
  IF jsonb_array_length(p_assignments) > 20 THEN RAISE EXCEPTION 'assignments: at most 20 rows'; END IF;
  IF cardinality(coalesce(p_groups, ARRAY[]::uuid[])) > 50 THEN RAISE EXCEPTION 'groups: at most 50'; END IF;
  IF jsonb_array_length(p_assignments) > 0 THEN PERFORM public.idm_actor('assignments', 'create'); END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
    v_role := (r->>'role_id')::uuid;
    v_level := r->>'permission_level'; v_team := coalesce(r->>'team', 'none');
    IF v_level IS NULL OR v_level NOT IN ('view', 'entry', 'review', 'approve', 'admin') THEN RAISE EXCEPTION 'assignments: unknown permission level'; END IF;
    IF v_team NOT IN ('cw', 'te', 'both', 'none') THEN RAISE EXCEPTION 'assignments: unknown team'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = v_role AND is_active) THEN RAISE EXCEPTION 'role not found or inactive'; END IF;
    FOR rg IN SELECT jsonb_array_elements_text(coalesce(r->'region_ids', '[]'::jsonb))::int LOOP
      IF NOT EXISTS (SELECT 1 FROM public.regions WHERE id = rg) THEN RAISE EXCEPTION 'assignments: unknown region %', rg; END IF;
    END LOOP;
    IF nullif(r->>'valid_to', '') IS NOT NULL AND coalesce(nullif(r->>'valid_from', '')::timestamptz, now()) >= (r->>'valid_to')::timestamptz THEN
      RAISE EXCEPTION 'assignments: the end date must be after the start date';
    END IF;
    PERFORM public.inv_assert_row_within_actor(r);
    IF v_level = 'admin' OR public.idm_role_privileged(v_role) THEN elevated := true; END IF;
  END LOOP;
  IF p_manager IS NOT NULL OR p_department IS NOT NULL THEN
    PERFORM public.idm_actor('users', 'edit');
    PERFORM public.idm_need_global('users', 'edit');
    IF p_manager IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_manager AND status = 'active' AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'the manager must be an active user';
    END IF;
    IF p_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department AND is_active) THEN
      RAISE EXCEPTION 'the department must exist and be active';
    END IF;
  END IF;
  IF cardinality(coalesce(p_groups, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.idm_actor('groups', 'edit');
    PERFORM public.idm_need_global('groups', 'edit');
    FOREACH g IN ARRAY p_groups LOOP
      IF NOT EXISTS (SELECT 1 FROM public.groups WHERE id = g AND is_active) THEN RAISE EXCEPTION 'group not found or inactive'; END IF;
      PERFORM public.idm_assert_group_within_actor(g);
      IF public.idm_group_privileged(g) THEN elevated := true; END IF;
    END LOOP;
  END IF;
  IF coalesce(p_two_factor, false) THEN
    PERFORM public.idm_actor('users', 'administer');
    PERFORM public.idm_need_global('users', 'administer');
  END IF;
  RETURN elevated;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin functions (the signed-in actor is checked inside every one)
-- ---------------------------------------------------------------------------------------------------------------------
-- Would this invitation need a step-up? Called by the API before inv_create, so the step-up can be demanded first. Raises the same refusals as inv_create.
CREATE OR REPLACE FUNCTION inv_elevated(p_assignments jsonb, p_groups uuid[], p_manager uuid, p_department uuid, p_two_factor boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.idm_actor('users', 'create');
  PERFORM public.idm_need_global('users', 'create');
  RETURN public.inv_check_payload(p_assignments, p_groups, p_manager, p_department, p_two_factor);
END $$;

CREATE OR REPLACE FUNCTION inv_create(p_email text, p_display text, p_employee_id text, p_phone text, p_assignments jsonb, p_department uuid, p_manager uuid,
  p_groups uuid[], p_two_factor boolean, p_token_hash text, p_reason text) RETURNS TABLE (r_id uuid, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'create'); em text := lower(btrim(coalesce(p_email, ''))); elevated boolean; iid uuid; exp timestamptz;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'create');
  IF em = '' OR coalesce(btrim(p_display), '') = '' THEN RAISE EXCEPTION 'name and email are required'; END IF;
  IF p_employee_id IS NOT NULL AND p_employee_id !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'employee id is 4 digits'; END IF;
  PERFORM public.inv_expire_due();
  IF EXISTS (SELECT 1 FROM public.users WHERE email = em) THEN RAISE EXCEPTION 'email: already used by another account' USING ERRCODE = 'unique_violation'; END IF;
  IF p_employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE trim(employee_id) = p_employee_id) THEN
    RAISE EXCEPTION 'employee_id: already used by another account' USING ERRCODE = 'unique_violation';
  END IF;
  IF nullif(btrim(p_phone), '') IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE phone = btrim(p_phone)) THEN
    RAISE EXCEPTION 'phone: already used by another account' USING ERRCODE = 'unique_violation';
  END IF;
  elevated := public.inv_check_payload(p_assignments, coalesce(p_groups, ARRAY[]::uuid[]), p_manager, p_department, p_two_factor);
  exp := now() + make_interval(hours => public.inv_hours());
  INSERT INTO public.user_invitations (email, display_name, employee_id, phone, assignments, department_id, manager_id, group_ids, require_two_factor, elevated,
    token_hash, status, expires_at, reason, invited_by, sent_by)
  VALUES (em, btrim(p_display), p_employee_id, nullif(btrim(p_phone), ''), p_assignments, p_department, p_manager, coalesce(p_groups, ARRAY[]::uuid[]),
    coalesce(p_two_factor, false), elevated, p_token_hash, 'pending', exp, btrim(p_reason), a, a)
  RETURNING id INTO iid;
  PERFORM public.idm_audit('user_invited', 'user_invitation', iid::text, NULL,
    jsonb_build_object('email', em, 'display_name', btrim(p_display), 'employee_id', p_employee_id, 'phone', nullif(btrim(p_phone), ''), 'assignments', p_assignments,
      'department_id', p_department, 'manager_id', p_manager, 'group_ids', coalesce(p_groups, ARRAY[]::uuid[]), 'require_two_factor', coalesce(p_two_factor, false),
      'elevated', elevated, 'expires_at', exp), p_reason);
  r_id := iid; r_expires := exp; RETURN NEXT;
END $$;

-- A new link: the old one stops working. The rights are checked again against the person who resends (an invitation never outlives the rights behind it).
CREATE OR REPLACE FUNCTION inv_resend(p_id uuid, p_token_hash text, p_reason text) RETURNS TABLE (r_expires timestamptz, r_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'create'); i public.user_invitations%ROWTYPE; v_elevated boolean; exp timestamptz;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'create');
  PERFORM public.inv_expire_due();
  SELECT * INTO i FROM public.user_invitations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found'; END IF;
  IF i.status = 'expired' THEN
    -- an expired invitation may be sent again: it becomes pending again, if its email and identifiers are still free
    IF EXISTS (SELECT 1 FROM public.users WHERE email = i.email)
       OR (i.employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE trim(employee_id) = i.employee_id))
       OR (i.phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE phone = i.phone)) THEN
      RAISE EXCEPTION 'email: already used by another account' USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF i.status <> 'pending' THEN
    RAISE EXCEPTION 'this invitation is not pending';
  END IF;
  v_elevated := public.inv_check_payload(i.assignments, i.group_ids, i.manager_id, i.department_id, i.require_two_factor);
  exp := now() + make_interval(hours => public.inv_hours());
  UPDATE public.user_invitations SET status = 'pending', token_hash = p_token_hash, expires_at = exp, sent_by = a, elevated = v_elevated, send_count = send_count + 1,
    last_sent_at = now() WHERE id = p_id;
  PERFORM public.idm_audit('user_invitation_resent', 'user_invitation', p_id::text, jsonb_build_object('status', i.status, 'expires_at', i.expires_at),
    jsonb_build_object('status', 'pending', 'expires_at', exp, 'send_count', i.send_count + 1), p_reason);
  r_expires := exp; r_email := i.email; RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION inv_revoke(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'create'); i public.user_invitations%ROWTYPE;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'create');
  PERFORM public.inv_expire_due();
  SELECT * INTO i FROM public.user_invitations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found'; END IF;
  IF i.status <> 'pending' THEN RAISE EXCEPTION 'this invitation is not pending'; END IF;
  UPDATE public.user_invitations SET status = 'revoked', token_hash = NULL, revoked_at = now(), revoked_by = a, revoke_reason = btrim(p_reason) WHERE id = p_id;
  PERFORM public.idm_audit('user_invitation_revoked', 'user_invitation', p_id::text, jsonb_build_object('status', i.status), jsonb_build_object('status', 'revoked'), p_reason);
END $$;

-- The list (and one invitation when p_id is given). The status is the effective one: a pending invitation past its time reads as expired.
CREATE OR REPLACE FUNCTION inv_read(p_id uuid, p_status text, p_q text, p_after_ts timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (id uuid, email text, display_name text, employee_id text, phone text, status text, expires_at timestamptz, created_at timestamptz, invited_by uuid,
  invited_by_name text, sent_by uuid, last_sent_at timestamptz, send_count integer, require_two_factor boolean, elevated boolean, reason text, department_id uuid,
  department_name text, manager_id uuid, manager_name text, groups jsonb, assignments jsonb, accepted_at timestamptz, accepted_user_id uuid, revoked_at timestamptz,
  revoke_reason text, total bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.idm_actor('users', 'create');
  PERFORM public.idm_need_global('users', 'create');
  RETURN QUERY
  WITH f AS (
    SELECT i.*, CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS eff
      FROM public.user_invitations i
     WHERE (p_id IS NULL OR i.id = p_id)
       AND (p_q IS NULL OR i.email ILIKE p_q ESCAPE '\' OR i.display_name ILIKE p_q ESCAPE '\')
  ), g AS (SELECT * FROM f WHERE p_status IS NULL OR f.eff = p_status), t AS (SELECT count(*) AS n FROM g)
  SELECT g.id, g.email, g.display_name, g.employee_id, g.phone, g.eff, g.expires_at, g.created_at, g.invited_by, ib.display_name, g.sent_by, g.last_sent_at, g.send_count,
         g.require_two_factor, g.elevated, g.reason, g.department_id, dp.name_en, g.manager_id, mg.display_name,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', gr.id, 'name', gr.name) ORDER BY gr.name), '[]'::jsonb) FROM public.groups gr WHERE gr.id = ANY (g.group_ids)),
         (SELECT coalesce(jsonb_agg(x.e || jsonb_build_object('role', jsonb_build_object('id', r.id, 'code', r.code, 'name_en', r.name_en, 'name_ar', r.name_ar)) ORDER BY x.ord), '[]'::jsonb)
            FROM jsonb_array_elements(g.assignments) WITH ORDINALITY x(e, ord) LEFT JOIN public.roles r ON r.id = (x.e->>'role_id')::uuid),
         g.accepted_at, g.accepted_user_id, g.revoked_at, g.revoke_reason, t.n
    FROM g CROSS JOIN t
    JOIN public.users ib ON ib.id = g.invited_by
    LEFT JOIN public.users mg ON mg.id = g.manager_id
    LEFT JOIN public.departments dp ON dp.id = g.department_id
   WHERE p_after_ts IS NULL OR (g.created_at, g.id) < (p_after_ts, p_after_id)
   ORDER BY g.created_at DESC, g.id DESC
   LIMIT greatest(1, least(coalesce(p_limit, 51), 201));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Public functions (no signed-in actor: the person has no account yet). The only key is the token hash.
-- ---------------------------------------------------------------------------------------------------------------------
-- What the accept page shows, and what the API needs for the password policy. No row for a token that is unknown, used, revoked or expired.
CREATE OR REPLACE FUNCTION inv_peek(p_hash text) RETURNS TABLE (r_display text, r_email text, r_employee_id text, r_phone text, r_expires timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.display_name, i.email, i.employee_id, i.phone, i.expires_at
    FROM public.user_invitations i
   WHERE p_hash IS NOT NULL AND i.token_hash = p_hash AND i.status = 'pending' AND i.expires_at > now()
$$;

-- Accepts the invitation: creates the user with everything chosen, in this one call. r_status: ok, invalid (nothing matches, uniform) or conflict (an identifier was
-- taken meanwhile). Nothing is created unless the answer is ok.
CREATE OR REPLACE FUNCTION inv_accept(p_hash text, p_password_hash text) RETURNS TABLE (r_status text, r_user uuid, r_two_factor boolean, r_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.user_invitations%ROWTYPE; uid uuid; r jsonb; aid uuid; n int := 0; skipped jsonb := '[]'::jsonb; g uuid; mgr uuid; dept uuid; sender_ok boolean; st public."UserStatus";
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    r_status := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO i FROM public.user_invitations WHERE token_hash = p_hash FOR UPDATE;
  IF NOT FOUND OR i.status <> 'pending' THEN r_status := 'invalid'; RETURN NEXT; RETURN; END IF;
  IF i.expires_at <= now() THEN
    UPDATE public.user_invitations SET status = 'expired', token_hash = NULL WHERE id = i.id;
    r_status := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  -- the person who sent it must still stand behind it
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = i.sent_by AND u.status = 'active' AND u.deleted_at IS NULL) INTO sender_ok;
  IF sender_ok AND i.elevated AND NOT public.app_user_is_system_admin(i.sent_by) THEN sender_ok := false; END IF;
  IF NOT sender_ok THEN
    UPDATE public.user_invitations SET status = 'revoked', token_hash = NULL, revoked_at = now(), revoke_reason = 'the sender no longer holds the rights behind this invitation' WHERE id = i.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('user_invitation_revoked', 'user_invitation', i.id::text, jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'revoked'), 'the sender no longer holds the rights behind this invitation', i.sent_by);
    r_status := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = i.email)
     OR (i.employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE trim(employee_id) = i.employee_id))
     OR (i.phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE phone = i.phone)) THEN
    UPDATE public.user_invitations SET status = 'revoked', token_hash = NULL, revoked_at = now(), revoke_reason = 'the email, employee ID or phone is now used by another account' WHERE id = i.id;
    r_status := 'conflict'; RETURN NEXT; RETURN;
  END IF;

  mgr := CASE WHEN i.manager_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE id = i.manager_id AND status = 'active' AND deleted_at IS NULL) THEN i.manager_id END;
  IF i.manager_id IS NOT NULL AND mgr IS NULL THEN skipped := skipped || jsonb_build_array(jsonb_build_object('kind', 'manager', 'id', i.manager_id)); END IF;
  dept := CASE WHEN i.department_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.departments WHERE id = i.department_id AND is_active) THEN i.department_id END;
  IF i.department_id IS NOT NULL AND dept IS NULL THEN skipped := skipped || jsonb_build_array(jsonb_build_object('kind', 'department', 'id', i.department_id)); END IF;

  INSERT INTO public.users (email, display_name, employee_id, phone, status, manager_id, department_id, updated_at)
  VALUES (i.email, i.display_name, i.employee_id, i.phone, 'pending_assignment', mgr, dept, now()) RETURNING id INTO uid;
  INSERT INTO public.local_credentials (user_id, password_hash, must_change, set_by) VALUES (uid, p_password_hash, false, i.sent_by);

  FOR r IN SELECT * FROM jsonb_array_elements(i.assignments) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = (r->>'role_id')::uuid AND is_active) THEN
      skipped := skipped || jsonb_build_array(jsonb_build_object('kind', 'role', 'id', r->>'role_id')); CONTINUE;
    END IF;
    INSERT INTO public.user_role_assignments (user_id, role_id, permission_level, team, valid_from, valid_to, is_primary, all_regions, all_modules, assigned_by)
    VALUES (uid, (r->>'role_id')::uuid, (r->>'permission_level')::"PermissionLevel", coalesce(r->>'team', 'none')::"TeamKind",
            coalesce(nullif(r->>'valid_from', '')::timestamptz, now()), nullif(r->>'valid_to', '')::timestamptz, n = 0,
            coalesce((r->>'all_regions')::boolean, false), coalesce((r->>'all_modules')::boolean, false), i.sent_by) RETURNING id INTO aid;
    INSERT INTO public.user_role_assignment_regions SELECT aid, x::int FROM jsonb_array_elements_text(coalesce(r->'region_ids', '[]'::jsonb)) x;
    INSERT INTO public.user_role_assignment_modules SELECT aid, x FROM jsonb_array_elements_text(coalesce(r->'module_keys', '[]'::jsonb)) x;
    INSERT INTO public.user_role_assignment_profiles SELECT aid, x::uuid FROM jsonb_array_elements_text(coalesce(r->'profile_ids', '[]'::jsonb)) x;
    n := n + 1;
  END LOOP;

  FOREACH g IN ARRAY i.group_ids LOOP
    IF EXISTS (SELECT 1 FROM public.groups WHERE id = g AND is_active)
       AND (NOT public.idm_group_privileged(g) OR public.app_user_is_system_admin(i.sent_by)) THEN
      INSERT INTO public.group_members (group_id, user_id) VALUES (g, uid) ON CONFLICT DO NOTHING;
    ELSE
      skipped := skipped || jsonb_build_array(jsonb_build_object('kind', 'group', 'id', g));
    END IF;
  END LOOP;

  IF i.require_two_factor THEN
    -- on, enforced, not enrolled and WITHOUT an enrolment code: an admin issues the code and hands it over in person or by phone (a password alone never enrols)
    INSERT INTO public.user_totp (user_id, required, enforced, set_by, set_at) VALUES (uid, true, true, i.sent_by, now());
  END IF;

  st := CASE WHEN n > 0 THEN 'active' ELSE 'pending_assignment' END;
  UPDATE public.users SET status = st, updated_at = now() WHERE id = uid;
  UPDATE public.user_invitations SET status = 'accepted', token_hash = NULL, accepted_at = now(), accepted_user_id = uid WHERE id = i.id;

  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
  VALUES ('user_invitation_accepted', 'user_invitation', i.id::text, jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'accepted', 'user_id', uid, 'assignments_created', n, 'skipped', skipped), 'the invited person accepted and chose a password', uid);
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
  VALUES ('user_created_by_invitation', 'user', uid::text,
    jsonb_build_object('email', i.email, 'display_name', i.display_name, 'employee_id', i.employee_id, 'phone', i.phone, 'status', st, 'invitation_id', i.id,
      'invited_by', i.invited_by, 'department_id', dept, 'manager_id', mgr, 'two_factor_enforced', i.require_two_factor), i.reason, uid);
  r_status := 'ok'; r_user := uid; r_two_factor := i.require_two_factor; r_email := i.email; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['inv_hours()', 'inv_expire_due()', 'inv_assert_row_within_actor(jsonb)', 'inv_check_payload(jsonb,uuid[],uuid,uuid,boolean)',
    'inv_elevated(jsonb,uuid[],uuid,uuid,boolean)', 'inv_create(text,text,text,text,jsonb,uuid,uuid,uuid[],boolean,text,text)', 'inv_resend(uuid,text,text)',
    'inv_revoke(uuid,text)', 'inv_read(uuid,text,text,timestamptz,uuid,integer)', 'inv_peek(text)', 'inv_accept(text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: inv_hours, inv_expire_due, inv_assert_row_within_actor and inv_check_payload (internal)
    FOREACH f IN ARRAY ARRAY['inv_elevated(jsonb,uuid[],uuid,uuid,boolean)', 'inv_create(text,text,text,text,jsonb,uuid,uuid,uuid[],boolean,text,text)',
      'inv_resend(uuid,text,text)', 'inv_revoke(uuid,text)', 'inv_read(uuid,text,text,timestamptz,uuid,integer)', 'inv_peek(text)', 'inv_accept(text,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
