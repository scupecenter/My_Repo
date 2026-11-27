-- 0291: support access, slice S2 of the security section (section 3 of the PM-platforms proposal).
--
-- WHY. A System Admin sometimes needs to let a support person help with configuration for a short time, without handing over a permanent role.
-- This adds NO new permission engine: a support grant is an ordinary delegation (0009: time window, revoke, audit) created through the existing
-- idm_delegate door, plus a switch and a set of limits that are checked here. It is OFF until a System Admin turns it on in Settings > Security > Support access.
--
-- WHAT THIS ADDS.
--   1. The setting security.support_access = {"enabled": false, "max_hours": 72, "default_hours": 24}, guarded by settings_guarded_keys like 0290.
--   2. support_access_cfg(): the sanitised setting (wrong types read as the defaults, enabled only on a boolean true).
--   3. support_access_state(): the read door (System Admin only): the setting, its version, and the modules a support grant may touch.
--   4. admin_set_support_access(p_enabled, p_max_hours, p_default_hours, p_reason, p_version): the write door. System Admin only, reason, version, audit
--      row support_access_update with before and after. Turning it off does not revoke grants already made (an admin revokes them one by one or all at once).
--   5. support_access_check_grant(p_user, p_grants, p_hours): called by the API in the same transaction right before idm_delegate. System Admin only, the
--      switch must be on, the target must be an active user other than the caller, the hours must be within 1..max_hours, every grant must be a create, edit or
--      delete on an allowlisted module (templates, fields, lists, document types, warehouse items;
--      never users, roles, groups, assignments, matrix, profiles, workflow versions, views, settings, overrides or two-factor), and at most 30 support grants per
--      admin per hour. The grant itself is audited by idm_delegate (delegation_created, with the reason below).
--   6. support_access_check_revoke(p_id): the delegation must be a support grant (its reason starts with '[support-access] '), System Admin only.
--
-- A support grant is recognised by the reason prefix '[support-access] ', which the API adds and the check functions require. Nothing is deleted and no
-- existing permission changes. Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC, owned by pmis_definer.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON users, delegations TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('security.support_access', '{"enabled": false, "max_hours": 72, "default_hours": 24}'::jsonb,
        'Support access (0291): off by default. A support grant is a time-limited delegation. Changed only through admin_set_support_access.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_support_access ON settings;
DROP TRIGGER IF EXISTS b_settings_support_access_update ON settings;
DROP TRIGGER IF EXISTS b_settings_support_access_delete ON settings;
CREATE TRIGGER b_settings_support_access BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'security.support_access') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_support_access_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.support_access' OR NEW.key = 'security.support_access') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_support_access_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.support_access') EXECUTE FUNCTION settings_guarded_keys();

CREATE OR REPLACE FUNCTION support_access_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; mx int := 72; df int := 24; en boolean := false;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'security.support_access';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  IF jsonb_typeof(v -> 'enabled') = 'boolean' THEN en := (v ->> 'enabled')::boolean; END IF;
  IF jsonb_typeof(v -> 'max_hours') = 'number' AND (v ->> 'max_hours') ~ '^[0-9]+$' AND (v ->> 'max_hours')::int BETWEEN 1 AND 168 THEN mx := (v ->> 'max_hours')::int; END IF;
  IF jsonb_typeof(v -> 'default_hours') = 'number' AND (v ->> 'default_hours') ~ '^[0-9]+$' AND (v ->> 'default_hours')::int BETWEEN 1 AND mx THEN df := (v ->> 'default_hours')::int; END IF;
  IF df > mx THEN df := mx; END IF;
  RETURN jsonb_build_object('enabled', en, 'max_hours', mx, 'default_hours', df);
END $$;

CREATE OR REPLACE FUNCTION support_access_modules() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY['templates', 'fields', 'lists', 'document_types', 'warehouse_items']::text[];
$$;

CREATE OR REPLACE FUNCTION support_access_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.support_access_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin manages support access.'));
  END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'security.support_access';
  RETURN jsonb_build_object('enabled', c -> 'enabled', 'max_hours', c -> 'max_hours', 'default_hours', c -> 'default_hours',
    'modules', to_jsonb(public.support_access_modules()),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('security.support_access'), 'can_edit', true);
END $$;

CREATE OR REPLACE FUNCTION admin_set_support_access(p_enabled boolean, p_max_hours integer, p_default_hours integer, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin changes support access.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wfe_err1('/enabled', 'required', 'Say whether support access is on.'); END IF;
  IF p_max_hours IS NULL OR p_max_hours NOT BETWEEN 1 AND 168 THEN PERFORM public.wfe_err1('/max_hours', 'invalid', 'max_hours is 1 to 168.'); END IF;
  IF p_default_hours IS NULL OR p_default_hours NOT BETWEEN 1 AND p_max_hours THEN PERFORM public.wfe_err1('/default_hours', 'invalid', 'default_hours is 1 to max_hours.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('security.support_access', '{"enabled": false, "max_hours": 72, "default_hours": 24}'::jsonb,
          'Support access (0291): off by default. A support grant is a time-limited delegation. Changed only through admin_set_support_access.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'security.support_access' FOR UPDATE;
  cur := public.support_access_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled AND (cur ->> 'max_hours')::int = p_max_hours AND (cur ->> 'default_hours')::int = p_default_hours THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the support access settings in force.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled, 'max_hours', p_max_hours, 'default_hours', p_default_hours),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'security.support_access';
  res := public.support_access_state();
  PERFORM public.log_audit_write('support_access_update', 'setting', 'security.support_access',
    jsonb_build_object('enabled', cur -> 'enabled', 'max_hours', cur -> 'max_hours', 'default_hours', cur -> 'default_hours'),
    jsonb_build_object('enabled', res -> 'enabled', 'max_hours', res -> 'max_hours', 'default_hours', res -> 'default_hours'), btrim(p_reason));
  RETURN res;
END $$;

-- Called by the API right before idm_delegate, in the same transaction. Raises the usual problem codes; returns nothing.
CREATE OR REPLACE FUNCTION support_access_check_grant(p_user uuid, p_grants jsonb, p_hours integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); c jsonb := public.support_access_cfg(); g jsonb; n int;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin grants support access.'));
  END IF;
  IF NOT (c ->> 'enabled')::boolean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Support access is switched off (Settings > Security > Support access).'));
  END IF;
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > (c ->> 'max_hours')::int THEN PERFORM public.wfe_err1('/hours', 'invalid', 'hours is 1 to the configured maximum.'); END IF;
  IF p_user IS NULL OR p_user = a OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND u.status = 'active') THEN
    PERFORM public.wfe_err1('/to_user_id', 'invalid', 'Name an active user other than yourself.');
  END IF;
  IF p_grants IS NULL OR jsonb_typeof(p_grants) <> 'array' OR jsonb_array_length(p_grants) = 0 THEN PERFORM public.wfe_err1('/rights', 'required', 'List the rights to grant.'); END IF;
  FOR g IN SELECT * FROM jsonb_array_elements(p_grants) LOOP
    IF NOT ((g ->> 'module') = ANY (public.support_access_modules())) OR (g ->> 'action') NOT IN ('create', 'edit', 'delete') THEN
      PERFORM public.wfe_err1('/rights', 'not_allowed', 'Support access cannot include ' || coalesce(g ->> 'module', '?') || '.' || coalesce(g ->> 'action', '?') || '.');
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM public.delegations d WHERE d.from_user_id = a AND d.reason LIKE '[support-access] %' AND d.created_at > now() - interval '1 hour';
  IF n >= 30 THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Too many support grants in the last hour.')); END IF;
END $$;

CREATE OR REPLACE FUNCTION support_access_check_revoke(p_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin revokes support access.'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delegations d WHERE d.id = p_id AND d.reason LIKE '[support-access] %') THEN PERFORM public.wf_err('not_found'); END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['support_access_cfg()', 'support_access_modules()', 'support_access_state()', 'admin_set_support_access(boolean,integer,integer,text,integer)',
                           'support_access_check_grant(uuid,jsonb,integer)', 'support_access_check_revoke(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION support_access_state(), admin_set_support_access(boolean, integer, integer, text, integer),
      support_access_check_grant(uuid, jsonb, integer), support_access_check_revoke(uuid) TO pmis_app;
    REVOKE ALL ON FUNCTION support_access_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('support_access_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'security.support_access', 'enabled', false, 'max_hours', 72, 'default_hours', 24,
          'read', 'support_access_state', 'write', 'admin_set_support_access', 'audit', jsonb_build_array('support_access_update', 'delegation_created', 'delegation_revoked')),
        'Support access (migration 0291): a time-limited delegation with limits, off by default.');
