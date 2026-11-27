# Hardening layer 1a: Warehouse on the register locks (0103)

Status: spec only.

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

