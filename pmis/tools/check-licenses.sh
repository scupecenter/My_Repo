#!/usr/bin/env bash
# License gate for the packages that ship at run time (production dependencies of the API and the web app).
# Needs `npm ci --ignore-scripts --omit=dev` to have run in apps/api and apps/web. Fails on any license that is not on the allowlist.
# The packages of this repository carry no license field on purpose (see LICENSE) and are excluded by name.
# Reviewed exceptions: buffers@0.1.1 declares no license in its package (it is pulled in by exceljs); see THIRD_PARTY_NOTICES.md.
# duck@0.1.12 declares the license "BSD" without a clause count; its LICENSE file is the 2-clause BSD text (pulled in by mammoth > lop, API only).
set -euo pipefail
cd "$(dirname "$0")/.."
allow='MIT;MIT*;ISC;Apache-2.0;BSD-2-Clause;BSD-3-Clause;0BSD;Unlicense;(MIT AND Zlib);(MIT OR GPL-3.0-or-later);OFL-1.1'
skip='@gsdn/pmis-api@0.1.0;@gsdn/pmis-web@0.1.0;buffers@0.1.1;duck@0.1.12'
for app in api web; do
  echo "== apps/$app"
  (cd "apps/$app" && npx --yes license-checker-rseidelsohn@4.3.0 --production --onlyAllow "$allow" --excludePackages "$skip" --summary)
done
