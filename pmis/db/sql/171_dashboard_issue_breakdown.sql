-- 0172_dashboard_issue_breakdown: package 3 of the issue work. The Dashboard issues section gains two read-only
-- breakdowns of the open issues: per category (the IssueCategory list) and per blocker reason (the BlockerReason
-- list). Mirror: db/sql/171_dashboard_issue_breakdown.sql (kept identical).
--
--   1. What is added. `dash_sec_issues` returns two more arrays, `by_category` and `by_reason`. Each row carries the
--      list code (null when the field is empty on the issue), the list labels (null when there is no code), the count
--      of open issues and the count of distinct sites, the same two measures as `by_owner` (Q36). Nothing existing
--      changes: the totals, the owner bars and the age buckets keep their definitions.
--   2. How it counts. The same open-issue set as the rest of the section (raised, not resolved on the reference
--      date, and not in a closing status when the date is today), grouped by the stored list code. The labels come
--      from Settings > Lists; renaming or hiding a value there renames the row, it never drops it. An issue whose
--      code is no longer in the list still counts, with the code as its label.
--   3. Read only. The function is replaced in place from its stored definition (0039); no table, no data, no grant
--      and no permission changes. The section keeps its existing visibility (the caller's issues scope).

CREATE OR REPLACE FUNCTION dash_sec_issues(p_ref date, p_scope integer[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; live boolean := (p_ref = public.cal_today());
BEGIN
  WITH i AS (
    SELECT r.id, r.site_id, s.region_id, nullif(r.data ->> 'raised_date', '')::date AS raised, nullif(r.data ->> 'resolution_date', '')::date AS resolved,
           lower(coalesce(r.data ->> 'issue_status', '')) AS st, r.data ->> 'owner_user' AS owner_user, r.external_party_id, btrim(coalesce(r.data ->> 'blocked_gate_or_task', '')) AS blocked_on,
           nullif(r.data ->> 'issue_category', '') AS category, nullif(r.data ->> 'blocker_reason', '') AS reason
    FROM public.register_records r JOIN _dsite s ON s.id = r.site_id AND NOT s.cancelled
    WHERE r.register_key = 'issues' AND r.is_current AND (p_scope IS NULL OR s.region_id = ANY (p_scope))
  ), o AS (
    SELECT i.*, public.dash_wd(i.raised, p_ref) AS age, coalesce(u.display_name, ep.name) AS owner_name,
           CASE WHEN i.owner_user IS NOT NULL THEN 'user:' || i.owner_user WHEN i.external_party_id IS NOT NULL THEN 'party:' || i.external_party_id::text ELSE 'none' END AS owner_key,
           CASE WHEN i.owner_user IS NOT NULL THEN 'user' WHEN i.external_party_id IS NOT NULL THEN 'party' ELSE 'none' END AS owner_kind
    FROM i LEFT JOIN public.users u ON u.id::text = i.owner_user LEFT JOIN public.external_parties ep ON ep.id = i.external_party_id
    WHERE i.raised IS NOT NULL AND i.raised <= p_ref AND (i.resolved IS NULL OR i.resolved > p_ref) AND (NOT live OR i.st !~ '^(closed|resolved|done|cancel)')
  )
  SELECT jsonb_build_object('available', true, 'open_total', (SELECT count(*) FROM o), 'sites_with_open_issue', (SELECT count(DISTINCT site_id) FROM o),
    'blocking_total', (SELECT count(*) FROM o WHERE blocked_on <> ''),
    'oldest_age_wd', (SELECT max(age) FROM o), 'avg_age_wd', (SELECT round(avg(age), 1) FROM o),
    'by_owner', coalesce((SELECT jsonb_agg(jsonb_build_object('owner_key', x.owner_key, 'owner_kind', x.owner_kind, 'owner_name', x.owner_name, 'count', x.n, 'sites', x.sites,
        'oldest_age_wd', x.oldest, 'avg_age_wd', x.avg_age) ORDER BY x.n DESC, x.oldest DESC, x.owner_name)
      FROM (SELECT owner_key, max(owner_kind) AS owner_kind, max(owner_name) AS owner_name, count(*) AS n, count(DISTINCT site_id) AS sites, max(age) AS oldest, round(avg(age), 1) AS avg_age FROM o GROUP BY owner_key) x), '[]'::jsonb),
    'by_category', coalesce((SELECT jsonb_agg(jsonb_build_object('code', x.code, 'label_en', coalesce(lv.label_en, x.code), 'label_ar', lv.label_ar, 'count', x.n, 'sites', x.sites) ORDER BY x.n DESC, x.code)
      FROM (SELECT category AS code, count(*) AS n, count(DISTINCT site_id) AS sites FROM o GROUP BY category) x
      LEFT JOIN public.list_values lv ON lv.catalogue_code = 'IssueCategory' AND lv.code = x.code), '[]'::jsonb),
    'by_reason', coalesce((SELECT jsonb_agg(jsonb_build_object('code', x.code, 'label_en', coalesce(lv.label_en, x.code), 'label_ar', lv.label_ar, 'count', x.n, 'sites', x.sites) ORDER BY x.n DESC, x.code)
      FROM (SELECT reason AS code, count(*) AS n, count(DISTINCT site_id) AS sites FROM o GROUP BY reason) x
      LEFT JOIN public.list_values lv ON lv.catalogue_code = 'BlockerReason' AND lv.code = x.code), '[]'::jsonb),
    'age_buckets', jsonb_build_array(
      jsonb_build_object('key', '0_7', 'count', (SELECT count(*) FROM o WHERE age <= 7)),
      jsonb_build_object('key', '8_15', 'count', (SELECT count(*) FROM o WHERE age BETWEEN 8 AND 15)),
      jsonb_build_object('key', '16_30', 'count', (SELECT count(*) FROM o WHERE age BETWEEN 16 AND 30)),
      jsonb_build_object('key', 'over_30', 'count', (SELECT count(*) FROM o WHERE age > 30))))
  INTO out_;
  RETURN out_;
END $$;
