-- 0612_forecast_method (contract 0.15.474): the method of the dashboard forecast is editable in Settings > Dashboard.
-- Mirror: db/sql/611_forecast_method.sql (kept byte-identical).
--
-- The forecast of the progress curve (the date the actual curve reaches 100 %) takes a weekly pace from the saved snapshots. Until now that was the mean weekly
-- gain over the last weeks. The setting dashboard.forecast_method chooses the method: 'mean' (the mean weekly gain, the value that was fixed in the web code,
-- the default) or 'linear' (the slope of a straight line fitted through the actual points of the same last weeks).
-- This migration adds only a guarded reader and a guarded writer:
--   1. forecast_method_json(): method, version (the seconds of the last change, 0 when never changed), updated_at, updated_by.
--   2. admin_save_forecast_method(method, reason, version): admin.settings edit for all regions, a reason, If-Match, 'mean' or 'linear', one audit row
--      `forecast_method_update` with before and after.
-- The forecast is computed when the card is drawn. Snapshots already stored are never rewritten, and no forecast is stored. No new table.

CREATE OR REPLACE FUNCTION forecast_method_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; m text;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.forecast_method';
  m := coalesce(s.value #>> '{}', 'mean');
  RETURN jsonb_build_object(
    'method', m,
    'version', CASE WHEN s.updated_by IS NULL THEN 0 ELSE floor(extract(epoch FROM s.updated_at))::int END,
    'updated_at', CASE WHEN s.updated_by IS NULL THEN NULL ELSE s.updated_at END,
    'updated_by', s.updated_by);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_forecast_method(p_method text, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.forecast_method', to_jsonb('mean'::text), 'Phase 5: the method of the dashboard forecast: mean (the mean weekly gain) or linear (a straight line fitted through the last weeks).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.forecast_method' FOR UPDATE;
  cur := public.forecast_method_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_method IS NULL OR p_method NOT IN ('mean', 'linear') THEN
    errs := errs || public.reg_err_item('/method', 'invalid', 'mean or linear.');
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs));
  END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings SET value = to_jsonb(p_method), updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.forecast_method';
  after := public.forecast_method_json();
  PERFORM public.log_audit_write('forecast_method_update', 'setting', 'dashboard.forecast_method', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['forecast_method_json()', 'admin_save_forecast_method(text,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['forecast_method_json()', 'admin_save_forecast_method(text,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
