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
- The UI is in English by default, with Arabic (RTL) available as an instant switch. It has light and dark themes and uses the Cairo font.

## Open decisions (blueprint section 21). Do not implement as final; keep them configurable or behind a flag
1. Features that have no matching data in the Master: clock-in, HSE incidents, team capacity, delay attribution, health index.
2. Where SLA D-1 is measured from. The Master uses Site Release; the proposal is TE Installation Readiness.
3. Rules for the Expansion scenario.
4. The Cluster rule for KPI Acceptance.
5. Final Closure is not measured in Project Status.
6. QC photos as an acceptance condition.
7. How sub-roles are distributed.
8. Which documents each task and gate requires. This list is not agreed yet; keep it data-driven.

## Default stack (change only through an ADR by tech-lead)
- Web: React 18, TypeScript, Vite, Tailwind with Radix/shadcn, TanStack Query and Table, react-i18next, ECharts.
- API: NestJS (TypeScript) with a PostgreSQL 16 database through Prisma. Background jobs run on BullMQ with Redis. Files go to S3-compatible storage (MinIO on-prem).
- Auth: MSAL / Entra ID OIDC. Server-side RBAC plus a row-level region filter.
- Tests: Vitest, Supertest, and Playwright.
- Deployment: Docker Compose first, on-prem friendly, because data residency rules may apply.

## Working agreement between agents
- **Contract first.** No endpoint is built before it exists in `contracts/openapi.yaml`. The web app uses MSW mocks generated from the contract until the API is ready.
- **Own your folders.** Each agent writes only inside its own folders (see `ORCHESTRATION.md`). Changes needed elsewhere go as a request to tech-lead.
- **Small PRs** to `develop`. Each PR includes tests and a short note covering what changed, how it was tested, and any open questions.
- Never invent business rules. If the spec is silent, add the question to `docs/spec/open-questions.md` and use a configurable default.
- Use only synthetic data (fictional names) until the product owner releases real data. Never commit secrets.
