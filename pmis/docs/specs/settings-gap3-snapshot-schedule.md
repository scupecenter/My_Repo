# [DRAFT-SPEC] Settings gap 3: dashboard snapshot weekday and interval as fields

Status: built in this PR (migration 0570, contract 0.15.430). Spec kept for the decisions.

## Agreed requirements
dashboard.snapshot_weekday and dashboard.every_days are SQL-only settings read by jobs.service. Add two fields in Settings > Dashboard (validated: weekday 0-6 or named, every_days 1-31), saved with the existing dashboard settings save (reason, If-Match, audit), EN and AR labels, hints.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review (agent-01M8DW421X0B9K9DCW78C87E2Q), gap 3.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: 0570 / db 569 only if a guard or seed change is needed
- Contract label: 0.15.430

## What was built (and one change from the agreed text)
- Only the weekday is a field. `dashboard.snapshot_every_days` (the "every_days 1-31" of the agreed text) has been documented as unused since migration 0046: the weekly snapshot is taken on `dashboard.snapshot_weekday` and a month-end snapshot on the last day of each month. A field for it would change nothing, so it is not exposed (rule: nothing inert). Reported in the PR body.
- Database (migration 0570, mirror `db/sql/569_snapshot_weekday.sql`): `snapshot_weekday_json()` and `admin_save_snapshot_weekday(weekday, reason, version)`: `admin.settings` edit for all regions, reason, If-Match, a whole number 0 to 6, one audit row `snapshot_weekday_update` with before and after. The version is the seconds of the last change (0 until the first save). The nightly job and the weekly-snapshot rule read the same setting as before. No new table, no data-reset entry.
- API: `GET` and `PUT /settings/dashboard/snapshot-schedule` (own controller and service, so it does not collide with the other dashboard settings PRs).
- Web: a "Weekly snapshot day" card in Settings > Dashboard with the seven weekday names (the existing `weekday.N` keys), its own save, reason and audit row, and the unsaved-changes guard.
- A change applies from the next snapshot; stored snapshots are never moved or rewritten (an API test counts the stored snapshot rows before and after).
