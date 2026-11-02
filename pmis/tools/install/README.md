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

## Tests

`test-le-existing.sh` runs the option 4 helpers against a fake `/etc/letsencrypt` tree made in a temporary directory:
valid, expired, mismatched key, empty directory, IP certificate, path-traversal name, the choice (interactive, unattended,
update) and the renewal hook (created, idempotent, foreign hooks left alone). It needs only `openssl`:

    bash pmis/tools/install/test-le-existing.sh

CI checks the scripts with `bash -n` and `shellcheck --severity=error` ("Installer scripts (syntax and shellcheck)").

## Stored files: encryption, virus scan and backup (ADR 0008, Q134)

- `FILE_ENC_KEY` (the master key of the encrypted stored files) is generated on the first run and kept on every update, like `TOTP_ENC_KEY`.
  Keep a copy offline: without it the stored files cannot be read.
- **ClamAV virus scan** (optional, asked at the end of the installer; `install-clamav.sh` can also be run alone): installs `clamav-daemon` and
  `clamav-freshclam`, sets `MALWARE_SCAN=clamd` and `SCAN_FAILURE=fail_closed` in `pmis.env`, and makes the API start after clamd.
- **Backup of the stored files** (optional; `install-file-backup.sh`): installs restic, asks for the repository (another building: an absolute
  path on another disk, or `sftp:`), creates the repository password file once, and installs the nightly timer `gsdn-pmis-files-backup` at 02:30
  (retention 14 daily, 8 weekly, 12 monthly).

The steps and the commands of the owner after an update are in `infra/RUNBOOK.md` (sections 2 to 6).
