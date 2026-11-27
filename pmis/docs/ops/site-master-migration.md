# Site Master: production migration guide

How the real Site Master (the owner's workbook) is loaded into Telecom Site Delivery Workspace for go-live. It ties together things that are built and
described elsewhere; it adds the order, the checks and the stop points. Rule behind it (CLAUDE.md): real data is uploaded through the system once it
is complete, never seeded by a script. Analysis of the owner's file: `docs/plans/2026-11-04-master-template-data-load.md`. Stories: TI-03, TI-07, TI-07b
in `docs/spec/stories-templates-and-import.md`. Reset contract: `docs/ops/data-reset.md`.

## 0. Who does what

| Step owner | Rights needed |
|---|---|
| System Admin (two of them for the reset) | Settings > Data: data reset, master import, column mapping |
| System Admin, or a person who holds L1 and L2 of the Matrix row `site_creation` | the option "Create the sites that are not in Workspace from the Master" |
| Project owner | signs off the comparison report (step 7) |

## 1. Before anything: freeze and back up

1. Agree a freeze: nobody edits the Excel Master from the moment of the final export until sign-off of step 7. A late change is entered in the system.
2. Take a database backup and check it (`infra/backup/db-backup-check.sh`). Run the restore drill once before go-live (`infra/restore-drill.md`) so the restore path is known to work.
3. Note the migration number and the application version of the server (from the server: `git describe` of the deployed release and the latest folder in `apps/api/prisma/migrations`). Keep them in the go-live record.

## 2. Start from a clean project

Use the scoped reset only on a system that holds test or demo data: Settings > Data > Data reset, scope "Everything", two System Admins, with the backup
choice left on. Identity (users, roles, staff) stays. On a fresh install skip this step. Never reset after real data was entered.

## 3. Prepare settings first

The load reads lists and settings. In this order, before the first upload:

1. Settings: regions, clusters, the lists SiteType, SiteScenario, DeliveryScenario, the holidays and the staff registry.
2. Roles and groups: assign people to their regions and to the Matrix rows they hold, including `site_creation` L1 and L2 for the person who creates sites.
3. Column mapping: Settings > Data > Column mapping. Map the headers of the owner's file to the Workspace columns. The known difference is the header of
   column CL3 ("IP Router" in the file, "Indoor IP Router" in the system). Save the aliases before uploading.
4. Check Data Hub (Settings > Data) shows no unmapped column.

## 4. Check the file before upload

- Save the workbook as a plain values file: no macros, no external links (the upload guard refuses `xl/externalLinks/`). Remove orphaned links in Excel
  (Data > Edit links > Break link) and save again.
- Do not remove or rename sheets. Do not edit headers.
- A formula cell is read as the file shows it (its cached value): open and save in Excel once so the cached values are current.
- Keep the file outside the repository. It is real project data.

## 5. Dry run with the comparison

1. Settings > Data > Master import (Imports) > new run, upload the file. The run is a comparison only: nothing is entered yet.
2. Read the comparison: counts of sites in the file, in the system, "Not in Workspace", rows refused with their reasons. Export the comparison
   (the run's export) and keep it.
3. Fix the file or the settings for every refusal reason that is not expected, then upload again as a new run. Repeat until the only differences are expected.

## 6. Apply

1. Apply the run with "Create the sites that are not in Workspace from the Master" ticked. The sites are created first (25 per transaction); the
   screen shows the progress. A stopped run keeps the sites created so far and can be applied again.
2. Choose the historical load option "registers" so the register sheets (RF & Design, Acquisition, Permission Log, As-Built, GECOL, HLC, PR-PO and the
   others in the file) are entered too. Historical dates go through the one-time, time-boxed historical-load waiver (System Admin only).
3. Do not apply a second file over the first before step 7 is signed off.
4. If the run stops or reports failures, do not retry by hand: read the run's result, fix the cause, apply again. The apply is safe to repeat; an
   existing Site ID is never touched.

## 7. Verify and sign off

| Check | How | Pass |
|---|---|---|
| Site count | Site Master total against the file's count of numbered rows | equal |
| Milestone dates | export the Master-format file and compare with the Excel Master (TI-08) | 100% of milestone dates match |
| Register counts | each register's record count against its sheet's row count | equal, or each difference is a listed refusal |
| Spot check | 20 sites chosen by the owner, all columns, against the Excel Master | no difference |
| Gates and status | Dashboard and Project Status against the Excel Dashboard | within the agreed tolerance, differences explained |
| Audit | audit rows `site_create` name the Master run | present |

The project owner signs the comparison report. From that moment Workspace is the system of record and the Excel Master is read only.

## 8. Parallel run and fall-back

Run both for the agreed period (TI-08): export the Master-format file each week and compare. A mismatch is a defect in one of them: log it, fix the
cause, do not edit the Excel to match. If go-live is aborted before sign-off, restore the backup of step 1 (RUNBOOK section 8.7) and start again from
step 2. After sign-off there is no automatic fall-back: use point-in-time restore for a data fault.

## 9. Go-live record

Keep, with the date and names: the migration number and version, the backup id, the comparison report of the final run, the sign-off, the file's
checksum. No secret goes in the record.
