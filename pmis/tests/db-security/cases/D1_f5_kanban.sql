-- F5 (migration 0118, contract 0.15.32): the sites board and the tasks board are read only and add no door that changes a site or a task.
-- The only write is the WIP limits setting kanban.wip_limits, which changes only through admin_set_kanban_wip_limits (a System Admin or a
-- delegate of settings edit for all regions, a reason, audited); a direct write, a delete, an insert and a rename are refused for every
-- session. The new functions follow the definer rules. Alice: CW Team Lead in Tripoli (region 1). ADMIN: the System Admin.
-- Each case runs in a transaction that the runner rolls back.

-- @case F5-01
-- @title The functions of 0118 are SECURITY DEFINER with search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; the application role keeps its doors (sv_screen_module was one since 0065)
-- @category f5-kanban
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('kanban_wip_json', 'admin_set_kanban_wip_limits', 'sv_screen_module')
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 3 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT app) THEN 'door not granted'
  ELSE 'ok' END;
-- @end

-- @case F5-02
-- @title Alice sets a WIP limit by a direct update (the settings policies keep her out: no row changes)
-- @category f5-kanban
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = '{"MS2": 1}'::jsonb WHERE key = 'kanban.wip_limits' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case F5-03
-- @title The System Admin sets a WIP limit by a direct update (no reason, no audit row)
-- @category f5-kanban
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '{"MS2": 1}'::jsonb WHERE key = 'kanban.wip_limits';
-- @end

-- @case F5-04
-- @title The System Admin deletes the WIP limits row, or renames it away
-- @category f5-kanban
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET key = 'kanban.wip_limits_old' WHERE key = 'kanban.wip_limits';
DELETE FROM settings WHERE key = 'kanban.wip_limits';
-- @end

-- @case F5-05
-- @title The System Admin inserts the WIP limits row again with another value (a conflict path)
-- @category f5-kanban
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('kanban.wip_limits', '{"MS1": 2}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case F5-06
-- @title Alice changes the WIP limits through the door: she holds no settings right
-- @category f5-kanban
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_set_kanban_wip_limits('{"MS2": 1}'::jsonb, 'Alice wants a limit', NULL);
-- @end

-- @case F5-07
-- @title A delegate without a settings right changes the WIP limits
-- @category f5-kanban
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 admin path
SELECT admin_set_kanban_wip_limits('{"MS2": 1}'::jsonb, 'Delegate without the right', NULL);
-- @end

-- @case F5-08
-- @title The new screen tasks-board belongs to the Sites module, so a shared view of it reaches only people who may see Sites
-- @category f5-kanban
-- @actor ALICE
-- @region 1
-- @expect output sites|
SELECT sv_screen_module('tasks-board') || '|' || coalesce(sv_screen_module('tasks-board-x'), '');
-- @end

-- @case F5-09
-- @title Positive control: Alice reads the WIP limits (empty by default, read only for her); the System Admin sets one through the door (null = no limit), and is recorded as the author
-- @category f5-kanban
-- @expect output {}|false|{"MS2": 3}|true
\ctx ALICE
SELECT set_config('f5.alice', (kanban_wip_json() -> 'limits')::text || '|' || (kanban_wip_json() ->> 'can_edit'), true) IS NOT NULL;
\ctx ADMIN
SELECT set_config('f5.set', (admin_set_kanban_wip_limits('{"MS2": 3, "MS3": null}'::jsonb, 'Security suite control', NULL) -> 'limits')::text, true) IS NOT NULL;
SELECT current_setting('f5.alice') || '|' || current_setting('f5.set') || '|' || coalesce((kanban_wip_json() ->> 'updated_by') = '{{ADMIN}}', false)::text;
-- @end
