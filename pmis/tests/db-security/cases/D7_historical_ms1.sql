-- Site Release of the historical Master load (migration 0124, owner request 2026-11-18, contract 0.15.37). A3 from the Acquisition sheet of the historical
-- load (Master T) and the rules of the site type (A5 N/A unless the site is HUB or Terminal) are internal (owner pmis_definer, PUBLIC revoked, nothing granted
-- to pmis_app): they are reached only from mi_apply_run (the door of 0122), from the trigger on the site type and from the migration. The rule itself lives in
-- the rule table of Settings, Scenario rules, written only through admin_save_scenario_rules. The task flag stays unwritable by the application role, also
-- with a forged marker. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case HMS-01
-- @title The System Admin with a step-up runs the one-time catch-up through the internal function
-- @category historical-ms1
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hms_catch_up();
-- @end

-- @case HMS-02
-- @title The System Admin approves A3 from an Acquisition batch through the internal function
-- @category historical-ms1
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hms_feed_acquisition(gen_random_uuid(), false, 'a forged feed');
-- @end

-- @case HMS-03
-- @title Alice approves a task of the Benghazi site through the internal feed of one task
-- @category historical-ms1
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hms_feed_task(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), current_date, 'A3', 'contract_signoff_date', true, 'a forged approval');
-- @end

-- @case HMS-04
-- @title The System Admin applies the rules of the site type to a site through the internal function
-- @category historical-ms1
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hms_apply_type_rules('{{SITE_BEN}}'::uuid, 'a forged applicability');
-- @end

-- @case HMS-05
-- @title Alice calls the trigger function of the site type directly
-- @category historical-ms1
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hms_site_type_changed();
-- @end

-- @case HMS-06
-- @title Alice plants a site-type rule that makes A5 N/A on every site
-- @category historical-ms1
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason)
SELECT id, 'B1', NULL, 'flag', 'hub_terminal', 'security case' FROM workflow_definitions LIMIT 1;
-- @end

-- @case HMS-07
-- @title Alice replaces the scenario rules with a site-type rule through the admin function
-- @category historical-ms1
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_save_scenario_rules('[{"task_code":"B1","scenario":null,"rule":"flag","flag_expr":"hub_terminal","reason":"security case HMS-07"}]'::jsonb, 'security case HMS-07', NULL);
-- @end

-- @case HMS-08
-- @title The System Admin forges the marker of the Acquisition feed and flags a task as approved directly
-- @category historical-ms1
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.hms_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET historical_direct_approved = true, historical_direct_approved_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case HMS-09
-- @title The shape of the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the trigger, the rule seeded and the catch-up recorded
-- @category historical-ms1
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hms_apply_type_rules', 'hms_site_type_changed', 'hms_feed_task', 'hms_feed_acquisition', 'hms_catch_up')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p WHERE p.oid = 'public.hda_guard_task()'::regprocedure
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 5 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN EXISTS (SELECT 1 FROM g WHERE prosecdef OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guard'
  WHEN NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'z_hms_site_type' AND tgrelid = 'public.sites'::regclass) THEN 'trigger'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_save_scenario_rules(jsonb,text,integer)', 'EXECUTE') THEN 'settings door'
  WHEN NOT EXISTS (SELECT 1 FROM scenario_task_rules r WHERE r.task_code = 'A5' AND r.is_active AND r.scenario IS NULL AND r.rule = 'flag' AND r.flag_expr = 'hub_terminal') THEN 'rule'
  WHEN NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'historical_ms1_catch_up') THEN 'catch-up'
  ELSE 'ok' END;
-- @end
