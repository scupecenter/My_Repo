# A4: planned dates proposed from predecessors and calendars

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Propose planned_date (predecessor actual or planned plus a rule of working days from the site calendars), cascade a slip downstream, the engineer confirms per site. Rules editable in Settings. task_instances.planned_date is only hand-patched today (014); baselines, task_predecessors and SLA work calendars exist but nothing computes a plan. The design goes in this PR description first; largest item. Source: Ahmed 2026-11-26 23:16 and 23:17 (A4).

## Reserved numbers (re-verify live before building)
prisma 0603, label 0.15.463
