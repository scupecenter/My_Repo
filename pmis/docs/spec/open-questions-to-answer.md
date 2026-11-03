# GSDN PMIS — open questions to answer

108 questions still open on 2026-11-03. Write your answer under each one after **Answer:**, then upload this file back.
Leave an answer empty to keep the proposed default (the system already works with it). You may answer in Arabic or English.

Short answers are fine, for example: `default`, `yes`, `no`, `option 2`, or a sentence.

---

## Earlier open questions (P0 spec, phase 4)

### Q1

**The Master upload has no `_tpl` sheet.** CLAUDE.md rejects uploads without an embedded ID. The live Master file contains no `_tpl` sheet, but must be uploadable during migration and the 1-month parallel run.

**Proposed default / question:** The PMIS issues a "Master template" by adding `_tpl` (TPL-MASTER, version) to the user's copy once. Until then, an admin-only "legacy Master import" path accepts it, identified by sheet names and headers, and writes every use to the System Log.

**Answer:** 


### Q2

**D-1 start where RFI is N/A.** CLAUDE.md measures D-1 from the Site RFI date. Hot / Cold Swap and sites with no CW, GECOL or HLC have no Site RFI (BP §03). BP §06 says D-1 is not measured for Swap.

**Proposed default / question:** D-1 starts from MS4. Where RFI is N/A, it starts from MS1 (the base date of gate CA). D-1 is not measured for Hot / Cold Swap. The Master SLA sheet (column Y, which starts from Site Release) needs the same fix for the parallel-run comparison.

**Answer:** 


### Q3

**RFI for Swap sites.** BP §03 and the SLA sheet say RFI is N/A for Hot / Cold Swap. Site Calc F and Master BQ decide RFI from the flags AA:AD only.

**Proposed default / question:** Follow the Master formula (flags), so the parallel run matches. Add an alert when a Hot / Cold Swap site has any of AA:AD = Yes.

**Answer:** 


### Q4

**The holidays table is empty.** Setting "Public Holidays" (F:G) has no rows, so every SLA currently ignores holidays.

**Proposed default / question:** The admin enters the Libyan public holidays for 2026–2027 before the pilot. Until then SLA counts Fri / Sat only, and a banner warns "holiday table empty".

**Answer:** 


### Q5

**Document step codes differ.** CLAUDE.md seeds "B4 STA / ST report", but in the blueprint step table B4 is the CW survey and B5 is STA / ST. CLAUDE.md seeds "B9 MOS proof" only, but B8 (tower MOS) has the same evidence.

**Proposed default / question:** Attach the STA / ST report to step B5 and the MOS proof to both B8 and B9. Confirm both.

**Answer:** 


### Q6

**Warehouse need for IP Router Only sites.** D72 applies a fixed need to every TE site: Router 1, Cabinet 1, Battery 2, LPU 2, plus sectors. An IP Router Only site (AF = Yes) probably needs only the router, so its TE Dispatch Complete would never be reached.

**Proposed default / question:** When AF = Yes and AE = N/A, the need is Router = 1 and every other unit = 0, as a configurable rule per scenario. Confirm before the WH build.

**Answer:** 


### Q7

**Delay that no period covers.** BP §14 attributes the days above SLA to the executor (R). BP §09 says days not attributed are charged to no one.

**Proposed default / question:** Show these days on the default party (R), tagged "default (R)" and kept separate from approved attributions. The contractor scorecard counts approved attributions only (BP §06).

**Answer:** 


### Q8

**Role list mismatch.** Setting StaffRole (15 values, for example "Team Lead (GECOL)", "Team Lead (Fiber)", "CW Engineer") does not match the 6 main roles and 9 sub-roles in CLAUDE.md.

**Proposed default / question:** The PMIS uses the CLAUDE.md roles. Import maps the Master values (Team Lead (CW) → CW Team Lead, CW Engineer / Site Engineer → Site Engineers (CW), Team Lead (GECOL) → GECOL Power Team, and so on). The mapping table is editable and approved by the owner.

**Answer:** 


### Q9

**Gate date vs extra conditions.** CLAUDE.md says the gate date equals the previous milestone date. The Master gates AX, CA and CV take the latest of that date, the Access / PTW permit dates and the Commissioning Power Safe Date, and stay blank while a Stop Work is active.

**Proposed default / question:** Follow the Master formulas (rules.md §2.2). The CLAUDE.md wording covers the base case. An ADR records the refinement.

**Answer:** 


### Q10

**Region names.** The Master stores "Tripoli Area", "Middle Area" and so on. CLAUDE.md uses "Tripoli", "Middle" and so on.

**Proposed default / question:** Store a region code with an English and an Arabic label. Import maps "X Area" → X.

**Answer:** 


### Q11

**Several issues per site vs the Master.** The Master holds one issue per site (GA:GE). The PMIS allows several. For the parallel-run export, which issue goes into GA:GE?

**Proposed default / question:** Export the oldest open issue, or the latest closed one when none is open, and append "+N more" in Remark.

**Answer:** 


### Q12

**Meetings register has no source.** CLAUDE.md lists Meetings, but it has no Master sheet and no blueprint fields.

**Proposed default / question:** Minimal fields: date, title, type, attendees, sites, minutes file, and action items (owner, due date, status). Owner to confirm.

**Answer:** 


### Q13

**B-6 is always 0 for analysis sites.** The Master has a single submission date (AR) for both the analysis report and the layout. B-6 therefore runs AR → AR when an analysis exists (D47).

**Proposed default / question:** Keep the Master behaviour for the parallel run. Propose a separate Layout Submitted Date after the Master is retired.

**Answer:** 


### Q14

**SLA step count.** D64 says 44 steps, but SLA sheet columns D:AV hold 45 step columns (B-10a and B-10b are separate).

**Proposed default / question:** Treat the 45 columns as the source of truth. 44 counts B-10 as one step.

**Answer:** 


### Q15

**Swap sites and stage 1 (A1, A3).** Expansion drops A1 and A3 (CLAUDE.md). Nothing says whether Hot / Cold Swap sites, which are existing sites, need a search, a SAR and an acquisition.

**Proposed default / question:** A1 and A3 apply by default, and a scenario template setting can mark them N/A. Confirm.

**Answer:** 


### Q16

**Health index and Final Closure KPI formulas.** These are new PMIS features with no source formula (rules.md §6.1, §9).

**Proposed default / question:** Equal weights across the 6 factors. The % closed base is HOTO-achieved sites. FAC age is counted from DLP End. The owner reviews all three before P1.

**Answer:** 


### Q17

**TE PAC e-signature.** BP §05 says TE PAC is e-signed by the project team. CLAUDE.md says acceptance documents are filled, signed, scanned and uploaded.

**Proposed default / question:** Scanned upload only (CLAUDE.md). E-signature is deferred.

**Answer:** 


### Q18

**Assignment overlaps and level order.** CLAUDE.md now makes role assignment many-to-many with validity dates. It does not say whether two rows of the same role with overlapping dates may exist, or whether a higher permission level includes the lower ones.

**Proposed default / question:** One active row per user and role at a time; a bulk assign skips existing rows. The levels are ordered view < entry < review < approve < admin, and each includes the lower ones (AU-10, AU-11, MX-02b).

**Answer:** 


### Q103

**Typed effects of the registers enabled in 0025 / 0027.** The registers run on the generic framework, so an approved record stays in `register_records` (like Dismantle). The typed tables and the calculation readers are not fed: Change Control to `change_requests` (the suspension shift of the gates reads it), Acquisition (selected candidate, A3, Master T) and RF & Design (Master C:Q, the `SiteIDs` list), Quality snags (the PAC / FAC block, Q58), Readiness (G6, MS9, Z1), As-Built (Master BU and EF, Q68 / Q99), Issues and Risks (health index). Only two effects are built: Contractors to `external_parties` / `external_teams` (Procurement picks them) and the approver fields of Q45.

**Proposed default / question:** Keep the approved data in the register and feed the calculation layer register by register in follow-up work; until then the calc layer reads what it read before. The owner orders the follow-ups (suggested: Change Control, then Quality, then Acquisition and RF & Design).

**Answer:** 


### Q104

**Values of the lists the spec names but does not fix** (CompanyType, CoStatus, TeamType, TeamSpecialization, TeamStatus, Severity, QIResult, Activity, IssueStatus, RiskCat, ScopeCWTE, RiskResponse, RiskStatus, Trend, EHSCheck, ReviewStatus, SiteType, TowerOwner, TowerType, Ownership, TestPit, WLVendor and the other vendor and type lists of As-Built). Also the Arabic labels of the new fields.

**Proposed default / question:** Free text (a list with no options accepts any text, as Q95) until the owner fixes the values in `register_fields.options`; Arabic labels are empty until reviewed. The spec's closed lists are enforced (Stage, Point Type, Change Type / Scope, Candidate, Selected, MW LOS Check, Existing / New, RT / GF, Scenario, Warehouse Status / Condition / Reason).

**Answer:** 


### Q105

**Warehouse stock model and movement rules (migration 0026).** The spec gives the document table but not the stock rules: one store or several, whether a return may exceed what the site holds, what a serial status is called, whether an adjustment may lower a serial-tracked item.

**Proposed default / question:** ASSUMPTIONS: one central store; stock is derived from posted and pending lines (never stored twice); a pending DN or negative ADJ reserves its quantity (`available` = on hand minus reserved); an RN cannot return more than the site holds (posted DN minus posted RN minus pending RN, `insufficient_stock` / `insufficient_on_site`); a serial-tracked item cannot be adjusted down; serial statuses `In Stock`, `Dispatched`, `Returned` (a Good return goes back to `In Stock`); PL, OPEN and ADJ have no site (`site_optional_types`); Qty Approved on a DN is not below the dispatched quantity; the dispatched quantity per site also lives in `warehouse_site_qty.dispatched`.

**Answer:** 


### Q106

**Document numbers and the form link of DN / RN.** Doc No. is typed and unique; CLAUDE.md numbers the generated forms (`DN-CW-TR-2026-0001`, configurable sequence). The forms module that generates the numbered PDF is not built, so `wh_movements.form_id` is empty.

**Proposed default / question:** Doc No. is entered by the user (Duplicate Doc No. answers 409). When the forms module is built it fills Doc No. from the numbering sequence and sets `form_id`; the signed scan is uploaded into the document slot of the register record.

**Answer:** 


### Q107

**Item codes and need quantities of the seeded Warehouse items.** The Master WH sheet has item codes for 11 of the 21 TE items and none for the 28 CW items, and the Need Unit row has no quantities.

**Proposed default / question:** CW items are `CW-01` to `CW-28` (the numbering of the DN / RN forms); the TE items without a code get a generated one (`SFP-SM-10G-10KM`, `ERKA-2X2-5`, `ERKA-4X0-75`, `FIBER-OUTDOOR`, `TELECOM-BRACKET`, `FIBER-CLAMP-4L8R`); need quantities follow D58 / D72 where stated (LPU Kit 2, Router 1, Cabinet 1, Battery 2) and are 1 per need unit otherwise. The admin edits all of it (items are data).

**Answer:** 


### Q108

**As-Built items (migration 0027).** CLAUDE.md makes the CW quantities and the TE configuration items an editable list; the spec lists the TE columns as fixed fields. Who may edit the list is not a separate permission.

**Proposed default / question:** The 31 CW quantities (Master D:AH) and six TE quantity items (Sector Qty, MW Antenna Qty, Router Qty, Battery Qty, Patch Cord 1 / 2 Qty) are items; the other TE columns (vendors, types, heights, power data) are fixed fields. Each item is the number field `q_<code>` and keeps its Master column; it is linked to a Warehouse code by the WH "As-Built Item" row (Q74; Concrete and Manhole have none). Edited by the System Admin or a delegate of `fields.edit` (no new permission module). Antenna, router and patch-cord types should be Warehouse items (spec 3.14): they are free-text lists for now. Patch cord quantities use the unit `qty`. Master BU / EF projection: Q103.

**Answer:** 


### Q109

**Quality rules where the spec contradicts itself.** "A Snag needs a Severity" and "a blank severity counts as Blocking" cannot both hold; the Record ID is not checked for uniqueness in the Master; the fix photos (EXIF rule) and the closure of a snag by the QC photo approval need the document module.

**Proposed default / question:** A snag needs a severity before it is submitted; the Record ID is unique; Q45 fills Approved / Released By and N/A Approved By at the final approval. The QC photo flow and the "snag blocks PAC / FAC" link are follow-ups (Q103).

**Answer:** 


### Q110

**Contractors: the party type, the status words and the link of a team.** The Master's CompanyType and the contract `ExternalPartyType` are different lists, and a team points to its company by name.

**Proposed default / question:** A company becomes an external party; the type is the normalized Company Type when it is one of `cw_contractor`, `te_vendor`, `gecol`, `hlc`, `supplier`, `landlord`, else `other`; a status of inactive, terminated, expired or closed makes it inactive; a team is linked to the company of the same name (the company must exist, DQ21) and is an external team with the same id as its record.

**Answer:** 


### Q111

**Meetings: attendees, linked sites, minutes file and action items.** The generic framework has no multi-user, multi-site, file or child-list field type (Q12 default).

**Proposed default / question:** Attendees and linked sites are text lists (names, site codes), the minutes are a reference text and the action items a free text, with Date and Title required. The structured version (action items with owner, due date, status; the minutes file in the document slots) needs those field types and the document module.

**Answer:** 


### Q112

**Template and export for the new registers and items.** The Templates and Export services are not built in the API, so "new items appear in approved templates and the Master-format export" is data-ready only.

**Proposed default / question:** Items and fields carry what those services need (code, labels, section, Master column, in_list); the template version bump on a field or item change is done when the Templates module reads them.

**Answer:** 


### Q113

**BU and EF after the move to As-Built (write-through, migration 0029).** BU (`cw_as_built_submitted`, Yes / N/A) and EF (`as_built_date`) are plain fields of the As-Built record, typed by hand from the B13 / D15 rows. Q68 proposed computing them from the CW and TE part approvals, and the calculation layer (dashboard "As-Built submitted") does not read the register yet (Q103). The As-Built record is one per site with one state, so the CW and TE parts are not approved separately.

**Proposed default / question:** Keep both as manual fields, with the existing record approval. Fill BU = Yes and EF = the approval date automatically on approval only if the owner confirms (setting `as_built.auto_fill_bu_ef`, default off). Confirm, and decide whether the CW and TE parts need separate records.

**Answer:** 


### Q114

**FO / FT only for In-House work, and Procurement as a second source (Q52).** FO and FT are stored as the contractor (external party) of the Dismantle `cw` / `te` record. Q52 says they are typed only for In-House work and read from the active dismantle order of Procurement otherwise.

**Proposed default / question:** Dismantle holds the contractor for every part; Procurement scopes `CW Dismantle` / `TE Dismantle` stay informational. Confirm, or name the rule that picks Procurement.

**Answer:** 


### Q115

**Local drafts of work data.** Should unsaved form data survive a reload in the browser?

**Proposed default / question:** Default: no; only view preferences are stored locally. Unsaved data is kept in memory with an unsaved-changes guard.

**Answer:** 


### Q116

**Pipeline variant.** A: refined rings; B: flat segmented track.

**Proposed default / question:** Default: A, confirmed after real-code previews of both.

**Answer:** 


### Q117

**Who may create shared saved views.**

**Proposed default / question:** Default: System Admin and Team Leads through a new `views.share` grant, delegable like any grant.

**Answer:** 


---

## HLC purchasing and Q91 (migration 0042)

### Q135

**C-3 SLA values after the HLC redesign (migration 0042).** C-3 now measures PR issue → HLC approval (start event `PR:HLC`, end = the HLC approval date). The rule kept the values of the old planning link B03 (min 0, max 1 working day), which were set for "CW PR → HLC request".

**Proposed default / question:** Kept 0 / 1 working days. Give the target and the limit of PR issue → HLC approval (Settings → SLA, a new rule-set version).

**Answer:** 


### Q136

**C-4 SLA end event.** C4 now closes on the in-service date of the HLC record. The SLA end event of C-4 stays the installation date (`hlc.installation_date`), because Q54 keeps the Master's end events during the parallel run.

**Proposed default / question:** Kept the installation date. Should C-4 end at the in-service date after the parallel run (a new end event `hlc.in_service_date`)?

**Answer:** 


### Q137

**C3 tasks that started before migration 0042.** An open C3 task whose clock had already started keeps its stored start (the CW PR date, old rule), as 0018 did for B-15; only clocks that had not started use the PR issue.

**Proposed default / question:** Kept as stored. Re-base the open C3 clocks on the HLC PR date instead?

**Answer:** 


### Q138

**A GECOL or HLC request while C1 / C3 is still locked (Q92 applied to Q91).** C1 and C3 open after B1 (CW PR). A GECOL record (C1 source) or a scope-HLC order with an HLC approval date (C3 source) submitted while that task is locked is refused with 409 until it opens; the draft is kept. Before 0042 a GECOL request without Power-On was accepted on the register row.

**Proposed default / question:** Q92 default applied. Or: accept it on the register row and close C1 / C3 later by hand?

**Answer:** 


### Q139

**HLC requests entered in the HLC register before 0042.** Their `request_no` / `request_date` are kept read-only (legacy) and still counted in `v_purchase_requests` until the site has a scope-HLC Procurement record. No Procurement record was created from them, because that would invent an approval and an HLC approval date.

**Proposed default / question:** The HLC team re-enters each one in Procurement (scope HLC). Or approve a one-time migration with a named approver and a rule for the missing HLC approval date.

**Answer:** 


### Q148

**An HLC execution record without an approved HLC purchase request.** It is a warning to the reviewer (`no_approved_hlc_pr`, Q96), not a refusal. C4 still cannot close before C3 (its predecessor), so the in-service date waits for the approved request.

**Proposed default / question:** Warning only. Should submitting any HLC record need the approved HLC PR?

**Answer:** 


### Q149

**The HLC approval date at submit.** A scope-HLC order needs its PR No. and PR date; the HLC approval date is optional, so the PR can be approved first and the approval date added in a new version (which then closes C3).

**Proposed default / question:** Optional. Make it required (the request is entered only after HLC approves)?

**Answer:** 


### Q150

**Several HLC purchase requests for one site.** Procurement allows several orders per site. C3 closes from the first one submitted while C3 is open (Q93); the HLC record links the approved one with the latest HLC approval date.

**Proposed default / question:** Confirm, or allow only one scope-HLC order per site (a new request = a new version, like Q55).

**Answer:** 


### Q151

**The other date orders of Q96 for GECOL.** The warnings are built for the HLC record and the scope-HLC order only. GECOL keeps its one blocking rule (C-2 not negative); the order of its other steps (survey, layout, notice, MOS, acceptance, Power-On, billing) is not checked.

**Proposed default / question:** Give the step order of GECOL to warn on, or confirm none.

**Answer:** 


---

## Gate-lock exempt list and Q97 team / scope match (0043)

### Q140

**Gate-lock exempt list: "nothing" was also ticked.** The owner's answer adds D1, B14, B15, D18, E2 and E3 to `calc.gate_lock_exempt_tasks`, but the form also had "nothing" ticked.

**Proposed default / question:** Read as adding the three groups (done in 0043, merged into the current value so an admin's own codes stay; tasks a closed gate held were opened by the migration through the normal unlock). If "nothing" was meant, remove the six codes in the setting; no code change.

**Answer:** 


### Q141

**Q97: which team may take an STA or ST order.** D37 (Scope Match) lists CW, GECOL, CW Dismantle, Tower Erection, Site Adaption, TE Installation and TE Dismantle, not STA / ST (the analysis provider, B5).

**Proposed default / question:** Conservative: STA and ST have a row with no specialization ticked, so an STA / ST order that names a team is refused; an order without a team is accepted. Tick the right column in Settings when the owner decides.

**Answer:** 


### Q142

**Q97: a team without a specialization.** The Contractors register does not require the specialization of a team.

**Proposed default / question:** Conservative: such a team is refused on every checked scope (`team_scope_mismatch`, "has no specialization"). Alternative: make the field required in the Contractors register.

**Answer:** 


### Q143

**Q97: the values of TeamSpecialization (Q104).** The list is free text until the owner fixes it. The match compares a team's specialization trimmed and case-insensitively with the columns of the table (seed: CW and TE).

**Proposed default / question:** If the real values differ (for example "Civil Works"), the admin adds them as columns in Settings. Better: fix the list in the Contractors register (`register_fields.options`) and use the same values here.

**Answer:** 


### Q144

**Q97: scopes that are not in the table, and HLC.** A scope missing from the table (for example a scope added to the Procurement list later) accepts no team. HLC is seeded as exempt (the HLC request has no contractor team), so an HLC order is never checked, even if a team is named.

**Proposed default / question:** Conservative for unknown scopes; confirm HLC exempt, or name the specialization (for example an HLC fiber team) that may be put on an HLC request.

**Answer:** 


### Q145

**Q97: what a later change re-checks.** A change of the table, or of a team's specialization, does not touch approved orders; a draft is checked again at submit (and refused then if it no longer matches).

**Proposed default / question:** Confirm that approved orders stay as they are, or ask for a report of approved orders that no longer match.

**Answer:** 


### Q146

**Q97: GECOL.** D37 says GECOL needs a CW team, and the seed has that row, but a GECOL purchase request is entered in the GECOL register (Q56), which has no team field and no check.

**Proposed default / question:** Keep the row for when GECOL orders carry a team; decide whether the GECOL register should check its contractor too.

**Answer:** 


### Q147

**Q97: who reads and edits the table.** Reading needs the Settings screen (`admin.settings` view); saving needs a System Admin or a delegation of `admin.settings` edit for all regions, a reason and the version; it is audited with before and after. No step-up is asked, as for the other light settings. The Procurement entry team does not see the table, only the refusal message.

**Proposed default / question:** Confirm, or ask for step-up on save and a read-only view for Procurement. Also open: the "CW Delivery Model" rule named in the old Q97 row is not built.

**Answer:** 


---

## My profile, email change, password, 2FA (0044)

### Q155

**Name in Arabic and position on the profile (migration 0044).** The owner listed name EN/AR and the position wording as self-editable "if the model has both". The API's `users` has one `display_name`; name EN/AR, position, team and region live in the staff registry, which is in the contract and the web mocks but not in the API database yet.

**Proposed default / question:** Self-editable now: `display_name`, `phone`, `locale`, `theme`. When the registry is built: `name_ar` self-editable like `display_name`; `position`, team and region stay admin-owned (they drive the registry card and assignments). Confirm.

**Answer:** 


### Q156

**Phone without approval.** The phone is a local sign-in identifier and is printed on the registry card, but the owner listed it as a self-edit field. It changes at once (unique, E.164, audited), with no step-up and no approval.

**Proposed default / question:** Keep as built, or ask for a step-up (password) when the phone changes. The registry phone (when the registry is built) follows the account phone.

**Answer:** 


### Q157

**Email change for an M365 account.** A request needs the password re-entered, which an M365 user does not have in the PMIS; the API refuses it (403) and the page tells them to ask an admin. When M365 sign-in is built, should the PMIS email follow Entra (and a request need an M365 step-up), and what happens on approval to a user with an Entra link, since the first-sign-in match uses the email?

**Proposed default / question:** Keep admin-only for M365 accounts until ADR 0002 sign-in is built; then require an M365 step-up and block approval while `m365_object_id` is set unless the new address is the Entra one.

**Answer:** 


### Q158

**Who is told about an email change.** In-app only: the deciders (System Admins and all-regions delegates of `users.edit`) on a request, the user on a decision. E-mail notifications are not built. Security practice also tells the old address when the email changes.

**Proposed default / question:** When e-mail is built: send the decision to both the old and the new address. Confirm.

**Answer:** 


### Q159

**"Waiting for enrolment" and "enforced".** A user whose two-factor waits for enrolment cannot sign in without the admin code, so self-disable needs a code and is not offered then; an admin reset keeps the enforced mark as it was (a self-enrolled user who is reset stays not enforced).

**Proposed default / question:** Keep, or make a reset always enforce it.

**Answer:** 


### Q160

**Existing two-factor rows.** Migration 0044 marks every account whose two-factor is on (or waiting for enrolment) as enforced, because only admins could turn it on before.

**Proposed default / question:** Keep; an admin unmarks the ones that may turn it off.

**Answer:** 


### Q161

**Sessions after a self-disable.** Turning two-factor on yourself ends your other sessions (they never passed a code); turning it off leaves them, as an admin "off" does.

**Proposed default / question:** Keep, or end the other sessions too.

**Answer:** 


---

## Logs and monitoring (0045)

### Q165

**Logs (0045): who is a Team Lead and who reads everything (B4).** The database reads two settings: `logs.audit.full_reader_roles` (seed `PM`) and `logs.audit.team_lead_roles` (seed `RFD_ACQ_TL`, `CW_TL`, `TE_TL`). A Team Lead reads the modules and regions of their Team Lead assignments.

**Proposed default / question:** Confirm the role lists, or name another way (a role property) to mark a Team Lead.

**Answer:** 


### Q166

**Logs: audit rows without a module or region.** Configuration rows (users, roles, groups, settings) map to a module through `logs.audit.entity_modules`; a row with no module, or no region, is read only by a full reader (System Admin, Project Manager) or a `view_audit` holder for all regions.

**Proposed default / question:** Confirm, or say which configuration rows a Team Lead should see.

**Answer:** 


### Q167

**Logs: alert e-mail.** Security alerts reach the System Admins in-app only; the API has no mail sender yet, while CLAUDE.md says security types go in-app and by email.

**Proposed default / question:** Confirm in-app now and e-mail when the mail service exists.

**Answer:** 


### Q168

**Logs: default thresholds.** 5 failed sign-ins per identifier or account in 15 minutes, 20 per address in 15 minutes, an export above 5 000 rows, any sign-in from a new address once a person has a history.

**Proposed default / question:** Confirm the defaults, and whether "new address" should ignore the internal network ranges.

**Answer:** 


### Q169

**Logs: monthly activity report as Excel.** `GET /reports/activity` answers JSON; the export service builds CSV jobs, not workbooks, so no xlsx variant was added.

**Proposed default / question:** Is an xlsx file needed, and with which sheets?

**Answer:** 


### Q170

**Logs: export rights.** Exporting the Audit Log needs `export` on `audit` (or a System Admin) plus the reader rules; exporting the security log needs a System Admin, or `view_security_log` with `export` on `admin.security_log`. At most 100 000 rows per file.

**Proposed default / question:** Confirm the grants and the cap.

**Answer:** 


### Q171

**Logs: chain order and the integrity check.** Rows are sealed at commit (commit order), not at insert, so a long transaction never holds the chain lock; the admin check runs inside one request and checks every row.

**Proposed default / question:** Confirm, and say whether a scheduled nightly check (raising `audit_integrity_failure`) is wanted beside the admin button.

**Answer:** 


---

## Dashboard owner answers (0046)

### Q175

**Manual central items in a regional or site figure (Q118, migration 0046).** A manual percentage is a project-wide value. It now counts by its weight in every Project Status figure, also a region, a filtered view and one site (so `meta.central_items_hidden` falls to 0 once every central item has a value, as Q118 asks).

**Proposed default / question:** Confirm, or say that a manual value counts only in the project-wide figure (regional and site figures would then leave it out again).

**Answer:** 


### Q176

**Who enters the manual values.** The Project Manager (role codes of the setting `dashboard.manual_items.roles`, default `PM`, on an all-regions assignment), a System Admin, or anyone holding `dashboard.project_status` edit for all regions (a grant or a delegation). No step-up is asked.

**Proposed default / question:** Confirm the holders, and whether a step-up re-authentication is wanted.

**Answer:** 


### Q177

**Planned % and SPI with manual items.** A manual item has no baseline, so under the 0039 rule ("Planned only when every measured item has a plan") Planned and SPI stay "not available" while any manual item is measured.

**Proposed default / question:** Should a manual item carry a planned percentage (for example a target date or a planned value per month), or be left out of Planned only?

**Answer:** 


### Q178

**Back-dated manual values.** An entry may take any effective date up to today; figures computed for a past date use it, saved snapshots do not (they keep the values known when they were taken).

**Proposed default / question:** Confirm, or limit back-dating (for example to the current month).

**Answer:** 


### Q179

**Suspension against an attribution period (Q122).** A working day under a Change Control suspension is left out of the delay even when an attribution period covers it. Periods of the same task may not overlap (422 `period_overlap`), so `overlapping_periods` is always 0.

**Proposed default / question:** Confirm that the suspension wins, and that overlapping periods should be refused rather than shared.

**Answer:** 


### Q180

**The days of a suspension.** From the approval date of the suspension up to the day before the approval date of the next resumption (or the reference date while not resumed); only approved or applied Change Control records count.

**Proposed default / question:** Confirm the dates used (approval dates, not requested or effective dates).

**Answer:** 


### Q181

**A late task without a due date.** A closed SLA clock over its maximum but with no due date keeps the 0039 figure (days over the maximum) under the default party; periods cannot apply because there is no day window.

**Proposed default / question:** Acceptable, or should the window be rebuilt from the SLA start and maximum?

**Answer:** 


### Q182

**Who records attribution periods.** The task's reviewer = a holder of its L2 level (or of the review level of an older 3-level task), a System Admin, or a holder of `dashboard.delay` edit in the task's region. L1 cannot propose a period.

**Proposed default / question:** Confirm, and say whether L1 may propose periods that L2 then confirms.

**Answer:** 


### Q183

**Delay attribution still marked draft.** The health index lost its draft label (Q121); delay attribution keeps `draft: true` because Q122 answered the periods only.

**Proposed default / question:** May the draft label of delay attribution be removed too?

**Answer:** 


### Q184

**Naming the contractor or external party of a period.** For the parties `contractor` and `external` the period may name an external party (optional).

**Proposed default / question:** Should naming it be mandatory for these two parties?

**Answer:** 


### Q185

**Milestones of a view (Q126).** The view filter keeps the milestones whose stage is a whole member of the view: CW = MS2 to MS4, TE = MS5 to MS9. A view made only of single tasks (O&M: TE FAC D18 and Z1) shows the stages of those tasks (MS10). CW FAC (B15) counts in the CW view's SLA and delay but does not add MS10 to the CW pipeline.

**Proposed default / question:** Confirm.

**Answer:** 


### Q186

**Snapshot catch-up and past-date snapshots (Q127).** If the server was stopped on a Sunday or a month end, the daily job takes the missed snapshot within 7 days (setting `dashboard.snapshot_catchup_days`), computed as of that date from dated facts; blocked gates are live only, so such a snapshot records none. A date that is both Sunday and month end is one snapshot with both kinds.

**Proposed default / question:** Confirm the catch-up window, and that the weekly snapshot on Sunday (setting `dashboard.snapshot_weekday`, 0) is wanted rather than Thursday (the last working day of the week).

**Answer:** 


### Q187

**Excel export layout (Q127).** The workbook has one sheet `Dashboard` (section, item, metric, value: the same rows as the CSV) and one sheet `About` (reference date, basis, scope).

**Proposed default / question:** Is one sheet per section, or the layout of the Master's Dashboard sheet (D67), wanted instead?

**Answer:** 


---

## File storage protection (0048)

### Q195

**Storage: virus scan defaults.** The API default is `MALWARE_SCAN=off` (a warning at start-up); the installer turns the scan on when the owner says yes. `SCAN_FAILURE` defaults to `fail_closed` (uploads answer 503 while clamd is down). Zip exports and log exports also pass the scanner, so a clamd outage stops them too.

**Proposed default / question:** Confirm the default for a fresh install (scan on, not asked), `fail_closed` for uploads, and whether generated exports should skip the scan.

**Answer:** 


### Q196

**Backup: database dump and WAL.** The nightly `pg_dump` and the WAL archiving (RPO 15 minutes, CLAUDE.md) are not in the repository. The file backup (restic, `infra/backup`) needs the matching database dump to restore anything.

**Proposed default / question:** Who runs the database dump and WAL archive, where they are kept, and whether they go to the same restic repository or to another one.

**Answer:** 


### Q197

**Storage: second copy.** MinIO bucket replication to the standby server or another building (ADR 0008 item 9) is set up on the server, not by this repository.

**Proposed default / question:** Confirm the owner and the network team own it, and that the restic copy in another building is enough as the one off-site copy until then.

**Answer:** 


### Q198

**Storage: master key custody.** `FILE_ENC_KEY` lives in `pmis.env` and must be kept offline too (without it the stored files are unreadable). Rotation is supported (`FILE_ENC_OLD_KEYS`, `storage-cli.js rewrap`).

**Proposed default / question:** Who holds the offline copy (two people, sealed envelope?), and whether a vault or KMS should hold it later.

**Answer:** 


### Q199

**Storage: streamed decryption and tamper detection.** The file is one AES-256-GCM stream with one tag at the end (the envelope holds the tag). A changed byte is detected when the stream ends, so bytes before it may already have reached the client, and the download then breaks. A chunked format would verify each part but changes the envelope.

**Proposed default / question:** Accept the single-tag design (the bytes are the user's own, already checked by sniffing), or ask for a chunked format before go-live.

**Answer:** 


---

## Stream templates and TPL-MASTER (0051)

### Q205

**Stream templates: which task a Master column writes (migration 0049).** The Master has one column where the PMIS has two tasks, and the spec table (registers-and-streams §2.3) names both: CW MOS Planned/Actual (AY, AZ) are B8 or B9; CW Installation Planned/Actual Start and End (BK:BN) are B10 or B11; the item lists BA:BC and BD:BJ sit on B10 and B11; Report/Layout Submitted and Approved (AR, AS) are B5, B6 or B7. Snags Found/Cleared (BS, BT, EG, EH, FC, FD, FH, FI) are Yes/N/A lists in the spec but the QC snags are records.

**Proposed default / question:** Seeded in `template_task_fields` (data, editable): AY/AZ on B8, BK:BN on B11, the snag lists as plain task values (the QC snags stay the QC module's), AR and AS not mapped (read only), AT/AU/CG/CH/DB/DC mapped to the submitted and approved dates the workflow sets (read only). A task with no Master column (A1 to A5, B1 to B3, B6, B9, B10, C1 to C4, D1, D4b, D12, D17 and so on) has its own Planned Date and Actual Date columns. Confirm the mapping, or say which task each Master column belongs to.

**Answer:** 


### Q206

**A row of a stream template is submitted, so it needs its actual date.** The upload enters each task as L1 and submits it (the task screen's submit needs the actual date and the mandatory documents). A row that only brings a planned date or a value, with no actual date on the task, is refused (`actual_date_required`); a task whose mandatory document slot is empty is refused (`mandatory_slots_missing`, upload the document on the task first).

**Proposed default / question:** Planning dates and values are saved on the task screen (the save does not submit). Confirm, or say that a template may save an entry without submitting it (the row would then have no L2 decision).

**Answer:** 


### Q207

**Who maintains the template field mapping.** `master_columns`, `template_task_fields`, `template_task_rules` (Dismantle E1 to E3 excluded, B14 and D4b calculated) and `template_parts` (the sheet names of TPL-MASTER) are configuration; a change issues the next template version, but only a migration changes them today.

**Proposed default / question:** Add an admin screen (a delegable `templates.edit` action, reason and audit like the other settings) in the next step. Confirm the rule and the owner of the screen.

**Answer:** 


### Q208

**Locked tasks in an upload.** TI-04 says a cell in a locked step is held until the earlier approval exists, and Q81 says a closed gate locks the next stage's tasks. Built: a task locked because a predecessor is not approved is held `pending_previous_approval` (released by the next send once it opens); a task locked by a closed gate is refused (`gate_locked`, the gate may stay closed for weeks). A task that is in review or approval is held (`open_submission`).

**Proposed default / question:** Confirm the difference, or hold gate-locked rows too (a send then keeps them until the gate opens).

**Answer:** 


### Q209

**Starting a pending task from an upload.** The task screen needs "Start" before entry; an upload does it for the uploader: the start date is the row's actual start when typed, else today (the same default as the Start button).

**Proposed default / question:** Confirm, or require the actual start in the row when the task is still pending.

**Answer:** 


### Q210

**What TPL-MASTER does not write.** Identity C:T (RF & Design sheet), baseline U, scope X:AG (changed only through Change Control), the calculated columns, Dismantle FN:FW (the Dismantle sheet) and Issue GA:GE (the Issue Log sheet) are shown grey and ignored with a warning; the register sheets of the file carry what the registers own. The scope flags and the baseline have no batch flow of their own.

**Proposed default / question:** Confirm that the Master sheet never writes scope or baseline, or say how a scope change by file should be approved (Change Control, BP §03).

**Answer:** 


### Q211

**TPL-MASTER and the parallel run.** A file is a PMIS-issued template (hidden `_tpl`); the real Master has none (Q1). Every row keeps its source (`Sheet!row`, file name and hash) and its diff against what the PMIS holds; the comparison report is the list of those diffs per part.

**Proposed default / question:** Confirm that the real Master reaches the PMIS through the one-time import (`tools/master-import`), and that TPL-MASTER is the path for files the PMIS issued. Say whether the comparison report needs its own screen or export.

**Answer:** 


### Q212

**Register-owned fields and write-through.** The Q73 owner update (2026-10-31) lets a work view edit a register-owned field through the register. A template does not: the register-owned columns (B13 BU and D15 EF from As-Built, the vendor CD, the dates of tasks whose date comes from a register such as B1 to B3, C1 to C4 and D1) are grey, and the file says "enter register data in its register".

**Proposed default / question:** Confirm, or say which register-owned fields a stream template may write through to their register (each would be a register batch of its own, with the register's L1 and L2).

**Answer:** 


---

## Two-level conversion and permits per stream (0050)

### Q215

**Conversion of old 3-level items (migration 0050): what happens to the review level's holders.** An open item waiting at the old review level moves to L2 and is asked of the old final approvers only; the reviewer is no longer asked, a pin on a reviewer is cleared, and an all_members L2 gets its own votes in a new round.

**Proposed default / question:** Keep, or should the old reviewer be told that the item moved on (today only the L2 holders get an in-app notice)?

**Answer:** 


### Q216

**Level actors of the dropped path.** For converted open items the `task_level_actors` / `register_level_actors` rows at level 2 and 3 are removed (the acts stay in the step history and in the audit row), so the approval path shows no reviewer who never became L2.

**Proposed default / question:** Keep, or keep the old review acts visible as history on the task screen?

**Answer:** 


### Q217

**Items on one level.** The conversion handles `levels_required = 3` only. A rare open item frozen on a 1-level snapshot (before 0032) is left as it is (one level, self-approval, step-up).

**Proposed default / question:** Convert these to L1/L2 as well (it would add an L2 approver they never had)?

**Answer:** 


### Q218

**Cell level 2 is retired, not deleted.** `matrix_cells.retired_at` is set; the data and holders stay for history and for the audit rows. A workflow draft that copies stage cells copies them retired.

**Proposed default / question:** Delete the retired cells after a retention period, or keep forever?

**Answer:** 


### Q219

**Default L1 of Permits & HSE.** The owner said CW permits are entered by the CW team and TE permits by the TE team but named no roles. Defaults seeded: `permits_hse` L1 = Site Engineers (CW), `permits_hse_te` L1 = Site Engineers (TE); L2 = CW Team Lead / TE Team Lead.

**Proposed default / question:** Confirm the roles (for example the Project Support or the Acquisition team may enter some permits, such as Civil Aviation or City Council).

**Answer:** 


### Q220

**Which stream a permit type belongs to.** `permit_types.stream`: Access - CW and PTW - CW are CW; Access - TE and PTW - TE are TE; every other type (City Council, Civil Aviation, Security Clearance, Other, Access - Survey, Access - QC / Maintenance, Access / PTW - Dismantle) has no stream and is entered on the Permits & HSE row, which covers CW.

**Proposed default / question:** Which stream enters the Dismantle permits and the types with no stream? The stream is data (Settings), so it can change without code.

**Answer:** 


### Q221

**Existing permit records and the new rule.** A permit already in entry keeps its draft; the entry check runs when a version is created or the permit type moves to another stream. A TE draft started by a CW holder before 0050 can still be edited and submitted by its holder.

**Proposed default / question:** Keep, or re-check every open permit draft against the new row?

**Answer:** 


### Q222

**The form does not yet hide permit types the user may not enter.** For Procurement the catalogue returns `entry_scopes`; for permits the refusal comes at save (`not_eligible_holder`, naming the stream).

**Proposed default / question:** Add a list of the permit types the caller may enter to the register catalogue so the type list shows only those?

**Answer:** 


---

## Documents on registers and QC snag photos (0047)

### Q225

**Who edits a site field such as near_airport, and is it approved?** The Site Register has no L1 / L2 path for its own attributes yet (sites come from the Master import). Migration 0047 edits a site custom field directly through `PATCH /sites/{id}` (`sites` edit in the region plus the field-level rule), audited with before and after, without an L2 step.

**Proposed default / question:** Direct edit by `sites` edit holders, audited; the field can be made read-only for chosen roles in the field-level rules. Confirm, or say whether a site field change must go through L1 then L2 like a register record.

**Answer:** 


### Q226

**B1's rule when a site has several Procurement records.** `procurement.delivery` reads the latest version of each Procurement record of the site whose scope is a source scope of B1 (CW, Tower Erection, Site Adaption); a voided record does not count.

**Proposed default / question:** The PR e-mail applies when any of them is Outsourced; otherwise the delivery of the latest one decides; with no record the slot waits as "not required" and Data Entry can still declare it.

**Answer:** 


### Q227

**Register documents on a record that is the source of a task (Q43).** Such a record keeps using its task's slots; when the library also places a document on the register, the record gets its own slot too, and both are checked at Submit.

**Proposed default / question:** Both are kept and checked. Should register placements be skipped for records that feed a task?

**Answer:** 


### Q228

**Register records without a site (Contractors, Risks, Meetings).** The slot table needs a site and a region, so a global record has no document slots.

**Proposed default / question:** No slots on global records. Is a document needed on any global register?

**Answer:** 


### Q229

**A new version of an approved record.** The slots follow the logical record; a new version reopens the approved slots as "uploaded" with their files (Data Entry may replace a file) and they go through L2 again. A voided correction gives them back their approval.

**Proposed default / question:** As built. Should a new version instead start with empty slots?

**Answer:** 


### Q230

**Who raises a QC snag, and who holds L1 / L2 of a snag.** CLAUDE.md says the site engineer uploads the fix and the L2 approves; it does not say who raises the snag. Migration 0047 lets anyone with Quality `create` in the region raise it, and takes L1 / L2 from the Quality register's row of the Responsibility Matrix (B11).

**Proposed default / question:** As built; the Quality row's cells are set by the admin. Confirm, or name a separate Matrix row for QC snags (for example per stream CW / TE).

**Answer:** 


### Q231

**"All members must approve" on the L2 of a snag.** Snags follow the any-one-member rule (with B5 self-approval and the B10 no-holder alert); a Quality L2 cell set to "all members" is treated as any one member for snags.

**Proposed default / question:** Any one member. Is a group vote needed for snags?

**Answer:** 


### Q232

**Photo dated after the upload, and the in-app camera rule.** A photo whose EXIF date is in the future is accepted (only "before the raise" is refused); photos are accepted from any camera until the mobile app exists (CLAUDE.md "Proof tasks (MOS, QC) accept the in-app camera only").

**Proposed default / question:** As built; the one-day tolerance is fixed (`qc_exif_tolerance`, API constant) per the owner answer. Should a future EXIF date be refused, and should the tolerance be a setting?

**Answer:** 


### Q233

**Default snag type.** No snag type was seeded before; migration 0047 seeds `QC_GENERAL` (1 photo, JPG / PNG / HEIC, 20 MB, blocks the PAC / FAC of its stream) so a snag can be raised at once.

**Proposed default / question:** Keep it as seed data, editable in Settings. Send the list of snag types and their photo rules (minimum count, shot types).

**Answer:** 


### Q234

**Quality register record of type "snag" and the QC snag.** The Quality register (0025) has a record type `snag` (data only), while the PAC / FAC block and the photo flow use the QC snags (`snags`). They are separate objects today.

**Proposed default / question:** Separate. Should a Quality "snag" record create (or be) the QC snag?

**Answer:** 

