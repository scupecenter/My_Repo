# Spec: A8 readiness_handover / O&M acceptance warning
Status: not built (verified not merged 19:22).
## Requirements
- On submit of the readiness handover (O&M acceptance), show the open snag, issue and quality counts of the site and ask for confirmation.
- Warn, do not block: the user may confirm and continue.
- Counts come from the existing registers; no new data entry.

## Standing rules that apply (from Ahmed via Main)
Additive migrations only; hide, never delete; no permission widening; no security changes; nothing public; no dependency changes. Accumulating SQL functions are patched in place and idempotently. A new table needs a data_reset_plan() in-place patch and pmis_reset_owner grants. Any new public share link calls SecurityLocksService.assertSharingAllowed(); exports honour the disable_export lock. Docs, READMEs and the openapi history entry go in the same PR as the code. Each PR lists the places covered and excluded, the connections checked (registers, Settings, D55 hub, quick-access gear, links, rights, templates) and the auto-fill opportunities. Placement checklist: Settings, responsibility matrix, lookups, filter panel, dashboards, notifications, exports, search.

## Numbering
Reserved at build time from live main (Main 20:42 range: prisma 0556 or higher, label 0.15.379 or higher, db/sql one lower than prisma). Re-verify against live main and open PRs before pushing; the first PR to merge keeps a number.

