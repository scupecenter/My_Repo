# Workflow Studio: plan and progress (owner request 2026-11-22)

Owner request: one screen in Settings to see the whole workflow and edit it directly, simply and professionally: every milestone, gate, task, Site Master column and dropdown, plus adding new ones with their place, values, inputs and relations. Approved design: https://claude.ai/artifact/GXE6ETLkupZPqKozeFNQwm (4 artboards: task selected, gate selected, review and publish, add new).

## Owner decisions (2026-11-22)
- Approved the design ("مناسب جدا"); the design must look professional.
- One "+ Add new" button opens a menu: Task, Milestone, Gate, Site Master column. Each opens the add screen with its place and all its properties. A shortcut "+ Add task in <milestone>" in the tree opens it with the place filled.
- Editing applies to what exists now and to anything added later, with the same tools.
- SITE 360 sidebar: one "Site Master" entry (all sites) with 7 sub-menus (done in #170).

## Rules that stay (CLAUDE.md, unchanged)
- Structural changes (add, remove, reorder or move a milestone, gate or task) are a new workflow version: new sites use it, open sites migrate only by the admin's choice with a preview.
- Anything referenced by site data is deactivated, never hard deleted (delete rule 2026-11-13).
- Publishing needs a reason, the typed confirmation `v<version>`, a step-up, and writes the audit log. The structural freeze (B9) still applies when a window is set.
- SLA keeps its versioning (a task keeps the rule in force when it opened).

## What exists in the API already (contract 0.15.42)
- Versions: `GET/POST /workflow/versions`, `PUT /workflow/versions/{v}` (replace a draft's structure), `.../remove`, `.../discard`, `.../publish`.
- Milestones and gates: `PATCH .../milestones/{code}`, `PATCH .../gates/{code}` (light data, gate conditions).
- Tasks: `POST .../tasks`, `PATCH .../tasks/{code}`, `.../predecessors`, `.../successors`, `.../closing`, `.../tasks/insert-preview`, `.../tasks/insert` (insert between with rewiring), `.../milestones/{code}/task-order`.
- SLA and weight: `GET .../sla-weight`, `.../weight-totals`, `PUT .../tasks/{code}/sla-rule`, `.../sla-rules/{id}/remove`, `PUT .../tasks/{code}/weight`.
- Site migration: `.../migration-preview`, `.../migrations`, `/workflow/site-migrations`, `.../revert`.
- Site Master menus: `GET /site360/sections`, `PATCH /site360/columns/{ord}/sections`.
- Dropdowns: `/list-catalogues...`. Custom fields: `/custom-fields...`.

## Phases
| Phase | Scope | Branch / PR | Status |
|---|---|---|---|
| S1 | Studio UI on the existing API: tree, selection, one form per kind (milestone, gate, task), "+ Add new" menu and add screen for task / milestone / gate, draft bar with pending changes, review and publish screen. Replaces the three-column editor as the default of Settings > Workflow (the old editor stays reachable until S4). | claude/workflow-studio-ui, PR #175 | merged 2026-11-22 |
| S2 | API for Site Master columns: create a column (band, group, place, type, dropdown list, source: a task input or a site field), rename, change type with a preview, change dropdown, deactivate; Master-format export carries new columns after the 187. Migration 0133, contract 0.15.43. | claude/workflow-studio-columns, PR #174 | merged 2026-11-22 |
| S3 | Wire S2 into the studio: the task's "Site Master columns" table and the "Site Master column" add type. | claude/workflow-studio-s3, PR #179 | in CI |
| S4 | Pending-changes list with undo per change, impact counts in review, Arabic RTL pass, remove the old editor route. | claude/workflow-studio-s4, PR #180 | in CI |

## Numbers reserved
- Migration 0133 (S2; main took 0132 for the Master import header report). Next free after it: 0134.
- Contract 0.15.43 (S2); S1 adds no path.
- CHANGELOG 176 (S1), 177 (S2), 180 (S3), 181 (S4) (main took 174, 175, 178; 179 is the Site Master navigation PR #177).

## Progress log
- 2026-11-22: design approved; plan written; S1 and S2 started in parallel.
- 2026-11-22: S2 committed (contract 0.15.43, migration 0132, later renumbered 0133), PR #174. Local DB tests 32/32 plus neighbours 129/129. Open: db-security cases for the new doors; unify `admin.settings` (menus) and `fields` (other writes) rights is an owner decision.
- 2026-11-22: S1 committed, PR #175. vitest 1185/1185. Open: SLA-to-open-tasks option disabled (not in publish body), no optimistic undo yet (S4), closing-task action only in classic editor.
- 2026-11-22: main merged #172 and #173 (migration 0132, CHANGELOG 174/175). S2 renumbered to migration 0133 and CHANGELOG 177, S1 to CHANGELOG 176; both branches merged main.
- 2026-11-22: S1 merged (#175). S3 (CHANGELOG 179), S4 (CHANGELOG 180) and the db-security cases for the S2 doors (branch claude/site360-columns-dbsec) started in parallel; Site Master navigation and dashboard tab names on branch claude/site-master-nav (CHANGELOG 178).
- 2026-11-22: S2 merged (#174) with the owner decision "one right" for every column change. db-security cases PR #176. S3 PR #179 and S4 PR #180 committed from interrupted agent sessions (CI decides the fixes). Site Master navigation PR #177 (CHANGELOG 179, migration 0135 for the register page names). Re-import of the reviewed SITE 360 Excel dropped by the owner.
