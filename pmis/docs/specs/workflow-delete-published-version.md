# [DRAFT-SPEC] Delete an old published workflow version (restorable)

Status: spec only, no code yet. The build goes into this same PR.

## Agreed requirements
Change the 0008 workflow_definitions_guard narrowly: a published version may be deleted only if (a) it is not the current published version, (b) no site is on it and no history or migration depends on it (otherwise block with a clear reason), (c) the caller has workflow.publish-level permission, a password step-up and a mandatory reason, and an audit row is written, (d) a full snapshot of the version is archived before the delete so it can be restored. Everything else about the guard stays. UI: a 'Delete version' action in the Workflow Studio version list as a small isolated component/dialog (the Studio redesign is another agent's PR; the plug-in point is reported). Tests EN and AR, docs.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Ahmed, relayed by the parent 2026-11-27 20:35.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (verify live against main and open PRs before use)
- Migration: 0557 or higher / db 556 or higher (Studio redesign takes 0556)
- Contract label: 0.15.380 or higher
