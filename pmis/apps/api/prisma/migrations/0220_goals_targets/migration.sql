-- 0220_goals_targets: goals (targets) with automatic progress. Contract 0.15.120.
-- Mirror: db/sql/219_goals_targets.sql (kept identical to prisma/migrations/0220_goals_targets/migration.sql).
--
--   A goal says: "N sites reach milestone task X in region R during this month / quarter / year". The progress is never typed: it is counted from the approved
--   milestone tasks (the same rule as the On-Air counter: an approved task with an actual date in the period, active, not cancelled sites, distinct sites).
--   Goals live in the existing settings table under the key 'dashboard.goals' (no new table; the version is kept in the value, as for dashboard.settings, 0108).
--   Reader goals_json() = the stored goals plus the catalogue (milestone tasks and regions). Progress goals_progress() runs as the caller, so row-level security
--   limits the sites counted to the regions the caller may read (no permission is widened). Writer admin_save_goals(config, reason, version): admin.settings edit
--   for all regions, reason, If-Match, one audit row. pmis_app only executes these functions. Additive: nothing is changed or deleted.

CREATE OR REPLACE FUNCTION goals_catalogue() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'metrics', coalesce((SELECT jsonb_agg(jsonb_build_object('code', m.code, 'label_en', m.name_en, 'label_ar', coalesce(m.name_ar, m.name_en)) ORDER BY m.code)
                         FROM (SELECT DISTINCT ON (td.code) td.code, td.name_en, td.name_ar FROM public.task_definitions td
                               WHERE td.is_milestone_task AND td.is_active ORDER BY td.code, td.version DESC) m), '[]'::jsonb),
    'regions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name_en', r.name_en, 'name_ar', coalesce(r.name_ar, r.name_en)) ORDER BY r.id)
                         FROM public.regions r), '[]'::jsonb),
    'periods', '["month","quarter","year"]'::jsonb)
$$;

CREATE OR REPLACE FUNCTION goals_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'version', coalesce((SELECT (s.value ->> 'version')::int FROM public.settings s WHERE s.key = 'dashboard.goals'), 0),
    'goals', coalesce((SELECT s.value -> 'goals' FROM public.settings s WHERE s.key = 'dashboard.goals'), '[]'::jsonb),
    'updated_at', (SELECT s.updated_at FROM public.settings s WHERE s.key = 'dashboard.goals'),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'dashboard.goals'),
    'catalogue', public.goals_catalogue())
$$;

-- Progress of every active goal, counted as the caller (row-level security applies). expected = the share of the period that has passed.
CREATE OR REPLACE FUNCTION goals_progress() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  out jsonb := '[]'::jsonb; g jsonb; d0 date; d1 date; today date := public.cal_today(); n bigint; exp numeric; pct numeric; st text;
BEGIN
  FOR g IN SELECT e FROM jsonb_array_elements(public.goals_json() -> 'goals') e
           WHERE coalesce((e ->> 'active')::boolean, true) LOOP
    d0 := date_trunc(g ->> 'period', today)::date;
    d1 := (d0 + CASE g ->> 'period' WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months' ELSE interval '1 year' END)::date - 1;
    SELECT count(DISTINCT s.id) INTO n
      FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.sites s ON s.id = ti.site_id
      WHERE td.code = g ->> 'metric' AND ti.state::text = 'approved' AND ti.actual_date >= d0 AND ti.actual_date <= least(today, d1)
        AND s.is_active AND s.overall_status <> 'cancelled'
        AND (g -> 'region_id' IS NULL OR jsonb_typeof(g -> 'region_id') = 'null' OR s.region_id = (g ->> 'region_id')::int);
    exp := round(100.0 * (today - d0 + 1) / (d1 - d0 + 1), 1);
    pct := round(100.0 * n / (g ->> 'target')::numeric, 1);
    st := CASE WHEN pct >= 100 THEN 'achieved' WHEN pct >= exp THEN 'on_track' WHEN pct >= exp - 15 THEN 'at_risk' ELSE 'behind' END;
    out := out || jsonb_build_object('id', g ->> 'id', 'name_en', g ->> 'name_en', 'name_ar', g ->> 'name_ar', 'metric', g ->> 'metric',
             'region_id', g -> 'region_id', 'period', g ->> 'period', 'period_start', d0, 'period_end', d1, 'target', (g ->> 'target')::int,
             'actual', n, 'percent', pct, 'expected_percent', exp, 'status', st);
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION admin_save_goals(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; before jsonb; after jsonb; cat jsonb := public.goals_catalogue(); errs jsonb := '[]'::jsonb; g jsonb; i int := 0; v int; ids text[] := ARRAY[]::text[]; k text;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
    VALUES ('dashboard.goals', '{"version":0,"goals":[]}'::jsonb, 'Goals with automatic progress (migration 0220).', NULL, now()) ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.goals' FOR UPDATE;
  cur := public.goals_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR jsonb_typeof(p_config -> 'goals') IS DISTINCT FROM 'array' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/goals', 'required', 'A list of goals is required.')));
  END IF;
  IF jsonb_array_length(p_config -> 'goals') > 50 THEN errs := errs || public.reg_err_item('/goals', 'too_many', 'At most 50 goals.'); END IF;
  FOR g IN SELECT e FROM jsonb_array_elements(p_config -> 'goals') e LOOP
    i := i + 1;
    IF jsonb_typeof(g) <> 'object' THEN errs := errs || public.reg_err_item('/goals/' || i, 'invalid', 'An object.'); CONTINUE; END IF;
    FOR k IN SELECT jsonb_object_keys(g) LOOP
      IF k NOT IN ('id', 'name_en', 'name_ar', 'metric', 'region_id', 'period', 'target', 'active') THEN errs := errs || public.reg_err_item('/goals/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
    END LOOP;
    IF coalesce(g ->> 'id', '') !~ '^[a-z0-9-]{3,40}$' THEN errs := errs || public.reg_err_item('/goals/' || i || '/id', 'invalid', '3 to 40 characters: a-z, 0-9, hyphen.');
    ELSIF g ->> 'id' = ANY (ids) THEN errs := errs || public.reg_err_item('/goals/' || i || '/id', 'duplicate', 'Used twice.');
    ELSE ids := ids || (g ->> 'id'); END IF;
    IF jsonb_typeof(g -> 'name_en') IS DISTINCT FROM 'string' OR length(btrim(g ->> 'name_en')) NOT BETWEEN 1 AND 120 THEN errs := errs || public.reg_err_item('/goals/' || i || '/name_en', 'invalid', '1 to 120 characters.'); END IF;
    IF g ? 'name_ar' AND jsonb_typeof(g -> 'name_ar') NOT IN ('null', 'string') OR length(coalesce(g ->> 'name_ar', '')) > 120 THEN errs := errs || public.reg_err_item('/goals/' || i || '/name_ar', 'invalid', 'At most 120 characters.'); END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cat -> 'metrics') m WHERE m ->> 'code' = g ->> 'metric') THEN errs := errs || public.reg_err_item('/goals/' || i || '/metric', 'unknown_metric', 'Not a milestone task.'); END IF;
    IF g ? 'region_id' AND jsonb_typeof(g -> 'region_id') <> 'null' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cat -> 'regions') r WHERE r ->> 'id' = g ->> 'region_id') THEN errs := errs || public.reg_err_item('/goals/' || i || '/region_id', 'unknown_region', 'Not a region.'); END IF;
    IF coalesce(g ->> 'period', '') NOT IN ('month', 'quarter', 'year') THEN errs := errs || public.reg_err_item('/goals/' || i || '/period', 'invalid', 'month, quarter or year.'); END IF;
    IF jsonb_typeof(g -> 'target') IS DISTINCT FROM 'number' OR (g ->> 'target')::numeric < 1 OR (g ->> 'target')::numeric > 100000 OR (g ->> 'target')::numeric <> trunc((g ->> 'target')::numeric) THEN errs := errs || public.reg_err_item('/goals/' || i || '/target', 'invalid', 'A whole number from 1 to 100000.'); END IF;
    IF g ? 'active' AND jsonb_typeof(g -> 'active') <> 'boolean' THEN errs := errs || public.reg_err_item('/goals/' || i || '/active', 'invalid', 'true or false.'); END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := cur - 'catalogue' - 'updated_at' - 'updated_by';
  UPDATE public.settings SET value = jsonb_build_object('version', v + 1, 'goals', p_config -> 'goals'), updated_by = public.app_actor(), updated_at = now() WHERE key = 'dashboard.goals';
  after := public.goals_json();
  PERFORM public.log_audit_write('goals_update', 'setting', 'dashboard.goals', before, after - 'catalogue' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['goals_catalogue()', 'goals_json()', 'goals_progress()', 'admin_save_goals(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['goals_json()', 'goals_progress()', 'admin_save_goals(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- The Dashboard card "goals" joins the card catalogue (Settings, Screens, Dashboard lists it; a card no tab names is shown at the end). The catalogue function is
-- rewritten from its stored text, so a card another migration added stays; nothing else in it changes. Safe to run twice.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"goals"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"goals","label_en":"Goals with automatic progress","label_ar":"الأهداف مع التقدم التلقائي"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
