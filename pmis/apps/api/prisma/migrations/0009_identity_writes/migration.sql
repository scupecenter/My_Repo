-- 008: identity writes, admin region transfer, configuration RLS (read for all, write by delegated permission).
--
-- Identity tables (users, user_role_assignments + regions/modules/profiles, groups, group_members, delegations + grants/regions,
-- roles + defaults, permission_profiles, permission_grants, field_permissions) are NOT writable by pmis_app: privileges are
-- revoked (idm_revoke_app_writes), a BEFORE trigger refuses every writer except pmis_identity_owner and the migration role,
-- and all writes go through idm_* SECURITY DEFINER functions owned by pmis_identity_owner. Each function re-derives, from
-- the tables, whether app.user_id is an active System Admin or holds an active delegation covering the action; refuses writes
-- where the actor is the beneficiary; protects the admin group (delegates cannot touch admins; at least one active admin
-- always remains); and writes an audit row. See the header of 003 for what this does and does not defend against.

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges and backstop triggers
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_role_assignments, user_role_assignment_regions, user_role_assignment_modules,
  user_role_assignment_profiles, groups, group_members, delegations, delegation_grants, delegation_regions, roles, role_default_regions,
  role_default_modules, permission_profiles, permission_grants, field_permissions TO pmis_identity_owner;
GRANT SELECT ON regions, field_definitions, work_calendars TO pmis_identity_owner;
GRANT INSERT ON audit_log TO pmis_identity_owner;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_identity_owner;

CREATE OR REPLACE FUNCTION idm_revoke_app_writes(p_app_role name DEFAULT 'pmis_app') RETURNS void
LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_app_role) THEN RETURN; END IF;
  FOREACH t IN ARRAY ARRAY['users','user_role_assignments','user_role_assignment_regions','user_role_assignment_modules',
    'user_role_assignment_profiles','groups','group_members','delegations','delegation_grants','delegation_regions','roles',
    'role_default_regions','role_default_modules','permission_profiles','permission_grants','field_permissions'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM %I', t, p_app_role);
  END LOOP;
  -- a user may keep their own sign-in bookkeeping and preferences (the backstop trigger limits users updates to these columns)
  EXECUTE format('GRANT UPDATE (last_login_at, locale, theme, updated_at) ON users TO %I', p_app_role);
END $$;
-- Run again after any blanket GRANT to the app role in a deployment script.

-- Generic backstop: only the identity owner (the idm_* functions) and the migration role may write identity tables.
CREATE OR REPLACE FUNCTION idm_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_identity_owner' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION '% is written only through idm_* functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_role_assignments','user_role_assignment_regions','user_role_assignment_modules','user_role_assignment_profiles',
    'groups','group_members','delegations','delegation_grants','delegation_regions','roles','role_default_regions','role_default_modules',
    'permission_profiles','permission_grants','field_permissions'] LOOP
    EXECUTE format('CREATE TRIGGER a_idm_backstop BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION idm_backstop()', t);
  END LOOP;
END $$;

-- users: insert and identity/status columns only through idm_*; self-service columns stay writable.
CREATE OR REPLACE FUNCTION idm_users_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_identity_owner' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'last_login_at' - 'locale' - 'theme' - 'updated_at') = (to_jsonb(OLD) - 'last_login_at' - 'locale' - 'theme' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'users identity columns are written only through idm_* functions' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER a_idm_backstop BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION idm_users_backstop();

-- Beneficiary backstops (apply to the owner path too; the migration role is exempt).
CREATE OR REPLACE FUNCTION idm_actor_holds_role(p_role uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_role_assignments a WHERE a.user_id = public.app_actor() AND a.role_id = p_role
                 AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
$$;
CREATE OR REPLACE FUNCTION idm_actor_uses_profile(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = a.id
                 WHERE a.user_id = public.app_actor() AND ap.profile_id = p_profile AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
      OR EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id
                 WHERE a.user_id = public.app_actor() AND r.default_profile_id = p_profile AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
$$;

CREATE OR REPLACE FUNCTION idm_beneficiary_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor uuid := app_actor();
BEGIN
  IF app_is_seeding() OR TG_OP = 'DELETE' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_TABLE_NAME = 'user_role_assignments' THEN
    IF NEW.user_id = actor THEN RAISE EXCEPTION 'you cannot assign roles to yourself' USING ERRCODE = 'insufficient_privilege'; END IF;
  ELSIF TG_TABLE_NAME = 'user_role_assignment_profiles' THEN
    IF EXISTS (SELECT 1 FROM user_role_assignments a WHERE a.id = NEW.assignment_id AND a.user_id = actor) THEN
      RAISE EXCEPTION 'you cannot give yourself a permission profile' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'group_members' THEN
    IF NEW.user_id = actor THEN RAISE EXCEPTION 'you cannot add yourself to a group' USING ERRCODE = 'insufficient_privilege'; END IF;
  ELSIF TG_TABLE_NAME = 'delegations' THEN
    IF NEW.from_user_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'a delegation is made in your own name' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF (NEW.target_kind = 'user' AND NEW.target_user_id = actor)
       OR (NEW.target_kind = 'role' AND idm_actor_holds_role(NEW.target_role_id))
       OR (NEW.target_kind = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = NEW.target_group_id AND gm.user_id = actor)) THEN
      RAISE EXCEPTION 'you cannot delegate to yourself' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'permission_grants' THEN
    IF idm_actor_uses_profile(NEW.profile_id) THEN RAISE EXCEPTION 'you cannot edit a profile that gives you rights' USING ERRCODE = 'insufficient_privilege'; END IF;
  ELSIF TG_TABLE_NAME = 'field_permissions' THEN
    IF (NEW.role_id IS NOT NULL AND idm_actor_holds_role(NEW.role_id)) OR (NEW.profile_id IS NOT NULL AND idm_actor_uses_profile(NEW.profile_id)) THEN
      RAISE EXCEPTION 'you cannot change field rules that apply to you' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_idm_beneficiary BEFORE INSERT OR UPDATE ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION idm_beneficiary_backstop();
CREATE TRIGGER b_idm_beneficiary BEFORE INSERT OR UPDATE ON user_role_assignment_profiles FOR EACH ROW EXECUTE FUNCTION idm_beneficiary_backstop();
CREATE TRIGGER b_idm_beneficiary BEFORE INSERT ON group_members FOR EACH ROW EXECUTE FUNCTION idm_beneficiary_backstop();
CREATE TRIGGER b_idm_beneficiary BEFORE INSERT ON delegations FOR EACH ROW EXECUTE FUNCTION idm_beneficiary_backstop();
CREATE TRIGGER b_idm_beneficiary BEFORE INSERT OR UPDATE ON permission_grants FOR EACH ROW EXECUTE FUNCTION idm_beneficiary_backstop();
CREATE TRIGGER b_idm_beneficiary BEFORE INSERT OR UPDATE ON field_permissions FOR EACH ROW EXECUTE FUNCTION idm_beneficiary_backstop();

-- At least one active System Admin must remain (checked at commit, only when the change touched an admin).
CREATE OR REPLACE FUNCTION idm_last_admin_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE touched boolean := false;
BEGIN
  IF app_is_seeding() THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'group_members' THEN
    touched := EXISTS (SELECT 1 FROM groups g WHERE g.id = OLD.group_id AND g.is_system_admins);
  ELSIF TG_TABLE_NAME = 'users' THEN
    touched := OLD.status = 'active' AND NEW.status <> 'active'
               AND EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins WHERE gm.user_id = OLD.id);
  ELSE -- groups
    touched := OLD.is_system_admins;
  END IF;
  IF touched AND NOT EXISTS (
       SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
       JOIN users u ON u.id = gm.user_id AND u.status = 'active') THEN
    RAISE EXCEPTION 'at least one active System Admin must remain' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER last_admin_members AFTER DELETE OR UPDATE ON group_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idm_last_admin_check();
CREATE CONSTRAINT TRIGGER last_admin_users AFTER UPDATE OF status ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idm_last_admin_check();
CREATE CONSTRAINT TRIGGER last_admin_groups AFTER UPDATE OR DELETE ON groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idm_last_admin_check();

ALTER TABLE delegations ADD CONSTRAINT delegations_one_target CHECK (
  (target_kind = 'user'  AND target_user_id  IS NOT NULL AND target_role_id IS NULL AND target_group_id IS NULL) OR
  (target_kind = 'role'  AND target_role_id  IS NOT NULL AND target_user_id IS NULL AND target_group_id IS NULL) OR
  (target_kind = 'group' AND target_group_id IS NOT NULL AND target_user_id IS NULL AND target_role_id  IS NULL));
ALTER TABLE delegations ADD CONSTRAINT delegations_range CHECK (valid_to IS NULL OR valid_to > valid_from);

-- ---------------------------------------------------------------------------------------------------------------------
-- idm_* functions (owner pmis_identity_owner)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_actor(p_module text, p_action "PermissionAction") RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_admin(p_module, p_action) THEN
    RAISE EXCEPTION 'System Admin or a delegation covering %.% required', p_module, p_action USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION idm_need_reason(p_reason text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF; END $$;

CREATE OR REPLACE FUNCTION idm_audit(p_action text, p_entity text, p_id text, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); obo uuid;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN
    SELECT d.from_user_id INTO obo FROM public.app_user_delegations(a) x(id) JOIN public.delegations d ON d.id = x.id LIMIT 1;
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, on_behalf_of, is_admin_override)
  VALUES (p_action, p_entity, p_id, p_before, p_after, p_reason, a, obo, true);
END $$;

-- A non-System-Admin actor may only hand out rights they hold themselves ("never wider than the delegate's own scope").
CREATE OR REPLACE FUNCTION idm_profile_within_actor(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_actor_is_system_admin() OR NOT EXISTS (
    SELECT 1 FROM public.permission_grants g WHERE g.profile_id = p_profile
      AND NOT public.app_has_permission(public.app_actor(), g.module_key, g.action))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The ceiling rule: a non-System-Admin actor never acts outside, or grants wider than, their own effective scope
-- (modules x actions x regions x end date). These helpers are used by every idm_* and admin_* function; System Admins are
-- exempt. Summary of the sweep (function -> ceiling applied):
--   idm_assign / idm_update_assignment : post-state idm_assert_assignment_within_actor (regions, all_regions, modules, all_modules, end date, level<>admin),
--                                        profiles within actor, role not privileged (idm_role_privileged); update/end also
--                                        require the existing assignment to lie in the actor's regions (idm_assignment_in_scope)
--   idm_end_assignment                 : existing assignment in the actor's regions
--   idm_group_add_member               : group not privileged (admin group or target of an effective delegation) + global scope
--   idm_group_remove_member / save     : global scope; admin group is System-Admin only
--   idm_set_user_status                : global scope; admins are System-Admin only
--   idm_delegate / idm_revoke_delegation: root delegations System-Admin only; re-delegation within parent grants/regions/end date
--   idm_profile_save / set_grants      : global scope; grants within actor's own permissions; profile not applied to the actor
--   idm_field_permission_set           : global scope; cannot unhide or raise access above the actor's own
--   idm_role_save / set_defaults / delete: global scope; default profile within actor; default_all_* only if held
--   admin_transfer_site_region         : old and new region both delegated
--   admin_add_task_to_open_sites, admin_migrate_sites_to_workflow, admin_workflow_migration_plan: sites restricted to delegated regions
--   admin_repoint_sla                  : every affected task in delegated regions
--   admin_create_workflow_draft        : global scope
--   config RLS (app_can)               : counts only rights held for all regions
--
-- Post-state rule (added in the third review round): for a non-System-Admin actor every idm_* write computes the RESULTING state
-- and checks it against the ceiling, inside the same function, so a failure rolls the change back:
--   idm_assert_assignment_within_actor (level, all_regions/modules, regions, modules, profiles, end date, role privilege)
--   idm_assert_group_within_actor, idm_assert_user_change_allowed, idm_assert_role_within_actor, idm_profile_within_actor.
-- Privilege tests (admin member, privileged group/role/user, delegation target) ignore every active/revoked/expiry flag, so a
-- dormant admin, group or delegation cannot be reactivated by a delegate. Sweep changes: idm_set_user_status (post-state user
-- check, privileged users by any status), idm_assign/idm_update_assignment (post-state; an ended assignment cannot get a new end
-- date), idm_group_save/add/remove (post-state, privileged groups System-Admin only), idm_field_permission_set (fails closed:
-- own access = field rule, else entity permission, else hidden; cannot loosen or remove a rule beyond own access),
-- idm_role_save / idm_profile_save / idm_profile_set_grants (post-state). admin_* functions only use region filters and global scope.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idm_need_global(p_module text, p_action "PermissionAction") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.app_actor_is_system_admin() AND public.app_actor_region_filter(p_module, p_action) IS NOT NULL THEN
    RAISE EXCEPTION 'this change is global: it needs an all-regions delegation' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION idm_actor_all_modules() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_resolve_permissions(public.app_actor()) r WHERE r.module_key = '*')
      OR EXISTS (SELECT 1 FROM public.user_role_assignments a WHERE a.user_id = public.app_actor() AND a.all_modules
                 AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
$$;

CREATE OR REPLACE FUNCTION idm_scope_check(p_module text, p_action "PermissionAction", p_all_regions boolean, p_regions int[], p_all_modules boolean,
  p_modules text[], p_valid_to timestamptz, p_level "PermissionLevel") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rf int[]; e timestamptz; m text; r int; a uuid := public.app_actor();
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  rf := public.app_actor_region_filter(p_module, p_action);
  IF coalesce(p_all_regions, false) AND rf IS NOT NULL THEN
    RAISE EXCEPTION 'you cannot grant all regions: your own delegation is limited to some regions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- defence in depth (the deferred scope trigger and the resolver already fail closed on an empty region set)
  IF rf IS NOT NULL AND NOT coalesce(p_all_regions, false) AND cardinality(coalesce(p_regions, ARRAY[]::int[])) = 0 THEN
    RAISE EXCEPTION 'a regional delegate must name at least one region' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF rf IS NOT NULL THEN
    FOREACH r IN ARRAY coalesce(p_regions, ARRAY[]::int[]) LOOP
      IF NOT (r = ANY (rf)) THEN RAISE EXCEPTION 'region % is outside your delegated regions', r USING ERRCODE = 'insufficient_privilege'; END IF;
    END LOOP;
  END IF;
  IF coalesce(p_all_modules, false) AND NOT public.idm_actor_all_modules() THEN
    RAISE EXCEPTION 'you cannot grant all modules: you do not hold all modules yourself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH m IN ARRAY coalesce(p_modules, ARRAY[]::text[]) LOOP
    IF NOT public.app_has_permission(a, m, 'view') THEN RAISE EXCEPTION 'module % is outside your own scope', m USING ERRCODE = 'insufficient_privilege'; END IF;
  END LOOP;
  e := public.app_actor_delegation_end(p_module, p_action);
  IF e IS NOT NULL AND e <> 'infinity' AND (p_valid_to IS NULL OR p_valid_to > e) THEN
    RAISE EXCEPTION 'cannot outlive your own delegation (ends %)', e USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_level = 'admin' THEN RAISE EXCEPTION 'only a System Admin can grant admin level' USING ERRCODE = 'insufficient_privilege'; END IF;
END $$;

-- An existing assignment lies in the actor's scope when its regions are all delegated to the actor.
CREATE OR REPLACE FUNCTION idm_assignment_in_scope(p_id uuid, p_module text, p_action "PermissionAction") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rf int[]; o public.user_role_assignments%ROWTYPE;
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  rf := public.app_actor_region_filter(p_module, p_action);
  IF rf IS NULL THEN RETURN; END IF;
  SELECT * INTO o FROM public.user_role_assignments WHERE id = p_id;
  IF o.all_regions
     OR NOT EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = p_id)
     OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = p_id AND NOT (r.region_id = ANY (rf))) THEN
    RAISE EXCEPTION 'this assignment reaches regions outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Roles and groups that carry delegations (or a default profile wider than the actor) are System-Admin territory.
CREATE OR REPLACE FUNCTION idm_role_privileged(p_role uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  -- ignores every active/revoked/expiry flag: a dormant delegation or role must not become a way around the test
  SELECT EXISTS (SELECT 1 FROM public.delegations d WHERE d.target_role_id = p_role)
      OR EXISTS (SELECT 1 FROM public.roles r WHERE r.id = p_role AND r.default_profile_id IS NOT NULL AND NOT public.idm_profile_within_actor(r.default_profile_id))
$$;
CREATE OR REPLACE FUNCTION idm_group_privileged(p_group uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  -- ignores groups.is_active and delegation status
  SELECT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = p_group AND g.is_system_admins)
      OR EXISTS (SELECT 1 FROM public.delegations d WHERE d.target_group_id = p_group)
$$;

-- A user is privileged when they are, or ever were set up as, an admin or a delegate: member of any System Admins group (whatever
-- the group or user status), direct delegation target, or holder of an admin-level assignment or a privileged role (any validity).
CREATE OR REPLACE FUNCTION idm_user_privileged(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins WHERE gm.user_id = p_user)
      OR EXISTS (SELECT 1 FROM public.delegations d WHERE d.target_user_id = p_user)
      OR EXISTS (SELECT 1 FROM public.user_role_assignments a WHERE a.user_id = p_user AND (a.permission_level = 'admin' OR public.idm_role_privileged(a.role_id)))
      OR EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.user_id = p_user AND public.idm_group_privileged(gm.group_id))
$$;

-- ---- post-state helpers: called AFTER the INSERT/UPDATE inside the same function; a failure rolls the change back --------------
CREATE OR REPLACE FUNCTION idm_assert_assignment_within_actor(p_id uuid, p_action "PermissionAction") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.user_role_assignments%ROWTYPE; rf int[]; e timestamptz; r int; m text; pr uuid; actor uuid := public.app_actor();
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  SELECT * INTO a FROM public.user_role_assignments WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'assignment not found'; END IF;
  IF a.permission_level = 'admin' THEN RAISE EXCEPTION 'only a System Admin can hold or grant admin level' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF public.idm_role_privileged(a.role_id) THEN RAISE EXCEPTION 'this role carries delegations or wider rights: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  rf := public.app_actor_region_filter('assignments', p_action);
  IF rf IS NOT NULL THEN
    IF a.all_regions THEN RAISE EXCEPTION 'resulting assignment has all regions: wider than your delegated regions' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_role_assignment_regions WHERE assignment_id = p_id) THEN
      RAISE EXCEPTION 'a regional delegate must name at least one region' USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR r IN SELECT region_id FROM public.user_role_assignment_regions WHERE assignment_id = p_id LOOP
      IF NOT (r = ANY (rf)) THEN RAISE EXCEPTION 'region % is outside your delegated regions', r USING ERRCODE = 'insufficient_privilege'; END IF;
    END LOOP;
  END IF;
  IF a.all_modules AND NOT public.idm_actor_all_modules() THEN RAISE EXCEPTION 'resulting assignment has all modules: you do not hold all modules' USING ERRCODE = 'insufficient_privilege'; END IF;
  FOR m IN SELECT module_key FROM public.user_role_assignment_modules WHERE assignment_id = p_id LOOP
    IF NOT public.app_has_permission(actor, m, 'view') THEN RAISE EXCEPTION 'module % is outside your own scope', m USING ERRCODE = 'insufficient_privilege'; END IF;
  END LOOP;
  FOR pr IN SELECT profile_id FROM public.user_role_assignment_profiles WHERE assignment_id = p_id LOOP
    IF NOT public.idm_profile_within_actor(pr) THEN RAISE EXCEPTION 'profile % is wider than your own rights', pr USING ERRCODE = 'insufficient_privilege'; END IF;
  END LOOP;
  e := public.app_actor_delegation_end('assignments', p_action);
  IF e IS NOT NULL AND e <> 'infinity' AND (a.valid_to IS NULL OR a.valid_to > e) THEN
    RAISE EXCEPTION 'resulting end date is beyond your own delegation (ends %)', e USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION idm_assert_group_within_actor(p_group uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  IF public.idm_group_privileged(p_group) THEN
    RAISE EXCEPTION 'this group is the admin group or carries delegations: System Admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION idm_assert_user_change_allowed(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  IF public.idm_user_privileged(p_user) THEN
    RAISE EXCEPTION 'this user is an admin or a delegate (or was): System Admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION idm_assert_role_within_actor(p_role uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.roles%ROWTYPE;
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN; END IF;
  SELECT * INTO r FROM public.roles WHERE id = p_role;
  IF r.default_all_regions THEN RAISE EXCEPTION 'a role with default_all_regions is System-Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF r.default_all_modules AND NOT public.idm_actor_all_modules() THEN RAISE EXCEPTION 'a role defaulting to all modules needs you to hold all modules' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF r.default_profile_id IS NOT NULL AND NOT public.idm_profile_within_actor(r.default_profile_id) THEN RAISE EXCEPTION 'default profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF EXISTS (SELECT 1 FROM public.delegations d WHERE d.target_role_id = p_role) THEN RAISE EXCEPTION 'this role is a delegation target: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
END $$;

-- First sign-in: a pending user with no rights. Idempotent by Entra object id.
CREATE OR REPLACE FUNCTION idm_register_self(p_m365 text, p_email text, p_display text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE uid uuid;
BEGIN
  IF coalesce(btrim(p_m365), '') = '' OR coalesce(btrim(p_email), '') = '' THEN RAISE EXCEPTION 'identity claims required'; END IF;
  SELECT id INTO uid FROM public.users WHERE m365_object_id = p_m365;
  IF FOUND THEN RETURN uid; END IF;
  INSERT INTO public.users (m365_object_id, email, display_name, status, updated_at)
  VALUES (p_m365, lower(p_email), coalesce(nullif(btrim(p_display), ''), p_email), 'pending_assignment', now()) RETURNING id INTO uid;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id) VALUES ('user_registered', 'user', uid::text, jsonb_build_object('email', lower(p_email)), uid);
  RETURN uid;
END $$;

-- First sign-in (the user is still pending_assignment, so app_actor() is not yet valid): the caller's own id only.
CREATE OR REPLACE FUNCTION idm_set_employee_id(p_user uuid, p_emp text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'you can only set your own employee id' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_emp !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'employee id is 4 digits'; END IF;
  UPDATE public.users SET employee_id = p_emp, updated_at = now() WHERE id = p_user AND employee_id IS NULL AND status <> 'disabled';
  IF NOT FOUND THEN RAISE EXCEPTION 'employee id already set or user disabled'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id) VALUES ('employee_id_set', 'user', p_user::text, jsonb_build_object('employee_id', p_emp), p_user);
END $$;

CREATE OR REPLACE FUNCTION idm_set_user_status(p_user uuid, p_status "UserStatus", p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); old "UserStatus";
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  IF p_user = a THEN RAISE EXCEPTION 'you cannot change your own status' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT status INTO old FROM public.users WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  UPDATE public.users SET status = p_status, updated_at = now() WHERE id = p_user;
  PERFORM public.idm_assert_user_change_allowed(p_user); -- post-state: privileged users (any status) are System-Admin only
  PERFORM public.idm_audit('user_status', 'user', p_user::text, jsonb_build_object('status', old), jsonb_build_object('status', p_status), p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_assign(p_user uuid, p_role uuid, p_level "PermissionLevel", p_team "TeamKind", p_valid_from timestamptz, p_valid_to timestamptz,
  p_is_primary boolean, p_all_regions boolean, p_regions int[], p_all_modules boolean, p_modules text[], p_profiles uuid[], p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('assignments', 'create'); aid uuid;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  IF p_user = a THEN RAISE EXCEPTION 'you cannot assign roles to yourself' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_assert_user_change_allowed(p_user);
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = p_role AND is_active) THEN RAISE EXCEPTION 'role not found or inactive'; END IF;
  INSERT INTO public.user_role_assignments (user_id, role_id, permission_level, team, valid_from, valid_to, is_primary, all_regions, all_modules, assigned_by)
  VALUES (p_user, p_role, coalesce(p_level, 'view'), coalesce(p_team, 'none'), coalesce(p_valid_from, now()), p_valid_to, coalesce(p_is_primary, false),
          coalesce(p_all_regions, false), coalesce(p_all_modules, false), a) RETURNING id INTO aid;
  INSERT INTO public.user_role_assignment_regions SELECT aid, r FROM unnest(coalesce(p_regions, ARRAY[]::int[])) r;
  INSERT INTO public.user_role_assignment_modules SELECT aid, m FROM unnest(coalesce(p_modules, ARRAY[]::text[])) m;
  INSERT INTO public.user_role_assignment_profiles SELECT aid, pp FROM unnest(coalesce(p_profiles, ARRAY[]::uuid[])) pp;
  PERFORM public.idm_assert_assignment_within_actor(aid, 'create'); -- post-state ceiling check; failure rolls everything back
  PERFORM public.idm_audit('assignment_created', 'user_role_assignment', aid::text, NULL,
    jsonb_build_object('user', p_user, 'role', p_role, 'all_regions', p_all_regions, 'regions', p_regions, 'all_modules', p_all_modules, 'modules', p_modules, 'profiles', p_profiles), p_reason);
  RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION idm_update_assignment(p_id uuid, p_level "PermissionLevel", p_team "TeamKind", p_valid_to timestamptz, p_all_regions boolean, p_regions int[],
  p_all_modules boolean, p_modules text[], p_profiles uuid[], p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('assignments', 'edit'); o public.user_role_assignments%ROWTYPE;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  SELECT * INTO o FROM public.user_role_assignments WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'assignment not found'; END IF;
  IF o.user_id = a THEN RAISE EXCEPTION 'you cannot change your own assignments' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN
    PERFORM public.idm_assert_user_change_allowed(o.user_id);
    PERFORM public.idm_assignment_in_scope(p_id, 'assignments', 'edit');                -- pre-state: only assignments inside your scope
    PERFORM public.idm_assert_assignment_within_actor(p_id, 'edit');                    -- pre-state: an admin-level / all_modules / wide assignment is not yours to edit
    IF o.valid_to IS NOT NULL AND o.valid_to <= now() AND p_valid_to IS DISTINCT FROM o.valid_to THEN
      RAISE EXCEPTION 'an assignment that has already ended cannot be given a new end date' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  UPDATE public.user_role_assignments SET permission_level = coalesce(p_level, permission_level), team = coalesce(p_team, team), valid_to = p_valid_to,
    all_regions = coalesce(p_all_regions, all_regions), all_modules = coalesce(p_all_modules, all_modules) WHERE id = p_id;
  IF p_regions IS NOT NULL THEN
    DELETE FROM public.user_role_assignment_regions WHERE assignment_id = p_id;
    INSERT INTO public.user_role_assignment_regions SELECT p_id, r FROM unnest(p_regions) r;
  END IF;
  IF p_modules IS NOT NULL THEN
    DELETE FROM public.user_role_assignment_modules WHERE assignment_id = p_id;
    INSERT INTO public.user_role_assignment_modules SELECT p_id, m FROM unnest(p_modules) m;
  END IF;
  IF p_profiles IS NOT NULL THEN
    DELETE FROM public.user_role_assignment_profiles WHERE assignment_id = p_id;
    INSERT INTO public.user_role_assignment_profiles SELECT p_id, pp FROM unnest(p_profiles) pp;
  END IF;
  PERFORM public.idm_assert_assignment_within_actor(p_id, 'edit');                      -- post-state
  PERFORM public.idm_audit('assignment_updated', 'user_role_assignment', p_id::text, to_jsonb(o),
    jsonb_build_object('regions', p_regions, 'modules', p_modules, 'profiles', p_profiles, 'all_regions', p_all_regions, 'all_modules', p_all_modules, 'valid_to', p_valid_to), p_reason);
END $$;

-- Removing an assignment ends it (history is kept).
CREATE OR REPLACE FUNCTION idm_end_assignment(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('assignments', 'delete'); uid uuid;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  SELECT user_id INTO uid FROM public.user_role_assignments WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'assignment not found'; END IF;
  IF uid = a THEN RAISE EXCEPTION 'you cannot change your own assignments' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_assignment_in_scope(p_id, 'assignments', 'delete');
  -- same gates as idm_update_assignment: a delegate cannot end a privileged user's or an out-of-ceiling assignment
  PERFORM public.idm_assert_user_change_allowed(uid);
  PERFORM public.idm_assert_assignment_within_actor(p_id, 'delete');
  UPDATE public.user_role_assignments SET valid_to = greatest(now(), valid_from + interval '1 millisecond'), is_primary = false WHERE id = p_id AND (valid_to IS NULL OR valid_to > now());
  PERFORM public.idm_audit('assignment_ended', 'user_role_assignment', p_id::text, NULL, jsonb_build_object('user', uid), p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_group_save(p_id uuid, p_name text, p_desc text, p_active boolean, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid; gid uuid := p_id; o public.groups%ROWTYPE;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('groups', CASE WHEN p_id IS NULL THEN 'create' ELSE 'edit' END::"PermissionAction");
  IF p_id IS NULL THEN
    a := public.idm_actor('groups', 'create');
    INSERT INTO public.groups (name, description, is_active) VALUES (p_name, p_desc, coalesce(p_active, true)) RETURNING id INTO gid;
    PERFORM public.idm_audit('group_created', 'group', gid::text, NULL, jsonb_build_object('name', p_name), p_reason);
  ELSE
    a := public.idm_actor('groups', 'edit');
    SELECT * INTO o FROM public.groups WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'group not found'; END IF;
    PERFORM public.idm_assert_group_within_actor(p_id); -- pre-state: privileged groups (any status) are System-Admin only
    UPDATE public.groups SET name = coalesce(p_name, name), description = p_desc, is_active = coalesce(p_active, is_active) WHERE id = p_id;
    PERFORM public.idm_assert_group_within_actor(p_id); -- post-state
    PERFORM public.idm_audit('group_updated', 'group', p_id::text, to_jsonb(o), jsonb_build_object('name', p_name, 'is_active', p_active), p_reason);
  END IF;
  RETURN gid;
END $$;

CREATE OR REPLACE FUNCTION idm_group_add_member(p_group uuid, p_user uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('groups', 'edit');
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  IF p_user = a THEN RAISE EXCEPTION 'you cannot add yourself to a group' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_need_global('groups', 'edit');
  IF NOT EXISTS (SELECT 1 FROM public.groups WHERE id = p_group) THEN RAISE EXCEPTION 'group not found'; END IF;
  INSERT INTO public.group_members (group_id, user_id) VALUES (p_group, p_user) ON CONFLICT DO NOTHING;
  PERFORM public.idm_assert_group_within_actor(p_group); -- post-state: not the admin group, not a delegation target
  PERFORM public.idm_audit('group_member_added', 'group', p_group::text, NULL, jsonb_build_object('user', p_user), p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_group_remove_member(p_group uuid, p_user uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.idm_actor('groups', 'edit');
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('groups', 'edit');
  IF NOT EXISTS (SELECT 1 FROM public.groups WHERE id = p_group) THEN RAISE EXCEPTION 'group not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.groups WHERE id = p_group AND is_system_admins) AND NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'a delegate cannot remove an admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.idm_assert_group_within_actor(p_group); -- privileged groups are System-Admin only (removing also changes others' rights)
  DELETE FROM public.group_members WHERE group_id = p_group AND user_id = p_user;
  PERFORM public.idm_audit('group_member_removed', 'group', p_group::text, jsonb_build_object('user', p_user), NULL, p_reason);
END $$;

-- p_grants: [{"module":"warehouse_items","action":"edit"}, ...]. A root delegation is made by a System Admin. A delegate may
-- re-delegate only under a parent delegation that has allow_redelegate, and never wider than the parent (grants, regions, dates).
CREATE OR REPLACE FUNCTION idm_delegate(p_kind "DelegationTarget", p_user uuid, p_role uuid, p_group uuid, p_is_full boolean, p_grants jsonb,
  p_all_regions boolean, p_regions int[], p_valid_from timestamptz, p_valid_to timestamptz, p_allow_redelegate boolean, p_parent uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); did uuid; g jsonb; par public.delegations%ROWTYPE; r int;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_need_reason(p_reason);
  IF NOT coalesce(p_is_full, false) AND coalesce(jsonb_array_length(p_grants), 0) = 0 THEN RAISE EXCEPTION 'a delegation needs grants or is_full'; END IF;
  IF p_parent IS NULL THEN
    IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'only a System Admin can create a delegation' USING ERRCODE = 'insufficient_privilege'; END IF;
  ELSE
    SELECT * INTO par FROM public.delegations WHERE id = p_parent;
    IF NOT FOUND OR NOT par.allow_redelegate OR NOT public.deleg_effective(p_parent)
       OR NOT EXISTS (SELECT 1 FROM public.app_user_delegations(a) x(id) WHERE x.id = p_parent) THEN
      RAISE EXCEPTION 're-delegation needs an active parent delegation to you with allow_redelegate' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF coalesce(p_is_full, false) AND NOT par.is_full THEN RAISE EXCEPTION 'cannot delegate wider than your own scope' USING ERRCODE = 'insufficient_privilege'; END IF;
    FOR g IN SELECT * FROM jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) LOOP
      IF NOT public.deleg_covers(p_parent, g->>'module', (g->>'action')::"PermissionAction") THEN
        RAISE EXCEPTION 'cannot delegate %.% : outside your own scope', g->>'module', g->>'action' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
    IF coalesce(p_all_regions, false) AND NOT par.all_regions THEN RAISE EXCEPTION 'cannot delegate more regions than you have' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF NOT par.all_regions THEN
      FOREACH r IN ARRAY coalesce(p_regions, ARRAY[]::int[]) LOOP
        IF NOT EXISTS (SELECT 1 FROM public.delegation_regions dr WHERE dr.delegation_id = p_parent AND dr.region_id = r) THEN
          RAISE EXCEPTION 'region % is outside your own scope', r USING ERRCODE = 'insufficient_privilege';
        END IF;
      END LOOP;
    END IF;
    IF par.valid_to IS NOT NULL AND (p_valid_to IS NULL OR p_valid_to > par.valid_to) THEN RAISE EXCEPTION 'cannot outlive the parent delegation' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;
  INSERT INTO public.delegations (from_user_id, target_kind, target_user_id, target_role_id, target_group_id, parent_delegation_id, is_full, all_regions,
    allow_redelegate, valid_from, valid_to, reason)
  VALUES (a, p_kind, p_user, p_role, p_group, p_parent, coalesce(p_is_full, false), coalesce(p_all_regions, false),
    coalesce(p_allow_redelegate, false), coalesce(p_valid_from, now()), p_valid_to, p_reason) RETURNING id INTO did;
  FOR g IN SELECT * FROM jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) LOOP
    INSERT INTO public.delegation_grants VALUES (did, g->>'module', (g->>'action')::"PermissionAction") ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO public.delegation_regions SELECT did, r2 FROM unnest(coalesce(p_regions, ARRAY[]::int[])) r2;
  PERFORM public.idm_audit('delegation_created', 'delegation', did::text, NULL,
    jsonb_build_object('kind', p_kind, 'user', p_user, 'role', p_role, 'group', p_group, 'grants', p_grants, 'full', p_is_full, 'parent', p_parent, 'until', p_valid_to), p_reason);
  RETURN did;
END $$;

CREATE OR REPLACE FUNCTION idm_revoke_delegation(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); d public.delegations%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_need_reason(p_reason);
  SELECT * INTO d FROM public.delegations WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'delegation not found'; END IF;
  IF NOT public.app_actor_is_system_admin() AND d.from_user_id <> a THEN RAISE EXCEPTION 'only a System Admin or the delegator can revoke' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.delegations SET revoked = true, revoked_at = now(), revoked_by = a WHERE id = p_id;
  PERFORM public.idm_audit('delegation_revoked', 'delegation', p_id::text, NULL, NULL, p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_profile_save(p_id uuid, p_code text, p_name_en text, p_name_ar text, p_desc text, p_active boolean, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid; pid uuid := p_id;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('permission_profiles', CASE WHEN p_id IS NULL THEN 'create' ELSE 'edit' END::"PermissionAction");
  IF p_id IS NULL THEN
    a := public.idm_actor('permission_profiles', 'create');
    INSERT INTO public.permission_profiles (code, name_en, name_ar, description, is_active, reason, changed_by)
    VALUES (p_code, p_name_en, p_name_ar, p_desc, coalesce(p_active, true), p_reason, a) RETURNING id INTO pid;
    PERFORM public.idm_audit('profile_created', 'permission_profile', pid::text, NULL, jsonb_build_object('code', p_code), p_reason);
  ELSE
    a := public.idm_actor('permission_profiles', 'edit');
    IF public.idm_actor_uses_profile(p_id) THEN RAISE EXCEPTION 'you cannot edit a profile that gives you rights' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF NOT public.idm_profile_within_actor(p_id) THEN RAISE EXCEPTION 'this profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege'; END IF;
    UPDATE public.permission_profiles SET name_en = coalesce(p_name_en, name_en), name_ar = p_name_ar, description = p_desc,
      is_active = coalesce(p_active, is_active), reason = p_reason, changed_by = a WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'profile not found'; END IF;
    IF NOT public.idm_profile_within_actor(p_id) THEN RAISE EXCEPTION 'this profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege'; END IF; -- post-state
  PERFORM public.idm_audit('profile_updated', 'permission_profile', p_id::text, NULL, jsonb_build_object('name_en', p_name_en, 'is_active', p_active), p_reason);
  END IF;
  RETURN pid;
END $$;

CREATE OR REPLACE FUNCTION idm_profile_set_grants(p_profile uuid, p_grants jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('permission_profiles', 'edit'); g jsonb;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('permission_profiles', 'edit');
  IF public.idm_actor_uses_profile(p_profile) THEN RAISE EXCEPTION 'you cannot edit a profile that gives you rights' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN
    FOR g IN SELECT * FROM jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) LOOP
      IF NOT public.app_has_permission(a, g->>'module', (g->>'action')::"PermissionAction") THEN
        RAISE EXCEPTION 'cannot grant %.% : you do not hold it', g->>'module', g->>'action' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
  END IF;
  DELETE FROM public.permission_grants WHERE profile_id = p_profile;
  FOR g IN SELECT * FROM jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) LOOP
    INSERT INTO public.permission_grants VALUES (p_profile, g->>'module', (g->>'action')::"PermissionAction") ON CONFLICT DO NOTHING;
  END LOOP;
  UPDATE public.permission_profiles SET reason = p_reason, changed_by = a WHERE id = p_profile;
  IF NOT public.idm_profile_within_actor(p_profile) THEN RAISE EXCEPTION 'resulting profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege'; END IF; -- post-state
  PERFORM public.idm_audit('profile_grants_set', 'permission_profile', p_profile::text, NULL, p_grants, p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_field_permission_set(p_field uuid, p_role uuid, p_profile uuid, p_access "FieldAccess", p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('fields', 'edit'); own int; want int; ent "FieldEntityType"; modk text;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('fields', 'edit');
  IF (p_role IS NULL) = (p_profile IS NULL) THEN RAISE EXCEPTION 'give a role or a profile'; END IF;
  IF (p_role IS NOT NULL AND public.idm_actor_holds_role(p_role)) OR (p_profile IS NOT NULL AND public.idm_actor_uses_profile(p_profile)) THEN
    RAISE EXCEPTION 'you cannot change field rules that apply to you' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.app_actor_is_system_admin() THEN
    -- the actor's own access: the field rule, else the entity-level permission, else hidden (fail closed when unknown)
    SELECT entity_type INTO ent FROM public.field_definitions WHERE id = p_field;
    IF NOT FOUND THEN RAISE EXCEPTION 'field not found'; END IF;
    modk := CASE ent::text WHEN 'site' THEN 'sites' WHEN 'task_instance' THEN 'sites' WHEN 'milestone' THEN 'workflow_versions' WHEN 'gate' THEN 'workflow_versions'
      WHEN 'rf_design' THEN 'rf_design' WHEN 'acquisition' THEN 'acquisition' WHEN 'procurement' THEN 'procurement' WHEN 'gecol' THEN 'gecol' WHEN 'hlc' THEN 'hlc'
      WHEN 'permit' THEN 'permits_hse' WHEN 'warehouse_item' THEN 'warehouse' WHEN 'warehouse_serial' THEN 'warehouse' WHEN 'quality' THEN 'quality'
      WHEN 'issue' THEN 'issues' WHEN 'risk' THEN 'risks' WHEN 'change_request' THEN 'change_control' WHEN 'readiness' THEN 'readiness'
      WHEN 'as_built' THEN 'as_built' WHEN 'meeting' THEN 'meetings' WHEN 'external_party' THEN 'contractors' END;
    own := CASE public.app_resolve_field_access(a, p_field)::text WHEN 'hidden' THEN 0 WHEN 'read' THEN 1 WHEN 'edit' THEN 2 ELSE
             CASE WHEN modk IS NOT NULL AND public.app_has_permission(a, modk, 'edit') THEN 2
                  WHEN modk IS NOT NULL AND public.app_has_permission(a, modk, 'view') THEN 1 ELSE 0 END END;
    IF own = 0 THEN RAISE EXCEPTION 'you cannot see this field, so you cannot change who sees it' USING ERRCODE = 'insufficient_privilege'; END IF;
    -- resulting access for the subject: the rule, or (rule removed) the entity default, which is edit
    want := CASE p_access::text WHEN 'hidden' THEN 0 WHEN 'read' THEN 1 ELSE 2 END;
    IF want > own THEN RAISE EXCEPTION 'you cannot give (or restore by removing a rule) more field access than you have yourself' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;
  DELETE FROM public.field_permissions WHERE field_id = p_field AND role_id IS NOT DISTINCT FROM p_role AND profile_id IS NOT DISTINCT FROM p_profile;
  IF p_access IS NOT NULL THEN
    INSERT INTO public.field_permissions (field_id, role_id, profile_id, access) VALUES (p_field, p_role, p_profile, p_access);
  END IF;
  PERFORM public.idm_audit('field_permission_set', 'field', p_field::text, NULL, jsonb_build_object('role', p_role, 'profile', p_profile, 'access', p_access), p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_role_save(p_id uuid, p_code text, p_name_en text, p_name_ar text, p_desc_en text, p_desc_ar text, p_parent uuid, p_team "TeamKind",
  p_default_profile uuid, p_default_all_regions boolean, p_default_all_modules boolean, p_can_hold boolean, p_sort int, p_active boolean, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid; rid uuid := p_id; o public.roles%ROWTYPE;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('roles', CASE WHEN p_id IS NULL THEN 'create' ELSE 'edit' END::"PermissionAction");
  IF NOT public.app_actor_is_system_admin() THEN
    IF coalesce(p_default_all_regions, false) THEN RAISE EXCEPTION 'default_all_regions is System-Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF coalesce(p_default_all_modules, false) AND NOT public.idm_actor_all_modules() THEN RAISE EXCEPTION 'you cannot make a role default to all modules' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;
  IF p_default_profile IS NOT NULL AND NOT public.idm_profile_within_actor(p_default_profile) THEN
    RAISE EXCEPTION 'default profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    a := public.idm_actor('roles', 'create');
    INSERT INTO public.roles (code, name_en, name_ar, description_en, description_ar, parent_role_id, team, default_profile_id, default_all_regions,
      default_all_modules, can_hold_matrix_levels, sort, is_active)
    VALUES (p_code, p_name_en, p_name_ar, p_desc_en, p_desc_ar, p_parent, coalesce(p_team, 'none'), p_default_profile, coalesce(p_default_all_regions, false),
      coalesce(p_default_all_modules, false), coalesce(p_can_hold, true), coalesce(p_sort, 0), coalesce(p_active, true)) RETURNING id INTO rid;
    PERFORM public.idm_audit('role_created', 'role', rid::text, NULL, jsonb_build_object('code', p_code, 'name_en', p_name_en, 'parent', p_parent), p_reason);
  ELSE
    a := public.idm_actor('roles', 'edit');
    SELECT * INTO o FROM public.roles WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
    IF p_default_profile IS DISTINCT FROM o.default_profile_id AND public.idm_actor_holds_role(p_id) THEN
      RAISE EXCEPTION 'you cannot change the default profile of a role you hold' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.roles SET name_en = coalesce(p_name_en, name_en), name_ar = p_name_ar, description_en = p_desc_en, description_ar = p_desc_ar,
      parent_role_id = p_parent, team = coalesce(p_team, team), default_profile_id = p_default_profile,
      default_all_regions = coalesce(p_default_all_regions, default_all_regions), default_all_modules = coalesce(p_default_all_modules, default_all_modules),
      can_hold_matrix_levels = coalesce(p_can_hold, can_hold_matrix_levels), sort = coalesce(p_sort, sort), is_active = coalesce(p_active, is_active)
    WHERE id = p_id;
    PERFORM public.idm_audit('role_updated', 'role', p_id::text, to_jsonb(o), jsonb_build_object('name_en', p_name_en, 'is_active', p_active, 'parent', p_parent), p_reason);
  END IF;
  PERFORM public.idm_assert_role_within_actor(rid); -- post-state
  RETURN rid;
END $$;

CREATE OR REPLACE FUNCTION idm_role_set_defaults(p_role uuid, p_regions int[], p_modules text[], p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.idm_actor('roles', 'edit');
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('roles', 'edit');
  PERFORM public.idm_scope_check('roles', 'edit', false, p_regions, false, p_modules, NULL, NULL);
  DELETE FROM public.role_default_regions WHERE role_id = p_role;
  INSERT INTO public.role_default_regions SELECT p_role, r FROM unnest(coalesce(p_regions, ARRAY[]::int[])) r;
  DELETE FROM public.role_default_modules WHERE role_id = p_role;
  INSERT INTO public.role_default_modules SELECT p_role, m FROM unnest(coalesce(p_modules, ARRAY[]::text[])) m;
  PERFORM public.idm_audit('role_defaults_set', 'role', p_role::text, NULL, jsonb_build_object('regions', p_regions, 'modules', p_modules), p_reason);
END $$;

CREATE OR REPLACE FUNCTION idm_role_delete(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.idm_actor('roles', 'delete');
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('roles', 'delete');
  DELETE FROM public.roles WHERE id = p_id; -- roles_guard refuses while assigned or referenced
  PERFORM public.idm_audit('role_deleted', 'role', p_id::text, NULL, NULL, p_reason);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'idm_actor_holds_role(uuid)','idm_actor_uses_profile(uuid)','idm_actor(text,"PermissionAction")','idm_audit(text,text,text,jsonb,jsonb,text)',
    'idm_profile_within_actor(uuid)','idm_need_reason(text)','idm_need_global(text,"PermissionAction")','idm_actor_all_modules()','idm_scope_check(text,"PermissionAction",boolean,int[],boolean,text[],timestamptz,"PermissionLevel")','idm_assignment_in_scope(uuid,text,"PermissionAction")','idm_role_privileged(uuid)','idm_group_privileged(uuid)','idm_user_privileged(uuid)','idm_assert_assignment_within_actor(uuid,"PermissionAction")','idm_assert_group_within_actor(uuid)','idm_assert_user_change_allowed(uuid)','idm_assert_role_within_actor(uuid)','idm_register_self(text,text,text)','idm_set_employee_id(uuid,text)','idm_set_user_status(uuid,"UserStatus",text)',
    'idm_assign(uuid,uuid,"PermissionLevel","TeamKind",timestamptz,timestamptz,boolean,boolean,int[],boolean,text[],uuid[],text)',
    'idm_update_assignment(uuid,"PermissionLevel","TeamKind",timestamptz,boolean,int[],boolean,text[],uuid[],text)','idm_end_assignment(uuid,text)',
    'idm_group_save(uuid,text,text,boolean,text)','idm_group_add_member(uuid,uuid,text)','idm_group_remove_member(uuid,uuid,text)',
    'idm_delegate("DelegationTarget",uuid,uuid,uuid,boolean,jsonb,boolean,int[],timestamptz,timestamptz,boolean,uuid,text)','idm_revoke_delegation(uuid,text)',
    'idm_profile_save(uuid,text,text,text,text,boolean,text)','idm_profile_set_grants(uuid,jsonb,text)',
    'idm_field_permission_set(uuid,uuid,uuid,"FieldAccess",text)',
    'idm_role_save(uuid,text,text,text,text,text,uuid,"TeamKind",uuid,boolean,boolean,boolean,int,boolean,text)','idm_role_set_defaults(uuid,int[],text[],text)','idm_role_delete(uuid,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
  END LOOP;
  -- idm_* are callable by the app role only; helpers stay internal
  FOREACH f IN ARRAY ARRAY['idm_actor(text,"PermissionAction")','idm_audit(text,text,text,jsonb,jsonb,text)','idm_profile_within_actor(uuid)','idm_need_global(text,"PermissionAction")','idm_actor_all_modules()','idm_scope_check(text,"PermissionAction",boolean,int[],boolean,text[],timestamptz,"PermissionLevel")','idm_assignment_in_scope(uuid,text,"PermissionAction")','idm_role_privileged(uuid)','idm_group_privileged(uuid)','idm_user_privileged(uuid)','idm_assert_assignment_within_actor(uuid,"PermissionAction")','idm_assert_group_within_actor(uuid)','idm_assert_user_change_allowed(uuid)','idm_assert_role_within_actor(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin region transfer (needs the verified-admin check, hence here)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_transfer_site_region(p_site uuid, p_new_region integer, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE old_region integer;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT region_id INTO old_region FROM public.sites WHERE id = p_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found'; END IF;
  -- ceiling: both the old and the new region must be delegated to the actor
  IF NOT public.app_actor_is_admin('sites', 'administer', ARRAY[old_region, p_new_region]) THEN
    RAISE EXCEPTION 'admin path: System Admin, or a delegation covering sites.administer for BOTH regions (% and %), required', old_region, p_new_region USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.sites SET region_id = p_new_region, updated_at = now() WHERE id = p_site;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, is_admin_override, actor_id)
  VALUES ('site_region_transfer', 'site', p_site::text, p_site, p_new_region,
          jsonb_build_object('region_id', old_region), jsonb_build_object('region_id', p_new_region), p_reason, true, public.app_actor());
END $$;
ALTER FUNCTION admin_transfer_site_region(uuid, integer, text) OWNER TO pmis_definer;
GRANT SELECT, UPDATE ON sites TO pmis_definer;
REVOKE ALL ON FUNCTION admin_transfer_site_region(uuid, integer, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------------
-- Configuration RLS: everyone reads; writes need the delegated/admin permission for the table's module
-- (create / edit / delete), judged from app.user_id by app_can(), never from the region session. Warehouse items: edited by the
-- System Admin, and by the Inventory Supervisor only through a delegation. The migration role may seed.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _rls_policies(t text, ins text, upd text, del text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE pol text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  FOREACH pol IN ARRAY ARRAY['region_filter','rls_select','rls_insert','rls_update','rls_delete'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, t);
  END LOOP;
  EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (true)', t);
  EXECUTE format('CREATE POLICY rls_insert ON %I FOR INSERT WITH CHECK (%s)', t, ins);
  EXECUTE format('CREATE POLICY rls_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t, upd, upd);
  EXECUTE format('CREATE POLICY rls_delete ON %I FOR DELETE USING (%s)', t, del);
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('regions','regions'),('workflow_definitions','workflow_versions'),('stage_definitions','workflow_versions'),('phase_gate_rules','workflow_versions'),
    ('task_definitions','task_definitions'),('task_predecessors','task_definitions'),('document_types','document_types'),
    ('document_type_placements','document_types'),('snag_types','document_types'),('template_definitions','templates'),('template_versions','templates'),
    ('work_calendars','calendars'),('holidays','calendars'),('sla_rules','sla_rules'),('weight_sets','weights'),('weight_activities','weights'),
    ('weight_items','weights'),('baseline_versions','baseline'),('settings','settings'),('field_definitions','fields'),('field_set_versions','fields'),
    ('field_list_values','lists'),('warehouse_items','warehouse_items')) AS v(t, m) LOOP
    PERFORM _rls_policies(r.t,
      format('app_can(%L, ''create'') OR app_is_seeding()', r.m),
      format('app_can(%L, ''edit'') OR app_is_seeding()', r.m),
      format('app_can(%L, ''delete'') OR app_is_seeding()', r.m));
  END LOOP;
  -- identity configuration: written only by the idm_* functions (BYPASSRLS owner) or the migration role
  FOR r IN SELECT unnest(ARRAY['roles','role_default_regions','role_default_modules','permission_profiles','permission_grants','field_permissions']) AS t LOOP
    PERFORM _rls_policies(r.t, 'app_is_seeding()', 'app_is_seeding()', 'app_is_seeding()');
  END LOOP;
  -- shared master data: any signed-in session may maintain it (contractors are registered by staff)
  FOR r IN SELECT unnest(ARRAY['external_parties','external_teams']) AS t LOOP
    PERFORM _rls_policies(r.t, 'app_has_session() OR app_is_seeding()', 'app_has_session() OR app_is_seeding()', 'app_has_session() OR app_is_seeding()');
  END LOOP;
END $$;
DROP FUNCTION _rls_policies(text, text, text, text);

SELECT idm_revoke_app_writes();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_transfer_site_region(uuid, integer, text) TO pmis_app;
  END IF;
END $$;
-- No idm_* / admin_* function is executable by PUBLIC; only pmis_app (below) and the owners.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'idm\_%' OR p.proname LIKE 'admin\_%')
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig); END LOOP;
END $$;

DO $$
DECLARE f record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_%'
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig); END LOOP;
  END IF;
END $$;

DO $$
DECLARE f record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'idm\_%' AND p.proname NOT IN ('idm_actor','idm_audit','idm_profile_within_actor','idm_need_global','idm_actor_all_modules','idm_scope_check','idm_assignment_in_scope','idm_role_privileged','idm_group_privileged','idm_user_privileged','idm_assert_assignment_within_actor','idm_assert_group_within_actor','idm_assert_user_change_allowed','idm_assert_role_within_actor','idm_need_reason','idm_backstop','idm_users_backstop','idm_beneficiary_backstop','idm_last_admin_check','idm_revoke_app_writes')
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig); END LOOP;
  END IF;
END $$;
