# Spec: time in stage (0.15.482, migration 0623)

Goal: per site, how long each stage took (slowest ranked), and across sites which stages are slowest.

Choices:
- No new table. The days come from the task dates already kept (actual start, submission, approval, planned start and date), so the figure follows the data and is never typed twice.
- Stage = first start to approval of the last counted task that applies; calendar days; open stages count to today. This differs from the existing time in state (levels of one task from audit rows) and reuses none of it.
- Same rights as the Sites module: view on sites, the caller's regions, a hidden site answers 404. Read only.
- The ranking uses the average of finished stages, with the 85th percentile as the dashboard KPI does, and lists open stages apart so they do not skew it.
