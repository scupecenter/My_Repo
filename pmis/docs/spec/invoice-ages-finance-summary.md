# Dashboard: invoice ages in the restricted financial summary (draft spec)

Status: DRAFT-SPEC. No code in this PR. The build goes into this same PR later, on top of the finance card (PR #323, then #324).

## Agreed requirements
- Source: Ahmed's approved follow-up on the restricted financial summary (item 9), relayed by Main; queued after the phase scope work.
- Add invoice ages to the financial summary: age of each open invoice, and an overdue count.
- Age = today minus `invoice_date` while the state is not Paid or Cancelled. Overdue = `due_date` < today.
- Data: register key `invoices` (db/sql/184_invoices_register.sql), fields invoice_date, received_date, due_date, paid_date in `register_records.data`. Derived only, nothing typed.
- Same readers as the financial summary (the Settings readers setting). No widening of permissions, nothing public.

## Plan
- Extend `financeSection` and `financeSummary` in `dashboard-ops.service.ts` and `dashboard-ops.rules.ts`; contract and generated types; web card, EN/AR, tests; 5-shot pixel pass.
- Additive only. Never replace accumulating SQL functions whole.

## Numbering reserved
- Contract label 0.15.369. Migration only if needed: prisma 0526, db/sql 525 (re-verify live before the build).
