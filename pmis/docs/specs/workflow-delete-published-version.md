# Delete an old published workflow version (restorable)

Status: built in this PR (contract 0.15.436, migration 0575, mirror `db/sql/574_workflow_version_delete.sql`).

## Agreed requirements
Change the 0008 workflow_definitions_guard narrowly: a published version may be deleted only if (a) it is not the current published version, (b) no site is on it and no history or migration depends on it (otherwise block with a clear reason), (c) the caller has workflow.publish-level permission, a password step-up and a mandatory reason, and an audit row is written, (d) a full snapshot of the version is archived before the delete so it can be restored. Everything else about the guard stays. UI: a 'Delete version' action in the Workflow Studio version list as a small isolated component/dialog (the Studio redesign is another agent's PR; the plug-in point is reported). Tests EN and AR, docs.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Ahmed, relayed by the parent 2026-11-27 20:35.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: 0575 / db 574 (guard patch, archive table, reset plan; live-scanned free on main and all open PRs 2026-11-28 08:58)
- Contract label: 0.15.436

## Built
- `POST /workflow/versions/{version}/delete`: `workflow_versions` administer for all regions (the publish right), reason, `If-Match`, password step-up, typed confirmation `v<version>`, audit `workflow_version_delete`.
- Allowed only for a published version that is not the one in force, has started, has no site, no site task and no site migration; otherwise 409 `invalid_transition` naming the reason.
- (d) `workflow_version_archive` gets one jsonb snapshot first (version row, milestones, gates, tasks, predecessors, matrix cells, SLA rules, rule set items, placements, scenario rules, streams, views, view members); the delete runs in the same transaction. A configuration table (kept on a data reset; listed in `data_reset_plan()`).
- Guard change (narrow): `workflow_definitions_guard` and the delete branch of the milestone, gate and task guards let a delete through only while `wf_version_delete_open(version)` is true, which holds only inside the transaction that archived that version, and (for the version row) only when it is not the version in force and no site is on it. Updates, inserts and every other rule are untouched.
- UI: `studio/OldVersions.tsx`, one isolated card, mounted by one line in `Studio.tsx` (`{one.data.can_publish && <OldVersions />}`) under the Studio body; lists published versions that are not in force, a Delete button per version (disabled when a site is on it), a dialog with the reason, the typed `v<n>` and the step-up the client opens itself.
- Not built: a one-click restore. The snapshot holds every row, so a restore can be written later without losing anything; none is claimed here.
