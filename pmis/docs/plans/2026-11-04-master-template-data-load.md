# Plan: loading the owner's "Site Master Template" file into GSDN Workspace (2026-11-04)

**Update 2026-11-05 (Q462):** gap G5 (no documents for the historical tasks) is decided and built as option (c) with a stricter shape: a one-time, time-boxed, System Admin only **historical-load waiver** (migration 0073, contract 0.14.3, CHANGELOG 102; `technical-decisions-2026-11-04.md`). While it is open, the admin marks the P3 apply or a stream-template batch "accept without documents"; the mandatory-document check is skipped only for rows whose actual date is on or before a cutoff date; the tasks are flagged "Admin override", audited and left out of the SLA and on-time figures like any override; the documents can be uploaded later and clear the flag. Every other check still runs, so Q351 holds for dates, gates, predecessors and holders. Step 10 of the load order (the documents of the historical tasks) is therefore optional and can follow the load.

**Update 2026-11-05:** gaps G1 (site creation, manual and bulk), G2 (header alias for CL3), G8 (the Site Scenario list) and G9 (the Arabic site name) are built (migration 0070, contract 0.14.0, CHANGELOG 98; owner questions Q470 to Q475). Step 1 of the load order (3.2) now has its path: the template `TPL-SITE-NEW`, one batch, L2 of the Matrix row `site_creation`. The rest of this plan is unchanged.

**Status (as written on 2026-11-04):** analysis only. No code changed, nothing committed. The uploaded file is real project data. It stays outside the repository; this plan holds counts and cell addresses only (no names, phones, e-mails, Site IDs, company names or other record values).

**Input:** `GSDN_Site_Master_Template.xlsx`, uploaded by the product owner on 2026-11-04 with the request "study the file and determine how the data will be loaded into the system". The file was read read-only with openpyxl (`python3 -I`, scripts kept outside the upload folder); no macro or formula was run.

**Compared with:** `GSDN_Site_Master.xlsx` (repository root, 23 sheets, 187 Master columns); `CLAUDE.md`; `docs/spec/registers-and-streams.md`, `stories-templates-and-import.md`, `task-catalogue.csv`, `technical-decisions-2026-11-04.md`; migrations 0019, 0025, 0027, 0037, 0049 to 0051, 0053, 0057, 0060; `apps/api/src/master-import/`, `apps/api/src/templates/`, `apps/api/src/registers/`; `tools/master-import/mapping.csv`.

**Rule kept throughout:** CLAUDE.md "Real data is uploaded through the system after it is complete". This plan describes the load for that moment and the work needed before it. Q351 also applies: historical dates go through the same checks as live data, and there is no "accept without workflow" for the one-time load.

---

## 0. Summary

1. **What the file is.** It is a cut-down, values-only copy of the Site Master: 10 sheets instead of 23, holding **real data for 469 sites**. It is not blank. It has **no formulas** in any data cell (every calculated column of the reference is either empty or a pasted value), **no `_tpl` sheet** (it is not a PMIS-issued template), one **external workbook link**, and 263 broken defined names. History stops at CW PAC: every TE, On-Air, acceptance, HOTO, closure, Dismantle and Issue column of the Master sheet is empty.
2. **Can it be loaded today?** No. Five blockers, in the order they are hit:
   - B1. The upload guard refuses the package because of `xl/externalLinks/` (`xlsx-guard.ts`, reason `macros_not_allowed`).
   - B2. P3 then refuses it because typed column CL is renamed ("IP Router" instead of "Indoor IP Router"), reason `structure_mismatch`.
   - B3. **GSDN Workspace has no way to create a site** (no `POST /sites`, no site template; Q350: P3 never creates a site). With no sites, every row is `site_not_in_pmis`.
   - B4. **Stage 1 has no dates** (TSSR Submitted / Approved, LLD Approved and SAR are empty or absent), so Site Release (MS1) cannot be derived. Gate W stays closed and every PRE-CW and CW row of the Master would be held `gate_locked` (Q208).
   - B5. Historical tasks carry **no documents**, and submit requires the mandatory slots (B6 layout, B7 approval email and CW DN, B8 / B9 MOS proof, B13 PAC certificate, and others).
3. **Recommended path:** prepare the settings (section 3.1). Create the 469 sites through a new bulk "New site" template (gap G1). Load the register sheets through GSDN Workspace-issued register templates (TPL-RF, TPL-ACQ, TPL-PRM, TPL-PO, TPL-GECOL, TPL-HLC, TPL-ASB, TPL-RSK). Each upload is one batch that goes to L2. Then load the Master sheet through the P3 legacy import: preview, comparison report, apply in `submit` mode, one batch per stream, L2 decides. During the parallel run, P3 is used in preview mode only.
4. **Owner questions:** Q460 to Q469 (section 6).

---

## 1. Structure of the file

### 1.1 Package

| Item | Finding |
|---|---|
| Size | 1.07 MB zipped, 100 package parts, 7.4 MB unzipped (inside the guard limits: 500 parts, 40 MB) |
| Macros, ActiveX, embedded objects | None |
| External links | **1** (`xl/externalLinks/externalLink1.xml`), pointing at an `.xlsb` copy of the Master on a user's PC. No formula and no defined name uses it (it is orphaned), but the guard refuses the whole file because the part exists. |
| `_tpl` sheet | **Absent.** The file carries no `template_id` or `version`. It is not a PMIS-issued template, so the Templates upload rejects it (CLAUDE.md "Approved templates only"; R8). Only the admin legacy path (P3, Q1) can read it. |
| Hidden sheets | None. All 10 sheets are visible. |
| Hidden columns | One filter-helper column each on RF & Design (BF), Acquisition (AE), Permission Log (Q), GECOL (W), HLC (O) and PR-PO (M). They hold `SUBTOTAL` formulas only. |
| Sheet protection | None |
| Defined names | 494, of which **263 point to `#REF!`** (left over from the 13 removed sheets). Harmless for the load; it shows the file was cut down from the full Master. |
| Excel tables | Only Risk Register (`tblRiskRegister`) and Setting (75 list tables). The reference's data tables (`tblRF`, `tblCandidates`, `tblOrders` and the others) are gone; the data sits in plain ranges. |
| Personal data in package metadata | The workbook and the external link carry a local Windows user path. It is not copied here. |

### 1.2 Sheets: upload against the reference

| Upload sheet | Reference sheet | Header rows | Data from row | Rows with data (rows with a key) | Columns (upload / reference) |
|---|---|---|---|---|---|
| Master | Master | 1–3 (group, sub-group, name); row 4 `SUBTOTAL` | 5 | **469 sites** (B5:B504 range, 500 numbered rows) | 187 / 187 |
| RF & Design | RF & Design | 1; row 2 `SUBTOTAL` | 3 | 475 | 55 + note + helper / 52 |
| Acquisition | Acquisition | 1; row 2 `SUBTOTAL` | 3 | 474 (one row per site) | 28 + note + helper / 34 |
| Permission Log | Permits & HSE (renamed and reshaped) | 1; row 2 `SUBTOTAL` | 3 | 255 | 14 + note + helper / 22 |
| As-Built | As-Built | 1–3; row 4 `SUBTOTAL` | 5 | 332 | 63 / 67 |
| GECOL | GECOL | 1; row 2 `SUBTOTAL` | 3 | 241 | 20 + note + helper / 19 |
| HLC | HLC | 1; row 2 `SUBTOTAL` | 3 | 114 | 12 + note + helper / 13 |
| PR-PO | PR-PO (`tblOrders` only) | 1; row 2 `SUBTOTAL` | 3 | 650 orders on 398 sites | 12 / 30 (orders 15, contractors 8, teams 5) |
| Risk Register | Risk Register | 1 (reference: 2) | 2 | 25 | 18 / 18 |
| Setting | Setting | 1–2 | 3 | 75 list tables; Staff and Holidays **empty** | 166 / 166 |

**Reference sheets missing from the upload (14):** Guide, Dashboard, Project Status, Progress & Plan, WH, WH Serials, Permits & HSE (replaced by Permission Log), Data Quality, Quality Inspections, Change Control, Readiness & Handover, SLA, Baseline, Site Calc. **Added (1):** Permission Log. The sheet order also differs: Permission Log and As-Built come before GECOL.

### 1.3 Column differences

**Master.** Same 187 columns, letters and header rows as the reference, with one exception: **CL3 is "IP Router"; the reference and `master_columns` have "Indoor IP Router"**. Row 4 sums to row 536 instead of 504. There are 25 data validations instead of 18, and several now hold typed lists instead of named lists. All 187 columns are typed values. The calculated columns of the reference (V, W, AH:AL, AV:AX, BO:BQ, BW:CB, CE, CT:CV, CZ, DG:DI, DO:DQ, EK:EN, EQ:EZ, FA, FB, FF, FG, FK:FM, FX:FZ) are empty, except R (Configuration) and AL (CW Access Date), which hold pasted values.

**RF & Design** (every column from W onward is shifted):
- Added (6): Coverage Objective, RF Survey Plan Date, RF Survey Report Ref, Candidate Approval Date, Candidate Approved By, Busbar Height (m).
- Missing (3): TSSR Rev No., Frequency License Date, Frequency License Ref.
- Renamed (2): "Nominal Plan Issue Date (RFNP)", "TSSR Approved Date (RFTS)".

**Acquisition:**
- Missing (9): Candidate Submitted Date (SAR), MW LOS Check, Test Pit Result, Selection Date, Lease Termination Notice Date, Site Handback Date, Feeds Master, and the two helpers.
- Added (3): Rejection Reason, Visit Restrictions / Access Notes, Contract Copy (file ref).

**PR-PO:**
- Missing: Delivery, Team, PR→PO (wd), Check, and the whole Contractors and Teams tables.
- Added: Region.
- Renamed: "PO No." (was "PO / WO No."), "PO Date" (was "PO / WO Date"), "Status" (was "Order Status").

**GECOL:** added Survey Requested (G); every later column moves one letter to the right.

**HLC:**
- Renamed: Termination Point (was Fiber Uplink).
- Added: No. of Sites on Link.
- Missing: Internal Fiber Team, Status.

**Permission Log against Permits & HSE:**
- Common: Type, Applied / Requested, Status, Valid From ("Approved / Valid From"), Valid To ("Expiry Date"), Validity.
- Added: Issued By / Authority, Reference No., Days Remaining, Days to Approve (wd), Contact / Visit Restrictions.
- Missing: N/A Reason, N/A Approved By, Remark, the 7 HSE / PTW checks, Stop Work, Stop Lifted Date, HSE Valid Date.

**As-Built:** three header rows instead of one. A new "Submitted with PAC" column sits at AI, so every TE column moves one letter to the right (WL Vendor is AK, not AJ). The four Patch Cord columns are missing.

**Risk Register:** same columns; the header sits on row 1 instead of row 2.

### 1.4 What the data covers

| Area | Filled | Empty |
|---|---|---|
| Master identity C:T | C:F, H:T for all 469 sites (S 426, T 426) | G Cluster ID |
| Master baseline / milestones | none | U and every milestone and gate column |
| Master scope X:AG | X, Z, AA, AE, AF for all; Y 383; AB 410; AC 29; AD 29 | AG CW Delivery Model (469 blank) |
| Master PRE-CW and CW (AL:BV) | 373 to 436 sites per column | AT, AU (CW DN), BU |
| Master TE and later (CB:GE) | none | all |
| RF & Design | identity, tower, RF Survey Actual (346), civil inputs, topology | nominal plan, search ring, cluster, sectors, azimuths, TSS / TSSR, MW LOS, LLD, HLD |
| Acquisition | selected (410, all "Yes"), landlord, contact (409), phone (409), e-mail (410), contract no. (408), sign-off (225), completed (225), status (474) | candidate letter, SAR, LOS, test pit, selection date, lease dates |
| Permission Log | 255 rows, all "Access - CW", "Approved", open-ended, with Valid From | authority, reference, applied date, expiry |
| As-Built | TE configuration of 332 sites | all 31 CW quantities (D:AH), backup time, D.G |
| GECOL | status (241), installation finish (231), remark (231) | PR No., contractor, survey to billing (all other dates) |
| HLC | request date (108), installation (42), fiber status (31), termination point (39) | request no., TX test |
| PR-PO | scope (650), PR date (530), PO date (471), contractor (432), PR No. (257), status (21) | PO No. (all blank) |

---

## 2. Mapping: sheet and column to PMIS target

Legend: **site** = `sites` column. **task X.f** = `template_task_fields` row of task X (migration 0051, 0060). **reg k.f** = `register_fields` of register k. **list** = list catalogue code (0057). **calc** = calculated, never imported. **none** = no target today.

### 2.1 Master sheet (P3 legacy import; `master_columns.owner` from 0051)

| Master columns | Target | Loaded by P3 apply? | Notes |
|---|---|---|---|
| A | calc (row number) | no | |
| B | site `site_code` (key) | match only | Q350: P3 never creates a site |
| C:Q, S | identity, owned by RF & Design (D46): site `owner_site_id`, `name`, `region_id` (region alias), `sub_region`, `latitude`, `longitude`, `site_type` (list SiteType), `site_scenario`, `uplink_site`, `tower_owner` (TowerOwner), `existing_or_new` (ExistNew), `rt_or_gf` (RTGF), `tower_type` (TowerType), `tower_height_m`, `rf_survey_date` | no (`owned_elsewhere` in the report) | They are loaded through RF & Design (2.2). The Master's typed values differ from RF & Design in several columns (5.5). |
| G | site `cluster_id` (clusters) | no | Empty in the file |
| R | calc (from As-Built) | no | Pasted value in the file |
| T | identity: Acquisition Completed Date of the selected candidate | no | |
| U | baseline (`baseline_entries` S01) | no | Empty |
| V, W, AV:AX, BO:BQ, BW:CB, CT:CV, DO:DQ, EK:EN, ER:ET, EX:EZ, FL, FM | calc (milestones, gates, baselines) | no | Empty |
| X, Y, Z, AA:AF, AG | scope: site `project_phase`, `delivery_batch`, `delivery_scenario` (DeliveryScenario), `scope_*` flags (YesNA), `cw_delivery_model` | **no** (P3 writes task columns only) | No path today (gap G1) |
| AH:AK | calc (from PR-PO and Contractors) | no | Empty |
| AL | calc (from Permits: Access - CW Valid From, task B3) | no | Typed in the file (382) |
| AM, AN, AO | task B4 `v:aat_se_name`, `planned_date`, `actual_date` | yes | |
| AP, AQ | task B5 `v:analysis_type`, `v:analysis_result` | yes | |
| **AR, AS** | `master_columns` owner `task`, **no `template_task_fields` row** | **no** | The catalogue reads them as B6 Layout Submitted and B7 Layout Approved; the old `mapping.csv` reads them as STA submitted and approved (Q467) |
| AT, AU | task B7 `submitted_date`, `approved_date` (read-only, set by the workflow) | no | Empty |
| AY, AZ | task B8 or B9 `planned_date`, `actual_date` (scenario- and scope-aware, Q205) | yes | |
| BA:BC | task B10 tower items (CompletionStatus) | yes | |
| BD:BJ | task B11 adaption items (CompletionStatus) | yes | 33 cells outside the list (5.3) |
| BK:BN | task B10 or B11 planned / actual start and end (earliest / latest projection) | yes | BK is read-only |
| BR, BS, BT, BV | task B13 `planned_date`, `v:snags_found`, `v:snags_cleared` (Yes / N/A), `actual_date` | yes | |
| BU | reg as_built `cw_as_built_submitted` | no | Empty |
| CC:FJ | tasks D2 to D18, F1, F2, D17, B15 (0051 list) | yes | **All empty in this file** |
| FN:FW | Dismantle register (TPL-DIS) | no | Empty |
| FX:FZ | calc | no | Empty |
| GA:GE | Issue Log projection (`mx_issue_cells`) | no | Empty |

### 2.2 Register sheets (no P3 path: Q352, register sheets are checked for structure only)

The target template is GSDN Workspace-issued template of the register (0037). The key is its natural key (`template_definitions.match_keys`).

**RF & Design → TPL-RF** (`rf_design`, key Site ID):

| Upload column | Target |
|---|---|
| C, F, G, H, L:P | reg `site_owner_id`, `sub_region`, `latitude`, `longitude`, `tower_owner`, `existing_or_new`, `rt_or_gf`, `tower_type`, `tower_height` |
| D, E | the site's own Site Name and Region |
| I | `site_type` (list SiteType) |
| J | `site_scenario`. **The list conflicts:** 0057 links it to the DeliveryScenario catalogue (New Build, ...), while the Master list `tblScenario` is Indoor / Outdoor (Q464). |
| K | calc (uplink = MW far-end, D30) |
| Q:U | `nominal_plan_issue_date`, `nominal_latitude`, `nominal_longitude`, `search_ring_radius`, `search_ring_received` |
| V | calc |
| X:AB | `cluster_id`, `antenna_height`, `sectors`, `azimuths`, `tilt` |
| AD | `rf_survey_actual_date` |
| AF | calc (approved candidate) |
| AI:AN | `tss_plan`, `tss_actual`, `tssr_submitted`, `tssr_approved`, `tssr_status` (ReviewStatus), `rf_data_sheet_issued` |
| AO | `mw_los_survey_date` |
| AP | calc (LOS result) |
| AQ, AR | `mw_far_end_site`, `link_budget_date` |
| AS | `building_height` |
| AU:BC | `cabinet_foundation` (ExistNew), `cabinet_foundation_dims`, `backup_site`, `belong_to_fn`, `primary_mfn`, `secondary_mfn`, `hld_ref`, `lld_approved_date`, `remark` |
| **No target** | W Coverage Objective, AC RF Survey Plan Date, AE RF Survey Report Ref, AG Candidate Approval Date, AH Candidate Approved By, AT Busbar Height |

**Acquisition → TPL-ACQ** (`acquisition`, key Site ID + Candidate):

| Upload column | Target |
|---|---|
| E | `candidate` (required, list Candidate; **blank in all 474 rows**) |
| F, G, H | `latitude`, `longitude`, `address` |
| I, J | calc |
| K | `tss_date` |
| L | `selected` (YesNo). Selected = Yes requires a Selection Date, which the file does not have. |
| N, O, P, Q, R | `owner_landlord`, `ownership_type` (Ownership), `contact_person`, `phone`, `email` (personal data: field visibility rules) |
| S:W | `negotiation_start_date`, `contract_no`, `contract_signoff_date`, `lease_expiry_date`, `title_verified` (YesNo; the file uses YesNoNA) |
| Z, AA | calc (D35) |
| AB | `remark` |
| **No target** | M Rejection Reason, X Visit Restrictions / Access Notes, Y Contract Copy (file ref): a file reference is not an upload (Q111) |

**Permission Log → TPL-PRM** (`permits_hse`, key Site ID + Type + Valid From):

| Upload column | Target |
|---|---|
| D | `permit_type` (PAType) |
| G | `applied_date` |
| H | `status` (PAStatus) |
| I | `valid_from` |
| J | `valid_to` |
| L | "Open-ended" becomes `has_expiry` = No (transform) |
| K, M | calc |
| **No target** | E Issued By / Authority, F Reference No., N Contact / Visit Restrictions |

`permit_stream` (0054) is derived from the type.

**PR-PO → TPL-PO** (`procurement`, key Site ID + Scope + PR No., else PO / WO No.):

| Upload column | Target |
|---|---|
| E | `scope` (ProcScope, critical) |
| F, G | `pr_no`, `pr_date` |
| H, I | `po_wo_no`, `po_wo_date` |
| J | the company of the order's team: external party from the Contractors register; a typed name is not a link |
| K | `order_status` (ProcStatus, required) |
| L | `remark` |
| C, D | calc |
| **Missing from the file** | `delivery` (critical), `team_id` |

**GECOL → TPL-GECOL** (`gecol`, key Site ID):

| Upload column | Target |
|---|---|
| E | `pr_no` (required) |
| F | `contractor` |
| H:R | `survey_date`, `layout_received`, `layout_approved`, `notice_date`, `mos_date`, `installation_finish`, `aat_acceptance_date`, `docs_approval_date`, `meter_no`, `power_on_date`, `billing_conversion_date` |
| T | `remark` |
| S Status | calc (no field) |
| **No target** | G Survey Requested. **Missing:** `request_date` (required). |

**HLC → TPL-HLC** (`hlc`, key Site ID):

| Upload column | Target |
|---|---|
| E, F | `request_no` (required), `request_date` (required) |
| G | `fiber_uplink` (renamed header) |
| I | `fiber_status` (FiberStatus) |
| J, K | `installation_date`, `tx_link_tested_date` |
| L | `remark` |
| **No target** | H No. of Sites on Link |

**As-Built → TPL-ASB** (`as_built`, key Site ID):

| Upload column | Target |
|---|---|
| D:AH | CW quantity items `q_<code>` (`as_built_items`, 0027), linked to the item's Master column. All empty. |
| AI Submitted with PAC | `cw_as_built_submitted` (YesNA; the file uses YesNo) |
| AJ | `configuration` |
| AK:BL | the TE fields of 0027, and the items SECTOR_QTY, MW_ANTENNA_QTY and ROUTER_QTY. RF Height uses the number field plus `rf_height_note` (D108b). |

The template is matched by its own headers. The file's columns are one letter to the right of the item `master_column` values (AK and so on), which only matters for the Master-format export.

**Risk Register → TPL-RSK** (`risks`, key Risk ID):

| Upload column | Target |
|---|---|
| A:G | `risk_id`, `risk_statement`, `category` (RiskCat), `scope` (ScopeCWTE), `affected_sites`, `probability`, `impact` |
| H, I | calc (score and level) |
| J:R | `response`, `mitigation_action`, `risk_owner`, `action_owner` (a user; blank), `target_date`, `status`, `trend`, `last_review_date`, `next_review_date` |

**Setting → Settings, list catalogue (0057).** The values of the 75 list tables are identical to the reference, except `tblTeamType`, which adds "Vendor". They are already seeded as `pending` lists, so the Setting sheet is **not loaded**. It only confirms the seeds. Other tables:
- `tblStaff` and `tblHolidays` are empty: nothing for the staff registry or the work calendar.
- `tblStaffRole` holds the same 15 values as the `role_aliases` seed of 0060.
- `tblRegion` uses the "X Area" forms that `region_aliases` already maps.
- `tblRegionVendor` has 7 regions with the vendor column empty.

### 2.3 Every column with no target today

| Sheet | Columns |
|---|---|
| Master | AR, AS (unmapped task columns, Q467). Scope X:AG has a target but no load path (G1). |
| RF & Design | W Coverage Objective, AC RF Survey Plan Date, AE RF Survey Report Ref, AG Candidate Approval Date, AH Candidate Approved By, AT Busbar Height (m) |
| Acquisition | M Rejection Reason, X Visit Restrictions / Access Notes, Y Contract Copy (file ref) |
| Permission Log | E Issued By / Authority, F Reference No., N Contact / Visit Restrictions |
| GECOL | G Survey Requested |
| HLC | H No. of Sites on Link |
| As-Built | none (AI maps to `cw_as_built_submitted`) |
| Setting | `tblRegionVendor` (Warehouse D58 table `warehouse_region_vendors`; empty) |

The fix needs no code. The System Admin adds custom fields to the register (CLAUDE.md "Custom fields") with "appears in templates" on; the templates are re-issued with a new version. Size S (configuration).

---

## 3. Load path and order

### 3.1 Before the load (prepared in the system, not from this file)

| # | What | Where | Source | Status |
|---|---|---|---|---|
| P1 | Regions and region aliases | seeded (0013, 0060) | the file's "X Area" values are already aliases | ready |
| P2 | Work calendar (holidays, weekend) | Settings → Work calendar | owner (the file's holiday table is empty) | owner data |
| P3 | Staff registry, users, local accounts | Staff registry template, Users & Roles | owner (the file's Staff table is empty) | owner data |
| P4 | Roles and role aliases | Roles & Responsibilities; mapping screen (`import-aliases`) | owner (Q356) | owner data |
| P5 | Responsibility Matrix: L1 and L2 of stages 1 to 4, and of the rows RF & Design, Acquisition, Permits & HSE, Procurement, GECOL, HLC, As-Built and Risk, in each of the 7 regions | Matrix screen | owner | owner data |
| P6 | List values: confirm the pending lists; resolve the out-of-list values of 5.3 (add, alias or correct) | Settings → Lists | owner (Q293, Q464) | owner data |
| P7 | Custom fields for the columns of 2.3, then re-issue the templates | Settings → Fields | owner says which to keep | config |
| P8 | Mapping of Master AR / AS | mapping screen (`tpl_mapping_save`) | Q467 | decision |
| P9 | Contractors register: the companies named in PR-PO J (57 distinct names), with their company type and an active contract (Q324) | TPL-CTR | owner | owner data |
| P10 | Warehouse items and need rules | seeded (0053); not in this file | owner (Q277 to Q279) | open, not needed for this file |
| P11 | The structural freeze (B9) set for the pilot | Settings | admin | process |

The importing user needs these rights:
- **Registers:** the uploader of a register batch is its L1 (Data Entry) holder, with the import grant in the region.
- **Master apply:** the person running `mi_apply_run` must be L1 of each task in each region (imp_stage_task_row checks the holder of L1, the region and the edit grant). Choose one Data Entry person (for example Project Support) holding L1 of stages 2 to 4 in all regions, or run one apply per region with that region's L1.
- **Separation of levels:** L2 must be someone else. If the same person holds both levels, every row becomes a flagged self-approval (B5), which is not wanted for a bulk load.

### 3.2 Order

| Step | Content | Path | Batches and L2 |
|---|---|---|---|
| 0 | Owner fixes or confirms the file (section 6). The external link is broken in Excel (Data → Edit Links → Break Link) and the file is saved again as `.xlsx`. CL3 is restored, or an alias is added (G2). | owner | none |
| 1 | **Sites (469)**: Site ID, Region (alias), Site Name, the identity fields RF & Design owns, and scope X:AG | **new** bulk "New site" template (G1, Q460) | one batch; L2 of the Site Register (stage 1) row |
| 2 | RF & Design (475 rows; 6 Site IDs not in the Master are left out or added in step 1) | TPL-RF | one batch → L2 of the RF & Design row, row by row or all at once |
| 3 | Acquisition (474) | TPL-ACQ | one batch → L2 Acquisition. Blocked until the candidate letter and the selection date exist (Q468). |
| 4 | Permits: 255 "Access - CW" rows | TPL-PRM | one batch → L2 Permits & HSE. An approved row is the source of B3 (0019 task source) once B3 is open. |
| 5 | Procurement orders (650) | TPL-PO, after the contractors (P9) | one batch → L2 Procurement. These are the sources of B1 and B2. |
| 6 | GECOL (241), HLC (114) | TPL-GECOL, TPL-HLC | one batch each. Blocked by the required PR No. / request no. and request date (Q468). |
| 7 | As-Built TE configuration (332) | TPL-ASB | one batch → L2 As-Built |
| 8 | Risk Register (25) | TPL-RSK | one batch → L2 Risk |
| 9 | **Master** (CW history, 380 sites) | P3: `POST /master-import/runs` (preview) → resolve the exceptions → `POST /master-import/runs/{id}/apply` with `mode = submit`, a reason and step-up | one group, one batch per stream (only CW has data). L1 is the caller; L2 of each stage decides row by row or all at once. Held rows (gate, predecessor) are sent again when unlocked. |
| 10 | Documents of the historical tasks | the task slots (drag and drop), by the L1 holders | each submit includes its documents (the unit of approval is the whole task). See Q462. |
| 11 | Parallel run (1 month) | P3 preview only (never apply), weekly, with the live Master | comparison report (`/runs/{id}/export`), each difference resolved: PMIS correct, Master correct, fixed, ignored |

Why registers come before the Master:
- TI-07 says so.
- B1, B2 and B3 take their dates from the Procurement and Permits records.
- The Master's identity columns are owned by RF & Design.
- Stage 1 (A1 to A4) is fed by RF & Design and Acquisition, and MS1 opens gate W for everything in the Master.

**Draft mode** (Q206, `mode = draft`) saves planned dates and values on the task without submitting and without L2. Use it only for the sites whose CW has not started (planned dates only). It does not help the history: actual dates still need a submit and L2. Register sheets cannot be drafted (Q355). **ASSUMPTION (verify in the rehearsal):** a draft apply can be used to place the historical values on the tasks so that the L1 holders add the documents and then submit from the task screen. This avoids rows refused for missing documents.

**Rehearsal.** Run steps 1 to 9 once on a non-production copy with the same controls (internal server, real accounts), then discard it. Read the rejected-rows reports and the comparison report before the real load. **ASSUMPTION:** whether a rehearsal on real data outside production is allowed is the owner's decision (Q463).

### 3.3 Parallel-run comparison

- P3 compares only the Master sheet's typed task columns (`mi_columns` typed). Identity, scope, calc, Dismantle and Issue columns are reported as `owned_elsewhere`, `calculated` or `issue_projection`, or not compared.
- The acceptance criterion "the real Master import matches 100% of milestone dates" (CLAUDE.md Rollout) **cannot be checked against this file**: its milestone columns (V, AW, BP, BZ and the others) are empty, because the formulas were removed. The parallel run needs the live formula Master, uploaded as it is, to P3 (Q463).
- A site created in GSDN Workspace but absent from the uploaded file is reported `site_not_in_master`. A Site ID in the file but not in GSDN Workspace is reported `site_not_in_pmis`.

### 3.4 Owner-data items of `technical-decisions-2026-11-04.md`

| Item | Does this file fill it? |
|---|---|
| Q272 region codes of the six other regions | **Partly.** Each region's Site IDs share one two-letter prefix (one exception in Middle), and Tripoli's prefix is the seeded TR. This is a proposal for the owner to confirm, not a fact. |
| Q277 need quantities and WL vendor per region | **No.** `tblRegionVendor` lists the 7 regions with no vendor. The As-Built WL Vendor per site shows one dominant vendor per region, which can be offered to the owner as a proposal. |
| Q278 manufacturer codes | No (no WH sheet) |
| Q279 BOQ source | No (As-Built CW quantities are empty) |
| Q261 snag catalogue | No (no Quality sheet) |
| Q293 pending list values | **Partly.** The Setting lists equal the seeded Master lists (TeamType adds "Vendor"); the data adds values outside the lists (5.3). |
| Q331 / Q361 ProcStatus and its cancelled value | **Partly.** Same 4 values; the data uses only "Cancelled" and "Rejected" (21 rows) and leaves 629 blank. |
| Q332 Company Type values | **Partly.** Same 6 values as the reference; the type map still needs the owner. |
| Q356 role mapping | No (Staff table empty) |
| Q367 GECOL chain and billing event | No (only installation finish and status) |
| Official holiday calendar | No (Holidays table empty) |
| SLA of C-3 and C-4 | No |
| Q254, Q370, Q372 | not applicable |

---

## 4. Gaps: what the system cannot load today

| # | Gap | Proposed solution | Size |
|---|---|---|---|
| G1 | **No site creation.** There is no `POST /sites` and no site template. P3 never creates a site (Q350). The scope columns X:AG have no write path except Change Control on an existing site. | Build the Q46 default: a "New site" form in the Site Register, with an Identity section stored in the site's RF & Design record and a Scope section (X:AG). Add a bulk template `TPL-SITE-NEW` (Site ID, Region, Name, identity, scope) through batch → L2 of the stage-1 row. Contract first, then migration (`site_create` definer function, region check, duplicate refusal DQ01, workflow version), API, web and tests. | L |
| G2 | **The upload guard refuses external links**, and **CL is renamed**. | (a) The owner breaks the link and saves the file again (no code). (b) Restore CL3, or add a header alias table for the Master (`master_column_aliases`, read by `mi_stage_run`, edited on the mapping screen, audited) so a known rename is accepted and reported. | S |
| G3 | **The register sheets have no loader in P3** (Q352). The columns of this file differ from the issued templates (sections 1.3 and 2.2). | **Built 2026-11-05 (CHANGELOG 103):** the offline helper `tools/master-import/fill-templates.py` with one mapping file per register in `tools/master-import/register-maps/` (README in `tools/master-import/`; questions Q490 to Q494). It covers TPL-RF, ACQ, PRM, PO, GECOL, HLC, ASB and RSK. Later, if the owner wants register sheets compared in the parallel run: a per-register column mapping in P3 (structure, preview, comparison). | S–M (helper); L (P3 extension) |
| G4 | **Stage 1 has no data** (TSSR, LLD, SAR, selection date), so MS1 and gate W never open and the CW history is held (Q208). | Owner data: the dates per site (Q461). With them, no code is needed. Without them, any "historical Site Release" rule is a new owner decision and an ADR (it would bypass D32). Not proposed by default. | data / L |
| G5 | **No documents for historical tasks**, while submit needs the mandatory slots. | Owner decision (Q462): (a) scan and upload; (b) an admin "accept without document" override per task (exists, reason and step-up, flagged in KPIs); (c) a one-time, owner-approved historical waiver, built as a Document Library rule "not required for tasks loaded from the Master before date X", audited and flagged. | none / none / M |
| G6 | **Master AR / AS are unmapped.** | One row each on the mapping screen once Q467 is answered (B6 `actual_date` → AR, B7 `actual_date` → AS is the catalogue reading). | S |
| G7 | **Columns with no field** (section 2.3). | Custom fields, then re-issue the templates (configuration). | S |
| G8 | **`rf_design.site_scenario` is linked to DeliveryScenario** (0057), while the Master's Site Scenario uses `tblScenario` (Indoor / Outdoor). Every row would be refused. | Re-link the field to a `Scenario` catalogue seeded from `tblScenario` (migration), after the owner confirms (Q464). | S |
| G9 | **One site name field.** The file has a mostly Arabic name (D) and a column C that mixes owner IDs and names. | A site custom field "Site Name (AR)", or `name_ar` on sites (migration), after Q469. | S |
| G10 | **Text in date columns** ("N/A", "Pending", "Cancelled": 271 cells) and **numbers typed as text** (5.2). | The conversion helper turns these into blank and lists them in its report. Applicability then comes from the scope flags, and cancellation from Change Control (Q466). Never imported as dates. | in G3 |
| G11 | **Cancelled sites** (34) carry CW dates on 6 of them. | Create them, then approve a Change Control Cancellation for each, which sets Overall Status to Cancelled (Q382). Or leave them out (Q466). | none |
| G12 | **Warehouse** has no WH sheet. The design need cannot be computed: RF & Design Sectors and MW Far-end are empty. | Nothing to load from this file. Opening stock (OPEN movements) and the need inputs come from other owner data (Q277 to Q279). | data |
| G13 | **Contractors** are only names in PR-PO J. Orders with a PO date need a party and an active contract at final approval (Q324). | Load the Contractors register first (TPL-CTR, P9). | data |

**Conversion helper (described only, not written).** `tools/master-import/prepare_register_files.py`, run by the System Admin on the internal server, with real files kept outside the repository:
1. Open the owner file read-only (`openpyxl`, `data_only=True`, `python3 -I`). Refuse to run if a formula, VBA or external link part would be executed (none is).
2. For each register, read a blank template freshly downloaded from the Templates page. Never change its header rows, locked cells, drop-downs or `_tpl` sheet.
3. Copy the values by header name, using a reviewed mapping file per register (`tools/master-import/register-map-<register_key>.csv`, header pairs only, no data). Apply these transforms:
   - trim spaces and collapse double spaces;
   - map region aliases;
   - "Open-ended" → `has_expiry` = No;
   - "N/A", "Pending" and "Cancelled" in date cells → blank;
   - numbers typed as text → numbers when they parse cleanly, else blank;
   - Site IDs normalised to upper case.
4. Write a pre-check report with counts and cell addresses only (the checks of section 5), and never log a value.
5. The admin then uploads each filled template through the normal Templates upload, so the database staging, the diff preview, batch → L2 and the System Log apply as for any user.

This keeps "Approved templates only": the uploaded file is the issued template with its own ID and version. **ASSUMPTION:** filling an issued template with a tool is acceptable to the owner (Q463).

---

## 5. Data-quality findings (counts and example cells only)

### 5.1 Keys and duplicates

| Check | Result |
|---|---|
| Duplicate Site IDs | **0** in Master (469), RF & Design (475), Acquisition (474), As-Built (332), GECOL (241), HLC (114) and Permission Log (255; also 0 duplicates of site + type + valid from) |
| Site ID shapes | two forms: two letters + three digits (434 in the Master) and the same with a space and a suffix letter (35). One RF & Design and one Acquisition key has neither shape. |
| Site IDs not in the Master | RF & Design 6, Acquisition 6, PR-PO 14, HLC 3, GECOL 1, As-Built 1. One Master site has no Acquisition row. |
| PR-PO | 650 rows on 398 sites (several orders per site is normal). 393 rows have neither a PR No. nor a PO No. (for example F260, F261, F262), so the natural key is incomplete and a second upload would duplicate them. 1 duplicate site + scope + PR + PO. |
| Site references | Uplink / backup / FN references that match no Site ID: RF & Design K 12, AW 29, AX 5; Master L 10; As-Built AW 10. Primary and Secondary MFN (AY, AZ) do not use Site IDs (428 and 295 non-matching; they are free text in GSDN Workspace). |
| Region consistency | 0 sites with a different region between sheets |

### 5.2 Dates

| Check | Count | Examples |
|---|---|---|
| Text in Master date columns | **271** cells: S 28, T 57, AL 3, AR 7, AS 7, AY / AZ / BK / BL / BM / BN 3 each, BR 64, BV 87. Values are "N/A", "Pending" and "Cancelled". | S109, T106, AR5, BV5 |
| Dates in the future (after 2026-11-04) | 0 | |
| Dates before 2018 | 0 | |
| CW Access (AL) after Survey Actual (AO) | 16 | AL5/AO5, AL126/AO126 |
| Survey Actual (AO) after MOS Actual (AZ) | 7 | AO101/AZ101 |
| CW Planned Start after Planned End (BK > BM) | 1 | BK37/BM37 |
| CW Actual End after PAC Actual (BN > BV) | 4 | BN202/BV202 |
| RF Survey (S) after CW Access (AL) | 11 | S125/AL125 |
| Acquisition Date (T) after CW Access (AL) | 21 | T8/AL8 |
| Actual Start after Actual End (BL > BN) | 0 | |
| HLC Request after Installation (F > J) | 3 | F57/J57 |
| PR Date after PO Date (PR-PO G > I) | 4 | G59/I59 |
| Planned later than actual (AN > AO; information only, not an error) | 35 | AN133/AO133 |

Contract No. (Acquisition T) holds a month-year shape in 388 of 408 cells (for example T3): it looks like a date, not a contract number.

Numbers typed as text:
- Master Q Tower Height: 11
- RF & Design AS Building Height: 260
- As-Built AN RF Height: 99 (the `rf_height_note` case), AT MW Antenna Height: 221, AV RSL: 234 (a number field in GSDN Workspace), AP M-Tilt: 17

### 5.3 Values outside their lists

| Column | Count | Against | Effect |
|---|---|---|---|
| Master K and RF & Design J, Site Scenario | 469 and 464 (all Indoor / Outdoor) | PMIS catalogue DeliveryScenario (critical) | every RF & Design row refused until G8 |
| Master BF, BG, BI (adaption items) | 33 ("Existing" 32, "No need" 1) | CompletionStatus (confirmed, critical) | cell refused |
| PR-PO E Scope | 57 ("Busbar / Grounding" 54, "Tower + Adaption" 3) | ProcScope (critical) | row refused |
| Master P, Tower Type | 7 (two values not in `tblTowerType`) | TowerType (allows other) | warning `list_other` |
| Setting TeamType | +1 value ("Vendor") | TeamType | to confirm |
| Acquisition Selected | 410, all "Yes" (no "No" rows) | YesNo | valid, but each needs a Selection Date |
| Region (all sheets) | "X Area" forms | region aliases | valid (seeded aliases) |

Spaces to trim (no effect after normalising): Master J 118 cells and N 117 cells with trailing spaces; D 13, F 5, AM 4, C 2.

### 5.4 Blank mandatory columns

| Column | Blank |
|---|---|
| Master Y Delivery Batch | 86 |
| Master AB Site Adaption | 59 |
| Master AC GECOL Power | 440 |
| Master AD HLC Fiber | 440 |
| Master AG CW Delivery Model | **469** (DQ06 mandatory) |
| Master U (Site Release baseline) and every milestone | 469 |
| RF & Design Site Type / Site Scenario / RT-GF / Tower Type / Tower Height | 27 / 11 / 21 / 23 / 28 |
| RF & Design TSSR Submitted, TSSR Approved, LLD Approved | 475 each (G4) |
| Acquisition Candidate (required) | 474 |
| Acquisition Selection Date (required with Selected = Yes) | 410 (column absent) |
| GECOL PR No. (required) | 241 |
| GECOL request date (required; column absent) | 241 |
| HLC Request No. (required) | 114 |
| HLC Request Date (required) | 6 |
| PR-PO Status (required) | 629 |
| PR-PO PO No. | 650 |
| PR-PO Contractor on rows with a PO date | 146 |

Scope inconsistency: 240 of the 241 GECOL sites and 113 of the 114 HLC sites have Master AC / AD not "Yes", so the C-track tasks would be N/A while the register holds installed work (Q465).

### 5.5 Formulas against typed values

- **Formulas:** 0 in any data cell of any sheet. The only formulas are the `SUBTOTAL` header rows and the hidden filter-helper columns. Every calculated column is either empty or holds a pasted value (Master R and AL). P3's check `formula_in_input` therefore finds nothing; on the other side, nothing in the file can be compared as a Master formula result.
- **Master identity typed against RF & Design** (same site; D46 says RF & Design is the source):

| Master column | Differs from RF & Design | Of which RF & Design blank |
|---|---|---|
| C | 53 | 39 |
| D | 4 | 4 |
| F | 163 | 163 |
| H, I | 1 each | 0 |
| J | 37 | 27 |
| K | 50 | 10 |
| L | 65 | 59 |
| M | 109 | 0 |
| N | 4 | 0 |
| O | 22 | 20 |
| P | 24 | 22 |
| Q | 37 | 26 |
| S | 203 | 82 |

  Examples: C5, F5, M27, S5.
- **CW Access** (AL): 379 dated cells. 124 have no "Access - CW" permit row (for example AL5), so B3 has no source for them. 1 differs from the permit's Valid From (AL245).

### 5.6 Merged cells

| Sheet | Merged ranges | Inside data rows |
|---|---|---|
| Master | 73 (for example GA2:GE2, B2:G2) | 0 |
| As-Built | 21 (for example D1:AI1, AJ1:BL1) | 0 |
| Other sheets | none | — |

No effect on the load: P3 composes the Master headers from rows 1 to 3, and the conversion helper reads the As-Built headers from row 3.

### 5.7 Arabic text

| Check | Result |
|---|---|
| Cells with Arabic script | Master D 330, C 42; RF & Design D 334, C 9; Acquisition C 333, P 406, X 409; PR-PO C 497, J 87, L 76; HLC G 39, L 42; GECOL C 158; As-Built C 197 |
| Mixed Arabic and Latin in one cell | Master C 1, D 2; RF & Design D 2; Acquisition P 23, X 18; HLC L 41; PR-PO L 8, C 3. Examples: D115, P35, L10. |
| Tatweel, Arabic-Indic digits, Persian kaf / yeh, diacritics, zero-width or bidi control characters, NBSP | 0 in every sheet |
| Master D against RF & Design D | 4 differ, all where RF & Design is blank; 0 that differ only by Alef / Yeh / Teh-marbuta spelling |
| Arabic in Latin-only fields | Site ID 0. Site Owner ID 42 (Master C) and 9 (RF & Design C). Contractor name 87 (PR-PO J), which must be matched to the Contractors register by hand. |

**Personal data in the file:** landlord contact names, phones and e-mails on about 410 Acquisition rows, and AAT SE names (50 distinct) in Master AM. They load only into fields with visibility rules (Acquisition contact fields; B4 `aat_se_name` is free text). Q469 asks whether to load them.

---

## 6. Questions for the owner (Q460 to Q469)

| # | Question | Default until answered |
|---|---|---|
| Q460 | **Site creation.** GSDN Workspace cannot create sites today. May we build the "New site" form and a bulk template (Q46 default: identity stored in RF & Design, one approval on the stage-1 row), and create the 469 sites from it? When the Master and RF & Design disagree on identity (section 5.5), is RF & Design the source (D46)? | Nothing is loaded. RF & Design is the identity source. |
| Q461 | **Stage 1 dates.** TSSR Submitted / Approved, LLD Approved and the SAR date are empty, so Site Release cannot be derived and every CW date stays held. Can you provide them per site? If not, what is the Site Release date of a site already in CW? | CW history is held, never forced. No date is invented. |
| Q462 | **Documents of historical tasks.** Upload the scans (layout, approval email and CW DN, MOS proof, PAC certificate) per task? Or one admin "accept without document" override per task (flagged in KPIs)? Or a one-time historical waiver for tasks before a cut-off date? | The normal rule: the mandatory slots must be filled before submit. |
| Q463 | **Which file is the authority?** This file is a 10-sheet, values-only copy with no milestone formulas. For the import and the parallel run, will you give the live 23-sheet Master as it is (formulas kept, external link broken)? May we fill the issued register templates with a conversion tool? May we rehearse the load on a non-production copy with real data? | No rehearsal on real data, and no tool-filled templates, until you agree. The parallel run waits for the live Master. |
| Q464 | **Values outside the lists.** For each, say "map to X", "add to the list" or "the data is wrong": Site Scenario Indoor / Outdoor (and should the RF & Design field use the Scenario list, not Delivery Scenario?); Tower Type values not in the list (7 cells); "Existing" and "No need" for adaption items (33 cells); PR-PO scopes "Busbar / Grounding" (54) and "Tower + Adaption" (3); TeamType "Vendor". | Cells and rows refused, and listed in the rejected-rows report |
| Q465 | **Scope flags.** AG CW Delivery Model is blank for every site. AC / AD are blank for 440 sites, while 240 sites have GECOL records and 113 have HLC records. Y is blank for 86 and AB for 59. What is the scope of these sites? | Blank flags stay `na` (the site default). GECOL and HLC tasks stay N/A. |
| Q466 | **Cancelled sites.** 34 sites show "Cancelled" in S or T (27 are also cancelled in Acquisition), and 6 of them have CW dates. Create them and cancel them through Change Control (Q382), or leave them out? | Created, then cancelled through Change Control |
| Q467 | **Master AR / AS.** Are they B6 Layout Submitted and B7 Layout Approved (task catalogue), or the STA submitted and approved dates (old mapping)? | Not loaded |
| Q468 | **Missing register keys.** The Acquisition candidate letter (474) and the selection date (410) are blank. The GECOL PR No. and request date (241) are blank. The HLC request no. (114) is blank. The PR-PO status (629) and PO No. (650) are blank, and 146 orders with a PO date have no contractor. The Contract No. column looks like month-year in 388 cells. Can these be supplied? Or may we use a default (for example candidate "A" for the single selected candidate, selection date = contract sign-off)? | Rows refused. No default without your approval. |
| Q469 | **Names and personal data.** Which column is the English site name and which the Arabic one? Column C (Site Owner ID) mixes ID-like values (201) and names (268). Should GSDN Workspace keep an Arabic site name? Should the landlord contacts (names, phones, e-mails) and the AAT SE names be loaded, or left out? | One name (Master D). Personal contact fields are not loaded until you confirm. |

---

## 7. Next steps

1. Send section 6 to the owner. Answers come back as rows in `docs/spec/open-questions.md` (Q460 to Q469) and, where binding, in a new owner-answers file.
2. The tech lead adds G1 (site creation, L) and G2 (header alias, S) to the contract and plans them as a package. G8 (Scenario catalogue) and G6 (AR / AS mapping) follow the answers.
3. Once Q463 is answered, the domain analyst writes the per-register mapping files (header pairs only) for the conversion helper.
4. The load runs only after the system is complete (CLAUDE.md Rollout), first as a rehearsal if Q463 allows it, then for real. Then the parallel run starts with the live Master in P3 preview mode.
