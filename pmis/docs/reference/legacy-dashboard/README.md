# GSDN Site Delivery Dashboard

A single offline HTML file. Open `GSDN_Dashboard.html` in a browser and load the GSDN Master workbook
(.xlsx or .xlsb). The file is read in the browser only; nothing is uploaded or stored.

- Pages: Project Overview, CW, TE. CW and TE share one eight-tab template.
- Every Master column is found by its three header rows, never by position. A missing required column
  stops loading with a message naming it.
- The dashboard presents what the Master computes (milestones, baselines, phase gates, Overall Status,
  SLA, Project Status, Data Quality, Risk Register, Quality Inspections). It does not re-derive them.
- The workbook must carry calculated values: open it in Excel, calculate, save, then load it.

Build: `python3 build.py` assembles `src/` (CSS with the Barlow fonts inlined, SheetJS 0.18.5, app) into
`GSDN_Dashboard.html`. Test data: `python3 test/gen_test.py <GSDN_Site_Master.xlsx> <out.xlsx>` writes a
500-site synthetic Master.
