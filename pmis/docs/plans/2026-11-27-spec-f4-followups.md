# Spec: F4 Deliverables register follow-ups
Status: follow-up (1) built (migration 0610, contract 0.15.470); follow-up (2) waits for the L5 date alert. F4 itself is merged (#360, 975b83a5).
## (1) Project Status items read from the Deliverables register
Main 10:23:32 (from Ahmed), quoted: "Build (1) as stated (accepted share of non-cancelled deliverables, BILL weight 0, manual value kept with history), with these safeguards: the mapping and the formula mode are in Settings, per item a switch auto / manual-only (so Ahmed can turn any item back to manual), and the dashboard shows which source the number comes from (tooltip). Patch stored function text in place as you planned."
- Uses dash_build_manual, patched in place and idempotently.
## (2) Overdue notifications
Main 10:22:55, quoted: "reuse the date-alert (L5) mechanism the registers agent agent-01M8CVD6F75HHV6CK4EA2X888Q is building, do not build a second one; until L5 lands, prepare the register to expose its due-date fields to it."
- Main 0342_alert_rules is generic and is NOT the L5 date alert.

## Standing rules that apply (from Ahmed via Main)
Additive migrations only; hide, never delete; no permission widening; no security changes; nothing public; no dependency changes. Accumulating SQL functions are patched in place and idempotently. A new table needs a data_reset_plan() in-place patch and pmis_reset_owner grants. Any new public share link calls SecurityLocksService.assertSharingAllowed(); exports honour the disable_export lock. Docs, READMEs and the openapi history entry go in the same PR as the code. Each PR lists the places covered and excluded, the connections checked (registers, Settings, D55 hub, quick-access gear, links, rights, templates) and the auto-fill opportunities. Placement checklist: Settings, responsibility matrix, lookups, filter panel, dashboards, notifications, exports, search.

## Numbering
Reserved by Main (21:38): migrations 0610-0639 (db/sql one lower, 0609-0638) and labels 0.15.470-0.15.499 for all of agent 3's PRs. Re-verify against live main and open PRs before pushing; the first PR to merge keeps a number.
