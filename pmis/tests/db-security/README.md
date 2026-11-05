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
| `cases/86_two_factor.sql` | Two-factor (migrations 0033 and 0034): `pmis_app` reading or writing the encrypted secrets, recovery hashes, enrolment-code hashes and pending sign-ins; another user's secret through the functions; non-admins, delegates without `users.administer` and admins on themselves turning it on, off, resetting or issuing an enrolment code; the session guard without a code; enrolment refused with a wrong code and the removed no-code forms. |
| `cases/87_templates_import.sql` | Approved-template entry (migration 0037): `pmis_app` writing the template catalogue, versions, batches and rows directly; calling the version issuing or the batch overloads of the register writers; staging a file with a retired version, a changed header or without the import right; sending, discarding or deciding a batch of someone else or of another region; batch and row visibility by region. |
| `cases/98_templates_streams.sql` | Site Register stream templates and TPL-MASTER (migration 0051): `pmis_app` writing task rows, the Master columns, the task fields, the rules or the sheet names directly; calling the register staging, send and decision functions behind the dispatchers, the task staging, the batch insert, the stream send and decision functions, the version issuing or the task step writer; staging a stream or Master file of a retired version, with a changed header, without the right to import tasks or without a session; a stream batch of another region or of someone else (send, discard, decide, read). Positive controls for the reads. |
| `cases/C2_followup_c.sql` | Follow-up group C of the technical decisions of 2026-11-04 (migration 0068): `pmis_app` cancelling an approved Quality snag record without being a System Admin, accepting pending evidence through the old call without the step-up flag, writing the Severity list or the task field lists directly, running the severity mirror, the options refresh or the delay section, resetting the certificate alert counters. Four controls (the single evidence function, the Severity codes, the `external_attendees` field, the CompletionStatus task fields) and the daily alerts job, which the application role may call. |
| `cases/A7_p11.sql` | Two-level conversion follow-up and permits per stream (migration 0054, P11): `pmis_app` writing or releasing the conversion record, running the conversion, the notices, the draft recheck or the internal mover; changing the permit type streams or the stream rows; a forged `transfer` step; a permit of a purpose-based type without a stream, on a stream the engineer does not hold, a City Council permit by a CW engineer, a fixed type stamped with another stream; a draft transferred by someone who neither holds it nor its row. Two positive controls. |
| `cases/C1_followup_b.sql` | Follow-up group B (migration 0067, Q245, Q253, Q257, Q270): a signed-in person resetting the calendar confirmation (the daily job only), switching it on or shortening the mail retention by a direct update, calling the job audit helper, mailing a forged integrity head to a System Admin or an outside address (the kind is reserved) or queueing it in the outbox, finishing a run that does not exist; a quarantine exit movement inserted directly, a quarantined serial put back In Stock by a direct update, the posting trigger function called, a quarantine exit without the Warehouse create right, with an unknown kind or without a reason, the supplier DN counter reset. Positive controls: the job may run the reset, a reader sees the new stock columns, the default retention is 30 days. |
| `cases/88_x_features.sql` | Phase 4b (migrations 0031, 0040): direct writes to notifications, follows and status updates, another person's notifications and follows, status updates of another region, the lead check, `x_follow` without rights or without a session, and the helpers that decide who is notified (`x_notify_watchers`, `x_user_can_read`, `wf_audit`, the trigger function) called from the application role; positive controls for the legitimate paths. |
| `cases/89_dashboard.sql` | Dashboard (migration 0039): a caller with no dashboard grant, the internal calculation functions, direct writes to the weight and snapshot tables, snapshots on demand, the admin weight functions for a non-admin. |
| `cases/93_self_service.sql` | Self-service profile (migration 0044): `pmis_app` reading or writing email change requests, other people's profiles, its own email or name directly, or the enforced flag; admin-owned fields through the profile function; an email change without the password, to a used address, decided by a non-admin, by an admin on their own account, by a delegate for an admin or by a region-limited delegate, or cancelled by someone else; two-factor self enrolment and self disable on another account, without a fresh step-up, from another session, or while enforced; the enforced mark changed by a non-admin, a delegate without `users.administer` or an admin on themselves; the internal helpers. Two positive controls. |
| `cases/90_documents.sql` | The document upload module (migration 0038): `pmis_app` writing slots, files, versions, drafts, zip jobs or the library directly; a non-admin saving or publishing a library document or attaching a blank form; the internal slot builder and spec writer; forged download audit rows (other actions, other regions); another person's zip job; attaching or withdrawing a file with no signed-in user or to a slot that does not exist. Includes two positive controls. |
| `cases/90_rls_and_sessions.sql` | Region RLS (a Tripoli session and Benghazi data), and session rows. RL-02 and RL-03 (a forged all-regions setting) pass since migration 0069. |
| `cases/C3_session_context.sql` | The verified session context (migration 0069, P1-DB-03): a forged `app.region_ids`, `app.user_id` naming an admin, a forged step-up and forged audit labels; a tampered `app.ctx` or `app.ctx_mac`, a MAC copied from another transaction, a TEMP table of the same name; `app_begin` with a replayed signature, an expired or future `issued_at`, a wrong key, a disabled, deleted or unknown user, an extra field, a foreign delegation; the key table and the key functions closed to `pmis_app`. |
| `cases/C4_site_creation.sql` | Site creation (migration 0070, G1 / Q460): `pmis_app` inserting, deleting or updating sites, tasks and site drafts directly, writing the accepted Master header aliases, or calling the one writer `site_create_apply`, the staging, send and decision functions of a New sites batch, the validation function, the applicability wrapper and the Matrix seeding; a caller without the create right, without L1 or without L2 of the Matrix row `site_creation`, or without a step-up (also with a forged step-up setting or a forged user id), calling `site_draft_create`, `_submit` and `_decide`; a draft of another region; no session at all; a landlord or contact field, a duplicate Site ID, an unknown region and a Hot Swap with a scope flag Yes refused at entry; the row seeded to the System Admins and the shape of every function (SECURITY DEFINER, fixed search path, owner `pmis_definer`, PUBLIC revoked). Row-level security of the drafts by region. |

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
-- @actor ADMIN            -- fixture name; the runner starts a verified session context for that user (app_begin, signed with the test key)
-- @region *               -- the regions the context must derive from the data (omit to take the actor's own)
-- @expect error 42501 you cannot change your own status
SELECT idm_set_user_status('{{ADMIN}}', 'suspended', 'Self suspend');
-- @end
```

- **Session context (migration 0069).** The database no longer trusts `app.user_id` or `app.region_ids`. For `@actor X` the runner begins the transaction, reads `txid_current()`, signs the context with the test key (`sign-context.mjs`, through a psql backtick) and calls `app_begin`, as the API does. The test key (`PMIS_SECSUITE_CONTEXT_KEY`, a fixed test value by default) is loaded into `pmis_context_keys` after the migrations.
  - `@region N` means a session whose data-derived regions are exactly N. When the actor's assignments give something else, the runner (as the superuser, outside the case) ends them and adds a temporary assignment for N, takes the table digests, runs the case and restores the assignments afterwards.
  - `@region *`: a System Admin gets `*` from the data; `DEL_ALL` and `DEL_RD` get a temporary all-regions assignment; for anyone else (Alice) `*` is a **forged** setting: the verified context keeps the data-derived regions and the plain `app.region_ids = '*'` is set on top, to show it has no effect.
  - A line `\ctx NAME` in a case body switches the transaction to a verified context for the fixture user NAME (a second person acting in the same transaction, signed with the test key). It replaces the old `SET app.user_id = '...'` in the middle of a case, which the database now ignores.
  - `@actor none` (or no `@actor`) starts no context at all; the plain settings of the case are set as written, to show the database ignores them. A case can also start its own context in its body with `{{SIGN}}` (the path of `sign-context.mjs`): see `cases/C3_session_context.sql`.
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
| SS-01 | The application role holds INSERT on `user_sessions`, so any SQL running as `pmis_app` can insert a live session for any user from a token it chooses. | A guarded session-creation function (migration 0013 and the grants file). The case passes today. |

### REAL FINDINGS (FAIL, not yet in the known-limit list)

| Case | Finding |
|---|---|
| LK-04, LK-05, LK-06 | `auth_local_lookup` returns the row of a **disabled** account (status `disabled`, not deleted, local sign-in still enabled), by e-mail, employee ID and phone. Deleted accounts are excluded (migration 0012 switches local sign-in off). The API hides disabled accounts in its own code, so the database does not enforce what the spec requires. The same function also returns `password_hash` to any caller without a session, so enumerating the 4-digit employee IDs returns the argon2id hash of every active account. Fix: filter `u.status = 'active'` in the function (a migration change, for the database engineer). |

These are reported to tech-lead. The suite does not change the migrations.

## Scope and what is not covered

- The suite covers the database's own refusals. It does not test the API's authorisation, which is in `apps/api/test`.
- It does not prove a forged app-level session cannot reach the database under an unknown SQL injection. It documents the known limits above.
- A compromised API process holds the context key and can sign any user. That is the residual limit of ADR 0003 section 6; the hash-chained audit log and the mails to the admins are the detection. The forged `app.user_id` that this section used to list as a residual limit is closed (cases CX-20 to CX-24).
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
