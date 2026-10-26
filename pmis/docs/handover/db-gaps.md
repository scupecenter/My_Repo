# DB gaps: contract 0.2.5 and 0.2.6 against the database

For: database-engineer. Date: 2026-10-26.

Checked against `apps/api/prisma/schema.prisma` (75 models) and `db/sql/001` to `008`. Source: `docs/adr/0011-contract-v0.2.md`, Amendment 0.2.5, "Security hardening of 0.2.5" and Amendment 0.2.6. Each item is one line: what is missing, the contract operation that needs it, and a suggested table or column. Names are proposals. Mirror every change in `db/sql/` and a Prisma migration, as HANDOVER section 2 requires.

## Missing

- [ ] Notification types catalogue (25 seeded types: code, category, default recipients, eligible roles, `mandatory`, `immediate`). Needed by `GET /settings/notification-policy/catalogue`. Suggest table `notification_types`, seeded by migration.
- [ ] Notification policy (on/off, thresholds, type x role/group x channel matrix). Needed by `GET/PUT /settings/notification-policy`. Suggest Setting key `notification_policy` (JSON, validated by the API, audited); use table `notification_policy_rules (type_code, target_role_id, target_group_id, in_app, email)` only if the notifier reads the matrix per event.
- [ ] `notifications.type_code` (FK to `notification_types.code`), next to the existing `kind`, which stays for personal preferences. Needed by policy-driven delivery of the 25 types.
- [ ] Security log, append-only: `security_log` (id bigint = chain position, at, event, outcome, user_id, actor_id, `identifier_masked`, client_type, ip inet, user_agent, session_id, request_id, details jsonb, prev_hash char(64), row_hash char(64)). Needed by `GET /security-log`, `POST /security-log/exports`, `GET /security-log/integrity`. Copy the block pattern of `001` (UPDATE, DELETE, TRUNCATE blocked; REVOKE from the app role). Only the masked identifier is stored, never the typed text.
- [ ] Hash chain on `audit_log`: add `seq bigint` (no gaps), `prev_hash char(64)`, `row_hash char(64)`, and a one-row head table `log_chain_heads (log, last_seq, head_hash)` locked `FOR UPDATE` on each insert so chain order is serial. Needed by `GET /audit-log/integrity`. Backfill existing rows in the same migration.
- [ ] Sessions: `user_sessions` (id uuid, user_id, client_type, signed_in_at, last_activity_at, current_screen, ip inet, user_agent, revoked_at, revoked_by, revoke_reason). Needed by `GET /sessions/active`, `POST /sessions/{session_id}/revoke`, `POST /users/{user_id}/sessions/revoke`. Polling (`X-PMIS-Live`) must not write `last_activity_at`.
- [ ] Soft delete: `users.deleted_at timestamptz`, `users.deleted_by uuid` (FK to users), `users.deleted_reason text` (3 to 500 characters). Needed by `POST /users/{user_id}/delete`, `POST /users/{user_id}/restore`, `GET /users/deleted`. `UserStatus` has no deleted or deactivated value: deactivation uses the existing `suspended` or `disabled`, and `holder_account_status` is derived from status and `deleted_at`. Restore duplicates are already refused by the unique constraints on `employee_id` and `email`.
- [ ] Act on behalf: `workflow_steps.on_behalf_kind` and `audit_log.on_behalf_kind` (enum `on_behalf_kind`: `system_admin`, `assignee`; nullable). Needed by `POST /tasks/{task_id}/act-on-behalf`, `WorkflowStep`, `AuditEntry`. The existing `on_behalf_of` stays. `audit_log.action` is free text, so no enum change there.
- [ ] Grants: add `manage_users` and `view_security_log` to the `PermissionAction` enum (schema.prisma line 241 and the matching PostgreSQL type). Needed by sessions, soft delete and the security log screens.
- [ ] `jobs` table, missing entirely. Columns: id, kind (the ten kinds in the contract `Job` schema), status (queued, running, done, failed), progress, created_by, idempotency_key (unique per user), result_file_id, result jsonb, error jsonb, created_at, finished_at. Needed by `POST /security-log/exports` (`security_export`), SLA publish with `apply_to_open_tasks` (`sla_recalculation`) and weights publish (`progress_recalculation`).
- [ ] SLA rule-set versions: `sla_rule_sets` (id, version int unique, status draft or published, effective_from null while draft, effective_to, base_version, reason, created_by, created_at, published_at, published_by). Needed by `/settings/sla-rule-sets` (list, create, get, patch, preview, publish). Add `sla_rules.rule_set_id` (FK; seed rows become version 1). Drafts go in `sla_rule_set_items`, because `sla_rules.effective_from` is NOT NULL and overlapping ranges are excluded; publish writes `sla_rules` rows and closes old ones through `effective_to`, which the `sla_rules_frozen` trigger allows. Reuse `admin_repoint_sla` (004) for open tasks.

## Open questions (decide before the matching item)

- Restore: contract 0.2.5 item 12 says both "re-enables previous assignments" and that delete keeps assignments. If delete keeps them, restore needs nothing more; otherwise store the ids the delete ended.
- Act on behalf, action `review`: the contract allows it, but `WorkflowAction` has no `review` value (only `submit`, `approve`, `reject`). Confirm whether it maps to `submit`.
- Sessions: ADR 0002 must say where the BFF session lives. If it is not Postgres, `user_sessions` is the admin view and must be updated on revoke.
- Notification matrix: table or Setting JSON (decide with the notifier owner).

## Exists (no work)

- Delegation to user, role or group: `delegations.target_kind`, `target_user_id`, `target_role_id`, `target_group_id`, `allow_redelegate`, `delegation_regions`, `delegation_grants (module_key, action)`, `is_full`. Contract `region_codes` and `module_codes` map to these.
- Log retention: generic `settings` table; keys `log_retention.system_log_days` (minimum 90) and `log_retention.security_log_days` (minimum 365). The `SystemLog` comment still says a fixed 12-month purge: the purge job must read the setting.
- Weight set publish: `weight_sets` has status, effective_from/to, reason, changed_by, published_at. `005` freezes published sets, allows closing one through `effective_to`, and runs the 100% check on published sets only, so drafts may be saved with other totals. `is_active` is derived.
- Export column codes: `master_export_column` on field definitions, stage definitions and phase gate rules, plus `in_exports`. The codes are an API mapping.
- Self-grant refusal: `idm_beneficiary_backstop` (008) covers assignments, group members, delegations, permission grants and field permissions. Copying assignments writes through `user_role_assignments`, so it is covered.
- Last admin guard: `idm_last_admin_check` (008).
- Audit log append-only: `audit_log_block_mutation` (001).
- Holder alerts (`GET /reassignments/alerts`, cause `holder_deactivated`): derived from users and workflow holders; no table.
- Typed confirmation, settings validation and step-up: API only, no schema.

## Outside this checklist (earlier amendments, not checked in detail)

- `users.mfa_exempt` (Amendment 0.2.1; CLAUDE.md MFA exemption): missing.
- `exports` table for `master_export` (Amendments 0.2.2 and 0.2.3, `expires_at`, retention): missing.
