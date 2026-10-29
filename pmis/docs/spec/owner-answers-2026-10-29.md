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
