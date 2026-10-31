#!/usr/bin/env bash
# GSDN PMIS: update an existing installation to the latest code, without questions.
# Pulls the branch, applies new migrations, rebuilds and restarts the API and the web app. Data and settings are kept.
#   sudo bash pmis/tools/install/update.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
[[ -r /etc/gsdn-pmis/install.conf ]] || { echo "No previous installation found. Run: sudo bash pmis/tools/install/install-ubuntu.sh" >&2; exit 1; }
cd "$REPO"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "==> Pulling $BRANCH"
git pull --ff-only origin "$BRANCH"
git log --oneline -1
# The installer may have changed in this pull: run the new copy.
exec bash "$REPO/pmis/tools/install/install-ubuntu.sh" --update
