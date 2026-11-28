# [DRAFT-SPEC] Settings gap 8: health index bands

Status: built in this PR (migration 0574, contract 0.15.435). Spec kept for the decisions.

## Agreed requirements
dashboard.health_bands {green:85, amber:70} is a SQL setting (038:935), removed from the PUT dashboard contract. Expose it in Settings > Dashboard: read only at minimum, editable if the guard allows (green > amber, 0-100, reason, audit). Changing it must not rewrite stored history.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 8.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: 0574 / db 573 if editable (guard), else none
- Contract label: 0.15.435

## What was built
- Database (migration 0574, mirror `db/sql/573_health_bands.sql`): `health_bands_json()` reads the existing setting `dashboard.health_bands` (default 85 and 70, version 0 until the first save). `admin_save_health_bands(green, amber, reason, version)` needs `admin.settings` edit for all regions, a reason and If-Match; whole numbers, green 1 to 100, amber 0 to 99, green above amber; one audit row `health_bands_update` with before and after. No new table, so no data-reset classification is needed. The accumulating dashboard functions are not touched.
- API: `GET` and `PUT /settings/dashboard/health-bands` (`getHealthBands` needs `dashboard.view`, `setHealthBands` needs admin).
- Web: a "Health index bands" card at the top of Settings > Dashboard with its own save, reason and audit row. Invalid input is blocked on the screen with the same rule. The unsaved-changes guard is wired.
- History: only the live colouring changes from the save on. Stored weekly and month-end snapshots are never rewritten (an API test counts the snapshot rows before and after).
- The health index tile on the Dashboard already reads the setting; the query cache of the dashboard is refreshed after a save.
