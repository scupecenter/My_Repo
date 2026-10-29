# P1 test plan (task P1-QA-01)

Owner: qa-engineer. Scope: the five P1 story files, the P1 gate scenario from `ORCHESTRATION.md`, and what was added since P0
(ADR 0012 local sign-in, ADR 0013 messages and announcements, migration 0012 soft delete). Only fictional data is used.

Status of this plan: **mapping only**. The tests named below were located by file and case name. I did not execute the
Vitest or Playwright suites for this plan. The database security suite was executed (section 4).

## 1. How to read the tables

| Column | Meaning |
|---|---|
| API | Vitest + Supertest in `apps/api/test` (file, then case). |
| WEB | Vitest + Testing Library in `apps/web/src` (file, then case). These run against the MSW mock, not the real API. |
| E2E | Playwright in `apps/web/e2e` (file, then test title). |
| DB | Database security suite in `tests/db-security`, by case ID (section 4). |
| Status | **covered**: the existing test asserts the story's main acceptance criteria. **covered (partial)**: some criteria are asserted, the rest are named in the note. **planned**: no test yet, and a P1 task in `P0-gate-report.md` section 7 will deliver it (task ID given). **gap**: no test, and no P1 task names it. |

Story IDs are in `docs/spec/stories-*.md`. Acceptance criteria are summarised, not copied.

## 2. Story coverage

### 2.1 Authentication and users (`stories-auth-and-users.md`)

| Story | Acceptance (summary) | API | WEB | E2E | DB | Status | Note |
|---|---|---|---|---|---|---|---|
| AU-01 | First M365 sign-in creates a pending account and asks for a 4-digit ID; a bad or taken ID is refused and logged; pending users get 403 outside `/auth/*` and `/me` | auth-session.test.ts "pending accounts" → "a pending_assignment user reaches only /auth/* and GET /me" | components.test.tsx describe "EmployeeId", "rejects non-4-digit input locally and unknown IDs from the server"; describe "Pending", "shows the pending state and notifies admins" | login-approve.spec.ts "pending user sees the pending screen only"; "first sign-in account: change the temporary password, enter the employee ID, wait for assignment" | | covered (partial) | The M365 sign-in itself is not built (B1: Entra registration). Planned P1-BE-01. Rejected IDs logged to the System Log: planned P1-BE-01. |
| AU-02 | Tokens from another tenant are refused and logged; external parties are a task attribute (`responsible_party`), never accounts | | | | | planned / gap | Tenant check: planned P1-BE-01. Gap: no P1 task names `responsible_party` or the rule that external parties never get an account. Proposed for tech-lead to add to P1-BE-01 or P1-DB-05. |
| AU-03 | Admin gives a pending user a team, status and an assignment; the account becomes active; a role change needs step-up; audited with before and after | assignments.test.ts "a pending person becomes usable with the first assignment…" → "stops being pending at once…"; "a person who loses the last assignment is pending again"; "refuses … without step-up (401)" | phase3a.test.tsx "assigns a role to a pending user, who then becomes active" | phase3a.spec.ts "admin assigns a role to a pending user, who then sees My Work" | | covered | Audit row of `assignment_created` is asserted in assignments.test.ts (before and after values). |
| AU-04 | Seed creates 6 main roles and 9 sub-roles with the agreed mapping; the mapping is editable and audited | roles-permissions.test.ts "makes a sub-role under a main role and lists main roles with their sub-roles"; "renames a role and changes its defaults with If-Match…" | | | | covered (partial) | Seed content and idempotency not asserted: planned P1-DB-07 (seed runs idempotently). |
| AU-05 | Admin creates a group and adds users; deactivated members leave the group's inbox | groups.test.ts "GET /groups…", "needs step-up, then reports done, skipped and failed per user", "refuses adding yourself…", "DELETE … removes the member and audits it" | | | | covered (partial) | Inbox effect of deactivation: planned P1-BE-10. Group UI: planned P1-FE-04. |
| AU-06 | Last active admin cannot be removed (message "at least one active admin must exist"); delegated actions read "X on behalf of System Admin"; delegation ends at its end date; a delegate cannot re-delegate or remove an admin | users.test.ts describe "the last System Admin", "cannot be removed or deactivated (409 last_admin), and nothing is committed"; groups.test.ts "a delegate (groups.edit) manages ordinary groups but not the System Admins group"; phase3a.test.tsx describe "delegation", "blocks granting to yourself"; phase3b.test.tsx "delegation targets…" | phase3a.test.tsx describe "delegation", "grants to another person and lists it, then revokes"; phase3b.test.tsx "act on behalf" | phase3b.spec.ts "users: delete, … act on behalf" | SE-06, SE-07, SE-08 (no re-delegation, no self-delegation); LA-01 to LA-11 | covered (partial) | End-date stop and "on behalf of" audit for delegates: planned P1-BE-06. The message text of the last-admin refusal is asserted in the DB suite only as the trigger message. |
| AU-07 | `amr` without `mfa` gets 401 `mfa_required` when the toggle is on; final approval, role/matrix/group change, delegation, delete and override need a fresh step-up (5 min) | auth-session.test.ts "step-up (password)" → "answers 401 step_up_required … then accepts the action after the password is re-entered"; roles-permissions.test.ts "writing needs the right (403) and step-up (401)"; assignments.test.ts "refuses a caller … without step-up (401)" | client.test.ts "retries once after a successful step-up"; "one step-up covers concurrent requests"; localSignIn.test.tsx "step-up by password…" | login-approve.spec.ts "login -> My Work -> approve with step-up by password" | FS-02, FS-03 (forged setting cannot act without a right) | covered (partial) | `mfa_required` toggle and the 5-minute freshness window: planned P1-BE-02. Entra `amr` check blocked on B1. |
| AU-08 | Break-glass account: internal network only, every use logged and emailed, refused outside the CIDR | | | | | planned | P1-BE-02 (break-glass, CIDR refusal, admin email, lockout after 5). No test exists. |
| AU-09 | Setting a user to Inactive ends access at the next request; open claimed tasks return to their group or cell (ASSUMPTION) | users.test.ts "PATCH /users/{id} (status)" → "needs If-Match (428)…, then changes the status, audits it and ends the sessions"; "a delegate (users.edit) cannot deactivate an admin"; auth-session.test.ts "a suspended user is refused on the next request" | | | | covered (partial) | Claimed-task release: planned P1-BE-10 (claim) and P1-BE-09. Soft delete and restore (B14): see 4.3. |
| AU-10 | Assignment row: user, role, level, regions, modules, valid from/to, status; rows outside validity are ignored; each role is checked against its own row | assignments.test.ts "takes regions, modules, team and profile from the role…"; "scopes never cross: sites in Tripoli plus warehouse in Benghazi gives exactly those two"; "a person who loses the last assignment is pending again" | phase3a.test.tsx describe "assignment edit", "changes the level of an assignment and rolls back when the server refuses" | | DB: none for validity | covered (partial) | Future `valid_from` and the approve-in-TE / entry-in-CW example (AU-10 second bullet): planned P1-DB-04 and P1-BE-05. |
| AU-11 | One action assigns 12 registered people to one role; already-assigned rows are skipped with the reason; one `bulk_action_id` | assignments.test.ts "assigns 12 people in one call under one bulk_action_id and skips the ones who already hold the role (already_assigned)"; "a dry run returns the same result and writes nothing"; "replays an Idempotency-Key…" | | | | covered (API) | Web bulk screen for 12 people: gap in the web and E2E suites (planned P1-FE-03, E2E in P1-QA-04). |
| AU-12 | Assign by person: several main and sub-roles at once, each with its own level and scope; the mapping does not limit which roles one person holds | assignments.test.ts "scopes never cross…" (two assignments for one person) | | | | covered (partial) | Person-page UI: planned P1-FE-03. Holding roles across main roles: not asserted, planned P1-BE-05. |
| AU-13 | Bulk remove ends rows (history kept); copy previews, then copies the active rows and skips rows already held; approved template upload | assignments.test.ts "ends rows (history kept), skips a row that already ended, supports a future end date and a dry run"; "previews by default, then copies the active rows (scope, level and profiles) to several people"; "replace ends the current rows…" | | | | covered (partial) | Template upload (TI-01, TI-04, TI-05) is P2 (template service). Claimed tasks back to the matrix cell: planned P1-BE-10. |

### 2.2 Visibility (`stories-visibility.md`)

| Story | Acceptance (summary) | API | WEB | E2E | DB | Status | Note |
|---|---|---|---|---|---|---|---|
| VI-01 | Default is everything the permission level allows | misc.test.ts "a System Admin gets every module key the web app knows, all grants and is_system_admin"; "a regular user gets assignments, groups and grants from the database, with regions per grant" | | | | covered | |
| VI-02 | Region limit applied on the server to every list; a site in another region gives 404 | roles-permissions.test.ts "lists the 7 regions with the contract codes; visible follows the regions of the caller" | phase2.test.tsx describe "Sites list", "virtualises rows and filters by region" (mock) | | RL-01 (Tripoli session does not see Benghazi cluster), RL-04 (cannot write it); RL-02 KNOWN LIMIT (forged setting reads it) | covered (partial) | Site list and 404 on site ID: planned P1-BE-08 (sites are not built). Forged-setting leak: P1-DB-03. |
| VI-03 | Module limit hides the menu; API calls to another module return 403 | groups.test.ts "needs view on admin.groups: a plain member gets 403 module_forbidden"; users.test.ts "is module_forbidden without view on admin.users and works with the grant"; misc.test.ts "grants through a profile open the module in nav…" | | | | covered (partial) | Warehouse and Quality 403: planned P1-BE-08 and the register modules. Menu rendering test: gap in web (planned P1-FE-01). |
| VI-03b | Two active rows give the union of regions per module; writes are checked against the one row used; an expired row stops granting | assignments.test.ts "scopes never cross: sites in Tripoli plus warehouse in Benghazi gives exactly those two"; "a person who loses the last assignment is pending again" | | | | covered (partial) | The SQL-level scenario (P1-DB-04, "the VI-03b scenario passes in SQL tests"): planned. Per-module union in SQL: planned P1-DB-04. |
| VI-04 | Dashboard totals, Project Status and the health index use only visible sites; central items hidden for regional users | | | | | gap | No P1 task names it. P1-BE-07b is the calculation service; the dashboard is P3. Proposed: tech-lead to add to P1-BE-07b. |
| VI-05 | Pending users see nothing (see AU-01) | auth-session.test.ts "a pending_assignment user reaches only /auth/* and GET /me" | | login-approve.spec.ts "pending user sees the pending screen only" | | covered | |
| VI-06 | Register rows without a site are visible to anyone with the module | | | | | planned P2 | Registers are P2 (stories-registers). |

### 2.3 Task workflow (`stories-workflow.md`)

No workflow engine exists in `apps/api/src` yet (P1-BE-09 to P1-BE-11). The web tests use the mock.

| Story | Acceptance (summary) | API | WEB | E2E | DB | Status | Note |
|---|---|---|---|---|---|---|---|
| WF-01 | Entry → Review → Approve; each step audited with actor and time | | phase2.test.tsx describe "Task drawer", "keeps Submit disabled until the mandatory slot is filled, then submits (skip of own level)" | site-flow.spec.ts "site -> edit date -> upload -> submit -> switch account -> approve" (submit reaches `in_approval`; approve removes the row) | | covered (partial) | Three-level path, next-task unlock and per-step audit: planned P1-BE-09 (engine table test: 1, 2 and 3 levels). |
| WF-02 | Unit of approval is the whole task; "Submit for review" disabled while a mandatory slot is empty, with the missing names | | phase2.test.tsx describe "Task drawer", "keeps Submit disabled until the mandatory slot is filled, then submits (skip of own level)" | site-flow.spec.ts (drawer-submit disabled, then enabled after upload) | | covered (partial) | Atomic approval of dates and documents: planned P1-BE-09. |
| WF-03 | Approving X makes the next task Pending with expected date = X + SLA max; a locked task names its predecessor | | phase2.test.tsx describe "Task grid", "offers a per-task template download and explains a lock" | | | planned | P1-BE-09 and P1-BE-07a (SLA). Lock reason is asserted in web only. |
| WF-04 | Same person holds Review and Approve: Approve is skipped, flagged "self-approval"; Entry + Review: Review is skipped | | phase2.test.tsx "keeps Submit disabled…, then submits (skip of own level)" | | — | covered (web mock) / planned (engine) | Engine table test (P1-BE-09) and skip audit row: planned. Self-approval step-up (B5): planned P1-BE-09. |
| WF-05 | Group claim: first member claims, others lose it; "all members must approve"; a second claim gets 409 `already_claimed` | | | | | planned | P1-BE-10. No web test for claim. |
| WF-06 | Reject at Approve returns to Review, at Review to Entry; reject without a note is refused; each rejection counts | | phase2.test.tsx "requires a note to reject and asks for step-up on final approve"; "returns the task with a note"; components.test.tsx describe "Approvals", "requires a note to return a task" | | | covered (web mock) / planned (API) | API 422 for a missing note and the counter: planned P1-BE-09. |
| WF-07 | Comment thread with author and time; @mentions notify; no edit after 15 minutes | | | | | planned | P1-BE-13. |
| WF-08 | Batch: approve selected rows; "approve all" holds rows "pending previous approval" and lists them | components.test.tsx "Approvals: bulk approve asks for one step-up then completes" (inbox bulk) | | | | covered (partial) | The upload-batch rows (held rows, rejected rows back to uploader): planned P2 (template service). The inbox bulk is P1-BE-11. |
| WF-09 | Admin override needs a reason and step-up; audit before and after; "Admin override" badge; KPIs flag it; reversible | | | | | planned | P1-BE-14. No test. |
| WF-10 | Reopen an approved task to Entry; dependent milestones marked "awaiting confirmation" | | | | | planned | P1-BE-14 (admin override and revert). |
| WF-11 | Site RFI date pre-filled from the latest condition date; approving it sets MS4 | | | | | planned | P1-BE-07a and P1-BE-09. |

### 2.4 Responsibility matrix (`stories-matrix.md`)

| Story | Acceptance (summary) | API | WEB | E2E | DB | Status | Note |
|---|---|---|---|---|---|---|---|
| MX-01 | One row per stage, plus registers and Dismantle, with Entry, Review and Approve cells and the level count; seed defaults | | phase2.test.tsx describe "Responsibility Matrix", "lists stage, register and Dismantle rows with skip preview" | | | covered (web mock) / planned | Seed defaults: planned P1-DB-01 and P1-DB-07. API matrix read: planned P1-BE-12. |
| MX-02 | A cell accepts users, roles, groups or a mix; an empty used cell cannot be saved | | phase2.test.tsx "refuses an empty used level and keeps the server copy" | | | covered (web mock) / planned | API 422 `empty_cell`: planned P1-BE-12. |
| MX-02b | A role in a cell resolves through active assignment rows with review or higher, the module and the site's region; a person with entry rights only is not a reviewer | | | | | planned | P1-BE-09 and P1-BE-12. No test. |
| MX-03 | Region-scoped holders; a task no holder can see goes to System Admins with "no eligible holder" | | | | | planned | P1-BE-09 and P1-BE-10 (B10). |
| MX-04 | Matrix change needs step-up; audited before and after; applies to new transitions only | | phase2.test.tsx "edits a cell and publishes after re-authentication" | | | covered (web mock) / planned | API audit and "new transitions only": planned P1-BE-12. |
| MX-05 | Changing a stage from 3 levels to 2 hides Review for that stage; only new submissions use 2 levels | | | | | planned | P1-BE-12 and P1-FE-09. |
| MX-06 | "level will be skipped for X" hint for a person who holds two consecutive levels | | phase2.test.tsx "lists stage, register and Dismantle rows with skip preview" | | | covered (web mock) | |

### 2.5 Audit log and system log (`stories-logs.md`)

| Story | Acceptance (summary) | API | WEB | E2E | DB | Status | Note |
|---|---|---|---|---|---|---|---|
| LG-01 | Every user action writes one audit row (actor, on-behalf-of, before and after, reason, batch, IP) | users.test.ts (audit row per status change, password reset and creation); groups.test.ts ("group_member_added", "group_member_removed"); assignments.test.ts ("assignment_created", bulk summary); departments-org.test.ts ("department_created", "user_org_set"); announcements.test.ts ("announcement_sent", "announcement_exported") | | | AL-01 to AL-04 (no tampering) | covered (partial) | A walk over every contract endpoint that asserts an audit row: planned P1-BE-15. |
| LG-02 | Append-only in the database, for every role including the application role | users.test.ts "what pmis_app may do in the database" → `UPDATE audit_log` rejected with "permission denied" | | | AL-01, AL-02, AL-03, AL-04 | covered | 10-year retention is an operations item. The hash chain and tamper check: planned P1-DB-06. |
| LG-03 | Audit log search by date, user, site, entity, action; paged; export is audited; visible to admins and the Project Manager only | | | | | planned | P1-BE-15 and P1-FE-10. No test. |
| LG-04 | System/error log, separate from audit; a failed sign-in is logged without the identifier or password; 12-month purge | auth-login.test.ts "writes the System Log without the identifier or the password" | | | | covered (partial) | Rejected template upload: P2. Nightly purge: planned P1-BE-15. |
| LG-05 | Break-glass and admin override are flagged `privileged` and emailed to admins | | | | | planned | P1-BE-02 (break-glass) and P1-BE-14 (override). |

## 3. Added since P0

| Item | Tests | Status |
|---|---|---|
| **ADR 0012 local sign-in** (one box, same message for every failure, 5 failures lock 15 minutes, temporary password, must change at first sign-in, password policy, step-up by password) | API: auth-login.test.ts (14 cases: identifiers, lock, rate limit, System Log); auth-session.test.ts "must change password"; password-policy.test.ts (policy, argon2id, temporary passwords, CLI). WEB: localSignIn.test.tsx (login errors, must change password, create user, reset password). E2E: login-approve.spec.ts (generic errors, first sign-in). DB: LC-01 to LC-04, LK-01 to LK-03, OK-04, OK-05 | covered. Open: LK-04 to LK-06 FAIL (see 4.3) |
| **ADR 0013 messages and announcements** (threads with manager, blocking announcements, answers final, results for sender and admins) | API: messages.test.ts (threads, participants, admin rules, validation); announcements.test.ts (send, answer, results, export, formula neutralising); departments-org.test.ts (department and manager, loop refusal). WEB: messagesAnnouncements.test.tsx (thread view, pop-up, sender view, departments). E2E: messages.spec.ts (announcement pop-up blocks, manager thread, departments). DB: DW-33 to DW-47, MS-01 to MS-12, AR-01 to AR-12, OK-01, OK-02, OK-03, OK-06, OK-10 | covered |
| **Migration 0012 soft delete** (B14: no hard delete; sessions end; restore brings back the old status) | API: user-delete.test.ts "soft delete and restore…"; "refuses deleting yourself…". WEB: phase3b.test.tsx "users: deactivate, delete, restore" and "deleting moves the user to Deleted…". E2E: phase3b.spec.ts "users: delete, deleted tab with blocked restore, then restore". DB: LK-01 to LK-03 (deleted account not returned), LA-04, LA-07 | covered |

## 4. Database security suite (P1-QA-02)

Location: `tests/db-security/` (see its README). It builds `pmis_secsuite`, applies `apps/api/prisma/migrations/0*/migration.sql` in order and
`db/sql/app_grants.sql`, loads synthetic fixtures, then runs each negative case as `pmis_app`.

Last run (see section 6 for the evidence): **151 cases, 145 PASS, 6 FAIL.**

### 4.1 Mapping to the stories and the P1 gate

| Story / requirement | Cases | Result |
|---|---|---|
| AU-06, AU-03 (identity writes only through guarded functions) | DW-01 to DW-26, FS-01 to FS-11, SE-01 to SE-17 | PASS |
| AU-06 (last active admin: status change, group removal, soft delete) | LA-01 to LA-11 | PASS |
| AU-07 (step-up is not a substitute for a right) | FS-02 to FS-07 | PASS |
| AU-11 (delegate limits on assignments) | SE-09 to SE-11 | PASS |
| ADR 0012 (password hashes only through functions; reset by a delegate only for rightless accounts) | LC-01 to LC-04, PR-01 to PR-05 | PASS |
| ADR 0013 (messages, announcements, answers final) | DW-33 to DW-47, MS-01 to MS-12, AR-01 to AR-12 | PASS |
| LG-02 (audit append-only) | AL-01 to AL-04 | PASS |
| VI-02 (region filter in the database) | RL-01, RL-04 | PASS |
| VI-02 (forged `app.region_ids` does not widen reads or writes) | RL-02, RL-03 | **FAIL (known limit)** |
| ADR 0012 section 4 (sessions are created only by the API) | SS-01 | **FAIL (real hole, see 4.3)** |
| ADR 0012 (`auth_local_lookup` never returns a deleted or disabled account) | LK-01 to LK-03 PASS; LK-04 to LK-06 | LK-04 to LK-06 **FAIL (real gap, see 4.3)** |

Gate status for P1-QA-02: **blocked.** The acceptance text says "all negative cases fail as expected". Six do not.

### 4.2 Scenario coverage for the rest of the P1 gate

The DB suite covers the identity and messaging rules above. The workflow rules (submit, unlock, self-skip, claim, reject)
need the engine tables and functions from P1-DB-05, which are not in the migrations yet. They are planned under
P1-DB-05 (negative tests per constraint) and P1-DB-02 (already in the migrations, covered by the identity cases).

## 5. P1 gate scenario (ORCHESTRATION.md "P1 · Core" gate, and P1-QA-04)

| Gate item | Covered by today | Status | Task |
|---|---|---|---|
| Submit → review → approve → next task opens | site-flow.spec.ts (submit and approve; "next task opens" is not asserted) | covered (partial) | P1-BE-09 (engine), P1-QA-04 (E2E with next-task assertion) |
| Rejection back one level with a note | phase2.test.tsx "requires a note to reject"; "returns the task with a note"; components.test.tsx "requires a note to return a task" (web mock) | covered (web mock); E2E gap | P1-BE-09, P1-QA-04 |
| Self-skip | phase2.test.tsx "keeps Submit disabled…, then submits (skip of own level)" (web mock); DB: the rule is in the engine, not yet | covered (web mock); planned | P1-BE-09, P1-DB-05 |
| Group claim | none | planned | P1-BE-10, P1-QA-04 |
| Visibility filter by region | DB RL-01, RL-04 (clusters); phase2.test.tsx describe "Sites list", "virtualises rows and filters by region" (mock); assignments.test.ts "scopes never cross" | covered (partial); E2E gap | P1-BE-08, P1-QA-04 |
| Visibility filter by module | groups.test.ts, users.test.ts (module_forbidden); misc.test.ts (nav from grants) | covered (partial); E2E gap | P1-BE-04, P1-QA-04 |
| Step-up on final approval | login-approve.spec.ts "approve with step-up by password" (a wrong password keeps the dialog, the right one completes); phase2.test.tsx "asks for step-up on final approve" | covered | P1-BE-09 |
| Local sign-in (ADR 0012) | section 3 | covered | |
| Messages and announcements (ADR 0013) | section 3 | covered | |
| Soft delete (migration 0012) | section 3 | covered | |

The P1-QA-04 gate E2E specs (Playwright, EN and AR) are not written yet. The existing E2E specs live in `apps/web/e2e`, which the
frontend agent owns. **Decision needed from tech-lead:** where the QA-owned gate specs live (for example `tests/e2e/`).

## 6. Evidence

Run of `tests/db-security/run.mjs` against a fresh `pmis_secsuite` on PostgreSQL 16. Each run writes `tests/db-security/results/last-run.json` (git-ignored), with every case, its verdict and the server evidence:
151 cases, 145 PASS, 6 FAIL. The six FAILs are listed in 4.1 and in the report that accompanies this plan.

## 7. Gaps to hand to tech-lead

| # | Gap | Proposed owner and task |
|---|---|---|
| G-1 | `auth_local_lookup` returns disabled accounts (LK-04 to LK-06). It also returns `password_hash` to any caller without a session. | database-engineer (P1-DB-03 or a new fix) |
| G-2 | The application role can INSERT into `user_sessions` (SS-01). Any SQL running as the application role can mint a session for any user. | database-engineer with backend (P1-DB-03, signed session context) |
| G-3 | Forged `app.region_ids = '*'` widens region reads and writes (RL-02, RL-03). Known limit, ADR 0003 section 6. | database-engineer (P1-DB-03) |
| G-4 | Tenant check and `responsible_party` rules (AU-02) have no task. | backend-engineer (P1-BE-01) |
| G-5 | Dashboard and aggregate visibility (VI-04) has no P1 task. | tech-lead (P1-BE-07b) |
| G-6 | No web or E2E test for claim, bulk assignment UI, audit log viewer. | frontend-engineer with QA (P1-FE-03, P1-FE-10) |
| G-7 | Gate E2E location and the workflow engine tests (P1-BE-09 to P1-BE-14) are not written. | qa-engineer, after the engine PRs |
