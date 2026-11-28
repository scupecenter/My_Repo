# Guest access (Settings > Security > Guest access)

Status: built, migration 0731 (mirror `db/sql/730_guest_access.sql`), contract 0.15.730. Off by default.

## What it is
A System Admin makes a **view-only account with an end date** for a person outside the staff, for example a client on a visit. The guest sees only the regions and modules chosen, can change nothing, and is signed out at the end date.

## How it is built (reuses what exists)
- Setting `security.guest_access` (`enabled`, `max_days` 30, `default_days` 7), changed with a reason, a version and a step-up, like support access.
- The guest is an **ordinary local user** made through `users.create` (temporary password shown once, change at first sign-in) with **one ordinary assignment**: role `GUEST`, level view, the profile `guest_view`, chosen regions and modules, `valid_to` = the end date. Nothing new is added to the permission model.
- Table `guest_accounts` (KEEP in `data_reset_plan()`, see `docs/ops/data-reset.md`) holds the end date, the note and who made it. Ending a guest sets a flag; nothing is deleted.
- Doors (SECURITY DEFINER, System Admin only, reason, audited): `admin_set_guest_access`, `admin_create_guest`, `admin_extend_guest`, `admin_end_guest`, plus reads `guest_access_state`, `guest_access_list`, `guest_session_state`.
- Database guards keep a guest a guest: only the role GUEST at level view with a bounded end date, the `guest_view` profile holds only the view action on the allow-listed modules, no delegation, no group.
- A second lock in the API (`auth/guest-routes.ts`): a deny-by-default list of read routes a guest may call. Everything else answers 403 `guest_read_only`.
- Rate limit 10 creations a minute; every action writes an audit row.

## Covered / excluded
- Covered: read of the allow-listed modules (`sites, dashboard, reports, procurement, contractors, rf_design, acquisition, gecol, hlc, permits_hse, warehouse, quality, issues, risks, change_control, readiness, as_built, meetings`) inside the chosen regions.
- Excluded: any write, export, download, message, upload, delegation, group, user or settings screen. Nothing public: a guest signs in with a password like everyone else; there are no public links.

## Known gaps (for the reviewer)
- A guest may see a 403 on a shell endpoint that is not in the allow-list.
- An announcement addressed to everyone reaches a guest.
- A matrix cell that names a guest as a user is not blocked.
- The client read-only portal, personal API tokens and record-event webhooks are separate follow-up PRs.
