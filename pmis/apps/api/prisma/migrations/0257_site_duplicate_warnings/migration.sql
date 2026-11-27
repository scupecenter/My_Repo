-- 0185_site_duplicate_warnings: a warning, never a block, when a new site looks like one that exists (owner approval relayed 2026-11-26; item 5).
--
-- Already there (0070): the exact Site ID is refused (site_new_clean error `duplicate`: any site, also a cancelled one, and any waiting draft).
-- Added here: warnings, in the same list the draft already returns (`warnings` of POST /sites, GET and PATCH /site-drafts/{id}), for
--   similar_site_code   the Site ID matches another one ignoring case, spaces, dashes and underscores (e.g. TRP-001 and TRP001);
--   duplicate_name      the English or the Arabic name equals the name of another site or of a waiting draft (case and spaces ignored);
--   close_coordinates   the coordinates are within 100 metres of another site or of a waiting draft.
-- Region rule: a match in the region of the proposal names the site (Site ID, name). A match in another region says only that one exists in another region
-- (no Site ID, no name), so a region user learns nothing about a site outside the regions they work in. Nothing blocks: a warning can be ignored.
--
-- How: site_new_clean (latest definition 0085) is renamed site_new_clean_core and a new site_new_clean calls it and appends the warnings. Every caller
-- (manual drafts, the New sites template, bulk batches, Master creation) keeps calling site_new_clean and so gets the same warnings. Additive: no table change.

ALTER FUNCTION site_new_clean(jsonb, uuid) RENAME TO site_new_clean_core;

CREATE OR REPLACE FUNCTION site_new_dup_warnings(p_clean jsonb, p_draft uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w jsonb := '[]'::jsonb; code text := p_clean ->> 'site_code'; nm text := lower(regexp_replace(btrim(coalesce(p_clean ->> 'name', '')), '\s+', ' ', 'g'));
  nma text := lower(regexp_replace(btrim(coalesce(p_clean ->> 'name_ar', '')), '\s+', ' ', 'g')); rid int := nullif(p_clean ->> 'region_id', '')::int;
  lat numeric := nullif(p_clean ->> 'latitude', '')::numeric; lon numeric := nullif(p_clean ->> 'longitude', '')::numeric;
  canon text; r record; label text;
BEGIN
  IF code IS NOT NULL THEN
    canon := upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'));
    FOR r IN SELECT * FROM (SELECT s.site_code AS c, s.region_id AS rg FROM public.sites s WHERE s.site_code <> code AND upper(regexp_replace(s.site_code, '[^A-Za-z0-9]', '', 'g')) = canon
             UNION ALL
             SELECT d.site_code, d.region_id FROM public.site_drafts d WHERE d.status IN ('entry', 'in_approval') AND d.id IS DISTINCT FROM p_draft AND d.site_code <> code
               AND upper(regexp_replace(d.site_code, '[^A-Za-z0-9]', '', 'g')) = canon) q ORDER BY (q.rg IS NOT DISTINCT FROM rid) DESC, q.c LIMIT 3 LOOP
      w := w || (public.site_new_err('site_code', 'similar_site_code', CASE WHEN rid IS NOT NULL AND r.rg = rid THEN 'Another Site ID is almost the same: ' || r.c || '. Check it is a different site.'
        ELSE 'A site with an almost identical Site ID exists in another region. Check it is a different site.' END) -> 0);
    END LOOP;
  END IF;
  IF nm <> '' OR nma <> '' THEN
    FOR r IN SELECT * FROM (SELECT s.site_code AS c, s.name AS n, s.region_id AS rg FROM public.sites s
               WHERE s.site_code IS DISTINCT FROM code AND ((nm <> '' AND lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')) = nm)
                 OR (nma <> '' AND lower(regexp_replace(btrim(coalesce(s.name_ar, '')), '\s+', ' ', 'g')) = nma))
             UNION ALL
             SELECT d.site_code, d.data ->> 'name', d.region_id FROM public.site_drafts d
               WHERE d.status IN ('entry', 'in_approval') AND d.id IS DISTINCT FROM p_draft AND d.site_code IS DISTINCT FROM code
                 AND ((nm <> '' AND lower(regexp_replace(btrim(coalesce(d.data ->> 'name', '')), '\s+', ' ', 'g')) = nm)
                   OR (nma <> '' AND lower(regexp_replace(btrim(coalesce(d.data ->> 'name_ar', '')), '\s+', ' ', 'g')) = nma))) q ORDER BY (q.rg IS NOT DISTINCT FROM rid) DESC, q.c LIMIT 3 LOOP
      w := w || (public.site_new_err('name', 'duplicate_name', CASE WHEN rid IS NOT NULL AND r.rg = rid THEN 'A site with this name exists: ' || r.c || ' (' || coalesce(r.n, '') || '). Check it is a different site.'
        ELSE 'A site with this name exists in another region. Check it is a different site.' END) -> 0);
    END LOOP;
  END IF;
  IF lat IS NOT NULL AND lon IS NOT NULL THEN
    FOR r IN SELECT * FROM (SELECT s.site_code AS c, s.name AS n, s.region_id AS rg FROM public.sites s
               WHERE s.site_code IS DISTINCT FROM code AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
                 AND abs(s.latitude - lat) < 0.002 AND abs(s.longitude - lon) < 0.002
                 AND sqrt(power((s.latitude - lat) * 111320, 2) + power((s.longitude - lon) * 111320 * cos(radians(lat)), 2)) < 100
             UNION ALL
             SELECT d.site_code, d.data ->> 'name', d.region_id FROM public.site_drafts d
               WHERE d.status IN ('entry', 'in_approval') AND d.id IS DISTINCT FROM p_draft AND d.site_code IS DISTINCT FROM code
                 AND CASE WHEN d.data ->> 'latitude' ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' AND d.data ->> 'longitude' ~ '^-?[0-9]{1,3}(\.[0-9]+)?$'
                     THEN sqrt(power(((d.data ->> 'latitude')::numeric - lat) * 111320, 2) + power(((d.data ->> 'longitude')::numeric - lon) * 111320 * cos(radians(lat)), 2)) < 100
                     ELSE false END) q ORDER BY (q.rg IS NOT DISTINCT FROM rid) DESC, q.c LIMIT 3 LOOP
      w := w || (public.site_new_err('latitude', 'close_coordinates', CASE WHEN rid IS NOT NULL AND r.rg = rid THEN 'These coordinates are within 100 metres of ' || r.c || ' (' || coalesce(r.n, '') || '). Check it is a different site.'
        ELSE 'These coordinates are within 100 metres of a site in another region. Check it is a different site.' END) -> 0);
    END LOOP;
  END IF;
  RETURN w;
END $$;

CREATE OR REPLACE FUNCTION site_new_clean(p_raw jsonb, p_draft uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE res jsonb := public.site_new_clean_core(p_raw, p_draft);
BEGIN
  IF jsonb_array_length(coalesce(res -> 'errors', '[]'::jsonb)) > 0 THEN RETURN res; END IF;
  RETURN jsonb_set(res, '{warnings}', coalesce(res -> 'warnings', '[]'::jsonb) || public.site_new_dup_warnings(res -> 'clean', p_draft));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['site_new_clean(jsonb,uuid)', 'site_new_clean_core(jsonb,uuid)', 'site_new_dup_warnings(jsonb,uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
END $$;
