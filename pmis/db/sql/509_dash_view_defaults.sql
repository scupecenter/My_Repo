-- 0510_dash_view_defaults (contract 0.15.208): server-wide dashboard view defaults (the default export format of the Share / Export menu and
-- the default collapse state of the dashboard sections). Mirror: db/sql/509_dash_view_defaults.sql (kept identical).
--
-- WHAT THIS ADDS (additive; no table, no existing function or grant changes).
--   1. The setting dashboard.view_defaults = {"export_format": "xlsx", "collapse": "open"}. Guarded by settings_guarded_keys like ui.identity (0130):
--      it changes only through admin_set_dashboard_view_defaults.
--   2. dashboard_view_defaults_state() (the read door, any signed-in user) and
--      admin_set_dashboard_view_defaults(p_export_format, p_collapse, p_reason, p_version) (the write door: System Admin or an all-regions delegate of
--      settings edit, a reason of 3+ characters, the version, one audit row dashboard_view_defaults_update with before and after; the step-up is
--      enforced by the API like the identity setting).
-- A user's own remembered choice in the browser stays as the override. Function rules as 0130: SECURITY DEFINER, search_path = pg_catalog, public,
-- pg_temp, EXECUTE revoked from PUBLIC, owner pmis_definer.

SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('dashboard.view_defaults', '{"export_format": "xlsx", "collapse": "open"}'::jsonb,
        '0510: server-wide dashboard view defaults {export_format: xlsx|csv, collapse: open|closed}. Changed only through admin_set_dashboard_view_defaults.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_dash_view ON settings;
DROP TRIGGER IF EXISTS b_settings_dash_view_update ON settings;
DROP TRIGGER IF EXISTS b_settings_dash_view_delete ON settings;
CREATE TRIGGER b_settings_dash_view BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'dashboard.view_defaults') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dash_view_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'dashboard.view_defaults' OR NEW.key = 'dashboard.view_defaults') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dash_view_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'dashboard.view_defaults') EXECUTE FUNCTION settings_guarded_keys();

-- The setting as stored, sanitised: a missing or malformed part reads as the default (xlsx, open).
CREATE OR REPLACE FUNCTION dashboard_view_defaults_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; f text; c text;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'dashboard.view_defaults';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  f := CASE WHEN v ->> 'export_format' IN ('xlsx', 'csv') THEN v ->> 'export_format' ELSE 'xlsx' END;
  c := CASE WHEN v ->> 'collapse' IN ('open', 'closed') THEN v ->> 'collapse' ELSE 'open' END;
  RETURN jsonb_build_object('export_format', f, 'collapse', c);
END $$;

CREATE OR REPLACE FUNCTION dashboard_view_defaults_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.dashboard_view_defaults_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'dashboard.view_defaults';
  RETURN jsonb_build_object(
    'export_format', c -> 'export_format',
    'collapse', c -> 'collapse',
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('dashboard.view_defaults'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_dashboard_view_defaults(p_export_format text, p_collapse text, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_export_format IS NULL OR p_export_format NOT IN ('xlsx', 'csv') THEN PERFORM public.wfe_err1('/export_format', 'invalid', 'Choose xlsx or csv.'); END IF;
  IF p_collapse IS NULL OR p_collapse NOT IN ('open', 'closed') THEN PERFORM public.wfe_err1('/collapse', 'invalid', 'Choose open or closed.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.view_defaults', '{"export_format": "xlsx", "collapse": "open"}'::jsonb,
          '0510: server-wide dashboard view defaults {export_format: xlsx|csv, collapse: open|closed}. Changed only through admin_set_dashboard_view_defaults.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.view_defaults' FOR UPDATE;
  cur := public.dashboard_view_defaults_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur ->> 'export_format' = p_export_format AND cur ->> 'collapse' = p_collapse THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the dashboard view defaults.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('export_format', p_export_format, 'collapse', p_collapse),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.view_defaults';
  res := public.dashboard_view_defaults_state();
  PERFORM public.log_audit_write('dashboard_view_defaults_update', 'setting', 'dashboard.view_defaults',
    jsonb_build_object('export_format', cur -> 'export_format', 'collapse', cur -> 'collapse'),
    jsonb_build_object('export_format', res -> 'export_format', 'collapse', res -> 'collapse'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dashboard_view_defaults_cfg()', 'dashboard_view_defaults_state()', 'admin_set_dashboard_view_defaults(text,text,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dashboard_view_defaults_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_dashboard_view_defaults(text, text, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION dashboard_view_defaults_cfg() FROM pmis_app;
  END IF;
END $$;
