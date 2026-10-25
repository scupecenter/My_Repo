# ADR 0006: The Audit Log and the System Log

- Status: Accepted (tech-lead). Item 3 adds columns: request to database-engineer.
- Related: CLAUDE.md "The Audit Log records every user action…", non-functional requirements (audit 10 years, system log 12 months); stories LG-01..LG-05; migration 0002; schema `audit_log`, `system_log`.

## Context
The Audit Log records every user action with before and after values. It is append-only, nobody can edit it, and it is kept for 10 years and never deleted. The System/Error Log is separate and is purged after 12 months. Migration 0002 already blocks UPDATE, DELETE and TRUNCATE with triggers and REVOKE. The stories need a batch or bulk-action id, a "privileged" flag, step-up and MFA chips, and a delegate's "on behalf of".

## Decision
1. **What is audited (audit_log).** Every state-changing request, plus these reads with consequences: file downloads, zip exports, audit-log exports, and break-glass sign-in. Also sign-in, sign-out and step-up success.
   - One row is written per changed entity. Bulk actions write one row per item, all sharing `bulk_action_id`.
   - `before` and `after` hold only the changed fields (a field-level diff). Creates have `before = null`.
   - Hidden-field rules (ADR 0003) apply when the log is **read**, never when it is written.
2. **Written in the same transaction** as the change, through one `AuditService.record()` in the API, or inside the identity functions (ADR 0003). If the audit insert fails, the change fails. There is no fire-and-forget path.
3. **Columns to add to `audit_log`** (request to database-engineer):
   - `bulk_action_id uuid`;
   - `batch_id uuid`;
   - `module_key text`;
   - `privileged boolean` (break-glass, admin override, admin self-target);
   - `stepup_verified boolean`;
   - `mfa boolean` (from the session's `amr`);
   - `self_approval boolean`;
   - `prev_hash bytea` and `row_hash bytea` (item 4).
   Keep `on_behalf_of`, `reason`, `is_admin_override`, `ip`, `user_agent` and `request_id`.
4. **Tamper evidence.**
   - A BEFORE INSERT trigger computes `row_hash = sha256(prev_hash || canonical_json(row without hashes))` under a transaction-level advisory lock. This serialises audit inserts, which is acceptable at about 100 users.
   - A nightly job verifies the chain and writes the day's last hash to the System Log and to the backup manifest.
   - A broken chain raises a critical System Log entry and emails the System Admins.
5. **Immutability.** Keep the triggers and REVOKE from migration 0002. In addition:
   - the table is owned by a role the app never connects as;
   - `pmis_app` keeps only `INSERT` and `SELECT`;
   - the purge job's role has no grant on `audit_log`;
   - the table is range-partitioned by year to make 10 years of data manageable, and each partition inherits the triggers.
   - Backups include it, and nothing ever truncates it.
6. **Reading.**
   - `GET /audit-log` needs the grid action "see the audit log" (seeded for System Admins and the Project Manager).
   - Rows are filtered by the reader's regions for that module. Rows with no region (configuration, identity) are visible only to readers with all regions.
   - The list uses cursor pagination on `id` and filters by date, actor, site, entity, action and text.
   - A CSV export runs as a job, and the export itself writes an audit row (LG-03).
   - There is no edit or delete endpoint, and none will ever be added.
7. **System Log (`system_log`).**
   - It holds technical events: rejected template uploads, authentication and MFA refusals, break-glass attempts, job failures, email failures, caught UI errors (`POST /client-errors`, rate-limited), and hash-chain checks.
   - Fields: level, source, message, context (JSON, scrubbed of tokens and passwords) and `request_id`, the correlation id that is also returned to clients as `X-Request-Id`.
   - It is never written to the audit log. The two logs share only `request_id`.
   - It is partitioned by month, and a nightly job drops partitions older than 12 months.
   - The application's own stdout logs are JSON and go to the server's log rotation, outside the database.
8. **Delegates.** `actor_id` = the delegate and `on_behalf_of` = the delegating admin. The UI renders "X on behalf of System Admin".

## Consequences
- An audit failure blocks the action. This is intended, and it is monitored.
- The hash chain adds one serialised insert point. It is acceptable for the target load. If needed, it can later move to per-partition chains.
- Region filtering on reads means a regional manager sees only their own sites' history. Configuration history is admin-only.
