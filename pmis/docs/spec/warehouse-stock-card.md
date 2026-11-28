# feat(dashboard): warehouse stock card (StockCard-1, 0716, 0.15.593)

Status: BUILT in PR #605. Product: Telecom Site Delivery Workspace.

Warehouse stock card on the dashboard (StockCard-1). Migration 0716, db/sql 715, contract label 0.15.593.

What it adds
- Card `warehouse_stock` (configurable in Settings > Dashboard): per item group, received, issued, returned, on hand, available. Period filter 7/30/90 days. Click a group for the region split. Link to Warehouse > Stock (`/warehouse?tab=stock`).
- One new read endpoint GET /dashboard/warehouse-stock (needs dashboard.view and warehouse.view; region scope respected), backed by function `wh_stock_summary(date,date,int[])`.
- EN/AR, hover hints, tests (API + web).

Choices
- There is no separate warehouse entity (one central stock), so the region split applies to issued and returned only. Receipts and on hand are central and shown to every warehouse reader.
- Group quantities sum units; a `mixed_units` flag marks groups with mixed units.
- The period applies to flows. On hand and available are always today's values from wh_stock_levels.
- Flows use posted movements by posted_at (Tripoli date).
- Numbers checked free vs main and all open PRs at push time. Additive migration only.

Verification: web and api tsc clean, dashboardStock tests pass locally. CI is the gate.
