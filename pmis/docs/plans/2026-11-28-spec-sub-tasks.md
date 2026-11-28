# Spec: sub-tasks (contract 0.15.474, migration 0613)

Status: built, draft PR. Source: the standard-features list approved in the user's conversation on 2026-11-28 ("implement fully").

## Choices
- Table `sub_tasks` with one parent: a task (`task_id`) or a register record (`record_entity_id`, the logical record, so a new version keeps its sub-tasks). No foreign key on the parent, as the engine tables are written only by definers.
- Writes only through `sub_task_save` (create, change with If-Match, hide) and reads through `sub_tasks_json`. The app role may only read, under the region policy. The workflow backstop trigger is on the table like every table of the engine.
- Rights follow the responsibility matrix and the grants: view of the parent's module and region reads; the entry level there writes; the owner of a line moves its status and progress only. Nothing is widened. The owner must pass `reg_user_in_scope`.
- Roll-up (total, done, mean progress) is computed on read and never written to the parent. The workflow state, SLA and approval are untouched.
- Hide, never delete (`removed_at`). Audit actions `sub_task_create`, `sub_task_update`, `sub_task_remove`.
- Global records have no region and take none, as they take no comments (422).
- Data reset: `sub_tasks` is classified `mixed` in `data_reset_plan()` (task lines with the sites part, record lines with the parts of their record; kept records keep theirs), patched in place and idempotently; `pmis_reset_owner` gets SELECT and DELETE.
- Screen: a "Sub-tasks" tab in the task drawer and the register record drawer; English and Arabic, tooltips, mock handlers, tests.

## Not done on purpose
- No effect on the parent's progress figures or weights. Dependencies between sub-tasks are not part of this item.
