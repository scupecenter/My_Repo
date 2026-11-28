-- 0624_site_compare: two sites side by side (contract 0.15.483). Additive, read only: one function, no table, no setting. Stacked on 0623 (it reads the stage times).
-- Mirror: db/sql/623_site_compare.sql (kept identical to prisma/migrations/0624_site_compare/migration.sql).
--
-- WHAT. For two sites: identity (code, names, region, status, milestone, scenario, phase), task counts (that apply, approved, open, overdue, the worst delay in
-- calendar days against the planned date), and the stages of 0623 merged by code with the days of each side and the difference (second minus first).
-- WHO. view on the sites module, the caller's regions; a site outside them answers 404 for the pair. The same site twice is a validation error. Nothing is written.

CREATE OR REPLACE FUNCTION public.site_compare(p_a uuid, p_b uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); regs int[]; today date := public.cal_today(); sa jsonb; sb jsonb; ta jsonb; tb jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/b', 'code', 'invalid', 'message', 'Two different sites.'))));
  END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN PERFORM public.wf_err('action_forbidden'); END IF;
  SELECT jsonb_build_object('id', s.id, 'site_code', s.site_code, 'name', s.name, 'name_ar', s.name_ar, 'region_id', s.region_id, 'status', s.overall_status,
           'current_milestone', s.current_milestone, 'delivery_scenario', s.delivery_scenario, 'project_phase', s.project_phase)
    INTO sa FROM public.sites s WHERE s.id = p_a AND (regs IS NULL OR s.region_id = ANY (regs));
  IF sa IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  SELECT jsonb_build_object('id', s.id, 'site_code', s.site_code, 'name', s.name, 'name_ar', s.name_ar, 'region_id', s.region_id, 'status', s.overall_status,
           'current_milestone', s.current_milestone, 'delivery_scenario', s.delivery_scenario, 'project_phase', s.project_phase)
    INTO sb FROM public.sites s WHERE s.id = p_b AND (regs IS NULL OR s.region_id = ANY (regs));
  IF sb IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  SELECT jsonb_build_object('applicable', count(*) FILTER (WHERE NOT t.is_na), 'approved', count(*) FILTER (WHERE NOT t.is_na AND t.state = 'approved'),
           'open', count(*) FILTER (WHERE NOT t.is_na AND t.state <> 'approved'),
           'overdue', count(*) FILTER (WHERE NOT t.is_na AND t.state <> 'approved' AND t.planned_date < today),
           'worst_delay_days', coalesce(max(today - t.planned_date) FILTER (WHERE NOT t.is_na AND t.state <> 'approved' AND t.planned_date < today), 0))
    INTO ta FROM public.task_instances t WHERE t.site_id = p_a;
  SELECT jsonb_build_object('applicable', count(*) FILTER (WHERE NOT t.is_na), 'approved', count(*) FILTER (WHERE NOT t.is_na AND t.state = 'approved'),
           'open', count(*) FILTER (WHERE NOT t.is_na AND t.state <> 'approved'),
           'overdue', count(*) FILTER (WHERE NOT t.is_na AND t.state <> 'approved' AND t.planned_date < today),
           'worst_delay_days', coalesce(max(today - t.planned_date) FILTER (WHERE NOT t.is_na AND t.state <> 'approved' AND t.planned_date < today), 0))
    INTO tb FROM public.task_instances t WHERE t.site_id = p_b;
  RETURN jsonb_build_object('as_of', today, 'a', sa || jsonb_build_object('tasks', ta), 'b', sb || jsonb_build_object('tasks', tb),
    'stages', coalesce((SELECT jsonb_agg(jsonb_build_object('code', coalesce(x.code, y.code), 'seq', coalesce(x.seq, y.seq), 'name_en', coalesce(x.name_en, y.name_en), 'name_ar', coalesce(x.name_ar, y.name_ar),
                  'a_state', x.state, 'a_days', x.days, 'a_finished', x.finished, 'b_state', y.state, 'b_days', y.days, 'b_finished', y.finished,
                  'diff_days', CASE WHEN x.days IS NOT NULL AND y.days IS NOT NULL THEN y.days - x.days END) ORDER BY coalesce(x.seq, y.seq))
                FROM (SELECT e ->> 'code' AS code, (e ->> 'seq')::int AS seq, e ->> 'name_en' AS name_en, e ->> 'name_ar' AS name_ar, e ->> 'state' AS state,
                             (e ->> 'days')::int AS days, e ->> 'finished' AS finished FROM jsonb_array_elements(public.site_stage_times(p_a) -> 'stages') e) x
                FULL JOIN (SELECT e ->> 'code' AS code, (e ->> 'seq')::int AS seq, e ->> 'name_en' AS name_en, e ->> 'name_ar' AS name_ar, e ->> 'state' AS state,
                             (e ->> 'days')::int AS days, e ->> 'finished' AS finished FROM jsonb_array_elements(public.site_stage_times(p_b) -> 'stages') e) y ON y.code = x.code), '[]'::jsonb));
END $$;

DO $$
BEGIN
  ALTER FUNCTION public.site_compare(uuid, uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION public.site_compare(uuid, uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.site_compare(uuid, uuid) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.site_compare(uuid, uuid) TO pmis_app;
  END IF;
END $$;
