# Small display features (items 16, 14, 3, 4, 1, 7)

Status: in build, one draft PR per feature, stacked in the order below. Owner approval: relayed by main on 2026-11-27 and 2026-11-28 (Ahmed's voice).
Customer text: `docs/customer/display-extras.md`. Contract: no path change except item 7 (0.15.597).

## Shared mechanism
- `apps/web/src/lib/uiExtras.ts` holds the keys; `components/DisplayExtrasCard.tsx` (Settings > Screens > Interface > "On this device") lists them; text in `ui.extra_<key>` and `_hint`, English and Arabic.
- Switches are per device (local storage). Default on. They hide a feature, they never delete data. No permission is involved.

## Features
| Order | Item | Key | Where | Notes |
|---|---|---|---|---|
| 1 | 16 copy link | `copy_link` | `DrawerFrame` `link` prop, task and register drawers | Absolute address; clipboard with a textarea fallback. The reader still needs the right to see the record. |
| 2 | 14 chart PNG | `chart_png` | `EChart` wrapper, `lib/chartPng.ts` | 2x size, page background, named after the chart and the day. |
| 3 | 3 last updated | `last_updated` | `LastUpdated` in `PageHeader` | Reads the query cache, skips background query keys; the button refetches the page's data. |
| 4 | 4 due dates in words | `relative_due` | `RelDue` in `TaskGrid` and `TaskDrawer` | Colour bands: overdue red, 0 to 2 days amber, within a week blue, later quiet; finished tasks show none. |
| 5 | 1 totals row | `totals_row` | `lib/columnTotals.ts`, `RegisterGrid` `totals` prop | Loaded rows only; sum, average, count, min, max per column, remembered per register and column. |

## Rules kept
Every icon button has a tip and an aria-label. Arabic RTL and English. No migration. Each PR has a vitest file and a Playwright spec (EN, AR, 390px).

## Not covered
Server-side totals, totals on tables without number columns, scheduled export.
