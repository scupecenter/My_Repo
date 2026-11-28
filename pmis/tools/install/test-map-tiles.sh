#!/usr/bin/env bash
# Checks of install-map-tiles.sh that need no root and no network: the tile counts and the dry run. Run: bash pmis/tools/install/test-map-tiles.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(bash "$here/install-map-tiles.sh" --list)"
grep -qx 'total: 11084 tiles' <<<"$out" || { echo "FAIL: expected 11084 tiles for zoom 5 to 11" >&2; echo "$out" >&2; exit 1; }
grep -qx 'zoom 11: 8280 tiles' <<<"$out" || { echo "FAIL: zoom 11 count" >&2; exit 1; }
dry="$(bash "$here/install-map-tiles.sh" --dry-run --dir "$(mktemp -d)/tiles")"
grep -q 'Nothing changed' <<<"$dry" || { echo "FAIL: dry run must change nothing" >&2; exit 1; }
if bash "$here/install-map-tiles.sh" --zoom-max 20 >/dev/null 2>&1; then echo "FAIL: zoom-max 20 must be refused" >&2; exit 1; fi
echo "OK: map tile installer checks passed"
