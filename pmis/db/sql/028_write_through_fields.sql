-- 0029_write_through_fields: write-through editing from the work views (owner decision 2026-10-31, spec registers-and-streams.md 2.7; Q73, Q99).
-- Mirror: db/sql/028_write_through_fields.sql (kept identical).
--
--   * task_field_sources: which register field a task row of the work views shows and edits. The view keeps no copy: the task grid reads the value
--     from the current record of the source register and an edit goes to that record through the register's own functions, permissions and approval.
--     field_code is a register_fields code, or 'external_party_id' (the contractor of the record).
--   * BU and EF move to As-Built (Q68, Q99): two fields of the register, shown on B13 (CW PAC) and D15 (As-Built).
--   * FO and FT move to Dismantle (Q52, Q99): the contractor (external party) of the CW part and of the TE part, shown on E2.
--   Not projected: BU / EF are not computed from the approvals and the calculation layer does not read them yet (Q103, Q113).

CREATE TABLE task_field_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_code    TEXT    NOT NULL,
  register_key TEXT    NOT NULL REFERENCES register_definitions (register_key) ON DELETE CASCADE ON UPDATE CASCADE,
  record_type  TEXT,                                     -- NULL = the register has one record (per site); otherwise the part (for example Dismantle cw / te)
  field_code   TEXT    NOT NULL,
  label_en     TEXT,                                     -- NULL = the register field's label
  label_ar     TEXT,
  master_col   TEXT,                                     -- the Master column the field replaces
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX task_field_sources_key ON task_field_sources (task_code, register_key, coalesce(record_type, ''), field_code);

ALTER TABLE task_field_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_field_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON task_field_sources FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON task_field_sources FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON task_field_sources FROM pmis_app;
    GRANT SELECT ON task_field_sources TO pmis_app;
  END IF;
END $$;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('as_built', 'cw_as_built_submitted', 'CW As-Built Submitted', 'تقديم كما نُفّذ (CW)', 'list', false, false, false, '["Yes", "N/A"]'::jsonb, true, 'CW submission', 90),
  ('as_built', 'as_built_date',         'As-Built Date',         'تاريخ كما نُفّذ',       'date', false, true,  false, NULL,                     true, 'TE submission', 399)
ON CONFLICT (register_key, code) DO NOTHING;

INSERT INTO task_field_sources (task_code, register_key, record_type, field_code, label_en, label_ar, master_col, sort_order) VALUES
  ('B13', 'as_built',  NULL, 'cw_as_built_submitted', NULL,                      NULL,           'BU', 10),
  ('D15', 'as_built',  NULL, 'as_built_date',         NULL,                      NULL,           'EF', 10),
  ('E2',  'dismantle', 'cw', 'external_party_id',     'CW dismantle contractor', 'مقاول فك CW',  'FO', 10),
  ('E2',  'dismantle', 'te', 'external_party_id',     'TE dismantle contractor', 'مقاول فك TE',  'FT', 20);
