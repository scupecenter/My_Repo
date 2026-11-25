-- P1 Master sources (migration 0121, contract 0.15.35): the source of each Master cell is read from site_master_master_values with the caller's own
-- rights (security-invoker views, row security of every table), so a record of another region never yields its id; the column source kinds are
-- configuration (master_columns stays read-only for pmis_app); site_master_date is a plain invoker helper (owner pmis_definer, PUBLIC revoked).
-- No SECURITY DEFINER function is added. Alice: CW Team Lead in Tripoli (region 1). ADMIN: the System Admin. Each case is rolled back.

-- @case MSRC-01
-- @title site_master_master_values and site_master_task_cells are security-invoker views; site_master_date is not SECURITY DEFINER, has a fixed search path, owner pmis_definer, PUBLIC revoked, EXECUTE for pmis_app
-- @category master-sources
-- @expect output ok
WITH v AS (
  SELECT c.relname, coalesce(c.reloptions::text, '') AS opts FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('site_master_master_values', 'site_master_task_cells')
), f AS (
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'site_master_date'
)
SELECT CASE
  WHEN (SELECT count(*) FROM v) <> 2 THEN 'views: ' || (SELECT count(*) FROM v)::text
  WHEN EXISTS (SELECT 1 FROM v WHERE opts NOT ILIKE '%security_invoker=true%') THEN 'view not security_invoker'
  WHEN (SELECT count(*) FROM f) <> 1 THEN 'function missing'
  WHEN (SELECT prosecdef FROM f) THEN 'SECURITY DEFINER'
  WHEN (SELECT proconfig FROM f) IS NULL OR NOT ((SELECT proconfig FROM f)::text ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN (SELECT owner FROM f) <> 'pmis_definer' THEN 'owner'
  WHEN (SELECT pub FROM f) THEN 'PUBLIC'
  WHEN NOT (SELECT app FROM f) THEN 'not granted to pmis_app'
  ELSE 'ok' END;
-- @end

-- @case MSRC-02
-- @title Alice marks a not-tracked Master column as tracked (the source kinds are configuration)
-- @category master-sources
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE master_columns SET source_kind = 'register', source_note = 'forged' WHERE letter = 'FP';
-- @end

-- @case MSRC-03
-- @title The System Admin rewrites the source note of a column directly
-- @category master-sources
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE master_columns SET source_note = 'forged' WHERE letter = 'FA';
-- @end

-- @case MSRC-04
-- @title Alice (Tripoli) reads the Master values and sources of the Benghazi site: row security leaves no row, so no source id
-- @category master-sources
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM site_master_master_values WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case MSRC-05
-- @title Alice (Tripoli) reads the task cells of the Benghazi site
-- @category master-sources
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM site_master_task_cells WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case MSRC-06
-- @title Alice with a forged all-regions setting still reads no source of the Benghazi site
-- @category master-sources
-- @actor ALICE
-- @region *
-- @expect output 0
SELECT count(*) FROM site_master_master_values WHERE site_id = '{{SITE_BEN}}'::uuid AND src_id IS NOT NULL;
-- @end

-- @case MSRC-07
-- @title Positive control: Alice reads the Site ID of her Tripoli site with its source (a site field), and the derived Rollback Count
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output SEC-TRI-S1|site|site_code|derived
SELECT (SELECT value || '|' || src_kind || '|' || src_field FROM site_master_master_values WHERE site_id = '{{SITE_TRI}}'::uuid AND ord = 2)
  || '|' || (SELECT src_kind FROM site_master_master_values WHERE site_id = '{{SITE_TRI}}'::uuid AND ord = 113);
-- @end

-- @case MSRC-08
-- @title Positive control: every Master column has a source kind; four are not tracked (Dismantle planned and RN dates)
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output 187|4
SELECT count(source_kind)::text || '|' || count(*) FILTER (WHERE source_kind = 'not_tracked')::text FROM master_columns;
-- @end

-- @case MSRC-09
-- @title Positive control: site_master_date reads a date or a date-time and gives NULL for a bad date (the projection never breaks on a value)
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output 2026-02-03|2026-02-03|null|null
SELECT site_master_date('2026-02-03')::text || '|' || site_master_date('2026-02-03T10:15')::text || '|' || coalesce(site_master_date('2026-13-45')::text, 'null') || '|' || coalesce(site_master_date('N/A')::text, 'null');
-- @end
