# GSDN PMIS: runbook

This runbook covers the storage protection of uploaded files (owner answer Q134; ADR 0008, amendment 2026-11-02). Every command runs on the
PMIS server as root unless it says otherwise. Secrets are read from `/etc/gsdn-pmis/pmis.env` and `/etc/gsdn-pmis/backup.env`; never paste
them into a ticket or a chat.

Sections: 1 what is protected and how, 2 enable ClamAV, 3 backup target, 4 re-encrypt existing files, 5 key rotation, 6 restore drill,
7 scheduled jobs and logs, 8 open items.

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
`/var/restore/gsdn-files/<STORAGE_DIR path>` (or `<staging path>` for MinIO). Note the path that printed.

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

## 8. Open items

- The PostgreSQL dump (pg_dump, nightly) and the WAL archive are not in this repository yet. Q196 asks who runs them.
- The objects are not written to a second building by the API; only the restic copy is. Q197 asks whether the MinIO bucket replication
  (ADR 0008 item 9) is set up by the network team.
- Object lock (governance mode) on the MinIO buckets is set on the server, not by the installer (Q133).
