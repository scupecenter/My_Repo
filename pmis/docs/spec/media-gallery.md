# Media gallery (Library > Media)

One place for the photos and images of every enabled source. It reads the records that own the files, so nothing is copied and nothing is stored twice.

## What it shows
- Images of document slots (`document_files`) and photos of QC snags (`snag_photos`), one card each: thumbnail, type icon when no thumbnail can be made, a link to the record the file belongs to, the audited original download, a state chip (withdrawn, earlier version, awaiting evidence decision).
- Filters: search, source, document type, snag type, status, upload date range. Saved views use the shared saved-views component (screen key `library-media`), so sharing and per-user views work as in the other library screens.

## Rights
Visibility is the owning slot's: Documents view in the region, the register's module, the Quality module for a snag photo. The thumbnail route applies the same check. A withdrawn or rejected item is hidden, never deleted; the withdrawn filter appears only when the setting allows it.

## Settings (Settings > Documents > Media)
Setting `media.gallery` (migration 0396): on/off, snag photos, document kinds, images only, task and site documents, withdrawn listing, registers, excluded codes, page size, thumbnail size, quality, format, largest source image. Saved with a reason, a step-up and If-Match, audited. Per-type allowed formats and photo rules stay in Document types; the screen links there.

## Thumbnails
Made on the first request and kept beside the original (nothing in the database). The image library (`sharp`) loads on first use, so a server without it still runs and the gallery shows type icons. The web asks for two thumbnails at a time. A content security policy needs `img-src blob:` because thumbnails are same-origin blob fetches with the session cookie.

## Connections
Permissions, audit (settings change and original download), settings, saved views, link to the owning record, hide-not-delete. Still to come in the next PRs: global search group, export of a selection, notifications, a per-user thumbnail rate limit set in Settings.

## Licence
The image engine ships as an unmodified shared library under LGPL-3.0-or-later; see THIRD_PARTY_NOTICES.md (reviewed exception, decision D63).

## View modes (Library > Media)
The Layout panel of the screen offers four modes: grid (cards, the default), list (one row per photo), by site (groups by the site code, photos without a site last) and by date (groups by upload day, newest first). The mode is kept per user in the same server store as the other remembered views (screen key `library-media`), so it follows the person to any device. An address that names a layout (`?layout=list`) wins over the remembered one. Filters, search and saved views apply in every mode, and the original download, record link and state chip are the same in all four. No setting, table or migration is added: the mode is a personal view choice, not a policy.

## Photo fields in the Daily Plan and in Status Updates (decision 32)
Both screens carry a photo field. The photos are document slots like any other (versions, withdraw that hides and never deletes, audit, virus scan, EXIF date), so they appear in the Media gallery by themselves.
- Daily Plan: one photo set per site and day, shown under the table for each region of the plan. Allowed to the L1 holders of the region (or a System Admin) on an unlocked day, the same right as editing a row. The first photo stores the auto row of the site; the plan version does not change. Audit: `daily_plan.document_uploaded` and `daily_plan.document_withdrawn`.
- Status Updates: shown on each update. A status update is per region or team, so a photo carries a site picked from the sites of the update's region (any visible site when the update has no region). Allowed to the author inside the week of the update. Audit: `status_update.*`.
- Settings: the two seeded document types `PHOTO_DAILY_PLAN` and `PHOTO_STATUS_UPDATE` (Settings > Documents > Document types) set mandatory, minimum, maximum, formats and size, and switching one off hides the field. A missing photo only informs; nothing is blocked.
- Reset: no new table. A slot loses its owner link when the owner row is removed by the project reset; the files stay (hide, never delete).
- Connections: search and filters of the gallery, saved views, export of a selection, notices (new photo on a followed site), permissions of the owner screens, audit, Settings.

