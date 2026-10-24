# Stories: Document Library, uploads, QC photos, downloads and versions

Sources: CLAUDE.md, "Documents and QC"; BP §05.
The seed document names are in the `documents` column of `task-catalogue.csv`. In stages 4–10 they are marked (TBD).

## DL-01 Define a document in data
- **Given** an admin in the Document Library
  **When** they create a document
  **Then** they set:
  - name in English and Arabic;
  - kind: scanned document, photo, email, report, or approved Excel template;
  - placement: one or more tasks, QC, or a register;
  - mandatory or conditional, with the rule;
  - formats, maximum size, and minimum and maximum number of files;
  - photo rules and expiry date;
  - an optional blank form.
  **And** no code change is needed.
- Defaults: PDF or image, 20 MB, multiple files allowed.

## DL-02 Publish scope
- **Given** a new or changed document definition
  **When** the admin publishes it
  **Then** they choose either "new tasks only" or "new and open tasks". Approved tasks never change.
- **Given** a document is no longer needed
  **When** the admin removes it
  **Then** it can only be deactivated, never deleted. Historical files stay linked to it.

## DL-03 Seed content
- **Given** a fresh installation
  **When** the seed runs
  **Then** stages 1–3 receive the agreed documents (CLAUDE.md).
  **And** the documents for stages 4–10 are created as drafts with the status "To review by product owner".
  - ASSUMPTION: the drafts are not mandatory until they are published.

## DL-04 Named slots on a task
- **Given** a task with 2 mandatory slots and 1 conditional slot whose rule is false
  **When** the task is opened
  **Then** 2 slots are shown, each with a status: missing, uploaded, in review, approved, or rejected with reason.
- **Given** the conditional rule becomes true (for example, Analysis Type = STA, so the STA / ST report is needed)
  **When** the task is refreshed
  **Then** the conditional slot appears.

## DL-05 Upload interactions
- **Given** a slot
  **When** the user drags files onto it, clicks it, or uses the phone camera
  **Then** the files are attached to that slot.
- **Given** a multi-file drop onto the task
  **When** the files arrive
  **Then** the document type of each file is suggested from its name and confirmed in a dropdown.
- **Given** a file in the wrong format or over the size limit
  **When** it is uploaded
  **Then** it is refused with the limit shown.

## DL-06 QC photos close a snag
- **Given** an open snag of type T
  **When** the site engineer uploads photos of the fix
  **Then** the photos are checked against the rules for T: minimum count, required shot types, JPG / PNG / HEIC formats, and maximum size.
  **And** the snag then goes through review and approval, and approval closes it.
- **Given** a photo whose EXIF capture date is earlier than the date the snag was raised
  **When** it is uploaded
  **Then** it is rejected.
- **Given** a photo with no EXIF date
  **When** it is uploaded
  **Then** it is accepted with the flag "unknown capture date" for the reviewer.

## DL-07 Preliminary acceptance blocked by open snags
- **Given** a site with 3 open snags
  **When** a user tries to submit or approve CW PAC (B13) or TE PAC (D16)
  **Then** the action is blocked with the lock reason "3 open snags".
- ASSUMPTION: TE PAC follows the same rule. CLAUDE.md gives CW PAC as the example.

## DL-08 Downloads and naming
- **Given** an approved document
  **When** it is downloaded from the task, from the site Documents tab (which can be filtered), or in bulk as a zip (per site, per stage, or per document type across sites)
  **Then** each file is named `SITE_TASK_DOC_APPROVEDDATE.ext`.
  **And** every download is written to the audit log.
- Storage keeps a random internal name. The original file name stays in the metadata (BP §05).

## DL-09 Versions
- **Given** a rejected document
  **When** a replacement is uploaded
  **Then** a new version is created. The superseded version stays available for download with its uploader and time.

## DL-10 Acceptance documents vs QC photos
- **Given** an acceptance document (for example TE PAC)
  **When** it is uploaded
  **Then** it closes its task through the task workflow.
  **And** it is never used to close a snag, and QC photos are never used to close a task.
