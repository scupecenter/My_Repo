# Next work: site page tabs, register views, Settings clean-up, dead screens, Documents hub

Owner request: 2026-11-23, after PRs #183-#187 merged. This file is the single source of truth for this work. Anyone can continue it from another place or account: read it top to bottom, then do the first workstream not marked Done. Update the Status column and the log at the end in every PR.

House rules (unchanged):
- One PR per workstream.
- PR titles and bodies are in English; chat replies to the owner are in Arabic.
- Tests run on GitHub CI only. Run them locally only to diagnose a failure.
- Hand over one PR at a time, after green CI and a clean merge state. Verify main after each merge, then delete the branch.
- Synthetic data only, no secrets. Never type U+2014 or U+2015.
- Edit .ts/.tsx files through Bash or Python: the Edit and Write tools trigger an auto-format hook that rewrites whole files with double quotes.
- Number collisions with other authors: before opening a PR, check the newest migration, the db/sql mirror (N-1, byte-identical), the contract version and the CHANGELOG number on main and on open PRs. At the time of writing, main has migration 0138 and contract 0.15.51, and the newest CHANGELOG entry is 187. Open PR #182 (another author) uses migration 0136.

## How to start from another place or account

1. Open Claude Code on the repository scupecenter/My_Repo (main branch).
2. Say: "Read pmis/CLAUDE.md and pmis/docs/plans/2026-11-23-next-ui-cleanup.md, then do the first workstream whose Status is not Done, following the Owner decisions section. One PR per workstream; reply to me in Arabic; PR text in English."
3. After each merge: update the Status table and the Log in this file in the next PR.

Everything below is decided. Do not ask the owner again about anything this section answers. If something truly new comes up, choose the option that matches what the system already does, and note the choice in the Log.

## Owner decisions (2026-11-23, final)

General rules for all workstreams:
- **Complete, not minimal.** Every new screen gets the full set of options the system already offers elsewhere: + Filter, saved views, search, column chooser, density, Export current view, and the view switcher where it applies.
- **Settings live in the general Settings.** Every new setting goes in Administration > Settings, in the tab that matches its area, never on the work screen itself. Use the same save rules: reason, audit with before/after, versioned where the area is versioned. The work screens link to their settings, shown only to users with the right.
- **Permissions come from the Responsibility Matrix and the permission grid, as everywhere else.** Add a matrix row or grid entries for each new module (L1 = enters and edits, L2 = reviews and locks or approves), scoped by region and module. No new permission mechanism.
- **Names are short.** New menus use one or two words, in English and Arabic, and sit in a logical place in the sidebar.

Menu names and places:

| Item | English | Arabic | Place |
|------|---------|--------|-------|
| New main menu | Library | المكتبة | Sidebar, after Data entry and before Administration |
| Its first page (approved forms) | Forms | النماذج | Library > Forms |
| Its second page (site document archive) | Archive | الأرشيف | Library > Archive |
| Daily progress and plan | Daily Plan | الخطة اليومية | My Work > Daily Plan, with two tabs: Progress (الإنجاز) and Tomorrow (خطة الغد) |

W5 decisions (Library: Forms and Archive):
1. **Who generates a filled document for a site:** the L1 holder of the task that the document belongs to, plus anyone the Responsibility Matrix or the permission grid gives "Documents: generate" for that region. The L2 holder approves the signed upload, as today.
2. **Archive cards:** one card per Document Library type that has at least one file or one generated document, grouped by stream (Design & Acquisition, Civil Works, Installation (TE), O&M, Handover & Closure, Dismantle, Registers). Each card shows the counts approved, waiting review and missing. The admin hides, shows and orders the cards in Settings > Library > Archive.
3. **Archive list (inside a card), full options:**
   - Columns: Site ID, site name, region, cluster, document type, document number, version, status (due / generated / signed and uploaded / in review / approved / rejected / superseded), task, uploaded by, upload date, approved by, approval date.
   - Tools: + Filter, saved views, search (site, number or file name), Export current view, bulk download as zip (by filter), file preview, version history, and open the site's Documents tab.
   - Every download is audited.
4. **Forms page, full options:**
   - Lists every approved form (the uploaded SoF and CW forms, future HTML forms), with: name, code, version, document type it produces, triggering task, numbering pattern and last update.
   - A user with the right picks a form and a site, sees the auto-filled preview, then downloads or prints it. The generated copy enters the Archive as "generated".
   - Uploading a new form or a new version, approving it and binding its fields happen in Settings > Documents (Library and Form templates), linked from this page for admins.
5. **When a document is due:** each form is bound in the Document Library to its document type and its triggering task (admin setting). A document becomes "due" when that task opens. The site's Documents tab and the Archive show the lifecycle: due, generated, signed and uploaded, in review, approved.
6. **Settings > Documents** gets these sections:
   - Document types (the existing "Library" section, renamed so it is not confused with the new Library menu; same route with a redirect).
   - Form templates (upload, versions, field bindings, numbering).
   - Archive (visible cards and their order, default columns, bulk zip limit).
   - Mail (existing).

W7 decisions (My Work > Daily Plan):
1. **Scope:** one plan per region per day. A user sees the regions their assignments cover. The Project Manager and the System Admins see all regions.
2. **Who:** a Responsibility Matrix row "Daily Plan". L1 (site engineers and team leads by default) edits the rows. L2 (the region's team lead by default) locks the day. A locked day is read-only, except through an admin override.
3. **Auto-filled columns** (the user may change them by hand, and the change is audited):
   - From Site Master: Site ID, Tower Owner, Owner ID, Latitude, Longitude, Region, Site Type, SOW.
   - From the Procurement assignment of that day: Vendor / Contractor Name and AAT SE.
   - From the CW access date or permit validity: Access Valid (Yes / No / expiry date).
   - From system tasks and assignment field-work dates:
     - Planned Work: tasks with a planned date that day, and field work scheduled that day.
     - Actual Work: tasks with an actual date that day.
4. **Manual columns:** "Reason (if not reach target)", required when Actual is below Planned, and "Remark". Users may also add or remove sites in the plan.
5. **Tomorrow tab:** the next working day (the weekend is Friday and Saturday; holidays come from the calendar), filled the same way.
6. **Tools:** + Filter (region, contractor, AAT SE, SOW), saved views, Export (Excel with the exact column order of the owner's sheet), and "Copy for email". Copy for email puts both tables on the clipboard as an HTML table with a plain-text fallback, with the titles "Daily Progress <date>" and "Tomorrow Plan <date>". There is no direct sending from the system.
7. **Settings > My Work > Daily Plan** (a new section):
   - Visible columns and their order.
   - Default region scope.
   - The time after which today's plan locks automatically, empty for no automatic lock.
   - A reminder to the L1 holders if Tomorrow is empty by a set hour.

W2 decision: inline editing in the wide table follows each register's own field rights (field-level rules and register state). Board columns use the register's status field, and Map uses the site coordinates.

W3 decision: everything Settings > Site360 still does moves to Settings > Workflow > Columns, with the same rights.

W1 decision: the single tab row takes its phases from the published workflow version of the site.

## Status

| # | Workstream | Status | PR |
|---|------------|--------|----|
| W1 | Site page: one clear tab row instead of two overlapping rows | Done | #199 |
| W2 | Registers & Logs: the same view options as Site Master (wide table, board, density, map where it applies) | Done (branch `claude/w2-register-views`, built on W8; contract 0.15.69, no migration, CHANGELOG 204) | #204 |
| W3 | Settings > Site360: remove the tab and the name; move what is still useful into Settings > Workflow | Done | #198 |
| W4 | Dead or stuck screens: Settings > Alerts and Security stay on "Loading..."; audit every menu and tab | Done | #201 |
| W5 | Library menu (Forms and Archive); Data entry > Templates stays as it is | Done (branch `claude/w5-library`, contract 0.15.70, migration 0151, CHANGELOG 205) | this PR |
| W7 | Daily Progress and Tomorrow Plan: a screen in the system, copyable to email | Done | #203 |
| W8 | Site lists and the site task table: row numbers everywhere, three-level headers, list-style task table, display options (font size, alignment, density, wrap) | Done (branch `claude/w8-table-standard`, contract 0.15.68, migration 0148, CHANGELOG 201); the Daily Plan (W7) and the Archive (W5) adopt it when they are built | |
| W6 | CHANGELOG, CLAUDE.md navigation notes and this file updated | Pending | |

Suggested order: W4 first (it may expose broken APIs that W3/W5 depend on), then W1, W8, W3, W7, W2, W5, W6. W8 builds the shared table options that W2 then reuses on registers. W2 and W5 are the largest.

## W1. Site page tabs (owner images 1-2)

Today, on /sites/:id, below the section tabs (Tasks, Master, Documents, QC snags, Scope, Warehouse) two tab rows sit on top of each other:
- Row A: All, Design & Acquisition, Civil Works (greyed), Installation (TE), Handover & Closure, Dismantle. Find this row's source first: it is not in pages/Site.tsx, so search components/ for the task list's stage or phase filter.
- Row B (`site-stream-tabs` in pages/Site.tsx): All work, Civil Works, Installation (TE), O&M. These are the streams.

Problem: Civil Works and Installation (TE) appear in both rows, so the user cannot tell what each row filters. Row A also lacks O&M and Row B lacks Design and Dismantle.

Do:
1. Confirm what Row A filters: workflow phase of the task, milestone group, or something else. Confirm whether it follows the latest workflow structure (Settings > Workflow / Studio phases). Write the finding here.
2. Replace both rows with one row that follows the current workflow phases in Studio order: All, Design & Acquisition, Civil Works, Installation (TE), O&M, Handover & Closure, Dismantle. Take the list and the order from the workflow configuration, not from a hard-coded list. A phase with no tasks for this site is shown disabled with a tooltip, as Civil Works is today.
3. The stream summary (`site-stream-summary`: state, progress, ball in court) moves under the single row and shows for the selected phase when that phase maps to a stream.
4. Keep the URL param backward compatible: old `stream=` links open the matching phase.
5. Tests: vitest for the single row (labels in workflow order, disabled phase, old `stream=` link); update the existing Site page tests and the e2e that use `site-stream-tab-*`.

Acceptance: one tab row; no duplicated labels; the order matches Settings > Workflow; Arabic and English, light and dark.

Finding for step 1 (2026-11-24, W1 PR). The two rows above were described the wrong way round:
- **Row A is `site-stream-tabs` in pages/Site.tsx** (All, Design & Acquisition, Civil Works, Installation (TE), Handover & Closure, Dismantle). It filters by **stream**: the stage group of the task (`stage_definitions.stream_code`, table `workflow_streams`, migration 0015), through `GET /sites/{id}/tasks?stream=`. Civil Works is greyed when the site's `StreamStatus.state` is `na` (no counting task in the stream). Dismantle is a placeholder added by `withDismantle` in lib/streams.ts (owner decision Q41): the API has no DISMANTLE stream, so the tab lists nothing.
- **Row B is components/ViewTabs.tsx (`site-view-tabs`)** (All work, Civil Works, Installation (TE), O&M). It filters by **work view** (tables `workflow_views` and `workflow_view_members`, migration 0023, Q98) through `?view=`. A view is a set of stages plus single tasks: the CW view adds CW FAC (B15), the TE view adds the HOTO stage and TE FAC (D18), and the O&M view holds CW DLP (B14), plus both FACs when `views.om_team_assigned` is on.
- Neither row is a milestone group. Both already follow the site's own workflow version: they come from `streams[]` and `views[]` of `GET /sites/{id}`, which belong to the version and are copied into each new draft. Studio and Settings > Workflow have no screen for streams or views; Studio edits milestones, gates and tasks only.

What W1 does with this:
- The one row merges the streams and the views of the site's published version. The streams come first, in their sort order. A view with the code of a stream (CW, TE) is the same phase. Any other view (O&M) goes right after the phase of the view before it. The seed gives: All, Design & Acquisition, Civil Works, Installation (TE), O&M, Handover & Closure, Dismantle. Nothing is hard-coded, so another version shows its own list.
- A stream phase filters by stream (`stream=` in the URL), so the stream summary, the task grid and the pipeline count the same tasks. A view-only phase (O&M) filters by view (`view=`). CW FAC, HOTO and TE FAC therefore appear under Handover & Closure (their stream) and under All, no longer under Civil Works or Installation (TE).
- Old `stream=` links open the phase of that stream. Old `view=` links open the phase of that view (`view=CW` opens Civil Works). When both are given, `stream=` wins.
- A phase with no applicable task is disabled with a tooltip: a stream whose status is `na`, a view with no task that is not N/A, and the Dismantle placeholder. An old link to a disabled phase shows "This phase does not apply to this site."

## W2. View options in Registers & Logs (owner images 3-4)

Site Master and its sub-menus have, in this order: saved views, Save view, search, + Filter, count, Map, Board, Wide table, density (rows) and column chooser, Export current view, more (...). Registers (pages/Register.tsx; Procurement is one example) have saved views, Save view, + Filter, search, count, New record, density, columns, Export, more, but no Wide table, Board or Map.

Do:
1. Wide table on every register and log: one row per record, columns of that register left to right, frozen first columns (# and Site ID), section headers when the register has column groups, LTR table and scroller in both locales. Inline edit only where the register already allows editing that field, through the register's existing save path (same rights, locks and version check). Reuse components/SitesWideTable.tsx: generalise it into a shared WideTable that takes columns, rows and an onSave adapter. Do not copy it.
2. Board (cards by status) on every register that has a status or stage column. Reuse the Site Master board component.
3. Map only on registers whose records carry site coordinates through the site (most site-based registers). Hide it elsewhere.
4. Saved views keep the layout (list, wide, board, map), as #185 does for Site Master. Extend the saved-view layout field to register screens.
5. The toolbar has the same order and look as Site Master.
6. Tests: vitest per layout on two registers (one with and one without coordinates); an e2e that switches layouts on Procurement in ar and en.

Acceptance: every register in Registers & Logs offers the same view switcher as Site Master, except where a layout does not apply (Map without coordinates, Board without status); saved views remember the layout.

Result (2026-11-24, branch `claude/w2-register-views`, on top of W8). Choices made under the House rules:
- **One wide table.** `components/WideTable.tsx` is the wide table of Site Master generalised (columns, rows, a cell adapter and an `onSave` adapter); `SitesWideTable.tsx` is now a thin adapter over it with the same behaviour and test ids. The register adapter (`components/RegisterViews.tsx`, `RegisterWide`) shows every field of the register the caller may see (the catalogue never lists a hidden field), in the register's order, under its form section (header row 1; "Record" and "Workflow" for region, type, state and ball in court), with # and Site ID frozen (a register without sites shows "Record" there and a "-" code). LTR table and scroller in both locales.
- **Inline edit = the register grid's rule** (owner decision W2): an inline type (text, number, date, list; a list with no fixed values or that allows other values is typed as text), not `read_only` for the caller, the column and the record not locked unless a System Admin, and `edit` in the record's `allowed_actions`; plus the form's own "does not apply" rules (`isHidden`, `typeHides`). The save is `useUpdateRecord` (PATCH with If-Match the record version); a refusal keeps the editor open with the register's own error text. Every read-only cell says why in its tooltip.
- **One board.** `components/Board.tsx` (`BoardGrid`) is the grid of the Site Master board (columns with counts and WIP note, swimlanes, cells, "N more"); `SitesBoard.tsx` uses it unchanged. The register board's columns follow the register's status field (owner decision W2): its single-value field named `status`, `..._status` or `stage` (Procurement Order Status, Permit Status, HLC Fiber Status, Issue Status, Quality Stage, ...), the first one shown in the list by default; columns are the list values in order, then values found outside the list, then "Not set". The approval state (entry, in review, in approval, approved, voided) is always offered and is the default where the register has no status field (so Board applies to every register). Swimlanes: none, region, record type. Read only like the Site Master board: a card opens the record drawer.
- **One map.** The register map is the Site Master `SiteMap` with a new outer scope `site_codes`: the sites of the records of the current filters. Only a register with `site_scoped` offers it. It reads the sites the caller may see (`GET /dashboard/site-map`), so a record's site outside them is never drawn.
- The board and the map load every record of the filters (pages of 100, up to 2000), so their counts match the server count; above it they say "Showing the first 2000 of N".
- Saved views of `register-<key>` keep `layout`, `board_by` and `lane` as quick parameters of `filters` (contract 0.15.69, documentation only: the server already stores quick parameters as given). No API, migration, setting or permission change; no new table.
- Also fixed: the register footer showed the missing key `registers.count_of` (removed: the W8 "Showing 50 of 120" footer covers it), and the Site Master board error showed the missing key `common.error`.

Register list (W2):

| Register | Route | List | Wide table | Board (default columns) | Map |
|---|---|---|---|---|---|
| Procurement (PR / PO / WO) | /registers/procurement | done | done | done (Order Status) | done |
| Contractors | /registers/contractors | done | done | done (Status of the company; Contract Status and Team Status on demand) | not applicable: companies, teams and contracts have no site |
| GECOL Power | /registers/gecol | done | done | done (approval state; its status field if the catalogue has one) | done |
| HLC Fiber | /registers/hlc | done | done | done (Fiber Status) | done |
| Permits & HSE | /registers/permits_hse | done | done | done (Status) | done |
| Warehouse | /registers/warehouse | done | done | done (Transaction Status) | not applicable: stock movements are not site records (`site_scoped` false) |
| Quality Control | /registers/quality | done | done | done (Stage) | done |
| Issue Log | /registers/issues | done | done | done (Issue Status) | done |
| Risk Register | /registers/risks | done | done | done (Status) | not applicable: project-wide risks |
| Change Control Log | /registers/change_control | done | done | done (approval state) | done |
| Readiness & Handover | /registers/readiness_handover | done | done | done (approval state) | done |
| As-Built | /registers/as_built | done | done | done (Rectifier Status) | done |
| Meetings | /registers/meetings | done | done | done (approval state) | not applicable: project-wide meetings |
| RF & Design | /registers/rf_design | done | done | done (TSSR Status) | done |
| Acquisition | /registers/acquisition | done | done | done (approval state) | done |
| Dismantle | /registers/dismantle | done | done | done (approval state) | done |
| Car Dispatcher | /registers/car_dispatcher | done | done | done (Vehicle Status) | not applicable: vehicles and bookings have no site |
| Financial Advances | /registers/financial_advances | done | done | done (approval state) | done |

The default board column is read at run time from the register's catalogue (the server's field list, as the caller may see it); the column above names the field of the seed. The list is in `lib/siteDataScreens.ts` (`REGISTER_SCREENS`), and the guard `tableStandard.test.tsx` renders each register and fails when its toolbar, count, Board or Wide table button is missing, or its Map button does not match the table above.

## W3. Settings > Site360 (owner image 5)

The SITE 360 name was removed from navigation in #177. Settings still has a tab `site360` (pages/settings/Settings.tsx, SETTINGS_TABS) that renders Site360Columns.tsx. Workflow Studio (#179) already manages the SITE 360 columns.

Do:
1. List every function Site360Columns.tsx and its API (GET/POST /site360/columns...) still offer that Studio does not. Write the list here.
2. Move each missing function into Settings > Workflow (a section, or inside Studio's Columns view), with the same rights (site360_col_can_admin).
3. Remove the `site360` tab. Add a legacy redirect `site360` and `site360-columns` to the new Workflow section in LEGACY_SETTINGS_PATHS.
4. Replace user-visible "Site360" / "SITE 360" words in Settings and in i18n with "Site Master" (en) and its Arabic equivalent. Code identifiers and API paths stay.
5. Tests: settingsRedirects and settingsScreens updated; the moved functions keep their tests.

Acceptance: no "Site360" tab or label in Settings; nothing the tab did is lost; old links redirect.

Step 1 finding (2026-11-24). What the Site360 tab (Site360Columns.tsx) and its API offered that Workflow Studio did not:

| # | Function | Studio before W3 | Moved to |
|---|----------|------------------|----------|
| 1 | One list of every Master column in Master order (A to GE and the added columns), whatever feeds it | Studio lists only the columns whose source is a task, inside that task's form | Settings > Workflow > Columns (`workflow/columns`), the full list |
| 2 | Change the menus of a column that no task feeds (site fields such as Site ID or Region, scope flags, register and formula columns) through `PATCH /site360/columns/{ord}/sections` with a reason | Not reachable: such a column is in no task form | Settings > Workflow > Columns, same dialog, same API, same right (`site360_col_can_admin` on the server) |
| 3 | The status columns (FX:GE) shown as "Status (every menu)", with no edit | Shown only for task columns | Settings > Workflow > Columns |
| 4 | The list is read from `GET /site360/sections` (menu names from the server, readable by anyone who opens Settings); only the save needs the right | `GET /site360/columns` answers 403 to anyone without the right | Kept as it was: the moved screen still reads `GET /site360/sections` |

Nothing else: rename, type, dropdown list, deactivate, reactivate, delete and add of a column were already in Studio (task form and the "New Site Master column" tab), and stay there. The moved screen links to the Workflow editor for them. No API or contract change was needed.


## W4. Screens that stay on "Loading..." (owner image 6)

Settings > Alerts (Notifications.tsx) and Settings > Security (StaffVisibility.tsx, Retention.tsx) show "Loading..." and never render. The yellow banner says "Some screens are not connected to the server yet".

Do:
1. Reproduce against the real API (local sign-in, hybrid mode) and find the root cause for each screen. Candidates: a missing API route; a route missing from realApi.ts, so the query never resolves or never errors; a query stuck because of an `enabled` condition; a 404 or 501 shown as loading forever.
2. Fix the root cause. If the backend route does not exist, implement it when the contract already defines it. Otherwise show the standard "not available" state, never an endless spinner.
3. Audit every menu item and every Settings tab and section the same way. Write the result as a table here: screen | state (works / not available / stuck) | cause | fix PR.
4. Add a guard: a test that renders every Settings tab and section in hybrid mode and fails if any stays on "Loading..." after the queries settle.

Acceptance: no screen stays on "Loading..."; each one either works or says "not available" clearly; the audit table is filled in.

### W4 findings (2026-11-24)

How it was checked: a local NestJS API on a fresh database with every migration (synthetic bootstrap admin), the web in hybrid mode (`VITE_USE_MOCKS=true`, `VITE_REAL_API=auth-users`, `/api` proxied to that API), and a browser that opened every sidebar entry, every Settings tab and every Settings section twice: as a System Admin, and as a delegate who holds `admin.settings` edit for all regions but is not a System Admin and does not hold `users.edit`. Each screen was read after its requests settled; the table lists the API answers that were not 2xx.

Root cause of owner image 6. Since #188-#194 every route of these screens is served (`NOT_AVAILABLE` is empty), and as a System Admin Alerts, Staff field visibility and Log retention all render with real data. The screens were still able to hang, for one reason in the web: they returned "Loading..." whenever their data was missing (`if (!q.data) return Loading`), and a failed read leaves the data missing for ever. In the owner's screenshot the reads answered 501 `not_available` (the routes were then in `NOT_AVAILABLE`); today the same screens hang on a 403 for anyone who opens Settings without the right of that screen. A second defect: the notification-type catalogue (`api/settings.ts`) and the permission catalogue (`api/admin.ts`) shared the query key `['catalogue']`, so Alerts read the permission catalogue after Delegation or Permission profiles had loaded it (and the other way round).

Fix: one shared fallback, `QueryFallback` in `components/States.tsx`: "Loading..." only while a read is pending; a refused read (403) shows the standard "no access" state, a 501 `not_available` shows "Not available yet" with the hybrid note, any other error shows the error with Retry. Every Settings screen that could hang now uses it. The notification catalogue has its own key (`notification-catalogue`). `common.error` (a key that did not exist, shown raw by Board WIP, Identity and Imports) is gone with it. No backend route was missing: no API, migration or contract change.

Settings (tabs and sections):

| Screen | State as System Admin | State as `admin.settings` delegate, before | Cause | Fix PR |
|--------|-----------------------|---------------------------------------------|-------|--------|
| Calendar | works | works | | |
| Workflow > Editor | works | works (read-only); `GET /workflow/site-migrations` 403 is not shown | | |
| Workflow > Columns (W3) | works | works | | |
| Workflow > Freeze | works | works | | |
| Workflow > Idle | works | works | | |
| Workflow > Board | works | works | | this PR: a failed read showed the raw key `common.error` |
| SLA > Rules | works | says "not allowed" (403 on `/settings/sla-rules`, `/settings/sla-rule-sets`) | the set editor hung on a failed read | this PR |
| SLA > DLP | works | works | | |
| Weights | works | looked empty: "no versions" (403 on `/settings/weight-sets`) | a failed list read looked like an empty list | this PR: "no access" |
| Registers > Columns | works | says "Something went wrong" (403 on a register's fields) | | |
| Registers > Contractors | works | showed an empty form as if it were the saved rules (403) | the form rendered without data | this PR: "no access" |
| Registers > GECOL | works | **stuck** on "…" (403 on `/settings/gecol-order-warnings`) | no error branch | this PR |
| Registers > Team / scope | works | **stuck** on "…" (403 on `/settings/team-scope-match`); the same component on Reports > Contractors | no error branch | this PR |
| DDL | works | works | | |
| Documents > Document types | works | says "not allowed" (403) | | |
| Documents > Mail | works | says "only a System Admin" (403); a 501 would have hung | no branch for errors other than 403 | this PR |
| Data > Imports | works | works | | this PR: raw `common.error` on a failed read |
| Data > Historical | works | works | | this PR: same fallback |
| Alerts | works (25 types, real policy) | works | owner image 6: 501 before #194, then a 403 or 501 hung; the catalogue key clash | this PR |
| Security > Staff field visibility | works | **stuck** on "Loading..." (403: System Admin or `users.edit` for all regions, contract 0.15.56) | no error branch | this PR: "no access" |
| Security > Log retention | works | **stuck** on "Loading..." (403 `module_forbidden`) | no error branch | this PR: "no access" |
| Dashboard | works | **stuck** on "Loading..." (403 on `/settings/dashboard`) | no error branch | this PR: "no access" |
| Identity & themes | works | works | | this PR: raw `common.error` on a failed read |

Menu items (sidebar). As a System Admin every entry works with the real API. The delegate's menu lists only My Work, Inbox and Messages; the other entries opened by link either redirect to My Work (registers without the module) or show their own "no access" or error state; none stays on "Loading...".

| Screen | State | Cause | Fix PR |
|--------|-------|-------|--------|
| My Work, Inbox, Approvals, Workload, Status updates, Dashboard, Messages, Absence & cover | works | | |
| Site Master and its six menus (Design & Acquisition, SOW, CW, TE, HOTO, O&M) | works | | |
| Registers & Logs: Dismantle, Procurement, GECOL Power, HLC Fiber, Permits & HSE, Warehouse, Quality Control, Issue Log, Risk Register, Change Control Log, Readiness & Handover, As-Built, Meetings, RF & Design, Acquisition, Contractors, Car Dispatcher, Financial Advances, Contractor reports | works | | Contractor reports: this PR (its team / scope table could hang) |
| Data entry > Templates | works | | |
| Administration: Users & Roles (users, assignments, roles, permission profiles, groups, delegation, Responsibility Matrix), Online now, Announcements, Settings | works | | |
| Logs: Audit Log, Field changes, Security log, System Log, Online sessions, Security alerts, Job runs, Deployments, Monthly activity report, Integrity checks, Mail delivery | works | | |

Guard: `src/pages/settingsNoEndlessLoading.test.tsx` renders every tab and section of `SETTINGS_TABS` (a new one is covered at once) three times: with the served data, with every read answering 403, and with every read answering 501 `not_available` as the hybrid build does for a route with no API. It fails if "Loading..." (en or ar), a busy marker or a lone "…" is still on screen once the queries have settled. On the code before this PR it fails for Registers > GECOL and Team / scope, Documents > Mail, Alerts, both Security sections and Dashboard.

## W5. Library (Forms and Archive) (owner image 7 and request)

Today "Data entry > Templates" (pages/Templates.tsx, "Templates and uploads") mixes:
- input templates (Excel per register and per SITE 360 stream, upload and validate), and
- approved project document forms recently uploaded so the system can fill them automatically when a document falls due. The user then prints, signs, stamps and re-uploads them. The library is under Settings > Documents > Library (DocumentLibrary.tsx).

The owner wants this clear:

1. **Data entry > Templates stays exactly as it is** (name, route and content), owner decision 2026-11-23: it may be removed later. Do not rename or move it. Only the document forms (the uploaded SoF and CW forms) move from it to Library > Forms, if they are listed there today.
2. **Library** (new main menu, المكتبة) has two cards:
   - **Forms (النماذج)**: every approved document form (the uploaded project forms and future HTML forms), with version, owner, the document type it produces and the stage or task that triggers it. From here, a user with the right can generate a filled document for a site: auto-fill, preview, download or print. For admins, the page links to Settings > Documents (Document types and Form templates), where forms are uploaded, versioned and approved.
   - **Archive (الأرشيف)**: one card per document type, for example Site Survey Report or Handover Certificate, with a count. Opening a card lists every document of that type for all sites in a list with + Filter, saved views and Export: site, version, status (generated / signed and uploaded / approved), uploaded by, date, file. Each row opens the file and the site's Documents tab.
3. The document lifecycle is visible:
   - **Due:** a task reaches the stage that needs the document.
   - **Generated:** auto-filled from site data.
   - **Printed and signed offline.**
   - **Uploaded.**
   - **Reviewed and approved.**

   Each step is shown on the site's Documents tab and in the archive list.
4. Reuse the existing APIs for documents, the document library and site documents (find them in apps/api/src/documents and the contract). Add only what is missing, with a contract patch version.
5. Navigation: add Library to the sidebar between Data entry and Administration (or where CLAUDE.md navigation says). Update CLAUDE.md navigation notes.
6. Tests: vitest for both cards and the archive list; API tests for any new endpoint; one e2e: generate a filled document for a site, upload the signed copy, see it in the archive.

Acceptance: Data entry > Templates is unchanged except that document forms no longer appear in it; a user finds approved forms in one place and every uploaded site document by type in one place; the lifecycle state is visible.

Result (2026-11-24, branch `claude/w5-library`). What was built, and the choices made where this section was silent:
- **Menu.** Library (المكتبة) sits between Data entry and Administration with Forms (`/library/forms`) and Archive (`/library/archive`, a list per type at `/library/archive/:docCode`). It shows for anyone with `sites.documents` view. A shared menu layout saved before W5 gets the Library heading right after the heading that holds Templates.
- **Data entry > Templates** was checked: it never listed document forms (it lists the register, stream, Master, New sites, list and holiday templates only). It is unchanged; a test asserts that no document form appears there.
- **Forms.** The approved form templates (one per code, the version in force) plus the Document Library types with an uploaded blank form (download only). A form template is HTML with the placeholder language of the CW forms (`design/forms/bindings.md`), bound to one document type and one triggering task, with a numbering pattern of the existing numbering service (`doc_sequences`, migration 0053; a new column `form_code`). Generation (L1 of the task, or the grant `library.forms` create = "Documents: generate" for the region, or a System Admin; the task open) numbers the copy, keeps it and audits it; the copy is "generated" in the Archive. Print and download are the stored HTML (a PDF through headless Chromium is still open). The signed scan is uploaded into the task's own slot (the existing upload) and the L2 holder approves it with the task.
- **Archive.** Cards per Document Library type with at least one file or one generated copy, grouped by the stream of the task the type is placed on; a task of a work view that is not a stream (O&M) groups under that view; register placements group under Dismantle or Registers. Counts per card: approved, waiting review (uploaded or in review), missing (due, generated or rejected). The list has one row per document slot (superseded file versions on request) with the lifecycle status, the columns of W5-3, the W8 toolbar, preview, version history (`GET /documents?file_group_id=`), the bulk zip by filter (the existing zip export, limit of the setting), and a link to the site's Documents tab, which shows the same lifecycle.
- **Settings > Documents:** Document types (the old Library section; `documents/library` redirects), Form templates, Archive (hidden cards, order, default columns, zip limit; setting `library.archive`), Mail.
- **Security.** Templates go through an allow-list re-serializer (`apps/api/src/library/sanitize.ts`) on save and every filled copy again; the database keeps a deny-list as defence in depth; the preview frame runs no script; the served file has a CSP without scripts or network.

## W7. Daily Progress and Tomorrow Plan (owner request 2026-11-23, image of the Excel sheet)

Today the team keeps a daily Excel sheet with two tables:
- **Daily Progress** (dated today) with columns: No, Site ID, Tower Owner, Owner ID, Latitude, Longitude, Region, Site Type, SOW, Vendor / Contractor Name, AAT SE, Planned Work, Actual Work, Reason (if not reach target).
- **Tomorrow Plan** (dated tomorrow) with columns: No, Site ID, Tower Owner, Owner ID, Latitude, Longitude, Region, Site Type, SOW, Vendor / Contractor Name, AAT SE, Access Valid, Planned Work, Remark.

The owner wants this summary inside the system, with a way to copy it to an email.

Do:
1. A screen "Daily plan" (suggested place: under My Work or the Dashboard; confirm with CLAUDE.md navigation) with a date picker and two sections: Daily Progress for the chosen date and Tomorrow Plan for the next working day (Friday and Saturday are the weekend; skip holidays from the calendar).
2. Pre-fill from system data, never retyped:
   - From Site Master: Site ID, Tower Owner, Owner ID, coordinates, Region, Site Type, SOW.
   - From Procurement assignments: Vendor / Contractor and AAT SE.
   - From the CW access date or permit: Access Valid.
   - Planned Work: the tasks or field work planned for that day (assignment field-work dates and task planned dates).
3. Users with the right edit Planned Work, Actual Work, Reason and Remark per row, and add or remove sites from the plan. Each day's plan is saved, versioned and audited. A "not reached target" row requires a reason.
4. Rows can be filtered by region, contractor and AAT SE with the unified + Filter.
5. "Copy for email": copies both tables as an HTML table (with a plain-text fallback) that pastes cleanly into Outlook, with the title and date as in the Excel sheet. "Export" downloads the same two tables as Excel in the same column order. An optional "Send by email" uses the existing mail service to chosen recipients or groups, audited.
6. Contract: new endpoints only through contracts/openapi.yaml (patch version), a migration for the saved daily plan rows if needed, CHANGELOG entry.
7. Tests: API for pre-fill, save and the required reason; vitest for the screen, copy (clipboard contains a table) and export; one e2e in ar and en.

Acceptance: the two tables of the Excel sheet appear in the system for any date, filled from system data; the user adds only the daily facts; one click copies them into an email in the same layout.

## W8. Site lists, the site task table and display options (owner request 2026-11-23, images of Site Master and the site page)

Findings from the owner's screenshots:
- The Site Master list (normal layout, for example Design & Acquisition) has no row-number column. Only the wide table has `#`.
- The wide table repeats the group name in every header ("Identification / Site Owner ID", "Identification / Region", ...) under one section row ("RF & DESIGN"). The headers are long and hard to scan.
- On the site page, the Tasks table defaults to the "Row" layout: tasks are columns, and Status, Plan and Actual are rows. This reads sideways and does not look like the Site Master lists. A "List" toggle exists.
- Cluster ID shows "Not entered" for every site: the cluster codes produced in the owner's Excel file (2026-11-23) are not loaded into the system yet. Loading them is the owner's action (the Master upload or a direct admin edit). No code is needed, but note it in the PR.

Do:
1. **Row-number column everywhere sites are listed.**
   - Cover the Site Master main list and every sub-menu, normal list and wide table, plus every other screen that lists sites: registers with a site column, My Work lists, dashboard drill-downs and the archive lists of W5.
   - The first column is `#`: 1..n in the current sort and filter, continuing across "Load more" pages. It is frozen with Site ID.
   - The count beside the toolbar stays.
2. **Three header levels in the wide table and in grouped lists.**
   - Row 1: section (for example RF & DESIGN).
   - Row 2: group (for example Identification, Coordinates, Classification, Tower Information).
   - Row 3: the column name only (Site Owner ID, Site Name, Region, ...).
   - Adjacent headers with the same section or group merge across their columns. A column without a group spans rows 2 and 3.
   - Take the groups from the Master column metadata (the same source as the section headers today).
3. **Site page Tasks table.**
   - The default is a list like the Site Master lists: one row per task, grouped under its milestone (a collapsible group header with progress).
   - Columns: #, Code, Task, Status, Plan, Actual, SLA (due and state), Ball in court, Documents (count missing), Last update.
   - Full options: + Filter, column chooser, density, Export current view, and the display options below.
   - The current task-as-column layout stays as a second option, named "Timeline", and the user's choice is remembered.
4. **One full table standard on every screen that shows site data (owner rule 2026-11-23, clarified: site data only, but complete).** Screens in scope: Site Master and its sub-menus (list and wide table), the site Tasks table, every register and log that lists sites, My Work, Approvals, the Daily Plan, the Archive, and dashboard drill-downs that list sites. Screens without site data (audit, system and security logs, Users & Roles, Settings tables) are out of scope. One shared "Display" menu in the toolbar, next to density and columns:
   - text size: small, normal, large;
   - alignment of text cells: start, center;
   - row density: compact, normal, comfortable;
   - wrap long text on or off;
   - zebra rows on or off.

   Rules for the menu:
   - It is stored per user and per screen, and saved views keep it.
   - Defaults come from Settings > Dashboard or a new Settings > Display section in the general Settings, per the owner rule.
   - Build it once as a shared table toolbar and settings layer. The same toolbar (row numbers, + Filter, saved views, search, count (item 6), view switcher where it applies, columns, density, Display, Export) appears in the same order on every one of these screens.
   - List every data screen in the PR with its state (done / not applicable and why). A guard test fails when a site-data table renders without the shared toolbar. The toolbar is complete on each of these screens: + Filter with all its fields and AND/OR, saved views, search, columns, density, Display, Export, row numbers, and the view switcher where it applies.
5. **Search by a pasted list of sites (owner request 2026-11-23, screenshot: "BG009 BG010 BG012" in the search box gives no rows).** Today the search treats the whole text as one phrase.
   - When the text holds two or more tokens (separated by spaces, new lines, tabs, commas or semicolons, as when cells are copied from Excel), the search matches each token exactly against Site ID and Site Owner ID, case-insensitive, and returns every match, one row per site.
   - A single token keeps today's "contains" search on code and name.
   - The chip shows "Sites: 3 pasted, 2 found", and a "not found" list names the missing codes.
   - The search applies on the server (GET /sites, GET /site360/{menu}/rows, the register lists and the other site-data lists), so paging, count and Export follow it. Keep it in saved views.
   - A paste of up to 1000 codes is accepted.
   - It works on every screen in item 4's scope.
6. **Total, filtered and shown counts (owner request 2026-11-24).** Today the toolbar shows one number ("469 sites") that does not change when a filter or search applies.
   - Place: the same spot as today, right after the filter chips and before the view switcher (Map, Board, Wide table).
   - Text: "469 sites" when nothing is filtered. With a filter or search: "120 of 469 sites", with the filtered number in bold and a small "Clear filters" link.
   - The list footer beside "Load more" shows "Showing 50 of 120". It disappears when everything is loaded.
   - Selected rows add "· 3 selected".
   - Total = every site the user may see on that screen (region scope applies). Filtered = rows matching the current filters and search, server-side. Shown = rows loaded on the page.
   - Arabic: "120 من 469 موقعًا" and "يُعرض 50 من 120".
   - The numbers come from the server (a total and a filtered count in the list response; add them to the contract where missing), never from the loaded rows. Export uses the filtered set.
   - The same component appears on every screen in item 4's scope, with no exception: Site Master and every sub-menu (list and wide table), the site Tasks table, every register and log that lists sites, My Work, Approvals, the Daily Plan, the Archive lists and the dashboard drill-downs that list sites. Registers use their own noun ("records", "issues") with the same pattern; the site Tasks table counts tasks ("12 of 45 tasks").
   - The count is part of the shared toolbar of item 4, so the item 4 guard test also fails when a site-data screen renders without it, and the PR's screen list shows the count state of each screen.
7. Tests: vitest for the counts (unfiltered, filtered, partly loaded, selected), the row numbers across pages, the three-level header merge, the task list layout, the display menu (persisted and applied) and the pasted-list search (spaces, new lines, mixed case, not-found list); API tests for the multi-token search on the site lists; update the e2e for the wide table and the site page.

Result (2026-11-24, branch `claude/w8-table-standard`). The shared layer is `apps/web/src/components/TableStandard.tsx` (TableToolbar, TableCount, ShownFooter, SearchBox, PastedChip, the `#` column, GroupBands, DisplayMenu, ExportCsvButton) on top of TableKit; the screen list lives in `apps/web/src/lib/siteDataScreens.ts` and the guard is `apps/web/src/pages/tableStandard.test.tsx`. Choices made under the House rules:
- The `#` column is the first frozen data column; the row checkbox stays at the very start, as in the wide table, where `#` and the checkbox share the first cell.
- "Found" in the pasted-list chip means a site the caller may see on the screen (region scope and row security), whatever the other filters, so the chip never calls a visible site "not found" and never reveals a site of another region.
- The total of a stream or a work view is the sites with work in it (the screen itself); a drill-down, a bucket or a stage is a filter.
- My Work and Approvals have no server export source, so their "Export current view" writes the rows of the view (the server's filtered set) to a CSV in the browser, with formulas neutralised. Approvals is a master-detail card list: it has no column chooser; its Display options apply to the list.
- The Display defaults are a new tab Administration > Settings > Display (GET/PUT `/settings/table-display`, migration 0148, guarded key `table.display`, System Admin or an all-regions delegate of `admin.settings`, reason, If-Match, audit before and after). No matrix row is needed: the menu changes the look only, never data.

Screen list (W8 item 4):

| Screen | Route | State | Toolbar | Count | Notes |
|---|---|---|---|---|---|
| Site Master | /sites | done | complete | server (GET /sites `counts`) | pipeline, locks, gaps |
| Site Master stream | /sites?stream=CW | done | complete | server | N/A sites join both numbers when shown |
| Site Master work view | /sites?view=CW | done | complete | server | |
| Site Master sub-menus (Design & Acquisition, SOW, CW, TE, HOTO, O&M) | /sites?section=... | done | complete | server (GET /site360/{menu}/rows) | three header levels; search moved to the server |
| Wide table (Master and every sub-menu) | ...&layout=wide | done | complete | server | three header rows, `#` with the checkbox |
| Map and Board layouts | ...&layout=map, board | done | complete (switcher) | server (one-row GET /sites) | no rows, so no `#` |
| Site Tasks table, List (default) | /sites/:id | done | complete | "x of y tasks" | grouped by milestone, Timeline as second option |
| Site Tasks table, Timeline | /sites/:id | done | views, search, + Filter, count, Display, Export | same | columns are the tasks: no column chooser |
| Every register and log | /registers/:key | done | complete | server (GET /registers/{key}/records `counts`) | noun "issues" on the Issue Log |
| My Work | /my-work | done | complete | server (GET /me/tasks `counts`) | buckets as groups; CSV export in the browser |
| Approvals | /approvals | done | views, search, + Filter, count, Display, Export | server (GET /approvals `counts`) | master-detail list; CSV export in the browser |
| Dashboard drill-downs | /sites?dashboard_status=... | done | Site Master toolbar | server | they open Site Master with their filter |
| Daily Plan | (W7) | not applicable yet | | | not built; must use TableToolbar |
| Library > Archive lists | /library/archive/:docCode | done | complete | server (GET /library/archive/rows `counts`) | W5: noun "documents"; Export current view writes every page as CSV; bulk zip by filter |
| Excel-like grid (hidden) | ...&layout=grid | not applicable | | its own counts | no button since 2026-11-22 |

Acceptance:
- Every site list shows `#` first.
- Wide-table headers show section, group and column on three rows, without the "Group / Column" repetition.
- The site Tasks table opens as a list like Site Master.
- The toolbar shows total, filtered and shown counts. Pasting several Site IDs into the search box shows each of those sites in its own row. The same complete toolbar (filters included) and Display menu (text size, alignment, density, wrap, zebra rows, remembered) appear on every screen that shows site data.

## W6. Documentation

The CHANGELOG entry in every PR. Update CLAUDE.md navigation (Library menu, Settings tabs), this file's Status table and the log below.

## Size estimate (honest)

| Workstream | Size | Notes |
|-----------|------|-------|
| W1 | Small | Front end only |
| W3 | Small-medium | Depends on what Studio already covers |
| W4 | Medium | Unknown until reproduced; the audit may reveal more |
| W2 | Large | Generalise the wide table, board and map; saved-view layout for registers |
| W5 | Large | New menu and archive list; may need new API endpoints |
| W7 | Medium | New screen, saved plan table, copy and export |
| W8 | Medium | Shared table options reused by W2, W5 and W7 |

Total: roughly 7 PRs and several CI cycles each. This does not fit in one short session at the end of a weekly limit. Do it from a fresh session or account, in the order above.

## Log

- 2026-11-24: W5 done on branch `claude/w5-library` (migration 0151, mirror `db/sql/150_library.sql`, contract 0.15.70, CHANGELOG 205), built on W8. Library > Forms and Archive, Settings > Documents > Document types, Form templates and Archive (see the W5 result). New tables `library_form_templates` (KEEP) and `library_generated_docs` (DELETE) are classified in `data_reset_plan()` / `data_reset_core()` (redefined from 0149). Choices: the grant `library.forms` create is "Documents: generate"; O&M groups the documents of a task of the O&M work view; the form template upload is multipart (the JSON body limit is 100 KB and the owner's CW forms are about 480 KB); print and download are HTML until the Chromium PDF is built; a security review replaced the deny-list check of templates by an allow-list re-serializer.
- 2026-11-24: W2 done on branch `claude/w2-register-views` (built on W8; contract 0.15.69 documentation only, no migration, CHANGELOG 204): the shared WideTable and BoardGrid, the register wide table with inline edit through the record update, the register board by its status field (or the approval state), the register map narrowed to the records' sites, saved views with the layout, every register in `siteDataScreens.ts` and the guard. Choice noted: the status field is the register's single-value field named `status`, `..._status` or `stage`; the approval state is always offered, so Board applies to every register; Map only where `site_scoped`.
- 2026-11-24: W7 done on branch `claude/w7-daily-plan` (migration 0149, mirror `db/sql/148_daily_plan.sql`, contract 0.15.67, CHANGELOG 203). My Work > Daily Plan (`/my-work/daily-plan`) with the Progress and Tomorrow tabs; one plan per region per day (`daily_plans`, `daily_plan_rows`, row security by region, doors only); the Matrix row `daily_plan` (L1 Site Engineers CW/TE and CW/TE Team Leads, L2 CW/TE Team Leads; held through the module `daily_plan` or `sites`); Settings > My Work > Daily Plan (columns and order per tab, default region scope, automatic lock time, reminder hour; the job `dp_tick` every 5 minutes). Choices made where the plan was silent, following what the system already does:
  - The sidebar has sub-menus only for Site Master, so Daily Plan is its own entry in the Work group, right after My Work, at `/my-work/daily-plan`.
  - "Actual below Planned" counts the items (one per line of the cell): planned = tasks with a planned date or planned start that day plus field work scheduled that day; actual = tasks with an actual date that day plus field work that ended that day. A manual Planned or Actual Work cell counts its lines. Only days up to today can be below target.
  - The Procurement assignment of the day is the order whose field-work dates cover the day; with none, the site's latest approved active order names the contractor and the AAT SE (members with role supervisor, else every member). The contractor is the order's external party, else its team, else "In-House".
  - Access Valid: an approved CW permit valid that day ("Yes (to <valid to>)"), else B3 approved by that day ("Yes"), else "No".
  - Site ID, Site Name and Region identify the row and the plan: they are never overridden. Every other auto column can be changed by hand (audited); an empty value goes back to the auto value.
  - The lock freezes the rows (a locked day reads the same whatever happens to the tasks later). The L2 lock needs every reason first; the automatic lock locks anyway and keeps the rows flagged. A day reopened by the admin override is never locked again by the job.
  - "Tomorrow is empty" for the reminder means the plan of the next working day has no row at all (auto or added). The reminder is in-app, once per region per day, to the L1 holders of the region.
  - Export and Copy for email always use the exact column order of the owner's sheet; the visible-column setting shapes the screen only. Both follow the current filters (region, contractor, AAT SE, SOW, search).
  - Table standard: the screen uses the list pieces already on main (unified + Filter with page extras, saved views, search, count, density, columns, Export) and a plain `<table>`, so the shared table toolbar of W8 (row numbers, counts, Display menu) can wrap it later without a rewrite. `UnifiedFilter` now renders for a screen without server filter fields (its extras only).
- 2026-11-24: W8 done on branch `claude/w8-table-standard` (contract 0.15.68, migration 0148 with mirror `db/sql/147_table_display_settings.sql`, CHANGELOG 201), in five commits: (a) shared toolbar, `#`, server counts and the pasted-list search; (b) three header levels; (c) the site Tasks list with Timeline; (d) the Display menu and Settings > Display; (e) registers, My Work, Approvals, the guard test and the screen list above. Cluster ID codes of the owner's Excel file are still to be loaded by the owner (Master upload or admin edit); no code needed.
- 2026-11-24: W4 done. Alerts and Security render with the real API since #188-#194; they (and Registers > GECOL and Team / scope, Dashboard, Documents > Mail) still hung on "Loading..." when a read failed (403 for a delegate, 501 in hybrid mode). One shared fallback (`QueryFallback`) shows "no access", "not available" or the error instead; the notification catalogue no longer shares a query key with the permission catalogue. Audit table and guard test in the W4 section. No migration, no contract change. CHANGELOG 199.
- 2026-11-24: W3 done: the Settings tab Site360 is removed; its Master column menus moved to Settings > Workflow > Columns (same API, same right); old `site360` and `site360-columns` links redirect there; user-visible "SITE 360" and "Site360" in i18n now read "Site Master" (en) and "ماستر المواقع" (ar). No migration, no contract change. CHANGELOG 202.
- 2026-11-24: W1 done. The site page has one phase row, built from the streams and views of the site's published workflow version. Row A was the stream row in pages/Site.tsx, not a component; Row B was ViewTabs (see the W1 finding). Front end only; no contract change. CHANGELOG 200.
- 2026-11-24: W8 item 6: total / filtered / shown counts on every site-data screen.
- 2026-11-23: W8 item 5: search by a pasted list of Site IDs.
- 2026-11-23: W8 added (row numbers, three-level headers, task list layout, one full table standard on every screen of site data).
- 2026-11-23: the new main menu is named Library (المكتبة) with Forms (النماذج) and Archive (الأرشيف); Settings > Documents > Library is renamed Document types.
- 2026-11-23: Data entry > Templates stays as it is (no rename), it may be removed later.
- 2026-11-23: owner decisions added (names, places, permissions via the matrix, settings in general Settings, Daily Plan under My Work, copy-paste email).
- 2026-11-23: plan written after #183-#187 (unified filter, wide view, saved views, bulk edit, dependent lists). Nothing in W1-W6 started.
