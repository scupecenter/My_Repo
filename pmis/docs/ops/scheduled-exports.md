# Scheduled exports: unattended run and mail (migration 0659, contract 0.15.584)

Schedules (Settings > Data > Scheduled export, migration 0251) start when their owner opens Exports. Two options per schedule and one system switch change that.

## Options per schedule (set by the owner)
- **Mail me** (`mail`): a plain text mail (kind `export_ready`, English and Arabic) when the export is done or failed. It holds the schedule name, the outcome, the row count and the link to Exports. No file and no data is attached. The file stays behind the owner's sign-in. The kind is listed under Settings > Notifications > Mail kinds and follows the mail policy and hourly cap.
- **Run when due without me signed in** (`unattended`): started by an hourly API job (needs `JOBS_ENABLED`) when the system switch is ON.
- A schedule can export one register or Master view (`spec.view`, the body of `POST /exports/master`) as well as parts and regions.

## System switch
`export.unattended`, Settings > Data > Scheduled export. Default OFF. A System Admin (or a delegate of `settings` edit for all regions) changes it with a reason; it is audited (`export_unattended_update`). While OFF, nothing runs without its owner opening Exports, and no schedule is lost: it stays due.

## How an unattended run is kept safe
- No session is used. The job opens a transaction as the owner (`via = job`); the database derives the owner's rights and region rules live (`app_begin`), so a lost grant, a part that no longer exists, or a deactivated or deleted owner stops the run. The error is recorded on the schedule (`last_error`) and the schedule moves to its next due day.
- It goes through the same start path as `POST /exports/master`: export grant per part, region scope, the security lock `disable_export`, audit rows `master_export.start` and `master_export.done`.
- The idempotency key is the schedule and its due instant, so a run beside the owner opening Exports, or a second hourly run, starts nothing twice.
- Only the job can ask which schedules are due (`export_schedules_due_unattended()` refuses a signed-in actor and answers nothing while the switch is OFF).

## Operations
- Time of the run: the first hourly tick after the due instant (the due instant is the start of the schedule's day in the project time zone).
- Look at the System Log and the Audit log (`export_schedule_save`, `master_export.start`) to follow a schedule. A failure shows as the schedule's `last_error` and, when `mail` is on, as a mail to the owner.
- To stop all unattended runs at once: switch it OFF, or use the lock `disable_export`.

## Report builder (`/reports`)

A report is a saved view of the screen `register-<key>`: the filters as the AND/OR tree (`filters.advanced`) and the export columns in order (`columns.order`). It reuses saved views, so it is private by default, versioned, shared with the views.share right, and hidden fields are stripped per reader. Run is `POST /exports/master` with a `view` block. Schedule is `PUT /exports/schedules` with `spec.view` and the mail option. Register exports have no sort, so none is offered. No new table, no migration, no permission change; the export grant, regions and field rules are re-checked on every run. The page is linked from the Data hub.
