# Hardening layer 1a: Warehouse on the register locks (0103)

Status: built in this PR (migration 0565, contract 0.15.408).

Common rules for every layer 1 item: additive migrations only; hide, never delete; no permission widening; nothing public; EN and AR; settings for the feature; links and relations; connections checked and stated in the PR body (other registers, Settings, hub D55, gear and quick access, rights, templates); one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Source: hardening inventory of 2026-11-27, section 2 gaps 2 and 5, matrix rows 3, 7, 11, 12 (Warehouse and Daily Plan sit outside the register framework hardening).

## Agreed requirements
1. The Warehouse writer (`warehouse.service.ts`) goes through `reg_lock_check` like the register writers: a locked register or column refuses the write with the same reason and audit as in registers.controller.ts:114-130.
2. Lock administration (set, lift, reason, audit, step-up) is the existing 0103 screen. Warehouse is added as a lockable target there; no second lock UI.
3. Gap 5: `DELETE items/:id` (warehouse.controller.ts lines 131 and 188) is a real delete against the rule hide, never delete. Review it: replace by hide (inactive flag with reason and audit) unless the item was never used; keep movements untouched.
4. Settings: the lock target and the hide rule are visible in Settings; EN and AR.

## Decisions to confirm during the build
- Which Warehouse writes are lockable (items, movements, central items from #458).
- Whether hide replaces DELETE entirely or only for items with movements.

## Reserved numbers
prisma 0565, db/sql 564, contract label 0.15.408.



## Built (layer 1a)
Choices relayed 2026-11-27 (21:49): option A, a new lock model `entity_locks` and `entity_column_locks` with one lock UI, the same administer right, reason, audit and step-up; and hide-always for items. The 0103 tables are untouched.

- Migration `0565_entity_locks` (mirror `db/sql/564_entity_locks.sql`): the two tables (target kind plus id, or kind plus column), `ent_lock_require`, `ent_lock_check`, `ent_lock_set`, `ent_column_lock_set`. System Admins are exempt, as in `reg_lock_check`.
- Writers patched in place, idempotently, from the stored function text: `admin_save_warehouse_item`, `admin_save_warehouse_item_custom`, `wh_create_movement`, `wh_create_quarantine_exit`, `wh_cancel_movement`. A locked record or a locked column answers 403 `register_locked`. A column lock refuses a write that names the column, so the web form sends only changed fields (it already does).
- `admin_delete_warehouse_item` hides the item (`is_active` false, version moves, reason, audit `warehouse_item_hide`). Nothing is deleted. UI wording is "Hide". The route and the response keep their shape (`hidden` added).
- API: `GET /entity-locks`, `POST` and `DELETE` on `/entity-locks/{kind}/{id}` and `/entity-locks/columns/{kind}/{field}`; step-up required.
- Web: lock and unlock on each item (Warehouse > Items), a column-lock panel (every item column and every custom column), badge, EN and AR keys, mocks, tests.
- Rights: items need administer on `warehouse_items` in all regions; movements need administer on the Warehouse register in the movement's region; column locks need all regions.
- Data reset: both tables are KEEP (no foreign keys; the screen ignores a lock whose target is gone). Patched in place in `data_reset_plan()` plus `pmis_reset_owner` grants.
- Connections checked: Warehouse register (0103 record locks on movement records stay in force), item master and its custom columns (0159), Settings (lock screen shows the Warehouse targets), data reset, audit log, templates (a locked column also blocks a template import that sets it, because import uses the same writers), links and relations (no new link; hide keeps as-built links and movement lines).
- Not covered on purpose: unchanged-value resend for a locked column (refused if the key is sent; the form sends only changes); Daily Plan targets are used from migration 0566 (layer 1b, same tables).
