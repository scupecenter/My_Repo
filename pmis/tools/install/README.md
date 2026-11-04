# GSDN PMIS installer (Ubuntu)

`install-ubuntu.sh` installs or upgrades the PMIS on an Ubuntu 22.04 or 24.04 server. `update.sh` pulls the code and
runs the installer again with every answer taken from the last run. Answers are kept in `/etc/gsdn-pmis/install.conf`
(no secrets).

    sudo bash pmis/tools/install/install-ubuntu.sh   # first time, or to change an answer
    sudo bash pmis/tools/install/update.sh           # later updates, no questions

## HTTPS certificate (step 2 of 6)

The first question of the certificate step is the menu. Options 0 to 3 keep their numbers.

| Option | Meaning | Certificate files used by nginx |
|---|---|---|
| 0 | Keep the current certificate (only offered when one is already in use) | the files nginx uses now |
| 1 | Let's Encrypt: issue a new certificate (needs a public domain, port 80 reachable) | `/etc/letsencrypt/live/<name>/` (certbot webroot) |
| 2 | Your own certificate files (for example from your internal CA) | copied to `/etc/ssl/gsdn-pmis/` |
| 3 | Self-signed | `/etc/ssl/gsdn-pmis/` |
| 4 | A Let's Encrypt certificate already on this server, used in place | `/etc/letsencrypt/live/<name>/` (read where certbot keeps it, not copied) |

Use option 4 when another certificate on the server is renewed by certbot and the PMIS must follow its renewals.
Option 2 copies the files, so a renewal never reaches the PMIS.

### Option 4

1. The installer lists the names under `/etc/letsencrypt/live/` (`README` is ignored). Choose a number from the list or type a name.
2. It checks the certificate: `fullchain.pem` and `privkey.pem` exist, the private key matches, the certificate is not
   expired (`openssl x509 -checkend 0`), and it covers the server name. It shows the subject, the SAN and the expiry date.
   Nothing is changed if a check fails.
3. The server name (nginx `server_name`) defaults to the certificate name. Type another name only if the certificate covers it.
4. The renewal hook is installed so certbot reloads nginx after each renewal: `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx`
   (content: `#!/bin/sh` and `systemctl reload nginx`). It is idempotent. If that name already holds another hook, the installer
   writes `reload-nginx-gsdn-pmis` beside it and never overwrites a hook with other content. If both names are taken, it stops
   and asks you to add the reload line yourself.
5. The new nginx site is tested with `nginx -t` before nginx is reloaded. If the test fails, the previous site file is put back
   and nginx is not reloaded.

The choice is saved in `install.conf` (`PREV_TLS_MODE=le-existing`, `PREV_LE_NAME=<name>`). `update.sh` and a re-run keep it,
and option 0 keeps working with it. A site that already points into `/etc/letsencrypt/live/<name>/` is recognised as option 4
even before `install.conf` exists.

### Unattended run (option 4 or any other option)

Only the certificate question is skipped. Every other question is still asked.

    sudo env TLS_MODE=le-existing TLS_LE_NAME=pmis.example.ly bash pmis/tools/install/install-ubuntu.sh

`TLS_MODE` takes `0` to `4` or `le-existing`. `TLS_LE_NAME` is required for option 4. For `update.sh` the saved answers are used.

## Database backup (pgBackRest, optional, Q196)

- `install-db-backup.sh` (asked at the end of `install-ubuntu.sh`, or run on its own): installs pgbackrest, writes `/etc/pgbackrest/`
  (repositories, encrypted with one key per repository; the keys are created once and never regenerated), turns on WAL archiving
  (`archive_timeout` 5 minutes) with a PostgreSQL restart, creates the stanza `gsdn-pmis`, and installs the timers: nightly full backup at 02:00,
  a check every 15 minutes (System Log alert when a backup or the WAL archive is late), and, when configured, a pg_dump copy at 03:00,
  a weekly copy and a monthly copy.
- Repository 2 in another building is an answer to the installer (`sftp:` or `s3:`). The owner's names, destinations and key custody are a
  checklist in `infra/RUNBOOK.md` section 8.8, not decided by the installer.
- Each run writes job_runs rows (`db_basebackup`, `db_dump`). Restore: `infra/backup/db-restore.sh` (point in time, scratch cluster only).

    sudo bash pmis/tools/install/install-db-backup.sh

## Tests

`test-le-existing.sh` runs the option 4 helpers against a fake `/etc/letsencrypt` tree made in a temporary directory:
valid, expired, mismatched key, empty directory, IP certificate, path-traversal name, the choice (interactive, unattended,
update) and the renewal hook (created, idempotent, foreign hooks left alone). It needs only `openssl`:

    bash pmis/tools/install/test-le-existing.sh

CI checks the scripts with `bash -n` and `shellcheck --severity=error` ("Installer scripts (syntax and shellcheck)").

## Stored files: encryption, virus scan and backup (ADR 0008, Q134)

- `FILE_ENC_KEY` (the master key of the encrypted stored files) is generated on the first run and kept on every update, like `TOTP_ENC_KEY`.
  Keep a copy offline: without it the stored files cannot be read.
- **ClamAV virus scan** (on by default since owner answer Q195: installed without a question; `PMIS_VIRUS_SCAN=off` on the command line, or `MALWARE_SCAN=off` in `pmis.env`, skips it; `install-clamav.sh` can also be run alone): installs `clamav-daemon` and
  `clamav-freshclam`, sets `MALWARE_SCAN=clamd` and `SCAN_FAILURE=fail_closed` in `pmis.env`, and makes the API start after clamd.
- **Backup of the stored files** (optional; `install-file-backup.sh`): installs restic, asks for the repository (another building: an absolute
  path on another disk, or `sftp:`), creates the repository password file once, and installs the nightly timer `gsdn-pmis-files-backup` at 02:30
  (retention 14 daily, 8 weekly, 12 monthly).

The steps and the commands of the owner after an update are in `infra/RUNBOOK.md` (sections 2 to 6).

## Outbound mail and the integrity anchors (migration 0055, Q167, Q171)

The PMIS mails the security alerts to every active System Admin (and, later, the notification kinds listed in the setting `mail.notification_kinds`).
The SMTP settings live only in `/etc/gsdn-pmis/pmis.env`. A first install writes them empty; **every update keeps them as they are**. With
`SMTP_HOST` empty, mail is off: nothing leaves the server and the System Log records what would have been sent (kind, masked address, subject;
never the body).

| Setting | Meaning | Example |
|---|---|---|
| `SMTP_HOST` | The internal relay (empty = mail off) | `smtp.aljeel.local` |
| `SMTP_PORT` | 587 for STARTTLS, 465 for implicit TLS, 25 for a relay without TLS | `587` |
| `SMTP_TLS` | `starttls` (required: a relay that does not offer it is refused, never downgraded), `tls` (port 465) or `none` | `starttls` |
| `SMTP_USER`, `SMTP_PASS` | The account the relay wants, both or neither. Never logged, never shown on screen | `pmis-relay` |
| `SMTP_FROM` | The sender, an address or `Name <address>` | `GSDN PMIS <pmis-noreply@aljeel.ly>` |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` (default) checks the relay certificate; `false` only for a test relay | `true` |
| `SMTP_CA_FILE` | The internal CA certificate when the relay uses one (readable by the service user) | `/etc/gsdn-pmis/relay-ca.pem` |
| `SMTP_ALLOW_PLAIN_AUTH` | `true` allows a password over `SMTP_TLS=none` (a relay on the same host only) | (empty) |
| `SMTP_TIMEOUT_MS`, `SMTP_HELO_NAME` | Optional: time-out per step (15000) and the EHLO name | `pmis.aljeel.local` |
| `APP_BASE_URL` | Base of the links in mails; empty = `APP_URL` | `https://pmis.aljeel.local` |
| `LOG_ANCHOR_DIR` | Where the nightly integrity check appends the chain heads (written by the installer: `/var/lib/gsdn-pmis/log-anchors`) | |

After filling them: `sudo systemctl restart gsdn-pmis-api`, then **Logs → Mail delivery → Send a test mail to me**. The channel reads
"Verified" only after a test mail went out with the current settings. A failed mail is retried after 1, 5, 15, 60 and 240 minutes (setting
`mail.retry_minutes`), then given up; the System Admins are told in-app and `GET /api/v1/health` reports `mail: failing` for an external monitor.

Copy the files in `LOG_ANCHOR_DIR` off the server (for example with the file backup): they are the reference that shows a rewrite of the whole
Audit Log or security log chain by someone with database superuser rights.
