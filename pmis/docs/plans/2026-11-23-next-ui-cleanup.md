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
| W1 | Site page: one clear tab row instead of two overlapping rows | Pending | |
| W2 | Registers & Logs: the same view options as Site Master (wide table, board, density, map where it applies) | Pending | |
| W3 | Settings > Site360: remove the tab and the name; move what is still useful into Settings > Workflow | Done | this PR |
| W4 | Dead or stuck screens: Settings > Alerts and Security stay on "Loading..."; audit every menu and tab | Pending | |
| W5 | Library menu (Forms and Archive); Data entry > Templates stays as it is | Pending | |
| W7 | Daily Progress and Tomorrow Plan: a screen in the system, copyable to email | Pending | |
| W8 | Site lists and the site task table: row numbers everywhere, three-level headers, list-style task table, display options (font size, alignment, density, wrap) | Pending | |
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

- 2026-11-24: W3 done: the Settings tab Site360 is removed; its Master column menus moved to Settings > Workflow > Columns (same API, same right); old `site360` and `site360-columns` links redirect there; user-visible "SITE 360" and "Site360" in i18n now read "Site Master" (en) and "ماستر المواقع" (ar). No migration, no contract change. CHANGELOG 202.
- 2026-11-24: W8 item 6: total / filtered / shown counts on every site-data screen.
- 2026-11-23: W8 item 5: search by a pasted list of Site IDs.
- 2026-11-23: W8 added (row numbers, three-level headers, task list layout, one full table standard on every screen of site data).
- 2026-11-23: the new main menu is named Library (المكتبة) with Forms (النماذج) and Archive (الأرشيف); Settings > Documents > Library is renamed Document types.
- 2026-11-23: Data entry > Templates stays as it is (no rename), it may be removed later.
- 2026-11-23: owner decisions added (names, places, permissions via the matrix, settings in general Settings, Daily Plan under My Work, copy-paste email).
- 2026-11-23: plan written after #183-#187 (unified filter, wide view, saved views, bulk edit, dependent lists). Nothing in W1-W6 started.
