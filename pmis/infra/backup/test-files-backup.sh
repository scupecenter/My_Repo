#!/usr/bin/env bash
# GSDN PMIS: smoke test of files-backup.sh with a fake restic (no repository, no network, no database).
# Checks that the integrity anchor directory (LOG_ANCHOR_DIR, Q257) travels in the same snapshot as the stored files, and that a missing or unset
# directory is noted without stopping the backup.
#
# Usage: bash infra/backup/test-files-backup.sh      (exit 0 = every check passed)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/files-backup.sh"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/files" "$W/anchors"
echo x >"$W/anchors/anchor-audit.jsonl"
echo pw >"$W/pw"
cat >"$W/bin/restic" <<'EOF'
#!/usr/bin/env bash
echo "$@" >>"$FAKE_RESTIC_LOG"
case "$1" in
  cat | forget) exit 0 ;;
  backup) echo '{"message_type":"summary","total_files_processed":2}'; exit 0 ;;
esac
EOF
chmod +x "$W/bin/restic"
export PATH="$W/bin:$PATH" FAKE_RESTIC_LOG="$W/log" RESTIC_REPOSITORY="$W/repo" RESTIC_PASSWORD_FILE="$W/pw" STORAGE_DIR="$W/files"
unset S3_ENDPOINT DATABASE_URL LOG_ANCHOR_DIR 2>/dev/null || true
fail=0
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

: >"$W/log"
LOG_ANCHOR_DIR="$W/anchors" bash "$SCRIPT" >/dev/null 2>"$W/err"
if grep -q "^backup .* $W/files $W/anchors\$" "$W/log"; then ok "the anchor directory is a second path of the snapshot"; else bad "the anchor directory is a second path of the snapshot"; fi

: >"$W/log"
bash "$SCRIPT" >/dev/null 2>"$W/err"
if grep -q "^backup .* $W/files\$" "$W/log" && grep -q "LOG_ANCHOR_DIR is not set" "$W/err"; then ok "no LOG_ANCHOR_DIR: the files alone, with a note"; else bad "no LOG_ANCHOR_DIR: the files alone, with a note"; fi

: >"$W/log"
LOG_ANCHOR_DIR="$W/missing" bash "$SCRIPT" >/dev/null 2>"$W/err"
if grep -q "^backup .* $W/files\$" "$W/log" && grep -q "does not exist yet" "$W/err"; then ok "a missing anchor directory is noted and the backup is still taken"; else bad "a missing anchor directory is noted and the backup is still taken"; fi

exit $fail
