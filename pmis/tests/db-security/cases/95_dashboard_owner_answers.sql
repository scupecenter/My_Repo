-- The dashboard follow-up of the owner answers (migration 0046): manual Project Status values (Q118), delay attribution periods (Q122) and the snapshot
-- schedule (Q127). The application role reads the three new tables and writes none of them: a manual value goes through ps_manual_set (Project Manager,
-- System Admin or an all-regions dashboard.project_status edit), a period through delay_period_add / delay_period_void (the task's reviewer, a System
-- Admin or dashboard.delay edit in the region), a snapshot run only through the daily job's dash_snapshot_weekly.

-- @case DA-01
-- @title Alice plants a manual Project Status value directly, skipping the right, the reason and the audit
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO ps_manual_values (item_code, version, value_pct, effective_date, reason, entered_by) VALUES ('8.1', 1, 100, cal_today(), 'planted', '{{ALICE}}');
-- @end

-- @case DA-02
-- @title Alice, who is neither the Project Manager nor an admin, enters a manual value through the function
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 Project Manager
SELECT ps_manual_set('8.1', 100, cal_today(), 'a reason');
-- @end

-- @case DA-03
-- @title Alice rewrites the history of the manual values
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE ps_manual_values SET value_pct = 100;
-- @end

-- @case DA-04
-- @title Alice deletes the history of the manual values
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM ps_manual_values;
-- @end

-- @case DA-05
-- @title The Tripoli-only delegate enters a project-wide manual value
-- @category dashboard
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 Project Manager
SELECT ps_manual_set('8.1', 100, cal_today(), 'a reason');
-- @end

-- @case DA-06
-- @title The System Admin enters a manual value on an item that is measured from tasks (not central)
-- @category dashboard
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_central_item
SELECT ps_manual_set('4.1', 50, cal_today(), 'a reason');
-- @end

-- @case DA-07
-- @title Alice plants a delay attribution period directly
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO task_delay_periods (task_id, site_id, region_id, from_date, to_date, party, reason, created_by)
SELECT t.id, t.site_id, t.region_id, cal_today() - 5, cal_today(), 'gecol', 'planted', '{{ALICE}}' FROM task_instances t LIMIT 1;
-- @end

-- @case DA-08
-- @title Alice voids or rewrites a period without the function
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_delay_periods SET party = 'aljeel';
-- @end

-- @case DA-09
-- @title Alice deletes the delay periods
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM task_delay_periods;
-- @end

-- @case DA-10
-- @title An anonymous session records a delay period through the function
-- @category dashboard
-- @actor none
-- @region 1
-- @expect error 42501 sign in first
SELECT delay_period_add(gen_random_uuid(), cal_today() - 3, cal_today(), 'gecol', NULL, 'a reason');
-- @end

-- @case DA-11
-- @title Alice voids a period that does not exist or is outside her regions (no hint either way)
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT delay_period_void(gen_random_uuid(), 'a reason');
-- @end

-- @case DA-12
-- @title Alice writes a snapshot run, so the schedule would skip a due date
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO dash_snapshot_runs (snapshot_date, kind) VALUES (cal_today(), 'weekly');
-- @end

-- @case DA-13
-- @title Alice runs the schedule for a date of her choosing
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_snapshot_scheduled(DATE '2026-05-31');
-- @end

-- @case DA-14
-- @title Alice calls the internal builders of the manual values and of the views
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_build_manual(cal_today(), NULL);
-- @end

-- @case DA-15
-- @title Alice, without the dashboard right, asks for the dashboard through the view entry point
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 cannot view the dashboard
SELECT dash_overview(NULL, NULL, NULL, NULL, NULL, true, 'CW');
-- @end

-- @case DA-16
-- @title Alice calls the internal calculation with a view, behind the entry points
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_core(cal_today(), NULL, NULL, NULL, NULL, NULL, true, NULL, ARRAY['headline'], NULL, 'none', NULL, true, 'CW');
-- @end

-- @case DA-17
-- @title Alice reads the manual values and the snapshot runs (allowed: project-wide figures, no write)
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect output >= 0
SELECT (SELECT count(*) FROM ps_manual_values) + (SELECT count(*) FROM dash_snapshot_runs);
-- @end
