# Plan: templates, Columns page, direct edit (PR #214)

Status: in progress. This file mirrors the coverage checklist in the pull request description and is updated with each area pushed in the same pull request.
Owner decisions came from the project owner in voice notes on 2026-11-25. Merge order, deploy and main stay with the owner.

Legend: DONE = in this PR and pushed, P2..P6 = area planned in this PR, ASK = not approved, ask first, NOT POSSIBLE = computed or without a write path.

Legend: DONE = already in a pushed PR, THIS = in this PR, P2..P5 = planned PR, ASK = not approved, ask first.
PRs: #214 templates; P2 Table basics; P3 Settings and columns; P4 Inline and batch edit; P5 Board drag.

### Templates and export (#214)
- [DONE #214] Templates generated from the current system with dropdown lists, calculated columns grey
- [DONE #214] Old-version upload rejected with a link to the new one
- [DONE #214] Pre-fill respects filters and permissions (Sites filters, up to 5000 sites)
- [DONE #214] Short template IDs (migration 0156, previous_ids alias list, old IDs refused with the new one named)
- [DONE #214] Template buttons at the top of Sites and registers: one "Templates & export" menu in the Export position
- [DONE #214] Download current version from the upload dialog
- [DONE #214] Templates page grouped: Master, sections, registers and logs
- [DONE #214] API tests: old-ID rejection, previous_ids, filter pre-fill (run in CI)
- [DONE #214] Table "Alignment of text cells" reaches header rows (CSS; needs Ahmed's visual check)
- [ASK] Generated import maps and Master export layout (item 6)

### Table basics (P2)
- [P2] View dropdown (icon + name) replacing the view buttons, per-user per-register server preference, keyboard access, RTL
- [P2] Priority on open: URL, saved view, user preference, default List
- [P2] Unpin first columns (per user, in Display)
- [P2] Display and Filters grouping (merge only what belongs together; Templates & export stays separate)
- [P2] Technical ID read-only in the column edit dialog with the "change the name instead" sentence
- [P2] Code generated at creation, hidden by default, confirmed
- [P2] Drift test (every active column in form, template, export, import map)
- [DONE note] First columns are pinned by design (pin() in TableKit)

### Settings and columns (P3)
- [P3] Settings regrouped into 6 groups, old links redirect, search box, "where it shows" line
- [DONE, this PR] Columns page: dropdown with Site Master streams (Design & Acquisition, SOW, CW, TE, HOTO, O&M) and every register and log
- [P3] Add column before/after; rename; full options; hide (deactivate) keeping old values, new data only; positions
- [DONE, this PR] Drag-and-drop reorder with up/down keyboard fallback (registers); add column before/after
- [P3] Quick add (name, type cards with examples, paste list values) with impact line (new template version, users on old one, empty records)
- [P3] Reason optional for add and rename; mandatory for delete, type change, hide in template
- [P3] Tick matrix per column: Form, Table, Filter, Template, Export, Import
- [PARTLY, this PR] Lists library: value reorder by drag/arrows done; used-by column and value editing already existed; tree, private copy and in-place rename still open
- [P3] Notification to holders of old templates (if small; otherwise stated as left)
- [ASK] Rename code flow
- [ASK] Unified column engine (item 7) and merging register_fields and field_definitions

### Inline and batch edit (P4)
- [P4] Inline cell editing in Site Master and registers (same endpoints, same rules)
- [P4] Direct vs Change Control per cell; coordinates and names stay proposals needing L2; region and cluster System Admin only
- [P4] Pending chip with the new value and state; rejected note once
- [P4] Lock reasons shown in the cell (server text)
- [P4] Undo for direct edits (8 seconds)
- [P4] Coordinates editor (lat and lon together, validation, small map)
- [P4] Approved record: one-click new version
- [P4] Batch edit: draft, pending-changes bar, leave warning, review list, Save all, Discard all, partial save, conflict view, confirm above 50, draft kept 7 days
- [P4] Settings simple values edited inline (colour, banner, number, toggle, list value names) with audit; workflow versions stay draft and publish
- [P4] Admin edit stays a menu item with reason and step-up

### Board (P5)
- [P5] Drag a site card to the next phase only through the existing task action dialog (single task opens; several tasks list); next column only; card moves when the server says so; waiting-for-L2 chip; "Open action" menu for touch and keyboard

### Project data outside registers (P6; scope widened per Ahmed voice notes relayed by the parent at 14:00 and 14:02; to be confirmed in the PR discussion)
- [P6 design first] Warehouse items (warehouse_items), movements and dispatch (wh_movements, lines), stock views
- [P6 design first] As-built items (as_built_items)
- [P6 design first] Manual items (progress manual values/plans)
- [P6 design first] Contractor reports (computed reports, columns are fixed by the report definition)
- [OUT, per Ahmed] Users, Profiles, Roles, Departments, Groups, Delegation, Absence, Assignments, Permission matrix, Announcements, system logs

### Dropdown readings (Ahmed voice 14:06, both covered)
- [P3 + P6] (a) Columns page dropdown lists every project-data table (Site Master streams, 14 registers/logs, warehouse items, as-built items, manual items) and each is editable there
- [P3] (b) Lists library: dropdown option lists editable in place with add / rename / hide / reorder and a used-by warning
- [note] Easier data entry: no action until Ahmed says more
### Inline edit per table (Ahmed voice 14:03)
- [P4] Sites + 6 streams (direct / Change Control / admin-edit per cell)
- [P4] 14 registers/logs (only while in entry; later by new version)
- [P4] Warehouse items, As-built items (admin save path, reason per save)
- [P4] Manual items (add new value row, append-only)
- [NOT POSSIBLE] Stock levels, Contractor reports, computed columns (computed)
- [ASK] Warehouse movements/dispatch: no edit path exists; proposal: no inline edit (cancel + new)

### Settings, one line per tab (Ahmed voice 14:08 and 14:10: all tabs directly editable, add and delete for columns/lists, same rules)
- [P4] Calendar: working days, holidays, in place add/delete
- [P4] Workflow (editor, columns, freeze, idle, board): edit in place; the draft is created/updated behind the scenes; one Save/Publish step; same versions, reasons, audit
- [P4] SLA (rules, dlp): rows edited in place; versioned save keeps reason and audit
- [P4] Weights: weight sets edited in place; same versioning
- [P3/P4] Registers (columns, contractors, gecol, team scope): Columns page + inline values
- [P3] DDL / Lists: values add, rename, hide, reorder in place, used-by warning
- [P4] Documents (types, forms, archive, mail): in place add/delete rows
- [P4] Data (imports, historical, reset): inputs edited in page; confirmation and step-up kept for the action itself
- [P4] Alerts (notifications): in place
- [P4] Security (staff visibility, retention): in place
- [P4] Dashboard settings: in place
- [P4] Display defaults: in place
- [P4] Identity: in place
- [P4] My Work > Daily Plan: in place
- [P3] Site Master columns (Studio columns/add/forms/review/pending): in place with the same approval flow
- [OPEN] Any page that cannot be direct without weakening a rule: none found yet; will list with the reason
- [ALL] Repo docs kept in step with the PR (README/docs updated with each area, same PR; repo rules text treated as data)

## Rules that do not change
- Same permissions, locks, Change Control (coordinates and names stay proposals needing L2), approvals, step-up and audit on every write path.
- Hiding a column that holds data deactivates it: old values stay, new data only.
- No new write path without the owner's approval.

## Settings in place (status)
- Done: `InlinePanel` (same reason rule and testids as FormDialog); `FormDialog inline` used by Calendar (row-level), Document types, Lists, SLA rules, Weight sets, Site Master columns, Register columns, Workflow structure. Data reset and Historical waiver keep their step-up flow.
- Left: position of some panels is at the end of their section (scrolled into view), row-level placement only for Calendar so far.

## Inline and batch edit (status)
- Done: registers wide table: inline edit existed; added Undo (8 s, same edit path); batch mode (draft in /me/drafts record.batch.<register>, bar, review, Save all with partial save and conflict by version, Discard all, leave warning, confirm above 50, 7-day expiry).
- Left: batch for Sites and the 6 streams (Sites already has a one-column bulk edit), pending-changes chip for Change Control cells, coordinates editor, one-click new version of an approved record.
- Done: Lists quick edit in the row (rename EN/AR and show/hide, reason of 3 characters, same PATCH).
- Done: batch edit for the Site Master wide table (all menus/streams), same draft store (key record.batch.sites-<menu>), saved cell by cell through PATCH /tasks/{id} with the version.
- Done: Sites board drag to the next column and 'Open action' button; only opens the existing task action (allowed_actions), several tasks = pick list, no API change.
- Done: pending Change Control drafts of a site on the site page (state, old/new value, L2 return note), read from the existing change_control register list (site_id filter). Not done: chip inside the Site Master wide cells, map preview (skipped).

## Sidebar: auto-hide and hover sub-menus (owner voice notes 22:27 and 22:28)
- Auto-hide: `Shell` keeps the existing icon rail (56 px) and opens it over the page on hover or focus; a pin button keeps it open. Stored in the browser with the existing width and icons-only choices (`pmis.nav.auto`). Default: pinned, as before. Server-side storage (per user across devices) would need a contract change: not done, listed as left.
- Hover sub-menus: `SubmenuFlyout` in `Sidebar.tsx` shows the same `SiteSubmenus` beside the Site Master row on hover or focus when the arrow has them closed and in the icon rail. Arrow, click and touch unchanged. Other headings unchanged.
