# Site 360 restructure, SLA and weight in the workflow editor, dropdown lists (F14 to F18)

Owner request of 2026-11-15, based on the Master workbook (sheet Master: 187 columns, 3 header rows, frozen at column Z, SUBTOTAL row 4, 26 list validations, 24 conditional-format rules).
Missing data in the workbook does not block work; it will be filled later.

## Shared rule: one source of truth

Every view below reads and writes the same records (site register, workflow steps, registers). An edit saved in Master shows in CW, TE, the task drawer and the dashboard without a refresh step, and the reverse. No view keeps its own copy. Lock/unlock, audit and permissions (B3 region and module) apply the same way in every view.

Every Site 360 list and register gets the same toolbar: Grid (Excel-like) / Vertical (current) toggle, multi Site ID paste search, multi-value filters (same set as the dashboard: region, sub region, phase, batch, scenario, delivery model, contractor, owner, status, milestone), lock/unlock, download, template upload, add column, saved views.

## F14 SLA and project weight inside the workflow editor (branch from claude/wf-gaps)

- Creating or editing a task, gate or milestone in the three-column editor shows an SLA section: none / working days / calendar days, duration, start event (previous task done, gate passed, date column, record created), warning threshold %, breach owner and escalation role, pause on "waiting for client". Edit and delete follow the delete rule (hard delete if unused, else deactivate with a reason).
- Same section: "Counts in project weight" yes/no, weight value, weight group (CW, TE, HOTO...), and a live check that the weights of the group still total 100%.
- A standalone SLA admin page lists all SLA rules with the same fields, for bulk review and edit.
- Other places that get the same SLA and weight options: register steps (Car Dispatcher, Financial Advances and any register placed in a workflow), milestones, gates, document types with due dates, inspection templates, generated forms, and breach notifications in subscriptions.
- CHANGELOG 145, contract 0.15.20, migrations 0099 (and 0100 if needed).

## F15 Site 360 restructure and Master view (branch from main)

New menu, each with Grid / Vertical toggle and the shared toolbar:

| Menu | Shows (Master columns) |
|---|---|
| Master (was All sites) | All 187 columns, same 3-level headers as the Master sheet |
| Design & Acquisition | RF & DESIGN up to Site Release Date (B to V) |
| SOW | Site data after Site Release: Project Phase, Delivery Batch, Delivery Scenario, CW SOW, TE SOW (X to AF) |
| CW | PRE-CW (from CW procurement) and ACTUAL CW with CW PAC, GECOL and HLC (AG to BY) |
| TE | From RFI through TE installation, On-Air and TE PAC (BZ to EM) |
| HOTO | After TE PAC up to handover to O&M: cluster optimization, launch, HOTO (EN to EZ) |
| Dismantle | CW Dismantle and TE Dismantle as two bands (FN to FW) |
| O&M | After HOTO to final closure: CW and TE DLP/FAC, final closure (FA to FM) |

Column ranges are the default mapping; admins can move a column between menus (column metadata `site360_section`). STATUS columns (Current Milestone, Next Milestone, Overall Status, issues) appear in every menu.

The grid matches the Master sheet look: phase band row, group row, field row, Phase Gate columns highlighted, frozen identity columns (# to Site Name by default, user can change), a totals row of visible rows (count, sum for numbers), conditional colours.

This replaces the SITE 360 navigation of 2026-11-05 in `CLAUDE.md`; F15 updates that rule and adds a decision entry to `CHANGELOG.md`.

CHANGELOG 146, contract 0.15.21, migration 0101 (section metadata).

## F16 Registers & Logs in Grid / Vertical, As-Built and Dismantle split (branch from main)

- Every register gets the Grid / Vertical toggle, add/edit/delete rows and columns, lock/unlock of rows or columns, download/upload.
- As-Built opens with two tabs: CW BOQ (31 civil items) and TE BOQ (equipment configuration), as in the As-Built sheet.
- Dismantle shows CW and TE as two tabs (two bands in Grid).
- Car Dispatcher and Financial Advances can be placed in the workflow with dependencies on tasks and milestones; this uses the #134/F14 editor (register steps), no new engine.
- CHANGELOG 147, contract 0.15.22.

## F17 Dropdown lists (branch from claude/register-columns-admin, #132)

- List admin: create, rename, edit values, reorder, colour, deactivate a value with a reason (hard delete only if unused), import values from Excel.
- Value types: text, date, number, person (staff registry), site, contractor/vendor.
- Dependent lists (Region to Sub Region, Vendor to Team), default value, multi-select.
- Bind a list to any column from the column dialog or from the list page ("where used").
- CHANGELOG 148, contract 0.15.23, migration 0102.

## F18 Excel-style working features (suggested, built into the F15/F16 grid)

From how the team used the Master sheet:
1. Excel-style column filter: value checklist with search, blanks, date ranges, filter by status colour.
2. Saved views per user, shareable to a team (columns, order, filters, sort, frozen columns).
3. Collapse/expand each phase band; hide empty columns.
4. Fill down, paste a block from Excel, find and replace in the selection, bulk edit.
5. Undo/redo for the last edits in the session.
6. Cell comments with mentions, and per-cell history (who, when, old value).
7. Highlight cells changed since my last visit.
8. Conditional formatting rules managed by admins (overdue red, due soon amber, done green, gate passed).
9. Download the current view to Excel with the same headers, colours and frozen panes.
10. Selection totals (count, sum, min, max) in the status bar.

## Settings placement rule (owner decision 2026-11-15)

- **Global settings live in one place: Administration > Settings**, as tabs. Anything that applies across the system goes there: work calendar, SLA rules (with the F14 bulk SLA admin inside the existing "SLA rules" tab, not a new tab), weight sets, lists (F17 extends the existing "Lists" tab), register columns, SITE 360 column-to-menu mapping (F15, new tab "SITE 360 columns"), workflow, document library, notification policy and the rest.
- **Local settings stay inside their module** (a toolbar "settings" button or panel on that page): per-view items such as saved views, frozen columns, column width and order for the user, a register's own record options. They never duplicate a global setting; when a local screen needs a global one, it links to the Settings tab.
- No setting exists in two places. A new feature first checks for an existing Settings tab and extends it.

## Merge order and fixed numbers

| PR | CHANGELOG | Contract |
|---|---|---|
| #132 register columns | 140 | 0.15.15 |
| #134 workflow editor | 141 | 0.15.16 |
| #137 F1 transitions | 142 | 0.15.17 |
| #138 F6 dashboard | 143 | 0.15.18 |
| #139 F4 search | 144 | 0.15.19 |
| F14 | 145 | 0.15.20 |
| F15 | 146 | 0.15.21 |
| F16 | 147 | 0.15.22 |
| F17 | 148 | 0.15.23 |

If a PR merges out of this order, only the contract version is renumbered at merge time.
