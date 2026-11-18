-- The tasks fed by the register records of the historical Master load approved directly (migration 0123, owner report 2026-11-18). The feed of one task, the
-- feed of one record and the one-time catch-up are internal (owner pmis_definer, PUBLIC revoked, nothing granted to pmis_app); they are reached only from
-- hda_approve_record (itself internal, 0093) and from the migration. The task flag stays unwritable by the application role. Alice: CW Team Lead in Tripoli,
-- not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case HRT-01
-- @title The System Admin with a step-up runs the one-time catch-up through the internal function
-- @category historical-register-tasks
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hrt_catch_up();
-- @end

-- @case HRT-02
-- @title The System Admin feeds the tasks of a register record through the internal function
-- @category historical-register-tasks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hrt_feed_record(gen_random_uuid(), gen_random_uuid(), false, 'a forged feed');
-- @end

-- @case HRT-03
-- @title Alice approves a task of the Benghazi site through the internal feed of one task
-- @category historical-register-tasks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hrt_feed_task(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), current_date, 'A3', 'contract_signoff_date', true, 'a forged approval');
-- @end

-- @case HRT-04
-- @title The System Admin calls the direct approval of a register record (internal since 0093)
-- @category historical-register-tasks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hda_approve_record(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), true);
-- @end

-- @case HRT-05
-- @title The System Admin flags a task as approved directly by the historical load
-- @category historical-register-tasks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE task_instances SET historical_direct_approved = true, historical_direct_approved_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case HRT-06
-- @title Alice links a register record to a task directly
-- @category historical-register-tasks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE register_records SET task_id = (SELECT id FROM task_instances LIMIT 1);
-- @end

-- @case HRT-07
-- @title The shape of the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the redefined ones kept internal, and the catch-up recorded
-- @category historical-register-tasks
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hrt_feed_task', 'hrt_feed_record', 'hrt_catch_up', 'hda_approve_record')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p WHERE p.oid = 'public.hda_guard_task()'::regprocedure
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 4 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN EXISTS (SELECT 1 FROM g WHERE prosecdef OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guard'
  WHEN NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hda_guard_task_upd' AND tgrelid = 'public.task_instances'::regclass) THEN 'trigger'
  ELSE 'ok' END;
-- @end
