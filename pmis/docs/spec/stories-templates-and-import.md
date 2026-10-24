# Stories: templates and import

Sources:
- CLAUDE.md, "Approved templates only" and data entry.
- BP §04: template, batch and duplicate check.
- BP §17: Master import and column map.
- CLAUDE.md "Rollout": the parallel-run comparison.

## TI-01 Issue an approved template
- **Given** a template defined on the Templates page (ID, name, version, scope)
  **When** a user downloads it, either beside a task or from the Templates page
  **Then** the file contains a hidden sheet `_tpl` with `template_id` and `version`.
  **And** its header cells are locked.
  **And** it has drop-down lists for the allowed values and an instructions sheet.
- **Given** a request for a pre-filled copy for selected sites
  **When** the file is generated
  **Then** it is built from the current settings and contains those sites (BP §04).

## TI-02 Reject unapproved files
- **Given** an uploaded file without `_tpl`, with an unknown `template_id`, or with a version that is retired
  **When** it is uploaded
  **Then** it is rejected with a reason and the rejection is written to the System Log.
- ASSUMPTION: a superseded version is still accepted for a grace period of 14 days (configurable).

## TI-03 Master upload as an approved template
- **Given** the Master file (xlsx or xlsb) that carries an embedded template ID such as `TPL-MASTER`
  **When** it is uploaded
  **Then** sheets are recognised by their names and columns by the names in their header rows.
  **And** the calculated columns are never read: the grey headers plus EZ, Site Calc, the SLA sheet and Baseline Proposal (BP §17).
  **And** adding a column to the file does not break the upload.
- The real Master has no `_tpl` sheet today. See open-questions Q1.

## TI-04 Validation and the rejected-rows report
- **Given** a batch
  **When** it is validated with the same rules as manual entry
  **Then** a row is excluded if its site does not exist, a date is invalid, or a value is not in the allowed list. The report gives the sheet, row and column for each.
  **And** the valid rows continue.
- **Given** a cell that falls in a locked step
  **When** it is validated
  **Then** it is held "pending previous approval" and is released automatically when that approval exists (BP §04).

## TI-05 Diff preview
- **Given** a validated batch
  **When** the uploader opens the preview
  **Then** every row is classified as new, changed or identical.
  **And** changed rows show the field, the old value and the new value.
  **And** identical rows are skipped.
- **Given** that the preview is confirmed
  **When** the uploader submits
  **Then** the batch gets a Batch ID and enters review. It then follows WF-08.

## TI-06 Limits and undo
- **Given** limits for file size and row count set in settings
  **When** a file exceeds them
  **Then** it is refused.
- **Given** an approved batch
  **When** an admin uses "undo batch"
  **Then** this is treated as an admin override (WF-09): a reason is required, and the before values are restored.

## TI-07 First migration from the Master
- **Given** the real Master
  **When** it is imported for the first time
  **Then** registers are loaded first (RF & Design first, then the others), then the Master.
  **And** the values are tagged "migrated from Master".
  **And** violations go to a separate quality report (BP §17).
- Acceptance: 100% of the milestone dates match the Master (CLAUDE.md "Rollout").

## TI-08 Master-format export for the parallel run
- **Given** the parallel run
  **When** the PMIS exports a Master-format file
  **Then** it is compared automatically with the live Master.
  **And** the differences are listed per site and column.
