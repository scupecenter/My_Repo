# GSDN PMIS — project rules for every agent

GSDN PMIS is a project management information system for the GSDN site-delivery
project (telecom sites across 7 Libyan regions). It replaces the Excel Site Master
as the system of record, with a 3-level approval workflow on every task.

All paths below are relative to `pmis/` unless marked as repository root. The previous standalone dashboard is kept read-only in `docs/reference/legacy-dashboard/` as the reference for dashboard KPIs (P3) and the pipeline style: do not modify it.

Read before any work:
1. `docs/reference/GSDN_PMIS_Blueprint_v1.1.html`: the functional blueprint (sections 03, 06, 14, 17, 21).
2. `docs/reference/GSDN_Rebuild_Decisions.md`: decisions D1–D88 that define the Master logic.
3. `GSDN_Site_Master.xlsx` (repository root): the Master structure (23 sheets, 187 columns). It is the source for field names and calculations.
4. `docs/spec/` (written by domain-analyst) and `contracts/openapi.yaml` (owned by tech-lead).

## Domain facts (do not change without an ADR)
- Default workflow (seed version 1; milestones and gates are admin-configurable, see Configuration): 10 milestones in this order: Site Release, PRE-CW Completion, CW Completion, Site RFI, TE Completion, On-Air, TE PAC, KPI Acceptance, HOTO, Final Closure.
- 9 phase gates between them. A gate date equals the previous milestone date. A Suspension→Resumption in Change Control shifts it.
- SLA counts working days. The weekend is Friday and Saturday (NETWORKDAYS.INTL code 7). Holidays come from a table.
- **Holidays are managed in Settings → Work calendar (decision B12).** The System Admin, or a delegate, can add, edit, delete and import holidays (date, name EN/AR, kind national/religious, "tentative" flag) and the weekend days, without code. Seed: `db/seed/holidays-2026-2027.csv`; religious dates are tentative until the admin confirms them on the official announcement, and the screen reminds the admin of tentative dates 14 days ahead. Every change is audited with before/after values and a reason. A change recalculates SLA due dates of open tasks; closed tasks keep their computed values. A banner shows while the table for the coming year is empty.
- Delivery Scenario: New Build, Expansion, Hot Swap, Cold Swap, Relocation. Overall Status: Not Started, In Progress, On Hold, Completed, Cancelled.
- Regions: Tripoli, Middle, WM, Zawia, Benghazi, GM, Sebha.
- Roles: 6 main roles (Project Manager, RF & Design / Acquisition Team Lead, CW Team Lead, TE Team Lead, Inventory Supervisor, Project Support) and 9 sub-roles.
- Aljeel supervising engineers (AAT SE) only supervise. TE installation steps through On-Air are the TE vendor's (A&T Global) responsibility.

## Workflow rules (agreed with the product owner)
- Login uses the company Microsoft 365 account (Entra ID SSO). Each user is linked to a 4-digit employee ID.
- **One sign-in box, M365 does the sign-in (owner decision 2026-10-25).** The login screen has one field: the employee types their email, employee ID or registered phone. The PMIS looks it up in the staff registry, keeps the match server-side, and sends the browser to Microsoft 365; Microsoft performs the actual sign-in (password, MFA, Conditional Access). For privacy, the registry email is never put in the redirect: Microsoft pre-fills the account only when the employee typed their email; with an ID or phone they pick or type their account on the Microsoft page, and the PMIS checks on return that it is the same person. The PMIS never stores passwords. To avoid revealing who is registered, the screen behaves the same whether or not a match is found (no match = Microsoft sign-in without a hint). After the callback, the token's account must match the registry row that was looked up; otherwise the normal first-sign-in link rules apply.
- **Local sign-in (employee ID or phone + PMIS password) stays deferred** to a later phase. The staff registry and its data are kept and used now, so that later phase needs no rework. The proposed design is in ADR 0002 §10.
- Every task goes through Entry → Review → Approve. The number of levels can be configured per stage.
- Changing the number of levels (decision B7): the new level count applies to new tasks and to open tasks not yet submitted. A task snapshots its level path at first submission and finishes on it, including after a rejection sends it back to entry.
- The Responsibility Matrix (editable in the UI) decides who holds each level, per stage. If one person holds two consecutive levels, the second level is skipped automatically, and the skip is logged.
- Matrix rows for registers and Dismantle (decision B11): besides the stage rows, the matrix has one row per register (Procurement PR/PO/WO, GECOL, HLC, Permits & HSE, Warehouse, Quality, Issue, Risk, Change Control, Readiness & Handover, As-Built, Meetings, Contractors) and one row for Dismantle. Each row has its own Entry/Review/Approve holders and its own number of levels (1 to 3), set by the admin.
- The unit of approval is the whole task: dates plus documents.
- A rejection goes back one level (approver → reviewer → entry) and must carry a note. Every task has a comment thread.
- Rejection after an auto-skip (decision B6): when a level was skipped because the same person held it, a rejection returns to the person who actually acted on the previous level. That person sees the rejection note, corrects, and resubmits; the skip is applied again on resubmission and logged again.
- Batch uploads can be approved row by row or all at once.
- **Staff absence and reassignment (decision B12b).** Nothing moves automatically when someone is absent. The assigned person stays on the task until their Team Lead (or anyone with the `reassign` grant for that module and region, or a System Admin) decides. The lead has three choices per task, per site, or for all of the person's open tasks:
  1. keep the person on it;
  2. reassign it to another eligible person (a task-level holder change; the Responsibility Matrix itself is not changed);
  3. act on it themselves through the system, logged as "lead on behalf of the assignee".
  A reassignment needs a short reason and is audited. It keeps all entered data, documents and comments. **It does not reset or pause anything:** the SLA keeps its original start date and its SLA version, and stage progress is unchanged. If the lead takes over a level and also holds the next one, the normal skip rule and the self-approval rule (B5) apply.
  Absence records are optional and informational: an employee can record annual leave in advance, and the lead or an admin records sick or emergency leave. An absent person's tasks show an "absent" badge, and the lead is alerted. Separately, a task idle for N working days (default 2, a setting) alerts the lead even when no absence was recorded.
- Visibility defaults to everything. It can be limited per user to one or more of the 7 regions and to selected modules.
- Data entry works three ways: manual entry, upload of the Master as an approved template, or upload of other approved templates. Every upload goes through batch → review → approve.
- **Approved templates only.** The system issues each template with an ID and version embedded in the file (hidden sheet `_tpl` containing `template_id` and `version`). A user downloads the template from beside the task or from the Templates page, fills it, and uploads that same template. Uploads without a valid embedded ID and version are rejected. Each rejection is written to the System Log.
- Registers are separate modules, each with its own menu: Procurement (PR/PO/WO), Contractors, GECOL power, HLC fiber, Permits & HSE, Warehouse, Quality, Issue Log (several issues per site), Risk Register, Change Control, Readiness & Handover, As-Built, and Meetings.
- The Audit Log records every user action with before and after values. It is append-only and nobody can edit it. The System/Error Log is kept separately.
- Audit Log readers (decision B4): System Admins and the Project Manager see all of it. Each Team Lead sees the entries for their own modules and regions only. Anyone else gets it only through the `view_audit` grant in the permission grid, scoped like any other grant (B3). Every read of the Audit Log is itself audited.
- The UI is in English by default, with Arabic (RTL) available as an instant switch. It has light and dark themes and uses the Cairo font, with ERPNext (frappe-ui) colors.

## Decisions agreed with the product owner (2026-10-24)
Stack and platform
- NestJS with PostgreSQL. Hosting is on an internal server, never cloud.
- Login is Microsoft 365 (Entra ID) for Aljeel employees only. Vendors, contractors, GECOL, HLC and suppliers never log in. Staff enter their data and upload their documents for them, and every task still shows the external party responsible for it (for example A&T Global) so delays are attributed correctly.
- Two-factor authentication: enforced through Entra Conditional Access. The API checks the token's `amr` claim for `mfa` behind an admin toggle (off until IT enables MFA). Step-up re-authentication is required for final approval, role/matrix/group changes, delegation, deletes and admin overrides. One break-glass local admin account exists, with TOTP, usable from the internal network only, and every use is logged and emailed. **Per-user MFA exemption (owner request 2026-10-25):** a System Admin (or a delegate granted it) can remove the PMIS MFA requirement for any registered user, until revoked or until an end date. The exempted user then signs in and passes step-up without `amr = mfa`. It needs a reason and the acting admin's own step-up MFA, nobody can exempt themselves, it is audited with before/after values, the user is emailed, and the Users & Roles screen shows an "MFA exempt" badge. It removes only the PMIS check; MFA enforced by Entra Conditional Access is changed by IT in Entra, not in the PMIS.
- Notifications go in-app and by email.

Roles, groups and administration
- **Staff registry (owner request 2026-10-25, settles B13).** A registry of Aljeel staff holds employee ID (4 digits), name EN/AR, phone, email, position, team and region. It is the list checked at first sign-in: the entered employee ID must exist in the registry and not already be linked to another account. A draft with synthetic rows is seeded and replaced with real data later. Wherever a person is shown as holding a task (task grid, drawer, Approvals, My Work, matrix), their employee ID is shown beside the name; hovering or focusing it opens a small card with the registry data. Phone and email in the card follow visibility settings kept in the registry screen: by default every signed-in Aljeel employee sees them; the admin (or a delegate) can choose which roles, groups or persons see or do not see each field, and can hide a field for a single employee. Maintained by the System Admin or a delegate, imported from an approved template, audited, never hard-deleted. Owned by the `people-registry` agent.
- Users & Roles screen. A user signs in with M365 the first time and enters a 4-digit employee ID. The account stays "Pending assignment" and sees nothing until an admin assigns its main role, sub-roles, team (CW/TE/both), permission level (view/entry/review/approve/admin), regions, visible modules and status.
- **Role assignment is many-to-many and works in both directions.** By role: pick a role (main or sub-role), then multi-select any number of registered employees by name (searchable list of everyone who signed in with M365), for example 12 Site Engineers in one action. By person: one employee can hold several main roles and several sub-roles at once. Each assignment row carries its own permission level, regions, modules and validity dates, so the same person can be an approver in one role and a data-entry user in another. Bulk actions include assign, remove, copy the assignments of one person to another, and an import from an approved Excel template. Every change is audited.
- Groups: named sets of users (for example "System Admins", "CW Reviewers Tripoli"). A matrix cell (entry/review/approve) accepts users, roles, groups or a mix. A task assigned to a group shows in every member's inbox; the first member to act claims it. Default rule is any one member; it can be set per cell to "all members must approve". (Decision B10) Under "all members must approve", one member's rejection rejects the task and sends it back with that note. A task whose level has no eligible holder (for example an expired assignment with no replacement) goes to the System Admins' inbox with an immediate alert and shows on the dashboard as "no holder"; it is never skipped automatically.
- System Admin is a group (one or more people) with full control. An admin can delegate full or partial rights, either time-bound or until revoked. A delegate cannot re-delegate or remove an admin, and at least one active admin must always exist. Every action by a delegate is logged as "X on behalf of System Admin".
- Admin overrides are all allowed: unlock a stage or task, skip or mark N/A, accept without document or workflow, reopen an approved task, edit any date, and change the rules (documents, SLA, templates, gates, number of approval levels, QC photo rules) from settings screens without code. Each override requires a reason and step-up MFA, is written to the audit log with before/after values, shows an "Admin override" badge, is reversible, and is excluded from or flagged in KPIs.
- The default sub-role mapping (RF Engineer, MW Engineer, Acquisition Team under RF & Design / Acquisition TL; Power Engineer, GECOL Power Team, HLC Fiber Team, Site Engineers (CW) under CW TL; Site Engineers (TE), HOTO Engineer under TE TL; Project Procurement Team under Project Support) is seed data, editable in the UI.
- Default approval is 3 levels for every stage, configurable per stage.

Configuration owned by the System Admin (or a delegate)
- **Every create, rename, edit, deactivate or delete of configuration is a System Admin action**, or that of a person the admin delegated it to. Examples are task definitions, fields, lists, documents, templates, SLA, weights, warehouse items and roles. The Roles & Responsibilities settings decide who may do what. Each change is audited with before/after values, needs a reason, and is versioned. Nothing referenced by data is hard-deleted; it is deactivated.
- **Delegation covers anything, to anyone.** The System Admin can delegate any action in the permission grid (including configuration: warehouse items, task definitions, custom fields, lists, documents, templates, SLA, weights, workflow versions, roles and permission profiles) to any person, any role or any group, for all regions or selected ones, time-bound or until revoked. Delegation is configured in the Roles & Responsibilities settings and is simply a permission grant. The database checks every configuration write against the actor's effective permission (`app_has_permission`), not against a fixed admin flag, so a delegated person can do exactly what was delegated and nothing more. Safeguards stay: nobody can grant rights to themselves, a delegate cannot re-delegate unless the admin explicitly allows it for that delegation, a delegate cannot remove an admin, there is always at least one active admin, and every delegated action is logged as "X on behalf of System Admin".
- **Warehouse item master data** (item names, units, categories, design-based need rules) is edited by the System Admin, and by the Inventory Supervisor only through delegation from the admin.
- **Task definitions are editable.** The admin can add new tasks or sub-steps inside any existing stage (for example a new step in PRE-CW or CW, or in TE), and can rename, reorder, change predecessors, or deactivate tasks. A new task gets its SLA rule, Document Library slots, template and matrix cells like any other task. Milestones and phase gates are also configurable (see the next rule). Each task has a flag "counts toward the stage milestone" (default yes), so the admin decides whether a new task blocks the milestone. (Decision B8) When a new counting task is added, the screen warns that the milestone date may move later than the Master; during the parallel-run month the admin must confirm explicitly, and the comparison report tags the resulting date difference "caused by an added task" so it is not counted as an import error. Changes apply to new site tasks. For open sites the admin chooses whether to add the new task to them.
- **Milestones and phase gates are configurable by the admin (decision 2026-10-25, replaces "fixed").**
  - **Light changes, applied immediately:**
    - rename (EN/AR display names)
    - custom fields on milestones and gates
    - the gate conditions (which tasks, permits or dates a gate waits for)
    - the gate SLA
    - whether a milestone counts in Project Status
  - **Structural changes** (add, remove or reorder a milestone or gate, or move tasks between stages) are published as a new version of the workflow definition, with a reason and step-up MFA.
    - New sites use the new version. For open sites the admin chooses, per site or in bulk, whether to migrate them; the migration preview shows which tasks move and which dates change.
    - Sites never silently change version.
  - Every milestone and gate keeps a stable internal code, so renames never break history, KPIs or reports. Each one also carries its Master export column.
  - The screen warns when a change affects the Master-format export or the parallel-run comparison. During the parallel-run month the warning requires an explicit confirmation.
  - Project Status and the dashboard read the active workflow version per site.
  - **Freeze during pilot and parallel run (decision B9):** structural changes are blocked from the pilot start to the end of the parallel-run month. Only a System Admin can lift the freeze, with a written reason and step-up MFA, and the lift is audited. Light changes, and new tasks inside an existing stage (B8), stay allowed.
- **Roles are fully admin-defined.** The 6 main roles and 9 sub-roles are seed data only. The admin can create a new role with:
  - a name (EN/AR) and a description of its duties
  - a parent role if it is a sub-role
  - a default permission profile
  - default regions and modules
  - whether it may hold matrix levels (entry/review/approve)

  Example: a **Management** role with "view the dashboard and progress reports", read-only on all modules and all regions, and no entry or approval. Roles can be renamed or deactivated (never deleted while assigned). Every change is audited.
- **Custom fields (like adding a column to the Master).** The admin can add fields to any register (Procurement PR/PO/WO, GECOL power, HLC fiber, RF survey and design, Acquisition, Permits, Warehouse, Quality, Issue, Risk, Change Control, Readiness & Handover, As-Built, Meetings), to sites and to tasks. Each field has: label EN/AR, type (text, number, date, list, multi-list, yes/no, user, external party, file), required or optional, validation (min/max, pattern), list values (themselves editable), default, order and section, which roles can see and which can edit it, whether it appears in templates, exports and the Master-format export (with its column), and whether it is shown in lists and filters. Fields are versioned and deactivated, never deleted, so their history is kept. Templates regenerate with a new version when fields change, and old template versions are rejected on upload with a clear message.

Permissions (part of Roles & Responsibilities settings)
- Beyond the matrix (entry/review/approve), each role or assignment has a **permission grid per module and screen**: view, create, edit, delete, approve, export, import, download documents, see the audit log, and administer. Optional **field-level** rules hide or make read-only specific fields, including custom fields. Navigation shows only what the person may use. Permission sets can be saved as named profiles and applied to many assignments. Effective permission (decision B3) = union of the person's active assignments, each assignment limited to its own regions and modules. Scopes never cross: a CW role in Tripoli plus a reviewer group in Zawia shows CW in Tripoli and the review work in Zawia, not CW in Zawia. All of this is configured in the Roles & Responsibilities settings and audited.

Business rules
- SLA for D-1 (TE Access) is measured from TE Installation Readiness (the Site RFI date), not from Site Release.
- Expansion scenario: Site Release keeps TSSR and LLD only. PRE-CW and CW apply only when adaption work exists. Power-On and TX test apply only if new power or fiber is needed. TE through Final Closure all apply. Conditions are decided by the Master scope flags (AA:AF).
- Cluster: use the Master rule. Each site's optimization gate opens from its own TE PAC. KPI Acceptance is recorded once per cluster and applied to all its sites. The site page shows cluster progress ("6 of 9 sites at TE PAC") as information only.
- Project Status stays as it is, ending at HOTO. Final Closure gets a separate KPI: sites closed, % closed, and pending CW FAC / TE FAC with their age.
- Site RFI has no document. Its date field unlocks when its conditions are met, is pre-filled with the latest condition date, can be edited, and then goes through review and approval.
- **SLA is fully editable by the admin, without code.** Each task has an SLA rule with a minimum and a maximum in working days (min = target/green, max = limit; above max = late), the start event it is measured from, and the calendar (weekend days and the holidays table). Optional overrides by delivery scenario or region are allowed. Rules are versioned with an effective date, a reason, and the person who changed them, and every change is audited. A task keeps the SLA version that was in force when it opened, so changing an SLA never rewrites past KPIs. When publishing a change, the admin can choose to apply it to tasks that are open now.
- **Project Status weights are editable by the admin, without code.** This covers the 8 activity weights (default 12/8/5/25/20/12/13/5), the weights of the 45 items within each activity, and each item's unit and measure. It also covers the other weighted formulas, the health index and delay attribution. The screen validates that weights sum to 100% at each level before publishing. Weight sets are versioned with an effective date, a reason and the person who changed them, and every change is audited. Current progress is recalculated with the active set. Saved weekly snapshots keep the values computed at the time, and a report can be re-run with an older weight set for comparison.
- PMIS-only features: delay attribution and project health index are in version 1. HSE incidents and clock-in are deferred to the mobile app. Team capacity and certificates are dropped.

Documents and QC
- **Acceptance documents and QC photos are different things.** Acceptance documents (TE PAC, SSV, CW FAC, TE FAC, HOTO and so on) are the official forms, filled, signed, scanned and uploaded. They close their task through the 3-level workflow. QC photos are photos of a fixed defect. Wherever a QC check or snag exists, the site engineer uploads fresh photos of the fix, then the reviewer reviews and the approver approves, which closes that snag.
- A preliminary acceptance (for example CW PAC) cannot be approved while any snag on the site is open. Its lock reason shows the count.
- QC photo requirements are configured per snag type: minimum count, required shot types, formats (JPG/PNG/HEIC), and maximum size. Photos taken before the snag was raised are rejected using the EXIF date. A missing EXIF date is accepted with an "unknown capture date" flag for the reviewer.
- **Document Library (admin).** Every document is defined in data, never in code: name EN/AR, kind (scanned document, photo, email, report, approved Excel template), placement (one or more tasks, QC, or a register), mandatory or conditional (with the rule), formats and size, minimum/maximum files, photo rules, expiry date, and an optional blank form to download. On publish, the admin chooses whether it applies to new tasks only or also to open tasks. Approved tasks never change. Documents are deactivated, never deleted.
- Seed content of the library: Stage 1 has A1 SAR (each candidate), A2 TSSR, A3 owner contract (or contract with the tower owner for an existing third-party tower) plus a civil aviation permit when near an airport, and A4 LLD. Stage 2 has B1 PR email (outsourced only), B2 PO/WO email or internal work order, B3 CW access permission, B4 STA/ST report (when tower analysis is required), B6 layout, and B7 approval email and CW DN. Stage 3 has B9 MOS proof; B11 has no document, and defects become QC snags. Stages 4 to 10 are seeded from blueprint v1.0 and the Master, then reviewed by the product owner in the library screen. The default for every document is PDF or image, 20 MB, multiple files allowed.
- Upload UI uses one named slot per required document, showing status (missing, uploaded, in review, approved, rejected with reason). Files can be dragged onto a slot, clicked, or taken with the phone camera. For a multi-file upload, the type is suggested from the file name and confirmed in a dropdown. Conditional slots appear only when they apply. "Submit for review" stays disabled until every mandatory slot is filled.
- Download is available from the task, from the site Documents tab (filterable), and in bulk as a zip (per site, per stage, or per document type across sites). Superseded versions are kept and downloadable. Files are named automatically `SITE_TASK_DOC_APPROVEDDATE.ext`. Every download is written to the audit log.

Generated documents (forms issued by the system)
- **Default approver (decision B2):** the stage's main role approves (for example CW Team Lead for CW stages, TE Team Lead for TE stages), and the Project Manager approves Final Closure. This is seed data and is editable in Roles & Responsibilities.
- **CW forms are issued by the system**: CW DN (material delivery to the contractor or site), CW RN (return note), CW PAC, CW FAC and the Snag list. Each is a Document Library entry of kind "generated form" with:
  - a form template the admin can edit. The owner's approved CW forms are HTML (`design/forms/source/`), so templates are HTML with placeholders and repeating blocks, rendered to PDF by headless Chromium on the internal server. The admin can upload a new template version; each generated PDF records the template version it used;
  - data bindings (site, contractor, dates, signatories from the matrix, warehouse lines with quantities and serials, snag list);
  - a numbering sequence (for example `DN-CW-TR-2026-0001`, configurable);
  - a QR code that links back to the record.
- **Flow**:
  1. The responsible person prepares the record. For DN/RN this is the warehouse movement lines; for PAC/FAC it is the site data and snags.
  2. The system generates the numbered PDF.
  3. The PDF is printed and signed on paper.
  4. The signed scan is uploaded into the same slot.
  5. The upload goes through the 3-level approval.
- **Item tables come from the system, not from the form.** The DN and RN line tables are built from the warehouse movement lines (item master: description, UOM; quantities approved, dispatched or returned; serials when tracked). Only items with a quantity are printed, plus a configurable number of blank rows. The fixed 28-item lists in the source forms become seed data for the CW item master. The PAC "Accepted Item List (BoQ)" is computed from the net quantities on site (DN minus RN). The PAC snag list comes from the site's QC snags with their closure status. FAC references its PAC automatically.
- **Pre-filled vs signed by hand.** The system fills every data field: ref no., dates, site, region (checked), contractor, PO/WO, warehouse, quantities, snags, and the names and positions of signatories from the Responsibility Matrix. Signatures and stamps stay blank for wet signature, and the signed scan is uploaded back into the same slot.
- **Warehouse link**: an approved DN posts the stock issue to the site, and an approved RN posts the return. Until approval, the quantities show as "pending issue" or "pending return", and stock is reserved so it cannot be issued twice.
- **Guards**:
  - CW PAC cannot be generated while any snag on the site is open.
  - Numbers are never reused or deleted. A wrong form is voided with a reason and reissued with a new number.
  - Every generation, void and download is audited.
- **TE forms are deferred.** Each TE document will be classified in the Document Library as one of: issued by Aljeel (generated by the system), issued by the vendor (uploaded only, with its metadata fields), or jointly signed (generated by the system, signed by both parties). The classification is agreed with the owner later and needs no code change.

Defects Liability Period (DLP)
- Defaults: CW 3 months, TE 12 months, counted from the PAC date. Each is a System Admin setting (`dlp.months.cw`, `dlp.months.te`), versioned; a PAC keeps the value in force when it was issued.

Self-approval (decision B5)
- If one person holds every level of a task, their submission becomes the final approval. It needs step-up MFA, is flagged "self-approval" in KPIs and the audit log, and the matrix screen shows the case in advance.

Mobile app (later, design for it now)
- A site engineer sees only the tasks assigned to them. The in-app camera stamps every photo, visibly and in metadata, with site ID, name, address, registered coordinates, device GPS, date/time, engineer, and task.
- The geofence check flags a photo taken more than 300 m (configurable) from the site. Proof tasks (MOS, QC) accept the in-app camera only. Capture works offline and syncs later with the original timestamp.

Non-functional requirements
| Item | Value |
|---|---|
| Max data loss (RPO) | 15 minutes (WAL archiving every 15 min plus a nightly full backup) |
| Max downtime (RTO) | 4 hours in working hours, with a standby server and a restore drill every quarter |
| Backup retention | 14 daily, 8 weekly, 12 monthly, with one copy in another building |
| Project data and documents | Life of the project plus 10 years, read-only archive after closure (ASSUMPTION: confirm against the contract and Aljeel security policy) |
| Audit log | 10 years, never deleted, append-only enforced in the database |
| System/error log | 12 months, then purged automatically |
| Performance | Pages under 2 s with 1000 sites and 100 concurrent users |
| Security | TLS on the internal network; encrypted backups |

Brand and UI
- Colors and styling follow ERPNext. Tokens are taken from the official frappe-ui design tokens (`frappe-ui/tailwind/tokens`, MIT, version 1.0.2), never from memory. We take the tokens and layout patterns, not the Vue components, the ERPNext logo or the ERPNext name. The font is Cairo. All tokens live in one file so a later Aljeel brand changes nothing in the screens.
- The pipeline component reuses the style and motion of the dashboard pipeline in `docs/reference/legacy-dashboard/GSDN_Dashboard.html` (CSS "pipeline (signature)" and `function pipeline`): progress rings on nodes, a gradient fill track, and hover lift. It replaces the earlier site-page pipeline concept.

Rollout
- A pilot on one region (Tripoli) runs for 2 weeks. Then the system and the Master run in parallel for 1 month: the PMIS exports a Master-format file and it is compared automatically with the live Master. The Master is retired after one month without material differences.
- Training is per role: short Arabic videos, an in-app guide on first use, one live session per role group, and a Project Support champion.
- Acceptance criteria: critical-path E2E tests pass, the real Master import matches 100% of milestone dates, no open critical bugs, and the performance targets are met.
- Real data is uploaded through the system after it is complete.

## Still open
- The documents for stages 4 to 10: seeded, to be reviewed in the Document Library.
- Real names per role: entered after go-live.
- The final Aljeel brand.

## Default stack (change only through an ADR by tech-lead)
- Web: React 18, TypeScript, Vite, Tailwind with Radix/shadcn, TanStack Query and Table, react-i18next, ECharts.
- API: NestJS (TypeScript) with a PostgreSQL 16 database through Prisma. Background jobs run on BullMQ with Redis. Files go to S3-compatible storage (MinIO on-prem).
- Auth: MSAL / Entra ID OIDC. Server-side RBAC plus a row-level region filter.
- Tests: Vitest, Supertest, and Playwright.
- Deployment: Docker Compose on the internal server.

## Working agreement between agents
- **Contract first.** No endpoint is built before it exists in `contracts/openapi.yaml`. The web app uses MSW mocks generated from the contract until the API is ready.
- **Own your folders.** Each agent writes only inside its own folders (see `ORCHESTRATION.md`). Changes needed elsewhere go as a request to tech-lead.
- **Small PRs** to `develop`. Each PR includes tests and a short note covering what changed, how it was tested, and any open questions.
- Never invent business rules. If the spec is silent, add the question to `docs/spec/open-questions.md` and use a configurable default.
- Use only synthetic data (fictional names) until the product owner releases real data. Never commit secrets.
- **Keep `CHANGELOG.md` current.** Every PR that changes a decision, the spec, the schema, the contract, the design or the forms adds a dated entry at the top under the right heading (قرارات, إضافة, تعديل, أمان, مفتوح).
