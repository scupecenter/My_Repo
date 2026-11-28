# Pivot table layout (2026-11-28)

A layout of every register, next to list, wide, board, feed, map, calendar and chart. Rows by one field, columns by another, each cell a count or the sum of a number field.

- Axes: the approval state, the region (site registers) and every list or yes/no field. Default rows: state. Default columns: the first list field. "None" gives a totals-only column.
- Reads the rows the screen has loaded (same as the chart): no request, nothing the caller cannot already see. A note says how many rows were counted when the view has more.
- A cell, a row total and a split-bar segment (the group summary bar, reused) list the matching rows: the page sets the filter builder's tree and returns to the list, so the result can be saved in a view. More than 12 heads on an axis fold into "Other" (not listable).
- Kept in the URL and in saved views (`pvr`, `pvc`, `pvm`, like the chart's `chx`, `chm`, `chk`).
- No table, migration, permission or contract change. Excluded: export of the pivot (the register export already covers the rows), dashboards.
