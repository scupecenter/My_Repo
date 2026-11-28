# Site pack (D5, contract 0.15.461, no migration)

A zip of one site: one workbook per part plus a README. Started with `POST /exports/master` and `{ site_pack: { site_id, parts? } }` (alone, not with parts, view or regions). Button "Site pack" on the site page (next to "Export current view"). The file lands in the export log (Data hub > Export) like any export and is downloaded there.

- Same engine, lock and audit as the other exports: the job runs as the requester, row-level security applies, the export grant is checked per part and per region (the region of the site). Start, completion and download are audited with the site id.
- Content: the site's Master row, its milestones and tasks, and every site-scoped register the caller may export, filtered to the site. Voided records are left out. Project-wide figures and the dismantle part are not included.
- Fields the caller may not read are left out: a hidden site custom field, a Master column of a part the caller may not export, and the columns a register does not export (Settings > Registers > columns, "in export"). Personal columns stay empty (Q469).
- Settings: no new setting. Which columns a register exports is Settings > Registers > columns; who may export is the export grant in the Matrix.
- Not included yet: a PDF form of the pack (the spec says "zip or PDF"; the zip is built).
