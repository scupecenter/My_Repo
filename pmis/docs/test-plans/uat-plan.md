# User acceptance test (UAT) plan

Purpose: the business users confirm, on a copy of the real data, that Telecom Site Delivery Workspace does their daily work before go-live. It does not
replace the automated tests (CI) or the load test (`docs/ops/load-test.md`).

## 1. Setup

| Item | Rule |
|---|---|
| Environment | a staging server built like production, loaded with the Site Master through the migration guide (`docs/ops/site-master-migration.md`) |
| Accounts | one real account per tester, with the real role and region. No shared accounts. |
| Duration | 5 working days, plus 2 days for retest of fixes |
| Testers | at least one person per role: Site Master owner, project manager, RF and design, acquisition, civil works, procurement, warehouse, finance, quality, region manager, System Admin, a read-only viewer |
| Defects | logged in the tracker with: scenario id, steps, expected, actual, screenshot, severity |

Severity: **blocker** (cannot do the work, or wrong data), **major** (work-around exists), **minor** (cosmetic or wording).

## 2. Entry and exit

Entry: CI green on the build under test, data loaded and signed off by the owner, accounts created, testers trained (`docs/customer/05-training-ar.md`).
Exit: every scenario below passed or accepted by the owner in writing; zero open blockers; zero open majors without an owner-accepted work-around; the
UAT record signed by the project owner and one tester per role.

## 3. Scenarios

Each scenario: who, steps, pass condition. Run on real sites of the tester's region.

| Id | Area | Scenario | Pass when |
|---|---|---|---|
| U01 | Sign in | sign in, change language (Arabic and English), sign out; wrong password is refused | each works; layout mirrors in Arabic |
| U02 | Visibility | a regional user sees only their regions; a viewer cannot edit | nothing outside the scope appears in lists, search, exports |
| U03 | Site Master | find a site, open its card, filter, sort, save a view, export | the numbers equal the Excel Master for the sampled sites |
| U04 | Tasks | open a task, upload the required documents, submit, approve at each level, return a task | status and gates follow the workflow; audit rows exist |
| U05 | Delay and SLA | a late task shows the delay and its cause; a cover decision is recorded | dashboard late counts change accordingly |
| U06 | Dashboard | open the Dashboard and Project Status; compare with the Excel Dashboard | within the agreed tolerance; differences explained |
| U07 | Registers | create, edit, send and approve a record in each register in the role's scope | the right people are notified; locked records refuse edits |
| U08 | Procurement | PR, PO and WO of a site; assign to a team | links between the register and the site are present both ways |
| U09 | Warehouse | receive, issue, serial lookup | stock equals the sheet |
| U10 | Finance | an advance, an expense, a settlement; balances | balances equal the finance sheet; only entitled roles see amounts |
| U11 | Documents | upload, preview, search the text of a document, download, forms from templates | each file opens; sharing links respect the security locks |
| U12 | Import and export | Master-format export; a register template upload with errors | errors listed row by row; nothing half-loaded |
| U13 | Notifications | a mention, an assignment, an overdue notice, an email and a push notice | each arrives once, in the user's language |
| U14 | Mobile | the same site visit flow on a phone | usable without zoom; photos upload |
| U15 | Search | find a site, a task, a document by a word | results respect scope |
| U16 | Admin | add a user, assign a role and region, deactivate; change a Settings list; view the audit | changes take effect and are logged |
| U17 | Backup | System Admin reads the last backup run in Logs > Job runs | shows the last run; a failure sends the alert email |
| U18 | Accessibility | keyboard-only pass of sign in, Site Master, a task | every control reachable; focus visible |
| U19 | Speed | open the Dashboard, a register list and search at the busiest hour | each page opens in under 2 seconds on the staging server |

## 4. Record

One row per scenario per tester: date, build, result (pass / fail / blocked), defect ids, notes. Keep the sheet with the sign-off. A fix after a failed
scenario is retested by the same tester, and the neighbouring scenarios are repeated.

## 5. Out of scope

Penetration testing (the security jobs of CI cover scans), the real-server load test (planned separately, see the load-test page), and any feature not
approved for the first release.
