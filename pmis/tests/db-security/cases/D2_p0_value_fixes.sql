-- P0 value fixes (migration 0119, contract 0.15.33): dash_drill_sites (the sites a dashboard card counts) is a read door with the definer rules;
-- fa_after (redefined) is an internal trigger function, never a door of the application role; the new reservation state `cancelled` is written
-- only by that trigger, never directly. Alice: CW Team Lead in Tripoli (region 1). ADMIN: the System Admin.
-- Each case runs in a transaction that the runner rolls back.

-- @case P0-01
-- @title dash_drill_sites and fa_after are SECURITY DEFINER with search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; only dash_drill_sites is a door of pmis_app
-- @category p0-value-fixes
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('dash_drill_sites', 'fa_after')
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 2 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN NOT (SELECT app FROM f WHERE proname = 'dash_drill_sites') THEN 'door not granted'
  WHEN (SELECT app FROM f WHERE proname = 'fa_after') THEN 'trigger function granted to pmis_app'
  ELSE 'ok' END;
-- @end

-- @case P0-02
-- @title Without a signed-in actor the drill-down set is refused (the dashboard scope of dash_overview)
-- @category p0-value-fixes
-- @expect error 42501 sign in first
SELECT dash_drill_sites(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'MS6');
-- @end

-- @case P0-03
-- @title The System Admin cancels reservations by a direct update (only the trigger of a voided vehicle does it, with its audit row): row security leaves no row to change
-- @category p0-value-fixes
-- @actor ADMIN
-- @region *
-- @expect output 0
WITH u AS (UPDATE vehicle_reservations SET state = 'cancelled', released_at = now() RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case P0-04
-- @title Alice inserts a cancelled reservation directly
-- @category p0-value-fixes
-- @actor ALICE
-- @region 1
-- @expect error 42501 written only through reg_
INSERT INTO vehicle_reservations (vehicle_entity_id, booking_entity_id, booking_record_id, period, state)
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), daterange(current_date, current_date + 1), 'cancelled');
-- @end

-- @case P0-05
-- @title Positive control: the System Admin reads the drill-down set of a milestone and of a status (an array, possibly empty)
-- @category p0-value-fixes
-- @actor ADMIN
-- @region *
-- @expect output true|true
SELECT (dash_drill_sites(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'MS6') IS NOT NULL)::text || '|' || (dash_drill_sites(NULL, NULL, NULL, NULL, NULL, NULL, 'in_progress', NULL) IS NOT NULL)::text;
-- @end
