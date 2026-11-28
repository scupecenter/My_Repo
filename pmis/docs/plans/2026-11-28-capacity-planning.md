# Resource capacity planning (migration 0666, contract 0.15.595)

Owner approval relayed 2026-11-28 (expert suggestion list, item 2). No spec text existed, so the choices below are mine and are open to change.

## What it does
Crews and skills per region against the planned tasks, week by week. Settings > Screens > Capacity planning holds the inputs. The Capacity screen (Work group of the side menu) shows the result.

## Choices
- **Inputs are one guarded setting** (`capacity.plan`), written only through `admin_set_capacity_plan` (System Admin or an all-regions delegate of `settings` edit, reason, step-up, If-Match, audit `capacity_plan_update`). No new table, so no data-reset change.
- **Capacity** per week = crew size x working days per week x usable share. A crew with several skills splits its days evenly between them, so no day counts twice.
- **Demand** = open tasks (locked, open, entry, in review, in approval; not N/A) by planned date, else due date, times the person-days entered for the task definition code. A late task counts in the first week. Tasks with no effort entry are shown as "not estimated" and add no load. Tasks with no date are counted once, outside the weeks.
- **Status of a cell**: up to 85 % ok, up to 100 % tight, above 100 % over; demand with no crew is over.
- **Visibility**: the plan follows the Site Register and Reports view rights and their region scope. The menu entry appears with the Workload entry (both need `sites` and `reports`).
- **Not done**: no automatic effort from history, no per-person calendars, no leave. They can be added on the same setting.

## Checked connections
Region scope (`reportRegions` pattern), settings guard triggers, nav catalogue (`nav_item_catalogue` row, `NAV_KEYS`, derived like the workload), screen-settings gear, mock API, real API list, Arabic RTL and English.
