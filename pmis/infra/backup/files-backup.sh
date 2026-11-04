#!/usr/bin/env bash
# GSDN PMIS: nightly backup of the stored files (owner answer Q134), with restic.
#
# What it backs up: the local document directory (STORAGE_DIR), or the MinIO bucket (S3_*), copied first to a staging directory with `mc mirror`.
# Every object is already encrypted by the API (FILE_ENC_KEY); restic encrypts the repository again, with its own password.
# Retention: 14 daily, 8 weekly, 12 monthly snapshots (CLAUDE.md, non-functional requirements). One copy goes to another building: point
# RESTIC_REPOSITORY at that building (sftp:user@host:/path or a mounted share); the repository password is kept offline as well.
#
# The log anchors (Q257, technical decision 2026-11-04): LOG_ANCHOR_DIR holds the chain heads that the nightly integrity check appends (anchor-audit.jsonl,
# anchor-security.jsonl). It is copied in the same snapshot, so the reference that shows a rewrite of the Audit Log chain also exists off the server, where
# the database cannot rewrite it. Skipped (with a note) when LOG_ANCHOR_DIR is not set or does not exist yet.
#
# Each run writes a job_runs row (name files_backup) through job_run_start and job_run_finish, as the API's own jobs do.
#
# Configuration (environment, normally /etc/gsdn-pmis/backup.env and /etc/gsdn-pmis/pmis.env; never in the repository):
#   RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE           where and how the repository is encrypted
#   STORAGE_DIR                                        local disk store (when S3_ENDPOINT is not set)
#   LOG_ANCHOR_DIR                                     the integrity anchor files, copied in the same snapshot (optional; /etc/gsdn-pmis/pmis.env sets it)
#   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY   MinIO store (all four)
#   DATABASE_URL                                       the pmis_app URL, only to write the job_runs row (optional)
#   FILES_BACKUP_STAGING                               scratch directory for the MinIO copy (default /var/tmp/gsdn-pmis-files-staging)
#
# Usage: files-backup.sh            (run by gsdn-pmis-files-backup.timer)
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is not set}"
[[ -r $RESTIC_PASSWORD_FILE ]] || { echo "files-backup: cannot read $RESTIC_PASSWORD_FILE" >&2; exit 1; }
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

STAGING=${FILES_BACKUP_STAGING:-/var/tmp/gsdn-pmis-files-staging}
RUN_ID=''
SUMMARY_FILE=$(mktemp)
trap 'rm -f "$SUMMARY_FILE"' EXIT

# record OUTCOME ROWS ERROR DETAIL_JSON: closes the job_runs row. Never fails the backup itself.
record() {
  [[ -n $RUN_ID && -n ${DATABASE_URL:-} ]] || return 0
  psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -v id="$RUN_ID" -v outcome="$1" -v rows="${2:-}" -v err="${3:-}" -v detail="${4:-}" >/dev/null 2>&1 <<'SQL' || true
SELECT job_run_finish(:'id'::uuid, :'outcome'::text, nullif(:'rows', '')::bigint, nullif(:'err', ''), nullif(:'detail', '')::jsonb);
SQL
}

fail() {
  echo "files-backup: $*" >&2
  record failed "" "$*" ""
  exit 1
}

if [[ -n ${DATABASE_URL:-} ]] && command -v psql >/dev/null; then
  RUN_ID=$(psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -v name=files_backup -v host="$(hostname)" 2>/dev/null <<'SQL' || true
SELECT job_run_start(:'name'::text, :'host'::text);
SQL
)
fi

command -v restic >/dev/null || fail "restic is not installed (the installer's file backup step installs it)"

SOURCE=''
if [[ -n ${S3_ENDPOINT:-} ]]; then
  : "${S3_BUCKET:?S3_BUCKET is not set}" "${S3_ACCESS_KEY:?S3_ACCESS_KEY is not set}" "${S3_SECRET_KEY:?S3_SECRET_KEY is not set}"
  command -v mc >/dev/null || fail "mc (MinIO client) is not installed"
  # mc reads its alias from MC_HOST_<alias>; the credentials stay in this process environment only.
  scheme=${S3_ENDPOINT%%://*}
  rest=${S3_ENDPOINT#*://}
  export MC_HOST_pmis="${scheme}://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@${rest}"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  chmod 700 "$STAGING"
  mc mirror --quiet "pmis/${S3_BUCKET}" "$STAGING" >/dev/null || fail "mc mirror from the bucket failed"
  SOURCE=$STAGING
else
  : "${STORAGE_DIR:?STORAGE_DIR is not set (or S3_ENDPOINT for MinIO)}"
  [[ -d $STORAGE_DIR ]] || fail "$STORAGE_DIR does not exist"
  SOURCE=$STORAGE_DIR
fi

# The integrity anchors travel with the files (Q257): a second path of the same snapshot.
SOURCES=("$SOURCE")
if [[ -n ${LOG_ANCHOR_DIR:-} ]]; then
  if [[ -d $LOG_ANCHOR_DIR ]]; then
    SOURCES+=("$LOG_ANCHOR_DIR")
  else
    echo "files-backup: LOG_ANCHOR_DIR $LOG_ANCHOR_DIR does not exist yet: the anchors are not in this snapshot" >&2
  fi
else
  echo "files-backup: LOG_ANCHOR_DIR is not set: the integrity anchors are not in this snapshot" >&2
fi

# A repository that does not exist yet is created here; the password file must already be in place.
if ! restic cat config >/dev/null 2>&1; then
  restic init >/dev/null 2>&1 || fail "restic init failed (check RESTIC_REPOSITORY and the password file)"
fi
if ! restic backup --tag files --tag daily --host "$(hostname)" --json "${SOURCES[@]}" >"$SUMMARY_FILE" 2>/dev/null; then
  [[ $SOURCE == "$STAGING" ]] && rm -rf "$STAGING"
  fail "restic backup failed"
fi
restic forget --tag files --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune >/dev/null || fail "restic forget (retention) failed"
[[ $SOURCE == "$STAGING" ]] && rm -rf "$STAGING"

FILES=$(tail -n 1 "$SUMMARY_FILE" | sed -n 's/.*"total_files_processed":\([0-9]*\).*/\1/p')
echo "files-backup: snapshot taken; retention 14 daily, 8 weekly, 12 monthly applied"
record ok "${FILES:-0}" "" "{\"retention\":\"14d/8w/12m\",\"paths\":${#SOURCES[@]}}"
