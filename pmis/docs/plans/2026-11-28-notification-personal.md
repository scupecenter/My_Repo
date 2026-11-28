# Personal notification settings (items 4 and 7, contract 0.15.531, migration 0583)

This is the third piece of the notification policy. B1 (0530) applies the organization policy in the trigger `z_notifications_policy_gate`. This change adds only what B1 does not have, on the same table and the same trigger chain, and reuses `notif_catalogue()` and the policy time zone. No second mechanism.

## What a person can do (Profile > Notifications)
- Per notification type of the catalogue: bell on or off, e-mail on or off. A mandatory type (no_holder, security_alert, mfa_exemption) is always on and is never stored. Admin-only types are listed to System Admins only.
- Scheduled do-not-disturb: days, from, until, time zone (blank = the policy time zone). A window that ends before it starts crosses midnight; its day is the day it starts.
- Snooze: 1 hour, 4 hours, until tomorrow 08:00, or clear (at most 14 days).
- Test notice: one notice of kind `system` to the own bell, with a 30 second pause. It says whether the person is in quiet time.
- "Notices my settings held back": the last 50 decisions with the reason (type turned off, same unread notice again, e-mail not sent in quiet time).

## What quiet time does
Quiet time (a snooze or the schedule) holds e-mail and browser push. The bell always receives the notice. Push waits and is sent when quiet ends (`push_due` keeps its cursor). An e-mail written in quiet time is not sent. A mandatory kind, and a kind the policy does not govern (mention, delegation, security alert mail), is never held.

## Dedupe across transactions
B1 drops the same notice twice inside one transaction. This adds: the same unread notice (person, kind, channel, title, link) inside the dedupe window (10 minutes, 0 = off) is not written again. Mandatory and ungoverned kinds are never deduped.

## Settings (Settings > Alerts > Policy, System Admin, audited with a reason, versioned)
`notifications.personal`: `allow_personal` (off = the organization policy applies to everyone, nobody can change their own), `allow_dnd`, `dedupe_minutes`, `decision_retention_days` (default 30; purged by the hourly step of B1).

## Connections checked
- `mail_on_notification` (patched in place, after the 0530 policy check), `push_due` (patched in place), `notif_policy_tick` (decision purge), `notifications_policy_gate` (unchanged, runs first), the fan-out of the matrix columns (runs through the same gate per row, so a person's own choice also stops a fanned-out copy).
- `data_reset_plan()`: `notification_user_prefs` is KEEP (a personal preference), `notification_decisions` is LOG; `pmis_reset_owner` holds SELECT and UPDATE on both.
- Tables: RLS forced, a person reads only their own rows, the app role has SELECT only, writes go through definer doors.

## Covered and excluded
Covered: bell, e-mail, browser push, the test notice, Profile and the policy page, EN and AR, API, contract, mock door, unit, API and Playwright tests.
Excluded: SMS or messaging channels (none exist), per-region or per-module personal choices (the matrix by type is the unit), changing the organization matrix itself (unchanged, B1).

## Changelog entry (for the PR body, not CHANGELOG.md)
See the PR description.
