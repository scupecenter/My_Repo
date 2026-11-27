# Spec: program progress curve and forecast (delta only)
Status: not built. Source: standing order from Main 19:06.
## Agreed requirements
- Delta only on what exists: ops_scurve, migration 0300, lib/scurve.ts and dashboardScurve.tsx already exist.
- Add the program-level progress curve and a forecast on top of them; no second curve implementation.
- Dashboard card keeps its tooltip and source note; EN/AR, RTL, light/dark, narrow screenshots in the PR.
- Settings entry for the forecast method (so Ahmed can change it), listed in dashboard_settings_catalogue by in-place patch.

## Standing rules that apply (from Ahmed via Main)
Additive migrations only; hide, never delete; no permission widening; no security changes; nothing public; no dependency changes. Accumulating SQL functions are patched in place and idempotently. A new table needs a data_reset_plan() in-place patch and pmis_reset_owner grants. Any new public share link calls SecurityLocksService.assertSharingAllowed(); exports honour the disable_export lock. Docs, READMEs and the openapi history entry go in the same PR as the code. Each PR lists the places covered and excluded, the connections checked (registers, Settings, D55 hub, quick-access gear, links, rights, templates) and the auto-fill opportunities. Placement checklist: Settings, responsibility matrix, lookups, filter panel, dashboards, notifications, exports, search.

## Numbering
Reserved by Main (21:38): migrations 0610-0639 (db/sql one lower, 0609-0638) and labels 0.15.470-0.15.499 for all of agent 3's PRs. Re-verify against live main and open PRs before pushing; the first PR to merge keeps a number.
