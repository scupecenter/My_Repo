# [DRAFT-SPEC] Settings gap 4: forecast window (weeks) as a setting

Status: built in this PR (migration 0572, contract 0.15.431). Spec kept for the decisions.

## Agreed requirements
VELOCITY_WINDOW=4 is hardcoded in scurve.ts. Add the setting dashboard.forecast_window_weeks (integer, default 4, bounds 2-12), a field in Settings > Dashboard, read by scurve.ts at run time, audited like the other dashboard settings. Published forecasts already stored are not recomputed.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 4.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: 0572 / db 571 (the number 0571 is taken by another open PR, so the next free one in the block was used)
- Contract label: 0.15.431

## What was built
- Database (migration 0572, mirror `db/sql/571_forecast_window.sql`): `forecast_window_json()` and `admin_save_forecast_window(weeks, reason, version)`: `admin.settings` edit for all regions, reason, If-Match, a whole number 2 to 12, one audit row `forecast_window_update` with before and after. The setting `dashboard.forecast_window_weeks` is created on the first save; until then the default 4 (the old fixed value) applies. No new table, no data-reset entry.
- API: `GET` and `PUT /settings/dashboard/forecast-window` (own controller and service; reads need `dashboard.view`).
- Web: `scurve.ts` keeps `VELOCITY_WINDOW = 4` as the default and `weeklyVelocity(points, window)` already took a window; the progress curve card (`dashboardScurve.tsx`) now passes the setting. A "Forecast window" card in Settings > Dashboard with its own save, reason, audit and unsaved-changes guard.
- Nothing stored is recomputed: no forecast is stored; the date is drawn from the saved snapshots when the card opens.
