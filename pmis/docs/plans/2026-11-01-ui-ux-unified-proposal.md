# Plan: unified UI/UX upgrade (calm Linear look, ClickUp-style interaction)

Status: reviewed 2026-11-01. Phases 1 and 2 done (CHANGELOG 53, previews in `design/previews/ui-phase2/`); phase 3 done (CHANGELOG 58); next phases 4 and 4b. The owner approved a full visual and interaction upgrade on the condition that no functional rule or relationship changes. Delivery is by phase; each phase is its own PR.
Source: owner proposal `GSDN_PMIS_Unified_UI_UX_Proposal_AR.md` (sections 1-20).
Base: main after PR #57. PR #58 (write-through) is open.
Legend:
- Kind: **V** view only, **P** personal preference, **S** shared setting (admin grant), **D** changes data (goes through the normal workflow).
- Needs: **W** web only, **A** API and contract, **M** migration.
- Decision: **Adopt**, **Adapt**, or **Later**.

## 0. Rule change (owner approved 2026-11-01)
Change `CLAUDE.md` § "Brand and UI" to read:
> Visual direction: a calm, Linear-style layout with ClickUp-style navigation and interaction. ERPNext/frappe-ui supplies the colour tokens and form conventions only, not the overall layout. The accent stays the existing petrol `--accent` (teal-8 in light mode, teal-7 in dark). Green (`--done`) is only for "completed". Primary buttons use the accent. Cairo and Lucide stay.

The constraints in §7 do not change.

## 1. Current state (checked in code)
| Area | Status | Where |
|---|---|---|
| Petrol accent | Exists (teal-8 light, teal-7 dark) | `apps/web/src/styles/tokens.css` |
| Token files | Two copies, duplicated | `design/tokens.css` and `apps/web/src/styles/tokens.css` |
| Ctrl/Cmd+K | Exists; searches pages only | `components/CommandPalette.tsx`, `Shell.tsx` |
| Virtualized lists | Exist | `components/useVirtual.ts`, `TaskGrid.tsx` |
| Drawers | Exist | `TaskDrawer.tsx`, `RegisterDrawer.tsx` |
| CW/TE/O&M tabs; streams as filter | Exist | `ViewTabs.tsx`, `Sites.tsx`, `Site.tsx` |
| Pipeline (rings, gradient track) | Exists | `components/Pipeline.tsx` |
| My Work, Approvals | Exist (list only) | `pages/MyWork.tsx`, `pages/Approvals.tsx` |
| Saved views, favourites, recent items, sidebar groups, column config, density, bulk bar, Board/Calendar/Gantt | Missing | — |
| Editing register fields from the task grid | API done (PR #58); web not built | `TaskRegisterField` |

## 2. Feature register

### 2.1 Navigation (§3)
| # | Feature | Kind/Needs | Decision |
|---|---|---|---|
| N1 | Collapsible groups (Work / Registers / Admin); state saved per user | P, W→A | Adopt |
| N2 | Favourites (pages, sites, records, saved views), reorderable | P, A+M | Adopt |
| N3 | Recently opened items | P, W | Adopt |
| N4 | Search inside the sidebar | V, W | Adopt |
| N5 | Resizable sidebar; icon-only mode with tooltips and keyboard access | P, W | Adopt |
| N6 | Active page and its parent highlighted; clickable breadcrumb | V, W | Adopt |
| N7 | Badges only for "waiting on me" counts | V | Adopt |
| N8 | Mobile drawer menu; collapsing never loses the open page | V, W | Adopt |
| N9 | Nav follows real permissions; direct links still checked by the server | V | Adopt (exists) |
| N10 | CW/TE/O&M shortcuts under Site Register open the same views | V, W | Adopt |
| N11 | No giant tree of every site: search, favourites, recent items and lazy loading instead; one navigation layer, no extra Space/Folder levels | — | Adopt |
| N12 | Collapse, unfavourite and admin deactivation are separate actions; context menus show only allowed actions | — | Adopt (rule) |

### 2.2 Page header and toolbar (§4)
| # | Feature | Decision |
|---|---|---|
| T1 | Fixed order: title+context › view tabs › search/filters › group/sort/columns › count › primary action › "More" | Adopt (shared `PageHeader`/`Toolbar`) |
| T2 | Active-filter count; a context chip for project, site, stream or view | Adopt |
| T3 | Secondary tools overflow into "More"; the primary action is never hidden | Adopt |
| T4 | Row menu: open, open in a full page, copy code, copy link | Adopt |
| T5 | Page, row and global actions visually separate | Adopt |

### 2.3 Filters, search and saved views (§5)
| # | Feature | Kind/Needs | Decision |
|---|---|---|---|
| F1 | Quick filters: assigned to me, waiting on me, late, rejected, missing documents | V, A | Adopt |
| F2 | Active-filter chips: remove one or clear all | V, W | Adopt |
| F3 | Multi-value filters (regions, states) | V, A | Adopt |
| F4 | AND/OR condition groups | V, A | Adapt: list screens, phase 4 |
| F5 | Date presets (today, this week, custom range); calendar ranges labelled apart from SLA working days | V, A | Adopt |
| F6 | Personal saved view (filters, sort, columns, grouping) | P, A+M | Adopt |
| F7 | Shared views per team or role, gated by a new `views.share` grant; protected, so an edit makes a personal copy | S, A+M | Adopt |
| F8 | Duplicate view settings (never data); default view; pinned views; reset | P | Adopt |
| F9 | Filters stored in the URL; scroll position and selected row restored | V, W | Adopt |
| F10 | "No data" shown apart from "no results for these filters", with a Clear button | V, W | Adopt |
| F11 | Filtering, sorting and grouping run on the full result on the server; counts and export match the view | V, A | Adopt |
| F12 | Unsaved view changes are marked (save or revert); a view that uses a deactivated field shows a clear message | P | Adopt |
| F13 | Ctrl/Cmd+K finds pages, sites, records, tasks and permitted actions, grouped and ranked, filtered by permission; hidden items are never revealed | V, A `/search` | Adopt |
| F14 | A command that changes data opens the normal form; no bypass of review, approval or step-up | D | Adopt (rule) |
| F15 | Shortcut help (`?`); no global shortcuts while typing; Ctrl/Cmd aware; RTL aware | V, W | Adopt |

### 2.4 Tables (§6)
| # | Feature | Decision |
|---|---|---|
| G1 | Show and hide columns (limited by permission); reorder, resize and pin identity columns | Adopt |
| G2 | Sticky header and toolbar; virtualization kept with variable row height | Adopt |
| G3 | Sort, multi-column where the API allows | Adopt |
| G4 | Group by region, stage, holder or state; collapsible groups with true counts | Adopt (A: group counts) |
| G5 | Comfortable and compact density; wrap or truncate with a full-value tooltip | Adopt |
| G6 | Selected-row and editing-row states | Adopt |
| G7 | Multi-select with a bulk-action bar; "visible rows" told apart from "all matching" | Adopt |
| G8 | Column summaries | Adapt: numeric register columns only |
| G9 | Badges for attachments, comments and missing items | Adopt (A: counts in lists) |
| G10 | Empty, N/A and hidden-by-permission values shown differently | Adopt |
| G11 | Hiding a column never changes a field, a permission or the Master export | Adopt (rule) |

### 2.5 Drag and drop (§7)
| # | Item | Kind | Decision |
|---|---|---|---|
| DD1 | Reorder and resize columns | P | Adopt |
| DD2 | Reorder favourites; reorder view tabs (personal order only) | P | Adopt |
| DD3 | Resize the sidebar and drawer splitters | P | Adopt |
| DD4 | Drop files on the right document slot: target highlight, progress, errors | D | Adopt (polish what exists) |
| DD5 | Multi-file drop: type suggested from the file name, then confirmed | D | Adopt |
| DD6 | Board drag between columns = a real workflow action (owner decision 2026-11-01) | D | Adopt: dropping a card on Reviewed/Approved/Returned performs that action **only when the user holds that level** (server-checked as for the button). Columns the user may not drop on are shown disabled. A rejection/return opens the mandatory-note box; step-up opens when the action needs it; mandatory documents and validations are checked by the server and a refused drop snaps back with the reason. Approvals are sent after a 5-second "Undo" window (the request is not sent before it ends), so Undo is real. Every drop is audited like the button, with `via: drag`. Bulk drag of several selected cards follows the batch rules. |
| DD7 | Drag dates in Calendar or Gantt | D | Later, under the same rule (opens the edit form; SLA, approval and audit apply) |
| — | Every drag has a button, menu or keyboard alternative; valid targets shown; Esc cancels; the item snaps back on failure | — | Adopt (rule) |

### 2.6 Entry and quick edit (§8)
| # | Feature | Decision |
|---|---|---|
| E1 | A My Work card opens the task drawer | Adopt |
| E2 | Inline cell edit for allowed fields; keyboard navigation between cells | Adopt |
| E3 | Searchable pickers (sites, people, contractors, items); a person shown with employee ID, eligibility and account state | Adopt |
| E4 | Context pre-fill (for example the site), always visible; "Save and add another" | Adopt |
| E5 | Form sections; conditional fields; required, optional, computed and locked marked; units and formats shown; rare fields collapsible | Adopt |
| E6 | Field errors plus a summary that jumps to the field; unsaved-changes guard | Adopt |
| E7 | Saving / saved / failed state; input kept on failure; retries are idempotent (existing Idempotency-Key) | Adopt |
| E8 | Edit conflicts (existing ETag/If-Match) offer reload or compare | Adopt |
| E9 | A disabled primary action states why | Adopt |
| E10 | Saves always go to the source register (write-through, PR #58) | Adopt |
| E11 | The holder or approval state is never inferred from a page filter | Adopt (rule) |
| E12 | Deactivated list values stay readable in history and are blocked for new entry | Adopt (exists in the API) |
| E13 | View preferences auto-save; drafts of work data are not stored locally (Q115) | Adopt |
| E14 | Small in-place editors for simple fields; the full drawer for complex forms | Adopt |
| E15 | Undo only where the action is reversible; none for approvals, stock moves or audited edits | Adopt (rule) |

### 2.7 Drawers and the site page (§9)
| # | Feature | Decision |
|---|---|---|
| R1 | Resizable drawer; full-screen mode; mode remembered | Adopt |
| R2 | Sticky header (site code, task, state); holder ("with whom"), approval path and lock reason | Adopt |
| R3 | Sticky action bar at the bottom; tabs Data / Documents / Comments / History | Adopt |
| R4 | Next and previous through the current list, with an unsaved guard | Adopt |
| R5 | Link to the source record; deep link re-checked by the server | Adopt |
| R6 | Inline preview of PDFs and images (sandboxed); on wide screens the preview sits beside the review fields | Adopt |
| R7 | Input kept on resize; focus trap; Esc closes; focus returns to the row | Adopt |
| R8 | No stacked drawers: a sub-record replaces the content and has a Back button | Adopt |
| R9 | One calm place for procedural alerts, shown once | Adopt |
| R10 | Site page: tasks, documents, issues, notes and history as tabs, with the improved pipeline on top | Adopt |

### 2.8 Pipeline (§10)
Order, gates, calculations and completion rules stay. Only the presentation changes.

| # | Item | Decision |
|---|---|---|
| P1 | Stage nodes and gate markers (diamond) drawn differently | Adopt |
| P2 | Each state has an icon and a label, not colour alone: done, in progress, late, locked, N/A, planned | Adopt |
| P3 | The ring shows task progress only. Approval state is a separate icon. Lateness is a separate badge in working days. | Adopt |
| P4 | Tooltip, or tap on touch screens: planned and actual dates, baseline, delay, current holder, block reason | Adopt |
| P5 | Clicking a stage filters the task grid; the selected stage is marked | Adopt |
| P6 | Parallel tracks only where the workflow version defines them | Adopt |
| P7 | Compact density for lists and the project view, detailed for the site page; one component | Adopt |
| P8 | The project pipeline shows its denominator and the data timestamp | Adopt |
| P9 | Calm motion that respects reduced motion; RTL, mobile and dark mode | Adopt |
| P10 | No number the API does not supply | Adopt (rule) |

Build two variants on the same data: **A**, refined rings, and **B**, a flat segmented track. Compare them in screenshots before choosing (Q116; recommended: A).

### 2.9 My Work and Approvals (§11)
| # | Feature | Decision |
|---|---|---|
| W1 | Sections: to do now / late / waiting on others / returned to me | Adopt |
| W2 | Each card shows task, site, holder, due date and reason, and opens the drawer | Adopt |
| W3 | Quick action only when requirements are met and the user is permitted | Adopt |
| W4 | Group and sort by due date, site or stage; no computed priority | Adopt |
| W5 | Loading skeleton never shown as "empty"; "my tasks" counted apart from "waiting my review" and "waiting my approval" | Adopt |
| W6 | Approvals: list with a preview pane; filters kept between items | Adopt |
| W7 | Documents, missing items and return notes shown in the preview | Adopt |
| W8 | Bulk approve or reject under the existing rules; the result lists succeeded, failed and skipped items with reasons; note and step-up kept | Adopt |
| W9 | Group claim and "all members must approve" state visible | Adopt |
| W10 | Button locked while a request is in flight; counters refresh after the action | Adopt |

### 2.10 View forms (§12)
| # | Form | Where | Decision |
|---|---|---|---|
| L1 | Table/List | Everywhere | Adopt |
| L2 | Board (columns: stage or approval state) | Site Register, My Work, Approvals, registers | Adopt, drag = workflow action under DD6 |
| L3 | Calendar (due dates, SLA, PAC/FAC, DLP ends) | Site Register, Warehouse | Adopt, read-only |
| L4 | Timeline/Gantt (baseline vs actual) | Site page, project | Later |
| — | The functional view (CW/TE/O&M), the view form, and the stream filter are three separate controls | — | Adopt (rule) |
| — | A dashboard tile opens the matching filtered list; print and export stay readable without colour | — | Adopt |

### 2.11 Colour (§13)
Verdict: keep the current petrol. It is already in the calm petrol family. `#0F766E` would add nothing.
1. Primary buttons move from `--done` (green) to `--accent`. Green is reserved for "completed".
2. Add state tokens `--state-{done,progress,late,locked,na,planned}` (foreground, background, border), kept separate from the accent.
3. The accent is used for selection and the focus ring. Large tinted areas are removed.
4. An automated test checks WCAG AA contrast for every pair in both themes.
5. One token source, `apps/web/src/styles/tokens.css`. `design/tokens.css` is generated from it.

### 2.12 Type, icons and details (§14)
- **Cairo**
  - Served locally, weights 400/500/600/700.
  - Type scale 12/13/14/16/18/22/28.
  - Line height 1.5 for Arabic.
  - Tabular numbers in tables.
  - Codes, dates, e-mail addresses and numbers are isolated with `dir="ltr"`/`bdi` inside Arabic text.
- **Lucide**
  - 16 and 20 px, stroke 1.75.
  - `src/lib/icons.ts` maps each concept (site, register, warehouse, approval, document, holder, late) to one icon.
  - Icon-only buttons have an `aria-label` and a tooltip.
  - Decorative icons are `aria-hidden`.
- **Visual spec**
  - Spacing on a 4-px scale, radius 6/8/10, two shadow levels, motion 150/200 ms with reduced-motion support.
  - Every shared component has the states default, hover, focus, selected, disabled, loading and error.
- **Dependencies**: no new UI framework and no second icon set. Allowed additions:
  - `@tanstack/react-table`, already in the default stack;
  - `@dnd-kit/core`, for drag with keyboard support;
  - `cmdk`, only if the current palette cannot be extended.

### 2.13 Mobile and accessibility (§15)
Checked in every phase:
- RTL panel sides.
- No toolbar overflow.
- Filters move into a bottom sheet on phones.
- Wide tables become cards on phones.
- No action that needs hover.
- Touch targets of at least 44 px.
- A full keyboard path with visible focus; focus never hidden under sticky bars.
- Live regions announce success and errors.
- The phone keyboard never covers fields or actions.
- 200 % zoom works.
- Automated axe and contrast tests, plus one manual screen-reader pass.

### 2.14 States and performance (§16)
- **One shared component per state:**
  - loading skeleton, and background refresh;
  - empty, and no results;
  - no permission;
  - network or server error, with retry;
  - edit conflict;
  - partial bulk or upload result;
  - session expired: after re-login the route and filters come back, and unsaved form data is kept in memory only.
- **Data loading:**
  - Search debounce of 250 ms, with stale requests cancelled.
  - Incremental loading; counts come from the server.
  - Success is shown only after the server confirms. Optimistic updates apply to personal preferences only.
- **Settings layers:** system default › shared view › personal view › unsaved session. Reset goes back one layer.

### 2.15 Additional functional features (owner decision 2026-11-01: add all that keep the rules)
| # | Feature | Source | Needs | Phase |
|---|---|---|---|---|
| X1 | Notification inbox: everything for me in one place, mark read, snooze until a date | Linear | A+M (`notifications.read_at`, `snooze_until`) | 4b |
| X2 | Follow (watch) a site or record: get its change notifications without holding it | ClickUp / Linear | A+M `watches` | 4b |
| X3 | @mentions in comments, with a notification to the person named (only people who can see the record) | both | A | 4b |
| X4 | Time in each state: how long a task sat at entry / review / approve, per person and team | ClickUp | A (from the audit log) | 4b |
| X5 | Workload view: open and late tasks per holder, opens the existing reassign action (B12b) | ClickUp | A | 4b |
| X6 | "Blocked by" chain: why a task is locked and which gate, permit or task it waits for | Linear | A (gates exist) | 4b |
| X7 | Weekly status update per region or team: the lead writes a summary and sets on track / at risk / off track | Linear | A+M `status_updates` | 4b |
| X8 | Personal reminder on a task ("remind me Sunday") | ClickUp | A+M `reminders` | 8 |
| X9 | Email a saved view on a schedule (daily or weekly), limited to the recipient's own scope | ClickUp | A + job | 8 |
| X10 | Admin notification rules ("task late 3 days → alert the team lead"); notify only, never change state, holder or date | ClickUp Automations | A+M, settings | 8 |
| X11 | Site activity timeline in plain language (from the audit log, read-scoped) | both | A | 8 |
| X12 | Triage queue for new issues and uploads waiting for classification and assignment | Linear Triage | W (+A filter) | 8 |
| X13 | Personal checklist inside a task: helper notes only, never a condition for approval and never changes the task definition | ClickUp | A+M | 8 |

Excluded because they break the rules: free custom statuses, free task creation outside the admin's task definitions, guests and public sharing, automations that change state, holder or dates.

## 3. Data, contract and migrations
All changes are additive. No existing endpoint, table, grant or rule changes.
| Need | For | Contract | Migration |
|---|---|---|---|
| `user_prefs` (JSON per user: sidebar, favourites, density, drawer mode, columns) | N1-N5, G1-G5, R1 | `GET/PUT /me/prefs` | yes |
| `saved_views` (owner, scope personal/shared, screen, definition, version, pinned, default) | F6-F8, F12 | `/views` CRUD | yes, plus the `views.share` grant |
| Global search | F13 | `GET /search?q=`, filtered by permission and region | indexes |
| Multi-value filters, date presets, group counts, sort | F1-F5, F11, G3-G4 | Additive query parameters | no |
| List badges (attachments, comments, missing items) | G9 | Additive list fields | no |
| Export accepts `view` and filters | F11 | Additive | no |

## 4. Phases (one PR each; each covers EN/AR, light/dark, mobile, a11y and tests)
| Phase | Content | Contract/DB | Size |
|---|---|---|---|
| 0 | This plan; the `CLAUDE.md` amendment; baseline screenshots of today's screens | none | S |
| 1 | Design system: token merge, accent buttons, state tokens, type scale, icon map, shared state components, `PageHeader`/`Toolbar`, contrast test | none | M |
| 2 | Shell: sidebar groups, search, recent items, resize, icon mode, breadcrumb, mobile drawer, CW/TE/O&M shortcuts, local favourites | none | M |
| 3 | Tables and drawers: columns, density, sticky header, selection and bulk bar, URL filters and chips, quick filters, empty states, drawer resize/tabs/next-prev/preview; write-through field editing (web) | additive params | L |
| 4 | Saved views (personal and shared), server-side preferences and favourites, global search, AND/OR filters, export with view | `user_prefs`, `saved_views`, `/search` | L |
| 5 | Pipeline A/B (the owner picks one), My Work sections, Approvals list with preview and bulk | none | M |
| 6 | Board with drag-to-review/approve/return (DD6) and Calendar (read-only) | additive `via` field in action audit | M |
| 4b | Inbox, follow, @mentions, time in state, workload, blocked-by chain, weekly status updates (X1-X7) | additive API + tables | L |
| 7 | Timeline/Gantt; date dragging through the edit form | later | L |
| 8 | Reminders, scheduled view e-mails, notification rules, site activity timeline, triage queue, task checklists (X8-X13) | additive API + tables + jobs | L |

Phase 3 starts after the open work on `Site.tsx`/`TaskGrid.tsx`, because both touch the same files. That work is the O&M final view membership (migration 0030) and the web editing of write-through fields.

## 5. Verification
- **Vitest:** filter logic, view layering, hidden columns limited by permission, drag alternatives, unsaved-changes guards.
- **API tests (phase 4):** search and shared views are filtered by permission and region; a shared view never widens access.
- **Playwright:** EN/AR, light/dark, desktop/mobile, on these screens: Site Register, site page, My Work, Approvals, register drawer, one settings form. Includes axe checks, keyboard-only runs, and before/after screenshots.
- **Edge data:** long names, empty sites, N/A stages, cancelled or on-hold sites, a user limited to some regions.
- **Existing suites stay green:** 396 API tests, 232 or more web tests, and the e2e suite.

## 6. Previews before the full rollout
- Real screenshots from the code with synthetic data. Each pair shows the current and the proposed version at the same viewport.
- Screens covered:
  - Site Register with filters and a saved view;
  - site page with pipeline variants A and B;
  - My Work and Approvals;
  - a register drawer;
  - the sidebar, toolbar and Ctrl+K;
  - one settings form;
  - one phone view.
- Every screen is shown in AR and EN, light and dark.
- Generated concept images are never used as proof.

## 7. Must not change
- **Access:** server permissions and the region, module and field scope; no guests or public sharing; preferences never grant rights.
- **Workflow:** Entry → Review → Approve, with its skip and return rules; mandatory documents; step-up, reasons and audit.
- **Timing:** gates, SLA, working days and baseline.
- **Data:**
  - Each register stays the source of truth, edited only through write-through.
  - Template ID and version checks stay.
  - Records are soft-deleted or deactivated, never hard-deleted.
  - The Master-format export is unchanged.
- **Hosting:** internal only, with no CDN at runtime.
- **Visual actions never:**
  - reassign work;
  - pause the SLA;
  - change stage definitions or the progress calculation.

## 8. Open decisions (each has a default; work continues on the default)
- **Q115.** Local drafts of work data: no by default. Only view preferences are stored locally.
- **Q116.** Pipeline variant: A by default, confirmed after the previews.
- **Q117.** Who may create shared views: the System Admin and Team Leads, through the `views.share` grant, which can be delegated.
