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
