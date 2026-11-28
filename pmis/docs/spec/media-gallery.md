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
