# GSDN PMIS: Handover to the implementation developer

> **ملخص بالعربي:** انتهت مرحلة P0 (التأسيس) والمرحلة P1 قيد التنفيذ على `main` بعد الدمج #48: واجهة الـAPI موجودة (العقد 0.4.6، الهجرات حتى 0020)، وتشمل تسجيل الدخول المحلي ومحرك الموافقات وسجل المواقع ومواعيد SLA والبوابات وأول أربعة سجلات (المشتريات وGECOL وHLC والتصاريح) ومصفوفة المسؤوليات. يوجد CI ومثبّت لـUbuntu. قرارات المالك بتاريخ 2026-10-31 (سجل Dismantle، عروض CW/TE/O&M، قسم المستندات) مسجلة في `docs/plans/` وغير مبنية بعد. مالك المنتج يبقى صاحب القرار في البوابات واختبار القبول ورفع البيانات الحقيقية.

Status on 2026-10-31: **main is at PR #48.** Phase P0 (Foundations) is complete and P1 (Core) is under way. Everything below is on `main` of this repository. Section 4 below was written in P0 and still says local passwords are deferred; local sign-in exists since migration 0010, so check the code and `CHANGELOG.md` before relying on it.
The owner decisions of 2026-10-31 are in `docs/plans/2026-10-31-dismantle-stream-views-documents.md`. They are **decided, not yet built**.

## 1. Read in this order
1. `CLAUDE.md`: the binding rules and every owner decision. If code and this file disagree, this file wins until an ADR changes it.
2. `CHANGELOG.md`: why and when each rule changed, newest first. Add an entry with every PR.
3. `docs/adr/0001`–`0010`: the architecture decisions (stack, auth, authorization and RLS, workflow engine, templates, logs, configuration versioning, files, metadata, versioned workflows).
4. `docs/adr/P0-gate-report.md`: inconsistencies found, the security limits, and the **P1 breakdown** (§7, with order of work).
5. `docs/spec/`: the task catalogue (`task-catalogue.csv`, 69 tasks), the business rules (`rules.md`), the user stories with acceptance criteria (`stories-*.md`), the staff registry spec, and `open-questions.md`.
6. `docs/plans/`: agreed plans, newest decisions first. Start with `2026-10-31-dismantle-stream-views-documents.md`.
7. `docs/handover/db-gaps.md`: schema and SQL work that contract 0.2.5 and 0.2.6 need and the database does not have yet, as a checklist for database-engineer.

## 2. What exists

| Area | Path | State |
|---|---|---|
| Data model | `apps/api/prisma/schema.prisma` | Prisma schema (75 models at P0; the registers and matrix migrations 0016 to 0020 add more) |
| Migrations | `apps/api/prisma/migrations/0001`–`0020` | 0001 init to 0020 matrix admin. Each mirrors a file in `db/sql/` where one exists; keep both copies identical. |
| Row-level security, identity writes | `db/sql/002`–`008` | Region RLS, config write checks, `idm_*` functions. Read ADR 0003 before touching them. |
| ERD, seed plan | `db/erd.md`, `db/seed-plan.md` | |
| Seeds | `db/seed/holidays-2026-2027.csv`, `db/seed/staff-registry.draft.csv` | Synthetic or tentative data. Real data comes from the owner later. |
| Master import mapping | `tools/master-import/mapping.csv` | 187 Master columns mapped to fields |
| API | `apps/api` | Built. Local sign-in (0010), approval engine (0015), Site Register streams (0016), SLA calendar and gates (0017, 0018), first four registers Procurement, GECOL, HLC and Permits & HSE (0019), Responsibility Matrix (0020). |
| API contract | `contracts/openapi.yaml` | OpenAPI 3.1 **v0.4.6**. Amendments 0.2.1 to 0.2.6 are in `docs/adr/0011-contract-v0.2.md`; later ones are in `CHANGELOG.md`. **Contract first:** no endpoint without it. |
| Web app | `apps/web` | React app, wired to the real API for the matrix (changelog entry 42); the rest was built on MSW mocks generated from the contract. Run: `cd apps/web && npm install && npm run dev`. Tests: `npm test`, `npm run e2e`. Scripts in `apps/web/package.json`. |
| CI | `.github/workflows/ci.yml` | Four jobs: `api` (typecheck, lint, build, tests on PostgreSQL 16), `web` (typecheck, lint, unit tests, build, Playwright e2e), `contract` (Redocly lint of `openapi.yaml`), `installer` (bash syntax and shellcheck). Runs on pull requests to `main` and on pushes to `main`. |
| Installer | `tools/install/` | `install-ubuntu.sh` and `update.sh`, the Ubuntu installer scripts. |
| Capacity sizer | `tools/capacity-sizer/index.html` | Customer sizing tool, a single HTML page (Arabic, RTL). |
| Design | `design/tokens.*`, `design/GSDN_PMIS_Prototype_v2.html`, `design/screens/` | Clickable prototype, 120 Playwright checks passing |
| CW forms | `design/forms/` | DN, RN, PAC, FAC as HTML templates rendered to A4 PDF |
| Agents | `../.claude/agents/*.md`, `ORCHESTRATION.md` | 9 agents with their models and folders |
| References | `docs/reference/` | Blueprint v1.1, decisions D1–D88, the Master user manual, and the previous standalone dashboard (`legacy-dashboard/`, read-only, the KPI reference for P3) |

**Not verified in this refresh:** the number of operations in the contract, the current model count, and the state of every web screen. Check them in the code before quoting them. No server URL is recorded here: ask the owner or IT for the deployment address.

## 3. How to run what exists
- **Database:**
  ```
  createdb pmis_dev
  for d in apps/api/prisma/migrations/0*/; do psql -v ON_ERROR_STOP=1 pmis_dev -f "$d/migration.sql"; done
  ```
  Or run `npx prisma migrate deploy` from `apps/api`.
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
- **Deactivated or deleted users (B14):** open tasks stay on the person with a "deactivated" badge; the Team Lead is alerted at once and uses keep, reassign or act on behalf (B12b). A level with no eligible active holder goes to the System Admins' inbox as "no holder" (B10). The SLA never pauses or resets. A deleted account can be restored unless its employee ID or email now belongs to another account.
- **Notification policy:** a matrix of notification type × role/group × channel, with thresholds in allowed ranges. Mandatory types (audit integrity failure, retention reduced) cannot be turned off; security and system types go to System Admins only.
- **Security log:** separate from the Audit Log and the System Log, readable by System Admins or the `view_security_log` grant, and every read is audited. An identifier typed at sign-in that matches nobody is never stored as typed: only a masked keyed hash is kept.
- **Log integrity:** the Audit Log and the security log are append-only hash chains; an admin check verifies each chain and lists any break.
- **Online now:** admins see active sessions (status, last activity, current screen) and can end a user's sessions with a reason and step-up MFA. Background polling never extends the idle timeout.
- **Log retention:** System Log and security log minimums are 90 and 365 days; reducing one needs a reason and step-up and raises a mandatory alert. The Audit Log stays 10 years and is not settable.
- **Typed confirmation:** type the target's code or name, in addition to step-up MFA, to lift the structural freeze, publish a workflow version, or dismantle.
- **No self-grant:** nobody can grant rights to themselves, by a delegation to a role or group they belong to, or by copying assignments to themselves (only a System Admin acting without delegation may do so).
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

## 7. Next
From `docs/plans/2026-10-31-dismantle-stream-views-documents.md` (decided 2026-10-31, not yet built):
1. Update `docs/spec/registers-and-streams.md` to match the plan (stream and stage boundary, O&M view, Dismantle flow, document section, write-through editing). **Still pending.** Q37, Q40, Q41 and Q73 in `open-questions.md` already carry the owner updates.
2. Add `CHANGELOG.md` entry (43) for these documentation updates and the owner decisions. **Still pending.**
3. Contract and migration for the Dismantle register, the O&M role, the handover engineer field and write-through edits.
4. Screens: Dismantle register, CW, TE and O&M tabs, document type settings.
5. Document section: configurable types, placement, naming and formats (including e-mail `.eml`, `.msg`, `.html`, `.mht`); add the e-mail formats to the ADR 0008 magic-byte allow-list.
6. Later phase, not now: the CPE / end-user installation module (plan section 5).
