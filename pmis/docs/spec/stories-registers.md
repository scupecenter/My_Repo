# Stories: registers

Each register is a separate module with its own menu (CLAUDE.md). Every create or change in a register goes through the stage's Matrix levels (WF-01). Its fields are those of the Master sheet named under it. One short section per register.

## RG-GEC GECOL power (D21, D50; Master AC, BW)
- **Given** a site with AC GECOL Power = Yes
  **When** a GECOL row is created
  **Then** the following are entered: PR Date (from PR-PO, Scope = GECOL), Installation Finish and Power-On Date.
  **And** Status is calculated:
  - N/A when AC = N/A;
  - Done when the scope is Yes, the site has exactly one row, and the Power-On Date is valid;
  - otherwise Pending.
- **Given** a site with AC = N/A
  **When** a GECOL row is added for it
  **Then** a scope-conflict alert is raised (D68 check 7).

## RG-HLC HLC fiber (D21, D52; Master AD, BX)
- **Given** a site with AD HLC Fiber = Yes
  **When** an HLC row is entered
  **Then** it holds Request Date, Installation Date, TX Link Tested Date, Fiber Status, and Fiber Uplink (Exchange / Post).
  **And** the TX Link Tested Date feeds Site RFI.
- **Given** Fiber Status = No Fiber or Through MW Link while AD = Yes
  **When** the row is saved
  **Then** an alert is raised (D52).

## RG-PRC Procurement and Contractors (PR / PO / WO) (D26, D37)
- **Given** an order row (Site, Scope, Delivery = Outsourced / In-House / TE Vendor, PR No. and Date, PO / WO No. and Date, Contractor, Team, Order Status)
  **When** it is approved
  **Then** Master AH PR Status, AI PO / WO Status, AJ Contractor and AK Team are calculated from it, and PR→PO (wd) is shown.
- **Given** a team whose Specialization does not match the order Scope (Scope Match: CW scopes need CW; TE Installation needs TE; TE Dismantle accepts TE or CW)
  **When** the row is saved
  **Then** its Check column flags it.
- Contractors and Teams are child lists: one contract per company and one team per row. There are no capacity or certificate checks (D26; CLAUDE.md drops team capacity).

## RG-PRM Permits & HSE (D36, D49)
- **Given** a permit row (Type from PAType, Applied, Status = Applied / Approved / Rejected / N/A, Valid From, Valid To)
  **When** it is approved
  **Then** Validity is calculated.
  **And** gates use the permit as described in rules.md §2.2 and §10.
- **Given** Status = N/A without a reason or an approver
  **When** the row is saved
  **Then** it is refused.
- **Given** a PTW row with Stop Work = Yes and no Stop Lifted Date
  **When** gate AX or DQ is evaluated
  **Then** the gate stays blank.
- HSE incidents are deferred to the mobile app (CLAUDE.md).

## RG-WH Warehouse (D57–D62, D72)
- **Given** a movement (Type = PL / OPEN / ADJ / TE DN / CW DN / TE RN / CW RN, Doc No., Date, Site, Status, Condition, Reason, quantities per item)
  **When** it is approved
  **Then** the 10-row summary is updated: Received, Delivered %, Issued, Returned Good, Faulty / Damaged, On Hand, Reserved, Available, Need, Shortfall.
  **And** TE Dispatch Complete is recalculated (rules.md §7).
- **Given** a serial-tracked item
  **When** a DN or RN is approved
  **Then** each serial gets its Site, Dispatch Date and Return Condition.
  **And** Installed is set from TE Completion (D62).
- **Given** a movement that would make Available negative
  **When** it is submitted
  **Then** it is blocked with the item and its shortfall.
  - ASSUMPTION: the movement is blocked. The Master only flags this case (D68 check 19).

## RG-QI Quality (QC / Snag / ITP / NCR) (D19, D54)
- **Given** a record (Record Type, Stage, Activity, Point Type, Severity = Critical / Major / Minor, Team, Raised Date, Target Date)
  **When** it is open
  **Then** Blocking is calculated: an unreleased Hold point, an NCR that is not closed, or an open Major snag blocks.
  **And** ITP Ready is calculated (D33).
- **Given** a snag
  **When** fix photos are approved (DL-06)
  **Then** the snag is closed with the closer and the date.
- **Given** a snag with N/A
  **When** it is saved without a reason or an approver
  **Then** it is refused.

## RG-ISS Issue Log, several issues per site (CLAUDE.md; BP §09; Master GA:GE)
- **Given** a site
  **When** users raise 3 issues (Issue, Owner, Raised Date, Status = Open / In Progress / Closed, Remark; plus the blocked gate, due date, root cause and corrective action from BP §09)
  **Then** all 3 are kept, each with its own lifecycle and the option to reopen.
- **Given** a list of open issues
  **When** it is displayed
  **Then** it is ordered by Site Type (Core, MFN, FN, HUB, Terminal), then by age in working days, oldest first (D41).
- **Given** an issue without an owner, date or status
  **When** it is saved
  **Then** it is refused (DQ24).
- Master import: GA:GE become 1 issue per site. See open-questions Q11.

## RG-RSK Risk Register (D3, D42, D70)
- **Given** a risk with Probability and Impact
  **When** it is saved
  **Then** Score = P × I, and Level = Critical if ≥ 15, High if ≥ 10, Medium if ≥ 5, otherwise Low.
- **Given** that Next Review Date is earlier than today and Status is not Closed
  **When** the list is shown
  **Then** the date is shown in red.
- **Given** Status = Materialized
  **When** the user presses "Create issue"
  **Then** an issue is created for each affected site (BP §09).
- The existing 25 risks are migrated with Risk Owner. Action Owner is left empty (D42).

## RG-CHG Change Control (D27, D53)
- **Given** a change (Change Type: Scope Change, Suspension, Resumption, Cancellation, Relocation, Baseline Re-plan, Data Correction, Cutover Rollback, Cutover Window; Old and New Value; Reason; Request Date)
  **When** it is approved (Approval, Approved By, Approval Date)
  **Then** its effects apply:
  - gate shift (rules.md §2.3);
  - On Hold, Cancelled, scope recalculation (rules.md §4);
  - S-2 from the Cutover Window row;
  - Rollback Count (Master DI).
- **Given** a Data Correction
  **When** it is approved
  **Then** approved dates and documents are not deleted. They are versioned (BP §03).

## RG-RDY Readiness & Handover (D55)
- **Given** a site
  **When** someone enters Commissioning Power Safe Date, Uplink Ready Date, the O&M Checklist (14 items, from the Guide), O&M Acceptance, Keys Handover, HOTO Package, Legacy Handover, Obligations Closure and the closure approval
  **Then** these are calculated:
  - Open Controls, a text list of the missing controls;
  - Ops Acceptance Valid Date (→ Master EY);
  - HOTO Package Valid Date (→ EW);
  - Final Closure (→ FM).
- **Given** that Commissioning Power Safe Date is missing
  **When** gate CV is evaluated
  **Then** the gate stays blank.

## RG-ASB As-Built (D56)
- **Given** a site
  **When** the 67 As-Built columns are entered (quantities, configuration, planned RSL)
  **Then** D8 reads Configuration and planned RSL from them.
  **And** they feed the CW PAC form quantities (BP §05).

## RG-MTG Meetings (CLAUDE.md lists the register; no Master sheet)
- **Given** a meeting record
  **When** it is saved
  **Then** it holds Date, Title, Type, Attendees (users), Linked sites, Minutes file, and Action items (owner, due date, status).
  - ASSUMPTION: all of these fields. See open-questions Q12.
- **Given** an action item that is overdue
  **When** the dashboard loads
  **Then** it is counted under Exceptions & Alerts. (ASSUMPTION)

## RG-ASG Field assignments in Procurement (Q495–Q506; plan 2026-11-07-assignments-fleet-advances.md §3)
- **Given** a Procurement record for field work
  **When** L1 fills the "Assignment" section (members, planned_start, planned_end, vehicle_required, advance_required)
  **Then** the record needs at least one member, each `supervisor` or `executor`, and every member is an active user (Q496).
  **And** these fields have no Master column and the PR-PO export keeps its 15 columns.
- **Given** `vehicle_required` = no
  **When** `vehicle_not_required_reason` is empty
  **Then** the save is refused; with a reason it is accepted (Q499).
- **Given** `advance_required` = no
  **When** `advance_not_required_reason` is empty
  **Then** the save is refused; with a reason it is accepted (Q500).
- **Given** a Procurement record with scope Survey, Acquisition Visit, Inspection, Maintenance or Emergency
  **When** it is saved with delivery In-House and no PR
  **Then** it is accepted (Q505).
  **And** the same record with a PR number is refused by the existing "In-House with a PR" rule.
- **Given** a Procurement record with a PO/WO (Outsourced or TE Vendor) or an internal work order (In-House)
  **When** the B2 document is uploaded
  **Then** it is the proof of the assignment (Q503); there is no separate assignments register (Q504).
- **Given** the Project Manager or a Team Lead is added to the Procurement matrix row
  **When** they enter or approve an assignment
  **Then** they act as L1 and/or L2 of that row (Q495).
- **Given** an old version of TPL-PO
  **When** it is uploaded after the fields changed
  **Then** it is refused with the usual old-version message.

## RG-CAR Car Dispatcher: booking a vehicle (Q498–Q501, Q507, Q510)
- **Given** a Procurement record with `vehicle_required` = yes
  **When** it is approved at L2
  **Then** one draft booking opens in the Car Dispatcher L1 inbox (Q507).
  **And** approving it again opens no second booking (idempotent).
- **Given** a vehicle already reserved from 10 to 14 of the month
  **When** a booking for the same vehicle from 12 to 16 is approved at L2
  **Then** the reservation is refused with 409 `vehicle_already_reserved`.
- **Given** a vehicle whose status is under_maintenance, or whose permit or insurance has expired (`bookable` = false)
  **When** the dispatcher selects it for a booking
  **Then** it is refused.
- **Given** a booking with no suitable vehicle
  **When** the dispatcher cannot assign one
  **Then** it is set to `waiting_vehicle` with a `waiting_reason`; nothing is rejected automatically.
- **Given** a vehicle whose home region differs from the site's region
  **When** it is booked
  **Then** the booking is allowed and shows the `out_of_region` warning (Q510).
- **Given** work running past its end date
  **When** the dispatcher uses "extend" on a booking
  **Then** a child booking (`parent_booking_id`) goes through L1/L2 and the parent keeps its history (Q501).
  **And** a new request instead of an extension is also allowed.
- **Given** a Procurement record needing several vehicles
  **When** the dispatcher adds more bookings
  **Then** each is linked to the same `procurement_record_id` (Q498).
- **Given** the Car Dispatcher register
  **When** a user exports
  **Then** it uses its own Export button; it is not a part of the Master-format export (Q512).

## RG-ADV Financial Advances (Q497, Q500–Q502, Q508, Q509, Q511, Q512)
- **Given** a Procurement record with `advance_required` = yes and three members
  **When** it is approved at L2
  **Then** three draft individual advances open in the Finance L1 inbox, one per member, in the same transaction as the booking (plan §5).
  **And** approving it again opens none more.
- **Given** a group advance
  **When** it is saved
  **Then** it needs one named `custodian_user_id` who receives and settles it, plus `beneficiaries` (Q497).
- **Given** an advance in `approved_for_disbursement`
  **When** the Finance L1 holder records the disbursement with the payment proof and the Finance L2 holder approves it
  **Then** the state becomes `disbursed` (Q508).
  **And** there is no third approval level.
- **Given** an expense recorded by the custodian
  **When** the custodian tries to approve it
  **Then** it is refused; only the Finance L2 approves expenses (Q512).
- **Given** an advance with disbursed 1000, approved expenses 700 and returned 100
  **When** the panel is read
  **Then** `balance` = 200 (disbursed − approved expenses − returned), shown in LYD only (Q511).
- **Given** an advance with balance 0
  **When** it is closed
  **Then** it becomes `closed`.
- **Given** an advance with a balance other than 0
  **When** it is closed without an L2 note "exceptional handling"
  **Then** the closure is refused; with the note it is accepted.
- **Given** the assignment's work is closed while an advance is not settled
  **When** the assignment closes
  **Then** it is allowed and the advance shows "open after the work closed"; `open_advances_after_close` counts it (Q502).
- **Given** a user who is not Finance, the Project Manager, the custodian or the custodian's Team Lead
  **When** they open an advance
  **Then** the amount fields are hidden (field-level rules, Q512).
- **Given** a top-up or extension
  **When** it is created
  **Then** it is a child record (`parent_advance_id`) through L1/L2 (Q501).
- **Given** the Financial Advances register
  **When** a user exports
  **Then** it uses its own Export button; it is not a part of the Master-format export (Q512).

## RG-RDY Readiness to mobilize and the MOB tasks (Q506; plan §5 rule 4 and §6)
- **Given** a Procurement record approved with a vehicle `reserved` and an advance only `approved_for_disbursement`
  **When** readiness is derived
  **Then** it is `awaiting_advance`; approval without disbursement does not count.
- **Given** the same record when the advance becomes `disbursed`
  **When** readiness is derived
  **Then** it is `ready_to_mobilize` and `ready_date` is that date.
- **Given** `vehicle_required` = no with a reason and `advance_required` = no with a reason
  **When** the record is approved
  **Then** it is `ready_to_mobilize` at approval.
- **Given** a vehicle still `waiting_vehicle` and no advance disbursed
  **When** readiness is derived
  **Then** it is `awaiting_both`.
- **Given** MOB-1, MOB-2 and MOB-5
  **When** the linked record becomes ready
  **Then** the task follows its `ready_date`; it counts toward no milestone and sits in no gate condition (`counts_toward_milestone` = false).
- **Regression: Given** a site with the MOB tasks added in stages 1, 2 and 5
  **When** milestone and gate dates are computed with and without the MOB tasks done or open
  **Then** all 10 milestone dates and all 9 gate dates are identical, and the existing SLA and Project Status weights are unchanged.
