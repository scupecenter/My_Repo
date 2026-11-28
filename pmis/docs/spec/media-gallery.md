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
