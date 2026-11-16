-- F2 (migration 0116, contract 0.15.30): the ball in court, the SLA overrun and the stale flag are read only. The two new doors are
-- task_last_activity(task), which reads the audit log for one task and must answer nothing for a task outside the caller's regions (B3), and
-- task_stale_idle_days(), the idle limit of the existing dashboard setting. Alice: CW Team Lead in Tripoli (region 1). ADMIN: the System Admin.

-- @case F2-01
-- @title Both functions of 0116 are SECURITY DEFINER with search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; the application role holds both
-- @category f2-ball-in-court
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('task_last_activity', 'task_stale_idle_days')
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 2 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT app) THEN 'not granted to the application role'
  ELSE 'ok' END;
-- @end

-- @case F2-02
-- @title Alice (Tripoli) asks the last activity of a task in Benghazi: no answer, and the task stays invisible to her
-- @category f2-ball-in-court
-- @actor ALICE
-- @region 1
-- @expect output null|0
SELECT coalesce(task_last_activity('{{TASK_BEN}}')::text, 'null') || '|' || (SELECT count(*) FROM task_instances WHERE id = '{{TASK_BEN}}')::text;
-- @end

-- @case F2-03
-- @title Positive control: the System Admin reads the last activity of the Benghazi task, Alice that of her own task, and the idle limit (default 2)
-- @category f2-ball-in-court
-- @expect output true|true|2
\ctx ADMIN
SELECT set_config('f2.admin', (task_last_activity('{{TASK_BEN}}') IS NOT NULL)::text, true) IS NOT NULL;
\ctx ALICE
SELECT current_setting('f2.admin') || '|' || (task_last_activity('{{TASK_TRI}}') IS NOT NULL)::text || '|' || task_stale_idle_days()::text;
-- @end
