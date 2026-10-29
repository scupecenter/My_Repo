# Dashboard KPIs: the legacy reference and the PMIS mapping (P3)

## Sources
- **Legacy dashboard (LD).** `docs/reference/legacy-dashboard/GSDN_Dashboard.html`, the repo copy with the XSS fixes. Its app script is `src/app.js` embedded verbatim (checked). Line numbers below are `app.js` lines, cited as "LD L123".
- **Master.** `GSDN_Site_Master.xlsx`: the Master sheet (row 3 headers), Project Status, SLA, Risk Register, Data Quality, Quality Inspections and Setting.
- **Decisions.** D58, D64–D68 and D72 (the Master Dashboard sheet and its six tables).
- **Blueprint.** BP §06, the indicator dictionary, cited as "BP §06 dict".
- **CLAUDE.md.** Project Status ends at HOTO; a separate Final Closure KPI; delay attribution and health index in v1; overrides flagged; visibility.
- **Other spec.** `rules.md` §1–§9 and `stories-dashboard.md` (DB-01 … DB-13).
- **Contract.** `contracts/openapi.yaml`, tags `dashboard` and `project-status`, plus `/sites` for the drill-downs.

The legacy dashboard is the reference for KPI definitions and pipeline style (CLAUDE.md). The Master Dashboard sheet (D66, D67) is a separate design: its six tables are specified in DB-01 … DB-07, and §7 shows where the two meet. Where they differ from the legacy code, the PMIS follows BP §06 dict and CLAUDE.md (§8).

---

## 1. Inputs the legacy dashboard reads

### 1.1 Master sheet columns
The dashboard finds each column by its three header rows, never by its position (LD L33–L100). Missing required columns stop the load (LD L101).

| LD key | Master column(s) | LD key | Master column(s) |
|---|---|---|---|
| id, ownerId, name | B, C, D | region, sub, cluster | E, F, G |
| lat, lng | H, I | type, siteScen, uplink | J, K, L |
| owner, existNew, rtgf | M, N, O | relB, relA | U, V |
| g_precw (gate) | W | phase, batch, scen | X, Y, Z |
| sowTower, sowAdp, sowGecol, sowHlc | AA, AB, AC, AD | teFull, teRouter | AE, AF |
| dmodel, prStatus, poStatus, contractor | AG, AH, AI, AJ | cwAccess, cwSE, cwSurvey | AL, AM, AO |
| repSub, repApp, cwDnSub, cwDnApp | AR, AS, AT, AU | precwB, precwA, g_cw | AV, AW, AX |
| cwMos, cwStart, cwB, cwA, g_rfi | AZ, BL, BO, BP, BQ | pacPlan, snagF, snagC, cwAsb, pacA | BR, BS, BT, BU, BV |
| gecol, hlc, rfiB, rfiA, g_te | BW, BX, BY, BZ, CA | teAccess, teSurvey, vendor, teSE | CB, CC, CD, CF |
| teDnSub, teDnApp, teMos, teStart | CG, CH, CJ, CQ | teB, teA, g_onair | CT, CU, CV |
| comm, mwAlign, rslDev, integ | CW, CX, CZ, DA | cutRes, rollback | DF, DI |
| onairB, onairA, g_tepac | DO, DP, DQ | ssvDate, ssvRes, hwid, eir, pat, teAsb | DR, DS, DT, DY, EE, EF |
| teSnagF, teSnagC, tepacB, tepacA | EG, EH, EK, EL | g_kpi, clusterOpt, kpiB, kpiA | EM, EO, ER, ES |
| g_hoto, matRec, hotoPkg, hotoB, hotoA | ET, EV, EW, EX, EY | g_fin, dlpEnd, cwFac, teFac, finB, finA | EZ, FB, FE, FJ, FL, FM |
| disCwRfd, disCwAct, disCwRn | FN, FQ, FR | disTeRfd, disTeAct, disTeRn | FS, FV, FW |
| cur, next, status | FX, FY, FZ | issue, issueOwner, issueDate, issueStatus, remark | GA, GB, GC, GD, GE |

### 1.2 Other sheets
- **Project Status:** the cells below ACTUAL PROGRESS, PLANNED PROGRESS, SPI and PLAN COVERAGE, and the activity table (Weight, Actual %, Planned %). LD L235.
- **SLA:** for every step, its COMPLETED and OPEN blocks per Site ID, and the "Max (wd)" header row. LD L253.
- **Risk Register:** read by the "Risk ID" header, using Probability (1-5), Impact (1-5), Risk Score, Risk Level, Status, Risk Owner, Trend, Mitigation Action and Target Date. LD L1409.
- **Data Quality:** read by "Check ID", using Area, Check, Rows, Severity and How to fix. LD L1410.
- **Quality Inspections:** read by "Record ID", using Stage, Site ID, Status, Result, Severity, Target Date and Blocking. LD L1411.
- **Report Date:** the named cell RptDate, then Setting "Report Date", and today as the fallback. LD L225.

## 2. Building blocks (exact legacy definitions)
`T` is the reference date: Report Date, or the "To · as of" filter. `from` is the optional "Period from" filter. `days(a, b)` counts **calendar** days, `round((a − b) / 1 day)` (LD L16).

| ID | Block | Legacy definition | LD |
|---|---|---|---|
| B-01 | Active site | Overall Status ≠ Cancelled. Cancelled sites are left out of every figure | L298, L349 |
| B-02 | CW applies | AA = Yes or AB = Yes | L295 |
| B-03 | RFI applies | CW applies or AC = Yes or AD = Yes | L296 |
| B-04 | TE applies | AE = Yes or AF = Yes. It is also true when **both** TE SOW columns are missing from the file | L297 |
| B-05 | Milestone N/A | Actual, baseline or gate = "N/A"; or PRE-CW or CW Completion where CW does not apply; or RFI where RFI does not apply | L300–L305 |
| B-06 | Milestone state on T | `na` if N/A. `done` if actual ≤ T. Site Release with no actual is `due` (or `na` if cancelled). `due` ("in work") if the gate date ≤ T. Otherwise `wait` ("waiting for readiness") | L314–L321 |
| B-07 | Site view | `cur` = the last `done` index. `next` = the first `due` or `wait`. `since` = the gate date (if `due`), else the previous done date. `age` = days(T, since). `overdue` = days(T, baseline of next) if that baseline < T, else 0 | L322–L337 |
| B-08 | Milestone aggregate `msAgg(rows, j)` | Over the sites not N/A: `app` (applicable); `done`; `due`; `wait`; `plan` (baseline ≤ T); `period` (done with actual ≥ from); for done sites with a baseline, `varDays` = days(actual, baseline), `late` (> 0) and `onTime` (≤ 0); for open sites with baseline < T, `overdue` and `ovDays` = days(T, baseline) | L357–L373 |
| B-09 | % done | done ÷ app | L448 |
| B-10 | vs plan (delta tag) | done − plan, signed | L426, L451 |
| B-11 | Weekly series and forecast `weekly(rows, j)` | Weekly cumulative actual (only up to T) and cumulative baseline. Weeks start on Monday. `rate` = actuals in the last 56 days ÷ 8. `ECD` = T + ceil(remaining ÷ rate) weeks. The chart extends to max(T + 8 weeks, min(last baseline or ECD, T + 40 weeks)) | L374–L401, L529 |
| B-12 | Age buckets | 0–7 d, 8–15 d, 16–30 d, > 30 d | L751 |
| B-13 | Heat cell | done ÷ app per region × milestone, with done/app and the lag (done − plan) shown when it is negative | L554–L567 |
| B-14 | Health pill | With SPI: "On track" if SPI ≥ 0.95 and behind share < 10%; "Needs attention" if SPI ≥ 0.85; else "Off track". Without SPI: behind share < 10% is ok, < 25% is watch, else crit. Behind share = sites with overdue > 0 ÷ scope | L793–L797, L810 |
| B-15 | Open issue | GA is not empty and GD does not start with closed, resolved, done or cancel. Issue age = days(Report Date, GC) | L307–L309 |
| B-16 | Status colours | Variance on the site card: > 15 d crit, > 0 watch, else ok. On-time %: ≥ 80% ok, ≥ 60% watch. SLA within max: the same 80/60 bands | L659, L1049, L1091 |

### 2.1 Filters (LD L340–L353, L1319)
- **Filters:** Project Phase (X), Delivery Batch (Y), Delivery Scenario (Z), Region (E), Cluster ID (G), Site Type (J), Tower Owner (M), Contractor (AJ, CW page only) and Vendor (CD, TE page only). Each is an exact match.
- **"Period from"** adds "achieved in period" counts.
- **"To · as of"** time-shifts T.
- **Section scope:** the CW page uses sites where CW applies or RFI applies. The TE page uses sites where TE applies (LD L354).

### 2.2 Drill-downs and common views
- Every count with `data-go` opens a site list. The list has search, sortable columns, a CSV export, and a click-through to the site card (LD L679–L750). The specs are:
  - `ms` with a milestone and a state: done, due, wait, overdue, period or all;
  - `scope`;
  - `issues`, optionally by owner;
  - `status` (Overall Status);
  - `next` with a milestone, a state and an age bucket;
  - `field`;
  - `ids`.
- **Pipeline node click** (LD L1362): opens the list with chips for Achieved / In work / Waiting for readiness / Behind baseline / (Achieved in period).
- **Site card** (LD L632–L676):
  - "where the site is" text, built from the next milestone, its state, the age, the gate hint, the RFI holds (GECOL pending, HLC pending, CW PAC not dated) and the baseline overdue;
  - a 10-milestone timeline of baseline, actual and variance;
  - the issue;
  - the site facts.
- **Print** (LD L1249): one A4 landscape sheet for the Overview or the section page.
- **Site register tab** (LD L1236): search and CSV.

---

## 3. Project Overview page (LD L800–L860)

| ID | Item | Exact legacy definition | Master | Filters | Drill-down | PMIS source | PMIS must differ / gap |
|---|---|---|---|---|---|---|---|
| OV-01 | Health pill | B-14 | Project Status SPI; site overdue | all | none | `GET /dashboard/health-index` (`score`, `band`) | Replaced by the health index (rules.md §9; DF-08). Band thresholds open (Q35) |
| OV-02 | Lede text | On-Air done of app; RFI done; weighted Actual vs Planned; sites behind baseline; ECD at the On-Air rate | DP, BZ, Project Status | all | none | pipeline + project-status | Working days and the 6-week rate (DF-02, DF-04) |
| OV-03 | Weighted physical progress (hero) | Project Status Actual, with the Planned tick and SPI (SPI ≥ 0.95 ok, ≥ 0.85 watch) | Project Status sheet | **ignores** site filters (LD note L841) | none | `GET /project-status` (`progress_pct`, activities, `weight_set`) | Computed by the PMIS (rules.md §6). Planned and SPI show "not available" until plan dates are complete (DB-08). Region and site scopes exist (rules.md §6 site filter). Ends at HOTO (CLAUDE.md) |
| OV-04 | Site RFI | msAgg(j = RFI): done / app, bar, plan tick, delta, + period | BZ, BY | all | `ms` RFI done | `GET /dashboard/milestone-pipeline` node MS4 | The contract node lacks `plan` and `period` (G-D02) |
| OV-05 | On-Air | msAgg(On-Air), as OV-04 | DP, DO | all | `ms` On-Air done | node MS6 | as OV-04 |
| OV-06 | HOTO | msAgg(HOTO), as OV-04 (no period) | EY, EX | all | `ms` HOTO done | node MS9 | as OV-04 |
| OV-07 | On-Air forecast | weekly(On-Air): ECD date, rate (sites per week over the last 8 weeks), remaining | DP, DO | all | none | **none** | BP §06 dict: velocity = average of the last **6** weeks, including weeks with zero (DF-04). No endpoint (G-D03) |
| OV-08 | Needs attention | Count of sites with an open issue; meta: sites behind baseline, open risks with level Critical or High | GA:GD, FY baseline, Risk Register | all (risks: none) | `issues` | `/registers/issues/records`, `/registers/risks/records` | Several issues per site (DF-09, Q36) |
| OV-09 | Delivery pipeline | Scope node = active sites (meta: on hold). For each of the 10 milestones: ring = done ÷ app, done, "% of app", plan with delta, + period, overdue. Track fill = Σ done ÷ Σ app. Gap label "N in work" = `due`, shown "hot" when due > 15% of app | V … FM, W … EZ | all | node chips (§2.2) | `GET /dashboard/milestone-pipeline` | Final Closure stays in the pipeline (D66). Nodes use stable codes and the active workflow version per site (CLAUDE.md). The contract node lacks plan, period, due vs wait, and overdue (G-D02). Pipeline style reused (CLAUDE.md) |
| OV-10 | RFI and On-Air against baseline | Weekly cumulative baseline (dashed) and actual for RFI and On-Air, plus the On-Air forecast line, with a Report-date marker | BY/BZ, DO/DP | all | none | **none** | No time-series endpoint (G-D03). Weekly snapshots (DB-12) can feed the history |
| OV-11 | Weighted progress by activity | One bar per activity: Actual %, with a Planned tick. Green ≥ 95% of plan, amber ≥ 85%, else red. Plan coverage noted | Project Status activity table | ignores filters | none | `GET /project-status` activities | Planned may be "not available" (DB-08) |
| OV-12 | Sites on the map | One dot per site with valid coordinates (lat 18–34.5, lon 8–26), coloured by current milestone, larger when behind baseline. Legend toggles; count of sites without coordinates | H, I, FX state | all | dot → site card | `/sites` | `SiteListItem` has no lat/lng (G-D05) |
| OV-13 | Decisions required | The top 5 by weight `w`. Rules: see the list after this table | V…FM, GA:GD, Risk Register, Data Quality | all | each item → its list or modal | **none** | No endpoint (G-D04). Port the heuristic as-is (legacy is the KPI reference). Working days (DF-02) |
| OV-14 | Regions by milestone (heat) | B-13 for milestones Site Release … HOTO, one row per region | E + milestones | all | cell → `ms` list for that region | `GET /dashboard/by-region` | `RegionKpi.by_milestone` holds reached counts only, without app or plan per cell (G-D06) |
| OV-15 | Site status | Stack bar of FZ: Not Started, In Progress, On Hold, Completed. The cancelled count is shown as a note | FZ | all | `status` list | `/sites?overall_status=` (count) | No count endpoint. The pipeline `meta` could carry it (G-D07) |
| OV-16 | Risks | 5×5 matrix of open risks (Status not Closed) by Probability × Impact. Cell colour: score ≥ 15 crit, ≥ 10 watch, ≥ 5 light green, else ok. Top 3 by Risk Score | Risk Register | none | modal: full register | `/registers/risks/records` | Thresholds from Setting (rules.md §10, D70) |
| OV-17 | Data quality | Checks with Rows > 0, sorted High, then Medium, then by rows. Top 7 and "N of M checks need action" | Data Quality (27 checks, D68) | none | DQ modal | **none** | DF-19, G-D08 |
| OV-18 | Swap and relocation (by scenario) | Per Z: sites; RFI done / app; On-Air done / app and %; TE PAC done; cutover success = DF matches success, pass or ok ÷ sites with DF; rollbacks = Σ DI | Z, BZ, DP, EL, DF, DI | all | none | **none** | D67 Swap table adds First-time Success, Window over Max (S-3/S-4), CW/TE Dismantle overdue and Post-Swap KPI degraded (DB-07). BP §06 dict: first-time success = Success with no rollback ÷ swap sites cut over (G-D09) |
| OV-19 | Dismantle | CW: sites with FN = Yes; executed (FQ dated); RN (FR dated). TE likewise with FS, FV, FW | FN:FW | all | none | `/registers/dismantle/records` | No summary endpoint (G-D09). D67 adds "Dismantle overdue" (DB-07) |

Decision rules for OV-13 (LD L755–L784):
- For each milestone (all, or the section's): if overdue ≥ 3, `w = overdue × (1 + median(ovDays) / 30)`. Severity is crit when overdue > 25% of app.
- The 2 issue owners with the most open issues, when they hold ≥ 2: `w = n × 1.6 + oldest / 20`. Crit when oldest > 60 d or n ≥ 10.
- Open Critical or High risks: `w = n × 2.2`. Overview only.
- Sites on hold: `w = n × 1.2`.
- The next milestone with the most sites waiting more than 30 days, when ≥ 3: `w = n`.
- Failing High data-quality checks: `w = n × 1.1`. Overview only.

## 4. CW and TE section pages (one template, LD L917–L1246)
| | CW page | TE page |
|---|---|---|
| Milestones | Site Release, PRE-CW Completion, CW Completion, Site RFI | TE Completion, On-Air, TE PAC, KPI Acceptance, HOTO, Final Closure |
| Prime / sub milestone | Site RFI / CW Completion | On-Air / TE Completion |
| Project Status activities | Activities matching /civil/ (activity 4) | /te install/, /integration/, /testing/ (activities 5–7) |
| Partner | Contractor (AJ) | Vendor (CD) |
| SLA steps | Codes B-, C-, RFI, E2E-B | Codes D-, E2E-D, S- |

The config is at LD L917–L930.

### 4.1 Tab 1, Cockpit (LD L951)

| ID | Item | Definition | PMIS source | Differ / gap |
|---|---|---|---|---|
| SC-01 | {CW, TE} weighted progress | The weight-averaged Actual of the matching activities: Σ w·a ÷ Σ w. Planned the same way (only if every activity has a Planned value) | `GET /project-status` activities | — |
| SC-02, SC-03 | Prime and sub milestone | msAgg, as OV-04 | pipeline nodes | G-D02 |
| SC-04 | In work now | Sites whose next milestone is in the section with state `due`; meta: count `wait` | **none** | G-D02 (due vs wait). Drill by ids (G-D10) |
| SC-05 | Behind baseline | Sites whose next milestone is in the section with overdue > 0; meta: median days | **none** | Working days (DF-02). `/sites?bucket=late` is task-based, not milestone baseline |
| SC-06 | SLA within max | Σ within ÷ Σ completed over the section's SLA steps (SC-20); meta: open issues | **none** | G-D11 |
| SC-07 | Section pipeline | OV-09 limited to the section milestones | pipeline | G-D02 |
| SC-08 | Prime burn-up | OV-10 for one milestone, with forecast | **none** | G-D03 |
| SC-09 | Weekly throughput | Milestones achieved per week, last 12 weeks, one bar series per section milestone (except Site Release) | **none** | G-D03 |
| SC-10 | Map | OV-12 with section groups (CW: Not released … RFI ready; TE: Before TE … HOTO / closed) | `/sites` | G-D05 |
| SC-11 | Decisions required | OV-13 for the section milestones (no risks, no DQ) | **none** | G-D04 |

### 4.2 Tab 2, Milestones and checkpoints (LD L1001–L1039)
- **SC-12, Pipeline:** as SC-07.
- **SC-13, Detailed checkpoints.** For each step it shows Applicable, Done, Pending (due), Not due and % done. Steps:
  - CW (12): CW access, CW survey, Report submitted, Report approved, CW DN approved, CW MOS, CW start, CW completion, CW PAC, GECOL power, HLC fiber, Site RFI.
  - TE (22): TE access … HOTO.
  - Pending = this step is not done but its predecessor (or gate) is done, or the BW/BX status reads "Pending". Not due = the predecessor is not done. GECOL and HLC apply only where AC or AD = Yes.
  - PMIS must differ:
    - D67 sets CW 17 steps, TE 22 and Post-HOTO 3 (DF-16).
    - Done means approved (DF-01).
    - The `Scope = Done + Pending + Not Due` check applies (DB-01).
    - No endpoint (G-D12).
- **SC-14, Regions heat:** OV-14 limited to the section milestones (G-D06).

### 4.3 Tab 3, Schedule (LD L1041)
- **SC-15, Schedule against baseline.** Per milestone it shows:
  - Applicable, Planned to date, Achieved, and "vs plan" (done − plan);
  - On time % = onTime ÷ (onTime + late);
  - Median variance, Behind baseline (open past baseline) and Median days late.
  - PMIS must differ:
    - D67 uses **Avg** Delay and adds Baseline Missing. Plan Coverage is removed (DF-17).
    - Working days (DF-02).
    - Gap G-D02.
- **SC-16, SC-17, S-curves:** sub and prime milestone (G-D03).
- **SC-18, Biggest slips.** The top 200 (site, milestone) pairs, achieved late or still open past baseline, sorted by slip days. Columns: Site, Region, Milestone, Baseline, Actual or "open", Slip, Contractor or Vendor. No endpoint (G-D13).

### 4.4 Tab 4, Flow and SLA (LD L1073–L1106)
- **SC-19, Work in progress by next milestone (kanban).** For each next milestone in the section:
  - the count;
  - the age-bucket bar (B-12);
  - in work vs waiting;
  - the 5 oldest sites;
  - "All N sites".
  - No endpoint (G-D12).
- **SC-20, SLA durations.** For each SLA step of the section: SLA max (wd), Completed n, Median, P85, Within max % (≤ max), and Open over max / open. Values come from the SLA sheet (working days).
  - PMIS must differ:
    - the source is the PMIS SLA engine (rules.md §3);
    - D-1 starts from MS4 (CLAUDE.md, DF-21).
  - BP §06 dict also asks for P90 and the maximum.
  - Gap G-D11 (DB-10).

### 4.5 Tab 5, Constraints and ownership (LD L1108–L1150)
- **SC-21, Where sites wait.** For each next milestone: Waiting for readiness, In work, Older than 30 d, Behind baseline, Open issues, and the gate hint text (LD GATE_HINT L126). G-D12.
- **SC-22 (CW), What holds RFI.** Among sites whose next milestone is RFI:
  - CW applies and BV is empty;
  - BW = Pending;
  - BX = Pending.
  - BP §06 dict "readiness gap" matches this.
- **SC-22 (TE), Dependencies:**
  - waiting for TE readiness (next = TE Completion, `wait`);
  - uplink site not On-Air (next = On-Air, L names another site of the file that is not On-Air);
  - RFI not achieved and TE not done.
- **SC-23, Open issues by owner:** bars by GB. **SC-24, Open issues table:** oldest first, with age > 60 d crit and > 30 d watch. PMIS: issues sort by D41 (rules.md §10) and there are several per site (DF-09).
- **SC-25, Risks matrix:** as OV-16.

### 4.6 Tab 6, Partners (LD L1152–L1181)
- **SC-26, Scorecard per contractor (CW) or vendor (TE).** Columns:
  - Sites; sub done/app; prime done/app; Progress % (prime);
  - On time % = (onTime prime + sub) ÷ (onTime + late, prime + sub);
  - Median full CW (E2E-B1/B2/B3) or Median MOS → On-Air (E2E-D1), in wd;
  - Open work; Behind baseline;
  - Snags at PAC % = sites with Snags Found (BS or EG) = Yes ÷ max(PAC-dated sites, snag sites);
  - Open issues.
- **SC-27, Per-partner mini bars:** % done per section milestone, with a plan tick (top 6).
- PMIS must differ:
  - BP §06 dict "contractor scorecard" counts SLA adherence on **approved attributed** days only, plus rejections, plan adherence, documentation and safety, with weights from settings (rules.md §8).
  - Snags come from snag records (DF-10).
  - No endpoint (G-D14).
  - `DelayAttribution` covers part of it.

### 4.7 Tab 7, Quality and closure (LD L1182–L1229)
- **SC-28 (CW), From CW completion to FAC.** Bars over the CW-complete sites:
  - CW complete;
  - CW PAC dated (BV ≤ T);
  - As-Built submitted (BU = Yes);
  - In DLP (PAC dated, FB > T);
  - DLP ended, FAC due (FB ≤ T, FE empty);
  - CW FAC (FE ≤ T).
  - First-time pass at PAC = (CW complete − sites with BS = Yes) ÷ CW complete; snags cleared (BT).
  - PMIS must differ:
    - BP §06 dict "acceptance quality" = CW PAC with no snags ÷ PAC (the denominator is the PAC, not CW complete), and the same for FAC (DF-10).
    - The closure part moves to the Final Closure KPI (DF-06).
- **SC-29, Quality inspections panel.** Records for the section stage (Stage = cw or te, or blank) on sites in scope:
  - open = (Status + Result) does not match closed, cleared, released or pass, or Status matches "open";
  - by severity: Critical, Major, Minor;
  - past target (Target Date < T);
  - blocking (Blocking = Yes).
  - PMIS: Status and Blocking come from the Quality register rules (D54; RG-QI).
- **SC-30, SC-31 (CW), GECOL and HLC:** Done vs Pending counts from BW and BX.
- **SC-32 (TE), From On-Air to TE PAC.** Over the On-Air sites: SSV done (DS not blank) with % Pass; HWID; EIR; PAT; As-Built (dates ≤ T); TE PAC; TE FAC; TE snags raised (EG) and cleared (EH).
- **SC-33 (TE), MW link RSL deviation:** a histogram of CZ (values with |x| < 40 only), with bins < −9, −9…−6, −6…−3, −3…−1, ±1, 1…3, 3…6, 6…9, > 9, and the "deviate by more than **3 dB**" count. PMIS must differ: the Master Setting "MW RSL tolerance" = **2 dB** (DF-15).
- **SC-34 (TE), Cutover:** Success (DF matches success, pass or ok) vs rolled back or failed.
- No endpoint for SC-28 … SC-34 (G-D15).

### 4.8 Tab 8, Site register (LD L1236)
- **SC-35.** One row per site in the section:
  - Site ID, Name, Region, Type;
  - CW: Contractor, CW baseline, CW actual, RFI actual;
  - TE: Vendor, TE installed, On-Air baseline, On-Air actual, TE PAC;
  - then Current, Next with its state tag, Days in step, Behind baseline and Open issue.
- Search, CSV and a cap of 600 rows.
- PMIS: the Sites list (`GET /sites`) with the CLAUDE.md Export button (Excel through the export service, not CSV). `SiteListItem` lacks the columns listed in G-D05.

---

## 5. KPIs the PMIS adds (not in the legacy dashboard)

| ID | KPI | Definition | PMIS source | Notes |
|---|---|---|---|---|
| PX-01 | Final Closure KPI | Sites closed, % closed, pending CW FAC and TE FAC with their ages (rules.md §6.1; DB-09) | `GET /dashboard/final-closure` | CLAUDE.md. Not mixed into Project Status. `FinalClosureKpi` lacks the "Not due" counts (in DLP) of the D67 pattern (G-D16). Formula open (Q16) |
| PX-02 | Delay attribution | Delay days per responsible party, % unattributed, overlapping periods (rules.md §8; DB-10) | `GET /dashboard/delay-attribution` | AAT SE is never a party. `DelayAttribution` lacks % unattributed, the overlap count, and the per step, region and contractor breakdown (G-D17). Q7 |
| PX-03 | Health index | 6 factors, each ≤ 100, with weights from the `health_index` weight set (rules.md §9; DB-11) | `GET /dashboard/health-index` | Replaces the legacy pill. Labelled "draft, under owner review" (DB-11). Bands Q35 |
| PX-04 | No holder | Tasks with no eligible holder (CLAUDE.md B10) | `RegionKpi.no_holder` | |
| PX-05 | Overrides flagged | Admin-override tasks are flagged in, or excluded from, every KPI (CLAUDE.md) | `KpiMeta.override_flagged_count`, `exclude_overrides` | |
| PX-06 | Exceptions & Alerts | Area · Indicator · Base · Count · % of Base, exceptions only (D66, D67; DB-05) | **none** | G-D18 |
| PX-07 | WH Complete Units | Need, Dispatched, Remaining Need, Available, Shortfall; Cambium and Intracom separate; project-wide, ignores the filters (D58, D72; rules.md §7; DB-06) | `/warehouse/stock` (Available only) | Need and Shortfall missing (G-D19) |
| PX-08 | Weekly snapshots and trends | Frozen weekly and month-end values, with trend arrows (BP §06; DB-12) | `/project-status/snapshots` (Project Status only) | Other KPIs have no snapshot read (G-D03) |
| PX-09 | Cluster progress | "6 of 9 sites at TE PAC", shown as information (CLAUDE.md; DB-13) | `SiteDetail` | |

## 6. Requirements in BP §06 dict with no legacy counterpart
These should be specified later. They are not built yet, and none of them is invented here:
- Lead Time, Execution Time, Lag and Flow Efficiency;
- Earned Schedule SPI(t), once the baseline covers ≥ 60% of sites;
- Float / due soon (late, within 7 days, within 14 days);
- Cumulative Flow;
- first-time approval;
- documentation completeness;
- QC closure;
- ready for closure;
- risk exposure;
- Swap outage duration.

They are listed so that the P3 backlog is complete (BP §06 dict rows 540–570).

## 7. Mapping to the Master Dashboard sheet (D67) and the stories
| D67 table | Story | Nearest legacy item |
|---|---|---|
| (1) Milestone Delivery | DB-02 | SC-15 Schedule plus OV-09 |
| (2) Overall Progress by Region (CW 7 / TE 6) | DB-03 | OV-14 heat |
| (3) Project Checkpoint (CW 17, TE 22, Post-HOTO 3) | DB-04 | SC-13 |
| (4) Exceptions & Alerts | DB-05 | partly OV-08, OV-15, OV-17 |
| (5) WH · Complete Units | DB-06 | none |
| (6) Swap & Relocation | DB-07 | OV-18, OV-19 |

## 8. Where the PMIS definition must differ from the legacy code

| ID | Difference | Legacy | PMIS | Source |
|---|---|---|---|---|
| DF-01 | Approved data only | Reads dates typed into the Master | Counts only approved values. A rejected document after approval leaves the KPIs (rules.md §2.2) | BP §06 dict; DB header; CLAUDE.md |
| DF-02 | Working days | `days()` counts calendar days for overdue, age, variance, slips and issue age | Working days (Fri/Sat weekend plus holidays, rules.md §3) | BP §06 dict ("in working days") |
| DF-03 | One reference date | Report Date plus a time-shiftable "as of" | Today. History comes from frozen weekly snapshots. BP §06 lists the double reference date as a bug of the current dashboard. Keeping "period from" is open (Q34) | BP §06 dict, row 571 |
| DF-04 | Forecast velocity | Last 8 weeks ÷ 8 | Average of the last 6 weeks including zero weeks. ECD = today + remaining ÷ velocity | BP §06 dict "Burn-up · ECD" |
| DF-05 | Project Status scope | Read from the Master sheet (which already ends at HOTO) | Computed by the PMIS, ends at HOTO, editable weights. The pipeline still shows Final Closure | CLAUDE.md; D65; D66 |
| DF-06 | Final Closure | A partial funnel in the CW Quality tab | A separate Final Closure KPI (PX-01) | CLAUDE.md; rules.md §6.1 |
| DF-07 | Delay | Only "behind baseline" | Delay attribution by party (PX-02) | CLAUDE.md; rules.md §8 |
| DF-08 | Health | SPI / behind-share pill | Health index (PX-03) | CLAUDE.md; rules.md §9 |
| DF-09 | Issues | One issue per site (GA:GE) | Several issues per site. Counting rule open (Q36) | CLAUDE.md |
| DF-10 | Snags | Yes / No flags BS, BT, EG, EH. PAC first-time pass over CW complete | Snag records. First-time pass = PAC with no snag ÷ PAC | CLAUDE.md; BP §06 dict |
| DF-11 | Admin overrides | Not known to the Master | Flagged or excluded (`exclude_overrides`) | CLAUDE.md |
| DF-12 | No holder | None | Count shown (PX-04) | CLAUDE.md B10 |
| DF-13 | Milestone identity | Fixed list of 10 | Stable codes; active workflow version per site | CLAUDE.md |
| DF-14 | Visibility | The whole file | Only the regions and modules the user may see (B3). WH Complete Units stays project-wide (D72). **ASSUMPTION:** for a region-limited user it shows the project-wide figure only with the `warehouse` view grant | CLAUDE.md; D72 |
| DF-15 | RSL tolerance | Hard-coded 3 dB | Setting "MW RSL tolerance" (2 dB) | Master Setting |
| DF-16 | Checkpoint lists | CW 12, TE 22 | CW 17, TE 22, Post-HOTO 3, from the task catalogue | D67 |
| DF-17 | Milestone table | Median variance; no Baseline Missing | Avg Delay, Overdue Open, Achieved Late, Baseline Missing; no Plan Coverage | D66; D67 |
| DF-18 | Applicability | Yes-only test; TE applies when the TE SOW columns are missing | Three-valued (Yes, N/A, unknown). Unknown blocks PRE-CW Completion | rules.md §1; D68 check 6 |
| DF-19 | Data quality | Reads the 27 Master checks | Most checks become validations at entry. The remaining alerts are counted per rule and site | BP §06 dict "data quality"; D68 |
| DF-20 | Exceptions and WH units | Absent | Added (PX-06, PX-07) | D67; D72 |
| DF-21 | SLA D-1 | SLA sheet D-1 starts from Site Release | Starts from MS4 (or MS1 where RFI is N/A) | CLAUDE.md; Q2 |

## 9. Contract coverage gaps (for tech-lead)

| ID | Gap |
|---|---|
| G-D01 | The dashboard endpoints accept only `region_id`, `scenario` and `exclude_overrides`. The legacy filters Phase, Batch, Cluster, Site Type, Tower Owner, Contractor and Vendor are missing, and so are the `from` window (Q34) and, on `/sites`, phase, site type, tower owner, contractor and vendor |
| G-D02 | `MilestonePipelineNode` has completed, in_progress, late and not_started, but no `plan` (baseline due by today), no "in work" (gate open) vs "waiting" (gate closed) split, no overdue-open vs achieved-late split ("late" is undefined), no `period`, no avg or median variance, and no baseline-missing count |
| G-D03 | No time series: weekly cumulative actual and baseline per milestone, forecast (ECD and rate), weekly throughput, and snapshots for KPIs other than Project Status |
| G-D04 | No "decisions required" endpoint |
| G-D05 | `SiteListItem` lacks latitude and longitude, site type, contractor, vendor, days in step, behind-baseline days and the open issue, all needed by the map, the register and the lists |
| G-D06 | `RegionKpi.by_milestone` has reached counts only. The heat needs applicable and plan counts per region × milestone |
| G-D07 | No Overall Status counts endpoint (stack bar) |
| G-D08 | No data-quality endpoint (alert-rule violations per rule and site) |
| G-D09 | No Swap and Relocation table, and no dismantle summary |
| G-D10 | No drill-down by milestone state. `/sites` filters by current stage and a task-based `late` bucket, not by "milestone j is done / due / wait / overdue / achieved in period" |
| G-D11 | No SLA statistics endpoint (per step, contractor and region: count, median, P85, P90, max, within max %, open over max) |
| G-D12 | No checkpoint, WIP or age, or "where sites wait" endpoint |
| G-D13 | No slips list |
| G-D14 | No partner scorecard |
| G-D15 | No quality and closure funnel, RSL histogram or cutover summary |
| G-D16 | `FinalClosureKpi` lacks the Scope / Done / Pending / Not Due counts (rules.md §6.1, D67 pattern) |
| G-D17 | `DelayAttribution` lacks % unattributed, the overlapping-periods count, and the per step, region and contractor breakdown |
| G-D18 | No Exceptions & Alerts endpoint |
| G-D19 | No WH Complete Units endpoint (Need, Dispatched, Remaining Need, Shortfall per need unit) |
| G-D20 | `HealthIndex.band` exists, but its thresholds are not defined (Q35) |
