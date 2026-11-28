# Daily Plan template and import (hardening layer 3b)

Contract 0.15.407, migration 0564 (mirror `db/sql/563_daily_plan_template.sql`).

## Choices recorded (owner choices relayed 2026-11-27 21:33)
1. How to import: a dedicated template `TPL-DAILY-PLAN` (kind `daily_plan`) and `POST /daily-plans/import` that validates every row and applies it through the existing doors `dp_add_site`, `dp_save_row` and `dp_remove_site`, all or nothing. The shared staged-import functions are not touched (only `tpl_sync` gets one more branch, patched in place).
2. What the file may change: the Reason, the Remark, the manual values of the auto-filled columns that `dp_save_row` accepts, sites added by hand (a row for a site not in the plan) and sites removed by hand (`Remove from plan` = yes). Site name and Region are read only and ignored. A cell equal to the value now shown, or empty, changes nothing. A locked day is refused per row.

## Connections checked
- Daily Plan screen: More menu gets "Download template (this day)" and "Import from template" (only where the user can edit a plan). Export and Copy for email are unchanged.
- Templates page and the Data hub quick bar: the template is listed (download here, upload on the Daily Plan page, like holidays and list values).
- Rights: the template is listed for who has view on Daily Plan or Sites; every row goes through the doors, so L1 (entry) of the region, the region scope and the day lock apply per row. No grant is added or widened.
- Audit: each row is audited by the door; the file adds `daily_plan.template_import`. Rejections go to the System Log.
- Settings: no new setting; the template follows the Daily Plan settings (columns and region scope) through the doors. Data reset: no new table, no change.
- Other registers: Daily Plan is not a register; its columns are auto-filled from sites, tasks, procurement and permits, so only manual overrides are typed in the file.
- Sub-streams: Permits sub-streams (CW, TE, ACQ, OM) share the one `TPL-PERMITS` (the permit type column carries every active type); Procurement-HLC is covered by `TPL-HLC`. A test checks both are listed, versioned and downloadable and that the permit type column lists every active type.

## Not in this PR
Layer 1 (locks 0103, History, Claim/Triage for Warehouse and Daily Plan) has its own spec PRs: #495, #508, #501.
