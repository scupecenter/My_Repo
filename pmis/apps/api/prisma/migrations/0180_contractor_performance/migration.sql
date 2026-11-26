-- 0180_contractor_performance: the thresholds of the contractor performance view (feature requested 2026-11-26: contractor evaluation computed
-- automatically from the existing data, no manual rating"). Mirror: db/sql/179_contractor_performance.sql (kept identical).
--
--   1. What is added. One setting, `contractors.performance`, and its two doors: contractor_perf_thresholds_json() (read, every signed-in user)
--      and admin_set_contractor_perf_thresholds() (System Admin or an all-regions delegate of `settings` edit, a reason, If-Match, audited as
--      contractor_performance_thresholds_update with before and after). The key is guarded against direct writes like kanban.wip_limits (0118).
--   2. What it holds. {"min_sample": n, "snag_overdue_pct": {"amber": a, "red": r}, "snag_return_pct": {...}, "quality_fail_pct": {...},
--      "contract_expiry_days": {"amber": a, "red": r}}. For the three percentages a value at or above amber is amber and at or above red is red;
--      for the contract expiry the days left to the end of the contract: at or below amber is amber and at or below red is red. min_sample is the
--      least number of records a measure needs before it can colour a contractor.
--   3. Nothing else. The view itself is computed by the API from tables it already reads (no table, no data, no grant and no permission change,
--      and no rating is ever typed by a person). The defaults are the ones the screen shows until an admin changes them in
--      Settings > Registers > Contractors.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('contractors.performance',
        '{"min_sample": 3, "snag_overdue_pct": {"amber": 10, "red": 25}, "snag_return_pct": {"amber": 20, "red": 40}, "quality_fail_pct": {"amber": 10, "red": 20}, "contract_expiry_days": {"amber": 60, "red": 15}}'::jsonb,
        'Contractor performance view (0180): the amber and red thresholds of each measure and the least sample. Changed in Settings, Registers, Contractors.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION contractor_perf_thresholds_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'contractors.performance';
  RETURN jsonb_build_object('thresholds', coalesce(s.value, '{}'::jsonb),
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('contractors.performance'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_contractor_perf_thresholds(p_thresholds jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; k text; v jsonb; a numeric; r numeric; clean jsonb := '{}'::jsonb; ms numeric;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_thresholds IS NULL OR jsonb_typeof(p_thresholds) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds', 'invalid', 'An object.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_thresholds) LOOP
    IF k NOT IN ('min_sample', 'snag_overdue_pct', 'snag_return_pct', 'quality_fail_pct', 'contract_expiry_days') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/' || left(k, 40), 'unknown_key', 'Unknown key.')));
    END IF;
  END LOOP;
  -- the least sample: a whole number from 1 to 100
  IF jsonb_typeof(p_thresholds -> 'min_sample') IS DISTINCT FROM 'number' OR (p_thresholds ->> 'min_sample') !~ '^[0-9]{1,3}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/min_sample', 'out_of_range', 'A whole number from 1 to 100.')));
  END IF;
  ms := (p_thresholds ->> 'min_sample')::numeric;
  IF ms < 1 OR ms > 100 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/min_sample', 'out_of_range', 'A whole number from 1 to 100.')));
  END IF;
  clean := jsonb_build_object('min_sample', ms::integer);
  FOREACH k IN ARRAY ARRAY['snag_overdue_pct', 'snag_return_pct', 'quality_fail_pct', 'contract_expiry_days'] LOOP
    v := p_thresholds -> k;
    IF jsonb_typeof(v) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v -> 'amber') IS DISTINCT FROM 'number' OR jsonb_typeof(v -> 'red') IS DISTINCT FROM 'number'
       OR (v ->> 'amber') !~ '^[0-9]{1,3}$' OR (v ->> 'red') !~ '^[0-9]{1,3}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/' || k, 'invalid', 'An object with whole numbers amber and red, from 0 to 365.')));
    END IF;
    a := (v ->> 'amber')::numeric; r := (v ->> 'red')::numeric;
    IF a > 365 OR r > 365 OR (k <> 'contract_expiry_days' AND (a > 100 OR r > 100)) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/' || k, 'out_of_range', 'A percentage is from 0 to 100, days from 0 to 365.')));
    END IF;
    -- a percentage turns red above amber; the days left turn red below amber
    IF (k <> 'contract_expiry_days' AND r < a) OR (k = 'contract_expiry_days' AND r > a) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/' || k, 'order',
        CASE WHEN k = 'contract_expiry_days' THEN 'Red must not be more than amber.' ELSE 'Red must not be less than amber.' END)));
    END IF;
    clean := clean || jsonb_build_object(k, jsonb_build_object('amber', a::integer, 'red', r::integer));
  END LOOP;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('contractors.performance', clean, 'Contractor performance view (0180): thresholds and the least sample.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'contractors.performance' FOR UPDATE;
  cur := public.contractor_perf_thresholds_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur -> 'thresholds') = clean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The thresholds are already these.'));
  END IF;
  UPDATE public.settings SET value = clean, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'contractors.performance';
  res := public.contractor_perf_thresholds_json();
  PERFORM public.log_audit_write('contractor_performance_thresholds_update', 'setting', 'contractors.performance',
    jsonb_build_object('thresholds', cur -> 'thresholds', 'updated_at', cur -> 'updated_at', 'updated_by', cur -> 'updated_by'),
    jsonb_build_object('thresholds', res -> 'thresholds', 'updated_at', res -> 'updated_at', 'updated_by', res -> 'updated_by'), btrim(p_reason));
  RETURN res;
END $$;

-- The key changes only through admin_set_contractor_perf_thresholds (the guard function of 0072; an UPDATE is guarded on the old and the new key).
DROP TRIGGER IF EXISTS b_settings_contractor_perf ON settings;
DROP TRIGGER IF EXISTS b_settings_contractor_perf_update ON settings;
DROP TRIGGER IF EXISTS b_settings_contractor_perf_delete ON settings;
CREATE TRIGGER b_settings_contractor_perf BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'contractors.performance') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_contractor_perf_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'contractors.performance' OR NEW.key = 'contractors.performance') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_contractor_perf_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'contractors.performance') EXECUTE FUNCTION settings_guarded_keys();

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['contractor_perf_thresholds_json()', 'admin_set_contractor_perf_thresholds(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION contractor_perf_thresholds_json(), admin_set_contractor_perf_thresholds(jsonb, text, integer) TO pmis_app;
  END IF;
END $$;
