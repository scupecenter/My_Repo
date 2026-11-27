# [DRAFT-SPEC] Settings gap 6: visible change log for Dashboard and Goals settings

Status: spec only, no code yet. The build goes into this same PR.

## Agreed requirements
Dashboard and Goals settings show only a version number and the last editor. Add an audit list (who, when, reason, what changed) for both, reusing the weight-set versions table pattern and the audit rows already written; read only, same rights as the settings screen.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 6.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: none expected (reads the audit); if a read function is needed: 0573 / db 572
- Contract label: 0.15.433
