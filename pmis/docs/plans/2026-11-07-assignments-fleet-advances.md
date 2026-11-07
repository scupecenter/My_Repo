# Field assignments in Procurement, Car Dispatcher and Financial Advances (plan, 2026-11-07)

Status: **approved by the product owner on 2026-11-07** (decisions Q495 to Q516). Documents updated; implementation not started yet. Planned: migration 0076, contract 0.15.0.

## 0. Hard limits (owner instruction)
- **No change** to the 10 milestones, the 9 phase gates, their conditions, stage order, Project Status weights, the SLA of existing tasks, or the Master-format export (the PR-PO sheet keeps its 15 columns).
- Only **new workflow tasks** (inside existing stages, `counts_toward_milestone = false`, not in any gate condition), **new fields on the Procurement register**, and **two new registers**.
- Two levels only (L1 Data Entry, L2 Reviewer & Approver). Operational states (reserved, disbursed, settled) are record data, not extra approval levels.
- The Car Dispatcher has nothing to do with the Warehouse dispatch of materials (DN/RN). Advances are field-work custody only, not project accounting.

## 1. Review of the proposal received
| Proposal item | Decision | Reason |
|---|---|---|
| A separate Work Assignment register | **Dropped (owner, Q504)** | The Procurement register already holds the assignment: `delivery` (Outsourced / In-House / TE Vendor), PO/WO or internal work order (task B2 and its document), and `team_id` in its "Assignment" section. A second register would duplicate PO/WO and the team. The Procurement record is extended instead (section 3). |
| A "Data Entry Assignment Rules" routing engine | Dropped | The Responsibility Matrix already routes L1/L2 per stage, register and region, to users, roles or groups, with inbox and notifications (B10, B11). |
| A separate orchestration layer | Dropped | Readiness is a derived field on the Procurement record (section 5). |
| 8 new specialised tables | Reduced to one | Records live in `register_records`. One small table, `vehicle_reservations`, gives a database guarantee against double booking. |
| A new operations inbox | Dropped | My Work and the Inbox already list the L1/L2 work of each person. |
| Extra approval levels for Finance | Dropped | Contradicts the fixed two-level rule (2026-11-01). |
| Car Dispatcher separate from the Warehouse | Kept | Confirmed by the owner. |
| Financial Advances as their own register | Kept | Own lifecycle: top-ups, extension, settlement after the work is closed. |

## 2. Owner decisions (2026-11-07)
| Q | Decision |
|---|---|
| Q495 | Assignments are entered and approved by Procurement, the Project Manager and the Team Leads, as L1 and/or L2 of the Procurement matrix row. |
| Q496 | Several Aljeel engineers per assignment; each one supervisor or executor; all may be supervisors or all executors. |
| Q497 | Advance individual by default; a group advance is allowed with one named custodian who receives and settles it. |
| Q498 | Usually one vehicle per assignment; several allowed. |
| Q499 | "Vehicle not required" allowed, with a mandatory reason. |
| Q500 | "Advance not required" allowed, with a mandatory reason. |
| Q501 | Work running past its end date: extend the booking / advance (child record linked to the parent) or open a new request. |
| Q502 | The assignment may close with advances still open; they are settled later and flagged "open after the work closed". |
| Q503 | Existing PO/WO data is the proof of an external assignment, with its document uploaded (B2 slot). |
| Q504 | No separate assignments register: the Procurement register is extended to cover internal assignments too. |
| Q505 | Field work without a PO/WO (survey, acquisition visit, inspection, maintenance, emergency) is recorded in Procurement as new scope values, delivery In-House, no PR (option A). |
| Q506 | Mobilization tasks: MOB-1 (stage 1), MOB-2 (stage 2, after B2), MOB-5 (stage 5); not counted in any milestone or gate. |
| Q507 | On approval, one vehicle booking is opened per assignment; the dispatcher adds more when needed. |
| Q508 | Disbursement: the Finance L1 holder records it with the payment proof; the Finance L2 holder approves it. |
| Q509 | Daily allowance is typed by hand for now; a rate table may come later. |
| Q510 | Each vehicle has a home region; booking outside it is allowed with a warning. The driver is a staff-registry employee when there is one, else free text. |
| Q511 | Currency: LYD only. |
| Q512 | Amounts are visible to Finance, the Project Manager, the custodian and the custodian's Team Lead only (field-level rules). Expenses are approved by the Finance L2; a custodian never approves their own expenses. The two new registers are not part of the Master-format export; each has its own Export button. |
| Q513 | MOB SLA: minimum 2, maximum 3 working days, from L2 approval of the Procurement record to ready_date. |
| Q514 | MOB holders: L1 Project Procurement Team; L2 the stage Team Lead (RF & Design / Acquisition for MOB-1, CW for MOB-2, TE for MOB-5). |
| Q515 | MOB tasks have no mandatory document; the evidence is in the linked PO/WO, payment proof and booking. |
| Q516 | MOB applicability follows the stage: MOB-1 as stage 1, MOB-2 as B2 (CW flag), MOB-5 all scenarios; N/A automatically otherwise. |

## 3. Procurement register extension (no new register)
- **Scope list (`ProcScope`)**: new values `Survey`, `Acquisition Visit`, `Inspection`, `Maintenance`, `Emergency` (data in the list catalogue). For these scopes delivery is In-House and there is no PR; the existing "In-House with PR" rule already refuses a PR.
- **New fields in the existing "Assignment" section** (no Master export column; the PR-PO sheet is unchanged):
  - `members`: list of `{user_id, member_role: supervisor | executor, is_lead}`; at least one member when the record is used for field work; members are active users.
  - `planned_start`, `planned_end`, `actual_end` (dates of the field work).
  - `vehicle_required` yes/no + `vehicle_not_required_reason` (required when no).
  - `advance_required` yes/no + `advance_not_required_reason` (required when no).
  - Derived, read-only: `readiness` (`not_ready`, `awaiting_vehicle`, `awaiting_advance`, `awaiting_both`, `ready_to_mobilize`), `ready_date`, `open_advances_after_close`.
- The Procurement template gets a new version (normal behaviour when fields change); old versions are refused on upload with the usual message.

## 4. New registers (menu "Registers & Logs", two entry ways, L1/L2, own matrix row, custom fields, Export)
### 4.1 `car_dispatcher`: Car Dispatcher (حجز وتوزيع السيارات), not site-scoped
- Record type `vehicle` (fleet master): `plate_no` (unique), `vehicle_type`, `model`, `home_region`, `driver_user_id` or `driver_name`, `permit_expiry`, `insurance_expiry`, `inspection_date`, `vehicle_status` (`available`, `under_maintenance`, `out_of_service`). Derived `bookable` = active status and permit and insurance not expired.
- Record type `booking`: `procurement_record_id` (required), `site_id`, `engineer_user_id`, `required_type`, `from_date`, `to_date`, `vehicle_id` (set by the dispatcher), `booking_state` (`requested`, `waiting_vehicle`, `reserved`, `on_trip`, `returned`, `cancelled`), `parent_booking_id` (extension), `waiting_reason`, `out_of_region` (derived warning).
- **Database guarantee:** `vehicle_reservations` with a btree_gist EXCLUDE constraint: one vehicle is never reserved for overlapping dates (409 `vehicle_already_reserved`).

### 4.2 `financial_advances`: Financial Advances (العهد المالية), site-scoped through the Procurement record
- Record type `advance`: `procurement_record_id` (required), `advance_scope` (`individual` | `group`), `custodian_user_id`, `beneficiaries` (group only), `advance_kind` (catalogue `ADVANCE_KIND`), `requested_amount`, `approved_amount`, `disbursed_amount`, currency LYD, `disbursed_date`, `payment_method`, `payment_ref`, payment-proof document slot, `period_from`, `period_to`, `parent_advance_id`, `advance_state` (`requested`, `approved_for_disbursement`, `disbursed`, `settlement_in_progress`, `settled`, `closed`, `cancelled`).
- Record type `expense`: `advance_id`, `expense_date`, `expense_kind`, `description`, `amount`, receipt slot. Approved by the Finance L2; never by the custodian.
- Record type `settlement`: `advance_id`, `returned_amount`, `settlement_note`. Derived `balance = disbursed − approved expenses − returned`. Closing needs balance 0 or an L2 note "exceptional handling".

## 5. Link rules and readiness
1. When a Procurement record with field work is approved at L2: if `vehicle_required`, one draft `booking` opens in the Car Dispatcher L1 inbox (Q507); if `advance_required`, one draft individual `advance` opens per member in the Finance L1 inbox. Same transaction, no waiting between the two, idempotent on re-approval.
2. A booking accepts only a `bookable` vehicle; L2 approval writes the reservation. No vehicle: `waiting_vehicle` with a reason; nothing is rejected automatically.
3. Extension (Q501): an "extend" action creates a child record through L1/L2; the parent keeps its history.
4. `ready_to_mobilize` when the record is approved AND (vehicle not required with reason OR every booking `reserved`/`on_trip`) AND (advance not required with reason OR every individual advance at least `disbursed`). Approval without disbursement does not count. `ready_date` is when the last condition became true.

## 6. New workflow tasks (additions only)
`MOB-1` (stage 1), `MOB-2` (stage 2, after B2), `MOB-5` (stage 5): "Field mobilization", `counts_toward_milestone = false`, outside every gate condition, fed by `ready_date` of the linked Procurement record, SLA and matrix cells like any task, N/A or deactivation by the admin. A regression test proves milestone and gate dates are unchanged.

## 7. Matrix rows, permissions, roles
New matrix rows (B11): `car_dispatcher`, `financial_advances` (holders empty in seed). Procurement row unchanged; the admin adds the PM and Team Leads to it (Q495). Seed plain roles "Fleet Dispatcher" and "Finance Officer". Field rules hide amounts per Q512.

## 8. Implementation (after the go-ahead)
| Step | Agent | Model | Deliverable |
|---|---|---|---|
| 1 | database-engineer (+ API) | sonnet | migration 0076, endpoints (extend, fleet availability, readiness), contract 0.15.0, tests incl. the milestone regression |
| 2 | frontend-engineer | sonnet | Procurement "Assignment" section (members, readiness badge), the two register menus, vehicle picker, advance balance panel, EN/AR |
| 3 | qa-engineer | haiku | suites + end-to-end scenario: Procurement record → approval → booking + advance → reserve → disburse → ready |
| 4 | tech-lead | opus | review, PR |
