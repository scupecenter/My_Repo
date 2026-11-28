# Spec: critical path on the Gantt (web only, stacked on the Gantt dependencies PR)

Choices
- The model of the Gantt is a chain: each stage or gate waits for the one before it (finish to start). In a chain nothing has slack, so the critical path is every dated stage that is still open; a stage with an actual date cannot move the finish. This is stated in the screen, not hidden.
- Finish = date of the last dated stage. Baseline finish = the last baseline. Variance = finish minus baseline finish (calendar days).
- Added delay per critical stage = its slip (date minus baseline) minus the slip of the dated stage before it; the largest positive value names the driver.
- Computed in `lib/gantt.ts` (`criticalPath`) from the pipeline dates the site endpoint already returns. No API, no migration, no saved data, the Gantt stays read only.
- Screen: red edge on critical rows, a summary line with finish, variance and driver, tooltip, English and Arabic.
