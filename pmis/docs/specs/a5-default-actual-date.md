# [DRAFT-SPEC] A5 Default actual date

Status: spec only in this draft PR; the build follows on this branch.

## Agreed requirements
Approval refuses a task with no actual_date. Prefill the actual date with today or the submitted date; editable and shown prominently.

## Decisions and source
- Approved by Ahmed (proposal list approved 2026-11-26 23:16, build ordered 2026-11-28), relayed by the parent. Item A5 of the A/B review.
- Rules: reuse existing mechanisms, no AI features, no external BI, additive migrations only, no permission widening, Arabic and English everywhere, one PR per item.
- Migration and contract label numbers are checked against main and open PRs right before the build; none reserved yet.
- PR checklist when built: covered and excluded places with reasons, EN/AR keys, API and web tests, spec doc, HANDOVER, relations-map, openapi, Docs line and Arabic changelog entry in the PR body (no CHANGELOG.md edit).
