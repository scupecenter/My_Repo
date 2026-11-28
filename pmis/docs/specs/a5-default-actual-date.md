# [DRAFT-SPEC] A5 Default actual date

Status: built in this PR (no migration, contract label 0.15.781).

## Agreed requirements
Approval refuses a task with no actual_date. Prefill the actual date with today or the submitted date; editable and shown prominently.

## Decisions and source
- Approved by Ahmed (proposal list approved 2026-11-26 23:16, build ordered 2026-11-28), relayed by the parent. Item A5 of the A/B review.
- Rules: reuse existing mechanisms, no AI features, no external BI, additive migrations only, no permission widening, Arabic and English everywhere, one PR per item.
- Migration and contract label numbers are checked against main and open PRs right before the build; none reserved yet.
- PR checklist when built: covered and excluded places with reasons, EN/AR keys, API and web tests, spec doc, HANDOVER, relations-map, openapi, Docs line and Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## What was built
- Web only, no migration, no API change. In the task drawer, when the person can edit and submit, the task is not a milestone task with an automatic date, and it has no actual date, the Actual date field shows today as the default with a prominent line saying it is the default and is saved on submit.
- Nothing is saved until Submit. Submit saves the shown date first (`PATCH /tasks/{id}`, If-Match), then submits with the new version. If the person typed another date, that date is used. The "mandatory fields missing: actual_date" line is no longer shown while the default stands.
- The server rule is unchanged: submit still refuses a task with no actual date. No permission, role or default value changes.
- Date used is today in the browser's local date. Places covered: the task drawer (the Site page, approvals and registers open the same drawer). Left out: the inline date edit in the task grid (a person types there on purpose) and bulk submit (no date is chosen there).
