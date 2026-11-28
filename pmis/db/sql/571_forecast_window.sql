-- 0572_forecast_window (contract 0.15.431): the number of weeks the dashboard forecast averages is editable in Settings > Dashboard.
-- Mirror: db/sql/571_forecast_window.sql (kept byte-identical).
--
-- The forecast of the progress curve (the date the actual curve reaches 100 %) uses the mean weekly gain over the last N real weeks of the saved
-- snapshots. N was fixed at 4 in the web code (VELOCITY_WINDOW). It becomes the setting dashboard.forecast_window_weeks (a whole number 2 to 12, default 4).
-- This migration adds only a guarded reader and a guarded writer:
--   1. forecast_window_json(): weeks, version (the seconds of the last change, 0 when never changed), updated_at, updated_by.
--   2. admin_save_forecast_window(weeks, reason, version): admin.settings edit for all regions, a reason, If-Match, a whole number 2 to 12, one audit
--      row `forecast_window_update` with before and after.
-- The forecast is computed when the card is drawn. Snapshots already stored are never rewritten, and no forecast is stored.

CREATE OR REPLACE FUNCTION forecast_window_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; w int;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.forecast_window_weeks';
  w := coalesce((s.value #>> '{}')::int, 4);
  RETURN jsonb_build_object(
    'weeks', w,
    'version', CASE WHEN s.updated_by IS NULL THEN 0 ELSE floor(extract(epoch FROM s.updated_at))::int END,
    'updated_at', CASE WHEN s.updated_by IS NULL THEN NULL ELSE s.updated_at END,
    'updated_by', s.updated_by);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_forecast_window(p_weeks integer, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.forecast_window_weeks', '4', 'Settings review gap 4: the number of weeks (2 to 12) the dashboard forecast averages the weekly gain over.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.forecast_window_weeks' FOR UPDATE;
  cur := public.forecast_window_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_weeks IS NULL OR p_weeks < 2 OR p_weeks > 12 THEN
    errs := errs || public.reg_err_item('/weeks', 'invalid', 'A whole number from 2 to 12.');
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs));
  END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings SET value = to_jsonb(p_weeks), updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.forecast_window_weeks';
  after := public.forecast_window_json();
  PERFORM public.log_audit_write('forecast_window_update', 'setting', 'dashboard.forecast_window_weeks', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['forecast_window_json()', 'admin_save_forecast_window(integer,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['forecast_window_json()', 'admin_save_forecast_window(integer,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
