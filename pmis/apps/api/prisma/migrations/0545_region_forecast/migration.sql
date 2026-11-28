-- 0545: forecast completion date per region (PMI EVM schedule forecasting). On the
-- group_by=region rows of the project status, forecast_date is:
--   * the latest actual date when every applicable task of the region is approved (done);
--   * otherwise start + planned_span / SPI, the classic EVM time estimate, where start and
--     the planned span come from the planned/baseline dates of the region's task instances
--     and SPI is the region's own actual/planned index (NULL when there is no plan or no
--     progress yet, and never a date in the past by construction of the inputs).
-- Region rows only; project and site rows carry NULL.
DO $$
DECLARE def text; marker text;
BEGIN
  def := pg_get_functiondef('public.dash_ps_rows(text,boolean)'::regprocedure);
  IF position('forecast_date' IN def) = 0 THEN
    marker := E'  ), tot AS (';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no tot anchor to patch'; END IF;
    def := replace(def, marker,
      E'  ), bnd AS (\n'
      || E'    SELECT s.region_id::text AS gk,\n'
      || E'           min(coalesce(t.planned_start, t.baseline_date, t.planned_date)) AS start0,\n'
      || E'           max(coalesce(t.planned_date, t.baseline_date, t.due_date)) AS end0,\n'
      || E'           max(coalesce(t.actual_date, t.approved_date::date, t.updated_at::date)) FILTER (WHERE t.state = ''approved'') AS last_actual,\n'
      || E'           count(*) FILTER (WHERE t.state <> ''approved'') AS open_n\n'
      || E'    FROM _dsite s JOIN public.task_instances t ON t.site_id = s.id AND t.state NOT IN (''na'', ''skipped'') AND NOT t.is_na\n'
      || E'    WHERE p_group = ''region'' AND NOT s.cancelled\n'
      || E'    GROUP BY 1\n'
      || marker);
    marker := E'FROM act GROUP BY gk\n  ), aj AS (';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no aj anchor to patch'; END IF;
    -- no change here; anchor only checked
    marker := E''', '||'plan_coverage_pct''';
    IF position('FROM tot t' IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no final-join anchor to patch'; END IF;
    def := replace(def, E'FROM tot t', E'FROM tot t LEFT JOIN bnd b ON b.gk = t.gk');
    marker := E'''plan_coverage_pct'', round(t.coverage * 100, 3),';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no coverage anchor to patch'; END IF;
    def := replace(def, marker, marker || E'\n'
      || E'      ''forecast_date'', CASE WHEN p_group <> ''region'' OR b.gk IS NULL THEN NULL\n'
      || E'          WHEN b.open_n = 0 THEN b.last_actual\n'
      || E'          WHEN t.planned > 0 AND t.actual > 0 AND b.start0 IS NOT NULL AND b.end0 IS NOT NULL AND b.end0 > b.start0\n'
      || E'            THEN (b.start0 + ceil((b.end0 - b.start0)::numeric / (t.actual / t.planned))::int)::date END,');
    EXECUTE def;
  END IF;
END $$;

-- dash_sec_regions: the regions card carries the forecast through.
DO $$
DECLARE def text; marker text := E'''health_score'', (SELECT (x ->> ''score'')::numeric FROM jsonb_array_elements(coalesce(p_health -> ''by_region'', ''[]''::jsonb)) x WHERE (x ->> ''region_id'')::int = r.region_id),';
BEGIN
  def := pg_get_functiondef('public.dash_sec_regions(jsonb,boolean,jsonb)'::regprocedure);
  IF position('forecast_date' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_sec_regions() has no health_score anchor to patch'; END IF;
    EXECUTE replace(def, marker, marker || E'\n      ''forecast_date'', (SELECT x ->> ''forecast_date'' FROM jsonb_array_elements(ps) x WHERE x ->> ''key'' = r.region_id::text),');
  END IF;
END $$;
