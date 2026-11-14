# Shared brief for the 5 feature agents (GSDN Workspace, repo /home/claude/my_repo, project in pmis/)

Read narrowly: pmis/CLAUDE.md (binding rules), the code you touch. Do not read whole blueprints.

Owner decisions taken 2026-11-12 (product owner). Record yours in pmis/CLAUDE.md (edit only the lines it changes):
1. Admin "approve all as-is" for uploads: uploaders stay as today; a System Admin gets a final approval that bypasses the L2-holder check, with reason + step-up, audited, flagged "admin override" (flagged/excluded in KPIs like other overrides). Incomplete rows (missing actual dates etc.) are approved with what they have and flagged "incomplete" (gaps stay visible via site_data_gaps).
2. Direct admin edit of site data: a System Admin edits any site field (name, name_ar, coordinates, region/cluster, scenario, custom fields; Site ID immutable) and any task date immediately, reason + step-up, audit before/after, "Admin override" badge, reversible. Non-admins keep the Change Control proposal path. Implement the contract's POST /tasks/{task_id}/overrides (kind edit_date at least) and /overrides/{id}/revert.
3. Permanent delete that frees identifiers: only for an already soft-deleted user, System Admin only, reason + step-up + typed confirmation. Account is purged from lists and cannot sign in; email, employee_id and phone are released so a NEW account can be created with the same data. All past entries, audit rows and task history stay attributed (keep the users row as a tombstone, never DELETE it). Last-admin guard applies. Amends decision B14 ("never a hard delete"): say so in CLAUDE.md.
4. Workflow editor in the system (task definitions, predecessors, stages, milestones, gates, versions).
5. Invite a new user by email with role and properties chosen at invite time.

Rules:
- Contract first: endpoints in pmis/contracts/openapi.yaml before implementing; regenerate web types the way the repo does (see apps/web package.json scripts); keep redocly lint passing if a script exists.
- DB: new migration pmis/apps/api/prisma/migrations/<YOUR NUMBER>_<name>/migration.sql, follow existing patterns (pmis_definer SECURITY DEFINER functions, app_has_permission, step-up, audit, RLS). Mirror into pmis/db/sql if recent migrations do.
- Use ONLY your assigned migration number and CHANGELOG entry number; 4 sibling PRs are built in parallel.
- Web: EN and AR i18n, RTL-safe, existing patterns (ActDialog, step-up flow). MSW mocks for new endpoints if the repo uses them.
- Tests: API tests (vitest, existing style), web tests where the area has them. Env:
  export TEST_PG_ADMIN_URL=postgresql://postgres:ci-only-postgres-test-value@127.0.0.1:5432/postgres
  export TEST_PG_APP_PASSWORD=ci-only-pmis-app-test-value
  Postgres 16 runs; node_modules exist in /home/claude/my_repo/pmis/apps/{api,web}. In your worktree run `npm ci` (or symlink node_modules) in apps you touch. Run only relevant test files plus typecheck and lint. Postgres is shared with sibling agents: check how test helpers name databases and avoid collisions.
- CHANGELOG: one entry `## 2026-11-12 (<YOUR ENTRY NUMBER>): ...` at the top of pmis/CHANGELOG.md, in Arabic, headings قرارات / إضافة / تعديل / أمان / مفتوح.
- Never use the characters U+2014 or U+2015 anywhere. Use commas, colons, parentheses or a hyphen.
- Synthetic data only, no secrets.
- Git: branch claude/<your-topic>. Before pushing: `git fetch origin main` then rebase on origin/main. Commit message ends with:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019NAoB1sDizLTTwpw28UM6f
  Push: `git push -u origin claude/<your-topic>`.
- PR via REST (GraphQL blocked): `gh api repos/scupecenter/My_Repo/pulls -f title=... -f head=claude/<topic> -f base=main -f body=...`. Body sections: What changed / Security / How it was tested / Open. Body ends with:
  🤖 Generated with [Claude Code](https://claude.com/claude-code)

  https://claude.ai/code/session_019NAoB1sDizLTTwpw28UM6f
  Then a PR comment (gh api repos/scupecenter/My_Repo/issues/<n>/comments -f body=...) pointing the reviewer to parts needing careful human review (permissions, migrations, step-up, grants).
- Final report: max 200 words: PR URL, what was built (API/DB/UI), tests and results, anything not done. No code dumps.

Additions (restart, 2026-11-12):
- Mirror file numbers in pmis/db/sql: migration 0087 -> 086_*, 0088 -> 087_*, 0089 -> 088_*, 0090 -> 089_*, 0091 -> 090_*.
- pmis/apps/*/node_modules are symlinks: never `git add` them (use explicit paths or check `git status` before committing).
- A previous run of you may have left uncommitted changes in your worktree: read `git status` / `git diff` first and continue from them instead of starting over.
- Commit and push a WIP commit to your branch early (after the migration + API compile) and again at each milestone, so work survives a session interruption. Open the PR as a draft once the first push is done (`-F draft=true`), then mark it ready via POST /repos/scupecenter/My_Repo/pulls/<n>/ccr/ready_for_review when complete.

## Commit procedure (security gate, approved by the user on 2026-11-13)
A PreToolUse hook blocks any Bash command whose text contains the words "git" followed by "commit" until a security scan passes. The user approved this configuration for all five worktrees: full scan, pre-commit mode, report high and above, telemetry NOT sent. Before EACH commit:
1. Stage your files (never pmis/apps/*/node_modules).
2. Run `pmis/tools/precommit-scan/quick.sh <your worktree path>` (owner decision 2026-11-13: quick secrets check of STAGED changes, under a second; the full scan now runs on GitHub, PR #130 workflow "Security"). PASS = go on; FAIL = fix the secret first (synthetic values in apps/api/test/*.ts are allowlisted). Do NOT run /tmp/opsera/scan.sh any more.
3. No critical/high NEW findings: run `touch /tmp/.opsera-pre-commit-scan-passed` as its own Bash call, then the commit as the NEXT Bash call (each commit consumes the flag). If there ARE critical/high NEW findings, fix them in code first; never commit around them.
Known pre-existing findings (synthetic values in apps/api/test/*.ts and tools/capacity-sizer) are not yours.
Commit in a few larger steps, not many tiny ones. Do not put the words git+commit inside other commands (heredocs, echo), the hook matches the text.

## Checkpoint and resume protocol (the 5-hour usage limit WILL interrupt you; owner instruction 2026-11-13)
- Checkpoint = scan, commit, PUSH. Do it right now, then after every milestone (migration done, API compiles, tests pass, UI done) and before any long step. Unpushed work can be lost.
- After the first push, open a DRAFT PR. Keep a "## Progress" checklist at the top of the PR body (done [x] / remaining [ ]) and update it at each checkpoint with `gh api -X PATCH repos/scupecenter/My_Repo/pulls/<n> -f body=...`. This checklist is how you or a fresh agent resumes.
- On resume: read your PR body checklist and `git log` first; never redo what is checked.

## Token economy (owner instruction)
- Read narrowly: grep for the symbol, then read only that range. Never read whole large files (openapi.yaml, CHANGELOG, schema.d.ts) end to end.
- Run only your own test files plus typecheck and lint; the full suite runs in CI.
- Copy the patterns of the nearest existing feature instead of exploring broadly.
- Keep your messages and reports short.

## Progress file
The orchestrator keeps pmis/docs/plans/2026-11-12-admin-features.md (done / in progress / planned). Do not edit it. Your final report must state clearly what is done and what remains.
