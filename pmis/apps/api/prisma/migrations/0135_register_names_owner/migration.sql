-- 0135_register_names_owner: the register names the owner asked for on 2026-11-22 (CHANGELOG 179): GECOL Power, Quality Control, RF & Design.
-- Only the seed names are renamed: a name an admin already changed in Settings > Registers is left as it is.
-- Mirror: db/sql/134_register_names_owner.sql (kept byte-identical).

UPDATE register_definitions SET name_en = 'GECOL Power'
 WHERE register_key = 'gecol' AND name_en IN ('GECOL power', 'GECOL');

UPDATE register_definitions SET name_en = 'Quality Control', name_ar = 'ضبط الجودة'
 WHERE register_key = 'quality' AND name_en = 'Quality' AND name_ar = 'الجودة';

UPDATE register_definitions SET name_en = 'RF & Design'
 WHERE register_key = 'rf_design' AND name_en IN ('RF Design', 'RF design');

UPDATE register_definitions SET name_ar = 'الترددات والتصميم'
 WHERE register_key = 'rf_design' AND name_ar = 'تصميم RF';
