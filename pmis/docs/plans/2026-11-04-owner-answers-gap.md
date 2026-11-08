# Owner answers of 2026-11-04: gap against what is built

Input: `docs/spec/owner-answers-2026-11-04.md` (108 questions, Arabic answers; not in git yet).
Compared with: `CLAUDE.md`, `docs/spec/open-questions.md`, `docs/spec/owner-answers-2026-10-29.md`, `CHANGELOG.md` entries 60–79, and the migrations and services on `origin/main` at `646ce03` (migrations up to `0051_templates_streams_master`).

**Read this first.** The answers file says in its preface that the answers are *advisory proposals*, written without seeing CLAUDE.md, the blueprint, the Master or the code, and that they "are not a claim that the owner approved every new choice". This plan therefore treats every B item as a change that is **ready to build once the owner confirms the file is binding** (follow-up D0). Nothing below has been built.

Classes:
- **A**: the answer confirms what is built, or the default. No work.
- **B**: the answer differs from what is built. The change is listed with a rough size (S, M or L).
- **C**: the answer needs data the owner has not given yet.
- **D**: the answer is unclear or conflicts with CLAUDE.md, an earlier owner decision or another answer.

Counts: **A 21, B 78, C 4, D 5** (108 in total). 14 of the B items also need owner data (listed in section 3), and 5 B items have a follow-up question on part of the answer (section 4).

---

## 1. Summary table

Where the table says "verified", the behaviour was checked in the migration or service named.

| Q | Class | Answer in one line | What changes |
|---|---|---|---|
| Q1 | B (L) | Two paths: an admin-only legacy Master import, and PMIS-issued templates with `_tpl`. Check the structure, preview the diff, and record the source, hash and result. Never write `_tpl` into the original without a saved copy. | The legacy import is **not built**: `tools/master-import/` holds only `mapping.csv`. Build the admin import path (P3). |
| Q2 | B (M) | D-1 starts at MS4 when RFI applies and at MS1 when RFI is N/A. D-1 is not measured for Hot or Cold Swap. A missing date is a data gap, never today. | `sla_resolve_start`/`sla_task_date` (0017/0018/0042) send an N/A MS4 back to its predecessors, not to MS1, and nothing depends on the scenario (no `hot_swap` logic in any migration, verified). Add the MS1 fallback and the Swap exclusion (P1). |
| Q3 | B (M) | Hot and Cold Swap make RFI N/A by scenario. A conflict with the AA:AD flags blocks scope approval until it is reviewed. The Master formula is shown only in the comparison. | `calc_refresh_site` sets `rfi := cw OR gecol OR hlc` (flags only, verified). Add the scenario rule, a conflict check and a comparison-only Master value (P1). |
| Q4 | C | Enter the official Libyan calendar before the pilot. Do not invent dates. Unannounced holidays stay pending. Until the calendar is complete, a banner says only weekends are excluded. | Built: 2026–2027 is seeded with religious dates marked tentative, and there is a banner while next year is empty. **Needs the approved calendar.** Follow-up D4b: should tentative dates count in SLA? Today they do (`cal_holiday_count` ignores `tentative`). |
| Q5 | A | The STA/ST report sits on B5, MOS proof on B8 and B9, and one upload may cover both. | Built in 0038 (`B4` doc on task B5, `B9` doc on B8 and B9). B4 has no survey document seeded; the owner names none. |
| Q6 | D | Router-only sites need Router 1 and 0 of everything else. "Dispatch complete" compares against the approved need. | This conflicts with the owner's Q65 ("TE Dispatch Complete = date of the latest TE DN"). See D6. |
| Q7 | B (S) | Days that no period covers are "unattributed delay". The R party is shown only as a suggestion and is kept out of the scorecard and penalties. | `dash_sec_delay` (0046) gives those days to the task's external party (`kind = external`) or `default_type`. Move them to `unattributed`, with `suggested_party` (P2). |
| Q8 | B (S) | Use stable PMIS role codes and an editable, reviewed mapping table for the Master values. Imported titles never grant rights. Ambiguous values become import exceptions. | No mapping table exists (verified). Add a `role_aliases` table used by the legacy import (P3). **Needs the owner-approved mapping (C).** |
| Q9 | B (S) | The gate date is the latest of the previous milestone and all applicable conditions. The gate is blocked while a condition is missing or a Stop Work is active. Keep the earlier opening date in history. Update the spec and add an ADR. | `gate_eval` computes this live. `site_gate_state` (0018) keeps only the current state, so no history. Add gate open/close events and an ADR (P1). |
| Q10 | B (S) | Region code with EN/AR labels plus an alias table for import and export. Unknown values need handling. | Codes and labels are built (`regions`, 0013). No alias table: add `region_aliases` (P3). |
| Q11 | B (M) | For GA:GE export the oldest open issue, else the latest closed one, and append "+N more". Add a separate full issues export. The UI shows critical issues first. Ties are broken by record id. | The Master-format export is **not built** (no service in `apps/api/src`). Record the rule in the spec and build it with the export (P3). |
| Q12 | B (M) | The Meetings register has date, title, type, organiser, attendees, linked sites or project, and the minutes attached. Action items are structured (owner, due date, status, closed date, task link). | 0025 holds attendees, sites, minutes and action items as plain `text`, and there is no organiser. Needs new field types (P5). |
| Q13 | B (S) | Keep AR→AR only as a Master-compatible metric tagged "inherited value". Add a separate Layout Submitted Date now, without waiting for the Master to retire. | Add the field on B6/B7, an SLA start for B-6 from it, and a comparison tag (P1). |
| Q14 | B (S) | 45 SLA columns. A reference table maps the SLA sheet columns to tasks. | B10 has one rule `B-10` (owner D5). Add the 45-row `sla_master_columns` table, with B-10a and B-10b both on B10 by flag (P1). |
| Q15 | B (M) | For Hot or Cold Swap on the same site, A1 and A3 are N/A by default. They are enabled by a scenario template or an approved scope exception, never faked as done. | No scenario applicability engine exists: no site creation, and no rule sets tasks to N/A by scenario or flag (verified: `state='na'` is set only by workflow migration and overrides). Build the scenario template (P1). |
| Q16 | D | Equal weights are a trial only, and the factor definitions are "not given". The indices stay experimental. The Final Closure base is HOTO sites and FAC age runs from DLP End. | The six factors are defined in rules.md §9, and the owner removed the draft label in Q121. See D16. |
| Q17 | A | Scanned signed TE PAC now. L2 approval is not an e-signature. E-signature comes later. | As built. |
| Q18 | B (S) | Block duplicate or overlapping assignments of the same user, role, scope and region, but allow different regions or scopes. Approve never implies admin, export or delete. | `AssignmentsService.overlapping` checks user + role only, ignoring regions and modules (verified). Add scope to the check (P8). |
| Q103 | B (L) | A register is not complete until approval feeds calc and gates. Order: Change Control and Quality, then RF & Design and Acquisition, then Readiness and As-Built, then Issues and Risks. Unfed functions show "not available", never 0. | Only Contractors feeds typed tables. `change_requests` is never written from the register (verified), so a Change Control suspension does not move gates. Build the feeds (P4a; Quality in P6). |
| Q104 | B (M) | Calculation-driving lists use stable codes with EN/AR labels and deactivation. Agreed values: TeamSpecialization (8), staff Active/Inactive, execution Done/Pending/N/A. Draft the others for review. Critical lists block approval until configured. | Today `register_fields.options` is free text with no codes. Add a list catalogue (P5). **Values of the other lists: C.** |
| Q105 | B (S) | One central store for now. Pending DN and negative ADJ reserve stock. A Good return goes back to stock and a faulty one is quarantined. Serial adjustment needs serials, a reason and approval, or is disabled. | `wh_stock_levels` (0026) adds every return to on-hand, faulty or damaged included (verified). Add a quarantine bucket (P7). The serial down-adjust is already refused: fine. |
| Q106 | B (M) | Automatic numbering is a service separate from the PDF, preferably on for new movements from the start. Manual unique numbers are accepted in the meantime and locked after posting. | No numbering service exists (verified). Build `doc_sequences` plus a lock on `doc_no` after posting (P7). |
| Q107 | B (S) | CW-01…28 and generated codes are internal provisional codes. Fixed needs only where stated and where the scenario and BOQ apply. An unknown need is "Pending configuration", not 1. | 0026 seeds 1 per need unit as an ASSUMPTION. Add a `status` (`confirmed`/`pending_configuration`) and a code-source flag (P7). **Real needs and codes: C.** |
| Q108 | B (M) | Keep the item catalogue. Quantities are integer or decimal by unit. Link the item types to the Warehouse catalogue. "RF Height stays text as agreed". | Antenna and router type fields are free `list`, patch cords are `text`. Add a warehouse-item lookup (P4a, needs P5). RF Height is `number` in 0027 and no agreement is recorded: D108b. |
| Q109 | A | Severity is required before submit and the Record ID is unique. Closure needs the QC flow. | Built in 0025 (`required`, `duplicate`). The "block" link is Q234. |
| Q110 | B (M) | One External Party per company, with explicit type mapping (unknown → other plus an alert). Teams link by party id, by name only at import. Party status is separate from contract validity, and the contract for the scope and date decides eligibility. | 0025 derives `is_active` from company status and links teams by name. There is one contract per company record. Add a party-to-contract model (P4b). |
| Q111 | B (M) | Free text is transitional only. The target is multi-links, an attached minutes file and structured actions, with an explicit conversion. | As in Q12 (P5; minutes file needs P6 Q228). |
| Q112 | D | Bump the template version when a setting is published, define the accepted versions and convert old templates, and test issue, fill, import and export. | Version bump is built (0037 `tpl_sync_all`, 0051). "Accepted versions / convert old templates" conflicts with CLAUDE.md "old template versions are rejected". See D112. |
| Q113 | B (L) | Split As-Built into a CW part and a TE part with separate approvals. BU is the CW part submission and EF the TE part submission date (not the approval date). | 0027 has one record per site with one state, and BU/EF are typed by hand. This matches the owner's earlier Q68 default but was never built. Split it (P4a). |
| Q114 | B (M) | For outsourced dismantle, FO/FT come from the approved, active Procurement order of scope CW or TE Dismantle, chosen explicitly when there are several. In-house work names the internal team. | Dismantle holds the contractor typed. Procurement is informational. Add an order picker and derivation (P4c). |
| Q115 | B (S) | View preferences stay local; unsaved data stays in memory with a leave guard. Add server-side drafts with a "last saved" indicator and an optional restore. | Records and tasks already save as server drafts. Add the indicator, autosave and restore in the UI (P10). |
| Q116 | C | Variant A only as a provisional choice. Show working previews of A and B (RTL, narrow screens, dark mode) before deciding. | Only variant A is built (`Pipeline.tsx`). **Owner picks after the previews.** Building the B preview is in P2. |
| Q117 | B (M) | System Admin, Team Leads and PM share views through `views.share` (delegable). Shares stay within the creator's scope and never reveal hidden columns. Ownership moves when the creator leaves. | Saved views exist only in the browser (`SavedViews.tsx`, localStorage). Add server-side views and the grant (P10). |
| Q135 | C | Keep 0/1 as an inherited value marked "Pending SLA Confirmation", excluded from scoring until PM and the HLC owner approve values. | **Needs the C-3 target and limit.** Add a `pending_confirmation` flag on the rule (P1, S). |
| Q136 | B (S) | Keep the installation date for the parallel run. Afterwards C-4 ends at `hlc.in_service_date` under a new rule-set version. | `sla_rules_end_ref_chk` allows only two end refs. Add `hlc.in_service_date` to the check and to `sla_task_close` (P1). The switch date is in C. |
| Q137 | A | Started clocks keep their start. A correction is possible with permission, a reason and an audit. | As built (admin override edits dates). |
| Q138 | A | Save a draft before C1/C3 opens. Submit is refused with its reasons. Early works go through an approved exemption. Do not force a CW PR where CW is N/A. | As built (409 at submit, draft kept). An N/A predecessor counts as done. |
| Q139 | B (S) | Do a one-time assisted migration of the legacy HLC requests into Procurement drafts, linked, previewed and de-duplicated, without inventing an approver or a date. | Today they are read-only legacy fields. Add the migration function (P4c). |
| Q140 | A | The six codes were added to the exempt list. Safety conditions still apply. | As built (0043). |
| Q141 | A | No team is required for STA/ST. A named team needs a qualified analysis specialization. | As built (0043: STA/ST has no allowed specialization). The provider contract check comes with Q110. |
| Q142 | B (S) | A team may be a draft with no specialization, but needs at least one before activation or assignment. Old teams go to a completeness report. | The Contractors register lets a team be approved with none. Add the check at submit (P4b). |
| Q143 | B (M) | One code catalogue for team specializations and the match table, with the 8 agreed values. Teams can hold several. CW and TE are groups. Aliases are used, not text compare. | The match compares trimmed text against the CW/TE columns. Add codes, multiple values and groups (P4b, uses P5 lists). |
| Q144 | B (S) | An unknown scope accepts no team. HLC is exempt only when no team is named; a named team needs Fiber, a contract and authority. | `team_scope_match_scopes.exempt` skips HLC even when a team is named. Change it (P4b). |
| Q145 | B (S) | Approved orders stay as they are and drafts are rechecked at submit. Add a report of running orders whose teams no longer match. An expired safety certificate or a Stop Work affects eligibility. | Add the report (P4b). Certificates are "dropped" in CLAUDE.md: D145b. |
| Q146 | B (S) | At approval check the GECOL party, its active contract and the scope. Check a team only when one is named. | GECOL has no check. Add it (P4b, needs the Q110 contracts). |
| Q147 | B (M) | Procurement can read the match table. Eligibility edits need step-up. Build the CW Delivery Model rule: Outsourced needs party, contract and order; In-House needs a qualified internal team. | Add the read-only view, step-up and the rule (P4b). |
| Q148 | B (S) | A draft or survey is allowed without a PR, with a warning. Starting execution or approving in-service needs an approved PR and C3. An emergency exception needs permission. | `no_approved_hlc_pr` is a warning only (0042). Make it blocking when installation or in-service dates are present (P4c). |
| Q149 | A | The HLC approval date is optional at create or submit, and required to close C3. | As built. |
| Q150 | B (M) | Several HLC PRs are allowed. The execution record links the PRs that cover it. C3 closes when every PR required for the approved scope is approved. Never pick the first or the latest blindly. | Built: the first submitted closes C3 (Q93), and the record links the latest approval. Change it (P4c). |
| Q151 | B (S) | Configurable warning order for GECOL (request ≤ survey ≤ layout sub ≤ layout appr …; installation ≤ acceptance ≤ Power-On; billing per contract). C-2 negative stays blocking. | Add warnings to `reg_warnings` for GECOL (P4c). **The order needs GECOL team confirmation (C).** |
| Q155 | A | Display name, phone, language and theme self-editable. Arabic name later with the registry. Position, team and region stay with the admin. | As built (0044). |
| Q156 | D | A phone change needs a fresh step-up and, without number verification, goes through an admin path. | This conflicts with the owner decision of 2026-11-02 (CLAUDE.md: the user edits their own phone). See D156. |
| Q157 | A | Admin-only for M365 accounts for now. Later the tenant id plus object id is the stable link and email follows Entra. | As built (403). |
| Q158 | B (M) | Tell the account holder in-app, email both the old and new address when mail exists, and verify the new address before activation. | No mail service and no verification of the new address. Build after the P9 mail service (P8). |
| Q159 | A | A reset keeps the enforced mark. The enrolment state allows only enrolment. | As built. |
| Q160 | A | Keep enforced on the old rows. Unmarking is a separate act. | As built (0044). |
| Q161 | B (S) | Turning 2FA off (self or admin) also ends the other sessions, with a security notice. | `auth_totp_self_disable` leaves the sessions (verified; recovery codes are already deleted). Add revocation (P8). |
| Q165 | B (S) | Keep PM and the three Team Lead codes for now, but move to a managed "role capability" instead of code lists. Team Lead reading is bounded by assignment validity. | The settings `logs.audit.full_reader_roles` and `team_lead_roles` hold code lists. Add a role capability column (P9). |
| Q166 | A | Rows with no module or region go to full readers only. Unclassified rows never become open. | As built (0045). |
| Q167 | B (M) | In-app only during development. Security email must be finished before production, with retry and failure logging, plus external monitoring. | There is no mail sender in the API (no SMTP or nodemailer, verified). Build the mail service (P9). |
| Q168 | B (S) | Accept 5/15 and 20/15 and >5000 rows as starting points. Rate-limit progressively (NAT). A new IP is low severity, softened for trusted ranges. | Add severity per rule, trusted ranges and progressive limiting (P9). |
| Q169 | B (M) | Yes: a monthly XLSX with Summary, User Activity, Module Activity, Exports, Exceptions and About. The security log stays out. | `GET /reports/activity` is JSON only. Add the xlsx (P9). |
| Q170 | B (S) | Grants and the 100 000 cap are confirmed, with no silent truncation: ask for narrower filters, or split explicitly. | `logs.service.ts` cuts at `EXPORT_MAX_ROWS` without telling the user (verified). Refuse instead (P9). |
| Q171 | B (M) | Commit-time sealing is accepted if atomic. Add a nightly integrity job (`audit_integrity_failure`), run large checks as a job with progress, and store the result with a trusted external reference. | Only the admin button exists. Add the job and an anchor (P9). |
| Q175 | B (S) | A manual central value counts in the project-wide figure only. Regional and site figures show it as a separate "central" line. | 0046 counts it in every figure. Revert to project-wide only and show the line (P2). |
| Q176 | B (S) | Holders are confirmed and there is no step-up for routine updates. Each entry has a value, effective date, reason, **source** and before/after. | `ps_manual_values` has no `source` column (verified). Add it (P2). |
| Q177 | B (M) | Manual items get an approved planned series. Actual and plan use the same item set. Name the index "progress vs plan" unless it is real EVM. A partial index shows its coverage. | Add a plan series per manual item and rename SPI (P2). **Planned values: C.** |
| Q178 | B (S) | Back-dating within the current month is allowed with a reason. Earlier closed periods need a historical-correction grant and review. Future dates are refused. | Today any date up to today is accepted. Add the month limit and a `dashboard.historical_correction` grant (P2). |
| Q179 | A | The suspension wins and overlapping periods are refused. | As built (0046). |
| Q180 | B (S) | Use the effective dates of suspension and resumption, falling back to the approval date. The window is [start, resume). | Gates (0017 `gate_eval`) and delay (0046) use `approval_date`. Use `coalesce(suspension_start, approval_date)` and `coalesce(resumption_date, approval_date)` (P1 helper, P2). |
| Q181 | B (M) | Rebuild the late window from the SLA start, the maximum and the calendar versions. If data is missing, it is a data gap and unattributed. | A task with no due date keeps a lump `days_over` under the default party. Rebuild the window (P2). |
| Q182 | B (M) | L1 may propose a period (party, reason, evidence) with no effect until L2 approves. No self-approval. | Today only L2, an admin or `dashboard.delay` can add, and the period applies at once. Add a proposed→approved state (P2). |
| Q183 | A | Keep the draft label on delay attribution. | As built. |
| Q184 | B (S) | Naming the external party is mandatory to approve a contractor or external period. "Unknown" stays pending. | Today it is optional. Enforce it at approval (P2, with Q182). |
| Q185 | A | CW = MS2–MS4, TE = MS5–MS9, CW FAC outside the CW pipeline. | As built. |
| Q186 | D | A 7-day catch-up, the weekly snapshot at the end of **Thursday**, and month end. Blocked gates show "historically unavailable", not 0. | This conflicts with the owner's Q127 ("every Sunday"; built as `dashboard.snapshot_weekday = 0`). See D186. The "historically unavailable" part is B (S) in P2. |
| Q187 | B (M) | XLSX with Project Overview, CW and TE sheets, detail sheets and About. CSV stays. | 0046 writes one `Dashboard` sheet plus `About`. Change the layout (P2). |
| Q195 | B (S) | Scan on by default in production, `fail_closed`. Generated CSV/XLSX/logs skip the rescan. A ZIP includes only files that are clean. | Log exports use `store.put` and are scanned. Zip uses `putFile` and is not scanned, but does not exclude `pending_rescan` files. Fix both and the installer default (P6). |
| Q196 | B (M) | IT runs PITR (base backup plus continuous WAL), with `pg_dump` as an extra. Encrypted, off-server, off-site. Run a restore test. | No DB backup scripts in `infra/` (only file backup). Add them (P12). **Names and destinations: C.** |
| Q197 | A | IT and the network team own replication. The restic off-site copy is enough for now if it is encrypted, includes DB, files and keys, and is restore-tested. | Default. It depends on P12 putting the DB into the backup. |
| Q198 | C | Security/IT plus an alternate hold the key under a documented custody procedure. A vault is preferred later. | **Needs the custodian names and the vault decision.** |
| Q199 | B (M) | Never send plaintext before the GCM tag is verified. Verify in protected temp space first, or use a chunked authenticated format. | Today the download streams and detects tampering at the end (verified in CHANGELOG 77). Verify before the first byte (P6). |
| Q205 | B (M) | Do not map AY/AZ to B8 and BK:BN to B11 as a general rule. The scenario decides the task. When two tasks apply, use detail fields per task plus a documented projection. An ambiguous mapping blocks the import. | Change the `template_task_fields` mapping to scenario-aware, add the projection, and refuse ambiguous cells (P3). |
| Q206 | B (M) | Templates get two modes, Save Draft/Planning and Submit for Review. | Today every row submits (`actual_date_required`). Add the draft mode (P3). |
| Q207 | B (M) | Add a mapping admin screen (System Admin, delegable `templates.edit`) with reason, version, impact preview and test. | Mapping changes need a migration today. Build the screen (P3). |
| Q208 | B (S) | Hold gate-locked rows as `gate_locked` instead of refusing them. Held rows are never applied automatically; they need a re-send. | 0051 refuses gate-locked rows. Hold them (P3). |
| Q209 | B (S) | Importing a start or completion for a pending task needs an actual start date, never today. | 0051 defaults to today. Require the date (P3). |
| Q210 | A | TPL-MASTER never writes scope, baseline or calculated fields. A Change Control bulk file may come later. | As built. |
| Q211 | B (L) | Legacy path for the real Master, TPL-MASTER for PMIS files. Repeated reconciliation runs in the parallel month, a diff screen, and an XLSX diff export. | Neither the legacy import nor the comparison screen is built. Build them (P3). |
| Q212 | A | One source per field. Write-through only via a register draft with that register's L1 and L2. Grey cells until then. | As built. |
| Q215 | B (S) | On conversion, also notify the old reviewer and the entry person. | 0050 notifies L2 holders only. Send a one-off notice for converted items (P11). |
| Q216 | B (S) | Show the old review acts in task history, labelled "previous path before conversion". | Step history is kept, but there is no label in the UI. Add it (P11). |
| Q217 | B (S) | Convert 1-level open items to L1/L2 after an impact report. With no L2 holder, hold the item with an alert. | 0050 leaves them as they are. Extend `levels_convert_two` (P11). |
| Q218 | A | Keep retired cells as inactive history. No deletion without a policy. | As built. |
| Q219 | A | Keep Site Engineers (CW) → CW TL and Site Engineers (TE) → TE TL. Delegate other types through the matrix. | As built (0050). |
| Q220 | B (M) | The stream follows the activity: Dismantle CW → CW, Dismantle TE → TE, City Council, Civil Aviation and real-estate permits → Acquisition/Design, QC/Maintenance → its stream or O&M, Other needs a stream choice. | `permit_types.stream` allows CW or TE only, and the other types fall on CW. Add streams and per-record choice (P11). Purpose-based types: D220b. |
| Q221 | B (S) | Recheck every open permit draft at save and submit. Move unqualified drafts to a qualified holder, with notice. | 0050 checks only at version creation or type change. Change it (P11). |
| Q222 | B (S) | Yes: the catalogue returns the permit types the caller may enter, and the server rechecks. | Add `entry_permit_types` to the catalogue (P11). |
| Q225 | B (M) | Descriptive site fields are edited directly. Rule-affecting fields (near_airport, scope) go through a change proposal with L2 or Change Control, then re-evaluation. | `PATCH /sites/{id}` edits all custom fields directly. Add a per-field `requires_approval` flag and a flow (P4a). |
| Q226 | B (S) | Use only approved, not-voided Procurement orders (latest approved version). Any Outsourced makes the PR e-mail required. No data means "pending determination", not "not required", and blocks approval. | `doc_procurement_delivery` (0047) reads the latest version, draft included, and shows "not required" (verified). Change it (P6). |
| Q227 | B (M) | One logical document requirement per purpose, satisfied once across the task and register placements. | 0047 checks both slots separately. De-duplicate them (P6). |
| Q228 | B (M) | Global records (Contractors, Meetings, Risks) need attachments, with an optional site or region. No fake site. | The slot table needs a site and a region. Allow global slots (P6). |
| Q229 | B (S) | A new version keeps the document links. L2 reviews the affected documents. Unchanged documents may inherit approval under an explicit policy. | Built: every approved slot reopens. Add the inherit policy setting (P6). |
| Q230 | B (M) | Anyone with Quality create in the region raises a snag. Use separate CW and TE rows when the teams differ. Record the finder, fixer and approver. "Prevent self-approval". | One `quality` row (L2 = both team leads). Add `quality_te` scope rows like the permits, and the actor fields (P6). Self-approval: D230b. |
| Q231 | B (S) | Honour `all_members` on snag L2, or refuse that setting with a message. Never ignore it silently. | Snags treat it as any one member. Change it (P6). |
| Q232 | B (S) | Refuse a future EXIF beyond the 1-day tolerance: keep it as pending evidence, not proof. The tolerance becomes an audited setting. | `EXIF_TOLERANCE_MS` and `qc_exif_tolerance()` are constants, and a future date is accepted. Change it (P6). |
| Q233 | B (S) | Keep QC_GENERAL. Blocking derives from severity and the acceptance rule; a generic type is conservative. Prepare draft CW and TE catalogues for review. | Blocking is a type flag today. Add severity-based blocking (P6). **Type catalogues: C.** |
| Q234 | B (L) | Unify the Quality snag record and the QC snag as one entity (or a managed 1:1 link). Migrate and de-duplicate. | Two separate objects (0025 `snag` record vs 0047 `snags`). Unify them (P6, also the Quality part of Q103). |

---

## 2. Work packages for the B items

**General rules for every package.**
- **Migration numbers are reserved per package** so that packages can run in parallel without clashing. Each migration gets its byte-identical `db/sql/` mirror. Merge in number order. A package that depends on another must not merge first.
- **Shared files.** `db/sql/app_grants.sql`, `contracts/openapi.yaml` (tech-lead), `CHANGELOG.md`, `apps/web/src/mocks/realApi.ts` and its exact-list test are touched by most packages. Each package adds only its own block. Contract changes go to tech-lead as one request per package, numbered by minor version in merge order.
- **Tests.** Each package adds an API suite under `apps/api/test/`, DB security cases under `tests/db-security/cases/` (next numbers 100+), and web tests where there is UI.

| Order | Package | Migration | Q |
|---|---|---|---|
| 1 | P1 SLA, calendar, gates and scenario applicability | 0052 | Q2, Q3, Q9, Q13, Q14, Q15, Q136, Q180 (gate side), and the Q135 pending flag |
| 2 | P9 Logs, monitoring and mail service | 0053 | Q165, Q167, Q168, Q169, Q170, Q171 |
| 3 | P6 Documents, QC snags and storage | 0054 | Q195, Q199, Q226, Q227, Q228, Q229, Q230, Q231, Q232, Q233, Q234, and Q103 (Quality) |
| 4 | P5 Register framework: lists, field types, Meetings | 0055 | Q12, Q104, Q111 |
| 5 | P4b Contractors, contracts and team–scope match | 0056 | Q110, Q142, Q143, Q144, Q145, Q146, Q147 |
| 6 | P4c Procurement, HLC, GECOL and Dismantle | 0057 | Q114, Q139, Q148, Q150, Q151 |
| 7 | P4a Change Control and register feeds into calculation | 0058 | Q103 (except Quality), Q108, Q113, Q225 |
| 8 | P2 Dashboard, Project Status and delay attribution | 0059 | Q7, Q175, Q176, Q177, Q178, Q180 (delay side), Q181, Q182, Q184, Q186 (B part), Q187, and the Q116 preview |
| 9 | P3 Master import, stream templates and parallel run | 0060 | Q1, Q8, Q10, Q11, Q205, Q206, Q207, Q208, Q209, Q211 |
| 10 | P7 Warehouse | 0061 | Q105, Q106, Q107 |
| 11 | P8 Identity and profile | 0062 | Q18, Q158, Q161 |
| 12 | P11 Approval levels conversion and permits per stream | 0063 | Q215, Q216, Q217, Q220, Q221, Q222 |
| 13 | P10 Web UX: shared saved views and drafts | 0064 | Q115, Q117 |
| 14 | P12 Database backup (infra only) | none | Q196 |

### P1: SLA, calendar, gates and scenario applicability (migration 0052)
- **Q:** Q2, Q3, Q9, Q13, Q14, Q15, Q136, Q180 (gate side), plus the Q135 `pending_confirmation` flag (S).
- **Files and functions:**
  - Migration `0052_scenario_sla_gates` (mirror `db/sql/051_scenario_sla_gates.sql`).
  - New table `scenario_task_rules` (workflow_id, task_code, scenario, rule: `applies` / `na` / `flag_expr`, reason, version), seeded from `docs/spec/task-catalogue.csv` `scenario_applicability`: A1/A3 N/A for Hot/Cold Swap (Q15), RFI N/A for Hot/Cold Swap (Q3), D-1 not measured for Swap (Q2).
  - New function `wf_apply_applicability(site)`: sets tasks N/A or applicable from scenario plus flags, never on approved tasks, audited. It is called on site creation (P3 import) and on an approved scope change (P4a).
  - `scope_scenario_conflicts(site)`: Swap with any of AA:AD = Yes → a conflict that blocks scope approval (Q3).
  - `calc_refresh_site`: `rfi` honours the scenario rule. It keeps a `master_rfi` value only for the comparison.
  - `sla_resolve_start`: D1 uses `MS4`, or `MS1` when MS4 is N/A, and has no clock under a Swap rule.
  - `sla_rules_end_ref_chk` and `sla_task_close` accept `hlc.in_service_date` (Q136). The switch itself is a new rule set published after the parallel run (C).
  - Q14: table `sla_master_columns` (45 rows: Master SLA column → task code + optional flag condition; B-10a/B-10b → B10 by AA/AB).
  - Q13: field `layout_submitted_date` on B6. A second B-6 rule start `B6.layout_submitted` (version 2 of the SLA set). The comparison tags the old AR→AR metric `inherited`.
  - Q9: table `site_gate_events` (site, gate, opened/closed, date, cause), written by `calc_gate_watch`. ADR `docs/adr/0015-gate-date-conditions.md`, plus rules.md §2.2 updated by the domain analyst.
  - Q180: helper `cc_suspension_windows(site, ref)` using `coalesce(suspension_start, approval_date)` and `coalesce(resumption_date, approval_date)`. `gate_eval` uses it.
  - Q135: `sla_rules.pending_confirmation boolean`. Rules flagged this way are excluded from the scorecard and penalties (read by P2).
- **Tests:** `apps/api/test/scenario-applicability.test.ts` (Swap A1/A3/RFI N/A, flag conflict refused, D-1 MS1 fallback, Swap no D-1 clock, C-4 in-service end under a v2 set, gate events, suspension effective dates); additions to `calc-gates.test.ts`; `tests/db-security/cases/100_scenario_sla.sql`.
- **Depends on:** none. P2, P3 and P4a depend on it.

### P2: Dashboard, Project Status and delay attribution (migration 0059)
- **Q:** Q7, Q175, Q176, Q177, Q178, Q180 (delay side), Q181, Q182, Q184, the B part of Q186, Q187, and the Q116 variant-B preview.
- **Files and functions:**
  - `dash_sec_delay` (0046): uncovered days become `kind = unattributed` with `suggested_party` (Q7); window from `cc_suspension_windows` (Q180); window rebuilt from `sla_start_date` + max + calendar when `due_date` is NULL (Q181); exclude `pending_confirmation` rules from the scorecard figures.
  - `task_delay_periods`: add `status` (proposed/approved/voided), `proposed_by`, `approved_by`, `evidence`. Add the functions `delay_period_propose` (L1) and `delay_period_decide` (L2, no self-approval) (Q182). The external party is required at approval for `contractor`/`external` (Q184).
  - Project Status (`dash_project_status`, 0046): manual items count only when `p_project_wide`. Add a `central_line` block for region and site views (Q175).
  - `ps_manual_values.source text NOT NULL` (Q176); a month limit plus a `dashboard.historical_correction` grant for earlier dates (Q178); table `ps_manual_plans` (item, date, planned_pct) and rename SPI in the UI and contract to "progress vs plan index" (Q177).
  - Snapshot catch-up stores blocked gates as `historically_unavailable` (Q186 B part; the weekday is D186).
  - `DashboardService.export`: sheets Project Overview, CW, TE, details, About (Q187).
  - Web: `Dashboard.tsx`, `ManualItems.tsx`, `components/DelayPeriods.tsx`, and `Pipeline.tsx` variant B behind a preview toggle (Q116).
- **Tests:** extend `dashboard-owner-answers.test.ts` (hand-computed figures) and `dashboard-perf.test.ts`; `tests/db-security/cases/101_dashboard_gap.sql`; `dashboardOwnerAnswers.test.tsx`.
- **Depends on:** P1 (`cc_suspension_windows`, `pending_confirmation`). Q186's weekday waits for D186.

### P3: Master import, stream templates and parallel run (migration 0060)
- **Q:** Q1, Q8, Q10, Q11, Q205, Q206, Q207, Q208, Q209, Q211.
- **Files and functions:**
  - New module `apps/api/src/master-import/` (or `tools/master-import/` CLI plus API) for the admin-only legacy path. It recognises the file by sheet names and headers, stores the source file with its hash, shows a structure check and a diff preview, writes nothing before the admin confirms, logs every use in the System Log, and calls `wf_apply_applicability` (P1) on site creation (Q1, Q211).
  - Tables `role_aliases` (Q8) and `region_aliases` (Q10). Unknown values become import exceptions.
  - Table `master_reconciliation_runs` / `_diffs`; a comparison screen `apps/web/src/pages/Reconciliation.tsx` with XLSX export (Q211).
  - `template_task_fields` gains a `scenario`/`flag` condition and a `projection` (earliest start / latest end). An ambiguous cell refuses the row (Q205).
  - `imp_*` functions in 0051: a batch `mode` of `draft`/`submit` (Q206); gate-locked rows held as `gate_locked` (Q208); a pending task needs `actual_start` (Q209).
  - Admin screen and functions `admin_save_template_mapping` (`templates.edit`, reason, version bump, impact preview) (Q207).
  - The Q11 rule recorded in `docs/spec/registers-and-streams.md`, implemented when the Master-format export is built (the export service is a separate large item, not in this plan).
- **Tests:** `templates-master.test.ts`, `templates-streams.test.ts` extended; new `master-import.test.ts` (with a synthetic Master); `tests/db-security/cases/102_master_import.sql`; `templatesStreams.test.tsx`.
- **Depends on:** P1 (applicability, `layout_submitted_date`, `sla_master_columns`). The Q112 version policy waits for D112. The Q8 mapping data is in C.

### P4a: Change Control and register feeds into calculation (migration 0058)
- **Q:** Q103 (except Quality), Q108, Q113, Q225.
- **Files and functions:**
  - Approval triggers on `register_records`: Change Control → `change_requests` (suspension, resumption, scope change, which also calls P1 `wf_apply_applicability` and `scope_scenario_conflicts`); RF & Design → site identity and `SiteIDs`; Acquisition → A3 / Master T; Readiness → G6, MS9, Z1; As-Built → BU/EF; Issues and Risks → the health index inputs.
  - Idempotent, with void and withdraw handling. Unfed readers return `not_available`, not 0.
  - Q113: As-Built gets record types `cw_part` and `te_part`, each with its own approval. BU = the CW part submission, EF = the TE part submission date. Data is migrated.
  - Q108: item-type fields become `warehouse_item` lookups (needs the P5 field type).
  - Q225: `field_definitions.requires_approval`. `PATCH /sites/{id}` refuses those fields and creates a site-change proposal (L1→L2 on the Site Register row, or Change Control for scope).
  - Files: the new migration, `registers.service.ts`, `sites.service.ts`, `SiteFields.tsx`, `AsBuiltItems.tsx`.
- **Tests:** `register-feeds.test.ts` (Change Control suspension moves a gate, void undoes it, Readiness closes G6, As-Built parts), `write-through.test.ts` updated; `tests/db-security/cases/103_register_feeds.sql`.
- **Depends on:** P1, P5. The Quality feed is in P6.

### P4b: Contractors, contracts and team–scope match (migration 0056)
- **Q:** Q110, Q142, Q143, Q144, Q145, Q146, Q147.
- **Files and functions:**
  - Table `external_party_contracts` (party, ref, scope, start, end, status). Party status is separate from contracts. Teams link by party id; a duplicate name is never linked automatically (Q110).
  - A team needs a specialization at submit (Q142).
  - Specialization codes from the P5 list catalogue, multiple per team, CW/TE groups in `team_scope_match_meta` (Q143).
  - HLC exempt only without a team (Q144).
  - Report `GET /reports/team-scope-mismatch` (Q145).
  - GECOL approval checks party, contract and scope (Q146).
  - Procurement gets a read-only view of the match table; step-up on `admin_save_team_scope_match`; the CW Delivery Model rule in `team_scope_problem` (Q147).
  - Files: the 0043 functions (`team_scope_problem`, `admin_save_team_scope_match`), `settings/team-scope-match.*`, `TeamScopeMatch.tsx`, the Contractors fields.
- **Tests:** `gates-scope-match.test.ts` extended, `contracts-parties.test.ts`, `tests/db-security/cases/104_contracts.sql`, `teamScopeMatch.test.tsx`.
- **Depends on:** P5 (list catalogue). Q145 certificates: D145b.

### P4c: Procurement, HLC, GECOL and Dismantle (migration 0057)
- **Q:** Q114, Q139, Q148, Q150, Q151.
- **Files and functions:**
  - Dismantle `cw`/`te` records get `procurement_record_id` (explicit choice when there are several active orders); FO/FT are derived from it; in-house work names an internal team (Q114).
  - One-time `hlc_legacy_to_drafts(p_dry_run)` (Q139).
  - `no_approved_hlc_pr` becomes blocking when installation or in-service dates are present, with an override exception (Q148).
  - HLC record ↔ PR link table (many), and C3 closes when all PRs required for the approved scope are approved (Q150).
  - GECOL order warnings configurable in a setting `gecol.order_warnings` (Q151).
  - Files: the 0042 functions (`reg_warnings`, the task-source triggers), `Register.tsx`, `hlcProcurement.test.tsx`.
- **Tests:** `hlc-procurement.test.ts`, `dismantle.test.ts` extended; `tests/db-security/cases/105_procurement_gap.sql`.
- **Depends on:** P4b for the GECOL contract check. The Q151 order is in C.

### P5: Register framework: lists, field types, Meetings (migration 0055)
- **Q:** Q12, Q104, Q111.
- **Files and functions:**
  - `register_fields.field_type` adds `multi_user`, `multi_site`, `file`, `child_list`, `warehouse_item`, `list_code`. `reg_clean_data`, `reg_validate` and `custom_check_value` are updated.
  - Tables `list_catalogues` / `list_values` (code, EN/AR, active, aliases, `critical` flag), with the existing values migrated.
  - Seeds: TeamSpecialization (8 values), staff Active/Inactive, execution Done/Pending/N/A.
  - A critical list without configured values blocks approval.
  - Meetings: organiser, attendees (`multi_user`), sites (`multi_site`), minutes (`file`, via the P6 global slots), action items (`child_list`: owner, due, status, closed date, task link), plus an explicit conversion of old text.
  - Templates (`tpl_sync_all`) are updated to emit and read the new types.
- **Tests:** `registers-catalog.test.ts` extended, `field-types.test.ts`, `templates-import.test.ts` (the new types round-trip), `tests/db-security/cases/106_field_types.sql`.
- **Depends on:** P6 (Q228) for the minutes file. P4a and P4b depend on it. The values of the other lists are in C.

### P6: Documents, QC snags and storage (migration 0054)
- **Q:** Q195, Q199, Q226, Q227, Q228, Q229, Q230, Q231, Q232, Q233, Q234, plus the Quality feed of Q103.
- **Files and functions:**
  - Storage: `storage.service.ts` adds a `putGenerated` path that is not scanned, used by log exports; the zip build skips files whose `scan_status <> 'clean'` (Q195); the installer defaults the scan on for production (`tools/install`).
  - `ProtectedStorage.get` decrypts into a protected temp file and verifies the tag before the response starts, or a chunked envelope v2 with a migration plan (Q199).
  - `doc_procurement_delivery` uses the latest approved, not-voided version and returns `pending` when there is no data; `pending` blocks approval (Q226).
  - Slot de-duplication by document type across task and register placements (Q227).
  - Slots on global records with an optional site and region, plus RLS from the record (Q228).
  - Setting `documents.new_version_inherit` (Q229).
  - `quality_te` scope row (pattern of `permits_hse_te`); `snags.found_by` / `fixed_by` / `approved_by` (Q230).
  - Honour `all_members` in `qc_transition_snag`, or refuse it in `matrix` saves for the Quality rows (Q231).
  - Setting `qc.exif_tolerance_hours`; a future EXIF beyond the tolerance → photo `pending_evidence` (Q232).
  - Blocking from `snags.severity` plus a type rule (Q233).
  - Unify Quality `snag` records and `snags` (one entity or a 1:1 managed link), and migrate (Q234).
  - Files: the 0047 functions (`qc_*`, `doc_*`), `qc/snags.service.ts`, `documents/*`, `SiteSnags.tsx`, `DocSlots.tsx`.
- **Tests:** `documents-registers-snags.test.ts`, `storage-protection.test.ts`, `documents-zip.test.ts` extended; `tests/db-security/cases/107_docs_snags_gap.sql`; `docsRegistersSnags.test.tsx`.
- **Depends on:** none. P5 depends on it for Q228. The self-approval part of Q230 is D230b. The snag type catalogues are in C.

### P7: Warehouse (migration 0061)
- **Q:** Q105, Q106, Q107.
- **Files and functions:**
  - `wh_stock_levels` and `wh_movement_lines.condition`: Faulty and Damaged returns go to `quarantine`, not `available` (Q105).
  - Tables `doc_sequences` (pattern per kind, region, year; the Q32 seed) and `doc_no` locked after posting; the forms module reuses them later (Q106).
  - `warehouse_item_need_rules.status` (`confirmed`/`pending_configuration`) and `warehouse_items.code_source` (`master`/`internal_provisional`). A pending need never counts toward "complete" (Q107).
  - Files: the 0026/0028 functions, `warehouse/*`, `Warehouse.tsx`.
- **Tests:** `warehouse.test.ts` extended; `tests/db-security/cases/108_warehouse_gap.sql`.
- **Depends on:** none. Q6 waits for D6. The real needs and codes are in C.

### P8: Identity and profile (migration 0062)
- **Q:** Q18, Q158, Q161.
- **Files and functions:**
  - `AssignmentsService.overlapping` and the bulk paths compare user + role + regions + modules overlap (Q18).
  - Email change: a verification link to the new address, notices to old and new, using the P9 mail service (Q158).
  - `auth_totp_self_disable` and `idm_set_two_factor` (off) revoke the other sessions and raise a security notice (Q161).
  - Files: `assignments.service.ts`, the 0044 functions, `me/*`, `Profile.tsx`.
- **Tests:** `assignments.test.ts`, `self-profile.test.ts`, `two-factor.test.ts` extended; `tests/db-security/cases/109_identity_gap.sql`.
- **Depends on:** P9 (mail). The phone part of Q156 waits for D156.

### P9: Logs, monitoring and mail service (migration 0053)
- **Q:** Q165, Q167, Q168, Q169, Q170, Q171.
- **Files and functions:**
  - New `apps/api/src/mail/` (SMTP to the internal relay, BullMQ queue, retry, a delivery-failure log, test mode). It is wired to the notification policy channel `email` and to security alerts (Q167).
  - `roles.capabilities text[]` (`audit_full_reader`, `team_lead`). `logs.audit.*` read them, and the settings remain only as a fallback (Q165).
  - The 0045 alert rules get `severity`, `logs.trusted_networks` and a progressive limiter (Q168).
  - `GET /reports/activity?format=xlsx` with the six sheets (Q169).
  - Exports above `EXPORT_MAX_ROWS` answer 422 `too_many_rows` with the count (Q170).
  - A nightly job `audit_integrity_check` with a progress row in `job_runs`; results stored; the chain head exported to an external anchor file (Q171).
  - Files: `logs/*`, `jobs/jobs.service.ts`, `notifications/*`, the 0045 functions.
- **Tests:** `logs-core.test.ts` extended, `mail.test.ts` (fake SMTP), `jobs-schedule.test.ts`; `tests/db-security/cases/110_logs_gap.sql`.
- **Depends on:** none. P8 depends on it.

### P10: Web UX: shared saved views and drafts (migration 0064)
- **Q:** Q115, Q117.
- **Files and functions:**
  - Table `saved_views` (owner, screen, filter, columns, shared_with, scope) and the grant `views.share`, seeded for System Admin, Team Leads and PM. Hidden columns are stripped server-side; ownership moves when the creator is deactivated (Q117).
  - `SavedViews.tsx` and `TableKit.tsx` move to the API.
  - A "last saved" indicator, autosave of drafts, and an optional restore on `FormDialog.tsx`, `RegisterDrawer.tsx` and `TaskDrawer.tsx` (Q115).
- **Tests:** `views.test.ts` (API), `tables.test.tsx`; `tests/db-security/cases/111_saved_views.sql`.
- **Depends on:** none.

### P11: Approval levels conversion and permits per stream (migration 0063)
- **Q:** Q215, Q216, Q217, Q220, Q221, Q222.
- **Files and functions:**
  - `levels_convert_two` sends a one-off notice to the old reviewer and to the entry person of each item already converted (Q215).
  - The task and record history label `previous_path` (Q216, `TaskDrawer.tsx`, `RegisterDrawer.tsx`).
  - Convert `levels_required = 1` open items after a dry-run report, holding them when there is no L2 (Q217).
  - `permit_types.stream` adds `acquisition` and `om` (new Matrix rows `permits_hse_acq` and `permits_hse_om`); a per-record stream for types that depend on the activity (Dismantle CW/TE); Other requires a stream (Q220).
  - `b_reg_scope_entry` rechecks at every save and submit, and a transfer flow moves the draft (Q221).
  - The register catalogue returns `entry_permit_types` (Q222).
  - Files: the 0050 functions, `matrix/*`, `registers.service.ts`, `permitsStream.test.tsx`.
- **Tests:** `levels-permits.test.ts` extended; `tests/db-security/cases/112_levels_permits_gap.sql`.
- **Depends on:** none. The purpose-based stream types wait for D220b.

### P12: Database backup (infra only, no migration)
- **Q:** Q196.
- **Files:** `infra/backup/db-basebackup.sh`, `db-wal-archive.sh` (WAL archive every 15 min), `db-dump.sh` (nightly logical copy), restore scripts, `infra/RUNBOOK.md` and `infra/restore-drill.md` updated. Encrypted, going to a destination separate from the files repository (or the same restic system with separate keys).
- **Tests:** a restore-drill script that runs on a throw-away container (PITR to a timestamp).
- **Depends on:** the names and destinations in C. Q197 then closes.

---

## 3. C list: data the owner must provide

1. **Q4 Holiday calendar.** The official Libyan public holidays for 2026 and 2027 (date, EN/AR name, national or religious) from an approved source; confirmation or correction of the 18 tentative religious dates in `db/seed/holidays-2026-2027.csv`; and the person who confirms them each year.
2. **Q8 Role mapping.** An approved mapping of the 15 Master `StaffRole` values to GSDN Workspace roles, including which values are ambiguous (for example the generic "Site Engineer") and must become import exceptions.
3. **Q104 List values.** Codes, EN labels, AR labels, and the critical (approval-blocking) mark for CompanyType, CoStatus, TeamType, TeamStatus, Severity, QIResult, Activity, IssueStatus, RiskCat, ScopeCWTE, RiskResponse, RiskStatus, Trend, EHSCheck, ReviewStatus, SiteType, TowerOwner, TowerType, Ownership, TestPit, WLVendor and the As-Built vendor and type lists. Also the Arabic labels of the new fields.
4. **Q107 Warehouse.** Confirmed need quantity per need unit for every TE item other than LPU Kit / Router / Cabinet / Battery (Cambium and Intracom sectors, MW half-link items, accessories). The manufacturer codes for the 10 TE items that have none (`SFP-SM-10G-10KM`, `ERKA-2X2-5`, `ERKA-4X0-75`, `FIBER-OUTDOOR`, `TELECOM-BRACKET`, `FIBER-CLAMP-4L8R`, and so on). Confirmation that CW-01…CW-28 may stay as internal codes.
5. **Q116 Pipeline.** The choice between variant A (rings) and variant B (flat segmented track), after the working previews from P2.
6. **Q135 C-3 SLA.** The target (min) and limit (max) in working days for PR issue → HLC approval, approved by the PM and the HLC owner, and the effective date.
7. **Q136 C-4 switch.** The date C-4 changes to end at the in-service date (normally the end of the parallel run), and the C-4 SLA min/max for the new definition.
8. **Q151 GECOL order.** Confirmation by the GECOL team of the step order to warn on, and the contract event that triggers billing.
9. **Q177 Plans for manual items.** For each central Project Status item (1.3, 1.5, 3.2–3.9, 6.1, 6.6, 7.7, 8.1): a target date, or a planned percentage per month.
10. **Q196 Database backup.** The names of the IT database/operations owner and an alternate; the backup destination (separate server or path, off-site location); confirmation of retention (14/8/12) and RTO; the date of the first full restore test.
11. **Q198 Key custody.** The names of the custodian and alternate for `FILE_ENC_KEY` and `TOTP_ENC_KEY`; the custody medium (for example a sealed envelope, two-person rule); and whether a vault or KMS is wanted for production, and which one.
12. **Q233 Snag types.** The CW and TE snag type catalogues (for example civil, earthing, cabling, power, labelling), each with minimum photo count, required shot types, and which severities block PAC/FAC.

---

## 4. D list: follow-up questions

**D0. Status of the file.** The preface says these are advisory proposals written without the code. Are they binding owner decisions?
- (a) Yes, all of them: build them.
- (b) Yes, except the items in D4b–D230b below.
- (c) No: each package needs a separate sign-off.

**D4b (follow-up to Q4). Tentative holidays in the SLA.** Today the tentative religious dates already reduce working days. The answer says unannounced holidays "stay pending review".
- (a) Count them now, as built, and correct on confirmation.
- (b) Do not count them until they are confirmed.
- (c) Count them, but show a "tentative" badge on the affected due dates.

**D6 (Q6 vs Q65). TE Dispatch Complete.** Q65 (owner, 2026-10-29) says "TE Dispatch Complete = the date of the latest TE DN". The Q6 answer says "dispatch completion compares with the approved need of the site".
- (a) Keep Q65: the date of the latest TE DN; the need rules only feed the warehouse KPIs.
- (b) Replace Q65: complete when the approved need is met, with the latest DN date as the date.
- (c) Both: the Q65 date for the Master comparison, and the need-based status in GSDN Workspace.

**D16 (Q16 vs Q121). Health index status.** The six factors are defined in rules.md §9, and Q121 approved D and I and removed the draft label (built, 0046). The Q16 answer says the definitions are "not given" and the indices stay experimental.
- (a) Keep Q121: no draft label; review rules.md §9 if any factor is wrong.
- (b) Put the draft label back until every factor is reviewed.
- (c) Draft label on the factors not yet approved only (all except D and I).

**D108b (Q108). RF Height type.** The answer says "RF Height stays text as agreed", but no such agreement is recorded and 0027 built it as a number in metres.
- (a) Keep it a number (m).
- (b) Make it text, for values like "30/45".
- (c) A number plus an optional note.

**D112 (Q112 vs CLAUDE.md). Old template versions.** CLAUDE.md says "old template versions are rejected on upload with a clear message" (built). The answer asks to "define accepted versions and convert old templates".
- (a) Keep the rejection.
- (b) Accept the previous version for a grace period (N days) and convert it.
- (c) Accept a version when only its non-input columns changed, otherwise reject.

**D145b (Q145 vs CLAUDE.md). Safety certificates.** CLAUDE.md says "Team capacity and certificates are dropped". The answer says an expired safety certificate affects work eligibility.
- (a) Keep them dropped: only Stop Work affects eligibility.
- (b) Add a certificate expiry field to teams, as information only.
- (c) Add certificates, and make an expired one block new assignments.

**D156 (Q156 vs CLAUDE.md My profile, owner decision 2026-11-02). Phone change.** CLAUDE.md says the user edits their own phone; it is built that way, audited, with no step-up. The answer says a sign-in phone change needs a fresh step-up and, while there is no number verification, goes through an admin path.
- (a) Keep self-edit and add a password step-up.
- (b) Make the phone change a request approved by an admin (like the email).
- (c) Self-edit for a contact phone, admin-only for the sign-in phone (two fields).

**D186 (Q186 vs Q127). Weekly snapshot day.** Q127 (owner, 2026-11-02) says "every Sunday" (built: `dashboard.snapshot_weekday = 0`). The Q186 answer says "end of Thursday".
- (a) Sunday, as Q127.
- (b) Thursday (the last working day): only the setting value changes, no code.
- (c) Both.

**D220b (Q220). Permits whose stream depends on purpose.** The answer puts Access - Survey "to RF/Design or CW by purpose" and Access - QC / Maintenance "to the relevant stream or O&M".
- (a) The person entering the permit chooses the stream on each permit (required for these types).
- (b) Fixed defaults: Survey → RF/Design, QC/Maintenance → O&M.
- (c) Split each into separate types (for example Access - Survey (RF) and Access - Survey (CW)).

**D230b (Q230 vs CLAUDE.md B5). Self-approval of snags.** B5 allows self-approval with step-up and a flag for every task and record (built for snags in 0047). The answer says "prevent self-approval" for snags.
- (a) Keep B5 for snags.
- (b) Forbid self-approval for snags only: the same person may not be both finder or fixer and approver.
- (c) Allow it only for a System Admin, with step-up.

---

## Owner decisions on the D list (2026-11-04)

| Item | Decision |
|---|---|
| D0 | **All answers are binding owner decisions.** Build them. |
| D4b | Tentative holidays **count** as holidays now, with a **"tentative date" badge** on the affected due dates; corrected when confirmed. |
| D6 | **Both:** the date of the latest TE DN for the Master comparison (Q65), and a need-based complete / short status inside GSDN Workspace. |
| D16 | **Draft label only on the factors not yet approved** (all except D and I). |
| D108b | RF Height is a **number in metres plus an optional note** (for values like "30/45"). |
| D112 | An older template version is **accepted when only non-input columns changed**; rejected when any input column changed. |
| D145b | Team safety certificate **expiry date as information**, with an alert on expiry; it does not block assignments. |
| D156 | A phone change is a **request approved by an admin** (like the email), because the phone is a sign-in identifier. |
| D186 | The weekly snapshot is taken on **Thursday** (the last working day): setting `dashboard.snapshot_weekday`. |
| D220b | For permit types whose stream depends on purpose, **the person entering the permit chooses the stream** (required for those types). |
| D230b | **Self-approval is forbidden for QC snags only:** whoever raised or fixed a snag may not approve its closure. B5 stays for everything else. |
