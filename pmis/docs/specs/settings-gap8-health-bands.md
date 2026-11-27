# [DRAFT-SPEC] Settings gap 8: health index bands

Status: spec only, no code yet. The build goes into this same PR.

## Agreed requirements
dashboard.health_bands {green:85, amber:70} is a SQL setting (038:935), removed from the PUT dashboard contract. Expose it in Settings > Dashboard: read only at minimum, editable if the guard allows (green > amber, 0-100, reason, audit). Changing it must not rewrite stored history.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 8.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (verify live against main and open PRs before use)
- Migration: 0560 / db 559 if editable (guard), else none
- Contract label: 0.15.377
