# ADR 0015: Gate date from all conditions, gate history and effective-date suspensions

- Status: Accepted, 2026-11-04. Owner answers Q9 and Q180 of 2026-11-04 (`docs/spec/owner-answers-2026-11-04.md`, binding owner decisions; plan `docs/plans/2026-11-04-owner-answers-gap.md` section P1).
- Changes a domain fact of CLAUDE.md ("A gate date equals the previous milestone date. A Suspension→Resumption in Change Control shifts it."), which may only change through an ADR.
- Related: rules.md sections 2.2 and 2.3, migrations `0017_sla_calendar_gates` (gate_eval), `0018_calc_owner_answers` (gate lock, calc_gate_watch), `0052_p1_sla_calendar_gates` (`db/sql/051_p1_sla_calendar_gates.sql`), contract 0.12.0.

## Context
CLAUDE.md states the base case: a gate date equals the previous milestone date, and Change Control shifts it. The Master gates AX, CA and DQ take the latest of that date and the permit dates and stay blank while a Stop Work is active; 0017 already built that as gate conditions. The PMIS kept only the current state of each gate (`site_gate_state`), so a gate that closed again lost the date it had opened on. The suspension shift used the approval dates of Change Control, while the records carry effective dates (`suspension_start`, `resumption_date`).

## Decision
1. **Gate date (Q9).** The gate date is the latest of the previous milestone date and the dates of every applicable condition of the gate (permits valid on the gate date or approved N/A, milestones, tasks). It is blocked while any condition is missing or a Stop Work is active. CLAUDE.md's wording is the case of a gate without conditions.
2. **History (Q9).** Every change of a gate is kept in `site_gate_events` (`opened` with its date, `closed` with the lock reasons, `date_moved` with the old and the new date), written by the calculation layer (`calc_gate_watch`, owner `pmis_definer`) and never rewritten; `pmis_app` reads it in its regions only. A gate that closes again keeps its earlier opening in the history. Withdrawing an approval re-evaluates the later gates; their history stays. Open tasks of the next stage are still not re-locked (Q81, unchanged).
3. **Suspension windows (Q180).** A suspension uses its effective start (`suspension_start`, else the approval date) and ends at the effective date of the first approved or applied resumption that is later (`resumption_date`, else its approval date). The window is [start, resume). A candidate gate date inside a window moves to the resumption date and is checked again; inside a window without a resumption the gate is locked. Drafts and rejected requests never count. Both dates stay on the record; a window whose effective date precedes its approval is flagged retroactive (`cc_suspension_windows`). The delay attribution side of Q180 is work package P2.
4. **Parallel run.** The Master formulas (approval dates, no history) stay the comparison value; differences are explained in the comparison report, never copied into the PMIS rule.

## Consequences
- `GET /sites/{site_id}/gate-events` lists the history (contract 0.12.0); the Site page shows it in the Scope section.
- A gate open before migration 0052 gets one `opened` event the first time the calculation layer sees it (open question Q246).
- A suspension approved later but effective earlier can now close a gate that the approval-date rule had left open; the alert of Q81 still tells the System Admins and the stage lead.
