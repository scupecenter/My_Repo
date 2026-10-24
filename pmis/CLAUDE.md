# GSDN PMIS — project rules for every agent

GSDN PMIS is a project management information system for the GSDN site-delivery
project (telecom sites across 7 Libyan regions). It replaces the Excel Site Master
as the system of record, with a 3-level approval workflow on every task.

All paths below are relative to `pmis/` unless marked as repository root. The dashboard in `dashboard/` is a separate product: do not modify it.

Read before any work:
1. `docs/reference/GSDN_PMIS_Blueprint_v1.1.html`: the functional blueprint (sections 03, 06, 14, 17, 21).
2. `build/GSDN_Rebuild_Decisions.md` (repository root): decisions D1–D88 that define the Master logic.
3. `GSDN_Site_Master.xlsx` (repository root): the Master structure (23 sheets, 187 columns). It is the source for field names and calculations.
4. `docs/spec/` (written by domain-analyst) and `contracts/openapi.yaml` (owned by tech-lead).

## Domain facts (do not change without an ADR)
- 10 milestones in this order: Site Release, PRE-CW Completion, CW Completion, Site RFI, TE Completion, On-Air, TE PAC, KPI Acceptance, HOTO, Final Closure.
- 9 phase gates between them. A gate date equals the previous milestone date. A Suspension→Resumption in Change Control shifts it.
- SLA counts working days. The weekend is Friday and Saturday (NETWORKDAYS.INTL code 7). Holidays come from a table.
- Delivery Scenario: New Build, Expansion, Hot Swap, Cold Swap, Relocation. Overall Status: Not Started, In Progress, On Hold, Completed, Cancelled.
- Regions: Tripoli, Middle, WM, Zawia, Benghazi, GM, Sebha.
- Roles: 6 main roles (Project Manager, RF & Design / Acquisition Team Lead, CW Team Lead, TE Team Lead, Inventory Supervisor, Project Support) and 9 sub-roles.
- Aljeel supervising engineers (AAT SE) only supervise. TE installation steps through On-Air are the TE vendor's (A&T Global) responsibility.

## Workflow rules (agreed with the product owner)
- Login uses the company Microsoft 365 account (Entra ID SSO). Each user is linked to a 4-digit employee ID.
- Every task goes through Entry → Review → Approve. The number of levels can be configured per stage.
- The Responsibility Matrix (editable in the UI) decides who holds each level, per stage. If one person holds two consecutive levels, the second level is skipped automatically, and the skip is logged.
- The unit of approval is the whole task: dates plus documents.
- A rejection goes back one level (approver → reviewer → entry) and must carry a note. Every task has a comment thread.
- Batch uploads can be approved row by row or all at once.
- Visibility defaults to everything. It can be limited per user to one or more of the 7 regions and to selected modules.
- Data entry works three ways: manual entry, upload of the Master as an approved template, or upload of other approved templates. Every upload goes through batch → review → approve.
- **Approved templates only.** The system issues each template with an ID and version embedded in the file (hidden sheet `_tpl` containing `template_id` and `version`). A user downloads the template from beside the task or from the Templates page, fills it, and uploads that same template. Uploads without a valid embedded ID and version are rejected. Each rejection is written to the System Log.
- Registers are separate modules, each with its own menu: Procurement (PR/PO/WO), Contractors, GECOL power, HLC fiber, Permits & HSE, Warehouse, Quality, Issue Log (several issues per site), Risk Register, Change Control, Readiness & Handover, As-Built, and Meetings.
- The Audit Log records every user action with before and after values. It is append-only and nobody can edit it. The System/Error Log is kept separately.
- The UI is in English by default, with Arabic (RTL) available as an instant switch. It has light and dark themes and uses the Cairo font, with ERPNext (frappe-ui) colors.

## Decisions agreed with the product owner (2026-10-24)
Stack and platform
- NestJS with PostgreSQL. Hosting is on an internal server, never cloud.
- Login is Microsoft 365 (Entra ID) for Aljeel employees only. Vendors, contractors, GECOL, HLC and suppliers never log in. Staff enter their data and upload their documents for them, and every task still shows the external party responsible for it (for example A&T Global) so delays are attributed correctly.
- Two-factor authentication: enforced through Entra Conditional Access. The API checks the token's `amr` claim for `mfa` behind an admin toggle (off until IT enables MFA). Step-up re-authentication is required for final approval, role/matrix/group changes, delegation, deletes and admin overrides. One break-glass local admin account exists, with TOTP, usable from the internal network only, and every use is logged and emailed.
- Notifications go in-app and by email.

Roles, groups and administration
- Users & Roles screen. A user signs in with M365 the first time and enters a 4-digit employee ID. The account stays "Pending assignment" and sees nothing until an admin assigns its main role, sub-roles, team (CW/TE/both), permission level (view/entry/review/approve/admin), regions, visible modules and status.
- Groups: named sets of users (for example "System Admins", "CW Reviewers Tripoli"). A matrix cell (entry/review/approve) accepts users, roles, groups or a mix. A task assigned to a group shows in every member's inbox; the first member to act claims it. Default rule is any one member; it can be set per cell to "all members must approve".
- System Admin is a group (one or more people) with full control. An admin can delegate full or partial rights, either time-bound or until revoked. A delegate cannot re-delegate or remove an admin, and at least one active admin must always exist. Every action by a delegate is logged as "X on behalf of System Admin".
- Admin overrides are all allowed: unlock a stage or task, skip or mark N/A, accept without document or workflow, reopen an approved task, edit any date, and change the rules (documents, SLA, templates, gates, number of approval levels, QC photo rules) from settings screens without code. Each override requires a reason and step-up MFA, is written to the audit log with before/after values, shows an "Admin override" badge, is reversible, and is excluded from or flagged in KPIs.
- The default sub-role mapping (RF Engineer, MW Engineer, Acquisition Team under RF & Design / Acquisition TL; Power Engineer, GECOL Power Team, HLC Fiber Team, Site Engineers (CW) under CW TL; Site Engineers (TE), HOTO Engineer under TE TL; Project Procurement Team under Project Support) is seed data, editable in the UI.
- Default approval is 3 levels for every stage, configurable per stage.

Business rules
- SLA for D-1 (TE Access) is measured from TE Installation Readiness (the Site RFI date), not from Site Release.
- Expansion scenario: Site Release keeps TSSR and LLD only. PRE-CW and CW apply only when adaption work exists. Power-On and TX test apply only if new power or fiber is needed. TE through Final Closure all apply. Conditions are decided by the Master scope flags (AA:AF).
- Cluster: use the Master rule. Each site's optimization gate opens from its own TE PAC. KPI Acceptance is recorded once per cluster and applied to all its sites. The site page shows cluster progress ("6 of 9 sites at TE PAC") as information only.
- Project Status stays as it is, ending at HOTO. Final Closure gets a separate KPI: sites closed, % closed, and pending CW FAC / TE FAC with their age.
- Site RFI has no document. Its date field unlocks when its conditions are met, is pre-filled with the latest condition date, can be edited, and then goes through review and approval.
- PMIS-only features: delay attribution and project health index are in version 1. HSE incidents and clock-in are deferred to the mobile app. Team capacity and certificates are dropped.

Documents and QC
- **Acceptance documents and QC photos are different things.** Acceptance documents (TE PAC, SSV, CW FAC, TE FAC, HOTO and so on) are the official forms, filled, signed, scanned and uploaded. They close their task through the 3-level workflow. QC photos are photos of a fixed defect. Wherever a QC check or snag exists, the site engineer uploads fresh photos of the fix, then the reviewer reviews and the approver approves, which closes that snag.
- A preliminary acceptance (for example CW PAC) cannot be approved while any snag on the site is open. Its lock reason shows the count.
- QC photo requirements are configured per snag type: minimum count, required shot types, formats (JPG/PNG/HEIC), and maximum size. Photos taken before the snag was raised are rejected using the EXIF date. A missing EXIF date is accepted with an "unknown capture date" flag for the reviewer.
- **Document Library (admin).** Every document is defined in data, never in code: name EN/AR, kind (scanned document, photo, email, report, approved Excel template), placement (one or more tasks, QC, or a register), mandatory or conditional (with the rule), formats and size, minimum/maximum files, photo rules, expiry date, and an optional blank form to download. On publish, the admin chooses whether it applies to new tasks only or also to open tasks. Approved tasks never change. Documents are deactivated, never deleted.
- Seed content of the library: Stage 1 has A1 SAR (each candidate), A2 TSSR, A3 owner contract (or contract with the tower owner for an existing third-party tower) plus a civil aviation permit when near an airport, and A4 LLD. Stage 2 has B1 PR email (outsourced only), B2 PO/WO email or internal work order, B3 CW access permission, B4 STA/ST report (when tower analysis is required), B6 layout, and B7 approval email and CW DN. Stage 3 has B9 MOS proof; B11 has no document, and defects become QC snags. Stages 4 to 10 are seeded from blueprint v1.0 and the Master, then reviewed by the product owner in the library screen. The default for every document is PDF or image, 20 MB, multiple files allowed.
- Upload UI uses one named slot per required document, showing status (missing, uploaded, in review, approved, rejected with reason). Files can be dragged onto a slot, clicked, or taken with the phone camera. For a multi-file upload, the type is suggested from the file name and confirmed in a dropdown. Conditional slots appear only when they apply. "Submit for review" stays disabled until every mandatory slot is filled.
- Download is available from the task, from the site Documents tab (filterable), and in bulk as a zip (per site, per stage, or per document type across sites). Superseded versions are kept and downloadable. Files are named automatically `SITE_TASK_DOC_APPROVEDDATE.ext`. Every download is written to the audit log.

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
- The pipeline component reuses the style and motion of the dashboard pipeline in `dashboard/GSDN_Dashboard.html` (CSS "pipeline (signature)" and `function pipeline`): progress rings on nodes, a gradient fill track, and hover lift. It replaces the earlier site-page pipeline concept.

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
