-- 0623_stage_times: time in each stage of a site, and the slowest stages ranked (contract 0.15.482). Additive, read only: two functions, no table, no setting.
-- Mirror: db/sql/622_stage_times.sql (kept identical to prisma/migrations/0623_stage_times/migration.sql).
--
-- WHAT. A stage is the work between its first start and the approval of its last counted task. Per site: for each stage the first start (the earliest actual
-- start, else the earliest submission or actual date of its tasks that apply), the finish (the latest approval date, only when every counted task that
-- applies is approved), the days (calendar days; an open stage counts up to today), the planned days (earliest planned start to latest planned date) and the
-- rank, slowest first. Across sites: per stage, the finished stages (how many, average, 85th percentile, worst) and the open ones (how many, average age),
-- ranked by the average of the finished ones.
-- WHO. view on the sites module, limited to the caller's regions (a site outside them answers 404). Nothing is written.

CREATE OR REPLACE FUNCTION public.stage_times_rows(p_regs int[], p_site uuid, p_region integer) RETURNS TABLE (
  site_id uuid, region_id integer, stage_code text, seq integer, name_en text, name_ar text, started date, finished date, planned_start date, planned_end date, tasks integer, done integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.region_id, sd.code, sd.seq, sd.name_en, sd.name_ar,
         min(coalesce(t.actual_start, t.submitted_date, t.actual_date)) FILTER (WHERE NOT t.is_na) AS started,
         CASE WHEN count(*) FILTER (WHERE NOT t.is_na AND td.counts_toward_milestone) > 0
                   AND count(*) FILTER (WHERE NOT t.is_na AND td.counts_toward_milestone AND t.state <> 'approved') = 0
              THEN max(coalesce(t.approved_date, t.actual_date)) FILTER (WHERE NOT t.is_na) END AS finished,
         min(t.planned_start) FILTER (WHERE NOT t.is_na) AS planned_start, max(t.planned_date) FILTER (WHERE NOT t.is_na) AS planned_end,
         (count(*) FILTER (WHERE NOT t.is_na))::int AS tasks, (count(*) FILTER (WHERE NOT t.is_na AND t.state = 'approved'))::int AS done
    FROM public.sites s
    JOIN public.stage_definitions sd ON sd.workflow_id = s.workflow_version_id AND sd.is_active
    JOIN public.task_definitions td ON td.stage_id = sd.id AND td.is_active
    JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id
   WHERE s.is_active AND s.overall_status IS DISTINCT FROM 'cancelled'
     AND (p_regs IS NULL OR s.region_id = ANY (p_regs)) AND (p_site IS NULL OR s.id = p_site) AND (p_region IS NULL OR s.region_id = p_region)
   GROUP BY s.id, s.region_id, sd.code, sd.seq, sd.name_en, sd.name_ar
$$;

CREATE OR REPLACE FUNCTION public.site_stage_times(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); regs int[]; today date := public.cal_today(); code text; rows jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN PERFORM public.wf_err('action_forbidden'); END IF;
  SELECT s.site_code INTO code FROM public.sites s WHERE s.id = p_site AND (regs IS NULL OR s.region_id = ANY (regs));
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.stage_code, 'seq', x.seq, 'name_en', x.name_en, 'name_ar', x.name_ar,
           'state', CASE WHEN x.finished IS NOT NULL THEN 'done' WHEN x.started IS NOT NULL THEN 'open' ELSE 'not_started' END,
           'started', x.started, 'finished', x.finished, 'days', x.days, 'planned_days', x.pdays, 'over_plan_days', CASE WHEN x.days IS NOT NULL AND x.pdays IS NOT NULL THEN x.days - x.pdays END,
           'tasks', x.tasks, 'done', x.done, 'rank', x.rk) ORDER BY x.seq), '[]'::jsonb)
    INTO rows
    FROM (SELECT y.*, CASE WHEN y.days IS NOT NULL THEN (rank() OVER (ORDER BY y.days DESC NULLS LAST))::int END AS rk
            FROM (SELECT r.*, CASE WHEN r.started IS NOT NULL THEN greatest(coalesce(r.finished, today) - r.started, 0) END AS days,
                         CASE WHEN r.planned_start IS NOT NULL AND r.planned_end IS NOT NULL THEN greatest(r.planned_end - r.planned_start, 0) END AS pdays
                    FROM public.stage_times_rows(regs, p_site, NULL) r) y) x;
  RETURN jsonb_build_object('site_id', p_site, 'site_code', code, 'as_of', today, 'stages', rows);
END $$;

CREATE OR REPLACE FUNCTION public.stage_times_report(p_region integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); regs int[]; today date := public.cal_today(); res jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN PERFORM public.wf_err('action_forbidden'); END IF;
  WITH _st AS MATERIALIZED (
    SELECT r.site_id, r.region_id, r.stage_code, r.seq, r.name_en, r.name_ar, r.started, r.finished, greatest(coalesce(r.finished, today) - r.started, 0) AS days
      FROM public.stage_times_rows(regs, NULL, p_region) r WHERE r.started IS NOT NULL)
  SELECT jsonb_build_object('as_of', today, 'region_id', p_region,
    'stages', coalesce((SELECT jsonb_agg(jsonb_build_object('code', g.stage_code, 'seq', g.seq, 'name_en', g.name_en, 'name_ar', g.name_ar,
                'finished', g.nfin, 'avg_days', g.avg_d, 'p85_days', g.p85, 'worst_days', g.worst, 'open', g.nopen, 'open_avg_days', g.open_avg,
                'rank', g.rk) ORDER BY g.avg_d DESC NULLS LAST, g.seq)
              FROM (SELECT h.*, CASE WHEN h.avg_d IS NOT NULL THEN (rank() OVER (ORDER BY h.avg_d DESC NULLS LAST))::int END AS rk
                    FROM (SELECT stage_code, min(seq) AS seq, min(name_en) AS name_en, min(name_ar) AS name_ar,
                           (count(*) FILTER (WHERE finished IS NOT NULL))::int AS nfin, round(avg(days) FILTER (WHERE finished IS NOT NULL), 1) AS avg_d,
                           round((percentile_cont(0.85) WITHIN GROUP (ORDER BY days) FILTER (WHERE finished IS NOT NULL))::numeric, 1) AS p85,
                           max(days) FILTER (WHERE finished IS NOT NULL) AS worst, (count(*) FILTER (WHERE finished IS NULL))::int AS nopen,
                           round(avg(days) FILTER (WHERE finished IS NULL), 1) AS open_avg FROM _st GROUP BY stage_code) h) g), '[]'::jsonb),
    'slowest_sites', coalesce((SELECT jsonb_agg(jsonb_build_object('site_id', w.site_id, 'site_code', w.site_code, 'region_id', w.region_id, 'code', w.stage_code,
                'name_en', w.name_en, 'name_ar', w.name_ar, 'days', w.days, 'open', w.finished IS NULL) ORDER BY w.days DESC, w.site_code, w.seq)
              FROM (SELECT x.*, s.site_code FROM _st x JOIN public.sites s ON s.id = x.site_id ORDER BY x.days DESC, s.site_code, x.seq LIMIT 25) w), '[]'::jsonb)) INTO res;
  RETURN res;
END $$;

GRANT SELECT ON public.sites, public.stage_definitions, public.task_definitions, public.task_instances TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['stage_times_rows(int[],uuid,integer)', 'site_stage_times(uuid)', 'stage_times_report(integer)'] LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.site_stage_times(uuid), public.stage_times_report(integer) TO pmis_app;
    REVOKE ALL ON FUNCTION public.stage_times_rows(int[], uuid, integer) FROM pmis_app;
  END IF;
END $$;
