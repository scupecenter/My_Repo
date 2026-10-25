# ADR 0003: Authorization: assignments, the permission grid, region RLS and DB defence in depth

- Status: Item 7 Accepted (the security review fix; database-engineer is implementing it). Item 6 is Accepted by tech-lead as the follow-up and is a request to database-engineer. Items 3 and 9 need confirmation from the product owner (gate report, questions B3 and B4).
- Related: CLAUDE.md "Role assignment is many-to-many", "Groups", "System Admin is a group", "Permissions"; stories AU-06, AU-10..AU-13, VI-01..VI-06, MX-02b; migrations 0003 (RLS, `pmis_migrator`, `admin_transfer_site_region`), 0004 (assignments), 0005 (`admin_repoint_sla`) and 0007 (permission grid, field rules, resolvers).

## Context
- Access comes from many-to-many assignment rows (`user_role_assignments` with `_regions`, `_modules` and `_profiles`). Each row has its own permission level, regions, modules, validity dates and **permission profiles**.
- A profile (`permission_profiles`) holds grid grants (`permission_grants`: module or `module.screen` × action). The actions are: view, create, edit, delete, approve, export, import, download_documents, view_audit and administer.
- Field-level rules (`field_permissions`) give field × (role or profile) → hidden / read / edit.
- Migration 0007 adds the resolvers `app_resolve_permissions(user)`, `app_has_permission(user, module, action)` and `app_resolve_field_access(user, field)`.
- Protection bypasses depend on the database role `pmis_migrator` (migrations and seed), never on a session setting. Region transfer and SLA re-point go only through the definer functions `admin_transfer_site_region` and `admin_repoint_sla`. A new task reaches open sites only through `admin_add_task_to_open_sites`.
- **The gap.** The API sets `app.region_ids` and `app.user_id` with `set_config`. These are plain session settings that any SQL running as `pmis_app` can also set. The admin definer functions accept any session whose `app.region_ids = '*'`. RLS therefore protects against API logic bugs, but not against SQL injection or a compromised app role.
- The identity tables (`users`, `user_role_assignments` and its children, `groups`, `group_members`, `delegations`) have no RLS and can be written directly by `pmis_app`.

## Decision
1. **Effective permission is a set of tuples.**
   - Each active assignment `a` grants grid(profiles of a) × modules(a) × regions(a).
   - The person's permission is the union of these sets, plus delegated rights (item 5).
   - This matches CLAUDE.md ("union … limited by their regions and modules") and VI-03b: Tripoli with all modules plus Benghazi with Warehouse only gives Quality = Tripoli and Warehouse = Tripoli and Benghazi.
   - It replaces the screens.md phrase "highest of the active rows". Nothing is compared across rows.
2. **Levels, profiles and field rules.**
   - The assignment's **permission level** (view < entry < review < approve < admin, each including the lower ones, Q18) decides **matrix eligibility** only (ADR 0004). A Review holder needs level ≥ review for the task's module and region.
   - The **grid** decides screen and action rights, through `app_has_permission`. An assignment with no profile grants no grid rights. Bulk assign therefore always carries at least one `profile_id`, defaulting to the seeded profile of the role (seed-plan 9a).
   - **Field rules** come from `app_resolve_field_access`, and the most permissive rule wins. With no rule, the entity permission decides. The API removes hidden fields from responses, exports and audit reads, and rejects writes to read-only fields with 403 `field_read_only`.
   - Navigation is built from `GET /me` (`effective.nav`).
   - **Roles are admin-defined** (CLAUDE.md, 2026-10-25). A role carries a name (EN/AR), duties, an optional parent role (which makes it a sub-role), a default profile, default regions and modules, and the flag `can_hold_matrix_levels`.
     - The defaults only pre-fill new assignments. Changing them later does not rewrite existing rows.
     - A role with `can_hold_matrix_levels = false` (for example Management: read-only, all modules, all regions) is never offered in a matrix cell. Holder resolution also ignores it, even if the level on its assignment is higher.
     - A role is deactivated, never deleted while assigned. Role writes go through the `idm_*` path (item 7).
   - "See the audit log" is the grant `view_audit`. It is seeded for System Admins and the Project Manager. This settles the LG-03 vs screens.md conflict as configuration.
3. **Regions per module.**
   - `app_resolve_permissions` limits modules per assignment, but regions are one union per user (`app_resolve_region_ids`). With one union, the VI-03b user would see Benghazi Quality rows.
   - Decision: the region set is resolved **per module**: `app_resolve_region_ids(user, module_key)` (request to database-engineer).
   - The API's per-transaction context uses the module of the endpoint. Cross-module lists (My Work, Approvals) use the union, and the API filters each row against the module of its task.
   - A site outside the set returns 404 (VI-02). An empty set fails closed.
4. **Writes** are checked against the tuple of the target (action, module, region). Workflow actions also need matrix eligibility (ADR 0004).
5. **System Admin and delegation.**
   - An admin is an `active` member of the group with `groups.is_system_admins`. The break-glass account has admin rights but never counts toward "at least one active admin".
   - A **full** delegation gives every admin right except: creating delegations, changing the membership of the System Admins group, and ending or demoting an admin. A **partial** delegation lists rights from the closed list `delegable_right` in the contract.
   - A delegate's actions are written with `on_behalf_of` = the delegating admin.
   - Migration 0007 §D says the definer functions only see a `*` session and that delegation is checked in the API. Item 7 moves this check into the database (`app_actor_is_admin(action)`).
6. **Closing the session-setting gap (the remaining limit of item 7): decided by tech-lead, to be implemented in P1 before the pilot, after item 7.**
   - **Mechanism: a verified session context.**
     - The API calls `app_begin(p_user uuid, p_on_behalf uuid, p_issued_at timestamptz, p_sig bytea)` once per transaction. The function is SECURITY DEFINER and owned by `pmis_definer`.
     - `p_sig` is HMAC-SHA256 over (user, on_behalf, issued_at, `txid_current()`), keyed with a secret that only the API process holds (environment variable, rotated yearly).
     - The key is also stored in a table readable only by `pmis_definer`.
     - The function checks the signature and that `issued_at` is no older than 30 s. It then **derives everything from data**: the user's status, region sets per module (item 3), admin membership and active delegations.
     - It writes the result into a `TEMP … ON COMMIT DELETE ROWS` table that the definer creates and owns. `pmis_app` has no privilege on that table, so it cannot forge it.
   - **What reads the context.**
     - RLS predicates, the resolvers and the admin functions read the context through STABLE definer accessors (`app_ctx_user()`, `app_ctx_regions(module)`, `app_ctx_is_admin()`, `app_ctx_on_behalf()`), wrapped as `(SELECT …)` so they are evaluated once per statement.
     - `app.region_ids` and `app.user_id` stop being trusted. `app_is_full_access()` becomes "context says admin with all regions".
     - `app_actor_is_admin(action)` and the `idm_*` functions (item 7) read the actor from `app_ctx_user()` instead of `app.user_id`. Their checks stay the same; only the source of the actor identity changes.
     - With no valid context, the database returns no rows.
   - **What it closes and what it does not.**
     - It closes SQL injection and any SQL issued as `pmis_app` without the key: such SQL cannot become another user, widen regions, or call admin paths.
     - It does **not** close a fully compromised API process, which holds the key. Detection then relies on the hash-chained audit log (ADR 0006) and on the email sent for every change to admins or delegations.
     - The worker uses the same mechanism under the identity of the user who queued the job, or under a system identity whose rights are fixed in data.
   - **Cost.**
     - One extra round trip per transaction (HMAC check and a few indexed lookups, well under 1 ms).
     - One DB PR to rewrite the policies of 0003 and 0007 and the three admin functions, plus one API PR: a Prisma `$extends` wrapper that runs every request in an interactive transaction starting with `app_begin`. The wrapper is needed anyway for `set_config(..., true)`.
     - Key handling, done by devops.
     - The RLS test suite must add forged-context tests.
     - Estimate: about 3 agent-days. That is cheaper than retrofitting after real data arrives.
   - Interim, until the PR merges: `$queryRawUnsafe` and `$executeRawUnsafe` are banned by lint, and the pilot does not start before this item is done.
7. **DB defence in depth for the identity tables. Decided 2026-10-24 after the security review; database-engineer is implementing it.** The tables covered are `users`, `user_role_assignments` with `_regions`, `_modules` and `_profiles`, `groups`, `group_members`, `delegations`, `permission_profiles`, `permission_grants` and `field_permissions`.
   - **No direct writes.** `pmis_app` loses `INSERT`, `UPDATE` and `DELETE` on these tables and keeps `SELECT`. The only exception is self-service preferences (`locale`, `theme`), which go through `idm_set_preferences`.
   - **Every identity write goes through a SECURITY DEFINER `idm_*` function**: assign, update, end and copy assignments; group create, rename and members; delegate and revoke; user status and employee-ID link; profile save and grants; field rules. The database agent owns the final names, and the contract cites them per operation (`x-db-path`). Each function writes its own `audit_log` row in the same transaction.
   - **Checks inside the functions.** They are repeated as BEFORE triggers on the tables, so that a future grant cannot bypass them:
     1. **Admin and delegation status are recomputed from the tables**: an `active` member of `groups.is_system_admins`, or an active, unrevoked delegation that covers the action. No argument or session flag is trusted. The other admin paths (`admin_transfer_site_region`, `admin_repoint_sla`, `admin_add_task_to_open_sites`, workflow-version publish and migration from ADR 0010) use the same check through `app_actor_is_admin(action)` instead of a bare `*` session.
     2. **No self-beneficiary writes.** Nobody may create or widen their own assignment, profile link, group membership or delegation, or edit a profile they are linked to. The only exception is a System Admin acting without delegation, who already holds every right; that write is audited `privileged = true` and emailed to the other admins.
     3. **No grant above your own rights.** A delegate cannot grant level `admin`, the action `administer`, membership of System Admins, or any right outside their delegation.
     4. **No re-delegation.** Only a System Admin acting without `on_behalf_of` may delegate. CHECK `from_user_id <> to_user_id`, and the delegate may not be an admin.
     5. **At least one active admin.** A deferred constraint trigger refuses to commit when System Admins has no `active`, non-break-glass member.
     6. **Pending stays empty.** A `pending_assignment` user cannot be a group member or a matrix assignee.
     7. **No overlapping rows** for the same user and role/sub-role (an exclusion constraint, Q18).
   - **RLS on the identity tables.**
     - `users` and `group_members` are readable by any session with a region value.
     - `users.totp_secret_enc` is never granted to `pmis_app`.
     - The assignment tables and `delegations` are readable by their subject, by admins, and by holders of `users.view`.
   - **Remaining limit, recorded.** The functions learn *who* is acting from `app.user_id` (and `app.on_behalf_of`), which is still a plain session setting. SQL injected through `pmis_app` can set `app.user_id` to the id of a real admin and then pass every check above. The `idm_*` layer therefore closes API logic bugs (a missing guard, a wrong id in a request body) and direct table writes. It does not close SQL injection or a compromised app role. Item 6 is the planned fix: it replaces `app.user_id` with the verified context. Until it lands, the compensating controls are:
     - the lint ban on raw unsafe queries;
     - the hash-chained audit log (ADR 0006);
     - an email to all admins on every change to System Admins membership or delegations;
     - synthetic data only.
8. **Resolver guard.** The resolvers keep their own guard (`app_assert_self_or_admin`), switched to the verified context.
9. **Assignment `team` (CW/TE/both)** stays on the assignment row, as in the schema. The person page shows the union. To confirm: AU-03 speaks of the user's team.

## Consequences
- Identity writes become function calls, not Prisma model writes. They are low-volume and the most sensitive writes in the system.
- The interim period, before item 6 merges, is acceptable only with synthetic data.
- Module-aware region sets remove over-exposure across modules, at the cost of one resolver call per transaction, cached in the context table.
- Every guard needs a negative test that connects as `pmis_app`, including forged `set_config` attempts.
