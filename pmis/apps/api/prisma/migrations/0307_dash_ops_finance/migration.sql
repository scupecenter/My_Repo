-- 0307_dash_ops_finance (contract 0.15.206): the dashboard follow-up card "Restricted financial summary" (owner approval 2026-11-26,
-- dashboard proposals item 9). Mirror: db/sql/306_dash_ops_finance.sql (kept identical).
--
-- WHAT THIS ADDS (additive; no table, no existing function or grant changes).
--   1. The card code ops_finance in the dashboard settings catalogue (migration 0108); the earlier cards are restated unchanged.
--   2. The setting dashboard.finance_readers = {"enabled": false, "role_codes": ["PM", "FIN_OFFICER"]}: who may see the card. It is OFF by default, and
--      only holders of a listed role (default Project Manager and Finance Officer; not a System Admin by that fact alone) see it. Guarded by
--      settings_guarded_keys like ui.identity (0130): it changes only through admin_set_dashboard_finance_readers.
--   3. dashboard_finance_readers_state() (the read door, any signed-in user), dashboard_finance_reader() (does the caller see the card) and
--      admin_set_dashboard_finance_readers(p_enabled, p_role_codes, p_reason, p_version) (the write door: System Admin or an all-regions delegate of
--      settings edit, a reason of 3+ characters, the version, one audit row dashboard_finance_readers_update with before and after; the step-up is
--      enforced by the API like the identity setting).
-- Function rules as 0130: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC, owner pmis_definer.

SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('dashboard.finance_readers', '{"enabled": false, "role_codes": ["PM", "FIN_OFFICER"]}'::jsonb,
        'Owner approval 2026-11-26 (0307): who sees the restricted financial summary card {enabled, role_codes}. Changed only through admin_set_dashboard_finance_readers.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_dash_finance ON settings;
DROP TRIGGER IF EXISTS b_settings_dash_finance_update ON settings;
DROP TRIGGER IF EXISTS b_settings_dash_finance_delete ON settings;
CREATE TRIGGER b_settings_dash_finance BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'dashboard.finance_readers') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dash_finance_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'dashboard.finance_readers' OR NEW.key = 'dashboard.finance_readers') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dash_finance_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'dashboard.finance_readers') EXECUTE FUNCTION settings_guarded_keys();

-- The setting as stored, sanitised: a missing or malformed value reads as off with the default roles; only codes of active roles are kept.
CREATE OR REPLACE FUNCTION dashboard_finance_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; en boolean; codes text[];
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'dashboard.finance_readers';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  en := CASE WHEN jsonb_typeof(v -> 'enabled') = 'boolean' THEN (v ->> 'enabled')::boolean ELSE false END;
  IF jsonb_typeof(v -> 'role_codes') = 'array' THEN
    SELECT coalesce(array_agg(DISTINCT r.code ORDER BY r.code), ARRAY[]::text[]) INTO codes
      FROM jsonb_array_elements_text(v -> 'role_codes') x JOIN public.roles r ON r.code = x AND r.is_active;
  ELSE
    codes := ARRAY['FIN_OFFICER', 'PM']::text[];
  END IF;
  RETURN jsonb_build_object('enabled', en, 'role_codes', to_jsonb(codes));
END $$;

-- Does the caller see the card: it is switched on and the caller holds an active, current assignment of a listed role.
CREATE OR REPLACE FUNCTION dashboard_finance_reader() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.dashboard_finance_cfg(); a uuid := public.app_actor();
BEGIN
  IF a IS NULL OR NOT (c ->> 'enabled')::boolean THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.user_role_assignments x JOIN public.roles r ON r.id = x.role_id AND r.is_active
                  WHERE x.user_id = a AND x.valid_from <= now() AND (x.valid_to IS NULL OR x.valid_to > now())
                    AND r.code IN (SELECT jsonb_array_elements_text(c -> 'role_codes')));
END $$;

CREATE OR REPLACE FUNCTION dashboard_finance_readers_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.dashboard_finance_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'dashboard.finance_readers';
  RETURN jsonb_build_object(
    'enabled', c -> 'enabled',
    'role_codes', c -> 'role_codes',
    'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('code', r.code, 'name_en', r.name_en, 'name_ar', r.name_ar) ORDER BY r.sort, r.code)
                         FROM public.roles r WHERE r.is_active), '[]'::jsonb),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('dashboard.finance_readers'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_dashboard_finance_readers(p_enabled boolean, p_role_codes text[], p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; codes text[]; bad text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wfe_err1('/enabled', 'required', 'Say whether the card is switched on.'); END IF;
  IF p_role_codes IS NULL THEN PERFORM public.wfe_err1('/role_codes', 'required', 'Give the roles that may see the card (a list, possibly empty).'); END IF;
  codes := ARRAY(SELECT DISTINCT x FROM unnest(p_role_codes) x ORDER BY x);
  SELECT string_agg(x, ', ' ORDER BY x) INTO bad FROM unnest(codes) x WHERE NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.code = x AND r.is_active);
  IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/role_codes', 'invalid', 'Not an active role: ' || bad); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.finance_readers', '{"enabled": false, "role_codes": ["PM", "FIN_OFFICER"]}'::jsonb,
          'Owner approval 2026-11-26 (0307): who sees the restricted financial summary card {enabled, role_codes}. Changed only through admin_set_dashboard_finance_readers.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.finance_readers' FOR UPDATE;
  cur := public.dashboard_finance_readers_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled AND cur -> 'role_codes' = to_jsonb(codes) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the readers of the financial summary.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled, 'role_codes', to_jsonb(codes)),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.finance_readers';
  res := public.dashboard_finance_readers_state();
  PERFORM public.log_audit_write('dashboard_finance_readers_update', 'setting', 'dashboard.finance_readers',
    jsonb_build_object('enabled', cur -> 'enabled', 'role_codes', cur -> 'role_codes'),
    jsonb_build_object('enabled', res -> 'enabled', 'role_codes', res -> 'role_codes'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dashboard_finance_cfg()', 'dashboard_finance_reader()', 'dashboard_finance_readers_state()', 'admin_set_dashboard_finance_readers(boolean,text[],text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dashboard_finance_reader() TO pmis_app;
    GRANT EXECUTE ON FUNCTION dashboard_finance_readers_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_dashboard_finance_readers(boolean, text[], text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION dashboard_finance_cfg() FROM pmis_app;
  END IF;
END $$;

-- The card joins the card catalogue by patching the stored function text (as 0260 does), never by replacing the whole function: a whole replacement
-- would drop a card another migration added (the goals card was lost that way). Idempotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_finance"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_finance","label_en":"Restricted financial summary: advances and disbursed against completion","label_ar":"ملخص مالي مقيّد: السلف والمنصرف مقابل الإنجاز"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
