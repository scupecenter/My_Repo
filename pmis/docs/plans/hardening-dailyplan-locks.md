# Hardening layer 1b: Daily Plan locks (0103)

Status: built in this PR (migration 0566, contract 0.15.409). Stacked on #495 (L1a, migration 0565), which holds the lock tables: merge #495 first.

Common rules for every layer 1 item: additive migrations only; hide, never delete; no permission widening; nothing public; EN and AR; settings for the feature; links and relations; connections checked and stated in the PR body (other registers, Settings, hub D55, gear and quick access, rights, templates); one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Source: hardening inventory of 2026-11-27, section 2 gaps 2 and 5, matrix rows 3, 7, 11, 12 (Warehouse and Daily Plan sit outside the register framework hardening).

## Agreed requirements
1. Daily Plan (`daily_plans`, `daily_plan_rows`, doors dp_save_row, dp_add_site, dp_remove_site, dp_lock, dp_unlock) has its own day lock (L2 locks, admin unlock with reason and step-up). Add the 0103 register lock path on top: an administrative lock of the Daily Plan target refuses writes through the doors with a reason and an audit row, whatever the day lock says.
2. No new write path: the check goes inside the existing doors, patched in place.
3. The Daily Plan template import (3b, separate PR) calls the same doors, so it obeys the lock automatically.
4. Settings, EN and AR, shown in the 0103 lock screen.

## Reserved numbers
prisma 0566, db/sql 565, contract label 0.15.409.



## Built (layer 1b)
Choices relayed 2026-11-27 (21:49): option A (the `entity_locks` and `entity_column_locks` of 0565, one lock UI, the same administer right, reason, audit and step-up).

- Migration `0566_daily_plan_locks` (mirror `db/sql/565_daily_plan_locks.sql`), no new table. Patched in place, idempotently, from the stored text: `dp_for_change` (the door of every plan write, also the template import of 0564) refuses a locked plan; `dp_save_row`, `dp_remove_site` and `dp_add_site` refuse a locked row; `dp_save_row` also refuses a locked column (an override key, Reason or Remark) named in the body. `dp_plan_head` gains `plan_id` and `entity_locked`, and `can_edit` is false for a non-admin on a locked plan. `dp_row_json` gains `row_id`.
- System Admins are exempt, as in the register locks. The day lock of 0149 (lock, unlock, auto lock, override) is unchanged and separate.
- Right: `dp_right(actor, region, 'administer')` for a plan or row in its region; a column lock needs administer in some region and applies to every plan.
- Web (Daily Plan): lock and unlock of a plan (per region chip) and of a stored row, a column-lock panel (all manual columns, Reason, Remark), badge, EN and AR (shared `entity_locks` keys), mocks, tests. Shown to a System Admin; the database decides the right.
- Contract 0.15.409: `plan_id`, `entity_locked`, `row_id`; no new route (the 0.15.408 routes take the kinds `daily_plan` and `daily_plan_row`).
- Data reset: nothing new (the tables are KEEP since 0565).
- Connections checked: Daily Plan doors and the template import (0564 calls the same doors), the day lock, the Matrix level of L1 (unchanged), Settings (the locks are managed on the Daily Plan screen, next to the existing lock), audit, links and relations (a plan or row lock does not touch site, task or Procurement links), auto-fill (rows still fill from system data; a locked row keeps its stored values).
- Deliberate exclusions: a row that has never been stored (an auto row nobody changed) has no `row_id` and cannot be locked on its own; lock the plan or the column instead. A locked column refuses a body that names it, even with an unchanged value.
