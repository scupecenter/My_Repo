# Orchestration: 8 agents, 4 phases

| # | Agent | Owns (write access) | Model | Effort |
|---|---|---|---|---|
| 1 | tech-lead (orchestrator) | `docs/adr/`, `contracts/`, root config, `develop` merges | opus | high |
| 2 | domain-analyst | `docs/spec/` | opus during P0, then sonnet | medium |
| 3 | ux-designer | `design/` | sonnet | medium |
| 4 | frontend-engineer | `apps/web/` | sonnet | medium |
| 5 | backend-engineer | `apps/api/src/` (except `prisma/`) | sonnet | high |
| 6 | database-engineer | `apps/api/prisma/`, `db/`, `tools/master-import/` | sonnet | medium |
| 7 | qa-engineer | `tests/`, `docs/test-plans/` | haiku | medium |
| 8 | devops-security | `infra/`, `.github/workflows/`, `Dockerfile*` | haiku | low |

## Token budget rules
- **Opus is reserved for low-volume, high-impact work.** tech-lead plans, reviews, and writes ADRs. domain-analyst extracts business rules in P0, where an error multiplies later. Neither writes bulk code.
- **Sonnet does the bulk of the code.** Backend runs at high effort because of the approval engine and the calculations.
- **Haiku handles repetitive work:** running tests, reporting, CI configuration, Compose files.
- **Escalate only by exception.** If a haiku agent fails the same task twice, tech-lead re-runs that one task on sonnet and records why in the PR. Never escalate a whole agent.
- **Read narrowly.** Agents read the section they need, never the whole blueprint or the Master on every task. domain-analyst produces `docs/spec/` once, and the other agents read the spec, not the raw references.
- **One task per session.** Hand off through files (spec, contract, PR notes), not long chat history.
- To switch a model, edit `model:` in `.claude/agents/<name>.md`.

Minimum viable team is 5 agents: merge 2 into 1, 3 into 4, and 8 into 5. Teams larger than 8 add merge conflicts without adding speed.

## Phases and gates

**P0 · Foundations (agents 1, 2, 3, 6 in parallel)**
- domain-analyst: user stories with acceptance criteria per module, task catalogue (code, stage, SLA, documents, template, master field), and the open-questions list.
- tech-lead: ADRs for stack, auth, approval engine, template versioning, and audit log, plus OpenAPI v0.1.
- database-engineer: ERD and Prisma schema v0.1, plus a mapping from the Master columns to database fields.
- ux-designer: finishes prototype v2 and the design tokens.
- *Gate:* the product owner approves the spec, ERD, and the key prototype screens.

**P1 · Core (agents 4, 5, 6, 7)**
- Sign-in and the 4-digit ID mapping, users and roles, regions and visibility.
- Sites and the task grid, the approval engine (levels, self-skip, one-level-back rejection, notes), the editable Responsibility Matrix, and the Audit Log.
- *Gate:* E2E tests pass for submit → review → approve → next task opens, rejection back one level, and the visibility filter.

**P2 · Data entry and registers**
- Template service: issue, embed ID and version, validate, preview the diff, then batch review and approve. Master import goes through the same service.
- Registers: GECOL first, then HLC, Procurement, Permits, Issue, Risk, and Change Control. Change Control drives gate shifts.
- System Log and notifications (in-app and M365 email).

**P3 · Dashboards and hardening (agents 4, 5, 7, 8)**
- Dashboard KPIs that match the GSDN Site Delivery Dashboard.
- Performance work, security review, backup and restore, the deployment runbook, and user acceptance testing with real data.

## How to run it with Claude Code
1. The PMIS lives in `pmis/` of this repository, beside the dashboard. Agent definitions are in `.claude/agents/` at the repository root. Work goes to a `develop` branch, or to the session's designated branch.
2. Start one Claude Code session in this repository and tell it: *"Act as tech-lead. Follow ORCHESTRATION.md phase P0. Delegate to the subagents in .claude/agents and report at each gate."*
3. tech-lead spawns the other agents through the Agent tool. To run them truly in parallel, each one works in its own git worktree or cloud session, on a branch `agent/<name>/<topic>`, and opens a PR to `develop`.
4. The product owner reviews and approves at each gate. Agents never merge to `main`.

## What agents cannot do (needs humans)
- Register the Entra ID app in the company tenant. This needs an M365 admin.
- Provide or approve the production server, domain, and backups.
- Supply the real data and the official document forms.
- Settle the open decisions in `CLAUDE.md`.
