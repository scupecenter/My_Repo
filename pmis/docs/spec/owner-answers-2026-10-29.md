# Owner answers to Q37–Q74 (2026-10-29)

Answered one by one by the product owner. "Default" means the proposed default in `open-questions.md` was accepted.

| Q | Answer |
|---|---|
| Q37 | Default: HOTO stays in Handover & Closure. |
| Q38 | Default: Site RFI stays in CW; the TE sub-section shows its date read-only. |
| Q39 | Default: stage 8 stays in TE; the RF team edits only its own tasks there. |
| Q40 | Default: CW FAC approved by the CW stage holders, TE FAC by the TE stage holders (per-task holder override); Final Closure stays with the Project Manager. |
| Q41 | Default: Dismantle is a fifth sub-section, outside the stage mapping; CW and TE show a read-only dismantle badge. |
| Q42 | Default: each stream lists the sites it applies to; N/A sites hidden behind a toggle. |
| Q43 | Default: a register record that is the source of a task is approved by the task's stage row; any other record by the register row. |
| Q44 | Default: RF & Design and Acquisition each get a register row, seeded with the stage-1 holders. |
| Q45 | Default: approver and approval-date fields come from the PMIS final approval; O&M Accepted By stays typed. |
| Q46 | Default: new sites are created in the Site Register; identity is stored in the RF & Design record, one approval on the stage-1 row. |
| Q47 | Default: planned Site Release is the first baseline date, entered at site creation, approved by the Project Manager with the baseline; later changes go through Change Control. |
| Q48 | Default: add D-1 to the baseline proposal; the parallel run tags the difference "D-1 added". |
| Q49 | Default: CW DN and TE DN submitted/approved dates are read from the Warehouse register. |
| Q50 | Default: CW/TE RN date = latest received RN of that type whose reason is not "Faulty or Damaged"; add "Dismantle" to the return reasons. |
| Q51 | Default: the TE vendor name is read from the TE Installation order; typed only when no order exists. |
| Q52 | Default: the dismantle contractor is read from the active dismantle order; typed only for in-house work. |
| Q53 | Default: contractor per task by scope (tower orders for tower tasks, adaption orders for adaption tasks); the Master export uses the order with the earliest PO/WO. |
| Q54 | Default: GECOL closes on Power-On, HLC on TX Link Tested; SLA end events stay as in the Master during the parallel run. |
| Q55 | Default: one row per site in GECOL and HLC; a new request is a new version of the same row. |
| Q56 | **Owner decision (differs from the default):** each team owns its own register and enters its own purchase requests. Procurement enters the CW purchase requests in the Procurement register; the GECOL team enters the GECOL purchase request in the GECOL register; the HLC team enters the HLC purchase request in the HLC register, and it counts as a purchase request. |
| Q57 | Default: a permit renewal is a register record only; B3/D1 keep the first approved permit; an expiry before the work ends raises the expiring/expired alert. |
| Q58 | Default: the Master snag columns are computed from Quality Inspections; no snag = N/A. |
| Q59 | Default: "no snags found" = N/A / N/A; the "No" branch is dropped. |
| Q60 | **Owner decision (extends the default):** add TE FAC to the Quality stages and map each stage to its task (CW QC → B10/B11, TE QC → D6, CW PAC → B13, TE PAC → D16, CW FAC → B15, TE FAC → D18), and also add a Dismantle QC stage for dismantle snags. |
| Q61 | Default: the design (MW half-links) decides MW; the As-Built configuration is a check with an alert. |
| Q62 | Default: the permit must be valid on the gate date (D36); an expiry after the gate opened raises an alert only. |
| Q63 | **Owner decision:** Has Expiry = Yes for Security Clearance, Other, Access - Survey, Access - CW, Access - TE and Access - Dismantle (and the 3 PTW types already Yes). Has Expiry = No for City Council and Civil Aviation. |
| Q63c | **Owner decision:** Access - QC/Maintenance has an expiry like the other access permits. In addition, each permit record in the Permits register has a "has expiry date" choice: Yes opens the expiry date field (required); No hides it and the permit is permanent. The permit type gives the default for this choice. |
| Q64 | Default: Dismantle (E2) needs an approved Access - Dismantle and PTW - Dismantle (or approved N/A); Survey and QC/Maintenance access are information only. |
| Q65 | **Owner decision (differs from the default and D59):** TE Dispatch Complete = the date of the latest TE DN, as the Master computes it now. |
| Q66 | **Owner decision (corrected by the owner):** the LPU Kit need is per sector, not fixed per site: 2 LPU Kits per sector, for both Cambium and Intracom sites, multiplied by the site's number of sectors. The need is read from the item need rules (Need Unit), not fixed columns. |
| Q67 | Default: Power Safe is entered with D7 (Commissioning) and Uplink Ready with D10 (On-Air), stored in the Readiness record and approved with those tasks; the Power Engineer enters Power Safe. |
| Q68 | Default: As-Built has two parts with separate approvals: the CW part with CW PAC (B13), the TE part with TE PAC (D15); Master BU and EF are computed from those approvals. |
| Q69 | Default: records without a site are visible to anyone holding the module, whatever their regions; the Risk Register gets an optional "affected sites" field, and a materialized risk creates issues for those sites. |
| Q70 | Default: an issue owner is an employee or an external party; for an external party the Aljeel follow-up person is shown too. |
| Q71 | Default: a "Deliverables" register with its own Matrix row; entry by Project Support, approval by the Project Manager; each unit needs an acceptance reference and a document. |
| Q72 | Default: the daily Progress & Plan page has no approval; it is a dated log, and a repeated reason can become an issue. |
| Q73 | Default: one Site Register template per stream with only that stream's input columns, plus the full Master template; a stream template uploaded in another stream is rejected. |
| Q74 | Default: As-Built and Warehouse items are matched by Warehouse item code ("Fiber Patch Cord" = As-Built "Patch Cord Fiber (m)"); concrete stays in As-Built only. |

## Approval engine questions (from PR scupecenter/My_Repo#43)

| # | Answer |
|---|---|
| E1 | As built: a 2-level stage uses the Entry and Approve cells (Review is left out); a 1-level task's submission is the final approval, with step-up. |
| E2 | As built: entry needs `edit` on sites, the final approval needs `approve`; review needs `view` plus being a holder of the review cell in the Matrix. |
| E3 | Default: milestone dates (except Site RFI) are calculated automatically from their tasks, as in the Master formulas, with no approval of their own. Site RFI is pre-filled, editable and approved. |
| E4 | As built: "self-approval" (B5, step-up and flag) is when the same person reaches the final approval, by skip or on a 1-level task. Entry and review by the same person is a logged skip only. |
| E5 | Superseded by D1 below: with no parent/sub-roles there is no inheritance question. |
| E6 | **Owner decision:** open snags on the site block the approval of CW PAC (B13), TE PAC (D16), CW FAC (B15) and TE FAC (D18). |

## Reference data questions

| # | Answer |
|---|---|
| D1 | **Owner decision (changes CLAUDE.md "6 main roles and 9 sub-roles"):** there is no main/sub-role split. All roles are flat "roles", and their names and properties are editable in Roles & Responsibilities. For now keep the seeded names (the 6 former main roles, the 10 former sub-roles and Management) as plain roles. |
| D2 | Default: the seeded workflow v1 and SLA v1 apply to every imported site, however old (effective from 2024-01-01). Later rule changes are new versions and never rewrite the past. |
| D3 | Default: the Arabic role names stay as proposed; the owner reviews and edits them on the Roles screen. |
| D4 | Default: no SLA on the 9 gates for now (a gate opens on the previous milestone date when its conditions are met); the admin can add one later in Settings. |
| D5 | Default: B10 (CW MOS) keeps one SLA of 14–21 working days for both B-10a (tower) and B-10b (adaption). |

## CW forms and dashboard questions (Q19–Q36)

| Q | Answer |
|---|---|
| Q19 | **Owner decision (differs from the default):** every CW DN and RN, including the first DN, is a record in the Warehouse register (Warehouse Matrix row). Task B7 reads the first DN from the register instead of holding its own slot. |
| Q20 | Default: each form template has a configurable signatory list; each block reads a Matrix level of the owning row or a named role (for example the Project Manager); the contractor signs by hand; a level held by a group or role prints a blank name. |
| Q21 | Default: the approved DN posts the stock issue; the uploader enters the dispatch date written on the signed DN (required, not after the upload date), used for posting, WH Serials and the TE dispatch date. |
| Q22 | Default: the applicant enters "Qty Approved" per line in the prepare screen; it is at least the dispatched quantity and is checked at review. |
| Q23 | Default: condition per RN line in the PMIS; the Master export writes one row per condition with a suffix on the document number (`-G` good, `-F` faulty). |
| Q24 | Default: the RN header takes the dismantle contractor and order when a CW Dismantle order exists, otherwise the CW contractor and order; E2 is split into E2a (CW dismantle) and E2b (TE dismantle). |
| Q25 | **Owner decision (narrows CLAUDE.md "any snag on the site"):** only open CW snags block the CW PAC; TE snags do not block it. By the same logic only TE snags block the TE PAC (see E6). The generated PAC pre-ticks "Accepted", the other two boxes are greyed. |
| Q26 | **Owner decision (differs from the default):** the PAC date and the FAC date are the PMIS approval dates of B13 and B15 (and of the TE PAC / FAC tasks). The form prints them blank or as "date of approval". |
| Q27 | Default: CW DLP = 3 calendar months (EDATE); FB differences of up to 2 days in the parallel run are tagged "DLP rule change". |
| Q28 | **Owner decision (differs from the default):** the PAC acceptance checklist (34 Pass / Fail / N/A items and the measured grounding resistance) is entered in the PMIS now, as part of the PAC prepare screen, and printed filled on the generated PAC. |
| Q29 | Default: Tower Type, CW Schedule (MS3 vs its baseline: Ahead / On / Behind) and the region name are filled automatically; the region labels use the PMIS names (Zawia, Sebha). |
| Q30 | **Owner decision (differs from the default):** a FAC cannot be generated before the DLP ends, nor while snags are open; the two statement boxes stay ticked by hand. |
| Q31 | **Owner decision:** design a provisional Snag List template in the style of the approved CW forms; the owner approves it later. |
| Q32 | **Owner decision:** the numbering pattern of each form is a setting defined and edited in the PMIS (prefix, region code, year, sequence, reset rule); the owner approves the final patterns later. Seed: `{KIND}-CW-{REGION}-{YYYY}-{SEQ:4}` with DN, RN, PAC, FAC and SL. |
| Q33 | **Owner decision (differs from CLAUDE.md "PAC BoQ = DN − RN"):** the PAC "Accepted Item List (BoQ)" prints the CW As-Built quantities. A non-blocking warning shows per item where the net DN − RN differs. |
| Q34 | **Owner decision (differs from the default):** the dashboard reference date can be changed by the user, as in the legacy dashboard. |
| Q35 | Default: health index bands green ≥ 85, amber ≥ 70, red below 70, as an admin setting, shown as draft. |
| Q36 | Default: the dashboard counts issues for owner bars and totals, and sites for "sites with an open issue"; issue age in working days from the raised date. |

## SLA and gate questions (Q75–Q84, from migration 0017)

| Q | Answer |
|---|---|
| Q75 | Default: A-1, A-3, S-1 and S-2 start from their register dates, as in the Master. Until the RF & Design, Acquisition and Change Control registers are built, the clock starts the day the task opens; it switches to the register date when the register exists. |
| Q76 | **Owner decision (differs from the Master):** when the latest condition date is earlier than the gate date, every milestone takes the later of the two dates (as MS2 and MS4 already do), instead of staying blank. `calc.milestone_ge_gate` becomes empty. |
| Q77 | **Owner decision:** Commissioning Power Safe stays a yes/no field; gate G6 (On-Air Readiness) has no condition on it. |
| Q78 | **Owner decision:** the six PTW HSE checks are information only and do not hold a gate; stop work still holds it. |
| Q79 | Default: an edited Site RFI date earlier than the RFI Readiness gate is refused (422 `before_gate`); the setting can switch it off. |
| Q81 | **Owner decision (differs from the default):** a gate locks the tasks of the next stage until it opens (its permits valid, no stop work, no suspension), except the GECOL and HLC tasks, which run in parallel with civil works. |
| Q82 | **Owner decision:** a task's SLA clock closes at its actual date (as in the Master); a negative duration (actual date before the start) raises a data-quality alert for review. |
| Q80 | **Owner decision:** the SLA of B-15 (CW FAC) and B06 starts from the DLP end counted as in the Master, PAC date + 90 calendar days (for CW). This applies to these SLA start events only; the printed DLP and `dlp.months.cw` stay 3 months (Q27). |
| Q83 | Default: holidays and weekend days are changed by a System Admin or a delegate holding `calendars.edit` for all regions. |
| Q84 | Default: build a daily job (also run at start-up) that applies future-dated SLA versions and sends the 14-day reminder for tentative holidays. |
