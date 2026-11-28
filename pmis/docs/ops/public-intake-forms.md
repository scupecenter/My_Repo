# Public intake forms (0730, contract 0.15.600)

A shareable link outsiders fill in without signing in. Each submission becomes a record in the form's register, in the triage queue.

## What it is
- Settings > Registers > Public intake forms. Per form: register (Issue Log or Change Control Log only, the registers with a triage queue), site, record type, up to 20 typed fields, fixed values (`@today` allowed), intro and thank-you text in EN and AR, expiry, hourly limit, and whether to ask for contact details.
- The public page is `/intake/<token>`. The API is `GET` and `POST /public/intake/{token}`; both need no session.

## Safety
- Creating or replacing a link needs the sharing lock to be off (`assertSharingAllowed`). While the lock is on, existing links answer as not found.
- The token is shown once. Only its SHA-256 hash and the last 4 characters are stored. Replace link makes a new token and kills the old one.
- Every link that does not work (unknown, off, expired, sharing locked, owner lost the right) answers the same 404 `not_found`.
- Limits: per IP in memory (peek 60 a minute, submit 10 an hour, per API process) and in the database per form (`max_per_hour`) and per sender (at least 3 an hour, or a fifth of the form limit).
- Honeypot field `website`: when filled the answer looks like success and nothing is written.
- Text is plain: `<`, `>`, entities and control characters are refused.

## Who creates the record
The record is created as the form owner, through the register's own `reg_save_record`, so the owner's create right, region and entry-holder rules apply live at each submit. If the owner loses the right, submissions stop working.

## Data reset
`intake_forms` and `intake_submissions` are KEEP (configuration and its log).
