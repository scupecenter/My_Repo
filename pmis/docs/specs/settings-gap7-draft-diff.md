# Settings gap 7: item-level draft vs active diff before publish

Status: built in this PR (contract 0.15.434, no migration).

## Agreed requirements
The weights preview shows per-activity progress delta only. Add an item-level diff (weight, name, unit, measure rule: changed, added, removed) between the draft and the set in force, in the same preview dialog, before publish. Read only. Coordinate with #458 (calibration) and #471 (measure rule editor) which touch the same dialog and screen.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 7.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: none (computed in the web from the saved draft and the set in force; no new endpoint)
- Contract label: 0.15.434

## Built
- Settings > Weights > Preview shows a "Changes against the set in force" list under the progress figure: added, removed and changed activities and items (name, weight, unit, measure rule), with the before and after of each changed field. Empty set of differences shows a plain note.
- Worked out in `lib/weightDiff.ts` from the saved draft and the published set in force (same code); the preview already runs on the saved draft. Read only, no write, no new route, so no mock or route-list change.
- Nothing is stored. EN and AR keys under `wtSet`. Coordination: the measure rule editor (#471, merged) is untouched; the calibration PR (#458) is not in the dialog.
