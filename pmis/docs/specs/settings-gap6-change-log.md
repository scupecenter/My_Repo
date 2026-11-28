# Settings gap 6: visible change log for Dashboard and Goals settings

Status: built in this PR (contract 0.15.433, migration 0576, mirror `db/sql/575_settings_change_log.sql`).

## Agreed requirements
Dashboard and Goals settings show only a version number and the last editor. Add an audit list (who, when, reason, what changed) for both, reusing the weight-set versions table pattern and the audit rows already written; read only, same rights as the settings screen.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 6.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: 0576 / db 575 (a guarded read function over the audit rows; no new table, no new write)
- Contract label: 0.15.433

## Built
- `GET /settings/change-log?scope=dashboard|goals&limit=` (`admin.settings` view, the same right as the screens): the newest audit rows of the dashboard settings (settings, health bands, snapshot weekday, forecast window) or of the goals, with the time, the actor, the reason and the fields that changed (before and after).
- Read function `settings_change_log(scope, limit)`: reads only `audit_log` rows of entity type `setting` for those keys; at most 200 rows; returns no other entity's rows, so the audit log's own reader rules are not widened.
- Web: a read-only "Change log" card under Settings > Dashboard and under Settings > Goals (`SettingsChangeLog.tsx`), English and Arabic.
- The key list already includes the progress colours setting (gap 5, `dashboard.progress_rag`); until that PR merges it simply has no rows.
