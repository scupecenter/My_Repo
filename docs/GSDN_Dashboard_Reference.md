# GSDN Project Dashboard — Claude Code Reference

> Single-file, offline executive dashboard for Libyan telecom civil-works (CW) & transmission-equipment (TE) rollout. This file is the durable project reference: architecture, data model, business rules, SLA rules, and the full change log. Read it before editing the dashboard.

_Last consolidated: 2026-09-20 (Master 20-09-2026)._

---

## 1. What it is

- **One self-contained `GSDN_Dashboard.html`** (~1.23 MB). No server, no internet after opening.
- Reads the master workbook **`GSDN_Master_<date>.xlsb`** in-browser via **inlined SheetJS (XLSX 0.18.5)**.
- Three scopes in the top bar: **GSDN OVERVIEW · CW · TE**, each with its own tab set.
- UI in **English**; the user communicates in **Arabic** (replies in Arabic).
- Upload screen (`#gate`) → on file load reveals the app (`#app`); `findMasterSheet()` locates the sheet whose A1-area contains "Site ID".

## 2. Working style (user preferences — always apply)

- **No assumptions** (`الافتراض ممنوع`). Investigate the real file/columns before stating anything.
- **Propose before big/ambiguous changes**; give an honest technical assessment (conflicts, limits) before implementing. Precise, targeted edits. Separate content vs formatting changes.
- **Never invent data.** Any KPI that can't be computed reliably → show "n/a" and say what's needed.
- **No `localStorage`/`sessionStorage`** (blocked in the environment) — keep state in memory only.
- Empty cells are **excluded** from every calculation (not counted done, not counted remaining).
- Keep tables from overflowing — shrink font / compress columns (`.compact-t`) instead of letting them scroll.
- Deliver a working single HTML file each time; keep this reference + change log updated.

## 3. Architecture / how it runs

- `parseWorkbook(wb)` builds `RAW` = array of site row objects (one per Site ID). Positional column maps (below) drive parsing; `verifyHeaders()` name-guards key columns and fills `HEADER_WARN` (a non-blocking structure warning).
- `applyFilters()` → filters `RAW` by the filter bar (region/batch/owner/contractor/type/scenario/status/**life**) and wraps the result in `periodView()` (global period mode). Cancelled + out-of-scope dropped.
- `render()` picks the page function from `PAGE`, injects HTML into `#main`, then `wire()` attaches post-render behaviour (charts, drill, geo map, donuts).
- Validation harness: headless Chromium (Playwright) loads the HTML, injects the .xlsb as base64 through the same `parseWorkbook` path, walks all **28 pages** (overview 1 + CW 15 + TE 12), asserts `HEADER_WARN=[]`, KPI counts, **no horizontal overflow**, no console/page errors. Always run it before delivering.

## 4. Master data model (positional column maps, 0-based)

The master tail shifts when the user adds/removes columns — **always re-verify positions on a new master** (dump header rows 0–2 and compare). As of **20-09 (177 cols)**:

**COL (CW + site):** id 1, name 2, owner 3, rtgf 8 (RT/GF), towerType 9, region 13, scenario 14, type 15, lat 5, lng 6, rfSurvey 23, acq 24, batch 25 (Delivery Batch = in-scope flag), scopeTwr 26 (Tower Erection Yes/N-A), scopeAdp 27, needGecol 28, needHlc 29, contractor 32, … cwStatus 56 (Site CW Date), acceptDate 59 (PAC actual), dlpStart 60, dlpEnd 61, snags 62, finalAccept 63 (FAC), gecolInst 65 (pwr gate), hlcApp 67 (link gate), rfi 68, **issue 115, ownerCol 116, remark 117**.

**TE_COL (TE block, +5 vs 16-09):** access 69, vendor 70, seName 71, survey 72, dnSub 73, dnApp 74, mosPlan 75, mosAct 76 (= TE work **start**), install-detail 77–81 (MTS/IP Router/RF Ant/MW Ant/DC-OF), instPlanEnd 82 (expected TE finish), instActEnd 83, **instFin=instStatus=84 (single "TE Installation Date" gate)**, onairPlan 85, commissioning 86, mwAlign 87, integration 88, onair 89, hwSnags 90, docSign 91, eir 92–96, pat 97–101, asBuilt 102, pac 103, oam 104.

**DIS_COL:** cwRfd 105 … teReturn 114.  **CW_BOQ:** 118–148.  **EQ_COL (TE BOQ):** 149–176.

## 5. Core business rules

- **STRICT DATE-ONLY:** any "…Date" gate is *done only with a real Excel date* (`serialToDate`: number 20000–90000). "Done"/"Yes" text no longer counts; "Pending" = pending; "N/A"/blank = excluded. Text-only columns (Acquisition, EIR, PAT, As-Built, O&M, DN, Layout, Commissioning, etc.) currently read 0 until real dates are entered — the user has **pre-accepted** this.
- **In scope:** `batch != '' && !cancelled`. Cancelled (Acquisition=Cancelled) dropped everywhere except the Dismantle pages.
- **Install start** = MOS Actual (dedicated start-date column removed). `instFin`/`instStatus` both = col 84.
- **Global period mode:** `periodOn() = FILTER.dFrom||FILTER.dTo`. `periodView()` clones rows and keeps each dated gate as done only if its date ∈ [From,To]; the WHOLE dashboard (Overview/CW/TE) then shows *achievement in the window*. Non-time panels are hidden via `.cum-only` + `body.period-on{…display:none}`. Normal mode = `periodView` is identity (byte-identical cumulative).
- **Date pickers:** native `<input type=date>`; on Clear, From = first project date, To = today (`todayISO`), max = today.
- **lifeBucket(r)** (3-way status used by donuts + geo map + `FILTER.life`): `onair` (r.te.onair) · `pending` (post-CW, not onair: cwState==='done') · `scope` (pre-CW). Colors: ok / watch / #6b7683.

## 6. Overview page order

Overall Status → Health+KPIs → **[Completion by Region bars | Overall Status donut]** → **[Project Lifecycle (compact %-bars) | Geographic Spread map]** → Project Checkpoint Chain → **Delivery by Region → Progress in Selected Period → Delivery by Region — Achievement in Period** → Dismantle → Why Sites Are Held → Management Decisions.

## 7. Charts & geographic map

- **Donuts** (Overview "Overall Status", TE "Site Status"): 3 lifeBucket slices; click a slice **or** legend row → sets `FILTER.life` (filters whole dashboard). ONAIR = Done.
- **Completion by Region** bars (Overview + TE Exec): per-region % onair via `gsdnRegions`, click to drill.
- **Geographic Spread** (Overview, offline): inline SVG **Libya outline** (212-pt ring embedded in `LIBYA_RING`, equirectangular projection w/ cos(midLat)); one dot per site from lat/lng, colored by lifeBucket. Hover → ID+name tooltip; click anywhere → **modal** (full-height map left, info panel right) with zoom (buttons+wheel, cursor-anchored CSS transform on `#gmSvg`) + drag-pan; click a dot → detail (status-first: chip + `siteStage(r)`, then coords/region/type/scenario/tower owner/Acquisition/CW/RFI/ONAIR/O&M/issue). Legend in modal isolates one status on the map; "↺ Show all sites" resets. New East/South sites plot automatically (projection covers all Libya; range lat 18–34, lon 8–26).

## 8. SLA rules (WORKING DAYS unless marked; user-confirmed 20-09)

Colour rule everywhere: **≤ min = green · within max = amber · > max = red.** Actuals are calendar days between real dates (SLA is working days) — rows without dates show n/a.

### TE SLA (`TE_SLA`, per-gate min–max) — chain: RFI→Access→Survey→DN Sub→DN App→MOS→TE Install→Commissioning→MW Align→Integration→ONAIR→HW Doc→EIR→PAT→As-Built→PAC→O&M
Access 3–5 · Survey 1–2 · DN Sub 1–2 · DN App 1–2 · MOS 1 · TE Installation (MOS→Install Date) 3–5 · Commissioning 1 · MW Alignment 1 · Integration 1 · ONAIR 1 · HW Doc 1 · EIR (HW Doc→EIR) 3–5 · PAT (EIR→PAT) 3–5 · As-Built 1–2 · PAC (As-Built→PAC) 5–10 · O&M 3–5. **End-to-end:** MOS→ONAIR 8–12 · Access→O&M 30–51. Shown in **teSLAPanel** (TE ▸ Cockpit).

### CW SLA (`CW_SLA`)
Procurement 1–2 · Access 1–2 · Mobilization 1–2 · Layout Submission 1–2 · Layout Approval 1–2 · **Execution = by scope/tower (see below)** · GECOL & HLC **embedded** 7–10 (run *within* execution from work start, NOT separate gates) · CW PAC 1–3 · **DLP 90 CALENDAR days (~3 months)** · FAC 3–10 · Site RFI 1. Shown in **cwSLATable** (CW ▸ Flow & Duration).
- **Execution SLA per site** (`cwExecSLA`): adaption-only **4–8**; adaption+tower by class — **RT (Rooftop) 14–21**, **GF (Greenfield) 30–45** (classifier = col 8 RT/GF; tower in scope = col 26 = "Yes"; GECOL/HLC/adaption are covered inside the tower window).
- **End-to-end (`CW_E2E`):** Adaption 10–21 · +RT 14–21 · +GF 30–45.

_Wiring:_ `teDurations`/`TE_SEGS` compute actuals vs `TE_SLA`; `vendorQuality` uses `TE_SLA.pat.max`; `pageCycle` colours CT_DEFS cards by `CW_SLA` (old hardcoded 14/30/60 thresholds removed). Old `TE_SLA` (MOS→EIR 10, EIR→PAT 5, PreAcc→PAC 14, PAC→O&M 7, Survey→Install) fully removed.

## 9. Validation & delivery workflow

1. Copy the user's latest attached HTML to `user_final.html`; copy the master to `mNN.xlsb`.
2. On a new master, dump header rows and **re-verify every positional map** before anything else.
3. Make targeted `Edit`s.
4. Run the Playwright harness (`val.mjs`): 28 pages, HEADER_WARN=[], KPI sanity, no overflow, no errors. Screenshot key pages to eyeball.
5. Append a change-log entry, copy to `/mnt/user-data/outputs/GSDN_Dashboard.html`, deliver with `SendUserFile`.

Known reference KPIs (20-09, date-only, in-scope 259): TE Installed 213 · ONAIR 199 · TE PAC 137 · CW 249 · GECOL 169 · HLC 42 · RFI 223. Acquisition/EIR/PAT/As-Built/O&M read 0 (text, not dated yet).

---

## 10. Project history from day one (phases)

> Phases before the 16-09 master are reconstructed from project memory (the detailed per-edit logs for the earliest sessions were not retained verbatim); everything from 16-09 onward is the verbatim change log in §11.

**Origin & goal.** Ahmed is a project-controls engineer running a Libyan telecom civil-works (CW) + transmission-equipment (TE) rollout in the Western Area (~259 in-scope sites). The deliverable from the start: one **self-contained HTML dashboard** ("GSDN CW Checkpoint Report", later "GSDN Project Dashboard") that reads the master `.xlsb` in-browser via inlined SheetJS, works offline, stores nothing between sessions, English-only UI. Built over many phased sessions; the unified Project Overview (Site Acquisition → O&M Handover) is the landing page. Three levels: Overview / CW / TE.

**Domain rules established early (still in force):**
- Delivery Batch (col Z) non-blank = in-scope.
- Site RFI is the single final CW readiness gate (RFO→RFI consolidated); N/A = router-only site.
- Pre-Acceptance = EIR + PAT + As-Built all complete. TE closing gate = **PAC**, not FAC.
- MW Alignment skipped for fiber sites (FN/MFN/Core); it follows Commissioning.
- Cancelled sites leave execution scope but enter Dismantle scope.
- Issue/Remark block in the master is the source (not the separate Site Issue sheet).
- Precise terminology: Issue vs Risk; Lead Time vs Cycle Time vs Waiting Time vs Flow Efficiency; "Activation/RFO" = readiness, not activation.
- A unified **Risk Register** (25 risks, CW/TE/Both scope column) was produced and integrated.

**Ways of working (made permanent by Ahmed):** critical-analyst, non-sycophantic, direct. "الافتراض ممنوع" — no assumptions. Never add anything not explicitly agreed — propose, wait for approval, then implement. Surgical single-match edits to his uploaded file. Deliver the file after each phase without being asked. Validate (node check + Playwright) after every edit batch. PROGRESS.md is the session-continuity log + authoritative column map.

**Phase timeline (high level):**
1. **Initial multi-session build** — the three-scope dashboard (Overview/CW/TE) with executive, progress/S-curve, kanban, accountability, activation, regional, contractor, risk, actions, register, data-quality pages; in-browser .xlsb loading; offline single file.
2. **Risk Register integration** — unified 25-risk register with CW/TE/Both scope.
3. **13-09 master** — new RF Survey Date column, reordered Network Topology columns, MW Alignment repositioned after Commissioning; schema integration + column remap.
4. **15-09 master** — added BOQ detail: **TE BOQ** (installed equipment per site) and **CW BOQ** (civil bill of quantities with unit-of-measure per group); a reader/button to surface quantities in the CW section; Antenna-Height column removed.
5. **16-09 master (172 cols)** — big remap: 5 "Overall Status" text columns deleted; 3 text columns became dates; global **strict date rule**; **single-file period engine** (global Period From/To + Achievement-in-Period table); two-file/baseline-compare mode removed; Delivery-by-Region reworked; native date-range pickers; O&M gate + Dismantle summary. (See §11.)
6. **19-09 master (177 cols)** — TE install block restructured (+5 shift; MOS=start; per-component install detail; expected TE finish); **Overview & TE charts** (donut + Completion-by-Region + stage bars); **offline Libya geographic map** with modal, zoom/pan, per-site drawer, status isolation.
7. **20-09 master** — **SLA rules fixed into the dashboard** (CW + TE, working days; scope/tower-type execution logic; GECOL/HLC embedded; DLP calendar) and contradicting logic removed.

---

## 11. Detailed change log (16-09 → 20-09, verbatim)

# GSDN Dashboard — progress log

## 16-09 master remap (172 cols) + global date rule + single-file period engine
MASTER 16-09: 172 cols (was 177) — 5 "Overall Status" text columns DELETED (GECOL Overall, HLC Overall, TE Pre-Acc Overall, CW Dismantle Overall, TE Dismantle Overall). 3 text columns became dates: Overall Site CW Status→Site CW Date(BE/56), TE Installation Status→TE Installation Date(CB/79), Site Acquisition→Acquisition Date(Y/24, still Done/Cancelled/Pending text for now). GECOL gate now = GECOL Installation Date(BN/65), HLC gate = HLC Installation Date(BP/67).
REMAP strategy: kept internal field names (pwr/link/cwState) and only changed their PARSE derivation — pwr from GECOL Install Date, link from HLC Install Date, cwState from Site CW Date, all via date rule (date|'Done'→done · 'Pending'→pending · 'N/A'/blank→excluded). preAcc Overall gone → te.preAcc = computed from EIR+PAT+As-Built. Dismantle status derived from Actual/RFD (Overall cols deleted). Full index remap of COL/TE_COL/DIS_COL/CW_BOQ(113-143)/EQ_COL(144-171).
Acquisition rule (user): date/Done=acquired · Pending · Cancelled=excluded (except dismantle) · no N/A.
VALIDATED 16-09: HEADER_WARN=[], in-scope 259, cancelled 27, CW 250, GECOL 169, HLC 54, RFI 223, PAC 195, FAC 186, TE installed 213, onair 199, TE PAC 137, O&M 161, eqWL 212, DQ 0, 28 pages, 0 errors.

TWO-FILE MODE REMOVED entirely (user: single file only): deleted BASE_RAW/BASE_META, cmpActive/cmpIndex/cmpTotals/cmpByRegion/curByRegion/cmpMovements/cmpWeekStrip/cmpMovementPanel/pageRegionWeekly/readBaseline/CMP_STEPS, the gate baseline picker (.baserow/#baseFile/#pickBase)+CSS+wiring, and all orphan "week" comments. Kept the legit Progress-&-Schedule S-curve/velocity (weekStart/cumSeries/ECD).

DELIVERY BY REGION → pure cumulative per gate as of report date: Region · IN SCOPE · CW · GECOL · HLC · RFI · TE Installed · ONAIR · TE PAC · Remaining · Issues · % onair + TOTAL row. Removed ONAIR Last/This/Δ columns.

SINGLE-FILE DATE-WINDOW PERIOD ENGINE (new): each row carries r.gateDates{gate→Date|null} (serialToDate of each gate's source col). PERIOD_GATES=[Acquisition,CW,GECOL,HLC,RFI,TE Installed,ONAIR,TE PAC]. periodCount(rows,gate,fromISO,toISO) counts sites whose gate date is inside the inclusive window. Sites still holding Done/Pending text (no real date) are not counted until dated — honest caveat, stated on the strip.
 - GLOBAL Period From/To selects added to the filter bar (dates from earliest gate date → latest, dd-mm-yyyy labels, ISO values; default = all dates). Drives ONLY the "Progress in Selected Period" strip = difference in the chosen window per gate. Does not touch cumulative tables. Cleared by Reset; shown in crumbs as "Period From/To: dd-mm-yyyy".
 - NEW "Delivery by Region — Achievement in Period" table with its OWN independent From/To selects (RP_FROM/RP_TO), per region × gate count of sites reaching that gate within the window + TOTAL row. Prints "Period: dd-mm-yyyy → dd-mm-yyyy" (verified survives into the PDF #ovPrint clone).
 - winDefaults bounds are real selectable dates (fixed a bug where To defaulted to report date, which isn't an achievement date, and reset the select).
Overview order: Overall Status → Health+KPIs → Project Lifecycle → Project Checkpoint Chain → Progress in Selected Period → Delivery by Region — Achievement in Period → Delivery by Region → Why Sites Are Held → Management Decisions.

## Date Range Pickers + reorder + acquisition-pending fix (19-09)
1. FIX Project Checkpoint Chain — Acquisition Pending showed 0: pageCheckpointChain measured every gate on the in-scope set (all acq=Done). Re-added POP_NOMINAL/POP_SCOPE tags to CHAIN_GATES + nominalRows(); RF Survey & Acquisition now measured on the nominal file (minus cancelled). Result: RF Survey 291/0, Acquisition 259/31, CW 250/0, GECOL 169/10, HLC 54/24, RFI 223/27, TE Installed 213/25, ONAIR 199/14, TE PAC 137/63.
2. Date filters → native calendar Date Range Pickers (<input type="date"> with min/max = data span), replacing the 477-option sequential dropdowns. Applies to global Period From/To in the filter bar AND the region table's own From/To. User can pick any day/month/year; any date recomputes counts (periodCount uses inclusive ISO compare, works for non-gate dates too).
3. Removed the "Period: from → to" label from the region-period table (dates live in the pickers). Added .dpick style + @media print override forcing color:#111 on white — verified the printed #ovPrint clone shows the date value in rgb(17,17,17), clearly legible.
4. Delivery by Region (cumulative) moved BEFORE Delivery by Region — Achievement in Period.
Overview order now: Overall Status → Health+KPIs → Project Lifecycle → Project Checkpoint Chain → Progress in Selected Period → Delivery by Region → Delivery by Region — Achievement in Period → Why Sites Are Held → Management Decisions.
VALIDATED 16-09: 28 pages, 0 errors, HEADER_WARN=[], KPIs intact, live date-pick recompute confirmed.

## O&M column + full period chain (19-09 pt2)
- Cumulative Delivery by Region: added O&M column after TE PAC (gsdnRegions.oam = te.oam==='done'; TOTAL uses S.oam=161). Table now 13 cols; kept width via .compact-t (11.5px, tighter padding; 9.5px in print). No horizontal overflow (measured). Header "TE Installed"→"TE Inst." to save width.
- Region "Achievement in Period" table: gate chain expanded to PERIOD_GATES_FULL = RF Survey · Acquisition · In Scope · CW · GECOL · HLC · RFI · TE Installed · ONAIR · TE PAC · O&M Handover. Added 'O&M Handover' to r.gateDates. compact-t applied.
- DATA LIMITATION (honest): the period table counts by DATE. RF Survey works (223 in-scope dated), and CW/GECOL/HLC/RFI/TE Installed/ONAIR/TE PAC work. Acquisition, In Scope and O&M Handover read 0 because those columns hold text (Done/Pending/N-A), no real dates — they light up once dated. In the CUMULATIVE table O&M shows 161 correctly (that table counts status, not date).
- Verified: cumulative TOTAL [259,250,169,54,223,213,199,137,161,60,53,77%]; period headers full 11-gate chain; 0 overflow; 0 errors; 28 pages.

## Date-range pickers defaults + unified region gates + strict date-only rule (19-09 pt3)
1. Filter date pickers (global + region-period): on Clear/empty, From defaults to the first project date, To defaults to TODAY's real calendar date (todayISO via new Date()), and picker max=today so tomorrow it auto-advances. syncFilters now fills these defaults (dateDefFrom/dateDefTo) so Reset shows first→today, not blank. Fixed: syncFilters was overwriting defaults with ''. Native <input type=date> calendar retained.
2. Delivery by Region gates UNIFIED with the period table: Region · RF Survey · Acquisition · In Scope · CW · GECOL · HLC · RFI · TE Installed · ONAIR · TE PAC · O&M Handover · Remaining · Issues · % ONAIR. RF Survey & Acquisition are nominal-population counts per region (gsdnRegions groups nominalRows too; totals S.rf/S.acqD). Period table keeps identical gate set with + deltas and its date-window function. .compact-t tightened (10.5px, fixed layout, header wrap, centered) → 15 cols fit 1680px with zero overflow (8.5px in print).
3. STRICT DATE-ONLY rule enforced on every "…Date" column — 'Done'/'Yes' text no longer counts as done (rule fixed for when dates are entered later; current text-only columns read 0, user pre-accepted): teDone→!!serialToDate; cwState, GECOL/HLC (dateStat), Acquisition, RF Survey, FAC (facDoneFlag) all date-only. Removed the raw-text fallback bug where acq/rfSurvey returned the literal "Done". Removed dead teDateDone.
   Resulting date-only reads on 16-09: RF Survey 241 (was 291), Acquisition 0/pending 31, CW 249, GECOL 169, HLC 42, RFI 223, TE Installed 213, ONAIR 199, TE PAC 137, FAC 161 (was 186), O&M/EIR/PAT/As-Built/HW-Doc = 0 (columns hold text, will light up when dated). PAC 195, MW Align 73 unaffected (have dates).
VALIDATED: 28 pages, 0 errors, 0 overflow, HEADER_WARN=[], reset→From 2023-01-08 / To today.

## GLOBAL PERIOD MODE (19-09 pt4) — main date filter now controls the whole dashboard
Mechanism: periodOn()=(FILTER.dFrom||FILTER.dTo). applyFilters() wraps its result in periodView(): in period mode it clones each row and marks every dated gate as done ONLY if its date is inside [From,To] (inclusive) — RF Survey, Acquisition, CW, GECOL, HLC, RFI, TE Installed, ONAIR, TE PAC, O&M, plus te sub-dates (EIR/PAT/As-Built/HW Doc/MW Align/survey/DN/MOS/commissioning/integration), PAC(accept), FAC(finalAccept). nominalRows() and gsdnStats' nominal set also run through periodView so RF Survey/Acquisition window too. Normal mode = periodView is identity → byte-for-byte the old cumulative behaviour (verified: reset → CW 249).
Result: every count widget across Overview + CW + TE reflects the chosen window (e.g. last-90/120d shows CW 4, ONAIR 12, TE PAC 35). Difference-in-period (option ب), not as-of.
Hidden in period mode (.cum-only + body.period-on CSS; option أ): Health Index card, Open Issues card, Why Sites Are Held, Management Decisions, the lifecycle state-bar (Pre-civil…), Checkpoint Chain Pending row (Overview + CW checkpointGrid + TE checkpoint), Delivery by Region Remaining/Issues/%ONAIR columns. Health/KPI grid reflows to 3 cols (ov-health) so no gap.
Honest limit (pre-accepted): only columns holding real dates move; text-only columns (Acquisition, O&M, EIR, PAT, As-Built, HW Doc) read 0 in a period until dated.
VALIDATED: normal 28 pages OK/0 overflow; period-mode 28 pages no empties/0 overflow; reset restores cumulative + From=first date / To=today; 0 errors.

## In Delivery Scope — clarification + period-mode handling (19-09 pt5)
User asked: is "In Delivery Scope" = Delivery Batch achieved, is it waterfall-linked to Acquisition, and why doesn't it change with the date filter.
- Data check (16-09): all 259 batch-present sites have Acquisition=Done; 0 batch sites are Pending/Cancelled; 0 acquired-without-batch. So the waterfall already holds in the data (every delivery-scope site is acquired). inScope = batch!=='' && !cancelled.
- Why it's constant under the date filter: Delivery Batch is a SCOPE FLAG with no date column, so it has no time dimension — period windowing (which counts by date) cannot move it. Correct behaviour: the scope of work doesn't shrink for a shorter window; only ACHIEVEMENT in the window does.
- Fix for the confusing constant (consistent with the user's "hide non-time in period mode" choice): hide the Lifecycle "In Delivery Scope" step and the Delivery-by-Region "In Scope" column in period mode (cum-only); removed "In Scope" from the period table's gate list entirely (it can never be a dated achievement). Kept in normal/cumulative mode.
VALIDATED: normal shows In Scope; period hides it (lifecycle step + region column + absent from period table); 28 pages, 0 overflow, 0 errors.

## O&M gate in Checkpoint + Dismantle summary (19-09 pt6)
- Added 'O&M Handover' as the last gate in Project Checkpoint Chain (POP_SCOPE): Done=te.oam date, Pending=te.oam==='pending'. Now reads 0/2 (no dates yet, 2 pending) — will fill when dated. Checkpoint table got .compact-t so the 10-gate row keeps width (no overflow).
- Added a compact "Dismantle" summary panel to GSDN Overview (after the two region tables), 6 cards: CW/TE × Ready(RFD)/In Progress/Completed, from dismantleRows(). Tagged .cum-only (hidden in period mode — it's a state snapshot). Shows CW Ready 4 on 16-09; empty-state message when no requests. Full detail stays in the existing CW/TE ▸ Dismantle tabs.
VALIDATED: checkpoint incl O&M 0/2; dismantle cards render; 0 overflow; 28 pages; 0 errors.

## 2026-09-19 (session): 19-09 master remap + Overview/TE charts
- New master `GSDN_Master_19-09-2026.xlsb` (177 cols, 322 rows). TE install block restructured: added 5 execution-detail cols (MTS Cabinet, Indoor IP Router, RF Antenna, MW Antenna, DC/OF Cable), Installation Plan End Date (= expected TE finish) + Actual End Date; dedicated Install-Start date removed. Whole tail from col 80 shifted +5.
- Remapped positional maps: COL.issue/owner/remark 115/116/117; TE_COL fully rebuilt (instFin & instStatus unified on col 84 "TE Installation Date"; instStart=76=MOS Actual; new instMts/instIpr/instRf/instMw/instDcof 77-81, instPlanEnd 82, instActEnd 83; onair 89, pac 103, oam 104, EIR 92-96, PAT 97-101); DIS_COL 105-114; EQ_COL 149-176; CW_BOQ 118-148.
- Dropped 'Install Start' gate from TE_GATES (now redundant with MOS); fixed tePipeline dates[] alignment to new gate order.
- Validated on 19-09 master: HEADER_WARN=[], in-scope 259, TE Installed 213, ONAIR 199, TE PAC 137, O&M 0 (no dates yet — to be filled later). 28 pages, no overflow, no console/page errors.
- CHARTS: Overview got a new row [Completion by Region bars | Overall Status donut (ONAIR=Done, teal/amber/grey)]; Project Lifecycle numeric tiles converted to Completion-by-Stage %-bars (kept drop-off banner + stacked "where sites stand now"). TE Executive got the same [Completion by Region | Site Status donut] row. Donut click disabled on Overview/TE (status buckets aren't CW-status filters). Verified light + dark + period mode.

## 2026-09-19 (session 2): donut filter + compact lifecycle + geographic map
- Donut click-to-filter: added FILTER.life (onair | pending=post-CW,not onair | scope=pre-CW). Shared lifeBucket()/LIFE_LAB/LIFE_COL. Clicking a donut slice or legend row (Overview "Overall Status" + TE "Site Status") filters the whole dashboard; crumb + Reset handle it.
- Project Lifecycle: converted to COMPACT bars (.lifebars CSS, tight rows, inline "241 /259 · 93%"), moved into a c2 row (align-items:start) beside the new map; removed the tall "where sites stand now" stacked block to slim it.
- Geographic Spread (offline): inline SVG Libya outline (212-pt ring embedded from georgique/world-geojson, equirectangular projection with cos(midLat) correction). 259 site dots from lat/lng, colored by 3 buckets (ONAIR/Pending/In-Scope). Panel on Overview with legend (click=filter) + Enlarge button. Dot click → status-first tooltip.
- Enlarge modal (#geoModal): larger map with zoom (buttons + wheel, cursor-anchored via CSS transform on #gmSvg) and drag-pan; side panel shows status chip + current stage (siteStage()) at top, then code/name/coords/region/type/scenario/contractor/ONAIR/PAC/issue. Close on ✕ or backdrop.
- siteStage(r): O&M > PAC > ONAIR > Installed > RFI > CW-done > civil-works.
- Validated: 28 pages no overflow/errors; map 259 dots, modal opens, dot detail = "ONAIR (Done)", onair legend filter → 199. Offline (no external tiles/CDN).

## 2026-09-19 (session 3): map UX refinements
- Modal rebuilt as flex (no full-width header): map fills full height on the LEFT, info panel full height on the RIGHT. Title/description "GSDN Site Map · N sites · scroll…" moved to top of the info panel. Fixes the empty top-half.
- Removed the Enlarge button; clicking anywhere on the Overview map (cursor:zoom-in) opens the modal, preselecting the clicked site.
- Hover a dot → small tooltip with ID + name only (both maps). Click a dot → full detail drawer in the modal side panel (status chip + current stage on top, then coords/region/type/scenario/contractor/ONAIR/PAC/issue). Detail fonts enlarged (chip 15, id 18, table 13).
- Main-page map height now equals Project Lifecycle (row stretch + geo-wrap flex with absolute svg so it fills, not balloons) — no empty gap under Lifecycle.
- Esc closes modal; zoom (buttons+wheel, cursor-anchored) and drag-pan retained.
- Confirmed: geoSites accepts the full Libya coord range (lat 18–34, lon 8–26) and projects by lat/lng, so future East/South sites (Benghazi, Tobruk, Sebha, Kufra…) plot and colour automatically with no code change.
- Validated: 28 pages no overflow/errors; map 259 dots; modal opens on map click; dot detail; legend/donut filter (onair→199). lifecycleH==mapCardH.

## 2026-09-19 (session 4): map detail rows + cursor
- Modal site-detail table reworked to waterfall order: Coordinates, Region, Type, Scenario, Tower Owner (new), then gates Acquisition · CW · RFI · ONAIR · O&M Handover (each shows its date, else Done/status/—), Open issue. Removed TE PAC row (kept "Closed — TE PAC signed" in the current-stage line).
- Map cursor: changed modal .gm-map from cursor:grab (tiring open-hand) to default; adds .dragging (grabbing) only while actually dragging. Dots keep pointer.
- Validated: 28 pages clean; modal detail + filter OK.

## 2026-09-19 (session 5): map status isolation
- Modal legend now isolates one status on the map: click ONAIR/Pending/In-Scope → only those dots show, others hidden; active chip outlined, others dimmed. Local view filter (does not touch global FILTER).
- Easy reset: a "↺ Show all sites" button appears while filtered, and clicking the active chip again also clears. Title hint updated ("click a status to isolate it").
- Validated: isolate ONAIR → 199/259 visible, note shown; Show all → 259, note hidden. 28 pages clean.

## 2026-09-20: SLA rules fixed into dashboard (CW + TE), working days
- TE_SLA replaced with the confirmed 16-gate chain (min–max working days): access RFI→Access 3–5, survey 1–2, dnSub 1–2, dnApp 1–2, mos 1, install MOS→TE-Install 3–5, comm 1, mwAlign 1, integ 1, onair 1, hwDoc 1, eir HW-Doc→EIR 3–5, pat 3–5, asBuilt 1–2, pac As-Built→PAC 5–10, oam 3–5. TE_E2E: MOS→ONAIR 8–12, Access→O&M 30–51. TE_SEGS date-pairs rewired to the new chain.
- Old TE_SLA removed (surveyToInst, mosToEir=10, eirToPat=5→now pat, PreAcc→PAC=14, pacToOam=7 all gone). vendorQuality now uses TE_SLA.pat.max. teSLAPanel shows min–max (wd) + end-to-end; colour rule ≤min green · ≤max amber · >max red; note corrected (removed the old "14 calendar days" claim).
- CW_SLA added (was none): proc/access/mob/laySub/layApp 1–2, exec by scope, gecol & hlc embedded 7–10, CW PAC 1–3, DLP 90 CALENDAR days (~3 months), FAC 3–10, RFI 1. Execution SLA per site via cwExecSLA(): adaption-only 4–8; adaption+tower by class RT 14–21 / GF 30–45 (classifier = col8 RT/GF; scopeTwr col26='Yes'). GECOL/HLC embedded (run within execution from work start), not separate gates. CW_E2E: adaption 10–21 / +RT 14–21 / +GF 30–45.
- pageCycle (CW Flow & Duration): added CW SLA Rules table (cwSLATable), removed hardcoded 14/30/60 colour thresholds → now coloured by each segment's SLA min/max; cards show SLA tag.
- Validated on Master 20-09: 28 pages, no overflow/console errors. TE SLA table renders with per-gate breaches where dates exist; rows without dates show n/a (data to be entered later, per user).
