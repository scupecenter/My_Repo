# P9 Warehouse joins the table standard

Items, Movements, Stock and Dispatch now render through `StandardTable`: saved views, column chooser, density, export and the shared toolbar. The Gaps tab is unchanged. The five tabs and their test ids are kept.

- `StandardTable` gained optional `views`, `filter` and `rowExpand` props (inline edit panels stay in the table).
- Covered: Warehouse Items, Movements, Stock, Dispatch.
- Excluded: Gaps (a read-only checklist, not a table).
- Layout panel and default view per screen belong to item (d) and (c).
