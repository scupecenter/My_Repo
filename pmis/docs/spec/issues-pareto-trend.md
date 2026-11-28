# feat(dashboard): issues Pareto with 80% marker and weekly opened vs closed trend (migration 0715, contract 0.15.592)

Status: BUILT in PR #597. Product: Telecom Site Delivery Workspace.

Draft. Issues card: Pareto view and weekly trend. Migration 0715 (mirror db/sql/714), contract 0.15.592. Numbers re-checked free against live main and all open PRs and branches at 13:35.

What it does
- Category and reason bars become Pareto: biggest first, a cumulative-share line on a 0 to 100 axis, dashed 80% marker, and a line under the chart ("The first K of N account for at least 80% of the open issues") with a hover hint. The cumulative share is over ALL rows, not only the 8 shown.
- New tab "Weekly trend" on the card: opened against closed per ISO week (Monday to Sunday), last 12 weeks, plus the open-at-week-end line.
- GET /dashboard/issues-trend?weeks=4..52: dashboard.view, caller's issues regions. One read function issues_weekly_trend. No table, no setting, additive.

Choices recorded
- Pareto needs no API change: computed in the web app from the existing by_category and by_reason lists (pure helper dashboardPareto.ts, unit tested).
- The 80% marker is a constant (PARETO_MARKER), as Ahmed specified it; not a setting.
- Weeks are ISO Monday to Sunday, 12 weeks fixed in the UI. Opened = raised_date in the week, closed = resolution_date in the week, same fields the open count uses. An issue closed by status only (no resolution date) is not counted as closed. Cancelled sites excluded.
- EN and AR text with hover hints. Chart axes mirror in RTL.

Tests: web dashboardPareto.test.tsx (helper, chart options, card interaction), i18n parity pass, tsc clean for src. API test/issues-trend.test.ts. Not visually inspected in a browser (charts are mocked in tests), so a visual check of the horizontal line-on-category-axis rendering is worth a look. No local Postgres: migration verified statically, CI is the gate.
