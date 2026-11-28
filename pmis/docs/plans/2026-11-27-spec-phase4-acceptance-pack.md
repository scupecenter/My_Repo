# Spec: consolidated site acceptance pack (field mode phase 4)
Status: not built. Source: standing order from Main 19:06 (from Ahmed): all remaining work implemented as PRs.
## Agreed requirements
- One consolidated site acceptance pack for the client, built from the existing PAC, FAC and HOTO documents of a site.
- Built with the existing zip.service (no new dependency); output is one archive per site with an index.
- Honours the disable_export lock and sharing locks; no new public link (if a link is ever offered it calls SecurityLocksService.assertSharingAllowed()).
- Rights follow the responsibility matrix; no widening.
## Open details to settle while building (from the code, not from Ahmed)
- Which document states are included (approved only is the safe default); file naming; Arabic and English index.

## Standing rules that apply (from Ahmed via Main)
Additive migrations only; hide, never delete; no permission widening; no security changes; nothing public; no dependency changes. Accumulating SQL functions are patched in place and idempotently. A new table needs a data_reset_plan() in-place patch and pmis_reset_owner grants. Any new public share link calls SecurityLocksService.assertSharingAllowed(); exports honour the disable_export lock. Docs, READMEs and the openapi history entry go in the same PR as the code. Each PR lists the places covered and excluded, the connections checked (registers, Settings, D55 hub, quick-access gear, links, rights, templates) and the auto-fill opportunities. Placement checklist: Settings, responsibility matrix, lookups, filter panel, dashboards, notifications, exports, search.

## Numbering
Reserved by Main (21:38): migrations 0610-0639 (db/sql one lower, 0609-0638) and labels 0.15.470-0.15.499 for all of agent 3's PRs. Re-verify against live main and open PRs before pushing; the first PR to merge keeps a number.
