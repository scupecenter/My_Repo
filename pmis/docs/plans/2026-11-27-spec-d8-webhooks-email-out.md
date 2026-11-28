# Spec: D8 webhooks and email-out
Status: not built. Source: Main 8:27 (from Ahmed), quoted: "to be built with a settings switch to enable or disable it. Build with the safest defaults: off by default, admin-only config, audited, destinations set only by an admin, honours disable_export and sharing locks, no permission widening, secrets never logged or exposed, additive migrations, new tables classified in data_reset_plan via in-place patch."
## Requirements
- Settings switch (off by default); admin-only configuration; every change audited.
- Destinations set only by an admin; secrets stored through the existing secret mechanism, never logged or returned by the API.
- Honours disable_export and sharing locks; events carry no more than the receiving role could see.
- New tables in data_reset_plan() by in-place patch with pmis_reset_owner grants.

## Standing rules that apply (from Ahmed via Main)
Additive migrations only; hide, never delete; no permission widening; no security changes; nothing public; no dependency changes. Accumulating SQL functions are patched in place and idempotently. A new table needs a data_reset_plan() in-place patch and pmis_reset_owner grants. Any new public share link calls SecurityLocksService.assertSharingAllowed(); exports honour the disable_export lock. Docs, READMEs and the openapi history entry go in the same PR as the code. Each PR lists the places covered and excluded, the connections checked (registers, Settings, D55 hub, quick-access gear, links, rights, templates) and the auto-fill opportunities. Placement checklist: Settings, responsibility matrix, lookups, filter panel, dashboards, notifications, exports, search.

## Numbering
Reserved by Main (21:38): migrations 0610-0639 (db/sql one lower, 0609-0638) and labels 0.15.470-0.15.499 for all of agent 3's PRs. Re-verify against live main and open PRs before pushing; the first PR to merge keeps a number.
