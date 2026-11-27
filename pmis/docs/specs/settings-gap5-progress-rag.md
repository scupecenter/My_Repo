# [DRAFT-SPEC] Settings gap 5: RAG thresholds for the progress KPIs

Status: spec only, no code yet. The build goes into this same PR.

## Agreed requirements
The KPI catalog (0108) covers 10 operational KPIs only. Add SPI, progress vs plan and weekly velocity with green/amber thresholds to the catalog so the existing threshold editor covers them; seed defaults must reproduce today's colours so nothing changes on deploy; additive, hide never delete.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 5.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (verify live against main and open PRs before use)
- Migration: 0555 / db 554 (catalog rows)
- Contract label: 0.15.374
