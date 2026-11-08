#!/usr/bin/env bash
# GSDN Workspace: restore the stored files from the restic repository (owner answer Q134). Part of the restore drill (infra/RUNBOOK.md, section
# "Restore drill"); the drill record is in infra/restore-drill.md.
#
# Usage:   files-restore.sh <snapshot-id|latest> <empty-target-directory>
# Example: files-restore.sh latest /var/restore/gsdn-files
#
# It restores into the target directory, which must be empty or absent. It never writes to STORAGE_DIR or the bucket: after the restore,
# copy the tree back (or mount it) under the API's control, then run the verification in the runbook:
#   node dist/documents/storage-cli.js verify      (with the database restored from its dump, the same FILE_ENC_KEY)
# A restore is complete only when verify reports bad=0.
set -euo pipefail

SNAP=${1:-}
TARGET=${2:-}
[[ -n $SNAP && -n $TARGET ]] || { echo "usage: files-restore.sh <snapshot-id|latest> <empty-target-directory>" >&2; exit 2; }
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is not set}"
[[ -r $RESTIC_PASSWORD_FILE ]] || { echo "files-restore: cannot read $RESTIC_PASSWORD_FILE" >&2; exit 1; }
command -v restic >/dev/null || { echo "files-restore: restic is not installed" >&2; exit 1; }
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

if [[ -e $TARGET ]]; then
  [[ -d $TARGET ]] || { echo "files-restore: $TARGET is not a directory" >&2; exit 1; }
  if [[ -n $(ls -A "$TARGET") ]]; then
    echo "files-restore: $TARGET is not empty; choose an empty directory so nothing is overwritten" >&2
    exit 1
  fi
else
  mkdir -p "$TARGET"
fi

restic snapshots --tag files --json "$SNAP" >/dev/null 2>&1 || { echo "files-restore: snapshot $SNAP not found" >&2; exit 1; }
restic restore "$SNAP" --tag files --target "$TARGET"
FILES=$(find "$TARGET" -type f | wc -l)
BYTES=$(du -sb "$TARGET" | cut -f1)
echo "files-restore: restored $FILES files ($BYTES bytes) from snapshot $SNAP into $TARGET"
echo "files-restore: next, verify against the restored database (see infra/RUNBOOK.md, Restore drill)"
