-- Work package P2 of the owner answers of 2026-11-04 (migration 0059): plans of the manual Project Status items (Q177), the source and the month
-- limit of manual values (Q176, Q178), proposed and decided delay periods (Q182, Q184) and the pipeline style setting (Q116). The application role
-- reads the plans and writes nothing directly; every write goes through a SECURITY DEFINER function that checks the actor.

-- @case P2-01
-- @title Alice plants a plan of a manual item directly, skipping the right, the cumulative rule and the audit
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO ps_manual_plans (item_code, version, points, reason, source, entered_by) VALUES ('8.1', 1, '[{"date": "2026-01-01", "planned_pct": 100}]', 'planted', 'none', '{{ALICE}}');
-- @end

-- @case P2-02
-- @title Alice, who is neither the Project Manager nor an admin, sets a plan through the function
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 Project Manager
SELECT ps_manual_plan_set('8.1', '[{"date": "2026-01-01", "planned_pct": 100}]'::jsonb, 'a reason', 'a source');
-- @end

-- @case P2-03
-- @title The Tripoli-only delegate sets a project-wide plan
-- @category dashboard
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 Project Manager
SELECT ps_manual_plan_set('8.1', '[{"date": "2026-01-01", "planned_pct": 100}]'::jsonb, 'a reason', 'a source');
-- @end

-- @case P2-04
-- @title Alice rewrites or deletes a plan
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE ps_manual_plans SET points = '[]';
-- @end

-- @case P2-05
-- @title Alice approves a delay period by writing its status, skipping the decider check and the no-self-approval rule
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_delay_periods SET status = 'approved', decided_by = '{{ALICE}}', decided_at = now();
-- @end

-- @case P2-06
-- @title An anonymous session decides a delay period through the function
-- @category dashboard
-- @actor none
-- @region 1
-- @expect error 42501 sign in first
SELECT delay_period_decide(gen_random_uuid(), 'approve', NULL, NULL);
-- @end

-- @case P2-07
-- @title Alice decides a period that does not exist or is outside her regions (no hint either way)
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT delay_period_decide(gen_random_uuid(), 'approve', NULL, NULL);
-- @end

-- @case P2-08
-- @title Alice proposes a period on a task that does not exist or is outside her regions
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT delay_period_propose(gen_random_uuid(), cal_today() - 3, cal_today(), 'gecol', NULL, 'a reason', 'evidence');
-- @end

-- @case P2-09
-- @title Alice changes the pipeline style without the dashboard administer right
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 pipeline style
SELECT dash_set_pipeline_variant('B', 'a reason');
-- @end

-- @case P2-10
-- @title Alice calls the internal delay calculation behind the entry points
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_sec_delay(cal_today());
-- @end

-- @case P2-11
-- @title Alice calls the internal date helper of the snapshot rules
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT dash_local_date(now());
-- @end

-- @case P2-12
-- @title Alice may not enter a historical correction (no dashboard.historical_correction)
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect output f
SELECT ps_manual_can_correct();
-- @end

-- @case P2-13
-- @title Alice reads the plans and the pipeline style (allowed: project-wide data, no write)
-- @category dashboard
-- @actor ALICE
-- @region 1
-- @expect output A
SELECT dash_pipeline_variant() || (SELECT CASE WHEN count(*) >= 0 THEN '' END FROM ps_manual_plans);
-- @end
