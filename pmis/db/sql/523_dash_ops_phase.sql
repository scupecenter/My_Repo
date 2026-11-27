-- 0524_dash_ops_phase (contract 0.15.367): the dashboard card "Phase scope" (sites per project phase with progress and derived targets;
-- approved by Ahmed 2026-11-27 20:28, relayed by the main agent). Mirror: db/sql/523_dash_ops_phase.sql (kept identical).
--
-- Additive: one card code, ops_phase, is added to the dashboard settings catalogue, so the card can be shown, hidden and ordered per
-- tab in Settings > Dashboard like every other card. A card in the catalogue that no saved list names is shown at the end, so the card
-- appears by default. One setting is added: dashboard.target_policy {manual_override: false}, with its read and write doors (a reason of 3+ characters, the version, one audit row dashboard_target_policy_update with before and after), written like dashboard.view_defaults (0510). No table, no grant and no permission change; the figures come from the sites table
-- through GET /dashboard/ops.

mpotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_phase"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_phase","label_en":"Phase scope: sites per project phase, progress and derived targets","label_ar":"نطاق المراحل: المواقع لكل مرحلة والتقدم والمستهدفات المشتقة"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;

-- Target policy (part 3): the manual numbers of Settings > Dashboard are an exception, off by default.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('dashboard.target_policy', '{"manual_override": false}'::jsonb,
        '0524: target policy {manual_override: boolean}. false (default) = the dashboard targets are derived from the scope; true = the typed numbers of Settings > Dashboard apply where set. Changed only through admin_set_dashboard_target_policy.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_dash_target ON settings;
DROP TRIGGER IF EXISTS b_settings_dash_target_update ON settings;
DROP TRIGGER IF EXISTS b_settings_dash_target_delete ON settings;
CREATE TRIGGER b_settings_dash_target BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'dashboard.target_policy') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dash_target_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'dashboard.target_policy' OR NEW.key = 'dashboard.target_policy') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dash_target_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'dashboard.target_policy') EXECUTE FUNCTION settings_guarded_keys();

-- The setting as stored, sanitised: a missing or malformed part reads as the default (no manual override).
CREATE OR REPLACE FUNCTION dashboard_target_policy_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'dashboard.target_policy';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  RETURN jsonb_build_object('manual_override', coalesce(v -> 'manual_override' = 'true'::jsonb, false));
END $$;

CREATE OR REPLACE FUNCTION dashboard_target_policy_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.dashboard_target_policy_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'dashboard.target_policy';
  RETURN jsonb_build_object(
    'manual_override', c -> 'manual_override',
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('dashboard.target_policy'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_dashboard_target_policy(p_manual_override boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_manual_override IS NULL THEN PERFORM public.wfe_err1('/manual_override', 'invalid', 'Choose on or off.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.target_policy', '{"manual_override": false}'::jsonb,
          '0524: target policy {manual_override: boolean}. false (default) = the dashboard targets are derived from the scope; true = the typed numbers of Settings > Dashboard apply where set. Changed only through admin_set_dashboard_target_policy.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.target_policy' FOR UPDATE;
  cur := public.dashboard_target_policy_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'manual_override')::boolean = p_manual_override THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This is already the target policy.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('manual_override', p_manual_override),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.target_policy';
  res := public.dashboard_target_policy_state();
  PERFORM public.log_audit_write('dashboard_target_policy_update', 'setting', 'dashboard.target_policy',
    jsonb_build_object('manual_override', cur -> 'manual_override'),
    jsonb_build_object('manual_override', res -> 'manual_override'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dashboard_target_policy_cfg()', 'dashboard_target_policy_state()', 'admin_set_dashboard_target_policy(boolean,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dashboard_target_policy_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_dashboard_target_policy(boolean, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION dashboard_target_policy_cfg() FROM pmis_app;
  END IF;
END $$;
