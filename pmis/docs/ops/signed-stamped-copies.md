# Signed and stamped copies of documents

Some documents, such as handover receipts, are downloaded, signed and stamped, then uploaded again. The documents center records which version is that copy. This first version is markers only: no e-signature, no drawn stamp. A real digital signature or stamp can follow as a later phase.

## Settings
Settings > Documents > Archive, block "Signed and stamped copies": for each document type tick "Needs signed copy" and / or "Needs stamped copy". A reason is required, the change is audited, and a password re-check applies. Nothing is deleted: untick to remove the need.

## Upload
When a slot's type needs a copy, the upload shows "This file is the signed copy" and "This file is the stamped copy", ticked by default. The uploader can untick (for example a working draft). The markers belong to that version only. A new version is a new upload: the older version keeps its own markers, the link follows the latest.

## What shows
- Each version shows a "Signed" and "Stamped" chip.
- A slot whose type needs a copy shows "Awaiting the signed and stamped copy" until a current version carries it.
- Library > Archive has two columns, "Signed copy" and "Stamped copy" (0474): a chip when the current version carries the marker, "Needed" when the type asks for it and no version does. Both are switched on in Settings > Documents > Archive (default columns; a project that already saved its list keeps it until an administrator ticks them). They are saved with the view and in the CSV export.
- The same two fields are in the Archive filter (+ Filter > Document: Signed copy, Stamped copy; yes or no), so a view can list what is still unsigned or unstamped, and the bulk zip of that view follows the filter.
- The zip `manifest.csv` ends with two columns, `signed` and `stamped` (yes or no).
- Nothing is blocked: no gate, approval or slot status depends on the markers.

## Technical notes
Migration 0555 adds no table. The need per type is the setting `documents.marks`; a version's markers are append-only audit rows (`document_file_marked`), so the data reset plan is unchanged. API: `GET /settings/document-marks`, `PUT /settings/document-marks/{code}`, optional upload fields `signed` and `stamped`.

Migration 0474 adds only `doc_file_marked(file, 'signed' | 'stamped')` (reads the latest marker) and lists the two columns for the Archive setting; no table.
