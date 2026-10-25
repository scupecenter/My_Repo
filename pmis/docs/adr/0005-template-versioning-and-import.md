# ADR 0005: Template versioning and import

- Status: Proposed. Item 6 (legacy Master path) depends on the owner's answer to open question Q1.
- Related: CLAUDE.md "Approved templates only", data entry, "Custom fields" (templates regenerate); stories TI-01..TI-08; schema `template_definitions`, `template_versions`, `import_batches`, `import_batch_rows`; `tools/master-import/mapping.csv`.

## Context
Every upload must be a template the system issued, with its ID and version embedded in a hidden sheet `_tpl`. A file without a valid ID and version is rejected, and the rejection is written to the System Log. Uploads go through batch → review → approve, with a diff preview. The real Master has no `_tpl` sheet (Q1), but it must be importable for the migration and the one-month parallel run. Templates regenerate when custom fields change, and older versions are rejected with a clear message.

## Decision
1. **Identity.**
   - `template_definitions.template_id` (for example `TPL-SITE`, `TPL-GECOL`, `TPL-ROLES`) is stable.
   - `template_versions.version` is an integer, shown as "v3". The prototype's "v1.0" strings are display only.
   - Exactly one version per template is `is_current`.
2. **The `_tpl` sheet.**
   - It is generated with ExcelJS and is `veryHidden`.
   - It holds these key/value cells: `template_id`, `version`, `header_checksum`, `issued_at`, `issued_by` (user id), and, for pre-filled copies, `scope` (site codes hash).
   - The workbook structure is protected and header cells are locked. Lists come from settings and appear as data validations.
3. **Checksum.**
   - `header_checksum` = SHA-256 of the canonical header: for each data sheet in order, the sheet name, then each header cell (trimmed, NFC-normalised, lower case), joined with `\u001f`.
   - It is stored on `template_versions` and recomputed from the uploaded file.
   - A mismatch means the structure was edited, and the file is rejected.
   - The `_tpl` cells are not trusted on their own; the checksum of the actual headers must match.
4. **Validation order on upload.** The first failure rejects the whole file:
   1. size and row limits (settings);
   2. `_tpl` is present;
   3. `template_id` is known and active;
   4. the version equals the current version (no grace period, per CLAUDE.md; this supersedes the TI-02 assumption). The message names both versions and links to the download;
   5. the template is the one the user selected, or the one placed on the task;
   6. the checksum matches;
   7. the user has `import` on the target module.

   Every rejection writes a `system_log` row (`source = template-check`, the reason, the file SHA-256, and the user). The response is 422 with `code = template_rejected` and a `reason` from a closed list.
5. **Batch and diff.**
   - A file that passes becomes an `import_batches` row (`status = validated`). Its rows are parsed into `import_batch_rows`, with `action` (create, update, unchanged, error), `diff` (field → {old, new}) and `errors` (sheet, row, column, code).
   - Calculated Master columns are never read: `mapping.csv` marks them, and the parser skips any column without a `target_field`.
   - Cells in locked steps are held with `pending_previous_approval`.
   - Nothing reaches the target tables until a row is approved (ADR 0004 §9).
   - An "Undo batch" is an admin override that uses the stored before values.
6. **Legacy Master path (Q1). Proposed default, pending the owner:**
   - The normal path is the template `TPL-MASTER`. The PMIS can **stamp** a user's copy of the live Master: the user uploads it once to `POST /templates/TPL-MASTER/stamp`, and the system returns the same workbook with `_tpl` added. Later uploads then follow item 4 with no exception.
   - Until that happens, there is an **admin-only legacy path**:
     - it accepts a file without `_tpl` only if it matches the known Master fingerprint (`TPL-MASTER-LEGACY`). The fingerprint is a subset match, not a checksum: every required sheet name, and every header in `mapping.csv` that has a `target_field`, must be present by name. Extra columns are ignored;
     - it is open only while the setting `legacy_master_import_until` (a date covering the migration and the parallel run) is in the future;
     - it needs step-up;
     - every use writes the System Log and an audit row with `privileged = true`.
   - The legacy path still creates a batch that goes through review and approval.
7. **Regeneration when fields change** (ADR 0009). The column spec of a template is built from its base columns plus the active custom fields marked "appears in templates".
   - Publishing a change to those fields publishes a new template version in the same transaction (version + 1, new checksum, the previous one `is_current = false`) and notifies the users who downloaded the old version within 30 days.
   - Batches already validated against an older version continue, because they were validated against it.
8. **Master-format export (TI-08).** It uses the same column map in reverse: the 187 columns in their order, then the custom fields marked for Master export at their configured column (ADR 0009). The parallel-run comparator compares only the columns that exist in the live Master.
9. **Libraries.**
   - ExcelJS for writing and reading `.xlsx`.
   - SheetJS (community build, run in a worker thread) for reading `.xlsb` Master files only.
   - Parsing runs in the BullMQ worker. The API stores the file in MinIO (`imports/` prefix, ADR 0008) and returns 202 with the batch id.

## Consequences
- Older template versions are rejected outright, which is strict. Users must re-download after any field change, so the message has to be clear and carry the download link.
- The stamp action removes the long-term need for the legacy path. The legacy path is time-boxed and loud.
- The header checksum makes "adding a column to the file does not break the upload" (TI-03) true only for the legacy Master fingerprint, which ignores unknown trailing columns. Issued templates are strict on purpose. Inconsistency I-10 in the gate report.
