# Floating Inbox panel

Reuses the notification panel behind the bell (item 8, ui.features `panel`). Per-user choice in the appearance profile (two new dimensions, migration 0526, mirror db/sql/525):

- `inbox_panel`: `overlay` (today), `floating` (no backdrop, the page stays usable), `docked` (pinned at the inline-end edge, the page gives it room).
- `inbox_anchor`: the corner of the floating panel (`end-top` default, `end-bottom`, `start-top`, `start-bottom`; inline sides, so it mirrors in RTL).

Use: in the overlay panel the float button opens it as a floating window; the grip button drags it (snaps to the nearest corner on release) or moves it with the arrow keys (announced to screen readers); the pin button docks and undocks; Escape or the close button closes it and returns focus to the bell. The choice is saved through the existing personal profile door (audited, If-Match); the admin personal-choice lock and the organization defaults (Settings > Identity) apply as for every appearance dimension. The popover mode (ui.features panel.mode = popover) is unchanged.
Covered: bell panel. Excluded: the Inbox page (a full page, not a panel); mobile uses the overlay below 1024px for docked.
