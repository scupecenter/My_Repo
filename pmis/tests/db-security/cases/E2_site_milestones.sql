-- Stored current and next milestone of a site (migration 0131, Master FX / FY). site_milestone_derive, site_milestones_refresh and the trigger function
-- site_ms_after_task_rows are internal; site_status_refresh (0122, redefined in 0131) stays internal. The application role calls none of them: the columns
-- follow the milestones through calc_refresh_site and the task_instances statement triggers only. Alice: CW Team Lead in Tripoli. Each case is rolled back.

-- @case SM-01
-- @title Alice refreshes the stored milestones of a site herself
-- @category site-milestones
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT site_milestones_refresh('00000000-0000-4000-8000-000000000001'::uuid);
-- @end

-- @case SM-02
-- @title Alice calls the internal rule that derives the milestones
-- @category site-milestones
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT site_milestone_derive('00000000-0000-4000-8000-000000000001'::uuid);
-- @end

-- @case SM-03
-- @title Alice calls the redefined site_status_refresh, with a forged all-regions setting
-- @category site-milestones
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT site_status_refresh('00000000-0000-4000-8000-000000000001'::uuid);
-- @end

-- @case SM-04
-- @title Control: the shape of the four functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked) and no right for pmis_app
-- @category site-milestones
-- @actor ALICE
-- @region 1
-- @expect output 4|0
SELECT concat_ws('|',
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('site_milestone_derive', 'site_milestones_refresh', 'site_status_refresh', 'site_ms_after_task_rows')
     AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer' AND p.proconfig::text LIKE '%pg_temp%'
     AND NOT has_function_privilege('public', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('site_milestone_derive', 'site_milestones_refresh', 'site_status_refresh', 'site_ms_after_task_rows')
     AND has_function_privilege('pmis_app', p.oid, 'EXECUTE')));
-- @end
