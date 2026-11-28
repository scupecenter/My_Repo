# Phase 4 acceptance pack: built
Status: built in this PR (no migration, contract 0.15.472). Follows `2026-11-27-spec-phase4-acceptance-pack.md`.
- `POST /exports/zip` takes `pack: acceptance` with `site_id` only. Same zip job, region scope, virus-scan rule, audit and export lock; no new dependency, no public link.
- Included: approved current files whose document type code is PAC, FAC or HOTO (also with a prefix or suffix such as B13_PAC). Folder per document type, `INDEX.txt` (English and Arabic), `manifest.csv`.
- Web: button on the site Documents tab, labels in English and Arabic, mock, test. Docs: customer page and README row.
- Places covered: Documents tab, zip job, audit, export lock. Excluded: Settings, matrix, lookups, filters, dashboards, notifications, search (nothing new to configure; rights are the existing download right).
