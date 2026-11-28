# Spec: company status details, order warning and order value (K2b, automation 2, gap 5)

Status: DRAFT-SPEC. Approved by the owner (relayed by Main 2026-11-28 15:32: "build now, nothing dropped"). Source of the requirement text: docs/plans/2026-11-28-companies-report-center-automation.md (K2b, automation item 2, gap review item 5). Code follows in the same PR after the spec is read.

## Requirement (as written in the plan)
K2b: reason, date and approver for suspend and blacklist (additive fields); a warning when a purchase request or order picks such a company; duplicate check; order value field; status history line. Blocking on new orders already exists (a suspended or blacklisted company deactivates its party, Q294) and is not rebuilt.
Automation 2: a suspended or blacklisted company shows a warning when picked on a purchase request or order.
Gap 5: link companies to procurement and warehouse: order value and cost preview.

## What exists (main)
- Contractors register: `company_status` (list) with Suspended and Blacklisted; approval deactivates the external party (065, Q294). Teams belong to a party; Procurement records pick a team (`team_id`, type external_team).
- Audit log keeps every status change with actor and time. Register versions keep the history of each record.
- Company page `/companies/:id` (#621) with Overview, Performance, Record tabs.

## Design (additive, one migration)
1. Status details: three new fields on the Contractors register (rows in `register_fields`): `status_reason` (text), `status_date` (date), `status_approver` (user). Required (reason, date) only when status is Suspended or Blacklisted, enforced by the existing required-when rules of the register, not a new mechanism. The approver is filled by the server from the approving actor at the final level, not typed. No existing record changes.
2. Status history line: the company page shows a line per status change (date, from, to, reason, approver), read from the record versions. No new table.
3. Warning: `GET /companies/{id}/status-warning` (read, same visibility as the company) returns `{status, reason, date}` when Suspended or Blacklisted. The team picker on Procurement (and the order screens) shows a warning chip with the reason next to a team of such a company. Warning only: the existing block of new orders stays as is. Not a permission change.
4. Duplicate check on company create: same normalised name (case, spaces, punctuation) or same registration number among active records returns a warning with a link to the existing company; saving stays possible with a reason (no block).
5. Order value: Procurement gets `po_value` (number, >= 0) and `po_currency` (list from settings, default as today's project currency) as register fields, optional. Cost preview: the company page Orders tab sums `po_value` per company and per status from approved records, read only. Warehouse link: a warehouse request that references a PO shows the PO value beside it, read only.

## Safety (owner rules)
Additive only; no permission, role, grant or default change; nothing public; no CHANGELOG.md or contract `version:` edit; term "Site Master" and product name rules apply. Hide, never delete.

## Open questions (do not block the draft)
1. Currency: one project currency or per order? (the draft uses one optional currency field.) 2. Is the duplicate check name only, or name plus registration number?

## Tests planned
API: fields saved and required when suspended; approver set by the server; warning endpoint; duplicate warning; PO value sum. Web: warning chip on the team picker, status history line, duplicate dialog, Orders tab totals; EN and AR.

Connections checked: Q294 deactivation, #620 compliance chip, #621 tabs, procurement register, audit log.
Docs in this PR: this spec, plan table row K2b, HANDOVER and relations-map lines (with the code).
Arabic changelog entry (PR body only): تفاصيل حالة الشركة (السبب والتاريخ والمعتمد)، تحذير عند اختيار شركة موقوفة أو في القائمة السوداء، فحص التكرار، وقيمة أمر الشراء.
