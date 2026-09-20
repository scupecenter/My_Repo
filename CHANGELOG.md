# Changelog

All notable changes to the GSDN Project Dashboard (`Dashboard.html`) are
recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every change to the project — code, data-handling, or documentation — must be
registered here under the `[Unreleased]` section before it is committed.

Detailed engineering history, the positional column maps, and the verbatim
per-session log live in
[`docs/GSDN_Dashboard_Reference.md`](docs/GSDN_Dashboard_Reference.md).

## How to register a change

- Add a bullet under the correct heading in `[Unreleased]`:
  `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, or `Security`.
- Keep each entry to one line, in plain language, describing the user-visible
  or behavioural effect (not the diff).
- When cutting a release, move the `[Unreleased]` items under a new dated
  version heading.

## [Unreleased]

### Fixed
- Geographic map (Overview + modal): the Libya landmass was nearly
  indistinguishable from the panel background in dark mode. Added
  theme-aware `--geo-land`/`--geo-stroke` tokens and a stronger outline so
  the country shape reads clearly in both dark and light themes.
- Geographic map: the dense cluster of site dots along the northern coast
  merged into a solid green mass that read as a "glow" on the map edge.
  Reduced the Overview dot radius (7 → 5) and gave each dot a thin
  land-coloured separating ring, so overlapping sites read as distinct dots.

### Added
- Persisted the engineering reference at `docs/GSDN_Dashboard_Reference.md`
  (architecture, data model, business rules, SLA rules, full project history)
  as the durable source of truth.

### Changed
- Rewrote `README.md` into a full project overview: what it is, how to use it,
  how it works, core business & SLA rules, repository layout, and contributing.

### Removed
- Overview **Site PAC Status** and **Delivered to O&M** KPI cards — removed at
  the user's request (no longer needed).

## [2026-09-20]

### Added
- CW and TE **SLA rules** baked into the dashboard (working-day min–max per
  gate; colour rule ≤ min green · within max amber · > max red). CW execution
  SLA by scope/tower class (adaption 4–8, RT 14–21, GF 30–45) with GECOL/HLC
  embedded and DLP at 90 calendar days. Shown in `cwSLATable`
  (CW ▸ Flow & Duration) and `teSLAPanel` (TE ▸ Cockpit).
- `CHANGELOG.md` to track all changes going forward.
- Overview **Site PAC Status** and **Delivered to O&M** KPI cards
  *(reverted — see [Unreleased])*.

### Changed
- CW cycle-time cards now coloured by each segment's SLA min/max
  (hardcoded 14/30/60 thresholds removed).

### Removed
- Old `TE_SLA` constants (survey→install, MOS→EIR 10, EIR→PAT 5,
  PreAcc→PAC 14, PAC→O&M 7) and the contradicting logic they drove.

## [2026-09-19]

### Added
- Support for the **177-column master**; TE install block restructured (+5
  shift): per-component install detail (MTS / IP Router / RF / MW / DC-OF),
  Installation Plan/Actual End dates, MOS Actual = TE work start.
- **Overview & TE charts:** Overall-Status donut (ONAIR = Done),
  Completion-by-Region bars, Completion-by-Stage bars.
- **Offline geographic map:** inline SVG Libya outline with one dot per site
  coloured by lifecycle; hover tooltip, click-to-open modal with zoom/pan, a
  per-site detail drawer, and status isolation. The projection covers all of
  Libya, so future East/South sites plot automatically.
- Donut/legend **click-to-filter** (`FILTER.life`: onair / pending / scope)
  across the whole dashboard.
- **O&M Handover** gate added to the Checkpoint Chain, the cumulative
  Delivery-by-Region table and the period table; a compact **Dismantle**
  summary added to the Overview.

### Changed
- Delivery-by-Region reworked to a pure cumulative per-gate view; Project
  Lifecycle converted to compact %-bars placed beside the map.
- Date filters replaced with native calendar **date-range pickers**
  (min/max = data span; Clear → first project date … today).

### Fixed
- Checkpoint-chain "Acquisition Pending" now measured on the nominal
  population instead of the all-acquired in-scope set.

## [2026-09-16]

### Added
- **Single-file date-window period engine:** each row carries per-gate dates; a
  global Period From/To plus a "Delivery by Region — Achievement in Period"
  table show the difference-in-window per gate.

### Changed
- **172-column master remap:** internal field names kept, parse derivation
  rewired (pwr / link / cwState from their new date columns; TE pre-acceptance
  computed from EIR + PAT + As-Built).
- Enforced the **global strict date-only rule** on every "…Date" gate.

### Removed
- Five "Overall Status" text columns; the two-file / baseline-compare mode
  (the dashboard is single-file only).

## Earlier

### Added
- Initial multi-session build of the three-scope dashboard
  (Overview / CW / TE): executive, progress / S-curve, kanban, accountability,
  activation, regional, contractor, risk, actions, register and data-quality
  pages; in-browser `.xlsb` loading; offline single file.
- Unified **Risk Register** (25 risks; CW / TE / Both scope).
- **13-09 master:** RF Survey Date column; Network Topology reordered;
  MW Alignment repositioned after Commissioning.
- **15-09 master:** TE BOQ (equipment per site) and CW BOQ (civil bill of
  quantities); Antenna-Height column removed.
