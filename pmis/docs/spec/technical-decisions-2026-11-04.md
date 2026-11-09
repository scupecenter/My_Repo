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
| Q276 | Confirmed: the Doc Date of an approved TE DN, and approved in GSDN Workspace means "Dispatched". |
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

## Site creation (Q470 to Q475), decided 2026-11-05

The owner again asked the technical lead to decide these ("قرر في الأسئلة Q470–Q475 بنفسك").

| # | Decision |
|---|---|
| Q470 | The Site Scenario list of RF & Design is **Indoor / Outdoor**, as the Master `tblScenario`. Old saved values that did not map stay inactive and readable; nothing is lost. The owner can add a value in Settings → Lists. The list stays "pending" (draft badge) until the owner confirms it there. |
| Q471 | Confirmed as built: a cluster is created with its first site when L2 approves. The reviewer sees `cluster_will_be_created` before deciding. A cluster of another region is refused. |
| Q472 | **Configuration before the real load (no code):** the System Admin sets the `site_creation` row in the Responsibility Matrix per region: **L1 = Project Support**, **L2 = Project Manager**. The seeded System Admins group stays as a fallback only. Two different people avoid a self-approval on every batch. |
| Q473 | **Change:** a site's identity changes through a **Change Control proposal** (the Q225 path, `POST /sites/{id}/change-proposals`), never by a direct edit. The rule then needs no exceptions: L1 proposes, L2 approves, and the change is audited. The proposal path gains the English and Arabic names and the coordinates. The **Site ID never changes**. A change of **region or cluster** is a System Admin decision through the same path, because it changes who can see the site. *Built 2026-11-05: migration 0071, contract 0.14.1, CHANGELOG 100.* |
| Q474 | Confirmed as built: a Cancelled row creates and cancels the site in one approval, with two audit rows. Cancelling a site that already exists stays a Change Control Cancellation (Q382). |
| Q475 | Confirmed as built: the Site ID is stored upper-case with single spaces, compared ignoring case and extra spaces, and never reused. The "duplicate" message names no region or site detail. Site IDs are project identifiers, not secrets, and must be unique across the whole project, so revealing that an ID is taken is accepted. |

## Data-load helper (Q490 to Q494), decided 2026-11-05

The offline helper `tools/master-import/fill-templates.py` (gap G3). Questions in [`open-questions.md`](open-questions.md).

| Q | Decision | Kind |
|---|---|---|
| Q490 | Non-numeric text in a number cell (and any text in a date cell that is not a date) is copied as found and listed in the report, so GSDN Workspace refuses it visibly. Only "N/A", "Pending" and "Cancelled" are blanked. | Confirmed as built |
| Q491 | Text dates with day and month both 12 or less are read **day first** (dd/mm/yyyy, the Libyan convention). Each such cell is listed in the report as `date_day_first_assumed` with its address and old and new value, for the L2 reviewer. The flag `--month-first` switches the assumption (event `date_month_first_assumed`). Unambiguous dates are unchanged. | Change |
| Q492 | `--include-personal` stays off. Landlord, contact, phone and e-mail data are not loaded until the owner decides Q469 in writing. Then only a System Admin runs the tool with the flag, on the server or an Aljeel machine, never a personal device. The tool prints a one-line warning when the flag is used. | Confirmed, with the warning added |
| Q493 | The first run on the owner's machine lists the Master headers it cannot find (names only). The owner sends the list and the mapping files are corrected in a small follow-up. | Confirmed process |
| Q494 | Procurement **Record Type** is derived per row: `po` when the PO / WO No. is filled, otherwise `pr` (codes of the Procurement register's record types `pr`, `po`, `wo`, migration 0019; a `wo` row is corrected by the Procurement team). **Delivery** and **Team** are left blank; each copied row is listed as `needs_delivery_team` and the Procurement team completes them in GSDN Workspace before submitting. | Change |

## Decided 2026-11-05 (2)

The owner decided the two questions that the identity work of the same day left open (Q476, Q477), and the technical lead built the two settings screens that Q440 and Q441 asked for. *Built 2026-11-05: migration 0072, contract 0.14.2, CHANGELOG 101.*

| # | Decision |
|---|---|
| Q440 | **Change (built):** Settings, Work calendar gets a confirm / withdraw action for the official calendar (`calendar.official_confirmed`). A System Admin, or a delegate of `settings` edit for all regions; a reason and If-Match; audited (`calendar_official_confirmed` / `calendar_official_unconfirmed`). Confirming is refused while the current or the next year has no holiday or one of their holidays is still tentative (the check Q440 recommended); withdrawing is always allowed. The banner "calendar not confirmed" goes while it is confirmed, and the screen shows who confirmed it and when. The yearly reset (Q245) still returns it to "not confirmed" on 1 January. |
| Q441 | **Change (built):** Settings gets a "Mail kinds" editor for `mail.notification_kinds`, System Admin only: a checklist of the kinds the code writes, the six go-live kinds marked recommended. A reason, step-up and If-Match; audited (`mail_notification_kinds_update`). Unknown kinds, kinds reserved for security (`security_*`, `integrity_*`, `audit_integrity_*`, `break_glass_*`, `retention_*`) and duplicates are refused. `task_assigned` still covers "a task is ready to start". The setting can no longer be changed by a direct update, not even by an administrator. |
| Q476 | RF feed fills coordinates only when empty. The approved RF & Design feed writes `sites.latitude` and `sites.longitude` only while the site has no coordinates (a complete pair in range); once a site has them they change only through a Change Control proposal (Q473). The fill is audited (`site_coordinates_fed`); coordinates in a record that the site does not take are audited as not applied (`site_coordinates_kept`). Every other part of the feed is unchanged. |
| Q477 | Manual reassignment plus an immediate notice to the new region's leads. When an approved region move takes a site to another region, its open tasks keep their holders and their SLA (B12b: nothing is reassigned or reset). The holders of the `reassign` grant of the new region who can see the site get an in-app notice (`site_region_moved`) at once; it lists the site and its open tasks with their holders, so they can use the B12b choices (keep, reassign, act on it themselves). When nobody holds the grant there, the System Admins get it (Q480). |

## Historical-load document waiver (Q462), decided 2026-11-05

The plan of 2026-11-04 (blocker 5, gap G5) asked the owner how the historical tasks of the Master get their documents, since a task cannot be submitted without its mandatory slots and Q351 forbids an "accept without workflow" for the load. The owner delegated the decision to the technical lead.

| # | Decision |
|---|---|
| Q462 | **A one-time, time-boxed, admin-only override** (CLAUDE.md "Admin overrides are all allowed ... accept without document"), built in migration 0073 and contract 0.14.3. The documents are not scanned and uploaded first; the history is accepted without them, flagged, and the documents can follow later. |
| Q462 (setting) | `load.historical_waiver` = `{ open: false, cutoff_date: null }`. Only a **System Admin** opens or closes it, never a delegate (403 `action_forbidden`; it cannot be delegated). Opening needs a reason, a step-up and a **cutoff date that is not in the future**. It **closes itself after 30 days** (a job audits it; the effective state reads the expiry, so it is closed even before the job runs) or by hand. Every change is audited with before and after values and the admin-override flag. The setting has no other writer: a trigger refuses every write that does not come from `hw_waiver_set` / `hw_waiver_expire`, whatever the permission grid says. |
| Q462 (scope) | While the waiver is open, a System Admin who **applies a P3 Master import** (`historical_load: {reason}` on the apply) or **uploads a Site Register stream template** (`historical_load_reason` on the upload) may mark the batch "historical load: accept without documents" (reason and step-up). For the rows of that batch the **mandatory-document check is skipped only when the task's actual (completion) date is on or before the cutoff date**. Every other check still runs: dates, gates, predecessors, the L1 and L2 holders, the two levels, the snags. Rows after the cutoff, a batch that is not marked, and a batch marked before the waiver closed are unchanged (the row is refused for its missing documents). The check is made in the database at staging (the preview row carries the warning `historical_no_documents`) and again at the submit. |
| Q462 (marking) | A task submitted that way is flagged `task_instances.historical_no_documents` (with the batch and the missing document codes). The audit has `task_historical_no_documents` with before and after values, the batch and the row, written with the admin-override flag of `log_audit_write` (0066). The task shows an **"Admin override" badge** in the task view, the drawer and the task grid; the batch shows its mark. |
| Q462 (KPIs) | **A flagged task is treated like an admin override, as the dashboard already does:** it is **left out of the SLA and on-time figures when `dashboard.exclude_overrides` is on (the default)** and counted when it is off; it is always flagged in the meta (`override_flagged_count` includes it, `historical_flagged_count` counts only these); the health index leaves it out of **documentation completeness (D)** and **first-time approval (F)** always, as it leaves out the overrides. **Project Status progress is not changed**: the work was done. |
| Q462 (reversible) | Uploading the missing documents later is allowed on a flagged task even after its approval, and when no mandatory slot is missing any more the flag clears by itself (audited `task_historical_no_documents_cleared`); nothing else changes. A task that goes back to Data Entry (a rejection, a reopening) loses the flag too, so the normal rule applies to its next submit. |
| Q462 (nothing else) | No other path skips the mandatory documents. The marking, the flag and the setting are guarded by triggers that read only the verified session context (`app_actor()`, `app_ctx_stepup()`, the System Admin test): the flag is accepted only for a task that has a row in a batch marked by the signed-in System Admin under the open waiver, with an actual date on or before the cutoff; a mark never changes; `pmis_app` has no table right on the flag or the mark and holds only the doors (`hw_waiver_state`, `hw_waiver_set`, `hw_waiver_expire`, the staging with the mark, the apply with the mark). |

Configuration for the real load (no code): the System Admin who runs the load is the L1 holder of the tasks of the load (or nobody holds L1 and the admin is the holder of last resort), and L2 is another person (Q472), so the rows are not flagged self-approvals. The load order of the plan does not change.

## Decided 2026-11-05 (3)

The owner delegated Q480 and Q485 to Q489 to the technical lead. All six keep the behaviour already built (migrations 0072 and 0073); no code change.

| # | Decision | Kind |
|---|---|---|
| Q480 | When nobody holds the `reassign` grant in the new region, the region-move notice goes to the active System Admins, and the audit row records the fallback. B12b already lets a System Admin keep, reassign or act on behalf; the Project Manager is not added, because the notice is about reassignment, which is not their grant. Naming the leads per region removes the fallback. | Confirmed as built |
| Q485 | Documents uploaded later on a flagged task are not sent to L2: the task is already approved (the unit of approval is the whole task) and reopening it for documents would create a second approval of history. The slot shows `uploaded`, the flag clears with an audit row (`task_historical_no_documents_cleared`), and the health index keeps counting the slot as incomplete until a reviewer approves it in the document view. | Confirmed as built |
| Q486 | No marking after staging. The mark is chosen at upload (or when the Master run is applied) by the System Admin with a step-up; a batch staged without it is discarded and uploaded again. A later "accept without documents" action on a staged batch would be a second door to the same override and is not added. | Confirmed as built |
| Q487 | History stays out of the SLA and on-time figures by default (the existing override rule, `dashboard.exclude_overrides` on), is always flagged, and still counts in Project Status progress, because the work was done. The figures then describe the work run in GSDN Workspace. | Confirmed as built |
| Q488 | No mail or in-app notice at 7 days left or on closing. The waiver is opened on purpose by a System Admin for a planned load, the Settings screen shows its state and end date, and the self-closing is audited. A notice can be added later as a notification kind if the load runs late. | Confirmed as built |
| Q489 | The cutoff date of an open waiver cannot change. To change it the System Admin closes the waiver and opens it again, which starts a new 30-day window and a new audit trail; a batch marked earlier is accepted only while the waiver it was marked under is open with the same cutoff. | Confirmed as built |

## Big New sites batches in the background, decided 2026-11-05 (4)

The owner sent a New sites batch of 469 rows while holding L1 and L2 of the Matrix row `site_creation`, so the send created every site in the same request. It took about 0.31 s per site (about 145 s): nginx answered 504 after 120 s, and the API rolled the request back anyway, because **every request runs in one database transaction that Prisma ends after 30 s** (`TxInterceptor`, `timeout: 30_000`). Nothing was kept. Raising the nginx limit alone could never help. Built in migration 0074, contract 0.14.4.

| Topic | Decision |
|---|---|
| Speed | Site creation is about 4 times faster with the same final data (measured on 40 synthetic sites, a self-approved send through `pmis_app` with a signed context: 12.9 s before, 3.0 s after on a fresh database; 10.4 s before, 3.5 s after on a database with 100 sites and fresh statistics). On a brand-new site the applicability decides every task first, writes the N/A tasks in one statement with one audit row each, and opens the successors once at the end; the calculation runs once per site; `custom_validate` returns at once for a new row without custom values when no custom field has a default or is required; `audit_log_fill` reads the verified context once per row instead of ten times. Every other site (an approved scope change, the admin path) keeps the step-by-step way. |
| Visible difference | A task that becomes N/A in the same pass is no longer opened first and closed right after. So there is no transient `task_unlock` audit row, no "task ready" or "no holder" notice, and no document slot for it; its `version` ends one lower and its `current_level` stays 0. For 40 New Build sites this means 52 unlocks instead of 384 and 52 "no holder" alerts instead of 384. Task states, lock reasons, gates and SLA fields are identical; every N/A still has its audit row. |
| Background | A send, or an L2 "approve", of a New sites batch with **more rows than the setting `imports.async_rows` (default 50)** answers **202** with the batch in the status `processing` and its `progress`. Smaller batches, returns and the other templates answer 200 as before. |
| Request checks | Every check runs in the request, before the 202: visibility, If-Match, the uploader, the state, the note of a return, L1 / L2 of the Matrix row with the grid right, and the **step-up**, read from the verified context, for a self-approval or a final approval (401 and nothing queued). The run (table `import_batch_jobs`, no right for `pmis_app`) stores who asked and whether the step-up was verified. |
| Chunks | The API does the rows in chunks of 25, each in its own transaction (about 2 s; an explicit 120 s limit for a chunk), never in the request transaction. Each chunk runs under a **newly signed context of the same person**: the database checks the person is still active and derives their regions and rights again. Every row is checked again by the same functions as the 200 path. Only that person can continue the run (`app_actor()` must match). The step-up counted is the one stored at the request; the API cannot claim a new one, and `pmis_app` can neither write the table nor pass the step-up as a parameter. A row that fails gets its error and the others go on. At the end the batch gets its usual status (`approved`, `partially_approved`, `in_approval`) and the same single audit row and notices as a 200 answer. |
| Guard | While a run is active, a second send, any decision and a discard answer 409 `batch_processing`. The If-Match moves when the run is asked. |
| Restart | A run left in `processing` (an API restart) is resumed by the API: once at start-up and every 2 minutes (`job_runs` name `import_batch_resume`, only when `JOBS_ENABLED`). A run whose person can no longer act is stopped: the rows done stay, the others wait, and an audit row records it. A chunk that fails three times in a row stops the run the same way. |
| nginx | The installer sets `proxy_read_timeout 300s`; `update.sh` raises a lower value in an existing site (only that directive, `nginx -t` before the reload, the file is put back if the test fails). |
| Open | The other templates (registers, Site Register streams) still send and decide in the request. A register or stream batch of several hundred rows could reach the 30 s limit; the same background run can be extended to them if that is seen. `imports.async_rows` has no field on the Settings screens yet (it is a stored setting, default 50). |

## Decided 2026-11-05 (5): site map

The owner asked for a map on the dashboard (2026-11-05): the project sites with their information, a tower icon whose light shows the delivery stream or phase of the site, pulsing while the site is in that phase and steady green once it is On Air, with filters on status, region, sub-region, site owner and other fields. This is OV-12 (and SC-10) of `dashboard-kpis.md`, gap G-D05. Built in contract 0.14.5, without a migration (CHANGELOG 107).

| Topic | Decision |
|---|---|
| No map tiles | The server is internal and site locations are private, and the map must work offline: **the browser fetches nothing from outside the server** (no tile layer, no map service, no font or script from a CDN). The map is drawn by ECharts (already a dependency) on a **bundled outline of Libya** (`apps/web/src/lib/libya.ts`), with static labels for the main cities (Tripoli, Misrata, Zawia, Benghazi, Sebha, Sirte, Tobruk, Ghat, Kufra, Al Bayda, Gharyan, Ghadames), pan and zoom (roam), a "reset view" button and a full-screen mode. The ECharts geo component draws the land; no `bmap` or other tile extension is loaded. A **self-hosted tile layer** (tiles served by the internal server) can be added later if the owner wants streets; it is not needed for this request. |
| Outline source and licence | The outline is the `LIBYA_RING` polygon of the legacy dashboard (`docs/reference/legacy-dashboard/src/libya.js`, the KPI reference), copied point for point (212 points, longitude/latitude). The legacy file does not record where the polygon came from; it is a coarse land outline used for orientation only, never for measurement. No npm package was added. If the owner wants a certified source, the replacement is the Natural Earth 1:50m "admin 0 countries" outline (public domain), for example through the `world-atlas` package (ISC licence; its data is Natural Earth), which would add `topojson-client`; the map code reads only `LIBYA_GEOJSON`, so the swap is one file. |
| Tower and light | Each site with valid coordinates (latitude 18 to 34.5, longitude 8 to 26, exclusive, as OV-12) is a small lattice tower (`path://` symbol) with a light dot on its top. Light colour = the site's **current stream** by default (Design & Acquisition, Civil Works, Installation TE, Handover & Closure); the toggle "Colour by: stream / milestone" switches to the **current milestone** (stable codes, coloured by workflow order). The Site Register sub-menus had no stream colours, so new tokens were defined in `tokens.css`: `--stream-design` (violet), `--stream-cw` (orange), `--stream-te` (blue), `--stream-closure` (teal) and `--ms-1` to `--ms-10`, plus `--map-land`, `--map-sea`, `--map-line`, `--map-tower`, `--map-idle`, `--map-hold`, `--map-cancel`. They avoid green (On-Air), red (the late ring) and the on-hold amber, and keep at least 3:1 against the land in light and dark (checked in `contrast.test.ts`). |
| States of the light | **In progress** (a current milestone, status not On Hold / Not Started): the stream or milestone colour, **pulsing** (ECharts effect-scatter ripple). **On-Air reached** (the On-Air milestone, stable code MS6, reached) or status Completed: **steady green** (`--done`), no pulse, whatever the stream; it wins over On Hold (a site on air stays on air). **On Hold**: amber, steady. **Not started**: grey, steady. **Cancelled**: hidden unless the status filter includes Cancelled, then dark grey. **Late** (open tasks past their due date, or a milestone not reached whose approved baseline date has passed): a thin **red ring** and a slightly larger light (OV-12's "larger when behind baseline"). **Reduced motion** (`prefers-reduced-motion: reduce`): nothing pulses; an in-progress light gets a steady translucent halo instead. |
| Current stream and milestone | Read from the site's own workflow version with the rule of the Site Register list: the current milestone is the first stage, in workflow order, that is neither reached (its milestone task approved, or every counting task approved when it has no milestone task) nor N/A; its stream is the current stream. Both are empty when everything is reached or N/A. |
| Legend | One chip per colour with its count (sites drawn with the current filters), a click hides or shows that colour (kept in the URL, `map_hide`); a note for the red ring. |
| Filters | ClickUp-style chips above the map, each a pop-over with the values and their counts (faceted: each chip counts over what the other filters keep): overall status, region, sub-region, **site owner / tower owner** (`tower_owner`), delivery scenario, stream, current milestone, cluster, "late only", and a Site ID / name search. They are kept in the URL with the prefix `map_` (shareable, Back restores them). The dashboard's own filters above (region, cluster, scenario, stream) also narrow the map; for the map, the stream filter means "the current stream". The count of sites without valid coordinates (not cancelled) links to the Site Register filtered to them (`/sites?coordinates=missing`, new filter of `GET /sites`). Filtering is done in the browser on one compact list, so counts move at once. |
| Site card | A click on a tower (or on a row of the "List" view, the keyboard and screen-reader alternative) opens the drawer with: Site ID, names EN/AR, region, sub-region, cluster, coordinates, delivery scenario, overall status, site owner / tower owner, tower type and height, owner site ID, current stream, current milestone, current task with its holders (employee ID beside the name, through the usual holder chip), late tasks, share of tasks approved, the milestone dates reached, and a button to the site page. The card reads `GET /sites/{site_id}` and `GET /sites/{site_id}/tasks` (so the site's own visibility and field rules apply); `SiteDetail` gained `tower_owner`, `tower_type`, `tower_height_m`. No landlord or contact data is shown or returned. |
| API | `GET /dashboard/site-map` (contract 0.14.5): one compact row per active site (cancelled included, flagged), the names of the streams and milestones of the versions in use, and the counts (total, cancelled, with and without valid coordinates). Not paged; not audited (a read, like `GET /dashboard`). |
| Who sees what | The sites of the regions where the caller holds **both `dashboard.view` and `sites.view`** (B3: the map shows site-level data, so the Site Register right is needed as well; a caller without `sites.view` anywhere gets 403 `module_forbidden`, and the card says so). The query is a plain read through `pmis_app`, like `GET /sites`: the API limits the regions and the database row-level filter applies underneath. **No new SECURITY DEFINER function and no migration.** No custom field is returned (field-level rules apply only to custom fields, and the card reads them through the site detail). |
| Performance | One query for all sites (an aggregate per site and stage, then per site). With 1000 synthetic sites it stays under 2 s (`dashboard-perf.test.ts`). The map is drawn on canvas so a thousand animated lights stay smooth. |
| Site Register (SC-10) | The same component is in the Site Register: a "Map" button switches the list to the map; in a stream sub-menu the map shows the sites whose current stream it is, and the region and scenario filters of the register narrow it. The SC-10 "section groups" (CW: Not released … RFI ready; TE: Before TE … HOTO / closed) are not built: colour by milestone gives the same information per milestone; the grouping is a follow-up if the owner wants it. |
| Open | The outline is coarse (about 200 points); replace it with Natural Earth 1:50m if the owner wants a finer coast. A self-hosted tile layer is possible later. The dashboard's reference date does not move the map (it always shows today's state). |

## Decided 2026-11-05 (6): register and stream batches in the background

The owner asked to "start processing register batches in the background too". A register batch (any approved register template) and a stream batch (TPL-SITE-DA / -CW / -TE / -CL, the stream parts of TPL-MASTER) were sent and decided inside the request, so a few hundred rows reached the 30 s limit of the request transaction. Built in migration 0075, contract 0.14.6, on the background run of 0074 (decided 2026-11-05 (4)); no second mechanism.

| Topic | Decision |
|---|---|
| Measured (300 rows, `pmis_app` with a signed context, synchronous call, before / after the hot-spot fix) | Issue Log self-approved send 8.7 s / 5.5 s; Issue Log L1 send 11.8 s / 5.1 s; Issue Log L2 approve all 4.6 s / 2.1 s; TPL-SITE-DA self-approved send 11.4 s / 9.1 s; stream L1 send 10.6 s / 5.9 s; stream L2 approve all 3.4 s / 2.1 s; Master import apply (300 sites, one typed column) 8.9 s / 7.1 s. So about 600 to 1,800 rows still fit in 30 s; real files (a full Master is thousands of task cells) do not. |
| Hot spot | `pg_stat_user_functions` (`track_functions = 'pl'`): 10 to 20 calls per row of the holder and right helpers (`wf_eligible`, `reg_eligible`, `wf_actor_regions`), most of their time in SQL helpers that PostgreSQL plans again at every call (a SECURITY DEFINER SQL function is never inlined and has no plan cache). `app_user_is_system_admin`, `app_user_delegations`, `wf_user_in_scope`, `reg_user_in_scope`, `reg_eligible_cell`, `reg_cell_row`, `wf_cell`, `reg_module`, `reg_row_key` and `reg_cell` are PL/pgSQL now: the same statements, owners and grants. 200 calls: `wf_actor_regions` 151 ms to 51 ms, `reg_eligible` 335 ms to 66 ms, `wf_eligible` 149 ms to 48 ms. It speeds up every screen that checks holders, not only imports. |
| Background | A send of a register or a stream batch with more rows than `imports.async_rows`, and an approve, review or return (all rows or the rows listed) of more rows than the threshold, answer 202 `processing` with `progress`, as New sites. A discard stays in the request (one statement). A Save Draft batch's send runs in the background too; its return stays in the request. |
| Same rules per row | The send and the decision of 0037 / 0041 / 0051 / 0073 are split into "rows" (a given list) and "finish" (status, the one audit row, the notice). The synchronous call is the same composition. The run keeps the fixed list of the rows in the order of the synchronous call; every row is checked again in its chunk by the same functions (holders, levels, eligibility, documents, gates, snags, the B7 holder snapshot, the historical-load mark and cutoff of 0073). |
| Request checks | Uploader, If-Match, state, the notes of a return, the grid right, the authority of the person on at least one row (403 otherwise), and the step-up from the verified context when the send can be a self-approval (the sender holds L2 of the register row or of a task of the rows, B5) or when the decision approves. In a chunk, a row that would still need a step-up the run lacks (the Matrix changed) is left as it was and reported as failed `step_up_required`; the run goes on. |
| Chunks | Register rows 50 per chunk (about 0.9 s), stream rows 25 (about 0.8 s plus the document sync), New sites 25 (0074); `imp_async_chunk_size`. Each chunk is its own transaction (120 s limit) under a newly signed context of the same person, so rights are derived again for every chunk (tested: an approver removed from the L2 cell after the first chunk decides nothing more). |
| Documents | A stream send synchronises the conditional documents of each chunk's tasks inside that chunk (`imp_async_chunk_tasks`), never all of them in the request. The synchronous send keeps doing it for all its tasks before the call. The Master import apply never synchronised documents and still does not. |
| Master import apply | The staging stays in the request (about 6 ms per task cell). Each staged batch with more rows than the threshold is sent in the background by the same admin, one batch after the other; the answer is 202 with the run `applied` and `progress` (`mi_run_progress_json`) shown on the Reconciliation screen. A smaller apply answers 200 as before. |
| Settings, Imports | `imports.async_rows` (default 50, range 10 to 500) has its own screen: every signed-in user reads it; a System Admin or a delegate of `settings` edit for all regions changes it with a reason and If-Match (the rule of the calendar confirmation of 0072; no step-up), audited as `imports_async_rows_update` with before and after. The key is guarded against a direct insert, update (old or new key) and delete like the keys of 0072. The next send or decision reads the new value. |
| Open | The staging of a Master import apply is still in the request: about 4,500 task cells fit in 30 s; a bigger Master must be split (by region or stream) or the staging moved to the background too. The register and stream functions trust the `p_stepup` parameter of the API (as before 0075); the background run stores the verified step-up instead. |

## Decided 2026-11-09: editable side menu

The owner asked (in Arabic, 2026-11-09) to "change the order of the side menu and move items by drag and drop, and add new main headings and sub-headings, from the main screen". Built in migration 0081, contract 0.15.1, CHANGELOG 119.

| Topic | Decision |
|---|---|
| One shared layout | One menu layout for everyone, kept in the setting `nav.layout` (jsonb). It is configuration, so it is edited by a System Admin or a delegate of `settings` edit for **all regions** (the rule of the calendar confirmation of 0072 and of Settings, Imports of 0075; no step-up). A delegate limited to some regions and any other user get 403. Personal favourites and recent items are unchanged (they stay in the browser, per user). |
| Filtering | The permission and module filter of the menu is unchanged and applied **after** the layout: every user sees only the screens they may use; a heading (main or sub) whose screens are all hidden for that user is hidden for that user. |
| Fixed entries | The current sidebar keeps no screen fixed: Favourites and Recent sit above the headings and are personal, so they stay where they are and are not part of the layout. My Work, Inbox, Approvals, Dashboard and the other "Work" entries are ordinary entries of the "Work" heading and can be moved like any other. The search box keeps searching every screen the user may use. |
| Shape | `{"headings": [{id, name_en, name_ar, icon, children}]}`. A main heading holds screen keys and sub-headings; a sub-heading holds screen keys only (no deeper level). Limits: 1 to 30 main headings, at most 100 headings in all, at most 200 entries per heading, 64 KiB. Heading id `^[a-z][a-z0-9_-]{0,39}$`, unique among all headings; names EN and AR both required, 1 to 60 characters after trimming; the icon is optional, one of the concepts of `lib/icons.ts` (the database checks the format, the web ignores an icon it does not know). The six default headings keep the ids `work`, `site_register`, `registers`, `data`, `admin`, `logs`, so a user's collapsed headings keep working. |
| Screens only | Entries are the existing screens only: no link or URL can be added, so routes and rights stay in the code. The database validates the keys against `nav_item_catalogue` (42 keys: the sidebar entries of `navItems.ts`; the tabs of Users & Roles are one entry, `admin.users`). A key appears once only. Labels, icons, routes and permissions stay in the web code; the catalogue is for validation only and is extended by the migration of the release that adds a screen (a web test checks that the catalogue of 0081 equals the screens of the menu). |
| Merging | The web merges the saved layout with the screens it knows: an unknown or repeated key is ignored; a screen of the code missing from the layout (a screen added by a later release) is appended at the end of its default heading, or of a heading "Other" (أخرى) when that heading was deleted. So every screen appears exactly once and a saved layout never hides a new screen. With no saved layout (or when it cannot be read) the default of the code applies, unchanged. |
| Site Register | The Site Register entry keeps its sub-menus (the four streams and O&M) wherever it is placed. Dismantle is shown among those sub-menus while it sits in the same heading as the Site Register, and as an ordinary entry elsewhere. The breadcrumb keeps the default group of the page. |
| Edit mode | An "Edit menu" button (pencil) at the bottom of the sidebar, shown only when `can_edit` (not in icon-only mode). In edit mode every screen of the catalogue is listed (also those the editor may not open). Drag and drop with the mouse or a finger (`@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2, pinned; TableKit uses native HTML5 drag, which has no touch support, so it was not reused): reorder, move a screen into another heading or sub-heading, move a sub-heading under another main heading. Keyboard on the handle of each entry: Space or Enter picks, Up and Down move one step in reading order (a screen steps into and out of sub-headings and across main headings), Space or Enter drops, Escape cancels, Tab drops; every step is announced in a live region (EN/AR). "Add main heading", "Add sub-heading" (inside a main heading), rename, delete. Deleting a sub-heading moves its screens to its main heading at its place; deleting a main heading moves its entries to "Other"; "Other" can be deleted only when empty; a screen is never deleted. |
| Save | "Save" and "Reset to default" ask for a reason (3+ characters) and send If-Match (`settings_etag` of 0072); a stale version is 412, the same layout again (or a reset while the default applies) 409 `invalid_transition`, a bad tree 422 with field errors under `/layout`. "Cancel" discards the draft. Audited through `log_audit_write` as `nav_layout_update` / `nav_layout_reset` with the layout, who and when before and after. |
| Database | `nav_layout_json()` (every signed-in user) and `admin_set_nav_layout(layout, reason, version)` (null layout = reset); internal `nav_layout_clean` and `nav_layout_heading` are closed to `pmis_app`. All SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, owner `pmis_definer`, PUBLIC revoked. The key is guarded against a direct insert, an update on the old or the new key and a delete (`settings_guarded_keys` of 0072), also for an administrator's own session; `pmis_app` reads the catalogue and writes nothing in it. The setting row is created by the migration (JSON null) so the version read before the first save is the one the save checks. |
| Open | Per-user layouts were not built (decision 1: one shared layout). The command palette keeps its own order. |

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
| Site creation | Change Control proposals also change the site names (EN/AR) and coordinates; region and cluster changes for a System Admin | Q473 |
| Settings screens | Confirm the official calendar; the mail notification kinds; the RF feed fills empty coordinates only; the leads of the new region are told of a region move | Q440, Q441, Q476, Q477 |
| Data load | The historical-load document waiver (migration 0073, contract 0.14.3) | Q462 |
| Data load | Big New sites batches in the background, faster site creation (migration 0074, contract 0.14.4) | 2026-11-05 (4) |
| Data load | Register and stream batches and the Master import apply in the background, faster holder checks, Settings, Imports (migration 0075, contract 0.14.6) | 2026-11-05 (6) |

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
