-- 0167: the Register columns switches "In filters" (in_filter) and "In the export" (in_export) now act (owner decision relayed 2026-11-26: make them work, with
-- every existing column kept in both, so no filter or export column disappears).
--
-- WHAT THIS MIGRATION DOES (data only, additive, no function or permission change):
--   1. Every existing register column is set to in_filter = true and in_export = true. Before this, in_filter was false on all columns that existed before 0095
--      and nothing read it; once the code reads it, a false would have removed the filter. So no filter or export column is lost by this change.
--   2. The column default of in_filter becomes true (it was false), so a register column added by any later migration or seed is offered in filters like before.
--      The Register columns screen already sends the four switches explicitly; this only changes the fallback.
-- WHERE THE SWITCHES ARE READ (code, this release): the filter builder catalog of the register lists (views/filter-catalog.service.ts: in_filter) and the register
-- export (exports/master-export.service.ts: in_export, for the columns offered and the columns written). The register list and the template were already
-- governed by in_list and in_template. A switch that is off never adds a column to anything; it only removes it from that place.
-- The UPDATE rewrites only rows that were false, so it is a no-op on a second run. register_fields is not read for permissions anywhere.

UPDATE register_fields SET in_filter = true WHERE NOT in_filter;
UPDATE register_fields SET in_export = true WHERE NOT in_export;
ALTER TABLE register_fields ALTER COLUMN in_filter SET DEFAULT true;
