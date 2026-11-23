# Site Master: unified filter, wide view, direct editing (progress)

Owner request (2026-11-22/23): Site Master and its sub-menus show everything required, with direct editing and full filtering. PRs merge in this order.

| # | PR | Content | Status |
|---|----|---------|--------|
| 1 | #183 | Unified "+ Filter" dropdown with AND/OR on Site Master, sub-menus, registers, dashboard, My Work. Contract 0.15.45, migration 0137, CHANGELOG 183. | Open, fixing web tests |
| 2 | #184 | Wide view (layout=wide): row per site, columns left to right, frozen # and Site ID. Site Master: Site Information to O&M; sub-menu: its own columns. Inline edit with typed editors (date, number, list, yes/no, text). Contract 0.15.48, CHANGELOG 184. | Open, CI running |
| 3 | next | Saved views for site360-* and dashboard; server value search beyond 500 values. Contract 0.15.49, migration 0138 if needed, CHANGELOG 185. Stacked on #183. | In progress |
| 4 | next | Bulk edit in the wide view; stage/mine/late/locks/gaps filters on rows; dependent lists; Playwright e2e with screenshots. Contract 0.15.50, CHANGELOG 186. Stacked on #184. | In progress |

Rules: tests run on GitHub CI; one PR handed over at a time after green CI and a clean merge state; branches deleted after merge.
