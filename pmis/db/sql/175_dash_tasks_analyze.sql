-- 0176: dashboard speed, one item. dash_build_tasks creates the temp table _dtask and an index on it but never ANALYZEs it, so the sections that
-- read _dtask are planned without statistics. Adds ANALYZE _dtask after the index (as dash_core already does for _dsite and _dms).
-- Same body as the latest definition (0092), nothing else changes: no new index, no change of any number or behavior.
-- The function keeps its owner and grants (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.dash_build_tasks(p_ref date, p_stream text, p_excl boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE eff date;
BEGIN
  SELECT max(d) INTO eff FROM _dcal WHERE d <= p_ref AND is_wd;
  DROP TABLE IF EXISTS _dtask;
  CREATE TEMP TABLE _dtask ON COMMIT DROP AS
    WITH base AS (
      SELECT t.id, t.site_id, s.region_id, td.code AS task_code, sd.code AS stage_code, sd.stream_code,
             t.state::text AS state, (t.admin_override OR t.historical_no_documents OR t.lock_bypassed OR t.historical_direct_approved) AS admin_override, t.sla_target_date, t.due_date, t.sla_elapsed_wd, t.sla_end_date,
             r.max_working_days AS sla_max, t.return_count, coalesce(t.actual_date, t.approved_date) AS done_date,
             t.external_party_id, td.default_external_party::text AS default_party,
             CASE WHEN t.sla_start_date IS NULL OR t.sla_start_date > p_ref OR t.state IN ('locked', 'na', 'skipped') OR t.is_na
                       OR (p_excl AND (t.admin_override OR t.historical_no_documents OR t.lock_bypassed OR t.historical_direct_approved)) THEN 'none'
                  WHEN t.state = 'approved' AND coalesce(t.sla_end_date, t.actual_date, t.approved_date, p_ref) <= p_ref THEN 'closed'
                  WHEN t.due_date IS NULL THEN 'none'
                  ELSE 'open' END AS phase
      FROM _dsite s
      JOIN public.task_instances t ON t.site_id = s.id
      JOIN public.task_definitions td ON td.id = t.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
      WHERE NOT s.cancelled AND t.state NOT IN ('locked', 'na', 'skipped') AND (p_stream IS NULL OR sd.stream_code = p_stream)
    )
    SELECT b.id, b.site_id, b.region_id, b.task_code, b.stage_code, b.stream_code, b.state, b.admin_override, b.due_date, b.return_count, b.done_date,
      b.external_party_id, b.default_party, b.phase,
      CASE WHEN b.phase = 'closed' THEN CASE WHEN b.sla_elapsed_wd IS NULL OR b.sla_max IS NULL THEN NULL WHEN b.sla_elapsed_wd <= b.sla_max THEN 'on_time' ELSE 'late' END
           WHEN b.phase = 'open' THEN CASE WHEN eff <= coalesce(b.sla_target_date, b.due_date) THEN 'on_time' WHEN eff <= b.due_date THEN 'at_risk' ELSE 'late' END END AS cls,
      CASE WHEN b.phase = 'closed' AND b.sla_elapsed_wd IS NOT NULL AND b.sla_max IS NOT NULL THEN greatest(0, b.sla_elapsed_wd - b.sla_max)
           WHEN b.phase = 'open' AND eff > b.due_date THEN greatest(0, (SELECT wd FROM _dcal WHERE d = p_ref) - cd.wd) ELSE 0 END AS days_over
    FROM base b LEFT JOIN _dcal cd ON cd.d = b.due_date;
  CREATE INDEX ON _dtask (phase, cls);
  ANALYZE _dtask;   -- 0176: the planner had no statistics for the temp table the dashboard sections read from
END $function$;
