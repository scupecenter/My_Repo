#!/usr/bin/env bash
# GSDN Workspace: update an existing installation to the latest code, without questions.
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
# 0074 (CHANGELOG 106): raise proxy_read_timeout of GSDN Workspace site to at least 300 s, also when the installer below stops early. Only that directive, only
# when it is lower; the file is put back when nginx -t refuses the result, and nginx is reloaded only after a good test. Running it again changes nothing.
patch_nginx_timeout() {
  local site=/etc/nginx/sites-available/gsdn-pmis want=300 backup
  [[ -f $site ]] && command -v nginx >/dev/null 2>&1 || return 0
  # shellcheck disable=SC2016
  awk -v w="$want" 'match($0, /^[[:space:]]*proxy_read_timeout[[:space:]]+[0-9]+s?;/) { v = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", v); if (v + 0 < w) found = 1 }
    END { exit !found }' "$site" || return 0
  backup=$(mktemp)
  cp -p "$site" "$backup"
  # shellcheck disable=SC2016
  awk -v w="$want" '{
    if (match($0, /^[[:space:]]*proxy_read_timeout[[:space:]]+[0-9]+s?;/)) {
      v = substr($0, RSTART, RLENGTH); n = v; gsub(/[^0-9]/, "", n)
      if (n + 0 < w) { ind = v; sub(/proxy_read_timeout.*/, "", ind); $0 = ind "proxy_read_timeout " w "s;" substr($0, RSTART + RLENGTH) }
    }
    print
  }' "$backup" > "$site"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || true
    echo "==> nginx: proxy_read_timeout raised to ${want}s in $site"
  else
    cp -p "$backup" "$site"
    echo "WARNING: nginx refused the raised proxy_read_timeout; $site was put back unchanged." >&2
  fi
  rm -f "$backup"
}
patch_nginx_timeout

# The installer may have changed in this pull: run the new copy.
exec bash "$REPO/pmis/tools/install/install-ubuntu.sh" --update
