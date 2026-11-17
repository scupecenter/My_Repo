-- Re-apply a historical Master file with direct approval, and the overall status that follows the milestones (migration 0122, owner decision 2026-11-17;
-- contract 0.15.36). The discard of the open Master batches, the status derivation, its refresh and its trigger are internal (owner pmis_definer, PUBLIC
-- revoked, nothing granted to pmis_app); the only door stays mi_apply_run, which accepts `reapply` only with the direct approval of the historical load (a
-- System Admin, a step-up, the waiver open, a reason). Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case HRP-01
-- @title The System Admin with a step-up discards the open Master batches through the internal function
-- @category historical-reapply
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hrp_discard_open(NULL::master_reconciliation_runs, 'a forged discard');
-- @end

-- @case HRP-02
-- @title The System Admin writes the overall status of a site through the internal refresh
-- @category historical-reapply
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT site_status_refresh('{{SITE_BEN}}'::uuid);
-- @end

-- @case HRP-03
-- @title Alice reads the derived status of the Benghazi site through the internal function
-- @category historical-reapply
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT site_status_derive('{{SITE_BEN}}'::uuid);
-- @end

-- @case HRP-04
-- @title The System Admin calls the trigger function of a withdrawn cancellation
-- @category historical-reapply
-- @actor ADMIN
-- @region *
-- @expect error 42501|0A000 permission denied|trigger functions can only be called as triggers
SELECT site_status_after_uncancel();
-- @end

-- @case HRP-05
-- @title The System Admin marks a background apply as a re-apply directly
-- @category historical-reapply
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE mi_apply_jobs SET reapply = true;
-- @end

-- @case HRP-06
-- @title Alice discards an open Master import batch directly
-- @category historical-reapply
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batches SET status = 'discarded' WHERE source = 'master_import';
-- @end

-- @case HRP-07
-- @title Alice, not a System Admin, calls the door with a re-apply
-- @category historical-reapply
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_apply_run(gen_random_uuid(), NULL, 'submit', 'forged load', true, '{"reason": "forged load", "approve_directly": true, "reapply": true}'::jsonb, NULL::jsonb);
-- @end

-- @case HRP-08
-- @title The shape of the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app) and the doors kept
-- @category historical-reapply
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hrp_discard_open', 'site_status_derive', 'site_status_refresh', 'site_status_after_uncancel')
), d AS (
  SELECT pg_get_userbyid(p.proowner) AS owner, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, p.prosecdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.oid IN ('mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)'::regprocedure, 'mi_apply_step(uuid)'::regprocedure)
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 4 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM d) <> 2 OR EXISTS (SELECT 1 FROM d WHERE NOT app OR owner <> 'pmis_definer' OR NOT prosecdef) THEN 'doors'
  WHEN NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'z_site_status_uncancel' AND tgrelid = 'public.sites'::regclass) THEN 'trigger'
  ELSE 'ok' END;
-- @end
