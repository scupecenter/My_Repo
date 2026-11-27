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
-- data_reset_parts()/data_reset_register_part(): patched in place and idempotently (0292 pattern) instead of redefined
-- whole, so register parts added by other migrations are never dropped. The stored text is read with pg_get_functiondef
-- and the lessons_learned row/key is inserted only when missing, anchored on the incidents row added by 0183.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE def text;
  marker text := '    (''incidents'',          ''registers'', ''project'', 280, ''Incidents & Security'', ''الحوادث والأمن'', ''{sites}''::text[]),';
  add text := E'\n    (''lessons_learned'',    ''registers'', ''project'', 285, ''Lessons Learned'', ''الدروس المستفادة'', ''{sites}''::text[]),';
BEGIN
  def := pg_get_functiondef('public.data_reset_parts()'::regprocedure);
  IF position('lessons_learned' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_parts() has no incidents row to patch'; END IF;
    EXECUTE replace(def, marker, marker || add);
  END IF;
END $$;

DO $$
DECLARE def text; marker text := ', ''incidents'') THEN p_key';
BEGIN
  def := pg_get_functiondef('public.data_reset_register_part(text)'::regprocedure);
  IF position('lessons_learned' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_register_part() has no incidents key to patch'; END IF;
    EXECUTE replace(def, marker, ', ''incidents'', ''lessons_learned'') THEN p_key');
  END IF;
END $$;
