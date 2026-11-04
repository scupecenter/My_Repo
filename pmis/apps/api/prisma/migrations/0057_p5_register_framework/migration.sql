-- 0057_p5_register_framework: lists, field types and Meetings (work package P5 of the owner answers of 2026-11-04: Q12, Q104, Q111, D108b; contract 0.12.5;
-- CHANGELOG 85). Mirrored byte-identically as db/sql/056_p5_register_framework.sql.
--
-- What this adds.
--   1. Q104, the list catalogue. Every list of a register is data: list_catalogues (code, EN/AR names, `critical`, `status` pending or confirmed,
--      `allow_other`) and list_values (a stable code, EN/AR labels, aliases, functional groups, order, active). The code is the value stored in the
--      records, so nothing already saved changes; a label can be renamed, a value is deactivated, never deleted. register_fields.list_catalogue links a
--      field to its catalogue, and register_fields.options keeps the active codes of the catalogue (materialised, so every existing reader keeps working).
--      Seeds: the values of each list as the PMIS has them today (the field's closed list, else the Master Setting list of the same name), plus every
--      value already saved in a record (nothing is lost). Agreed by the owner and `confirmed`: TeamSpecialization (8 values; the old text CW is kept as an
--      inactive value), StaffStatus (Active / Inactive) and CompletionStatus (the execution status Done / Pending / N/A). Every other list is `pending`
--      (a draft for the owner's review, Q104 class C) and keeps working. A list that was free text keeps accepting another value while it is not
--      critical (`allow_other`, the "Other with a description" of Q104; the API shows it as the warning `list_other`). A critical list accepts only its
--      values and, while it has no active value, blocks the final approval of every record of a register that uses it (list_not_configured).
--      Written only by admin_save_list_catalogue and admin_save_list_value (System Admin or a delegate of fields.edit for all regions, a reason,
--      If-Match, audited with before and after through log_audit_write). A change of the values re-issues the templates that use the list.
--   2. Field types. register_fields.field_type gains multi_user, multi_site, file, child_list, warehouse_item and list_code (a catalogue value; with
--      options.multiple an array of codes). reg_clean_data checks and normalises them (a list value may be typed as its code, its label or an alias; users
--      by id, employee ID or e-mail; sites by id or code inside the caller's regions; Warehouse items by id or item code; a child list row gets a stable id).
--      At submit (trigger p5_record_rules): a file field must name a current file of the record's own document slots (a typed reference is not an
--      upload, Q111; reg_record_file_ok is the hook the documents package fills for global records, Q228), and an inactive list value or Warehouse item
--      may stay only where the previous version already had it. custom_check_value accepts a catalogue for custom list fields (validation.list_catalogue).
--   3. Q12 and Q111, Meetings. New fields: organiser (user), attendee_users (multi_user), linked_site_ids (multi_site; empty = a project-wide meeting),
--      minutes_file (file) and action_items_list (child_list: action, owner, due date, status from ActionStatus, closed date, task link). Date and title
--      stay the only required fields. The old free-text fields stay as read-only "old text" until an explicit, reviewed conversion
--      (reg_meeting_convert): once per logical record, never duplicating an action, audited.
--   4. D108b: RF Height of the As-Built register stays a number in metres; a new optional text field rf_height_note holds values such as "30/45".
--   5. Templates: tpl_columns emits the new types (multi values separated by ";", file and child list columns grey and never read).
--   6. pmis_app is read-only on the new tables (db/sql/app_grants.sql); the writers are SECURITY DEFINER functions owned by pmis_definer.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The list catalogue
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE list_catalogues (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[A-Z][A-Za-z0-9]{1,40}$'),
  name_en     TEXT        NOT NULL CHECK (char_length(btrim(name_en)) BETWEEN 2 AND 200),
  name_ar     TEXT,
  description TEXT,
  critical    BOOLEAN     NOT NULL DEFAULT false,   -- drives a calculation, a rule or a permission: only its values, and approval waits until it has one
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),   -- pending = a draft for the owner's review (Q104)
  allow_other BOOLEAN     NOT NULL DEFAULT false,   -- another value is accepted as typed (transitional, non-critical lists only)
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  version     INTEGER     NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by  UUID,
  CONSTRAINT list_catalogues_critical_closed CHECK (NOT (critical AND allow_other))
);

CREATE TABLE list_values (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalogue_code TEXT        NOT NULL REFERENCES list_catalogues (code) ON DELETE RESTRICT ON UPDATE RESTRICT,
  code           TEXT        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 80 AND code = btrim(code) AND code !~ '[[:cntrl:];]'),
  label_en       TEXT        NOT NULL CHECK (char_length(btrim(label_en)) BETWEEN 1 AND 200),
  label_ar       TEXT,
  aliases        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],   -- old names that map to this code on entry and import (Q143)
  groups         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],   -- functional groups (for example CW and TE of TeamSpecialization, closed of ActionStatus)
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  version        INTEGER     NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by     UUID,
  CONSTRAINT list_values_code_key UNIQUE (catalogue_code, code)
);
CREATE INDEX list_values_catalogue_idx ON list_values (catalogue_code, is_active, sort_order);

-- A value keeps its code and its list for ever (records store the code); nothing is deleted.
CREATE OR REPLACE FUNCTION list_values_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a list value is deactivated, never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.catalogue_code IS DISTINCT FROM OLD.catalogue_code THEN
    RAISE EXCEPTION 'the code and the list of a value never change (deactivate it and add a new one)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER list_values_guard BEFORE UPDATE OR DELETE ON list_values FOR EACH ROW EXECUTE FUNCTION list_values_guard();

CREATE OR REPLACE FUNCTION list_catalogues_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a list is deactivated, never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'the code of a list never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER list_catalogues_guard BEFORE UPDATE OR DELETE ON list_catalogues FOR EACH ROW EXECUTE FUNCTION list_catalogues_guard();

ALTER TABLE register_fields ADD COLUMN list_catalogue TEXT REFERENCES list_catalogues (code) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE register_fields DROP CONSTRAINT register_fields_field_type_check;
ALTER TABLE register_fields ADD CONSTRAINT register_fields_field_type_check CHECK (field_type IN (
  'text', 'number', 'date', 'list', 'yes_no', 'user', 'external_team', 'multi_user', 'multi_site', 'file', 'child_list', 'warehouse_item', 'list_code'));
ALTER TABLE register_fields ADD CONSTRAINT register_fields_list_code_catalogue CHECK (field_type <> 'list_code' OR list_catalogue IS NOT NULL);
COMMENT ON COLUMN register_fields.list_catalogue IS '0057 (Q104): the list catalogue of a list or list_code field; options then holds the active codes of the catalogue (list) or {"multiple": bool} (list_code).';

ALTER TABLE list_catalogues ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_catalogues FORCE ROW LEVEL SECURITY;
ALTER TABLE list_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_values FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON list_catalogues FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON list_catalogues FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
CREATE POLICY rls_select ON list_values FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON list_values FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

GRANT SELECT, INSERT, UPDATE ON list_catalogues, list_values TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON register_fields TO pmis_definer;
GRANT SELECT ON warehouse_items, task_instances, task_definitions, document_slots, document_files TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON list_catalogues, list_values FROM pmis_app;
    GRANT SELECT ON list_catalogues, list_values TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Seeds (data, not code). The values are the ones the PMIS uses today: the closed list of the field, else the Master Setting list of that name.
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('ProcScope',          'Procurement scope',       'نطاق المشتريات',        true,  'pending',   false, 'Drives the task sources and the Matrix rows of Procurement.'),
  ('Delivery',           'Delivery',                'طريقة التنفيذ',          true,  'pending',   false, 'Drives the PR / PO rules of Procurement.'),
  ('ProcStatus',         'Order status',            'حالة الطلب',            false, 'pending',   true,  NULL),
  ('FiberStatus',        'Fiber status',            'حالة الألياف',          false, 'pending',   true,  NULL),
  ('PAStatus',           'Permit status',           'حالة التصريح',          true,  'pending',   false, 'Drives the task sources of the access permits.'),
  ('EHSCheck',           'EHS check',               'فحص السلامة',           false, 'pending',   true,  'PTW checks and the O&M checklist.'),
  ('CompanyType',        'Company type',            'نوع الشركة',            true,  'pending',   false, 'Drives the type of the external party.'),
  ('CoStatus',           'Company status',          'حالة الشركة',           true,  'pending',   false, 'Drives whether the external party is active.'),
  ('TeamType',           'Team type',               'نوع الفريق',            false, 'pending',   true,  NULL),
  ('TeamSpecialization', 'Team specialization',     'تخصص الفريق',           true,  'confirmed', false, 'Agreed values (owner answer Q104). CW and TE are groups, not values (Q143).'),
  ('TeamStatus',         'Team status',             'حالة الفريق',           true,  'pending',   false, 'Drives whether the external team is active.'),
  ('StaffStatus',        'Staff status',            'حالة الموظف',           true,  'confirmed', false, 'Agreed values (owner answer Q104).'),
  ('CompletionStatus',   'Execution status',        'حالة التنفيذ',          true,  'confirmed', false, 'Agreed values (owner answer Q104); not used for IssueStatus or RiskStatus.'),
  ('QCStage',            'Quality stage',           'مرحلة الجودة',          true,  'pending',   false, NULL),
  ('QCActivity',         'Quality activity',        'نشاط الجودة',           false, 'pending',   true,  NULL),
  ('PointType',          'Point type',              'نوع النقطة',            false, 'pending',   false, NULL),
  ('Severity',           'Severity',                'الخطورة',               true,  'pending',   false, 'Drives the blocking of a snag.'),
  ('QIResult',           'Quality result',          'نتيجة الجودة',          false, 'pending',   true,  NULL),
  ('IssueStatus',        'Issue status',            'حالة المشكلة',          true,  'pending',   false, 'Drives the open issues of the dashboard.'),
  ('RiskCat',            'Risk category',           'فئة الخطر',             false, 'pending',   true,  NULL),
  ('ScopeCWTE',          'Scope (CW / TE)',         'النطاق (CW / TE)',      false, 'pending',   true,  NULL),
  ('RiskResponse',       'Risk response',           'الاستجابة للخطر',        false, 'pending',   true,  NULL),
  ('RiskStatus',         'Risk status',             'حالة الخطر',            false, 'pending',   true,  NULL),
  ('Trend',              'Trend',                   'الاتجاه',               false, 'pending',   true,  NULL),
  ('ChangeType',         'Change type',             'نوع التغيير',           true,  'pending',   false, 'Drives the gate shifts of Change Control.'),
  ('ChangeScope',        'Change scope',            'نطاق التغيير',          false, 'pending',   false, NULL),
  ('SiteType',           'Site type',               'نوع الموقع',            false, 'pending',   true,  NULL),
  ('DeliveryScenario',   'Delivery scenario',       'سيناريو التنفيذ',        true,  'pending',   false, NULL),
  ('TowerOwner',         'Tower owner',             'مالك البرج',            false, 'pending',   true,  NULL),
  ('ExistNew',           'Existing / New',          'قائم / جديد',           false, 'pending',   false, NULL),
  ('RTGF',               'RT / GF',                 'سطح / أرضي',            false, 'pending',   false, NULL),
  ('TowerType',          'Tower type',              'نوع البرج',             false, 'pending',   true,  NULL),
  ('ReviewStatus',       'Review status',           'حالة المراجعة',         false, 'pending',   true,  NULL),
  ('Candidate',          'Candidate',               'المرشح',                true,  'pending',   false, NULL),
  ('PassFail',           'Pass / Fail',             'ناجح / راسب',           false, 'pending',   false, NULL),
  ('TestPit',            'Test pit result',         'نتيجة حفرة الاختبار',    false, 'pending',   true,  NULL),
  ('YesNo',              'Yes / No',                'نعم / لا',              true,  'pending',   false, NULL),
  ('YesNA',              'Yes / N/A',               'نعم / لا ينطبق',        true,  'pending',   false, NULL),
  ('Ownership',          'Ownership type',          'نوع الملكية',           false, 'pending',   true,  NULL),
  ('WLVendor',           'WL vendor',               'مورد WL',               false, 'pending',   true,  NULL),
  ('WLAntennaType',      'WL antenna type',         'نوع هوائي WL',          false, 'pending',   true,  'Planned as Warehouse items (Q108).'),
  ('MWVendor',           'MW vendor',               'مورد MW',               false, 'pending',   true,  NULL),
  ('MWAntennaType',      'MW antenna type',         'نوع هوائي MW',          false, 'pending',   true,  'Planned as Warehouse items (Q108).'),
  ('IPVendor',           'IP vendor',               'مورد IP',               false, 'pending',   true,  NULL),
  ('RouterType',         'Router type',             'نوع الراوتر',           false, 'pending',   true,  'Planned as Warehouse items (Q108).'),
  ('RectifierStatus',    'Rectifier status',        'حالة المقوّم',          false, 'pending',   true,  NULL),
  ('PowerVendor',        'Power vendor',            'مورد الطاقة',           false, 'pending',   true,  NULL),
  ('MDBType',            'MDB type',                'نوع لوحة التوزيع',       false, 'pending',   true,  NULL),
  ('BatteryType',        'Battery type',            'نوع البطارية',          false, 'pending',   true,  NULL),
  ('DismantleReason',    'Dismantle reason',        'سبب الفك',              false, 'pending',   false, NULL),
  ('TxnStatus',          'Warehouse status',        'حالة الحركة',           true,  'pending',   false, 'Drives the stock postings.'),
  ('Condition',          'Return condition',        'حالة المرتجع',          true,  'pending',   false, 'Drives the stock postings.'),
  ('ReturnReason',       'Return reason',           'سبب الإرجاع',           false, 'pending',   false, NULL),
  ('MeetingType',        'Meeting type',            'نوع الاجتماع',          false, 'pending',   true,  NULL),
  ('ActionStatus',       'Action status',           'حالة الإجراء',          false, 'pending',   false, 'Status of a meeting action item; values in the group closed need the closed date.')
ON CONFLICT (code) DO NOTHING;

-- The fields of each list (register, field, list).
CREATE TEMP TABLE p5_links (register_key text, field_code text, catalogue text);
INSERT INTO p5_links VALUES
  ('procurement', 'scope', 'ProcScope'), ('procurement', 'delivery', 'Delivery'), ('procurement', 'order_status', 'ProcStatus'),
  ('hlc', 'fiber_status', 'FiberStatus'),
  ('permits_hse', 'status', 'PAStatus'), ('permits_hse', 'jsa_tra', 'EHSCheck'), ('permits_hse', 'toolbox_talk', 'EHSCheck'), ('permits_hse', 'work_at_height', 'EHSCheck'),
  ('permits_hse', 'lifting_plan', 'EHSCheck'), ('permits_hse', 'loto', 'EHSCheck'), ('permits_hse', 'rescue_plan', 'EHSCheck'),
  ('readiness_handover', 'om_checklist', 'EHSCheck'),
  ('contractors', 'company_type', 'CompanyType'), ('contractors', 'company_status', 'CoStatus'), ('contractors', 'team_type', 'TeamType'),
  ('contractors', 'specialization', 'TeamSpecialization'), ('contractors', 'team_status', 'TeamStatus'),
  ('quality', 'stage', 'QCStage'), ('quality', 'activity', 'QCActivity'), ('quality', 'point_type', 'PointType'), ('quality', 'severity', 'Severity'), ('quality', 'result', 'QIResult'),
  ('issues', 'issue_status', 'IssueStatus'),
  ('risks', 'category', 'RiskCat'), ('risks', 'scope', 'ScopeCWTE'), ('risks', 'response', 'RiskResponse'), ('risks', 'status', 'RiskStatus'), ('risks', 'trend', 'Trend'),
  ('change_control', 'change_type', 'ChangeType'), ('change_control', 'change_scope', 'ChangeScope'),
  ('rf_design', 'site_type', 'SiteType'), ('rf_design', 'site_scenario', 'DeliveryScenario'), ('rf_design', 'tower_owner', 'TowerOwner'), ('rf_design', 'existing_or_new', 'ExistNew'),
  ('rf_design', 'cabinet_foundation', 'ExistNew'), ('rf_design', 'rt_or_gf', 'RTGF'), ('rf_design', 'tower_type', 'TowerType'), ('rf_design', 'tssr_status', 'ReviewStatus'),
  ('acquisition', 'candidate', 'Candidate'), ('acquisition', 'mw_los_check', 'PassFail'), ('acquisition', 'test_pit_result', 'TestPit'), ('acquisition', 'selected', 'YesNo'),
  ('acquisition', 'title_verified', 'YesNo'), ('acquisition', 'ownership_type', 'Ownership'),
  ('as_built', 'cw_as_built_submitted', 'YesNA'), ('as_built', 'wl_vendor', 'WLVendor'), ('as_built', 'wl_antenna_type', 'WLAntennaType'), ('as_built', 'mw_vendor', 'MWVendor'),
  ('as_built', 'mw_antenna_type', 'MWAntennaType'), ('as_built', 'ip_vendor', 'IPVendor'), ('as_built', 'router_type', 'RouterType'), ('as_built', 'rectifier_status', 'RectifierStatus'),
  ('as_built', 'power_vendor', 'PowerVendor'), ('as_built', 'mdb_type', 'MDBType'), ('as_built', 'battery_type', 'BatteryType'),
  ('dismantle', 'dismantle_reason', 'DismantleReason'),
  ('warehouse', 'txn_status', 'TxnStatus'), ('warehouse', 'condition', 'Condition'), ('warehouse', 'reason', 'ReturnReason'),
  ('meetings', 'meeting_type', 'MeetingType');

-- Master Setting values of the lists that were free text in the PMIS (the field had no closed list).
CREATE TEMP TABLE p5_master (catalogue text, ord int, code text);
INSERT INTO p5_master
SELECT v.catalogue, t.ord, t.code
FROM (VALUES
  ('ProcStatus',   ARRAY['Active', 'Completed', 'Cancelled', 'Rejected']),
  ('FiberStatus',  ARRAY['Requested', 'Pending', 'Received', 'Received (TBN)', 'Through MW Link', 'No Fiber', 'Cancelled']),
  ('EHSCheck',     ARRAY['Done', 'Not Done', 'N/A']),
  ('CompanyType',  ARRAY['CW Contractor', 'TE Vendor', 'GECOL Contractor', 'Dismantle Contractor', 'In-House', 'Other']),
  ('CoStatus',     ARRAY['Active', 'Suspended', 'Blacklisted', 'Inactive']),
  ('TeamType',     ARRAY['Internal', 'Contractor']),
  ('TeamStatus',   ARRAY['Active', 'Inactive']),
  ('StaffStatus',  ARRAY['Active', 'Inactive']),
  ('CompletionStatus', ARRAY['Done', 'Pending', 'N/A']),
  ('QCActivity',   ARRAY['Tower', 'Tower Foundation Pre-Pour Readiness', 'Tower Grounding Resistance Test', 'Tower Verticality and Alignment', 'Cabinet Foundation', 'Mounting Pole',
                         'Cable Tray', 'Indoor Rack', 'Site Optical Fiber', 'AC / DC Box', 'Site GND', 'MTS Cabinet', 'Indoor IP Router', 'RF Antenna',
                         'Antenna Azimuth / Tilt Verification', 'MW Antenna', 'DC / OF Cable', 'Concrete Compression Test']),
  ('Severity',     ARRAY['Critical', 'Major', 'Minor']),
  ('QIResult',     ARRAY['Pending', 'Approved', 'Rejected', 'Cleared', 'Pass', 'Fail', 'N/A']),
  ('IssueStatus',  ARRAY['Open', 'In Progress', 'Closed']),
  ('RiskCat',      ARRAY['Acquisition', 'Permits', 'Power', 'Fiber', 'Schedule', 'Resources', 'Supply', 'Quality', 'HSE', 'Acceptance', 'Governance', 'Other',
                         'Permit / Access', 'Site Acquisition', 'External / Security', 'External / Weather', 'Supply Chain', 'Contractor', 'Design / Scope', 'EHS',
                         'Data Integrity', 'Network Dependency', 'Technical', 'Dismantle']),
  ('ScopeCWTE',    ARRAY['CW', 'TE', 'Both']),
  ('RiskResponse', ARRAY['Avoid', 'Mitigate', 'Transfer', 'Accept']),
  ('RiskStatus',   ARRAY['Open', 'Monitoring', 'Closed', 'Materialized']),
  ('Trend',        ARRAY['Increasing', 'Stable', 'Decreasing']),
  ('SiteType',     ARRAY['Core', 'MFN', 'FN', 'HUB', 'Terminal']),
  ('TowerOwner',   ARRAY['Almadar', 'LTT', 'AAT', 'Albounya', 'HLC', 'Brega', 'LNET', 'Libyana', 'GECOL', 'N/A']),
  ('TowerType',    ARRAY['SST', 'GMT', 'Monopole', 'N/A']),
  ('ReviewStatus', ARRAY['Pending', 'Submitted', 'Approved', 'Rejected']),
  ('TestPit',      ARRAY['Normal', 'Rock', 'Water', 'Filled Soil', 'N/A']),
  ('Ownership',    ARRAY['Individual', 'Public Entity', 'Private Entity', 'Tower Owner (Colocation)']),
  ('WLVendor',     ARRAY['Cambium', 'Intracom'])
) AS v(catalogue, vals)
CROSS JOIN LATERAL unnest(v.vals) WITH ORDINALITY AS t(code, ord);

-- (a) the agreed TeamSpecialization values (Q104, Q143): groups are placeholders for P4b (team_scope_match); the old text CW stays as an inactive value
INSERT INTO list_values (catalogue_code, code, label_en, groups, sort_order, is_active)
SELECT 'TeamSpecialization', v.code, v.code, v.g, v.ord * 10, v.active
FROM (VALUES ('Tower RT', ARRAY['CW'], 1, true), ('Tower GF', ARRAY['CW'], 2, true), ('Adaption', ARRAY['CW'], 3, true), ('TE', ARRAY['TE'], 4, true),
             ('Dismantle', ARRAY[]::text[], 5, true), ('GECOL', ARRAY[]::text[], 6, true), ('Fiber', ARRAY[]::text[], 7, true), ('Survey', ARRAY[]::text[], 8, true),
             ('CW', ARRAY['CW'], 9, false)) AS v(code, g, ord, active)
ON CONFLICT (catalogue_code, code) DO NOTHING;

-- (b) ActionStatus of the meeting action items (draft for the owner)
INSERT INTO list_values (catalogue_code, code, label_en, label_ar, groups, sort_order)
VALUES ('ActionStatus', 'Open', 'Open', 'مفتوح', ARRAY['open'], 10), ('ActionStatus', 'In Progress', 'In Progress', 'قيد التنفيذ', ARRAY['open'], 20),
       ('ActionStatus', 'Done', 'Done', 'منجز', ARRAY['closed'], 30), ('ActionStatus', 'Cancelled', 'Cancelled', 'ملغى', ARRAY['closed'], 40)
ON CONFLICT (catalogue_code, code) DO NOTHING;

-- (c) the closed list of each linked field, in its order (the first field of a list wins)
INSERT INTO list_values (catalogue_code, code, label_en, sort_order)
SELECT DISTINCT ON (l.catalogue, t.code) l.catalogue, t.code, t.code, t.ord::int * 10
FROM p5_links l JOIN register_fields f ON f.register_key = l.register_key AND f.code = l.field_code
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.options) = 'array' THEN f.options ELSE '[]'::jsonb END) WITH ORDINALITY AS t(code, ord)
WHERE btrim(t.code) <> ''
ORDER BY l.catalogue, t.code, l.register_key, l.field_code
ON CONFLICT (catalogue_code, code) DO NOTHING;

-- (d) the Master Setting values of the lists that were free text
INSERT INTO list_values (catalogue_code, code, label_en, sort_order)
SELECT m.catalogue, m.code, m.code, m.ord * 10 FROM p5_master m
WHERE NOT EXISTS (SELECT 1 FROM list_values x WHERE x.catalogue_code = m.catalogue)
   OR m.catalogue IN ('StaffStatus', 'CompletionStatus')
ON CONFLICT (catalogue_code, code) DO NOTHING;

-- (e) every value already saved in a record (nothing is lost, Q104), after the others
INSERT INTO list_values (catalogue_code, code, label_en, sort_order)
SELECT x.catalogue, x.v, x.v, 10000 + (row_number() OVER (PARTITION BY x.catalogue ORDER BY x.v COLLATE "C"))::int
FROM (
  SELECT DISTINCT l.catalogue, btrim(r.data ->> l.field_code) AS v
  FROM p5_links l JOIN register_records r ON r.register_key = l.register_key
  WHERE jsonb_typeof(r.data -> l.field_code) = 'string' AND btrim(r.data ->> l.field_code) <> ''
) x
WHERE char_length(x.v) <= 80 AND x.v !~ '[[:cntrl:];]'
  AND NOT EXISTS (SELECT 1 FROM list_values y WHERE y.catalogue_code = x.catalogue AND lower(y.code) = lower(x.v))
ON CONFLICT (catalogue_code, code) DO NOTHING;

-- (f) link the fields; any other list field of a register (added by an earlier migration) gets a list of its own with its current values
UPDATE register_fields f SET list_catalogue = l.catalogue
FROM p5_links l WHERE f.register_key = l.register_key AND f.code = l.field_code AND f.field_type = 'list';

DO $$
DECLARE f record; c text;
BEGIN
  FOR f IN SELECT x.register_key, x.code, x.label_en, x.options FROM register_fields x
           WHERE x.field_type = 'list' AND x.list_catalogue IS NULL AND NOT x.derived AND (x.options IS NULL OR jsonb_typeof(x.options) = 'array')
           ORDER BY x.register_key, x.code LOOP
    c := left(replace(initcap(replace(f.register_key || '_' || f.code, '_', ' ')), ' ', ''), 41);
    INSERT INTO list_catalogues (code, name_en, critical, status, allow_other)
    VALUES (c, left(f.label_en, 200), false, 'pending', f.options IS NULL) ON CONFLICT (code) DO NOTHING;
    INSERT INTO list_values (catalogue_code, code, label_en, sort_order)
    SELECT c, t.code, t.code, t.ord::int * 10 FROM jsonb_array_elements_text(coalesce(f.options, '[]'::jsonb)) WITH ORDINALITY AS t(code, ord)
    WHERE btrim(t.code) <> '' AND char_length(t.code) <= 80 ON CONFLICT (catalogue_code, code) DO NOTHING;
    UPDATE register_fields SET list_catalogue = c WHERE register_key = f.register_key AND code = f.code;
  END LOOP;
END $$;

DROP TABLE p5_links;
DROP TABLE p5_master;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Helpers: resolve a typed value to its code, the active codes, the materialised options of the linked fields
-- ---------------------------------------------------------------------------------------------------------------------
-- The code a typed text stands for: the code itself, else (ignoring case and outer spaces) a code, a label or an alias; an active value wins. NULL = none.
CREATE OR REPLACE FUNCTION list_pick(p_catalogue text, p_text text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    (SELECT v.code FROM public.list_values v WHERE v.catalogue_code = p_catalogue AND v.code = p_text),
    (SELECT v.code FROM public.list_values v
     WHERE v.catalogue_code = p_catalogue
       AND (lower(v.code) = lower(btrim(p_text)) OR lower(v.label_en) = lower(btrim(p_text)) OR lower(coalesce(v.label_ar, '')) = lower(btrim(p_text))
            OR EXISTS (SELECT 1 FROM unnest(v.aliases) a WHERE lower(a) = lower(btrim(p_text))))
     ORDER BY v.is_active DESC, v.sort_order, v.code COLLATE "C" LIMIT 1))
$$;

CREATE OR REPLACE FUNCTION list_active_codes(p_catalogue text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(v.code ORDER BY v.sort_order, v.code COLLATE "C"), '[]'::jsonb) FROM public.list_values v WHERE v.catalogue_code = p_catalogue AND v.is_active
$$;

-- The catalogues a register uses: its list fields and the list columns of its child lists.
CREATE OR REPLACE FUNCTION list_catalogues_of(p_register text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT c ORDER BY c), ARRAY[]::text[]) FROM (
    SELECT f.list_catalogue AS c FROM public.register_fields f WHERE f.register_key = p_register AND f.is_active AND f.list_catalogue IS NOT NULL
    UNION
    SELECT col ->> 'list_catalogue' FROM public.register_fields f, jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) col
    WHERE f.register_key = p_register AND f.is_active AND f.field_type = 'child_list' AND col ->> 'list_catalogue' IS NOT NULL
  ) x
$$;

-- options of a linked `list` field = the active codes of its catalogue (existing readers of register_fields.options keep working).
CREATE OR REPLACE FUNCTION list_refresh_fields(p_catalogue text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE codes jsonb := public.list_active_codes(p_catalogue);
BEGIN
  UPDATE public.register_fields SET options = codes
  WHERE list_catalogue = p_catalogue AND field_type = 'list' AND options IS DISTINCT FROM codes;
END $$;

CREATE OR REPLACE FUNCTION list_catalogue_json(c public.list_catalogues) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', c.code, 'name_en', c.name_en, 'name_ar', c.name_ar, 'description', c.description, 'critical', c.critical, 'status', c.status,
    'allow_other', c.allow_other, 'is_active', c.is_active, 'version', c.version)
$$;

CREATE OR REPLACE FUNCTION list_value_json(v public.list_values) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', v.id, 'code', v.code, 'label_en', v.label_en, 'label_ar', v.label_ar, 'aliases', to_jsonb(v.aliases), 'groups', to_jsonb(v.groups),
    'sort_order', v.sort_order, 'is_active', v.is_active, 'version', v.version)
$$;

SELECT list_refresh_fields(c.code) FROM list_catalogues c;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The writers (System Admin or a delegate of fields.edit for all regions; a reason; If-Match; audited)
-- ---------------------------------------------------------------------------------------------------------------------
-- p_patch keys: name_en, name_ar, description, critical, status (pending / confirmed), allow_other, is_active. p_create: a new list with code p_code.
CREATE OR REPLACE FUNCTION admin_save_list_catalogue(p_code text, p_create boolean, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.list_catalogues%ROWTYPE; old_c public.list_catalogues%ROWTYPE; k text; errs jsonb := '[]'::jsonb; actor uuid := public.app_actor();
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('name_en', 'name_ar', 'description', 'critical', 'status', 'allow_other', 'is_active') THEN
      errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.');
    END IF;
  END LOOP;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) NOT BETWEEN 2 AND 200 THEN
    errs := errs || public.reg_err_item('/name_en', 'invalid', 'A name of 2 to 200 characters.');
  END IF;
  IF p_patch ? 'status' AND coalesce(p_patch ->> 'status', '') NOT IN ('pending', 'confirmed') THEN
    errs := errs || public.reg_err_item('/status', 'invalid', 'pending or confirmed.');
  END IF;
  FOREACH k IN ARRAY ARRAY['critical', 'allow_other', 'is_active'] LOOP
    IF p_patch ? k AND jsonb_typeof(p_patch -> k) <> 'boolean' THEN errs := errs || public.reg_err_item('/' || k, 'invalid', 'true or false.'); END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_create THEN
    IF p_code IS NULL OR p_code !~ '^[A-Z][A-Za-z0-9]{1,40}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/code', 'invalid', 'A code like TeamType: a capital letter, then letters and digits.')));
    END IF;
    IF NOT (p_patch ? 'name_en') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/name_en', 'required', 'The name is required.'))); END IF;
    IF EXISTS (SELECT 1 FROM public.list_catalogues x WHERE lower(x.code) = lower(p_code)) THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A list with this code exists already.'));
    END IF;
    IF coalesce((p_patch ->> 'critical')::boolean, false) AND coalesce((p_patch ->> 'allow_other')::boolean, false) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/allow_other', 'critical_closed', 'A critical list accepts only its own values.')));
    END IF;
    IF coalesce(p_patch ->> 'status', 'pending') = 'confirmed' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'no_values', 'Add the values before confirming the list.')));
    END IF;
    INSERT INTO public.list_catalogues (code, name_en, name_ar, description, critical, status, allow_other, is_active, updated_by)
    VALUES (p_code, btrim(p_patch ->> 'name_en'), nullif(btrim(p_patch ->> 'name_ar'), ''), nullif(btrim(p_patch ->> 'description'), ''),
            coalesce((p_patch ->> 'critical')::boolean, false), 'pending', coalesce((p_patch ->> 'allow_other')::boolean, false), coalesce((p_patch ->> 'is_active')::boolean, true), actor)
    RETURNING * INTO c;
    PERFORM public.log_audit_write('list_catalogue_create', 'list_catalogue', c.code, NULL, public.list_catalogue_json(c), p_reason);
    RETURN jsonb_build_object('code', c.code, 'version', c.version);
  END IF;

  SELECT * INTO old_c FROM public.list_catalogues WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The list does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> old_c.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The list changed since you read it. Reload and try again.')); END IF;
  IF p_patch = '{}'::jsonb THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'required', 'Change at least one field.'))); END IF;
  c := old_c;
  c.name_en := coalesce(btrim(p_patch ->> 'name_en'), c.name_en);
  IF p_patch ? 'name_ar' THEN c.name_ar := nullif(btrim(p_patch ->> 'name_ar'), ''); END IF;
  IF p_patch ? 'description' THEN c.description := nullif(btrim(p_patch ->> 'description'), ''); END IF;
  c.critical := coalesce((p_patch ->> 'critical')::boolean, c.critical);
  c.status := coalesce(p_patch ->> 'status', c.status);
  c.allow_other := coalesce((p_patch ->> 'allow_other')::boolean, c.allow_other);
  c.is_active := coalesce((p_patch ->> 'is_active')::boolean, c.is_active);
  IF c.critical AND c.allow_other THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(CASE WHEN p_patch ? 'allow_other' THEN '/allow_other' ELSE '/critical' END,
      'critical_closed', 'A critical list accepts only its own values: switch "accept another value" off first.')));
  END IF;
  IF c.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM public.list_values v WHERE v.catalogue_code = c.code AND v.is_active) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'no_values', 'A list without an active value cannot be confirmed.')));
  END IF;
  IF NOT c.is_active AND old_c.is_active AND (EXISTS (SELECT 1 FROM public.register_fields f WHERE f.list_catalogue = c.code AND f.is_active)
      OR EXISTS (SELECT 1 FROM public.register_fields f, jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) col
                 WHERE f.is_active AND f.field_type = 'child_list' AND col ->> 'list_catalogue' = c.code)) THEN
    PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'An active field uses this list.', 'errors', public.reg_err_item('/is_active', 'item_in_use', 'An active field uses this list.')));
  END IF;
  UPDATE public.list_catalogues SET name_en = c.name_en, name_ar = c.name_ar, description = c.description, critical = c.critical, status = c.status,
    allow_other = c.allow_other, is_active = c.is_active, version = version + 1, updated_at = now(), updated_by = actor
  WHERE code = p_code RETURNING * INTO c;
  PERFORM public.log_audit_write(CASE WHEN old_c.is_active AND NOT c.is_active THEN 'list_catalogue_deactivate' ELSE 'list_catalogue_update' END,
    'list_catalogue', c.code, public.list_catalogue_json(old_c), public.list_catalogue_json(c), p_reason);
  RETURN jsonb_build_object('code', c.code, 'version', c.version);
END $$;

-- p_id NULL = a new value (p_patch.code required). Keys: code (new only), label_en, label_ar, aliases, groups, sort_order, is_active.
CREATE OR REPLACE FUNCTION admin_save_list_value(p_catalogue text, p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cat public.list_catalogues%ROWTYPE; v public.list_values%ROWTYPE; old_v public.list_values%ROWTYPE; k text; t text; errs jsonb := '[]'::jsonb; actor uuid := public.app_actor();
  tokens text[]; v_aliases text[]; v_groups text[];
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO cat FROM public.list_catalogues WHERE code = p_catalogue FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The list does not exist.')); END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('code', 'label_en', 'label_ar', 'aliases', 'groups', 'sort_order', 'is_active') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.'); END IF;
  END LOOP;
  IF p_id IS NOT NULL AND p_patch ? 'code' THEN errs := errs || public.reg_err_item('/code', 'field_read_only', 'The code of a value never changes: deactivate it and add a new value.'); END IF;
  IF p_id IS NULL AND (p_patch ->> 'code' IS NULL OR char_length(p_patch ->> 'code') NOT BETWEEN 1 AND 80 OR p_patch ->> 'code' <> btrim(p_patch ->> 'code') OR p_patch ->> 'code' ~ '[[:cntrl:];]') THEN
    errs := errs || public.reg_err_item('/code', 'invalid', 'A code of 1 to 80 characters, without outer spaces or ";".');
  END IF;
  IF p_patch ? 'label_en' AND char_length(btrim(coalesce(p_patch ->> 'label_en', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || public.reg_err_item('/label_en', 'invalid', 'A label of 1 to 200 characters.'); END IF;
  IF p_patch ? 'aliases' AND (jsonb_typeof(p_patch -> 'aliases') <> 'array' OR jsonb_array_length(p_patch -> 'aliases') > 20
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'aliases') a WHERE jsonb_typeof(a) <> 'string' OR char_length(btrim(a #>> '{}')) NOT BETWEEN 1 AND 80)) THEN
    errs := errs || public.reg_err_item('/aliases', 'invalid', 'Up to 20 texts of 1 to 80 characters.');
  END IF;
  IF p_patch ? 'groups' AND (jsonb_typeof(p_patch -> 'groups') <> 'array' OR jsonb_array_length(p_patch -> 'groups') > 10
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'groups') a WHERE jsonb_typeof(a) <> 'string' OR (a #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_ -]{0,30}$')) THEN
    errs := errs || public.reg_err_item('/groups', 'invalid', 'Up to 10 group codes (letters, digits, space, - and _).');
  END IF;
  IF p_patch ? 'sort_order' AND (jsonb_typeof(p_patch -> 'sort_order') <> 'number' OR (p_patch ->> 'sort_order')::numeric NOT BETWEEN 0 AND 100000) THEN errs := errs || public.reg_err_item('/sort_order', 'invalid', 'A whole number from 0 to 100000.'); END IF;
  IF p_patch ? 'is_active' AND jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN errs := errs || public.reg_err_item('/is_active', 'invalid', 'true or false.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_patch ? 'aliases' THEN SELECT coalesce(array_agg(DISTINCT btrim(a)), ARRAY[]::text[]) INTO v_aliases FROM jsonb_array_elements_text(p_patch -> 'aliases') a; END IF;
  IF p_patch ? 'groups' THEN SELECT coalesce(array_agg(DISTINCT a ORDER BY a), ARRAY[]::text[]) INTO v_groups FROM jsonb_array_elements_text(p_patch -> 'groups') a; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.list_values (catalogue_code, code, label_en, label_ar, aliases, groups, sort_order, is_active, updated_by)
    VALUES (cat.code, p_patch ->> 'code', coalesce(btrim(p_patch ->> 'label_en'), p_patch ->> 'code'), nullif(btrim(p_patch ->> 'label_ar'), ''), coalesce(v_aliases, ARRAY[]::text[]),
            coalesce(v_groups, ARRAY[]::text[]), coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(x.sort_order), 0) + 10 FROM public.list_values x WHERE x.catalogue_code = cat.code)),
            coalesce((p_patch ->> 'is_active')::boolean, true), actor)
    ON CONFLICT (catalogue_code, code) DO NOTHING
    RETURNING * INTO v;
    IF v.id IS NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This list has a value with this code already.')); END IF;
  ELSE
    SELECT * INTO old_v FROM public.list_values WHERE id = p_id AND catalogue_code = cat.code FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The value does not exist in this list.')); END IF;
    IF p_version IS NOT NULL AND p_version <> old_v.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The value changed since you read it. Reload and try again.')); END IF;
    IF p_patch = '{}'::jsonb THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'required', 'Change at least one field.'))); END IF;
    -- a critical list never loses its last active value (that would block every approval of the registers that use it)
    IF cat.critical AND old_v.is_active AND (p_patch ->> 'is_active') = 'false'
       AND NOT EXISTS (SELECT 1 FROM public.list_values x WHERE x.catalogue_code = cat.code AND x.is_active AND x.id <> old_v.id) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'last_active_value', 'A critical list keeps at least one active value.')));
    END IF;
    UPDATE public.list_values SET
      label_en = coalesce(btrim(p_patch ->> 'label_en'), label_en),
      label_ar = CASE WHEN p_patch ? 'label_ar' THEN nullif(btrim(p_patch ->> 'label_ar'), '') ELSE label_ar END,
      aliases = coalesce(v_aliases, list_values.aliases),
      groups = coalesce(v_groups, list_values.groups),
      sort_order = coalesce((p_patch ->> 'sort_order')::int, sort_order),
      is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
      version = version + 1, updated_at = now(), updated_by = actor
    WHERE id = p_id RETURNING * INTO v;
  END IF;

  -- a code, a label or an alias names one value only (ignoring case), so a typed text never means two values
  tokens := ARRAY[lower(v.code), lower(v.label_en)] || CASE WHEN v.label_ar IS NOT NULL THEN ARRAY[lower(v.label_ar)] ELSE ARRAY[]::text[] END
            || (SELECT coalesce(array_agg(lower(a)), ARRAY[]::text[]) FROM unnest(v.aliases) a);
  FOREACH t IN ARRAY tokens LOOP
    IF EXISTS (SELECT 1 FROM public.list_values x WHERE x.catalogue_code = cat.code AND x.id <> v.id
               AND (lower(x.code) = t OR lower(x.label_en) = t OR lower(coalesce(x.label_ar, '')) = t OR EXISTS (SELECT 1 FROM unnest(x.aliases) a WHERE lower(a) = t))) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(CASE WHEN p_patch ? 'aliases' THEN '/aliases' ELSE '/label_en' END, 'duplicate',
        'Another value of this list already uses "' || t || '" as its code, label or alias.')));
    END IF;
  END LOOP;

  PERFORM public.list_refresh_fields(cat.code);
  UPDATE public.list_catalogues SET version = version + 1, updated_at = now(), updated_by = actor WHERE code = cat.code;
  PERFORM public.log_audit_write(CASE WHEN p_id IS NULL THEN 'list_value_create' WHEN old_v.is_active AND NOT v.is_active THEN 'list_value_deactivate' ELSE 'list_value_update' END,
    'list_catalogue', cat.code || ':' || v.code, CASE WHEN p_id IS NULL THEN NULL ELSE public.list_value_json(old_v) END, public.list_value_json(v), p_reason);
  RETURN jsonb_build_object('id', v.id, 'version', v.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Field types: the cleaning of every save (manual entry and templates)
-- ---------------------------------------------------------------------------------------------------------------------
-- One user from an id, an employee ID or an e-mail; NULL when none or several.
CREATE OR REPLACE FUNCTION reg_pick_user(p_text text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int; u uuid;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN RETURN NULL; END IF;
  IF btrim(p_text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT x.id INTO u FROM public.users x WHERE x.id = btrim(p_text)::uuid;
    RETURN u;
  END IF;
  SELECT count(*), min(x.id::text)::uuid INTO n, u FROM public.users x
  WHERE x.deleted_at IS NULL AND (btrim(x.employee_id) = btrim(p_text) OR lower(x.email) = lower(btrim(p_text)));
  RETURN CASE WHEN n = 1 THEN u END;
END $$;

-- One site from an id or a site code, inside the caller's regions (an unknown site and a site of another region answer the same).
CREATE OR REPLACE FUNCTION reg_pick_site(p_text text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id FROM public.sites s
  WHERE public.app_region_check(s.region_id)
    AND CASE WHEN btrim(p_text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN s.id = btrim(p_text)::uuid ELSE upper(s.site_code) = upper(btrim(p_text)) END
  LIMIT 1
$$;

-- A list of texts from a JSON array or a text separated by ";" (templates), trimmed, without blanks.
CREATE OR REPLACE FUNCTION reg_split_values(v jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) = 'array' THEN (SELECT coalesce(array_agg(btrim(e #>> '{}') ORDER BY o), ARRAY[]::text[]) FROM jsonb_array_elements(v) WITH ORDINALITY AS t(e, o)
                                         WHERE jsonb_typeof(e) IN ('string', 'number') AND btrim(e #>> '{}') <> '')
    WHEN jsonb_typeof(v) = 'string' THEN (SELECT coalesce(array_agg(btrim(x) ORDER BY o), ARRAY[]::text[]) FROM unnest(regexp_split_to_array(v #>> '{}', '[;\n]')) WITH ORDINALITY AS t(x, o) WHERE btrim(x) <> '')
  END
$$;

-- One value of a list field or column: the code, or the text as typed in a list that accepts another value; NULL = refused.
CREATE OR REPLACE FUNCTION reg_list_value(p_catalogue text, p_text text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(public.list_pick(p_catalogue, p_text),
                  CASE WHEN (SELECT c.allow_other FROM public.list_catalogues c WHERE c.code = p_catalogue) AND char_length(btrim(p_text)) <= 200 THEN btrim(p_text) END)
$$;

-- One cell of a child list row (the column spec of options.columns). Returns {"v": value} or {"e": [code, message]}.
CREATE OR REPLACE FUNCTION reg_clean_cell(p_col jsonb, v jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t text := v #>> '{}'; d date; u uuid; c text;
BEGIN
  CASE p_col ->> 'type'
    WHEN 'text' THEN
      IF jsonb_typeof(v) <> 'string' OR length(t) > 2000 THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'Text up to 2000 characters.')); END IF;
      RETURN jsonb_build_object('v', btrim(t));
    WHEN 'number' THEN
      IF jsonb_typeof(v) NOT IN ('number', 'string') OR t !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'A number.')); END IF;
      RETURN jsonb_build_object('v', t::numeric);
    WHEN 'yes_no' THEN
      IF jsonb_typeof(v) <> 'boolean' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'true or false.')); END IF;
      RETURN jsonb_build_object('v', v);
    WHEN 'date' THEN
      IF jsonb_typeof(v) <> 'string' OR t !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid_date', 'A date as YYYY-MM-DD.')); END IF;
      BEGIN d := t::date; EXCEPTION WHEN others THEN d := NULL; END;
      IF d IS NULL OR d::text <> t THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid_date', 'Not a calendar date.')); END IF;
      IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid_date', 'The date must be between 2020-01-01 and 2035-12-31.')); END IF;
      IF coalesce((p_col ->> 'is_actual')::boolean, false) AND d > current_date THEN RETURN jsonb_build_object('e', jsonb_build_array('future_date', 'An actual date cannot be in the future.')); END IF;
      RETURN jsonb_build_object('v', t);
    WHEN 'user' THEN
      u := CASE WHEN jsonb_typeof(v) = 'string' THEN public.reg_pick_user(t) END;
      IF u IS NULL THEN RETURN jsonb_build_object('e', jsonb_build_array('unknown_user', 'Unknown user: give the 4-digit employee ID or the e-mail of one user.')); END IF;
      RETURN jsonb_build_object('v', u::text);
    WHEN 'list_code' THEN
      c := CASE WHEN jsonb_typeof(v) = 'string' THEN public.reg_list_value(p_col ->> 'list_catalogue', t) END;
      IF c IS NULL THEN RETURN jsonb_build_object('e', jsonb_build_array('not_in_list', 'Not a value of the list.')); END IF;
      RETURN jsonb_build_object('v', c);
    WHEN 'task' THEN
      IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR NOT EXISTS (SELECT 1 FROM public.task_instances ti WHERE ti.id = t::uuid AND public.app_region_check(ti.region_id)) THEN
        RETURN jsonb_build_object('e', jsonb_build_array('unknown_task', 'Unknown task, or a task outside your regions.'));
      END IF;
      RETURN jsonb_build_object('v', lower(t));
    ELSE
      RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'Unknown column type.'));
  END CASE;
END $$;

-- Checks a patch of `data` against register_fields and returns it cleaned (text trimmed, numbers and dates normalised, an explicit null or empty text kept as
-- null = clear). Raises validation_failed with one error per problem. 0057: the list catalogue (codes, labels, aliases, another value) and the types
-- multi_user, multi_site, file, child_list, warehouse_item and list_code.
CREATE OR REPLACE FUNCTION reg_clean_data(p_key text, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  k text; v jsonb; f public.register_fields%ROWTYPE; out jsonb := '{}'::jsonb; errs jsonb := '[]'::jsonb; t text; d date; refused jsonb;
  opts jsonb; items text[]; x text; arr jsonb; u uuid; i int; row_ jsonb; rk text; rv jsonb; col jsonb; cell jsonb; clean_row jsonb; ids text[]; rid text;
  closing jsonb; st text; maxn int; c text;
BEGIN
  IF p_patch IS NULL THEN RETURN out; END IF;
  SELECT dd.rules -> 'refused_scopes' INTO refused FROM public.register_definitions dd WHERE dd.register_key = p_key;
  IF jsonb_typeof(p_patch) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/data', 'code', 'invalid', 'message', 'data must be an object.'))));
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_patch) LOOP
    SELECT * INTO f FROM public.register_fields x WHERE x.register_key = p_key AND x.code = k AND x.is_active;
    IF NOT FOUND THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_field', 'message', 'This field does not exist in the register.'));
      CONTINUE;
    END IF;
    IF f.derived THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'field_read_only', 'message', 'This value comes from the approval and cannot be typed (Q45).'));
      CONTINUE;
    END IF;
    IF jsonb_typeof(v) = 'null' OR (jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = '') OR (jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 0) THEN
      out := out || jsonb_build_object(k, NULL); CONTINUE;
    END IF;
    t := v #>> '{}';
    CASE f.field_type
      WHEN 'text' THEN
        IF jsonb_typeof(v) <> 'string' OR length(t) > 2000 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'Text up to 2000 characters.'));
        ELSE out := out || jsonb_build_object(k, btrim(t)); END IF;
      WHEN 'number' THEN
        IF jsonb_typeof(v) NOT IN ('number', 'string') OR t !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A number.'));
        ELSE out := out || jsonb_build_object(k, t::numeric); END IF;
      WHEN 'yes_no' THEN
        IF jsonb_typeof(v) <> 'boolean' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'true or false.'));
        ELSE out := out || jsonb_build_object(k, v); END IF;
      WHEN 'date' THEN
        IF jsonb_typeof(v) <> 'string' OR t !~ '^\d{4}-\d{2}-\d{2}$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid_date', 'message', 'A date as YYYY-MM-DD.'));
        ELSE
          BEGIN
            d := t::date;
          EXCEPTION WHEN others THEN d := NULL;
          END;
          IF d IS NULL OR d::text <> t THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid_date', 'message', 'Not a calendar date.'));
          ELSIF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'));
          ELSIF f.is_actual AND d > current_date THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'future_date', 'message', 'An actual date cannot be in the future.'));
          ELSE out := out || jsonb_build_object(k, t); END IF;
        END IF;
      WHEN 'list', 'list_code' THEN
        IF f.field_type = 'list_code' AND coalesce((f.options ->> 'multiple')::boolean, false) THEN
          -- several codes: a JSON array, or a text separated by ";" (templates)
          items := public.reg_split_values(v);
          IF items IS NULL THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of values.'));
          ELSE
            arr := '[]'::jsonb;
            FOREACH x IN ARRAY items LOOP
              c := public.reg_list_value(f.list_catalogue, x);
              IF c IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', '"' || left(x, 80) || '" is not a value of the list.'));
              ELSIF NOT arr ? c THEN arr := arr || to_jsonb(c); END IF;
            END LOOP;
            out := out || jsonb_build_object(k, arr);
          END IF;
        ELSIF jsonb_typeof(v) <> 'string' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A text from the list.'));
        ELSIF k = 'scope' AND refused IS NOT NULL AND jsonb_typeof(refused) = 'object' AND refused ? t THEN
          -- Q56 ownership: a purchase request of another team's register is refused with a pointer to its register (rule parameters are data)
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/scope', 'code', 'wrong_register',
            'message', 'Enter this request in the ' || (refused ->> t) || ' register (each team enters its own purchase requests, Q56).'));
        ELSIF f.list_catalogue IS NOT NULL THEN
          c := public.reg_list_value(f.list_catalogue, t);
          IF c IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', 'Not a value of the list.'));
          ELSE out := out || jsonb_build_object(k, c); END IF;
        ELSE
          opts := f.options;
          IF opts IS NULL THEN out := out || jsonb_build_object(k, btrim(t));
          ELSIF jsonb_typeof(opts) = 'object' AND opts ->> 'source' = 'permit_types' THEN
            IF EXISTS (SELECT 1 FROM public.permit_types pt WHERE pt.code = t AND pt.is_active) THEN out := out || jsonb_build_object(k, t);
            ELSE errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', 'Not a permit type of the list.')); END IF;
          ELSIF jsonb_typeof(opts) = 'array' AND opts ? t THEN out := out || jsonb_build_object(k, t);
          ELSE errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', 'Not a value of the list.')); END IF;
        END IF;
      WHEN 'external_team' THEN
        IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM public.external_teams x WHERE x.id = t::uuid AND x.is_active) THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_team', 'message', 'Unknown or inactive team.'));
        ELSE out := out || jsonb_build_object(k, lower(t)); END IF;
      WHEN 'user' THEN
        IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM public.users x WHERE x.id = t::uuid) THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_user', 'message', 'Unknown user.'));
        ELSE out := out || jsonb_build_object(k, lower(t)); END IF;
      WHEN 'multi_user' THEN
        items := public.reg_split_values(v);
        IF items IS NULL OR cardinality(items) > 200 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of up to 200 people.'));
        ELSE
          arr := '[]'::jsonb; i := 0;
          FOREACH x IN ARRAY items LOOP
            u := public.reg_pick_user(x);
            IF u IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i, 'code', 'unknown_user', 'message', 'Unknown user: "' || left(x, 80) || '".'));
            ELSIF NOT arr ? u::text THEN arr := arr || to_jsonb(u::text); END IF;
            i := i + 1;
          END LOOP;
          out := out || jsonb_build_object(k, arr);
        END IF;
      WHEN 'multi_site' THEN
        items := public.reg_split_values(v);
        IF items IS NULL OR cardinality(items) > 500 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of up to 500 sites.'));
        ELSE
          arr := '[]'::jsonb; i := 0;
          FOREACH x IN ARRAY items LOOP
            u := public.reg_pick_site(x);
            IF u IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i, 'code', 'unknown_site', 'message', 'Unknown site, or a site outside your regions: "' || left(x, 80) || '".'));
            ELSIF NOT arr ? u::text THEN arr := arr || to_jsonb(u::text); END IF;
            i := i + 1;
          END LOOP;
          out := out || jsonb_build_object(k, arr);
        END IF;
      WHEN 'warehouse_item' THEN
        SELECT w.id INTO u FROM public.warehouse_items w
        WHERE jsonb_typeof(v) = 'string' AND (CASE WHEN btrim(t) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN w.id = btrim(t)::uuid ELSE upper(w.item_code) = upper(btrim(t)) END)
        LIMIT 1;
        IF NOT FOUND THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_warehouse_item', 'message', 'No Warehouse item has this id or code.'));
        ELSE out := out || jsonb_build_object(k, u::text); END IF;
      WHEN 'file' THEN
        -- the id of a file uploaded into a document slot of the record; that it belongs to the record is checked at submit (Q111: a typed reference is not an upload)
        IF jsonb_typeof(v) <> 'string' OR btrim(t) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'The id of a file uploaded to the record.'));
        ELSE out := out || jsonb_build_object(k, lower(btrim(t))); END IF;
      WHEN 'child_list' THEN
        maxn := coalesce((f.options ->> 'max_rows')::int, 200);
        closing := f.options -> 'closing';
        IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > maxn THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of up to ' || maxn || ' rows.'));
        ELSE
          arr := '[]'::jsonb; ids := ARRAY[]::text[]; i := 0;
          FOR row_ IN SELECT * FROM jsonb_array_elements(v) LOOP
            IF jsonb_typeof(row_) <> 'object' THEN
              errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i, 'code', 'invalid', 'message', 'A row is an object.'));
              i := i + 1; CONTINUE;
            END IF;
            clean_row := '{}'::jsonb;
            -- every row keeps a stable id (given back by the server on the first save), so a row is never entered twice
            rid := row_ ->> 'id';
            IF rid IS NULL THEN rid := gen_random_uuid()::text;
            ELSIF rid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR lower(rid) = ANY (ids) THEN
              errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/id', 'code', 'invalid', 'message', 'Each row has its own id.'));
            END IF;
            rid := lower(rid); ids := ids || rid;
            clean_row := jsonb_build_object('id', rid);
            FOR rk, rv IN SELECT * FROM jsonb_each(row_) LOOP
              CONTINUE WHEN rk = 'id';
              IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) cc WHERE cc ->> 'code' = rk) THEN
                errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || rk, 'code', 'unknown_field', 'message', 'This column does not exist.'));
              END IF;
            END LOOP;
            FOR col IN SELECT * FROM jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) LOOP
              rv := row_ -> (col ->> 'code');
              IF rv IS NULL OR jsonb_typeof(rv) = 'null' OR (jsonb_typeof(rv) = 'string' AND btrim(rv #>> '{}') = '') THEN
                IF coalesce((col ->> 'required')::boolean, false) THEN
                  errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (col ->> 'code'), 'code', 'required', 'message', coalesce(col ->> 'label_en', col ->> 'code') || ' is required.'));
                END IF;
                CONTINUE;
              END IF;
              cell := public.reg_clean_cell(col, rv);
              IF cell ? 'e' THEN
                errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (col ->> 'code'), 'code', cell -> 'e' ->> 0, 'message', cell -> 'e' ->> 1));
              ELSE clean_row := clean_row || jsonb_build_object(col ->> 'code', cell -> 'v'); END IF;
            END LOOP;
            -- a status of the group "closed" needs the closed date; any other status has none (Q12)
            IF closing IS NOT NULL AND clean_row ? (closing ->> 'status') THEN
              st := clean_row ->> (closing ->> 'status');
              IF EXISTS (SELECT 1 FROM public.list_values lv, jsonb_array_elements(f.options -> 'columns') cc
                         WHERE cc ->> 'code' = closing ->> 'status' AND lv.catalogue_code = cc ->> 'list_catalogue' AND lv.code = st AND (closing ->> 'group') = ANY (lv.groups)) THEN
                IF NOT clean_row ? (closing ->> 'date') THEN
                  errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (closing ->> 'date'), 'code', 'required', 'message', 'A closed action needs its closed date.'));
                END IF;
              ELSIF clean_row ? (closing ->> 'date') THEN
                errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (closing ->> 'date'), 'code', 'not_closed', 'message', 'Only a closed action has a closed date.'));
              END IF;
            END IF;
            arr := arr || jsonb_build_array(clean_row);
            i := i + 1;
          END LOOP;
          out := out || jsonb_build_object(k, arr);
        END IF;
    END CASE;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. At submit and at the final approval (a trigger, so every path is covered: the screen, templates, batches)
-- ---------------------------------------------------------------------------------------------------------------------
-- Is p_file a current file of a document slot of the logical record p_entity? Q228 hook: the documents package builds the slots of the records without a
-- site (Contractors, Risks, Meetings); this check needs nothing more than document_slots.register_entity_id.
CREATE OR REPLACE FUNCTION reg_record_file_ok(p_entity uuid, p_file uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.document_files df JOIN public.document_slots ds ON ds.id = df.slot_id
                 WHERE df.id = p_file AND ds.register_entity_id = p_entity AND df.is_current AND df.withdrawn_at IS NULL AND df.superseded_by IS NULL)
$$;

CREATE OR REPLACE FUNCTION p5_record_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f record; v jsonb; prev jsonb; errs jsonb := '[]'::jsonb; c text; lv public.list_values%ROWTYPE; cat public.list_catalogues%ROWTYPE; missing text[];
BEGIN
  IF OLD.state = 'entry' THEN
    SELECT p.data INTO prev FROM public.register_records p WHERE p.id = NEW.supersedes_id;
    FOR f IN SELECT x.code, x.field_type, x.list_catalogue, x.options FROM public.register_fields x
             WHERE x.register_key = NEW.register_key AND x.is_active AND NOT x.derived AND x.field_type IN ('file', 'list', 'list_code', 'warehouse_item') LOOP
      v := NEW.data -> f.code;
      CONTINUE WHEN v IS NULL OR jsonb_typeof(v) = 'null';
      IF f.field_type = 'file' THEN
        IF NOT public.reg_record_file_ok(NEW.entity_id, (v #>> '{}')::uuid) THEN
          errs := errs || public.reg_err_item('/data/' || f.code, 'file_not_attached', 'Upload the file to the record''s documents and choose it here: a typed reference is not an upload (Q111).');
        END IF;
      ELSIF f.field_type = 'warehouse_item' THEN
        IF EXISTS (SELECT 1 FROM public.warehouse_items w WHERE w.id = (v #>> '{}')::uuid AND NOT w.is_active) AND (prev -> f.code) IS DISTINCT FROM v THEN
          errs := errs || public.reg_err_item('/data/' || f.code, 'inactive_value', 'This Warehouse item is deactivated: choose an active one.');
        END IF;
      ELSIF f.list_catalogue IS NOT NULL THEN
        SELECT * INTO cat FROM public.list_catalogues WHERE code = f.list_catalogue;
        FOR c IN SELECT CASE WHEN jsonb_typeof(v) = 'array' THEN e #>> '{}' ELSE v #>> '{}' END
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END) e LOOP
          SELECT * INTO lv FROM public.list_values WHERE catalogue_code = f.list_catalogue AND code = c;
          IF NOT FOUND THEN
            IF NOT cat.allow_other AND NOT coalesce(prev -> f.code @> to_jsonb(c) OR prev ->> f.code = c, false) THEN
              errs := errs || public.reg_err_item('/data/' || f.code, 'not_in_list', '"' || left(c, 80) || '" is not a value of the list ' || cat.code || '.');
            END IF;
          ELSIF NOT lv.is_active AND NOT coalesce(prev -> f.code @> to_jsonb(c) OR prev ->> f.code = c, false) THEN
            errs := errs || public.reg_err_item('/data/' || f.code, 'inactive_value', '"' || left(c, 80) || '" is deactivated in the list ' || cat.code || ': choose an active value.');
          END IF;
        END LOOP;
      END IF;
    END LOOP;
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;
  IF NEW.state = 'approved' THEN
    -- Q104: a critical list without an active value blocks the approval of every record of a register that uses it
    SELECT array_agg(x ORDER BY x) INTO missing FROM unnest(public.list_catalogues_of(NEW.register_key)) x
    WHERE EXISTS (SELECT 1 FROM public.list_catalogues c2 WHERE c2.code = x AND c2.critical)
      AND NOT EXISTS (SELECT 1 FROM public.list_values v2 WHERE v2.catalogue_code = x AND v2.is_active);
    IF cardinality(missing) > 0 THEN
      PERFORM public.wf_err('list_not_configured', jsonb_build_object('lists', to_jsonb(missing),
        'detail', 'A critical list of this register has no value yet (' || array_to_string(missing, ', ') || '): ask the System Admin to configure it before approving.'));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p5_record_rules BEFORE UPDATE OF state ON register_records
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('in_review', 'in_approval', 'approved'))
  EXECUTE FUNCTION p5_record_rules();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q12 and Q111: Meetings
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_fields SET label_ar = 'التاريخ' WHERE register_key = 'meetings' AND code = 'meeting_date' AND label_ar IS NULL;
UPDATE register_fields SET label_ar = 'العنوان' WHERE register_key = 'meetings' AND code = 'title' AND label_ar IS NULL;
UPDATE register_fields SET label_ar = 'النوع' WHERE register_key = 'meetings' AND code = 'meeting_type' AND label_ar IS NULL;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('meetings', 'organiser',         'Organiser',     'المنظم',            'user',       false, false, false, NULL, true,  'Meeting', 35, NULL),
  ('meetings', 'attendee_users',    'Attendees',     'الحضور',            'multi_user', false, false, false, NULL, false, 'Attendees and sites', 41, NULL),
  ('meetings', 'linked_site_ids',   'Linked sites',  'المواقع المرتبطة',  'multi_site', false, false, false, NULL, false, 'Attendees and sites', 51, NULL),
  ('meetings', 'minutes_file',      'Minutes file',  'ملف المحضر',        'file',       false, false, false, NULL, false, 'Minutes', 61, NULL),
  ('meetings', 'action_items_list', 'Action items',  'إجراءات المتابعة',  'child_list', false, false, false,
     '{"max_rows": 200,
       "closing": {"status": "status", "date": "closed_date", "group": "closed"},
       "columns": [
         {"code": "description", "label_en": "Action",      "label_ar": "الإجراء",          "type": "text",      "required": true},
         {"code": "owner",       "label_en": "Owner",       "label_ar": "المسؤول",          "type": "user",      "required": true},
         {"code": "due_date",    "label_en": "Due date",    "label_ar": "تاريخ الاستحقاق",  "type": "date",      "required": true},
         {"code": "status",      "label_en": "Status",      "label_ar": "الحالة",           "type": "list_code", "required": true, "list_catalogue": "ActionStatus"},
         {"code": "closed_date", "label_en": "Closed date", "label_ar": "تاريخ الإغلاق",    "type": "date",      "is_actual": true},
         {"code": "task_id",     "label_en": "Task",        "label_ar": "المهمة",           "type": "task"}]}'::jsonb,
     false, 'Action items', 71, NULL),
  ('meetings', 'legacy_converted_at', 'Old text converted on', 'تاريخ تحويل النص القديم', 'date', false, false, true, NULL, false, 'Old text (to convert)', 990, NULL),
  ('meetings', 'legacy_converted_by', 'Old text converted by', 'محوّل النص القديم',        'user', false, false, true, NULL, false, 'Old text (to convert)', 995, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

-- The old free-text fields: kept, read-only, until the explicit conversion (Q111: free text is transitional only)
UPDATE register_fields SET derived = true, in_list = false, section = 'Old text (to convert)', label_en = label_en || ' (old text)', sort_order = 900 + sort_order,
  label_ar = CASE code WHEN 'attendees' THEN 'الحضور (نص قديم)' WHEN 'linked_sites' THEN 'المواقع (نص قديم)' WHEN 'minutes_ref' THEN 'مرجع المحضر (نص قديم)' ELSE 'الإجراءات (نص قديم)' END
WHERE register_key = 'meetings' AND code IN ('attendees', 'linked_sites', 'minutes_ref', 'action_items') AND NOT derived;

-- The explicit conversion of the old text of one meeting, after the person reviewed the proposal (GET .../legacy-conversion). p_values: the reviewed
-- organiser, attendee_users, linked_site_ids and action_items_list. Once per logical record (a new version keeps the mark); an action whose text is already
-- in the structured list is not added again; the old text stays as it was. The write is the normal entry save (holder, grant, cleaning, audit), plus one
-- audit row meeting_legacy_convert with the old text and the values.
CREATE OR REPLACE FUNCTION reg_meeting_convert(p_record uuid, p_version integer, p_values jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.register_records%ROWTYPE; k text; errs jsonb := '[]'::jsonb; patch jsonb := '{}'::jsonb; cur jsonb; e jsonb; seen text[]; actor uuid := public.app_actor();
BEGIN
  PERFORM public.calc_require_reason(p_reason);
  r := public.reg_lock(p_record, p_version);
  IF r.register_key <> 'meetings' THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'Only a meeting has old text to convert.')); END IF;
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Convert the old text while the record is in entry: create a new version of an approved meeting first.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_records x WHERE x.entity_id = r.entity_id AND x.data ? 'legacy_converted_at') THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'The old text of this meeting was converted already.'));
  END IF;
  IF NOT (r.data ?| ARRAY['attendees', 'linked_sites', 'minutes_ref', 'action_items']) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This meeting has no old text to convert.'));
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN p_values := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_values) LOOP
    IF k NOT IN ('organiser', 'attendee_users', 'linked_site_ids', 'action_items_list') THEN errs := errs || public.reg_err_item('/values/' || k, 'unknown_field', 'Not a converted field.'); END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_values ? 'organiser' AND NOT r.data ? 'organiser' THEN patch := patch || jsonb_build_object('organiser', p_values -> 'organiser'); END IF;
  FOREACH k IN ARRAY ARRAY['attendee_users', 'linked_site_ids'] LOOP
    IF jsonb_typeof(p_values -> k) = 'array' THEN
      cur := coalesce(r.data -> k, '[]'::jsonb);
      FOR e IN SELECT * FROM jsonb_array_elements(p_values -> k) LOOP
        IF NOT cur @> jsonb_build_array(e) THEN cur := cur || jsonb_build_array(e); END IF;
      END LOOP;
      patch := patch || jsonb_build_object(k, cur);
    END IF;
  END LOOP;
  IF jsonb_typeof(p_values -> 'action_items_list') = 'array' THEN
    cur := coalesce(r.data -> 'action_items_list', '[]'::jsonb);
    SELECT coalesce(array_agg(lower(btrim(x ->> 'description'))), ARRAY[]::text[]) INTO seen FROM jsonb_array_elements(cur) x;
    FOR e IN SELECT * FROM jsonb_array_elements(p_values -> 'action_items_list') LOOP
      IF jsonb_typeof(e) = 'object' AND NOT (lower(btrim(coalesce(e ->> 'description', ''))) = ANY (seen)) THEN
        cur := cur || jsonb_build_array(e - 'id');
        seen := seen || lower(btrim(coalesce(e ->> 'description', '')));
      END IF;
    END LOOP;
    patch := patch || jsonb_build_object('action_items_list', cur);
  END IF;

  PERFORM public.reg_save_record('meetings', p_record, p_version, NULL, NULL, patch, NULL, NULL, false);
  UPDATE public.register_records SET data = data || jsonb_build_object('legacy_converted_at', current_date::text, 'legacy_converted_by', actor::text) WHERE id = p_record;
  PERFORM public.log_audit_write('meeting_legacy_convert', 'register_record', r.entity_id::text,
    jsonb_build_object('attendees', r.data -> 'attendees', 'linked_sites', r.data -> 'linked_sites', 'minutes_ref', r.data -> 'minutes_ref', 'action_items', r.data -> 'action_items'),
    (SELECT jsonb_build_object('organiser', x.data -> 'organiser', 'attendee_users', x.data -> 'attendee_users', 'linked_site_ids', x.data -> 'linked_site_ids',
       'action_items_list', x.data -> 'action_items_list') FROM public.register_records x WHERE x.id = p_record),
    p_reason);
  RETURN p_record;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. D108b: RF Height is a number in metres plus an optional note (for values such as "30/45"); the saved numbers stay as they are
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_fields SET label_ar = 'ارتفاع RF (م)' WHERE register_key = 'as_built' AND code = 'rf_height' AND label_ar IS NULL;
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('as_built', 'rf_height_note', 'RF Height note', 'ملاحظة ارتفاع RF', 'text', false, false, false, NULL, false, 'WL', 535)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Templates: the columns of the new types (multi values separated by ";"; a file or a child list is grey and never read)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tpl_columns(p_register text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.register_definitions%ROWTYPE; ent text; out jsonb;
BEGIN
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_register;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  SELECT t.custom_entity INTO ent FROM public.template_definitions t WHERE t.register_key = p_register LIMIT 1;
  WITH cols AS (
    SELECT 10 AS grp, 0 AS ord, 'site_code'::text AS code, 'Site ID'::text AS label, 'text'::text AS type, 'site'::text AS kind, false AS required, false AS derived, NULL::jsonb AS options,
           NULL::boolean AS allow_other, NULL::boolean AS multiple
      WHERE d.site_scoped
    UNION ALL
    SELECT 20, 0, 'record_type', 'Record Type', 'list', 'record_type', false, false, to_jsonb(d.record_types), NULL, NULL WHERE cardinality(d.record_types) > 0
    UNION ALL
    SELECT 30, f.sort_order, f.code, f.label_en,
           CASE WHEN f.field_type = 'list_code' THEN CASE WHEN coalesce((f.options ->> 'multiple')::boolean, false) THEN 'multi_list' ELSE 'list' END ELSE f.field_type END,
           'field', f.required, f.derived OR f.field_type IN ('file', 'child_list'),
           CASE WHEN f.list_catalogue IS NOT NULL THEN public.list_active_codes(f.list_catalogue)
                WHEN jsonb_typeof(f.options) = 'array' THEN f.options
                WHEN jsonb_typeof(f.options) = 'object' AND f.options ->> 'source' = 'permit_types'
                  THEN (SELECT coalesce(jsonb_agg(pt.code ORDER BY pt.sort_order, pt.code), '[]'::jsonb) FROM public.permit_types pt WHERE pt.is_active)
                WHEN f.field_type = 'yes_no' THEN '["Yes", "No"]'::jsonb END,
           CASE WHEN f.list_catalogue IS NOT NULL AND (SELECT c.allow_other FROM public.list_catalogues c WHERE c.code = f.list_catalogue) THEN true END,
           CASE WHEN f.field_type IN ('multi_user', 'multi_site') OR (f.field_type = 'list_code' AND coalesce((f.options ->> 'multiple')::boolean, false)) THEN true END
      FROM public.register_fields f WHERE f.register_key = p_register AND f.is_active
    UNION ALL
    SELECT 40, c.sort_order, c.code, c.label_en,
           CASE c.data_type::text WHEN 'multi_list' THEN 'text' WHEN 'file' THEN 'text' WHEN 'external_party' THEN 'text' ELSE c.data_type::text END,
           'custom', c.required, false,
           CASE WHEN c.data_type::text = 'list' AND c.validation ->> 'list_catalogue' IS NOT NULL THEN public.list_active_codes(c.validation ->> 'list_catalogue')
                WHEN c.data_type::text = 'list' THEN (SELECT coalesce(jsonb_agg(l.code ORDER BY l.sort_order, l.code), '[]'::jsonb) FROM public.field_list_values l WHERE l.field_id = c.id AND l.is_active)
                WHEN c.data_type::text = 'yes_no' THEN '["Yes", "No"]'::jsonb END,
           NULL, NULL
      FROM public.field_definitions c
      WHERE ent IS NOT NULL AND c.entity_type::text = ent AND c.is_active AND c.in_templates AND c.task_code IS NULL
        AND c.data_type::text NOT IN ('file', 'multi_list', 'user', 'external_party')
    UNION ALL
    SELECT 90, 0, 'record_id', 'Record ID', 'text', 'record_id', false, false, NULL::jsonb, NULL, NULL
  ), numbered AS (
    SELECT c.*, count(*) OVER (PARTITION BY lower(c.label)) AS same
    FROM cols c
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'code', n.code, 'header', CASE WHEN n.same > 1 THEN n.label || ' [' || n.code || ']' ELSE n.label END, 'type', n.type, 'kind', n.kind,
      'required', n.required, 'derived', n.derived, 'options', n.options, 'allow_other', n.allow_other, 'multiple', n.multiple)) ORDER BY n.grp, n.ord, n.code COLLATE "C"), '[]'::jsonb)
  INTO out FROM numbered n;
  RETURN out;
END $$;

-- A change of the list values issues new template versions (the statement trigger of 0037 on register_fields already covers the options of the list fields;
-- this one covers the list_code fields and the custom fields that read a catalogue).
CREATE TRIGGER tpl_list_values_changed AFTER INSERT OR UPDATE ON list_values FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Custom fields: a list or multi-list custom field may read a catalogue (validation.list_catalogue) instead of its own options
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION custom_check_value(f field_definitions, v jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE t text := jsonb_typeof(v); s text; n numeric; d date; el jsonb; vmin text := f.validation->>'min'; vmax text := f.validation->>'max'; cat text := f.validation->>'list_catalogue';
BEGIN
  CASE f.data_type::text
    WHEN 'text' THEN
      IF t <> 'string' THEN RETURN 'must be text'; END IF;
      s := v #>> '{}';
      IF f.validation ? 'min_length' AND length(s) < (f.validation->>'min_length')::int THEN RETURN 'too short'; END IF;
      IF f.validation ? 'max_length' AND length(s) > (f.validation->>'max_length')::int THEN RETURN 'too long'; END IF;
      IF f.validation ? 'pattern' AND s !~ (f.validation->>'pattern') THEN RETURN 'does not match the pattern'; END IF;
    WHEN 'number' THEN
      IF t <> 'number' THEN RETURN 'must be a number'; END IF;
      n := (v #>> '{}')::numeric;
      IF vmin IS NOT NULL AND n < vmin::numeric THEN RETURN 'below minimum'; END IF;
      IF vmax IS NOT NULL AND n > vmax::numeric THEN RETURN 'above maximum'; END IF;
    WHEN 'date' THEN
      IF t <> 'string' OR (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN 'must be an ISO date (YYYY-MM-DD)'; END IF;
      BEGIN d := (v #>> '{}')::date; EXCEPTION WHEN others THEN RETURN 'not a valid date'; END;
      IF vmin IS NOT NULL AND d < vmin::date THEN RETURN 'before minimum date'; END IF;
      IF vmax IS NOT NULL AND d > vmax::date THEN RETURN 'after maximum date'; END IF;
    WHEN 'bool' THEN
      IF t <> 'boolean' THEN RETURN 'must be true or false'; END IF;
    WHEN 'list' THEN
      IF t <> 'string' THEN RETURN 'not an active list option'; END IF;
      IF cat IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM list_values l WHERE l.catalogue_code = cat AND l.code = (v #>> '{}') AND l.is_active) THEN RETURN 'not an active list option'; END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM field_list_values l WHERE l.field_id = f.id AND l.code = (v #>> '{}') AND l.is_active) THEN
        RETURN 'not an active list option';
      END IF;
    WHEN 'multi_list' THEN
      IF t <> 'array' THEN RETURN 'must be a list of options'; END IF;
      FOR el IN SELECT * FROM jsonb_array_elements(v) LOOP
        IF jsonb_typeof(el) <> 'string'
           OR (cat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM list_values l WHERE l.catalogue_code = cat AND l.code = (el #>> '{}') AND l.is_active))
           OR (cat IS NULL AND NOT EXISTS (SELECT 1 FROM field_list_values l WHERE l.field_id = f.id AND l.code = (el #>> '{}') AND l.is_active)) THEN
          RETURN 'contains an option that is not active';
        END IF;
      END LOOP;
    WHEN 'user' THEN
      IF t <> 'string' OR (v #>> '{}') !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = (v #>> '{}')::uuid) THEN RETURN 'unknown user'; END IF;
    WHEN 'external_party' THEN
      IF t <> 'string' OR (v #>> '{}') !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM external_parties p WHERE p.id = (v #>> '{}')::uuid) THEN RETURN 'unknown external party'; END IF;
    WHEN 'file' THEN
      IF t <> 'string' OR length(v #>> '{}') = 0 THEN RETURN 'must be a stored file key'; END IF;
  END CASE;
  RETURN NULL;
END $$;
GRANT SELECT ON list_values TO pmis_definer;

-- the template versions that changed with the fields above (meetings, As-Built, the lists that were free text)
SELECT tpl_sync_all();

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'list_pick(text,text)', 'list_active_codes(text)', 'list_catalogues_of(text)', 'list_refresh_fields(text)',
    'admin_save_list_catalogue(text,boolean,jsonb,text,integer)', 'admin_save_list_value(text,uuid,jsonb,text,integer)',
    'reg_pick_user(text)', 'reg_pick_site(text)', 'reg_list_value(text,text)', 'reg_clean_cell(jsonb,jsonb)',
    'reg_record_file_ok(uuid,uuid)', 'p5_record_rules()', 'reg_meeting_convert(uuid,integer,jsonb,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: the resolvers (they read across regions), the field refresh, the trigger and the file check (called by definer functions only)
    FOREACH f IN ARRAY ARRAY['admin_save_list_catalogue(text,boolean,jsonb,text,integer)', 'admin_save_list_value(text,uuid,jsonb,text,integer)',
                             'reg_meeting_convert(uuid,integer,jsonb,text)', 'list_active_codes(text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON list_catalogues, list_values FROM pmis_app;
  END IF;
END $$;
