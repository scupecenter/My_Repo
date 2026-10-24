# GSDN PMIS screens: purpose, states and shortcuts

Prototype: `GSDN_PMIS_Prototype_v2.html` (offline, hash routes). Tokens: `tokens.css` and `tokens.json` (frappe-ui 1.0.2).
Every screen works in English LTR and Arabic RTL (logical CSS, mirrored chevrons, `dir` set on `<html>`), in light and dark, and down to 390 px width.

## States (apply to every screen unless a row says otherwise)
Open the user menu, then "Simulate screen state", to see each state on any screen.

| State | Behaviour |
|---|---|
| Loading | Skeleton blocks in the page area, `aria-busy`, header stays. Real loading happens per list on the server; the prototype only simulates it. |
| Empty | Icon, one-line reason, one action (clear filters, assign, upload). Never a blank table. |
| Error | Red icon, plain sentence ("Your data is safe"), Retry button, `role=alert`. A UI exception is caught, written to the System Log, and shown as this state. |
| No permission | Grey lock icon, sentence naming the cause (permission level or visibility), "Back to My Work". Navigation hides links the user cannot open, but a typed URL still lands here. |

Permission rules used in the prototype: view < entry < review < approve < admin. Admin = member of the System Admins group (or a full delegate). Admin screens need admin. Approvals needs review or higher. Audit Log needs approve or higher. Upload needs entry or higher. Sites outside the user's regions are invisible everywhere (lists, palette, deep links show No permission).

## Global shortcuts
`Ctrl/Cmd+K` command palette (pages, registers, sites by ID or name, actions). `/` focus the search box of the screen. `?` shortcut help. `g` then `m`/`a`/`s`/`d` go to My Work / Approvals / Sites / Dashboard. `j` `k` move in lists, `Enter` opens. `Esc` closes palette, modal, drawer, menu in that order. Every icon button has an accessible name; focus ring is a 2 px accent outline.

## Screens

### Login
Purpose: Microsoft 365 button, then the 4-digit employee ID (asked once), plus demo users for the prototype.
Empty: n/a. Loading: button shows "Verifying" during the ID check (simulated). Error: ID not 4 digits, or not found ("Contact a System Admin"), inline under the field with `role=alert`. No-permission: a new account goes to Pending assignment.
Shortcuts: `Enter` submits the ID; language and theme buttons are on the card.

### Pending assignment
Purpose: the account exists but has no role; sees no data. Actions: Notify System Admin (in-app and email), Sign out.
States: only this one. Shortcuts: none.

### Shell
Sidebar groups: Work, Data entry, Registers (collapsible, 13 registers), Administration (admin only; Audit Log for approvers). Top bar: collapse, breadcrumb, Ctrl+K, EN/AR, theme, notifications, user menu (switch demo user, simulate state, shortcuts, sign out). A banner shows active delegation ("X on behalf of System Admin"). On narrow screens the sidebar becomes a drawer behind the burger.
Shortcuts: global list above.

### My Work
Purpose: ease of entry. Three columns: Late, Do now, Waiting on others. Each card has a date field and Quick submit when no document is missing; otherwise Open. Returned tasks show the rejection note in red.
Empty: "You are all caught up". Error/Loading/No permission: generic. Shortcuts: `Tab` through cards, `Enter` opens the task.

### Sites
Purpose: find any site. Filters: search, stage, scenario, status (All/Mine/Late/Waiting approval/Closed), region chips. Table has the mini rail (10 stage dots: done, current, late, n/a). Sortable by site, region, stage; Show more.
Empty: "No sites match" with Clear filters. No-permission: sites outside regions are not listed. Shortcuts: `/` search, `j` `k` rows, `Enter` open.

### Site page
Purpose: the working page for one site. Header with cluster progress note (information only), the pipeline, tabs Tasks, Documents, QC snags, Issues, History.
- Pipeline: ring progress per stage, gradient fill track, hover lift; node states done / current / late / planned ghost (dashed outline), dashed baseline marker on the track, milestone actual date with working-day variance.
- Task grid: grouped by stage (collapsible), columns code, task, ball in court (people, "claimed by", external party such as A&T Global), plan/actual with SLA, status, document slots (n/m), template download and upload beside each task. "Why locked?" opens the reasons and the ball in court.
- Drawer: why-locked banner, ball in court, approval path (skipped levels struck through), dates with working days vs SLA, one named slot per document (drag and drop, Choose files, Camera, status, rejection reason, auto file name preview, conditional slots only when they apply, camera-only proof slot with a simulated mobile capture), multi-file drop with suggested type, template block, comment thread, timeline, sticky action bar (Submit for review stays disabled and lists what is missing; Mark reviewed; Approve with step-up; Return with note requires a note and can mark documents rejected; Admin override with reason and step-up, badge, Revert).
- Documents tab: filter by stage, status, text; tick files; zip selected, whole site, filtered, or one document type across sites; versions (superseded kept and downloadable); every download is audited.
- QC snags tab: per snag type requirements (min photos, shot types, formats, size), EXIF rule, unknown capture date flag, submit fix, review, approve and close. CW PAC cannot be approved while any snag is open.
States: unknown site shows Empty; site outside regions shows No permission; no snags/issues/history show per-tab empty states; drawer read-only for people not assigned to the level.
Shortcuts: `j` `k` `Enter` in the task grid, `Esc` closes the drawer, `Tab` through slots.

### Approvals
Purpose: ease of approval. Master list (tabs All, Review, Approve, Batches, Snags) with checkboxes, detail pane with documents, dates, comments and actions. Group-assigned items show "group" and are claimed by the first member to act; "all must approve" items show progress. Bulk bar: Approve / pass selected (one step-up for all), skipped items are reported. Batches can be approved row by row or all at once, then reviewed, then approved.
Empty: "Inbox zero". No-permission: entry and view users. Shortcuts: `j` `k` move, `x` tick, `a` approve or pass, `r` return with note, `Shift+A` approve all ticked, `/` filter.

### Dashboard
Purpose: portfolio health. KPI strip (sites, late, waiting approval, health index from the active weight set), delivery pipeline (scope node plus 10 milestone rings, "in work" gaps), region progress, delay attribution by responsible party, Final Closure KPI (closed, %, pending CW FAC / TE FAC with age), admin override count (excluded from SLA KPIs).
Empty: all zero values with explanatory text when no site is visible. Shortcuts: tiles and nodes are buttons; `Enter` drills into Sites with the filter set.

### Templates
Purpose: approved templates only (ID and version in hidden sheet `_tpl`). Cards with Download and Upload, recent batches. Empty: "No batches yet". Shortcuts: none.

### Upload wizard
Four steps: choose template, upload file, preview changes (new / changed / same / error per row, tick rows), submit batch. A file without a valid embedded ID and version, or an outdated version, or a different template than selected, is rejected with the reason and written to the System Log. Empty: no rows in file shows all rows skipped. Error: rejection banner. No-permission: view users. Shortcuts: `Enter` on the drop zone opens the file picker.

### Users & Roles (admin)
Three views. By role: pick a main role or sub-role, see everyone assigned (permission, regions, modules, validity), tick rows to remove, edit in bulk (permission, regions, modules, dates), or also assign to another role; below, a searchable multi-select of every registered employee (including pending ones) with defaults for permission, regions, modules and validity, then "Assign N people". By person: one employee with several role rows, each with its own role, permission, regions, modules, from and until; add or remove rows; copy assignments to other people (add or replace); status and team. Pending assignment: new accounts with a button to assign. Export CSV; Import from Excel template links to Templates (the TPL-ROLES file is issued, its import is not wired in the prototype). All changes need step-up and are audited with before and after. A user's effective permission is the highest of the active rows; the last active admin cannot be deactivated.
Empty: "Nobody holds this role yet", "No roles yet", "No pending accounts". Shortcuts: `/` search, `Enter` on a role row.

### Groups (admin)
Named sets with members and the number of matrix cells using the group. System Admins cannot drop below one active member. Empty: "No members". Shortcuts: `Enter` selects a group.

### Responsibility Matrix (admin)
Grid of 10 stages by Entry, Review, Approve plus levels (3, 2 or 1). Click a cell to add users, roles or groups (tabs and search) and set the rule (any one member or all must approve). A preview column shows where consecutive levels held by one person will be skipped. Unsaved cells are highlighted; Save needs step-up and writes before/after to the Audit Log. A used level with nobody assigned blocks saving.
Empty cell: red "Nobody assigned". Shortcuts: `Enter` on a cell, `Esc` closes the editor.

### Delegation (admin)
Delegate full or partial rights (unlock, skip, accept without document, reopen, edit dates, change rules), time-bound or until revoked. Timeline of delegations with Revoke. A delegate cannot delegate further, and admin members are not offered. Empty: "No delegations". Shortcuts: none.

### Document Library (admin)
List with filters (stage, kind, search) and an editor: names EN and AR, kind, mandatory or conditional with rule, formats, size, min/max files, expiry, blank form, placement chips (tasks and QC), live slot preview. Publish asks whether it applies to new tasks only or also to open tasks and shows how many are affected; approved tasks never change. Deactivate, never delete. Seeded stage 4 to 10 documents carry a "review" badge for the product owner. Empty: "No documents match". Shortcuts: `/` search.

### Settings (admin)
SLA rules per task (min, max, measured-from event, calendar, scenario or region overrides, version history). Project Status weights (8 activities, items per activity, health index weights) with live sum validation. Publishing asks for reason and effective date, can apply to open tasks (SLA), needs step-up, and is versioned and audited. Empty: none. Shortcuts: none.

### Registers
Each register has its own menu entry. GECOL power is built: sticky site column, inline date entry (audited), status chip, follow-up thread, filters, export. Issue Log lists several issues per site. The other eleven show a "Not built in this prototype" state that points to GECOL.
Empty: "No rows match". Shortcuts: `/` search, `Tab` across dates.

### Audit Log
Append-only table with before and after, MFA chip, "Admin override" badge, "on behalf of" badge, filters (user, action, text), CSV export (the export is itself audited). No edit or delete control exists. Empty: "No entries match". Shortcuts: `/` search.

### System Log
Console-style list with level chips (Errors, Warnings, Info) and search; rejected uploads and caught UI errors appear here; kept 12 months. Empty: "No log lines". Shortcuts: `/` search.
