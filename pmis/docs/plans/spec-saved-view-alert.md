# Spec: alert me when a saved view has at least N rows (item 8)

Contract 0.15.487, migration 0628 (mirror `db/sql/627_saved_view_watches.sql`).

## Choice and reason

A saved view is a filter of one screen and is evaluated for one user: row security and the regions of the user apply, and only the screen's own list endpoint knows how to count it. A server job cannot count a personal view without repeating every screen's query. So the watch is evaluated when the owner loads the home dashboard: the pinned card already reads the count (the list endpoint with limit 1) and reports it. The database decides and writes at most one in-app notification per view and day (kind `alert_rule`, to the caller only).

## Data

`saved_view_watches (user_id, view_id, min_rows 1..100000, last_alert_on, created_at)`, primary key (user_id, view_id), at most 20 per user, row level security to the owner. A personal preference: kept with `saved_views` in `data_reset_plan`, with the reset grants.

## Functions and API

- `saved_view_watch_set(view, min_rows)`: set or remove (NULL). The view is read through `sv_can_read`; not visible answers not_found. Setting again resets `last_alert_on`.
- `saved_view_watches()`: the caller's watches.
- `saved_view_watch_report(view, count)`: the caller's own watch only. At or above the limit and not notified today: one notification, `last_alert_on` is today (calendar day), result `notified: true`.
- Routes: `POST /saved-views/{id}/watch`, `POST /saved-views/{id}/unwatch`, `GET /me/view-watches`, `POST /saved-views/{id}/watch-report`.

## Limits

The count is reported by the caller's browser and affects only the caller's own notification. No grant, role, permission, visibility or audit change.
