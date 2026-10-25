# GSDN PMIS

Project management information system for the GSDN telecom site-delivery project (7 Libyan regions). It replaces the Excel Site Master as the system of record, with a 3-level approval workflow on every task.

**Start here:** [`pmis/HANDOVER.md`](pmis/HANDOVER.md). The binding rules are in [`pmis/CLAUDE.md`](pmis/CLAUDE.md), and the history of every decision and change is in [`pmis/CHANGELOG.md`](pmis/CHANGELOG.md).

| Path | Contents |
|---|---|
| `pmis/` | The system: spec, ADRs, API contract, database, design, forms |
| `GSDN_Site_Master.xlsx` | The latest Site Master, the source for field names and calculations |
| `build/` | The Python generator of the Site Master (`python3 build/main.py`) |
| `.claude/agents/` | The AI agent team (see `pmis/ORCHESTRATION.md`) |
