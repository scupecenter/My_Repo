# Spec: company score engine with factor settings and manual input (K5)

Status: DRAFT-SPEC (no code in this PR). Approved by the owner (relayed by Main 2026-11-28 15:32). Requirement text: docs/plans/2026-11-28-companies-report-center-automation.md, row K5: "Score engine with factor settings, manual factors, notes and a bounded manual adjustment with required reason; 'Manual' badge". Default weights from the same file: schedule 25, quality 25, snags 10, delays 10, cost of delay 10, completed work 10, compliance 5, responsiveness 5 (all editable, sum 100).

## What exists (main)
- `ContractorPerformanceService` (migration 0180): computed on read, nothing stored. Per company: issues and delay days, snags (total, open, overdue, returned), quality inspections (total, failed), orders (total, open), contract (active, end date, days left). Levels ok / amber / red / insufficient from thresholds in Settings (`contractors.performance`). The dashboard scorecard reads the same report.
- Company page (#621) and Companies tabs (#615); documents and compliance (#620).

## Design (additive, one migration, no change to the existing report)
1. Factor catalogue (code, label EN/AR, source: `computed` or `manual`, weight). Eight factors above. Stored as a guarded setting `companies.score` (like `contractors.performance`: version, If-Match, reason, audit). Weights must be integers 0 to 100 and sum to 100.
2. Each factor yields 0 to 100 (higher is better), or no value when there is not enough data (`min_sample` of the existing thresholds). A missing factor is left out and the others are re-weighted, shown as such.
3. Computed factors read only existing numbers: quality = 100 minus the failed share; snags = 100 minus the overdue share (half) and the returned share (half); delays = from delay days of issues against a ceiling in the setting; completed work = share of closed orders; compliance = contract in force and documents valid (#620). Schedule, cost of delay and responsiveness have no complete source today: they start as `manual` factors, entered per company with a note, until K8 reads them from records.
4. Manual input table `company_score_inputs` (party, factor, value 0 to 100, note, entered by, at; append only, latest wins). Bounded manual adjustment on the total: at most plus or minus the bound in the setting (default 10 points) with a required reason, audited, shown with a "Manual" badge and the reason on hover. Never changes a factor, only adds one visible line.
5. API: `GET /companies/{id}/score` (factors, weights, values, source, notes, total, adjustment) and `GET /reports/company-score` (ranking rows); `PUT /settings/company-score` (weights, bound, ceilings). `POST /companies/{id}/score/inputs` and `/adjustment` need a new right? No new right: the existing edit grant of `contractors` for all regions, as the contractor rules settings use. No permission or role change.
6. Web: Score tab on `/companies/:id` (#621), score column in the Ranking tab (#615), Settings screen for weights; EN and AR; the dashboard scorecard (K6) reads the same total.

## Safety (owner rules)
Additive only. No permission, role, grant or default change. Hide, never delete (inputs are append only). No AI features. Nothing public. No CHANGELOG.md or contract `version:` edit.

## Open questions for the owner (not blocking the draft)
1. The formulas of the computed factors above are proposals: confirm or give the rule per factor. 2. Bound of the manual adjustment (proposed 10 points). 3. Which of schedule, cost of delay and responsiveness should be manual first, or is a source record meant (then K8)?

## Tests planned
API: weights sum check, re-weighting with a missing factor, manual input latest wins, adjustment bound and required reason, audit, region visibility. Web: Score tab, badge, settings form; EN and AR.

Connections checked: performance report and thresholds, dashboard scorecard (K6), #615, #620, #621, K7 history (freezes this total monthly), K8 (custom factors).
Docs in this PR: this spec. Code PR adds HANDOVER and relations-map lines, openapi paths.
Arabic changelog entry (PR body only): محرك تقييم الشركات: عوامل بأوزان قابلة للتعديل، مدخلات يدوية بملاحظات، وتعديل يدوي محدود بسبب إلزامي مع شارة "يدوي".
