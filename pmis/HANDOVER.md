# GSDN PMIS — Handover to the implementation developer

> **ملخص بالعربي:** انتهت مرحلة P0 (التأسيس): القرارات، والمواصفات، ونموذج البيانات، وعقد الـAPI، والتصميم، ونماذج الطباعة. هذا الملف يشرح للمطوّر ما الموجود وأين، وكيف يشغّله، وما المطلوب منه في P1. مالك المنتج يبقى صاحب القرار في البوابات واختبار القبول ورفع البيانات الحقيقية.

Status on 2026-10-25: **phase P0 (Foundations) is complete.** Everything below is on `main` of this repository.
Next phase: **P1 (Core)**. Its task list is in `docs/adr/P0-gate-report.md` §7.

## 1. Read in this order
1. `CLAUDE.md`: the binding rules and every owner decision. If code and this file disagree, this file wins until an ADR changes it.
2. `CHANGELOG.md`: why and when each rule changed, newest first. Add an entry with every PR.
3. `docs/adr/0001`–`0010`: the architecture decisions (stack, auth, authorization and RLS, workflow engine, templates, logs, configuration versioning, files, metadata, versioned workflows).
4. `docs/adr/P0-gate-report.md`: inconsistencies found, the security limits, and the **P1 breakdown** (§7, with order of work).
5. `docs/spec/`: the task catalogue (`task-catalogue.csv`, 69 tasks), the business rules (`rules.md`), the user stories with acceptance criteria (`stories-*.md`), the staff registry spec, and `open-questions.md`.

## 2. What exists

| Area | Path | State |
|---|---|---|
| Data model | `apps/api/prisma/schema.prisma` | 75 models |
| Migrations | `apps/api/prisma/migrations/0001`–`0009` | Run clean on PostgreSQL 16. Each mirrors a file in `db/sql/`; keep both copies identical. |
| Row-level security, identity writes | `db/sql/002`–`008` | Region RLS, config write checks, `idm_*` functions. Read ADR 0003 before touching them. |
| ERD, seed plan | `db/erd.md`, `db/seed-plan.md` | |
| Seeds | `db/seed/holidays-2026-2027.csv`, `db/seed/staff-registry.draft.csv` | Synthetic or tentative data. Real data comes from the owner later. |
| Master import mapping | `tools/master-import/mapping.csv` | 187 Master columns mapped to fields |
| API contract | `contracts/openapi.yaml` | OpenAPI 3.1 v0.1, 84 operations, lints clean with redocly. **Contract first:** no endpoint without it. |
| Design | `design/tokens.*`, `design/GSDN_PMIS_Prototype_v2.html`, `design/screens/` | Clickable prototype, 120 Playwright checks passing |
| CW forms | `design/forms/` | DN, RN, PAC, FAC as HTML templates rendered to A4 PDF |
| Agents | `../.claude/agents/*.md`, `ORCHESTRATION.md` | 9 agents with their models and folders |
| References | `docs/reference/` | Blueprint v1.1, decisions D1–D88, the Master user manual, and the previous standalone dashboard (`legacy-dashboard/`, read-only, the KPI reference for P3) |

**Not started:** `apps/api/src` (NestJS code), `apps/web` (React app), `infra/` (Docker Compose), CI.

## 3. How to run what exists
- **Database:**
  ```
  createdb pmis_dev
  for d in apps/api/prisma/migrations/0*/; do psql -v ON_ERROR_STOP=1 pmis_dev -f "$d/migration.sql"; done
  ```
  Or run `npx prisma migrate deploy` once `apps/api` has its package.
- **Prototype:**
  ```
  cd design/src
  python3 ar.py && python3 build.py
  npm i -D playwright   # if not installed
  node tests/test.js
  ```
  Open `design/GSDN_PMIS_Prototype_v2.html` in a browser. Demo login ID `1001`.
- **Forms:**
  ```
  cd design/forms
  npm install
  npm run render
  ```
  Output goes to `out/`.

## 4. Must-know rules for P1
- **Sign-in:**
  - M365 (Entra ID) only, using a backend-for-frontend session (ADR 0002).
  - One identifier box (email, employee ID or phone), resolved in the staff registry and passed to Microsoft as `login_hint` (ADR 0002 §9b). The response must not reveal whether a user exists.
  - Local passwords are **deferred** (§10).
- **Authorization:** effective permission is the union of assignments, **each limited to its own regions and modules** (B3). Today the database uses one region union per user. Per-module region sets plus the signed session context (ADR 0003 §3 and §6) are the first P1 security items.
- **Workflow engine:**
  - Entry → Review → Approve, with auto-skip, self-approval (B5), and rejection back one level, or back to the person who actually acted (B6).
  - Level path snapshotted at first submission (B7). No-holder tasks go to admins (B10).
  - Reassignment by the lead never resets or pauses the SLA (B12b).
- **Everything configurable is versioned and audited:** SLA, weights, workflow versions, fields, documents, templates, holidays. The structural freeze during the pilot and parallel run (B9).
- **Audit log:** append-only, enforced in the database. Read access per B4.
- **Synthetic data only** until the owner releases real data. Never commit secrets.

## 5. Needs people, not code
| Item | Who | Blocks |
|---|---|---|
| Entra app registration: redirect URIs `/api/v1/auth/callback` and `/api/v1/auth/step-up/callback`, scopes `openid profile email`; deliver tenant ID, client ID, client secret | M365 admin (IT) | Real sign-in. Develop against a mock IdP until then. |
| Internal server, domain, TLS, backups (RPO 15 min, RTO 4 h) | IT | Deployment |
| Confirm the religious holiday dates and the number of Eid days | Owner or System Admin | Exact SLA before the pilot |
| Real staff registry and real Master data | Owner | Pilot (Tripoli) |
| Gate approvals and user acceptance testing | Owner | Each phase gate |

## 6. Working agreement
- Small PRs with tests and a short note. Update `CHANGELOG.md` in every PR.
- Each agent writes only in its own folders (`ORCHESTRATION.md`).
- Unknown business rule → add it to `docs/spec/open-questions.md` and use a configurable default. Never invent one.
