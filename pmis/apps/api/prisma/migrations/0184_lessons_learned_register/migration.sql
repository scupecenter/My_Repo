-- 0184_lessons_learned_register: the Lessons Learned register (owner approval 2026-11-26, "C3"): one register for the lessons of
-- the project, from an incident, a snag, a delay or any experience, with the recommendation and where it was applied. Mirror:
-- prisma/migrations/0184_lessons_learned_register/migration.sql (kept identical).
--
--   1. List LessonCategory (Settings > Dropdown lists: add, rename, reorder, hide; the codes never change).
--   2. register_definitions row lessons_learned (site-scoped, several per site, two levels like every register: L1 Data Entry, L2 Data
--      Reviewer & Approver; owner decision 2026-11-01), its fields and its Matrix row. The row is empty in the seed (the convention
--      of 0076 for a new register): the Responsibility Matrix shows it from the register definition and the admin chooses who reads,
--      enters and approves; until then a level with nobody goes to the System Admins' inbox (B10).
--   3. The permission module lessons_learned (the grid; no grant is seeded: a module starts with the System Admins and the admin gives
--      it out in Roles & Responsibilities; no permission widening). The nav catalogue key for the side menu.
--   4. The upload/download template TPL-LESSONS-LEARNED (match keys site + date + title), issued by tpl_sync_all().
--   5. The Settings data reset (0151): the new register is one resettable part, or the coverage check stops every reset.
--
-- No new table and no new endpoint: the register framework of 0019 runs the records, the steps, the levels and the views; the
-- generic register page and the Data entry > Templates page pick the register up. Existing registers and data are untouched.

-- the tables below have forced row-level security; this runs as the migration role, which sees every region
SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Dropdown lists (Settings > Dropdown lists)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('LessonCategory', 'Lesson category', 'فئة الدرس', false, 'pending', false, 'What a Lessons Learned record is about (owner approval 2026-11-26, C3).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('LessonCategory', 'Safety',      'Safety',      'السلامة',      10),
  ('LessonCategory', 'Quality',     'Quality',     'الجودة',       20),
  ('LessonCategory', 'Schedule',    'Schedule',    'الجدول الزمني', 30),
  ('LessonCategory', 'Cost',        'Cost',        'التكلفة',       40),
  ('LessonCategory', 'Procurement', 'Procurement', 'المشتريات',     50),
  ('LessonCategory', 'Design',      'Design',      'التصميم',       60),
  ('LessonCategory', 'Security',    'Security',    'الأمن',         70),
  ('LessonCategory', 'Other',       'Other',       'أخرى',          80)
ON CONFLICT (catalogue_code, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The register and its fields (the Matrix row is the register definition itself; no cells are seeded)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('lessons_learned', 'Lessons Learned', 'الدروس المستفادة', 'lessons_learned', 'register', true, true, ARRAY[]::text[], 2, '{}'::jsonb, true, 190)
ON CONFLICT (register_key) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('lessons_learned', 'lesson_date',    'Lesson Date',    'تاريخ الدرس',     'date',      true,  true,  false, NULL, true,  'Lesson',    10, NULL),
  ('lessons_learned', 'title',          'Title',          'العنوان',         'text',      true,  false, false, NULL, true,  'Lesson',    20, NULL),
  ('lessons_learned', 'category',       'Category',       'الفئة',           'list_code', true,  false, false, NULL, true,  'Lesson',    30, 'LessonCategory'),
  ('lessons_learned', 'source',         'Source',         'المصدر',          'text',      false, false, false, NULL, true,  'Lesson',    40, NULL),
  ('lessons_learned', 'description',    'What Happened',  'ما حدث',          'text',      false, false, false, NULL, false, 'Lesson',    50, NULL),
  ('lessons_learned', 'lesson',         'The Lesson',     'الدرس',           'text',      true,  false, false, NULL, false, 'Lesson',    60, NULL),
  ('lessons_learned', 'recommendation', 'Recommendation', 'التوصية',         'text',      false, false, false, NULL, false, 'Follow-up', 70, NULL),
  ('lessons_learned', 'applied_to',     'Applied To',     'طُبّق على',       'text',      false, false, false, NULL, true,  'Follow-up', 80, NULL),
  ('lessons_learned', 'closed_date',    'Closed Date',    'تاريخ الإغلاق',   'date',      false, true,  false, NULL, true,  'Follow-up', 90, NULL),
  ('lessons_learned', 'remark',         'Remark',         'ملاحظات',         'text',      false, false, false, NULL, false, 'Remark',    100, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The side-menu catalogue key (labels, icon, route and rights stay in the web code)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('lessons_learned', 'registers', 29, '0184')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The upload/download template
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT 'TPL-LESSONS-LEARNED', r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, NULL, '[["site_code","lesson_date","title"]]'::jsonb, r.sort_order
FROM register_definitions r WHERE r.register_key = 'lessons_learned'
ON CONFLICT (template_id) DO NOTHING;
SELECT tpl_sync_all();


-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The Settings data reset (0151): the new register is one resettable part, or the coverage check stops every reset. Both
--    functions are redefined from 0151; the only changes are the lessons_learned part row and the lessons_learned key of the register map.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION data_reset_parts()
RETURNS TABLE (code text, grp text, kind text, ord integer, label_en text, label_ar text, depends_on text[])
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM (VALUES
    ('sites',              'project',   'project',  10, 'Sites, tasks, milestones, gates and baselines', 'المواقع ومهامها ومعالمها وبواباتها والخطط الأساسية', '{}'::text[]),
    ('documents',          'project',   'project',  20, 'Documents and generated forms (Library)', 'المستندات والنماذج المولّدة (المكتبة)', '{sites}'::text[]),
    ('imports',            'project',   'project',  30, 'Imports, upload batches and exports', 'الاستيرادات ودفعات الرفع والتصديرات', '{sites}'::text[]),
    ('notifications',      'project',   'project',  40, 'Notifications, inbox and follows', 'الإشعارات وصندوق الوارد والمتابعات', '{}'::text[]),
    ('daily_plan',         'project',   'project',  50, 'Daily Plan', 'الخطة اليومية', '{sites}'::text[]),
    ('kpi',                'project',   'project',  60, 'Project Status and KPI snapshots', 'حالة المشروع ولقطات مؤشرات الأداء', '{sites}'::text[]),
    ('procurement',        'registers', 'project', 100, 'Procurement (PR / PO / WO, assignments)', 'المشتريات (PR / PO / WO والتكليفات)', '{sites}'::text[]),
    ('gecol',              'registers', 'project', 110, 'GECOL Power', 'كهرباء GECOL', '{sites}'::text[]),
    ('hlc',                'registers', 'project', 120, 'HLC fiber', 'ألياف HLC', '{sites}'::text[]),
    ('permits',            'registers', 'project', 130, 'Permits & HSE', 'التصاريح والسلامة', '{sites}'::text[]),
    ('warehouse',          'registers', 'project', 140, 'Warehouse (movements and stock; the item master stays)', 'المخزن (الحركات والأرصدة؛ يبقى دليل الأصناف)', '{sites}'::text[]),
    ('quality',            'registers', 'project', 150, 'Quality Control (inspections and QC snags)', 'ضبط الجودة (الفحوص وملاحظات الجودة)', '{sites}'::text[]),
    ('issues',             'registers', 'project', 160, 'Issue Log', 'سجل المشاكل', '{sites}'::text[]),
    ('risks',              'registers', 'project', 170, 'Risk Register', 'سجل المخاطر', '{sites}'::text[]),
    ('change_control',     'registers', 'project', 180, 'Change Control (and the scope exceptions it made)', 'ضبط التغيير (واستثناءات النطاق الناتجة عنه)', '{sites}'::text[]),
    ('readiness',          'registers', 'project', 190, 'Readiness & Handover', 'الجاهزية والتسليم', '{sites}'::text[]),
    ('as_built',           'registers', 'project', 200, 'As-Built (the item list stays)', 'كما نُفّذ (تبقى قائمة البنود)', '{sites}'::text[]),
    ('meetings',           'registers', 'project', 210, 'Meetings', 'الاجتماعات', '{sites}'::text[]),
    ('rf_design',          'registers', 'project', 220, 'RF & Design', 'الترددات والتصميم', '{sites}'::text[]),
    ('acquisition',        'registers', 'project', 230, 'Acquisition', 'الاستحواذ', '{sites}'::text[]),
    ('dismantle',          'registers', 'project', 240, 'Dismantle', 'الفك', '{sites}'::text[]),
    ('deliverables',       'registers', 'project', 250, 'Deliverables', 'المخرجات', '{sites}'::text[]),
    ('car_dispatcher',     'registers', 'project', 260, 'Car Dispatcher bookings (the vehicles stay)', 'حجوزات السيارات (تبقى المركبات)', '{sites,procurement}'::text[]),
    ('financial_advances', 'registers', 'project', 270, 'Financial Advances', 'العهد المالية', '{sites,procurement}'::text[]),
    ('lessons_learned',    'registers', 'project', 280, 'Lessons Learned', 'الدروس المستفادة', '{sites}'::text[]),
    ('users',              'identity',  'identity', 900, 'Users: deactivate every account except the System Admins', 'المستخدمون: تعطيل كل الحسابات عدا مديري النظام', '{}'::text[]),
    ('roles',              'identity',  'identity', 910, 'Roles, groups and delegations (role definitions and profiles stay)', 'الأدوار والمجموعات والتفويضات (تبقى تعريفات الأدوار والملفات)', '{}'::text[]),
    ('staff',              'identity',  'identity', 920, 'Staff registry and absences', 'سجل الموظفين والغيابات', '{}'::text[])
  ) v(code, grp, kind, ord, label_en, label_ar, depends_on)
$$;

CREATE OR REPLACE FUNCTION data_reset_register_part(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_key IN ('procurement', 'procurement_hlc') THEN 'procurement'
    WHEN p_key IN ('permits_hse', 'permits_hse_acq', 'permits_hse_om', 'permits_hse_te') THEN 'permits'
    WHEN p_key IN ('quality', 'quality_te') THEN 'quality'
    WHEN p_key = 'readiness_handover' THEN 'readiness'
    WHEN p_key = 'site_creation' THEN 'sites'
    WHEN p_key IN ('gecol', 'hlc', 'warehouse', 'issues', 'risks', 'change_control', 'as_built', 'meetings', 'rf_design', 'acquisition', 'dismantle',
                   'deliverables', 'car_dispatcher', 'financial_advances', 'daily_plan', 'lessons_learned') THEN p_key
  END
$$;
