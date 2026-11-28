-- 0574_health_bands (contract 0.15.435): the health index bands become editable in Settings > Dashboard.
-- Mirror: db/sql/573_health_bands.sql (kept byte-identical).
--
-- The bands live in the existing setting dashboard.health_bands ({"green":85,"amber":70}, migration 0039, Q35). No duplicate setting, no new table.
-- This migration adds only a guarded reader and a guarded writer:
--   1. health_bands_json(): green, amber, version (0 until the first save), updated_at, updated_by. Reads need nothing beyond what the caller of the REST
--      route already needs (dashboard.view, checked in the API).
--   2. admin_save_health_bands(green, amber, reason, version): admin.settings edit for all regions (calc_require_admin), a reason, If-Match (the version
--      is kept inside the setting), whole numbers 0 to 100 with green above amber, one audit row with before and after values.
-- Changing the bands only changes how the live score is coloured from now on. Stored history (weekly and month-end snapshots) is not rewritten.

CREATE OR REPLACE FUNCTION health_bands_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; v jsonb;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.health_bands';
  v := coalesce(s.value, '{"green":85,"amber":70}'::jsonb);
  RETURN jsonb_build_object(
    'green', coalesce((v ->> 'green')::int, 85),
    'amber', coalesce((v ->> 'amber')::int, 70),
    'version', coalesce((v ->> 'version')::int, 0),
    'updated_at', s.updated_at,
    'updated_by', s.updated_by);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_health_bands(p_green integer, p_amber integer, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.health_bands', '{"green":85,"amber":70}', 'Health index bands (Q35): green from this score, amber from this score, red below.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.health_bands' FOR UPDATE;
  cur := public.health_bands_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_green IS NULL OR p_green < 1 OR p_green > 100 THEN
    errs := errs || public.reg_err_item('/green', 'invalid', 'A whole number from 1 to 100.');
  END IF;
  IF p_amber IS NULL OR p_amber < 0 OR p_amber > 99 THEN
    errs := errs || public.reg_err_item('/amber', 'invalid', 'A whole number from 0 to 99.');
  END IF;
  IF jsonb_array_length(errs) = 0 AND p_green <= p_amber THEN
    errs := errs || public.reg_err_item('/green', 'invalid_order', 'Green must be above amber.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings
     SET value = jsonb_build_object('green', p_green, 'amber', p_amber, 'version', v + 1), updated_by = public.app_actor(), updated_at = now()
   WHERE key = 'dashboard.health_bands';
  after := public.health_bands_json();
  PERFORM public.log_audit_write('health_bands_update', 'setting', 'dashboard.health_bands', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['health_bands_json()', 'admin_save_health_bands(integer,integer,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['health_bands_json()', 'admin_save_health_bands(integer,integer,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
