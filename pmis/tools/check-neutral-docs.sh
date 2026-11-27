#!/usr/bin/env bash
# Fails when a live doc names the country, the customer project, the former platform or a competitor tool.
# Live docs only: CHANGELOG, migrations, owner-answer logs, the reference and plans folders are the record and are not scanned.
# Region names and the register key are product data and are not scanned. Real file names (GSDN_*.html, gsdn-pmis) are ignored.
set -euo pipefail
cd "$(dirname "$0")/.."
words='Libya|Libyan|ليبيا|الليبي|GSDN|Africa/Tripoli|ClickUp|Smartsheet|Asana|Procore|Primavera|Airtable|Jira'
files=$(ls CLAUDE.md HANDOVER.md ORCHESTRATION.md ../SECURITY.md ../CONTRIBUTING.md README_AR.md ../.github/PULL_REQUEST_TEMPLATE.md infra/*.md apps/api/README.md apps/api/.env.example apps/web/README.md 2>/dev/null; find docs/customer docs/ops docs/spec docs/test-plans -name '*.md' ! -name 'owner-answers-*' ! -name 'technical-decisions-*' | sort)
bad=0
for f in $files; do
  hits=$(sed -E 's/GSDN[_-][A-Za-z0-9_.-]*//g; s#/etc/gsdn-pmis[A-Za-z0-9_./-]*##g' "$f" | grep -nE "$words" || true)
  if [ -n "$hits" ]; then echo "$f"; echo "$hits" | head -5; bad=1; fi
done
[ "$bad" = 0 ] && echo "neutral docs: ok" || { echo "A live doc names a country, project, platform or tool. Use a neutral word."; exit 1; }
