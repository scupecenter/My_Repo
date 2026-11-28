# Phase 5: program progress curve and forecast (delta)

Status: built in this PR (migration 0612, contract 0.15.474). Source: the phase 5 spec (docs/plans/2026-11-27-spec-phase5-scurve-forecast.md); the picks below were confirmed by the parent on 2026-11-28 10:08.

## What already existed (reused, no second curve)
`ops_scurve`, `lib/scurve.ts`, `dashboardScurve.tsx` and the weekly Project Status snapshots (`GET /project-status/snapshots`) already draw the program-level planned and actual curve, the weekly velocity and the forecast date. Nothing of that is duplicated.

## Delta built
- Setting `dashboard.forecast_method`: `mean` (the mean weekly gain over the last weeks, the default and the former fixed behaviour, so nothing changes on deploy) or `linear` (the slope of a least squares line through the actual points of the same weeks).
- Database (migration 0612, mirror `db/sql/611_forecast_method.sql`): `forecast_method_json()` and `admin_save_forecast_method(method, reason, version)`: `admin.settings` edit for all regions, reason, If-Match, audited as `forecast_method_update`. No new table, so no data-reset entry.
- API: `GET` and `PUT /settings/dashboard/forecast-method` (own controller and service; reads need `dashboard.view`).
- Web: `weeklyVelocity(points, window, method)` in `lib/scurve.ts` (pure, unit tested); the card reads the setting and draws the forecast as a dotted line from the last actual point to 100 % on the forecast date, keeping its tooltip, source note and hint. A "Forecast method" card in Settings > Dashboard (own save, reason, audit, unsaved-changes guard).
- Nothing stored is recomputed: no forecast is stored; the date and the line are drawn from the saved snapshots when the card opens.

## Assumptions to confirm
- Two methods only (mean, linear). More can be added in the same setting.
- The forecast window (how many weeks) is the separate gap 4 setting; this PR keeps the fixed window of 4 until that PR merges.
