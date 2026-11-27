# Spec: Decision-32 photo slots

Status: DRAFT-SPEC. This PR holds the agreed details only. Code is built into this same PR later.

## Agreed requirements
Decision 32, approved by the project lead 2026-11-27 10:29.
- Add a photo field in five places that have none today:
  1. Warehouse: material condition at receipt and at returns.
  2. Demolition: before and after.
  3. HOTO handover.
  4. Field visits and daily reports.
  5. HSE safety and incidents.
- Configurable in Settings, per place: photos mandatory or optional, and the minimum number of photos.
- The photos appear automatically in the Gallery (no manual step).
- Everything already stored in the unified documents system is covered by the Gallery automatically: site and phase acceptance, QC notes, advance payment proof, invoices, minutes, site permits, delivery notices.

## Standing rules that apply
- No isolated feature: connect it to search, filters, saved views, audit, permissions, export, the data-reset plan and Settings.
- Anything configurable goes in Settings.
- Every screen follows the UI standards; a real-stack EN and AR walkthrough with screenshots is required for UI work.
- Additive migrations only. Hide, never delete. No new table without an entry in the data-reset plan.
- No new dependencies. No CHANGELOG.md edit and no openapi version-line edit; the changelog entry, contract version and migration number go in the PR body.

## Source
Brief from the project lead relayed 2026-11-27 11:03 (Africa/Tripoli); list named as "next PRs" in the gallery web PR body (#364); order to implement all remaining work 2026-11-27 19:06; spec PR requested 2026-11-27 21:36.

## Numbering reserved
Migration: 0470-0489 range (assigned 2026-11-27 19:09). Take the next free number inside it at build time; re-check live before merge.

## Open details to confirm before build
- None for the requirement itself. Per-place field names and where the Settings screen sits are decided at build, following the existing Settings pattern.
