-- F20 (contract 0.15.24, CHANGELOG 150): the global settings of the dashboard.
--
-- The settings live in the existing settings table under the key 'dashboard.settings' (no new table; the version is kept inside the value, as for
-- gecol.order_warnings in migration 0063). They hold:
--   targets     sites per batch and the monthly On-Air target (null = no target);
--   thresholds  green and amber for each KPI of the catalogue (higher is better or lower is better, from the KPI);
--   tabs        for PMO, CW and TE: the card codes in display order and the codes the tab hides. A card in the catalogue that no list names is shown
--               at the end, so a card added later appears by default.
-- The health index bands stay in dashboard.health_bands (no duplicate setting).
--
-- Readers and writer: dashboard_settings_catalogue(), dashboard_settings_json(), admin_save_dashboard_settings(config, reason, version).
-- The writer needs admin.settings edit for all regions (System Admin or a delegation), a reason, If-Match (the version) and writes one audit row
-- with before and after values. pmis_app only executes these functions.

CREATE OR REPLACE FUNCTION dashboard_settings_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'kpis', '[
      {"code":"sla_breach","label_en":"SLA breaches (open tasks past the maximum)","label_ar":"تجاوزات SLA (مهام مفتوحة تجاوزت الحد الأقصى)","unit":"pct","direction":"lower","default_green":5,"default_amber":10},
      {"code":"sla_at_risk","label_en":"SLA at risk (past the warning share)","label_ar":"SLA معرّض للخطر (تجاوز نسبة الإنذار)","unit":"pct","direction":"lower","default_green":10,"default_amber":20},
      {"code":"data_quality_gap","label_en":"Empty mandatory cells","label_ar":"خلايا إلزامية فارغة","unit":"pct","direction":"lower","default_green":2,"default_amber":5},
      {"code":"vehicle_ready","label_en":"Vehicle-ready rate of assignments","label_ar":"نسبة جاهزية المركبة للمهام الميدانية","unit":"pct","direction":"higher","default_green":90,"default_amber":75},
      {"code":"advances_open_after_close","label_en":"Advances open after the work closed","label_ar":"سلفيات مفتوحة بعد إغلاق العمل","unit":"count","direction":"lower","default_green":0,"default_amber":3},
      {"code":"dismantle_pending","label_en":"Dismantle CW and TE pending","label_ar":"تفكيك CW وTE المعلّق","unit":"count","direction":"lower","default_green":0,"default_amber":5},
      {"code":"as_built_submitted","label_en":"As-Built submitted against PAC","label_ar":"As-Built المقدَّم مقابل PAC","unit":"pct","direction":"higher","default_green":90,"default_amber":70},
      {"code":"time_in_state_p85","label_en":"Time in state, 85th percentile","label_ar":"الزمن في الحالة، المئين 85","unit":"days","direction":"lower","default_green":10,"default_amber":20},
      {"code":"stale_tasks","label_en":"Stale tasks (idle for N working days)","label_ar":"مهام راكدة (خاملة لعدد من أيام العمل)","unit":"pct","direction":"lower","default_green":5,"default_amber":10},
      {"code":"on_air_vs_target","label_en":"On-Air against the monthly target","label_ar":"الربط On-Air مقابل الهدف الشهري","unit":"pct","direction":"higher","default_green":100,"default_amber":80}
    ]'::jsonb,
    'cards', '[
      {"code":"site_map","label_en":"Site map","label_ar":"خريطة المواقع"},
      {"code":"f13","label_en":"Risk matrix, data quality, decisions, swap and relocation","label_ar":"مصفوفة المخاطر وجودة البيانات والقرارات والاستبدال والنقل"},
      {"code":"headline","label_en":"Headline KPIs","label_ar":"المؤشرات الرئيسية"},
      {"code":"pipeline","label_en":"Milestone pipeline","label_ar":"مسار المعالم"},
      {"code":"health_ps","label_en":"Health index and Project Status","label_ar":"مؤشر الصحة وحالة المشروع"},
      {"code":"streams","label_en":"Streams","label_ar":"المسارات"},
      {"code":"sla","label_en":"SLA per stage and top late tasks","label_ar":"SLA لكل مرحلة وأهم المهام المتأخرة"},
      {"code":"gates_issues_delay","label_en":"Blocked gates, issues and delay attribution","label_ar":"البوابات المعطلة والقضايا وتوزيع التأخير"},
      {"code":"regions","label_en":"Regions","label_ar":"المناطق"}
    ]'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION dashboard_settings_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT s.value FROM public.settings s WHERE s.key = 'dashboard.settings'), '{}'::jsonb)
$$;

-- The setting as the API returns it: stored values, with the catalogue defaults filled in for each KPI that has no stored threshold.
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
  seen text[]; v int; cards text[];
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
    IF k NOT IN ('targets', 'thresholds', 'tabs') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  SELECT coalesce(array_agg(e ->> 'code'), ARRAY[]::text[]) INTO cards FROM jsonb_array_elements(cat -> 'cards') e;

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
            'tabs', p_config -> 'tabs', 'version', v + 1),
          'F20 (migration 0108): dashboard targets, KPI thresholds and the cards of each tab.', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  after := public.dashboard_settings_json();
  PERFORM public.log_audit_write('dashboard_settings_update', 'setting', 'dashboard.settings', before,
    after - 'catalogue' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

-- The seed row: no targets, no stored thresholds (the catalogue defaults apply), no card overrides.
INSERT INTO public.settings (key, value, description, updated_by, updated_at)
VALUES ('dashboard.settings', '{"version":0,"targets":{"sites_per_batch":null,"monthly_on_air":null},"thresholds":{},"tabs":{}}'::jsonb,
        'F20 (migration 0108): dashboard targets, KPI thresholds and the cards of each tab.', NULL, now())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dashboard_settings_catalogue()', 'dashboard_settings_cfg()', 'dashboard_settings_json()', 'admin_save_dashboard_settings(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['dashboard_settings_json()', 'admin_save_dashboard_settings(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
