# [DRAFT-SPEC] A2 Risk score

Status: built in this PR (migration 0780, contract 0.15.780).

## Agreed requirements
Risks have probability 1-5 and impact 1-5 but no score or level. Add a derived score = probability x impact with a banded level. No permissions change.

## Decisions and source
- Approved by Ahmed (proposal list approved 2026-11-26 23:16, build ordered 2026-11-28), relayed by the parent. Item A2 of the A/B review.
- Rules: reuse existing mechanisms, no AI features, no external BI, additive migrations only, no permission widening, Arabic and English everywhere, one PR per item.
- Migration and contract label numbers are checked against main and open PRs right before the build; none reserved yet.
- PR checklist when built: covered and excluded places with reasons, EN/AR keys, API and web tests, spec doc, HANDOVER, relations-map, openapi, Docs line and Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## What was built
- Score = probability x impact (each a whole number 1 to 5). Level = the band of the existing risk matrix (`riskBand`): low 1-4, medium 5-9, high 10-16, critical 20-25. A risk without a valid probability or impact shows neither.
- Computed on read in the register record mapping (`withRiskScore`), added to `data` as `risk_score` and `risk_level`. Nothing is stored, so history and the data reset plan are unaffected; no new table.
- Migration 0780 (mirror `db/sql/779_risk_score.sql`) adds two derived, read-only fields to the Risks register so the list, the record view and the column settings show them. Typing them is refused (`field_read_only`).
- Web: the level is shown translated (EN/AR) through `registers.risk_level_*`.
- No permission, role, grant or default changes. The bands are the existing matrix constants.
- Places covered: Risks list and record view. Left out: filters and sorting by score (the value is not stored), kept for a later step if wanted.
