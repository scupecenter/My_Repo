# [DRAFT-SPEC] A6 Delay-period suggestion

Status: built in this PR (no migration, contract 0.15.782).

## Agreed requirements
When a task passes planned_date or its SLA turns red, suggest a delay period with dates prefilled and the party guessed from the task group (C1/C2 gecol, C3/C4 hlc). One open suggestion per task. Suggestion only, never auto-written. Related: merged #469 daily delay log.

## Decisions and source
- Approved by Ahmed (proposal list approved 2026-11-26 23:16, build ordered 2026-11-28), relayed by the parent. Item A6 of the A/B review.
- Rules: reuse existing mechanisms, no AI features, no external BI, additive migrations only, no permission widening, Arabic and English everywhere, one PR per item.
- Migration and contract label numbers are checked against main and open PRs right before the build; none reserved yet.
- PR checklist when built: covered and excluded places with reasons, EN/AR keys, API and web tests, spec doc, HANDOVER, relations-map, openapi, Docs line and Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## What was built
- `suggestion` on `GET /tasks/{id}/delay-periods`, computed on read from the task (state, planned date, SLA colour from the task's own SLA rule, the calendar's today) and its existing periods. Nothing is stored and nothing is proposed or written by itself; the person fills the usual form (reason is still theirs to type) and proposes through the existing flow, so approval, audit and rights are unchanged.
- When: the task is still running (open, entry, in review, in approval) and its planned date has passed, or its SLA colour is red. Dates: from the day after the planned date (from today when only the SLA is red), to today. If a proposed or approved period already exists, the suggestion starts after the last one; when a period already covers today, nothing is suggested (one open suggestion per task). Voided and rejected periods do not count.
- Party guessed from the task group: C1 and C2 gecol, C3 and C4 hlc, any other task none (left empty). Only a person who may propose sees it.
- Web: a box above the form in the delay-period panel of the task drawer with a "Fill the form with the suggestion" button (EN/AR).
- Covered: the task drawer delay-period panel, the only place delay periods are proposed. Related: the daily delay log (#469) is separate and unchanged. Left out: a separate notification for the suggestion (not approved).
- Tests: pure rule unit tests (`test/delay-suggestion.test.ts`), web test with a mock late task.
