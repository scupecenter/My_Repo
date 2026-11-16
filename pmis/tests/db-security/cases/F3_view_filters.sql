-- AND/OR filter builder in saved views and views shared with a region (migration 0117, F3, contract 0.15.31). pmis_app reads its own rows of
-- saved_view_region_targets only (row security) and writes them only through sv_save; the internal helpers of the filter tree are closed; the
-- database refuses a tree deeper than two levels or too large; a view shared with a region does not reach a reader of another region.
-- Each case runs in a transaction that the runner rolls back.

-- @case SVF-01
-- @title Alice shares a view with a region by writing the region audience table directly
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO saved_view_region_targets (view_id, region_id) SELECT id, 1 FROM saved_views LIMIT 1;
-- @end

-- @case SVF-02
-- @title Alice deletes the region audience of views directly
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM saved_view_region_targets;
-- @end

-- @case SVF-03
-- @title Alice calls the internal audience writer to add a region to a view
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function sv_set_audience
SELECT sv_set_audience(gen_random_uuid(), '{"region_ids": [5]}'::jsonb);
-- @end

-- @case SVF-04
-- @title Alice calls the internal tree stripper and the hidden-field test of one field
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function sv_(strip_tree|hidden_filter_field)
SELECT sv_hidden_filter_field('sites', 'c:anything');
SELECT sv_strip_tree('sites', '{"op":"and","items":[]}'::jsonb);
-- @end

-- @case SVF-05
-- @title Alice reads a view the System Admin shared with Benghazi only
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:not_found
SELECT (sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Benghazi view", "audience": {"region_ids": [5]}}'::jsonb, NULL) ->> 'id') AS v \gset
\ctx ALICE
SELECT sv_get(:'v'::uuid);
-- @end

-- @case SVF-06
-- @title Alice, without views.share, shares her own view with her own region
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:(action_forbidden|not_found)
SELECT sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Tripoli for all", "audience": {"region_ids": [1]}}'::jsonb, NULL);
-- @end

-- @case SVF-07
-- @title The System Admin stores a filter tree three levels deep
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:validation_failed.*too_deep
SELECT sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Deep", "filters": {"advanced": {"op": "and", "items": [{"op": "or", "items": [{"op": "and", "items": []}]}]}}}'::jsonb, NULL);
-- @end

-- @case SVF-08
-- @title The System Admin stores a filter condition whose field id carries SQL
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:validation_failed
SELECT sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Injected", "filters": {"advanced": {"op": "and", "items": [{"field": "site_code; DROP TABLE sites", "operator": "is", "value": "x"}]}}}'::jsonb, NULL);
-- @end

-- @case SVF-09
-- @title Positive control: the System Admin shares a view with two regions and reads them back in the audience
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect output 1,5
SELECT (sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Two regions", "filters": {"advanced": {"op": "or", "items": [{"field": "region_id", "operator": "in", "value": ["1", "5"]}]}}, "audience": {"region_ids": [5, 1]}}'::jsonb, NULL) ->> 'id') AS v \gset
SELECT string_agg(r ->> 'id', ',' ORDER BY (r ->> 'id')::int) FROM jsonb_array_elements(sv_get(:'v'::uuid) #> '{audience,regions}') r;
-- @end

-- @case SVF-10
-- @title Every function of 0117 is SECURITY DEFINER (but the two casts), search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; the application role holds three new doors only
-- @category saved-views
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('sv_try_numeric', 'sv_try_date', 'sv_check_tree', 'sv_hidden_filter_field', 'sv_filter_hidden', 'sv_strip_tree',
    'sv_strip', 'sv_is_shared', 'sv_addressed_to', 'sv_audience', 'sv_set_audience', 'sv_check_body')
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 12 THEN 'functions: ' || (SELECT count(*) FROM f)
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef AND proname NOT IN ('sv_try_numeric', 'sv_try_date')) THEN 'not SECURITY DEFINER: ' || (SELECT min(proname) FROM f WHERE NOT prosecdef AND proname NOT IN ('sv_try_numeric', 'sv_try_date'))
  WHEN EXISTS (SELECT 1 FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'search_path: ' || (SELECT min(proname) FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%'))
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner: ' || (SELECT min(proname) FROM f WHERE owner <> 'pmis_definer')
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC: ' || (SELECT min(proname) FROM f WHERE pub)
  WHEN (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app) <> 'sv_filter_hidden,sv_try_date,sv_try_numeric' THEN 'doors: ' || (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app)
  WHEN has_table_privilege('pmis_app', 'saved_view_region_targets', 'INSERT') OR NOT has_table_privilege('pmis_app', 'saved_view_region_targets', 'SELECT') THEN 'table rights'
  WHEN NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'saved_view_region_targets') THEN 'row security not forced'
  ELSE 'ok' END;
-- @end
