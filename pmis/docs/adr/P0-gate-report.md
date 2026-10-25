# P0 gate report: Foundations

- Date: 2026-10-25
- Author: tech-lead
- For: the product owner
- Decision asked: approve the spec, the ERD and the key prototype screens (ORCHESTRATION.md, P0 gate), and answer the questions in section 4.

## 1. What P0 delivered

| Area | What exists now | Where |
|---|---|---|
| Business rules | Task catalogue (all stages, SLA codes, documents, templates, Master columns, scenario applicability); rules for gates, milestones, SLA, scenarios, cluster, Project Status, delay attribution, health index; 92 user stories with acceptance criteria; 18 open questions with proposed defaults | `docs/spec/` |
| Database | Prisma schema and migrations 0001–0007. They cover region row-level security, append-only audit log, many-to-many role assignments, versioned SLA rules and weight sets, editable task definitions, custom fields (JSONB with a validation trigger), the permission grid and field-level rules. Also the ERD, the seed plan (synthetic data only) and the Master-column mapping | `apps/api/prisma/`, `db/`, `tools/master-import/mapping.csv` |
| Design | Design tokens (frappe-ui 1.0.2, one file), clickable prototype v2 (EN/AR, light/dark), screen catalogue with states and shortcuts | `design/` |
| Architecture decisions | ADR 0001 stack and repository layout · 0002 sign-in · 0003 access control · 0004 approval engine · 0005 templates and import · 0006 audit and system logs · 0007 configuration versioning · 0008 file storage · 0009 custom fields, task definitions, roles, warehouse items · 0010 versioned workflow (milestones and gates) | `docs/adr/` |
| API contract | OpenAPI 3.1, version 0.1.0. It covers every endpoint P1 needs: sign-in and session, me, users, assignments (bulk), roles, permission profiles, groups, delegations, regions, sites (list, detail, task grid), tasks (detail, entry, submit, review, approve, reject with note, claim, release, comments, history, upload, download, admin override), approvals inbox (bulk), matrix, workflow versions and site migration, audit log read and export, settings read. It passes `redocly lint` (recommended rules) with no errors; four intentional 302 redirect endpoints are ignored. It generates TypeScript types that compile. | `contracts/openapi.yaml`, `contracts/redocly.yaml` |

### How to look at it (demo steps)
1. Open `design/GSDN_PMIS_Prototype_v2.html` in a browser. Sign in as a demo user. Then go to My Work → a site → open a task drawer → Approvals → Responsibility Matrix → Users & Roles. Switch to Arabic and to dark mode from the top bar.
2. Read `docs/spec/rules.md` §2 (gates) and §10 (approval rules). Then pick two stories, for example WF-04 self-skip and VI-03b visibility from several roles.
3. Open `db/erd.md` for the data model in plain words.
4. Optional, technical: run `npx -y @redocly/cli@1 lint pmis/contracts/openapi.yaml --config pmis/contracts/redocly.yaml`, or paste the file into any OpenAPI viewer to browse the API.

## 2. Inconsistencies found, with proposed fixes

"Spec" means `docs/spec/`, "schema" means the Prisma schema and SQL, and "prototype" means `design/`. Unless marked "owner", these are technical fixes the team will make.

| # | What disagrees | Proposed fix | Owner of fix |
|---|---|---|---|
| I-01 | Task codes. The catalogue uses `A1…D18`, `MS1…MS10`, `G2…G10`. The schema comments, seed plan and `mapping.csv` use `CW_STA`, `TE_PAC`, … | The catalogue codes are the stable codes. Re-key the seed and `mapping.csv`. | database-engineer |
| I-02 | Who reads the Audit Log. LG-03 says admins and the Project Manager. The prototype says "approve level or higher". | Make it the permission `view_audit`, seeded for System Admins and the Project Manager (ADR 0003). **Owner: confirm.** | backend, ux |
| I-03 | Effective permission. screens.md says "the highest of the active rows". VI-03b says each role is checked on its own row. | Permissions are a union of (action, module, region) combinations, never a "highest row" (ADR 0003 §1). Update the prototype text. | ux-designer |
| I-04 | Region visibility. The database computes one region list per user. VI-03b needs regions *per module* (Tripoli everywhere, Benghazi only in Warehouse). | Module-aware region resolution (ADR 0003 §3). | database-engineer |
| I-05 | Matrix rows for Dismantle and the registers. MX-01 has them. The schema requires a stage on every matrix cell, and the prototype shows 10 stages only. The catalogue's Dismantle tasks (E1–E3) have no stage. | Let a matrix row belong to a stage *or* to a register/Dismantle scope. Add those rows to the matrix screen. | database-engineer, ux-designer |
| I-06 | Task states. The schema has a `rejected` state, but a rejection returns the task one level back, so nothing rests in "rejected". There is no state for "approved document later rejected, awaiting confirmation" (BP §03), and none for tasks retired by a workflow migration. | Use `rejected` as `awaiting_confirmation` and add `retired`. Track returns with a counter and the last note (ADR 0004 §2). | database-engineer |
| I-07 | When the number of approval levels is frozen. The schema says "at creation". MX-05 says tasks *submitted* after the change use the new count. | Freeze it at the first submission (ADR 0004 §3). **Owner: confirm.** | database-engineer, backend |
| I-08 | Duplicate matrix cells are possible. The uniqueness rule does not treat empty task or region as equal (PostgreSQL treats NULLs as distinct). | Use `NULLS NOT DISTINCT` on the unique index. | database-engineer |
| I-09 | Q18 says one active row per person and role. The database only blocks two rows that start at the same moment. | Add an exclusion constraint on overlapping validity periods. | database-engineer |
| I-10 | TI-02 assumes a 14-day grace period for old template versions. CLAUDE.md now says old versions are rejected. TI-03 says an added column must not break the Master upload, but issued templates are checked by header checksum. | No grace period. The checksum is strict for issued templates. Only the legacy Master path uses a "required columns present" check (ADR 0005). | domain-analyst (story text) |
| I-11 | Template IDs and versions. The spec uses `TPL-USERS`, the prototype `TPL-ROLES`. Versions are "v1.0" strings in the prototype and whole numbers in the schema. | Use `TPL-ROLES`. Versions are whole numbers, shown as "v3". | domain-analyst, ux-designer |
| I-12 | Employee ID check. The prototype login shows "ID not found, contact a System Admin", which implies a list of real IDs. The spec only checks 4 digits and uniqueness. | Check format and uniqueness only, unless HR can supply a list (question B13). | ux-designer |
| I-13 | User status words. AU-09 says "Inactive". The schema has `suspended` and `disabled`. | "Inactive" = `disabled` (permanent). `suspended` = temporary. Update the stories. | domain-analyst |
| I-14 | Team (CW/TE/both). AU-03 and the prototype show team on the person. The schema stores it on each assignment row. | Keep it per assignment. The person page shows the combination (ADR 0003 §9). **Owner: confirm.** | ux-designer |
| I-15 | Change Control types. rules.md uses Cancellation, Relocation and Baseline Re-plan. The schema's `ChangeKind` lacks them. | Add the three values. | database-engineer |
| I-16 | Region names on import. The Master stores "Tripoli Area", but `mapping.csv` matches the region code exactly (Q10). | Strip " Area" in the mapping transform. | database-engineer |
| I-17 | Sub-roles. CLAUDE.md says 9 but lists 10 names. | Seed all 10. Roles are now admin-defined, so the count no longer matters. | (none, closed) |
| I-18 | ERD text is out of date: "weekend is code, not data" (it is data now), `app.allow_sla_repoint` (replaced by `admin_repoint_sla`), and "milestones are fixed" (changed by the 2026-10-25 decision). | Refresh `db/erd.md` with the workflow-version rework. | database-engineer |
| I-19 | The audit log cannot store a bulk-action id, a batch id, a "privileged" flag, step-up or MFA (needed by LG-01, LG-05, AU-11 and the prototype's MFA chip). | Add these columns plus a tamper-evident hash chain (ADR 0006). | database-engineer |
| I-20 | Document Library publish to "new tasks only / also open tasks". Slots point at the document type, not at a frozen version of it, so a publish would silently change open tasks. | Add versions of document types and point slots at a version (ADR 0007 §4). | database-engineer |
| I-21 | A custom field of type "file" accepts any text. | Store a file id and check that it exists (ADR 0008 §8). | database-engineer |
| I-22 | A required custom field on tasks would block creating a *locked* task, because the trigger checks it on insert. | For tasks, "required" means required to submit (ADR 0009 §2). | database-engineer |
| I-23 | Default approver in the matrix seed. The seed plan sets the Project Manager as approver for every stage. MX-01 says the stage's main role approves, and the Project Manager approves only Final Closure. | Follow MX-01. **Owner: confirm** (question B2). | database-engineer |
| I-24 | Warehouse item master data. CLAUDE.md wants categories, need rules, deactivation and versions. The table has none of these. | Add them (ADR 0009 §6). This is needed for P2, not P1. | database-engineer |
| I-25 | Roles. CLAUDE.md now wants description, parent, default profile, default regions and modules, and "may hold matrix levels". The schema has fixed role and sub-role tables without them. | ADR 0009 §5. | database-engineer |
| I-26 | Milestones and gates. Migration 0007 makes them unchangeable, but the 2026-10-25 decision makes them configurable through workflow versions. | ADR 0010 replaces those triggers. The database agent is already reworking this. | database-engineer |
| I-27 | The admin database functions (region transfer, SLA re-point, add task to open sites) accept any session marked "all regions", so a delegate's limits were checked only in the API. | They now go through `app_actor_is_admin(action)` (ADR 0003 §7). The database agent is implementing this. | database-engineer |

## 3. Security note: what is fixed, and the remaining limit
The security review found that the application could write the user, role, group and permission tables directly. A bug could therefore have let a person grant themselves rights.

- **Being fixed now.** All such writes go through guarded database functions that:
  - recompute who is an admin from the tables;
  - refuse "grant to myself";
  - refuse re-delegation;
  - always keep at least one active admin (ADR 0003 §7).
- **Remaining limit.** The database still learns *who* is acting from a setting the application sends (`app.user_id`). This protects against application bugs, but not against an attacker who can run SQL through the application.
- **Plan.** In P1, before the Tripoli pilot, we replace that setting with a signed, verified session context (ADR 0003 §6). It costs about 3 agent-days and adds well under 1 ms per request.
- **Until then.** Only synthetic data is used.

## 4. Open questions that block P1, ranked

| Rank | Question | Why it blocks | Proposed default |
|---|---|---|---|
| B1 | **Entra ID app registration** (tenant id, redirect URIs, MFA via Conditional Access). Does the tenant send `auth_time` on re-sign-in, and will IT define an authentication context for step-up? | Nobody can sign in without it. It needs the M365 admin. | Use a mock sign-in provider in development. Step-up is checked with `auth_time`, falling back to a forced re-login. |
| B2 | **Default approver per stage**: the stage's main role (MX-01) or the Project Manager everywhere (seed plan)? | The engine tests and the pilot need a matrix. | MX-01: the stage main role approves; the Project Manager approves Final Closure. |
| B3 | **Visibility across roles**: a person's rights are the union of their roles, each limited to its own regions and modules (ADR 0003 §1, §3). And team (CW/TE) is stored per assignment. | Users & Roles, the visibility filter and its E2E test. | As written in ADR 0003. |
| B4 | **Who can read the Audit Log**: System Admins and the Project Manager only? | Audit Log screen and permissions seed. | Yes, configurable as a permission. |
| B5 | **Self-skip all the way to final approval.** If one person holds Entry, Review and Approve, their submit becomes the final approval (with step-up), and it is flagged "self-approval" in KPIs. Allowed? | Core engine rule. | Allowed, flagged, and shown in advance on the matrix. |
| B6 | **Rejection when the previous level was skipped**: return to the person who actually acted (ADR 0004 §6b)? | Core engine rule. | Yes. |
| B7 | **Approval-level changes** apply to tasks not yet submitted (I-07)? | Core engine rule. | Yes. |
| B8 | **Admin-added task "counts toward milestone"**: the milestone waits for it, and its date can become later than the Master's (ADR 0009 §3c). | Milestone calculation. It affects the parallel-run match. | Yes, with a warning during the parallel run. |
| B9 | **Freeze structural workflow changes during the pilot and the parallel-run month?** | Acceptance requires 100% milestone match, which cannot hold for sites on a changed workflow. | Freeze them. Light changes stay allowed, with the warning. |
| B10 | **Tasks with no eligible holder** go to System Admins with an alert (MX-03). Under "all members must approve", one rejection rejects (WF-05). | Engine edge cases. | Yes to both. |
| B11 | **Matrix rows for registers and Dismantle** (I-05): should register records follow their own Entry/Review/Approve rows? | The matrix screen layout in P1; register approvals in P2. | Yes, one row per register and one for Dismantle. |
| B12 | Q4 **holidays 2026–2027**. The table is empty, so SLAs ignore holidays. | Needed before the pilot, not for development. | A banner shows "holiday table empty" until it is filled. |
| B13 | Is there an **HR list of employee IDs** we can check against at first sign-in? | Login error wording (I-12). | No list: format and uniqueness only. |

Not blocking P1, but needed before P2: Q1 (legacy Master import path, ADR 0005 §6), Q8 (role-name mapping), Q6 (IP-Router-Only warehouse need), Q3 and Q15 (Swap scenario rules), Q11 (which issue goes to the Master export), Q12 (Meetings fields), Q16 (health index and Final Closure KPI formulas).

## 5. Risks of letting the workflow structure change (ADR 0010)

| # | Risk | Mitigation |
|---|---|---|
| R-01 | **Parallel run and acceptance.** A site on a changed workflow cannot match the live Master 100%, and acceptance requires that. | Freeze structural changes until the Master is retired (B9). The Master export marks "expected difference (workflow vN)". Explicit typed confirmation during the parallel month. |
| R-02 | **Removing or reordering a seeded milestone** breaks rules built on it: Site RFI (MS4) starts the TE Access SLA; KPI Acceptance is per cluster; Project Status ends at HOTO; Final Closure has its own KPI. | Publishing is refused while any SLA start event, weight item, gate condition or KPI still refers to a removed code. The seeded ten keep their Master formulas. |
| R-03 | **KPIs mix versions.** Totals, trends and comparisons can shift when sites migrate, because a node that is missing in a version leaves the denominator. | Group by stable codes only. "Versions in scope" is shown on every tile. Weekly snapshots store the version. Migrations are listed on trend charts. |
| R-04 | **Migrating work in progress.** Tasks that change stage change their matrix holders and their SLA chain mid-flight. | Sites with tasks in review or approval that would move are skipped and listed. The preview shows every date change. A migration can be reverted until the next approval. |
| R-05 | **Template churn.** Each structural publish invalidates the site-tasks template, so users must download it again. | A clear rejection message with the download link. Users who downloaded the old version recently are notified. |
| R-06 | **Light changes apply at once to every site on the version.** A wrong gate condition could open or lock many gates in one click. | It applies only to gates not yet open. Step-up and a reason are required. Contract v0.2 adds a dry run that shows how many sites and gates change. |
| R-07 | **Two calculation paths** (Master formulas for the seeded ten, generic rules for admin-added milestones) mean more code and more tests. | Table-driven golden tests per path. Generic milestones are kept deliberately simple. |
| R-08 | **Performance.** Every KPI query joins through the site's workflow version. | The engine caches each version's graph. The 1000-site performance test includes mixed versions. |

## 6. What I need from the database agent (it is reworking the schema now)
1. Workflow versions (ADR 0010 §1): `sites.workflow_version_id` written only by the migration function. Replace the 0007 "fixed milestone" triggers.
2. The identity functions `idm_*` and `app_actor_is_admin(action)`, already in progress (ADR 0003 §7). Please send the final function names so the contract's `x-db-path` notes can match.
3. Verified session context `app_begin` (ADR 0003 §6) and module-aware regions (§3).
4. Schema corrections I-05 to I-09, I-15, I-16, I-19 to I-22 and I-25. Also: a materialised `task_inbox`, a notification outbox table, and `task_instances.duration_wd` (ADR 0007 §6).
5. Refresh `db/erd.md` and `db/seed-plan.md` (I-01, I-18, I-23).

## 7. P1 task breakdown (one PR each, to `develop`)

Every PR includes tests and a short note (what changed, how it was tested, open questions). No endpoint is built before it exists in the contract. Acceptance criteria are shortened here; the PR template links the stories.

### Enablers (start first)
| Id | Agent | Task | Acceptance criteria |
|---|---|---|---|
| P1-TL-01 | tech-lead | `packages/contracts`: generated types, typed client, MSW handlers; CI lint and drift check | `pnpm contracts:gen` is clean. CI fails on a stale client or a lint error. |
| P1-OPS-01 | devops-security | Dev Compose (Postgres 16 with the `pmis_app`/`pmis_migrator`/`pmis_definer` roles, Redis, MinIO, mock OIDC provider); CI with a Postgres service; secret for the context HMAC key | `docker compose up` gives a working stack. CI runs migrations as `pmis_migrator` and the tests as `pmis_app`. |

### database-engineer
| Id | Task | Acceptance criteria |
|---|---|---|
| P1-DB-01 | Workflow versions schema and seed v1 (ADR 0010) | v1 has MS1–MS10 and G2–G10 with Master columns. A direct update of `sites.workflow_version_id` fails. Migration and rollback are tested. |
| P1-DB-02 | `idm_*` identity functions and `app_actor_is_admin` (in progress) | As `pmis_app`: a direct INSERT into assignments fails; a grant to oneself is refused; a delegate cannot delegate; removing the last admin fails at commit. |
| P1-DB-03 | Verified session context `app_begin`; policies rewritten | `set_config('app.region_ids','*')` without a valid context returns no rows. A forged signature is refused. The overhead is under 1 ms (benchmark in the PR). |
| P1-DB-04 | Module-aware region resolution | The VI-03b scenario passes in SQL tests. |
| P1-DB-05 | Engine support: states (I-06), return counter, levels freeze, matrix uniqueness and register scope (I-05, I-08), assignment overlap (I-09), workflow-step guard trigger, `task_inbox`, outbox | Each constraint has a negative test. The inbox query is under 50 ms on seed data with 1000 sites. |
| P1-DB-06 | Audit log columns, hash chain, yearly partitions | UPDATE and DELETE are still blocked. The chain verify function detects a tampered row in the test. |
| P1-DB-07 | Roles as admin-defined (ADR 0009 §5), seed profiles, re-key seed and `mapping.csv` to catalogue codes, region " Area" transform, ChangeKind values | The seed runs idempotently. A Management role seeds as read-only with all regions and cannot hold matrix levels. |

### backend-engineer
| Id | Task | Acceptance criteria |
|---|---|---|
| P1-BE-01 | Sign-in session: login, callback, session, logout, tenant check, MFA toggle, employee ID, pending guard | Against the mock OIDC provider: a wrong tenant gets 401 and is logged; a pending user gets 403 `pending_assignment` except on `/auth/*` and `/me`; a missing CSRF token gets 403. |
| P1-BE-02 | Step-up and break-glass | A protected call without a recent step-up gets 401 `step_up_required`. Break-glass from outside the internal CIDR is refused and logged. Success emails the admins. Lockout after 5 failures. |
| P1-BE-03 | Request plumbing: per-request transaction with context, request id, problem+json, ETag/If-Match, cursor pagination, Idempotency-Key | Contract tests: the error shape is valid; 428 without If-Match; 412 when stale; a replayed bulk request returns the same body. |
| P1-BE-04 | `/me`, `/regions`, navigation from permissions | The VI-03b and Management-role cases are correct. |
| P1-BE-05 | Users, assignments (bulk assign, update, end, copy), roles, profiles through `idm_*` | 12 users are assigned in one call with one `bulk_action_id`. An existing row is skipped with `already_assigned`. A dry run writes nothing. |
| P1-BE-06 | Groups and delegations | Last admin gets 409 `last_admin`. A delegate creating a delegation gets 403. A delegate's actions are audited "on behalf of". |
| P1-BE-07a | Calculation service: gates and milestones MS1–MS4 for workflow v1 (rules.md §2), suspension shift | Golden tests built from synthetic rows reproduce the Master formulas, including the N/A pass-through. |
| P1-BE-07b | Calculation service: MS5–MS10, cluster KPI Acceptance, Overall Status | Golden tests pass. Cluster progress "x of y at TE PAC" is correct. |
| P1-BE-08 | Sites list (filters, mini rail), site detail (pipeline), task grid | A site outside the region gets 404. p95 is under 300 ms for the list at 1000 sites. |
| P1-BE-09 | Engine core: holder resolution, start, entry, submit, review, approve, reject with note, self-skip, unlock | A table-driven test covers 1, 2 and 3 levels × holder overlaps × reject paths. Each transition writes one workflow step and one audit row. |
| P1-BE-10 | Group claim and release, "all members must approve", concurrency | A concurrent second claim gets 409 `already_claimed` naming the claimant. "All members" completes only when all active members approve; one rejection rejects. |
| P1-BE-11 | Approvals inbox, bulk pass/approve, My Work buckets | Bulk returns done, skipped and failed per item, with one step-up. The inbox loads in under 2 s with 100 concurrent users. |
| P1-BE-12 | Matrix read and save, stage levels, skip preview | An empty used level gets 422 `empty_cell`. A role that may not hold levels is refused. The change applies to the next transition only. |
| P1-BE-13 | Comments, history, slot upload and download (MinIO) | The download audit row is written before streaming. A wrong file type (checked by content) gets 422. A new version keeps the old one. |
| P1-BE-14 | Admin override and revert | A reason and step-up are required. The badge is set. A revert after later activity gets 409. |
| P1-BE-15 | AuditService, Audit Log read and CSV export job, System Log writer, `/client-errors` | Every endpoint in the contract writes an audit row (checked by a test that walks the contract). An export writes its own audit row. |
| P1-BE-16 | Workflow versions: read and light changes; settings read endpoints | A light rename keeps the code. A gate condition change does not move gates that are already open. |

Workflow drafts, structural publish and site migration are already in the contract. They are planned for the start of P2, after the owner answers B9.

### frontend-engineer
| Id | Task | Acceptance criteria |
|---|---|---|
| P1-FE-01 | Shell, routing, EN/AR with RTL, light/dark, tokens, MSW from the contract, the four standard states | A Playwright smoke test passes in EN and AR. No hard-coded colours (lint rule). |
| P1-FE-02 | Login, employee ID, pending page, global step-up and error handling | A 401 `step_up_required` triggers re-authentication and retries the action. A pending user sees only the pending page. |
| P1-FE-03 | Users & Roles: by role, by person, pending; bulk assign; copy preview | Assigning 12 people works in one flow. Skipped rows are shown with their reason. |
| P1-FE-04 | Groups, Delegation, Roles and permission profiles (grid editor) | The last admin cannot be removed (message shown). The grid saves with step-up. |
| P1-FE-05 | Sites list with filters and mini rail | Filters are kept in the URL. Keyboard navigation (`j`/`k`/Enter) works. |
| P1-FE-06 | Site page: pipeline in the dashboard style, task grid, read-only drawer | The pipeline matches the dashboard component (rings, gradient track). "Why locked?" lists the reasons. |
| P1-FE-07 | Drawer actions: entry, document slots, submit, review, approve, reject with note, claim, comments, history, override | "Submit" stays disabled until every mandatory slot and field is filled. A note is required to reject. A skipped level is shown struck through. |
| P1-FE-08 | Approvals inbox with bulk actions; My Work | One step-up covers the bulk action. The shortcuts `x`, `a`, `r` and `Shift+A` work. |
| P1-FE-09 | Matrix editor with skip preview and level counts | An unsaved cell is highlighted. An empty used level blocks saving. |
| P1-FE-10 | Audit Log viewer | Filters, badges (override, on behalf of, MFA, privileged) and export. No edit control exists. |

### qa-engineer
| Id | Task | Acceptance criteria |
|---|---|---|
| P1-QA-01 | P1 test plan and synthetic fixtures | The plan maps every P1 story to a test. Only fictional data is used. |
| P1-QA-02 | Database security suite run as `pmis_app`: RLS, forged settings, self-escalation, last admin | All negative cases fail as expected. The suite runs in CI. |
| P1-QA-03 | Contract conformance: API responses validated against `openapi.yaml` | Any drift fails CI. |
| P1-QA-04 | **Gate E2E:** submit → review → approve → next task opens; rejection back one level with a note; self-skip; group claim; visibility filter (region and module); step-up on final approval | All pass on Compose in EN and AR. This is the P1 gate criterion from ORCHESTRATION.md. |
| P1-QA-05 | Performance smoke test: 1000 sites, 100 virtual users, mixed workflow versions | Pages respond in under 2 s at p95 (report attached). |

### Order of work
1. **Enablers.** P1-TL-01 and P1-OPS-01.
2. **Database.** P1-DB-02 (already running), then P1-DB-01 and P1-DB-05, then P1-DB-03 and P1-DB-04.
3. **Backend: foundation.** P1-BE-01 and P1-BE-03 first. Then P1-BE-04 to P1-BE-06, and the calculation service P1-BE-07a and P1-BE-07b.
4. **Backend: engine.** P1-BE-09 to P1-BE-12, which depend on P1-DB-05.
5. **Frontend.** Starts on mocks at once. It moves to the real API screen by screen as each backend PR merges.
6. **QA.** P1-QA-04 runs last, as the P1 gate.
