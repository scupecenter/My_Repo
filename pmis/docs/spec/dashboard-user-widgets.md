# feat(dashboard): per-user dashboard widgets, arrange, hide and layout templates (migration 0713, contract 0.15.585)

Status: BUILT in PR #577. Product: Telecom Site Delivery Workspace.

Per-user dashboard widgets: each user arranges and hides the cards of their own dashboard tabs (PMO, CW, TE) and keeps named layout templates. Migration 0713 (mirror db/sql/712), contract 0.15.585. Draft until CI is 8/8.

What it does
- A "Customize my dashboard" button on the dashboard opens a panel: show/hide checkbox, move up/down per card, Save my layout, Discard, Back to default. Hover hints on every control, English and Arabic.
- Templates: save the layout of all three tabs under a name (same name replaces, at most 20), apply in one click, delete.
- A tab without a personal layout follows the global layout of Settings > Dashboard (unchanged). Back to default removes the personal layout.

Choices recorded
- Reuse, no duplicates: same F20 shape (order + hidden), same card catalogue (dashboard_settings_catalogue, so a card added later is accepted with no change here), same pure functions in dashboardLayout.ts (tabRows, moveRow, toLayout). Same personal-preference pattern as the pinned views (0344): own-row RLS, KEEP in data reset, no audit row.
- Permissions: dashboard.view only; touches the caller's own rows. No grant, role, permission or visibility change. The data of every card stays filtered by the caller's own rights; hiding a card changes only what that user sees.
- Concurrency: a version per tab (0 = not customised yet); a stale save answers 412 precondition_failed.
- An old template still applies: a card the catalogue no longer has is dropped on apply. Unknown card or a card listed twice is refused on save (422).
- Additive migration only: two new tables, eight functions, data_reset_plan patched idempotently (0361 pattern).

Tests: API integration suite test/dash-user-widgets.test.ts (layout, validation, 412, personal isolation, templates, apply, 20 limit); web test dashboardWidgets.test.tsx (hide, move, reset, templates, stale version, EN/AR keys, 403 without the module). Web typecheck and the three dashboard web suites pass locally; the API suite and migration run in CI (no local Postgres).
