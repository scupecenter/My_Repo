-- N/A "historical load: no source" (migration 0126, owner decision "Option 1" 2026-11-18, contract 0.15.38): in the historical Master load approved directly,
-- a task with no date in the file is N/A only where a later task of the site is approved with a date. The rule, the restore and the catch-up are decided only by
-- definer code: hns_* are internal (owner pmis_definer, PUBLIC revoked, nothing granted to pmis_app); the flag task_instances.historical_no_source is written
-- only by hns_mark_site under its marker (guard hns_guard_task); the mark is an admin_overrides row (no right for pmis_app), restored only through the
-- existing door admin_override_revert. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case HNS-01
-- @title The System Admin with a step-up runs the one-time catch-up through the internal function
-- @category historical-no-source
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hns_catch_up();
-- @end

-- @case HNS-02
-- @title The System Admin runs the no-source rule on a site through the internal function
-- @category historical-no-source
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hns_apply_sites(ARRAY['{{SITE_BEN}}'::uuid], 'forged run', false, NULL);
-- @end

-- @case HNS-03
-- @title Alice marks the tasks of a site N/A through the internal function, naming another user as the actor
-- @category historical-no-source
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hns_mark_site('{{SITE_BEN}}'::uuid, gen_random_uuid(), 'forged mark', true);
-- @end

-- @case HNS-04
-- @title The System Admin restores a task without the revert door (no step-up check) through the internal function
-- @category historical-no-source
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hns_restore_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), 'forged restore', 'x', true);
-- @end

-- @case HNS-05
-- @title Alice restores tasks with forged rows of a file through the internal function
-- @category historical-no-source
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hns_restore_dated('[{"site_code":"X","cells":{"A2:actual_date":"2026-01-01"}}]'::jsonb, 'forged');
-- @end

-- @case HNS-06
-- @title The System Admin forges the marker of the rule and flags a task N/A "no source"
-- @category historical-no-source
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.hns_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET state = 'na', is_na = true, historical_no_source = true, historical_no_source_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case HNS-07
-- @title Alice plants a no-source override row to make a task revertible
-- @category historical-no-source
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
VALUES ('task', '{{SITE_BEN}}'::uuid, gen_random_uuid(), 'historical_no_source_na', 'forged override', '{"state":"open"}', '{"state":"na"}', gen_random_uuid());
-- @end

-- @case HNS-08
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the guard (runs as its writer), the triggers, the revert and apply doors kept, the flag columns and the override table unwritable, the catch-up recorded
-- @category historical-no-source
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hns_site_in_scope', 'hns_site_loader', 'hns_current_stage', 'hns_mark_site', 'hns_apply_sites',
                                              'hns_restore_task', 'hns_restore_dated', 'hns_after_job', 'hns_catch_up')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid = 'public.hns_guard_task()'::regprocedure
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 9 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN EXISTS (SELECT 1 FROM g WHERE prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guard'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.task_instances'::regclass AND tgname IN ('hns_guard_task_ins', 'hns_guard_task_upd')) <> 2 THEN 'guard triggers'
  WHEN NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'z_hns_after_job' AND tgrelid = 'public.import_batch_jobs'::regclass) THEN 'job trigger'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_override_revert(uuid,text)', 'EXECUTE') THEN 'revert door'
  WHEN NOT has_function_privilege('pmis_app', 'public.mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)', 'EXECUTE') THEN 'apply door'
  WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.admin_override_revert(uuid,text)'::regprocedure, 'public.ao_current_matches(uuid)'::regprocedure,
                 'public.mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)'::regprocedure)
               AND (NOT p.prosecdef OR coalesce(p.proconfig::text, '') NOT ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'redefined'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'historical_no_source', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'historical_no_source_at', 'UPDATE') THEN 'flag writable'
  WHEN has_table_privilege('pmis_app', 'public.admin_overrides', 'INSERT') THEN 'overrides writable'
  WHEN NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'historical_no_source_catch_up') THEN 'catch-up'
  ELSE 'ok' END;
-- @end
