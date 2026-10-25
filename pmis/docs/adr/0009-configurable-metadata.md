# ADR 0009: Configurable metadata: custom fields, task definitions, roles and warehouse items

- Status: Accepted for what is built in migration 0007. Items 5 and 6 are requests to database-engineer. Item 3c needs the owner (gate report, question B8).
- Related: CLAUDE.md "Configuration owned by the System Admin", "Task definitions are editable", "Custom fields", "Roles are fully admin-defined", "Warehouse item master data"; ADR 0005 (templates), 0007 (versioning) and 0010 (workflow definition); migration 0007; schema `field_definitions`, `field_list_values`, `field_permissions`, `field_set_versions`, `task_definitions`, `task_predecessors`, `warehouse_items`.

## Context
The admin adds fields to sites, tasks and every register "like adding a column to the Master". The admin also adds and edits tasks inside stages, defines roles, and maintains warehouse items and their need rules. All of this must be data, versioned, validated, and visible in templates and in the Master-format export, without code changes or runtime DDL.

## Decision
1. **Custom fields: storage and validation** (built in 0007).
   - Definitions live in `field_definitions`, keyed by entity type and an immutable `code`. List options live in `field_list_values`.
   - Values live in one `custom jsonb` column per entity table, with a GIN index. No columns are added at runtime.
   - The `custom_validate` trigger checks: unknown keys, type, required, min/max, length, pattern, active list options, existing user or external party, and defaults on insert.
   - A deactivated field keeps its values but rejects changes.
   - A field that holds values cannot be deleted, re-typed or re-keyed (`field_has_values`, which looks across all regions).
2. **Required on tasks.** The trigger enforces `required` on insert and on change. For `task_instance` fields, "required" means **required to submit**: the engine checks it at `submit`, like mandatory slots, and returns 422 `mandatory_fields_missing`. Database-engineer should therefore skip the trigger's required check for `task_instance` rows that are not in a submit transition. Otherwise creating a locked task with a required field fails.
3. **Task definitions.**
   a. The admin adds, renames, reorders (`sort_order`), re-links (`task_predecessors`, cycles refused) and deactivates ordinary tasks. `code` is immutable.
   b. The predecessor graph and stage membership are part of the **workflow definition version** (ADR 0010). A change that moves a task between stages is structural; the other edits are light.
   c. **`counts_toward_milestone`** (default true). Proposed rule: a milestone is reached when its fixed Master condition is met **and** every active, applicable task with the flag in that stage is approved or N/A. The milestone date is the latest of the Master date and those tasks' dates. Seeded tasks keep the Master formula. To confirm with the owner: an admin-added counting task can make the PMIS milestone later than the live Master's during the parallel run.
   d. **Adding a task to open sites** uses `admin_add_task_to_open_sites(task, sites, reason)`. The API passes the sites where the task's `condition_rule` applies, and the preview shows the count first. The new instances start `locked` and open through the normal unlock rules.
4. **Templates and exports.**
   - A template's columns are its base columns plus the active fields with `in_templates`, ordered by section and `sort_order`.
   - Any change to a field or list option bumps `field_set_versions` for the entity (trigger). Template generation stamps `template_versions.field_set_version`. A newer field set publishes a new template version, and older versions are rejected on upload (ADR 0005 §4).
   - **Master-format export.** A field with `master_export_column` is written at that column. Its letter or header must be unused by the 187 Master columns, which the API validates on save. The parallel-run comparator ignores it, because the live Master does not have it, and lists it as "PMIS-only".
   - Fields with `in_exports` appear in CSV and Excel exports, and field rules (hidden) still apply.
5. **Roles** (CLAUDE.md, 2026-10-25). Request to database-engineer: `roles` gains `description_en`/`description_ar`, `parent_role_id` (replacing the separate `sub_roles` table, or keeping it as a view, at the database agent's choice), `default_profile_id`, `default_all_regions`, default region and module rows, `can_hold_matrix_levels`, and the versioning columns (`version`, `reason`, `changed_by`). Role writes go through `idm_*` (ADR 0003 §7). Assignments keep pointing at one role row.
6. **Warehouse items.** Request to database-engineer: `warehouse_items` gains `category`, `is_active` and the versioning columns, plus a `warehouse_need_rules` table: need unit, quantity rule and applicability (the rules.md §7 table, including the Q6 IP-Router-Only variant). Quantity rules use the shared rule language (item 7). Edits are by the System Admin, or by the Inventory Supervisor through delegation (the right `warehouse.items.edit`).
7. **One rule language.** Task `condition_rule`, document `condition_rule` and warehouse need rules all use one small JSON rule format:
   - operators `all`, `any`, `not`, `eq`, `in`, `is_na`, `is_yes`, `count`, `lookup`;
   - operands: site fields, scope flags, scenario and custom fields.
   - It is evaluated by one TypeScript evaluator in the API. It is never SQL and never `eval`.
   - It has a JSON Schema in `contracts/` (component `ConditionRule`) and is validated on save.

## Consequences
- JSONB keeps the schema stable while admins add fields. Filters on custom fields use the GIN index (`custom @> …`). Sorting on a custom field is slower and is offered only for fields with `in_list_filters`.
- Every field change makes old templates invalid. This is the price of the strict "approved templates only" rule, and the UI must make re-downloading obvious.
- A structural change to tasks (stage moves) goes through the workflow versioning of ADR 0010, never as an in-place edit.
