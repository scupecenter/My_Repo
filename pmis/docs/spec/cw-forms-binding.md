# CW forms: data bindings (DN, RN, PAC, FAC, snag list)

Sources:
- The owner's approved CW forms: `design/forms/source/GSDN_CW_DN.html`, `GSDN_CW_RN.html`, `GSDN_CW_PAC.html`, `GSDN_CW_FAC.html`. They are cited as "DN form", "RN form" and so on, with the section number printed on the form.
- CLAUDE.md "Generated documents" and "Defects Liability Period". These are cited as CLAUDE.md.
- Blueprint v1.1 §05 "auto-filled forms", §03 step table and §10 warehouse. These are cited as "BP §nn".
- Decisions D54, D57–D62, D73, and the Master sheets Master, WH, WH Serials, PR-PO, Quality Inspections and Setting.
- The data model in `apps/api/prisma/schema.prisma` and `db/erd.md`, and the contract `contracts/openapi.yaml` (tags `forms`, `warehouse`, `qc`).

Precedence follows `rules.md`: CLAUDE.md > Master formulas > BP v1.1 text. Anything not stated in a source is marked **ASSUMPTION**. Open points are listed as questions Q19–Q33 in `open-questions.md`.

Fill codes used in the tables:
- **P**: pre-filled by the system at generation.
- **C**: computed by the system.
- **E**: editable in the prepare screen before generation.
- **H**: left blank and written by hand on paper (signatures, stamps, hand dates).

The placeholder names are a **proposal** for the HTML templates. The binding list itself is `FormTemplate.placeholders` in the contract, owned by tech-lead.

---

## 0. Rules shared by every form

### 0.1 Flow
CLAUDE.md "Generated documents" and BP §05 define the flow:
1. **Prepare.** The responsible person prepares the record. For DN and RN this means the warehouse movement lines. For PAC and FAC it means the site data and the snags. Preparing does not use up a number (contract `prepareGeneratedForm`).
2. **Generate.** The system generates the numbered PDF from the current template version, with a QR code that links back to the record. The PDF records which template version it used.
3. **Print and sign.** The PDF is printed, then signed and stamped on paper.
4. **Upload.** The signed scan is uploaded into the same Document Library slot (`GeneratedForm.slot_id`).
5. **Approve.** The upload goes through the 3-level approval like any other document.

Extra rules from BP §05:
- The "filled form" button appears only when the step is open (Pending). It never appears on a locked step.
- A form that was generated but never uploaded appears in the missing-documents report.
- The QR code matches the site and the form. Uploading the scan to another site raises a warning.
- In the prepare screen, the data fields (site, dates, contractor) show the values held in the system. They are changed only through normal data entry. Only the free fields can be edited there: notes, signatories, comments. The contract deviates from this; see gap G-F19.

### 0.2 Pre-filled and hand-filled fields
- The system fills every data field (CLAUDE.md): ref no., dates, site, region (box ticked), contractor, PO/WO, warehouse, quantities, snags, and the names and positions of the signatories from the Responsibility Matrix.
- Signatures, stamps and the signing dates beside them stay blank for wet signature (CLAUDE.md).
- **ASSUMPTION:** if a matrix cell is held by a group or a role, there is no single name to print. The Name line is then left blank (H), because the first member to act claims the task (CLAUDE.md, B10).

### 0.3 Repeating tables
- Item tables come from the system, not from the form (CLAUDE.md).
- DN and RN lines come from the warehouse movement lines. Only items with a quantity are printed, followed by a configurable number of blank rows (`FormTemplate.blank_rows_default`). The source forms carry 5 blank rows (rows 29–33).
- The fixed list of 28 items in the DN and RN source forms becomes seed data for the CW item master (CLAUDE.md). It matches the Master WH columns AG:BH: Group = CW, UoM m or pcs, Tracking = Qty (WH header rows).
- Tables of variable length repeat their rows automatically (BP §05).

### 0.4 Number, QR and footer
- See §6 for numbering.
- The DN and RN footers print the number and "Page X of Y" on every page.
- The source PAC and FAC footers carry neither the number nor a page count, and no source form carries a QR code. The templates must add both (gap G-F15).

### 0.5 Audit
- Every generation, void and download is audited (CLAUDE.md).
- Template uploads need step-up MFA and a reason (contract `uploadFormTemplateVersion`).

### 0.6 Model coverage
The four forms bind to these records:

| Record | Contract (0.2) | Prisma schema |
|---|---|---|
| Generated form (number, status, template version, lines, BoQ, snags, signatories, guard, QR, PDF, slot, void and reissue links) | `GeneratedForm`, `GeneratedFormInput` | **none** (G-F01) |
| Number sequence | `NumberSequence` | **none** (G-F01) |
| Form template and versions | `FormTemplate` | **none** (G-F01). `template_definitions` is for the Excel `_tpl` templates. |
| Stock movement and lines (pending, posted, cancelled; reserved) | `StockMovement`, `StockMovementLine` | **none** (G-F01). Only `warehouse_site_qty` (required, dispatched, installed) and `warehouse_serials` (dn_no, rn_no) exist. |
| Document type of kind "generated form" | `DocumentTypeFields.kind = generated_form`, `form_kind` | `DocKind` has no `generated_form` value, and `document_types` has no `form_kind` (G-F02) |
| Site, region, scope flags, tower data | `SiteDetail` | `sites`, `regions` |
| Contractor, PO / WO | `ExternalPartyRef`, `po_wo_ref` | `procurement_records` (scope, po_wo_no, party_id), `external_parties` |
| Snags | `Snag` | `snags`, `snag_types`; the Quality register is `quality_inspections` |
| Signatories | `GeneratedForm.signatories` (label, user, position) | `matrix_cells`, `matrix_cell_assignees`, `users`. The position comes from the staff registry, which is specified in `staff-registry.md` and has no Prisma table yet (G-F10). |

---

## 1. CW Delivery Note (DN): "Issue of Warehouse Material to Site"

### 1.1 Where the form belongs
- Document Library entry: B7 "CW DN" (CLAUDE.md seed). It is placed on task B7, "Layout approval and CW DN" (`task-catalogue.csv`), and maps to Master AT (CW DN Submitted) and AU (CW DN Approved).
- The underlying record is a CW DN movement in the Warehouse register (Master WH movement table, Type = CW DN, D61).
- Several DNs per site, and the choice between the B7 slot and a Warehouse register record, are open (Q19).

### 1.2 Fields

| # | Form field (DN form) | Source in the PMIS | Master | Fill | Proposed placeholder | Notes |
|---|---|---|---|---|---|---|
| 1 | DN Ref. No. | Generated form `number`, taken at generation (§6) | WH movement "Doc No." (D61) | P | `form.number` | No Prisma table (G-F01) |
| 2 | DN Date | Date of generation, in the Africa/Tripoli timezone | WH movement "Date" | P | `form.date` | ASSUMPTION: issue date = generation date |
| 3 | Site ID | `sites.site_code` | Master B | P | `site.code` | |
| 4 | Site Name | `sites.name` | Master D | P | `site.name` | |
| 5 | Site Region (7 boxes: Tripoli, Middle, Zawia, WM, Sebha, Benghazi, GM) | `sites.region_id` → `regions.code`. The matching box is ticked. | Master E ("X Area", Q10) | P | `site.region_code` | Box labels match the CLAUDE.md region names |
| 6 | Contractor Name | `procurement_records` (scope CW) `party_id` → `external_parties.name`. Contract: `GeneratedForm.contractor` | Master AJ; PR-PO J | P | `contractor.name` | ASSUMPTION: when a site has several CW orders, the latest order that is not cancelled is used |
| 7 | Site CW PO / WO | `procurement_records.po_wo_no` (scope CW). Contract: `po_wo_ref` | PR-PO H; Master AI | P | `po_wo.number` | Same ASSUMPTION as row 6 |
| 8 | From Warehouse | A setting holding the main store name. Contract: `GeneratedForm.warehouse` | WH is a "single main store" (WH title row; D57; BP §02) | P | `warehouse.name` | Gap G-F14: no setting key exists yet |
| 9 | Dispatch Date | **No source** | WH movement Date with Status = Dispatched | H by default | `movement.dispatch_date` | Open, Q21; gap G-F05 |
| 10 | No. (line) | Running number over the printed lines | — | C | `lines[].no` | |
| 11 | Item Description | `warehouse_items.name` (contract `name_en`) | WH row "Item Name" | P | `lines[].description` | |
| 12 | UOM | `warehouse_items.unit` (contract `uom`) | WH row "UoM" | P | `lines[].uom` | |
| 13 | Qty Approved | Contract `FormLine.qty_approved`. **No source in the model or in the Master** | — | P if entered, else H | `lines[].qty_approved` | Open, Q22; gap G-F06 |
| 14 | Qty Dispatched | Movement line `qty` (contract `StockMovementLine.qty`, kind = issue) | WH movement item columns | P | `lines[].qty` | Only lines with a quantity are printed (CLAUDE.md) |
| 15 | Blank rows | `blank_rows` (default from the template) | — | H | — | The source form has 5 |
| 16 | Remarks / Notes | `GeneratedForm.notes` | WH movement "Remark" | E | `form.notes` | |
| 17 | Applicant: Name | The user who prepares the record (entry level) | — | P | `sign.applicant.name` | Open, Q20 |
| 18 | Applicant: Date, Signature | — | — | H | — | |
| 19 | Reviewer – SE: Name | Holder of matrix level 2 | — | P | `sign.reviewer.name` | Open, Q20 |
| 20 | Reviewer – SE: Date, Signature | — | — | H | — | |
| 21 | Approver – Inventory Supervisor: Name | Holder of matrix level 3 | — | P | `sign.approver.name` | Open, Q20. This differs from B2 (the CW Team Lead approves CW stages) |
| 22 | Approver: Date, Signature | — | — | H | — | |
| 23 | Footer "DN No." (each page) | Same as row 1 | — | P | `form.number` | |
| 24 | Footer "Page X of Y" | Renderer | — | C | `page.no`, `page.count` | |
| 25 | QR code (not on the source form) | `GeneratedForm.qr_url` | — | P | `form.qr` | Required by CLAUDE.md; G-F15 |

Serial numbers:
- CLAUDE.md lists serials in the DN lines "when tracked". All 28 CW items are Qty-tracked (WH "Tracking" row), so the CW DN needs no serial column.
- **ASSUMPTION:** if the admin later makes a CW item serial-tracked, the template must gain a serial column or a serial annex (G-F16).

### 1.3 Warehouse effect (CLAUDE.md)
- **Prepare:** creates a pending issue movement. The quantities show as "pending issue" and are reserved, so they cannot be issued twice (contract 422 `insufficient_stock`).
- **Approval** of the signed DN posts the issue to the site.
- **Voiding** the form, or cancelling the movement, releases the reservation (contract `cancelStockMovement`).
- The Master and BP §10 work differently: there an approved DN reserves the stock and dispatch deducts it (WH summary rows Reserved and Issued). See Q21.

---

## 2. CW Return Note (RN): "Return of Material to Warehouse"

### 2.1 Where the form belongs
- Document Library entry: CW RN (`task-catalogue.csv` E3, "Return to warehouse (CW RN / TE RN)"). It maps to Master FR (CW RN Date).
- The underlying record is a CW RN movement (WH Type = CW RN, D61).
- An RN for faulty material that is not part of a dismantle has no task in the catalogue (Q19).

### 2.2 Fields

| # | Form field (RN form) | Source in the PMIS | Master | Fill | Proposed placeholder | Notes |
|---|---|---|---|---|---|---|
| 1 | RN Ref. No. | Generated form `number` (§6) | WH "Doc No." | P | `form.number` | G-F01 |
| 2 | RN Date | Date of generation | WH "Date" | P | `form.date` | ASSUMPTION as for the DN |
| 3 | Site ID, Site Name | `sites.site_code`, `sites.name` | Master B, D | P | `site.code`, `site.name` | |
| 4 | Site Region (7 boxes) | `regions.code` | Master E | P | `site.region_code` | |
| 5 | Contractor Name | ASSUMPTION: the dismantle contractor when a CW Dismantle order exists, otherwise the CW contractor | Master FO (CW Dismantle Contractor / Vendor); AJ | P | `contractor.name` | Open, Q24 |
| 6 | CW Dismantle Actual Date | Task E2 `actual_date`. E2 covers both CW and TE dismantle, so the CW date cannot be told apart from the TE date | Master FQ | P if available, else H | `dismantle.cw_actual_date` | Open, Q24; G-F08 |
| 7 | Site CW PO / WO | `procurement_records.po_wo_no` (scope CW) | PR-PO H | P | `po_wo.number` | |
| 8 | Dismantle PO / WO | `procurement_records.po_wo_no` with scope "CW Dismantle" (Setting ProcScope list) | PR-PO H (scope CW Dismantle) | P | `po_wo.dismantle_number` | Prisma documents `scope` as "CW or TE" only (G-F08). BP §05 asks for both orders on a dismantle RN |
| 9 | To Warehouse | Same setting as DN row 8 | single main store | P | `warehouse.name` | G-F14 |
| 10 | Reason (Faulty or Damaged / Relocation / Cancellation / Other: ___) | **No field** in the contract (`StockMovement` or `GeneratedFormFields`) | WH movement "Reason" (ReturnReason list, D61) | P if recorded | `movement.reason`, `movement.reason_other` | G-F07; Q23 |
| 11 | No., Item Description, UOM | Same as DN rows 10–12 | WH header | P/C | `lines[]` | |
| 12 | QTY | Movement line `qty` (kind = return) | WH movement item columns | P | `lines[].qty` | |
| 13 | Condition (Good / Faulty / Damaged), per line | **No field** on `StockMovementLine` or `FormLine` | WH movement "Condition", one value per document (D61); WH Serials "Return Condition" | P if recorded | `lines[].condition` | G-F07; Q23 |
| 14 | Blank rows, Remarks | As DN rows 15–16 | WH "Remark" | H / E | | |
| 15 | Applicant / Reviewer – SE / Approver – Inventory Supervisor | As DN rows 17–22 | — | P name, H date and signature | `sign.*` | Q20 |
| 16 | Footer "RN No.", page | As DN rows 23–24 | — | P/C | | |
| 17 | QR code | As DN row 25 | — | P | `form.qr` | G-F15 |

### 2.3 Warehouse effect (CLAUDE.md; WH summary rows)
- Approval of the signed RN posts the return. Until then the quantity shows as "pending return".
- In the Master, Returned Good goes back into On Hand. Returned Faulty / Damaged is counted separately and is not in On Hand (WH summary rows 4 and 5, D61).
- **ASSUMPTION:** the PMIS keeps the same split, so the condition is needed per line (Q23).

---

## 3. CW Preliminary Acceptance Certificate (PAC)

### 3.1 Where the form belongs
- Task B13 "CW PAC (snags cleared)". Its documents are "CW PAC certificate signed and scanned; Snag list; Snag closure evidence; CW As-Built" (`task-catalogue.csv`).
- Master columns: BR (Planned), BS (Snags Found), BT (Snags Cleared), BU (CW As-Built Submitted), BV (CW PAC Actual).
- The PAC starts the Defects Liability Period (form subtitle; CLAUDE.md DLP).

### 3.2 Fields: header and section 1, "Site Info."

| # | Form field (PAC form) | Source in the PMIS | Master | Fill | Proposed placeholder | Notes |
|---|---|---|---|---|---|---|
| 1 | PAC Ref. No. | Generated form `number` (§6) | — | P | `form.number` | |
| 2 | PAC Date | ASSUMPTION: the acceptance date entered in the prepare screen (default today). On approval of the signed scan it becomes B13 `actual_date`, which is Master BV | BV | P (E) | `pac.date` | Open, Q26 |
| 3 | Site ID | `sites.site_code` | B | P | `site.code` | |
| 4 | PR/PO/WO # | `procurement_records.po_wo_no` (scope CW); PR No. when no PO yet | PR-PO F/H; AI | P | `po_wo.number` | As DN row 7 |
| 5 | Contractor Name | CW contractor (as DN row 6) | AJ | P | `contractor.name` | |
| 6 | Site Region (boxes Tripoli, Middle, Zawya, WM, Sabha, Benghazi, GM) | `regions.code` | E | P | `site.region_code` | The PAC form spells "Zawya" and "Sabha", while CLAUDE.md and the DN form use "Zawia" and "Sebha". The template must map them by region code (G-F17, Q29) |
| 7 | Tower Type (GF-SST / RT-GMT / RT-Pole / Other) | `sites.rt_or_gf` + `sites.tower_type` | O (RT or GF), P (Tower Type: SST, GMT, Monopole, N/A) | P | `site.tower_type_box` | The mapping is not defined (Q29) |
| 8 | Tower Height (m) | `sites.tower_height_m` | Q | P | `site.tower_height_m` | |
| 9 | Site Name | `sites.name` | D | P | `site.name` | |
| 10 | Tower Coordinates: Latitude, Longitude | `sites.latitude`, `sites.longitude` | H, I | P | `site.lat`, `site.lng` | ASSUMPTION: tower coordinates = registered site coordinates |
| 11 | CW SOW (Tower Erection / Site Adaption / Both) | `sites.scope_tower_erection`, `scope_site_adaption` (Yes/N/A) | AA, AB | P | `site.cw_sow_box` | "Both" when both are Yes |
| 12 | CW Date: Start Date | ASSUMPTION: the earliest `actual_start` of tasks B10 and B11 | BL (CW Actual Start) | P | `cw.actual_start` | |
| 13 | CW Date: Finish Date | ASSUMPTION: the latest `actual_date` of tasks B10 and B11 | BN (CW Actual End); BP is the milestone | P | `cw.actual_end` | |
| 14 | CW Schedule (Ahead / Behind / On schedule) | **Not defined.** Proposed default: CW Completion (MS3) against its current baseline (BO) | BP vs BO | H by default | `cw.schedule_box` | Q29; G-F13 |

### 3.3 Section 2, "Provisional Acceptance Statement"

| Field | Source | Fill | Notes |
|---|---|---|---|
| ACCEPTED / ACCEPTED WITH SNAGS / NOT ACCEPTED (one box) | No model field | H by default | The PAC cannot be generated while a snag on the site is open (CLAUDE.md), so "ACCEPTED WITH SNAGS" and "NOT ACCEPTED" can never be true on a generated PAC. Open, Q25 |
| Remarks | `GeneratedForm.notes` | E | |

### 3.4 Section 3, "Defects Liability Period (DLP)"

| Field | Source | Master | Fill | Notes |
|---|---|---|---|---|
| DLP Start Date | = PAC Date (CLAUDE.md: "counted from the PAC date") | FA = BV | C | |
| DLP Expiry Date | PAC Date + `dlp.months.cw` months (CLAUDE.md, default 3) | FB = FA + CW DLP period, which is **90 calendar days** (Setting; D13; BP §03) | C | The two rules give different dates (Q27) |
| DLP Duration (prefilled "3 months" on the form) | The `dlp.months.cw` value in force at issue (contract `/settings/dlp`) | Setting "CW DLP period" | C | The PAC keeps the value in force when it was issued (CLAUDE.md). It is stored on the generated form record (G-F22) |

### 3.5 Section 4, "Credential & Approval" (four blocks)

| Block | Name | Position | Date, Signature and Stamp | Notes |
|---|---|---|---|---|
| Contractor | Contractor Name P (as row 5). Signee H | H | H | `external_parties` holds no signatory contact (G-F10) |
| GSDN Site Engineer | P: holder of the B13 entry level (ASSUMPTION) | P from the staff registry `position` | H | Q20 |
| GSDN CW Team Lead | P: approver of the stage (B2 default) | P | H | Q20 |
| GSDN Project Manager | P: the holder of the Project Manager role (ASSUMPTION). The PM is not a matrix level of the RFI stage (B2) | P | H (signature and stamp) | Q20 |

### 3.6 Section 5, "Acceptance Criteria Checklist"
- The checklist has 7 groups and 34 items, each with Pass / Fail / N/A:
  1. General Requirements (1-1, 1-2)
  2. Tower Foundation & Tower Members (2-1 … 2-17)
  3. Cabinet Foundation, Greenfield (3-1 … 3-3)
  4. Cabinet Foundation, Rooftop (4-1 … 4-3)
  5. Fiber & Electrical Components (5-1 … 5-7). Item 5-3 asks for the measured grounding resistance in Ohm.
- **There is no data source.** No model holds this checklist. The Quality register (`quality_inspections`) holds QC, Snag, ITP and NCR records, not this list.
- Default: printed blank for hand ticking (H). Open, Q28; gap G-F11.
- **ASSUMPTION** (not applied until Q28 is answered): group 2 could be pre-ticked N/A when AA = N/A, and group 3 or 4 by Master O (GF or RT).

### 3.7 Section 6, "Snag / Punch List (Defects & Closure)"
CLAUDE.md: "The PAC snag list comes from the site's QC snags with their closure status."

| Column | Source | Fill | Notes |
|---|---|---|---|
| Snag No. (S01 …) | **No snag number field.** Proposed: the linked Quality register `record_code` (Master "Record ID"), otherwise a running S01, S02 … in order of `raised_at` | C | G-F09 |
| Description of Defect / Non-Conformance | `snags.description` (contract `title` + `description`) | P | |
| Raised Date | `snags.raised_at` (date part) | P | |
| Closed Date | `snags.closed_at` (date part) | P | |
| Verified by | `snags.closed_by` → user name | P | The contract `Snag` has no `closed_by` (G-F09) |
| Status | `snags.status` (closed / cancelled) | P | Because of the guard, no row can be open |

- Rows: one per snag, then blank rows. The source form has 6 fixed rows (S01–S06); the rows repeat (BP §05).
- **ASSUMPTION:** only snags with `scope = CW` are listed. Which snags block generation is open (Q25).

### 3.8 Section 7, "Accepted Item List (BoQ)"
CLAUDE.md: "The PAC Accepted Item List (BoQ) is computed from the net quantities on site (DN minus RN)."

| Column | Source | Fill |
|---|---|---|
| No. | Running number | C |
| Item Code | `warehouse_items.item_code` | P |
| Item Description | `warehouse_items.name` | P |
| UOM | `warehouse_items.unit` | P |
| QTY | Σ posted CW DN line qty − Σ posted CW RN line qty for this site and item (contract `GeneratedForm.boq_lines`; `/warehouse/stock?site_id=`) | C |
| Remark | free | E |

- Only items with a net quantity above 0 are printed, followed by blank rows. The source form has 15 rows.
- **ASSUMPTION:** pending (not yet approved) movements are excluded. Returns count whatever their condition, because they have left the site.
- The Master CW items have no Item Code (WH "Item Code" row is empty for AG:BH). The seed needs codes, because the contract requires `code` (G-F03).
- **Disagreement in the sources:** BP §05 says the CW quantities in the PAC are the As-Built quantities, entered before issue. `stories-registers.md` RG-ASB repeats this. CLAUDE.md (newer) says net DN − RN, and CLAUDE.md wins. BP §06 "ready for closure" separately compares dispatched quantities with As-Built. Q33 asks whether the PAC prepare screen shows that comparison.

### 3.9 Footer, number and QR
The source footer reads "GSDN CW Acceptance · CW Preliminary Acceptance Certificate (PAC)". The template must add the number, the page count and the QR code (G-F15).

### 3.10 Guards specific to the PAC
- Generation is refused while any snag on the site is open (CLAUDE.md; contract 422 `open_snags`, `guard.open_snag_count`).
- Approval of B13 is also blocked while a snag is open, and the lock reason shows the count (CLAUDE.md; DL-07).

---

## 4. CW Final Acceptance Certificate (FAC)

### 4.1 Where the form belongs
Task B15 "CW FAC" maps to Master FC, FD and FE (CW FAC Date) and starts SLA B-15 from CW DLP End (FB). The FAC references its PAC automatically (CLAUDE.md; contract `reference_form_id`).

### 4.2 Fields

| # | Form field (FAC form) | Source in the PMIS | Master | Fill | Proposed placeholder | Notes |
|---|---|---|---|---|---|---|
| 1 | FAC Ref. No. | Generated form `number` | — | P | `form.number` | |
| 2 | FAC Date | ASSUMPTION: entered in the prepare screen (default today). On approval it becomes B15 `actual_date` (FE) | FE | P (E) | `fac.date` | Same pattern as the PAC Date (Q26) |
| 3 | Site ID | `sites.site_code` | B | P | `site.code` | |
| 4 | PR/PO/WO # | As PAC row 4 | | P | `po_wo.number` | |
| 5 | Contractor Name | As PAC row 5 | AJ | P | `contractor.name` | |
| 6 | Tower Type (text) | `sites.rt_or_gf` + `sites.tower_type` as text, for example "GF · SST" | O, P | P | `site.tower_type_text` | ASSUMPTION on the text format |
| 7 | Site Region (text) | `regions.name_en` | E | P | `site.region_name` | |
| 8 | PAC Ref. No. | `number` of the referenced PAC: the site's latest generated PAC that is not voided | — | P | `pac.number` | CLAUDE.md "FAC references its PAC automatically" |
| 9 | PAC Issue Date | The PAC Date of the referenced PAC (= BV) | BV | P | `pac.date` | ASSUMPTION: "issue date" = PAC Date, not the generation timestamp |
| 10 | DLP Start Date | Stored on the referenced PAC | FA | P | `pac.dlp_start` | Frozen at PAC issue (CLAUDE.md DLP) |
| 11 | DLP Expiry Date | Stored on the referenced PAC | FB | P | `pac.dlp_end` | Q27 |
| 12 | Retention Release Recommendation (RECOMMENDED / NOT RECOMMENDED) | **No model** | — | H | — | Q30; G-F12 |
| 13 | Final Acceptance (GRANTED / WITHHELD) | **No model** | — | H | — | Q30 |
| 14 | Remarks | `GeneratedForm.notes` | — | E | `form.notes` | |
| 15 | GSDN CW Team Lead: Name / Date / Signature | Name P (Q20); the rest H | — | P/H | `sign.cw_team_lead.name` | |
| 16 | GSDN Project Manager: Name / Date / Signature & Stamp | Name P: the approver of the Final Closure stage (B2) | — | P/H | `sign.project_manager.name` | |
| 17 | Footer, number, QR | — | — | P | | G-F15 |

The FAC form has no contractor signature block.

---

## 5. Snag list (standalone form)
- CLAUDE.md lists "the Snag list" among the system-issued CW forms. The contract has the matching `FormKind = snag_list`, and BP §05 has a "filled form" button for it.
- **There is no approved source template** in `design/forms/source/`. The only snag table in the owner's forms is PAC section 6.
- BP §05: "without the official forms the system issues no form".
- Default: the snag list is not issued until the owner supplies its template (Q31).
- When it exists, its lines bind exactly like PAC section 6, with the site header bound like PAC rows 3–9.

---

## 6. Numbering
- Every generated form gets a number from a sequence, for example `DN-CW-TR-2026-0001`. The sequence is configurable (CLAUDE.md).
- Contract `NumberSequence`:
  - a `key` per sequence, for example `DN-CW-TR`;
  - a `pattern`, for example `DN-CW-{REGION}-{YYYY}-{SEQ:4}`;
  - a `reset` rule (never or yearly);
  - a `next_value` that only goes up.
- The number is taken at **generate**, not at prepare (contract `generateFormPdf`).
- Numbers are never reused or deleted. A wrong form is voided with a reason and reissued with a new number (CLAUDE.md). Voiding needs step-up MFA (contract `voidGeneratedForm`, `x-step-up`). The void links `replaces_id` and `replaced_by_id`.
- Only one region abbreviation is given anywhere: "TR" in the CLAUDE.md example.
- BP §05 gives another example pattern, `GSDN-CW PAC-MI001-01`, which is per site with a revision.
- The prefixes for RN, PAC, FAC and the snag list, the codes of the other 6 regions, and the reset rule are open (Q32).
- **ASSUMPTION (seed placeholders until Q32 is answered):**
  - prefixes DN, RN, PAC, FAC and SL;
  - one sequence per kind and region;
  - yearly reset.

---

## 7. Guards (CLAUDE.md "Guards" plus related rules)

| # | Guard | Source | Where it is enforced |
|---|---|---|---|
| 1 | A CW PAC cannot be generated while any snag on the site is open | CLAUDE.md | `forms_generate` (422 `open_snags`); `guard.can_generate`, `guard.open_snag_count` |
| 2 | A preliminary acceptance cannot be approved while any snag on the site is open. The lock reason shows the count | CLAUDE.md; DL-07 | Approval engine on B13 (and on D16, ASSUMPTION in DL-07) |
| 3 | Numbers are never reused or deleted. A wrong form is voided with a reason and reissued with a new number | CLAUDE.md | `forms_void`; `NumberSequence.next_value` only goes up |
| 4 | Every generation, void and download is audited | CLAUDE.md | Audit Log; contract `downloadGeneratedForm` ("audited") |
| 5 | Reserved stock cannot be issued twice | CLAUDE.md | `wh_create_movement` (422 `insufficient_stock`) |
| 6 | An approved DN posts the issue and an approved RN posts the return. Before that they show as pending | CLAUDE.md | Server-side on approval (ADR 0011 note 7) |
| 7 | Each PDF records its template version. A new template version never regenerates older PDFs | CLAUDE.md; contract | `GeneratedForm.template_version` |
| 8 | A template upload is checked against the allowed placeholders | contract | `forms_publish_template` |
| 9 | The FAC references its PAC automatically | CLAUDE.md | `forms_prepare` fills `reference_form_id` |
| 10 | "Submit for review" stays disabled until the signed scan fills the mandatory slot | CLAUDE.md | Upload slot |
| 11 | The form button appears only on an open (Pending) step, never on a locked one | BP §05 | UI and `forms_prepare` |
| 12 | Uploading a signed scan whose QR belongs to another site raises a warning | BP §05 | Upload check |
| 13 | A form that was generated but not uploaded appears in the missing-documents report | BP §05 | Report |
| 14 | Approved tasks never change | CLAUDE.md (Document Library) | **ASSUMPTION:** a form for an approved task can be voided only through an admin override (reason, step-up, audit) |

---

## 8. Gaps (no source in the model or contract yet)

| ID | Gap | Affects | Owner |
|---|---|---|---|
| G-F01 | No Prisma tables for generated forms, number sequences, form templates and versions, or stock movements and their lines. They exist only in the contract. ADR 0011 marks the `forms_*` and `wh_*` paths as proposals | all forms | database-engineer / tech-lead |
| G-F02 | `DocKind` has no `generated_form` value, and `document_types` has no `form_kind` column. The contract has both | all forms | database-engineer |
| G-F03 | The CW items in the Master have no Item Code, but the contract requires `code` and the PAC BoQ prints it. The Prisma `warehouse_items` also lacks the D60 header fields (Manufacturer, Tracking, Contract Qty, Progress Item Code, As-Built Item, Need Unit), an `is_active` flag and need rules | DN, RN, PAC BoQ | database-engineer; owner (codes) |
| G-F04 | `warehouse_site_qty` has no returned or pending quantities. The net DN − RN per site needs the movement lines | PAC BoQ | database-engineer |
| G-F05 | No dispatch date on a movement. `posted_at` is the approval time | DN row 9; TE Dispatch Complete (D59) | Q21 |
| G-F06 | No source for "Qty Approved" on the CW DN | DN row 13 | Q22 |
| G-F07 | No RN reason, and no per-line condition (`StockMovement`, `StockMovementLine`, `FormLine`) | RN rows 10, 13 | Q23 |
| G-F08 | Task E2 has one date for both CW and TE dismantle, and `procurement_records.scope` is documented as CW or TE only (no CW Dismantle) | RN rows 6, 8 | Q24 |
| G-F09 | Snags have no number. The contract `Snag` has neither `closed_by` nor `scope`. Snags (`snags`) and Quality register snag rows (`quality_inspections`, record type Snag, `snag_id`) overlap, and the source that feeds the PAC list must be fixed | PAC section 6, snag list | tech-lead |
| G-F10 | Signatory position: the staff registry (`staff-registry.md`) has no Prisma table yet. Nothing models a contractor signee or position | DN, RN, PAC, FAC signatures | people-registry; Q20 |
| G-F11 | No model for the PAC acceptance checklist (34 items and the grounding resistance value) | PAC section 5 | Q28 |
| G-F12 | No model for the FAC retention recommendation or the final acceptance statement | FAC rows 12, 13 | Q30 |
| G-F13 | No rule for the PAC "CW Schedule" box or for the Tower Type box mapping | PAC rows 7, 14 | Q29 |
| G-F14 | No setting for the warehouse name printed in "From / To Warehouse" | DN row 8, RN row 9 | tech-lead (setting key) |
| G-F15 | No source form has a QR code. The PAC and FAC footers have no number or page count | all forms | design (template) |
| G-F16 | The source forms are static HTML with `<input>` fields and fixed rows. They must be converted into templates with placeholders and repeating blocks. The `FormTemplate.placeholders` list is not yet defined (proposed names above) | all forms | design / tech-lead |
| G-F17 | The PAC region labels read "Zawya" and "Sabha"; CLAUDE.md and the DN and RN forms read "Zawia" and "Sebha" | PAC row 6 | Q29 (template wording) |
| G-F18 | BP §05 issues one form for several sites at once, as a zip. The contract has no bulk generate | all forms | tech-lead |
| G-F19 | BP §05 makes the data fields read-only in the prepare screen. `GeneratedFormPatch` lets `contractor_id`, `po_wo_ref`, `warehouse` and `lines` be edited | all forms | tech-lead. **ASSUMPTION:** lines stay editable for DN and RN, because the lines *are* the record. Site and contractor data change only through normal entry |
| G-F20 | BP §05 issues Word and PDF. CLAUDE.md (newer) uses HTML templates rendered to PDF, so no change is needed. Noted for traceability | all forms | none |
| G-F21 | Several DNs or RNs per site, and an RN that is not for a dismantle, have no clear slot or task (B7 holds a single CW DN, E3 a single RN) | DN, RN | Q19 |
| G-F22 | The DLP months value in force when the PAC is issued must be stored on the PAC record, and the FAC must read it back (CLAUDE.md DLP) | PAC section 3, FAC rows 10–11 | database-engineer |
| G-F23 | The PAC statement options "ACCEPTED WITH SNAGS" and "NOT ACCEPTED" contradict the open-snag guard | PAC section 2 | Q25 |
