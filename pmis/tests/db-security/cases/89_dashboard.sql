-- The main dashboard, weight sets and snapshots (migration 0039). The dashboard functions run as pmis_definer and read only; the application role
-- reaches them through dash_overview / dash_project_status, which limit every figure to the regions of the caller's own dashboard.view grant. Weight
-- sets change only through admin_* functions (reason, audit, 100% rule) and snapshots only through dash_snapshot_take; the application role writes
-- neither table directly.

-- @case DB-01
-- @title Alice, who holds no dashboard grant, asks for the dashboard
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 cannot view the dashboard
SELECT dash_overview(NULL, NULL, NULL, NULL, NULL, true);
-- @end

-- @case DB-02
-- @title Alice asks for Project Status without the dashboard right
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 cannot view the dashboard
SELECT dash_project_status(NULL, NULL, NULL, 'none', NULL, true);
-- @end

-- @case DB-03
-- @title Alice calls the internal calculation entry point, which sits behind the two entry points
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_core(cal_today(), NULL, NULL, NULL, NULL, NULL, true, NULL, ARRAY['headline'], NULL, 'none', NULL, true);
-- @end

-- @case DB-04
-- @title Alice changes a weight directly
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE weight_items SET weight = 100;
-- @end

-- @case DB-05
-- @title Alice plants a weight set directly, skipping the reason, the audit and the 100% rule
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO weight_sets (code, version, effective_from, status, reason, changed_by) VALUES ('project_status', 99, cal_today(), 'draft', 'x', '{{ALICE}}');
-- @end

-- @case DB-06
-- @title Alice writes a snapshot row for a site
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO site_snapshots (snapshot_date, site_id, region_id, overall_status, ms, streams, items) SELECT cal_today(), id, region_id, 'completed', '{}', '{}', '{}' FROM sites LIMIT 1;
-- @end

-- @case DB-07
-- @title Alice deletes the saved Project Status history
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM progress_snapshots;
-- @end

-- @case DB-08
-- @title Alice takes a snapshot for a date of her choosing
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_snapshot_take(cal_today());
-- @end

-- @case DB-09
-- @title Alice, who is not an admin, saves a weight set through the admin function
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_save_weight_set(NULL, 'project_status', NULL, 'a reason', NULL, NULL);
-- @end

-- @case DB-10
-- @title Alice publishes a weight set through the admin function
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_publish_weight_set(gen_random_uuid(), cal_today(), 'a reason', NULL);
-- @end
