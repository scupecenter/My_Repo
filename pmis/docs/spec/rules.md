# GSDN PMIS: business rules (P0)

Sources: Blueprint v1.1 (`docs/reference/GSDN_PMIS_Blueprint_v1.1.html`, cited as "BP §nn"), the decisions log (`docs/reference/GSDN_Rebuild_Decisions.md`, cited as Dnn), the Master (`GSDN_Site_Master.xlsx`, cited by sheet and column), and `pmis/CLAUDE.md` (cited as "CLAUDE.md", binding product-owner decisions of 2026-10-24).
Anything not stated in a source is marked **ASSUMPTION** and is listed in `open-questions.md` when it matters.
Task codes are those in `task-catalogue.csv` (BP §03 step table).

Precedence when sources disagree: CLAUDE.md (newest owner decisions) > Master formulas > BP v1.1 text. Every disagreement found is written down here or in `open-questions.md`.

---

## 1. Shared definitions

| Term | Rule | Source |
|---|---|---|
| Valid date | A date between DateMin (2020-01-01) and DateMax (2035-12-31). Anything outside is treated as empty. | D13, D73; Setting Parameters |
| Actual date in the future | Not allowed for actual dates. An N/A step has no date. | BP §03 alert rule 11 |
| CW applies | `Yes` if AA Tower Erection = Yes or AB Site Adaption = Yes; `N/A` if both are N/A; otherwise unknown (blank). | Site Calc D |
| TE applies | `Yes` if AE Full Scope = Yes or AF IP Router Only = Yes; `N/A` if both N/A. | Site Calc E |
| RFI applies | `Yes` if any of AA, AB, AC, AD = Yes; `N/A` if all four are N/A. | Site Calc F |
| Active site | Overall Status is not Cancelled. | BP §06 |
| Mandatory site fields | Site ID, Name, Region, Site Type, Project Phase, Delivery Batch, Delivery Scenario, AA:AF, CW Delivery Model. PRE-CW Completion is not computed while any of AA:AF is blank. | D68 check 6; Master AW |

## 2. Gates and milestones

### 2.1 Milestones
- There are 10 milestones in a fixed order: Site Release (V), PRE-CW Completion (AW), CW Completion (BP), Site RFI (BZ), TE Completion (CU), On-Air (DP), TE PAC (EL), KPI Acceptance (ES), HOTO (EY), Final Closure (FM). Each one has a baseline column next to it: U, AV, BO, BY, CT, DO, EK, ER, EX, FL. (CLAUDE.md; BP §17; Master row 2.)
- A milestone is calculated and never typed. It appears when its gate is open and all of its conditions are met, and it equals the latest of the condition dates. (BP §03)
- The derivation of each milestone is in the `notes` column of the `milestone` rows in `task-catalogue.csv`, copied from the Master formula in row 5 of the named column.
- Exception (CLAUDE.md): **Site RFI** works like a task. Its date field unlocks when the BZ conditions are met. It is pre-filled with the latest condition date and can be edited. It then goes through review and approval. It has no document. Its approved value is the MS4 date.
  - ASSUMPTION: the edited date may not be earlier than the RFI Readiness gate (BQ). This follows the `>= gate` pattern used in BP, CU, DP, EL and EY.
- Current Milestone (FX) is the highest milestone achieved, or "Not Started". Next Milestone (FY) is the one after it. (Master FX, FY)

### 2.2 Gates
The 9 gates are W, AX, BQ, CA, CV, DQ, EM, ET and EZ (BP §21; Master row 2).

**Base rule (CLAUDE.md, BP §03):** the gate date equals the previous milestone date. Change Control can then shift it (§2.3).

**Extra conditions that the Master adds to some gates** (Master row 5 formulas). For these gates the date is the latest of the previous milestone and the listed conditions, so it can be later than the previous milestone. This refines the CLAUDE.md wording (see open-questions Q9).

| Gate | Opens from | Extra conditions (Master) | N/A when |
|---|---|---|---|
| G2 Pre-CW Readiness (W) | MS1 | none | never |
| G3 CW Readiness (AX) | MS2 | MAX with: the first approved Access - CW Valid From, and the first PTW - CW HSE Valid Date. Each permit is also satisfied by an approved N/A (with reason and approver, D36). The gate stays blank while a PTW - CW Stop Work is active. | CW N/A |
| G4 RFI Readiness (BQ) | MS3 if CW applies, else MS2 | none | RFI N/A |
| G5 TE Installation Readiness (CA) | MS4, or MS1 where RFI is N/A | MAX with: the first approved Access - TE Valid From, and the first PTW - TE HSE Valid Date (an approved N/A is accepted) | TE N/A |
| G6 On-Air Readiness (CV) | MS5 | MAX with: Commissioning Power Safe Date (Readiness & Handover). The gate stays blank until it exists. | never (follows MS5) |
| G7 TE PAC Readiness (DQ) | MS6 | Blank while a PTW - TE Stop Work is active | never |
| G8 Cluster Optimization Readiness (EM) | MS7 of the site itself | none | never |
| G9 HOTO Readiness (ET) | MS8 | none | never |
| G10 Final Closure Readiness (EZ) | MS9 | none | never |

- When a stage does not apply, its milestone passes the date through or is N/A: if CW is N/A, AW = W, and AX and BP are N/A (Master AW, AX, BP). This is how stages are skipped (BP §03 "skipping stages").
- **Step unlocking (BP §03):** a step opens when the date of the previous step is *approved*. Entering a date is not enough. An approved completion makes the next step `Pending`. The stage owner moves it to `Ongoing` with a start date (default: today; for TE installation, the TE MOS date). `Ongoing` does not count as done.
- **Rejected document after approval (BP §03):** the date goes back to "awaiting confirmation" and leaves the KPIs until a replacement is approved. Steps that were opened after it stay open.

### 2.3 Change Control suspension shift
Source: the formula in Master W, BQ, CV, DQ, EM, ET and EZ, which is the same in each column; BP §03; CLAUDE.md.

For a gate whose candidate date is `G0` (the previous milestone, or the MAX in §2.2):
```
S = latest approved Suspension approval date  <= G0   (Change Control, Change Type = Suspension, Approval = Approved)
R = latest approved Resumption approval date  <= G0
if S > R:                      # suspended on G0
    R1 = earliest approved Resumption approval date > S
    gate = R1 if R1 exists else LOCKED (blank)
else:
    gate = G0
```
- A suspension approved after the gate opened does not move that gate. It sets Overall Status to On Hold (§2.4), and the next gate is evaluated against it when that gate's candidate date arrives.
- SLA during a suspension: the SLA counter stops in the contractor scorecard only. It keeps running in project KPIs. (BP §03)
  - ASSUMPTION: suspended working days are the working days between an approved Suspension and the next approved Resumption, and they are subtracted from the contractor-attributed delay (§8).

### 2.4 Overall Status (Master FZ)
The first rule that matches applies:
1. **Cancelled**: an approved Cancellation row exists in Change Control.
2. **Completed**: Final Closure (FM) is valid.
3. **On Hold**: on the Report Date (in the PMIS, today), the latest approved Suspension is after the latest approved Resumption.
4. **In Progress**: Current Milestone is not "Not Started".
5. **Not Started**: none of the above.

A cancelled site leaves the execution scope and the weights. It stays in the dismantle pages, and dismantle opens for it if work was done or equipment was installed (BP §03).

## 3. SLA working-day calendar
- **Working days:** the weekend is Friday and Saturday (NETWORKDAYS.INTL weekend code 7). Holidays come from the Holidays table (Setting "Public Holidays", Date and Holiday columns). (CLAUDE.md; D13; D73; SLA sheet row 1)
- **Duration** (SLA sheet formulas):
  - If end < start, duration = −NETWORKDAYS.INTL(end+1, start, 7, Holidays). A negative value raises an alert (DQ10).
  - If end = start, duration = 0.
  - Otherwise duration = NETWORKDAYS.INTL(start+1, end, 7, Holidays). The start day is not counted.
- **Open age:** working days from the start event to today (Report Date in the Master). (SLA sheet "OPEN" block)
- **Due date** = WORKDAY.INTL(start, SLA max, 7, Holidays). This is the pattern of Master DH. The expected date of a Pending step = completion of its predecessor + SLA max. (BP §03)
- **Colour:** green when ≤ min, amber when ≤ max, red when > max. Amber notifies the task owner. Red escalates to the main role. Project Manager gets a weekly summary of all red items. (BP §06, §14)
- **Steps without an SLA** ("per plan"): a notification and then an escalation when the planned or baseline date passes without completion. (BP §06)
- **N/A steps** are excluded from SLA and from the end-to-end totals. (BP §06)
- **SLA limits** are data in settings, with the codes of the SLA sheet: rows 6 and 7 hold Min and Max, plus planning links B01–B07. A change can be applied retroactively or from a chosen date. Saved weekly snapshots are never recalculated. (D64, D39, BP §06)
- **Holidays table:** the Master holds no holiday rows (Setting F:G is empty). See open-questions Q4.

### 3.1 SLA steps and limits (working days)
From SLA sheet rows 3–7 and D39 planning links. The task code each one belongs to is in `task-catalogue.csv`.

| Code | From → To | Min–Max | Applies |
|---|---|---|---|
| A-1 | Search Ring Received → first SAR | 10–20 | sites with a search ring |
| A-3 | TSSR Submitted → Approved | 1–2 | all |
| B01 | Site Release → CW PR / WO | 0–1 | planning link (D39) |
| B-2 | PR Date → PO / WO Date | 1–2 | CW, Outsourced |
| B-3 | PO / WO Date → CW Access | 1–2 | CW |
| B-4 | CW Access → CW Survey Actual | 1–2 | CW |
| B-5 | CW Survey → Report Submitted (AR) | 1–2 | CW and STA / ST (D47) |
| B-6 | AR (with analysis) or AO → AR | 1–2 | CW (D47) |
| B-7 | Layout Submitted (AR) → Approved (AS) | 1–2 | CW |
| B-8 / B-9 | Layout Approval → CW MOS | 1–2 | tower / adaption only |
| B-10a / B-10b | CW MOS → CW Actual End | 14–21 RT / 30–45 GF | tower |
| B-11 | CW MOS → CW Actual End | 4–8 | adaption only |
| B-13 | CW Completion → CW PAC | 1–3 | CW |
| B-15 | CW DLP End → CW FAC | 3–10 | CW |
| B02 / B03 | CW PR / WO → GECOL PR / HLC Request | 0–1 | planning links (D38, D39). The start is Site Release when the site has no CW. |
| C-2 | GECOL PR → Installation Finish | 7–10 | GECOL = Yes |
| C-4 | HLC Request → Installation Date | 7–10 | HLC = Yes |
| RFI | RFI Readiness → Site RFI | 1–1 | RFI applies |
| E2E-B1 / B2 / B3 | PR (Outsourced) or PO / WO (In-House) → CW PAC | 11–23 / 22–38 / 38–62 | adaption only / RT tower / GF tower (D40) |
| D-1 | **Site RFI date (MS4)** → TE Access | 3–5 | TE (CLAUDE.md overrides SLA sheet Y, which starts from Site Release) |
| D-2 … D-4 | TE Access → Survey → DN Submitted → DN Approved | 1–2 each | TE |
| B04 | DN Approved → TE Dispatch Complete | 0–1 | planning link |
| D-5 | TE Dispatch Complete → TE MOS | 1–1 | TE (D59) |
| D-6 | TE MOS → TE Actual End | 3–5 | TE |
| D-7, D-8, D-9, D-10 | Actual End → Commissioning → MW Alignment → Integration → On-Air | 1 each | TE; D-8 only with MW. Without MW, D-9 starts from Commissioning. |
| D-11 / D-12 | On-Air → SSV / HWID | 3–5 / 1 | TE |
| D-13, D-14, D-15 | HWID → EIR → PAT → As-Built | 3–5, 3–5, 1–2 | TE |
| D-16 | MAX(As-Built, SSV) → TE PAC | 5–10 | TE |
| B05 | TE PAC → KPI Acceptance | 1–5 | planning link |
| D-17 | KPI Acceptance → HOTO | 3–5 | TE |
| E2E-D1 / E2E-D2 | TE MOS → On-Air / TE Access → HOTO | 8–12 / 30–51 | TE |
| S-1, S-2 | MOP Submitted → Approved; Cutover Window request → approval (Change Control) | 1 each | Hot / Cold Swap (D53) |
| S-3 / S-4 | Window Start → Window End | 1 each | Hot / Cold Swap (D27) |
| S-5 | On-Air → TE Dismantle Actual | 1 | Cold Swap |
| B06 | TE DLP End → TE FAC | 3–10 | planning link |
| B07 | latest FAC / HOTO → Final Closure | 1–3 | planning link |

- **D-1 start event (CLAUDE.md):** D-1 starts from the MS4 date, or MS1 where RFI is N/A.
  - It does not start from the CA gate date, because CA itself waits for the Access - TE permit. Starting there would be circular.
  - D-1 is not measured for Hot / Cold Swap (BP §06).
- **DLP is not an SLA** (BP §06; Master FA:FB, FF:FG):
  - CW DLP End = CW PAC + 90 calendar days (Setting "CW DLP period").
  - TE DLP End = EDATE(TE PAC, 12 months) (Setting "TE DLP period").

## 4. Scenario rules
The Delivery Scenario is Master Z: New Build, Expansion, Hot Swap, Cold Swap or Relocation. The scope flags are AA:AF. Each scenario is a template in settings, so adding one needs no code change (BP §03). The applicability per task is in the `scenario_applicability` column of the catalogue.

| Scenario | Rule | Source |
|---|---|---|
| New Build | All stages, each one subject to the scope flags. | BP §03 |
| Expansion | Site Release keeps TSSR (A2) and LLD (A4) only, so A1, A3, A5 and the civil-aviation condition are N/A. PRE-CW and CW apply only when adaption work exists. Power-On and TX test apply only if new power or fiber is needed. TE through Final Closure all apply. Conditions come from AA:AF. | CLAUDE.md |
| Cold Swap | Stages 1–3 follow the flags (usually N/A). RFI is N/A, so installation starts from Site Release. The new equipment is installed in parallel, then MOP (S-1), then window (S-2, S-4), then Cutover = On-Air. The legacy equipment is dismantled within 1 wd of On-Air (S-5; Legacy Dismantle Due DH = WORKDAY.INTL(DP, S-5 max)). Then Legacy Handover Date. | BP §03; Master DH |
| Hot Swap | Same as Cold Swap, but dismantle, install and cutover all happen inside one window (S-1, S-2, S-3). | BP §03 |
| Relocation | Same Site ID. Stages 1–3 are done in full at the new location. RFI applies at the new site. Dismantle at the old site comes first (TE RN, then TE DN). It is recorded in Change Control (Relocation). On approval, a snapshot of the whole site is taken. | BP §03, §05 |

- **Conflict:** BP says RFI is N/A for Hot / Cold Swap, but Site Calc F decides RFI from the flags only. See open-questions Q3.
- **Scope change (BP §03):** changing AA:AF, the Scenario, or a relocation needs a Change Control row (Scope Change / Relocation) with the old and new value and an approval.
  - On approval, N/A states, locks, weights and SLA are recalculated. The approved baseline does not change.
  - A re-plan is a "Baseline Re-plan" row. Affected values carry a "changed by scope" flag.

## 5. Cluster rule
Sources: CLAUDE.md; Master EM, EQ, ES; BP §03.
- Each site's Cluster Optimization gate (EM) opens from its own TE PAC.
- KPI Source Validation (EQ) is evaluated in this order:
  1. Cluster ID is blank: "Missing Cluster ID".
  2. No source date in the cluster: "No Source".
  3. More than one source date in the cluster: "Multiple Sources".
  4. Otherwise: "Valid".
- KPI Acceptance (ES) = the single cluster source date, when EQ = Valid and that date is on or after the site's EM. The value is recorded once per cluster and applied to all its sites.
- The site page shows cluster progress, for example "6 of 9 sites at TE PAC". This is information only and does not gate anything.
- A cancelled site is excluded from the cluster. Moving a site to another cluster after acceptance needs approval and sets the flag "cluster membership changed" (BP §03).

## 6. Project Status (progress to HOTO)
Sources: D65; BP §06 level 5; Project Status sheet.
- There are 8 activities whose weights total 100: Survey & Engineering 12, Site Acquisition & Permits 8, Procurement & Supply 5, Civil Work & Site Readiness 25, TE Installation 20, Integration & On-Air 12, Testing & Acceptance 13, Training & Handover 5.
- There are 45 items (5 + 3 + 10 + 8 + 4 + 6 + 7 + 2). The item weights inside each activity total 100.
- Measurement ends at HOTO. FAC and Final Closure are not measured.
- All weights are editable data (versioned, with an effective date, never applied retroactively). Done and Applicable values are read from approved data.

| Item | Weight | Method · source (plan basis) |
|---|---|---|
| 1.1 TSSR approved | 30 | units · RF & Design TSSR Approved |
| 1.2 Layout / STA / ST approved | 25 | units · Master AS (plan: Baseline AV) |
| 1.3 HLD | 15 | 0/100 · Deliverables HLD |
| 1.4 LLD per site | 20 | units · LLD Approved (plan U) |
| 1.5 Technical document templates | 10 | 0/100 · DOC |
| 2.1 Candidate selected | 30 | units · Acquisition Selection Date (plan U) |
| 2.2 Site acquired | 50 | units · Master T (plan U) |
| 2.3 CW access permission | 20 | units · Access - CW / AL (plan AV) |
| 3.1 CW PO / WO | 15 | units · AI (plan AV) |
| 3.2 BTS · 3.3 PtP · 3.4 CPE · 3.5 Battery · 3.6 Cabinet · 3.7 Router · 3.9 Core server | 14.45 · 14.45 · 8.5 · 17 · 17 · 8.5 · 1.7 | received in WH (PL, OPEN, ADJ) ÷ Contract Qty by Progress Item Code (plan: WH Planned Delivery Date) |
| 3.8 NMS · 3.10 Billing | 3.4 · 0 | 0/100 · NMS-S, BILL (weight 0 = "Not weighted") |
| 4.1 Adaption items | 35 | one unit per item · BD BE BF BG BJ = Done (plan BO) |
| 4.2 Tower items | 10 | one unit per item · BA BB BC (plan BO) |
| 4.3 Internal AC/DC | 8 | units · BI = Done |
| 4.4 GECOL Power-On | 12 | units · BW = Done (plan BY) |
| 4.5 Site optical fiber | 6 | units · BH = Done |
| 4.6 HLC link | 9 | units · BX = Done (plan BY) |
| 4.7 Site RFI | 15 | units · BZ (plan BY) |
| 4.8 CW PAC | 5 | units · BV (plan BY) |
| 5.1 TE DN approved · 5.2 TE MOS · 5.3 TE items · 5.4 HWID | 5 · 15 · 70 · 10 | CH, CJ, CK–CO, DT (plan CT; HWID plan EK) |
| 6.1 Pilot · 6.2 Commissioning · 6.3 MW alignment · 6.4 Integration · 6.5 On-Air · 6.6 NMS integration | 10 · 20 · 10 · 15 · 35 · 10 | PILOT, CW, CX, DA, DP, NMS-I (plan DO) |
| 7.1 EIR per system · 7.2 PAT per system · 7.3 SSV · 7.4 As-Built · 7.5 TE PAC · 7.6 KPI Acceptance · 7.7 NMS acceptance | 20 · 20 · 10 · 10 · 20 · 10 · 10 | DU–DX, DZ–EC, DS = Pass, EF, EL, ES (plan ER), NMS-A (plan EK) |
| 8.1 Vendor training · 8.2 HOTO | 50 · 50 | TRN, EY (plan EX) |

Calculation rules (BP §06):
- **Units:** approved done ÷ applicable, capped at 100%. Applicable = active sites in the item's scope.
- **Grouped items:** each component that is not N/A counts as one applicable unit. A blank component counts as applicable.
- **0/100 items:** recorded as units with a supporting document. A manual percentage is never entered.
- **Out-of-scope work:** an item with no applicable units is dropped and its weight is redistributed inside its activity. An activity with no items is redistributed across the other activities.
- **Overall result:** Actual = Σ activity weight × activity %. Planned uses the same weights on plan dates and is shown only when every weighted item has plan dates. SPI = Actual ÷ Planned. Plan Coverage = the share of weight whose plan dates are complete.
- **Site filter:** the central items (1.3, 1.5, 3.2–3.10, 6.1, 6.6, 7.7, 8.1) are dropped and the weights redistributed. Pilot and NMS-I are counted by their Site ID.
- **Admin overrides:** tasks closed by admin override are flagged or excluded in KPIs (CLAUDE.md).
  - ASSUMPTION: by default they are excluded from Project Status. A setting can include them with a flag.

### 6.1 Final Closure KPI (separate, CLAUDE.md)
- **Sites closed** = active sites with FM valid.
- **% closed** = sites closed ÷ base. ASSUMPTION: base = active sites with HOTO (EY) achieved. The alternative base, all active sites, is shown as a secondary figure.
- **Pending CW FAC:** CW applies, CW PAC valid, FE empty. Age = working days from CW DLP End (FB) to today. Before FB the site counts as "Not due". ASSUMPTION: age measured from DLP End.
- **Pending TE FAC:** TE applies, TE PAC valid, FJ empty. Age measured from TE DLP End (FG). ASSUMPTION, same as above.
- Shown with the dashboard pattern Scope / Done / Pending / Not Due (D67).

## 7. Warehouse need from design and TE Dispatch Complete
Sources: D58, D59, D72; Site Calc H–K; Setting tblRegionVendor and NeedUnit.

Need is computed per site, only for sites where TE applies.

| Need unit | Quantity per site |
|---|---|
| Cambium Sector | RF & Design "Sectors" count, if the region's WL Vendor (Setting tblRegionVendor) = Cambium, else 0 |
| Intracom Sector | the same count, if the region's vendor = Intracom, else 0 |
| MW Half-link | (1 if the site's own MW Far-end Site is neither blank nor N/A) + (the number of sites whose MW Far-end Site is this site). Each half-link = 1 Radio + 1 Antenna. Any site type can be a far end. |
| LPU Kit | 2 |
| Router | 1 |
| Cabinet | 1 |
| Battery | 2 |

- The sector count may be 0 for FN / MFN sites, by design (D58).
- A region with no WL Vendor raises an alert (D68 check 27).
- **Dispatched to a site** = Σ TE DN (Status Dispatched) − Σ TE RN (Status Received), per need unit. Each WH item has a "Need Unit" column (D60).
- **TE Dispatch Complete Date** = the date of the last DN after which the dispatched quantity covers the need for *every* need unit (D59). This date is task D4b. It starts SLA D-5 and planning link B04.
- **Dashboard "Complete Units"** covers the whole project and ignores the filters (D72).
  - Per unit, with Cambium and Intracom kept separate, it shows: Need (scope), Dispatched, Remaining Need, Available (WH), and Shortfall = max(0, Remaining Need − Available) (D58, D67).
  - ASSUMPTION: this is the shortfall formula, inferred from the column names.
- **Available** (D61) = On Hand − Reserved. Reserved = quantity on approved DNs that are not yet dispatched (BP §06 "warehouse balance").
- IP Router Only sites: see open-questions Q6.

## 8. Delay attribution (PMIS-only, v1). All formulas are ASSUMPTIONS for owner review.
Sources: CLAUDE.md (each task shows its responsible external party; delays are attributed correctly); BP §09 (attribution periods); BP §14 (days above SLA attributed to the executor R; the Aljeel AAT SE is never charged).

For a task instance with SLA max `M` and duration (or open age) `d`, in working days:
1. **Overdue days** `O = max(0, d − M)`. A task with no SLA but with a baseline date: `O = working days from the baseline date to the actual date (or today)` (ASSUMPTION).
2. **Default party** = the task's `responsible_party` from the catalogue (for example A&T Global for D2–D10, GECOL for C2, HLC for C4, the CW contractor from PR-PO AJ for B4–B11). It is never an AAT SE.
3. **Attribution periods:** rows (from, to, party, reason, optional document) entered by the stage owner. They go through entry → review → approve. The approved overdue days that fall inside a period move to that period's party. Overlapping periods are counted and flagged; ASSUMPTION: the later-approved period wins.
4. **Unattributed days** = O − days moved by periods − days during approved Suspension (§2.3).
   - ASSUMPTION: they stay on the default party, tagged "default (R)" so the two can be told apart. BP §09 says unattributed days are charged to no one; see open-questions Q7.
5. **Reports:** delay days per party, per step, region and contractor; the % unattributed; the number of overlapping periods (BP §06 indicator "delay by party").

## 9. Project health index (PMIS-only, v1). Every formula is an ASSUMPTION for owner review.
Source: BP §06 level 4. The factors are progress, baseline adherence, SLA adherence, documentation completeness, first-time approval and open critical issues. Each factor is ≤ 100. A factor with no data is excluded and its weight redistributed. The index is kept separate from progress on purpose.

| Factor | Formula (scope: active sites in the current filter) | Default weight |
|---|---|---|
| P Progress | Project Status Actual % (§6). With a site filter, the site-only variant. | 1/6 |
| B Baseline adherence | 100 × (achieved milestones with actual ≤ current baseline date) ÷ (achieved milestones that have a baseline) | 1/6 |
| S SLA adherence | 100 × (completed SLA step instances with duration ≤ max) ÷ (completed SLA step instances) | 1/6 |
| D Documentation | 100 × (approved mandatory document slots) ÷ (mandatory slots of approved tasks) | 1/6 |
| F First-time approval | 100 × (tasks approved with zero rejections) ÷ (approved tasks) | 1/6 |
| I Critical issues | 100 × (1 − sites with ≥ 1 open blocking item ÷ active sites). A blocking item is an open Issue linked to a gate, an open Major / Critical snag, an unreleased Hold point, or an open NCR (D54 "Blocking"). | 1/6 |

- `Health = Σ (w_f × factor_f) ÷ Σ w_f`, summed over the factors that have data.
- Tasks closed by admin override are excluded from S, D and F (CLAUDE.md).
- Values are kept in weekly snapshots (BP §06).

## 10. Approval and data rules shared by all modules
- **Approval unit (CLAUDE.md):**
  - The unit of approval is the whole task: its dates and its documents.
  - The default flow is Entry → Review → Approve. The number of levels is configurable per stage.
  - "Submit for review" stays disabled until every mandatory slot is filled.
  - This supersedes BP §03, which allowed approval without the document.
- **Rejection (CLAUDE.md):** a rejection goes back one level and must carry a note.
- **Self-skip (CLAUDE.md):** when the same person holds two consecutive levels, the second level is skipped and the skip is logged. BP §14 calls this "self-approval".
- **Batch upload (BP §04):**
  - A cell that falls in a locked step is held "pending previous approval" and is released automatically once that approval exists.
  - Invalid rows are rejected with their sheet, row and column. Valid rows continue.
  - Calculated (grey) Master columns are never read.
- **Issue order (D41):** by Site Type (Core, MFN, FN, HUB, Terminal), then oldest first by working days since Issue Raised Date. This is a display order, not a severity.
- **Risk level (D70, D73):** Score = Probability × Impact. Critical ≥ 15, High ≥ 10, Medium ≥ 5, Low below 5. Next Review Date is shown red when it is past and the risk is not Closed.
- **Permit satisfied at a gate (D36):**
  - Either Approved and valid on the gate date, or N/A for this site with a reason and an approver.
  - A permit type with Has Expiry blank is treated as not valid.
  - Alert 30 calendar days before expiry (Setting "Expiring alert").
- **Acceptances and snags (owner decision 2026-10-29, Q25 and E6):** an acceptance cannot be submitted or approved while an open snag of its own stream exists on the site. Open CW snags (`snags.scope = 'CW'`) block CW PAC (B13) and CW FAC (B15); open TE snags (`scope = 'TE'`) block TE PAC (D16) and TE FAC (D18). Snags of the other stream do not block. Any snag on the site counts, whether or not it is linked to the task. The snag types with `blocks_preliminary_acceptance = false` are ignored. The lock reason and the 422 `open_snags` carry the count.
- **Seeds:** `entry_role` in the catalogue is the default Responsibility Matrix seed. The stage owner comes from BP §03 and §14. The sub-role choice is an ASSUMPTION, editable in the Matrix.
- **Template IDs:** `TPL-*` codes follow the synthetic prototype (`design/prototype-v2/data.js`). They are ASSUMPTIONS until the Templates page issues the real IDs.
