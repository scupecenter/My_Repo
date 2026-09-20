# GSDN Project Dashboard

A **single-file, fully offline executive dashboard** for a Libyan telecom
**civil-works (CW)** and **transmission-equipment (TE)** rollout
(~259 in-scope sites, Western Area). Everything — the UI, the Arabic font, and
the Excel reader — is embedded in one HTML file, so it runs in any browser with
no server and no internet connection after it is opened.

> The authoritative engineering reference (architecture, data model, business
> rules, SLA rules and full history) lives in
> [`docs/GSDN_Dashboard_Reference.md`](docs/GSDN_Dashboard_Reference.md).
> Read it before editing `Dashboard.html`.

## What it does

- Reads the master workbook **`GSDN_Master_<date>.xlsb`** in-browser via an
  **inlined SheetJS (XLSX 0.18.5)** build — no upload leaves the machine.
- Presents three scopes in the top bar: **GSDN Overview · CW · TE**, each with
  its own set of tabs (28 pages total: Overview 1 + CW 15 + TE 12).
- All values are derived live from the uploaded workbook — nothing is
  hard-coded. Any KPI that cannot be computed reliably shows **n/a**.
- English-only UI; offline; stores nothing between sessions (no
  `localStorage`/`sessionStorage`).

## How to use

1. Open `Dashboard.html` in a browser (double-click).
2. On the upload screen, drop or choose the GSDN Master file
   (`.xlsb`/`.xlsx`/`.xlsm`/`.xls`).
3. The app loads and opens the **GSDN Overview** landing page. Use the top-bar
   scopes, the tab strip, and the filter bar (region / batch / owner /
   contractor / type / scenario / status / lifecycle / period From–To) to
   explore. Click charts, donut slices, region bars and map dots to drill down.

## How it works

- `findMasterSheet()` locates the sheet whose A1 area contains "Site ID".
- `parseWorkbook(wb)` builds `RAW` — one row object per Site ID — using
  **positional column maps** (`COL`, `TE_COL`, `DIS_COL`, `CW_BOQ`, `EQ_COL`).
  `verifyHeaders()` name-guards key columns and raises a **non-blocking**
  structure warning (`HEADER_WARN`) if the template shifts.
- `applyFilters()` filters `RAW` and wraps the result in `periodView()` (global
  period mode); `render()` selects the page function by `PAGE` and injects HTML
  into `#main`; `wire()` then attaches charts, drill-downs, the geographic map
  and donuts.

## Core business rules

- **Strict date-only:** any "…Date" gate counts as *done* only when the cell
  holds a real Excel date (`serialToDate`, serial 20000–90000). "Done"/"Yes"
  text no longer counts; "Pending" = pending; "N/A"/blank = **excluded** from
  every calculation.
- **In scope:** `Delivery Batch != '' && !cancelled`. Cancelled sites leave
  execution scope but remain in the Dismantle pages.
- **Global period mode:** setting Period From/To makes the whole dashboard show
  *achievement within the window*; normal mode is byte-identical cumulative.
- **lifeBucket** (used by donuts, the geo map and the `life` filter):
  `onair` (live) · `pending` (post-CW, not onair) · `scope` (pre-CW).
- **Lifecycle:** Site Acquisition → CW → GECOL/HLC → RFI → TE Installed →
  ONAIR → **TE PAC** (TE closing gate, not FAC) → O&M Handover.

## SLA rules

Working-day min–max SLAs are baked in for both CW and TE, with the colour rule
**≤ min = green · within max = amber · > max = red**. See the reference
(§8) for the full per-gate tables; they surface in **CW ▸ Flow & Duration**
(`cwSLATable`) and **TE ▸ Cockpit** (`teSLAPanel`).

## Repository layout

| Path | Purpose |
|---|---|
| `Dashboard.html` | The entire application (UI + font + SheetJS + engine). |
| `docs/GSDN_Dashboard_Reference.md` | Durable engineering reference & project history. |
| `CHANGELOG.md` | All notable changes. Every change is registered here before commit. |

## Contributing

- Follow the working style in the reference: **no assumptions**, propose before
  large or ambiguous changes, make surgical single-match edits, and never invent
  data.
- On a new master, **re-verify every positional column map** before editing —
  the tail shifts when columns are added or removed.
- Validate before delivering: syntax-check the script and walk all 28 pages
  (`HEADER_WARN = []`, KPI sanity, no horizontal overflow, no console errors).
- Register every change in `CHANGELOG.md` under `[Unreleased]`.
