# ADR 0011: Contract v0.2 (additive extension for the web mock phase)

- Status: Proposed. Needs a read-through by the developer and the product owner's answers to the open points below.
- Related: `contracts/openapi.yaml` 0.2.1; ADR 0001 §6 (contract versioning), 0002 §9b, 0003, 0004, 0005, 0007, 0009, 0010; `docs/spec/staff-registry.md`; CLAUDE.md decisions B9, B11, B12, B12b.

## Context
Contract 0.1 covered phase P1 only. The web app (React, MSW mocks generated from the contract) must show every UI decision in CLAUDE.md before the API exists. Without endpoints for the staff registry, absence and reassignment, registers, templates, generated forms, warehouse, snags, custom fields, notifications, System Log and the dashboard, the mocks would be invented by the web agent, which breaks "contract first".

## Decision
1. Extend the contract to 0.2.0, **additively**: 109 new operations (84 to 193) in 16 new tags, no removed or renamed operation or schema, no new required request field on an existing operation. The "Changes since 0.1" list is in `info.description`.
2. Shapes follow the 0.1 conventions: problem+json, cursor pages (small bounded catalogues return `{ items }`), ETag with `If-Match` on versioned rows, `x-step-up`, `Idempotency-Key` on bulk and job-starting posts, `x-db-path` for the writing function.
3. Small additive edits to 0.1 shapes: `GET /auth/login?identifier=` (ADR 0002 §9b, same 302 either way, 429 when rate limited); `User.mfa_exempt`; `TaskSummary.holder_absent` and `idle_working_days`; `Matrix` stage `kind` and `register_key` (register and Dismantle rows, B11); `Problem.reason`; error codes `freeze_active`, `insufficient_stock`, `role_in_use`; job kinds; `updateRole` also lists 409 and 422.
4. One import-batch resource (`/import-batches`) serves every template (staff registry, holidays, Master, others): upload, row preview with diff, row-wise or all-at-once decisions, undo. `POST /staff-registry/import` and `POST /settings/holidays/import` are entry points that create the same batch.
5. Registers and snags reuse the task transition vocabulary (submit, review, approve, reject) as separate operations, so mocks and permissions map one to one.
6. Local password sign-in is **not** in the contract (deferred, ADR 0002 §10).

## What the developer must review
- **Invented `x-db-path` names** (`people_*`, `ops_*`, `reg_*`, `forms_*`, `wh_*`, `qc_*`, `imp_*`, `admin_*`): proposals for database-engineer, not existing functions.
- **Register field set**: the catalogue returns `fields[]` per register; `data` is an open object. Exact base fields per register come from the Master and the registers spec, still to be written.
- **Dashboard shapes** (`/dashboard/*`) are first drafts built from CLAUDE.md wording. They must be checked against `docs/reference/legacy-dashboard/` in P3 before the API is built.
- **Reassignment**: `act_on_behalf` is modelled as a recorded decision that lets the lead act at the holder's level, logged "lead on behalf of the assignee". The task transitions themselves are unchanged. Reassignment changes the holder of the task's **current level** only.
- **Generated forms**: `snag_list` is included as a `FormKind` because CLAUDE.md lists it among the CW forms. TE forms are not modelled (deferred).
- **Step-up assignment**: required on MFA exemption, freeze lift, holiday delete, weekend days, DLP publish, Document Library publish, form void, form template upload, register void, import undo, and (conditionally) final approval by someone who holds every level. Not required on staff registry edits or holiday create and confirm. Confirm that split.
- **DELETE with a query `reason`** on holidays (no body on DELETE). Alternative: `POST .../delete`.

## Open points (product owner or other agents)
1. ~~Staff registry maintenance: step-up?~~ **Decided 2026-10-25 (owner): yes**, every registry write (create, update, deactivate, reactivate, import, visibility) needs step-up.
2. ~~Holiday import format?~~ **Decided (owner): approved xlsx template only** (`TPL-HOLIDAYS`). The seed CSV is loaded by the seed script, not through the UI.
3. `reassign` of a task with several levels held by the person: only the current level moves in 0.2. Confirm.
4. ~~Idle alert definition?~~ **Decided (owner): any state change or comment counts as activity.**
5. `POST /templates/TPL-MASTER/stamp` and the legacy Master path (ADR 0005 §6) are **not** in 0.2 because Q1 is unanswered.
6. Roles admin needed no new operation: 0.1 already carries `can_hold_matrix_levels`; only error responses were added.
7. Warehouse stock posting happens on DN or RN approval inside the server, so there is no "post movement" operation. Stock adjustments (counts, receipts) are out of scope until the warehouse spec exists.

   - The step-up list in this contract is **approved by the owner** as written.

## Amendment 0.2.1 (2026-10-25, additive)
Three gaps raised by frontend-engineer are resolved:
1. `MatrixAssignee` gains optional `employee_id` (null for role and group holders) and `user_id` (person holders only).
2. The `return_to` allowlist is stated in both `return_to` parameters: `/my-work` (default after login and fallback), `/step-up-done` (step-up popup), plus any same-origin route matching the pattern. A 401 `step_up_url` already includes `return_to`.
3. `ApprovalItem.documents_summary` (`slot_id`, `name`, `status`, `file_count`) removes the extra `GET /tasks/{id}` in Approvals detail.

## Amendment 0.2.2 (2026-10-25, additive)
Owner request: any user with the `export` grant can download the whole project as one Excel file in the Site Master layout, on demand (CLAUDE.md "Full project export to a Master file, on demand").
1. `POST /exports/master` answers 202 with a `Job` of the new kind `master_export` (same `/jobs/{job_id}` polling and `Idempotency-Key` as the other jobs). Optional body: `regions` (a subset of the caller's; outside scope is 422) and `as_of` (date, default now). Needs the `export` grant. Content is scoped by B3 (regions and modules); a System Admin gets everything. When the job is done, `result.export_id` names the export.
2. `GET /exports/master` lists the caller's recent exports: `id`, `created_at`, `status`, `regions`, `row_count`, `expires_at` (plus `job_id` and `as_of`).
3. `GET /exports/master/{export_id}/download` writes the audit row, then answers 302 to the file `GSDN_Site_Master_<date>.xlsx`. It answers 409 while the export is not done and 410 `export_expired` (new error code) after expiry. Retention is the setting `master_export.retention_days`, default 7.
4. The workbook has all sheets and the 187 columns, plus custom fields that carry a Master export column. The same export feeds the parallel-run comparison. Starting an export and every download are audited (ADR 0006).
5. Additive only: a new tag `exports`, three operations, one job kind, one error code, one response (`Gone`). Nothing from 0.2.1 changes. The Master-format sheet builder and the retention purge are API and worker work, not part of this amendment.

## Amendment 0.2.3 (2026-10-25, additive)
Owner request: the export can be full or partial, chosen from a list, and every list screen has an Export button for its current view (CLAUDE.md "Full or partial").
1. `POST /exports/master` gains `parts` (array of part keys; omitted or empty = whole project). Part keys: every register key used by `/registers` (including `dismantle`) plus `sites`, `milestones`, `tasks`, `project_status`. `GET /exports/parts` returns the parts the caller may export (`key`, `label_en`, `label_ar`, `master_sheet`).
2. `view` (`source`, `filters`, `columns`, optional `sort`) exports exactly the current list view. `parts` and `view` are mutually exclusive: both is 422 `validation_failed`.
3. `MasterExport` echoes `parts`/`view` and adds `kind` (`full`, `partial`, `view`). File name: `GSDN_Site_Master_<date>.xlsx` for `full`, `GSDN_<part>_<date>.xlsx` otherwise.
4. Each part keeps the Master sheet and column layout. Content is scoped by B3. The `export` grant is needed for every requested part; the 403 `errors[]` lists the denied parts.
5. **Security: field-level rules (required server test).** The export applies the same field-level rules as the read paths: custom fields and restricted staff fields (phone and email visibility) the caller cannot read are omitted or nulled. System Admin is the only exception. A server test must export as a user with a hidden custom field and a hidden staff phone/email and assert both are absent (full, partial and view), and that a System Admin export contains them.
6. **Security: download.** `GET /exports/master/{export_id}/download` now streams the file with 200, `Content-Disposition: attachment` and `Cache-Control: no-store`, like `/files/{file_id}/download`, and replaces the 302 of amendment 0.2.2 (item 3; 409 and 410 `export_expired` are unchanged). The audit row is still written before streaming. The lint-ignore entry for this operation is removed. No client was built on the 302, so this is recorded as a correction of the same-day amendment, not as a breaking change.
7. Additive otherwise: one operation, three schemas (`ExportPartKey`, `ExportPart`, `ExportView`), optional request fields, one response field. The sheet/column mapping per part is API work.

## Consequences
- The web agent can build every screen against generated mocks; the API is built per tag in later PRs with the same contract.
- The contract is large (193 operations). Each API PR must name the tag it implements, and conformance tests are generated per operation.
- Shapes marked as drafts above may change in 0.3. Those changes are breaking only for operations already implemented; none is implemented yet, so they are recorded in the changelog, not as new ADRs, until the first implementation merges.
