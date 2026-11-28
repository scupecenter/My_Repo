# feat(dashboard): site health score, one score and colour per site (migration 0714, contract 0.15.591)

Status: BUILT in PR #591. Product: Telecom Site Delivery Workspace.

Draft. Site health score: one score (0 to 100) and a colour per site. Migration 0714 (mirror db/sql/713), contract 0.15.591. Numbers re-checked free against live main and all open PRs and branches at 13:30.

What it does
- GET /dashboard/site-health (list, worst first, filters band, region, search, paging) and GET /dashboard/site-health/{site_id} (the factors behind the score). dashboard.view, limited to the caller's dashboard regions.
- Dashboard card `site_health` (shown, hidden and ordered in Settings > Dashboard and in personal layouts): colour counts that filter, search, table with the four factors, click a site for weight and item count per factor. Hover hints on every factor, EN and AR.
- Settings > Dashboard > Site health weights: GET/PUT /settings/dashboard/site-health-weights (admin.settings, reason, If-Match, audit row site_health_weights_update).

Choices recorded
- Reuse: colours come from the existing dashboard.health_bands (no second band setting). Factors read the same tables as the project health index (task_instances with the SLA clock, document_slots, snags, task_delay_periods). No new table, additive migration.
- The project index (dash_sec_health) runs on temp tables built per dashboard call, so I did not call it per site. This is a self-contained per-site function with the same ideas. Factors: tasks on time (closed within SLA max plus open not past due), documents (mandatory slots of approved tasks approved), snags (100 minus 30 critical, 15 major, 5 other open), delay (100 minus 10 per delay-period day in the last 30). A factor with no data is left out and its weight shared, as in the project index.
- Default weights 40, 20, 25, 15 are my assumption; editable in Settings. Admin-override tasks are left out.
- Not scored (null) when no factor has data; counted separately.

Tests
- API: test/site-health.test.ts (shape, band rule, worst first, filters, 404, weights rules, version, audit, catalogue). Web: pages/dashboardSiteHealth.test.tsx (3 tests pass locally), i18n parity tests pass, tsc clean for src. No local Postgres: migration verified statically, CI is the gate.
