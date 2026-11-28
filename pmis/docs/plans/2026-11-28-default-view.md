# Default view per screen (built)

Each person can make one saved view their default for a screen. Chosen on the screen with the star next to the views (aria-label and tip); the screen then opens on it by itself, once per visit, when the link names no filter or view of its own (a dashboard pin or a typed filter wins). The star again clears it.

Settings: My profile > Default views lists every screen with a default, the view's name and a Reset (the screen then opens on its built-in view). A deactivated or unreadable view drops out; views are never deleted.

Server: table `user_default_views` (user, screen, view; one per screen; RLS own rows), `default_view_set`, `default_view_clear`, `default_views`; routes `POST /saved-views/{id}/set-default`, `POST /saved-views/{id}/clear-default`, `GET /me/default-views`. The set uses the view's own read check (404 otherwise). KEEP in `data_reset_plan()` with saved_views; `pmis_reset_owner` grant added. No permission change.

Shared screens keep keying by their screen key, so the column isolation stamp still decides which table takes a view's columns. Covered: every screen that renders `SavedViews` (all of them share the component). Excluded: none known; screens without saved views have nothing to default.
