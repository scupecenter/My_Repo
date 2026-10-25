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
Purpose: one field, "Email, employee ID or phone", and one button, "Continue with Microsoft". The PMIS looks the text up in the staff registry (email, 4-digit ID, or phone in any common format) and sends the browser to Microsoft 365 with that person's email as `login_hint`; Microsoft does the password and MFA, the PMIS stores no passwords. The screen is identical whether a match is found or not (no match = Microsoft sign-in without a hint, nothing on screen reveals who is registered). After Microsoft, a first-time user enters the 4-digit employee ID once; it must exist in the registry and not be linked to another account. Demo users stay for the prototype.
Empty: an empty field is allowed (Microsoft sign-in without a hint). Loading: "Verifying" on the ID check (simulated). Error: ID not 4 digits, or not found ("Contact a System Admin"), inline under the field with `role=alert`; the lookup itself never errors. No-permission: a new account goes to Pending assignment.
Shortcuts: `Enter` in the field continues; `Enter` submits the ID; language and theme buttons are on the card.

### Pending assignment
Purpose: the account exists but has no role; sees no data. Actions: Notify System Admin (in-app and email), Sign out.
States: only this one. Shortcuts: none.

### Shell
Sidebar groups: Work, Data entry, Registers (collapsible, 13 registers), Administration (admin only; Audit Log for approvers). Top bar: collapse, breadcrumb, Ctrl+K, EN/AR, theme, notifications, user menu (switch demo user, simulate state, shortcuts, sign out). A banner shows active delegation ("X on behalf of System Admin"). On narrow screens the sidebar becomes a drawer behind the burger.
Shortcuts: global list above.
Work menu now includes Absence & cover (badge for leads). The palette lists it with every other page.

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
MFA exemption (owner request 2026-10-25): in By person, each employee has a "PMIS MFA requirement" box. A System Admin (or a delegate holding the "MFA exemption" right) can set an exemption until a date or until revoked, with a reason and their own step-up; the user is emailed, an "MFA exempt" badge shows here and in the people list, and clearing it also needs a reason and step-up. Nobody can exempt themselves (the button is disabled with a hint). It removes only the PMIS check; Entra Conditional Access is IT's. States: expired exemptions show "Expired on {date}" and count as required. No-permission for others: the box is read-only with an explanation.

### Groups (admin)
Named sets with members and the number of matrix cells using the group. System Admins cannot drop below one active member. Empty: "No members". Shortcuts: `Enter` selects a group.

### Responsibility Matrix (admin)
Grid of 10 stages, then a divider and 14 more rows (decision B11): one per register (Procurement, Contractors, GECOL power, HLC fiber, Permits & HSE, Warehouse, Quality, Issue Log, Risk Register, Change Control, Readiness & Handover, As-Built, Meetings) and one for Dismantle. Every row has Entry, Review, Approve and its own level count (3, 2 or 1). Click a cell to add users, roles or groups (tabs and search) and set the rule (any one member or all must approve). A preview column shows where consecutive levels held by one person will be skipped. Person chips show the employee ID and open the employee card on hover or focus (same component as the task grid, `people.js`); an absent person carries an "absent" badge. Unsaved cells are highlighted; Save needs step-up and writes before/after to the Audit Log. A used level with nobody assigned blocks saving.
Empty cell: red "Nobody assigned". No-permission: admins only. Shortcuts: `Enter` on a cell, `Esc` closes the editor; hover or `Tab` to a chip for the card, `Esc` closes the card.

### Delegation (admin)
Delegate full or partial rights (unlock, skip, accept without document, reopen, edit dates, change rules), time-bound or until revoked. Timeline of delegations with Revoke. A delegate cannot delegate further, and admin members are not offered. Empty: "No delegations". Shortcuts: none.

### Document Library (admin)
List with filters (stage, kind, search) and an editor: names EN and AR, kind, mandatory or conditional with rule, formats, size, min/max files, expiry, blank form, placement chips (tasks and QC), live slot preview. Publish asks whether it applies to new tasks only or also to open tasks and shows how many are affected; approved tasks never change. Deactivate, never delete. Seeded stage 4 to 10 documents carry a "review" badge for the product owner. Empty: "No documents match". Shortcuts: `/` search.

### Settings (admin)
Seven tabs; deep links `#/settings?tab=calendar|staff|workflow|dlp|forms|sla|weights`. Every publish or save asks for a reason, is audited with before/after values, and is versioned where it says so. Empty: none of the tabs is ever blank. No-permission: admins only (a delegate sees what was delegated). Loading/error: the shared states.

**SLA rules** and **Project Status weights**: per task min, max, start event, overrides, version history; 8 activity weights, items per activity, health index, live sum validation; publish asks for reason and effective date, can apply to open tasks (SLA), needs step-up.

**Work calendar (decision B12).** Weekend day chips (default Friday and Saturday, 1 to 3 days), saved with a reason. Holidays table (date, weekday, name EN/AR, national or religious, Tentative or Confirmed badge, note) with search, year and kind filters, add, edit, delete, "Confirm" for a tentative date (the date may move to the announced one; the reason is the announcement reference), CSV import (preview with new, replaced and error rows, then a reason) and a CSV template. Seeded from `db/seed/holidays-2026-2027.csv`. Banners: a red banner when the coming year's table is empty; an amber "Confirm within 14 days" banner for tentative dates in the next 14 days; a blue note for past tentative dates never confirmed. Any change recalculates SLA due dates of open tasks (the toast says how many); closed tasks keep their values. The prototype's working-day function reads this table.
Empty: "No holidays match" with add and import. Error: bad CSV columns are refused and the file name is written to the System Log. Shortcuts: `/` search, `n` add a holiday.

**Staff registry.** Sub-tab Registry: list with search (name, ID, position, email) and status filter, add or edit in a dialog (ID 4 digits and unique, names EN and AR, email and phone format, position, team, region, reason), Deactivate or Reactivate (there is no delete; the banner says so), Download template and Upload template (approved template `TPL-STAFF` with a hidden `_tpl` sheet; the preview shows new, changed and error rows; missing employees stay untouched; a non-template file is rejected and logged). Sub-tab Phone and email visibility: per field (phone, email) a default (all staff or admins only), an "Also see" list and a "Do not see" list that accept roles, groups or persons (deny wins), a table to hide a field for one employee, and a "check what a person sees" preview; edits are a draft with an Unsaved bar and Save needs a reason. System Admins and the employee always see their own data. The employee card (everywhere) follows these rules and shows "Not visible to you".
Empty: "No employees match". Shortcuts: `/` search, `n` add employee, `j` `k` move in the list, `Enter` edits.

**Workflow.** Freeze banner for the pilot and parallel-run window (B9): structural buttons (add, reorder, remove a milestone) are disabled and say why; a System Admin can "Lift freeze" with a reason and step-up (audited, "Restore freeze" returns it). New tasks inside a stage stay allowed (B8): the dialog warns that the milestone date may move later than the Master, and during the parallel run needs an explicit confirmation; the task is tagged "Caused by an added task" and the admin chooses whether open sites get it. Idle-task alert setting: working days without activity before the lead is alerted (default 2). Version list of structural changes.
Error: unconfirmed comparison effect blocks publishing. Shortcuts: none.

**DLP.** CW months (default 3) and TE months (default 12), versioned; Publish asks for reason and effective date and needs step-up. A table shows issued PACs keeping the value in force when they were issued. Empty: none.

**Forms and templates.** The four generated CW forms (DN, RN, PAC, FAC) with numbering sequence, number of PDFs generated, version history, Preview (sandboxed iframe with sample data), Download template and Upload new version. An upload must be .html, at most 2 MB, contain `{{placeholders}}`, and contain no scripts or event handlers; unknown placeholders are listed as a warning; publishing needs a reason and step-up and records the new version (each generated PDF records the version it used). Rejections are written to the System Log. The prototype ships small stand-in templates; the owner's real HTML forms are in `design/forms/source/`.
Empty: none. Shortcuts: `Enter` selects a form.

### Registers
Each register has its own menu entry and a row in the matrix (B11). Built: **Procurement** (PR/PO/WO) and **Risk Register** use one generic layout, and **GECOL power** keeps its inline-date layout plus a Record column. Generic layout: search, status segments (All, Mine, Draft, Awaiting review, Awaiting approval, Done), table, export, "New record" (needs the Entry level of the matrix row). Clicking a row opens the **record drawer**: ball in court (employee chips), approval path (Entry, Review, Approve, with auto-skips shown), the fields (editable only for the Entry holder while Draft), comment thread, timeline, and footer actions: Submit for review, Mark reviewed, Approve (step-up), Return with note (note required; goes back one level). Risk shows probability times impact as a score pill. GECOL rows open the same drawer for the four dates.
The other register menus (Contractors, HLC, Permits & HSE, Warehouse, Quality, Change Control, Readiness & Handover, As-Built, Meetings) still show the "Not built in this prototype" state; Issue Log lists issues per site.
Empty: "No records" with the filter hint. Error and no-permission: the shared states (a user without the Registers module gets no-permission). Read-only: "Read only. You are not assigned to this level."
Shortcuts: `/` search, `n` new record, `j` `k` move, `Enter` opens the drawer, `Esc` closes it.

### Absence & cover (Work menu; leads, admins; everyone for their own annual leave)
Purpose (decision B12b): nothing moves when someone is absent; the assignee stays until the lead decides. Top: an amber banner with the number of open tasks waiting on an absent person (also the badge on the menu item for leads). "Record absence": annual leave by the employee for themselves; sick and emergency leave by a lead or admin for anyone; validation for dates and overlaps. "Absence records" lists status (Absent now, Upcoming, Past). Lead panel: chips for people absent today, their open tasks with the current decision (Undecided, Kept, Reassigned to X, Lead on behalf), then the decision card: Keep the assignee, Reassign to another person (only people eligible for every task in scope: active, not absent, right permission level and region), or Act on their behalf (logged "lead on behalf of the assignee", the self-approval and skip rules still apply); scope per selected tasks, per site, or all open tasks; a reason is required; the card states that the SLA is not reset or paused and the matrix is unchanged. Tasks show an "absent" badge on the person chip everywhere, and the task drawer explains a reassignment. "Idle tasks" lists tasks without activity for N working days (Settings, Workflow).
Empty: "Nobody is absent today", "No open tasks", "No idle tasks", "No absence recorded". Error and loading: the shared states. No-permission: employees see only their own records and the form (no lead panel).
Shortcuts: `/` focus, `Enter` on an idle row opens the task, `Esc` closes the drawer.

### Audit Log
Append-only table with before and after, MFA chip, "Admin override" badge, "on behalf of" badge, filters (user, action, text), CSV export (the export is itself audited). No edit or delete control exists. Empty: "No entries match". Shortcuts: `/` search.

### System Log
Console-style list with level chips (Errors, Warnings, Info) and search; rejected uploads and caught UI errors appear here; kept 12 months. Empty: "No log lines". Shortcuts: `/` search.
