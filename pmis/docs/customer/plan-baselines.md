# Plan baselines: freeze the plan and see the variance

In Reports > Workload, the section "Plan baselines" keeps frozen copies of the plan and compares what was done against them.

- A System Admin presses "Freeze the plan now" and names it. The approved baseline date of each milestone of every active site is copied. The official baselines (the ones the sites and the dashboard use) do not change, and a later re-baseline never rewrites a frozen plan.
- Pick a frozen plan to see, per stage and per region: how many dated stages, how many are done, how many were done late, how many are still open past their frozen date, the average variance and the worst. Below that, the 50 worst rows.
- Variance is in calendar days: actual minus the frozen date. Negative is early. An open stage past its date counts up to today.
- Who sees it: anyone with the dashboard view, only for their own regions. Only a System Admin freezes or hides a frozen plan. Hiding keeps the data.
- Up to 50 frozen plans can be kept.
