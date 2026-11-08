# GSDN Workspace: runbook

This runbook covers the storage protection of uploaded files (owner answer Q134; ADR 0008, amendment 2026-11-02). Every command runs on the
PMIS server as root unless it says otherwise. Secrets are read from `/etc/gsdn-pmis/pmis.env` and `/etc/gsdn-pmis/backup.env`; never paste
them into a ticket or a chat.

Sections: 1 what is protected and how, 2 enable ClamAV, 3 backup target, 4 re-encrypt existing files, 5 key rotation, 6 restore drill,
7 scheduled jobs and logs, 8 database backup, 9 session context key rotation.

## 1. What is protected, and how

| Control | Where | Behaviour |
|---|---|---|
| Encryption at rest | every upload, blank form and zip export | AES-256-GCM, a random data key and nonce per object, streamed. The data key is wrapped with the master key `FILE_ENC_KEY`. The envelope (wrapped key, key id, nonce, tag, SHA-256 of the plaintext) is in the table `stored_object_meta`. |
| Virus scan | every upload (`put`), before anything is stored | clamd, INSTREAM. An infected file: 422 `file_rejected`, reason `malware`, nothing stored, a System Log row, a security alert `malware_upload` (High) for the System Admins. |
| Scanner down | `SCAN_FAILURE` | `fail_closed` (default): 503 `malware_scan_unavailable`, nothing stored. `fail_open`: stored, flagged `pending_rescan`, rescanned at 04:00. Both are logged. |
| Legacy files | objects with no envelope row | read as they are (plain). Use section 4 to encrypt them. |
| Zip expiry | `document_export_jobs.expires_at` | at 03:00 the stored object of an expired export is deleted, its envelope removed, and the row marked `purged_at`. The download answers 410 `export_expired`. |
| Backup | local store or MinIO bucket | nightly restic snapshot at 02:30, retention 14 daily / 8 weekly / 12 monthly, one copy in another building. |

Why restic for the backup: it encrypts the repository, deduplicates, and applies the retention policy in one command. rsync would copy the
files without encryption or history, and the retention would be a script of our own.

**The master key is the one thing that cannot be restored from the backup.** `FILE_ENC_KEY` lives in `pmis.env`. Keep a copy in the
offline safe (sealed envelope, two people). The restic password (`/etc/gsdn-pmis/restic.password`) is kept there too. Without the master key
the backed-up stored files are unreadable, and the backups of the database alone do not help.

Object keys are random and never change; the API is the only way in; MinIO's bucket is private (installer). Object lock and MinIO server-side
encryption are set on the server, as ADR 0008 says (Q133), not by this installer.

## 2. Enable the ClamAV virus scan

The installer asks at the end of a run. To enable it later, or on a server where it was skipped:

```bash
sudo bash pmis/tools/install/install-clamav.sh
```

What it does: installs `clamav-daemon` and `clamav-freshclam`, enables both, gives the API user the `clamav` group (to read the socket),
writes `MALWARE_SCAN=clamd`, `CLAMD_SOCKET=/run/clamav/clamd.ctl` and `SCAN_FAILURE=fail_closed` to `pmis.env`, and makes `gsdn-pmis-api`
start after `clamav-daemon`.

Checks:

```bash
sudo systemctl status clamav-daemon clamav-freshclam --no-pager
sudo journalctl -u clamav-freshclam -n 20 --no-pager     # signature update: "database updated" or "up-to-date"
```

The first signature download can take several minutes; until clamd has loaded the signatures, uploads answer 503 under `fail_closed`.
The EICAR test (upload the standard EICAR test string as a PDF-named text file through the document slot) must answer 422 `file_rejected`
with `reason: malware`, and the System Admins' inbox gets a `malware_upload` alert. Remove the test alert by acknowledging it in Logs > Security alerts (the acknowledgement keeps the record).

To run uploads without a scanner (only with the owner's decision, Q195): set `SCAN_FAILURE=fail_open` in `pmis.env`, then
`sudo systemctl restart gsdn-pmis-api`. Files stored in that time are rescanned at 04:00; check them with
`sudo -u gsdn-pmis node /opt/gsdn-pmis/api/dist/documents/storage-cli.js rescan`.

## 3. Choose the backup target

The backup is optional at install time (`install-file-backup.sh`). Choose a repository on **another building**:

- another disk or share mounted on this server: an absolute path, for example `/mnt/backup-b/gsdn-files`;
- another server by SFTP: `sftp:backup@other-building.example:/srv/gsdn-files` (the key for the SFTP user is set up by the network team; the
  password file of restic stays on this server and offline).

```bash
sudo env FILES_BACKUP_REPO=/mnt/backup-b/gsdn-files bash pmis/tools/install/install-file-backup.sh
sudo systemctl start gsdn-pmis-files-backup.service     # the first run now, instead of waiting for 02:30
sudo journalctl -u gsdn-pmis-files-backup -n 30 --no-pager
```

The installer writes `/etc/gsdn-pmis/backup.env` and creates `/etc/gsdn-pmis/restic.password` once (never printed). **Copy the password
file to the offline safe the same day.** Check the repository:

```bash
sudo -u gsdn-pmis bash -c 'set -a; . /etc/gsdn-pmis/backup.env; export RESTIC_PASSWORD_FILE; restic snapshots --tag files'
```

Each run writes a `job_runs` row named `files_backup` (visible in Logs > Job runs).

**The integrity anchors travel with the files (Q257).** The service reads `/etc/gsdn-pmis/pmis.env`, so the backup also copies the directory
`LOG_ANCHOR_DIR` (the installer writes `/var/lib/gsdn-pmis/log-anchors`) as a second path of the same snapshot. These files hold the chain head
hash of every integrity check; with the copy off the server and the mail of each head hash to the System Admins, the anchor exists in places the
database cannot rewrite. If `LOG_ANCHOR_DIR` is unset or missing, the backup is still taken and says so in the journal. The smoke test is
`bash infra/backup/test-files-backup.sh`.

## 4. Re-encrypt the files that were stored before this release

Files stored before migration 0048 are plain. Encrypt them once. The step is idempotent: a second run skips what is done.

```bash
# 1. a database backup first (pg_dump of the pmis database, kept off this server)
# 2. see how many files are still plain (writes nothing)
sudo -u gsdn-pmis node /opt/gsdn-pmis/api/dist/documents/storage-cli.js encrypt-legacy --dry-run
# 3. encrypt them (in place, one by one; a mismatch is reported and left as it is)
sudo -u gsdn-pmis node /opt/gsdn-pmis/api/dist/documents/storage-cli.js encrypt-legacy
# 4. verify every stored file decrypts to the recorded SHA-256 and size
sudo -u gsdn-pmis node /opt/gsdn-pmis/api/dist/documents/storage-cli.js verify
```

The command reads the environment of the API (`pmis.env`) through the service unit. If you run it by hand, load the same variables first.
Step 3 prints `MISMATCH` for a file whose bytes differ from the SHA-256 recorded with the file; such a file is not touched. Investigate it
before anything else (it may have been changed on disk). Run `verify` at the end: `bad` must be 0.

If the command stops in the middle (power cut), run step 3 again: a file with an envelope is skipped. Run `verify`; a file that is reported
bad was caught in the one-second window between its envelope and its replacement: restore that file from the last backup (section 6) and
run step 3 again.

## 5. Key rotation (rewrap the data keys)

Rotation changes the master key. It rewraps the data keys only; the stored bytes are not rewritten.

1. Generate the new key: `openssl rand -hex 32`. Put the old key in the offline safe under its id.
2. Edit `/etc/gsdn-pmis/pmis.env`: set `FILE_ENC_KEY_ID=k2` (a new id), `FILE_ENC_KEY=<new key>`, and
   `FILE_ENC_OLD_KEYS=k1:<old key>` (add older ids with commas). The installer keeps these lines on update.
3. `sudo systemctl restart gsdn-pmis-api`
4. Rewrap: `sudo -u gsdn-pmis node /opt/gsdn-pmis/api/dist/documents/storage-cli.js rewrap` (repeats in batches until nothing is left).
5. `verify` (section 4, step 4). When `verify` is clean, the old key may be removed from `FILE_ENC_OLD_KEYS` only after a new backup has
   been taken (the backups still hold data keys wrapped with the old key).

The data keys of an object are wrapped with the key whose id is recorded on its envelope; a key that is missing from `FILE_ENC_OLD_KEYS`
makes those files unreadable (they fail loudly, they are not silently lost).

## 6. Restore drill

Run it every quarter (CLAUDE.md: restore drill every quarter) on a second machine or a scratch directory, never on the live store. Write the
result in `infra/restore-drill.md` (a dated entry with the snapshot id, the counts and the verify result).

a. Restore the newest snapshot into an empty directory with the restore script of the repository (a checkout of the same version, root,
   with the same `backup.env`):

```bash
sudo bash -c 'set -a; . /etc/gsdn-pmis/backup.env; set +a; RESTIC_PASSWORD_FILE=/etc/gsdn-pmis/restic.password \
  bash /opt/gsdn-pmis/pmis/infra/backup/files-restore.sh latest /var/restore/gsdn-files'
```

The restored tree keeps the absolute path of the backed-up directory (restic stores paths), so the files are under
`/var/restore/gsdn-files/<STORAGE_DIR path>` (or `<staging path>` for MinIO). Note the path that printed. The integrity anchors are in the same
tree under `<LOG_ANCHOR_DIR path>` (`anchor-audit.jsonl`, `anchor-security.jsonl`): the last line of each must carry the head hash that the System
Admins received by mail for that check.

```bash
b. Restore the database from the dump taken the same day (a scratch database, never the live one)
c. Verify the restored files against the restored database, with the same FILE_ENC_KEY:
sudo -u gsdn-pmis env STORAGE_DIR=/var/restore/gsdn-files/<path> DATABASE_URL=<scratch url> FILE_ENC_KEY=<key> \
  FILE_ENC_KEY_ID=k1 node /opt/gsdn-pmis/api/dist/documents/storage-cli.js verify
```

Pass: `verify` prints `{"checked":N,"bad":0}` and the file count of the snapshot equals N plus the number of plain legacy files. Fail:
any `BAD` line. A failed drill is a reportable incident: raise it at the next PMIS status meeting.

Time the drill. The RTO is 4 hours in working hours (CLAUDE.md); the drill records the minutes for restore, database and verify.

## 7. Scheduled jobs and logs

| Job | When (Africa/Tripoli) | Name in job_runs | What |
|---|---|---|---|
| Purge of expired zip exports | 03:00 | `storage_purge` | deletes the stored zip objects past `expires_at`, marks the rows purged |
| Malware rescan | 04:00 | `malware_rescan` | scans the files stored while clamd was down |
| Nightly backup (server time) | 02:30 | `files_backup` | restic snapshot and retention |

The API runs the first two when `JOBS_ENABLED` is on (the default outside tests). Their outcome is in Logs > Job runs; a failure is also in
the System Log. A malware detection is in Logs > Security alerts (rule `malware_upload`). The log of a refused upload is in the System Log
(source `storage`) and contains the storage key and the scanner's signature name, never the file.

Manual runs: `storage-cli.js purge-exports` and `storage-cli.js rescan` (same environment as the API).

## 8. Database backup (pgBackRest)

Owner answer Q196 (binding): base backups with continuous WAL (point-in-time recovery), pgBackRest as the extra logical copy, encrypted,
off the server, one copy in another building, and a tested restore. Q198 covers the keys (8.4). The scripts are in `infra/backup/`
(`db-backup.sh`, `db-backup-check.sh`, `db-dump.sh`, `db-restore.sh`, shared `db-common.sh`); the installer is
`tools/install/install-db-backup.sh`. Commands run on GSDN Workspace server as root unless they say `postgres`.

### 8.1 What is protected, and how

| Item | Setting | Meaning |
|---|---|---|
| Data loss (RPO) | `archive_timeout = 5min`, `archive_command` = `pgbackrest archive-push` | WAL is archived at least every 5 minutes; the alert fires after 20 minutes without an archive. Data newer than the last archived segment is not recoverable. |
| Base backup | full backup nightly at 02:00 to each daily repository (1 and 2) | A restore starts from the latest full backup before the target, then replays WAL. |
| Recovery time (RTO) | 4 hours in working hours | Timed in every drill (8.7). |
| Retention, daily | 14 full backups per daily repository (`repo-retention-full=14`) | pgBackRest expires older backups and their WAL. |
| Retention, weekly and monthly | 8 weekly and 12 monthly copies, **only when repositories 3 and 4 are configured** | Not in force until then (Q370). |
| Encryption | `aes-256-cbc` on every repository, one key per repository | Keys in `/etc/pgbackrest/conf.d/secret.conf` (8.4). |
| Logical copy | `pg_dump -Fc` nightly at 03:00 into a restic repository, retention 14/8/12 | An extra copy for single objects and a second route. Not the point-in-time base. |
| Alert | `gsdn-pmis-db-check.timer`, every 15 minutes | System Log row, source `backup`, level error; repeated at most every 6 hours while it lasts; an info row when it clears. |

Why pgBackRest and not WAL-G: one tool for posix, SFTP and S3/MinIO repositories; each repository is encrypted by the tool; retention is per
repository; WAL goes to every repository and archiving continues when one is down; `check` and `info --output=json` serve monitoring.
Ubuntu 24.04 package, pgbackrest 2.50 (the version tested).

### 8.2 Install, or change the targets

```bash
sudo bash pmis/tools/install/install-db-backup.sh
```

It asks for repository 1 (an absolute path on another disk of this server), repository 2 (the copy in another building:
`sftp:user@host:/path` or `s3:https://host:port/bucket`), the optional weekly and monthly copies, and the optional restic copy of the
pg_dump. It writes `/etc/pgbackrest/` and sets `wal_level`, `archive_mode`, `archive_timeout` and `archive_command` with `ALTER SYSTEM`.
**archive_mode needs a restart of PostgreSQL**, which drops every connection for a few seconds. Without `DB_BACKUP_RESTART=yes` the installer
stops after writing the configuration and prints the command; run it again afterwards. Then it runs `stanza-create` and `check`.

Non-interactive: `sudo env DB_BACKUP_REPO1=/mnt/backup-b/pgbackrest DB_BACKUP_REPO2=sftp:backup@other-building.example:/srv/pgbackrest DB_BACKUP_RESTART=yes bash pmis/tools/install/install-db-backup.sh`

Checks after the install:

```bash
sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=gsdn-pmis info
sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=gsdn-pmis check
sudo systemctl start gsdn-pmis-db-basebackup.service      # the first full backup now
sudo journalctl -u gsdn-pmis-db-basebackup -n 30 --no-pager
```

For an sftp repository the PostgreSQL user needs a key and a known host on the other building (set up by the network team): the private key
`/var/lib/postgresql/.ssh/pgbackrest_repo2` and `known_hosts` for user `postgres`. For S3/MinIO the installer asks once for the access key and
the secret key and stores them only in `conf.d/secret.conf`.

### 8.3 Daily use

- Logs > Job runs (`db_basebackup`, `db_dump`); Logs > System log, source `backup`, for alerts.
- A manual full or differential backup: `sudo -u postgres /usr/local/lib/gsdn-pmis/db-backup.sh full` (or `diff`).
- Backups and WAL ranges: `sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=gsdn-pmis info`.

### 8.4 Key custody (Q198)

Keep an offline copy of each file, in a sealed envelope or a two-person safe. Never in git, tickets, chats or support logs.

| File | Protects | Note |
|---|---|---|
| `/etc/pgbackrest/conf.d/secret.conf` | the cipher keys of every pgBackRest repository, and any S3 keys | Without them the backups cannot be read. Created once and never regenerated. |
| `/etc/pgbackrest/restic-db.password` | the pg_dump restic repository | Only when that copy is set up. |

Rules: a copy in the offline safe on the day the installer runs; two named people (custodian and alternate, pending Q196/Q198); every use
written in the operations record; a vault or KMS for production later (owner decision pending). Test the offline copy in the drill (8.7).
A pgBackRest cipher key is not rotated in place: add a new repository with a new key, or keep the old key until its backups have expired.

### 8.5 Point-in-time restore (into a scratch cluster, never the live one)

`db-restore.sh` restores into a new directory, starts a scratch server on another port, runs an optional verification SQL file and stops
the server. It refuses port 5432 and GSDN Workspace port, the live data directory, and any non-empty target.

```bash
sudo install -d -o postgres -g postgres /var/restore
sudo -u postgres /usr/local/lib/gsdn-pmis/db-restore.sh \
  --pgdata /var/restore/pmis-pgdata --port 55433 \
  --target-time '2026-11-04 10:15:00+02' \
  --verify-sql /var/restore/verify.sql          # optional
# --keep-running leaves the scratch server up; stop it with:
sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /var/restore/pmis-pgdata -m fast -w stop
```

Omit `--target-time` to recover to the end of the archived WAL. Pick the target from the operations record (the start of the incident, a
few minutes earlier). Restoring over the live database is a separate decision with the owner and the Project Manager; this runbook does not
do it. After any real cutover, take a fresh full backup at once (`db-backup.sh full`).

Points found in the test (keep them): the scratch server's `max_connections` and `max_worker_processes` must not be lower than the primary's,
or recovery refuses to start. The scratch configuration does not read the live `postgresql.conf` (its `external_pid_file` belongs to the live
server). The restored directory has no configuration files on Ubuntu, so the script writes its own.

### 8.6 Late-backup alert

`db-backup-check.sh` runs every 15 minutes and writes a System Log row (source `backup`, level error) when: archive_mode is off; no WAL was
archived for 20 minutes (`WAL_LATE_SECONDS`); the last archive attempt failed; a daily repository has no full backup for 26 hours
(`BACKUP_LATE_HOURS`); the weekly copy is older than 8 days or the monthly copy older than 32 days; the pg_dump copy is older than 26 hours;
or pgBackRest reports a stanza status other than 0. The row names the repository and the age. Response: read the PostgreSQL log
(`/var/log/postgresql/postgresql-16-main.log`), then `pgbackrest info` and `journalctl -u gsdn-pmis-db-basebackup`, fix the cause, and run the
backup by hand. This is a System Log row, not a security alert (Q370 asks whether it should also raise one).

### 8.7 Restore drill (quarterly, and before go-live)

1. Choose a recent target (for example two hours ago) and a scratch directory, preferably on another machine.
2. Put the key files from the offline copy on the drill machine only, never back on the live server.
3. Run 8.5 with a `--verify-sql` file that counts rows in two or three key tables and reads the latest audit row. Time the whole run.
4. Restore the same day's pg_dump from the restic copy into a second scratch database and compare row counts
   (`restic restore latest --tag db-dump --target <dir>`, then `pg_restore`).
5. Record the drill in `infra/restore-drill.md` (section "Database"). A pass needs matching rows at the target and a time within the RTO.

Before the first production run, the test harness runs on a throw-away cluster, never the live one. It needs root and PostgreSQL 16, uses
cluster `pmisbk` on port 55440 and the scratch restore on port 55441:

```bash
sudo bash pmis/infra/backup/test-db-backup.sh
```

### 8.8 Owner checklist (Q196, Q198)

Placeholders only. The owner fills them in before production; the repository does not decide them.

- [ ] Database and operations owner in IT: `<OWNER NAME>`, `<OWNER CONTACT>`.
- [ ] Alternate: `<ALTERNATE NAME>`, `<ALTERNATE CONTACT>`.
- [ ] Repository 1 (another disk on this server): `<REPO 1 PATH>`.
- [ ] Repository 2 in another building: `<REPO 2 DESTINATION>`, and who sets up its keys (network team).
- [ ] Weekly copy (8) and monthly copy (12): `<REPO 3 DESTINATION>`, `<REPO 4 DESTINATION>`, or drop them (Q370).
- [ ] pg_dump copy (restic): `<RESTIC DESTINATION>`.
- [ ] Key custodian and alternate for the pgBackRest and restic keys: `<CUSTODIAN>`, `<ALTERNATE>`; custody medium; vault or KMS for production (Q198).
- [ ] RTO 4 hours in working hours and RPO 15 minutes confirmed (the 5-minute archive timeout is the working value).
- [ ] Date of the first full restore drill: `<DATE>`.

Known limits: weekly and monthly copies are not enforced until repositories 3 and 4 exist; the alert is a System Log row only; the drill is
manual, not scheduled.

### 8.9 Other open items (files, from before)

- The PostgreSQL dump (pg_dump, nightly) and the WAL archive are now covered by 8 above; the owner checklist is 8.8.
- The objects are not written to a second building by the API; only the restic copy is. Q197 asks whether the MinIO bucket replication
  (ADR 0008 item 9) is set up by the network team.
- Object lock (governance mode) on the MinIO buckets is set on the server, not by the installer (Q133).

## 9. Session context key rotation (migration 0069, P1-DB-03)

The API signs the context of every database transaction with `PMIS_CONTEXT_KEY` (in `/etc/gsdn-pmis/pmis.env`); the database holds the same key in
`pmis_context_keys` and verifies each signature. Several keys can exist at the same time: the API signs with one, the database verifies with every key
that has not expired. That lets you rotate without downtime. Rotate once a year, after anybody who could read `pmis.env` leaves, and at once if the file
may have leaked. **Never print the key, paste it into a ticket or put it in a log.** All commands read it from a variable.

1. Make the new key and load it (`pmis` is the default database name; use the one you gave the installer). The old key keeps verifying for one hour, enough to restart the API:

       NEW=$(openssl rand -hex 32)
       printf "SELECT app_ctx_key_install('%s', interval '1 hour');\n" "$NEW" | sudo -u postgres psql -d pmis -qAt >/dev/null

2. Put the new key in `pmis.env` and restart the API (the sed replaces the line without showing it):

       sudo sed -i "s/^PMIS_CONTEXT_KEY=.*/PMIS_CONTEXT_KEY=$NEW/" /etc/gsdn-pmis/pmis.env
       sudo systemctl restart gsdn-pmis-api
       unset NEW

3. Check: sign in and open any list. A request fails with 500 and the System Log says "session context refused" if the two keys differ.
4. After a week, delete the expired key: `SELECT app_ctx_key_purge(interval '7 days');`.
5. If the key leaked: install a new one with `interval '0 seconds'` (the old one stops verifying at once; every request fails until the API restarts with the new
   one), then review the Audit Log and the security log for the period (the chains in Logs → Integrity).

A restore of the database from a backup made before the key existed has an empty `pmis_context_keys`: run `install-ubuntu.sh` again (it loads the key from
`pmis.env`), or `app_ctx_key_install` by hand as in step 1 with the key from `pmis.env`.
