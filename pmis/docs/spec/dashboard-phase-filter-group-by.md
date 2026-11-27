# Dashboard: quick filter and group-by Phase on Project Status (draft spec)

Status: DRAFT-SPEC. No code in this PR. The build goes into this same PR later.
Part 2 of the Phase scope package. Parts 1 and 3 (Phase scope card, derived targets, manual override) are in draft PR #465.

## Agreed requirements
- Source: Ahmed, relayed by Main, 2026-11-27 20:27-20:28 EET (phase scope "decide and execute", items 1-3 confirmed).
- A quick filter by Phase on the dashboard, and a group-by Phase on Project Status.
- Phase today lives only in the filter tree (site field `project_phase`). The quick filter must not widen anyone's data: it only narrows, like the filter tree.
- Everything automatic: no typed numbers. Phase values come from the sites table.
- NOT in scope: the phases reference table (item 4).
- Settings entries for show/hide/order, EN/AR, hover hints, docs. Dropdown values, if any, live in Settings dropdown management.
- Permissions come from the responsibility matrix, no widening. Additive migrations only. Nothing public.

## Plan
- API: `project_phase` parameter added to the dashboard site set (`filter-catalog.service` `siteSet`, same mechanism as the filter tree) and to the ops/extras site filters and the overview cache key.
- Project Status: `group_by=phase` in `GET /project-status`, built in TypeScript by running the existing engine once per phase site set (`pmis.dash_sites`). Do NOT replace `dash_project_status`.
- Web: a Phase chip in the dashboard filter bar. Tests, 5-shot pixel pass (en-light, ar-dark RTL, narrow, ar-light, print).

## Numbering reserved
- Contract label 0.15.368 (history entry at the END of the Versions list). Migration only if a Settings entry needs one: prisma 0525, db/sql 524.
