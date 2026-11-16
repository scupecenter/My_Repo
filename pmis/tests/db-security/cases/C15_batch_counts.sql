-- The counts of an import batch for the list (migration 0114, owner report 2026-11-16): imp_batch_counts is a definer function that answers only for a
-- batch the caller may see (imp_batch_visible), and NULL otherwise; owner pmis_definer, PUBLIC revoked, EXECUTE for the application role only.

-- @case BC-01
-- @title imp_batch_counts keeps its shape: owner pmis_definer, security definer, fixed search_path, PUBLIC revoked, the application role may execute it
-- @category batch-counts
-- @expect output ok
SELECT CASE
  WHEN pg_get_userbyid(p.proowner) <> 'pmis_definer' OR NOT p.prosecdef THEN 'shape'
  WHEN NOT (coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN 'search_path'
  WHEN has_function_privilege('public', p.oid, 'EXECUTE') THEN 'public'
  WHEN NOT has_function_privilege('pmis_app', p.oid, 'EXECUTE') THEN 'door'
  ELSE 'ok' END
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'imp_batch_counts';
-- @end

-- @case BC-02
-- @title Alice asks the counts of a batch that does not exist (or that she may not see): nothing is answered
-- @category batch-counts
-- @actor ALICE
-- @region 1
-- @expect output null
SELECT coalesce(imp_batch_counts('00000000-0000-4000-8000-0000000000bc')::text, 'null');
-- @end
