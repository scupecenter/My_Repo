# Database security suite (P1-QA-02)

Runs the negative cases of the GSDN PMIS database as the application role `pmis_app`. Every case is an attack that the
database must refuse. A case passes only when the refusal happens with the expected SQLSTATE (and message), and no row
changes. The suite builds its own scratch database, so it never touches a real one.

Plain SQL holds the fixtures and the cases. A small Node runner (`run.mjs`, no dependencies, drives `psql`) builds the
database, runs the cases and reports.

## Layout

| Path | What it is |
|---|---|
| `run.mjs` | Runner: builds `pmis_secsuite`, runs the cases, prints PASS/FAIL, exits non-zero on any FAIL. |
| `sql/00_harness.sql` | Harness objects: `secsuite_ids` (fixture names to ids) and `secsuite_snapshot()` (a digest per table). |
| `sql/01_fixtures.sql` | Synthetic baseline: 10 people, 7 regions, roles, groups, delegations, messages, announcements, clusters. Created through the real installer, admin and messaging functions where they exist. |
| `cases/05_positive_controls.sql` | Legitimate actions that must succeed. They prove that the fixtures and harness are not vacuous. |
| `cases/10_direct_writes.sql` | INSERT, UPDATE, DELETE, TRUNCATE on identity, credential, department, message and announcement tables, and on `audit_log`. |
| `cases/20_forged_settings.sql` | `app.region_ids = '*'` set by a non-admin (or by nobody): identity functions still refuse. |
| `cases/30_self_escalation.sql` | Granting oneself rights, group membership in System Admins, delegation to self, re-delegation, a delegate's own row. |
| `cases/40_last_admin.sql` | Removing the last active System Admin by status change, group removal, group deactivation, soft delete. |
| `cases/50_delegate_limits.sql` | Password reset for accounts with assignments, announcements from region-limited delegates, other scope limits. |
| `cases/60_messages.sql` | Reading, replying to and marking-read a thread one is not part of; editing or deleting messages. |
| `cases/70_announcement_results.sql` | A recipient reading results or other answers; answering twice; answering a notice not addressed to them. |
| `cases/80_local_credentials.sql` | Reading hashes directly or through the functions for another user; anonymous calls. |
| `cases/85_local_lookup.sql` | `auth_local_lookup` must never return a deleted or a disabled account. |
| `cases/90_rls_and_sessions.sql` | Region RLS (a Tripoli session and Benghazi data), and session rows. Includes KNOWN LIMIT cases (below). |

## How to run

Prerequisites: PostgreSQL 16 running, the `psql` client on the PATH, Node 18 or later.

```bash
# the PostgreSQL 16 container used for local tests
pg_ctlcluster 16 main start

# from the repository root (or from pmis/)
node pmis/tests/db-security/run.mjs              # full run; drops the scratch database at the end
node pmis/tests/db-security/run.mjs --keep-db    # keep pmis_secsuite for inspection
node pmis/tests/db-security/run.mjs --list       # list the case IDs without running them
node pmis/tests/db-security/run.mjs --only local-lookup   # one category
```

Exit codes: `0` every case PASS; `1` at least one FAIL; `2` setup failed (the migrations, the grants, the fixtures or the
role check). A setup failure is not a verdict on the cases.

Connection settings are environment variables. The defaults are container-only test credentials, so override them in CI:

| Variable | Default |
|---|---|
| `PMIS_SECSUITE_PSQL` | `psql` |
| `PMIS_SECSUITE_PGHOST` | `127.0.0.1` |
| `PMIS_SECSUITE_PGPORT` | `5432` |
| `PMIS_SECSUITE_SUPER_USER` | `postgres` |
| `PMIS_SECSUITE_SUPER_PASSWORD` | `localtest` |
| `PMIS_SECSUITE_APP_USER` | `pmis_app` |
| `PMIS_SECSUITE_APP_PASSWORD` | `testpass-123456` |
| `PMIS_SECSUITE_DB` | `pmis_secsuite` |

What a run does, in order:

1. Drops and creates `pmis_secsuite`, and grants `pmis_migrator` to the superuser (the documented deployment role, see migration 0003). The migrations run as a member of that role, as a deployment would.
2. Applies every `apps/api/prisma/migrations/0*/migration.sql` in name order, stopping at the first error.
3. Applies `db/sql/app_grants.sql`.
4. Applies `sql/00_harness.sql` and `sql/01_fixtures.sql`.
5. Preflight as `pmis_app`: it is not a superuser, has no BYPASSRLS, is not a member of `pmis_migrator`, `pmis_identity_owner` or `pmis_definer`, and owns no table. Any failure is a setup failure.
6. Runs every case. Each case runs as `pmis_app` in one transaction, which is rolled back unless the case is a positive control. Deferred checks (the last-admin triggers, the assignment scope checks) are run at the end with `SET CONSTRAINTS ALL IMMEDIATE`, which is what COMMIT would do. Nothing persists, so one case cannot change another.
7. Takes a digest of 28 tables before and after each refused case (identity, credentials, departments, messages, announcements, sessions, audit log, clusters). A refused case must leave every digest unchanged.
8. Writes `results/last-run.json` (git-ignored) with each case, its verdict and the server evidence.

## Case format

```sql
-- @case LA-03
-- @title The only admin suspends himself (self-change refused)
-- @category last-admin
-- @actor ADMIN            -- fixture name; the runner sets app.user_id
-- @region *               -- the runner sets app.region_ids (omit to leave it unset)
-- @expect error 42501 you cannot change your own status
SELECT idm_set_user_status('{{ADMIN}}', 'suspended', 'Self suspend');
-- @end
```

- `@expect error <SQLSTATE>[|<SQLSTATE>] [message regex]`: the statement must fail with one of the SQLSTATEs and a message matching the regex (case-insensitive). Use the alternative form only where two layers may refuse the same attack.
- `@expect output <value>` or `output>= <n>`: the last output line must equal (or be at least) the value. Used for reads that must return nothing.
- `@expect ok`: the statements must succeed (positive control, committed).
- `{{NAME}}` is replaced by the fixture id (or value) recorded in `secsuite_ids`. An unknown name fails the case.

A case that expects a refusal and is accepted FAILs with "the statements completed without an error", and the runner
rolls the change back, so the evidence is the statement that was allowed.

## Results at the time of writing

The run output is in `results/last-run.json` after each run. The summary line is `N cases: P PASS, F FAIL`.

### KNOWN LIMITS (kept as FAIL on purpose)

These cases are part of the suite and are not skipped. They fail until the fix named here is in place, and the gate is
blocked until then. Do not edit them to pass.

| Case | What the database allows today | Fix |
|---|---|---|
| RL-02, RL-03 | A session that sets `app.region_ids = '*'` reads and writes region data outside its regions. The application sets this setting itself, so any SQL injection can set it. | P1-DB-03 (signed session context verified in the database, ADR 0003 section 6). |
| SS-01 | The application role holds INSERT on `user_sessions`, so any SQL running as `pmis_app` can insert a live session for any user from a token it chooses. | P1-DB-03, and session creation through a guarded function. |

### REAL FINDINGS (FAIL, not yet in the known-limit list)

| Case | Finding |
|---|---|
| LK-04, LK-05, LK-06 | `auth_local_lookup` returns the row of a **disabled** account (status `disabled`, not deleted, local sign-in still enabled), by e-mail, employee ID and phone. Deleted accounts are excluded (migration 0012 switches local sign-in off). The API hides disabled accounts in its own code, so the database does not enforce what the spec requires. The same function also returns `password_hash` to any caller without a session, so enumerating the 4-digit employee IDs returns the argon2id hash of every active account. Fix: filter `u.status = 'active'` in the function (a migration change, for the database engineer). |

These are reported to tech-lead. The suite does not change the migrations.

## Scope and what is not covered

- The suite covers the database's own refusals. It does not test the API's authorisation, which is in `apps/api/test`.
- It does not prove a forged app-level session cannot reach the database under an unknown SQL injection. It documents the known limits above.
- The `app.user_id` setting can be forged to name an admin. ADR 0003 section 6 documents this as the residual limit that P1-DB-03 closes. It is not a case, because a case that always fails would hide the other results.
- The workflow engine tables and functions (P1-DB-05: submit, unlock, self-skip, claim, reject) are not in the migrations yet, so the suite has no cases for them.
- Region RLS is enabled by migration 0003 on `sites`, `task_instances` and other site-bound tables. The suite has no case on those tables yet; `clusters` stands in for the region filter.

## Adding a case

1. Pick the file for the category, or add a new `cases/NN_name.sql`. Files run in name order.
2. Give the case a new ID, a title that says what is attempted, and an expectation that names the refusal you expect.
3. Run `node tests/db-security/run.mjs --only <category>`. Check the evidence line: a PASS must show the refusal you meant, not an unrelated error.
4. Do not weaken an expectation to make a run pass. If a case reveals a hole, leave it FAIL and report it.

## CI

Run it against a PostgreSQL 16 service, with the superuser and the application role provided as secrets, then run:

```bash
node tests/db-security/run.mjs
```

The job must fail on exit code 1 and on exit code 2. Keep `results/last-run.json` as a build artifact.
