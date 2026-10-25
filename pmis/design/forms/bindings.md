# CW form bindings

Data contract for the four CW templates in `templates/`. Schema references are to `apps/api/prisma/schema.prisma`.

**Schema gaps.** The schema has no tables yet for the following. They are marked NEW and proposed here for tech-lead:
- `generated_forms` (one row per issued number: form code, number, site_id, template version, status issued/voided, void reason, pdf file id, created_by).
- `number_sequences` (pattern, scope, next value, never reused).
- `stock_movements` and `stock_movement_lines` for DN/RN (kind DN/RN, site_id, warehouse, party, dates, status, then lines with item_id, qty, serials, condition).
- Signatory resolution reads `matrix_cells` and its assignees (`MatrixCell`, `MatrixCellAssignee`).

**Syntax.** `{{x}}` is HTML-escaped. `{{{x}}}` is raw and is used only for `doc.qr_svg`. `{{#each a}}..{{else}}..{{/each}}` and `{{#if x}}..{{else}}..{{/if}}` are the only blocks. Paths are dotted. There are no helpers.

**Flags.** Checkboxes cannot compare strings without helpers, so the backend supplies boolean maps, e.g. `site.region_is.Tripoli = true`. All dates are pre-formatted `YYYY-MM-DD` strings. Numbers are pre-formatted strings.

## Common to all forms

| Placeholder | Source | Rule |
|---|---|---|
| `doc.ref_no` | NEW `generated_forms.number` | Pattern from `number_sequences`, e.g. `DN-CW-TR-2026-0001`. Never reused. A voided number stays burned, and a reissue gets a new one. |
| `doc.date` | NEW `generated_forms.created_at::date` | Date of generation. |
| `doc.remarks` | NEW `generated_forms.remarks` | Free text entered by the preparer. |
| `doc.qr_svg` | generated | QR encoding the record URL (`/forms/<id>`). The engine adds `doc.qr_svg_uri` (base64 data URI) for the page footer. |
| `template.code`, `template.version` | `document_types.code` + `template_versions` (NEW kind "generated form") | Version in force at generation. Stored on `generated_forms.template_version`. |
| `site.id` | `sites.site_code` | Master B Site ID. |
| `site.name` | `sites.name` | |
| `site.region_code` / `site.region_is.<code>` | `regions.code` via `sites.region_id` | `region_is` has exactly one key set to true. Keys are Tripoli, Middle, Zawia, WM, Sebha, Benghazi, GM. The PAC labels "Zawya" and "Sabha" keep their printed spelling and use the same keys. |
| `site.region_name` | `regions.name_en` | FAC prints the region as text. |
| `site.po_wo` | `procurement_records.po_wo_no` where `scope='CW'` and `site_id` matches | Latest CW row. PAC and FAC print the PR/PO/WO label and use the same field. |
| `contractor.name` | `external_parties.name` through `procurement_records.party_id` (fallback `task_instances.external_party_id` of the CW task) | |
| `signatories.<role>.name` / `.position` / `.date` | `matrix_cells` (+ `matrix_cell_assignees`) for the stage, then `users.display_name` and role name | The person who performed or holds that level. The date is the date of the matching `workflow_steps` action when it exists, else the generation date. The signature and stamp cells stay empty. |

## DN (`GSDN_CW_DN.tpl.html`)

| Placeholder | Source | Rule |
|---|---|---|
| `doc.dispatch_date` | NEW `stock_movements.dispatch_date` | |
| `warehouse.name` | NEW `stock_movements.warehouse` (Warehouse register) | |
| `lines[].no` | computed | 1..n after filtering. |
| `lines[].description`, `.uom` | `warehouse_items.name`, `.unit` | |
| `lines[].qty_approved`, `.qty_dispatched` | NEW `stock_movement_lines.qty_approved`, `.qty_dispatched` | **Only lines with qty greater than 0 are printed.** Until the DN is approved the quantities are "pending issue" and stock is reserved. |
| `lines[].serials` | `warehouse_serials.serial_no` where `dn_no` = this DN, comma-joined | Only when `warehouse_items.serialised`. Printed as a small "S/N:" line under the description, so no extra column. |
| `blank_rows[].no` | computed | N rows (Setting `forms.blank_rows.DN`, default 3) numbered after the last line. |
| `signatories.applicant`, `.reviewer_se`, `.approver_inventory` | Matrix of the "B7 CW DN" task: level 1 entry, level 2 review, level 3 approve | Default approver is the Inventory Supervisor. |

Rules:
- An approved DN posts the issue to `warehouse_site_qty.dispatched`.
- A DN with no printable line cannot be generated.

## RN (`GSDN_CW_RN.tpl.html`)

| Placeholder | Source | Rule |
|---|---|---|
| `dismantle.date` | `task_instances.actual_date` of the CW dismantle task, or NEW `stock_movements.dismantle_date` | "CW Dismantle Actual Date". |
| `dismantle.po_wo` | `procurement_records.po_wo_no` (the dismantle order) | Latest row with `scope='CW'` and a dismantle remark or kind. |
| `warehouse.name` | NEW `stock_movements.warehouse` | Printed as "To Warehouse". |
| `rn.reason_is.faulty \| relocation \| cancellation \| other`, `rn.reason_other` | NEW `stock_movements.reason` | One flag set. `reason_other` is text for "Other". |
| `lines[].description`, `.uom`, `.qty` | as DN | Only lines with qty greater than 0. |
| `lines[].is_good`, `.is_faulty` | NEW `stock_movement_lines.condition` | Exactly one is true. `warehouse_serials.return_condition` applies to serialised items. |
| `lines[].serials`, `blank_rows[].no`, `signatories.*` | as DN | An approved RN posts the return and updates `warehouse_serials.rn_no`. |

Rule: the RN quantity per item cannot exceed the net on site (DN minus earlier RN).

## PAC (`GSDN_CW_PAC.tpl.html`)

| Placeholder | Source | Rule |
|---|---|---|
| `site.tower_is.GF_SST \| RT_GMT \| RT_Pole \| Other` | `sites.tower_type` | Unknown values map to `Other`. |
| `site.tower_height_m` | `sites.tower_height_m` | |
| `site.latitude`, `site.longitude` | `sites.latitude`, `.longitude` | Printed to 6 decimals. |
| `site.sow_is.erection \| adaption \| both` | `sites.scope_tower_erection`, `.scope_site_adaption` | `both` if both are `yes`. |
| `site.cw_start_date` | `task_instances.actual_start` of the first CW task | |
| `site.cw_finish_date` | `task_instances.actual_date` of the CW Completion task | |
| `site.schedule_is.ahead \| behind \| on` | `actual_date` compared with `baseline_date` / `planned_date` (CW Completion) | Earlier = ahead, later = behind, same = on. |
| `pac.statement_is.accepted \| with_snags \| not_accepted` | computed | `with_snags` if the site has any closed snag, else `accepted`. `not_accepted` is never set because the form cannot be generated in that state. |
| `pac.dlp_start` / `pac.dlp_expiry` / `pac.dlp_duration` | `generated_forms.created_at`; start plus `Setting dlp.months`; the setting | The duration default is a configurable ASSUMPTION (12 months) until the contract is checked. See `open-questions.md`. |
| `checks.ground_ohm` | `quality_inspections` (grounding measurement) | Optional. The "____" blank is printed when absent. |
| `snags[]` | `snags` where `site_id` matches and `scope='CW'` | `no` = S01.. ordered by `raised_at`. `description` = `snags.description`. `raised_date` = `raised_at`. `closed_date` = `closed_at`. `verified_by` = `users.display_name` of `closed_by`. `status` = the `snags.status` label. |
| `boq[]` | computed from `warehouse_site_qty` or the DN/RN lines | **BoQ qty = net on site = sum(approved DN lines) - sum(approved RN lines), per item.** Items with net qty greater than 0 only. `item_code` = `warehouse_items.item_code`. `remark` is optional. |
| `blank_rows[].no` | computed | Blank BoQ rows (default 3). |
| `pac.final_remarks` | NEW `generated_forms.remarks` | |
| `signatories.contractor` (`name`, `position`, `date`) | `external_teams` of the contractor | Contractor representative. |
| `signatories.site_engineer`, `.cw_team_lead`, `.project_manager` | Matrix of the PAC stage | The Project Manager is the signatory on the form. |

Guards:
- **PAC cannot render while open snags > 0.** The check is `count(snags where site_id and scope='CW' and status in (open, fix_uploaded, in_review)) > 0`. The API refuses, and the refusal shows in the audit log.
- The checklist (section 5) is the inspector's judgment, so Pass/Fail/N-A stay unticked for the hand.

## FAC (`GSDN_CW_FAC.tpl.html`)

| Placeholder | Source | Rule |
|---|---|---|
| `site.tower_type` | `sites.tower_type` | Printed as text. |
| `pac.ref_no`, `pac.date` | `generated_forms` of the site's PAC (latest not voided) | **FAC references its PAC automatically.** FAC cannot be generated without an issued PAC for the site. |
| `pac.dlp_start`, `pac.dlp_expiry` | PAC record | |
| `fac.recommendation_is.recommended \| not_recommended` | computed | Recommended when DLP expiry is on or before today and there are no open snags. Both are left empty if the preparer chooses "decide on paper". |
| `fac.decision_is.granted \| withheld` | same | Normally left blank, because the decision is signed by hand. |
| `signatories.cw_team_lead`, `.project_manager` | Matrix of the CW FAC stage | |

Guard: FAC cannot be generated before `pac.dlp_expiry` unless an admin override is recorded (reason and step-up MFA).

## Audit

Every generate, void and download writes an `audit_log` row (`entity_type='generated_form'`, `after` = ref_no, template version, sha256 of the PDF).
