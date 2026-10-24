# Stories: mobile readiness (design now, build later)

Source: CLAUDE.md, "Mobile app". These stories set API and data requirements for v1 so that the later mobile app needs no schema change.

## MB-01 My tasks only
- **Given** a site engineer on the mobile client
  **When** they open the task list
  **Then** the API returns only the tasks assigned to them, either directly or through a claimed group task.

## MB-02 Photo stamp metadata
- **Given** a photo taken with the in-app camera
  **When** it is uploaded
  **Then** these fields are stored as metadata and drawn visibly on the image: site ID, name, address, registered coordinates, device GPS, date and time, engineer, and task.
- The v1 API accepts and stores these fields on upload.

## MB-03 Geofence flag
- **Given** a photo whose device GPS is more than 300 m from the site's registered coordinates (the distance is configurable)
  **When** it is uploaded
  **Then** it is accepted with the flag "outside geofence" for the reviewer.

## MB-04 Proof tasks need the in-app camera
- **Given** a proof slot (MOS proof on B8, B9 and D5, and QC fix photos)
  **When** a file without the in-app camera signature is uploaded once the mobile app is live
  **Then** it is refused.
  **And** before the mobile app is live, the web upload is allowed. The switch is an admin setting.
  - ASSUMPTION: this admin setting and the web upload until go-live.

## MB-05 Offline capture
- **Given** a photo captured offline
  **When** the device syncs
  **Then** the original capture timestamp is kept.
  **And** the upload time is stored separately.
  **And** the EXIF rule (DL-06) uses the capture time.

## MB-06 Deferred features
- HSE incidents and clock-in are deferred to the mobile app. No v1 screens are built for them (CLAUDE.md).
