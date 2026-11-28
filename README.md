# Telecom Site Delivery Workspace

A full-stack workspace for managing telecom site delivery — towers, telecom equipment, and civil works — covering the complete lifecycle of a site from acquisition and design through construction, integration, acceptance, and handover.

## Overview

Delivering a telecom site involves dozens of coordinated tasks across acquisition, civil works, telecom installation, power, and commissioning, each requiring evidence, approvals, and deadline tracking. The workspace is the single system of record for that work: it replaces spreadsheet-based tracking with a governed workflow, versioned documents, and real-time visibility across many regions and sites.

Every task in the system moves through a multi-level review-and-approval workflow. Documents are versioned and immutable. Every change is audited. Access is scoped by region and role down to the database row level.

## Domain

The system models the standard telecom site-delivery pipeline:

- **Site acquisition** — candidate evaluation, surveys, and site acceptance.
- **Design** — RF design and detailed design deliverables.
- **Civil works (CW)** — foundations, towers, shelters, and site construction.
- **Telecom equipment (TE)** — installation, integration, and on-air readiness.
- **Power and utilities** — utility coordination and power-on evidence.
- **Quality, snags, and rectification** — quality checks with photo evidence rules.
- **Acceptance and handover** — readiness, handover/takeover, and as-built records.
- **Dismantle** — controlled decommissioning and site restoration.

## Key Features

- **Workflow engine** with a three-level approval chain on every task, SLA calendars, deadline gates, and escalation.
- **Regional, row-level security**: every query is filtered by the user's regions and role directly in the database.
- **Document management**: typed, versioned documents with per-type rules (formats, sizes, photo evidence requirements), immutable file history, withdraw-not-delete semantics, and encrypted, virus-scanned file storage.
- **Generic register framework**: typed records with validation, child lists, file references, list catalogues, and governed import/export templates — new registers are defined by configuration, not new code.
- **Bilingual UI (English/Arabic) with full RTL support**, light and dark themes, and switchable view modes (list, wide table, board, feed, map, calendar, chart) chosen from one View menu, remembered per user and register, with saved views.
- **Dashboards and reporting**: operational KPIs, workload, status updates, and scheduled exports.
- **Collaboration**: inbox, approvals queue, messages, announcements, and notifications.
- **Auditability**: a full audit log of data and configuration changes.
- **Operations**: installer and update scripts, automated database and file backups, and a tested disaster-recovery procedure.

## Modules and Records

Derived from the running system:

| Area | What it covers |
|---|---|
| Sites | The site register: one record per site with its full task pipeline, streams, and status |
| Registers | Acquisition, RF design, procurement, utility coordination, permits & HSE, quality & snags, incidents, issues, risks, meetings, lessons learned, dismantle, as-built, readiness & handover, change control, invoices, financial advances, contractors, warehouse, fleet & assignments |
| Documents & Library | Typed document slots on tasks, sites, regions, and records; blank forms; generated documents; archive |
| Templates & Import | Governed Excel templates, batch import with reconciliation, and export |
| My Work | Personal queue, daily plan, approvals, follow-ups, and workload |
| Dashboard | Operational cards, progress curves, and drill-downs |
| Administration | Users, roles, permissions, departments, groups, delegations, settings, announcements |

## Architecture

- **API**: Node.js (NestJS) + Prisma, contract-first against an OpenAPI 3.1 specification — no endpoint exists without a contract entry.
- **Database**: PostgreSQL 16 with row-level security; migrations are mirrored SQL-first under `pmis/db/sql/`.
- **Web**: React + TypeScript + Vite + Tailwind, generated API types, MSW-mocked e2e tests.
- **Files**: pluggable storage (local or S3-compatible) with per-file encryption keys and virus scanning on upload.
- **Design system**: shared tokens (`pmis/design/tokens.*`) synced into the web app.

Design principles: contract-first, database-enforced authorization, immutable history, configuration over code, and no deletions (records are withdrawn, never erased).

## Repository Structure

```
pmis/
  apps/api        NestJS API, Prisma schema and migrations
  apps/web        React web app
  contracts/      OpenAPI specification (the contract of record)
  db/sql          SQL migrations and grants (mirror of the Prisma migrations)
  db/seed         Seed data
  design/         Design tokens, prototype, print forms
  docs/           Specs, ADRs, plans, handover notes
  infra/          CI notes, backup scripts, runbook
  tools/          Installer, capacity sizer, import tooling
  tests/          Database security test cases
```

## Getting Started

Prerequisites: Node.js 22 and PostgreSQL 16.

```bash
# API
cd pmis/apps/api && npm ci   # from the repository root
export TEST_PG_ADMIN_URL=postgresql://postgres:<password>@127.0.0.1:5432/postgres
export TEST_PG_APP_PASSWORD=<pmis_app-password>
npm run typecheck && npm run lint && npm run build && npm test

# Web (runs against an in-browser mock layer; no API needed)
cd ../web && npm ci && npm run dev
npm run typecheck && npm run lint && npm test && npm run build
npm run e2e
```

A scripted installer (`pmis/tools/install/`) provisions a production server, including storage, backups, and updates.

## Documentation

- `pmis/HANDOVER.md` — current build state and reading order for implementers.
- `pmis/CHANGELOG.md` — every rule and feature change, newest first.
- `pmis/docs/adr/` — architecture decision records.
- `pmis/docs/spec/` — task catalogue, business rules, and user stories.
- `pmis/infra/RUNBOOK.md` — backup, restore, and disaster-recovery procedures.

## Contributing

- Contract-first: every API change starts in `pmis/contracts/openapi.yaml`.
- Keep the Prisma migrations and their `pmis/db/sql/` mirrors identical.
- All checks must pass: API tests on PostgreSQL 16, web unit tests and Playwright e2e, contract lint, and installer shell checks.
- Database changes ship as forward-only migrations; destructive operations are reviewed separately.

## Security

Row-level security on every table, least-privilege database roles, audited configuration changes, encrypted file storage with upload-time virus scanning, and no secrets in the repository. Report issues privately to the maintainers.

## License

Private and proprietary. All rights reserved. No license is granted to use, copy, modify, or distribute this software without written permission from the owner.
