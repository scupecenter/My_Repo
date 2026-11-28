-- 0714_site_health_score (contract 0.15.591): one health number and colour per site. Mirror: db/sql/713_site_health_score.sql (kept byte-identical).
--
-- Reuses what exists: the colour bands are the setting dashboard.health_bands (green from 85, amber from 70, editable since 0574); the factors are read
-- from the same tables as the project health index (task_instances with the SLA clock, document_slots, snags, task_delay_periods). No second band
-- setting, no new table. This migration adds:
--   1. The setting dashboard.site_health_weights {"tasks":40,"docs":20,"snags":25,"delay":15,"version":0}: how much each of the four site factors counts.
--      A factor with no data for a site is left out and its weight is shared by the others (same rule as the project index).
--   2. site_health_weights_json() and admin_save_site_health_weights(...): guarded reader and writer (admin.settings, reason, If-Match, one audit row).
--   3. site_health_scores(regions, region, band, search, limit, offset): the list, worst score first, region scope respected.
--      site_health_detail(site, regions): the four factors of one site with their counts, the numbers behind the score.
-- Factors (each 0 to 100, higher is better), per site, as of today (cal_today()):
--   tasks  share of SLA clocks inside the limit: closed on time, plus open tasks not past their due date, over closed and open tasks with a due date.
--   docs   share of mandatory document slots of approved tasks that are approved.
--   snags  100 minus 30 per open critical, 15 per open major and 5 per other open snag, never below 0 (open = open, fix_uploaded, in_review).
--   delay  100 minus 10 per calendar day of the site's delay periods (not voided) that fall in the last 30 days, never below 0.
-- Tasks closed by an admin override are left out, like the project index leaves them out by default.

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('dashboard.site_health_weights', '{"tasks":40,"docs":20,"snags":25,"delay":15,"version":0}',
   'Site health score: how much the four factors (tasks on time, documents, open snags, delay periods) count. The colour bands are dashboard.health_bands.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION site_health_weights_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; v jsonb;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.site_health_weights';
  v := coalesce(s.value, '{"tasks":40,"docs":20,"snags":25,"delay":15}'::jsonb);
  RETURN jsonb_build_object(
    'tasks', coalesce((v ->> 'tasks')::int, 40), 'docs', coalesce((v ->> 'docs')::int, 20),
    'snags', coalesce((v ->> 'snags')::int, 25), 'delay', coalesce((v ->> 'delay')::int, 15),
    'version', coalesce((v ->> 'version')::int, 0), 'updated_at', s.updated_at, 'updated_by', s.updated_by);
END
$$;

CREATE OR REPLACE FUNCTION admin_save_site_health_weights(p_tasks integer, p_docs integer, p_snags integer, p_delay integer, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int; k text; n int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.site_health_weights', '{"tasks":40,"docs":20,"snags":25,"delay":15,"version":0}', 'Site health score weights.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.site_health_weights' FOR UPDATE;
  cur := public.site_health_weights_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  FOR k, n IN SELECT * FROM (VALUES ('tasks', p_tasks), ('docs', p_docs), ('snags', p_snags), ('delay', p_delay)) AS t(k, n) LOOP
    IF n IS NULL OR n < 0 OR n > 100 THEN errs := errs || public.reg_err_item('/' || k, 'invalid', 'A whole number from 0 to 100.'); END IF;
  END LOOP;
  IF jsonb_array_length(errs) = 0 AND coalesce(p_tasks, 0) + coalesce(p_docs, 0) + coalesce(p_snags, 0) + coalesce(p_delay, 0) = 0 THEN
    errs := errs || public.reg_err_item('/tasks', 'all_zero', 'At least one factor must count.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings
     SET value = jsonb_build_object('tasks', p_tasks, 'docs', p_docs, 'snags', p_snags, 'delay', p_delay, 'version', v + 1),
         updated_by = public.app_actor(), updated_at = now()
   WHERE key = 'dashboard.site_health_weights';
  after := public.site_health_weights_json();
  PERFORM public.log_audit_write('site_health_weights_update', 'setting', 'dashboard.site_health_weights', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

-- One row per site with its four factors and the score. p_regions NULL = every region (the caller's scope is passed by the API).
CREATE OR REPLACE FUNCTION site_health_rows(p_regions integer[], p_region integer, p_site uuid) RETURNS TABLE (
  site_id uuid, site_code text, site_name text, region_id integer, status text,
  f_tasks numeric, n_tasks integer, f_docs numeric, n_docs integer, f_snags numeric, n_snags integer, f_delay numeric, n_delay integer, score numeric, band text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w jsonb := public.site_health_weights_json(); b jsonb := public.calc_setting('dashboard.health_bands', '{"green":85,"amber":70}'::jsonb);
  green numeric := coalesce((b ->> 'green')::numeric, 85); amber numeric := coalesce((b ->> 'amber')::numeric, 70); today date := public.cal_today();
BEGIN
  RETURN QUERY
  WITH s AS (
    SELECT x.id, x.site_code, x.name, x.region_id, x.status::text AS status FROM public.sites x
    WHERE x.status::text <> 'cancelled' AND (p_regions IS NULL OR x.region_id = ANY (p_regions)) AND (p_region IS NULL OR x.region_id = p_region)
      AND (p_site IS NULL OR x.id = p_site)
  ), tk AS (
    SELECT t.site_id,
      count(*) FILTER (WHERE t.state::text = 'approved' AND t.sla_elapsed_wd IS NOT NULL AND r.max_working_days IS NOT NULL) AS closed_n,
      count(*) FILTER (WHERE t.state::text = 'approved' AND t.sla_elapsed_wd IS NOT NULL AND r.max_working_days IS NOT NULL AND t.sla_elapsed_wd <= r.max_working_days) AS closed_ok,
      count(*) FILTER (WHERE t.state::text <> 'approved' AND t.due_date IS NOT NULL AND t.sla_start_date IS NOT NULL AND t.sla_start_date <= today) AS open_n,
      count(*) FILTER (WHERE t.state::text <> 'approved' AND t.due_date IS NOT NULL AND t.sla_start_date IS NOT NULL AND t.sla_start_date <= today AND t.due_date >= today) AS open_ok
    FROM public.task_instances t JOIN s ON s.id = t.site_id LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
    WHERE t.state::text NOT IN ('locked', 'na', 'skipped') AND NOT t.is_na AND NOT t.admin_override GROUP BY t.site_id
  ), dc AS (
    SELECT t.site_id, count(*) AS n, count(*) FILTER (WHERE ds.status = 'approved') AS ok
    FROM public.task_instances t JOIN s ON s.id = t.site_id
    JOIN public.document_slots ds ON ds.task_id = t.id JOIN public.document_types dt ON dt.id = ds.doc_type_id AND dt.is_mandatory
    WHERE t.state::text = 'approved' AND NOT t.admin_override GROUP BY t.site_id
  ), sg AS (
    SELECT n.site_id, count(*) AS n,
      sum(CASE lower(coalesce(n.severity, '')) WHEN 'critical' THEN 30 WHEN 'major' THEN 15 ELSE 5 END) AS pen
    FROM public.snags n JOIN s ON s.id = n.site_id WHERE n.status IN ('open', 'fix_uploaded', 'in_review') GROUP BY n.site_id
  ), dl AS (
    SELECT d.site_id, count(*) AS n,
      sum(least(d.to_date, today) - greatest(d.from_date, today - 29) + 1) AS days
    FROM public.task_delay_periods d JOIN s ON s.id = d.site_id
    WHERE d.voided_at IS NULL AND d.to_date >= today - 29 AND d.from_date <= today GROUP BY d.site_id
  ), f AS (
    SELECT s.*,
      CASE WHEN coalesce(tk.closed_n, 0) + coalesce(tk.open_n, 0) > 0
           THEN round(100.0 * (coalesce(tk.closed_ok, 0) + coalesce(tk.open_ok, 0)) / (tk.closed_n + tk.open_n), 2) END AS ft,
      coalesce(tk.closed_n, 0) + coalesce(tk.open_n, 0) AS nt,
      CASE WHEN coalesce(dc.n, 0) > 0 THEN round(100.0 * dc.ok / dc.n, 2) END AS fd, coalesce(dc.n, 0)::integer AS nd,
      -- snags and delay always have data: no open snag and no delay period is a full 100
      greatest(0, 100 - coalesce(sg.pen, 0))::numeric AS fs, coalesce(sg.n, 0)::integer AS ns,
      greatest(0, 100 - 10 * coalesce(dl.days, 0))::numeric AS fl, coalesce(dl.n, 0)::integer AS nl
    FROM s LEFT JOIN tk ON tk.site_id = s.id LEFT JOIN dc ON dc.site_id = s.id LEFT JOIN sg ON sg.site_id = s.id LEFT JOIN dl ON dl.site_id = s.id
  ), sc AS (
    SELECT f.*, round(
      (coalesce((w ->> 'tasks')::numeric * f.ft, 0) + coalesce((w ->> 'docs')::numeric * f.fd, 0) + (w ->> 'snags')::numeric * f.fs + (w ->> 'delay')::numeric * f.fl)
      / nullif(CASE WHEN f.ft IS NULL THEN 0 ELSE (w ->> 'tasks')::numeric END + CASE WHEN f.fd IS NULL THEN 0 ELSE (w ->> 'docs')::numeric END
               + (w ->> 'snags')::numeric + (w ->> 'delay')::numeric, 0), 1) AS sc
    FROM f
  )
  SELECT sc.id, sc.site_code, sc.name, sc.region_id, sc.status, sc.ft, sc.nt::integer, sc.fd, sc.nd, sc.fs, sc.ns, sc.fl, sc.nl, sc.sc,
         CASE WHEN sc.sc IS NULL THEN NULL WHEN sc.sc >= green THEN 'green' WHEN sc.sc >= amber THEN 'amber' ELSE 'red' END
  FROM sc;
END
$$;

CREATE OR REPLACE FUNCTION site_health_scores(p_regions integer[], p_region integer, p_band text, p_search text, p_limit integer, p_offset integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out_ jsonb; lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); off_ integer := greatest(coalesce(p_offset, 0), 0);
  b jsonb := public.calc_setting('dashboard.health_bands', '{"green":85,"amber":70}'::jsonb);
BEGIN
  IF p_band IS NOT NULL AND p_band NOT IN ('green', 'amber', 'red') THEN
    PERFORM public.sv_fail('validation_failed', 'Unknown band.', '{"errors":[{"path":"/band","code":"invalid"}]}');
  END IF;
  WITH r AS (
    SELECT * FROM public.site_health_rows(p_regions, p_region, NULL)
    WHERE (p_band IS NULL OR band = p_band)
      AND (nullif(btrim(coalesce(p_search, '')), '') IS NULL OR site_code ILIKE '%' || btrim(p_search) || '%' OR site_name ILIKE '%' || btrim(p_search) || '%')
  ), pg AS (SELECT * FROM r ORDER BY score NULLS LAST, site_code LIMIT lim OFFSET off_)
  SELECT jsonb_build_object(
    'bands', jsonb_build_object('green', coalesce((b ->> 'green')::int, 85), 'amber', coalesce((b ->> 'amber')::int, 70)),
    'weights', (public.site_health_weights_json() - 'updated_at' - 'updated_by'),
    'total', (SELECT count(*) FROM r),
    'counts', jsonb_build_object('green', (SELECT count(*) FROM r WHERE band = 'green'), 'amber', (SELECT count(*) FROM r WHERE band = 'amber'),
                                 'red', (SELECT count(*) FROM r WHERE band = 'red'), 'unscored', (SELECT count(*) FROM r WHERE band IS NULL)),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('site_id', pg.site_id, 'site_code', pg.site_code, 'site_name', pg.site_name, 'region_id', pg.region_id,
        'score', pg.score, 'band', pg.band, 'tasks', pg.f_tasks, 'docs', pg.f_docs, 'snags', pg.f_snags, 'delay', pg.f_delay)
        ORDER BY pg.score NULLS LAST, pg.site_code) FROM pg), '[]'::jsonb))
  INTO out_;
  RETURN out_;
END
$$;

CREATE OR REPLACE FUNCTION site_health_detail(p_site uuid, p_regions integer[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; b jsonb := public.calc_setting('dashboard.health_bands', '{"green":85,"amber":70}'::jsonb); w jsonb := public.site_health_weights_json();
BEGIN
  SELECT * INTO r FROM public.site_health_rows(p_regions, NULL, p_site);
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  RETURN jsonb_build_object(
    'site_id', r.site_id, 'site_code', r.site_code, 'site_name', r.site_name, 'region_id', r.region_id, 'score', r.score, 'band', r.band,
    'bands', jsonb_build_object('green', coalesce((b ->> 'green')::int, 85), 'amber', coalesce((b ->> 'amber')::int, 70)),
    'factors', jsonb_build_array(
      jsonb_build_object('code', 'tasks', 'weight', (w ->> 'tasks')::int, 'value', r.f_tasks, 'count', r.n_tasks, 'excluded', r.f_tasks IS NULL),
      jsonb_build_object('code', 'docs', 'weight', (w ->> 'docs')::int, 'value', r.f_docs, 'count', r.n_docs, 'excluded', r.f_docs IS NULL),
      jsonb_build_object('code', 'snags', 'weight', (w ->> 'snags')::int, 'value', r.f_snags, 'count', r.n_snags, 'excluded', false),
      jsonb_build_object('code', 'delay', 'weight', (w ->> 'delay')::int, 'value', r.f_delay, 'count', r.n_delay, 'excluded', false)));
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['site_health_weights_json()', 'admin_save_site_health_weights(integer,integer,integer,integer,text,integer)',
    'site_health_rows(integer[],integer,uuid)', 'site_health_scores(integer[],integer,text,text,integer,integer)', 'site_health_detail(uuid,integer[])'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['site_health_weights_json()', 'admin_save_site_health_weights(integer,integer,integer,integer,text,integer)',
      'site_health_scores(integer[],integer,text,text,integer,integer)', 'site_health_detail(uuid,integer[])'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- The dashboard card "Site health" (code site_health) joins the settings catalogue, so it can be shown, hidden and ordered per tab in Settings > Dashboard
-- and in the personal layouts. Idempotent (the catalogue function accumulates: patched, never redefined). A card no saved list names is shown at the end.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"site_health"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"site_health","label_en":"Site health: one score and colour per site","label_ar":"صحة المواقع: درجة ولون لكل موقع"},{"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
