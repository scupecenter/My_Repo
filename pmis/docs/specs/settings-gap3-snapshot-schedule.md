# [DRAFT-SPEC] Settings gap 3: dashboard snapshot weekday and interval as fields

Status: spec only, no code yet. The build goes into this same PR.

## Agreed requirements
dashboard.snapshot_weekday and dashboard.every_days are SQL-only settings read by jobs.service. Add two fields in Settings > Dashboard (validated: weekday 0-6 or named, every_days 1-31), saved with the existing dashboard settings save (reason, If-Match, audit), EN and AR labels, hints.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review (agent-01M8DW421X0B9K9DCW78C87E2Q), gap 3.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (verify live against main and open PRs before use)
- Migration: 0553 / db 552 if a seed or guard change is needed, else none
- Contract label: 0.15.372
