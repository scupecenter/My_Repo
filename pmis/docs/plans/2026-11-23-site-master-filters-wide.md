# Site Master: unified filter, wide view, direct editing (progress)

Owner request (2026-11-22/23): Site Master and its sub-menus show everything required, with direct editing and full filtering. PRs merge in this order.

| # | PR | Content | Status |
|---|----|---------|--------|
| 1 | #183 | Unified "+ Filter" dropdown with AND/OR. Contract 0.15.45, migration 0137, CHANGELOG 183. | Merged |
| 2 | #184 | Wide view (layout=wide) with inline typed editors. Contract 0.15.48, CHANGELOG 184. | Merged |
| 3 | #185 | Saved views for site360-* and dashboard; server value search beyond 500 values. Contract 0.15.49, migration 0138, CHANGELOG 185. | Open |
| 4 | #186 | Bulk edit, row filters, dependent lists in the UI, Playwright e2e. Contract 0.15.50, CHANGELOG 186. | Merged |
| 5 | next (branch claude/site-master-finish, stacked on #185) | Dependent lists enforced on save (422 `list_parent_mismatch`); bulk edit can clear a value; the AND/OR builder uses the server value search (shared `ChoiceList`). Contract 0.15.51, no migration, CHANGELOG 187. | Ready for CI |

Remaining human check: a visual review of Site Master (wide view, bulk edit dialog with "Clear the value", AND/OR builder on a long list) in the browser, in English and Arabic, light and dark.

Rules: tests run on GitHub CI; one PR handed over at a time after green CI and a clean merge state; branches deleted after merge.

Next work (site page tabs, register views, Settings clean-up, stuck screens, Documents hub, daily plan): see `2026-11-23-next-ui-cleanup.md`.
