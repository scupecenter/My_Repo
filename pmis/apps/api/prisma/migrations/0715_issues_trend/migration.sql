-- 0715_issues_trend (contract 0.15.592): the weekly trend of issues opened against issues closed, for the Issues card of the dashboard.
-- Mirror: db/sql/714_issues_trend.sql (kept byte-identical).
--
-- Read only and additive: one function, no table, no setting, no grant or permission change. The Pareto view (cumulative share line with the 80 % marker on the
-- category and reason bars) needs no database change: it is computed in the web app from the by_category and by_reason lists that /dashboard already returns.
--   issues_weekly_trend(p_scope, p_weeks): one row per ISO week (Monday to Sunday), the last row is the current week up to today.
--     opened   current issue records with a raised_date in the week
--     closed   current issue records with a resolution_date in the week
--     open_end issues open at the end of the week (raised on or before it, no resolution date or one after it)
--   Sites: not cancelled, inside p_scope (the caller's issues regions; NULL = all). Dates are the register fields raised_date and resolution_date, the same
--   fields the open count of the dashboard uses, so a week's figures add up to the card's open total for the current day.

CREATE OR REPLACE FUNCTION issues_weekly_trend(p_scope integer[], p_weeks integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer := least(greatest(coalesce(p_weeks, 12), 4), 52); today date := public.cal_today(); first_w date; out_ jsonb;
BEGIN
  first_w := date_trunc('week', today::timestamp)::date - 7 * (n - 1);
  WITH w AS (
    SELECT g::date AS ws, least((g + 6)::date, today) AS we FROM generate_series(first_w::timestamp, date_trunc('week', today::timestamp), interval '7 days') g
  ), i AS (
    SELECT nullif(r.data ->> 'raised_date', '')::date AS raised, nullif(r.data ->> 'resolution_date', '')::date AS resolved
    FROM public.register_records r JOIN public.sites s ON s.id = r.site_id AND s.status::text <> 'cancelled'
    WHERE r.register_key = 'issues' AND r.is_current AND (p_scope IS NULL OR s.region_id = ANY (p_scope))
  )
  SELECT jsonb_build_object('weeks', n, 'as_of', today, 'items', coalesce(jsonb_agg(jsonb_build_object(
      'week_start', w.ws, 'week_end', w.we,
      'opened', (SELECT count(*) FROM i WHERE i.raised BETWEEN w.ws AND w.we),
      'closed', (SELECT count(*) FROM i WHERE i.resolved BETWEEN w.ws AND w.we),
      'open_end', (SELECT count(*) FROM i WHERE i.raised <= w.we AND (i.resolved IS NULL OR i.resolved > w.we))) ORDER BY w.ws), '[]'::jsonb))
  INTO out_ FROM w;
  RETURN out_;
END $$;

DO $$
BEGIN
  ALTER FUNCTION issues_weekly_trend(integer[], integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION issues_weekly_trend(integer[], integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION issues_weekly_trend(integer[], integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION issues_weekly_trend(integer[], integer) TO pmis_app;
  END IF;
END $$;
