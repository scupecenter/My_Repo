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

## Export of a selection (Library > Media)
Photos are picked with the checkbox on each card or row ("Select loaded" picks everything on screen) and exported with the Export button: a zip with the files in a folder per site and `index.csv` (path, kind, site, type, state, upload time, size, original name, note). It is a background job on the existing job table (`document_export_jobs`, `scope.kind = media_export`, so no new table and the data-reset plan already covers it); the screen starts the download when the job is done. Rules:
- every chosen item must be in the caller's gallery (the same conditions as the list), checked again when the job runs with the requester's own rights;
- a step-up is asked at the start; the export lock key (Settings > Security > Lock keys) blocks both the start and the download;
- the size cap is `export_max_mb` in Settings > Documents > Media (default 500 MB, 10 to 5000), counted from the recorded file sizes; at most 1000 items;
- audited: `document_zip_start` and `document_zip_download` with entity `media_export`, the item count and size;
- only the person who started a job can read it and download it (7 days);
- a file that waits for the virus scan is left out and listed in the index with a note, like the document zip.

## Notices (migration 0472, contract 0.15.534)
Three notices go through the existing notification mechanism (the bell; e-mail and the personal choices follow the notification policy). Nothing is added to the engine and no table is created.
- New photo on a followed site: people who follow a site (the existing Follow button, table `watches`) are told when a photo is added, except the person who uploaded it, and only if they can still read it (the region scope for a site document, the register's module for a register slot). The same gallery rules apply: the document kinds, registers and excluded codes of the setting, images only. Kind `followed_change`.
- Photos below the minimum: the hourly notification step counts photo slots (document type kind photo, mandatory) that still have fewer photos than `min_files` after `min_photos_after_hours`. The record owner (the ball in court of the task, or the creator of the register record) and the Team Leads of the region get one notice per site. The same site is told again only after `min_photos_repeat_days`. Kind `system`.
- Export ready: the person who asked is told when a media export finishes; the link opens the gallery and downloads the finished export once. Kind `system`.
Settings > Documents > Media > Notices: `notify_new_photo`, `notify_min_photos`, `notify_export_ready` (default on), `min_photos_after_hours` (1 to 720, default 24), `min_photos_repeat_days` (1 to 90, default 7). Saved with a reason, a step-up and audit like the other keys. Links open the gallery filtered by the site code (`?q=`).
Connections: search and filters (the link), permissions (the recipient is checked at write time), audit (the settings change), export (the third notice), data-reset plan (no new table), Settings.
