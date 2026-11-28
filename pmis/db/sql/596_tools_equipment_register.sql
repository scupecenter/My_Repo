-- 0597_tools_equipment_register: the Tools & Equipment register (C4, contract 0.15.457): the tools and equipment of the project, who holds each one, and when its
-- calibration or inspection is next due. Mirror: db/sql/596_tools_equipment_register.sql (kept identical).
--
--   1. Lists EquipmentCategory, EquipmentStatus and EquipmentDueKind (Settings > Dropdown lists: add, rename, reorder, hide; the codes never change).
--      Retiring a tool is a status: nothing is deleted.
--   2. register_definitions row tools_equipment (site-scoped, several per site, two levels like every register: L1 Data Entry, L2 Data Reviewer & Approver), its
--      fields, its sections (with Arabic names) and its Matrix row. The Matrix row is the register definition itself and is empty in the seed (the convention of 0076
--      and 0184): the admin names who reads, enters and approves; until then a level with nobody goes to the System Admins' inbox (B10).
--      Links: the equipment belongs to its site (the record's own site) and to its custodian (a user column `custodian`).
--   3. The permission module tools_equipment (catalogue key in code; no grant is seeded: no permission widening).
--   4. The template TPL-TOOLS-EQUIPMENT (match keys site + equipment number), issued by tpl_sync_all().
--   5. The Settings data reset: one resettable part, patched in place into data_reset_parts()/data_reset_register_part() (idempotent), or the coverage check stops every reset.
--   6. The next due date feeds the expiry radar (0360): the setting expiry.radar gets the entry tools_equipment -> next_due_date (30, 14 and 7 days) when it has none.
--      The radar tells the Matrix holders of the register in the bell, as for permits. (The generic L5 date_approaching alert rule reads the same column when it exists.)
-- No new table, endpoint or grant. Existing registers and data are untouched.
SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('EquipmentCategory', 'Equipment category',  'فئة المعدة',    false, 'pending', false, 'What kind of tool or equipment a Tools & Equipment record is (C4).'),
  ('EquipmentStatus',   'Equipment status',    'حالة المعدة',   false, 'pending', false, 'Where a tool or equipment item is now (C4).'),
  ('EquipmentDueKind',  'Equipment due kind',  'نوع الاستحقاق', false, 'pending', false, 'What the next due date of an equipment item is for: calibration or inspection (C4).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('EquipmentCategory', 'TestInstrument', 'Test instrument',  'جهاز قياس',        10),
  ('EquipmentCategory', 'HandTool',       'Hand tool',        'أداة يدوية',        20),
  ('EquipmentCategory', 'PowerTool',      'Power tool',       'أداة كهربائية',     30),
  ('EquipmentCategory', 'Lifting',        'Lifting gear',     'معدات رفع',         40),
  ('EquipmentCategory', 'Safety',         'Safety equipment', 'معدات السلامة',     50),
  ('EquipmentCategory', 'Climbing',       'Climbing gear',    'معدات تسلق',        60),
  ('EquipmentCategory', 'Other',          'Other',            'أخرى',              70),
  ('EquipmentStatus',   'InUse',          'In use',           'قيد الاستخدام',     10),
  ('EquipmentStatus',   'InStore',        'In store',         'في المخزن',         20),
  ('EquipmentStatus',   'UnderRepair',    'Under repair',     'قيد الصيانة',       30),
  ('EquipmentStatus',   'Lost',           'Lost',             'مفقودة',            40),
  ('EquipmentStatus',   'Retired',        'Retired',          'خارج الخدمة',       50),
  ('EquipmentDueKind',  'Calibration',    'Calibration',      'معايرة',            10),
  ('EquipmentDueKind',  'Inspection',     'Inspection',       'فحص',               20)
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('tools_equipment', 'Tools & Equipment', 'الأدوات والمعدات', 'tools_equipment', 'register', true, true, ARRAY[]::text[], 2, '{}'::jsonb, true, 210)
ON CONFLICT (register_key) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('tools_equipment', 'equipment_no',    'Equipment No.',          'رقم المعدة',            'text',      true,  false, false, NULL, true,  'Equipment',                  10,  NULL),
  ('tools_equipment', 'name',            'Name',                   'الاسم',                 'text',      true,  false, false, NULL, true,  'Equipment',                  20,  NULL),
  ('tools_equipment', 'category',        'Category',               'الفئة',                 'list_code', true,  false, false, NULL, true,  'Equipment',                  30,  'EquipmentCategory'),
  ('tools_equipment', 'manufacturer',    'Manufacturer',           'الشركة المصنعة',        'text',      false, false, false, NULL, false, 'Equipment',                  40,  NULL),
  ('tools_equipment', 'model',           'Model',                  'الطراز',                'text',      false, false, false, NULL, false, 'Equipment',                  50,  NULL),
  ('tools_equipment', 'serial_no',       'Serial No.',             'الرقم التسلسلي',        'text',      false, false, false, NULL, true,  'Equipment',                  60,  NULL),
  ('tools_equipment', 'equipment_status','Status',                 'الحالة',                'list_code', false, false, false, NULL, true,  'Equipment',                  70,  'EquipmentStatus'),
  ('tools_equipment', 'custodian',       'Custodian',              'المسؤول عن العهدة',     'user',      false, false, false, NULL, true,  'Custody',                    80,  NULL),
  ('tools_equipment', 'custody_date',    'Custody Since',          'تاريخ التسليم',         'date',      false, false, false, NULL, false, 'Custody',                    90,  NULL),
  ('tools_equipment', 'due_kind',        'Due For',                'الاستحقاق لـ',          'list_code', false, false, false, NULL, true,  'Calibration and inspection', 100, 'EquipmentDueKind'),
  ('tools_equipment', 'last_checked_date','Last Calibrated or Inspected', 'تاريخ آخر معايرة أو فحص', 'date', false, true, false, NULL, false, 'Calibration and inspection', 110, NULL),
  ('tools_equipment', 'next_due_date',   'Next Due Date',          'تاريخ الاستحقاق القادم', 'date',     false, false, false, NULL, true,  'Calibration and inspection', 120, NULL),
  ('tools_equipment', 'certificate_no',  'Certificate No.',        'رقم الشهادة',           'text',      false, false, false, NULL, false, 'Calibration and inspection', 130, NULL),
  ('tools_equipment', 'remark',          'Remark',                 'ملاحظات',               'text',      false, false, false, NULL, false, 'Remark',                     140, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

INSERT INTO register_sections (register_key, name_en, name_ar, sort_order)
SELECT v.register_key, v.name_en, v.name_ar, v.sort_order
  FROM (VALUES
    ('tools_equipment', 'Equipment', 'المعدة', 10),
    ('tools_equipment', 'Custody', 'العهدة', 20),
    ('tools_equipment', 'Calibration and inspection', 'المعايرة والفحص', 30),
    ('tools_equipment', 'Remark', 'ملاحظة', 40)) AS v(register_key, name_en, name_ar, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM register_sections s WHERE s.register_key = v.register_key AND s.name_en = v.name_en);

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT 'TPL-TOOLS-EQUIPMENT', r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, NULL, '[["site_code","equipment_no"]]'::jsonb, r.sort_order
FROM register_definitions r WHERE r.register_key = 'tools_equipment'
ON CONFLICT (template_id) DO NOTHING;
SELECT tpl_sync_all();

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('tools_equipment', 'registers', 36, '0597')
ON CONFLICT (key) DO NOTHING;

-- The data reset: patched in place and idempotently, anchored on the Invoices row (0185).
DO $$
DECLARE def text;
  marker text := '    (''invoices'',           ''registers'', ''project'', 290, ''Invoices'', ''الفواتير'', ''{sites,procurement}''::text[]),';
  add text := E'\n    (''tools_equipment'',    ''registers'', ''project'', 295, ''Tools & Equipment'', ''الأدوات والمعدات'', ''{sites}''::text[]),';
BEGIN
  def := pg_get_functiondef('public.data_reset_parts()'::regprocedure);
  IF position('tools_equipment' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_parts() has no invoices row to patch'; END IF;
    EXECUTE replace(def, marker, marker || add);
  END IF;
END $$;

DO $$
DECLARE def text; marker text := ', ''lessons_learned'', ''invoices'') THEN p_key';
BEGIN
  def := pg_get_functiondef('public.data_reset_register_part(text)'::regprocedure);
  IF position('tools_equipment' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_register_part() has no invoices key to patch'; END IF;
    EXECUTE replace(def, marker, ', ''lessons_learned'', ''invoices'', ''tools_equipment'') THEN p_key');
  END IF;
END $$;

-- The expiry radar: the next due date, 30, 14 and 7 days ahead, when the setting has no entry for the register.
UPDATE settings
   SET value = jsonb_set(value, '{registers,tools_equipment}', '{"field": "next_due_date", "lead_days": [30, 14, 7]}'::jsonb, true)
 WHERE key = 'expiry.radar' AND jsonb_typeof(value -> 'registers') = 'object' AND NOT (value -> 'registers' ? 'tools_equipment');
