# Item 9: group summary row with a status distribution bar

Built on the framework of the Display options (W8 item 4): one more option, `groupbar`, next to text size, alignment, density, wrap and zebra rows.

## What the user sees
- Every group header of a grouped table shows the count and a bar with one segment per status, as wide as its share of the group.
- A segment is a button: it filters the table to that status (a second click, or "Show all", clears it). `aria-pressed` says which is on; each segment has a tooltip and an aria-label; the same numbers are in a screen-reader list (`role="group"` with the totals).
- Arabic RTL and English; the bar follows the reading direction.

## Settings
- Organization default: Settings > Screens > Tables > "Group summary" (setting `table.display`, key `groupbar`, audited with a reason and a version, as the other Display defaults).
- Personal choice, per screen: Layout panel > Display > "Group summary", shown only on a screen that has group header rows. Saved views keep it.
- Off = the plain header the screen had before.

## Covered
- My Work (list): the three groups Late, Do now, Waiting. Status = the SLA colour of the task (late, near the limit, within target, no SLA). The filter is the URL parameter `sla`, applied to all three groups.

## Excluded (and why)
- Column group bands (the section and group rows above the column headers of Site Master and registers): these group columns, not rows, so they have no count to summarise.
- Kanban boards and the register board: their columns already show their own count and are not a header row of a table.
- The dashboard bucket lists (aging, shortages): they are charts, already bars.
- Any table without group header rows has no option to turn on (the Display section shows the checkbox only where `grouped` is passed to the Layout panel).

## Connections checked
`table_display_seed()` and `admin_set_table_display` (patched in place, idempotent, the key is optional in a PUT so an older client still works), `GET/PUT /settings/table-display`, saved views (`display.groupbar`), the contract schemas `TableDisplay` and `SavedViewColumns`, the mock door, `DisplaySettings` preview, `LayoutPanel`, `displayAttrs` (`data-tgroupbar`).

## Numbers
db/sql 651 = prisma 0652 (byte-identical), contract 0.15.533. No table, no route, no permission change.

## Walkthrough
`e2e/group-summary.spec.ts` (EN and AR): My Work shows the bar and the text alternative, a segment filters and clears, the Layout panel switch hides the bar and brings it back.
