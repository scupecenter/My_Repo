# Plan: Dismantle register, stream views, document section (owner decisions 2026-10-31)

Status: agreed with the product owner, not yet built.
Base: main @ 99638c3 (PR #47, contract 0.4.6, migration 0020).
This plan amends the answers to Q37, Q40, Q41 and Q73 where they conflict. Record the changes in `docs/spec/open-questions.md` and `docs/spec/registers-and-streams.md` when the work starts.

## 1. Dismantle register

Dismantle is its own register with two parts: **CW Dismantle** and **TE Dismantle**. This keeps Q41 (fifth sub-section, outside the stream mapping).

Each part runs this flow. Data that belongs to another register stays in that register (see section 4).

| Step | Data | Source of truth |
|---|---|---|
| 1. RFD (Request For Dismantle), trigger | RFD date, uploaded RFD document (usually an e-mail from Design & Acquisition) | Dismantle register |
| 2. Reason | dismantle reason (list, editable in settings) | Dismantle register |
| 3. Assignment mode | In-House or Outsourced | Procurement register (`delivery`) |
| 4. PR | PR number, PR date | Procurement register |
| 5. PO/WO or internal team | PO/WO number and date, company name; or internal team and assignment date | Procurement register (scopes "CW Dismantle" / "TE Dismantle", Q24, Q52) |
| 6. Permits | dismantle permit from the owner authority, other permits | Permits & HSE register (Access/PTW Dismantle, Q64) |
| 7. Supervision and work | supervising engineer, start/end dates, other work data | Dismantle register |
| 8. Close | CW part: signed **CW RN** (civil and tower materials). TE part: signed **TE RN** (equipment). | Warehouse register; the RN record closes its part |

Rules:
- RFD must exist before any later step.
- A part closes only when its RN is received in the Warehouse register with a signed scan.
- `ProcurementRecord.scope` must accept the Dismantle scopes (today documented as CW or TE only).

Missing today: Dismantle table in `schema.prisma`, RFD upload, reason, supervising engineer, close-by-RN link, screens.

## 2. Site Register views

Site Register shows all work per site. Under it, three views. Each view shows only its own steps.

| View | Starts | Ends | Owner |
|---|---|---|---|
| CW Register | Site Release | Site RFI and CW acceptances | CW Team Lead |
| TE Register | Site RFI | HOTO (includes stage 8 Cluster Optimization / KPI acceptance) | TE Team Lead |
| O&M | after HOTO | FAC | O&M team |

Decisions:
- HOTO is owned by the TE Team Lead. The TE lead can delegate a **handover engineer**. Add that field. This changes Q37 (HOTO was in Closure).
- O&M view and an O&M role are built now. O&M users are added later.
- Until the O&M team is assigned, FAC stays with the stream holders (CW lead for CW FAC, TE lead for TE FAC), as in Q40. After assignment, O&M follows DLP and FAC.
- Final Closure (Z1) stays with the Project Manager.

## 3. Document section

One document section is the single place for every upload. Keep it fully configurable from settings, with no fixed values in code. An admin can:
- add, edit or retire a document type;
- set where each document type appears (register, stage, task, field);
- set the file naming rule per type (for example site code, type, date);
- set the allowed formats per type (PDF, images, e-mail: .eml, .msg, .html/.htm, .mht/.mhtml, others).

Allowed formats per type are decided later with the owner. Keep options open.
Check: the spec exists (`stories-document-library-and-uploads.md`, ADR 0008); the build is not verified. ADR 0008 magic-byte checks need an allow-list entry for e-mail formats.

## 4. Source of truth and editing

- Each register (Procurement, Permits & HSE, Warehouse, Dismantle, GECOL, HLC, ...) is the source of truth for its data.
- Work views (Site Register, CW, TE, O&M) read from the registers and show progress per site.
- **Owner decision (option 2):** a user may also edit from the work views. The change is saved to the source register, with the same permission checks, approvals and audit log as an edit made in the register. The view never keeps its own copy.
- Fields that are still typed in tasks today (BU, EF, FO/FT) move to their source register under this rule.

## 5. Future plan (not now): CPE / end-user installation module

A separate O&M module, built in a later phase.
- Prerequisites: field survey with line of sight (LOS), permits, other conditions.
- Work: mounting pole, outdoor CPE, indoor router, power and signal cables, activation.
- Same pattern as equipment installation. Steps can be added or changed later.

## 6. Working rules agreed with the owner

- Delegate work to agents; use the cheapest model that can do the task.
- Keep repo files current with what is built; update `HANDOVER.md` (stale since 2026-10-26).
- Record every agreed plan in `pmis/docs/plans/`.
- Short replies; questions one at a time, each with a recommended answer.

## Next steps

1. Update `registers-and-streams.md` and `open-questions.md` (Q37, Q40, Q41, Q73) to match this plan.
2. Contract and migration for the Dismantle register, O&M role, handover engineer, write-through edits.
3. Screens: Dismantle register, CW/TE/O&M tabs, document type settings.
4. Refresh `HANDOVER.md`.
