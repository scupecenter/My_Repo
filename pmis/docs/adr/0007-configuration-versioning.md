# ADR 0007: Configuration versioning and snapshot-on-open

- Status: Proposed. Item 4 (Document Library versions) is a request to database-engineer.
- Related: CLAUDE.md "SLA is fully editable", "Project Status weights are editable", "Document Library", "Configuration owned by the System Admin"; ADR 0009 (fields and task definitions); ADR 0010 (workflow definition); migrations 0005 (SLA, `admin_repoint_sla`), 0006 (weights) and 0007 (`config_touch`).

## Context
Admins change SLA rules, weights, the Document Library, task definitions, fields, templates, roles and the workflow structure without code. CLAUDE.md requires the following:
- Every change is versioned, carries a reason and its author, and is audited.
- A task keeps the SLA in force when it opened.
- Weekly snapshots keep their values.
- A Document Library publish applies to new tasks only, or also to open tasks.
- Approved tasks never change.
- Nothing referenced by data is hard-deleted.

Each area already has a mechanism, but they need one shared set of rules.

## Decision
1. **A common publish contract** for every configuration family:
   - **Fields.** Every change records `version`, `effective_from`, `reason` and `changed_by`. Every change writes an audit row with before and after values. Rows are deactivated (`is_active = false`), never deleted once referenced.
   - **Publish.** Publishing needs the grid right `administer` on the `settings.<family>` screen (or a delegation), and step-up.
   - **API shape.** Every family is published with `POST /settings/<family>/…:publish`. The body is `{ reason, effective_from, apply_to: new_only | open_too }` and the response is `{ affected_open_tasks }`. `apply_to` is offered only where CLAUDE.md allows it.
   - Approved tasks are never touched by any publish.
2. **Snapshot-on-open.** A task instance freezes its configuration when it goes `locked → open` (ADR 0004 §8):
   - its SLA rule (`task_instances.sla_rule_id`, already in place);
   - its document slot set, built from the published Document Library versions at that moment (item 4);
   - its field set (custom fields of the task, by `field_set_versions` at that moment);
   - its workflow version (inherited from the site, ADR 0010).

   `levels_required` is frozen at first submission (ADR 0004 §3).
3. **SLA** (already built).
   - Edits create a new `sla_rules` row, and overlapping ranges are refused.
   - "Apply to open tasks" calls `admin_repoint_sla(old, new, reason)`. It is a definer function that never touches approved tasks.
   - Past KPIs keep the old rule, because every computed duration refers to the rule row of its task.
4. **Document Library: versions** (request to database-engineer).
   - Add `document_type_versions` (immutable published rows: rules, formats, size, min/max files, condition, photo rules, expiry) and point `document_slots.doc_type_version_id` at them. `document_types` stays the stable identity (code, active flag).
   - Publish with `new_only`: open tasks keep their slots.
   - Publish with `open_too`, for each open (not approved) task:
     - slots of new or now-applicable types are added;
     - slots of types that no longer apply become `not_required`, and their files are kept;
     - changed rules apply to the next upload only. Files already uploaded are not re-validated, except that a now-mandatory empty slot blocks submission again.
   - A task that is in review or approval when the publish happens keeps its slots until it is returned or approved. This avoids moving the goalposts mid-review.
   - The response gives the number of affected tasks, for the confirmation dialog.
5. **Weights** (already built). Published sets are immutable, and the 100% check runs at commit. Current progress uses the active set. `progress_snapshots` store `weight_set_id` and the computed values, and a report can be re-run with an older set.
6. **Holidays and calendars are facts, not versions.**
   - Adding a holiday changes the working-day maths of open tasks and future reports.
   - It does not change saved weekly snapshots or approved durations: those are stored at approval time (`task_instances.duration_wd`, a request to database-engineer).
   - This is deliberate. A holiday that is missing by mistake must be correctable (Q4).
7. **Generic settings** (`settings` key/value, for example `require_mfa` and `geofence_radius_m`) are not versioned rows. The audit log keeps every before and after value. They have no snapshot semantics.
8. **Who may change configuration.** A System Admin, or a delegate with the matching right (CLAUDE.md). The definer functions check this in the database through the verified context (ADR 0003 §6).

## Consequences
- One publish dialog and one API pattern serve every settings screen, so the frontend builds it once.
- Snapshot-on-open means a task's rules are predictable for its whole life, and a KPI can always be explained from the rows it references.
- `document_type_versions` and `duration_wd` are schema additions, and the seed must create version 1 of every document type.
