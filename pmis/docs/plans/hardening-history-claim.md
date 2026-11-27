# Hardening layer 1c: History, FieldHistory and Claim/Triage for Warehouse and Daily Plan

Status: built (migration 0567, contract 0.15.410).

Common rules for every layer 1 item: additive migrations only; hide, never delete; no permission widening; nothing public; EN and AR; settings for the feature; links and relations; connections checked and stated in the PR body (other registers, Settings, hub D55, gear and quick access, rights, templates); one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Source: hardening inventory of 2026-11-27, section 2 gaps 2 and 5, matrix rows 3, 7, 11, 12 (Warehouse and Daily Plan sit outside the register framework hardening).

## Agreed requirements
1. History tab and FieldHistory with Restore (RegisterDrawer.tsx:258,349,425 for registers): Warehouse and Daily Plan get the same view, fed by their audit rows. Restore goes through the normal write door with its rights, locks and reason.
2. Claim and Triage (0340, useRecordClaim and useRecordTriage): Warehouse records and Daily Plan rows get receive-and-sort with the same states and Matrix level; no second inbox.
3. Settings for both, EN and AR, links and relations checked.

## Open points for the build
- Daily Plan rows are per site and day, not records: define the claim target (plan row vs plan day).

## Reserved numbers
prisma 0567, db/sql 566, contract label 0.15.410.


## Built
- Migration 0567 (mirror db/sql/566): `hist_changes`, `wh_item_history(item)`, `dp_plan_history(region, date)`, all fed by the audit rows. Triage and claim columns on `daily_plans` (no new table, so `data_reset_plan` is unchanged). Functions `dp_plan_triage_get`, `dp_plan_claim`, `dp_plan_triage`; trigger `dp_triage_default` (new days start pending, existing days stay untriaged).
- Claim and triage target of a Daily Plan: the plan day of a region (region + date). Same states and level as 0340, the L2 holder or a System Admin. Only accepted and deferred apply to a plan day. Row-level history comes from the audit rows. Row-level claim is not built.
- Warehouse item master: History with the field changes, Restore sends the old values through the normal writer (PATCH items/:id) with a reason, so rights, locks and audit apply.
- Warehouse movements are register records and already have Claim and Release (0340). Triage for them is not switched on, because it would put every new movement in a queue; that is a setting for the owner to decide.
