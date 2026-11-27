# Hardening layer 1b: Daily Plan locks (0103)

Status: spec only.

Common rules for every layer 1 item: additive migrations only; hide, never delete; no permission widening; nothing public; EN and AR; settings for the feature; links and relations; connections checked and stated in the PR body (other registers, Settings, hub D55, gear and quick access, rights, templates); one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Source: hardening inventory of 2026-11-27, section 2 gaps 2 and 5, matrix rows 3, 7, 11, 12 (Warehouse and Daily Plan sit outside the register framework hardening).

## Agreed requirements
1. Daily Plan (`daily_plans`, `daily_plan_rows`, doors dp_save_row, dp_add_site, dp_remove_site, dp_lock, dp_unlock) has its own day lock (L2 locks, admin unlock with reason and step-up). Add the 0103 register lock path on top: an administrative lock of the Daily Plan target refuses writes through the doors with a reason and an audit row, whatever the day lock says.
2. No new write path: the check goes inside the existing doors, patched in place.
3. The Daily Plan template import (3b, separate PR) calls the same doors, so it obeys the lock automatically.
4. Settings, EN and AR, shown in the 0103 lock screen.

## Reserved numbers
prisma 0566, db/sql 565, contract label 0.15.409.

