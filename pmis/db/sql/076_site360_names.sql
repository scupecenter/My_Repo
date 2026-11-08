-- 0077_site360_names (owner decision 2026-11-07, Q522): the Site Register is named SITE 360 and its sub-sections carry no
-- "Register" in their names. Display names only: codes, versions, data and permissions are unchanged. A name an admin
-- already changed is left as it is (only the seeded value is replaced).
UPDATE workflow_views SET name_en = 'Civil Works', name_ar = 'الأعمال المدنية'
 WHERE code = 'CW' AND name_en = 'CW Register';
UPDATE workflow_views SET name_en = 'Installation (TE)', name_ar = 'التركيبات'
 WHERE code = 'TE' AND name_en = 'TE Register';
UPDATE template_definitions
   SET name    = replace(name, 'Site Register: ', 'SITE 360: '),
       name_ar = replace(name_ar, 'سجل المواقع: ', 'SITE 360: ')
 WHERE template_id IN ('TPL-SITE-DA', 'TPL-SITE-CW', 'TPL-SITE-TE', 'TPL-SITE-CL');
