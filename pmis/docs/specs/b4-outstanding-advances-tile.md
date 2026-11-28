# [DRAFT-SPEC] B4 Outstanding-advances money tile

Status: spec only in this draft PR; the build follows on this branch.

## Agreed requirements
A read-only aggregate tile of the money in the field (outstanding financial advances) per custodian and per site. It respects the register permissions: visible only to the finance officer and the project manager (owner decision 2026-11-26 23:15). Read only: it writes nothing.

## Decisions and source
- Approved by Ahmed (proposal list approved 2026-11-26 23:16, build ordered 2026-11-28), relayed by the parent. Item B4 of the A/B review.
- Rules: reuse existing mechanisms, no AI features, no external BI, additive migrations only, no permission widening, Arabic and English everywhere, one PR per item.
- Migration and contract label numbers are checked against main and open PRs right before the build; none reserved yet.
- PR checklist when built: covered and excluded places with reasons, EN/AR keys, API and web tests, spec doc, HANDOVER, relations-map, openapi, Docs line and Arabic changelog entry in the PR body (no CHANGELOG.md edit).
