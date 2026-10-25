-- 003: role assignments, the verified actor, delegation and the permission resolvers.
--
-- SECURITY MODEL AND ITS LIMIT. The API sets two session settings per transaction: app.user_id (the signed-in user) and
-- app.region_ids (the region filter). Every identity write and every admin function re-derives, from the tables, whether
-- app.user_id is an active System Admin (group membership) or holds an active delegation for the action (app_actor_is_admin),
-- and the app role has no write privilege on identity tables. This defends against API bugs (mass assignment, a missing
-- check, a forged request body). It does NOT defend against a fully compromised app role or SQL injection, because
-- app.user_id is still a session setting that role can set. Closing that needs per-user database roles or a signed session token
-- verified in the database; it is out of scope for this schema.

ALTER TABLE user_role_assignments ADD CONSTRAINT user_role_assignments_valid_range
  CHECK (valid_to IS NULL OR valid_to > valid_from);
-- At most one primary assignment per user; no duplicate assignment of the same role starting at the same time.
CREATE UNIQUE INDEX user_role_assignments_one_primary ON user_role_assignments (user_id) WHERE is_primary;
CREATE UNIQUE INDEX user_role_assignments_no_dup ON user_role_assignments (user_id, role_id, valid_from);

-- Scope is an explicit opt-in. all_regions / all_modules = true grants everything; otherwise only the child rows count.
-- An assignment with the flag false and no rows contributes nothing (fail closed).

-- Region value for the session: the union of the user's active assignments.
--   '*'   if the user is active and any active assignment has all_regions = true
--   '1,3' union of the regions listed on active assignments otherwise
--   ''    if nothing applies (pending_assignment, suspended, expired, no regions): the user sees nothing
-- Usage by the API, once per transaction:  SELECT set_config('app.region_ids', app_resolve_region_ids($1), true);
CREATE OR REPLACE FUNCTION app_resolve_region_ids(p_user uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH act AS (
    SELECT a.id, a.all_regions
    FROM user_role_assignments a
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM act WHERE all_regions) THEN '*'
    ELSE coalesce((SELECT string_agg(DISTINCT r.region_id::text, ',')
                   FROM user_role_assignment_regions r JOIN act ON act.id = r.assignment_id), '')
  END
$$;

-- Modules: NULL = all modules (explicit all_modules), empty array = none, otherwise the union.
CREATE OR REPLACE FUNCTION app_resolve_modules(p_user uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  WITH act AS (
    SELECT a.id, a.all_modules
    FROM user_role_assignments a
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM act WHERE all_modules) THEN NULL
    ELSE coalesce((SELECT array_agg(DISTINCT m.module_key)
                   FROM user_role_assignment_modules m JOIN act ON act.id = m.assignment_id), ARRAY[]::text[])
  END
$$;

-- Deferred check at commit: an active assignment must have all_regions = true or at least one region row, and likewise
-- for modules. Deferral lets the API insert the assignment and its child rows in one transaction.
CREATE OR REPLACE FUNCTION assignment_scope_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE aid uuid; a user_role_assignments%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'user_role_assignments' THEN aid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN aid := OLD.assignment_id;
  ELSE aid := NEW.assignment_id;
  END IF;
  SELECT * INTO a FROM user_role_assignments WHERE id = aid;
  IF NOT FOUND OR (a.valid_to IS NOT NULL AND a.valid_to <= now()) THEN RETURN NULL; END IF;
  IF NOT a.all_regions AND NOT EXISTS (SELECT 1 FROM user_role_assignment_regions WHERE assignment_id = aid) THEN
    RAISE EXCEPTION 'assignment % needs all_regions = true or at least one region', aid USING ERRCODE = 'check_violation';
  END IF;
  IF NOT a.all_modules AND NOT EXISTS (SELECT 1 FROM user_role_assignment_modules WHERE assignment_id = aid) THEN
    RAISE EXCEPTION 'assignment % needs all_modules = true or at least one module', aid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER user_role_assignments_scope AFTER INSERT OR UPDATE ON user_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_scope_check();
CREATE CONSTRAINT TRIGGER user_role_assignment_regions_scope AFTER DELETE OR UPDATE ON user_role_assignment_regions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_scope_check();
CREATE CONSTRAINT TRIGGER user_role_assignment_modules_scope AFTER DELETE OR UPDATE ON user_role_assignment_modules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_scope_check();

-- ---------------------------------------------------------------------------------------------------------------------
-- Verified actor, System Admin, delegation, permission resolvers (SECURITY DEFINER, owner pmis_identity_owner, BYPASSRLS).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u uuid;
BEGIN
  BEGIN u := nullif(current_setting('app.user_id', true), '')::uuid; EXCEPTION WHEN others THEN RETURN NULL; END;
  RETURN (SELECT id FROM public.users WHERE id = u AND status = 'active');
END $$;

CREATE OR REPLACE FUNCTION app_user_is_system_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
    JOIN public.users u ON u.id = gm.user_id AND u.status = 'active'
    WHERE gm.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION app_actor_is_system_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(public.app_user_is_system_admin(public.app_actor()), false)
$$;

-- A delegation is effective when it and every parent up the chain is active (not revoked, dates current) and the root
-- delegator is still a System Admin.
CREATE OR REPLACE FUNCTION deleg_effective(p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.delegations%ROWTYPE; cur uuid := p_id; depth int := 0;
BEGIN
  LOOP
    SELECT * INTO d FROM public.delegations WHERE id = cur;
    IF NOT FOUND OR d.revoked OR d.valid_from > now() OR (d.valid_to IS NOT NULL AND d.valid_to <= now()) THEN RETURN false; END IF;
    IF d.parent_delegation_id IS NULL THEN RETURN public.app_user_is_system_admin(d.from_user_id); END IF;
    cur := d.parent_delegation_id; depth := depth + 1;
    IF depth > 10 THEN RETURN false; END IF;
  END LOOP;
END $$;

-- Does grant set of delegation d cover (module, action)? A grant on "sites" covers "sites" and "sites.*".
CREATE OR REPLACE FUNCTION deleg_covers(p_id uuid, p_module text, p_action "PermissionAction") RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.delegations d WHERE d.id = p_id AND d.is_full)
      OR EXISTS (SELECT 1 FROM public.delegation_grants g
                 WHERE g.delegation_id = p_id AND g.action = p_action
                   AND (p_module = g.module_key OR p_module LIKE g.module_key || '.%'))
$$;

-- Effective delegations that apply to a user: addressed to the user, to a role the user holds through an active assignment,
-- or to a group the user belongs to.
CREATE OR REPLACE FUNCTION app_user_delegations(p_user uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.id FROM public.delegations d
  WHERE public.deleg_effective(d.id)
    AND ( (d.target_kind = 'user' AND d.target_user_id = p_user)
       OR (d.target_kind = 'role' AND EXISTS (
             SELECT 1 FROM public.user_role_assignments a JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
             WHERE a.user_id = p_user AND a.role_id = d.target_role_id AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())))
       OR (d.target_kind = 'group' AND EXISTS (
             SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_active
             WHERE gm.user_id = p_user AND gm.group_id = d.target_group_id)) )
$$;

-- Does an effective delegation to the user cover (module, action) AND every region in p_regions? p_regions NULL or empty =
-- the action is not region-bound. A delegation covers a region when it has all_regions or a delegation_regions row; the
-- union over the covering delegations counts.
CREATE OR REPLACE FUNCTION app_delegation_covers(p_user uuid, p_module text, p_action "PermissionAction", p_regions int[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH cov AS (
    SELECT d.id, d.all_regions FROM public.app_user_delegations(p_user) x(id) JOIN public.delegations d ON d.id = x.id
    WHERE public.deleg_covers(d.id, p_module, p_action))
  SELECT EXISTS (SELECT 1 FROM cov)
     AND (p_regions IS NULL OR cardinality(p_regions) = 0
          OR EXISTS (SELECT 1 FROM cov WHERE all_regions)
          OR NOT EXISTS (SELECT 1 FROM unnest(p_regions) r
                         WHERE NOT EXISTS (SELECT 1 FROM cov JOIN public.delegation_regions dr ON dr.delegation_id = cov.id WHERE dr.region_id = r)))
$$;

-- The ceiling every non-System-Admin actor works under, for one (module, action):
--   region filter: NULL = unrestricted (System Admin, or a covering delegation with all_regions); otherwise the union of the
--   delegated regions (empty array = nothing). Callers restrict sites to it or refuse.
CREATE OR REPLACE FUNCTION app_actor_region_filter(p_module text, p_action "PermissionAction") RETURNS int[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF public.app_actor_is_system_admin() THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.app_user_delegations(a) x(id) JOIN public.delegations d ON d.id = x.id
             WHERE d.all_regions AND public.deleg_covers(d.id, p_module, p_action)) THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT array_agg(DISTINCT dr.region_id) FROM public.app_user_delegations(a) x(id)
                   JOIN public.delegation_regions dr ON dr.delegation_id = x.id
                   WHERE public.deleg_covers(x.id, p_module, p_action)), ARRAY[]::int[]);
END $$;

-- End of the actor's delegated power for (module, action): NULL = none, 'infinity' = until revoked.
CREATE OR REPLACE FUNCTION app_actor_delegation_end(p_module text, p_action "PermissionAction") RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT max(coalesce(d.valid_to, 'infinity'::timestamptz))
  FROM public.app_user_delegations(public.app_actor()) x(id) JOIN public.delegations d ON d.id = x.id
  WHERE public.deleg_covers(d.id, p_module, p_action)
$$;

-- The check used by every identity write and admin function: System Admin member, or an active delegation covering the action
-- (and, when p_regions is given, every one of those regions).
CREATE OR REPLACE FUNCTION app_actor_is_admin(p_module text, p_action "PermissionAction", p_regions int[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_actor_is_system_admin() OR public.app_delegation_covers(public.app_actor(), p_module, p_action, p_regions)
$$;

CREATE OR REPLACE FUNCTION app_assert_self_or_admin(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor() IS DISTINCT FROM p_user AND NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'permission resolver: only for yourself or a System Admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Permissions of a user = union over active assignments (profiles, limited to the assignment's modules) + delegations that
-- apply to the user + everything for a System Admin. A '*' module_key means every module (admin or full delegation).
CREATE OR REPLACE FUNCTION app_resolve_permissions(p_user uuid) RETURNS TABLE (module_key text, action "PermissionAction")
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_assert_self_or_admin(p_user);
  RETURN QUERY
  WITH act AS (
    SELECT a.id, a.all_modules
    FROM public.user_role_assignments a JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
  SELECT g.module_key, g.action
  FROM act
  JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = act.id
  JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
  JOIN public.permission_grants g ON g.profile_id = pp.id
  WHERE act.all_modules
     OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = act.id AND m.module_key = split_part(g.module_key, '.', 1))
  UNION
  SELECT dg.module_key, dg.action
  FROM public.app_user_delegations(p_user) x(id) JOIN public.delegation_grants dg ON dg.delegation_id = x.id
  UNION
  SELECT '*', pa FROM unnest(enum_range(NULL::"PermissionAction")) pa
  WHERE public.app_user_is_system_admin(p_user)
  UNION
  SELECT '*', pa FROM unnest(enum_range(NULL::"PermissionAction")) pa
  WHERE EXISTS (SELECT 1 FROM public.app_user_delegations(p_user) x(id) JOIN public.delegations d ON d.id = x.id WHERE d.is_full);
END $$;

CREATE OR REPLACE FUNCTION app_has_permission(p_user uuid, p_module text, p_action "PermissionAction") RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_resolve_permissions(p_user) r
                 WHERE r.action = p_action AND (r.module_key = '*' OR p_module = r.module_key OR p_module LIKE r.module_key || '.%'))
$$;

-- For the signed-in actor (RLS write policies on GLOBAL configuration tables). Configuration is not region data, so a
-- right counts only when it is held for all regions: System Admin, a delegation with all_regions, or a profile through an
-- active assignment with all_regions. A Tripoli-only delegate can therefore not change global configuration.
CREATE OR REPLACE FUNCTION app_can(p_module text, p_action "PermissionAction") RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(a) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.app_user_delegations(a) x(id) JOIN public.delegations d ON d.id = x.id
             WHERE d.all_regions AND public.deleg_covers(d.id, p_module, p_action)) THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_role_assignments ua
    JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = ua.id
    JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
    JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = p_action
         AND (p_module = g.module_key OR p_module LIKE g.module_key || '.%')
    WHERE ua.user_id = a AND ua.all_regions AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
      AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = split_part(g.module_key, '.', 1))));
END $$;

-- Field access: most permissive matching rule across active assignments (profile or role); NULL = entity permission decides.
CREATE OR REPLACE FUNCTION app_resolve_field_access(p_user uuid, p_field uuid) RETURNS "FieldAccess"
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE best integer;
BEGIN
  PERFORM public.app_assert_self_or_admin(p_user);
  WITH act AS (
    SELECT a.id, a.role_id FROM public.user_role_assignments a
    JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
  SELECT max(CASE fp.access::text WHEN 'hidden' THEN 0 WHEN 'read' THEN 1 ELSE 2 END) INTO best
  FROM public.field_permissions fp
  WHERE fp.field_id = p_field
    AND (fp.role_id IN (SELECT role_id FROM act)
         OR fp.profile_id IN (SELECT ap.profile_id FROM act JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = act.id));
  RETURN CASE best WHEN 0 THEN 'hidden' WHEN 1 THEN 'read' WHEN 2 THEN 'edit' ELSE NULL END::"FieldAccess";
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app_actor()','app_user_is_system_admin(uuid)','app_actor_is_system_admin()','deleg_effective(uuid)',
    'deleg_covers(uuid,text,"PermissionAction")','app_user_delegations(uuid)','app_delegation_covers(uuid,text,"PermissionAction",int[])',
    'app_actor_region_filter(text,"PermissionAction")','app_actor_delegation_end(text,"PermissionAction")',
    'app_actor_is_admin(text,"PermissionAction",int[])','app_assert_self_or_admin(uuid)','app_resolve_permissions(uuid)',
    'app_has_permission(uuid,text,"PermissionAction")','app_can(text,"PermissionAction")','app_resolve_field_access(uuid,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
  END LOOP;
END $$;
GRANT SELECT ON users, groups, group_members, delegations, delegation_grants, delegation_regions, user_role_assignments,
  user_role_assignment_regions, user_role_assignment_modules, user_role_assignment_profiles, permission_profiles,
  permission_grants, field_permissions, roles TO pmis_identity_owner;
