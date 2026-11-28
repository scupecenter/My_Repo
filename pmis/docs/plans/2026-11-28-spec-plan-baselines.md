# Spec: plan baselines, freeze and variance (contract 0.15.480, migration 0621)

Choices
- The official baselines (`baseline_versions`, `baseline_entries`, approved versions) already drive the sites and the dashboard. They are not touched. A freeze is an independent copy (`plan_freezes`, `plan_freeze_rows`: site, region, milestone, date), so a later re-baseline cannot change what a freeze says. No foreign key to sites, so the rows never block a site change.
- Freeze and hide: System Admin only (conservative; no new grant or role). Read: view on the dashboard module, rows limited to the caller's regions (`wf_actor_regions`), optional region filter.
- Variance: calendar days, actual (approved milestone task, actual date else approved date) minus frozen date; an open row past its date counts up to today. Per stage, per region, 50 worst rows. Computed on read in one query; nothing is written by the report.
- Hide, never delete. Audit `plan_freeze_create` and `plan_freeze_hide`. At most 50 frozen plans.
- Data reset: both tables classified `mixed` over the sites part (patched in place, idempotent, anchor check), reset grants added.
- Screen: Reports > Workload, section "Plan baselines". English and Arabic, tooltips, tests, mock handlers.

Not done on purpose: comparing two frozen plans with each other; changing official baselines from here.
