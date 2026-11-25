-- 0157_site_master_names: the stream templates carry the name "Site Master" (owner decision, PR #214 discussion 2026-11-25).
-- Migrations 0077 and 0079 had named them "SITE 360: ..." and "الموقع 360: ...". Display names only: IDs, versions, data and
-- permissions are unchanged. A name an admin already changed is left as it is (only the seeded prefix is replaced).
-- Mirror: db/sql/156_site_master_names.sql (kept byte-identical).
UPDATE template_definitions
   SET name = replace(name, 'SITE 360: ', 'Site Master: ')
 WHERE name LIKE 'SITE 360: %';
UPDATE template_definitions
   SET name_ar = replace(replace(name_ar, 'الموقع 360: ', 'Site Master: '), 'SITE 360: ', 'Site Master: ')
 WHERE name_ar LIKE 'الموقع 360: %' OR name_ar LIKE 'SITE 360: %';
