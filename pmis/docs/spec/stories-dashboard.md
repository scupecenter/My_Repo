# Stories: dashboard and KPIs

Sources: D66, D67, D72 (the dashboard tables); BP §06 (the indicator dictionary); CLAUDE.md (Final Closure KPI, delay attribution, health index); rules.md §6–§9.
All counts use approved data only and exclude Cancelled sites and N/A steps (BP §06).

## DB-01 Filters and the common pattern
- **Given** the filters Phase, Batch and Scenario, plus the reference date (today)
  **When** the user applies them
  **Then** every table except Exceptions & Alerts and WH Complete Units is re-scoped (D67, D72).
- **Given** any table
  **When** it is rendered
  **Then** it shows Scope, Done, Pending, Not Due and % Done, and Scope = Done + Pending + Not Due always holds (D67).
  - Pending means the step's turn has come, and includes work in progress.
  - Not Due means the previous step is not complete.

## DB-02 Milestone Delivery
- **Given** the 10 milestones
  **When** the table loads
  **Then** each row shows Scope, Done, Pending, Not Due, % Done, Overdue Open, Achieved Late, Avg Delay and Baseline Missing (D66, D67). Plan Coverage is not shown.

## DB-03 Overall Progress by Region
- **Given** the 7 regions
  **When** the table loads
  **Then** it shows a CW block (7 milestones) and a TE block (6 milestones) for each region (D67).

## DB-04 Project Checkpoint
- **Given** the checkpoint lists (CW 17 steps, TE 22, Post-HOTO 3)
  **When** the table loads
  **Then** it shows Done and Pending rows covering the whole scope (D66, D67).

## DB-05 Exceptions & Alerts
- **Given** exception rules (On Hold, Cancelled, open or aged site issues, the data-quality count, expiring permits and contracts within 30 days)
  **When** the table loads
  **Then** it shows Area, Indicator, Base, Count and % of Base, and lists exceptions only (D66, D67).
  **And** each row links to the list behind its count.

## DB-06 WH Complete Units
- **Given** the computed need (rules.md §7)
  **When** the table loads
  **Then** each unit shows Need, Dispatched, Remaining Need, Available and Shortfall, with Cambium and Intracom separate.
  **And** it is project-wide and ignores the filters (D72).

## DB-07 Swap & Relocation
- **Given** the Swap sites
  **When** the table loads
  **Then** it adds First-time Success, Rollbacks, Window over Max (S-3 / S-4), CW / TE Dismantle overdue, and Post-Swap KPI degraded (D67).

## DB-08 Project Status card
- **Given** the 8 activities and 45 items (rules.md §6)
  **When** the card loads
  **Then** it shows Actual, Planned, SPI and Plan Coverage.
  **And** Planned and SPI show "not available" until every weighted item has plan dates.
  **And** weight-0 items show "Not weighted".

## DB-09 Final Closure KPI
- **Given** the HOTO-achieved sites
  **When** the card loads
  **Then** it shows sites closed, % closed, and pending CW FAC and TE FAC with their ages in working days (rules.md §6.1).
  **And** these figures are not mixed into Project Status.

## DB-10 SLA and delay views
- **Given** completed and open SLA steps
  **When** the SLA view loads
  **Then** each step, contractor and region shows Count, Avg, Within Max % and Over Max, with the green, amber and red colours (rules.md §3; SLA sheet rows 8–11).
- **Given** the delay attribution (rules.md §8)
  **When** the "Delay by party" view loads
  **Then** it shows days per party, the % unattributed, and the overlapping periods. AAT SE is never listed as a party.

## DB-11 Health index
- **Given** the factors in rules.md §9
  **When** the card loads
  **Then** it shows the index out of 100 with each factor's value and weight, and lists the factors with no data as "excluded".
  **And** the formula carries the label "draft, under owner review" until it is approved.

## DB-12 Weekly snapshots
- **Given** the weekly snapshot job (and the month-end job)
  **When** it runs
  **Then** all KPI values are stored and never recalculated.
  **And** trend arrows compare the current values with the last snapshot (BP §06).

## DB-13 Cluster progress on the site page
- **Given** a site in a cluster of 9 sites
  **When** the site page loads
  **Then** it shows "6 of 9 sites at TE PAC" as information only (CLAUDE.md).
