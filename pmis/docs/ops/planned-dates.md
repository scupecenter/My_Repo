# Planned dates proposed from predecessors and calendars (A4, contract 0.15.463, migration 0603)

Until now `task_instances.planned_date` was only typed by hand. Now the system proposes it; a person confirms.

- **How a proposal is made.** For each task of a site that has predecessors, no actual date and is not closed: start = the latest date of its predecessors (actual, else planned, else the predecessor's own proposal when the cascade is on); proposal = start plus the SLA maximum (or minimum) working days of the task's rule, on the work calendar of that rule (weekend days and holidays from Settings > SLA and time > Calendar). A late predecessor therefore moves every task after it.
- **No proposal** when the task has no predecessor, a predecessor has no date, the task has no SLA rule, it already has an actual date, or it is approved, N/A or skipped. The reason is shown by the API (`reason`).
- **Nothing is stored** per task. `GET /sites/{id}/planned-dates` computes on read (`plan_proposals`). `POST /sites/{id}/planned-dates/apply` is the confirmation: it writes `planned_date` of the ticked tasks (needs edit on sites in the region), bumps the task version and writes one audit record per task (`task_planned_date_proposal_applied`, with the basis in the reason).
- **Site page.** A button "Proposed planned dates" (hover hint, aria-label) appears when at least one proposal differs from the planned date. A table with the current date, the proposal, the slip in days and the basis; the engineer ticks and confirms.
- **Settings.** Settings > SLA and time > Planned dates: on or off, SLA maximum or minimum days, cascade on or off. Setting `plan.rules`, reason, If-Match, audited (`plan_rules_update`). Defaults: on, maximum, cascade.
- **Hand patches still work.** A confirmed date can be changed by hand as before; a later proposal shows the difference.
- No new table, so no data-reset decision is needed. Roots of the chain (tasks without a predecessor) keep hand-entered dates.
