-- 0573_progress_rag (contract 0.15.432): green and amber thresholds for three progress figures of the dashboard, editable in Settings > Dashboard.
-- Mirror: db/sql/572_progress_rag.sql (kept byte-identical).
--
-- The three figures are: the progress vs plan index (SPI), the progress against plan in points (progress minus planned, can be negative) and the weekly velocity of
-- the progress curve (points per week). None of them has a colour today. Owner choice (relayed 2026-11-28): nothing changes on deploy. A figure is coloured
-- only after an admin turns it on and saves its thresholds; until then it stays as it is. The editor shows suggested numbers for each row (not stored).
-- They are NOT added to the 10-KPI catalogue of dashboard_settings_catalogue(): that catalogue also feeds the counters, the KPI alert rules and the rule that every
-- catalogue KPI must have a stored threshold, so three rows with no live counter behind them would break those. A separate setting does not collide with them.
-- This migration adds the setting dashboard.progress_rag and a guarded reader and a guarded writer:
--   1. progress_rag_catalogue(): the three codes, units, labels and the suggested numbers (higher is better for all three).
--   2. progress_rag_json(): per code enabled, green, amber (the suggestion when never saved) plus version (seconds of the last change, 0 when never saved).
--   3. admin_save_progress_rag(items, reason, version): admin.settings edit for all regions, reason, If-Match, every code present with enabled (boolean) and green and
--      amber (numbers inside the unit's range, green not below amber), one audit row `progress_rag_update` with before and after.
-- Nothing stored is rewritten: the colour is worked out when the figure is drawn.

CREATE OR REPLACE FUNCTION progress_rag_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT '[
    {"code":"spi","label_en":"Progress vs plan index (SPI)","label_ar":"مؤشر التقدم مقابل الخطة (SPI)","unit":"index","min":0,"max":5,"default_green":0.95,"default_amber":0.85},
    {"code":"progress_gap","label_en":"Progress against plan (points)","label_ar":"التقدم مقابل الخطة (نقاط)","unit":"points","min":-100,"max":100,"default_green":-2,"default_amber":-5},
    {"code":"velocity","label_en":"Weekly velocity (points per week)","label_ar":"السرعة الأسبوعية (نقاط في الأسبوع)","unit":"points_per_week","min":-100,"max":100,"default_green":1.5,"default_amber":0.75}
  ]'::jsonb
$$;

CREATE OR REPLACE FUNCTION progress_rag_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; items jsonb;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.progress_rag';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', e ->> 'code', 'label_en', e ->> 'label_en', 'label_ar', e ->> 'label_ar', 'unit', e ->> 'unit',
           'min', e -> 'min', 'max', e -> 'max',
           'default_green', e -> 'default_green', 'default_amber', e -> 'default_amber',
           'enabled', coalesce((s.value -> (e ->> 'code') ->> 'enabled')::boolean, false),
           'green', coalesce(s.value -> (e ->> 'code') -> 'green', e -> 'default_green'),
           'amber', coalesce(s.value -> (e ->> 'code') -> 'amber', e -> 'default_amber'))
         ORDER BY ord), '[]'::jsonb)
    INTO items FROM jsonb_array_elements(public.progress_rag_catalogue()) WITH ORDINALITY AS t(e, ord);
  RETURN jsonb_build_object(
    'items', items,
    'version', CASE WHEN s.updated_by IS NULL THEN 0 ELSE floor(extract(epoch FROM s.updated_at))::int END,
    'updated_at', CASE WHEN s.updated_by IS NULL THEN NULL ELSE s.updated_at END,
    'updated_by', s.updated_by);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_progress_rag(p_items jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int; e jsonb; k text; it jsonb; g numeric; a numeric; store jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.progress_rag', '{}'::jsonb, 'Settings review gap 5: green and amber thresholds of the SPI, the progress against plan and the weekly velocity. A figure is coloured only when enabled.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.progress_rag' FOR UPDATE;
  cur := public.progress_rag_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items', 'required', 'An object with one entry per figure.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_items) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.progress_rag_catalogue()) c WHERE c ->> 'code' = k) THEN
      errs := errs || public.reg_err_item('/items/' || k, 'unknown_key', 'Not one of the progress figures.');
    END IF;
  END LOOP;
  FOR e IN SELECT c FROM jsonb_array_elements(public.progress_rag_catalogue()) c LOOP
    k := e ->> 'code';
    it := p_items -> k;
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR jsonb_typeof(it -> 'enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(it -> 'green') IS DISTINCT FROM 'number' OR jsonb_typeof(it -> 'amber') IS DISTINCT FROM 'number' THEN
      errs := errs || public.reg_err_item('/items/' || k, 'required', 'enabled (true or false), green and amber (numbers) are required.');
      CONTINUE;
    END IF;
    g := (it ->> 'green')::numeric;
    a := (it ->> 'amber')::numeric;
    IF g < (e ->> 'min')::numeric OR g > (e ->> 'max')::numeric OR a < (e ->> 'min')::numeric OR a > (e ->> 'max')::numeric THEN
      errs := errs || public.reg_err_item('/items/' || k, 'invalid', 'Between ' || (e ->> 'min') || ' and ' || (e ->> 'max') || '.');
    ELSIF g < a THEN
      errs := errs || public.reg_err_item('/items/' || k, 'invalid_order', 'Green must not be below amber (higher is better for this figure).');
    ELSE
      store := store || jsonb_build_object(k, jsonb_build_object('enabled', (it ->> 'enabled')::boolean, 'green', g, 'amber', a));
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs));
  END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings SET value = store, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'dashboard.progress_rag';
  after := public.progress_rag_json();
  PERFORM public.log_audit_write('progress_rag_update', 'setting', 'dashboard.progress_rag', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['progress_rag_catalogue()', 'progress_rag_json()', 'admin_save_progress_rag(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['progress_rag_catalogue()', 'progress_rag_json()', 'admin_save_progress_rag(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
