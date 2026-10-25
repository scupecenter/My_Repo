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
