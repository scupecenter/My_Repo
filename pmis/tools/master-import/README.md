# fill-templates.py: fill the PMIS register templates from the Master

An offline helper (gap G3 of `docs/plans/2026-11-04-master-template-data-load.md`). It copies the register sheets of the owner's Master workbook into the templates the PMIS issued. It never uploads anything and never creates a template: the PMIS still rejects any file without the embedded `_tpl` id and version, and every upload still becomes a batch that goes to L2.

Python 3 and `openpyxl` only (`pip install openpyxl`). Run it on your own computer. Keep the real Master outside the repository.

## Step by step

1. **Download blank templates** from the PMIS (Templates page): TPL-RF, TPL-ACQ, TPL-PRM, TPL-PO, TPL-GECOL, TPL-HLC, TPL-ASB, TPL-RSK, as many as you want to load. Do not edit them. A template that already has rows, or whose header row was changed, is refused.
2. **Save the Master as `.xlsx`** (values only, no macros). If Excel shows an external link, break it first (Data, Edit Links, Break Link). The tool does not follow links either way.
3. **Run the tool** with a new, empty output folder:

   ```
   python3 -I tools/master-import/fill-templates.py \
       --master /path/to/Master.xlsx \
       --out /path/to/filled \
       /path/to/TPL-RF.xlsx /path/to/TPL-ACQ.xlsx /path/to/TPL-PRM.xlsx
   ```

   Options: `--month-first` (read ambiguous text dates as mm/dd/yyyy; the default is day first, dd/mm/yyyy), `--include-personal` (see "Personal data" below), `--maps DIR` (another mapping folder), `--master-sheet`, `--master-site-col`, `--master-first-row` (where the valid Site IDs are, default sheet `Master`, column B, row 5), `--no-site-check`.
   Exit code 0 = done, 1 = a template was skipped (no mapping or no Master sheet), 2 = refused.
4. **Read the report.** For each template the folder gets three files:
   - `<template>_v<n>_filled.xlsx`: the filled template;
   - `<template>_v<n>_summary.md`: counts and cell addresses only (safe to share);
   - `<template>_v<n>_report.csv`: every changed cell (old and new value, never for a personal column), blanked cells, values outside lists, skipped rows with the reason (`no_site_id`, `site_not_in_master`, `duplicate_key`), and per-column counts of blank, grey and personal cells.

   **First run (Q493):** the report lists every mapped Master header the tool could not find, and every mapping row that matches no template column (names only, no data). Send that list to the project team: the mapping files are corrected in a small follow-up, then run again.

   Text dates with day and month both 12 or less (for example 05/06/2025) are read day first and listed as `date_day_first_assumed` (cell, old and new value) so the L2 reviewer can check them. Procurement rows are listed as `needs_delivery_team`: the Procurement team fills Delivery and Team in the PMIS before submitting.

   Fix what you can in the Master and run again into a new folder. Values outside lists and text in date or number cells are copied as found: the PMIS shows them as refused rows.
5. **Upload each filled template** on the PMIS Templates page (the same file you filled). It becomes one batch for L1, and L2 then approves it row by row or all at once. Load in the order of section 3.2 of the plan.

## What the tool changes, and what it does not

Changes (mechanical only): extra spaces; Site IDs trimmed and upper-cased; text dates to dates (ambiguous ones read day first, reported); numbers typed as text to numbers; `N/A`, `Pending` and `Cancelled` in a date or number cell to blank; list values to the list's own capitalisation, and `y`/`n` to `Yes`/`No` on Yes/No lists; `Open-ended` to `No` in Permits "Has expiry date".

Never: the `_tpl` sheet, the header row, grey (never-read) columns and Record ID, drop-downs, protection, or any value it cannot fix mechanically. Personal columns are left blank unless `--include-personal`.

Procurement: the Record Type is derived per row (`po` when the PO / WO No. is filled, otherwise `pr`). Delivery and Team are left blank.

## Personal data (Q469, Q492)

Landlord, contact person, phone and e-mail are not loaded until the owner decides Q469 in writing. After that, only a System Admin runs the tool with `--include-personal`, on the server or an Aljeel machine, never a personal device. The tool prints a one-line warning when the flag is used. Values of personal columns never appear in the report or summary.

A row is skipped when it has no Site ID, when the Site ID is not on the Master sheet, or when its key repeats (the key is the template's natural key: `register-maps/index.csv`, column `key_headers`). Rows with an incomplete key (a Procurement order with neither PR nor PO number) are copied and counted, not deduplicated.

## Mapping files

`register-maps/index.csv` names the Master sheet, header row, first data row and key of each register. `register-maps/<register>.csv` has one row per template column: `template_header` (as the PMIS issues it), `master_header` (the header in the Master; `a|b` gives alternatives for renamed columns), `master_column` (the letter, documentation only), `transform`, `personal`. A template column with an empty `master_header` has no source in the owner's file and stays blank. If the PMIS re-issues a template with new headers, edit the matching row; the report lists every mapping row that matches nothing.

## Tests

`python3 -m unittest discover -s tools/master-import/tests` (or `pytest tools/master-import/tests`). The tests build synthetic workbooks only.
