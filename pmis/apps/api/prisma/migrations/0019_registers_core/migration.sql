-- 0019_registers_core: the register framework and the first four registers (Procurement, GECOL, HLC, Permits & HSE).
-- Mirror: db/sql/018_registers_core.sql (kept identical).
--
-- Design (owner decisions Q43, Q45, Q55, Q56, Q57, Q63c, Q69; spec docs/spec/registers-and-streams.md section 1 and 3):
--   * A register record is a VERSION of a logical record (entity_id). It lives in register_records with a state
--     (entry -> in_review -> in_approval -> approved, or voided), the same level machinery as a task (levels from the register's
--     Matrix row, auto-skip, B5, B6, B7, B10, claim) and its data as JSONB checked against register_fields.
--   * The existing typed tables (procurement_records, gecol_records, hlc_records, permit_records) keep only APPROVED values: the
--     final approval of a version projects it into the typed row with id = entity_id. Drafts and records in review never reach
--     them, so gate_eval, the SLA end events and every other reader of those tables (0017) keep working untouched, and an approved
--     value stays in force until the next version is approved (R9, RE-03).
--   * reg_* functions (owner pmis_definer) are written beside the wf_* functions and reuse their pure helpers (wf_err, wf_kind,
--     wf_actor_regions, wf_cell, wf_rule, wf_levels_live, wf_missing_slots, wf_unlock_successors, wf_audit). 0015 and 0016 are not touched.
--   * Q43: a record that is the source of a task (register_task_sources) is approved at its review and approve levels by the TASK's
--     matrix cells (the stage row, or a task cell) and, on the final approval, fills the task's date and approves the task in the same
--     transaction. The entry level always belongs to the register's own row (Q56 ownership). Every other record uses the register row.
--   * pmis_app only reads these tables. Every write goes through reg_* functions; a backstop trigger refuses any other writer.
--
-- Contents: 1 definitions and fields  2 tables  3 matrix rows  4 typed tables  5 backstop, grants, RLS  6 seeds
--           7 resolvers  8 validation  9 projection and task completion  10 writes and transitions  11 views  12 ownership and execute rights.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Register catalogue (one Matrix row per register, B11) and its fields (data, not code)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE register_definitions (
  register_key      TEXT PRIMARY KEY CHECK (register_key ~ '^[a-z][a-z_]{1,30}$'),
  name_en           TEXT    NOT NULL,
  name_ar           TEXT,
  module_key        TEXT    NOT NULL,                    -- the permission module of the grid (view, create, edit, approve ...)
  kind              TEXT    NOT NULL DEFAULT 'register' CHECK (kind IN ('register', 'dismantle')),
  site_scoped       BOOLEAN NOT NULL DEFAULT true,       -- false = rows without a site (Q69: visible to anyone holding the module)
  multiple_per_site BOOLEAN NOT NULL DEFAULT true,       -- false = one logical record per site; a new request is a new version (Q55)
  record_types      TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  approval_levels   INTEGER NOT NULL DEFAULT 3 CHECK (approval_levels BETWEEN 1 AND 3),   -- the level count of the register row (B11)
  rules             JSONB   NOT NULL DEFAULT '{}',        -- configurable rule parameters (for example refused procurement scopes, Q56)
  enabled           BOOLEAN NOT NULL DEFAULT false,      -- a register whose records the API accepts
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE register_fields (
  register_key TEXT    NOT NULL REFERENCES register_definitions (register_key) ON DELETE CASCADE ON UPDATE CASCADE,
  code         TEXT    NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,40}$'),
  label_en     TEXT    NOT NULL,
  label_ar     TEXT,
  field_type   TEXT    NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'list', 'yes_no', 'user', 'external_team')),
  required     BOOLEAN NOT NULL DEFAULT false,           -- needed to submit
  is_actual    BOOLEAN NOT NULL DEFAULT false,           -- an actual date: not in the future (V2)
  derived      BOOLEAN NOT NULL DEFAULT false,           -- filled by the system, never typed (Q45)
  options      JSONB,                                    -- NULL = free; an array of texts; or {"source": "permit_types"}
  in_list      BOOLEAN NOT NULL DEFAULT false,
  section      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (register_key, code)
);

-- Which records are the source of which task (Q43). The first matching record of a site that finds the task open becomes its source.
CREATE TABLE register_task_sources (
  register_key TEXT    NOT NULL REFERENCES register_definitions (register_key) ON DELETE CASCADE ON UPDATE CASCADE,
  task_code    TEXT    NOT NULL,
  date_field   TEXT    NOT NULL,                         -- the data key whose value becomes the task's date on approval
  data_eq      JSONB   NOT NULL DEFAULT '{}',            -- data keys that must equal these values (case-insensitive text)
  data_in      JSONB   NOT NULL DEFAULT '{}',            -- data keys whose value must be one of these arrays
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (register_key, task_code)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Records, steps, level actors and voters
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE register_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             UUID        NOT NULL,            -- the logical record; the id of its typed row once approved
  version_no            INTEGER     NOT NULL DEFAULT 1,  -- business version of the logical record (1, 2, 3 ...)
  supersedes_id         UUID REFERENCES register_records (id) ON DELETE RESTRICT,
  is_current            BOOLEAN     NOT NULL DEFAULT false,  -- the latest approved version (the one in force)
  register_key          TEXT        NOT NULL REFERENCES register_definitions (register_key) ON UPDATE CASCADE,
  record_type           TEXT,
  site_id               UUID,
  region_id             INTEGER,
  is_global             BOOLEAN     NOT NULL DEFAULT false,
  state                 TEXT        NOT NULL DEFAULT 'entry' CHECK (state IN ('entry', 'in_review', 'in_approval', 'approved', 'voided')),
  current_level         INTEGER     NOT NULL DEFAULT 1,
  levels_required       INTEGER     NOT NULL DEFAULT 3 CHECK (levels_required BETWEEN 1 AND 3),
  path_frozen_at        TIMESTAMPTZ(6),                  -- B7: the level path is final from the first submission
  level_round           INTEGER     NOT NULL DEFAULT 0,
  level_opened_at       TIMESTAMPTZ(6),
  ball_in_court_user_id UUID,                            -- claimant of a group level, or the person a rejection returned the record to (B6)
  return_count          INTEGER     NOT NULL DEFAULT 0,
  last_return_note      TEXT,
  self_approval         BOOLEAN     NOT NULL DEFAULT false,
  task_id               UUID REFERENCES task_instances (id) ON DELETE RESTRICT,   -- Q43: the task this record is the source of (set at first submission)
  data                  JSONB       NOT NULL DEFAULT '{}',
  custom                JSONB       NOT NULL DEFAULT '{}',
  external_party_id     UUID REFERENCES external_parties (id) ON DELETE RESTRICT,
  source                TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'template')),
  batch_row_id          UUID,                            -- template entry: the import row this version came from
  version               INTEGER     NOT NULL DEFAULT 1,  -- If-Match counter
  created_by            UUID,
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  submitted_at          TIMESTAMPTZ(6),
  approved_at           TIMESTAMPTZ(6),
  approved_by           UUID,
  voided_at             TIMESTAMPTZ(6),
  voided_by             UUID,
  void_reason           TEXT,
  CONSTRAINT register_records_site_fkey FOREIGN KEY (site_id, region_id) REFERENCES sites (id, region_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT register_records_global_xor_site CHECK ((is_global AND site_id IS NULL AND region_id IS NULL) OR (NOT is_global AND site_id IS NOT NULL AND region_id IS NOT NULL)),
  CONSTRAINT register_records_version_key UNIQUE (entity_id, version_no)
);
CREATE INDEX register_records_register_site_idx ON register_records (register_key, site_id);
CREATE INDEX register_records_region_state_idx ON register_records (register_key, region_id, state);
CREATE INDEX register_records_task_idx ON register_records (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX register_records_data_idx ON register_records USING GIN (data);
-- one open (not yet approved) version per logical record
CREATE UNIQUE INDEX register_records_one_open_idx ON register_records (entity_id) WHERE state IN ('entry', 'in_review', 'in_approval');
-- one logical record per site in the registers that are one-per-site (Q55); a voided first version frees the slot
CREATE UNIQUE INDEX register_records_one_per_site_idx ON register_records (register_key, site_id) WHERE version_no = 1 AND state <> 'voided' AND register_key IN ('gecol', 'hlc');
-- one current approved version per logical record
CREATE UNIQUE INDEX register_records_one_current_idx ON register_records (entity_id) WHERE is_current;

CREATE TABLE register_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id      UUID        NOT NULL REFERENCES register_records (id) ON DELETE CASCADE ON UPDATE CASCADE,
  level          INTEGER     NOT NULL,
  action         TEXT        NOT NULL CHECK (action IN ('create', 'edit', 'submit', 'review', 'approve', 'reject', 'auto_skip', 'claim', 'release', 'new_version', 'void')),
  acted_by       UUID,
  note           TEXT,
  before_state   TEXT,
  after_state    TEXT,
  stepup_verified BOOLEAN    NOT NULL DEFAULT false,
  self_approval  BOOLEAN     NOT NULL DEFAULT false,
  batch_row_id   UUID,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX register_steps_record_idx ON register_steps (record_id, created_at);

CREATE TABLE register_level_actors (
  record_id UUID    NOT NULL REFERENCES register_records (id) ON DELETE CASCADE ON UPDATE CASCADE,
  level     INTEGER NOT NULL,
  user_id   UUID    NOT NULL,
  how       TEXT    NOT NULL CHECK (how IN ('acted', 'skipped')),
  acted_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, level)
);
CREATE TABLE register_level_voters (
  record_id UUID    NOT NULL REFERENCES register_records (id) ON DELETE CASCADE ON UPDATE CASCADE,
  level     INTEGER NOT NULL,
  round     INTEGER NOT NULL,
  user_id   UUID    NOT NULL,
  voted_at  TIMESTAMPTZ(6),
  PRIMARY KEY (record_id, level, round, user_id)
);
CREATE INDEX register_level_voters_user_idx ON register_level_voters (user_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Matrix rows of the registers (B11): matrix_cells gets a register_key beside the stage_id. Cells of a register row are not
--    versioned with the workflow (admin_create_workflow_draft copies only cells whose stage it copies).
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE matrix_cells ADD COLUMN register_key TEXT REFERENCES register_definitions (register_key) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE matrix_cells ALTER COLUMN stage_id DROP NOT NULL;
ALTER TABLE matrix_cells ADD CONSTRAINT matrix_cells_stage_xor_register CHECK ((stage_id IS NULL) <> (register_key IS NULL));
ALTER TABLE matrix_cells ADD CONSTRAINT matrix_cells_register_no_task CHECK (register_key IS NULL OR task_def_id IS NULL);
CREATE UNIQUE INDEX matrix_cells_register_level_region_key ON matrix_cells (register_key, level, coalesce(region_id, 0)) WHERE register_key IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Typed tables: the approved projection keeps a pointer to the version that produced it (and the GECOL request date, Q56)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE procurement_records ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER;
ALTER TABLE gecol_records       ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER, ADD COLUMN request_date DATE;
ALTER TABLE hlc_records         ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER;
ALTER TABLE permit_records      ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER;
COMMENT ON COLUMN gecol_records.request_date IS 'Q56: the GECOL team enters the GECOL purchase request in the GECOL register (PR no. in pr_no, date here).';

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Backstop, RLS and grants
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_definer' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION '% is written only through reg_* functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON register_records FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON register_steps FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON procurement_records FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON gecol_records FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON hlc_records FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON permit_records FOR EACH ROW EXECUTE FUNCTION reg_backstop();

-- Records: strict region read (a record without a site is a global row, readable by any session; the module is checked by the
-- functions and the API, Q69). Nobody writes through policies: the definer functions bypass RLS, the migration role seeds.
ALTER TABLE register_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_records FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON register_records FOR SELECT USING (app_region_read(is_global, region_id));
CREATE POLICY rls_seed_write ON register_records FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['register_steps', 'register_level_actors', 'register_level_voters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM register_records p WHERE p.id = record_id))', t);
    EXECUTE format('CREATE POLICY rls_seed_write ON %I FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['register_definitions', 'register_fields', 'register_task_sources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY rls_seed_write ON %I FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON register_records, procurement_records, gecol_records, hlc_records, permit_records TO pmis_definer;
GRANT SELECT, INSERT ON register_steps TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON register_level_actors, register_level_voters TO pmis_definer;
GRANT SELECT ON register_definitions, register_fields, register_task_sources, permit_types, external_teams, external_parties, field_definitions TO pmis_definer;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON register_records, register_steps, register_level_actors, register_level_voters, register_definitions, register_fields,
      register_task_sources, procurement_records, gecol_records, hlc_records, permit_records FROM pmis_app;
    GRANT SELECT ON register_records, register_steps, register_level_actors, register_level_voters, register_definitions, register_fields, register_task_sources,
      procurement_records, gecol_records, hlc_records, permit_records TO pmis_app;
  END IF;
END $$;

-- The generic custom-field check (0007) runs on register_records too, for the entity of the record's register.
CREATE TRIGGER custom_validate_procurement BEFORE INSERT OR UPDATE OF custom ON register_records FOR EACH ROW WHEN (NEW.register_key = 'procurement') EXECUTE FUNCTION custom_validate('procurement');
CREATE TRIGGER custom_validate_gecol       BEFORE INSERT OR UPDATE OF custom ON register_records FOR EACH ROW WHEN (NEW.register_key = 'gecol')       EXECUTE FUNCTION custom_validate('gecol');
CREATE TRIGGER custom_validate_hlc         BEFORE INSERT OR UPDATE OF custom ON register_records FOR EACH ROW WHEN (NEW.register_key = 'hlc')         EXECUTE FUNCTION custom_validate('hlc');
CREATE TRIGGER custom_validate_permit      BEFORE INSERT OR UPDATE OF custom ON register_records FOR EACH ROW WHEN (NEW.register_key = 'permits_hse') EXECUTE FUNCTION custom_validate('permit');

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Seeds (idempotent). Runs as the migration role.
-- ---------------------------------------------------------------------------------------------------------------------
-- The catalogue of the contract (13 registers and Dismantle, B11). Only the first four are enabled by this migration.
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('procurement',        'Procurement (PR / PO / WO)', 'المشتريات (PR / PO / WO)', 'procurement',    'register',  true,  true,  ARRAY['pr', 'po', 'wo'], 3,
     '{"refused_scopes": {"GECOL": "gecol", "HLC": "hlc"}}'::jsonb, true, 10),
  ('contractors',        'Contractors',                'المقاولون',               'contractors',    'register',  false, true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 20),
  ('gecol',              'GECOL power',                'كهرباء GECOL',            'gecol',          'register',  true,  false, ARRAY[]::text[], 3, '{"counts_as_purchase_request": true}'::jsonb, true, 30),
  ('hlc',                'HLC fiber',                  'ألياف HLC',               'hlc',            'register',  true,  false, ARRAY[]::text[], 3, '{"counts_as_purchase_request": true}'::jsonb, true, 40),
  ('permits_hse',        'Permits & HSE',              'التصاريح والسلامة',       'permits_hse',    'register',  true,  true,  ARRAY[]::text[], 3, '{}'::jsonb, true, 50),
  ('warehouse',          'Warehouse',                  'المخزن',                  'warehouse',      'register',  false, true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 60),
  ('quality',            'Quality',                    'الجودة',                  'quality',        'register',  true,  true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 70),
  ('issues',             'Issue Log',                  'سجل المشاكل',             'issues',         'register',  true,  true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 80),
  ('risks',              'Risk Register',              'سجل المخاطر',             'risks',          'register',  false, true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 90),
  ('change_control',     'Change Control',             'ضبط التغيير',             'change_control', 'register',  true,  true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 100),
  ('readiness_handover', 'Readiness & Handover',       'الجاهزية والتسليم',       'readiness',      'register',  true,  false, ARRAY[]::text[], 3, '{}'::jsonb, false, 110),
  ('as_built',           'As-Built',                   'كما نُفّذ',               'as_built',       'register',  true,  false, ARRAY[]::text[], 3, '{}'::jsonb, false, 120),
  ('meetings',           'Meetings',                   'الاجتماعات',              'meetings',       'register',  false, true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 130),
  ('dismantle',          'Dismantle',                  'الفك',                    'dismantle',      'dismantle', true,  true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 140)
ON CONFLICT (register_key) DO NOTHING;

-- Fields of the four registers (docs/spec/registers-and-streams.md section 3). A list with NULL options accepts any text until
-- the owner fixes its values (ProcStatus, FiberStatus, EHSCheck: open questions).
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('procurement', 'scope',        'Scope',            'النطاق',            'list',          true,  false, false, '["CW", "Tower Erection", "Site Adaption", "TE Installation", "CW Dismantle", "TE Dismantle", "STA", "ST"]'::jsonb, true,  'Site and scope', 10),
  ('procurement', 'delivery',     'Delivery',         'طريقة التنفيذ',     'list',          false, false, false, '["Outsourced", "In-House", "TE Vendor"]'::jsonb, true,  'Site and scope', 20),
  ('procurement', 'pr_no',        'PR No.',           'رقم طلب الشراء',    'text',          false, false, false, NULL, true,  'Request', 30),
  ('procurement', 'pr_date',      'PR Date',          'تاريخ طلب الشراء',  'date',          false, true,  false, NULL, true,  'Request', 40),
  ('procurement', 'po_wo_no',     'PO / WO No.',      'رقم أمر الشراء / العمل', 'text',     false, false, false, NULL, true,  'Order', 50),
  ('procurement', 'po_wo_date',   'PO / WO Date',     'تاريخ أمر الشراء / العمل', 'date',   false, true,  false, NULL, true,  'Order', 60),
  ('procurement', 'team_id',      'Team',             'الفريق',            'external_team', false, false, false, NULL, false, 'Assignment', 70),
  ('procurement', 'order_status', 'Order Status',     'حالة الطلب',        'list',          true,  false, false, NULL, true,  'Status and remark', 80),
  ('procurement', 'remark',       'Remark',           'ملاحظات',           'text',          false, false, false, NULL, false, 'Status and remark', 90),

  ('gecol', 'pr_no',                  'GECOL PR No.',               'رقم طلب الشراء (GECOL)', 'text',   true,  false, false, NULL, true,  'Request', 10),
  ('gecol', 'request_date',           'GECOL Request Date',         'تاريخ طلب GECOL',        'date',   true,  true,  false, NULL, true,  'Request', 20),
  ('gecol', 'contractor',             'GECOL Contractor',           'مقاول GECOL',            'text',   false, false, false, NULL, false, 'Request', 30),
  ('gecol', 'survey_date',            'Survey Date',                'تاريخ المسح',            'date',   false, true,  false, NULL, false, 'Survey and layout', 40),
  ('gecol', 'layout_received',        'Layout Received',            'استلام المخطط',          'date',   false, true,  false, NULL, false, 'Survey and layout', 50),
  ('gecol', 'layout_approved',        'Layout Approved',            'اعتماد المخطط',          'date',   false, true,  false, NULL, false, 'Survey and layout', 60),
  ('gecol', 'notice_date',            'GECOL Notice Date',          'تاريخ إشعار GECOL',      'date',   false, true,  false, NULL, false, 'Notice and works', 70),
  ('gecol', 'mos_date',               'MOS Date',                   'تاريخ MOS',              'date',   false, true,  false, NULL, false, 'Notice and works', 80),
  ('gecol', 'installation_finish',    'Installation Finish Date',   'تاريخ انتهاء التركيب',   'date',   false, true,  false, NULL, true,  'Notice and works', 90),
  ('gecol', 'aat_acceptance_date',    'AAT Acceptance Date',        'تاريخ قبول AAT',         'date',   false, true,  false, NULL, false, 'Acceptance', 100),
  ('gecol', 'docs_approval_date',     'GECOL Docs Approval Date',   'تاريخ اعتماد مستندات GECOL', 'date', false, true, false, NULL, false, 'Acceptance', 110),
  ('gecol', 'meter_no',               'Meter No.',                  'رقم العداد',             'text',   false, false, false, NULL, false, 'Meter and power-on', 120),
  ('gecol', 'power_on_date',          'Power-On Date (Meter Charging)', 'تاريخ التشغيل (شحن العداد)', 'date', false, true, false, NULL, true, 'Meter and power-on', 130),
  ('gecol', 'billing_conversion_date','Billing Conversion Date',    'تاريخ تحويل الفوترة',    'date',   false, true,  false, NULL, false, 'Meter and power-on', 140),
  ('gecol', 'remark',                 'Remark',                     'ملاحظات',                'text',   false, false, false, NULL, false, 'Remark', 150),

  ('hlc', 'request_no',          'HLC Request No.',           'رقم طلب HLC',          'text',  true,  false, false, NULL, true,  'Request', 10),
  ('hlc', 'request_date',        'Request Date',              'تاريخ الطلب',          'date',  true,  true,  false, NULL, true,  'Request', 20),
  ('hlc', 'fiber_uplink',        'Fiber Uplink (Exchange / Post)', 'وصلة الألياف (مقسم / عمود)', 'text', false, false, false, NULL, false, 'Request', 30),
  ('hlc', 'fiber_status',        'Fiber Status',              'حالة الألياف',         'list',  false, false, false, NULL, true,  'Status and team', 40),
  ('hlc', 'internal_fiber_team', 'Internal Fiber Team',       'فريق الألياف الداخلي', 'text',  false, false, false, NULL, false, 'Status and team', 50),
  ('hlc', 'installation_date',   'Installation Date',         'تاريخ التركيب',        'date',  false, true,  false, NULL, true,  'Installation and test', 60),
  ('hlc', 'tx_link_tested_date', 'TX Link Tested Date',       'تاريخ فحص وصلة TX',    'date',  false, true,  false, NULL, true,  'Installation and test', 70),
  ('hlc', 'remark',              'Remark',                    'ملاحظات',              'text',  false, false, false, NULL, false, 'Remark', 80),

  ('permits_hse', 'permit_type',      'Type',                  'النوع',                'list',   true,  false, false, '{"source": "permit_types"}'::jsonb, true,  'Permit', 10),
  ('permits_hse', 'applied_date',     'Applied / Requested',   'تاريخ التقديم',        'date',   false, true,  false, NULL, false, 'Permit', 20),
  ('permits_hse', 'status',           'Status',                'الحالة',               'list',   true,  false, false, '["Applied", "Approved", "Rejected", "N/A"]'::jsonb, true,  'Permit', 30),
  ('permits_hse', 'has_expiry',       'Has expiry date',       'له تاريخ انتهاء',      'yes_no', false, false, false, NULL, true,  'Validity', 40),
  ('permits_hse', 'valid_from',       'Valid From',            'ساري من',              'date',   false, false, false, NULL, true,  'Validity', 50),
  ('permits_hse', 'valid_to',         'Valid To',              'ساري حتى',             'date',   false, false, false, NULL, true,  'Validity', 60),
  ('permits_hse', 'na_reason',        'N/A Reason',            'سبب عدم الانطباق',     'text',   false, false, false, NULL, false, 'N/A', 70),
  ('permits_hse', 'na_approved_by',   'N/A Approved By',       'معتمد عدم الانطباق',   'text',   false, false, true,  NULL, false, 'N/A', 80),
  ('permits_hse', 'jsa_tra',          'JSA / TRA',             'JSA / TRA',            'list',   false, false, false, NULL, false, 'PTW checks', 90),
  ('permits_hse', 'toolbox_talk',     'Toolbox Talk',          'Toolbox Talk',         'list',   false, false, false, NULL, false, 'PTW checks', 100),
  ('permits_hse', 'work_at_height',   'Work at Height',        'العمل على المرتفعات',  'list',   false, false, false, NULL, false, 'PTW checks', 110),
  ('permits_hse', 'lifting_plan',     'Lifting Plan',          'خطة الرفع',            'list',   false, false, false, NULL, false, 'PTW checks', 120),
  ('permits_hse', 'loto',             'LOTO',                  'LOTO',                 'list',   false, false, false, NULL, false, 'PTW checks', 130),
  ('permits_hse', 'rescue_plan',      'Rescue Plan',           'خطة الإنقاذ',          'list',   false, false, false, NULL, false, 'PTW checks', 140),
  ('permits_hse', 'stop_work',        'Stop Work',             'إيقاف العمل',          'yes_no', false, false, false, NULL, true,  'Stop work', 150),
  ('permits_hse', 'stop_lifted_date', 'Stop Lifted Date',      'تاريخ رفع الإيقاف',    'date',   false, true,  false, NULL, false, 'Stop work', 160),
  ('permits_hse', 'remark',           'Remark',                'ملاحظات',              'text',   false, false, false, NULL, false, 'Remark', 170)
ON CONFLICT (register_key, code) DO NOTHING;

-- Q43: records that are the source of a task. Dates: B1 = PR date, B2 = PO/WO date (the first CW order, outsourced or not), B3 and D1 =
-- Valid From of the first approved Access permit (Master AL, CB; Q57: a renewal never closes the task again), C2 = Power-On, C4 = TX Link Tested (Q54).
INSERT INTO register_task_sources (register_key, task_code, date_field, data_eq, data_in, sort_order) VALUES
  ('procurement', 'B1', 'pr_date',             '{}'::jsonb, '{"scope": ["CW", "Tower Erection", "Site Adaption"]}'::jsonb, 10),
  ('procurement', 'B2', 'po_wo_date',          '{}'::jsonb, '{"scope": ["CW", "Tower Erection", "Site Adaption"]}'::jsonb, 20),
  ('permits_hse', 'B3', 'valid_from',          '{"permit_type": "Access - CW", "status": "Approved"}'::jsonb, '{}'::jsonb, 10),
  ('permits_hse', 'D1', 'valid_from',          '{"permit_type": "Access - TE", "status": "Approved"}'::jsonb, '{}'::jsonb, 20),
  ('gecol',       'C2', 'power_on_date',       '{}'::jsonb, '{}'::jsonb, 10),
  ('hlc',         'C4', 'tx_link_tested_date', '{}'::jsonb, '{}'::jsonb, 10)
ON CONFLICT (register_key, task_code) DO NOTHING;

-- Q56 ownership: each team enters its own requests. The entry cell of the three rows names the owning team's role (global cell;
-- a region cell, when the admin makes one, wins). Review and approve cells stay empty until the admin sets them (B10: a level with
-- nobody goes to the System Admins' inbox). Permits & HSE has no owner in the owner's answers, so its row is not seeded.
INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at)
SELECT v.k, 1, 'any_one', NULL, true, now()
FROM (VALUES ('procurement'), ('gecol'), ('hlc')) AS v(k)
WHERE NOT EXISTS (SELECT 1 FROM matrix_cells c WHERE c.register_key = v.k AND c.level = 1 AND c.region_id IS NULL);
INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id)
SELECT c.id, 'role', r.id
FROM (VALUES ('procurement', 'PROC_TEAM'), ('gecol', 'GECOL_TEAM'), ('hlc', 'HLC_TEAM')) AS v(k, rc)
JOIN matrix_cells c ON c.register_key = v.k AND c.level = 1 AND c.region_id IS NULL
JOIN roles r ON r.code = v.rc
WHERE NOT EXISTS (SELECT 1 FROM matrix_cell_assignees a WHERE a.cell_id = c.id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Resolvers (the same questions as wf_*: who holds a level, where does the record land after a completion)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_module(p_key text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = p_key
$$;

-- Is the user active and able to see records of this region in the module (any assignment, or a System Admin)? NULL region = global row (Q69).
CREATE OR REPLACE FUNCTION reg_user_in_scope(p_user uuid, p_region int, p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass)
     AND (public.app_user_is_system_admin(p_user)
          OR EXISTS (SELECT 1 FROM public.user_role_assignments ua
                     WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                       AND (p_region IS NULL OR ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
                       AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = p_module))))
$$;

-- The matrix cell of a register row for a region (region cell > global cell).
CREATE OR REPLACE FUNCTION reg_cell_row(p_key text, p_region int, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id FROM public.matrix_cells c
  WHERE c.register_key = p_key AND c.level = CASE p_kind WHEN 'entry' THEN 1 WHEN 'review' THEN 2 ELSE 3 END
    AND (c.region_id IS NULL OR c.region_id = p_region)
  ORDER BY (c.region_id IS NOT NULL)::int DESC, c.id
  LIMIT 1
$$;

-- The live number of levels: the source task's (its own setting, else its stage's) or the register row's. Final from the first submission (B7).
CREATE OR REPLACE FUNCTION reg_levels_live(p_record uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.task_id IS NOT NULL THEN public.wf_levels_live(r.task_id)
              ELSE (SELECT least(greatest(d.approval_levels, 1), 3) FROM public.register_definitions d WHERE d.register_key = r.register_key) END
  FROM public.register_records r WHERE r.id = p_record
$$;

CREATE OR REPLACE FUNCTION reg_levels(p_record uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.path_frozen_at IS NULL THEN public.reg_levels_live(r.id) ELSE r.levels_required END FROM public.register_records r WHERE r.id = p_record
$$;

-- The cell that decides a level of a record. Entry: always the register's own row (Q56 ownership). Review and approve: the source
-- task's cell when the record is the source of a task (Q43), else the register row.
CREATE OR REPLACE FUNCTION reg_cell(p_record uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_kind <> 'entry' AND r.task_id IS NOT NULL THEN public.wf_cell(r.task_id, p_kind)
              ELSE public.reg_cell_row(r.register_key, r.region_id, p_kind) END
  FROM public.register_records r WHERE r.id = p_record AND public.app_region_read(r.is_global, r.region_id)
$$;

CREATE OR REPLACE FUNCTION reg_rule(p_record uuid, p_kind text) RETURNS "MatrixRule"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_kind = 'entry' THEN 'any_one'::"MatrixRule"
              ELSE coalesce((SELECT c.rule FROM public.matrix_cells c WHERE c.id = public.reg_cell(p_record, p_kind)), 'any_one'::"MatrixRule") END
$$;

-- The people of a cell: users; roles through assignment rows with enough level that include the region and the module; active groups.
CREATE OR REPLACE FUNCTION reg_eligible_cell(p_cell uuid, p_region int, p_module text, p_need "PermissionLevel") RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH ex AS (
    SELECT a.ref_id AS uid, NULL::uuid AS gid
      FROM public.matrix_cell_assignees a WHERE a.cell_id = p_cell AND a.kind = 'user'
    UNION ALL
    SELECT ua.user_id, NULL::uuid
      FROM public.matrix_cell_assignees a
      JOIN public.roles r ON r.id = a.ref_id AND r.is_active AND r.can_hold_matrix_levels
      JOIN public.user_role_assignments ua ON ua.role_id = r.id
      WHERE a.cell_id = p_cell AND a.kind = 'role'
        AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
        AND ua.permission_level >= p_need
        AND (p_region IS NULL OR ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rr WHERE rr.assignment_id = ua.id AND rr.region_id = p_region))
        AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules mm WHERE mm.assignment_id = ua.id AND mm.module_key = p_module))
    UNION ALL
    SELECT gm.user_id, g.id
      FROM public.matrix_cell_assignees a
      JOIN public.groups g ON g.id = a.ref_id AND g.is_active
      JOIN public.group_members gm ON gm.group_id = g.id
      WHERE a.cell_id = p_cell AND a.kind = 'group'
  )
  SELECT ex.uid, (array_agg(ex.gid) FILTER (WHERE ex.gid IS NOT NULL))[1]
  FROM ex
  WHERE public.reg_user_in_scope(ex.uid, p_region, p_module)
  GROUP BY ex.uid
$$;

CREATE OR REPLACE FUNCTION reg_eligible(p_record uuid, p_kind text) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; cell uuid; m text;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT FOUND OR NOT public.app_region_read(r.is_global, r.region_id) THEN RETURN; END IF;
  cell := public.reg_cell(p_record, p_kind);
  IF cell IS NULL THEN RETURN; END IF;
  -- the task's cells are held through the module `sites` (as for every task); the register row through the register's module
  m := CASE WHEN p_kind <> 'entry' AND r.task_id IS NOT NULL THEN 'sites' ELSE public.reg_module(r.register_key) END;
  RETURN QUERY SELECT * FROM public.reg_eligible_cell(cell, r.region_id, m, p_kind::public."PermissionLevel");
END $$;

CREATE OR REPLACE FUNCTION reg_is_eligible(p_record uuid, p_kind text, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.reg_eligible(p_record, p_kind) e WHERE e.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION reg_has_holder(p_record uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.reg_eligible(p_record, p_kind))
$$;

-- May this person start a new record in the register for a site of this region? (the entry holders of the register row)
CREATE OR REPLACE FUNCTION reg_entry_holders(p_key text, p_region int) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.user_id, e.via_group FROM public.reg_eligible_cell(public.reg_cell_row(p_key, p_region, 'entry'), p_region, public.reg_module(p_key), 'entry') e
  WHERE public.app_region_read(p_region IS NULL, p_region)   -- nobody learns the holders of a region they cannot see
$$;

-- Where the record lands when `p_actor` completes level p_from (see wf_chain): next level, skipped levels, and whether it reaches the final level (B5).
CREATE OR REPLACE FUNCTION reg_chain(p_record uuid, p_from int, p_actor uuid) RETURNS TABLE (next_level int, skipped int[], is_final boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int := public.reg_levels(p_record); lvl int := p_from; sk int[] := ARRAY[]::int[]; nxt int; k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.register_records r WHERE r.id = p_record AND public.app_region_read(r.is_global, r.region_id)) THEN RETURN; END IF;
  LOOP
    IF lvl >= n THEN RETURN QUERY SELECT NULL::int, sk, true; RETURN; END IF;
    nxt := lvl + 1;
    k := public.wf_kind(n, nxt);
    IF public.reg_rule(p_record, k) = 'any_one' AND public.reg_is_eligible(p_record, k, p_actor) THEN
      sk := sk || nxt;
      lvl := nxt;
    ELSE
      RETURN QUERY SELECT nxt, sk, false;
      RETURN;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7b. Internals shared by the writes
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_snap(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('register', r.register_key, 'entity_id', r.entity_id, 'version_no', r.version_no, 'state', r.state, 'current_level', r.current_level,
    'levels_required', r.levels_required, 'path_frozen', r.path_frozen_at IS NOT NULL, 'pinned_to', r.ball_in_court_user_id, 'task_id', r.task_id,
    'return_count', r.return_count, 'self_approval', r.self_approval, 'is_current', r.is_current, 'record_type', r.record_type,
    'external_party_id', r.external_party_id, 'data', r.data, 'custom', r.custom, 'version', r.version)
  FROM public.register_records r WHERE r.id = p_record
$$;

CREATE OR REPLACE FUNCTION reg_audit(p_action text, p_record uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'register_record', p_record::text, r.site_id, r.region_id, p_before, p_after, p_reason, public.app_actor());
END $$;

CREATE OR REPLACE FUNCTION reg_step(p_record uuid, p_level int, p_action text, p_actor uuid, p_note text, p_before text, p_after text, p_stepup boolean, p_self boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid;
BEGIN
  INSERT INTO public.register_steps (record_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, batch_row_id, created_at)
  VALUES (p_record, p_level, p_action, p_actor, p_note, p_before, p_after, coalesce(p_stepup, false), coalesce(p_self, false),
          (SELECT r.batch_row_id FROM public.register_records r WHERE r.id = p_record), clock_timestamp())
  RETURNING id INTO sid;
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION reg_label(p_record uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(s.site_code || ' / ', '') || d.name_en || ' v' || r.version_no
  FROM public.register_records r JOIN public.register_definitions d ON d.register_key = r.register_key LEFT JOIN public.sites s ON s.id = r.site_id WHERE r.id = p_record
$$;

CREATE OR REPLACE FUNCTION reg_notify(p_user uuid, p_kind text, p_title text, p_body text, p_record uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT p_user, 'in_app', p_kind, p_title, p_body, '/registers/' || r.register_key || '/records/' || r.id::text FROM public.register_records r WHERE r.id = p_record
$$;

CREATE OR REPLACE FUNCTION reg_notify_admins(p_kind text, p_title text, p_body text, p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
           JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND NOT x.is_break_glass LOOP
    PERFORM public.reg_notify(u, p_kind, p_title, p_body, p_record);
  END LOOP;
END $$;

-- Opens level p_level: state, current level, pin, round, voters; alerts the System Admins when nobody can act (B10).
CREATE OR REPLACE FUNCTION reg_open_level(p_record uuid, p_level int, p_pin uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; k text; st text; rl public."MatrixRule";
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  k := public.wf_kind(r.levels_required, p_level);
  st := CASE k WHEN 'entry' THEN 'entry' WHEN 'review' THEN 'in_review' ELSE 'in_approval' END;
  rl := public.reg_rule(p_record, k);
  UPDATE public.register_records SET state = st, current_level = p_level, level_round = level_round + 1, level_opened_at = now(),
    ball_in_court_user_id = CASE WHEN rl = 'any_one' THEN p_pin END, updated_at = now()
  WHERE id = p_record;
  IF rl = 'all_members' THEN
    INSERT INTO public.register_level_voters (record_id, level, round, user_id)
      SELECT p_record, p_level, r.level_round + 1, e.user_id FROM public.reg_eligible(p_record, k) e;
  END IF;
  IF NOT public.reg_has_holder(p_record, k) THEN
    PERFORM public.reg_notify_admins('no_eligible_holder', 'No holder for a register level', public.reg_label(p_record) || ': nobody can act on the ' || k || ' level.', p_record);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reg_lock(p_record uuid, p_version int) RETURNS public.register_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; regs int[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.register_records WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.')); END IF;
  regs := public.wf_actor_regions(public.reg_module(r.register_key), 'view');
  IF regs IS NOT NULL AND (cardinality(regs) = 0 OR (NOT r.is_global AND NOT (r.region_id = ANY (regs)))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.'));
  END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The record changed since you read it. Reload and try again.'));
  END IF;
  RETURN r;
END $$;

-- The grid right (create, edit, approve, view, delete) in the record's region, for the register's module.
CREATE OR REPLACE FUNCTION reg_require_grant(p_key text, p_region int, p_action "PermissionAction") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE regs int[] := public.wf_actor_regions(public.reg_module(p_key), p_action);
BEGIN
  IF regs IS NOT NULL AND (cardinality(regs) = 0 OR (p_region IS NOT NULL AND NOT (p_region = ANY (regs)))) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need ' || p_action::text || ' on ' || public.reg_module(p_key) || ' in this region.'));
  END IF;
END $$;

-- May the caller act on the level the record is at? 'holder', 'vote' (all_members) or 'admin' (nobody holds the level, B10).
CREATE OR REPLACE FUNCTION reg_require_actor(p_record uuid, p_kind text, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; rl public."MatrixRule"; is_admin boolean; has_holder boolean;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  rl := public.reg_rule(p_record, p_kind);
  is_admin := public.app_user_is_system_admin(p_actor);
  has_holder := public.reg_has_holder(p_record, p_kind);
  IF rl = 'all_members' THEN
    IF EXISTS (SELECT 1 FROM public.register_level_voters v WHERE v.record_id = p_record AND v.level = r.current_level AND v.round = r.level_round AND v.user_id = p_actor AND v.voted_at IS NULL) THEN
      RETURN 'vote';
    END IF;
    IF EXISTS (SELECT 1 FROM public.register_level_voters v WHERE v.record_id = p_record AND v.level = r.current_level AND v.round = r.level_round AND v.user_id = p_actor) THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'You have already voted on this level.'));
    END IF;
    IF is_admin AND NOT EXISTS (SELECT 1 FROM public.register_level_voters v WHERE v.record_id = p_record AND v.level = r.current_level AND v.round = r.level_round) THEN
      RETURN 'admin';
    END IF;
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF NOT (public.reg_is_eligible(p_record, p_kind, p_actor) OR (is_admin AND NOT has_holder)) THEN
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF r.ball_in_court_user_id IS NOT NULL AND r.ball_in_court_user_id <> p_actor AND public.reg_is_eligible(p_record, p_kind, r.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', r.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN public.reg_is_eligible(p_record, p_kind, p_actor) THEN 'holder' ELSE 'admin' END;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Validation: types and lists on every save, the register's own rules (V6, blocking) on submit
-- ---------------------------------------------------------------------------------------------------------------------
-- Checks a patch of `data` against register_fields and returns it cleaned (text trimmed, numbers and dates normalised, an explicit
-- null or empty text kept as null = clear). Raises validation_failed with one error per problem.
CREATE OR REPLACE FUNCTION reg_clean_data(p_key text, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  k text; v jsonb; f public.register_fields%ROWTYPE; out jsonb := '{}'::jsonb; errs jsonb := '[]'::jsonb; t text; d date; refused jsonb;
  opts jsonb;
BEGIN
  IF p_patch IS NULL THEN RETURN out; END IF;
  SELECT d.rules -> 'refused_scopes' INTO refused FROM public.register_definitions d WHERE d.register_key = p_key;
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
    IF jsonb_typeof(v) = 'null' OR (jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = '') THEN out := out || jsonb_build_object(k, NULL); CONTINUE; END IF;
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
      WHEN 'list' THEN
        IF jsonb_typeof(v) <> 'string' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A text from the list.'));
        ELSIF k = 'scope' AND refused IS NOT NULL AND jsonb_typeof(refused) = 'object' AND refused ? t THEN
          -- Q56 ownership: a purchase request of another team's register is refused with a pointer to its register (rule parameters are data)
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/scope', 'code', 'wrong_register',
            'message', 'Enter this request in the ' || (refused ->> t) || ' register (each team enters its own purchase requests, Q56).'));
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
    END CASE;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN out;
END $$;

-- Applies an explicit-null patch: keys whose value is null are removed.
CREATE OR REPLACE FUNCTION reg_merge_data(p_old jsonb, p_patch jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_strip_nulls(coalesce(p_old, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)) $$;

-- Did the site's scope flag (GECOL power AC, HLC fiber AD) say N/A? A row for such a site is refused (DQ07).
CREATE OR REPLACE FUNCTION reg_scope_ok(p_key text, p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE p_key WHEN 'gecol' THEN s.scope_gecol_power = 'yes' WHEN 'hlc' THEN s.scope_hlc_fiber = 'yes' ELSE true END
  FROM public.sites s WHERE s.id = p_site
$$;

CREATE OR REPLACE FUNCTION reg_err_item(p_path text, p_code text, p_msg text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_array(jsonb_build_object('path', p_path, 'code', p_code, 'message', p_msg)) $$;

-- The register's own rules, blocking at submit (spec section 3 "Validation", V4, V5, V6). Returns an array of field errors.
CREATE OR REPLACE FUNCTION reg_validate(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.register_records%ROWTYPE; errs jsonb := '[]'::jsonb; f record; dd jsonb; st text; ptype text; hx boolean; kind text;
  has_pr boolean; has_po boolean; pr date; po date; ti date; tx date; ifin date; req date;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  dd := r.data;
  -- V4: required fields (blank is never N/A)
  FOR f IN SELECT x.code, x.label_en FROM public.register_fields x WHERE x.register_key = r.register_key AND x.required AND x.is_active AND NOT x.derived LOOP
    IF NOT (dd ? f.code) OR jsonb_typeof(dd -> f.code) = 'null' THEN
      errs := errs || public.reg_err_item('/data/' || f.code, 'required', f.label_en || ' is required.');
    END IF;
  END LOOP;
  IF r.site_id IS NOT NULL AND NOT public.reg_scope_ok(r.register_key, r.site_id) THEN
    errs := errs || public.reg_err_item('/site_id', 'scope_conflict', 'The site scope says N/A for this register (DQ07).');
  END IF;

  IF r.register_key = 'procurement' THEN
    has_pr := coalesce(dd ->> 'pr_no', dd ->> 'pr_date') IS NOT NULL;
    has_po := coalesce(dd ->> 'po_wo_no', dd ->> 'po_wo_date') IS NOT NULL;
    IF dd ->> 'delivery' = 'In-House' AND has_pr THEN errs := errs || public.reg_err_item('/data/pr_no', 'in_house_with_pr', 'An in-house order has no PR.'); END IF;
    IF dd ->> 'delivery' = 'Outsourced' AND has_po AND NOT has_pr THEN errs := errs || public.reg_err_item('/data/pr_no', 'po_without_pr', 'An outsourced PO needs a PR.'); END IF;
    pr := (dd ->> 'pr_date')::date; po := (dd ->> 'po_wo_date')::date;
    IF pr IS NOT NULL AND po IS NOT NULL AND po < pr THEN errs := errs || public.reg_err_item('/data/po_wo_date', 'po_before_pr', 'The PO / WO date is before the PR date.'); END IF;
    IF dd ->> 'scope' = 'TE Installation' AND (has_pr OR has_po) THEN errs := errs || public.reg_err_item('/data/scope', 'no_pr_po', 'TE Installation has no PR, PO or WO.'); END IF;
    IF dd ? 'team_id' AND r.external_party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.external_teams t WHERE t.id = (dd ->> 'team_id')::uuid AND t.party_id = r.external_party_id) THEN
      errs := errs || public.reg_err_item('/data/team_id', 'team_of_other_contractor', 'The team belongs to another contractor.');
    END IF;
  ELSIF r.register_key = 'gecol' THEN
    ifin := (dd ->> 'installation_finish')::date; req := (dd ->> 'request_date')::date;
    IF ifin IS NOT NULL AND req IS NOT NULL AND ifin < req THEN errs := errs || public.reg_err_item('/data/installation_finish', 'negative_duration', 'The installation finish is before the request date (DQ10).'); END IF;
  ELSIF r.register_key = 'hlc' THEN
    ti := (dd ->> 'installation_date')::date; tx := (dd ->> 'tx_link_tested_date')::date;
    IF ti IS NOT NULL AND tx IS NOT NULL AND tx < ti THEN errs := errs || public.reg_err_item('/data/tx_link_tested_date', 'before_installation', 'The TX link test is before the installation date.'); END IF;
  ELSIF r.register_key = 'permits_hse' THEN
    st := lower(coalesce(dd ->> 'status', ''));
    ptype := dd ->> 'permit_type';
    hx := coalesce((dd ->> 'has_expiry')::boolean, (SELECT t.has_expiry FROM public.permit_types t WHERE t.code = ptype));
    kind := (SELECT t.kind FROM public.permit_types t WHERE t.code = ptype);
    IF st = 'n/a' AND btrim(coalesce(dd ->> 'na_reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/na_reason', 'required', 'N/A needs a reason (V5, D36).'); END IF;
    IF st <> 'n/a' AND dd ? 'na_reason' THEN errs := errs || public.reg_err_item('/data/na_reason', 'not_applicable', 'An N/A reason belongs to status N/A only.'); END IF;
    IF st = 'approved' AND NOT (dd ? 'valid_from') THEN errs := errs || public.reg_err_item('/data/valid_from', 'required', 'An approved permit needs Valid From.'); END IF;
    IF st = 'approved' AND hx IS TRUE AND NOT (dd ? 'valid_to') THEN errs := errs || public.reg_err_item('/data/valid_to', 'required', 'This permit has an expiry date: Valid To is required.'); END IF;
    IF hx IS FALSE AND dd ? 'valid_to' THEN errs := errs || public.reg_err_item('/data/valid_to', 'permanent', 'A permit without an expiry date has no Valid To (Q63c).'); END IF;
    IF dd ? 'valid_from' AND dd ? 'valid_to' AND (dd ->> 'valid_to')::date < (dd ->> 'valid_from')::date THEN errs := errs || public.reg_err_item('/data/valid_to', 'before_valid_from', 'Valid To is before Valid From.'); END IF;
    IF kind IS DISTINCT FROM 'ptw' THEN
      FOR f IN SELECT k FROM unnest(ARRAY['jsa_tra', 'toolbox_talk', 'work_at_height', 'lifting_plan', 'loto', 'rescue_plan', 'stop_work', 'stop_lifted_date']) k LOOP
        IF dd ? f.k THEN errs := errs || public.reg_err_item('/data/' || f.k, 'ptw_only', 'This field belongs to the PTW types only.'); END IF;
      END LOOP;
    END IF;
    IF dd ? 'stop_lifted_date' AND coalesce((dd ->> 'stop_work')::boolean, false) IS FALSE THEN
      errs := errs || public.reg_err_item('/data/stop_lifted_date', 'no_stop_work', 'A lift date needs Stop Work = Yes.');
    END IF;
  END IF;
  RETURN errs;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Projection into the typed tables (on final approval) and the task a record is the source of (Q43)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_apply(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb; hse jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  IF r.register_key = 'procurement' THEN
    INSERT INTO public.procurement_records (id, site_id, region_id, scope, delivery, pr_no, pr_date, po_wo_no, po_wo_date, party_id, team_id, order_status, remark, custom, register_record_id, record_version)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'scope', d ->> 'delivery', d ->> 'pr_no', (d ->> 'pr_date')::date, d ->> 'po_wo_no', (d ->> 'po_wo_date')::date,
            r.external_party_id, (d ->> 'team_id')::uuid, d ->> 'order_status', d ->> 'remark', r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET scope = EXCLUDED.scope, delivery = EXCLUDED.delivery, pr_no = EXCLUDED.pr_no, pr_date = EXCLUDED.pr_date, po_wo_no = EXCLUDED.po_wo_no,
      po_wo_date = EXCLUDED.po_wo_date, party_id = EXCLUDED.party_id, team_id = EXCLUDED.team_id, order_status = EXCLUDED.order_status, remark = EXCLUDED.remark,
      custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  ELSIF r.register_key = 'gecol' THEN
    INSERT INTO public.gecol_records (id, site_id, region_id, pr_no, contractor, request_date, survey_date, layout_received, layout_approved, notice_date, mos_date, installation_finish,
      aat_acceptance_date, docs_approval_date, meter_no, power_on_date, billing_conversion_date, remark, custom, register_record_id, record_version)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'pr_no', d ->> 'contractor', (d ->> 'request_date')::date, (d ->> 'survey_date')::date, (d ->> 'layout_received')::date,
            (d ->> 'layout_approved')::date, (d ->> 'notice_date')::date, (d ->> 'mos_date')::date, (d ->> 'installation_finish')::date, (d ->> 'aat_acceptance_date')::date,
            (d ->> 'docs_approval_date')::date, d ->> 'meter_no', (d ->> 'power_on_date')::date, (d ->> 'billing_conversion_date')::date, d ->> 'remark', r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET pr_no = EXCLUDED.pr_no, contractor = EXCLUDED.contractor, request_date = EXCLUDED.request_date, survey_date = EXCLUDED.survey_date,
      layout_received = EXCLUDED.layout_received, layout_approved = EXCLUDED.layout_approved, notice_date = EXCLUDED.notice_date, mos_date = EXCLUDED.mos_date,
      installation_finish = EXCLUDED.installation_finish, aat_acceptance_date = EXCLUDED.aat_acceptance_date, docs_approval_date = EXCLUDED.docs_approval_date,
      meter_no = EXCLUDED.meter_no, power_on_date = EXCLUDED.power_on_date, billing_conversion_date = EXCLUDED.billing_conversion_date, remark = EXCLUDED.remark,
      custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  ELSIF r.register_key = 'hlc' THEN
    INSERT INTO public.hlc_records (id, site_id, region_id, request_no, request_date, fiber_uplink, fiber_status, internal_fiber_team, installation_date, tx_link_tested_date, remark, custom,
      register_record_id, record_version)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'request_no', (d ->> 'request_date')::date, d ->> 'fiber_uplink', d ->> 'fiber_status', d ->> 'internal_fiber_team',
            (d ->> 'installation_date')::date, (d ->> 'tx_link_tested_date')::date, d ->> 'remark', r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET request_no = EXCLUDED.request_no, request_date = EXCLUDED.request_date, fiber_uplink = EXCLUDED.fiber_uplink, fiber_status = EXCLUDED.fiber_status,
      internal_fiber_team = EXCLUDED.internal_fiber_team, installation_date = EXCLUDED.installation_date, tx_link_tested_date = EXCLUDED.tx_link_tested_date,
      remark = EXCLUDED.remark, custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  ELSIF r.register_key = 'permits_hse' THEN
    hse := jsonb_strip_nulls(jsonb_build_object('jsa_tra', d -> 'jsa_tra', 'toolbox_talk', d -> 'toolbox_talk', 'work_at_height', d -> 'work_at_height',
                                                'lifting_plan', d -> 'lifting_plan', 'loto', d -> 'loto', 'rescue_plan', d -> 'rescue_plan'));
    INSERT INTO public.permit_records (id, site_id, region_id, permit_type, applied_date, status, valid_from, valid_to, has_expiry, na_reason, na_approved_by, hse_checks,
      stop_work, stop_lifted_date, remark, custom, register_record_id, record_version)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'permit_type', (d ->> 'applied_date')::date, d ->> 'status', (d ->> 'valid_from')::date, (d ->> 'valid_to')::date,
            (d ->> 'has_expiry')::boolean, d ->> 'na_reason', d ->> 'na_approved_by', CASE WHEN hse = '{}'::jsonb THEN NULL ELSE hse END,
            coalesce((d ->> 'stop_work')::boolean, false), (d ->> 'stop_lifted_date')::date, d ->> 'remark', r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET permit_type = EXCLUDED.permit_type, applied_date = EXCLUDED.applied_date, status = EXCLUDED.status, valid_from = EXCLUDED.valid_from,
      valid_to = EXCLUDED.valid_to, has_expiry = EXCLUDED.has_expiry, na_reason = EXCLUDED.na_reason, na_approved_by = EXCLUDED.na_approved_by, hse_checks = EXCLUDED.hse_checks,
      stop_work = EXCLUDED.stop_work, stop_lifted_date = EXCLUDED.stop_lifted_date, remark = EXCLUDED.remark, custom = EXCLUDED.custom,
      register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  END IF;
  -- a registers without a typed table yet keeps its approved data in register_records only
END $$;

-- Does the record match a task source row (the data conditions and the date field)?
CREATE OR REPLACE FUNCTION reg_source_matches(p_record uuid, p_task_code text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; s public.register_task_sources%ROWTYPE; k text; v jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  SELECT * INTO s FROM public.register_task_sources x WHERE x.register_key = r.register_key AND x.task_code = p_task_code AND x.is_active;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT (r.data ? s.date_field) THEN RETURN false; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(s.data_eq) LOOP
    IF lower(coalesce(r.data ->> k, '')) <> lower(v #>> '{}') THEN RETURN false; END IF;
  END LOOP;
  FOR k, v IN SELECT * FROM jsonb_each(s.data_in) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v) e WHERE e = r.data ->> k) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- At the first submission: the task this record is the source of, or NULL (Q43). The first matching task that is still open and has
-- no other record in review is taken; a matching task that is still locked refuses the submission (the gate is not open yet).
CREATE OR REPLACE FUNCTION reg_link_task(p_record uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; src record; t public.task_instances%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.site_id IS NULL THEN RETURN NULL; END IF;
  FOR src IN SELECT x.task_code FROM public.register_task_sources x WHERE x.register_key = r.register_key AND x.is_active ORDER BY x.sort_order, x.task_code LOOP
    IF NOT public.reg_source_matches(p_record, src.task_code) THEN CONTINUE; END IF;
    SELECT ti.* INTO t FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.sites s ON s.id = ti.site_id AND s.workflow_version_id = td.workflow_id
      WHERE ti.site_id = r.site_id AND td.code = src.task_code
      LIMIT 1;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF t.state IN ('approved', 'na', 'skipped') OR t.is_na THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = t.id AND o.id <> p_record AND o.state IN ('in_review', 'in_approval')) THEN CONTINUE; END IF;
    IF t.state NOT IN ('open', 'entry') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is the source of task ' || src.task_code || ', which is ' || t.state::text
        || ': it cannot be submitted until the task is open.'));
    END IF;
    RETURN t.id;
  END LOOP;
  RETURN NULL;
END $$;

-- Final approval of a task-source record: the task takes the record's date and is approved with it, one approval for both (Q43).
-- Documents of the task are approved with it; the successors unlock. A task that was closed some other way meanwhile is left alone.
CREATE OR REPLACE FUNCTION reg_complete_task(p_record uuid, p_actor uuid, p_stepup boolean, p_self boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; t public.task_instances%ROWTYPE; s public.register_task_sources%ROWTYPE; td_code text; d date; before jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.task_id IS NULL THEN RETURN ARRAY[]::uuid[]; END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = r.task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN ARRAY[]::uuid[]; END IF;
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.reg_audit('register_record_task_not_open', p_record, NULL, jsonb_build_object('task_id', t.id, 'task_state', t.state), 'the task is no longer open: left unchanged');
    RETURN ARRAY[]::uuid[];
  END IF;
  SELECT td.code INTO td_code FROM public.task_definitions td WHERE td.id = t.task_def_id;
  SELECT * INTO s FROM public.register_task_sources x WHERE x.register_key = r.register_key AND x.task_code = td_code;
  d := (r.data ->> s.date_field)::date;
  before := public.wf_snap(t.id);
  UPDATE public.task_instances SET actual_date = d, state = 'approved', current_level = r.levels_required, levels_required = r.levels_required,
    path_frozen_at = coalesce(path_frozen_at, now()), submitted_date = coalesce(r.submitted_at::date, current_date), approved_date = current_date,
    ball_in_court_user_id = NULL, level_opened_at = NULL, self_approval = p_self, version = version + 1, updated_at = now()
  WHERE id = t.id;
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = t.id AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots sl
    WHERE sl.task_id = t.id AND f.slot_id = sl.id AND f.is_current AND f.approved_date IS NULL;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
  VALUES (t.id, r.levels_required, 'approve', p_actor, 'approved with the register record ' || r.register_key || ' ' || r.id::text, t.state, 'approved', coalesce(p_stepup, false), coalesce(p_self, false), clock_timestamp());
  PERFORM public.wf_audit('task_approve', t.id, before, public.wf_snap(t.id) || jsonb_build_object('via_register_record', r.id, 'register', r.register_key), 'approved with a register record (Q43)');
  RETURN public.wf_unlock_successors(t.id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Writes and transitions
-- ---------------------------------------------------------------------------------------------------------------------
-- Create (p_id NULL) or edit a record in state `entry`. A patch: keys present are applied, an explicit null clears.
CREATE OR REPLACE FUNCTION reg_save_record(p_key text, p_id uuid, p_version int, p_site uuid, p_record_type text, p_data jsonb, p_custom jsonb, p_party uuid, p_clear_party boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.register_definitions%ROWTYPE; s public.sites%ROWTYPE; r public.register_records%ROWTYPE; rid uuid; before jsonb;
  clean jsonb; cnt int; pin uuid; ent uuid; existing uuid; regs int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register is not available.')); END IF;
  IF p_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.external_parties x WHERE x.id = p_party AND x.is_active) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/external_party_id', 'unknown_party', 'Unknown or inactive external party.')));
  END IF;
  IF p_record_type IS NOT NULL AND NOT (p_record_type = ANY (d.record_types)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a record type of this register.')));
  END IF;

  IF p_id IS NULL THEN
    -- create
    IF d.site_scoped THEN
      IF p_site IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'required', 'The site is required.'))); END IF;
      SELECT * INTO s FROM public.sites WHERE id = p_site AND public.app_region_check(region_id);
      IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
      regs := public.wf_actor_regions(d.module_key, 'view');
      IF regs IS NOT NULL AND NOT (s.region_id = ANY (regs)) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
      PERFORM public.reg_require_grant(p_key, s.region_id, 'create');
      IF NOT public.reg_scope_ok(p_key, s.id) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'scope_conflict', 'The site scope says N/A for this register (DQ07).')));
      END IF;
      IF NOT d.multiple_per_site THEN
        SELECT x.id INTO existing FROM public.register_records x WHERE x.register_key = p_key AND x.site_id = s.id AND x.version_no = 1 AND x.state <> 'voided';
        IF existing IS NOT NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('existing_id', existing, 'detail', 'This site already has a ' || d.name_en || ' record: create a new version of it (Q55).')); END IF;
      END IF;
    ELSE
      IF p_site IS NOT NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'not_site_scoped', 'This register has no site.'))); END IF;
      PERFORM public.reg_require_grant(p_key, NULL, 'create');
    END IF;
    -- Q56 ownership: the entry holders of the register's own row (the System Admins when the row has nobody, B10)
    IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id) h WHERE h.user_id = actor)
            OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id)))) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder of the ' || d.name_en || ' row of the Matrix.'));
    END IF;
    clean := public.reg_clean_data(p_key, p_data);
    ent := gen_random_uuid();
    SELECT count(*) INTO cnt FROM public.reg_entry_holders(p_key, s.region_id);
    INSERT INTO public.register_records (entity_id, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, external_party_id, ball_in_court_user_id, created_by, level_opened_at)
    VALUES (ent, p_key, p_record_type, s.id, s.region_id, NOT d.site_scoped, d.approval_levels, public.reg_merge_data('{}'::jsonb, clean), coalesce(p_custom, '{}'::jsonb), p_party,
            CASE WHEN cnt > 1 THEN actor END, actor, now())
    RETURNING id INTO rid;
    PERFORM public.reg_step(rid, 1, 'create', actor, NULL, NULL, 'entry', false, false);
    PERFORM public.reg_audit('register_record_create', rid, NULL, public.reg_snap(rid), NULL);
    RETURN rid;
  END IF;

  -- edit
  r := public.reg_lock(p_id, p_version);
  IF r.register_key <> p_key THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.')); END IF;
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A record can be edited only while it is in entry (it is ' || r.state || '): create a new version to change an approved record.'));
  END IF;
  PERFORM public.reg_require_grant(p_key, r.region_id, 'edit');
  PERFORM public.reg_require_actor(p_id, 'entry', actor);
  clean := public.reg_clean_data(p_key, p_data);
  before := public.reg_snap(p_id);
  SELECT count(*) INTO cnt FROM public.reg_eligible(p_id, 'entry');
  pin := CASE WHEN r.ball_in_court_user_id IS NULL AND cnt > 1 THEN actor ELSE r.ball_in_court_user_id END;
  UPDATE public.register_records SET
    data = public.reg_merge_data(data, clean),
    custom = CASE WHEN p_custom IS NOT NULL THEN jsonb_strip_nulls(custom || p_custom) ELSE custom END,
    external_party_id = CASE WHEN p_clear_party THEN NULL WHEN p_party IS NOT NULL THEN p_party ELSE external_party_id END,
    ball_in_court_user_id = pin, version = version + 1, updated_at = now()
  WHERE id = p_id;
  PERFORM public.reg_step(p_id, 1, 'edit', actor, NULL, 'entry', 'entry', false, false);
  PERFORM public.reg_audit('register_record_update', p_id, before, public.reg_snap(p_id), NULL);
  RETURN p_id;
END $$;

-- A new version of an approved record (GECOL and HLC: a new request, Q55; a correction of any register, R9 / RE-03). The approved version
-- stays in force until the new one is approved. The data is copied, the derived values (Q45) are not.
CREATE OR REPLACE FUNCTION reg_new_version(p_record uuid, p_version int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; rid uuid; d public.register_definitions%ROWTYPE; cnt int; derived text[];
BEGIN
  r := public.reg_lock(p_record, p_version);
  SELECT * INTO d FROM public.register_definitions WHERE register_key = r.register_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register is not available.')); END IF;
  IF r.state <> 'approved' OR NOT r.is_current THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A new version is made from the approved version that is in force.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = r.entity_id AND o.state IN ('entry', 'in_review', 'in_approval')) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'An open version of this record exists already.'));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'edit');
  IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(r.register_key, r.region_id) h WHERE h.user_id = actor)
          OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(r.register_key, r.region_id)))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder of the ' || d.name_en || ' row of the Matrix.'));
  END IF;
  SELECT coalesce(array_agg(f.code), ARRAY[]::text[]) INTO derived FROM public.register_fields f WHERE f.register_key = r.register_key AND f.derived;
  SELECT count(*) INTO cnt FROM public.reg_entry_holders(r.register_key, r.region_id);
  INSERT INTO public.register_records (entity_id, version_no, supersedes_id, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, external_party_id,
    ball_in_court_user_id, created_by, level_opened_at)
  VALUES (r.entity_id, (SELECT max(o.version_no) + 1 FROM public.register_records o WHERE o.entity_id = r.entity_id), r.id, r.register_key, r.record_type, r.site_id, r.region_id, r.is_global,
    d.approval_levels, r.data - derived, r.custom, r.external_party_id, CASE WHEN cnt > 1 THEN actor END, actor, now())
  RETURNING id INTO rid;
  PERFORM public.reg_step(rid, 1, 'new_version', actor, NULL, NULL, 'entry', false, false);
  PERFORM public.reg_audit('register_record_new_version', rid, public.reg_snap(p_record), public.reg_snap(rid), NULL);
  RETURN rid;
END $$;

-- Submit (level 1), pass a review level, or give the final approval (see wf_complete). Returns the steps, skipped levels and unlocked tasks.
CREATE OR REPLACE FUNCTION reg_complete(p_record uuid, p_version int, p_action text, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); r public.register_records%ROWTYPE; n int; lvl int; k text; mode text; ch record; before jsonb; step_ids uuid[] := ARRAY[]::uuid[];
  sk int; self boolean; after_state text; v_left int; sid uuid; first boolean; errs jsonb; missing_s text[]; tid uuid; unlocked uuid[] := ARRAY[]::uuid[]; aname text; h record;
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.register_key AND d.is_active AND d.enabled) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register is not available.'));
  END IF;
  IF (p_action = 'submit' AND r.state <> 'entry') OR (p_action = 'review' AND r.state <> 'in_review') OR (p_action = 'approve' AND r.state <> 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The record is ' || r.state || ': ' || p_action || ' is not possible now.'));
  END IF;
  before := public.reg_snap(p_record);
  first := r.path_frozen_at IS NULL;
  lvl := r.current_level;
  IF p_action = 'submit' THEN
    k := 'entry';
  ELSE
    n := public.reg_levels(p_record);
    k := public.wf_kind(n, lvl);
    IF p_action = 'review' AND k <> 'review' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The record is at the approve level.')); END IF;
    IF p_action = 'approve' AND k <> 'approve' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The record is not at the approve level.')); END IF;
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, CASE k WHEN 'entry' THEN 'edit' WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  mode := public.reg_require_actor(p_record, k, actor);

  IF p_action = 'submit' THEN
    errs := public.reg_validate(p_record);
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
    IF first THEN
      tid := public.reg_link_task(p_record);                                   -- Q43
      UPDATE public.register_records SET task_id = tid WHERE id = p_record;
      UPDATE public.register_records SET levels_required = public.reg_levels_live(p_record), path_frozen_at = now() WHERE id = p_record;   -- B7
    END IF;
    SELECT * INTO r FROM public.register_records WHERE id = p_record;
    IF r.task_id IS NOT NULL THEN
      missing_s := public.wf_missing_slots(r.task_id);
      IF cardinality(missing_s) > 0 THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(missing_s))); END IF;
    END IF;
  END IF;
  n := public.reg_levels(p_record);

  -- all_members: record the vote; the level completes with the last vote
  IF mode = 'vote' THEN
    UPDATE public.register_level_voters SET voted_at = now() WHERE record_id = p_record AND level = lvl AND round = r.level_round AND user_id = actor;
    SELECT count(*) INTO v_left FROM public.register_level_voters WHERE record_id = p_record AND level = lvl AND round = r.level_round AND voted_at IS NULL;
    IF v_left > 0 THEN
      sid := public.reg_step(p_record, lvl, p_action, actor, p_note, r.state, r.state, false, false);
      UPDATE public.register_records SET version = version + 1, updated_at = now() WHERE id = p_record;
      PERFORM public.reg_audit('register_record_' || p_action || '_vote', p_record, before, public.reg_snap(p_record), p_note);
      RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb, 'votes_missing', v_left);
    END IF;
  END IF;

  SELECT * INTO ch FROM public.reg_chain(p_record, lvl, actor);
  IF ch.is_final THEN
    IF k <> 'approve' THEN PERFORM public.reg_require_grant(r.register_key, r.region_id, 'approve'); END IF;
    IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- B5 and the final approval
  END IF;

  self := ch.is_final AND (n = 1 OR n = ANY (ch.skipped));
  after_state := CASE WHEN ch.is_final THEN 'approved'
                      ELSE CASE public.wf_kind(n, ch.next_level) WHEN 'review' THEN 'in_review' WHEN 'approve' THEN 'in_approval' ELSE 'entry' END END;

  sid := public.reg_step(p_record, lvl, p_action, actor, p_note, r.state, after_state, coalesce(p_stepup, false) AND ch.is_final, self);
  step_ids := step_ids || sid;
  INSERT INTO public.register_level_actors (record_id, level, user_id, how) VALUES (p_record, lvl, actor, 'acted')
    ON CONFLICT (record_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  FOREACH sk IN ARRAY ch.skipped LOOP
    sid := public.reg_step(p_record, sk, 'auto_skip', actor, 'level skipped: same holder', r.state, after_state, false, self);
    step_ids := step_ids || sid;
    INSERT INTO public.register_level_actors (record_id, level, user_id, how) VALUES (p_record, sk, actor, 'skipped')
      ON CONFLICT (record_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'skipped', acted_at = now();
  END LOOP;

  IF p_action = 'submit' THEN
    UPDATE public.register_records SET submitted_at = now() WHERE id = p_record;
    IF r.task_id IS NOT NULL THEN
      UPDATE public.document_slots SET status = 'in_review', reject_reason = NULL WHERE task_id = r.task_id AND status = 'uploaded';
    END IF;
  END IF;

  IF ch.is_final THEN
    SELECT u.display_name INTO aname FROM public.users u WHERE u.id = actor;
    -- Q45: the approver and the approval date of the record come from this approval (the N/A approver of a permit is not typed)
    IF r.register_key = 'permits_hse' AND lower(coalesce(r.data ->> 'status', '')) = 'n/a' THEN
      UPDATE public.register_records SET data = data || jsonb_build_object('na_approved_by', aname) WHERE id = p_record;
    END IF;
    UPDATE public.register_records SET is_current = false WHERE entity_id = r.entity_id AND id <> p_record AND is_current;
    UPDATE public.register_records SET state = 'approved', current_level = n, approved_at = now(), approved_by = actor, is_current = true, ball_in_court_user_id = NULL,
      level_opened_at = NULL, self_approval = self WHERE id = p_record;
    PERFORM public.reg_apply(p_record);                                         -- the typed table first: the task's calculations read it
    unlocked := public.reg_complete_task(p_record, actor, coalesce(p_stepup, false), self);
  ELSE
    PERFORM public.reg_open_level(p_record, ch.next_level, NULL);
    FOR h IN SELECT e.user_id FROM public.reg_eligible(p_record, public.wf_kind(n, ch.next_level)) e WHERE e.user_id <> actor LIMIT 20 LOOP
      PERFORM public.reg_notify(h.user_id, 'register_assigned', 'A register record waits for you', public.reg_label(p_record), p_record);
    END LOOP;
  END IF;
  UPDATE public.register_records SET version = version + 1, updated_at = now() WHERE id = p_record;

  PERFORM public.reg_audit('register_record_' || p_action, p_record, before,
    public.reg_snap(p_record) || jsonb_build_object('skipped_levels', to_jsonb(ch.skipped), 'self_approval_flag', self), p_note);
  FOREACH sk IN ARRAY ch.skipped LOOP
    PERFORM public.reg_audit('register_record_auto_skip', p_record, jsonb_build_object('level', sk, 'holder', actor),
      jsonb_build_object('level', sk, 'skipped', true, 'reason', 'same holder', 'self_approval', self), 'level skipped: same holder');
  END LOOP;

  RETURN jsonb_build_object('step_ids', to_jsonb(step_ids), 'skipped_levels', to_jsonb(ch.skipped), 'unlocked_task_ids', to_jsonb(unlocked));
END $$;

-- Reject one level back with a note (B6, B10).
CREATE OR REPLACE FUNCTION reg_reject(p_record uuid, p_version int, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); r public.register_records%ROWTYPE; n int; lvl int; k text; tgt int; pin uuid; how text; before jsonb; sid uuid; h record;
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF coalesce(btrim(p_note), '') = '' THEN PERFORM public.wf_err('note_required'); END IF;
  IF r.state NOT IN ('in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a record in review or approval can be rejected.'));
  END IF;
  before := public.reg_snap(p_record);
  n := public.reg_levels(p_record);
  lvl := r.current_level;
  k := public.wf_kind(n, lvl);
  PERFORM public.reg_require_grant(r.register_key, r.region_id, CASE k WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  PERFORM public.reg_require_actor(p_record, k, actor);

  tgt := lvl - 1;
  SELECT a.how, a.user_id INTO how, pin FROM public.register_level_actors a WHERE a.record_id = p_record AND a.level = tgt;
  IF how = 'skipped' THEN
    SELECT a.level, a.user_id INTO tgt, pin FROM public.register_level_actors a WHERE a.record_id = p_record AND a.level < lvl AND a.how = 'acted' ORDER BY a.level DESC LIMIT 1;
    IF NOT FOUND THEN tgt := 1; pin := NULL; END IF;
  END IF;
  IF pin IS NOT NULL AND NOT public.reg_is_eligible(p_record, public.wf_kind(n, tgt), pin) THEN pin := NULL; END IF;
  DELETE FROM public.register_level_actors WHERE record_id = p_record AND level >= tgt;
  IF r.task_id IS NOT NULL THEN
    UPDATE public.document_slots SET status = 'uploaded' WHERE task_id = r.task_id AND status = 'in_review';
  END IF;

  PERFORM public.reg_open_level(p_record, tgt, pin);
  UPDATE public.register_records SET return_count = return_count + 1, last_return_note = p_note, version = version + 1, updated_at = now() WHERE id = p_record;
  sid := public.reg_step(p_record, lvl, 'reject', actor, p_note, r.state, (SELECT state FROM public.register_records WHERE id = p_record), false, false);
  PERFORM public.reg_audit('register_record_reject', p_record, before, public.reg_snap(p_record) || jsonb_build_object('returned_to_level', tgt), p_note);

  IF pin IS NOT NULL THEN
    PERFORM public.reg_notify(pin, 'register_rejected', 'A register record was returned to you', public.reg_label(p_record) || ': ' || p_note, p_record);
  ELSE
    FOR h IN SELECT e.user_id FROM public.reg_eligible(p_record, public.wf_kind(n, tgt)) e LIMIT 20 LOOP
      PERFORM public.reg_notify(h.user_id, 'register_rejected', 'A register record was returned', public.reg_label(p_record) || ': ' || p_note, p_record);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb, 'returned_to_level', tgt);
END $$;

-- submit / review / approve / reject through one door (contract x-db-path reg_transition_record)
CREATE OR REPLACE FUNCTION reg_transition_record(p_record uuid, p_version int, p_action text, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_action = 'reject' THEN RETURN public.reg_reject(p_record, p_version, p_note); END IF;
  IF p_action NOT IN ('submit', 'review', 'approve') THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Unknown action.')); END IF;
  RETURN public.reg_complete(p_record, p_version, p_action, p_note, p_stepup);
END $$;

-- Claim a group level (any one member) and release it again.
CREATE OR REPLACE FUNCTION reg_claim_record(p_record uuid, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb; sid uuid; k text; n int;
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF r.state NOT IN ('entry', 'in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A record that is ' || r.state || ' cannot be claimed.'));
  END IF;
  n := public.reg_levels(p_record);
  k := public.wf_kind(n, greatest(r.current_level, 1));
  IF public.reg_rule(p_record, k) = 'all_members' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This level needs every member to vote; there is nothing to claim.'));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, CASE k WHEN 'entry' THEN 'edit' WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  IF r.ball_in_court_user_id = actor THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'You already hold this record.')); END IF;
  PERFORM public.reg_require_actor(p_record, k, actor);
  before := public.reg_snap(p_record);
  UPDATE public.register_records SET ball_in_court_user_id = actor, version = version + 1, updated_at = now() WHERE id = p_record;
  sid := public.reg_step(p_record, greatest(r.current_level, 1), 'claim', actor, NULL, r.state, r.state, false, false);
  PERFORM public.reg_audit('register_record_claim', p_record, before, public.reg_snap(p_record), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION reg_release_record(p_record uuid, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb; sid uuid;
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF r.ball_in_court_user_id IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nobody holds a claim on this record.')); END IF;
  IF r.ball_in_court_user_id <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who holds the claim can release it.'));
  END IF;
  before := public.reg_snap(p_record);
  UPDATE public.register_records SET ball_in_court_user_id = NULL, version = version + 1, updated_at = now() WHERE id = p_record;
  sid := public.reg_step(p_record, greatest(r.current_level, 1), 'release', actor, NULL, r.state, r.state, false, false);
  PERFORM public.reg_audit('register_record_release', p_record, before, public.reg_snap(p_record), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

-- Void a record that is not approved yet (never hard-deleted). An approved version is corrected by a new version.
CREATE OR REPLACE FUNCTION reg_void_record(p_record uuid, p_version int, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb;
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF coalesce(btrim(p_reason), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason is required.')));
  END IF;
  IF r.state NOT IN ('entry', 'in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a record that is not approved yet can be voided (it is ' || r.state || ').'));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'delete');
  before := public.reg_snap(p_record);
  UPDATE public.register_records SET state = 'voided', voided_at = now(), voided_by = actor, void_reason = p_reason, ball_in_court_user_id = NULL, level_opened_at = NULL,
    version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.reg_step(p_record, r.current_level, 'void', actor, p_reason, r.state, 'voided', false, false);
  PERFORM public.reg_audit('register_record_void', p_record, before, public.reg_snap(p_record), p_reason);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Purchase requests (Q56): the PRs of the three registers in one view. A GECOL or HLC request counts as a purchase request.
--     Invoker rights: the region filter of each table applies.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE VIEW v_purchase_requests WITH (security_invoker = true) AS
  SELECT 'procurement'::text AS register_key, p.id AS record_id, p.site_id, p.region_id, p.scope, p.pr_no AS request_no, p.pr_date AS request_date
    FROM procurement_records p WHERE p.pr_no IS NOT NULL OR p.pr_date IS NOT NULL
  UNION ALL
  SELECT 'gecol', g.id, g.site_id, g.region_id, 'GECOL', g.pr_no, g.request_date FROM gecol_records g WHERE g.pr_no IS NOT NULL OR g.request_date IS NOT NULL
  UNION ALL
  SELECT 'hlc', h.id, h.site_id, h.region_id, 'HLC', h.request_no, h.request_date FROM hlc_records h WHERE h.request_no IS NOT NULL OR h.request_date IS NOT NULL;
COMMENT ON VIEW v_purchase_requests IS 'Q56: Procurement PRs, the GECOL request and the HLC request (each counts as a purchase request).';

-- ---------------------------------------------------------------------------------------------------------------------
-- 12. Ownership and execute rights. Everything is owned by pmis_definer and closed to PUBLIC; pmis_app gets the reads and the writers.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'reg_module(text)', 'reg_user_in_scope(uuid,int,text)', 'reg_cell_row(text,int,text)', 'reg_levels_live(uuid)', 'reg_levels(uuid)', 'reg_cell(uuid,text)', 'reg_rule(uuid,text)',
    'reg_eligible_cell(uuid,int,text,"PermissionLevel")', 'reg_eligible(uuid,text)', 'reg_is_eligible(uuid,text,uuid)', 'reg_has_holder(uuid,text)', 'reg_entry_holders(text,int)',
    'reg_chain(uuid,int,uuid)', 'reg_snap(uuid)', 'reg_audit(text,uuid,jsonb,jsonb,text)', 'reg_step(uuid,int,text,uuid,text,text,text,boolean,boolean)', 'reg_label(uuid)',
    'reg_notify(uuid,text,text,text,uuid)', 'reg_notify_admins(text,text,text,uuid)', 'reg_open_level(uuid,int,uuid)', 'reg_lock(uuid,int)', 'reg_require_grant(text,int,"PermissionAction")',
    'reg_require_actor(uuid,text,uuid)', 'reg_clean_data(text,jsonb)', 'reg_merge_data(jsonb,jsonb)', 'reg_scope_ok(text,uuid)', 'reg_err_item(text,text,text)', 'reg_validate(uuid)',
    'reg_apply(uuid)', 'reg_source_matches(uuid,text)', 'reg_link_task(uuid)', 'reg_complete_task(uuid,uuid,boolean,boolean)',
    'reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean)', 'reg_new_version(uuid,int)', 'reg_complete(uuid,int,text,text,boolean)', 'reg_reject(uuid,int,text)',
    'reg_transition_record(uuid,int,text,text,boolean)', 'reg_claim_record(uuid,int)', 'reg_release_record(uuid,int)', 'reg_void_record(uuid,int,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  ALTER FUNCTION reg_backstop() OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- what the API calls: the writers and the read helpers of the record view
    FOREACH f IN ARRAY ARRAY[
      'reg_module(text)', 'reg_levels(uuid)', 'reg_cell(uuid,text)', 'reg_rule(uuid,text)', 'reg_eligible(uuid,text)', 'reg_is_eligible(uuid,text,uuid)', 'reg_has_holder(uuid,text)',
      'reg_entry_holders(text,int)', 'reg_chain(uuid,int,uuid)', 'reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean)', 'reg_new_version(uuid,int)',
      'reg_transition_record(uuid,int,text,text,boolean)', 'reg_claim_record(uuid,int)', 'reg_release_record(uuid,int)', 'reg_void_record(uuid,int,text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    GRANT SELECT ON v_purchase_requests TO pmis_app;
  END IF;
END $$;
