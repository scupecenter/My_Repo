# [DRAFT-SPEC] Settings gap 5: RAG thresholds for the progress KPIs

Status: built in this PR (migration 0573, contract 0.15.432). Spec kept for the decisions.

## Agreed requirements
The KPI catalog (0108) covers 10 operational KPIs only. Add SPI, progress vs plan and weekly velocity with green/amber thresholds to the catalog so the existing threshold editor covers them; seed defaults must reproduce today's colours so nothing changes on deploy; additive, hide never delete.

## Decisions and source
- Approved by Ahmed on 2026-11-27 (relayed by the parent: 20:05 review request, 20:29 and 20:35 tasks; rule: anything agreed is implemented at once as a draft PR). Source: Settings review, gap 5.
- Rules that apply: additive migrations only, no permission widening, hide never delete, Arabic and English everywhere, everything configurable in Settings, no other platform names.
- PR checklist when built: covered and excluded places with reasons, connections checked (registers, Settings, hub rule D55, gear, links, rights, templates), auto-fill and automation notes, Arabic changelog entry in the PR body (no CHANGELOG.md edit).

## Numbering reserved (block 0570-0589 and labels 0.15.430-0.15.449 assigned by the parent, 2026-11-27 21:38; verify live against main and open PRs before use)
- Migration: 0573 / db 572 (0572 went to the forecast window, gap 4)
- Contract label: 0.15.432

## What was built, and two changes from the agreed text (decided with the owner's side, 2026-11-28)
- "Seed defaults must reproduce today's colours": the three figures have no colour today (the SPI chip, the progress vs plan figure and the weekly velocity are plain). Chosen reading: nothing changes on deploy. A figure is coloured only after an admin turns it on and saves it. The suggested numbers (SPI 0.95 / 0.85, progress against plan -2 / -5 points, velocity 1.5 / 0.75 points per week) are shown in the editor and are not stored.
- "Add them to the KPI catalog": they are NOT rows of the 10-KPI catalogue of `dashboard_settings_catalogue()`. That catalogue also feeds the counters, the KPI alert rules (a rule on a KPI with no live value would never fire) and the rule that every catalogue KPI has a stored threshold, which would silently store (and so switch on) the suggestions the first time anyone saved the dashboard settings. A separate setting `dashboard.progress_rag` with its own guarded writer `admin_save_progress_rag` does the same job without those side effects and cannot collide with the other dashboard-settings PRs.
- Database (migration 0573, mirror `db/sql/572_progress_rag.sql`): `progress_rag_catalogue()`, `progress_rag_json()`, `admin_save_progress_rag(items, reason, version)`: `admin.settings` edit for all regions, reason, If-Match, all three figures sent with `enabled`, `green`, `amber`, ranges (SPI 0 to 5, others -100 to 100), green not below amber, one audit row `progress_rag_update` with before and after. No new table.
- API: `GET` and `PUT /settings/dashboard/progress-rag`.
- Web: a "Progress figure colours" card in Settings > Dashboard (per row: on/off, green, amber, a "Suggested" button that fills the numbers without turning the row on), own save, reason, audit and unsaved guard. Colours: the SPI chip, the plan chip (progress minus planned) and the velocity chip of the progress curve card, with the same tone classes as the counters, only when the row is on.
