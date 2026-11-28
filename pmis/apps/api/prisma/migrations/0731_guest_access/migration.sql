-- 0731: guest access, part of the security section (section 3 of the PM-platforms proposal; owner approval "implement fully" 2026-11-28).
--
-- WHY. A System Admin sometimes needs to let an outside person (a client, an auditor, a visiting manager) look at chosen parts of the project for a limited
-- time, without giving them an employee account. A guest is a local account that can only VIEW the regions and modules the admin chose, never writes, never
-- exports or downloads, and stops working at an end date. It is OFF until a System Admin turns it on in Settings > Security > Guest access.
--
-- NO NEW PERMISSION ENGINE. A guest is an ordinary user with one ordinary assignment: the seeded role GUEST, level view, the seeded profile guest_view
-- (the view action only, on the allow-listed modules), the chosen regions and modules, and valid_to = the end date. What this migration adds are the limits:
--   1. The setting security.guest_access = {"enabled": false, "max_days": 30, "default_days": 7}, guarded by settings_guarded_keys like 0291.
--   2. The table guest_accounts (one row per guest: end date, note, who created, who ended). Written only by the doors below.
--   3. The role GUEST and the profile guest_view (view on the allow-listed modules; no create, edit, delete, approve, export, import, download or audit).
--   4. Guard triggers that keep a guest a guest: the assignment of a guest can only be the role GUEST at level view with an end date that is not later than
--      the guest's end date, only the guest_view profile, only allow-listed modules, never all regions or all modules; the role GUEST can only be held by a
--      guest; guest_view can never gain an action other than view or a module outside the list; a guest cannot be the target of a delegation or a member of a
--      group (the System Admins group included).
--   5. guest_access_state() (read door, System Admin only), admin_set_guest_access(...), guest_access_list(), admin_create_guest(...),
--      admin_extend_guest(...), admin_end_guest(...) (the write doors: System Admin only, reason, audit rows with before and after), and
--      guest_session_state(p_user) (what the session guard needs: is this user a guest, and until when).
--   6. The table is a KEEP row in data_reset_plan() (patched in place) with the grants of pmis_reset_owner.
-- Nothing is deleted, no existing permission or default changes, and existing users and sessions are untouched.
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC, owned by pmis_definer.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON users, roles, permission_profiles TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('security.guest_access', '{"enabled": false, "max_days": 30, "default_days": 7}'::jsonb,
        'Guest access (0731): off by default. A guest is a view-only account with an end date. Changed only through admin_set_guest_access.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_guest_access ON settings;
DROP TRIGGER IF EXISTS b_settings_guest_access_update ON settings;
DROP TRIGGER IF EXISTS b_settings_guest_access_delete ON settings;
CREATE TRIGGER b_settings_guest_access BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'security.guest_access') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_guest_access_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.guest_access' OR NEW.key = 'security.guest_access') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_guest_access_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.guest_access') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE guest_accounts (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  note text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid REFERENCES users (id),
  end_reason text
);
COMMENT ON TABLE guest_accounts IS '0731: one row per guest account (a view-only user with an end date). Written only by admin_create_guest, admin_extend_guest and admin_end_guest; rows are never deleted.';
REVOKE ALL ON guest_accounts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON guest_accounts TO pmis_definer;

CREATE OR REPLACE FUNCTION guest_accounts_guarded() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.app_in_admin_path() THEN
    RAISE EXCEPTION 'permission denied: guest accounts change only through their audited functions (migration 0731)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a guest account row is never deleted (end it instead)' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_guest_accounts_guarded BEFORE INSERT OR UPDATE OR DELETE ON guest_accounts FOR EACH ROW EXECUTE FUNCTION guest_accounts_guarded();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Config, allow-list, role and profile
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guest_access_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; mx int := 30; df int := 7; en boolean := false;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'security.guest_access';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  IF jsonb_typeof(v -> 'enabled') = 'boolean' THEN en := (v ->> 'enabled')::boolean; END IF;
  IF jsonb_typeof(v -> 'max_days') = 'number' AND (v ->> 'max_days') ~ '^[0-9]+$' AND (v ->> 'max_days')::int BETWEEN 1 AND 365 THEN mx := (v ->> 'max_days')::int; END IF;
  IF jsonb_typeof(v -> 'default_days') = 'number' AND (v ->> 'default_days') ~ '^[0-9]+$' AND (v ->> 'default_days')::int BETWEEN 1 AND mx THEN df := (v ->> 'default_days')::int; END IF;
  IF df > mx THEN df := mx; END IF;
  RETURN jsonb_build_object('enabled', en, 'max_days', mx, 'default_days', df);
END $$;

-- The modules a guest may ever view: the project data, never people, messages, approvals, settings, security, logs or templates.
CREATE OR REPLACE FUNCTION guest_access_modules() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY['sites', 'dashboard', 'reports', 'procurement', 'contractors', 'rf_design', 'acquisition', 'gecol', 'hlc', 'permits_hse', 'warehouse', 'quality',
               'issues', 'risks', 'change_control', 'readiness', 'as_built', 'meetings']::text[];
$$;

INSERT INTO permission_profiles (code, name_en, name_ar, description, reason)
VALUES ('guest_view', 'Guest (view only)', 'ضيف (عرض فقط)',
        'The view action on the modules a guest may see. Fixed by the database (migration 0731): no other action and no other module can be added.', 'seed')
ON CONFLICT (code) DO NOTHING;
INSERT INTO permission_grants (profile_id, module_key, action)
SELECT p.id, m, 'view'::"PermissionAction" FROM permission_profiles p, unnest(public.guest_access_modules()) m WHERE p.code = 'guest_view'
ON CONFLICT DO NOTHING;

INSERT INTO roles (code, name_en, name_ar, description_en, description_ar, team, default_profile_id, default_all_regions, default_all_modules, can_hold_matrix_levels, sort)
SELECT 'GUEST', 'Guest', 'ضيف', 'A view-only outside person with an end date (Settings > Security > Guest access). Held only by guest accounts.',
       'شخص من خارج الفريق يطلع على ما يحدده المدير فقط وبتاريخ انتهاء (الإعدادات > الأمان > وصول الضيوف). لا يحمله إلا حساب ضيف.',
       'none'::"TeamKind", (SELECT id FROM permission_profiles WHERE code = 'guest_view'), false, false, false, 990
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Guard triggers: a guest stays a guest
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON user_role_assignments TO pmis_definer;

CREATE OR REPLACE FUNCTION guest_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g public.guest_accounts%ROWTYPE; code text;
BEGIN
  SELECT r.code INTO code FROM public.roles r WHERE r.id = NEW.role_id;
  SELECT * INTO g FROM public.guest_accounts WHERE user_id = NEW.user_id;
  IF code = 'GUEST' AND g.user_id IS NULL THEN
    RAISE EXCEPTION 'the role GUEST can only be held by a guest account (Settings > Security > Guest access)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF g.user_id IS NOT NULL THEN
    IF code IS DISTINCT FROM 'GUEST' OR NEW.permission_level <> 'view' OR NEW.all_regions OR NEW.all_modules OR NEW.team <> 'none'
       OR NEW.valid_to IS NULL OR NEW.valid_to > g.expires_at THEN
      RAISE EXCEPTION 'a guest holds only the role GUEST at level view, for chosen regions and modules, ending no later than the guest end date' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_guest_assignment_guard ON user_role_assignments;
CREATE TRIGGER b_guest_assignment_guard BEFORE INSERT OR UPDATE ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION guest_assignment_guard();

CREATE OR REPLACE FUNCTION guest_assignment_child_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid;
BEGIN
  SELECT a.user_id INTO uid FROM public.user_role_assignments a WHERE a.id = NEW.assignment_id;
  IF uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.guest_accounts g WHERE g.user_id = uid) THEN
    IF TG_TABLE_NAME = 'user_role_assignment_modules' AND NOT ((to_jsonb(NEW) ->> 'module_key') = ANY (public.guest_access_modules())) THEN
      RAISE EXCEPTION 'a guest may see only the guest modules, not %', to_jsonb(NEW) ->> 'module_key' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_TABLE_NAME = 'user_role_assignment_profiles' AND NOT EXISTS (SELECT 1 FROM public.permission_profiles p WHERE p.id::text = (to_jsonb(NEW) ->> 'profile_id') AND p.code = 'guest_view') THEN
      RAISE EXCEPTION 'a guest holds only the guest_view profile' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_guest_modules_guard ON user_role_assignment_modules;
DROP TRIGGER IF EXISTS b_guest_profiles_guard ON user_role_assignment_profiles;
CREATE TRIGGER b_guest_modules_guard BEFORE INSERT OR UPDATE ON user_role_assignment_modules FOR EACH ROW EXECUTE FUNCTION guest_assignment_child_guard();
CREATE TRIGGER b_guest_profiles_guard BEFORE INSERT OR UPDATE ON user_role_assignment_profiles FOR EACH ROW EXECUTE FUNCTION guest_assignment_child_guard();

CREATE OR REPLACE FUNCTION guest_profile_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.permission_profiles p WHERE p.id = NEW.profile_id AND p.code = 'guest_view')
     AND (NEW.action <> 'view' OR NOT (NEW.module_key = ANY (public.guest_access_modules()))) THEN
    RAISE EXCEPTION 'the guest_view profile holds only the view action on the guest modules' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_guest_profile_guard ON permission_grants;
CREATE TRIGGER b_guest_profile_guard BEFORE INSERT OR UPDATE ON permission_grants FOR EACH ROW EXECUTE FUNCTION guest_profile_guard();

CREATE OR REPLACE FUNCTION guest_target_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid;
BEGIN
  IF TG_TABLE_NAME = 'delegations' THEN uid := NEW.target_user_id; ELSE uid := NEW.user_id; END IF;
  IF uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.guest_accounts g WHERE g.user_id = uid) THEN
    RAISE EXCEPTION 'a guest account cannot receive a delegation or join a group' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_guest_delegation_guard ON delegations;
DROP TRIGGER IF EXISTS b_guest_group_guard ON group_members;
CREATE TRIGGER b_guest_delegation_guard BEFORE INSERT OR UPDATE ON delegations FOR EACH ROW EXECUTE FUNCTION guest_target_guard();
CREATE TRIGGER b_guest_group_guard BEFORE INSERT OR UPDATE ON group_members FOR EACH ROW EXECUTE FUNCTION guest_target_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Doors
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guest_access_require_admin() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin manages guest access.'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guest_access_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.guest_access_cfg();
BEGIN
  PERFORM public.guest_access_require_admin();
  SELECT * INTO s FROM public.settings WHERE key = 'security.guest_access';
  RETURN jsonb_build_object('enabled', c -> 'enabled', 'max_days', c -> 'max_days', 'default_days', c -> 'default_days',
    'modules', to_jsonb(public.guest_access_modules()),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('security.guest_access'), 'can_edit', true);
END $$;

CREATE OR REPLACE FUNCTION admin_set_guest_access(p_enabled boolean, p_max_days integer, p_default_days integer, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  PERFORM public.guest_access_require_admin();
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wfe_err1('/enabled', 'required', 'Say whether guest access is on.'); END IF;
  IF p_max_days IS NULL OR p_max_days NOT BETWEEN 1 AND 365 THEN PERFORM public.wfe_err1('/max_days', 'invalid', 'max_days is 1 to 365.'); END IF;
  IF p_default_days IS NULL OR p_default_days NOT BETWEEN 1 AND p_max_days THEN PERFORM public.wfe_err1('/default_days', 'invalid', 'default_days is 1 to max_days.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('security.guest_access', '{"enabled": false, "max_days": 30, "default_days": 7}'::jsonb,
          'Guest access (0731): off by default. A guest is a view-only account with an end date. Changed only through admin_set_guest_access.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'security.guest_access' FOR UPDATE;
  cur := public.guest_access_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled AND (cur ->> 'max_days')::int = p_max_days AND (cur ->> 'default_days')::int = p_default_days THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the guest access settings in force.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled, 'max_days', p_max_days, 'default_days', p_default_days),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'security.guest_access';
  res := public.guest_access_state();
  PERFORM public.log_audit_write('guest_access_update', 'setting', 'security.guest_access',
    jsonb_build_object('enabled', cur -> 'enabled', 'max_days', cur -> 'max_days', 'default_days', cur -> 'default_days'),
    jsonb_build_object('enabled', res -> 'enabled', 'max_days', res -> 'max_days', 'default_days', res -> 'default_days'), btrim(p_reason));
  RETURN res;
END $$;

-- One guest as the API shows it: the user, the end date, the state and the scope of the one assignment.
CREATE OR REPLACE FUNCTION guest_access_row(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('user_id', g.user_id, 'display_name', u.display_name, 'email', u.email, 'note', g.note, 'expires_at', g.expires_at,
    'created_at', g.created_at, 'created_by', coalesce(public.wfe_user_ref(g.created_by), 'null'::jsonb), 'ended_at', g.ended_at, 'end_reason', g.end_reason,
    'state', CASE WHEN g.ended_at IS NOT NULL THEN 'ended' WHEN g.expires_at <= now() THEN 'expired' ELSE 'active' END,
    'regions', coalesce((SELECT jsonb_agg(DISTINCT r.region_id ORDER BY r.region_id) FROM public.user_role_assignments a
                         JOIN public.user_role_assignment_regions r ON r.assignment_id = a.id WHERE a.user_id = g.user_id), '[]'::jsonb),
    'modules', coalesce((SELECT jsonb_agg(DISTINCT m.module_key ORDER BY m.module_key) FROM public.user_role_assignments a
                         JOIN public.user_role_assignment_modules m ON m.assignment_id = a.id WHERE a.user_id = g.user_id), '[]'::jsonb))
  FROM public.guest_accounts g JOIN public.users u ON u.id = g.user_id WHERE g.user_id = p_user
$$;

CREATE OR REPLACE FUNCTION guest_access_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.guest_access_require_admin();
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(public.guest_access_row(x.user_id) ORDER BY x.created_at DESC, x.user_id::text)
                                               FROM (SELECT g.user_id, g.created_at FROM public.guest_accounts g ORDER BY g.created_at DESC, g.user_id::text LIMIT 200) x), '[]'::jsonb));
END $$;

-- Makes the user a guest. The account was just created through idm_create_local_user in the same transaction (no assignment yet).
CREATE OR REPLACE FUNCTION admin_create_guest(p_user uuid, p_expires_at timestamptz, p_regions int[], p_modules text[], p_note text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); c jsonb; prof uuid; role_id uuid; res jsonb;
BEGIN
  PERFORM public.guest_access_require_admin();
  PERFORM public.calc_require_reason(p_reason);
  c := public.guest_access_cfg();
  IF NOT (c ->> 'enabled')::boolean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Guest access is switched off (Settings > Security > Guest access).'));
  END IF;
  IF p_user IS NULL OR p_user = a OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND u.status IN ('active', 'pending_assignment')) THEN
    PERFORM public.wfe_err1('/user_id', 'invalid', 'Name a new user other than yourself.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.guest_accounts WHERE user_id = p_user)
     OR EXISTS (SELECT 1 FROM public.user_role_assignments x WHERE x.user_id = p_user)
     OR public.app_user_is_system_admin(p_user)
     OR EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.user_id = p_user) THEN
    PERFORM public.wfe_err1('/user_id', 'invalid', 'The user must be a new account with no roles and no groups.');
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() + interval '1 hour' OR p_expires_at > now() + make_interval(days => (c ->> 'max_days')::int) THEN
    PERFORM public.wfe_err1('/expires_at', 'invalid', 'The end date is at least one hour away and at most max_days from now.');
  END IF;
  IF p_regions IS NULL OR coalesce(array_length(p_regions, 1), 0) = 0 OR EXISTS (SELECT 1 FROM unnest(p_regions) r WHERE NOT EXISTS (SELECT 1 FROM public.regions g WHERE g.id = r)) THEN
    PERFORM public.wfe_err1('/regions', 'invalid', 'Choose at least one existing region.');
  END IF;
  IF p_modules IS NULL OR coalesce(array_length(p_modules, 1), 0) = 0 OR EXISTS (SELECT 1 FROM unnest(p_modules) m WHERE NOT (m = ANY (public.guest_access_modules()))) THEN
    PERFORM public.wfe_err1('/modules', 'not_allowed', 'Choose at least one module from the guest list.');
  END IF;
  SELECT id INTO prof FROM public.permission_profiles WHERE code = 'guest_view' AND is_active;
  SELECT id INTO role_id FROM public.roles WHERE code = 'GUEST' AND is_active;
  IF prof IS NULL OR role_id IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The GUEST role or the guest_view profile is missing or inactive.')); END IF;
  INSERT INTO public.guest_accounts (user_id, expires_at, note, created_by) VALUES (p_user, p_expires_at, nullif(btrim(p_note), ''), a);
  PERFORM public.idm_assign(p_user, role_id, 'view'::"PermissionLevel", 'none'::"TeamKind", now(), p_expires_at, true, false, p_regions, false, p_modules, ARRAY[prof], '[guest] ' || btrim(p_reason));
  PERFORM public.idm_set_user_status(p_user, 'active'::"UserStatus", '[guest] ' || btrim(p_reason));
  res := public.guest_access_row(p_user);
  PERFORM public.log_audit_write('guest_created', 'user', p_user::text, NULL,
    jsonb_build_object('expires_at', p_expires_at, 'regions', p_regions, 'modules', p_modules, 'note', nullif(btrim(p_note), '')), btrim(p_reason));
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION admin_extend_guest(p_user uuid, p_expires_at timestamptz, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; g public.guest_accounts%ROWTYPE; res jsonb;
BEGIN
  PERFORM public.guest_access_require_admin();
  PERFORM public.calc_require_reason(p_reason);
  c := public.guest_access_cfg();
  SELECT * INTO g FROM public.guest_accounts WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  IF g.ended_at IS NOT NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'An ended guest account is not reopened. Create a new one.')); END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() + interval '1 hour' OR p_expires_at > now() + make_interval(days => (c ->> 'max_days')::int) THEN
    PERFORM public.wfe_err1('/expires_at', 'invalid', 'The end date is at least one hour away and at most max_days from now.');
  END IF;
  IF p_expires_at = g.expires_at THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'That is already the end date.')); END IF;
  -- the guest row first, then the assignment (the guard checks the assignment end against the guest row)
  UPDATE public.guest_accounts SET expires_at = p_expires_at WHERE user_id = p_user;
  PERFORM public.idm_update_assignment((SELECT x.id FROM public.user_role_assignments x WHERE x.user_id = p_user), NULL, NULL, p_expires_at, NULL, NULL, NULL, NULL, NULL, '[guest] ' || btrim(p_reason));
  res := public.guest_access_row(p_user);
  PERFORM public.log_audit_write('guest_extended', 'user', p_user::text, jsonb_build_object('expires_at', g.expires_at), jsonb_build_object('expires_at', p_expires_at), btrim(p_reason));
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION admin_end_guest(p_user uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g public.guest_accounts%ROWTYPE; res jsonb;
BEGIN
  PERFORM public.guest_access_require_admin();
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO g FROM public.guest_accounts WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  IF g.ended_at IS NOT NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The guest account is already ended.')); END IF;
  UPDATE public.guest_accounts SET ended_at = now(), ended_by = public.app_actor(), end_reason = btrim(p_reason) WHERE user_id = p_user;
  PERFORM public.idm_end_assignment(x.id, '[guest] ' || btrim(p_reason)) FROM public.user_role_assignments x WHERE x.user_id = p_user AND (x.valid_to IS NULL OR x.valid_to > now());
  res := public.guest_access_row(p_user);
  PERFORM public.log_audit_write('guest_ended', 'user', p_user::text, jsonb_build_object('expires_at', g.expires_at), jsonb_build_object('ended', true), btrim(p_reason));
  RETURN res;
END $$;

-- For the session guard: is this signed-in user a guest, and until when. Reads only the caller's own row; no actor needed.
CREATE OR REPLACE FUNCTION guest_session_state(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('expires_at', g.expires_at, 'ended', g.ended_at IS NOT NULL) FROM public.guest_accounts g WHERE g.user_id = p_user
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Data reset: KEEP (it belongs to the users, which are kept)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE def text; marker text := '''ui_assets'', ';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('guest_accounts' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no ui_assets row to patch'; END IF;
    EXECUTE replace(def, marker, marker || '''guest_accounts'', ');
  END IF;
END $$;
GRANT SELECT, UPDATE ON public.guest_accounts TO pmis_reset_owner;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['guest_accounts_guarded()', 'guest_access_cfg()', 'guest_access_modules()', 'guest_assignment_guard()', 'guest_assignment_child_guard()',
      'guest_profile_guard()', 'guest_target_guard()', 'guest_access_require_admin()', 'guest_access_state()', 'admin_set_guest_access(boolean,integer,integer,text,integer)',
      'guest_access_row(uuid)', 'guest_access_list()', 'admin_create_guest(uuid,timestamptz,integer[],text[],text,text)', 'admin_extend_guest(uuid,timestamptz,text)',
      'admin_end_guest(uuid,text)', 'guest_session_state(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- admin_create_guest (owned by pmis_definer) hands the new account its role through the existing identity doors.
  GRANT EXECUTE ON FUNCTION idm_assign(uuid, uuid, "PermissionLevel", "TeamKind", timestamptz, timestamptz, boolean, boolean, integer[], boolean, text[], uuid[], text) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION idm_set_user_status(uuid, "UserStatus", text) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION idm_update_assignment(uuid, "PermissionLevel", "TeamKind", timestamptz, boolean, integer[], boolean, text[], uuid[], text) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION idm_end_assignment(uuid, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION guest_access_state(), admin_set_guest_access(boolean, integer, integer, text, integer), guest_access_list(),
      admin_create_guest(uuid, timestamptz, integer[], text[], text, text), admin_extend_guest(uuid, timestamptz, text), admin_end_guest(uuid, text),
      guest_session_state(uuid) TO pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('guest_access_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'security.guest_access', 'enabled', false, 'max_days', 30, 'default_days', 7, 'table', 'guest_accounts', 'role', 'GUEST', 'profile', 'guest_view',
          'read', jsonb_build_array('guest_access_state', 'guest_access_list'), 'write', jsonb_build_array('admin_set_guest_access', 'admin_create_guest', 'admin_extend_guest', 'admin_end_guest'),
          'audit', jsonb_build_array('guest_access_update', 'guest_created', 'guest_extended', 'guest_ended')),
        'Guest access (migration 0731): a view-only account with an end date, off by default.');
