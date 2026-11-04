# Technical decisions on the open questions of the owner-answer packages (2026-11-04)

**Status: decided.** On 2026-11-04 the product owner asked the technical lead to answer the open questions of work packages P1 to P12 "as you see fit" ("جاوب على الأسئلة لما تراه مناسب لأنك أنت الخبير"). This file records those decisions. They are binding, as the owner's own answers are, until the owner changes one; a change is a new row in this file and, where it touches built behaviour, a migration.

Rules followed:
- Where the build already does the safe and sensible thing, it is **confirmed as built** (no change).
- Where a decision changes behaviour, it is marked **Change**. The change is listed under "Follow-up work" with the package that owns it.
- Where the answer is a fact only the owner's organisation has (names, quantities, codes, network ranges, the content of lists), it is marked **Owner data**. The default stays in force, and the item stays open in the owner-data list at the end.
- Security and audit win ties. A rule that could hide a mistake or bypass an approval is never chosen.

The questions are in [`open-questions.md`](open-questions.md). This file gives only the decision.

## P12: database backup (Q370 to Q374)

| # | Decision |
|---|---|
| Q370 | Confirmed as built. The weekly (8) and monthly (12) copies run only when their repository is configured. **Owner data:** the destinations of repositories 3 and 4. Alerts go to the System Log, which mails the System Admins once P9 mail is configured. |
| Q371 | Keep `archive_timeout` at 5 minutes. It is stricter than the 15-minute RPO; the storage cost is small. |
| Q372 | **Owner data:** names, alternate, repository 2 destination, key custody medium. They stay placeholders in RUNBOOK 8.8 until given. |
| Q373 | Keep the restic dump in its own repository with its own key. Two independent copies with two keys are the point of the second copy. |
| Q374 | Keep: a restore always goes to a scratch cluster. A cutover over the live database is a planned change approved by the Project Manager, using the RUNBOOK steps, never a script default. |

## P1: SLA, calendar, gates, scenario (Q240 to Q248)

| # | Decision |
|---|---|
| Q240 | Confirmed as built: a System Admin or a delegate of `task_definitions` edit applies the scope. A Project Manager who needs it gets a delegation. |
| Q241 | Keep the seeded catalogue rules (editable in Settings). B5, D8 and A5 get no rule until the scenario data says they should. |
| Q242 | A System Admin scope exception (step-up, reason, audited) is enough. Naming an approved Change Control record stays optional. |
| Q243 | Confirmed as built. Approved tasks and tasks in review or approval are never touched; they are listed as `kept`. |
| Q244 | Publish the B-6 rule with the Layout Submitted Date at the end of the parallel run, together with C-4. B-7 keeps its current start. |
| Q245 | A System Admin confirms the official calendar each year. **Change:** `calendar.official_confirmed` resets itself on 1 January, so the "calendar not confirmed" banner returns until the new year's dates are confirmed. |
| Q246 | Acceptable. No rebuild from the audit log; the gate history starts at 0052. |
| Q247 | Decided by migration 0064: a suspension pairs with the resumption that names it (`paired_change_id`), else with the first approved resumption on or after its start. |
| Q248 | Confirmed: a pending rule still colours the task; only the scorecard and the penalties leave it out. |

## P7: Warehouse (Q270 to Q281)

| # | Decision |
|---|---|
| Q270 | Quarantined stock stays in quarantine and is shown in the stock list. **Change:** three movements take it out: "repaired back to stock" (ADJ), "written off" (ADJ) and "returned to supplier" (DN to the vendor). Each is a Warehouse document approved by L2 with a reason. |
| Q271 | Confirmed as built. A condition is required only on a "Faulty or Damaged" RN. |
| Q272 | The Tripoli patterns stand, with a yearly reset. **Owner data:** the region codes of the other six regions. Until then, their sequences are created by the admin in the numbering screen. |
| Q273 | Confirmed as built. A number issued by a sequence is never reused. |
| Q274 | A wrong Doc No. on a posted document is corrected only by a reversing document (RN or ADJ) that references the wrong one. There is no admin override: posted stock history is never edited. |
| Q275 | Confirmed: the comparison report tags those rows "Master blank: need not covered" and does not count them as differences. |
| Q276 | Confirmed: the Doc Date of an approved TE DN, and approved in the PMIS means "Dispatched". |
| Q277 | **Owner data:** the quantity per unit and the WL vendor of each region. The needs stay `pending_configuration` until then. |
| Q278 | **Owner data:** the manufacturer codes of the 6 generated items. CW-01 to CW-28 stay internal codes. |
| Q279 | **Owner data:** where the approved BOQ of a site comes from. Accessories stay outside the need until then. |
| Q280 | Confirmed: the need status is information only; it does not close D4b or start D-5. |
| Q281 | **Change:** a site whose overall status is Cancelled is left out of the dispatch list and the need totals. It is still visible in its own site page. |

## P11: two levels and permits (Q310 to Q316)

| # | Decision |
|---|---|
| Q310 | No default holder for `permits_hse_om`. The System Admin names its L1 and L2 in the Responsibility Matrix before the first O&M permit; until then such a permit is held (empty cell), as built. |
| Q311 | Confirmed as seeded. Project Support enters these permits only through a delegation (Q219). |
| Q312 | Confirmed as built. No real-estate permit type is added now. |
| Q313 | Keep: no override of an empty L2. An approver is never invented, an admin included. |
| Q314 | Confirmed as built. |
| Q315 | Keep the recheck at save and submit. No nightly move of drafts: a draft moves only when someone acts on it. |
| Q316 | Confirmed as built. |

## P9: logs, monitoring, mail (Q250 to Q259)

| # | Decision |
|---|---|
| Q250 | Confirmed as built for development. **At go-live**, `mail.notification_kinds` also lists the kinds that ask a person to act: an approval waiting for them and an item returned to them with a note. Everything else stays in-app. |
| Q251 | Confirmed as built. `GET /health` serves an external monitor, and security and system mail go to System Admins only. No extra mailbox. |
| Q252 | Confirmed: retries after 1, 5, 15, 60 and 240 minutes; hourly cap as built. |
| Q253 | **Change:** keep mail bodies for 30 days, not 90. That is long enough to resend a failed mail and keeps less personal data. |
| Q254 | Confirmed: a new address inside a trusted network is softened by one level and still raised. **Owner data:** the internal CIDR ranges. |
| Q255 | Confirmed: 10 free failures in 15 minutes, a doubling wait, capped at 60 seconds. |
| Q256 | The refusal with the row count is enough. No automatic split. |
| Q257 | **Change:** the nightly file backup copies `LOG_ANCHOR_DIR` off the server, and every finished check mails the head hash to the System Admins. The anchor then exists in two places the database cannot rewrite. |
| Q258 | Confirmed: System Admin only. The GECOL and Fiber leads get `team_lead` when their roles exist. |
| Q259 | Confirmed as built. Rejections are normal workflow, not exceptions. |

## P6: documents, QC snags, storage (Q260 to Q268)

| # | Decision |
|---|---|
| Q260 | Confirmed: CRITICAL and MAJOR block, MINOR does not. **Change:** the Quality register's Severity field reads the same three codes. |
| Q261 | **Owner data:** the CW and TE snag type catalogue. QC_GENERAL (always blocks) is used until then. |
| Q262 | Confirmed: Quality-TE region cell, then the Quality region cell, then the Quality-TE global cell, then the Quality global cell. |
| Q263 | A snag raised directly stays a QC-only item. Only Quality register records of type snag create a QC snag. |
| Q264 | Keep `documents.new_version_inherit` off. Every document of a new version is approved again. |
| Q265 | Confirmed: L2 of the snag decides pending evidence, never the raiser, finder or fixer. **Change:** accepting pending evidence needs step-up, like the closure. |
| Q266 | Only the Procurement delivery rule blocks. Other undecidable rules show "pending determination" without blocking, as built. |
| Q267 | **Change:** an approved Quality snag record entered by mistake can be cancelled by a System Admin, with a reason and step-up, audited. Its QC snag is cancelled with it. |
| Q268 | Confirmed: quarantined files are left out of the zip and listed in `manifest.csv`. |

## P5: register framework and Meetings (Q290 to Q296)

| # | Decision |
|---|---|
| Q290 | The minutes file stays optional (Q12: only the date and title are mandatory). When it is given, it must be an uploaded file of the record. |
| Q291 | **Change:** add an optional free-text field "external attendees" beside `attendee_users` for vendors, GECOL, HLC and landlords. No links to Contractors. |
| Q292 | Groups: Tower RT, Tower GF and Adaption = CW; TE = TE; Dismantle = CW and TE; GECOL, Fiber and Survey = no group. Old teams with the text `CW` are not converted (see Q320). **Change:** P4b's `team_specializations` table is the single source; P5's `TeamSpecialization` list mirrors it and is never edited on its own. |
| Q293 | **Owner data:** the values of the pending lists. The seeded values are used and stay `pending` (draft badge) until confirmed in Settings, Lists. |
| Q294 | The critical set is confirmed. **Change:** CoStatus Suspended and Blacklisted also deactivate the external party, like Terminated. A blacklisted company must not receive orders. |
| Q295 | Confirmed: Open and In Progress are open; Done and Cancelled are closed. |
| Q296 | **Change (templates):** the stream template task fields read the CompletionStatus catalogue. |

## P8: identity and profile (Q300 to Q308)

| # | Decision |
|---|---|
| Q300 | **Change:** also refuse an overlapping assignment in the database (a deferred check on the assignment and its region and module rows), not only in the API bulk paths. The database is the last line for access rules. |
| Q301 | Confirmed as built: the same scope means the same role, a shared region and a shared top-level module, whatever the permission level. |
| Q302 | Confirmed: removing the phone goes through the same approved request. |
| Q303 | **Change:** an approved change of the email (a sign-in identifier) ends the user's other sessions, like a password change. A phone change keeps them. |
| Q304 | Confirmed: a code in the profile, valid 24 hours, five attempts. |
| Q305 | Confirmed as built. Deciders are told in-app only. |
| Q306 | Confirmed: an admin turning two-factor off ends every session, including M365 ones. |
| Q307 | **Change:** `log_audit_write` takes the admin-override flag, so admin decisions on another person's identity are listed as privileged again. |
| Q308 | The registry phone follows an approved phone change. No separate contact phone now. |

## P2: dashboard, Project Status, delay (Q340 to Q349, Q392, Q393)

| # | Decision |
|---|---|
| Q340 | Confirmed: a straight line by calendar day between plan points; 0% before the first point; the last value after the last point. |
| Q341 | Confirmed: entering the plan is its approval, by the same restricted people as manual values. |
| Q342 | Confirmed: the right, the flag and the audit row. No second review. |
| Q343 | Confirmed: the default work calendar. |
| Q344 | Confirmed: a data gap is shown, with no alert. |
| Q345 | Confirmed: an old period without its party does not count until it is proposed again with the party. |
| Q346 | Confirmed: the task's external party, else the default party type of its definition. |
| Q347 | Confirmed as built. |
| Q348 | No: a snapshot keeps counts only. |
| Q349 | Style A (rings) stays the default. **Change:** the site page follows the same setting. |
| Q392 | Only CW and TE get their own sheets. |
| Q393 | **Change:** SLA rules marked `pending_confirmation` (P1) are left out of the scorecard and penalties, using P1's flag. |

## P3: Master import (Q350 to Q358)

| # | Decision |
|---|---|
| Q350 | Confirmed: the import never creates a site. A missing site is reported. |
| Q351 | Keep the normal workflow for the one-time load. There is no "accept without workflow" override; historical dates go through the same checks as live data. |
| Q352 | Confirmed: register sheets are checked for structure only. A column mapping per register sheet is a later package if the owner wants it compared. |
| Q353 | Confirmed: the `added_task` tag rule. |
| Q354 | Keep the mapping as the definition. |
| Q355 | Registers stay on Submit for Review only. |
| Q356 | **Owner data:** the role mapping. It is entered as role aliases on the mapping screen. |
| Q357 | Confirmed: both projections. B8 and B9 never apply on the same site. |
| Q358 | Confirmed: a new typed column refuses an older file. |

## P4b: contractors (Q320 to Q332)

| # | Decision |
|---|---|
| Q320 | Old "CW" teams are not converted automatically. They are listed in the completeness report and each is set by hand. |
| Q321 | Kept as the whole CW group. |
| Q322 | Confirmed (see Q292). No analysis specialization now. |
| Q323 | During the parallel run, a company contract with no scope list covers every scope, as built. Contracts with scopes are entered as they are renewed. |
| Q324 | Confirmed: the party and an active contract are required once the order has its PO/WO. |
| Q325 | Internal team types are Internal and In-House. Aljeel's own teams are registered under a company record named "Aljeel". |
| Q326 | Confirmed as built: a Fiber specialization and an active contract. |
| Q327 | Confirmed as built: the party may be GECOL or the contractor GECOL uses, checked at final approval. |
| Q328 | Confirmed: an active Stop Work is reported and alerted, and does not block orders. Blocking work on site is the permit's job. |
| Q329 | Confirmed: PROC_TEAM, in-app. |
| Q330 | 30 days. **Change:** a weekly reminder repeats until the expiry date is renewed. |
| Q331 | **Owner data:** the Procurement Order Status list. |
| Q332 | **Owner data:** the Company Type values of the Master, to be added to the type map. |

## P4a: Change Control feeds (Q380 to Q391)

| # | Decision |
|---|---|
| Q380 | Confirmed as built. Migration 0064 adds the pairing rule (Q247). |
| Q381 | Confirmed: withdrawal is a new approved version with `withdrawn` = Yes. |
| Q382 | Confirmed: an approved Cancellation sets the overall status to Cancelled. Dismantle is opened by hand, never automatically. |
| Q383 | Confirmed: fields flagged `requires_approval` are set by the System Admin or a delegate of `fields.edit`. The owner can flag more fields in Settings. |
| Q384 | Confirmed: the proposer must hold L1 of Change Control. |
| Q385 | Confirmed. No typed vendor date for historical sites. |
| Q386 | Confirmed. |
| Q387 | Confirmed (with 0064, the lists follow the Warehouse). Patch cords are not Warehouse items now. |
| Q388 | Confirmed: D17 is closed by Ops Acceptance. |
| Q389 | Confirmed: the contract sign-off date closes A3 and fills Master T. |
| Q390 | Confirmed. The RF & Design cluster ID does not move the site to another cluster; a cluster change is an admin act. |
| Q391 | Confirmed: a risk without probability and impact is shown as "not assessed" and has no score. |

## P4c: procurement, HLC, GECOL, Dismantle (Q360 to Q368)

| # | Decision |
|---|---|
| Q360 | Confirmed: a draft never submitted does not hold C3. |
| Q361 | Confirmed as built. **Owner data:** the ProcStatus list and its cancelled value(s). |
| Q362 | Confirmed: C3 closes on the data, audited. |
| Q363 | Confirmed: installation, TX link test and in-service dates. |
| Q364 | Confirmed: `administer` on HLC in the region, or a System Admin, with the normal L2 approval and step-up. |
| Q365 | Allowed with a warning during the parallel run. **Change (at the end of the parallel run):** the mode becomes required at submit. |
| Q366 | Confirmed as built. |
| Q367 | The warnings stay off. **Owner data:** the GECOL chain and the billing event, from the GECOL team. |
| Q368 | Confirmed. The migration is run once, before the parallel run starts. |

## P10: saved views and drafts (Q420 to Q427)

| # | Decision |
|---|---|
| Q420 to Q425, Q427 | Confirmed as built. Managing other people's views stays with the System Admin; the heir of an orphaned view is the owner's direct manager. |
| Q426 | Confirmed: 30 days, 200 drafts per user, 64 KB each. No other forms for now. |

## Follow-up work (the "Change" rows)

| Package | Change | Questions |
|---|---|---|
| P1 | `calendar.official_confirmed` resets on 1 January | Q245 |
| P7 | Quarantine exit movements (repaired, written off, returned to supplier); cancelled sites left out of dispatch and need totals | Q270, Q281 |
| P9 | Mail body retention 30 days; anchor files in the nightly backup and the head hash mailed to System Admins; go-live mail kinds | Q253, Q257, Q250 |
| P6 | Register Severity reads the snag severity codes; step-up for pending evidence; admin cancel of a mistaken Quality snag | Q260, Q265, Q267 |
| P5 | External attendees free text; specialization list mirrors P4b's table; CoStatus Suspended and Blacklisted deactivate the party; template task fields read CompletionStatus | Q291, Q292, Q294, Q296 |
| P8 | Database check against overlapping assignments; an approved email change ends other sessions; the admin-override flag in `log_audit_write` | Q300, Q303, Q307 |
| P2 | The site page follows the pipeline style; pending SLA rules left out of the scorecard | Q349, Q393 |
| P4b | Weekly certificate reminder until renewed | Q330 |
| P4c | Execution mode required at submit after the parallel run | Q365 |

## Owner data still needed

These are facts, not decisions. The default stays in force until each is given:
- The backup destinations and the names of the key custodians (Q370, Q372).
- The region codes and numbering patterns of the other regions (Q272).
- The Warehouse need quantities, the WL vendors, the manufacturer codes and the BOQ source (Q277 to Q279).
- The internal network ranges (Q254).
- The CW and TE snag type catalogue (Q261).
- The values of the pending lists, the Procurement Order Status list and its cancelled values, and the Company Type values of the Master (Q293, Q331, Q332, Q361).
- The role mapping of the Master (Q356).
- The GECOL chain and billing event (Q367).
- From the earlier C list: the official holiday calendar, and the SLA rules of C-3 and C-4.
