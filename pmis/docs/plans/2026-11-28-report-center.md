# Report Center (spec)

Status: spec for the draft PR chain below. Approved by the owner in the chat of 2026-11-28 (13:53 to 14:25, relayed by main): the four-item Report Center, the server PDF engine option B, and the company ranking as the first ready report. Not approved and not built: a drag-and-drop designer, free calculated fields, public share links, external BI, AI.

## Goal
Management asks for a report on contractors, sites, procurement, warehouse, issues or equipment. The user picks a ready report, picks region, company and period, and gets it on screen or as a file or by mail, with one click. Everything is read from the live records, nothing is typed in.

## What exists and is reused (nothing is duplicated)
| Need | Existing mechanism |
|---|---|
| Saved, shareable report definition | saved views (`register-<key>`) and the report builder, #574 |
| Run to a file | `POST /exports/master` with `view` (xlsx), same export grant, regions, field rules and the `disable_export` lock |
| Schedule and mail | `PUT /exports/schedules` with `spec.view`, mail kind `export_ready`, `mail_outbox` (retry, dead letter), #568 and #574 |
| A4 print | `PrintSheet` and `PrintButton`, #618 |
| Toasts, Settings screens, audit, EN/AR | existing |

## Chain (each a draft PR, in this order; every one stacks on the one before)
1. **Library and run (R2).** `report_definitions` is code, not a table: a catalogue of ready reports (key, title EN/AR, group, source, default columns, parameters). First set: Contractor ranking (later), SLA and delay, Materials stock, Issues, Equipment calibration, Procurement status. `GET /reports/library` (hidden reports and unreadable sources left out), `POST /reports/{key}/run` returns rows, optional groups with sub-totals, and chart series as JSON. Parameters: region, company, period (from, to). Every run reads through the same list services and grants as the screens (no new read path, no join the caller could not make on screen).
2. **Report page.** `/reports` becomes the Report Center: library with search and groups, parameter bar, display modes (table, cards, grouped with totals, chart), actions with Arabic labels: عرض (View), تنزيل (Download), طباعة (Print), إرسال بالبريد (Send by email). Print uses `PrintSheet`.
3. **PDF engine, option B (Chromium on the server).** The report page is rendered by headless Chromium to A4 PDF, Arabic and RTL kept, so the PDF mailed equals the printed one. Chromium runs in its own limited process: no network except the app itself, a timeout, a memory limit, one job at a time, the page it opens is a signed one-use URL of a print route. The installer adds the package (about 300 MB; recorded in the installer docs). Without it the option stays hidden and print-to-PDF in the browser remains.
4. **Send and schedule.** Send by email (PDF, Excel or CSV) to system users only (no outside address); schedule daily, weekly, monthly; one copy per recipient built under that recipient's own grants; a delivery log (who, when, format, result, retry) kept for the retention period.
5. **Settings (short).** Settings > Reports: logo and header text, formats allowed per role, row limit, hide a ready report, retention of the delivery log. Changes need a reason and are audited, like other settings.
6. **Contractor ranking report.** The first library report. The scoring (factors, weights summing to 100, thresholds) is configured in Settings; see the open question below.

## Two more approved items (relayed by main, 2026-11-28 15:34)
- **As of stamp and snapshot (extra 5).** Every run carries "as of" (date and time, Africa/Tripoli) and a data freshness note; each run is saved as a snapshot (parameters, row counts, the figures shown, the author) so a figure can be reproduced later. It reuses the delivery log table of step 4 (a run is a log row with a stored result), kept for the retention period. Lands with steps 1 and 4.
- **Scheduled reports to saved company contacts (automation item 7).** The recipients are the contacts saved on a company (Companies work, #620), an audience outside the system users. It is built as its own PR after step 4, and its send path stays OFF and unreachable until the owner confirms the external mail path (main is asked first). Until then schedules go to system users only.

## Rules kept
Additive migrations only; no permission widened; a report never shows more than the screens show; no public links; recipients are system users only; hide, never delete; EN/AR RTL; tips and aria-labels; every PR has docs, tests (API and web), a Playwright EN/AR spec and an Arabic changelog entry in its body.

## Decisions relayed by main
- The scoring engine (factors, weights, manual inputs, monthly snapshot) belongs to the Companies work (K-series, K2b and K5 to K8). This chain adds the ranking only as a ready report on top of it, and coordinates the interface with that work.
- This chain stacks on #574 (report builder) and #618 (print layout) and merges after them.
