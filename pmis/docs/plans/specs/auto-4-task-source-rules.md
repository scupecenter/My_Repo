# Automation 4: task source rules in Settings

Status: built (migration 0770, contract 0.15.646).

## What already exists
Migration 0019 (Q43) has the table `register_task_sources`: which register record is the source of which task. At the submission of a record, `reg_link_task` links it to the first matching task that is still open. At the final approval, `reg_complete_task` gives the task the date of the chosen field and approves it. A row can carry conditions: `data_eq` (a field equals a value) and `data_in` (a field is one of several values). Today the six seeded rows say: Procurement PR date closes B1, Procurement PO/WO date closes B2, Access permits close B3 and D1, GECOL power-on closes C2, HLC TX link tested closes C4.

## The gap
The rows could only be changed by a migration, so a later order status (for example Delivered) could not move a linked task.

## What this adds
Only the edit door and the read of the same table. No workflow logic changes.
- Settings > Registers > Task source rules: register, task, condition (a field and its values, optional) and the date field. A rule is hidden, never deleted. Reason, If-Match, audit (`register_task_sources_update`).
- `register_task_sources_json()` and `admin_save_register_task_sources()` check that the register is active and has a site, the task exists, the date field is a date field of the register, and every condition names a field of the register.
- Seeds: nothing is added. The six rows stay as they are, so no new rule fires until the owner writes one.

## Choices
- Open tasks only. A new approved version of an order is linked and completes a task only through the unchanged path, so an approved task is never reopened or re-dated and a future date is still refused.
- One row per register and task (the existing key). Several statuses go in one rule as a list.
- Existing rows can change the date field, the hide flag and (by adding the row again) the condition; their conditions are shown in plain words.
- Import and export templates are not added: the table is a handful of configuration rows that carry conditions, like the register rules; the Settings screen is the entry point. The rows are in the data reset plan (config).

## Connections
Register fields (conditions, date field), task definitions (the task), the record (linked at submission), the task (date and approval at final approval), audit log.
