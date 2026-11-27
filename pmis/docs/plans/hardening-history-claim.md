# Hardening layer 1c: History, FieldHistory and Claim/Triage for Warehouse and Daily Plan

Status: spec only.

Common rules for every layer 1 item: additive migrations only; hide, never delete; no permission widening; nothing public; EN and AR; settings for the feature; links and relations; connections checked and stated in the PR body (other registers, Settings, hub D55, gear and quick access, rights, templates); one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Source: hardening inventory of 2026-11-27, section 2 gaps 2 and 5, matrix rows 3, 7, 11, 12 (Warehouse and Daily Plan sit outside the register framework hardening).

## Agreed requirements
1. History tab and FieldHistory with Restore (RegisterDrawer.tsx:258,349,425 for registers): Warehouse and Daily Plan get the same view, fed by their audit rows. Restore goes through the normal write door with its rights, locks and reason.
2. Claim and Triage (0340, useRecordClaim and useRecordTriage): Warehouse records and Daily Plan rows get receive-and-sort with the same states and Matrix level; no second inbox.
3. Settings for both, EN and AR, links and relations checked.

## Open points for the build
- Daily Plan rows are per site and day, not records: define the claim target (plan row vs plan day).

## Reserved numbers
prisma 0567, db/sql 566, contract label 0.15.410.

