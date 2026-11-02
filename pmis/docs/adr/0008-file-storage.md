# ADR 0008: File storage (MinIO)

- Status: Accepted (tech-lead). Item 7 (photo checks) is tested in P2; the mobile items are designed now and built later.
- Related: CLAUDE.md "Documents and QC", "Download is available…", "Mobile app"; non-functional requirements (retention, encrypted backups); schema `document_slots`, `document_files`, `snag_photos`.

## Context
- Acceptance documents and QC photos are uploaded into named slots. Superseded versions are kept and can be downloaded.
- Files are named `SITE_TASK_DOC_APPROVEDDATE.ext`, and every download is audited.
- Bulk zip export works per site, per stage, or per document type across sites.
- QC photos are checked against their EXIF date. The mobile app later adds stamping and a geofence check (300 m, configurable).
- Hosting is on-premises only, so storage is MinIO.

## Decision
1. **Buckets.** Each bucket has versioning off, because versions are managed in the database:
   - `pmis-docs`: acceptance documents and register files;
   - `pmis-photos`: QC and snag photos, plus derived thumbnails under `thumbs/`;
   - `pmis-imports`: uploaded templates and Master files, kept 2 years;
   - `pmis-exports`: generated zip and CSV files, deleted after 7 days by a lifecycle rule.
2. **Object keys are opaque and immutable**: `{bucket}/{yyyy}/{mm}/{uuid}`. Nothing in a key depends on names, regions or approval, so a rename or a region transfer never moves an object.
   - An object is never overwritten. A new version is a new object and a new `document_files` row with the same `file_group_id` and `version + 1`.
   - `is_current` moves to the new row. The old row stays and can be downloaded (CLAUDE.md).
   - `pmis-docs` and `pmis-photos` use MinIO **object lock in governance mode** with a retention of the project life plus 10 years (the date is set when the project closes; until then a 10-year default). The app's MinIO user cannot bypass governance mode.
3. **Display names are computed when a file is downloaded, not stored as truth.**
   - The name is `{SITE}_{TASK}_{DOC}_{YYYYMMDD}.{ext}`, using the site code, task code, document code and approved date.
   - Before approval, `DRAFT` plus the upload date replaces the approved date.
   - A superseded version gets `_v{n}`.
   - A name collision in a zip gets `_2`, `_3` and so on.
   - Characters outside `[A-Za-z0-9-]` in codes are replaced with `-`.
   - `document_files.stored_name` keeps the name last issued, for display.
4. **Upload path: through the API, streamed (no presigned PUT).** The default limit is 20 MB per file, so streaming through the API is cheap. It lets the API enforce, before anything is stored:
   - authorization: RLS on the slot, and the matrix level on the task;
   - slot rules from the document-type version (ADR 0007): formats checked by magic bytes, not by extension, plus size and maximum file count;
   - a SHA-256 hash;
   - an optional ClamAV scan (an `infra` decision).

   The file goes to MinIO first, then the database row is written. A nightly sweep removes orphan objects that are older than 24 hours.
5. **Download path.**
   - `GET /files/{file_id}/download` checks authorization (`download_documents` on the module, RLS on the site) and writes the audit row **first**.
   - It then streams the object, with `Content-Disposition` set to the computed name.
   - There are no presigned GET URLs, so every byte served is behind an audit row.
6. **Zip export** runs as a BullMQ job (`POST /exports/zip` returns 202 with a job id).
   - Scope is per site, per stage, per document type across sites, or an explicit file list. The filter is applied with the requester's verified context, so RLS limits the content.
   - The folder layout is `{SITE}/{stage code}/` with the computed names inside. A `manifest.csv` lists each file with its SHA-256, version and status.
   - The job writes to `pmis-exports`. One audit row records the export with its file count and scope. Downloading the zip is audited again.
7. **Photo checks** (QC snag photos, and later the mobile app).
   - EXIF is read on upload. If `DateTimeOriginal` is earlier than `snags.raised_at`, the photo is rejected (`before_snag_raised`). If the tag is missing, the photo is accepted with `unknown_capture_date = true`.
   - HEIC is accepted. Thumbnails (JPEG, GPS removed) are made by the worker. The original is kept byte-for-byte as evidence.
   - **Geofence.** The distance is computed with the haversine formula between the photo's GPS (EXIF, or device GPS from the mobile stamp) and the site's registered coordinates. The radius comes from the setting `geofence_radius_m` (default 300).
     - The result is `inside`, `outside` or `no_gps`. It is a flag for the reviewer and never a rejection, except that camera-only proof slots (MOS, QC) refuse uploads from the web once the mobile app exists (`captured_in_app` is required).
     - `stamp_meta` holds the mobile stamp: site, coordinates, device GPS, time, engineer and task. Offline captures keep their original timestamp.
8. **Custom fields of type `file`** store a `document_files.id` (uuid). The 0007 trigger accepts any non-empty string today; database-engineer should tighten it to an existing file id.
9. **Encryption and backup.**
   - MinIO server-side encryption uses a KMS key held in MinIO KES on the same server, with the key backed up offline.
   - TLS is on the internal network.
   - Bucket replication to the standby server, plus a nightly encrypted copy to the other building, meets RPO 15 min / RTO 4 h. The devops runbook covers this.

## Consequences
- Proxying uploads costs API bandwidth. At 20 MB and about 100 users this is acceptable; it would be revisited for video.
- Computed names mean a renamed task or document type changes future download names, but never the stored objects. The audit log records which name was served.
- Object lock prevents deletion, even by mistake, for the retention period. A legal deletion request would need a MinIO admin with the governance bypass right, which is outside the app.

## Amendments (2026-11-02, the document upload module, migration 0038, contract 0.7.0)
- **Storage drivers.** The API reads `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `S3_REGION`. When all four of the first are set it uses an S3-compatible server (AWS SDK v3, path-style, MinIO on-prem); when none is set it keeps files in the directory `STORAGE_DIR` (small installs and tests). A half-set S3 configuration stops the API at start-up. The two drivers use the same keys, so `mc mirror STORAGE_DIR alias/bucket` moves a local store into MinIO; the installer does it when the choice changes.
- **One bucket with prefixes** instead of four buckets: `docs/`, `forms/` (blank forms) and `exports/` (zip files), each `yyyy/mm/<uuid>`. The bucket is private and the API user can use that one bucket only. The object lock, encryption and replication of items 2 and 9 are set on the server, not by the installer (see Q133).
- **Content checks** (item 4) are by magic bytes in the API, before anything is stored: executables and scripts, archives (a zip is accepted only when it is an Office file with no macro, no embedded program and no path), macro documents, web pages and SVG with a script are refused with 422 `file_rejected` and a `reason`; the stored type and extension come from the bytes, never from the name or the browser. Per Q100: `.eml` and `.msg` are accepted for e-mail documents, `.html`, `.htm`, `.mht` and `.mhtml` are never accepted. A size over the document's limit is 413 `file_too_large`.
- **Photos** (item 7): the EXIF capture date is read from JPEG, TIFF and HEIC and stored; a photo without a readable date is accepted with `unknown_capture_date`. The check against the date a snag was raised and the geofence wait for the snag API (Q131).
- **Download and zip** (items 5 and 6): downloads are audited in the request transaction that commits before the response body is sent, then streamed with `Content-Disposition: attachment`, an ASCII-only computed name and `X-Content-Type-Options: nosniff`. The zip is `POST /exports/zip`, a job table (`document_export_jobs`) and an in-process worker that runs with the requester's own context, so row-level security limits the content; the file is kept 7 days.
- **Library versions** (ADR 0007 item 4): `document_types` holds the published definition, `document_type_drafts` the edit in progress, `document_type_versions` the immutable published versions. A task snapshots its slot set when it opens (`document_task_snapshots`); each slot points at the version it was built from. "New tasks only" leaves open tasks as they are; "also open tasks" adds, retires and re-points slots of pending and ongoing tasks only.

## Amendment 2 (2026-11-02, storage protection, migration 0048, contract 0.11.2, owner answer Q134; supersedes item 9 for the API side)
- **Encryption at rest (client side, both drivers).** Each object is encrypted by the API with AES-256-GCM under a random 32-byte data key and a random 12-byte nonce, streamed (the ciphertext has the length of the plaintext). The data key is wrapped with the master key `FILE_ENC_KEY` (id `FILE_ENC_KEY_ID`, default `k1`; earlier keys in `FILE_ENC_OLD_KEYS`). The envelope (wrapped key, key id, nonce, GCM tag, SHA-256 of the plaintext, size, scan status) is in `stored_object_meta`, not in the object, so the object key stays opaque and a restored store can be checked against the database. An object with no envelope is a legacy plaintext object and is read as it is until `storage-cli.js encrypt-legacy` encrypts it.
- **Why the envelope is a row and not a header in the object:** the document rows keep their `storage_key` unchanged, so the documents module needs no change; the verify and rotation commands read one table; and an object cannot be decrypted without its row, which the database keeps under its own rights (`pmis_app` has no access).
- **Virus scan before storage.** Every `put` (a user upload, a blank form, a register or log file that goes through `put`) is scanned by clamd (INSTREAM, unix socket or TCP) before anything is written. Refused: 422 `file_rejected`, `reason` `malware`, the alert rule `malware_upload` (High) and a System Log row. clamd down: `SCAN_FAILURE=fail_closed` (default) answers 503 `malware_scan_unavailable`; `fail_open` stores the file with `scan_status = pending_rescan`, and the nightly job `malware_rescan` (04:00) scans it. A file that a rescan finds infected is quarantined (its download answers 404) and alerted. Generated zip exports are written by `putFile` and are not scanned again.
- **Expired zip exports** are deleted from storage by the nightly job `storage_purge` (03:00). The row stays, marked `purged_at`; the download answers 410 `export_expired` as before.
- **Backup of stored files:** restic (not rsync), nightly at 02:30, retention 14 daily, 8 weekly, 12 monthly, to a repository on another building, encrypted with its own password. Source: the local directory, or the MinIO bucket copied with `mc mirror`. Each run is a `job_runs` row (`files_backup`). The restore and its drill are in `infra/RUNBOOK.md` and `infra/restore-drill.md`.
- **Object lock and MinIO server-side encryption** stay on the server (item 9 and Q133); server-side encryption is not a substitute for the client-side envelope above.
- **Known limit (Q199):** one GCM tag covers the whole object, checked at the end of the stream; a changed byte is detected when the stream ends, so bytes before it may already have been sent.
