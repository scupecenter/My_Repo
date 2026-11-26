-- 0168_issue_lists_fields: package 1 of the issue work. Two editable lists (IssueCategory, BlockerReason), three new optional fields on the Issues register
-- (issue_category, blocker_reason, issue_no) and an automatic issue number for new issues. Mirror: db/sql/167_issue_lists_fields.sql (kept identical).
--
-- Direction from the owner (relayed 2026-11-26): the issue register is organised, with a description, a type and a reason, shows on the dashboard and tells PMO who
-- holds the solution; the category and reason lists are editable in Settings > Registers > Lists (add, edit, merge, hide); "Uplink Site Not Ready" is the first reason.
--
--   1. Lists. IssueCategory (10 values) and BlockerReason (11 values) are list catalogues like the others: not critical, status pending (a draft for the owner's
--      review), no free "other" text. Their values are data: rename, reorder, add or deactivate them in Settings. The codes are stored in the records and never change.
--   2. Fields of the Issues register. issue_category and blocker_reason (list_code, optional, shown in the list and the filters) and issue_no (text, derived, read-only).
--      Nothing becomes required, nothing existing changes: the old free text Pending Issue stays the only required description.
--   3. Issue number. A new issue (version 1) gets ISS-0001, ISS-0002... from a sequence; a new version of the same issue keeps its number. Existing issues are NOT numbered
--      (no data of existing records is rewritten); the number appears on issues created after this migration.
-- Not in this migration (separate packages): the role-based owner, the dashboard breakdown, the derived "stopped at" rows, any permission or gate change.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('IssueCategory', 'Issue category', 'تصنيف المشكلة',   false, 'pending', false, 'The area an issue belongs to (Fiber, Power, Acquisition...). Values come from RiskCat, party types and procurement scopes.'),
  ('BlockerReason', 'Blocker reason', 'سبب التعطيل',     false, 'pending', false, 'Why the site cannot move and who must act. "Uplink Site Not Ready" is the first reason.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('IssueCategory', 'Fiber',        'Fiber',                  'الألياف',          10),
  ('IssueCategory', 'Power',        'Power / GECOL',          'الكهرباء / GECOL', 20),
  ('IssueCategory', 'Acquisition',  'Acquisition',            'الاستحواذ',        30),
  ('IssueCategory', 'Access',       'Access / Permits',       'الدخول / التصاريح', 40),
  ('IssueCategory', 'Supply',       'Supply / Procurement',   'التوريد / المشتريات', 50),
  ('IssueCategory', 'Contractor',   'Contractor',             'المقاول',          60),
  ('IssueCategory', 'Civil',        'Civil works / Tower',    'الأعمال المدنية / البرج', 70),
  ('IssueCategory', 'Telecom',      'Telecom equipment',      'معدات الاتصالات',  80),
  ('IssueCategory', 'External',     'Landlord / External',    'المالك / جهة خارجية', 90),
  ('IssueCategory', 'Other',        'Other',                  'أخرى',             100),
  ('BlockerReason', 'Uplink Site Not Ready',        'Uplink Site Not Ready',        'موقع الـ Uplink غير جاهز',   10),
  ('BlockerReason', 'Waiting GECOL',                'Waiting for GECOL (power)',    'بانتظار GECOL (الكهرباء)',    20),
  ('BlockerReason', 'Waiting HLC',                  'Waiting for HLC / fiber link', 'بانتظار HLC / وصلة الألياف',  30),
  ('BlockerReason', 'Land or Acquisition',          'Land / acquisition or landlord', 'الأرض / الاستحواذ أو المالك', 40),
  ('BlockerReason', 'Access or Permit',             'Access / permit',              'الدخول / التصريح',            50),
  ('BlockerReason', 'Material Not Delivered',       'Material or equipment not delivered', 'مواد أو معدات لم تصل', 60),
  ('BlockerReason', 'Team Not Available',           'Contractor / team not available', 'مقاول / فريق غير متاح',   70),
  ('BlockerReason', 'Vehicle or Advance Not Ready', 'Vehicle or advance not ready', 'سيارة أو عهدة غير جاهزة',   80),
  ('BlockerReason', 'Approval Pending',             'Client / PMO approval pending', 'اعتماد العميل / PMO معلّق', 90),
  ('BlockerReason', 'Weather or Security',          'Weather / security',           'الطقس / الأمن',               100),
  ('BlockerReason', 'Other',                        'Other',                        'أخرى',                        110)
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('issues', 'issue_no',        'Issue No.',      'رقم المشكلة',  'text',      false, false, true,  NULL, true, 'Issue', 5,  NULL),
  ('issues', 'issue_category',  'Category',       'التصنيف',      'list_code', false, false, false, NULL, true, 'Issue', 15, 'IssueCategory'),
  ('issues', 'blocker_reason',  'Blocker reason', 'سبب التعطيل',  'list_code', false, false, false, NULL, true, 'Issue', 16, 'BlockerReason')
ON CONFLICT (register_key, code) DO NOTHING;

-- Automatic number: version 1 of an issue takes the next number; a later version keeps the number of the version it replaces.
CREATE SEQUENCE IF NOT EXISTS issue_no_seq;
CREATE OR REPLACE FUNCTION reg_issue_no() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prev text;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT data ->> 'issue_no' INTO prev FROM public.register_records WHERE id = NEW.supersedes_id;
    IF prev IS NOT NULL THEN NEW.data := NEW.data || jsonb_build_object('issue_no', prev); END IF;
  ELSE
    NEW.data := NEW.data || jsonb_build_object('issue_no', 'ISS-' || lpad(nextval('public.issue_no_seq')::text, 4, '0'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_reg_issue_no BEFORE INSERT ON register_records FOR EACH ROW WHEN (NEW.register_key = 'issues') EXECUTE FUNCTION reg_issue_no();
REVOKE ALL ON FUNCTION reg_issue_no() FROM PUBLIC;
