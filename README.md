# Workspace

Project management information system for the Project telecom site-delivery project (7 Libyan regions). It replaces the Excel Site Master as the system of record, with a 3-level approval workflow on every task.

**Start here:** [`pmis/HANDOVER.md`](pmis/HANDOVER.md). The binding rules are in [`pmis/CLAUDE.md`](pmis/CLAUDE.md), and the history of every decision and change is in [`pmis/CHANGELOG.md`](pmis/CHANGELOG.md).

| Path | Contents |
|---|---|
| `pmis/` | The system: spec, ADRs, API contract, database, design, forms |
| `build/` | The Python generator of the legacy Site Master workbook (`python3 build/main.py`) |

| `.claude/agents/` | The AI agent team (see `pmis/ORCHESTRATION.md`) |

The system itself is the reference for the Site Master structure: field names and calculations live in the database (`master_columns`, applied by the migrations), and a Master workbook in the legacy layout is generated on demand by the Master export (`POST /exports/master`). The `GSDN_Site_Master.xlsx` snapshot at the repository root is retired: it is no longer updated and nothing reads it.
