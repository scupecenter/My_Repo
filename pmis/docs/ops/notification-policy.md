# Notification policy: what is applied (B1, migration 0530)

The policy in Settings > Alerts > Policy (setting `notifications.policy`) was stored and edited but nothing read it. Migration 0530 applies it in the database,
in one place (the `notifications` table), so every emitter follows it. Reads and writes of the policy itself are unchanged.

| Part of the policy | Effect |
|---|---|
| Switch (`enabled`) | off: governed in-app notices are not written. Mandatory kinds (`no_holder`, `security_alert`, `mfa_exemption`) always pass. Kinds outside the catalogue (mention, delegation, snags, digests) are not governed. |
| Channels (type x channel matrix) | a notice is written only if its type has the in-app channel on; e-mail follows the stored matrix row, else `mail.notification_kinds` (unchanged) |
| Rate cap (`rate_cap_per_hour`) | more in-app notices than the cap to one person in an hour are not written, except approvals, security and mandatory kinds |
| Columns (type x role or group) | a cell that is on adds the members of that role or group (active, in the region) as recipients; nobody is told twice |
| Reminder, escalation, no holder | an hourly step writes `approval_due` to the holders, then to the Team Leads of the region, and `no_holder` to the System Admins; once per level opening and person; nothing changes in the task or record |
| Idle task | `idle_task_alert` to the Team Leads after the working days of `dashboard.settings.stale_idle_days`, when `tasks.idle_alert` is on |
| Retention (`retention_days`) | older notices are deleted |
| Digest hour | the approval digest and the weekly digest run at the policy hour in the policy time zone (they moved from the 02:00 daily run) |

The hourly step is the job `notification_policy` (Logs > Job runs). The old kind `task_returned` is an alias; the engine writes `task_rejected`, which the
catalogue governs. Tests: `apps/api/test/notification-policy-applied.test.ts`.
