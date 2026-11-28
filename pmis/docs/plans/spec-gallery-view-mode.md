# Spec: Gallery view mode in the Layout panel

Status: DRAFT-SPEC. This PR holds the agreed details only. Code is built into this same PR later.

## Agreed requirements
- The media gallery gets a view mode (grid or list) chosen in the Layout panel and kept per user.
- Check PR #361 first for an existing Layout panel mechanism and reuse it.

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
- Which modes are wanted and whether the choice is a saved-view field.
