-- 0039_dashboard: the main dashboard, Project Status with editable weights, weekly snapshots (owner request 2026-11-02, Q34 to Q36).
-- Mirror: db/sql/038_dashboard.sql (kept identical to prisma/migrations/0039_dashboard/migration.sql).
--
-- What this adds
--   * Seeds: the weight set `project_status` v1 (8 activities 12/8/5/25/20/12/13/5 and the 45 items of rules.md section 6, each item with a
--     machine-readable measure_rule), the weight set `health_index` v1 (six factors, rules.md section 9), and the settings
--     dashboard.health_bands (Q35: green 85, amber 70) and dashboard.exclude_overrides.
--   * Weight sets are edited only through admin_save_weight_set / admin_preview_weight_set / admin_publish_weight_set (reason, audit with before
--     and after, the 100% rule per level, effective date, one open draft per code). pmis_app loses its direct write rights on the weight tables
--     and on the snapshot tables.
--   * dash_overview / dash_project_status: the dashboard and Project Status computed in the database, scoped by the caller's `dashboard.view`
--     regions (wf_actor_regions) so no caller sees a site outside their regions (B3, VI-04). SECURITY DEFINER, owner pmis_definer, search_path set.
--     They read only; the temporary tables they build vanish at commit.
--   * Weekly snapshots: site_snapshots (one row per site and date) and the existing progress_snapshots (one row per region and for the project),
--     written only by dash_snapshot_take / dash_snapshot_weekly (called by the daily job). A snapshot is never rewritten.
--   * Indexes for the dashboard reads.
--
-- Working days: the calendar is the default calendar (weekend Friday and Saturday, holidays table). Inside one call a temporary day table
-- (_dcal) holds the running count of working days, so the difference of two dates is one subtraction (the same value as cal_workdays_between).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Indexes
-- ---------------------------------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS register_records_issues_idx ON register_records (site_id) WHERE register_key = 'issues' AND is_current;
CREATE INDEX IF NOT EXISTS register_records_dismantle_idx ON register_records (site_id) WHERE register_key = 'dismantle' AND is_current;
CREATE INDEX IF NOT EXISTS register_records_quality_idx ON register_records (site_id) WHERE register_key = 'quality' AND is_current;
CREATE INDEX IF NOT EXISTS baseline_entries_site_ms_idx ON baseline_entries (site_id, milestone_code);
CREATE INDEX IF NOT EXISTS task_instances_site_state_idx ON task_instances (site_id, state);
CREATE INDEX IF NOT EXISTS snags_open_idx ON snags (site_id) WHERE status IN ('open', 'fix_uploaded', 'in_review');
CREATE INDEX IF NOT EXISTS document_slots_task_idx ON document_slots (task_id, status);

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Settings and weight-set seeds
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('dashboard.health_bands', '{"green": 85, "amber": 70}', 'Health index bands (Q35): green from this score, amber from this score, red below. The index is a draft under owner review.', now()),
  ('dashboard.exclude_overrides', 'true', 'Project Status and the health factors leave out tasks closed by an admin override (rules.md section 6, ASSUMPTION). The dashboard flags how many were left out.', now()),
  ('dashboard.snapshot_every_days', '7', 'The daily job takes a snapshot of the dashboard when the last one is at least this many days old (weekly by default).', now())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE ws uuid; nil constant uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM weight_sets WHERE code = 'project_status') THEN
    INSERT INTO weight_sets (code, version, effective_from, status, reason, changed_by)
    VALUES ('project_status', 1, DATE '2024-01-01', 'draft', 'seed: Project Status weights of rules.md section 6 (8 activities, 45 items)', nil) RETURNING id INTO ws;
    INSERT INTO weight_activities (weight_set_id, code, name, name_ar, weight, sort) VALUES
      (ws, 'A1', 'Survey & Engineering',          'المسح والهندسة',            12, 10),
      (ws, 'A2', 'Site Acquisition & Permits',    'استحواذ الموقع والتصاريح',  8,  20),
      (ws, 'A3', 'Procurement & Supply',          'المشتريات والتوريد',        5,  30),
      (ws, 'A4', 'Civil Work & Site Readiness',   'الأعمال المدنية وجاهزية الموقع', 25, 40),
      (ws, 'A5', 'TE Installation',               'تركيب TE',                  20, 50),
      (ws, 'A6', 'Integration & On-Air',          'التكامل والتشغيل',          12, 60),
      (ws, 'A7', 'Testing & Acceptance',          'الاختبار والقبول',          13, 70),
      (ws, 'A8', 'Training & Handover',           'التدريب والتسليم',          5,  80);
    -- measure_rule: {"method":"tasks","tasks":[codes],"plan":milestone} counts approved / applicable instances of those tasks (a milestone task has the
    -- code of its milestone, MS1..MS10) and plans against the baseline of the milestone `plan`. {"method":"none","central":true} is a project-wide
    -- item with no data in the PMIS yet: it is left out and its weight is redistributed (rules.md section 6).
    INSERT INTO weight_items (activity_id, code, name, weight, unit, measure_rule, source, sort)
    SELECT a.id, v.code, v.name, v.weight, v.unit, v.rule::jsonb, v.source, v.sort
    FROM (VALUES
      ('A1', '1.1',  'TSSR approved',                    30,    'units', '{"method":"tasks","tasks":["A2"],"plan":"MS1"}',  'RF & Design: TSSR Approved (task A2)', 10),
      ('A1', '1.2',  'Layout / STA / ST approved',       25,    'units', '{"method":"tasks","tasks":["B7"],"plan":"MS2"}',  'Master AS (task B7)', 20),
      ('A1', '1.3',  'HLD',                              15,    '0/100', '{"method":"none","central":true}',               'Deliverables Log HLD', 30),
      ('A1', '1.4',  'LLD per site',                     20,    'units', '{"method":"tasks","tasks":["A4"],"plan":"MS1"}',  'RF & Design: LLD Approved (task A4)', 40),
      ('A1', '1.5',  'Technical document templates',     10,    '0/100', '{"method":"none","central":true}',               'DOC', 50),
      ('A2', '2.1',  'Candidate selected',               30,    'units', '{"method":"tasks","tasks":["A1"],"plan":"MS1"}',  'Acquisition (task A1)', 10),
      ('A2', '2.2',  'Site acquired',                    50,    'units', '{"method":"tasks","tasks":["A3"],"plan":"MS1"}',  'Master T (task A3)', 20),
      ('A2', '2.3',  'CW access permission',             20,    'units', '{"method":"tasks","tasks":["B3"],"plan":"MS2"}',  'Access - CW (task B3)', 30),
      ('A3', '3.1',  'CW PO / WO',                       15,    'units', '{"method":"tasks","tasks":["B2"],"plan":"MS2"}',  'Master AI (task B2)', 10),
      ('A3', '3.2',  'BTS',                              14.45, 'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 20),
      ('A3', '3.3',  'PtP',                              14.45, 'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 30),
      ('A3', '3.4',  'CPE',                              8.5,   'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 40),
      ('A3', '3.5',  'Battery',                          17,    'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 50),
      ('A3', '3.6',  'Cabinet',                          17,    'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 60),
      ('A3', '3.7',  'Router',                           8.5,   'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 70),
      ('A3', '3.8',  'NMS',                              3.4,   '0/100', '{"method":"none","central":true}',               'NMS-S', 80),
      ('A3', '3.9',  'Core server',                      1.7,   'units', '{"method":"none","central":true}',               'Warehouse received / Contract Qty', 90),
      ('A3', '3.10', 'Billing',                          0,     '0/100', '{"method":"none","central":true}',               'BILL (not weighted)', 100),
      ('A4', '4.1',  'Adaption items',                   35,    'units', '{"method":"tasks","tasks":["B11"],"plan":"MS3"}', 'Master BD BE BF BG BJ (task B11)', 10),
      ('A4', '4.2',  'Tower items',                      10,    'units', '{"method":"tasks","tasks":["B10"],"plan":"MS3"}', 'Master BA BB BC (task B10)', 20),
      ('A4', '4.3',  'Internal AC/DC',                   8,     'units', '{"method":"tasks","tasks":["B11"],"plan":"MS3"}', 'Master BI (task B11)', 30),
      ('A4', '4.4',  'GECOL Power-On',                   12,    'units', '{"method":"tasks","tasks":["C2"],"plan":"MS4"}',  'Master BW (task C2)', 40),
      ('A4', '4.5',  'Site optical fiber',               6,     'units', '{"method":"tasks","tasks":["B11"],"plan":"MS3"}', 'Master BH (task B11)', 50),
      ('A4', '4.6',  'HLC link',                         9,     'units', '{"method":"tasks","tasks":["C4"],"plan":"MS4"}',  'Master BX (task C4)', 60),
      ('A4', '4.7',  'Site RFI',                         15,    'units', '{"method":"tasks","tasks":["MS4"],"plan":"MS4"}', 'Master BZ (milestone MS4)', 70),
      ('A4', '4.8',  'CW PAC',                           5,     'units', '{"method":"tasks","tasks":["B13"],"plan":"MS4"}', 'Master BV (task B13)', 80),
      ('A5', '5.1',  'TE DN approved',                   5,     'units', '{"method":"tasks","tasks":["D4"],"plan":"MS5"}',  'Master CH (task D4)', 10),
      ('A5', '5.2',  'TE MOS',                           15,    'units', '{"method":"tasks","tasks":["D5"],"plan":"MS5"}',  'Master CJ (task D5)', 20),
      ('A5', '5.3',  'TE items',                         70,    'units', '{"method":"tasks","tasks":["D6"],"plan":"MS5"}',  'Master CK to CO (task D6)', 30),
      ('A5', '5.4',  'HWID',                             10,    'units', '{"method":"tasks","tasks":["D12"],"plan":"MS7"}', 'Master DT (task D12)', 40),
      ('A6', '6.1',  'Pilot',                            10,    '0/100', '{"method":"none","central":true}',               'PILOT', 10),
      ('A6', '6.2',  'Commissioning',                    20,    'units', '{"method":"tasks","tasks":["D7"],"plan":"MS6"}',  'Master CW (task D7)', 20),
      ('A6', '6.3',  'MW alignment',                     10,    'units', '{"method":"tasks","tasks":["D8"],"plan":"MS6"}',  'Master CX (task D8)', 30),
      ('A6', '6.4',  'Integration',                      15,    'units', '{"method":"tasks","tasks":["D9"],"plan":"MS6"}',  'Master DA (task D9)', 40),
      ('A6', '6.5',  'On-Air',                           35,    'units', '{"method":"tasks","tasks":["MS6"],"plan":"MS6"}', 'Master DP (milestone MS6)', 50),
      ('A6', '6.6',  'NMS integration',                  10,    '0/100', '{"method":"none","central":true}',               'NMS-I', 60),
      ('A7', '7.1',  'EIR per system',                   20,    'units', '{"method":"tasks","tasks":["D13"],"plan":"MS7"}', 'Master DU to DY (task D13)', 10),
      ('A7', '7.2',  'PAT per system',                   20,    'units', '{"method":"tasks","tasks":["D14"],"plan":"MS7"}', 'Master DZ to EC, EE (task D14)', 20),
      ('A7', '7.3',  'SSV',                              10,    'units', '{"method":"tasks","tasks":["D11"],"plan":"MS7"}', 'Master DS = Pass (task D11)', 30),
      ('A7', '7.4',  'As-Built',                         10,    'units', '{"method":"tasks","tasks":["D15"],"plan":"MS7"}', 'Master EF (task D15)', 40),
      ('A7', '7.5',  'TE PAC',                           20,    'units', '{"method":"tasks","tasks":["MS7"],"plan":"MS7"}', 'Master EL (milestone MS7)', 50),
      ('A7', '7.6',  'KPI Acceptance',                   10,    'units', '{"method":"tasks","tasks":["MS8"],"plan":"MS8"}', 'Master ES (milestone MS8)', 60),
      ('A7', '7.7',  'NMS acceptance',                   10,    '0/100', '{"method":"none","central":true}',               'NMS-A', 70),
      ('A8', '8.1',  'Vendor training',                  50,    '0/100', '{"method":"none","central":true}',               'TRN', 10),
      ('A8', '8.2',  'HOTO',                             50,    'units', '{"method":"tasks","tasks":["MS9"],"plan":"MS9"}', 'Master EY (milestone MS9)', 20)
    ) AS v(act, code, name, weight, unit, rule, source, sort)
    JOIN weight_activities a ON a.weight_set_id = ws AND a.code = v.act;
    UPDATE weight_sets SET status = 'published', published_at = now() WHERE id = ws;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM weight_sets WHERE code = 'health_index') THEN
    INSERT INTO weight_sets (code, version, effective_from, status, reason, changed_by)
    VALUES ('health_index', 1, DATE '2024-01-01', 'draft', 'seed: health index factors of rules.md section 9 (draft, under owner review)', nil) RETURNING id INTO ws;
    INSERT INTO weight_activities (weight_set_id, code, name, name_ar, weight, sort) VALUES
      (ws, 'P', 'Progress',                    'التقدم',                  16.666, 10),
      (ws, 'B', 'Baseline adherence',          'الالتزام بخط الأساس',     16.666, 20),
      (ws, 'S', 'SLA adherence',               'الالتزام بمدد SLA',       16.667, 30),
      (ws, 'D', 'Documentation completeness',  'اكتمال المستندات',        16.667, 40),
      (ws, 'F', 'First-time approval',         'الاعتماد من أول مرة',     16.667, 50),
      (ws, 'I', 'Critical issues',             'المشاكل الحرجة',          16.667, 60);
    UPDATE weight_sets SET status = 'published', published_at = now() WHERE id = ws;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Snapshot table per site (the region and project rows live in progress_snapshots)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE site_snapshots (
  snapshot_date  DATE        NOT NULL,
  site_id        UUID        NOT NULL REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE,
  region_id      INTEGER     NOT NULL REFERENCES regions (id),
  cluster_code   TEXT,
  scenario       TEXT,
  weight_set_id  UUID        REFERENCES weight_sets (id),
  overall_status TEXT        NOT NULL,
  ms             JSONB       NOT NULL,        -- {"MS1": {"state": "done", "date": "2026-01-04", "baseline": "2026-01-02", "seq": 1}, ...}
  streams        JSONB       NOT NULL,        -- {"CW": "in_progress", ...}
  items          JSONB       NOT NULL,        -- Project Status counts: {"1.1": [done, applicable, planned, plan_known], ...}
  progress_pct   NUMERIC(6, 3),
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, site_id)
);
CREATE INDEX site_snapshots_region_idx ON site_snapshots (region_id, snapshot_date);
CREATE INDEX site_snapshots_site_idx ON site_snapshots (site_id, snapshot_date);
ALTER TABLE site_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON site_snapshots FOR SELECT USING (app_region_read(false, region_id));
CREATE POLICY rls_seed_write ON site_snapshots FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- A snapshot is final: no UPDATE, no DELETE (the site cascade of a hard-deleted site is the only way a row goes).
CREATE OR REPLACE FUNCTION snapshots_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'a snapshot is never rewritten' USING ERRCODE = 'check_violation'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER site_snapshots_frozen BEFORE UPDATE ON site_snapshots FOR EACH ROW EXECUTE FUNCTION snapshots_frozen();
CREATE TRIGGER progress_snapshots_frozen BEFORE UPDATE ON progress_snapshots FOR EACH ROW EXECUTE FUNCTION snapshots_frozen();

GRANT SELECT, INSERT ON site_snapshots, progress_snapshots TO pmis_definer;
GRANT SELECT ON sites, clusters, regions, task_instances, task_definitions, stage_definitions, workflow_definitions, workflow_streams, phase_gate_rules,
  baseline_entries, baseline_versions, change_requests, register_records, snags, document_slots, document_types, sla_rules, external_parties, users,
  weight_sets, weight_activities, weight_items, work_calendars, holidays, settings, site_gate_state TO pmis_definer;
GRANT INSERT, UPDATE, DELETE ON weight_sets, weight_activities, weight_items TO pmis_definer;
GRANT USAGE ON SCHEMA public TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Weight sets: helpers and the audited admin path
-- ---------------------------------------------------------------------------------------------------------------------
-- The published set of a code in force on a date; before the first set starts, the earliest one.
CREATE OR REPLACE FUNCTION weight_set_in_force(p_code text, p_on date) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    (SELECT id FROM public.weight_sets WHERE code::text = p_code AND status = 'published' AND effective_from <= p_on AND (effective_to IS NULL OR effective_to > p_on) ORDER BY version DESC LIMIT 1),
    (SELECT id FROM public.weight_sets WHERE code::text = p_code AND status = 'published' ORDER BY effective_from, version LIMIT 1))
$$;

-- A set as jsonb (the same shape the API returns).
CREATE OR REPLACE FUNCTION weight_set_json(p_set uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'code', s.code, 'version', s.version, 'status', s.status, 'effective_from', s.effective_from, 'effective_to', s.effective_to,
    'reason', s.reason, 'changed_by', s.changed_by, 'created_at', s.created_at, 'published_at', s.published_at,
    'is_active', (s.id = public.weight_set_in_force(s.code::text, public.cal_today()) AND s.status = 'published' AND s.effective_from <= public.cal_today()),
    'activities', coalesce((
      SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name_en', a.name, 'name_ar', a.name_ar, 'weight', a.weight,
        'items', coalesce((SELECT jsonb_agg(jsonb_build_object('code', i.code, 'name_en', i.name, 'name_ar', i.name_ar, 'weight', i.weight, 'unit', i.unit,
            'measure_rule', CASE WHEN i.measure_rule IS NULL THEN NULL WHEN jsonb_typeof(i.measure_rule) = 'string' THEN i.measure_rule #>> '{}' ELSE i.measure_rule::text END,
            'source', i.source) ORDER BY i.sort, i.code) FROM public.weight_items i WHERE i.activity_id = a.id), '[]'::jsonb)) ORDER BY a.sort, a.code)
      FROM public.weight_activities a WHERE a.weight_set_id = s.id), '[]'::jsonb))
  FROM public.weight_sets s WHERE s.id = p_set
$$;

-- Content of a set without the identity columns, for "no changes" and for the audit rows.
CREATE OR REPLACE FUNCTION weight_set_content(p_set uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT public.weight_set_json(p_set) -> 'activities'
$$;

-- The 100% rule, per level, as a list of errors (the API shows them in the preview and the publish answers 422 with them).
CREATE OR REPLACE FUNCTION weight_set_errors(p_set uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb; total numeric; r record; idx int := 0;
BEGIN
  SELECT coalesce(sum(weight), 0) INTO total FROM public.weight_activities WHERE weight_set_id = p_set;
  IF abs(total - 100) > 0.001 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/activities', 'code', 'weights_must_total_100', 'message', 'The activity weights total ' || trim(trailing '.' from trim(trailing '0' from total::text)) || ', they must total 100.'));
  END IF;
  FOR r IN SELECT a.code, (row_number() OVER (ORDER BY a.sort, a.code)) - 1 AS pos, sum(i.weight) AS s
           FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id WHERE a.weight_set_id = p_set GROUP BY a.id, a.code, a.sort ORDER BY a.sort, a.code LOOP
    IF abs(r.s - 100) > 0.001 THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/activities/' || r.pos || '/items', 'code', 'weights_must_total_100',
        'message', 'The items of activity ' || r.code || ' total ' || trim(trailing '.' from trim(trailing '0' from r.s::text)) || ', they must total 100.'));
    END IF;
  END LOOP;
  RETURN errs;
END $$;

-- Create a draft (p_set NULL: a copy of p_base, or of the set in force) or replace the activities and items of a draft (p_activities).
-- A draft may be saved while its totals are not 100 (the screen shows the live sum); publishing refuses it.
CREATE OR REPLACE FUNCTION admin_save_weight_set(p_set uuid, p_code text, p_base uuid, p_reason text, p_activities jsonb, p_expected jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.weight_sets%ROWTYPE; b public.weight_sets%ROWTYPE; nid uuid; a jsonb; i jsonb; aid uuid; before_ jsonb; ver int; n int := 0; m int; codes text[];
BEGIN
  PERFORM public.calc_require_admin('weights');
  PERFORM public.calc_require_reason(p_reason);
  IF p_set IS NULL THEN
    IF p_code IS NULL OR p_code NOT IN ('project_status', 'health_index', 'delay_attribution') THEN
      PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'invalid', 'message', 'Unknown weight set code.'))));
    END IF;
    IF EXISTS (SELECT 1 FROM public.weight_sets WHERE code::text = p_code AND status = 'draft') THEN
      PERFORM public.calc_err('duplicate', jsonb_build_object('detail', 'This code has an open draft already.', 'existing_id', (SELECT id FROM public.weight_sets WHERE code::text = p_code AND status = 'draft' LIMIT 1)));
    END IF;
    IF p_base IS NOT NULL THEN
      SELECT * INTO b FROM public.weight_sets WHERE id = p_base;
      IF NOT FOUND OR b.code::text <> p_code THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The base weight set does not exist for this code.')); END IF;
    ELSE
      SELECT * INTO b FROM public.weight_sets WHERE id = public.weight_set_in_force(p_code, public.cal_today());
    END IF;
    SELECT coalesce(max(version), 0) + 1 INTO ver FROM public.weight_sets WHERE code::text = p_code;
    INSERT INTO public.weight_sets (code, version, effective_from, status, reason, changed_by)
    VALUES (p_code::"WeightSetCode", ver, public.cal_today(), 'draft', p_reason, coalesce(public.app_actor(), '00000000-0000-0000-0000-000000000000')) RETURNING id INTO nid;
    IF b.id IS NOT NULL THEN
      FOR a IN SELECT row_to_json(x)::jsonb FROM public.weight_activities x WHERE x.weight_set_id = b.id ORDER BY x.sort LOOP
        INSERT INTO public.weight_activities (weight_set_id, code, name, name_ar, weight, sort)
        VALUES (nid, a ->> 'code', a ->> 'name', a ->> 'name_ar', (a ->> 'weight')::numeric, (a ->> 'sort')::int) RETURNING id INTO aid;
        INSERT INTO public.weight_items (activity_id, code, name, name_ar, weight, unit, measure_rule, source, sort)
        SELECT aid, it.code, it.name, it.name_ar, it.weight, it.unit, it.measure_rule, it.source, it.sort FROM public.weight_items it WHERE it.activity_id = (a ->> 'id')::uuid;
      END LOOP;
    END IF;
    PERFORM public.calc_audit('weights.draft_created', 'weight_set', nid::text, NULL, jsonb_build_object('code', p_code, 'version', ver, 'base_set_id', b.id), p_reason);
    RETURN nid;
  END IF;

  SELECT * INTO s FROM public.weight_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The weight set does not exist.')); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only a draft can be changed.')); END IF;
  IF p_expected IS NOT NULL AND public.weight_set_content(p_set) IS DISTINCT FROM p_expected THEN
    PERFORM public.calc_err('precondition_failed', jsonb_build_object('detail', 'The draft changed since you read it.'));
  END IF;
  IF p_activities IS NULL OR jsonb_typeof(p_activities) <> 'array' OR jsonb_array_length(p_activities) = 0 THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/activities', 'code', 'required', 'message', 'At least one activity is required.'))));
  END IF;
  SELECT array_agg(x ->> 'code') INTO codes FROM jsonb_array_elements(p_activities) x;
  IF (SELECT count(DISTINCT c) FROM unnest(codes) c) <> cardinality(codes) THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/activities', 'code', 'duplicate', 'message', 'Activity codes must be unique.'))));
  END IF;
  before_ := public.weight_set_content(p_set);
  DELETE FROM public.weight_activities WHERE weight_set_id = p_set;     -- items go with them (on delete cascade)
  FOR a IN SELECT x FROM jsonb_array_elements(p_activities) x LOOP
    n := n + 1;
    INSERT INTO public.weight_activities (weight_set_id, code, name, name_ar, weight, sort)
    VALUES (p_set, a ->> 'code', a ->> 'name_en', a ->> 'name_ar', (a ->> 'weight')::numeric, n * 10) RETURNING id INTO aid;
    codes := ARRAY[]::text[]; m := 0;
    FOR i IN SELECT y FROM jsonb_array_elements(coalesce(a -> 'items', '[]'::jsonb)) y LOOP
      m := m + 1;
      IF (i ->> 'code') = ANY (codes) THEN
        PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/activities/' || (n - 1) || '/items/' || (m - 1) || '/code', 'code', 'duplicate', 'message', 'Item codes must be unique inside an activity.'))));
      END IF;
      codes := codes || (i ->> 'code');
      INSERT INTO public.weight_items (activity_id, code, name, name_ar, weight, unit, measure_rule, source, sort)
      VALUES (aid, i ->> 'code', i ->> 'name_en', i ->> 'name_ar', (i ->> 'weight')::numeric, i ->> 'unit',
        CASE WHEN i ->> 'measure_rule' IS NULL THEN NULL
             WHEN left(btrim(i ->> 'measure_rule'), 1) = '{' THEN (i ->> 'measure_rule')::jsonb
             ELSE to_jsonb(i ->> 'measure_rule') END,
        i ->> 'source', m * 10);
    END LOOP;
  END LOOP;
  UPDATE public.weight_sets SET reason = p_reason, changed_by = coalesce(public.app_actor(), changed_by) WHERE id = p_set;
  PERFORM public.calc_audit('weights.draft_saved', 'weight_set', p_set::text, jsonb_build_object('activities', before_), jsonb_build_object('activities', public.weight_set_content(p_set)), p_reason);
  RETURN p_set;
END $$;

-- Preview: always answers, never changes anything. progress_current_pct and progress_new_pct are the project progress today with the set in force and with the draft.
CREATE OR REPLACE FUNCTION admin_preview_weight_set(p_set uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.weight_sets%ROWTYPE; errs jsonb; cur uuid; cur_j jsonb; new_j jsonb; today date := public.cal_today();
BEGIN
  PERFORM public.calc_require_admin('weights');
  SELECT * INTO s FROM public.weight_sets WHERE id = p_set;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The weight set does not exist.')); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only a draft can be previewed.')); END IF;
  errs := public.weight_set_errors(p_set);
  cur := public.weight_set_in_force(s.code::text, today);
  IF s.code::text <> 'project_status' THEN
    RETURN jsonb_build_object('valid', jsonb_array_length(errs) = 0, 'errors', errs, 'progress_current_pct', NULL, 'progress_new_pct', NULL, 'activities', '[]'::jsonb);
  END IF;
  cur_j := public.dash_ps_project(today, cur);
  IF jsonb_array_length(errs) = 0 THEN new_j := public.dash_ps_project(today, p_set); END IF;
  RETURN jsonb_build_object('valid', jsonb_array_length(errs) = 0, 'errors', errs,
    'progress_current_pct', (cur_j ->> 'progress_pct')::numeric, 'progress_new_pct', (new_j ->> 'progress_pct')::numeric,
    'activities', coalesce((SELECT jsonb_agg(jsonb_build_object('code', c ->> 'code', 'current_pct', (c ->> 'progress_pct')::numeric,
        'new_pct', (SELECT (n ->> 'progress_pct')::numeric FROM jsonb_array_elements(coalesce(new_j -> 'activities', '[]'::jsonb)) n WHERE n ->> 'code' = c ->> 'code'))) FROM jsonb_array_elements(cur_j -> 'activities') c), '[]'::jsonb));
END $$;

-- Publish: the 100% rule, an effective date today or later and after the set in force, something changed; the previous set ends on the effective date.
CREATE OR REPLACE FUNCTION admin_publish_weight_set(p_set uuid, p_effective date, p_reason text, p_expected jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.weight_sets%ROWTYPE; errs jsonb; prev public.weight_sets%ROWTYPE; today date := public.cal_today(); before_ jsonb;
BEGIN
  PERFORM public.calc_require_admin('weights', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO s FROM public.weight_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The weight set does not exist.')); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only a draft can be published.')); END IF;
  IF p_expected IS NOT NULL AND public.weight_set_content(p_set) IS DISTINCT FROM p_expected THEN
    PERFORM public.calc_err('precondition_failed', jsonb_build_object('detail', 'The draft changed since you read it.'));
  END IF;
  errs := public.weight_set_errors(p_set);
  IF p_effective IS NULL OR p_effective < today THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'effective_date_in_past', 'message', 'The effective date is today or later.'));
  END IF;
  SELECT * INTO prev FROM public.weight_sets WHERE code = s.code AND status = 'published' ORDER BY effective_from DESC, version DESC LIMIT 1;
  IF FOUND AND p_effective IS NOT NULL AND p_effective <= prev.effective_from THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'effective_date_not_after_current', 'message', 'The effective date must be after ' || prev.effective_from::text || '.'));
  END IF;
  IF FOUND AND public.weight_set_content(p_set) IS NOT DISTINCT FROM public.weight_set_content(prev.id) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/', 'code', 'no_changes', 'message', 'The draft is the same as the set in force.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before_ := jsonb_build_object('previous_set_id', prev.id, 'previous_version', prev.version);
  IF prev.id IS NOT NULL THEN UPDATE public.weight_sets SET effective_to = p_effective WHERE id = prev.id AND (effective_to IS NULL OR effective_to > p_effective); END IF;
  UPDATE public.weight_sets SET status = 'published', effective_from = p_effective, published_at = now(), reason = p_reason, changed_by = coalesce(public.app_actor(), changed_by) WHERE id = p_set;
  PERFORM public.calc_audit('weights.published', 'weight_set', p_set::text, before_, jsonb_build_object('code', s.code, 'version', s.version, 'effective_from', p_effective), p_reason);
  RETURN jsonb_build_object('set_id', p_set, 'previous_set_id', prev.id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Dashboard calculation. Temporary tables (_dcal, _dsite, _dms, _dbase, _dwi, _dic, _dstr, _dtask) live until commit.
-- ---------------------------------------------------------------------------------------------------------------------
-- Working-day calendar of the call: the running count of working days, so wd(a, b) = idx(b) - idx(a) (the value cal_workdays_between gives).
CREATE OR REPLACE FUNCTION dash_build_cal() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE we integer[] := public.cal_weekend(); cal uuid := public.cal_default();
BEGIN
  DROP TABLE IF EXISTS _dcal;
  CREATE TEMP TABLE _dcal ON COMMIT DROP AS
    SELECT x.d, x.is_wd, (count(*) FILTER (WHERE x.is_wd) OVER (ORDER BY x.d))::integer AS wd
    FROM (SELECT g::date AS d,
                 (NOT (extract(dow FROM g)::integer = ANY (we)) AND NOT EXISTS (SELECT 1 FROM public.holidays h WHERE h.calendar_id = cal AND h.date = g::date)) AS is_wd
          FROM generate_series(DATE '2019-12-31', DATE '2036-01-01', interval '1 day') g) x;
  CREATE UNIQUE INDEX ON _dcal (d);
END $$;

CREATE OR REPLACE FUNCTION dash_wd(p_a date, p_b date) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE x integer; y integer;
BEGIN
  IF p_a IS NULL OR p_b IS NULL THEN RETURN NULL; END IF;
  SELECT wd INTO x FROM _dcal WHERE d = p_a;
  SELECT wd INTO y FROM _dcal WHERE d = p_b;
  RETURN y - x;
END $$;

-- The sites of the call, their milestones as of the reference date, baselines, gate state and the derived status (rules.md section 2.4).
--   p_scope   regions the caller may see (NULL = all);   p_region / p_cluster / p_scenario  the filters.
-- A milestone is `done` when its task is approved with an actual date on or before the reference date, `na` when the stage does not apply,
-- otherwise `open`. A gate is open when the previous milestone that applies is done; `blocked` (live only) comes from site_gate_state.
CREATE OR REPLACE FUNCTION dash_build_facts(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE live boolean := (p_ref = public.cal_today());
BEGIN
  DROP TABLE IF EXISTS _dsite; DROP TABLE IF EXISTS _dbase; DROP TABLE IF EXISTS _dms;
  CREATE TEMP TABLE _dsite ON COMMIT DROP AS
    SELECT s.id, s.site_code, s.region_id, c.cluster_code, s.delivery_scenario::text AS scenario, s.workflow_version_id AS wf,
           (s.overall_status = 'cancelled') AS cancelled,
           NULL::text AS status, NULL::integer AS cur_seq, NULL::text AS cur_code
    FROM public.sites s LEFT JOIN public.clusters c ON c.id = s.cluster_id
    WHERE s.is_active AND (p_scope IS NULL OR s.region_id = ANY (p_scope)) AND (p_region IS NULL OR s.region_id = p_region)
      AND (p_cluster IS NULL OR c.cluster_code = p_cluster) AND (p_scenario IS NULL OR s.delivery_scenario::text = p_scenario);
  CREATE UNIQUE INDEX ON _dsite (id);

  CREATE TEMP TABLE _dbase ON COMMIT DROP AS
    SELECT DISTINCT ON (be.site_id, be.milestone_code) be.site_id, be.milestone_code AS code, be.baseline_date AS base
    FROM public.baseline_entries be JOIN public.baseline_versions bv ON bv.id = be.version_id AND bv.status = 'approved'
    WHERE be.site_id IN (SELECT id FROM _dsite)
    ORDER BY be.site_id, be.milestone_code, bv.version DESC;
  CREATE UNIQUE INDEX ON _dbase (site_id, code);

  CREATE TEMP TABLE _dms ON COMMIT DROP AS
    WITH raw AS (
      SELECT s.id AS site_id, s.wf, sd.code, sd.seq, sd.stream_code,
        CASE WHEN t.id IS NULL OR t.state IN ('na', 'skipped') OR t.is_na THEN 'na'
             WHEN t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref THEN 'done'
             ELSE 'open' END AS state,
        CASE WHEN t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref THEN coalesce(t.actual_date, t.approved_date) END AS d,
        b.base
      FROM _dsite s
      JOIN public.stage_definitions sd ON sd.workflow_id = s.wf AND sd.is_active
      LEFT JOIN public.task_definitions td ON td.stage_id = sd.id AND td.is_milestone_task
      LEFT JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id
      LEFT JOIN _dbase b ON b.site_id = s.id AND b.code = sd.code
    ), prev AS (
      SELECT r.*,
        max(r.seq) FILTER (WHERE r.state <> 'na') OVER w AS prev_app, max(r.seq) FILTER (WHERE r.state = 'done') OVER w AS prev_done
      FROM raw r WINDOW w AS (PARTITION BY r.site_id ORDER BY r.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
    )
    SELECT p.site_id, p.code, p.seq, p.stream_code, p.state, p.d, p.base,
      CASE WHEN p.state = 'done' AND p.base IS NOT NULL THEN (SELECT cb.wd FROM _dcal cb WHERE cb.d = p.d) - (SELECT ca.wd FROM _dcal ca WHERE ca.d = p.base) END AS var_wd,
      (p.prev_app IS NOT DISTINCT FROM p.prev_done) AS gate_open,
      (live AND p.state = 'open' AND (p.prev_app IS NOT DISTINCT FROM p.prev_done) AND bl.site_id IS NOT NULL) AS blocked
    FROM prev p LEFT JOIN (
      SELECT DISTINCT gs.site_id, g.to_code, g.workflow_id FROM public.site_gate_state gs JOIN public.phase_gate_rules g ON g.link_code = gs.gate_code AND g.is_active
      WHERE NOT gs.is_open AND gs.site_id IN (SELECT id FROM _dsite)) bl ON bl.site_id = p.site_id AND bl.to_code = p.code AND bl.workflow_id = p.wf;
  CREATE INDEX ON _dms (site_id, seq);
  ANALYZE _dsite;
  ANALYZE _dms;

  UPDATE _dsite s SET status = x.status, cur_seq = x.cur_seq, cur_code = x.cur_code
  FROM (
    SELECT s2.id,
      CASE WHEN s2.cancelled THEN 'cancelled'
           WHEN coalesce(f.final_done, false) THEN 'completed'
           WHEN h.sdate IS NOT NULL AND (h.rdate IS NULL OR h.sdate > h.rdate) THEN 'on_hold'
           WHEN coalesce(f.any_done, false) THEN 'in_progress'
           ELSE 'not_started' END AS status,
      f.cur_seq, f.cur_code
    FROM _dsite s2
    LEFT JOIN (SELECT m.site_id, bool_or(m.state = 'done') AS any_done, max(m.seq) FILTER (WHERE m.state = 'done') AS cur_seq,
                      (array_agg(m.code ORDER BY m.seq DESC) FILTER (WHERE m.state = 'done'))[1] AS cur_code,
                      coalesce(bool_or(m.state = 'done') FILTER (WHERE m.seq = mx.seq), false) AS final_done
               FROM _dms m JOIN (SELECT site_id, max(seq) AS seq FROM _dms GROUP BY site_id) mx ON mx.site_id = m.site_id GROUP BY m.site_id) f ON f.site_id = s2.id
    LEFT JOIN (SELECT c.site_id, max(c.approval_date) FILTER (WHERE c.kind = 'suspension') AS sdate, max(c.approval_date) FILTER (WHERE c.kind = 'resumption') AS rdate
               FROM public.change_requests c WHERE c.status IN ('approved', 'applied') AND c.approval_date IS NOT NULL AND c.approval_date <= p_ref
                 AND c.site_id IN (SELECT id FROM _dsite) GROUP BY c.site_id) h ON h.site_id = s2.id
  ) x WHERE x.id = s.id;
END $$;

-- Status of each site in each stream (SR-R3), from the milestones of the stream; plus the Dismantle stream from its register.
--   na: no milestone of the stream applies;  done: the last one that applies is done;  not_due: nothing done and the first one that applies waits for its gate;
--   in_progress: anything else.
CREATE OR REPLACE FUNCTION dash_build_streams(p_ref date) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS _dstr;
  CREATE TEMP TABLE _dstr ON COMMIT DROP AS
    SELECT m.site_id, m.stream_code AS stream,
      CASE WHEN count(*) FILTER (WHERE m.state <> 'na') = 0 THEN 'na'
           WHEN (array_agg(m.state ORDER BY m.seq DESC) FILTER (WHERE m.state <> 'na'))[1] = 'done' THEN 'done'
           WHEN count(*) FILTER (WHERE m.state = 'done') = 0 AND NOT (array_agg(m.gate_open ORDER BY m.seq) FILTER (WHERE m.state <> 'na'))[1] THEN 'not_due'
           ELSE 'in_progress' END AS status
    FROM _dms m WHERE m.stream_code IS NOT NULL GROUP BY m.site_id, m.stream_code;
  INSERT INTO _dstr (site_id, stream, status)
    SELECT s.id, 'DISMANTLE', coalesce(d.status, 'na')
    FROM _dsite s LEFT JOIN (
      SELECT r.site_id,
        CASE WHEN bool_and(coalesce((r.data ->> 'closed')::boolean, false)) THEN 'done'
             WHEN bool_or(nullif(r.data ->> 'work_start_date', '')::date <= p_ref) THEN 'in_progress'
             ELSE 'not_started' END AS status
      FROM public.register_records r
      WHERE r.register_key = 'dismantle' AND r.is_current AND r.site_id IN (SELECT id FROM _dsite) AND nullif(r.data ->> 'rfd_date', '')::date <= p_ref
      GROUP BY r.site_id) d ON d.site_id = s.id;
  CREATE INDEX ON _dstr (site_id, stream);
END $$;

-- Project Status counts per site and item, as of the reference date, for the weight set p_ws.
CREATE OR REPLACE FUNCTION dash_build_wi(p_ws uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS _dwi; DROP TABLE IF EXISTS _dwt;
  CREATE TEMP TABLE _dwi ON COMMIT DROP AS
    SELECT a.code AS act, a.name AS act_name, a.name_ar AS act_name_ar, a.weight AS aw, a.sort AS asort,
           i.code AS item, i.name AS item_name, i.name_ar AS item_name_ar, coalesce(i.weight, 0) AS iw, i.sort AS isort, i.unit,
           CASE WHEN i.measure_rule IS NULL THEN 'none' WHEN jsonb_typeof(i.measure_rule) = 'object' THEN coalesce(i.measure_rule ->> 'method', 'none') ELSE 'none' END AS method,
           CASE WHEN jsonb_typeof(i.measure_rule) = 'object' THEN i.measure_rule ->> 'plan' END AS plan,
           CASE WHEN jsonb_typeof(i.measure_rule) = 'object' THEN coalesce((i.measure_rule ->> 'central')::boolean, false) ELSE false END AS central
    FROM public.weight_activities a LEFT JOIN public.weight_items i ON i.activity_id = a.id WHERE a.weight_set_id = p_ws;
  CREATE TEMP TABLE _dwt ON COMMIT DROP AS
    SELECT i.code AS item, t AS task_code
    FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.measure_rule) = 'object' AND jsonb_typeof(i.measure_rule -> 'tasks') = 'array' THEN i.measure_rule -> 'tasks' ELSE '[]'::jsonb END) t
    WHERE a.weight_set_id = p_ws;
END $$;

CREATE OR REPLACE FUNCTION dash_build_items(p_ref date, p_ws uuid, p_excl boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dash_build_wi(p_ws);
  DROP TABLE IF EXISTS _dic;
  CREATE TEMP TABLE _dic ON COMMIT DROP AS
    SELECT s.id AS site_id, w.act, w.item,
      count(*) FILTER (WHERE t.state NOT IN ('na', 'skipped') AND NOT t.is_na) AS applic,
      count(*) FILTER (WHERE t.state = 'approved' AND NOT t.is_na AND coalesce(t.actual_date, t.approved_date, t.updated_at::date) <= p_ref) AS done,
      count(*) FILTER (WHERE t.state NOT IN ('na', 'skipped') AND NOT t.is_na AND b.base IS NOT NULL AND b.base <= p_ref) AS planned,
      count(*) FILTER (WHERE t.state NOT IN ('na', 'skipped') AND NOT t.is_na AND b.base IS NOT NULL) AS plan_known
    FROM _dsite s
    JOIN _dwi w ON w.method = 'tasks' AND w.item IS NOT NULL AND w.iw > 0
    JOIN _dwt k ON k.item = w.item
    JOIN public.task_definitions td ON td.workflow_id = s.wf AND td.code = k.task_code
    JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id AND NOT (p_excl AND t.admin_override)
    LEFT JOIN _dbase b ON b.site_id = s.id AND b.code = w.plan
    WHERE NOT s.cancelled
    GROUP BY s.id, w.act, w.item;
  CREATE INDEX ON _dic (site_id);
END $$;

-- Project Status for the sites in _dsite, grouped: 'none' (one row, key all), 'region' or 'site'. Needs _dsite, _dwi and _dic.
-- Item percent = min(1, done / applicable). An item with no applicable unit, with weight 0, or central when the scope is not the whole project is dropped and its
-- weight redistributed inside the activity; an activity with no measured item is dropped and redistributed across the others (rules.md section 6).
-- Planned uses the baseline of the item's plan milestone and is shown only when every measured item of the group has a baseline for all its units.
CREATE OR REPLACE FUNCTION dash_ps_rows(p_group text, p_project_wide boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH ic AS (
    SELECT CASE p_group WHEN 'region' THEN s.region_id::text WHEN 'site' THEN s.site_code ELSE 'all' END AS gk,
           CASE p_group WHEN 'region' THEN coalesce(r.name_en, s.region_id::text) WHEN 'site' THEN s.site_code ELSE 'Project' END AS label,
           c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic, sum(c.planned) AS planned, sum(c.plan_known) AS plan_known
    FROM _dic c JOIN _dsite s ON s.id = c.site_id LEFT JOIN public.regions r ON r.id = s.region_id
    GROUP BY 1, 2, c.act, c.item
  ), it AS (
    SELECT ic.gk, ic.label, w.act, w.item, w.item_name, w.iw, w.aw,
           least(1, ic.done::numeric / ic.applic) AS pct,
           CASE WHEN ic.plan_known = ic.applic THEN least(1, ic.planned::numeric / ic.applic) END AS ppct
    FROM ic JOIN _dwi w ON w.item = ic.item WHERE ic.applic > 0 AND w.iw > 0 AND NOT (w.central AND NOT p_project_wide)
  ), act AS (
    SELECT gk, max(label) AS label, act, max(aw) AS aw, sum(iw * pct) / sum(iw) AS apct,
           CASE WHEN count(*) FILTER (WHERE ppct IS NULL) = 0 THEN sum(iw * ppct) / sum(iw) END AS pplan,
           coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL), 0) / sum(iw) AS cov
    FROM it GROUP BY gk, act
  ), tot AS (
    SELECT gk, max(label) AS label, sum(aw * apct) / sum(aw) AS actual,
           CASE WHEN count(*) FILTER (WHERE pplan IS NULL) = 0 THEN sum(aw * pplan) / sum(aw) END AS planned,
           sum(aw * cov) / sum(aw) AS coverage
    FROM act GROUP BY gk
  ), aj AS (
    SELECT gk, jsonb_object_agg(act, round(apct * 100, 3)) AS j, jsonb_object_agg(act, round(pplan * 100, 3)) FILTER (WHERE pplan IS NOT NULL) AS jp FROM act GROUP BY gk
  ), ij AS (
    SELECT gk, jsonb_object_agg(item, round(pct * 100, 3)) AS j FROM it GROUP BY gk
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'key', t.gk, 'label', t.label,
      'progress_pct', round(t.actual * 100, 3), 'planned_pct', round(t.planned * 100, 3),
      'spi', CASE WHEN t.planned > 0 THEN round(t.actual / t.planned, 3) END, 'plan_coverage_pct', round(t.coverage * 100, 3),
      'activities', aj.j, 'planned_activities', aj.jp, 'items', ij.j
    ) ORDER BY CASE WHEN p_group = 'region' THEN lpad(t.gk, 3, '0') ELSE t.gk END), '[]'::jsonb)
  INTO out_ FROM tot t JOIN aj ON aj.gk = t.gk LEFT JOIN ij ON ij.gk = t.gk;
  RETURN out_;
END $$;

-- The Project Status card (project or filtered scope): activities and items with their effective weights. Needs _dsite, _dwi, _dic.
CREATE OR REPLACE FUNCTION dash_ps_card(p_project_wide boolean, p_rows_none jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE head jsonb; acts jsonb; hidden int;
BEGIN
  head := coalesce(p_rows_none, public.dash_ps_rows('none', p_project_wide)) -> 0;
  WITH ic AS (SELECT c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic FROM _dic c JOIN _dsite s ON s.id = c.site_id GROUP BY c.act, c.item),
  it AS (
    SELECT w.act, w.item, w.item_name, w.item_name_ar, w.iw, w.unit, w.method, w.central, ic.applic, ic.done,
           CASE WHEN ic.applic > 0 THEN least(1, ic.done::numeric / ic.applic) END AS pct,
           (w.iw > 0 AND w.method = 'tasks' AND coalesce(ic.applic, 0) > 0 AND NOT (w.central AND NOT p_project_wide)) AS measured
    FROM _dwi w LEFT JOIN ic ON ic.item = w.item WHERE w.item IS NOT NULL
  ), a AS (
    SELECT w.act, max(w.act_name) AS name, max(w.act_name_ar) AS name_ar, max(w.aw) AS aw, max(w.asort) AS asort FROM _dwi w GROUP BY w.act
  )
  SELECT jsonb_agg(jsonb_build_object('code', a.act, 'name_en', a.name, 'name_ar', a.name_ar, 'weight', a.aw,
      'progress_pct', coalesce((SELECT round(sum(i.iw * i.pct) / nullif(sum(i.iw) FILTER (WHERE i.measured), 0) * 100, 3) FROM it i WHERE i.act = a.act AND i.measured), 0),
      'measured', EXISTS (SELECT 1 FROM it i WHERE i.act = a.act AND i.measured),
      'items', (SELECT jsonb_agg(jsonb_build_object('code', i.item, 'name_en', i.item_name, 'name_ar', i.item_name_ar, 'weight', i.iw, 'unit', i.unit,
          'progress_pct', round(coalesce(i.pct, 0) * 100, 3), 'measured', i.measured, 'done', coalesce(i.done, 0), 'applicable', coalesce(i.applic, 0),
          'reason', CASE WHEN i.iw = 0 THEN 'not_weighted' WHEN i.method <> 'tasks' THEN 'no_data' WHEN i.central AND NOT p_project_wide THEN 'central_hidden' WHEN coalesce(i.applic, 0) = 0 THEN 'not_applicable' END)
          ORDER BY i.item) FROM it i WHERE i.act = a.act)) ORDER BY a.asort)
  INTO acts FROM a;
  SELECT count(*) INTO hidden FROM _dwi w WHERE w.item IS NOT NULL AND w.central AND NOT p_project_wide AND w.iw > 0;
  RETURN jsonb_build_object('progress_pct', coalesce((head ->> 'progress_pct')::numeric, 0), 'planned_pct', head -> 'planned_pct', 'spi', head -> 'spi',
    'plan_coverage_pct', coalesce((head ->> 'plan_coverage_pct')::numeric, 0), 'activities', coalesce(acts, '[]'::jsonb), 'central_items_hidden', hidden);
END $$;

-- Whole-project Project Status for a date and weight set (preview of a draft, snapshots): builds its own temporary tables for every active site.
CREATE OR REPLACE FUNCTION dash_ps_project(p_ref date, p_ws uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dash_build_cal();
  PERFORM public.dash_build_facts(p_ref, NULL, NULL, NULL, NULL);
  PERFORM public.dash_build_items(p_ref, p_ws, coalesce((public.calc_setting('dashboard.exclude_overrides', 'true'::jsonb) #>> '{}')::boolean, true));
  RETURN public.dash_ps_card(true);
END $$;

-- Facts of a past reference date from a saved snapshot instead of the dated facts (the snapshot keeps what was computed at the time).
CREATE OR REPLACE FUNCTION dash_build_facts_snap(p_date date, p_scope integer[], p_region integer, p_cluster text, p_scenario text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS _dsite; DROP TABLE IF EXISTS _dbase; DROP TABLE IF EXISTS _dms;
  CREATE TEMP TABLE _dsite ON COMMIT DROP AS
    SELECT ss.site_id AS id, s.site_code, ss.region_id, ss.cluster_code, ss.scenario, s.workflow_version_id AS wf, (ss.overall_status = 'cancelled') AS cancelled,
           ss.overall_status AS status, NULL::integer AS cur_seq, NULL::text AS cur_code
    FROM public.site_snapshots ss JOIN public.sites s ON s.id = ss.site_id
    WHERE ss.snapshot_date = p_date AND s.is_active AND (p_scope IS NULL OR ss.region_id = ANY (p_scope)) AND (p_region IS NULL OR ss.region_id = p_region)
      AND (p_cluster IS NULL OR ss.cluster_code = p_cluster) AND (p_scenario IS NULL OR ss.scenario = p_scenario);
  CREATE UNIQUE INDEX ON _dsite (id);
  CREATE TEMP TABLE _dbase ON COMMIT DROP AS SELECT NULL::uuid AS site_id, NULL::text AS code, NULL::date AS base WHERE false;
  CREATE TEMP TABLE _dms ON COMMIT DROP AS
    SELECT ss.site_id, e.key AS code, (e.value ->> 'seq')::integer AS seq, e.value ->> 'stream' AS stream_code, e.value ->> 'state' AS state,
           nullif(e.value ->> 'date', '')::date AS d, nullif(e.value ->> 'baseline', '')::date AS base,
           CASE WHEN e.value ->> 'state' = 'done' AND coalesce(e.value ->> 'baseline', '') <> '' AND coalesce(e.value ->> 'date', '') <> ''
                THEN (SELECT cb.wd FROM _dcal cb WHERE cb.d = (e.value ->> 'date')::date) - (SELECT ca.wd FROM _dcal ca WHERE ca.d = (e.value ->> 'baseline')::date) END AS var_wd,
           coalesce((e.value ->> 'gate_open')::boolean, true) AS gate_open,
           coalesce((e.value ->> 'blocked')::boolean, false) AS blocked
    FROM public.site_snapshots ss CROSS JOIN LATERAL jsonb_each(ss.ms) e
    WHERE ss.snapshot_date = p_date AND ss.site_id IN (SELECT id FROM _dsite);
  CREATE INDEX ON _dms (site_id, seq);
  UPDATE _dsite s SET cur_seq = f.cur_seq, cur_code = f.cur_code
  FROM (SELECT m.site_id, max(m.seq) FILTER (WHERE m.state = 'done') AS cur_seq, (array_agg(m.code ORDER BY m.seq DESC) FILTER (WHERE m.state = 'done'))[1] AS cur_code
        FROM _dms m GROUP BY m.site_id) f WHERE f.site_id = s.id;
  -- the streams come from the snapshot too
  DROP TABLE IF EXISTS _dstr;
  CREATE TEMP TABLE _dstr ON COMMIT DROP AS
    SELECT ss.site_id, e.key AS stream, e.value #>> '{}' AS status
    FROM public.site_snapshots ss CROSS JOIN LATERAL jsonb_each(ss.streams) e WHERE ss.snapshot_date = p_date AND ss.site_id IN (SELECT id FROM _dsite);
  CREATE INDEX ON _dstr (site_id, stream);
END $$;

-- Project Status counts of a past reference date from the snapshot (its own weight set).
CREATE OR REPLACE FUNCTION dash_build_items_snap(p_date date, p_ws uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dash_build_wi(p_ws);
  DROP TABLE IF EXISTS _dic;
  CREATE TEMP TABLE _dic ON COMMIT DROP AS
    SELECT ss.site_id, w.act, w.item, (e.value ->> 0)::bigint AS done, (e.value ->> 1)::bigint AS applic, (e.value ->> 2)::bigint AS planned, (e.value ->> 3)::bigint AS plan_known
    FROM public.site_snapshots ss CROSS JOIN LATERAL jsonb_each(ss.items) e JOIN _dwi w ON w.item = e.key AND w.method = 'tasks' AND w.iw > 0
    WHERE ss.snapshot_date = p_date AND ss.site_id IN (SELECT id FROM _dsite) AND (e.value ->> 1)::bigint > 0;
  CREATE INDEX ON _dic (site_id);
END $$;

-- Task rows of the sites in _dsite with the SLA phase and class as of the reference date.
--   phase: none (no clock at that date), open (running), closed (approved on or before the date)
--   cls:   on_time / at_risk / late. Open: green until the target date, amber until the due date, red after (rules.md section 3); the date compared is the last
--          working day on or before the reference date, so a weekend does not add a day. Closed: elapsed working days against the rule's maximum.
CREATE OR REPLACE FUNCTION dash_build_tasks(p_ref date, p_stream text, p_excl boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE eff date;
BEGIN
  SELECT max(d) INTO eff FROM _dcal WHERE d <= p_ref AND is_wd;
  DROP TABLE IF EXISTS _dtask;
  CREATE TEMP TABLE _dtask ON COMMIT DROP AS
    WITH base AS (
      SELECT t.id, t.site_id, s.region_id, td.code AS task_code, sd.code AS stage_code, sd.stream_code,
             t.state::text AS state, t.admin_override, t.sla_target_date, t.due_date, t.sla_elapsed_wd, t.sla_end_date,
             r.max_working_days AS sla_max, t.return_count, coalesce(t.actual_date, t.approved_date) AS done_date,
             t.external_party_id, td.default_external_party::text AS default_party,
             CASE WHEN t.sla_start_date IS NULL OR t.sla_start_date > p_ref OR t.state IN ('locked', 'na', 'skipped') OR t.is_na
                       OR (p_excl AND t.admin_override) THEN 'none'
                  WHEN t.state = 'approved' AND coalesce(t.sla_end_date, t.actual_date, t.approved_date, p_ref) <= p_ref THEN 'closed'
                  WHEN t.due_date IS NULL THEN 'none'
                  ELSE 'open' END AS phase
      FROM _dsite s
      JOIN public.task_instances t ON t.site_id = s.id
      JOIN public.task_definitions td ON td.id = t.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
      WHERE NOT s.cancelled AND t.state NOT IN ('locked', 'na', 'skipped') AND (p_stream IS NULL OR sd.stream_code = p_stream)
    )
    SELECT b.id, b.site_id, b.region_id, b.task_code, b.stage_code, b.stream_code, b.state, b.admin_override, b.due_date, b.return_count, b.done_date,
      b.external_party_id, b.default_party, b.phase,
      CASE WHEN b.phase = 'closed' THEN CASE WHEN b.sla_elapsed_wd IS NULL OR b.sla_max IS NULL THEN NULL WHEN b.sla_elapsed_wd <= b.sla_max THEN 'on_time' ELSE 'late' END
           WHEN b.phase = 'open' THEN CASE WHEN eff <= coalesce(b.sla_target_date, b.due_date) THEN 'on_time' WHEN eff <= b.due_date THEN 'at_risk' ELSE 'late' END END AS cls,
      CASE WHEN b.phase = 'closed' AND b.sla_elapsed_wd IS NOT NULL AND b.sla_max IS NOT NULL THEN greatest(0, b.sla_elapsed_wd - b.sla_max)
           WHEN b.phase = 'open' AND eff > b.due_date THEN greatest(0, (SELECT wd FROM _dcal WHERE d = p_ref) - cd.wd) ELSE 0 END AS days_over
    FROM base b LEFT JOIN _dcal cd ON cd.d = b.due_date;
  CREATE INDEX ON _dtask (phase, cls);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Sections of the dashboard
-- ---------------------------------------------------------------------------------------------------------------------
-- Milestone aggregates: used by the headline (counts per milestone, on-air) and the pipeline.
CREATE OR REPLACE FUNCTION dash_sec_milestones(p_ref date, p_stream text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH wfs AS (
    SELECT wf AS id FROM _dsite UNION SELECT id FROM (SELECT id FROM public.workflow_definitions WHERE status = 'published' ORDER BY version DESC LIMIT 1) l
  ), names AS (
    SELECT DISTINCT ON (sd.code) sd.code, sd.name_en, sd.name_ar, sd.seq, sd.stream_code, sd.counts_in_project_status
    FROM public.stage_definitions sd JOIN public.workflow_definitions wd ON wd.id = sd.workflow_id
    WHERE sd.workflow_id IN (SELECT id FROM wfs) AND sd.is_active AND (p_stream IS NULL OR sd.stream_code = p_stream)
    ORDER BY sd.code, wd.version DESC
  ), m AS (
    SELECT m.code, m.state, m.d, m.base, m.var_wd, m.gate_open, m.blocked FROM _dms m JOIN _dsite s ON s.id = m.site_id WHERE NOT s.cancelled
  ), agg AS (
    SELECT code,
      count(*) FILTER (WHERE state <> 'na') AS applicable, count(*) FILTER (WHERE state = 'na') AS na, count(*) FILTER (WHERE state = 'done') AS done,
      count(*) FILTER (WHERE state = 'open' AND gate_open AND NOT blocked) AS in_work, count(*) FILTER (WHERE state = 'open' AND NOT gate_open) AS waiting,
      count(*) FILTER (WHERE state = 'open' AND blocked) AS blocked,
      count(*) FILTER (WHERE state <> 'na' AND base IS NOT NULL AND base <= p_ref) AS plan,
      count(*) FILTER (WHERE state <> 'na' AND base IS NULL) AS baseline_missing,
      count(*) FILTER (WHERE state = 'open' AND base < p_ref) AS overdue_open,
      count(*) FILTER (WHERE state = 'done' AND base IS NOT NULL AND d > base) AS achieved_late,
      count(*) FILTER (WHERE state = 'done' AND base IS NOT NULL AND d <= base) AS on_time,
      avg(var_wd) FILTER (WHERE state = 'done' AND base IS NOT NULL) AS avg_variance,
      avg(var_wd) FILTER (WHERE state = 'done' AND base IS NOT NULL AND d > base) AS avg_delay
    FROM m GROUP BY code
  ), gates AS (
    SELECT DISTINCT ON (g.to_code) g.to_code AS code, g.link_code, g.name_en, g.name_ar
    FROM public.phase_gate_rules g JOIN public.workflow_definitions wd ON wd.id = g.workflow_id
    WHERE g.workflow_id IN (SELECT id FROM wfs) AND g.is_active ORDER BY g.to_code, wd.version DESC
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'code', n.code, 'name_en', n.name_en, 'name_ar', n.name_ar, 'order', n.seq, 'stream_code', n.stream_code, 'counts_in_project_status', n.counts_in_project_status,
      'sites_total', coalesce(a.applicable, 0), 'completed', coalesce(a.done, 0), 'in_progress', coalesce(a.in_work, 0), 'late', coalesce(a.overdue_open, 0),
      'not_started', coalesce(a.waiting, 0), 'not_applicable', coalesce(a.na, 0), 'blocked', coalesce(a.blocked, 0),
      'completed_pct', CASE WHEN coalesce(a.applicable, 0) > 0 THEN round(a.done * 100.0 / a.applicable, 2) ELSE 0 END,
      'plan', coalesce(a.plan, 0), 'vs_plan', coalesce(a.done, 0) - coalesce(a.plan, 0), 'baseline_missing', coalesce(a.baseline_missing, 0),
      'overdue_open', coalesce(a.overdue_open, 0), 'achieved_late', coalesce(a.achieved_late, 0), 'on_time', coalesce(a.on_time, 0),
      'avg_variance_wd', round(a.avg_variance, 2), 'avg_delay_wd', round(a.avg_delay, 2), 'avg_working_days', round(a.avg_variance, 2),
      'gate', CASE WHEN g.link_code IS NULL THEN NULL ELSE jsonb_build_object('code', g.link_code, 'name_en', g.name_en, 'name_ar', g.name_ar) END
    ) ORDER BY n.seq), '[]'::jsonb)
  INTO out_ FROM names n LEFT JOIN agg a ON a.code = n.code LEFT JOIN gates g ON g.code = n.code;
  RETURN out_;
END $$;

CREATE OR REPLACE FUNCTION dash_sec_status(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  SELECT jsonb_build_object(
    'sites_total', count(*) FILTER (WHERE NOT cancelled), 'sites_cancelled', count(*) FILTER (WHERE cancelled),
    'by_overall_status', jsonb_build_object('not_started', count(*) FILTER (WHERE status = 'not_started'), 'in_progress', count(*) FILTER (WHERE status = 'in_progress'),
      'on_hold', count(*) FILTER (WHERE status = 'on_hold'), 'completed', count(*) FILTER (WHERE status = 'completed'), 'cancelled', count(*) FILTER (WHERE status = 'cancelled')))
  INTO out_ FROM _dsite;
  RETURN out_;
END $$;

-- Final Closure KPI (rules.md section 6.1): base = active sites with HOTO (MS9) achieved; pending FAC = PAC achieved, FAC not, aged from the end of the DLP.
CREATE OR REPLACE FUNCTION dash_sec_closure(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH ms AS (
    SELECT m.site_id, bool_or(m.state = 'done') FILTER (WHERE m.code = 'MS9') AS hoto, bool_or(m.state = 'done') FILTER (WHERE m.code = 'MS10') AS closed
    FROM _dms m JOIN _dsite s ON s.id = m.site_id WHERE NOT s.cancelled GROUP BY m.site_id
  ), f AS (
    SELECT s.id AS site_id, s.site_code,
      coalesce(bool_or(td.code = 'B13' AND t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref), false) AS cw_pac,
      coalesce(bool_or(td.code = 'B15' AND t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref), false) AS cw_fac,
      coalesce(bool_or(td.code = 'B15' AND (t.state IN ('na', 'skipped') OR t.is_na)), false) AS cw_fac_na,
      max(t.sla_start_date) FILTER (WHERE td.code = 'B15') AS cw_dlp_end,
      coalesce(bool_or(td.code = 'D16' AND t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref), false) AS te_pac,
      coalesce(bool_or(td.code = 'D18' AND t.state = 'approved' AND coalesce(t.actual_date, t.approved_date) <= p_ref), false) AS te_fac,
      coalesce(bool_or(td.code = 'D18' AND (t.state IN ('na', 'skipped') OR t.is_na)), false) AS te_fac_na,
      max(t.sla_start_date) FILTER (WHERE td.code = 'D18') AS te_dlp_end
    FROM _dsite s JOIN public.task_definitions td ON td.workflow_id = s.wf AND td.code IN ('B13', 'B15', 'D16', 'D18')
    JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id
    WHERE NOT s.cancelled GROUP BY s.id, s.site_code
  ), cw AS (
    SELECT site_id, site_code, cw_dlp_end AS dlp_end, (cw_dlp_end IS NOT NULL AND cw_dlp_end <= p_ref) AS due, public.dash_wd(cw_dlp_end, p_ref) AS age FROM f WHERE cw_pac AND NOT cw_fac AND NOT cw_fac_na
  ), te AS (
    SELECT site_id, site_code, te_dlp_end AS dlp_end, (te_dlp_end IS NOT NULL AND te_dlp_end <= p_ref) AS due, public.dash_wd(te_dlp_end, p_ref) AS age FROM f WHERE te_pac AND NOT te_fac AND NOT te_fac_na
  ), c AS (
    SELECT count(*) FILTER (WHERE coalesce(hoto, false)) AS base, count(*) FILTER (WHERE coalesce(closed, false)) AS closed, count(*) AS active FROM ms
  )
  SELECT jsonb_build_object(
    'sites_total', c.base, 'sites_closed', c.closed, 'closed_pct', CASE WHEN c.base > 0 THEN round(c.closed * 100.0 / c.base, 2) ELSE 0 END,
    'active_sites', c.active, 'closed_pct_of_active', CASE WHEN c.active > 0 THEN round(c.closed * 100.0 / c.active, 2) ELSE 0 END,
    'pending_cw_fac', jsonb_build_object('count', (SELECT count(*) FROM cw WHERE due), 'not_due', (SELECT count(*) FROM cw WHERE NOT due),
        'avg_age_days', (SELECT round(avg(age), 1) FROM cw WHERE due), 'oldest_age_days', (SELECT max(age) FROM cw WHERE due),
        'sites', coalesce((SELECT jsonb_agg(jsonb_build_object('site_id', x.site_id, 'site_code', x.site_code, 'age_days', x.age) ORDER BY x.age DESC, x.site_code) FROM (SELECT * FROM cw WHERE due ORDER BY age DESC, site_code LIMIT 10) x), '[]'::jsonb)),
    'pending_te_fac', jsonb_build_object('count', (SELECT count(*) FROM te WHERE due), 'not_due', (SELECT count(*) FROM te WHERE NOT due),
        'avg_age_days', (SELECT round(avg(age), 1) FROM te WHERE due), 'oldest_age_days', (SELECT max(age) FROM te WHERE due),
        'sites', coalesce((SELECT jsonb_agg(jsonb_build_object('site_id', x.site_id, 'site_code', x.site_code, 'age_days', x.age) ORDER BY x.age DESC, x.site_code) FROM (SELECT * FROM te WHERE due ORDER BY age DESC, site_code LIMIT 10) x), '[]'::jsonb))
  ) INTO out_ FROM c;
  RETURN out_;
END $$;

-- Streams (Q37, Q41): status counts per stream and per region, plus the Dismantle stream.
CREATE OR REPLACE FUNCTION dash_sec_streams() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH wfs AS (
    SELECT wf AS id FROM _dsite UNION SELECT id FROM (SELECT id FROM public.workflow_definitions WHERE status = 'published' ORDER BY version DESC LIMIT 1) l
  ), names AS (
    SELECT DISTINCT ON (ws.code) ws.code, ws.name_en, ws.name_ar, ws.sort_order
    FROM public.workflow_streams ws JOIN public.workflow_definitions wd ON wd.id = ws.workflow_id WHERE ws.workflow_id IN (SELECT id FROM wfs) ORDER BY ws.code, wd.version DESC
    ), all_names AS (
    SELECT code, name_en, name_ar, sort_order FROM names UNION ALL SELECT 'DISMANTLE', 'Dismantle', 'الفك', 99
  ), x AS (
    SELECT st.stream, s.region_id, st.status, s.status AS overall
    FROM _dstr st JOIN _dsite s ON s.id = st.site_id WHERE NOT s.cancelled
  ), cnt AS (
    SELECT stream, region_id,
      count(*) FILTER (WHERE status = 'not_due') AS not_due, count(*) FILTER (WHERE status = 'not_started') AS not_started,
      count(*) FILTER (WHERE status = 'in_progress') AS in_progress, count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'na') AS na,
      count(*) FILTER (WHERE overall = 'on_hold' AND status IN ('not_due', 'not_started', 'in_progress')) AS on_hold
    FROM x GROUP BY stream, region_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'code', n.code, 'name_en', n.name_en, 'name_ar', n.name_ar, 'sort_order', n.sort_order,
      'counts', (SELECT jsonb_build_object('not_due', coalesce(sum(c.not_due), 0), 'not_started', coalesce(sum(c.not_started), 0), 'in_progress', coalesce(sum(c.in_progress), 0),
                        'done', coalesce(sum(c.done), 0), 'na', coalesce(sum(c.na), 0), 'on_hold', coalesce(sum(c.on_hold), 0)) FROM cnt c WHERE c.stream = n.code),
      'by_region', coalesce((SELECT jsonb_agg(jsonb_build_object('region_id', c.region_id, 'not_due', c.not_due, 'not_started', c.not_started, 'in_progress', c.in_progress,
                        'done', c.done, 'na', c.na, 'on_hold', c.on_hold) ORDER BY c.region_id) FROM cnt c WHERE c.stream = n.code), '[]'::jsonb)
    ) ORDER BY n.sort_order), '[]'::jsonb)
  INTO out_ FROM all_names n;
  RETURN out_;
END $$;

-- SLA (rules.md section 3): per stage the open tasks on time, at risk and late, and the completed ones within and over the maximum; the top late tasks.
CREATE OR REPLACE FUNCTION dash_sec_sla(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH names AS (
    SELECT DISTINCT ON (sd.code) sd.code, sd.name_en, sd.name_ar, sd.seq, sd.stream_code
    FROM public.stage_definitions sd JOIN public.workflow_definitions wd ON wd.id = sd.workflow_id
    WHERE sd.workflow_id IN (SELECT DISTINCT wf FROM _dsite) AND sd.is_active ORDER BY sd.code, wd.version DESC
  ), agg AS (
    SELECT stage_code,
      count(*) FILTER (WHERE phase = 'open' AND cls = 'on_time') AS open_on_time, count(*) FILTER (WHERE phase = 'open' AND cls = 'at_risk') AS open_at_risk,
      count(*) FILTER (WHERE phase = 'open' AND cls = 'late') AS open_late, count(*) FILTER (WHERE phase = 'closed' AND cls = 'on_time') AS completed_on_time,
      count(*) FILTER (WHERE phase = 'closed' AND cls = 'late') AS completed_late
    FROM _dtask WHERE phase <> 'none' GROUP BY stage_code
  ), top AS (
    SELECT t.id, t.site_id, s.site_code, t.region_id, t.task_code, td.name_en AS task_name, t.stage_code, t.due_date, t.days_over, t.state, ep.name AS party
    FROM _dtask t JOIN _dsite s ON s.id = t.site_id JOIN public.task_definitions td ON td.workflow_id = s.wf AND td.code = t.task_code
    LEFT JOIN public.external_parties ep ON ep.id = t.external_party_id
    WHERE t.phase = 'open' AND t.cls = 'late' ORDER BY t.days_over DESC, t.due_date, s.site_code, t.task_code LIMIT 10
  )
  SELECT jsonb_build_object(
    'totals', (SELECT jsonb_build_object('open_on_time', coalesce(sum(open_on_time), 0), 'open_at_risk', coalesce(sum(open_at_risk), 0), 'open_late', coalesce(sum(open_late), 0),
                 'completed_on_time', coalesce(sum(completed_on_time), 0), 'completed_late', coalesce(sum(completed_late), 0)) FROM agg),
    'by_stage', coalesce((SELECT jsonb_agg(jsonb_build_object('stage_code', n.code, 'name_en', n.name_en, 'name_ar', n.name_ar, 'order', n.seq, 'stream_code', n.stream_code,
        'open_on_time', coalesce(a.open_on_time, 0), 'open_at_risk', coalesce(a.open_at_risk, 0), 'open_late', coalesce(a.open_late, 0),
        'completed_on_time', coalesce(a.completed_on_time, 0), 'completed_late', coalesce(a.completed_late, 0)) ORDER BY n.seq)
      FROM names n LEFT JOIN agg a ON a.stage_code = n.code WHERE a.stage_code IS NOT NULL), '[]'::jsonb),
    'top_late', coalesce((SELECT jsonb_agg(jsonb_build_object('task_id', id, 'site_id', site_id, 'site_code', site_code, 'region_id', region_id, 'task_code', task_code,
        'task_name', task_name, 'stage_code', stage_code, 'due_date', due_date, 'days_late_wd', days_over, 'state', state, 'party', party)
        ORDER BY days_over DESC, due_date, site_code, task_code) FROM top), '[]'::jsonb)
  ) INTO out_;
  RETURN out_;
END $$;

-- Blocked gates with their reasons (live only: the state of a gate on a past date is not kept).
CREATE OR REPLACE FUNCTION dash_sec_gates(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; live boolean := (p_ref = public.cal_today());
BEGIN
  IF NOT live THEN RETURN jsonb_build_object('available', false, 'blocked_total', 0, 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb); END IF;
  WITH b AS (
    SELECT s.id AS site_id, s.site_code, s.region_id, g.link_code, g.name_en, g.name_ar, m.code AS to_code, gs.since
    FROM _dms m JOIN _dsite s ON s.id = m.site_id AND NOT s.cancelled
    JOIN public.phase_gate_rules g ON g.workflow_id = s.wf AND g.to_code = m.code AND g.is_active
    JOIN public.site_gate_state gs ON gs.site_id = s.id AND gs.gate_code = g.link_code AND NOT gs.is_open
    WHERE m.blocked
  ), top AS (SELECT * FROM b ORDER BY since, site_code, link_code LIMIT 50)
  SELECT jsonb_build_object('available', true, 'blocked_total', (SELECT count(*) FROM b),
    'by_gate', coalesce((SELECT jsonb_agg(jsonb_build_object('gate_code', x.link_code, 'name_en', x.name_en, 'name_ar', x.name_ar, 'to_code', x.to_code, 'count', x.n) ORDER BY x.link_code)
                         FROM (SELECT link_code, max(name_en) AS name_en, max(name_ar) AS name_ar, max(to_code) AS to_code, count(*) AS n FROM b GROUP BY link_code) x), '[]'::jsonb),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('site_id', t.site_id, 'site_code', t.site_code, 'region_id', t.region_id, 'gate_code', t.link_code, 'name_en', t.name_en,
        'name_ar', t.name_ar, 'to_code', t.to_code, 'since', t.since, 'reasons', coalesce((SELECT ge.reasons FROM public.gate_eval(t.site_id, t.link_code) ge), '[]'::jsonb)) ORDER BY t.since, t.site_code) FROM top t), '[]'::jsonb))
  INTO out_;
  RETURN out_;
END $$;

-- Issues (Q36): counts of issues for the owner bars and totals, sites for "sites with an open issue"; age in working days from the raised date.
CREATE OR REPLACE FUNCTION dash_sec_issues(p_ref date, p_scope integer[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; live boolean := (p_ref = public.cal_today());
BEGIN
  WITH i AS (
    SELECT r.id, r.site_id, s.region_id, nullif(r.data ->> 'raised_date', '')::date AS raised, nullif(r.data ->> 'resolution_date', '')::date AS resolved,
           lower(coalesce(r.data ->> 'issue_status', '')) AS st, r.data ->> 'owner_user' AS owner_user, r.external_party_id, btrim(coalesce(r.data ->> 'blocked_gate_or_task', '')) AS blocked_on
    FROM public.register_records r JOIN _dsite s ON s.id = r.site_id AND NOT s.cancelled
    WHERE r.register_key = 'issues' AND r.is_current AND (p_scope IS NULL OR s.region_id = ANY (p_scope))
  ), o AS (
    SELECT i.*, public.dash_wd(i.raised, p_ref) AS age, coalesce(u.display_name, ep.name) AS owner_name,
           CASE WHEN i.owner_user IS NOT NULL THEN 'user:' || i.owner_user WHEN i.external_party_id IS NOT NULL THEN 'party:' || i.external_party_id::text ELSE 'none' END AS owner_key,
           CASE WHEN i.owner_user IS NOT NULL THEN 'user' WHEN i.external_party_id IS NOT NULL THEN 'party' ELSE 'none' END AS owner_kind
    FROM i LEFT JOIN public.users u ON u.id::text = i.owner_user LEFT JOIN public.external_parties ep ON ep.id = i.external_party_id
    WHERE i.raised IS NOT NULL AND i.raised <= p_ref AND (i.resolved IS NULL OR i.resolved > p_ref) AND (NOT live OR i.st !~ '^(closed|resolved|done|cancel)')
  )
  SELECT jsonb_build_object('available', true, 'open_total', (SELECT count(*) FROM o), 'sites_with_open_issue', (SELECT count(DISTINCT site_id) FROM o),
    'blocking_total', (SELECT count(*) FROM o WHERE blocked_on <> ''),
    'oldest_age_wd', (SELECT max(age) FROM o), 'avg_age_wd', (SELECT round(avg(age), 1) FROM o),
    'by_owner', coalesce((SELECT jsonb_agg(jsonb_build_object('owner_key', x.owner_key, 'owner_kind', x.owner_kind, 'owner_name', x.owner_name, 'count', x.n, 'sites', x.sites,
        'oldest_age_wd', x.oldest, 'avg_age_wd', x.avg_age) ORDER BY x.n DESC, x.oldest DESC, x.owner_name)
      FROM (SELECT owner_key, max(owner_kind) AS owner_kind, max(owner_name) AS owner_name, count(*) AS n, count(DISTINCT site_id) AS sites, max(age) AS oldest, round(avg(age), 1) AS avg_age FROM o GROUP BY owner_key) x), '[]'::jsonb),
    'age_buckets', jsonb_build_array(
      jsonb_build_object('key', '0_7', 'count', (SELECT count(*) FROM o WHERE age <= 7)),
      jsonb_build_object('key', '8_15', 'count', (SELECT count(*) FROM o WHERE age BETWEEN 8 AND 15)),
      jsonb_build_object('key', '16_30', 'count', (SELECT count(*) FROM o WHERE age BETWEEN 16 AND 30)),
      jsonb_build_object('key', 'over_30', 'count', (SELECT count(*) FROM o WHERE age > 30))))
  INTO out_;
  RETURN out_;
END $$;

-- Delay attribution (rules.md section 8, draft): overdue working days per responsible party. The party is the external party of the task, else the default
-- type of the task definition, else unassigned. Attribution periods and suspension days are not built yet, so the periods count is 0.
CREATE OR REPLACE FUNCTION dash_sec_delay() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH d AS (
    SELECT t.days_over, CASE WHEN t.external_party_id IS NOT NULL THEN 'party:' || t.external_party_id::text WHEN t.default_party IS NOT NULL THEN 'type:' || t.default_party ELSE 'unassigned' END AS pkey,
           coalesce(ep.name, t.default_party, 'unassigned') AS party, t.external_party_id, ep.type::text AS ptype
    FROM _dtask t LEFT JOIN public.external_parties ep ON ep.id = t.external_party_id WHERE t.phase <> 'none' AND t.cls = 'late' AND t.days_over > 0
  ), g AS (
    SELECT pkey, max(party) AS party, max(external_party_id::text) AS external_party_id, max(ptype) AS ptype, count(*) AS late_tasks, sum(days_over) AS wd FROM d GROUP BY pkey
  ), tot AS (SELECT coalesce(sum(wd), 0) AS wd, coalesce(sum(wd) FILTER (WHERE pkey = 'unassigned'), 0) AS un FROM g)
  SELECT jsonb_build_object('total_late_working_days', tot.wd, 'unattributed_pct', CASE WHEN tot.wd > 0 THEN round(tot.un * 100.0 / tot.wd, 2) ELSE 0 END,
    'overlapping_periods', 0, 'periods_supported', false,
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('party', g.party, 'external_party_id', g.external_party_id, 'party_type', g.ptype, 'late_tasks', g.late_tasks,
        'late_working_days', g.wd, 'share_pct', round(g.wd * 100.0 / nullif(tot.wd, 0), 2)) ORDER BY g.wd DESC, g.party) FROM g), '[]'::jsonb))
  INTO out_ FROM tot;
  RETURN out_;
END $$;

-- Health index (rules.md section 9, DRAFT, formula version 1): six factors, each at most 100; a factor with no data is left out and its weight redistributed.
-- Groups: 'all' and one per region. p_issue_scope / p_issues limit the issue part of factor I to what the caller may see.
CREATE OR REPLACE FUNCTION dash_sec_health(p_ref date, p_project_wide boolean, p_issue_scope integer[], p_issues boolean, p_rows_none jsonb, p_rows_region jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; ws uuid := public.weight_set_in_force('health_index', p_ref); bands jsonb := public.calc_setting('dashboard.health_bands', '{"green":85,"amber":70}'::jsonb);
  green numeric := coalesce((bands ->> 'green')::numeric, 85); amber numeric := coalesce((bands ->> 'amber')::numeric, 70);
BEGIN
  DROP TABLE IF EXISTS _dhf;
  CREATE TEMP TABLE _dhf (gk text, f text, v numeric) ON COMMIT DROP;
  -- P progress
  INSERT INTO _dhf SELECT x ->> 'key', 'P', (x ->> 'progress_pct')::numeric FROM jsonb_array_elements(p_rows_region) x;
  INSERT INTO _dhf SELECT 'all', 'P', (x ->> 'progress_pct')::numeric FROM jsonb_array_elements(p_rows_none) x;
  -- B baseline adherence
  INSERT INTO _dhf
    SELECT coalesce(s.region_id::text, 'all'), 'B', round(100.0 * count(*) FILTER (WHERE m.d <= m.base) / nullif(count(*), 0), 3)
    FROM _dms m JOIN _dsite s ON s.id = m.site_id AND NOT s.cancelled WHERE m.state = 'done' AND m.base IS NOT NULL GROUP BY GROUPING SETS ((), (s.region_id));
  -- S SLA adherence (completed SLA clocks within the maximum)
  INSERT INTO _dhf
    SELECT coalesce(region_id::text, 'all'), 'S', round(100.0 * count(*) FILTER (WHERE cls = 'on_time') / nullif(count(*), 0), 3)
    FROM _dtask WHERE phase = 'closed' AND cls IS NOT NULL GROUP BY GROUPING SETS ((), (region_id));
  -- D documentation completeness (mandatory slots of approved tasks)
  INSERT INTO _dhf
    SELECT coalesce(t.region_id::text, 'all'), 'D', round(100.0 * count(*) FILTER (WHERE ds.status = 'approved') / nullif(count(*), 0), 3)
    FROM _dtask t JOIN public.document_slots ds ON ds.task_id = t.id JOIN public.document_types dt ON dt.id = ds.doc_type_id AND dt.is_mandatory
    WHERE t.state = 'approved' AND t.done_date <= p_ref AND NOT t.admin_override GROUP BY GROUPING SETS ((), (t.region_id));
  -- F first-time approval (approved with no return)
  INSERT INTO _dhf
    SELECT coalesce(region_id::text, 'all'), 'F', round(100.0 * count(*) FILTER (WHERE return_count = 0) / nullif(count(*), 0), 3)
    FROM _dtask WHERE state = 'approved' AND done_date <= p_ref AND NOT admin_override GROUP BY GROUPING SETS ((), (region_id));
  -- I critical issues: 100 x (1 - sites with an open blocking item / active sites)
  INSERT INTO _dhf
    WITH blk AS (
      SELECT r.site_id FROM public.register_records r JOIN _dsite s ON s.id = r.site_id AND NOT s.cancelled
      WHERE p_issues AND r.register_key = 'issues' AND r.is_current AND (p_issue_scope IS NULL OR s.region_id = ANY (p_issue_scope))
        AND btrim(coalesce(r.data ->> 'blocked_gate_or_task', '')) <> '' AND nullif(r.data ->> 'raised_date', '')::date <= p_ref
        AND (nullif(r.data ->> 'resolution_date', '')::date IS NULL OR nullif(r.data ->> 'resolution_date', '')::date > p_ref)
        AND (p_ref <> public.cal_today() OR lower(coalesce(r.data ->> 'issue_status', '')) !~ '^(closed|resolved|done|cancel)')
      UNION SELECT sn.site_id FROM public.snags sn JOIN _dsite s ON s.id = sn.site_id AND NOT s.cancelled
      WHERE sn.status IN ('open', 'fix_uploaded', 'in_review') AND lower(coalesce(sn.severity, '')) IN ('major', 'critical') AND sn.raised_at::date <= p_ref
      UNION SELECT q.site_id FROM public.register_records q JOIN _dsite s ON s.id = q.site_id AND NOT s.cancelled
      WHERE q.register_key = 'quality' AND q.is_current AND lower(coalesce(q.data ->> 'blocking', '')) IN ('yes', 'true')
        AND lower(coalesce(q.data ->> 'result', '')) !~ '^(closed|cleared|released|pass|n/a)'
    )
    SELECT coalesce(s.region_id::text, 'all'), 'I', round(100.0 * (1 - count(*) FILTER (WHERE s.id IN (SELECT site_id FROM blk))::numeric / nullif(count(*), 0)), 3)
    FROM _dsite s WHERE NOT s.cancelled GROUP BY GROUPING SETS ((), (s.region_id));
  WITH w AS (SELECT a.code, a.name, a.name_ar, a.weight, a.sort FROM public.weight_activities a WHERE a.weight_set_id = ws),
  grp AS (
    SELECT g.gk, round(sum(w.weight * g.v) / nullif(sum(w.weight), 0), 2) AS score FROM _dhf g JOIN w ON w.code = g.f WHERE g.v IS NOT NULL GROUP BY g.gk
  ), allc AS (
    SELECT w.code, w.name, w.name_ar, w.weight, w.sort, (SELECT v FROM _dhf WHERE gk = 'all' AND f = w.code) AS v,
           (SELECT sum(w2.weight) FROM w w2 WHERE w2.code IN (SELECT f FROM _dhf WHERE gk = 'all' AND v IS NOT NULL)) AS used
    FROM w
  )
  SELECT jsonb_build_object(
    'draft', true, 'formula_version', 1, 'bands', jsonb_build_object('green', green, 'amber', amber),
    'score', (SELECT score FROM grp WHERE gk = 'all'),
    'band', (SELECT CASE WHEN score >= green THEN 'green' WHEN score >= amber THEN 'amber' ELSE 'red' END FROM grp WHERE gk = 'all'),
    'components', coalesce((SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name_en', a.name, 'name_ar', a.name_ar, 'weight', a.weight, 'value', a.v,
        'excluded', a.v IS NULL, 'contribution', CASE WHEN a.v IS NULL OR a.used IS NULL THEN 0 ELSE round(a.weight * a.v / a.used, 2) END) ORDER BY a.sort) FROM allc a), '[]'::jsonb),
    'by_region', coalesce((SELECT jsonb_agg(jsonb_build_object('region_id', g.gk::integer, 'score', g.score,
        'band', CASE WHEN g.score >= green THEN 'green' WHEN g.score >= amber THEN 'amber' ELSE 'red' END) ORDER BY g.gk::integer) FROM grp g WHERE g.gk <> 'all'), '[]'::jsonb))
  INTO out_;
  RETURN out_;
END $$;

-- Per region summary: sites, status counts, Project Status progress, milestones done, late open tasks.
CREATE OR REPLACE FUNCTION dash_sec_regions(p_health jsonb, p_with_sla boolean, p_rows_region jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; ps jsonb := p_rows_region;
BEGIN
  WITH r AS (
    SELECT s.region_id, count(*) FILTER (WHERE NOT s.cancelled) AS sites_total,
      count(*) FILTER (WHERE s.status = 'not_started') AS not_started, count(*) FILTER (WHERE s.status = 'in_progress') AS in_progress,
      count(*) FILTER (WHERE s.status = 'on_hold') AS on_hold, count(*) FILTER (WHERE s.status = 'completed') AS completed, count(*) FILTER (WHERE s.status = 'cancelled') AS cancelled
    FROM _dsite s GROUP BY s.region_id
  ), ms AS (
    SELECT s.region_id, jsonb_object_agg(x.code, x.n) AS by_ms FROM (
      SELECT m.code, s2.region_id, count(*) FILTER (WHERE m.state = 'done') AS n FROM _dms m JOIN _dsite s2 ON s2.id = m.site_id AND NOT s2.cancelled GROUP BY m.code, s2.region_id) x
    JOIN _dsite s ON s.region_id = x.region_id GROUP BY s.region_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'region_id', r.region_id, 'region_name', rg.name_en, 'region_name_ar', rg.name_ar, 'sites_total', r.sites_total, 'completed', r.completed,
      'in_progress', r.in_progress, 'late', CASE WHEN p_with_sla THEN (SELECT count(*) FROM _dtask t WHERE t.region_id = r.region_id AND t.phase = 'open' AND t.cls = 'late') ELSE 0 END,
      'by_overall_status', jsonb_build_object('not_started', r.not_started, 'in_progress', r.in_progress, 'on_hold', r.on_hold, 'completed', r.completed, 'cancelled', r.cancelled),
      'progress_pct', coalesce((SELECT (x ->> 'progress_pct')::numeric FROM jsonb_array_elements(ps) x WHERE x ->> 'key' = r.region_id::text), 0),
      'health_score', (SELECT (x ->> 'score')::numeric FROM jsonb_array_elements(coalesce(p_health -> 'by_region', '[]'::jsonb)) x WHERE (x ->> 'region_id')::int = r.region_id),
      'by_milestone', coalesce((SELECT ms.by_ms FROM ms WHERE ms.region_id = r.region_id), '{}'::jsonb)
    ) ORDER BY r.region_id), '[]'::jsonb)
  INTO out_ FROM r JOIN public.regions rg ON rg.id = r.region_id;
  RETURN out_;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Orchestration
-- ---------------------------------------------------------------------------------------------------------------------
-- The one place that builds the temporary tables and assembles the sections. Not callable by the application role.
--   p_sections  any of headline, pipeline, streams, sla, gates, issues, health, delay, regions, ps
--   p_snap      a date with a saved snapshot to read the headline facts from (NULL = dated facts)
--   p_group     for the ps section: none, region or site
CREATE OR REPLACE FUNCTION dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid,
  p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; wf_versions int[];
  rows_none jsonb; rows_region jsonb;
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  IF p_snap IS NULL AND (p_stream IS NOT NULL OR p_sections && ARRAY['streams']) THEN PERFORM public.dash_build_streams(p_ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  all_regions := p_scope IS NULL OR NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id <> ALL (p_scope));
  wide := all_regions AND p_region IS NULL AND p_cluster IS NULL AND p_scenario IS NULL AND p_stream IS NULL;
  need_tasks := p_sections && ARRAY['sla', 'delay', 'health', 'regions'];
  IF p_sections && ARRAY['headline', 'health', 'regions', 'ps'] THEN
    IF p_snap IS NOT NULL THEN
      SELECT weight_set_id INTO snap_ws FROM public.site_snapshots WHERE snapshot_date = p_snap AND weight_set_id IS NOT NULL LIMIT 1;
      ws := coalesce(p_ws, snap_ws, public.weight_set_in_force('project_status', p_ref));
      IF p_ws IS NULL AND snap_ws IS NOT NULL THEN PERFORM public.dash_build_items_snap(p_snap, ws); ELSE PERFORM public.dash_build_items(p_ref, ws, p_excl); END IF;
    ELSE
      ws := coalesce(p_ws, public.weight_set_in_force('project_status', p_ref));
      PERFORM public.dash_build_items(p_ref, ws, p_excl);
    END IF;
    rows_none := public.dash_ps_rows('none', wide);
    rows_region := public.dash_ps_rows('region', wide);
    ps_card := public.dash_ps_card(wide, rows_none);
  END IF;
  IF need_tasks THEN PERFORM public.dash_build_tasks(p_ref, p_stream, p_excl); END IF;

  SELECT array_agg(DISTINCT wd.version ORDER BY wd.version) INTO wf_versions FROM _dsite s JOIN public.workflow_definitions wd ON wd.id = s.wf;
  SELECT count(*) INTO flagged FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.admin_override;
  out_ := jsonb_build_object('meta', jsonb_build_object('project_wide', wide, 'workflow_versions', coalesce(to_jsonb(wf_versions), '[]'::jsonb), 'override_flagged_count', flagged,
    'overrides_excluded', p_excl, 'weight_set_id', ws));

  IF p_sections && ARRAY['headline'] THEN
    out_ := out_ || jsonb_build_object('headline', public.dash_sec_status(p_ref) || jsonb_build_object('final_closure', public.dash_sec_closure(p_ref), 'project_status', ps_card));
  END IF;
  IF p_sections && ARRAY['pipeline', 'headline'] THEN
    out_ := out_ || jsonb_build_object('milestones', public.dash_sec_milestones(p_ref, CASE WHEN p_stream IN (SELECT DISTINCT stream_code FROM _dms WHERE stream_code IS NOT NULL) THEN p_stream END));
  END IF;
  IF p_sections && ARRAY['streams'] THEN out_ := out_ || jsonb_build_object('streams', public.dash_sec_streams()); END IF;
  IF p_sections && ARRAY['sla'] THEN out_ := out_ || jsonb_build_object('sla', public.dash_sec_sla(p_ref)); END IF;
  IF p_sections && ARRAY['gates'] THEN out_ := out_ || jsonb_build_object('gates', public.dash_sec_gates(p_ref)); END IF;
  IF p_sections && ARRAY['issues'] THEN
    out_ := out_ || jsonb_build_object('issues', CASE WHEN p_issues THEN public.dash_sec_issues(p_ref, p_issue_scope) ELSE NULL END);
  END IF;
  IF p_sections && ARRAY['health', 'regions'] THEN hl := public.dash_sec_health(p_ref, wide, p_issue_scope, p_issues, rows_none, rows_region); END IF;
  IF p_sections && ARRAY['health'] THEN out_ := out_ || jsonb_build_object('health', hl); END IF;
  IF p_sections && ARRAY['delay'] THEN out_ := out_ || jsonb_build_object('delay', public.dash_sec_delay()); END IF;
  IF p_sections && ARRAY['regions'] THEN out_ := out_ || jsonb_build_object('regions', public.dash_sec_regions(hl, true, rows_region)); END IF;
  IF p_sections && ARRAY['ps'] THEN
    out_ := out_ || jsonb_build_object('ps', jsonb_build_object('card', ps_card, 'rows', CASE WHEN p_group = 'region' THEN rows_region WHEN p_group = 'site' THEN public.dash_ps_rows('site', wide) ELSE '[]'::jsonb END,
      'sites_in_scope', (SELECT count(*) FROM _dsite WHERE NOT cancelled)));
  END IF;
  RETURN out_;
END $$;

-- The caller's own regions for the dashboard (the permission grid: module dashboard, action view), and for the issues module.
CREATE OR REPLACE FUNCTION dash_actor_scope(OUT scope integer[], OUT issue_scope integer[], OUT issues_ok boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE isc integer[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'dashboard: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  scope := public.wf_actor_regions('dashboard', 'view');
  IF scope IS NOT NULL AND cardinality(scope) = 0 THEN RAISE EXCEPTION 'dashboard: you cannot view the dashboard' USING ERRCODE = 'insufficient_privilege'; END IF;
  isc := public.wf_actor_regions('issues', 'view');
  issues_ok := isc IS NULL OR cardinality(isc) > 0;
  IF NOT issues_ok THEN issue_scope := ARRAY[]::integer[];
  ELSIF isc IS NULL THEN issue_scope := scope;
  ELSIF scope IS NULL THEN issue_scope := isc;
  ELSE issue_scope := ARRAY(SELECT unnest(isc) INTERSECT SELECT unnest(scope)); END IF;
END $$;

-- GET /dashboard. p_ref NULL = today. A saved snapshot dated exactly p_ref is used for the headline facts (reported in meta.basis).
CREATE OR REPLACE FUNCTION dash_overview(p_ref date, p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a record; today date := public.cal_today(); ref date := coalesce(p_ref, today); snap date; res jsonb;
BEGIN
  SELECT * INTO a FROM public.dash_actor_scope();
  IF ref > today THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/ref_date', 'code', 'in_future', 'message', 'The reference date cannot be in the future.')))); END IF;
  IF ref < today AND EXISTS (SELECT 1 FROM public.site_snapshots WHERE snapshot_date = ref) THEN snap := ref; END IF;
  res := public.dash_core(ref, a.scope, p_region, p_cluster, p_scenario, p_stream, p_excl, NULL,
    ARRAY['headline', 'pipeline', 'streams', 'sla', 'gates', 'issues', 'health', 'delay', 'regions'], snap, 'none', a.issue_scope, a.issues_ok);
  RETURN res || jsonb_build_object('basis', jsonb_build_object('ref_date', ref, 'today', today,
    'source', CASE WHEN ref = today THEN 'live' WHEN snap IS NOT NULL THEN 'snapshot' ELSE 'as_of_computed' END,
    'snapshot_date', snap,
    'snapshots', coalesce((SELECT jsonb_agg(d ORDER BY d DESC) FROM (SELECT DISTINCT snapshot_date AS d FROM public.site_snapshots ORDER BY snapshot_date DESC LIMIT 60) q), '[]'::jsonb)));
END $$;

-- GET /project-status
CREATE OR REPLACE FUNCTION dash_project_status(p_ref date, p_region integer, p_site uuid, p_group text, p_ws uuid, p_excl boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a record; today date := public.cal_today(); ref date := coalesce(p_ref, today); res jsonb; ws uuid;
BEGIN
  SELECT * INTO a FROM public.dash_actor_scope();
  ws := coalesce(p_ws, public.weight_set_in_force('project_status', ref));
  res := public.dash_core(ref, a.scope, p_region, NULL, NULL, NULL, p_excl, ws, ARRAY['ps'], NULL, p_group, a.issue_scope, a.issues_ok);
  IF p_site IS NOT NULL THEN
    -- one site: its own counts (central items are dropped, as for any scope below the whole project)
    PERFORM public.dash_build_cal();
    DELETE FROM _dsite WHERE id <> p_site;
    DELETE FROM _dic WHERE site_id <> p_site;
    IF NOT EXISTS (SELECT 1 FROM _dsite) THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
    res := jsonb_set(res, '{ps,card}', public.dash_ps_card(false));
    res := jsonb_set(res, '{ps,sites_in_scope}', '1'::jsonb);
  END IF;
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Weekly snapshots
-- ---------------------------------------------------------------------------------------------------------------------
-- Stores, for the date p_date (as the dated facts give it): one row per site in site_snapshots, and one row per region and one for the whole project in
-- progress_snapshots with the Project Status result, the dashboard headline, the pipeline, the streams and the health index. Rows that exist stay as they are.
CREATE OR REPLACE FUNCTION dash_snapshot_take(p_date date) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ws uuid; n integer := 0; r record; res jsonb; excl boolean := coalesce((public.calc_setting('dashboard.exclude_overrides', 'true'::jsonb) #>> '{}')::boolean, true); card jsonb;
BEGIN
  IF p_date > public.cal_today() THEN RAISE EXCEPTION 'a snapshot cannot be taken for a future date' USING ERRCODE = 'check_violation'; END IF;
  ws := public.weight_set_in_force('project_status', p_date);
  PERFORM public.dash_build_cal();
  PERFORM public.dash_build_facts(p_date, NULL, NULL, NULL, NULL);
  PERFORM public.dash_build_streams(p_date);
  PERFORM public.dash_build_items(p_date, ws, excl);
  WITH per_site AS (
    SELECT (x ->> 'key') AS site_code, (x ->> 'progress_pct')::numeric AS pct FROM jsonb_array_elements(public.dash_ps_rows('site', false)) x
  ), ins AS (
    INSERT INTO site_snapshots (snapshot_date, site_id, region_id, cluster_code, scenario, weight_set_id, overall_status, ms, streams, items, progress_pct)
    SELECT p_date, s.id, s.region_id, s.cluster_code, s.scenario, ws, s.status,
      coalesce((SELECT jsonb_object_agg(m.code, jsonb_build_object('state', m.state, 'date', m.d, 'baseline', m.base, 'seq', m.seq, 'stream', m.stream_code, 'gate_open', m.gate_open, 'blocked', m.blocked))
                FROM _dms m WHERE m.site_id = s.id), '{}'::jsonb),
      coalesce((SELECT jsonb_object_agg(x.stream, x.status) FROM _dstr x WHERE x.site_id = s.id), '{}'::jsonb),
      coalesce((SELECT jsonb_object_agg(c.item, jsonb_build_array(c.done, c.applic, c.planned, c.plan_known)) FROM _dic c WHERE c.site_id = s.id), '{}'::jsonb),
      ps.pct
    FROM _dsite s LEFT JOIN per_site ps ON ps.site_code = s.site_code
    ON CONFLICT (snapshot_date, site_id) DO NOTHING RETURNING 1
  ) SELECT count(*) INTO n FROM ins;
  -- project and regions
  FOR r IN SELECT NULL::integer AS region_id UNION ALL SELECT id FROM public.regions ORDER BY 1 NULLS FIRST LOOP
    res := public.dash_core(p_date, NULL, r.region_id, NULL, NULL, NULL, excl, ws, ARRAY['headline', 'pipeline', 'streams', 'health', 'ps'], NULL, 'none', NULL, true);
    card := res #> '{ps,card}';
    INSERT INTO progress_snapshots (snapshot_date, weight_set_id, region_id, is_global, actual_pct, planned_pct, spi, plan_coverage, health_index, values)
    VALUES (p_date, ws, r.region_id, r.region_id IS NULL, coalesce((card ->> 'progress_pct')::numeric, 0), (card ->> 'planned_pct')::numeric, (card ->> 'spi')::numeric,
      (card ->> 'plan_coverage_pct')::numeric, (res #>> '{health,score}')::numeric,
      jsonb_build_object('headline', res -> 'headline', 'milestones', res -> 'milestones', 'streams', res -> 'streams', 'health', res -> 'health', 'project_status', card))
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN n;
END $$;

-- The daily job calls this: a snapshot is taken when the last one is at least dashboard.snapshot_every_days old (7), or none exists yet.
CREATE OR REPLACE FUNCTION dash_snapshot_weekly() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE every integer := coalesce((public.calc_setting('dashboard.snapshot_every_days', '7'::jsonb) #>> '{}')::integer, 7); last_ date; today date := public.cal_today();
BEGIN
  SELECT max(snapshot_date) INTO last_ FROM public.site_snapshots;
  IF last_ IS NULL OR today - last_ >= every THEN RETURN public.dash_snapshot_take(today); END IF;
  RETURN 0;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and rights. Everything that calculates runs as pmis_definer. pmis_app may call only the entry points.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'dash\_%' OR p.proname IN ('admin_save_weight_set', 'admin_preview_weight_set', 'admin_publish_weight_set'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname <> 'dash_wd' THEN EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig); END IF;
  END LOOP;
  -- admin_* functions are owned by the migration role like admin_save_holiday: they check app_actor_is_admin themselves; calc_audit does the audit insert as definer.
  ALTER FUNCTION admin_save_weight_set(uuid, text, uuid, text, jsonb, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION admin_preview_weight_set(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION admin_publish_weight_set(uuid, date, text, jsonb) OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dash_overview(date, integer, text, text, text, boolean) TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_project_status(date, integer, uuid, text, uuid, boolean) TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_snapshot_weekly() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_save_weight_set(uuid, text, uuid, text, jsonb, jsonb) TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_preview_weight_set(uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_publish_weight_set(uuid, date, text, jsonb) TO pmis_app;
    GRANT EXECUTE ON FUNCTION weight_set_json(uuid), weight_set_content(uuid), weight_set_in_force(text, date) TO pmis_app;
    -- weights and snapshots change only through the functions above
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON weight_sets, weight_activities, weight_items, progress_snapshots, site_snapshots FROM pmis_app;
    GRANT SELECT ON weight_sets, weight_activities, weight_items, progress_snapshots, site_snapshots TO pmis_app;
  END IF;
END $$;
