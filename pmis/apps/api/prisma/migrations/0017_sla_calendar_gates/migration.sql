-- 0017_sla_calendar_gates: the calculation layer (working-day calendar, SLA per task, milestone dates, gate conditions, permit validity).
-- Mirror: db/sql/016_sla_calendar_gates.sql (kept byte-identical).
--
-- Why in the database: the dates are derived data that must agree for every reader (task grid, site pipeline, exports, the Master
-- comparison), and pmis_app is read-mostly (ADR 0003 item 7). Writes of this layer run in SECURITY DEFINER functions (owner
-- pmis_definer, BYPASSRLS) with a fixed search_path; the readers are plain STABLE functions that run with the caller's rights.
-- The approval engine (wf_* functions of 0015/0016) is NOT redefined: SLA and milestones hook in through statement-level AFTER
-- triggers on task_instances and through functions the API calls.
--
-- Rules implemented (docs/spec/rules.md section 2 and 3; CLAUDE.md "Business rules"; owner answers Q38, Q48, Q54, Q62, Q63, E3, D2, D4, D5, D36):
--   * working days: weekend = work_calendars.weekend_days (default Friday + Saturday = NETWORKDAYS.INTL code 7) plus the holidays table;
--   * SLA: a task takes the rule version in force the day it opens, a start event date, target = start + min, due = start + max
--     (WORKDAY.INTL); elapsed = working days after the start; green <= min, amber <= max, red > max; closed tasks keep their values;
--   * milestone dates (E3): calculated from their tasks and gate, no approval of their own; Site RFI (Q38) is pre-filled, editable, approved;
--   * gates (D4, D36, Q62, Q63): the gate date is the previous milestone date (or later: the latest valid-from of the required
--     permits), a Suspension/Resumption in Change Control shifts it; required permits must be approved and valid on the gate date;
--   * permit expiry (Q63, Q63c): permit types carry Has Expiry; every permit record has its own choice; without expiry the permit is permanent.
--
-- Contents: 1 calendar functions  2 columns and tables  3 seeds  4 SLA functions  5 permits, gates and milestones  6 triggers
--           7 admin functions (holidays, weekend, SLA rule sets)  8 ownership and rights.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Working-day calendar. Weekend days use the same numbering as work_calendars.weekend_days (0 = Sunday ... 5 = Friday, 6 = Saturday).
--    p_cal NULL = the default calendar. All of them are STABLE: they read work_calendars and holidays only.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calc_setting(p_key text, p_default jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT value FROM public.settings WHERE key = p_key), p_default)
$$;

-- "Today" for the business (Africa/Tripoli by default; setting calc.timezone).
CREATE OR REPLACE FUNCTION cal_today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (now() AT TIME ZONE coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli'))::date
$$;

CREATE OR REPLACE FUNCTION cal_default() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT id FROM public.work_calendars WHERE is_default LIMIT 1
$$;

CREATE OR REPLACE FUNCTION cal_weekend(p_cal uuid DEFAULT NULL) RETURNS integer[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT weekend_days FROM public.work_calendars WHERE id = coalesce(p_cal, public.cal_default())), ARRAY[5, 6])
$$;

-- Weekend days inside [a, b] (arithmetic, no row per day). Requires a <= b.
CREATE OR REPLACE FUNCTION cal_weekend_count(p_a date, p_b date, p_we integer[]) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(sum(CASE WHEN p_a + x.off > p_b THEN 0 ELSE (p_b - (p_a + x.off)) / 7 + 1 END), 0)::integer
  FROM (SELECT (((k - extract(dow FROM p_a)::integer) % 7) + 7) % 7 AS off FROM (SELECT DISTINCT k FROM unnest(p_we) AS k) d) x
$$;

-- Holidays inside [a, b] that do not fall on a weekend day (a holiday on a weekend takes no working day away).
CREATE OR REPLACE FUNCTION cal_holiday_count(p_cal uuid, p_a date, p_b date, p_we integer[]) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT count(*)::integer FROM public.holidays h
  WHERE h.calendar_id = coalesce(p_cal, public.cal_default()) AND h.date BETWEEN p_a AND p_b AND NOT (extract(dow FROM h.date)::integer = ANY (p_we))
$$;

CREATE OR REPLACE FUNCTION cal_is_workday(p_date date, p_cal uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_date IS NOT NULL AND NOT (extract(dow FROM p_date)::integer = ANY (public.cal_weekend(p_cal)))
     AND NOT EXISTS (SELECT 1 FROM public.holidays h WHERE h.calendar_id = coalesce(p_cal, public.cal_default()) AND h.date = p_date)
$$;

-- NETWORKDAYS.INTL(a, b, weekend, holidays): working days from a to b, BOTH ends counted; negative when a > b.
CREATE OR REPLACE FUNCTION cal_networkdays(p_a date, p_b date, p_cal uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE we integer[];
BEGIN
  IF p_a IS NULL OR p_b IS NULL THEN RETURN NULL; END IF;
  IF p_a > p_b THEN RETURN -public.cal_networkdays(p_b, p_a, p_cal); END IF;
  we := public.cal_weekend(p_cal);
  RETURN (p_b - p_a + 1) - public.cal_weekend_count(p_a, p_b, we) - public.cal_holiday_count(p_cal, p_a, p_b, we);
END $$;

-- The SLA duration (rules.md section 3, SLA sheet formulas): the start day is not counted.
--   end > start: NETWORKDAYS.INTL(start + 1, end);  end = start: 0;  end < start: -NETWORKDAYS.INTL(end + 1, start).
CREATE OR REPLACE FUNCTION cal_workdays_between(p_a date, p_b date, p_cal uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_a IS NULL OR p_b IS NULL THEN RETURN NULL; END IF;
  IF p_b > p_a THEN RETURN public.cal_networkdays(p_a + 1, p_b, p_cal); END IF;
  IF p_b < p_a THEN RETURN -public.cal_networkdays(p_b + 1, p_a, p_cal); END IF;
  RETURN 0;
END $$;

-- WORKDAY.INTL(date, n, weekend, holidays). n = 0 returns the date itself (even on a weekend), as Excel does; a negative n goes back.
-- Fast: it jumps whole weeks arithmetically, then corrects for the holidays inside the stretch it jumped (a handful of loops at most).
CREATE OR REPLACE FUNCTION cal_add_workdays(p_date date, p_n integer, p_cal uuid DEFAULT NULL) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  we integer[]; w integer; cur date := p_date; rem integer; dir integer; cand date; h integer; nweeks integer; k integer; c uuid;
BEGIN
  IF p_date IS NULL OR p_n IS NULL THEN RETURN NULL; END IF;
  IF p_n = 0 THEN RETURN p_date; END IF;
  we := public.cal_weekend(p_cal);
  c := coalesce(p_cal, public.cal_default());
  w := 7 - (SELECT count(DISTINCT x) FROM unnest(we) AS x)::integer;
  IF w < 1 THEN RAISE EXCEPTION 'a calendar needs at least one working day' USING ERRCODE = 'check_violation'; END IF;
  dir := CASE WHEN p_n > 0 THEN 1 ELSE -1 END;
  rem := abs(p_n);
  LOOP
    nweeks := (rem - 1) / w;                              -- whole weeks (each has w working days) that can be skipped at once
    cand := cur + dir * nweeks * 7;
    k := rem - nweeks * w;                                -- 1 .. w working days still to walk, day by day (at most 7 steps)
    WHILE k > 0 LOOP
      cand := cand + dir;
      IF NOT (extract(dow FROM cand)::integer = ANY (we)) THEN k := k - 1; END IF;
    END LOOP;
    IF dir > 0 THEN h := public.cal_holiday_count(c, cur + 1, cand, we); ELSE h := public.cal_holiday_count(c, cand, cur - 1, we); END IF;
    IF h = 0 THEN RETURN cand; END IF;
    cur := cand;                                        -- every holiday on a working day inside the stretch costs one more working day
    rem := h;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Columns and tables
-- ---------------------------------------------------------------------------------------------------------------------
-- Calendars and holidays: version (ETag of the admin screens) and the confirmation of tentative dates (decision B12).
ALTER TABLE work_calendars ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ(6);
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS confirmed_by UUID;
ALTER TABLE holidays ADD CONSTRAINT holidays_date_range CHECK (date BETWEEN DATE '2020-01-01' AND DATE '2035-12-31');

CREATE OR REPLACE FUNCTION cal_bump_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER holidays_bump BEFORE UPDATE ON holidays FOR EACH ROW EXECUTE FUNCTION cal_bump_version();
CREATE TRIGGER work_calendars_bump BEFORE UPDATE ON work_calendars FOR EACH ROW EXECUTE FUNCTION cal_bump_version();

-- SLA rule: where the clock starts and ends. start_ref grammar (a closed set, validated by sla_start_ref_valid):
--   <task or milestone code>   the date of that task on the same site (the Site RFI milestone MS4 for D-1, rules.md section 3.1)
--   Gn                         the date of a gate (G4 for the RFI task)
--   PRED                       the latest date of the predecessors of the task
--   OPEN                       the day the task opens
--   DLP:<task>:<setting key>   the task date plus the DLP months of the setting (dlp.months.cw default 3, dlp.months.te default 12)
-- NULL = PRED (and OPEN when no predecessor has a date). end_ref NULL = the actual date of the task; 'gecol.installation_finish' and
-- 'hlc.installation_date' keep the Master SLA end events of C-2 and C-4 while the task itself closes on Power-On / TX Link Tested (Q54).
ALTER TABLE sla_rules ADD COLUMN IF NOT EXISTS start_ref TEXT;
ALTER TABLE sla_rules ADD COLUMN IF NOT EXISTS end_ref TEXT;
ALTER TABLE sla_rules ADD COLUMN IF NOT EXISTS code TEXT;                 -- SLA sheet code, for example D-1
ALTER TABLE sla_rules ADD COLUMN IF NOT EXISTS rule_set_id UUID;
ALTER TABLE sla_rules ADD CONSTRAINT sla_rules_end_ref_chk CHECK (end_ref IS NULL OR end_ref IN ('gecol.installation_finish', 'hlc.installation_date'));

-- The task keeps what its clock needs: start, target and due date (due_date exists since 0001), and, once closed, the end and the elapsed days.
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS sla_start_date DATE;
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS sla_target_date DATE;
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS sla_end_date DATE;
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS sla_elapsed_wd INTEGER;
CREATE INDEX IF NOT EXISTS task_instances_sla_open_idx ON task_instances (sla_start_date) WHERE sla_start_date IS NOT NULL;

-- Versions of the whole SLA rule set (contract 0.2.6). A published version is a full snapshot: it owns one sla_rules row per task
-- (and per override) from its effective date. A draft keeps its items here until it is published.
CREATE TABLE sla_rule_sets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version             INTEGER NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  effective_from      DATE,
  effective_to        DATE,
  base_version        INTEGER,
  reason              TEXT NOT NULL,
  created_by          UUID,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  published_by        UUID,
  published_at        TIMESTAMPTZ(6),
  apply_to_open_tasks BOOLEAN,
  apply_pending       BOOLEAN NOT NULL DEFAULT false,      -- publish with apply_to_open_tasks and a future effective date: applied on that day
  affected_open_tasks INTEGER,
  row_version         INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT sla_rule_sets_published_chk CHECK (status = 'draft' OR effective_from IS NOT NULL)
);
CREATE UNIQUE INDEX sla_rule_sets_one_draft ON sla_rule_sets ((true)) WHERE status = 'draft';

CREATE TABLE sla_rule_set_items (
  set_id           UUID NOT NULL REFERENCES sla_rule_sets (id) ON DELETE CASCADE,
  task_def_id      UUID NOT NULL REFERENCES task_definitions (id),
  min_working_days INTEGER NOT NULL,
  max_working_days INTEGER NOT NULL,
  start_ref        TEXT NOT NULL,
  end_ref          TEXT,
  calendar_id      UUID NOT NULL REFERENCES work_calendars (id),
  code             TEXT,
  overrides        JSONB NOT NULL DEFAULT '[]'::jsonb,     -- [{scenario, region_id, min_working_days, max_working_days}]
  PRIMARY KEY (set_id, task_def_id),
  CONSTRAINT sla_rule_set_items_min_max CHECK (min_working_days >= 0 AND max_working_days >= min_working_days)
);
ALTER TABLE sla_rules ADD CONSTRAINT sla_rules_rule_set_fkey FOREIGN KEY (rule_set_id) REFERENCES sla_rule_sets (id);
CREATE INDEX sla_rules_rule_set_idx ON sla_rules (rule_set_id);

-- Permit types (Master Setting tblPAType): Has Expiry is a fixed property of the type, filled by the owner (D36, Q63, Q63c).
CREATE TABLE permit_types (
  code       TEXT PRIMARY KEY,
  name_ar    TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('permit', 'access', 'ptw')),
  has_expiry BOOLEAN NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

-- Every permit record has its own "has expiry date" choice (Q63c). NULL = not chosen and the type is unknown: not valid (D36, DQ16).
-- Yes: the expiry date is required once the permit is approved. No: the permit is permanent and has no expiry date.
ALTER TABLE permit_records ADD COLUMN IF NOT EXISTS has_expiry BOOLEAN;
ALTER TABLE permit_records ADD CONSTRAINT permit_records_expiry_required CHECK (NOT (has_expiry IS TRUE AND lower(coalesce(status, '')) = 'approved' AND valid_to IS NULL));
ALTER TABLE permit_records ADD CONSTRAINT permit_records_permanent CHECK (NOT (has_expiry IS FALSE AND valid_to IS NOT NULL));
ALTER TABLE permit_records ADD CONSTRAINT permit_records_dates CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);

-- The type gives the default for the record's choice (Q63c); an explicit choice is kept.
CREATE OR REPLACE FUNCTION permit_default_expiry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.has_expiry IS NULL THEN
    NEW.has_expiry := (SELECT t.has_expiry FROM public.permit_types t WHERE t.code = NEW.permit_type);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER permit_records_default_expiry BEFORE INSERT OR UPDATE OF permit_type, has_expiry ON permit_records FOR EACH ROW EXECUTE FUNCTION permit_default_expiry();

ALTER TABLE permit_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_types FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON permit_types FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON permit_types FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE sla_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_rule_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON sla_rule_sets FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON sla_rule_sets FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE sla_rule_set_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_rule_set_items FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON sla_rule_set_items FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON sla_rule_set_items FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Seeds (idempotent, non-destructive). Runs as the migration role.
-- ---------------------------------------------------------------------------------------------------------------------
-- 3a. Permit types and Has Expiry. Q63 (owner decision): Yes for Security Clearance, Other, the five Access types and the three PTW
-- types; No for City Council and Civil Aviation. Names are the Master's PAType list.
INSERT INTO permit_types (code, kind, has_expiry, sort_order) VALUES
  ('City Council Permit', 'permit', false, 10),
  ('Civil Aviation Authority Permit', 'permit', false, 20),
  ('Security Clearance', 'permit', true, 30),
  ('Other Permit', 'permit', true, 40),
  ('Access - Survey', 'access', true, 50),
  ('Access - CW', 'access', true, 60),
  ('Access - TE', 'access', true, 70),
  ('Access - Dismantle', 'access', true, 80),
  ('Access - QC / Maintenance', 'access', true, 90),
  ('PTW - CW', 'ptw', true, 100),
  ('PTW - TE', 'ptw', true, 110),
  ('PTW - Dismantle', 'ptw', true, 120)
ON CONFLICT (code) DO NOTHING;
UPDATE permit_records p SET has_expiry = t.has_expiry FROM permit_types t WHERE t.code = p.permit_type AND p.has_expiry IS NULL;

-- 3b. SLA start and end events of the seeded rule set (Master SLA sheet row 4 "From -> To", mapped to task codes of workflow v1).
-- "OPEN" = the start event is a register field the PMIS does not read yet (search ring, TSSR submission, MOP, cutover window): the
-- clock starts the day the task opens (open question in the report). The 5 planning links and E2E rows follow the SLA sheet.
UPDATE sla_rules r SET start_ref = v.start_ref, end_ref = v.end_ref, code = v.sla_code
FROM (VALUES
  ('A1', 'OPEN', NULL, 'A-1'), ('A2', 'OPEN', NULL, 'A-3'), ('B1', 'MS1', NULL, 'B01'), ('B2', 'B1', NULL, 'B-2'), ('B3', 'B2', NULL, 'B-3'),
  ('B4', 'B3', NULL, 'B-4'), ('B5', 'B4', NULL, 'B-5'), ('B6', 'PRED', NULL, 'B-6'), ('B7', 'B6', NULL, 'B-7'), ('B8', 'B7', NULL, 'B-8'),
  ('B9', 'B7', NULL, 'B-9'), ('B10', 'B8', NULL, 'B-10'), ('B11', 'B9', NULL, 'B-11'), ('B13', 'MS3', NULL, 'B-13'), ('C1', 'B1', NULL, 'B02'),
  ('C2', 'C1', 'gecol.installation_finish', 'C-2'), ('C3', 'B1', NULL, 'B03'), ('C4', 'C3', 'hlc.installation_date', 'C-4'), ('MS4', 'G4', NULL, 'RFI'),
  ('D1', 'MS4', NULL, 'D-1'), ('D2', 'D1', NULL, 'D-2'), ('D3', 'D2', NULL, 'D-3'), ('D4', 'D3', NULL, 'D-4'), ('D4b', 'D4', NULL, 'B04'),
  ('D5', 'D4b', NULL, 'D-5'), ('D6', 'D5', NULL, 'D-6'), ('D7', 'D6', NULL, 'D-7'), ('D8', 'D7', NULL, 'D-8'), ('D9', 'D8', NULL, 'D-9'),
  ('D10a', 'OPEN', NULL, 'S-1'), ('D10b', 'OPEN', NULL, 'S-2'), ('D10', 'D9', NULL, 'D-10'), ('MS6', 'D5', NULL, 'E2E-D1'), ('D11', 'MS6', NULL, 'D-11'),
  ('D12', 'MS6', NULL, 'D-12'), ('D13', 'D12', NULL, 'D-13'), ('D14', 'D13', NULL, 'D-14'), ('D15', 'D14', NULL, 'D-15'), ('D16', 'PRED', NULL, 'D-16'),
  ('F1', 'MS7', NULL, 'B05'), ('D17', 'MS8', NULL, 'D-17'), ('MS9', 'D1', NULL, 'E2E-D2'), ('B15', 'DLP:B13:dlp.months.cw', NULL, 'B-15'),
  ('D18', 'DLP:D16:dlp.months.te', NULL, 'B06'), ('Z1', 'PRED', NULL, 'B07'), ('E2', 'MS6', NULL, 'S-5')
) AS v(task_code, start_ref, end_ref, sla_code)
JOIN task_definitions td ON td.code = v.task_code
WHERE r.task_def_id = td.id AND r.start_ref IS NULL;

-- 3c. The seeded rule set becomes version 1 of the rule set (full snapshot: one item per task).
INSERT INTO sla_rule_sets (version, status, effective_from, reason, created_at, published_at, apply_to_open_tasks, affected_open_tasks)
SELECT 1, 'published', DATE '2024-01-01', 'seed: SLA rule-set v1', now(), now(), false, 0
WHERE NOT EXISTS (SELECT 1 FROM sla_rule_sets);
UPDATE sla_rules SET rule_set_id = (SELECT id FROM sla_rule_sets WHERE version = 1) WHERE rule_set_id IS NULL;
INSERT INTO sla_rule_set_items (set_id, task_def_id, min_working_days, max_working_days, start_ref, end_ref, calendar_id, code)
SELECT (SELECT id FROM sla_rule_sets WHERE version = 1), r.task_def_id, r.min_working_days, r.max_working_days, coalesce(r.start_ref, 'PRED'), r.end_ref, r.calendar_id, r.code
FROM sla_rules r WHERE r.scenario IS NULL AND r.region_id IS NULL AND r.rule_set_id = (SELECT id FROM sla_rule_sets WHERE version = 1)
ON CONFLICT (set_id, task_def_id) DO NOTHING;

-- 3d. Gate conditions of the default workflow (Master AX, CA, DQ): permits that must be approved and valid on the gate date (or approved
-- N/A with reason and approver, D36), and the PTW stop work that holds the gate. G6 (Commissioning Power Safe Date) stays without a
-- condition: Readiness & Handover holds a yes/no for it, not a date (open question in the report).
UPDATE phase_gate_rules SET conditions = '[{"type":"permit","ref":"Access - CW","accept_na":true},{"type":"permit","ref":"PTW - CW","accept_na":true},{"type":"stop_work_blocks","ref":"PTW - CW"}]'::jsonb
WHERE link_code = 'G3' AND conditions IS NULL;
UPDATE phase_gate_rules SET conditions = '[{"type":"permit","ref":"Access - TE","accept_na":true},{"type":"permit","ref":"PTW - TE","accept_na":true},{"type":"stop_work_blocks","ref":"PTW - TE"}]'::jsonb
WHERE link_code = 'G5' AND conditions IS NULL;
UPDATE phase_gate_rules SET conditions = '[{"type":"stop_work_blocks","ref":"PTW - TE"}]'::jsonb
WHERE link_code = 'G7' AND conditions IS NULL;

-- 3e. Calculation settings (all editable in Settings; the functions read them with these defaults when a key is absent).
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('calc.timezone', '"Africa/Tripoli"', 'Time zone of "today" for SLA ages and effective dates.', now()),
  ('calc.milestone_manual', '["MS4"]', 'Milestones that are pre-filled and then approved (Q38). All others are calculated with no approval of their own (E3).', now()),
  ('calc.milestone_ge_gate', '["MS3","MS5","MS6","MS7","MS8","MS9","MS10"]', 'Milestones that stay uncalculated when their latest condition date is earlier than their gate (Master BP, CU, DP, EL, ES, EY, FM).', now()),
  ('calc.rfi_not_before_gate', 'true', 'The edited Site RFI date may not be earlier than the RFI Readiness gate (rules.md section 2.1, ASSUMPTION).', now()),
  ('calc.baseline_include_d1', 'true', 'Baseline proposal: add D-1 (TE Access) to the TE Completion proposal (Q48). The parallel run tags the difference "D-1 added".', now()),
  ('calc.ptw_hse_check_keys', '[]', 'Keys of the PTW hse_checks that must be Done or N/A before a PTW counts (Master Permits U). Empty = the checks are not evaluated.', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. SLA functions
-- ---------------------------------------------------------------------------------------------------------------------
-- green until min, amber until max, red after max (rules.md section 3; BP section 06). Both limits are inclusive.
CREATE OR REPLACE FUNCTION sla_colour(p_elapsed integer, p_min integer, p_max integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_elapsed IS NULL OR p_min IS NULL OR p_max IS NULL THEN 'none'
              WHEN p_elapsed <= p_min THEN 'green' WHEN p_elapsed <= p_max THEN 'amber' ELSE 'red' END
$$;

-- Is this a code the start event may name? Task and milestone codes of the workflow, gate codes, and the reserved words.
CREATE OR REPLACE FUNCTION sla_start_ref_valid(p_ref text, p_workflow uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_ref IS NULL THEN false
    WHEN p_ref IN ('PRED', 'OPEN') THEN true
    WHEN p_ref LIKE 'DLP:%:%' THEN EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = split_part(p_ref, ':', 2)) AND split_part(p_ref, ':', 3) <> ''
    WHEN p_ref ~ '^G[0-9]+$' THEN EXISTS (SELECT 1 FROM public.phase_gate_rules g WHERE g.workflow_id = p_workflow AND g.link_code = p_ref)
    ELSE EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = p_ref)
  END
$$;

-- The date of a task on a site, for starting another clock: its actual date once approved. A task that is N/A or skipped hands over
-- the latest date of its own predecessors (D-9 without MW starts from Commissioning; D-1 starts from MS1 where the RFI is N/A).
CREATE OR REPLACE FUNCTION sla_task_date(p_site uuid, p_code text, p_depth integer DEFAULT 0) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE r record; d date;
BEGIN
  IF p_depth > 12 THEN RETURN NULL; END IF;
  SELECT ti.state, ti.actual_date, ti.approved_date, ti.task_def_id INTO r
  FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
  WHERE ti.site_id = p_site AND td.code = p_code;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.state = 'approved' THEN RETURN coalesce(r.actual_date, r.approved_date); END IF;
  IF r.state IN ('na', 'skipped') THEN
    SELECT max(public.sla_task_date(p_site, pd.code, p_depth + 1)) INTO d
    FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id WHERE tp.task_def_id = r.task_def_id;
    RETURN d;
  END IF;
  RETURN NULL;
END $$;

-- Start event date of a task for a rule's start_ref. NULL = the event has not happened yet (the clock waits).
CREATE OR REPLACE FUNCTION sla_resolve_start(p_task uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; d date; months integer; key text; today date := public.cal_today();
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_ref IS NULL OR p_ref = 'PRED' THEN
    SELECT max(public.sla_task_date(t.site_id, pd.code)) INTO d
    FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id WHERE tp.task_def_id = t.task_def_id;
    RETURN coalesce(d, today);
  ELSIF p_ref = 'OPEN' THEN
    RETURN today;
  ELSIF p_ref ~ '^G[0-9]+$' THEN
    RETURN (SELECT g.gate_date FROM public.gate_eval(t.site_id, p_ref) g);
  ELSIF p_ref LIKE 'DLP:%:%' THEN
    key := split_part(p_ref, ':', 3);
    months := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, CASE WHEN key = 'dlp.months.cw' THEN 3 ELSE 12 END);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE (d + make_interval(months => months))::date END;
  END IF;
  RETURN public.sla_task_date(t.site_id, p_ref);
END $$;

-- Opens the clock of a task: the rule version in force today, the start event date, target = start + min, due = start + max.
-- Idempotent: once a start date is set the task keeps its version and start (reassignment never resets it, CLAUDE.md B12b).
-- A start event that has not happened yet (a gate still closed) leaves only the rule; calc_refresh_site retries.
CREATE OR REPLACE FUNCTION sla_task_open(p_task uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; s public.sites%ROWTYPE; r public.sla_rules%ROWTYPE; rid uuid; st date;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.sla_start_date IS NOT NULL THEN RETURN; END IF;
  SELECT * INTO s FROM public.sites WHERE id = t.site_id;
  rid := public.sla_rule_for(t.task_def_id, s.delivery_scenario, t.region_id, public.cal_today());
  IF rid IS NULL THEN rid := t.sla_rule_id; END IF;
  IF rid IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = rid;
  st := public.sla_resolve_start(p_task, r.start_ref);
  UPDATE public.task_instances SET sla_rule_id = rid, sla_start_date = st,
    sla_target_date = CASE WHEN st IS NULL THEN NULL ELSE public.cal_add_workdays(st, r.min_working_days, r.calendar_id) END,
    due_date = CASE WHEN st IS NULL THEN due_date ELSE public.cal_add_workdays(st, r.max_working_days, r.calendar_id) END,
    sla_end_date = NULL, sla_elapsed_wd = NULL, updated_at = now()
  WHERE id = p_task;
END $$;

-- Closes the clock when the task is approved: the end event, the elapsed working days (kept from then on).
CREATE OR REPLACE FUNCTION sla_task_close(p_task uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.sla_rules%ROWTYPE; e date;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.state IN ('na', 'skipped') THEN
    UPDATE public.task_instances SET due_date = NULL, sla_target_date = NULL, sla_start_date = NULL, sla_end_date = NULL, sla_elapsed_wd = NULL WHERE id = p_task;
    RETURN;
  END IF;
  IF t.sla_start_date IS NULL OR t.sla_rule_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = t.sla_rule_id;
  e := CASE r.end_ref
         WHEN 'gecol.installation_finish' THEN coalesce((SELECT g.installation_finish FROM public.gecol_records g WHERE g.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'hlc.installation_date' THEN coalesce((SELECT h.installation_date FROM public.hlc_records h WHERE h.site_id = t.site_id), t.actual_date, t.approved_date)
         ELSE coalesce(t.actual_date, t.approved_date) END;
  UPDATE public.task_instances SET sla_end_date = e, sla_elapsed_wd = public.cal_workdays_between(t.sla_start_date, e, r.calendar_id) WHERE id = p_task;
END $$;

-- Elapsed working days and colour of a task now. Running: start to today. Closed: the value kept at approval.
CREATE OR REPLACE FUNCTION sla_status(p_task uuid, OUT elapsed_wd integer, OUT colour text)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.sla_rules%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.sla_rule_id IS NULL OR t.sla_start_date IS NULL THEN colour := 'none'; RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = t.sla_rule_id;
  elapsed_wd := CASE WHEN t.state = 'approved' THEN t.sla_elapsed_wd
                     WHEN t.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') THEN public.cal_workdays_between(t.sla_start_date, public.cal_today(), r.calendar_id)
                     ELSE NULL END;
  colour := public.sla_colour(elapsed_wd, r.min_working_days, r.max_working_days);
END $$;

-- Recomputes target and due date of the OPEN tasks (not locked, approved, N/A or skipped): after a holiday or weekend change, after
-- an SLA version is applied. The start date and the rule version stay. p_from / p_to bound the dates that moved (NULL = all).
-- Returns the number of tasks whose due date changed. Closed tasks keep their values (CLAUDE.md B12).
CREATE OR REPLACE FUNCTION sla_recalc_open(p_cal uuid DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  WITH c AS (
    SELECT ti.id, public.cal_add_workdays(ti.sla_start_date, r.max_working_days, r.calendar_id) AS due,
           public.cal_add_workdays(ti.sla_start_date, r.min_working_days, r.calendar_id) AS tgt
    FROM public.task_instances ti JOIN public.sla_rules r ON r.id = ti.sla_rule_id
    WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND ti.sla_start_date IS NOT NULL
      AND (p_cal IS NULL OR r.calendar_id = p_cal)
      AND (p_to IS NULL OR ti.sla_start_date <= p_to) AND (p_from IS NULL OR ti.due_date >= p_from)
  ), u AS (
    UPDATE public.task_instances x SET due_date = c.due, sla_target_date = c.tgt, updated_at = now()
    FROM c WHERE x.id = c.id AND (x.due_date IS DISTINCT FROM c.due OR x.sla_target_date IS DISTINCT FROM c.tgt)
    RETURNING (x.due_date IS DISTINCT FROM c.due) AS dummy
  )
  SELECT count(*) INTO n FROM u;
  PERFORM set_config('pmis.sla_affected', (coalesce(nullif(current_setting('pmis.sla_affected', true), '')::integer, 0) + n)::text, true);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Permits, gates and milestones
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION permit_is_ptw(p_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT t.kind = 'ptw' FROM public.permit_types t WHERE t.code = p_type), left(p_type, 3) = 'PTW')
$$;

-- N/A for this site, accepted by the gate only with a reason and an approver (D36).
CREATE OR REPLACE FUNCTION permit_na_ok(p public.permit_records) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT lower(coalesce(p.status, '')) = 'n/a' AND btrim(coalesce(p.na_reason, '')) <> '' AND btrim(coalesce(p.na_approved_by, '')) <> ''
$$;

-- Valid on a date (Q62, D36): approved, valid from on or before the date, and, when the permit expires, valid to on or after it.
-- No expiry (has_expiry = false) means permanent. has_expiry NULL (unknown type) counts as expiring if a valid-to exists, else not valid.
CREATE OR REPLACE FUNCTION permit_valid_on(p public.permit_records, p_on date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT lower(coalesce(p.status, '')) = 'approved' AND p.valid_from IS NOT NULL AND p.valid_from <= p_on
     AND CASE WHEN p.has_expiry IS FALSE THEN true
              ELSE p.valid_to IS NOT NULL AND p.valid_to >= p_on END
$$;

-- The date from which an approved permit counts for a gate (Master Permits U for PTW types: the HSE checks done and the stop work
-- lifted; the date is the later of valid from and the lift date). NULL = it does not count (not approved, no valid from, checks open, stop work active).
CREATE OR REPLACE FUNCTION permit_start(p public.permit_records) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE k text;
BEGIN
  IF lower(coalesce(p.status, '')) <> 'approved' OR p.valid_from IS NULL THEN RETURN NULL; END IF;
  IF NOT public.permit_is_ptw(p.permit_type) THEN RETURN p.valid_from; END IF;
  FOR k IN SELECT jsonb_array_elements_text(public.calc_setting('calc.ptw_hse_check_keys', '[]'::jsonb)) LOOP
    IF coalesce(p.hse_checks ->> k, '') NOT IN ('Done', 'N/A') THEN RETURN NULL; END IF;
  END LOOP;
  IF p.stop_work THEN
    IF p.stop_lifted_date IS NULL THEN RETURN NULL; END IF;
    RETURN greatest(p.valid_from, p.stop_lifted_date);
  END IF;
  RETURN p.valid_from;
END $$;

-- The milestone of a stage on a site: 'approved' with its date, 'pending' (not dated yet), or 'na' (the stage does not apply and no
-- earlier stage has a date). A milestone that is N/A hands over the one before it (G4 = MS3 if CW applies, else MS2; G5 = MS4 or MS1).
CREATE OR REPLACE FUNCTION ms_resolve(p_site uuid, p_stage_code text, OUT state text, OUT ms_date date, OUT stage_code text)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; st record; ti record; n integer := 0;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN state := 'na'; RETURN; END IF;
  SELECT id, seq, code INTO st FROM public.stage_definitions WHERE workflow_id = s.workflow_version_id AND code = p_stage_code;
  WHILE FOUND AND n < 12 LOOP
    n := n + 1;
    SELECT ti2.state AS st, ti2.actual_date AS d INTO ti
    FROM public.task_instances ti2 JOIN public.task_definitions td ON td.id = ti2.task_def_id
    WHERE ti2.site_id = p_site AND td.stage_id = st.id AND td.is_milestone_task LIMIT 1;
    IF NOT FOUND THEN state := 'pending'; stage_code := st.code; RETURN; END IF;
    IF ti.st = 'approved' THEN state := 'approved'; ms_date := ti.d; stage_code := st.code; RETURN; END IF;
    IF ti.st NOT IN ('na', 'skipped') THEN state := 'pending'; stage_code := st.code; RETURN; END IF;
    SELECT id, seq, code INTO st FROM public.stage_definitions WHERE workflow_id = s.workflow_version_id AND seq = st.seq - 1;
  END LOOP;
  state := 'na';
END $$;

-- A gate on a site (D4, D36, Q62, Q63; rules.md section 2.2 and 2.3).
--   status     open     the gate has a date;  pending  the previous milestone has no date yet;  blocked  a condition holds it;  na  does not apply
--   gate_date  the previous milestone date, or the latest start of the required permits when later, shifted by a Suspension/Resumption
--   base_date  the previous milestone date;  shifted  true when Change Control moved it;  reasons  LockReason items for the screen
-- Required permits (conditions of type "permit") must be approved and valid on the gate date; an approved N/A with reason and approver
-- also satisfies (accept_na). A gate has no SLA of its own (D4).
CREATE OR REPLACE FUNCTION gate_eval(p_site uuid, p_gate text, OUT status text, OUT gate_date date, OUT base_date date, OUT shifted boolean, OUT reasons jsonb)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; g public.phase_gate_rules%ROWTYPE; m record; cond jsonb; g0 date; d date; nd date; i integer; rs jsonb; blocked boolean;
  ptype text; best date; sdate date; rdate date; r1 date; b date;
BEGIN
  reasons := '[]'::jsonb; shifted := false;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN status := 'na'; RETURN; END IF;
  SELECT * INTO g FROM public.phase_gate_rules WHERE workflow_id = s.workflow_version_id AND link_code = p_gate AND is_active;
  IF NOT FOUND THEN status := 'na'; RETURN; END IF;
  SELECT * INTO m FROM public.ms_resolve(p_site, g.from_code);
  IF m.state = 'na' THEN status := 'na'; RETURN; END IF;
  IF m.state = 'pending' THEN
    status := 'pending';
    reasons := jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', coalesce(m.stage_code, g.from_code),
      'message', 'The milestone ' || coalesce(m.stage_code, g.from_code) || ' has no date yet.', 'count', NULL));
    RETURN;
  END IF;
  g0 := m.ms_date; base_date := g0; d := g0;
  FOR i IN 1..20 LOOP
    nd := g0; blocked := false; rs := '[]'::jsonb;
    FOR cond IN SELECT * FROM jsonb_array_elements(coalesce(g.conditions, '[]'::jsonb)) LOOP
      ptype := cond ->> 'ref';
      IF cond ->> 'type' = 'permit' THEN
        IF coalesce((cond ->> 'accept_na')::boolean, true)
           AND EXISTS (SELECT 1 FROM public.permit_records pr WHERE pr.site_id = p_site AND pr.permit_type = ptype AND public.permit_na_ok(pr)) THEN
          CONTINUE;                                          -- approved N/A for this site (D36)
        END IF;
        SELECT min(public.permit_start(pr)) INTO best FROM public.permit_records pr
        WHERE pr.site_id = p_site AND pr.permit_type = ptype AND public.permit_start(pr) IS NOT NULL
          AND public.permit_valid_on(pr, greatest(d, public.permit_start(pr)));
        IF best IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype,
            'message', ptype || ' must be approved and valid on the gate date.', 'count', NULL));
        ELSE
          nd := greatest(nd, best);
        END IF;
      ELSIF cond ->> 'type' = 'stop_work_blocks' THEN
        IF EXISTS (SELECT 1 FROM public.permit_records pr WHERE pr.site_id = p_site AND pr.permit_type = ptype AND pr.stop_work AND pr.stop_lifted_date IS NULL) THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'stop_work', 'ref_code', ptype, 'message', 'Stop work is active on ' || ptype || '.', 'count', NULL));
        END IF;
      ELSIF cond ->> 'type' = 'milestone' THEN
        SELECT * INTO m FROM public.ms_resolve(p_site, ptype);
        IF m.state = 'approved' THEN nd := greatest(nd, m.ms_date);
        ELSIF m.state = 'pending' THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', ptype, 'message', 'The milestone ' || ptype || ' has no date yet.', 'count', NULL));
        END IF;
      ELSIF cond ->> 'type' = 'task' THEN
        b := public.sla_task_date(p_site, ptype);
        IF b IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', ptype, 'message', 'Task ' || ptype || ' is not approved yet.', 'count', NULL));
        ELSE nd := greatest(nd, b); END IF;
      ELSE
        blocked := true;
        rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype, 'message', 'The condition type ' || coalesce(cond ->> 'type', '?') || ' is not supported.', 'count', NULL));
      END IF;
    END LOOP;
    EXIT WHEN nd = d;
    d := nd;
  END LOOP;
  reasons := rs;
  IF blocked THEN status := 'blocked'; RETURN; END IF;

  -- Change Control (rules.md section 2.3): suspended on the candidate date -> the gate moves to the next approved resumption, or stays locked.
  SELECT max(c.approval_date) FILTER (WHERE c.kind = 'suspension'), max(c.approval_date) FILTER (WHERE c.kind = 'resumption')
    INTO sdate, rdate
  FROM public.change_requests c WHERE c.site_id = p_site AND c.status IN ('approved', 'applied') AND c.approval_date IS NOT NULL AND c.approval_date <= d;
  IF sdate IS NOT NULL AND (rdate IS NULL OR sdate > rdate) THEN
    SELECT min(c.approval_date) INTO r1 FROM public.change_requests c
    WHERE c.site_id = p_site AND c.kind = 'resumption' AND c.status IN ('approved', 'applied') AND c.approval_date > sdate;
    IF r1 IS NULL THEN
      status := 'blocked';
      reasons := reasons || jsonb_build_array(jsonb_build_object('kind', 'suspension', 'ref_code', NULL, 'message', 'The site is suspended since ' || sdate::text || ' and has no approved resumption.', 'count', NULL));
      RETURN;
    END IF;
    gate_date := r1; shifted := true;
  ELSE
    gate_date := d;
  END IF;
  status := 'open';
END $$;

-- Can the milestone task be calculated now, and to which date? (E3, Master milestone formulas, catalogue notes.)
-- Needs every predecessor approved or N/A, the gate before the stage open, and then
--   date = the latest of the gate date and the dates of the predecessors that count toward the milestone (MS2 = MAX(W, ...), MS4 = MAX(BQ, ...)).
-- Stages in calc.milestone_ge_gate (BP, CU, DP, EL, ES, EY, FM) stay uncalculated when that latest condition date lies before the gate.
CREATE OR REPLACE FUNCTION ms_evaluate(p_task uuid, OUT ready boolean, OUT ms_date date, OUT reasons jsonb)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  t public.task_instances%ROWTYPE; st record; g record; gate_rule public.phase_gate_rules%ROWTYPE; s public.sites%ROWTYPE; pr record; cand date; gd date;
BEGIN
  ready := false; reasons := '[]'::jsonb;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO s FROM public.sites WHERE id = t.site_id;
  SELECT sd.id, sd.code INTO st FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id WHERE td.id = t.task_def_id;
  FOR pr IN
    SELECT pd.code, pi.state AS pstate, pi.actual_date AS pdate, pd.counts_toward_milestone AS counts
    FROM public.task_predecessors tp
    JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
    JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
    WHERE tp.task_def_id = t.task_def_id
  LOOP
    IF pr.pstate NOT IN ('approved', 'na', 'skipped') THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', pr.code, 'message', 'Task ' || pr.code || ' is not approved yet.', 'count', NULL));
    ELSIF pr.pstate = 'approved' AND pr.counts AND pr.pdate IS NOT NULL THEN
      cand := greatest(cand, pr.pdate);
    END IF;
  END LOOP;
  IF jsonb_array_length(reasons) > 0 THEN RETURN; END IF;
  SELECT * INTO gate_rule FROM public.phase_gate_rules WHERE workflow_id = s.workflow_version_id AND to_code = st.code AND is_active LIMIT 1;
  IF FOUND THEN
    SELECT * INTO g FROM public.gate_eval(t.site_id, gate_rule.link_code);
    IF g.status = 'open' THEN gd := g.gate_date;
    ELSIF g.status = 'na' THEN gd := NULL;
    ELSE
      reasons := g.reasons;
      IF jsonb_array_length(reasons) = 0 THEN
        reasons := jsonb_build_array(jsonb_build_object('kind', 'gate_closed', 'ref_code', gate_rule.link_code, 'message', 'The gate ' || gate_rule.link_code || ' is not open.', 'count', NULL));
      END IF;
      RETURN;
    END IF;
  END IF;
  IF gd IS NOT NULL AND cand IS NOT NULL AND cand < gd
     AND st.code IN (SELECT jsonb_array_elements_text(public.calc_setting('calc.milestone_ge_gate', '[]'::jsonb))) THEN
    reasons := jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', gate_rule.link_code,
      'message', 'The latest condition date ' || cand::text || ' is before the gate date ' || gd::text || '.', 'count', NULL));
    RETURN;
  END IF;
  ms_date := greatest(gd, cand);
  ready := ms_date IS NOT NULL;
END $$;

-- Raises the same error format as the approval engine (wf:<code>:<json>, SQLSTATE P0001) so the API answers 422.
CREATE OR REPLACE FUNCTION calc_err(p_code text, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'wf:%:%', p_code, p_extra::text USING ERRCODE = 'P0001';
END $$;

-- Brings the calculated dates of one site up to date: completes the calculated milestones that are ready (state approved, no approval
-- of their own), pre-fills the manual one (Site RFI), updates calculated dates that moved, and starts clocks that were waiting for
-- their start event. Called by the triggers below; safe to call by hand (the API does after a register change).
CREATE OR REPLACE FUNCTION calc_refresh_site(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  changed integer := 0; round_ integer := 0; progress boolean; m record; ev record; manual jsonb; before jsonb; pre date; sid uuid;
BEGIN
  IF current_setting('pmis.calc_busy', true) = '1' THEN RETURN 0; END IF;
  PERFORM set_config('pmis.calc_busy', '1', true);
  manual := public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb);
  LOOP
    progress := false; round_ := round_ + 1;
    EXIT WHEN round_ > 25;
    FOR m IN
      SELECT ti.id, ti.state, ti.actual_date, ti.admin_override, ti.values, ti.levels_required, ti.version, sd.code AS stage_code, sd.seq
      FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.is_milestone_task
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site AND ti.state IN ('open', 'entry', 'approved')
      ORDER BY sd.seq
    LOOP
      SELECT * INTO ev FROM public.ms_evaluate(m.id);
      IF manual ? m.stage_code THEN
        -- Site RFI (Q38): pre-filled with the latest condition date while the entry is open and the date was not edited; it then goes through approval.
        IF m.state IN ('open', 'entry') AND ev.ready THEN
          pre := nullif(m.values ->> 'prefilled_date', '')::date;
          IF m.actual_date IS NULL OR m.actual_date IS NOT DISTINCT FROM pre THEN
            IF m.actual_date IS DISTINCT FROM ev.ms_date THEN
              before := jsonb_build_object('actual_date', m.actual_date);
              UPDATE public.task_instances SET actual_date = ev.ms_date, lock_reason = NULL,
                values = coalesce(values, '{}'::jsonb) || jsonb_build_object('prefilled_date', ev.ms_date, 'prefilled', true), version = version + 1, updated_at = now()
              WHERE id = m.id;
              INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
              SELECT 'milestone_prefill', 'task', m.id::text, ti.site_id, ti.region_id, before, jsonb_build_object('actual_date', ev.ms_date), 'pre-filled with the latest condition date (Q38)'
              FROM public.task_instances ti WHERE ti.id = m.id;
              changed := changed + 1; progress := true;
            END IF;
          END IF;
        ELSIF m.state IN ('open', 'entry') AND NOT ev.ready THEN
          UPDATE public.task_instances SET lock_reason = ev.reasons -> 0 ->> 'message' WHERE id = m.id AND lock_reason IS DISTINCT FROM (ev.reasons -> 0 ->> 'message');
        END IF;
        CONTINUE;
      END IF;
      -- calculated milestone (E3)
      IF m.state = 'open' THEN
        IF ev.ready THEN
          before := jsonb_build_object('state', m.state, 'actual_date', m.actual_date);
          UPDATE public.task_instances SET state = 'approved', actual_date = ev.ms_date, approved_date = public.cal_today(), current_level = levels_required,
            ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
            version = version + 1, updated_at = now()
          WHERE id = m.id;
          INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
          VALUES (m.id, 1, 'approve', NULL, 'calculated milestone: no approval of its own (E3)', 'open', 'approved', clock_timestamp());
          INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
          SELECT 'milestone_calculated', 'task', m.id::text, ti.site_id, ti.region_id, before,
                 jsonb_build_object('state', 'approved', 'actual_date', ev.ms_date), 'calculated from its tasks and gate (E3)'
          FROM public.task_instances ti WHERE ti.id = m.id;
          PERFORM public.wf_unlock_successors(m.id);
          changed := changed + 1; progress := true;
        ELSE
          UPDATE public.task_instances SET lock_reason = ev.reasons -> 0 ->> 'message' WHERE id = m.id AND lock_reason IS DISTINCT FROM (ev.reasons -> 0 ->> 'message');
        END IF;
      ELSIF m.state = 'approved' AND NOT m.admin_override AND ev.ready AND ev.ms_date IS DISTINCT FROM m.actual_date THEN
        -- a condition date moved after the milestone was calculated: the calculated date follows (audited)
        before := jsonb_build_object('actual_date', m.actual_date);
        UPDATE public.task_instances SET actual_date = ev.ms_date, version = version + 1, updated_at = now() WHERE id = m.id;
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
        SELECT 'milestone_recalculated', 'task', m.id::text, ti.site_id, ti.region_id, before, jsonb_build_object('actual_date', ev.ms_date), 'a condition date moved'
        FROM public.task_instances ti WHERE ti.id = m.id;
        changed := changed + 1; progress := true;
      END IF;
    END LOOP;
    -- clocks that were waiting for their start event (a gate that was closed, a predecessor without a date)
    FOR sid IN
      SELECT ti.id FROM public.task_instances ti
      WHERE ti.site_id = p_site AND ti.sla_start_date IS NULL AND ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended')
    LOOP
      PERFORM public.sla_task_open(sid);
      IF EXISTS (SELECT 1 FROM public.task_instances WHERE id = sid AND sla_start_date IS NOT NULL) THEN changed := changed + 1; progress := true; END IF;
    END LOOP;
    EXIT WHEN NOT progress;
  END LOOP;
  PERFORM set_config('pmis.calc_busy', '', true);
  RETURN changed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', '', true);
  RAISE;
END $$;

-- Baseline proposal (Master Baseline sheet D:L; owner answer Q48). The proposed dates walk forward from the start (the actual Site Release, else
-- its planned date, else the first baseline date) by the SLA MAX durations of the version in force, with WORKDAY.INTL on the calendar.
-- Q48 (default accepted): D-1 is added to the TE Completion proposal, because the PMIS measures D-1 (TE Access) after the Site RFI; every
-- date from TE Completion on carries d1_added = true so the parallel run can tag the difference "D-1 added". Setting calc.baseline_include_d1
-- (default true) switches it off. Scope flags decide which stages apply (rules.md section 1). Not exposed by the API yet (no endpoint in the contract).
CREATE OR REPLACE FUNCTION sla_max_wd(p_site uuid, p_code text) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT r.max_working_days FROM public.sites s JOIN public.task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = p_code
  JOIN public.sla_rules r ON r.id = public.sla_rule_for(td.id, s.delivery_scenario, s.region_id, public.cal_today())
  WHERE s.id = p_site
$$;

CREATE OR REPLACE FUNCTION baseline_proposal(p_site uuid) RETURNS TABLE (milestone_code text, proposed_date date, d1_added boolean)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; c date; cal uuid := public.cal_default(); cw boolean; te boolean; rfi boolean; gecol boolean; hlc boolean; tower boolean; mw boolean; outsourced boolean; sta boolean;
  inc_d1 boolean; dd date; ee date; ff date; gg date; hh date; ii date; jj date; kk date; ll date; cwdlp integer; tedlp integer;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN; END IF;
  c := coalesce(
    (SELECT t.actual_date FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id
       WHERE t.site_id = p_site AND td.code = 'MS1' AND t.state = 'approved'),
    (SELECT t.planned_date FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.site_id = p_site AND td.code = 'MS1'),
    (SELECT be.baseline_date FROM public.baseline_entries be JOIN public.baseline_versions bv ON bv.id = be.version_id
       WHERE be.site_id = p_site AND be.milestone_code = 'MS1' AND be.baseline_date IS NOT NULL ORDER BY bv.version DESC LIMIT 1));
  IF c IS NULL THEN RETURN; END IF;
  tower := s.scope_tower_erection = 'yes';
  cw := tower OR s.scope_site_adaption = 'yes';
  gecol := s.scope_gecol_power = 'yes';
  hlc := s.scope_hlc_fiber = 'yes';
  rfi := cw OR gecol OR hlc;
  te := s.scope_te_full = 'yes' OR s.scope_te_ip_router_only = 'yes';
  outsourced := lower(coalesce(s.cw_delivery_model, '')) = 'outsourced';
  sta := EXISTS (SELECT 1 FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.site_id = p_site AND td.code = 'B5' AND t.state NOT IN ('na', 'skipped'));
  mw := EXISTS (SELECT 1 FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.site_id = p_site AND td.code = 'D8' AND t.state NOT IN ('na', 'skipped'));
  inc_d1 := coalesce((public.calc_setting('calc.baseline_include_d1', 'true'::jsonb) #>> '{}')::boolean, true);
  cwdlp := coalesce((public.calc_setting('dlp.months.cw', 'null'::jsonb) #>> '{}')::integer, 3);
  tedlp := coalesce((public.calc_setting('dlp.months.te', 'null'::jsonb) #>> '{}')::integer, 12);

  IF cw THEN dd := public.cal_add_workdays(c, coalesce(public.sla_max_wd(p_site, 'B1'), 0) + CASE WHEN outsourced THEN coalesce(public.sla_max_wd(p_site, 'B2'), 0) ELSE 0 END
      + coalesce(public.sla_max_wd(p_site, 'B3'), 0) + coalesce(public.sla_max_wd(p_site, 'B4'), 0) + CASE WHEN sta THEN coalesce(public.sla_max_wd(p_site, 'B5'), 0) ELSE 0 END
      + coalesce(public.sla_max_wd(p_site, 'B6'), 0) + coalesce(public.sla_max_wd(p_site, 'B7'), 0), cal);
  ELSE dd := c; END IF;
  IF cw THEN ee := public.cal_add_workdays(dd, CASE WHEN tower THEN coalesce(public.sla_max_wd(p_site, 'B8'), 0) + coalesce(public.sla_max_wd(p_site, 'B10'), 0)
                                                    ELSE coalesce(public.sla_max_wd(p_site, 'B9'), 0) + coalesce(public.sla_max_wd(p_site, 'B11'), 0) END, cal); END IF;
  IF rfi THEN
    ff := public.cal_add_workdays(greatest(
        CASE WHEN cw THEN public.cal_add_workdays(ee, coalesce(public.sla_max_wd(p_site, 'B13'), 0), cal) ELSE c END,
        CASE WHEN gecol THEN public.cal_add_workdays(c, coalesce(public.sla_max_wd(p_site, 'B1'), 0) + coalesce(public.sla_max_wd(p_site, 'C1'), 0) + coalesce(public.sla_max_wd(p_site, 'C2'), 0), cal) END,
        CASE WHEN hlc THEN public.cal_add_workdays(c, coalesce(public.sla_max_wd(p_site, 'B1'), 0) + coalesce(public.sla_max_wd(p_site, 'C3'), 0) + coalesce(public.sla_max_wd(p_site, 'C4'), 0), cal) END),
      coalesce(public.sla_max_wd(p_site, 'MS4'), 0), cal);
  END IF;
  IF te THEN
    gg := public.cal_add_workdays(CASE WHEN rfi THEN ff ELSE c END,
      CASE WHEN inc_d1 THEN coalesce(public.sla_max_wd(p_site, 'D1'), 0) ELSE 0 END + coalesce(public.sla_max_wd(p_site, 'D2'), 0) + coalesce(public.sla_max_wd(p_site, 'D3'), 0)
      + coalesce(public.sla_max_wd(p_site, 'D4'), 0) + coalesce(public.sla_max_wd(p_site, 'D4b'), 0) + coalesce(public.sla_max_wd(p_site, 'D5'), 0) + coalesce(public.sla_max_wd(p_site, 'D6'), 0), cal);
    hh := public.cal_add_workdays(gg, coalesce(public.sla_max_wd(p_site, 'D7'), 0) + CASE WHEN mw THEN coalesce(public.sla_max_wd(p_site, 'D8'), 0) ELSE 0 END
      + coalesce(public.sla_max_wd(p_site, 'D9'), 0) + coalesce(public.sla_max_wd(p_site, 'D10'), 0), cal);
    ii := public.cal_add_workdays(hh, greatest(coalesce(public.sla_max_wd(p_site, 'D11'), 0),
      coalesce(public.sla_max_wd(p_site, 'D12'), 0) + coalesce(public.sla_max_wd(p_site, 'D13'), 0) + coalesce(public.sla_max_wd(p_site, 'D14'), 0) + coalesce(public.sla_max_wd(p_site, 'D15'), 0))
      + coalesce(public.sla_max_wd(p_site, 'D16'), 0), cal);
    jj := public.cal_add_workdays(ii, coalesce(public.sla_max_wd(p_site, 'F1'), 0), cal);
    kk := public.cal_add_workdays(jj, coalesce(public.sla_max_wd(p_site, 'D17'), 0), cal);
  END IF;
  ll := public.cal_add_workdays(greatest(
      CASE WHEN cw THEN public.cal_add_workdays((public.cal_add_workdays(ee, coalesce(public.sla_max_wd(p_site, 'B13'), 0), cal) + make_interval(months => cwdlp))::date, coalesce(public.sla_max_wd(p_site, 'B15'), 0), cal) END,
      CASE WHEN te THEN public.cal_add_workdays((ii + make_interval(months => tedlp))::date, coalesce(public.sla_max_wd(p_site, 'D18'), 0), cal) END,
      kk), coalesce(public.sla_max_wd(p_site, 'Z1'), 0), cal);
  RETURN QUERY VALUES ('MS2', dd, false), ('MS3', ee, false), ('MS4', ff, false),
    ('MS5', gg, te AND inc_d1), ('MS6', hh, te AND inc_d1), ('MS7', ii, te AND inc_d1), ('MS8', jj, te AND inc_d1), ('MS9', kk, te AND inc_d1), ('MS10', ll, te AND inc_d1);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Triggers. They hook into task_instances without touching the wf_* functions of the approval engine.
-- ---------------------------------------------------------------------------------------------------------------------
-- Statement-level, after the statement: opens the clock of tasks that became active, closes it for approved ones, clears N/A ones,
-- then refreshes each affected site once.
CREATE OR REPLACE FUNCTION calc_after_task_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; sites_ uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR r IN SELECT n.id, n.site_id, o.state AS old_state, n.state AS new_state
           FROM new_t n JOIN old_t o ON o.id = n.id WHERE o.state IS DISTINCT FROM n.state LOOP
    IF r.new_state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') THEN
      IF r.old_state = 'approved' THEN
        UPDATE public.task_instances SET sla_end_date = NULL, sla_elapsed_wd = NULL WHERE id = r.id;        -- reopened: the clock runs again
      END IF;
      PERFORM public.sla_task_open(r.id);
    ELSIF r.new_state IN ('approved', 'na', 'skipped') THEN
      PERFORM public.sla_task_close(r.id);
    END IF;
    IF NOT (r.site_id = ANY (sites_)) THEN sites_ := sites_ || r.site_id; END IF;
  END LOOP;
  IF current_setting('pmis.calc_busy', true) IS DISTINCT FROM '1' THEN
    FOR r IN SELECT unnest(sites_) AS site_id LOOP PERFORM public.calc_refresh_site(r.site_id); END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_calc_after_update AFTER UPDATE ON task_instances REFERENCING OLD TABLE AS old_t NEW TABLE AS new_t FOR EACH STATEMENT EXECUTE FUNCTION calc_after_task_update();

-- A task inserted already active (a site created with open tasks) gets its clock, unless the caller gave it a due date.
CREATE OR REPLACE FUNCTION calc_after_task_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.id FROM new_t n WHERE n.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND n.due_date IS NULL AND n.sla_start_date IS NULL LOOP
    PERFORM public.sla_task_open(r.id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER z_calc_after_insert AFTER INSERT ON task_instances REFERENCING NEW TABLE AS new_t FOR EACH STATEMENT EXECUTE FUNCTION calc_after_task_insert();

-- The edited Site RFI date may not be earlier than the RFI Readiness gate (rules.md section 2.1, ASSUMPTION, setting calc.rfi_not_before_gate).
CREATE OR REPLACE FUNCTION calc_manual_milestone_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE st record; gate_rule public.phase_gate_rules%ROWTYPE; g record; s public.sites%ROWTYPE;
BEGIN
  IF NEW.actual_date IS NULL OR NEW.actual_date IS NOT DISTINCT FROM OLD.actual_date THEN RETURN NEW; END IF;
  IF coalesce((public.calc_setting('calc.rfi_not_before_gate', 'true'::jsonb) #>> '{}')::boolean, true) IS NOT TRUE THEN RETURN NEW; END IF;
  SELECT sd.code INTO st FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id WHERE td.id = NEW.task_def_id AND td.is_milestone_task;
  IF NOT FOUND OR NOT (public.calc_setting('calc.milestone_manual', '["MS4"]'::jsonb) ? st.code) THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.sites WHERE id = NEW.site_id;
  SELECT * INTO gate_rule FROM public.phase_gate_rules WHERE workflow_id = s.workflow_version_id AND to_code = st.code AND is_active LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.gate_eval(NEW.site_id, gate_rule.link_code);
  IF g.status = 'open' AND NEW.actual_date < g.gate_date THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('detail', 'The date cannot be earlier than the gate ' || gate_rule.link_code || ' (' || g.gate_date::text || ').',
      'errors', jsonb_build_array(jsonb_build_object('path', '/actual_date', 'code', 'before_gate', 'message', 'The date cannot be earlier than the gate date ' || g.gate_date::text || '.'))));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_calc_manual_milestone BEFORE UPDATE OF actual_date ON task_instances FOR EACH ROW EXECUTE FUNCTION calc_manual_milestone_guard();

-- Register changes that move a gate (permits, Change Control) or a start event (GECOL, HLC) refresh the site.
CREATE OR REPLACE FUNCTION calc_after_register_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.site_id IS NOT NULL THEN PERFORM public.calc_refresh_site(OLD.site_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.site_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.site_id IS DISTINCT FROM OLD.site_id) THEN PERFORM public.calc_refresh_site(NEW.site_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER calc_permit_change AFTER INSERT OR UPDATE OR DELETE ON permit_records FOR EACH ROW EXECUTE FUNCTION calc_after_register_change();
CREATE TRIGGER calc_change_request_change AFTER INSERT OR UPDATE OR DELETE ON change_requests FOR EACH ROW EXECUTE FUNCTION calc_after_register_change();

-- A holiday change recalculates the due dates of the open tasks whose period covers the changed days; weekend days recalculate all open
-- tasks of that calendar. Closed tasks keep their values. The count is kept for the admin function that caused the change.
CREATE OR REPLACE FUNCTION cal_holidays_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT calendar_id, min(date) AS lo, max(date) AS hi FROM new_rows GROUP BY calendar_id LOOP PERFORM public.sla_recalc_open(r.calendar_id, r.lo, r.hi); END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR r IN SELECT calendar_id, min(date) AS lo, max(date) AS hi FROM old_rows GROUP BY calendar_id LOOP PERFORM public.sla_recalc_open(r.calendar_id, r.lo, r.hi); END LOOP;
  ELSE
    FOR r IN SELECT calendar_id, min(date) AS lo, max(date) AS hi FROM (SELECT calendar_id, date FROM new_rows UNION ALL SELECT calendar_id, date FROM old_rows) u GROUP BY calendar_id LOOP
      PERFORM public.sla_recalc_open(r.calendar_id, r.lo, r.hi);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_holidays_insert AFTER INSERT ON holidays REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cal_holidays_changed();
CREATE TRIGGER z_holidays_update AFTER UPDATE ON holidays REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cal_holidays_changed();
CREATE TRIGGER z_holidays_delete AFTER DELETE ON holidays REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION cal_holidays_changed();

CREATE OR REPLACE FUNCTION cal_weekend_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.sla_recalc_open(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER z_work_calendars_weekend AFTER UPDATE OF weekend_days ON work_calendars FOR EACH ROW WHEN (OLD.weekend_days IS DISTINCT FROM NEW.weekend_days) EXECUTE FUNCTION cal_weekend_changed();

-- sla_rules_frozen (004) now also protects the start and end events of a rule used by tasks.
CREATE OR REPLACE FUNCTION sla_rules_freeze_used() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.task_def_id, NEW.min_working_days, NEW.max_working_days, NEW.start_event, NEW.scenario, NEW.region_id, NEW.calendar_id, NEW.effective_from, NEW.start_ref, NEW.end_ref)
     IS DISTINCT FROM
     (OLD.task_def_id, OLD.min_working_days, OLD.max_working_days, OLD.start_event, OLD.scenario, OLD.region_id, OLD.calendar_id, OLD.effective_from, OLD.start_ref, OLD.end_ref)
     AND sla_rule_in_use(OLD.id) THEN
    RAISE EXCEPTION 'sla_rule % is referenced by tasks; create a new version instead', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Admin functions (SECURITY DEFINER, owner pmis_definer). The actor (app.user_id) must be a System Admin or hold a delegation
-- covering the module (calendars / sla_rules, both inside the "settings.edit" right). Reason required, audited with before and after.
-- Errors use the wf:<code>:<json> format of the engine, so the API maps them the same way.
-- ---------------------------------------------------------------------------------------------------------------------
-- p_global: the change reaches every region (holidays, weekend days), so a delegation limited to some regions is not enough.
CREATE OR REPLACE FUNCTION calc_require_admin(p_module text, p_global boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.app_actor_is_admin(p_module, 'edit') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering %.edit required', p_module USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_global AND public.app_actor_region_filter(p_module, 'edit') IS NOT NULL THEN
    RAISE EXCEPTION 'admin path: this change applies to every region; a delegation for all regions is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION calc_require_reason(p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of at least 3 characters is required.'))));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION calc_audit(p_action text, p_entity text, p_id text, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, is_admin_override, actor_id)
  VALUES (p_action, p_entity, p_id, p_before, p_after, p_reason, false, public.app_actor())
$$;

CREATE OR REPLACE FUNCTION calc_holiday_json(h public.holidays) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('date', h.date, 'name', h.name, 'name_ar', h.name_ar, 'kind', h.kind, 'tentative', h.tentative, 'confirmed_at', h.confirmed_at, 'version', h.version)
$$;

-- Add or edit (or confirm) a holiday. p_patch keys: calendar_code (create only), date, name, name_ar, kind, tentative, confirm (true clears tentative).
-- Returns {id, affected_open_tasks}: the open tasks whose due date moved (closed tasks keep their values).
CREATE OR REPLACE FUNCTION admin_save_holiday(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h public.holidays%ROWTYPE; old_h public.holidays%ROWTYPE; cal uuid; actor uuid := public.app_actor(); hid uuid; action_ text;
BEGIN
  PERFORM public.calc_require_admin('calendars', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM set_config('pmis.sla_affected', '0', true);
  IF p_id IS NULL THEN
    SELECT id INTO cal FROM public.work_calendars WHERE code = coalesce(p_patch ->> 'calendar_code', (SELECT code FROM public.work_calendars WHERE is_default));
    IF cal IS NULL THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/calendar_code', 'code', 'unknown_calendar', 'message', 'Unknown calendar.')))); END IF;
    INSERT INTO public.holidays (calendar_id, date, name, name_ar, kind, tentative)
    VALUES (cal, (p_patch ->> 'date')::date, p_patch ->> 'name', p_patch ->> 'name_ar', coalesce(p_patch ->> 'kind', 'national'), coalesce((p_patch ->> 'tentative')::boolean, false))
    RETURNING * INTO h;
    hid := h.id;
    PERFORM public.calc_audit('holiday_create', 'holiday', hid::text, NULL, public.calc_holiday_json(h), p_reason);
  ELSE
    SELECT * INTO old_h FROM public.holidays WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
    IF p_version IS NOT NULL AND p_version <> old_h.version THEN PERFORM public.calc_err('precondition_failed'); END IF;
    action_ := CASE WHEN coalesce((p_patch ->> 'confirm')::boolean, false) THEN 'holiday_confirm' ELSE 'holiday_update' END;
    UPDATE public.holidays SET
      date = coalesce((p_patch ->> 'date')::date, date),
      name = coalesce(p_patch ->> 'name', name),
      name_ar = CASE WHEN p_patch ? 'name_ar' THEN p_patch ->> 'name_ar' ELSE name_ar END,
      kind = coalesce(p_patch ->> 'kind', kind),
      tentative = CASE WHEN coalesce((p_patch ->> 'confirm')::boolean, false) THEN false ELSE coalesce((p_patch ->> 'tentative')::boolean, tentative) END,
      confirmed_at = CASE WHEN coalesce((p_patch ->> 'confirm')::boolean, false) THEN now() ELSE confirmed_at END,
      confirmed_by = CASE WHEN coalesce((p_patch ->> 'confirm')::boolean, false) THEN actor ELSE confirmed_by END
    WHERE id = p_id RETURNING * INTO h;
    hid := p_id;
    PERFORM public.calc_audit(action_, 'holiday', hid::text, public.calc_holiday_json(old_h), public.calc_holiday_json(h), p_reason);
  END IF;
  RETURN jsonb_build_object('id', hid, 'affected_open_tasks', coalesce(nullif(current_setting('pmis.sla_affected', true), '')::integer, 0));
END $$;

CREATE OR REPLACE FUNCTION admin_delete_holiday(p_id uuid, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE old_h public.holidays%ROWTYPE;
BEGIN
  PERFORM public.calc_require_admin('calendars', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM set_config('pmis.sla_affected', '0', true);
  SELECT * INTO old_h FROM public.holidays WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF p_version IS NOT NULL AND p_version <> old_h.version THEN PERFORM public.calc_err('precondition_failed'); END IF;
  DELETE FROM public.holidays WHERE id = p_id;
  PERFORM public.calc_audit('holiday_delete', 'holiday', p_id::text, public.calc_holiday_json(old_h), NULL, p_reason);
  RETURN jsonb_build_object('id', p_id, 'affected_open_tasks', coalesce(nullif(current_setting('pmis.sla_affected', true), '')::integer, 0));
END $$;

CREATE OR REPLACE FUNCTION admin_save_weekend_days(p_calendar text, p_days integer[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.work_calendars%ROWTYPE; n integer; days integer[];
BEGIN
  PERFORM public.calc_require_admin('calendars', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO c FROM public.work_calendars WHERE code = coalesce(p_calendar, (SELECT code FROM public.work_calendars WHERE is_default)) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), ARRAY[]::integer[]) INTO days FROM unnest(p_days) AS x;
  IF cardinality(days) < 1 OR cardinality(days) > 6 OR days[1] < 0 OR days[cardinality(days)] > 6 OR cardinality(days) <> cardinality(p_days) THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/weekend_days', 'code', 'invalid', 'message', 'Give 1 to 6 different days between 0 (Sunday) and 6 (Saturday).'))));
  END IF;
  PERFORM set_config('pmis.sla_affected', '0', true);
  UPDATE public.work_calendars SET weekend_days = days WHERE id = c.id;
  n := coalesce(nullif(current_setting('pmis.sla_affected', true), '')::integer, 0);
  PERFORM public.calc_audit('weekend_days_update', 'work_calendar', c.id::text, jsonb_build_object('weekend_days', c.weekend_days), jsonb_build_object('weekend_days', days, 'affected_open_tasks', n), p_reason);
  RETURN jsonb_build_object('calendar_code', c.code, 'weekend_days', to_jsonb(days), 'affected_open_tasks', n, 'version', (SELECT version FROM public.work_calendars WHERE id = c.id));
END $$;

-- ---- SLA rule sets --------------------------------------------------------------------------------------------------------
-- The workflow version whose task codes a rule set speaks about: the latest published one.
CREATE OR REPLACE FUNCTION sla_workflow() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT id FROM public.workflow_definitions WHERE status = 'published' ORDER BY version DESC LIMIT 1
$$;

-- The version in force today (latest published whose effective date has come); before any has, the latest published.
CREATE OR REPLACE FUNCTION sla_set_in_force() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    (SELECT id FROM public.sla_rule_sets WHERE status = 'published' AND effective_from <= public.cal_today() ORDER BY effective_from DESC, version DESC LIMIT 1),
    (SELECT id FROM public.sla_rule_sets WHERE status = 'published' ORDER BY effective_from DESC, version DESC LIMIT 1))
$$;

-- Most specific override wins: scenario and region, then region, then scenario, then the base rule.
CREATE OR REPLACE FUNCTION sla_item_pick(p_min integer, p_max integer, p_overrides jsonb, p_scenario "DeliveryScenario", p_region integer, OUT min_wd integer, OUT max_wd integer)
RETURNS record LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(o.mn, p_min), coalesce(o.mx, p_max) FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT (e ->> 'min_working_days')::integer AS mn, (e ->> 'max_working_days')::integer AS mx
    FROM jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) e
    WHERE (e ->> 'scenario' IS NULL OR e ->> 'scenario' = p_scenario::text) AND ((e ->> 'region_id') IS NULL OR (e ->> 'region_id')::integer = p_region)
    ORDER BY ((e ->> 'region_id') IS NOT NULL)::integer * 2 + ((e ->> 'scenario') IS NOT NULL)::integer DESC LIMIT 1
  ) o ON true
$$;

-- Creates the draft (a copy of the version in force) or replaces rules in it. p_rules: [{task_code, min_working_days, max_working_days,
-- start_event, calendar_code, overrides[]}]. Validation errors (422): min_exceeds_max, unknown_task_code, unknown_start_event,
-- unknown_calendar, duplicate_task_code, duplicate_override. Returns the set id.
CREATE OR REPLACE FUNCTION admin_save_sla_rule_set(p_set uuid, p_reason text, p_rules jsonb DEFAULT NULL, p_version integer DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sla_rule_sets%ROWTYPE; base public.sla_rule_sets%ROWTYPE; wf uuid := public.sla_workflow(); r jsonb; idx integer; errs jsonb := '[]'::jsonb;
  td uuid; cal uuid; o jsonb; oidx integer; seen text[] := ARRAY[]::text[]; seen_o text[]; norm jsonb; mn integer; mx integer; v_code text; before jsonb;
BEGIN
  PERFORM public.calc_require_admin('sla_rules');
  PERFORM public.calc_require_reason(p_reason);
  IF p_set IS NULL THEN
    SELECT * INTO base FROM public.sla_rule_sets WHERE id = public.sla_set_in_force();
    INSERT INTO public.sla_rule_sets (version, status, base_version, reason, created_by)
    VALUES ((SELECT coalesce(max(version), 0) + 1 FROM public.sla_rule_sets), 'draft', base.version, p_reason, public.app_actor()) RETURNING * INTO s;
    INSERT INTO public.sla_rule_set_items (set_id, task_def_id, min_working_days, max_working_days, start_ref, end_ref, calendar_id, code, overrides)
    SELECT s.id, i.task_def_id, i.min_working_days, i.max_working_days, i.start_ref, i.end_ref, i.calendar_id, i.code, i.overrides FROM public.sla_rule_set_items i WHERE i.set_id = base.id;
    PERFORM public.calc_audit('sla_rule_set_draft', 'sla_rule_set', s.id::text, NULL, jsonb_build_object('version', s.version, 'base_version', base.version), p_reason);
    RETURN s.id;
  END IF;
  SELECT * INTO s FROM public.sla_rule_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only the draft rule set can be changed.')); END IF;
  IF p_version IS NOT NULL AND p_version <> s.row_version THEN PERFORM public.calc_err('precondition_failed'); END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rules', 'code', 'required', 'message', 'rules is required.')))); END IF;
  -- validate every rule first, so nothing is half written
  FOR r, idx IN SELECT value, ordinality - 1 FROM jsonb_array_elements(p_rules) WITH ORDINALITY LOOP
    v_code := r ->> 'task_code';
    IF v_code = ANY (seen) THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/task_code', 'code', 'duplicate_task_code', 'message', 'The task appears twice.')); END IF;
    seen := seen || v_code;
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = wf AND code = v_code) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/task_code', 'code', 'unknown_task_code', 'message', 'Unknown task code.'));
    END IF;
    IF (r ->> 'min_working_days')::integer > (r ->> 'max_working_days')::integer THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/max_working_days', 'code', 'min_exceeds_max', 'message', 'The minimum cannot exceed the maximum.'));
    END IF;
    IF NOT public.sla_start_ref_valid(r ->> 'start_event', wf) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/start_event', 'code', 'unknown_start_event', 'message', 'Unknown start event.'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.work_calendars WHERE code = r ->> 'calendar_code') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/calendar_code', 'code', 'unknown_calendar', 'message', 'Unknown calendar.'));
    END IF;
    seen_o := ARRAY[]::text[];
    FOR o, oidx IN SELECT value, ordinality - 1 FROM jsonb_array_elements(coalesce(r -> 'overrides', '[]'::jsonb)) WITH ORDINALITY LOOP
      IF (o ->> 'min_working_days')::integer > (o ->> 'max_working_days')::integer THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/overrides/' || oidx || '/max_working_days', 'code', 'min_exceeds_max', 'message', 'The minimum cannot exceed the maximum.'));
      END IF;
      IF coalesce(o ->> 'scenario', '') || '|' || coalesce(o ->> 'region_id', '') = ANY (seen_o) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/overrides/' || oidx, 'code', 'duplicate_override', 'message', 'The same scenario and region appear twice.'));
      END IF;
      seen_o := seen_o || (coalesce(o ->> 'scenario', '') || '|' || coalesce(o ->> 'region_id', ''));
    END LOOP;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', d.code, 'min', i.min_working_days, 'max', i.max_working_days, 'start', i.start_ref) ORDER BY d.code), '[]'::jsonb)
             FROM public.sla_rule_set_items i JOIN public.task_definitions d ON d.id = i.task_def_id
             WHERE i.set_id = s.id AND d.code IN (SELECT value ->> 'task_code' FROM jsonb_array_elements(p_rules)));
  FOR r IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    SELECT id INTO td FROM public.task_definitions WHERE workflow_id = wf AND code = r ->> 'task_code';
    SELECT id INTO cal FROM public.work_calendars WHERE code = r ->> 'calendar_code';
    SELECT coalesce(jsonb_agg(e ORDER BY coalesce(e ->> 'scenario', ''), coalesce((e ->> 'region_id')::integer, 0)), '[]'::jsonb) INTO norm
    FROM jsonb_array_elements(coalesce(r -> 'overrides', '[]'::jsonb)) e;
    INSERT INTO public.sla_rule_set_items (set_id, task_def_id, min_working_days, max_working_days, start_ref, end_ref, calendar_id, code, overrides)
    VALUES (s.id, td, (r ->> 'min_working_days')::integer, (r ->> 'max_working_days')::integer, r ->> 'start_event',
            (SELECT i.end_ref FROM public.sla_rule_set_items i WHERE i.set_id = s.id AND i.task_def_id = td), cal,
            (SELECT i.code FROM public.sla_rule_set_items i WHERE i.set_id = s.id AND i.task_def_id = td), norm)
    ON CONFLICT (set_id, task_def_id) DO UPDATE SET min_working_days = EXCLUDED.min_working_days, max_working_days = EXCLUDED.max_working_days,
      start_ref = EXCLUDED.start_ref, calendar_id = EXCLUDED.calendar_id, overrides = EXCLUDED.overrides;
  END LOOP;
  UPDATE public.sla_rule_sets SET reason = p_reason, row_version = row_version + 1 WHERE id = s.id;
  PERFORM public.calc_audit('sla_rule_set_update', 'sla_rule_set', s.id::text, jsonb_build_object('rules', before),
    jsonb_build_object('rules', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', value ->> 'task_code', 'min', value -> 'min_working_days', 'max', value -> 'max_working_days', 'start', value -> 'start_event')), '[]'::jsonb) FROM jsonb_array_elements(p_rules))), p_reason);
  RETURN s.id;
END $$;

-- Does the item differ from the same task in the latest published set?
CREATE OR REPLACE FUNCTION sla_item_changed(p_item public.sla_rule_set_items, p_against uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.sla_rule_set_items o
    WHERE o.set_id = p_against AND o.task_def_id = p_item.task_def_id AND o.min_working_days = p_item.min_working_days AND o.max_working_days = p_item.max_working_days
      AND o.start_ref = p_item.start_ref AND o.end_ref IS NOT DISTINCT FROM p_item.end_ref AND o.calendar_id = p_item.calendar_id AND o.overrides = p_item.overrides)
$$;

-- Dry run: how many open tasks (in the caller's regions) would change due date if the draft were applied to them.
CREATE OR REPLACE FUNCTION admin_preview_sla_rule_set(p_set uuid, p_effective date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sla_rule_sets%ROWTYPE; regs integer[]; today date := public.cal_today(); out jsonb; errs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('sla_rules');
  SELECT * INTO s FROM public.sla_rule_sets WHERE id = p_set;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only the draft rule set can be previewed.')); END IF;
  regs := public.app_actor_region_filter('sla_rules', 'edit');
  WITH t AS (
    SELECT ti.id, st.site_code, td.code, ti.due_date AS old_due,
           public.cal_add_workdays(ti.sla_start_date, p.max_wd, i.calendar_id) AS new_due
    FROM public.task_instances ti
    JOIN public.sites st ON st.id = ti.site_id
    JOIN public.task_definitions td ON td.id = ti.task_def_id
    JOIN public.sla_rule_set_items i ON i.set_id = s.id AND i.task_def_id = ti.task_def_id
    CROSS JOIN LATERAL public.sla_item_pick(i.min_working_days, i.max_working_days, i.overrides, st.delivery_scenario, ti.region_id) p
    WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND ti.sla_start_date IS NOT NULL
      AND (regs IS NULL OR ti.region_id = ANY (regs))
  ), ch AS (SELECT * FROM t WHERE new_due IS DISTINCT FROM old_due)
  SELECT jsonb_build_object(
    'set_id', s.id, 'effective_date', p_effective,
    'open_tasks_total', (SELECT count(*) FROM t),
    'changed_due_date_count', (SELECT count(*) FROM ch),
    'became_late_count', (SELECT count(*) FROM ch WHERE NOT coalesce(old_due < today, false) AND new_due < today),
    'no_longer_late_count', (SELECT count(*) FROM ch WHERE coalesce(old_due < today, false) AND NOT (new_due < today)),
    'by_task', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', g.code, 'open_tasks', g.n, 'changed', g.c) ORDER BY g.code), '[]'::jsonb)
                FROM (SELECT code, count(*) AS n, count(*) FILTER (WHERE new_due IS DISTINCT FROM old_due) AS c FROM t GROUP BY code) g),
    'samples', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_id', x.id, 'site_code', x.site_code, 'task_code', x.code, 'due_date_before', x.old_due, 'due_date_after', x.new_due)), '[]'::jsonb)
                FROM (SELECT * FROM ch ORDER BY site_code, code LIMIT 20) x)
  ) INTO out;
  RETURN out;
END $$;

-- Switches the open tasks to the rows of a published set (their start date stays). Returns the number of tasks whose terms changed.
CREATE OR REPLACE FUNCTION sla_apply_set(p_set uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sla_rule_sets%ROWTYPE; r record; nr public.sla_rules%ROWTYPE; orr public.sla_rules%ROWTYPE; n integer := 0; rid uuid;
BEGIN
  SELECT * INTO s FROM public.sla_rule_sets WHERE id = p_set;
  IF NOT FOUND OR s.status <> 'published' THEN RETURN 0; END IF;
  FOR r IN
    SELECT ti.id, ti.task_def_id, ti.region_id, ti.sla_rule_id, ti.sla_start_date, st.delivery_scenario
    FROM public.task_instances ti JOIN public.sites st ON st.id = ti.site_id
    WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND ti.sla_rule_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.sla_rule_set_items i WHERE i.set_id = p_set AND i.task_def_id = ti.task_def_id)
  LOOP
    rid := public.sla_rule_for(r.task_def_id, r.delivery_scenario, r.region_id, s.effective_from);
    CONTINUE WHEN rid IS NULL OR rid = r.sla_rule_id;
    SELECT * INTO nr FROM public.sla_rules WHERE id = rid;
    IF nr.rule_set_id IS DISTINCT FROM p_set THEN CONTINUE; END IF;
    SELECT * INTO orr FROM public.sla_rules WHERE id = r.sla_rule_id;
    UPDATE public.task_instances SET sla_rule_id = rid,
      due_date = CASE WHEN r.sla_start_date IS NULL THEN due_date ELSE public.cal_add_workdays(r.sla_start_date, nr.max_working_days, nr.calendar_id) END,
      sla_target_date = CASE WHEN r.sla_start_date IS NULL THEN sla_target_date ELSE public.cal_add_workdays(r.sla_start_date, nr.min_working_days, nr.calendar_id) END,
      updated_at = now()
    WHERE id = r.id;
    IF (orr.min_working_days, orr.max_working_days, orr.calendar_id, orr.start_ref, orr.end_ref) IS DISTINCT FROM (nr.min_working_days, nr.max_working_days, nr.calendar_id, nr.start_ref, nr.end_ref) THEN
      n := n + 1;
    END IF;
  END LOOP;
  UPDATE public.sla_rule_sets SET apply_pending = false, affected_open_tasks = n WHERE id = p_set;
  RETURN n;
END $$;

-- Publishes the draft: closes the old rows at the effective date and writes the new full set of rows. A task keeps the version it opened with
-- unless apply_to_open_tasks is true (applied now when the date is today, on that day by sla_apply_due_sets() otherwise).
CREATE OR REPLACE FUNCTION admin_publish_sla_rule_set(p_set uuid, p_effective date, p_reason text, p_apply boolean DEFAULT false, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sla_rule_sets%ROWTYPE; latest public.sla_rule_sets%ROWTYPE; today date := public.cal_today(); errs jsonb := '[]'::jsonb; regs integer[];
  i public.sla_rule_set_items%ROWTYPE; changed integer := 0; n integer := 0; o jsonb; actor uuid := public.app_actor();
BEGIN
  PERFORM public.calc_require_admin('sla_rules');
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO s FROM public.sla_rule_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only the draft rule set can be published.')); END IF;
  IF p_version IS NOT NULL AND p_version <> s.row_version THEN PERFORM public.calc_err('precondition_failed'); END IF;
  SELECT * INTO latest FROM public.sla_rule_sets WHERE status = 'published' ORDER BY effective_from DESC, version DESC LIMIT 1;
  IF p_effective IS NULL OR p_effective < today THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'effective_date_in_past', 'message', 'The effective date cannot be earlier than today.'));
  ELSIF latest.id IS NOT NULL AND p_effective <= latest.effective_from THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'effective_date_not_after_current', 'message', 'The effective date must be later than that of the latest published version.'));
  END IF;
  SELECT count(*) INTO changed FROM public.sla_rule_set_items x WHERE x.set_id = s.id AND (latest.id IS NULL OR public.sla_item_changed(x, latest.id));
  IF changed = 0 THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/', 'code', 'no_changes', 'message', 'The draft is equal to the version in force.')); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  regs := public.app_actor_region_filter('sla_rules', 'edit');
  IF p_apply AND regs IS NOT NULL AND EXISTS (SELECT 1 FROM public.task_instances ti
       WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND NOT (ti.region_id = ANY (regs))
         AND EXISTS (SELECT 1 FROM public.sla_rule_set_items x WHERE x.set_id = s.id AND x.task_def_id = ti.task_def_id)) THEN
    RAISE EXCEPTION 'the change would be applied to open tasks outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- close the rows in force, write the new ones (base rule, then each override)
  UPDATE public.sla_rules SET effective_to = p_effective WHERE effective_to IS NULL AND task_def_id IN (SELECT task_def_id FROM public.sla_rule_set_items WHERE set_id = s.id);
  FOR i IN SELECT * FROM public.sla_rule_set_items WHERE set_id = s.id LOOP
    INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by, start_ref, end_ref, code, rule_set_id)
    VALUES (i.task_def_id, i.min_working_days, i.max_working_days, i.start_ref, NULL, NULL, i.calendar_id, p_effective, p_reason, actor, i.start_ref, i.end_ref, i.code, s.id);
    FOR o IN SELECT value FROM jsonb_array_elements(i.overrides) LOOP
      INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by, start_ref, end_ref, code, rule_set_id)
      VALUES (i.task_def_id, (o ->> 'min_working_days')::integer, (o ->> 'max_working_days')::integer, i.start_ref, (o ->> 'scenario')::"DeliveryScenario",
              (o ->> 'region_id')::integer, i.calendar_id, p_effective, p_reason, actor, i.start_ref, i.end_ref, i.code, s.id);
    END LOOP;
  END LOOP;
  IF latest.id IS NOT NULL THEN UPDATE public.sla_rule_sets SET effective_to = p_effective WHERE id = latest.id AND effective_to IS NULL; END IF;
  UPDATE public.sla_rule_sets SET status = 'published', effective_from = p_effective, published_by = actor, published_at = now(), reason = p_reason,
    apply_to_open_tasks = coalesce(p_apply, false), apply_pending = coalesce(p_apply, false) AND p_effective > today, row_version = row_version + 1
  WHERE id = s.id;
  IF coalesce(p_apply, false) AND p_effective <= today THEN n := public.sla_apply_set(s.id); END IF;
  UPDATE public.sla_rule_sets SET affected_open_tasks = n WHERE id = s.id;
  PERFORM public.calc_audit('sla_rule_set_publish', 'sla_rule_set', s.id::text, jsonb_build_object('version_in_force', latest.version),
    jsonb_build_object('version', s.version, 'effective_date', p_effective, 'apply_to_open_tasks', coalesce(p_apply, false), 'changed_tasks', changed, 'affected_open_tasks', n), p_reason);
  RETURN jsonb_build_object('set_id', s.id, 'version', s.version, 'affected_open_tasks', n);
END $$;

-- For the scheduler: applies the sets that were published with apply_to_open_tasks and a future date, on that date.
CREATE OR REPLACE FUNCTION sla_apply_due_sets() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; total integer := 0; n integer;
BEGIN
  FOR s IN SELECT id, version FROM public.sla_rule_sets WHERE status = 'published' AND apply_pending AND effective_from <= public.cal_today() ORDER BY effective_from LOOP
    n := public.sla_apply_set(s.id);
    total := total + n;
    PERFORM public.calc_audit('sla_rule_set_apply', 'sla_rule_set', s.id::text, NULL, jsonb_build_object('version', s.version, 'affected_open_tasks', n), 'effective date reached');
  END LOOP;
  RETURN total;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights. Writers are owned by pmis_definer; pmis_app keeps SELECT on the new tables and loses direct writes to
-- the calendar and SLA tables (the narrowing is repeated in db/sql/app_grants.sql, which re-grants blanket rights at every deploy).
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON holidays, work_calendars, settings, permit_records, permit_types, change_requests, gecol_records, hlc_records, sla_rule_sets, sla_rule_set_items,
  sites, task_definitions, stage_definitions, task_predecessors, phase_gate_rules, workflow_definitions, sla_rules, task_instances TO pmis_definer;
GRANT INSERT, UPDATE, DELETE ON holidays TO pmis_definer;
GRANT UPDATE ON work_calendars TO pmis_definer;
GRANT INSERT, UPDATE ON sla_rule_sets TO pmis_definer;
GRANT INSERT, UPDATE, DELETE ON sla_rule_set_items TO pmis_definer;
GRANT INSERT, UPDATE ON sla_rules TO pmis_definer;
GRANT INSERT ON audit_log, workflow_steps TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  -- every function of this migration: not executable by PUBLIC
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
             'calc_setting', 'cal_today', 'cal_default', 'cal_weekend', 'cal_weekend_count', 'cal_holiday_count', 'cal_is_workday', 'cal_networkdays',
             'cal_workdays_between', 'cal_add_workdays', 'cal_bump_version', 'permit_default_expiry', 'sla_colour', 'sla_start_ref_valid', 'sla_task_date',
             'sla_resolve_start', 'sla_task_open', 'sla_task_close', 'sla_status', 'sla_recalc_open', 'permit_is_ptw', 'permit_na_ok', 'permit_valid_on',
             'permit_start', 'ms_resolve', 'gate_eval', 'ms_evaluate', 'calc_err', 'sla_max_wd', 'baseline_proposal', 'calc_refresh_site', 'calc_after_task_update', 'calc_after_task_insert',
             'calc_manual_milestone_guard', 'calc_after_register_change', 'cal_holidays_changed', 'cal_weekend_changed', 'calc_require_admin', 'calc_require_reason',
             'calc_audit', 'calc_holiday_json', 'admin_save_holiday', 'admin_delete_holiday', 'admin_save_weekend_days', 'sla_workflow', 'sla_set_in_force',
             'sla_item_pick', 'admin_save_sla_rule_set', 'sla_item_changed', 'admin_preview_sla_rule_set', 'sla_apply_set', 'admin_publish_sla_rule_set',
             'sla_apply_due_sets'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname = ANY (ARRAY['sla_task_open', 'sla_task_close', 'sla_recalc_open', 'calc_refresh_site', 'calc_after_task_update', 'calc_after_task_insert',
                              'calc_manual_milestone_guard', 'calc_after_register_change', 'cal_holidays_changed', 'cal_weekend_changed', 'calc_require_admin',
                              'calc_audit', 'admin_save_holiday', 'admin_delete_holiday', 'admin_save_weekend_days', 'admin_save_sla_rule_set',
                              'admin_preview_sla_rule_set', 'sla_apply_set', 'admin_publish_sla_rule_set', 'sla_apply_due_sets']) THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- what the API calls: the calendar and status readers and the audited admin functions
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
               'calc_setting', 'cal_today', 'cal_default', 'cal_weekend', 'cal_weekend_count', 'cal_holiday_count', 'cal_is_workday', 'cal_networkdays',
               'cal_workdays_between', 'cal_add_workdays', 'sla_colour', 'sla_start_ref_valid', 'sla_task_date', 'sla_resolve_start', 'sla_status',
               'permit_is_ptw', 'permit_na_ok', 'permit_valid_on', 'permit_start', 'ms_resolve', 'gate_eval', 'ms_evaluate', 'sla_max_wd', 'baseline_proposal', 'sla_workflow', 'sla_set_in_force',
               'sla_item_pick', 'sla_item_changed', 'calc_holiday_json', 'calc_require_reason', 'calc_err', 'admin_save_holiday', 'admin_delete_holiday',
               'admin_save_weekend_days', 'admin_save_sla_rule_set', 'admin_preview_sla_rule_set', 'admin_publish_sla_rule_set', 'sla_apply_due_sets'])
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig); END LOOP;
    GRANT SELECT ON permit_types, sla_rule_sets, sla_rule_set_items TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON holidays, work_calendars, sla_rules, sla_rule_sets, sla_rule_set_items, permit_types FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Calculated milestones have no holder (E3): unlocking one must not alert the System Admins with "no eligible holder".
-- Same body as 0015 otherwise; CREATE OR REPLACE keeps the owner and grants.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_unlock_successors(p_task uuid) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; s record; ids uuid[] := ARRAY[]::uuid[]; before jsonb; h record;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  FOR s IN
    SELECT si.id FROM public.task_predecessors tp
    JOIN public.task_instances si ON si.site_id = t.site_id AND si.task_def_id = tp.task_def_id AND si.state = 'locked'
    WHERE tp.predecessor_id = t.task_def_id
      AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2
                      JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = p2.predecessor_id
                      WHERE p2.task_def_id = si.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped'))
    ORDER BY si.id
  LOOP
    before := public.wf_snap(s.id);
    UPDATE public.task_instances SET state = 'open', current_level = 1, level_opened_at = now(), lock_reason = NULL, version = version + 1, updated_at = now()
    WHERE id = s.id;
    PERFORM public.wf_audit('task_unlock', s.id, before, public.wf_snap(s.id), 'predecessor ' || public.wf_label(p_task) || ' approved');
    ids := ids || s.id;
    -- A calculated milestone (every milestone task except Site RFI, owner answer E3) has no holder on purpose: no alert.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.task_instances mi JOIN public.task_definitions md ON md.id = mi.task_def_id
                          WHERE mi.id = s.id AND md.is_milestone_task AND md.code <> 'MS4');
    FOR h IN SELECT e.user_id FROM public.wf_eligible(s.id, 'entry') e LIMIT 20 LOOP
      PERFORM public.wf_notify(h.user_id, 'task_assigned', 'A task is ready to start', public.wf_label(s.id), s.id);
    END LOOP;
    IF NOT public.wf_has_holder(s.id, 'entry') THEN
      PERFORM public.wf_notify_admins('no_eligible_holder', 'No holder for a task level', public.wf_label(s.id) || ': nobody can act on the entry level.', s.id);
    END IF;
  END LOOP;
  RETURN ids;
END $$;
