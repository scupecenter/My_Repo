-- 0113_f20_counter_sources (contract 0.15.27, CHANGELOG 150): the last sources of the dashboard counters.
-- Mirror: db/sql/112_f20_counter_sources.sql (kept identical).
--
-- The seven counters that had no source (vehicle ready, advances open after close, Dismantle pending, As-Built against TE PAC, time in state at the
-- 85th percentile, stale tasks, On-Air against the monthly target) read the existing tables; their SQL is in dashboard-extras.service.ts. This
-- migration adds only what they need that did not exist:
--   1. stale_idle_days: the idle limit of the stale-task counter (CLAUDE.md B12b: a task idle N working days, default 2). It is a key of the
--      dashboard setting (migration 0108), an integer from 1 to 30. A save without it keeps the stored value, so the screen of 0.15.24 is unchanged.
--   2. cal_local_date(ts): the business date of a timestamp in calc.timezone (Africa/Tripoli by default), counted as cal_today() is.
--
-- The writer keeps every rule of 0108 (admin.settings edit for all regions, reason, If-Match, one audit row with before and after values).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The business date of a timestamp (the same zone as cal_today())
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cal_local_date(p_ts timestamptz) RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (p_ts AT TIME ZONE coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli'))::date
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The dashboard setting: stale_idle_days (default 2) in the reader and the writer of 0108
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dashboard_settings_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c jsonb := public.dashboard_settings_cfg();
  cat jsonb := public.dashboard_settings_catalogue();
  th jsonb;
  tabs jsonb := '{}'::jsonb;
  tb text;
BEGIN
  SELECT coalesce(jsonb_object_agg(e ->> 'code', coalesce(c -> 'thresholds' -> (e ->> 'code'),
           jsonb_build_object('green', e -> 'default_green', 'amber', e -> 'default_amber'))), '{}'::jsonb)
    INTO th FROM jsonb_array_elements(cat -> 'kpis') e;
  FOREACH tb IN ARRAY ARRAY['pmo', 'cw', 'te'] LOOP
    tabs := tabs || jsonb_build_object(tb, coalesce(c -> 'tabs' -> tb, '{"order":[],"hidden":[]}'::jsonb));
  END LOOP;
  RETURN jsonb_build_object(
    'version', coalesce((c ->> 'version')::int, 0),
    'targets', coalesce(c -> 'targets', '{"sites_per_batch":null,"monthly_on_air":null}'::jsonb),
    'thresholds', th,
    'tabs', tabs,
    'stale_idle_days', coalesce((c ->> 'stale_idle_days')::int, 2),
    'updated_at', (SELECT s.updated_at FROM public.settings s WHERE s.key = 'dashboard.settings'),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'dashboard.settings'),
    'catalogue', cat);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_dashboard_settings(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; before jsonb; after jsonb; cat jsonb := public.dashboard_settings_catalogue();
  errs jsonb := '[]'::jsonb; k text; x text; tab text; tb jsonb; el jsonb; kpi jsonb; th jsonb; g numeric; a numeric;
  seen text[]; v int; cards text[]; idle jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.settings' FOR UPDATE;
  cur := public.dashboard_settings_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with targets, thresholds and tabs.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('targets', 'thresholds', 'tabs', 'stale_idle_days') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  SELECT coalesce(array_agg(e ->> 'code'), ARRAY[]::text[]) INTO cards FROM jsonb_array_elements(cat -> 'cards') e;

  -- stale_idle_days: optional; when given, a whole number from 1 to 30. Absent = the stored value (default 2)
  IF p_config ? 'stale_idle_days' THEN
    IF jsonb_typeof(p_config -> 'stale_idle_days') <> 'number'
       OR (p_config ->> 'stale_idle_days')::numeric < 1 OR (p_config ->> 'stale_idle_days')::numeric > 30
       OR (p_config ->> 'stale_idle_days')::numeric <> trunc((p_config ->> 'stale_idle_days')::numeric) THEN
      errs := errs || public.reg_err_item('/stale_idle_days', 'invalid', 'A whole number from 1 to 30.');
    END IF;
  END IF;
  idle := coalesce(p_config -> 'stale_idle_days', to_jsonb(coalesce((cur ->> 'stale_idle_days')::int, 2)));

  -- targets: each is null or a whole number from 0 to 100000
  IF jsonb_typeof(p_config -> 'targets') IS DISTINCT FROM 'object' THEN
    errs := errs || public.reg_err_item('/targets', 'required', 'The targets are required.');
  ELSE
    FOREACH x IN ARRAY ARRAY['sites_per_batch', 'monthly_on_air'] LOOP
      IF NOT (p_config -> 'targets' ? x) THEN
        errs := errs || public.reg_err_item('/targets/' || x, 'required', 'A number or null is required.');
      ELSIF jsonb_typeof(p_config -> 'targets' -> x) = 'null' THEN
        NULL;
      ELSIF jsonb_typeof(p_config -> 'targets' -> x) <> 'number' THEN
        errs := errs || public.reg_err_item('/targets/' || x, 'invalid', 'A whole number from 0 to 100000, or null.');
      ELSIF (p_config -> 'targets' ->> x)::numeric < 0 OR (p_config -> 'targets' ->> x)::numeric > 100000
            OR (p_config -> 'targets' ->> x)::numeric <> trunc((p_config -> 'targets' ->> x)::numeric) THEN
        errs := errs || public.reg_err_item('/targets/' || x, 'invalid', 'A whole number from 0 to 100000, or null.');
      END IF;
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(p_config -> 'targets') LOOP
      IF k NOT IN ('sites_per_batch', 'monthly_on_air') THEN errs := errs || public.reg_err_item('/targets/' || k, 'unknown_key', 'Unknown key.'); END IF;
    END LOOP;
  END IF;

  -- thresholds: every catalogue KPI, green and amber in the KPI's unit, in the order its direction implies
  IF jsonb_typeof(p_config -> 'thresholds') IS DISTINCT FROM 'object' THEN
    errs := errs || public.reg_err_item('/thresholds', 'required', 'The thresholds are required.');
  ELSE
    FOR k IN SELECT jsonb_object_keys(p_config -> 'thresholds') LOOP
      SELECT e INTO kpi FROM jsonb_array_elements(cat -> 'kpis') e WHERE e ->> 'code' = k;
      IF kpi IS NULL THEN
        errs := errs || public.reg_err_item('/thresholds/' || k, 'unknown_kpi', 'Not a KPI of the catalogue.');
      ELSE
        th := p_config -> 'thresholds' -> k;
        IF jsonb_typeof(th) IS DISTINCT FROM 'object' OR NOT (th ? 'green') OR NOT (th ? 'amber') THEN
          errs := errs || public.reg_err_item('/thresholds/' || k, 'required', 'green and amber are required.');
        ELSIF jsonb_typeof(th -> 'green') <> 'number' OR jsonb_typeof(th -> 'amber') <> 'number' THEN
          errs := errs || public.reg_err_item('/thresholds/' || k, 'invalid', 'green and amber are numbers.');
        ELSE
          g := (th ->> 'green')::numeric;
          a := (th ->> 'amber')::numeric;
          IF g < 0 OR a < 0 OR g > 100000 OR a > 100000 THEN
            errs := errs || public.reg_err_item('/thresholds/' || k, 'invalid', 'Between 0 and 100000.');
          ELSIF ((kpi ->> 'direction') = 'higher' AND g < a) OR ((kpi ->> 'direction') = 'lower' AND g > a) THEN
            errs := errs || public.reg_err_item('/thresholds/' || k, 'invalid_order', 'Green must be better than amber for this KPI.');
          END IF;
        END IF;
      END IF;
    END LOOP;
    FOR kpi IN SELECT e FROM jsonb_array_elements(cat -> 'kpis') e LOOP
      IF NOT (p_config -> 'thresholds' ? (kpi ->> 'code')) THEN
        errs := errs || public.reg_err_item('/thresholds/' || (kpi ->> 'code'), 'missing_kpi', 'A threshold is required for this KPI.');
      END IF;
    END LOOP;
  END IF;

  -- tabs: each tab has order and hidden lists of catalogue card codes, no code twice in one tab
  IF jsonb_typeof(p_config -> 'tabs') IS DISTINCT FROM 'object' THEN
    errs := errs || public.reg_err_item('/tabs', 'required', 'The tabs are required.');
  ELSE
    FOREACH tab IN ARRAY ARRAY['pmo', 'cw', 'te'] LOOP
      tb := p_config -> 'tabs' -> tab;
      IF jsonb_typeof(tb) IS DISTINCT FROM 'object' THEN
        errs := errs || public.reg_err_item('/tabs/' || tab, 'required', 'order and hidden are required.');
      ELSE
        seen := ARRAY[]::text[];
        FOREACH x IN ARRAY ARRAY['order', 'hidden'] LOOP
          IF jsonb_typeof(tb -> x) IS DISTINCT FROM 'array' THEN
            errs := errs || public.reg_err_item('/tabs/' || tab || '/' || x, 'required', 'A list of card codes is required.');
          ELSIF jsonb_array_length(tb -> x) > 60 THEN
            errs := errs || public.reg_err_item('/tabs/' || tab || '/' || x, 'too_many', 'At most 60 cards.');
          ELSE
            FOR el IN SELECT * FROM jsonb_array_elements(tb -> x) LOOP
              IF jsonb_typeof(el) <> 'string' OR NOT ((el #>> '{}') = ANY (cards)) THEN
                errs := errs || public.reg_err_item('/tabs/' || tab || '/' || x, 'unknown_card', 'Not a card of the dashboard.');
              ELSIF (el #>> '{}') = ANY (seen) THEN
                errs := errs || public.reg_err_item('/tabs/' || tab || '/' || x, 'duplicate', 'This card is listed twice in the tab.');
              ELSE
                seen := seen || (el #>> '{}');
              END IF;
            END LOOP;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := cur - 'catalogue' - 'updated_at' - 'updated_by';
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('dashboard.settings', jsonb_build_object('targets', p_config -> 'targets', 'thresholds', p_config -> 'thresholds',
            'tabs', p_config -> 'tabs', 'stale_idle_days', idle, 'version', v + 1),
          'F20 (migrations 0108, 0113): dashboard targets, KPI thresholds, the cards of each tab and the stale-task idle limit.', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  after := public.dashboard_settings_json();
  PERFORM public.log_audit_write('dashboard_settings_update', 'setting', 'dashboard.settings', before,
    after - 'catalogue' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dashboard_settings_json()', 'admin_save_dashboard_settings(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['dashboard_settings_json()', 'admin_save_dashboard_settings(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
