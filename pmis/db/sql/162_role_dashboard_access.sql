-- 0163: what a role sees of the Dashboard (owner decision 2026-11-26, 00:39 and 00:43: management read-only users see only the Dashboard, and only the tabs chosen in Settings).
--   * roles.dashboard_tabs: the Dashboard tabs a holder of the role may open: any non-empty combination of pmo, cw, te. Default all three, so nobody loses anything.
--   * roles.hide_messages_inbox: the Messages and Inbox menu entries are hidden for a holder of the role. Default false (shown).
--   * Both are set by a System Admin (step-up, reason, audit row role_dashboard_access_set) through idm_role_set_dashboard_access.
--   * app_dashboard_tabs(user): the tabs of a user = the union over the active roles that user holds now (a System Admin, or a user with no active role: all three).
--   * app_nav_hidden(user): true only when the user is not a System Admin, holds at least one active role, and every one of those roles hides Messages and Inbox.
--   * The API refuses a dashboard call outside the user's tabs (403 action_forbidden). The tab is not a grant: dashboard.view and its regions are unchanged.
-- No new table and no change to any grant, role, profile or default.
ALTER TABLE roles ADD COLUMN dashboard_tabs text[] NOT NULL DEFAULT ARRAY['pmo', 'cw', 'te']::text[]
  CONSTRAINT roles_dashboard_tabs_check CHECK (dashboard_tabs <@ ARRAY['pmo', 'cw', 'te']::text[] AND cardinality(dashboard_tabs) >= 1);
ALTER TABLE roles ADD COLUMN hide_messages_inbox boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION idm_role_set_dashboard_access(p_role uuid, p_tabs text[], p_hide boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE o public.roles%ROWTYPE; nt text[];
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'role dashboard access: System Admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'))));
  END IF;
  nt := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_tabs, '{}'::text[])) x ORDER BY x);
  IF cardinality(nt) < 1 OR NOT nt <@ ARRAY['cw', 'pmo', 'te']::text[] THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/dashboard_tabs', 'code', 'invalid',
      'message', 'Choose at least one of pmo, cw and te.'))));
  END IF;
  IF NOT public.log_actor_stepped_up() THEN PERFORM public.wf_err('step_up_required', '{}'::jsonb); END IF;
  SELECT * INTO o FROM public.roles WHERE id = p_role FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The role does not exist.')); END IF;
  IF o.dashboard_tabs = nt AND o.hide_messages_inbox = coalesce(p_hide, false) THEN RETURN; END IF;
  UPDATE public.roles SET dashboard_tabs = nt, hide_messages_inbox = coalesce(p_hide, false) WHERE id = p_role;
  PERFORM public.log_audit_write('role_dashboard_access_set', 'role', p_role::text,
    jsonb_build_object('code', o.code, 'dashboard_tabs', to_jsonb(o.dashboard_tabs), 'hide_messages_inbox', o.hide_messages_inbox),
    jsonb_build_object('code', o.code, 'dashboard_tabs', to_jsonb(nt), 'hide_messages_inbox', coalesce(p_hide, false)), p_reason);
END $$;

-- The tabs of a user now. A System Admin and a user who holds no active role (the rights come from delegations or nothing) keep all three.
CREATE OR REPLACE FUNCTION app_dashboard_tabs(p_user uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_user IS NULL OR public.app_user_is_system_admin(p_user) THEN ARRAY['cw', 'pmo', 'te']::text[]
    WHEN NOT EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
                     WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())) THEN ARRAY['cw', 'pmo', 'te']::text[]
    ELSE ARRAY(SELECT DISTINCT t FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active, unnest(r.dashboard_tabs) t
               WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()) ORDER BY t)
  END
$$;

CREATE OR REPLACE FUNCTION app_nav_hidden(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_user IS NOT NULL AND NOT public.app_user_is_system_admin(p_user)
    AND EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
                WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
    AND NOT EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
                WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()) AND NOT r.hide_messages_inbox)
$$;

ALTER FUNCTION idm_role_set_dashboard_access(uuid, text[], boolean, text) OWNER TO pmis_identity_owner;
ALTER FUNCTION app_dashboard_tabs(uuid) OWNER TO pmis_definer;
ALTER FUNCTION app_nav_hidden(uuid) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION idm_role_set_dashboard_access(uuid, text[], boolean, text), app_dashboard_tabs(uuid), app_nav_hidden(uuid) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION log_actor_stepped_up() TO pmis_identity_owner;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION idm_role_set_dashboard_access(uuid, text[], boolean, text), app_dashboard_tabs(uuid), app_nav_hidden(uuid) TO pmis_app;
  END IF;
END $$;
