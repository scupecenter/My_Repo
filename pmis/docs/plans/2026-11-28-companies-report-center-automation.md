# Companies, Report Center and automation: plan and status (2026-11-28)

Status of what was agreed and what is built. Update this file as each draft merges. PR numbers are drafts unless marked merged.

## 1. Companies (contractors, executing companies, vendors)

One page, one full record per company, ranked automatically with manual input allowed. Name: Companies. Default factor weights: schedule 25, quality 25, snags 10, delays 10, cost of delay 10, completed work 10, compliance 5, responsiveness 5 (all editable, sum 100).

| Part | What | PR | State |
|---|---|---|---|
| K1 | Merged page: List, Ranking, Data to complete, Team and scope match as tabs of `/companies`; old report route redirects | #615 | draft |
| K2 part 1 | `/companies/:id`: Overview, Performance, Record tabs | #621 (stacked on #615) | draft |
| K2b | Reason, date and approver for suspend and blacklist (additive fields), warning when a purchase request or order picks such a company, duplicate check, order value field, status history line. Blocking on new orders already exists (a suspended or blacklisted company deactivates its party) and is not rebuilt | planned | |
| K3 | Contacts and documents with expiry, document types in Settings, compliance endpoint | #620 | draft |
| K4 | Onboarding checklist, bulk actions, import and export templates for the new tables | planned | |
| K5 | Score engine with factor settings, manual factors, notes and a bounded manual adjustment with required reason; "Manual" badge | planned | |
| K6 | Ranking cards, per-trade and per-company report, A4 and PDF layout, dashboard scorecard reads the same ranking | planned | |
| K7 | Monthly frozen score history and trend, built from the daily site snapshots | planned | |
| K8 | Custom factors read from existing records | planned | |

## 2. Report Center

Goal: management picks a report for any team or work area, chooses fields and filters, runs it, and gets it as an on-screen view, a download (Excel, CSV, PDF), a print, or an email. Everything reads live records. Sufficient for the project size, nothing extra.

Built or planned, in order:
1. Shared A4 print layout (title, filters, who printed and when, page numbers): #618.
2. Report library with parameters (period, company, trade), grouping and subtotals, display options (table, cards, grouped, chart), on top of the report builder #574.
3. Preview on screen, send by email once, sort (follow-ups of #574).
4. Schedule, email and delivery log on the scheduled export engine (#568); server PDF through a headless browser with hard limits (one render at a time, time limit, row cap, no network access, our own HTML only); respects the export lock and the user's rights.
5. Settings: logo and header, allowed formats per role, row limit, hide a library report, favourites, default recipients per team, delivery log retention.

Arabic labels for outputs: عرض، تنزيل، طباعة، إرسال بالبريد (grouped in one menu).

### Decided against
- No link to an external BI tool and no CSV or JSON feed for one.
- No public report links.
- No drag-and-drop designer, no free computed fields, no per-recipient copies, no definition templates, no folders or tags (revisit only on request).
- No AI features unless decided separately.

## 3. Automation (reuse of existing mechanisms)
1. Company document or certificate expiry raises an alert through the alert rules.
2. A suspended or blacklisted company shows a warning when picked on a purchase request or order.
3. Stock below reorder level creates a draft purchase request through the register links.
4. Order status updates the linked task dates and stage.
5. Weekly reminders for incomplete data to the data owner.
6. Public intake forms are triaged and assigned by the assignment rules.
7. Scheduled reports go to the saved company contacts.
8. The monthly company score is frozen from the daily snapshots.
9. Closing or approving fills the linked handover and invoice fields where the link is defined.
10. The idle-record rule is on by default for the main registers.

### Links and automation (approved, all ten)
| # | Item | Owner area |
|---|---|---|
| L1 | Auto-fill derived fields from the linked record | registers |
| L2 | Suggested links when a record is saved without one | registers |
| L3 | Link health board (orphan, broken, incomplete) with one-click fix | registers |
| L4 | Rollups from linked records on the site and company pages | companies |
| L5 | Cross-module triggers (quality approval, stock receipt, task close update what is linked) | automation |
| L6 | Create a linked record in one click with prefilled data | registers |
| L7 | Early conflict warning before save (team, scope, contract, expired licence) | companies |
| L8 | Read-only relationship view of a site or company | dashboards |
| L9 | Consistency alerts (closed record with an open linked record) | automation |
| L10 | Recipients and owners filled from links (company contacts, region owners) | companies |

### Further additions (approved, all ten)
| # | Item | Owner area |
|---|---|---|
| E1 | Settings search and "where is this used" | dashboards and settings UI |
| E2 | Preview of what a setting change does | dashboards and settings UI |
| E3 | Export and import of the whole settings set | templates |
| E4 | Rule log and dry run for automation rules | automation |
| E5 | "As of" stamp and saved snapshot of each report run | Report Center |
| E6 | Merge duplicate companies, sites and records with links moved | companies and registers |
| E7 | Link-aware search results | registers |
| E8 | Alerts on a saved view ("tell me when this view gets a new row") | automation |
| E9 | Project start checklist from a template | templates |
| E10 | Approver stand-in suggestion from delegations | automation |

Order: E4, E5, E6, E8, E1 first, then E2, E3, E7, E9, E10; links L1, L4, L3, L5 first, then L6, L10, L2, then L7, L9, L8.

## 4. Gap review items (approved)
Documentation of this batch (this file), search coverage for risks, issues, invoices, sub-tasks and company contacts and documents, Arabic wording pass, security tests for the public intake form, the order value field, a what's-new entry and short Arabic guide, a load test of the Report Center and PDF, and an ordered merge of the register view PRs.

## 5. Rules in force
Additive migrations only. Hide, never delete. No permission widening. Share links call the sharing lock and exports honour the export lock. Every PR lists covered and excluded places, connections checked and overlaps with earlier work. Arabic strings in clear standard Arabic.
