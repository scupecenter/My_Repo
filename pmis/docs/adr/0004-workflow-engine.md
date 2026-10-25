# ADR 0004: Workflow engine: a state machine driven by the matrix

- Status: Proposed. Items 5c, 6b and 3 (level freeze point) need confirmation from the product owner (gate report, questions B5–B7).
- Related: CLAUDE.md "Workflow rules", "Groups", "Admin overrides"; rules.md §2.2 and §10; stories WF-01..WF-11, MX-01..MX-06; schema `task_instances`, `workflow_steps`, `matrix_cells`, `matrix_cell_assignees`.

## Context
Every task goes Entry → Review → Approve. The number of levels can be set per stage (default 3). The Responsibility Matrix decides who holds each level. When one person holds two consecutive levels, the second level is skipped and the skip is logged. Groups are claimed by the first member to act, unless a cell says "all must approve". A rejection goes back one level and carries a note. Batch rows can be approved row by row or all at once. An admin can override anything, with a reason and step-up.

## Decision
1. **One engine, in the API (`apps/api/src/workflow`).** Each transition runs in one transaction:
   - `SELECT … FOR UPDATE` on the task;
   - check `version` against the request's `If-Match`;
   - apply the transition;
   - insert a `workflow_steps` row and an `audit_log` row;
   - bump `version`;
   - enqueue notifications through an outbox table that BullMQ reads.
   No other code path writes `task_instances.state`, `current_level` or the ball-in-court columns. The database guards this without any session flag, in line with the 0007 principle that no session setting bypasses a protection: a deferred constraint trigger refuses to commit a change to those columns unless a `workflow_steps` row for the same task was inserted in the same transaction (`xmin = txid_current()`) with matching `before_state` and `after_state`.
   The engine works on the tasks of the site's **workflow definition version** (ADR 0010). Predecessors and stage membership come from that version, never from the "current" definition.
2. **States** (the `TaskState` enum). Mapping to the spec words:

   | State | Meaning | Spec word |
   |---|---|---|
   | `locked` | a predecessor is not yet *approved*, or the gate is closed; `lock_reason` lists why | Locked |
   | `open` | unlocked, nobody has started | Pending |
   | `entry` | started (has a start date), being filled at level 1 | Ongoing / returned to entry |
   | `in_review` | at a level between 2 and N−1 | Awaiting review |
   | `in_approval` | at level N | Awaiting approval |
   | `approved` | closed. Dates and document versions are frozen | Approved |
   | `na` | not applicable (condition rule or admin) | N/A |
   | `skipped` | admin skip | Skipped |
   | `suspended` | site On Hold through Change Control | — |

   Change request to the schema: `rejected` is not a resting state. A returned task sits in `entry` or `in_review` with `return_count + 1` and a `last_return_note`. The enum value is repurposed as `awaiting_confirmation` for BP §03: an approved document later rejected, where the date leaves the KPIs until a replacement is approved.
3. **Levels.**
   - `levels_required` N is between 1 and 3 (the screen offers 3, 2 or 1). Level 1 = Entry, level N = Approve, levels 2..N−1 = Review.
   - With N = 2 there is no Review. With N = 1, submitting is the final approval, so step-up applies.
   - N is frozen when the task is **first submitted**, not when it is created. This follows WF-01 and MX-05 ("tasks submitted after the change"). The schema comment "frozen at creation" must change; see the gate report, I-07.
4. **Holder resolution** at the moment a task enters level L:
   - Take the matrix cell for (stage, task, L, site region). The most specific cell wins: task + region > task > stage + region > stage.
   - Expand its assignees: a user is themselves; a role or sub-role means the users with an active assignment for it whose level is at least the level's need (entry/review/approve) and whose regions and modules include the task's; a group means its active members, each of whom must also pass the region and module test.
   - The result is the **eligible set** (people). The ball in court shows the cell (users, roles, groups) and is never cached as a single user unless the task is claimed.
   - An empty eligible set routes the task to System Admins with the alert `no_eligible_holder` (MX-03).
5. **Self-skip.**
   a. After person P completes level L, the engine checks whether P is in the eligible set of L+1. If so, it writes `workflow_steps(action = auto_skip, level = L+1, acted_by = P, note = 'level skipped: same holder')`. The audit row carries `self_approval = true`. The check then repeats for L+2.
   b. "Holds" means *eligible to act*, comparing people, not roles (MX-02b). A group under `any_one` counts if P is a member. Under `all_members`, P's action counts as P's vote only and the level is not skipped.
   c. If the chain reaches the final level, P's original action is the final approval and needs step-up. The UI warns before it (MX-06 preview, and `allowed_actions[].will_skip_to` in the contract).
6. **Rejection one level back.**
   a. `reject` needs a non-empty `note` (otherwise 422 `note_required`) and is allowed only at level ≥ 2.
   b. The task goes to level L−1. If L−1 was auto-skipped in the current cycle, the target is the level at which that same person last *acted*, because the skipping person holds both. This avoids "return to a reviewer who is the same person who must now edit". The task returns to the person who acted at the target level if they are still eligible; otherwise the cell is resolved again.
   c. The reviewer may mark individual document slots as rejected, with reasons. Each rejection increases `return_count`, which feeds first-time approval.
7. **Group claim.**
   - `any_one`: the first `claim`, or the first action (which claims implicitly), sets `claimed_by`. The task then leaves the other members' inboxes. A concurrent second action fails with 409 `already_claimed`, which includes the claimant.
   - A claimant may `release` the claim. An admin may reassign it.
   - A claim is dropped automatically when the claimant's assignment ends or the user is deactivated (AU-09, AU-13).
   - `all_members`: the votes of the members active at the moment the level opened are recorded in `workflow_steps`. The level completes when each of those members has approved. A member who leaves the group no longer counts. One rejection rejects the task (WF-05).
8. **Unlocking.**
   - On approval, the engine re-evaluates the successors from the task-definition predecessor graph (ADR 0009) and the gate rules (rules.md §2.2, computed by the calculation service).
   - Each successor whose predecessors are all approved or N/A and whose gate is open goes `locked → open`, with `expected_date = predecessor date + SLA max`. The owner is notified.
   - At `open` the task takes its configuration snapshot (ADR 0007).
9. **Batches.**
   - An approved import batch row that targets a task acts as that task's **submission at level 1**, with the uploader as the entry actor. From then on it follows the task's own matrix.
   - A row for a register record with no task follows the register's matrix row. Today `matrix_cells.stage_id` is mandatory, so this is a change request (gate report, I-05).
   - Approvals can be done row by row, or all at once with one step-up per request. Rows held "pending previous approval" stay held and are reported.
10. **Admin override.**
    - Kinds: `unlock`, `skip`, `mark_na`, `accept_without_document`, `accept_without_workflow`, `reopen`, `edit_date`, `reassign`.
    - Each needs a reason, step-up, and the right (System Admin or a delegate with that right).
    - It writes `workflow_steps(action = admin_override)` with before and after values, sets `task_instances.admin_override = true` (the badge), and sets the KPI flag.
    - A **revert** applies the stored before-image if the task has not moved on since. Otherwise it returns 409 `override_not_revertible` with the blocking steps. The revert is itself audited.
    - `reopen` returns the task to `entry` and keeps its values. Successors stay open. Dependent milestones show "awaiting confirmation" (WF-10).
11. **Concurrency.** Every task mutation needs `If-Match: "<version>"`. A missing header returns 428, a stale one returns 412. Bulk requests carry a `version` per item and get a result per item.

## Consequences
- One transactional engine is easy to test exhaustively. QA builds a table-driven test of (levels × holder overlaps × group rules × reject paths).
- Resolving holders at entry to each level, and not caching them, makes matrix and assignment changes take effect on the next transition (MX-04) without data migration.
- The inbox query must expand cells into people. A materialised `task_inbox` (task, user) table, refreshed by the engine on each transition and on each assignment or group change, keeps Approvals under 2 s (request to database-engineer).
- Repurposing `rejected` and freezing levels at first submission are schema and semantic changes. They need the database agent and owner confirmation.
