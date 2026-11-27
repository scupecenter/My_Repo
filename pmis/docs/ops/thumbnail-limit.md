# Thumbnail rate limit (Media gallery)

Review item SEC-2 (phase 1 security review). Making a thumbnail reads the original file and runs the image library, so one person asking for many new thumbnails
at once could keep the server busy. The limit caps that.

## What it limits

- Only a thumbnail that has to be made. A thumbnail that was made before is served from storage and is never counted.
- Per person (the signed-in user), per minute, in memory in the API process.
- Default 120 a minute. Range 0 to 6000. 0 means no limit.

## Where to change it

Settings > Security > Limits > Media > "New thumbnails per person" (System Admin, with a reason and a password re-check, like the other limits there).
It is one more entry of the `ops.limits` setting; there is no separate setting. Until a value is saved the default applies.

## What happens above the limit

The thumbnail request answers 429 `rate_limited` with `Retry-After` (seconds). The original file stays available. Each refusal writes one `thumbnail_rate_limited`
warning to the System Log (limit and item kind, no file name). Nothing is deleted and no permission changes.

## Not covered, on purpose

- The Media list and the file download are not limited here: they read rows or stream a stored file and do not run the image library.
- The count is per API process. The API runs as one service on one server, so this is the whole count.
- The limit is not per IP: every request is signed in, so the person is the right unit.

Migration 0521 (mirror `db/sql/520_thumbnail_limit.sql`) adds the entry to the limit catalogue by patching the stored function in place; contract 0.15.405.
