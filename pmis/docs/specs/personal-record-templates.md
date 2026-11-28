# Personal record templates (contract 0.15.621)

A person can save a record as a template and start a new record from a template or from a previous record. Templates belong to the person who saved them.

- **Where:** the record form of every register (`RegisterDrawer`). A new record shows "Start from" (My templates, Previous records). An existing record shows "Save as template".
- **What is copied:** plain values (text, number, list, multi-list, yes/no) of fields that are not read-only and not locked, plus the record type. Never copied: site, party, files, people, dates, rows.
- **Nothing is saved by starting from a template.** The person still submits the form, so every right, rule and approval of a normal create applies.
- **Rules:** names are unique per register (case-insensitive) among active templates, at most 30 per register, hidden and never deleted. Data: table `user_record_templates` (migration 0741, db/sql 740), routes `GET/POST /record-templates`, `POST /record-templates/:id/archive`.
- **Reset:** the table is in `data_reset_plan()` with `pmis_reset_owner` grants.
