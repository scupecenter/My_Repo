-- 0570_snapshot_weekday (contract 0.15.430): the weekday of the weekly dashboard snapshot is editable in Settings > Dashboard.
-- Mirror: db/sql/569_snapshot_weekday.sql (kept byte-identical).
--
-- The weekday is the existing setting dashboard.snapshot_weekday (0 = Sunday ... 6 = Saturday, Africa/Tripoli dates; 4 = Thursday since 0059, D186).
-- The nightly job and the weekly-snapshot rule keep reading it exactly as before. dashboard.snapshot_every_days is documented as unused since 0046
-- (only the weekday drives the weekly snapshot, plus a month-end one), so it is NOT exposed: a field that changes nothing would be inert.
-- This migration adds only a guarded reader and a guarded writer:
--   1. snapshot_weekday_json(): weekday, version (the seconds of the last change, 0 when never changed), updated_at, updated_by.
--   2. admin_save_snapshot_weekday(weekday, reason, version): admin.settings edit for all regions, a reason, If-Match, a whole number 0 to 6, one audit
--      row `snapshot_weekday_update` with before and after.
-- A change decides on which day the NEXT weekly snapshot is taken. Snapshots already stored are never moved, rewritten or deleted.

CREATE OR REPLACE FUNCTION snapshot_weekday_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; w int;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.snapshot_weekday';
  w := coalesce((s.value #>> '{}')::int, 4);
  RETURN jsonb_build_object(
    'weekday', w,
    'version', CASE WHEN s.updated_by IS NULL THEN 0 ELSE floor(extract(epoch FROM s.updated_at))::int END,
    'updated_at', CASE WHEN s.updated_by IS NULL THEN NULL ELSE s.updated_at END,
    'updated_by', s.updated_by);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_snapshot_weekday(p_weekday integer, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.snapshot_weekday', '4', 'Q127: the weekday of the weekly dashboard snapshot (0 = Sunday ... 6 = Saturday), on the Africa/Tripoli date.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.snapshot_weekday' FOR UPDATE;
  cur := public.snapshot_weekday_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_weekday IS NULL OR p_weekday < 0 OR p_weekday > 6 THEN
    errs := errs || public.reg_err_item('/weekday', 'invalid', 'A whole number from 0 (Sunday) to 6 (Saturday).');
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs));
  END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings SET value = to_jsonb(p_weekday), updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.snapshot_weekday';
  after := public.snapshot_weekday_json();
  PERFORM public.log_audit_write('snapshot_weekday_update', 'setting', 'dashboard.snapshot_weekday', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['snapshot_weekday_json()', 'admin_save_snapshot_weekday(integer,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['snapshot_weekday_json()', 'admin_save_snapshot_weekday(integer,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
