# ADR 0010: Versioned workflow definition (milestones, gates, stage membership)

- Status: Proposed, 2026-10-25. It records the owner decision of 2026-10-25, which supersedes "milestones and gates are fixed". The schema is being reworked by database-engineer (item 7). Items 5 and 6 carry risks the owner must accept (gate report, R-01 to R-05).
- Related: CLAUDE.md "Milestones and phase gates are configurable by the admin", "Rollout" (parallel run, 100% milestone match); rules.md §2 and §6; ADR 0004 (engine), 0005 (templates and Master export), 0007 (snapshot-on-open) and 0009 (task definitions). It supersedes the `stage_definitions_protect` and `phase_gate_rules_protect` triggers of migration 0007.

## Context
The 10 milestones and 9 gates are now seed version 1 of an admin-configurable **workflow definition**.
- **Light changes** apply at once: names, custom fields on milestones and gates, gate conditions, gate SLA, and whether a milestone counts in Project Status.
- **Structural changes** publish a new version, with a reason and step-up: adding, removing or reordering milestones or gates, and moving tasks between stages.
- New sites take the new version. Open sites migrate only when the admin chooses, per site or in bulk, after a preview.
- Stable codes protect history. Each milestone and gate carries its Master export column.
- During the parallel-run month, changes that affect the Master export need explicit confirmation.

## Decision
1. **Model** (names are proposals for database-engineer):
   - `workflow_versions`: number, status (`draft`, `published`, `retired`), `reason`, `published_by`, `published_at`, `parent_version_id`, and a `light_revision` counter.
   - `workflow_milestones`: version, **stable `code`** (seed `MS1`..`MS10`, from the catalogue), `seq`, `name_en`/`name_ar`, `master_export_column`, `counts_in_project_status`, `canonical_seq`, and `formula_kind`. `formula_kind` is `master` for the seeded ten, whose Master formulas are implemented in code, or `generic`.
   - `workflow_gates`: version, stable `code` (seed `G2`..`G10`), from and to milestone codes, `conditions` (a list of condition items, item 3), `sla_rule` (a gate SLA, as an SLA row with a gate `start_event`), and `master_export_column`.
   - `workflow_task_placements`: version, `task_def_id`, milestone/stage code, `sort_order`, and predecessors (moving `task_predecessors` into the version).
   - `sites.workflow_version_id`: NOT NULL, set at creation to the current published version, and changed only by the migration function (item 5).
   - `site_workflow_migrations`: site, from and to versions, the preview hash, actor, reason, before and after dates of the milestones and gates, and `reverted_at`.
   - Codes are unique across all versions, are never reused, and never change. A renamed milestone keeps its code.
2. **Light and structural changes.**
   - **Light** changes edit the published version in place. They bump `light_revision`, write an audit row with before and after values, and apply from the next calculation.
   - A changed **gate condition** applies only to gates **not yet open**. A gate that is already open keeps its date, and an achieved milestone keeps its date. Re-evaluating an achieved date is an admin override (ADR 0004 §10), never a side effect.
   - **Structural** changes are made only in a `draft` copy, then published with a reason and step-up.
   - **Publish validation.** Publishing is refused unless all of these hold:
     - the order and graph are acyclic;
     - every active task is in exactly one stage;
     - every gate links two consecutive milestones;
     - every `generic` milestone has at least one counting task;
     - every stage has a complete matrix for its levels;
     - Master columns are unique and do not collide with other columns;
     - every active weight set and SLA rule refers only to codes that exist, or the publish dialog lists the codes that are missing.
3. **Calculation.** The calculation service evaluates each site **against its own version**.
   - A seeded milestone (`master`) keeps the rules.md §2 formula, including the cluster rule for KPI Acceptance and the RFI special task.
   - A `generic` milestone is the latest approved date of its counting tasks (ADR 0009 §3c).
   - A gate = MAX(previous milestone in the version order, the dates of its condition items).
     - Condition items have the type `milestone`, `task`, `permit` (with the D36 N/A rule), `date_field` or `stop_work_blocks`.
     - The suspension shift of rules.md §2.3 applies to every gate.
     - The Master extra conditions of §2.2 become seed condition items, so they are now data.
4. **Comparing sites on different versions: stable codes everywhere.**
   - **KPIs and the dashboard** group by milestone or gate **code**, never by position.
     - The dashboard pipeline shows the union of the milestones of every version in use, ordered by `canonical_seq`.
     - A site whose version lacks a node counts as "not in workflow" for that node: it is outside that node's denominator, and it is distinct from N/A.
     - Each tile shows "versions in scope: v1 (140 sites), v2 (10 sites)" when more than one version is in use.
   - **Project Status.** Weight items refer to task, milestone or field codes.
     - For a site whose version lacks the source, the item has no applicable units for that site. The existing rules.md §6 redistribution then applies. This is the same mechanism as out-of-scope work, so no new formula is needed.
     - A milestone with `counts_in_project_status = false` behaves the same way.
     - Weekly `progress_snapshots` store the workflow version per site, so old reports are not affected.
   - **SLA** rules and **baselines** are keyed by codes (`baseline_entries.milestone_code` already is). A new milestone has no baseline until a Baseline Re-plan, so it is excluded from baseline adherence (health factor B).
5. **Master-format export and the parallel run.**
   - The Master has fixed columns for the 10 milestones, 9 gates and their baselines.
   - The export writes each milestone and gate at its `master_export_column`. A node without a column is **not exported** and is listed in the export's "PMIS-only" sheet.
   - A Master column whose node is missing from the site's version is exported **blank**, and the comparator marks it "expected difference (workflow vN)" instead of a mismatch.
   - Any light or structural change that touches a node with a Master column, or a gate condition that differs from the Master formula, shows a warning.
   - From `parallel_run_start` to `parallel_run_end` (settings), the warning needs an explicit typed confirmation, recorded in the audit row.
   - **Recommendation:** freeze structural publishes during the pilot and the parallel run, because the acceptance criterion "100% of milestone dates match" cannot hold for a site on a changed version.
6. **Site migration.** It is explicit, previewed and audited.
   - `POST /workflow/versions/{v}/migration-preview` with a site list or filter returns, per site:
     - tasks kept (matched by task code; state, dates, documents and history are kept even if the task changes stage);
     - tasks added (they are created and then unlocked by the normal rules, so they may open at once if their predecessors are already approved);
     - tasks retired (only in the old version): approved ones stay as history with the mark "retired in vN" and stop counting; unapproved ones go to state `retired`, with values and files kept and nothing deleted;
     - the milestone and gate dates before and after.

     The preview has a hash.
   - `POST /workflow/versions/{v}/migrations` with the preview hash, a reason and step-up runs in a job, one transaction per site, through a definer function (`admin_migrate_site_workflow`, checked with `app_actor_is_admin('workflow.migrate')`). A stale hash returns 409, and the admin must preview again.
   - **Blockers.** A site is skipped and listed when:
     - a task in `in_review` or `in_approval` would change stage, or would be retired;
     - the site is `completed` or `cancelled`, unless an admin override is given.
   - **Never changed by a migration:** approved dates, approved documents and workflow history. SLA snapshots of existing instances stay; new instances take their snapshot at open (ADR 0007).
   - **Revert.** A site can be migrated back to its previous version only while no task has been approved since the migration. Otherwise it returns 409 `migration_not_revertible`.
   - Sites never change version silently. Nothing but this function writes `sites.workflow_version_id`, and a trigger enforces it.
7. **Templates.** A structural publish bumps `TPL-SITE` and every other template whose columns depend on tasks. An uploaded row for a task that is not in the site's version is a row error: `task_not_in_site_workflow`.
8. **Roles are admin-defined** (same owner decision). This is covered in ADR 0003 §2 and ADR 0009 §5. A stage's matrix cells may only hold roles with `can_hold_matrix_levels`.

## Consequences
- The calculation service becomes data-driven for gates, which is good for testing (condition items are explicit). The seeded ten milestones still need code formulas, so two calculation paths exist: `master` and `generic`.
- Mixed-version portfolios make every KPI query join through the site's version. This is acceptable at 1000 sites; the engine caches each version's graph.
- The ADR 0004 engine reads predecessors from the site's version (amended in 0004 §1).
- The 0007 triggers that freeze `stage_definitions` and `phase_gate_rules` must be replaced by version-level immutability: published structural content is frozen, and light fields are editable with an audit row.
