-- The Master import creates the sites of its file that are not in GSDN Workspace, then enters their dates (migration 0155, owner request 2026-11-25, Q350;
-- contract 0.15.73). The option is for a System Admin (never a delegate) or the holder of both L1 and L2 of the Matrix row site_creation; the database
-- decides it (mcs_offer, mcs_rights) at the request, in the background and on every row. The staging, the creation, the finish and the rights check are
-- internal (owner pmis_definer, PUBLIC revoked, nothing granted to pmis_app); the only doors are mi_apply_run (8 arguments) and mcs_offer. The new columns
-- (import_batches.master_run_id; mi_apply_jobs.create_sites, create_batch_id, create_total, create_done) are not writable by pmis_app. Alice: CW Team Lead
-- in Tripoli, not a System Admin. Carol: no assignment. ADMIN: the System Admin. Each case is rolled back.

-- @case MCS-01
-- @title The System Admin stages the New sites batch of a run through the internal function (no step-up, no apply)
-- @category master-create-sites
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mcs_stage(gen_random_uuid());
-- @end

-- @case MCS-02
-- @title Alice creates the sites of a batch through the internal function, claiming a verified step-up, with a forged all-regions setting
-- @category master-create-sites
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT mcs_create_rows(gen_random_uuid(), 25, true);
-- @end

-- @case MCS-03
-- @title The System Admin closes a batch through the internal finish
-- @category master-create-sites
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mcs_finish(gen_random_uuid());
-- @end

-- @case MCS-04
-- @title Alice asks the internal rights check whether she may create a site of Tripoli
-- @category master-create-sites
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT mcs_rights(1);
-- @end

-- @case MCS-05
-- @title Alice asks the internal "holds both levels" check
-- @category master-create-sites
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT mcs_holds_both(1);
-- @end

-- @case MCS-06
-- @title The System Admin calls the one writer of a site directly (a draft approved without L2)
-- @category master-create-sites
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT site_create_apply(gen_random_uuid(), true);
-- @end

-- @case MCS-07
-- @title Alice links an import batch to a Master run (so that the batch doors would refuse it, or a creation would be credited to the run)
-- @category master-create-sites
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batches SET master_run_id = gen_random_uuid();
-- @end

-- @case MCS-08
-- @title The System Admin turns the creation of sites on for a background apply, or points it at another batch, directly
-- @category master-create-sites
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE mi_apply_jobs SET create_sites = true, create_batch_id = gen_random_uuid(), create_done = 0;
-- @end

-- @case MCS-09
-- @title Alice, not a System Admin and without the Master import, applies a run with the creation of sites
-- @category master-create-sites
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_apply_run(gen_random_uuid(), NULL, 'submit', 'forged load', true, NULL::jsonb, NULL::jsonb, true);
-- @end

-- @case MCS-10
-- @title Alice reads the offer: not allowed, because the legacy Master import is not hers
-- @category master-create-sites
-- @actor ALICE
-- @region 1
-- @expect output false|false|0
SELECT (mcs_offer() ->> 'allowed') || '|' || (mcs_offer() ->> 'admin') || '|' || jsonb_array_length(mcs_offer() -> 'regions');
-- @end

-- @case MCS-11
-- @title Carol, given a delegation of the Master import and of the Site Master create and approve rights (all regions), is not offered the creation: a delegate is never a System Admin, and she holds no level of site_creation
-- @category master-create-sites
-- @expect output false|false|0
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{CAROL}}'::uuid, NULL, NULL, false,
  '[{"module":"templates","action":"view"},{"module":"templates","action":"administer"},{"module":"templates","action":"import"},
    {"module":"sites","action":"view"},{"module":"sites","action":"create"},{"module":"sites","action":"approve"}]'::jsonb,
  true, NULL, NULL, NULL, false, NULL, 'Case MCS-11: a delegate of the Master import') IS NOT NULL AS delegated \gset
\ctx CAROL stepup=300
SELECT (mcs_offer() ->> 'allowed') || '|' || (mcs_offer() ->> 'admin') || '|' || jsonb_array_length(mcs_offer() -> 'regions');
-- @end

-- @case MCS-12
-- @title The System Admin is offered the creation in every region (the seeded System Admins group holds both levels of site_creation)
-- @category master-create-sites
-- @actor ADMIN
-- @region *
-- @expect output true|true|7
SELECT (mcs_offer() ->> 'allowed') || '|' || (mcs_offer() ->> 'admin') || '|' || jsonb_array_length(mcs_offer() -> 'regions');
-- @end

-- @case MCS-13
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; only mcs_offer granted), the doors (both apply doors and the background step granted), the internal redefined functions not granted, the new columns not writable by pmis_app, and no new table
-- @category master-create-sites
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('mcs_cell', 'mcs_identity', 'mcs_holds_both', 'mcs_rights', 'mcs_offer', 'mcs_stage', 'mcs_create_rows', 'mcs_result', 'mcs_finish')
), d AS (
  SELECT p.oid::regprocedure::text AS sig, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p
  WHERE p.oid IN ('public.mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb,boolean)'::regprocedure, 'public.mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)'::regprocedure,
                  'public.mi_apply_step(uuid)'::regprocedure, 'public.mi_run_applying_json(uuid)'::regprocedure, 'public.mi_apply_fail(uuid,text,text)'::regprocedure,
                  'public.site_create_apply(uuid,boolean)'::regprocedure, 'public.imp_async_guard(uuid)'::regprocedure)
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 9 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app) IS DISTINCT FROM 'mcs_offer' THEN 'granted: ' || coalesce((SELECT string_agg(proname, ',') FROM f WHERE app), 'none')
  WHEN (SELECT count(*) FROM d) <> 7 THEN 'redefined: ' || (SELECT count(*) FROM d)::text
  WHEN EXISTS (SELECT 1 FROM d WHERE NOT prosecdef OR owner <> 'pmis_definer' OR pub OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'redefined shape'
  WHEN (SELECT string_agg(sig, ',' ORDER BY sig) FROM d WHERE app) IS DISTINCT FROM
       'mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb),mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb,boolean),mi_apply_step(uuid),mi_run_applying_json(uuid)'
    THEN 'doors: ' || coalesce((SELECT string_agg(sig, ',' ORDER BY sig) FROM d WHERE app), 'none')
  WHEN has_column_privilege('pmis_app', 'public.import_batches', 'master_run_id', 'INSERT') OR has_column_privilege('pmis_app', 'public.import_batches', 'master_run_id', 'UPDATE') THEN 'batch column writable'
  WHEN has_table_privilege('pmis_app', 'public.mi_apply_jobs', 'SELECT') OR has_table_privilege('pmis_app', 'public.mi_apply_jobs', 'UPDATE') THEN 'jobs table granted'
  WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'mcs%') THEN 'new table'
  ELSE 'ok' END;
-- @end
