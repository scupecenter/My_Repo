# Seed plan (synthetic data only)

Seeding runs through `prisma db seed` (TypeScript, deterministic PRNG with fixed seed so every environment gets identical data). Because RLS is forced, the seed script sets `app.region_ids = '*'` at the start of its transaction. Only fictional names are used. Real names per role are entered after go-live.

## Reference data (always, also in production)
1. `regions`: ids 1..7 = Tripoli, Middle, WM, Zawia, Benghazi, GM, Sebha.
2. `roles`: Project Manager, RF & Design / Acquisition Team Lead, CW Team Lead, TE Team Lead, Inventory Supervisor, Project Support.
3. `sub_roles` (9, editable in UI): RF Engineer, MW Engineer, Acquisition Team (RF & Design TL); Power Engineer, GECOL Power Team, HLC Fiber Team, Site Engineers (CW) (CW TL); Site Engineers (TE), HOTO Engineer (TE TL); Project Procurement Team (Project Support). The CLAUDE.md mapping lists 10 names under the TLs: the count of 9 and the list differ by one (Project Procurement Team is the tenth under Project Support). Seed all 10 listed names and record the discrepancy in `docs/spec/open-questions.md` (request to domain-analyst).
4. `stage_definitions`: 10 milestones in the agreed order, `approval_levels = 3`.
5. `task_definitions`: generated from the domain-analyst task catalogue; until it exists, the codes used in `tools/master-import/mapping.csv` (CW_STA, CW_DN, CW_MOS, CW_INSTALL, CW_PAC, TE_ACCESS, ... ) are seeded as the provisional set.
6. `matrix_cells`: every stage x level 1..3, rule `any_one`, assignees = role-level defaults (entry = sub-role engineers of the owning TL, review = the TL role, approve = Project Manager role). Editable in the UI.
7. `groups`: "System Admins" (flagged). `settings`: `require_mfa=false`, `geofence_radius_m=300`, `default_approval_levels=3`, `audit_retention_years=10`, `system_log_retention_months=12`.
8. `document_types` and placements: the Stage 1-3 library from CLAUDE.md (A1-A4, B1-B4, B6, B7, B9; B11 none), stages 4-10 seeded from blueprint v1.0 and the Master and flagged `needs_review`. Defaults: pdf/jpg/png, 20 MB, multiple files.
9. `snag_types` (CW and TE categories) with min photos 1 and formats jpg/png/heic; `template_definitions` and `template_versions` for the Master and each register template (header checksums computed from the generated files).
10. `work_calendars`: one default calendar `std` (weekend_days = {5,6}, Friday and Saturday, NETWORKDAYS.INTL code 7). `holidays` rows reference it (`calendar_id`); the placeholder list below goes into it.
10a. `sla_rules`: one rule per task definition from the task catalogue (`docs/spec/task-catalogue.csv`) with min/max working days, `start_event`, the default calendar, `effective_from` = project start, reason "seed". The D-1 (TE Access) rule uses start_event = Site RFI. No scenario/region overrides are seeded. Task instances take `sla_rule_id` from `sla_rule_for(task_def, scenario, region, open_date)` when they open.
10b. `weight_sets`, `weight_activities`, `weight_items`: `project_status` v1 from `docs/spec/rules.md` section 6: 8 activities (Survey & Engineering 12, Site Acquisition & Permits 8, Procurement & Supply 5, Civil Work & Site Readiness 25, TE Installation 20, Integration & On-Air 12, Testing & Acceptance 13, Training & Handover 5 = 100) and the 45 items (5+3+10+8+4+6+7+2) with the item weights, unit and `measure_rule`/`source` from the table in that section (item weights inside each activity total 100; 3.10 Billing has weight 0, "not weighted"). `health_index` v1 (six factors) and `delay_attribution` v1 are seeded the same way from rules.md. Seed order matters: insert the set as `draft`, then its activities and items, then update to `published` in the same transaction, because the deferred 100% trigger and the freeze trigger apply to published sets. A few `progress_snapshots` (weekly, project-wide and per region) are generated for the synthetic sites.
10c. `holidays`: Libyan public holidays placeholder list for the current and next year (to be confirmed by the product owner). `phase_gate_rules` and `baseline_versions` version 1 from the Baseline sheet.

## Synthetic users
About 20 fictional users (for example "Test User 01"), `m365_object_id` of the form `00000000-0000-0000-0000-0000000000NN`, emails at the reserved domain `example.test`, employee ids 1001..1020. Distribution: 1 break-glass admin placeholder (no real secret), 2 System Admins, one Project Manager, one TL per role, 2-3 engineers per sub-role, 2 users left `pending_assignment`. Two users are limited to one region each to exercise RLS. One time-bound delegation and one revoked delegation.

## Synthetic sites (150)
- Region split (sums to 150): Tripoli 30, Middle 20, WM 18, Zawia 18, Benghazi 28, GM 16, Sebha 20.
- Site codes `GS-<region prefix>-<nnnn>` (TRP, MID, WM, ZAW, BEN, GM, SEB), owner ids `OWN-<nnnn>`, names built from a fictional word list (for example "Alpha Ridge 014"), no real Libyan place or company names. Sub regions `<Region>-A..D`.
- Coordinates are random points inside a rough per-region bounding box, flagged synthetic in a seed note.
- Scenario mix: New Build 55%, Expansion 20%, Hot Swap 10%, Cold Swap 10%, Relocation 5%. Scope flags follow the Master rule per scenario (Expansion: tower and adaption mostly `na`, TE full yes). Tower, type, height, RT/GF follow the Setting lists.
- Clusters: about 18 clusters of 6-10 sites within a region, `kpi_acceptance_date` set for a few.
- Phase/batch: batches B1..B4 assigned by region wave; projects across all progress stages so every state is represented: 15% not started, 60% in progress spread over the 10 milestones, 10% on hold (with a suspension/resumption change request on some), 12% completed, 3% cancelled.
- Task instances are generated from task definitions and the site's scope/scenario conditions. Dates follow the baseline gaps (min/max working days) with random slippage; approved tasks get workflow steps for levels 1-3, a few with `auto_skip`, rejections with notes, one admin override per region.
- Register rows: procurement for every outsourced site, GECOL and HLC rows where scope is yes, permits, about 40 issues, 10 risks, 25 QC inspections, 60 snags (a third open) with photo rows (some `unknown_capture_date`, a few `outside` geofence), 5 meetings, warehouse items from the Master WH sheet column headers with generated serial numbers.
- External parties: fictional contractors ("Northgate Civil", "Delta Works") and the TE vendor named A&T Global (as in the project documents).

## Rules
- Seed is idempotent (upserts by natural key) and refuses to run when `NODE_ENV=production` unless only the reference-data subset is requested (`--reference-only`).
- Real data enters only through the batch workflow (template upload then review then approval), never through the seed.
