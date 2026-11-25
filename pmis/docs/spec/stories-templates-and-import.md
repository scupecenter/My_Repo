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

## TI-07b Create the sites of the Master that are not in GSDN Workspace (owner request 2026-11-25, Q350; migration 0155, contract 0.15.73)
- **Given** a Master import run whose rows name Site IDs that GSDN Workspace does not hold (for example after a project data reset; the comparison lists them as "Not in GSDN Workspace", reason `site_not_in_pmis`)
  **When** a System Admin, or a person who holds both L1 and L2 of the Matrix row `site_creation`, applies the run with **"Create the sites that are not in GSDN Workspace from the Master"** (AR: «أنشئ المواقع غير الموجودة في النظام من الماستر»)
  **Then** before anything is entered, each such Site ID (its first row in the file) becomes a row of one New sites batch of the run and is created by the path of an approved New sites row: the same validation (`site_new_clean`), the workflow version in force with every task, the scenario applicability, the cluster created in its region when new, and one `site_create` audit row (before empty, after the site) that names the Master run.
  **And** then the task columns and, with the historical load "registers" option, the register sheets are entered as before, the created sites included.
  **And** a Site ID that exists (active, cancelled, voided or deleted, or waiting in a site draft) is never touched: the row is skipped with the reason "This Site ID exists already".
  **And** a row whose identity is not valid is skipped with its reasons (shown in the result of the run and on the New sites batch): nothing is defaulted; a blank or unknown region, a blank delivery scenario, a value outside a list or a scenario and scope conflict refuses the row.
- Who: a System Admin (never a delegate): an admin override (flagged in the audit row) unless the admin also holds both levels; or the holder of both L1 and L2 of `site_creation` in the region of the row, with the Site Master create and approve rights: a self-approval (B5, the step-up of the apply, flagged). Anyone else does not get the option (it is disabled with the reason); the database checks it at the request, at every background step and on every row. A row of a region where the person does not hold both levels is skipped with that reason.
- Big files: when the sites to create plus the sites of the file exceed `imports.async_rows` (default 50), the apply runs in the background: the sites are created 25 per transaction first (the screen shows "Creating the sites of the file: n of N"), then the file is applied. A run stopped meanwhile keeps the sites created so far; its rows not done are closed "not created", and the file can be applied again.
- The New sites batch of the run is processed by the apply only (its send, decisions and discard answer 409 `batch_processing`).

| Master column | New sites field | When missing or invalid |
|---|---|---|
| B Site ID | `site_code` | the row has no Site ID: it is not a site and is not read |
| C Site Owner ID | `owner_site_id` | left empty |
| D Site Name | `name` (English) | **refused**: "The English site name is required." |
| E Region | `region` (name, code or a region alias) | **refused**: required, or unknown region |
| F Sub Region | `sub_region` | left empty |
| G Cluster ID | `cluster_code` (created in the site's region when new; one of another region refuses the row) | left empty |
| H Latitude, I Longitude | `latitude`, `longitude` | both or none; out of range refuses the row; outside Libya is a warning |
| J Site Type | `site_type` (list SiteType) | left empty; a value outside the list refuses the row unless the list allows other values |
| K Site Scenario | `site_scenario` (list SiteScenario) | as Site Type |
| S RF Survey Date | `rf_survey_date` | left empty; an invalid or future date refuses the row |
| X Project Phase, Y Delivery Batch | `project_phase`, `delivery_batch` | left empty |
| Z Delivery Scenario | `delivery_scenario` (list DeliveryScenario) | **refused**: required, or not in the list |
| AA Tower Erection, AB Site Adaption, AC GECOL Power, AD HLC Fiber, AE Full Scope, AF IP Router Only | the six scope flags (Yes, No / N/A, blank) | blank is N/A; another value refuses the row; a Hot or Cold Swap with a scope flag Yes is a scenario conflict |
| AG CW Delivery Model | `cw_delivery_model` | left empty |
| FZ Overall Status | Cancelled only: the site is created, then cancelled (Q466) | any other status is not read (it follows the work) |

Not read at creation: L Site Uplink, M:Q tower data (Tower Owner, Existing or New, RT or GF, Tower Type, Tower Height), R Configuration and T Acquisition Date. They are not fields of the New sites template; in the Master they are formulas over the RF & Design, As-Built and Acquisition sheets, and those registers feed them into the site when the sheets are loaded (the historical load "registers" option). A formula cell is read as the file shows it (its cached value). The Arabic name and the address are not in the Master.

## TI-08 Master-format export for the parallel run
- **Given** the parallel run
  **When** GSDN Workspace exports a Master-format file
  **Then** it is compared automatically with the live Master.
  **And** the differences are listed per site and column.
