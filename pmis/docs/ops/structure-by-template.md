# Edit the structure of a register through a template

Contract 0.15.401, migration 0560. Settings > Data > Edit through templates (admins only).

## How it works
1. Download the template of a register. Who may edit the columns (System Admin or a delegate of `fields.edit`) gets a **Structure** sheet: one row per column (code, labels EN and AR, type, list, required, order, section, where it shows, active). It is written from the live definition at the moment of the download, so it is never an old copy.
2. Change the sheet in Excel and upload the file in the same tab. The data sheets are not read. Nothing is written to the register: the upload makes a **structure proposal**.
3. The proposal shows every change with its effect on the data (rows holding a value, how many values convert on a type change). An item that cannot be applied is **blocked** and the approval stays disabled until a new proposal leaves it out.
4. A System Admin approves (step-up). The items are applied through the existing column doors (migration 0094/0095) in one transaction: one failure rolls everything back. The template triggers then issue the new template version, and files of the older version follow rule D112.
5. A proposal that changes a type or hides a column needs a **second** System Admin (submitter and approver differ).
6. Undo is a proposal of its own (the "before" values; added columns are hidden), approved the same way. Nothing is silently reverted.

## What the sheet cannot do
The code of a column never changes. A column that holds values is hidden (Active = No), never deleted. A type change is accepted only when every value converts. System columns change label, order and visibility only. The sheet cannot create or delete a register, change the computed Master columns, the workflow, rights or roles.

## Audit and rights
Submit, reject, apply and undo are audited (`structure_proposal_*`, with the before and after). The table `structure_proposals` is written only by the doors (owner `pmis_definer`; no write right for the API role, see `db/sql/app_grants.sql`). The proposals screen and the doors need `fields.edit` for all regions; the approval needs a System Admin.

## Not in this slice
Alternative names (import aliases) have no storage yet and are not in the sheet. The same tab inside the Data hub and the gear shortcut from Data entry are follow-ups.
