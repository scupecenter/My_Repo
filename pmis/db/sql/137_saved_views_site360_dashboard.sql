-- 0138_saved_views_site360_dashboard: saved views for the screens site360-<menu> and dashboard (owner request 2026-11-22, closes an open item of CHANGELOG 183;
-- contract 0.15.49, CHANGELOG 185). Mirror: db/sql/137_saved_views_site360_dashboard.sql (kept byte-identical).
--
-- WHAT THIS CHANGES. The unified filter of 0.15.45 added the screens `site360-<menu>` (master, design_acq, sow, cw, te, hoto, dismantle, om) and `dashboard` to the
-- filter builder but gave them no saved views, because sv_screen_module did not know them. This migration lets a user save, share and open a view of them with the
-- same rights model as every other list screen (private, shared with roles, groups, users, regions or everyone, owner and views.manage, versions, audit):
--   1. sv_screen_module (the latest definition is 0118, db/sql/117_f5_kanban.sql): `site360-<menu>` belongs to the module `sites` (the module of the Site Register,
--      as for `sites` and `sites-stream`) and `dashboard` to the module `dashboard`.
--   2. sv_module_ok (0065): a user opens a `dashboard` view only with the Site Register right as well, because the dashboard filter reads site data (the same two
--      rights GET /saved-views/filter-fields asks for); a System Admin always may.
--   3. sv_hidden_filter_field (0117): a site custom field `c:<code>` in the filter tree is checked on the sites-like screens `site360-<menu>` and `dashboard` as it is
--      on `sites`, instead of being treated as hidden (without this a saved tree would lose its custom-field conditions when it is read).
-- A saved view keeps what the screens already keep: the filter tree in `filters.advanced`, the quick parameters as keys of `filters`, and the column control. For
-- `site360-<menu>` `filters.layout` (`list` or `wide`) is one more quick parameter; the database does not read it. No new table, no grant change, no new door:
-- the three functions are the existing ones, redefined from their latest definitions with the additions marked "0138".
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC.

CREATE OR REPLACE FUNCTION sv_screen_module(p_screen text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_screen IS NULL THEN RETURN NULL; END IF;
  IF p_screen ~ '^register-[a-z0-9_]{2,60}$' THEN
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = substr(p_screen, 10) AND d.is_active);
  END IF;
  RETURN CASE p_screen
    WHEN 'sites' THEN 'sites'
    WHEN 'sites-stream' THEN 'sites'
    WHEN 'site-tasks' THEN 'sites'
    WHEN 'tasks-board' THEN 'sites' -- 0118 (F5)
    WHEN 'site360-master' THEN 'sites' -- 0138
    WHEN 'site360-design_acq' THEN 'sites' -- 0138
    WHEN 'site360-sow' THEN 'sites' -- 0138
    WHEN 'site360-cw' THEN 'sites' -- 0138
    WHEN 'site360-te' THEN 'sites' -- 0138
    WHEN 'site360-hoto' THEN 'sites' -- 0138
    WHEN 'site360-dismantle' THEN 'sites' -- 0138
    WHEN 'site360-om' THEN 'sites' -- 0138
    WHEN 'dashboard' THEN 'dashboard' -- 0138
    WHEN 'audit-log' THEN 'audit'
    WHEN 'field-changes' THEN 'audit'
    WHEN 'security-log' THEN 'admin.security_log'
    WHEN 'system-log' THEN 'admin.system_log'
    ELSE NULL END;
END $$;

CREATE OR REPLACE FUNCTION sv_module_ok(p_screen text, p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m text := public.sv_screen_module(p_screen);
BEGIN
  IF m IS NULL OR p_user IS NULL THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN true; END IF;
  IF p_user IS DISTINCT FROM public.app_actor() THEN RETURN false; END IF;  -- the resolver answers for the signed-in actor only
  IF m = 'admin.security_log' THEN RETURN public.app_has_permission(p_user, m, 'view_security_log'::"PermissionAction"); END IF;
  -- 0138: the dashboard filter reads site data, so a dashboard view also needs the Site Register right
  IF p_screen = 'dashboard' AND NOT public.app_has_permission(p_user, 'sites', 'view'::"PermissionAction") THEN RETURN false; END IF;
  RETURN public.app_has_permission(p_user, m, 'view'::"PermissionAction")
      OR (m = 'audit' AND public.app_has_permission(p_user, m, 'view_audit'::"PermissionAction"));
END $$;

CREATE OR REPLACE FUNCTION sv_hidden_filter_field(p_screen text, p_field text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE fid uuid; acc text;
BEGIN
  IF p_field IS NULL THEN RETURN true; END IF;
  IF p_field ~ '^f:' THEN RETURN public.sv_hidden_column(p_screen, p_field); END IF;
  IF p_field ~ '^c:' THEN
    -- 0138: the sites-like screens of 0.15.45 hold the fields of `sites`
    IF p_screen NOT IN ('sites', 'sites-stream', 'dashboard') AND p_screen !~ '^site360-[a-z_]{2,20}$' THEN RETURN true; END IF;
    SELECT f.id INTO fid FROM public.field_definitions f
      WHERE f.entity_type::text = 'site' AND f.code = substr(p_field, 3) AND f.is_active AND f.in_list_filters AND f.task_code IS NULL;
    IF fid IS NULL THEN RETURN true; END IF;
    IF public.app_actor_is_system_admin() THEN RETURN false; END IF;
    acc := public.app_resolve_field_access(public.app_actor(), fid)::text;
    RETURN coalesce(acc = 'hidden', false);
  END IF;
  RETURN false;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['sv_screen_module(text)', 'sv_module_ok(text,uuid)', 'sv_hidden_filter_field(text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
END $$;
