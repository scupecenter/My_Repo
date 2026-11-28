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

## Location, panorama and drone files (contract 0.15.539, migration 0477)
The place a photo was taken is read from the image itself (EXIF GPS, with XMP as a second source) when the file is uploaded. For a snag photo the device point sent with the upload is used when the image has none. Older files are read by an admin scan in Settings. The result is kept in a derived table `media_geo`; the file tables are not changed. The row goes with its file and is covered by the data reset plan.

Each card shows the distance to the site and a "far" flag when it is over the limit set in Settings. A panorama (wide equirectangular ratio and width) or a drone file (maker in the configured list) gets a kind mark. The viewer dialog shows the image, the point on a small map with the site, the distance, height, camera and date. A panorama opens in a drag-to-look viewer (WebGL), with a sideways-scrolling image when the browser has no WebGL.

Filters: location (far, near, has a point, no point, not scanned yet) and kind (photo, panorama, drone). Both are in the filter catalog and saved views. A fourth layout, map, draws the points around their sites.

Settings (Settings > Documents > Media): on/off, far distance in metres, flag files without a point, panorama on/off with minimum ratio and width, drone makers list, a scan button with the count still waiting. A change needs a reason and is audited (`media_geo_update`).
