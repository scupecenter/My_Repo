-- 0059_p2_dashboard: work package P2 of the owner answers of 2026-11-04 (Dashboard, Project Status and delay attribution).
-- Mirror: db/sql/058_p2_dashboard.sql (kept identical to prisma/migrations/0059_p2_dashboard/migration.sql).
-- Plan: docs/plans/2026-11-04-owner-answers-gap.md section P2 and "Owner decisions on the D list"; answers: docs/spec/owner-answers-2026-11-04.md.
--
-- What this changes
--   * Q7    Delay that no approved period covers is "unattributed delay" (kind `unattributed`). The task's R party (its external party, else the
--           default party type of its definition) is shown only as `suggested_party`; it is never an attribution. The days stay in the project's
--           total delay but not in the scorecard (`delay.scorecard` lists approved periods only). A day counts once. attributed_pct and
--           unattributed_pct are both given.
--   * Q175  A manual central value (Q118) counts in the project-wide figure only (one row, every region, no filter). Regional, site and filtered
--           figures leave every central item out again (`reason` central_hidden, meta.central_items_hidden) and show the values in a separate
--           `central_line` block that is not part of the local progress.
--   * Q176  ps_manual_values.source (text, required): where the value comes from. Entries made before 0059 read "not recorded (entered before 0059)".
--   * Q177  ps_manual_plans: an approved plan per manual item, versioned and append-only. A plan is a list of points (date, planned %), cumulative
--           (never falling). The planned % on a date: 0 before the first point, the value of the last point after it, and a straight line by
--           calendar day between two points. A target date is one point at 100% (an optional start point at 0% makes a ramp). With a plan, a
--           manual item has a Planned figure, so Planned and the index work once every measured item has a plan. The index is named
--           "progress vs plan index" (`progress_vs_plan_index`; `spi` stays as the same value for old clients): it is Actual / Planned over the
--           same items and weights, not an EVM SPI. `partial_index` gives the same ratio over the items that have a plan, with its coverage.
--   * Q178  Back-dating: an effective date in the current month (Africa/Tripoli) is allowed with a reason; an earlier date (a closed month) needs
--           dashboard.historical_correction edit and is flagged historical_correction (audited, listed for review). Future dates stay refused.
--   * Q180  (delay side) Suspension days. Read from change_requests, status approved or applied:
--             a suspension (kind suspension) starts on coalesce(suspension_start, approval_date);
--             it ends at the earliest resumption (kind resumption) of the same site whose coalesce(resumption_date, approval_date) is after that
--             start; the window is [start, resumption), in working days; with no such resumption it runs to the reference date.
--           A record with neither date is ignored. The gate side of Q180 (gate_eval, cc_suspension_windows) is work package P1 and is not touched.
--   * Q181  A late task without a due date gets its window rebuilt: the due working day is the SLA start plus the rule's maximum, counted on the
--           dashboard's work calendar (_dcal). When the window cannot be built, or holds no day, the task's days over the maximum are a data gap:
--           unattributed, with no suggested party (`data_gap`, delay.data_gap_working_days).
--   * Q182  A period is first proposed (status proposed: party, reason, optional evidence), with no effect, by L1 (an entry holder of the task),
--           L2, a System Admin or a dashboard.delay edit holder in the region. L2, a System Admin or the delegate decides (approve or reject, with a
--           note for a rejection); nobody decides their own proposal. Periods recorded before 0059 had immediate effect: they are kept as approved.
--   * Q184  The external party is required to approve a `contractor` or `external` period (the approver may name it then). An approved period of
--           those parties without one (from before 0059) does not count; its days stay unattributed.
--   * Q186  (B part) Blocked gates are live only. A past reference date, a catch-up snapshot or a snapshot taken by hand for an earlier date
--           records them as "historically unavailable" (null), not 0 (`gates.status`, `blocked_available` on the pipeline).
--   * D186  The weekly snapshot is taken on Thursday: dashboard.snapshot_weekday 4 (the 0046 seed was 0, Sunday).
--   * D16   The health index factors not yet approved (every factor except D and I; setting dashboard.health_approved_factors) carry draft: true.
--   * Q116  Setting dashboard.pipeline_variant (A = rings, the default; B = flat segmented track), changed only through dash_set_pipeline_variant.
--
-- pmis_app reads the new table and columns and writes nothing (db/sql/app_grants.sql). Every function is SECURITY DEFINER with search_path set.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('dashboard.health_approved_factors', '["D", "I"]', 'D16: the health index factors the owner approved. The other factors are shown with a draft label.', now()),
  ('dashboard.pipeline_variant', '"A"', 'Q116: the pipeline style of the dashboard: A = progress rings (default), B = flat segmented track. Changed by a System Admin or a dashboard administer holder.', now())
ON CONFLICT (key) DO NOTHING;

-- D186: Thursday, the last working day of the week. An admin's own value other than the 0046 seed is kept.
UPDATE settings SET value = '4'::jsonb, updated_at = now() WHERE key = 'dashboard.snapshot_weekday' AND value = '0'::jsonb;
UPDATE settings SET description = 'D186: the weekday of the weekly dashboard snapshot (0 = Sunday ... 4 = Thursday, the default ... 6 = Saturday), on the Africa/Tripoli date.', updated_at = now()
WHERE key = 'dashboard.snapshot_weekday';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------------------------------
-- Q176, Q178
ALTER TABLE ps_manual_values
  ADD COLUMN source TEXT NOT NULL DEFAULT 'not recorded (entered before 0059)' CHECK (char_length(btrim(source)) >= 2 AND char_length(source) <= 500),
  ADD COLUMN historical_correction BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ps_manual_values ALTER COLUMN source DROP DEFAULT;

-- Q177
CREATE TABLE ps_manual_plans (
  id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code   TEXT           NOT NULL CHECK (item_code ~ '^[A-Za-z0-9._-]{1,20}$'),
  version     INTEGER        NOT NULL CHECK (version >= 1),
  points      JSONB          NOT NULL CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) BETWEEN 1 AND 120),
  reason      TEXT           NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  source      TEXT           NOT NULL CHECK (char_length(btrim(source)) >= 2 AND char_length(source) <= 500),
  entered_by  UUID           NOT NULL REFERENCES users (id),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (item_code, version)
);
ALTER TABLE ps_manual_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ps_manual_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON ps_manual_plans FOR SELECT USING (true);   -- project-wide plans, not region data; the API asks for dashboard.view
CREATE TRIGGER ps_manual_plans_frozen BEFORE UPDATE OR DELETE ON ps_manual_plans FOR EACH ROW EXECUTE FUNCTION dash_owner_rows_frozen();

-- Q182, Q184: proposed -> approved | rejected, once. created_by is the proposer.
ALTER TABLE task_delay_periods
  ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('proposed', 'approved', 'rejected')),
  ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR char_length(evidence) <= 2000),
  ADD COLUMN decided_by UUID REFERENCES users (id),
  ADD COLUMN decided_at TIMESTAMPTZ(6),
  ADD COLUMN decision_note TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000);
-- the periods of 0046 were recorded by the reviewer with immediate effect: approved by the person who recorded them
ALTER TABLE task_delay_periods DISABLE TRIGGER task_delay_periods_frozen;
UPDATE task_delay_periods SET decided_by = created_by, decided_at = created_at, decision_note = 'recorded with immediate effect before migration 0059 (Q122)';
ALTER TABLE task_delay_periods ENABLE TRIGGER task_delay_periods_frozen;
ALTER TABLE task_delay_periods ALTER COLUMN status SET DEFAULT 'proposed';
ALTER TABLE task_delay_periods ADD CONSTRAINT task_delay_periods_decision_ck
  CHECK ((status = 'proposed') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL));
CREATE INDEX task_delay_periods_status_idx ON task_delay_periods (task_id, status) WHERE voided_at IS NULL;

-- Append-only rules (0046) plus the one decision of a proposed period: status, decided_by, decided_at, decision_note change once, and the
-- external party may be named then when the proposal had none. Everything else stays as it was.
CREATE OR REPLACE FUNCTION dash_owner_rows_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END IF;
  IF TG_TABLE_NAME = 'task_delay_periods' THEN
    o := to_jsonb(OLD); n := to_jsonb(NEW);
    IF (o ->> 'voided_at') IS NULL AND (n ->> 'voided_at') IS NOT NULL
       AND (n - 'voided_at' - 'voided_by' - 'void_reason') = (o - 'voided_at' - 'voided_by' - 'void_reason') THEN
      RETURN NEW;
    END IF;
    IF (o ->> 'status') = 'proposed' AND (n ->> 'status') IN ('approved', 'rejected') AND (o ->> 'voided_at') IS NULL AND (n ->> 'voided_at') IS NULL
       AND (n - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'external_party_id') = (o - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'external_party_id')
       AND ((o ->> 'external_party_id') IS NULL OR (o -> 'external_party_id') = (n -> 'external_party_id')) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% rows are never rewritten', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;

GRANT SELECT, INSERT ON ps_manual_plans TO pmis_definer;
GRANT SELECT ON sla_rules, task_definitions, external_parties, site_snapshots, dash_snapshot_runs TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q176, Q178: manual values with a source and the month limit
-- ---------------------------------------------------------------------------------------------------------------------
-- May the signed-in actor enter a value dated before the current month (Q178)? A System Admin, or dashboard.historical_correction edit for all regions.
CREATE OR REPLACE FUNCTION ps_manual_can_correct() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_actor() IS NOT NULL AND public.app_can('dashboard.historical_correction', 'edit')
$$;

-- Enter a manual value: 0..100 (3 decimals), an effective date today or earlier, a reason and its source (Q176). A date before the first day of the
-- current month is a historical correction (Q178): only with ps_manual_can_correct(), flagged on the row and in the audit entry.
CREATE OR REPLACE FUNCTION ps_manual_set(p_item text, p_value numeric, p_effective date, p_reason text, p_source text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); w numeric; ver integer; prev public.ps_manual_values%ROWTYPE; r public.ps_manual_values%ROWTYPE; errs jsonb := '[]'::jsonb;
  today date := public.cal_today(); corr boolean := false;
BEGIN
  IF NOT public.ps_manual_can_edit() THEN
    RAISE EXCEPTION 'project status: the Project Manager, a System Admin or a holder of dashboard.project_status edit for all regions enters manual values' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  SELECT c.weight INTO w FROM public.ps_central_items(today) c WHERE c.item_code = p_item;
  IF NOT FOUND OR coalesce(w, 0) <= 0 THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/item_code', 'code', 'not_central_item',
      'message', 'Only a weighted central item of the Project Status weight set in force takes a manual value.'))));
  END IF;
  IF p_value IS NULL OR p_value < 0 OR p_value > 100 OR round(p_value, 3) <> p_value THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/value_pct', 'code', 'invalid', 'message', 'The value is 0 to 100 with at most 3 decimals.'));
  END IF;
  IF p_effective IS NULL OR p_effective > today THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'in_future', 'message', 'The effective date is today or earlier.'));
  ELSIF p_effective < DATE '2020-01-01' THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'invalid', 'message', 'The effective date is too early.'));
  END IF;
  IF char_length(btrim(coalesce(p_source, ''))) < 2 OR char_length(p_source) > 500 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/source', 'code', 'required', 'message', 'Say where the value comes from (2 to 500 characters).'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_effective < date_trunc('month', today)::date THEN
    IF NOT public.ps_manual_can_correct() THEN
      PERFORM public.calc_err('action_forbidden', jsonb_build_object('detail',
        'An effective date before this month is a historical correction of a closed month: it needs the dashboard.historical_correction right.'));
    END IF;
    corr := true;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.ps_manual.' || p_item));
  SELECT coalesce(max(version), 0) + 1 INTO ver FROM public.ps_manual_values WHERE item_code = p_item;
  SELECT * INTO prev FROM public.ps_manual_values WHERE item_code = p_item AND effective_date <= p_effective ORDER BY effective_date DESC, version DESC LIMIT 1;
  INSERT INTO public.ps_manual_values (item_code, version, value_pct, effective_date, reason, entered_by, source, historical_correction)
  VALUES (p_item, ver, p_value, p_effective, btrim(p_reason), a, btrim(p_source), corr) RETURNING * INTO r;
  PERFORM public.log_audit_write('project_status.manual_value_set', 'ps_manual_value', p_item,
    CASE WHEN prev.id IS NULL THEN NULL ELSE jsonb_build_object('value_pct', prev.value_pct, 'effective_date', prev.effective_date, 'version', prev.version, 'source', prev.source) END,
    jsonb_build_object('item_code', p_item, 'value_pct', r.value_pct, 'effective_date', r.effective_date, 'version', r.version, 'id', r.id, 'source', r.source,
      'historical_correction', r.historical_correction), btrim(p_reason));
  RETURN jsonb_build_object('id', r.id, 'item_code', r.item_code, 'version', r.version, 'value_pct', r.value_pct, 'effective_date', r.effective_date,
    'reason', r.reason, 'source', r.source, 'historical_correction', r.historical_correction, 'entered_by', r.entered_by, 'created_at', r.created_at);
END $$;

-- The 0046 signature: a value without a source is refused (Q176), after the same right check.
CREATE OR REPLACE FUNCTION ps_manual_set(p_item text, p_value numeric, p_effective date, p_reason text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.ps_manual_set(p_item, p_value, p_effective, p_reason, NULL::text)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q177: plans of the manual items
-- ---------------------------------------------------------------------------------------------------------------------
-- Planned % (0..100) of a plan on a date: 0 before the first point, the last value after the last point, a straight line by calendar day between.
CREATE OR REPLACE FUNCTION ps_plan_pct(p_points jsonb, p_on date) RETURNS numeric
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH pts AS (SELECT (e ->> 'date')::date AS d, (e ->> 'planned_pct')::numeric AS v FROM jsonb_array_elements(p_points) e),
  pr AS (SELECT d, v FROM pts WHERE d <= p_on ORDER BY d DESC LIMIT 1),
  nx AS (SELECT d, v FROM pts WHERE d > p_on ORDER BY d LIMIT 1)
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pr) THEN 0::numeric
              WHEN NOT EXISTS (SELECT 1 FROM nx) THEN (SELECT v FROM pr)
              ELSE (SELECT pr.v + (nx.v - pr.v) * (p_on - pr.d)::numeric / (nx.d - pr.d) FROM pr, nx) END
$$;

-- A new version of an item's plan: 1 to 120 points {date, planned_pct}, dates unique, planned % 0..100 (3 decimals) and never falling with the date,
-- a reason and a source. Future dates are allowed (it is a plan). The same people as the manual values. Audited with the plan it replaces.
CREATE OR REPLACE FUNCTION ps_manual_plan_set(p_item text, p_points jsonb, p_reason text, p_source text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); w numeric; ver integer; prev public.ps_manual_plans%ROWTYPE; r public.ps_manual_plans%ROWTYPE; errs jsonb := '[]'::jsonb;
  e jsonb; i integer := 0; d date; v numeric; pts jsonb := '[]'::jsonb; last_d date; last_v numeric;
BEGIN
  IF NOT public.ps_manual_can_edit() THEN
    RAISE EXCEPTION 'project status: the Project Manager, a System Admin or a holder of dashboard.project_status edit for all regions enters manual plans' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  SELECT c.weight INTO w FROM public.ps_central_items(public.cal_today()) c WHERE c.item_code = p_item;
  IF NOT FOUND OR coalesce(w, 0) <= 0 THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/item_code', 'code', 'not_central_item',
      'message', 'Only a weighted central item of the Project Status weight set in force takes a plan.'))));
  END IF;
  IF char_length(btrim(coalesce(p_source, ''))) < 2 OR char_length(p_source) > 500 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/source', 'code', 'required', 'message', 'Say where the plan comes from (2 to 500 characters).'));
  END IF;
  IF p_points IS NULL OR jsonb_typeof(p_points) <> 'array' OR jsonb_array_length(p_points) NOT BETWEEN 1 AND 120 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/points', 'code', 'invalid', 'message', 'A plan has 1 to 120 points.'));
  ELSE
    FOR e IN SELECT x FROM jsonb_array_elements(p_points) x LOOP
      d := NULL; v := NULL;
      IF jsonb_typeof(e) = 'object' AND coalesce(e ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN
        BEGIN d := (e ->> 'date')::date; EXCEPTION WHEN others THEN d := NULL; END;
      END IF;
      IF jsonb_typeof(e) = 'object' AND jsonb_typeof(e -> 'planned_pct') = 'number' THEN v := (e ->> 'planned_pct')::numeric; END IF;
      IF d IS NULL OR d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', format('/points/%s/date', i), 'code', 'invalid', 'message', 'A date from 2020 to 2035, YYYY-MM-DD.'));
      END IF;
      IF v IS NULL OR v < 0 OR v > 100 OR round(v, 3) <> v THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', format('/points/%s/planned_pct', i), 'code', 'invalid', 'message', 'The planned value is 0 to 100 with at most 3 decimals.'));
      END IF;
      IF d IS NOT NULL AND v IS NOT NULL THEN pts := pts || jsonb_build_array(jsonb_build_object('date', d, 'planned_pct', v, 'i', i)); END IF;
      i := i + 1;
    END LOOP;
    IF jsonb_array_length(errs) = 0 THEN
      FOR e IN SELECT x FROM jsonb_array_elements(pts) x ORDER BY (x ->> 'date')::date LOOP
        d := (e ->> 'date')::date; v := (e ->> 'planned_pct')::numeric;
        IF last_d IS NOT NULL AND d = last_d THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', format('/points/%s/date', e ->> 'i'), 'code', 'duplicate', 'message', 'Two points have the same date.'));
        ELSIF last_v IS NOT NULL AND v < last_v THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', format('/points/%s/planned_pct', e ->> 'i'), 'code', 'not_cumulative', 'message', 'A plan is cumulative: the planned % never falls with the date.'));
        END IF;
        last_d := d; last_v := greatest(v, coalesce(last_v, v));
      END LOOP;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', (x ->> 'date')::date, 'planned_pct', (x ->> 'planned_pct')::numeric) ORDER BY (x ->> 'date')::date), '[]'::jsonb)
  INTO pts FROM jsonb_array_elements(pts) x;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.ps_manual_plan.' || p_item));
  SELECT coalesce(max(version), 0) + 1 INTO ver FROM public.ps_manual_plans WHERE item_code = p_item;
  SELECT * INTO prev FROM public.ps_manual_plans WHERE item_code = p_item ORDER BY version DESC LIMIT 1;
  INSERT INTO public.ps_manual_plans (item_code, version, points, reason, source, entered_by)
  VALUES (p_item, ver, pts, btrim(p_reason), btrim(p_source), a) RETURNING * INTO r;
  PERFORM public.log_audit_write('project_status.manual_plan_set', 'ps_manual_plan', p_item,
    CASE WHEN prev.id IS NULL THEN NULL ELSE jsonb_build_object('version', prev.version, 'points', prev.points, 'source', prev.source) END,
    jsonb_build_object('item_code', p_item, 'version', r.version, 'points', r.points, 'source', r.source, 'id', r.id), btrim(p_reason));
  RETURN jsonb_build_object('id', r.id, 'item_code', r.item_code, 'version', r.version, 'points', r.points, 'reason', r.reason, 'source', r.source,
    'entered_by', r.entered_by, 'created_at', r.created_at);
END $$;

-- The manual values in force on p_ref as known at p_known (0046), plus the plan of each item known at p_known (Q177):
-- _dman (item, pct 0..1, value_pct, effective_date, version) and _dmplan (item, ppct 0..1, planned_pct, version).
CREATE OR REPLACE FUNCTION dash_build_manual(p_ref date, p_known timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS _dman; DROP TABLE IF EXISTS _dmplan;
  CREATE TEMP TABLE _dman ON COMMIT DROP AS
    SELECT DISTINCT ON (v.item_code) v.item_code AS item, v.value_pct / 100.0 AS pct, v.value_pct, v.effective_date, v.version
    FROM public.ps_manual_values v
    WHERE v.effective_date <= p_ref AND (p_known IS NULL OR v.created_at <= p_known)
    ORDER BY v.item_code, v.effective_date DESC, v.version DESC;
  CREATE UNIQUE INDEX ON _dman (item);
  CREATE TEMP TABLE _dmplan ON COMMIT DROP AS
    SELECT x.item, x.planned_pct / 100.0 AS ppct, x.planned_pct, x.version
    FROM (SELECT DISTINCT ON (p.item_code) p.item_code AS item, round(public.ps_plan_pct(p.points, p_ref), 3) AS planned_pct, p.version
          FROM public.ps_manual_plans p WHERE p_known IS NULL OR p.created_at <= p_known
          ORDER BY p.item_code, p.version DESC) x;
  CREATE UNIQUE INDEX ON _dmplan (item);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q175, Q177: Project Status rows and card
-- ---------------------------------------------------------------------------------------------------------------------
-- Project Status rows (0039, 0046). A manual central item counts only in the project-wide row (group none, p_project_wide): Q175. With a plan its
-- Planned is the plan's value on the reference date (Q177), otherwise none, so Planned stays "not available" (the 0039 rule).
-- progress_vs_plan_index = actual / planned over the same items and weights (named so because it is not EVM). partial_index: the same ratio over the
-- items that have a plan, with plan_coverage_pct as its coverage.
CREATE OR REPLACE FUNCTION dash_ps_rows(p_group text, p_project_wide boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; wide boolean := p_project_wide AND p_group = 'none';
BEGIN
  WITH ic AS (
    SELECT CASE p_group WHEN 'region' THEN s.region_id::text WHEN 'site' THEN s.site_code ELSE 'all' END AS gk,
           CASE p_group WHEN 'region' THEN coalesce(r.name_en, s.region_id::text) WHEN 'site' THEN s.site_code ELSE 'Project' END AS label,
           c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic, sum(c.planned) AS planned, sum(c.plan_known) AS plan_known
    FROM _dic c JOIN _dsite s ON s.id = c.site_id LEFT JOIN public.regions r ON r.id = s.region_id
    GROUP BY 1, 2, c.act, c.item
  ), g AS (
    SELECT DISTINCT gk, label FROM ic
  ), it AS (
    SELECT ic.gk, ic.label, w.act, w.item, w.iw, w.aw,
           least(1, ic.done::numeric / ic.applic) AS pct,
           CASE WHEN ic.plan_known = ic.applic THEN least(1, ic.planned::numeric / ic.applic) END AS ppct
    FROM ic JOIN _dwi w ON w.item = ic.item WHERE ic.applic > 0 AND w.iw > 0 AND NOT (w.central AND NOT wide)
    UNION ALL
    SELECT g.gk, g.label, w.act, w.item, w.iw, w.aw, least(1, greatest(0, m.pct)), CASE WHEN mp.ppct IS NOT NULL THEN least(1, greatest(0, mp.ppct)) END
    FROM g CROSS JOIN _dwi w JOIN _dman m ON m.item = w.item LEFT JOIN _dmplan mp ON mp.item = w.item
    WHERE wide AND w.central AND w.method <> 'tasks' AND w.iw > 0
  ), act AS (
    SELECT gk, max(label) AS label, act, max(aw) AS aw, sum(iw) AS sw, sum(iw * pct) / sum(iw) AS apct,
           CASE WHEN count(*) FILTER (WHERE ppct IS NULL) = 0 THEN sum(iw * ppct) / sum(iw) END AS pplan,
           coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL), 0) / sum(iw) AS cov,
           coalesce(sum(iw * pct) FILTER (WHERE ppct IS NOT NULL), 0) AS pa_num,
           coalesce(sum(iw * ppct) FILTER (WHERE ppct IS NOT NULL), 0) AS pp_num,
           coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL), 0) AS pw
    FROM it GROUP BY gk, act
  ), tot AS (
    SELECT gk, max(label) AS label, sum(aw * apct) / sum(aw) AS actual,
           CASE WHEN count(*) FILTER (WHERE pplan IS NULL) = 0 THEN sum(aw * pplan) / sum(aw) END AS planned,
           sum(aw * cov) / sum(aw) AS coverage,
           sum(aw * pa_num / sw) AS pa, sum(aw * pp_num / sw) AS pp, sum(aw * pw / sw) AS pwt
    FROM act GROUP BY gk
  ), aj AS (
    SELECT gk, jsonb_object_agg(act, round(apct * 100, 3)) AS j, jsonb_object_agg(act, round(pplan * 100, 3)) FILTER (WHERE pplan IS NOT NULL) AS jp FROM act GROUP BY gk
  ), ij AS (
    SELECT gk, jsonb_object_agg(item, round(pct * 100, 3)) AS j FROM it GROUP BY gk
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'key', t.gk, 'label', t.label,
      'progress_pct', round(t.actual * 100, 3), 'planned_pct', round(t.planned * 100, 3),
      'spi', CASE WHEN t.planned > 0 THEN round(t.actual / t.planned, 3) END,
      'progress_vs_plan_index', CASE WHEN t.planned > 0 THEN round(t.actual / t.planned, 3) END,
      'plan_coverage_pct', round(t.coverage * 100, 3),
      'partial_index', CASE WHEN t.pwt > 0 THEN jsonb_build_object(
          'value', CASE WHEN t.pp > 0 THEN round(t.pa / t.pp, 3) END, 'coverage_pct', round(t.coverage * 100, 3),
          'actual_pct', round(t.pa / t.pwt * 100, 3), 'planned_pct', round(t.pp / t.pwt * 100, 3)) END,
      'activities', aj.j, 'planned_activities', aj.jp, 'items', ij.j
    ) ORDER BY CASE WHEN p_group = 'region' THEN lpad(t.gk, 3, '0') ELSE t.gk END), '[]'::jsonb)
  INTO out_ FROM tot t JOIN aj ON aj.gk = t.gk LEFT JOIN ij ON ij.gk = t.gk;
  RETURN out_;
END $$;

-- The Project Status card. Project-wide: a central item with a value in force is measured (its `manual` block, and its `plan` block when it has one).
-- Any other scope: every weighted central item is left out (central_hidden, counted in central_items_hidden) and the values in force are shown in
-- `central_line`, outside the local figure (Q175). central_line.progress_pct weighs each value by activity weight x item weight / the item weights of
-- its activity (its share of the project figure).
CREATE OR REPLACE FUNCTION dash_ps_card(p_project_wide boolean, p_rows_none jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE head jsonb; acts jsonb; hidden int; cline jsonb;
BEGIN
  head := coalesce(p_rows_none, public.dash_ps_rows('none', p_project_wide)) -> 0;
  WITH ic AS (SELECT c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic FROM _dic c JOIN _dsite s ON s.id = c.site_id GROUP BY c.act, c.item),
  it0 AS (
    SELECT w.act, w.item, w.item_name, w.item_name_ar, w.iw, w.unit, w.method, w.central, ic.applic, ic.done,
           (p_project_wide AND w.central AND w.method <> 'tasks' AND m.item IS NOT NULL) AS is_manual, m.pct AS mpct, m.value_pct AS mval, m.effective_date AS meff, m.version AS mver,
           mp.planned_pct AS pplan, mp.version AS pver
    FROM _dwi w LEFT JOIN ic ON ic.item = w.item LEFT JOIN _dman m ON m.item = w.item LEFT JOIN _dmplan mp ON mp.item = w.item WHERE w.item IS NOT NULL
  ), it AS (
    SELECT it0.*,
           CASE WHEN it0.is_manual THEN least(1, greatest(0, it0.mpct)) WHEN it0.applic > 0 THEN least(1, it0.done::numeric / it0.applic) END AS pct,
           (it0.iw > 0 AND (it0.is_manual OR (it0.method = 'tasks' AND coalesce(it0.applic, 0) > 0 AND NOT (it0.central AND NOT p_project_wide)))) AS measured
    FROM it0
  ), a AS (
    SELECT w.act, max(w.act_name) AS name, max(w.act_name_ar) AS name_ar, max(w.aw) AS aw, max(w.asort) AS asort FROM _dwi w GROUP BY w.act
  )
  SELECT jsonb_agg(jsonb_build_object('code', a.act, 'name_en', a.name, 'name_ar', a.name_ar, 'weight', a.aw,
      'progress_pct', coalesce((SELECT round(sum(i.iw * i.pct) / nullif(sum(i.iw) FILTER (WHERE i.measured), 0) * 100, 3) FROM it i WHERE i.act = a.act AND i.measured), 0),
      'measured', EXISTS (SELECT 1 FROM it i WHERE i.act = a.act AND i.measured),
      'items', (SELECT jsonb_agg(jsonb_build_object('code', i.item, 'name_en', i.item_name, 'name_ar', i.item_name_ar, 'weight', i.iw, 'unit', i.unit,
          'progress_pct', round(coalesce(i.pct, 0) * 100, 3), 'measured', i.measured, 'done', coalesce(i.done, 0), 'applicable', coalesce(i.applic, 0),
          'central', i.central,
          'manual', CASE WHEN i.is_manual THEN jsonb_build_object('value_pct', i.mval, 'effective_date', i.meff, 'version', i.mver) END,
          'plan', CASE WHEN i.is_manual AND i.pver IS NOT NULL THEN jsonb_build_object('planned_pct', i.pplan, 'version', i.pver) END,
          'reason', CASE WHEN i.iw = 0 THEN 'not_weighted' WHEN i.measured THEN NULL WHEN i.central AND NOT p_project_wide THEN 'central_hidden' WHEN i.method <> 'tasks' THEN 'no_data' WHEN coalesce(i.applic, 0) = 0 THEN 'not_applicable' END)
          ORDER BY i.item) FROM it i WHERE i.act = a.act)) ORDER BY a.asort)
  INTO acts FROM a;
  SELECT count(*) INTO hidden FROM _dwi w WHERE w.item IS NOT NULL AND w.central AND NOT p_project_wide AND w.iw > 0;
  IF NOT p_project_wide THEN
    WITH sw AS (SELECT act, sum(iw) AS s FROM _dwi WHERE item IS NOT NULL AND iw > 0 GROUP BY act),
    c AS (
      SELECT w.act, w.item, w.item_name, w.item_name_ar, w.iw, w.aw, w.isort, w.asort, m.value_pct, m.effective_date, m.version, w.aw * w.iw / sw.s AS share
      FROM _dwi w JOIN sw ON sw.act = w.act LEFT JOIN _dman m ON m.item = w.item
      WHERE w.item IS NOT NULL AND w.central AND w.method <> 'tasks' AND w.iw > 0
    )
    SELECT jsonb_build_object('total', count(*), 'measured', count(*) FILTER (WHERE c.value_pct IS NOT NULL),
      'progress_pct', round(sum(c.share * c.value_pct) FILTER (WHERE c.value_pct IS NOT NULL) / nullif(sum(c.share) FILTER (WHERE c.value_pct IS NOT NULL), 0), 3),
      'items', coalesce(jsonb_agg(jsonb_build_object('code', c.item, 'name_en', c.item_name, 'name_ar', c.item_name_ar, 'activity_code', c.act, 'weight', c.iw,
          'value_pct', c.value_pct, 'effective_date', c.effective_date, 'version', c.version) ORDER BY c.asort, c.isort) FILTER (WHERE c.value_pct IS NOT NULL), '[]'::jsonb))
    INTO cline FROM c;
  END IF;
  RETURN jsonb_build_object('progress_pct', coalesce((head ->> 'progress_pct')::numeric, 0), 'planned_pct', head -> 'planned_pct', 'spi', head -> 'spi',
    'progress_vs_plan_index', head -> 'progress_vs_plan_index', 'partial_index', head -> 'partial_index',
    'plan_coverage_pct', coalesce((head ->> 'plan_coverage_pct')::numeric, 0), 'activities', coalesce(acts, '[]'::jsonb), 'central_items_hidden', hidden,
    'manual_items_measured', CASE WHEN p_project_wide THEN (SELECT count(*) FROM _dwi w JOIN _dman m ON m.item = w.item WHERE w.central AND w.method <> 'tasks' AND w.iw > 0) ELSE 0 END,
    'manual_items_planned', CASE WHEN p_project_wide THEN (SELECT count(*) FROM _dwi w JOIN _dman m ON m.item = w.item JOIN _dmplan mp ON mp.item = w.item WHERE w.central AND w.method <> 'tasks' AND w.iw > 0) ELSE 0 END,
    'central_line', cline);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Q182, Q184: proposed and approved delay periods
-- ---------------------------------------------------------------------------------------------------------------------
-- May the actor propose a period on the task? L1 (an entry holder of the task) or anyone who decides (delay_period_can_edit of 0046).
CREATE OR REPLACE FUNCTION delay_period_can_propose(p_task uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = a AND u.status = 'active') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = p_task) THEN RETURN false; END IF;
  RETURN public.delay_period_can_edit(p_task) OR public.wf_is_eligible(p_task, 'entry', a);
END $$;

CREATE OR REPLACE FUNCTION delay_period_json(p public.task_delay_periods) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', p.id, 'task_id', p.task_id, 'from_date', p.from_date, 'to_date', p.to_date, 'party', p.party,
    'external_party_id', p.external_party_id, 'reason', p.reason, 'evidence', p.evidence, 'status', p.status, 'created_by', p.created_by, 'created_at', p.created_at,
    'decided_by', p.decided_by, 'decided_at', p.decided_at, 'decision_note', p.decision_note,
    'voided_at', p.voided_at, 'voided_by', p.voided_by, 'void_reason', p.void_reason)
$$;

-- Propose a period (Q182): no effect until it is approved. The external party is optional here (Q184). A period that overlaps an active proposal or
-- approved period of the task is refused.
CREATE OR REPLACE FUNCTION delay_period_propose(p_task uuid, p_from date, p_to date, p_party text, p_external uuid, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); t record; errs jsonb := '[]'::jsonb; r public.task_delay_periods%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'delay periods: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT ti.id, ti.site_id, ti.region_id INTO t FROM public.task_instances ti WHERE ti.id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
  IF NOT public.delay_period_can_propose(p_task) THEN
    RAISE EXCEPTION 'delay periods: L1 or L2 of the task, a System Admin or a holder of dashboard.delay edit proposes them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_from IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/from_date', 'code', 'required', 'message', 'From is required.')); END IF;
  IF p_to IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/to_date', 'code', 'required', 'message', 'To is required.')); END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/to_date', 'code', 'before_from', 'message', 'To is on or after From.'));
  END IF;
  IF p_party IS NULL OR p_party NOT IN ('gecol', 'hlc', 'client', 'contractor', 'external', 'aljeel') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/party', 'code', 'invalid', 'message', 'The party is gecol, hlc, client, contractor, external or aljeel.'));
  END IF;
  IF p_external IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.external_parties ep WHERE ep.id = p_external) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/external_party_id', 'code', 'unknown', 'message', 'There is no such external party.'));
  END IF;
  IF p_evidence IS NOT NULL AND char_length(p_evidence) > 2000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/evidence', 'code', 'too_long', 'message', 'The evidence is at most 2000 characters.'));
  END IF;
  IF jsonb_array_length(errs) = 0 AND EXISTS (SELECT 1 FROM public.task_delay_periods x WHERE x.task_id = p_task AND x.voided_at IS NULL AND x.status IN ('proposed', 'approved')
                                               AND daterange(x.from_date, x.to_date, '[]') && daterange(p_from, p_to, '[]')) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/from_date', 'code', 'period_overlap', 'message', 'The period overlaps another period of this task.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.task_delay_periods (task_id, site_id, region_id, from_date, to_date, party, external_party_id, reason, evidence, created_by, status)
  VALUES (p_task, t.site_id, t.region_id, p_from, p_to, p_party, p_external, btrim(p_reason), nullif(btrim(coalesce(p_evidence, '')), ''), a, 'proposed') RETURNING * INTO r;
  PERFORM public.log_audit_write('delay_period.proposed', 'task_delay_period', r.id::text, NULL, public.delay_period_json(r), btrim(p_reason), t.site_id, t.region_id);
  RETURN public.delay_period_json(r);
END $$;

-- The 0046 entry point: since 0059 it proposes (no immediate effect).
CREATE OR REPLACE FUNCTION delay_period_add(p_task uuid, p_from date, p_to date, p_party text, p_external uuid, p_reason text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.delay_period_propose(p_task, p_from, p_to, p_party, p_external, p_reason, NULL::text)
$$;

-- Decide a proposal (Q182): approve or reject, by L2, a System Admin or a dashboard.delay edit holder of the region, never by the proposer.
-- A rejection needs a note. Approving a contractor or external period needs the external party (Q184): the proposal's, or p_external when it had none.
CREATE OR REPLACE FUNCTION delay_period_decide(p_id uuid, p_decision text, p_note text, p_external uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); p public.task_delay_periods%ROWTYPE; r public.task_delay_periods%ROWTYPE; ext uuid;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'delay periods: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO p FROM public.task_delay_periods WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(p.region_id) THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The period does not exist or is not visible to you.')); END IF;
  IF NOT public.delay_period_can_edit(p.task_id) THEN
    RAISE EXCEPTION 'delay periods: the reviewer of the task, a System Admin or a holder of dashboard.delay edit decides them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/decision', 'code', 'invalid', 'message', 'The decision is approve or reject.'))));
  END IF;
  IF p.voided_at IS NOT NULL OR p.status <> 'proposed' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'The period is not waiting for a decision.')); END IF;
  IF p.created_by = a THEN
    RAISE EXCEPTION 'delay periods: you cannot decide a period you proposed yourself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision = 'reject' THEN
    IF char_length(btrim(coalesce(p_note, ''))) < 3 THEN
      PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/note', 'code', 'required', 'message', 'A rejection needs a note of at least 3 characters.'))));
    END IF;
    UPDATE public.task_delay_periods SET status = 'rejected', decided_by = a, decided_at = clock_timestamp(), decision_note = btrim(p_note) WHERE id = p_id RETURNING * INTO r;
  ELSE
    IF p_external IS NOT NULL AND p.external_party_id IS NOT NULL AND p_external <> p.external_party_id THEN
      PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/external_party_id', 'code', 'already_named',
        'message', 'The proposal names another external party: reject it and propose again.'))));
    END IF;
    IF p_external IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.external_parties ep WHERE ep.id = p_external) THEN
      PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/external_party_id', 'code', 'unknown', 'message', 'There is no such external party.'))));
    END IF;
    ext := coalesce(p.external_party_id, p_external);
    IF p.party IN ('contractor', 'external') AND ext IS NULL THEN
      PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/external_party_id', 'code', 'external_party_required',
        'message', 'Name the contractor or external party before approving: an unknown party stays pending.'))));
    END IF;
    IF EXISTS (SELECT 1 FROM public.task_delay_periods x WHERE x.task_id = p.task_id AND x.id <> p.id AND x.voided_at IS NULL AND x.status = 'approved'
               AND daterange(x.from_date, x.to_date, '[]') && daterange(p.from_date, p.to_date, '[]')) THEN
      PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/from_date', 'code', 'period_overlap', 'message', 'The period overlaps an approved period of this task.'))));
    END IF;
    UPDATE public.task_delay_periods SET status = 'approved', decided_by = a, decided_at = clock_timestamp(), decision_note = nullif(btrim(coalesce(p_note, '')), ''), external_party_id = ext
    WHERE id = p_id RETURNING * INTO r;
  END IF;
  PERFORM public.log_audit_write(CASE WHEN p_decision = 'approve' THEN 'delay_period.approved' ELSE 'delay_period.rejected' END, 'task_delay_period', r.id::text,
    public.delay_period_json(p), public.delay_period_json(r), coalesce(nullif(btrim(coalesce(p_note, '')), ''), p_decision), r.site_id, r.region_id);
  RETURN public.delay_period_json(r);
END $$;

-- Void (0046) with the reason. A decider voids a proposal or an approved period; the proposer may also withdraw their own proposal. A rejected one stays.
CREATE OR REPLACE FUNCTION delay_period_void(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); p public.task_delay_periods%ROWTYPE; r public.task_delay_periods%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'delay periods: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO p FROM public.task_delay_periods WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(p.region_id) THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The period does not exist or is not visible to you.')); END IF;
  IF NOT (public.delay_period_can_edit(p.task_id) OR (p.status = 'proposed' AND p.created_by = a)) THEN
    RAISE EXCEPTION 'delay periods: the reviewer of the task, a System Admin or a holder of dashboard.delay edit voids them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p.voided_at IS NOT NULL THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'The period is voided already.')); END IF;
  IF p.status = 'rejected' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'A rejected period is kept as it is.')); END IF;
  UPDATE public.task_delay_periods SET voided_at = clock_timestamp(), voided_by = a, void_reason = btrim(p_reason) WHERE id = p_id RETURNING * INTO r;
  PERFORM public.log_audit_write('delay_period.voided', 'task_delay_period', r.id::text, public.delay_period_json(p), public.delay_period_json(r), btrim(p_reason), r.site_id, r.region_id);
  RETURN public.delay_period_json(r);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q7, Q180, Q181, Q182, Q184: delay attribution
-- ---------------------------------------------------------------------------------------------------------------------
-- Day by day over the late tasks of _dtask:
--   window     the working days after the due date (Q181: rebuilt from the SLA start plus the rule's maximum when the due date is missing) up to the
--              reference date (open) or the end of the SLA clock (closed);
--   minus      the days of a Change Control suspension of the site (Q180: [coalesce(suspension_start, approval_date), first later
--              coalesce(resumption_date, approval_date)) );
--   attributed the approved, not voided period of the task that covers the day (a contractor or external one only with its external party, Q184);
--   otherwise  unattributed (Q7), with the R party as a suggestion; a task whose window cannot be built or is empty gives its days over the maximum
--              as a data gap, unattributed, with no suggestion (Q181).
CREATE OR REPLACE FUNCTION dash_sec_delay(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH wm AS (
    -- the last day of each working-day count: the rebuilt due day is the last day whose count is the start's count plus the maximum (Q181)
    SELECT c.wd, max(c.d) AS d FROM _dcal c GROUP BY c.wd
  ), lt AS (
    SELECT t.id, t.site_id, t.days_over, t.external_party_id, t.default_party,
           coalesce(t.due_date, wm.d) AS due_d,
           CASE WHEN t.phase = 'open' THEN p_ref ELSE least(p_ref, coalesce(ti.sla_end_date, t.done_date, p_ref)) END AS end_d
    FROM _dtask t JOIN public.task_instances ti ON ti.id = t.id LEFT JOIN public.sla_rules r ON r.id = ti.sla_rule_id
    LEFT JOIN _dcal c0 ON t.due_date IS NULL AND c0.d = ti.sla_start_date
    LEFT JOIN wm ON t.due_date IS NULL AND wm.wd = c0.wd + r.max_working_days
    WHERE t.phase <> 'none' AND t.cls = 'late' AND t.days_over > 0
  ), dy AS (
    SELECT lt.id, lt.site_id, c.d FROM lt JOIN _dcal c ON c.is_wd AND c.d > lt.due_d AND c.d <= lt.end_d WHERE lt.due_d IS NOT NULL
  ), susp AS (
    SELECT s.site_id, coalesce(s.suspension_start, s.approval_date) AS f,
           (SELECT min(coalesce(x.resumption_date, x.approval_date)) FROM public.change_requests x
             WHERE x.site_id = s.site_id AND x.kind = 'resumption' AND x.status IN ('approved', 'applied')
               AND coalesce(x.resumption_date, x.approval_date) > coalesce(s.suspension_start, s.approval_date)) AS t
    FROM public.change_requests s
    WHERE s.kind = 'suspension' AND s.status IN ('approved', 'applied') AND coalesce(s.suspension_start, s.approval_date) <= p_ref
      AND s.site_id IN (SELECT site_id FROM lt)
  ), eff AS (
    SELECT p.* FROM public.task_delay_periods p
    WHERE p.task_id IN (SELECT id FROM lt) AND p.voided_at IS NULL AND p.status = 'approved' AND NOT (p.party IN ('contractor', 'external') AND p.external_party_id IS NULL)
  ), dd AS (
    SELECT dy.id, dy.site_id, dy.d,
      EXISTS (SELECT 1 FROM susp WHERE susp.site_id = dy.site_id AND dy.d >= susp.f AND (susp.t IS NULL OR dy.d < susp.t)) AS suspended,
      (SELECT e.id FROM eff e WHERE e.task_id = dy.id AND dy.d BETWEEN e.from_date AND e.to_date ORDER BY e.from_date, e.created_at LIMIT 1) AS period_id,
      EXISTS (SELECT 1 FROM public.task_delay_periods q WHERE q.task_id = dy.id AND q.voided_at IS NULL AND q.status = 'proposed' AND dy.d BETWEEN q.from_date AND q.to_date) AS proposed
    FROM dy
  ), rows_ AS (
    SELECT dd.id AS task_id, 1 AS wd, dd.suspended, dd.proposed, false AS gap, e.party AS period_party, e.external_party_id AS period_ext, lt.external_party_id, lt.default_party
    FROM dd JOIN lt ON lt.id = dd.id LEFT JOIN eff e ON e.id = dd.period_id
    UNION ALL
    SELECT lt.id, lt.days_over, false, false, true, NULL, NULL, lt.external_party_id, lt.default_party
    FROM lt WHERE NOT EXISTS (SELECT 1 FROM dy WHERE dy.id = lt.id)
  ), keyed AS (
    SELECT r.task_id, r.wd, r.suspended, r.proposed, r.gap, r.period_party,
      CASE WHEN r.period_party IS NOT NULL THEN 'period:' || r.period_party || coalesce(':' || r.period_ext::text, '')
           WHEN r.gap THEN 'gap'
           WHEN r.external_party_id IS NOT NULL THEN 'un:party:' || r.external_party_id::text
           WHEN r.default_party IS NOT NULL THEN 'un:type:' || r.default_party ELSE 'un:none' END AS pkey,
      CASE WHEN r.period_party IS NOT NULL THEN 'period' ELSE 'unattributed' END AS kind,
      CASE WHEN r.period_party IS NOT NULL THEN coalesce(pe.name, r.period_party) ELSE 'unattributed' END AS party,
      CASE WHEN r.period_party IS NOT NULL THEN r.period_ext END AS ext_id,
      CASE WHEN r.period_party IS NOT NULL THEN pe.type::text END AS ptype,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN coalesce(ep.name, r.default_party) END AS sparty,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN r.external_party_id END AS sext,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN CASE WHEN r.external_party_id IS NOT NULL THEN 'external' WHEN r.default_party IS NOT NULL THEN 'default_type' END END AS skind,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN coalesce(ep.type::text, r.default_party) END AS stype
    FROM rows_ r LEFT JOIN public.external_parties ep ON ep.id = r.external_party_id LEFT JOIN public.external_parties pe ON pe.id = r.period_ext
  ), g AS (
    SELECT pkey, max(kind) AS kind, max(party) AS party, max(ext_id::text) AS external_party_id, max(ptype) AS ptype, max(period_party) AS period_party,
           max(sparty) AS sparty, max(sext::text) AS sext, max(skind) AS skind, max(stype) AS stype, bool_or(gap) AS gap,
           count(DISTINCT task_id) AS late_tasks, sum(wd) AS wd
    FROM keyed WHERE NOT suspended GROUP BY pkey
  ), tot AS (
    SELECT coalesce(sum(wd), 0) AS wd, coalesce(sum(wd) FILTER (WHERE kind = 'unattributed'), 0) AS un, coalesce(sum(wd) FILTER (WHERE kind = 'period'), 0) AS per,
           coalesce(sum(wd) FILTER (WHERE gap), 0) AS gap FROM g
  )
  SELECT jsonb_build_object('total_late_working_days', tot.wd,
    'attributed_working_days', tot.per, 'period_working_days', tot.per, 'unattributed_working_days', tot.un, 'data_gap_working_days', tot.gap,
    'attributed_pct', CASE WHEN tot.wd > 0 THEN round(tot.per * 100.0 / tot.wd, 2) ELSE 0 END,
    'unattributed_pct', CASE WHEN tot.wd > 0 THEN round(tot.un * 100.0 / tot.wd, 2) ELSE 0 END,
    'proposed_working_days', (SELECT count(*) FROM keyed WHERE NOT suspended AND kind = 'unattributed' AND proposed),
    'overlapping_periods', 0, 'periods_supported', true,
    'suspended_working_days', (SELECT count(*) FROM keyed WHERE suspended),
    'periods_count', (SELECT count(*) FROM eff),
    'proposals_count', (SELECT count(*) FROM public.task_delay_periods p WHERE p.voided_at IS NULL AND p.status = 'proposed' AND p.task_id IN (SELECT id FROM lt)),
    'pending_party_count', (SELECT count(*) FROM public.task_delay_periods p WHERE p.voided_at IS NULL AND p.status = 'approved' AND p.party IN ('contractor', 'external')
                              AND p.external_party_id IS NULL AND p.task_id IN (SELECT id FROM lt)),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('party', g.party, 'external_party_id', g.external_party_id, 'party_type', g.ptype, 'kind', g.kind,
        'period_party', g.period_party, 'data_gap', g.gap,
        'suggested_party', CASE WHEN g.sparty IS NOT NULL THEN jsonb_build_object('name', g.sparty, 'kind', g.skind, 'external_party_id', g.sext, 'party_type', g.stype) END,
        'late_tasks', g.late_tasks, 'late_working_days', g.wd, 'share_pct', round(g.wd * 100.0 / nullif(tot.wd, 0), 2))
        ORDER BY g.wd DESC, g.party, g.pkey) FROM g), '[]'::jsonb),
    'scorecard', coalesce((SELECT jsonb_agg(jsonb_build_object('party', g.party, 'period_party', g.period_party, 'external_party_id', g.external_party_id, 'party_type', g.ptype,
        'late_tasks', g.late_tasks, 'late_working_days', g.wd) ORDER BY g.wd DESC, g.party) FROM g WHERE g.kind = 'period'), '[]'::jsonb))
  INTO out_ FROM tot;
  RETURN out_;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Q186 (B part), D16: orchestration
-- ---------------------------------------------------------------------------------------------------------------------
-- The Africa/Tripoli date of a time (the zone of cal_today).
CREATE OR REPLACE FUNCTION dash_local_date(p_at timestamptz) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (p_at AT TIME ZONE coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli'))::date
$$;

-- 0046 body, plus: blocked gates are known only live, or from a snapshot taken on its own date (Q186); the health factors carry a draft flag (D16).
CREATE OR REPLACE FUNCTION dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid,
  p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean, p_view text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; wf_versions int[];
  rows_none jsonb; rows_region jsonb; ms jsonb; live boolean := (p_ref = public.cal_today()); blk_ok boolean; appr text[]; gt jsonb;
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  blk_ok := CASE WHEN p_snap IS NULL THEN live
                 ELSE EXISTS (SELECT 1 FROM public.site_snapshots ss WHERE ss.snapshot_date = p_snap AND public.dash_local_date(ss.created_at) = p_snap) END;
  IF p_snap IS NULL AND (p_stream IS NOT NULL OR p_sections && ARRAY['streams']) THEN PERFORM public.dash_build_streams(p_ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  IF p_view IS NOT NULL THEN
    PERFORM public.dash_build_view(p_view);
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM public.task_instances t JOIN _dview v ON v.id = t.task_def_id
                                           WHERE t.site_id = s.id AND t.state NOT IN ('na', 'skipped') AND NOT t.is_na);
  END IF;
  all_regions := p_scope IS NULL OR NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id <> ALL (p_scope));
  wide := all_regions AND p_region IS NULL AND p_cluster IS NULL AND p_scenario IS NULL AND p_stream IS NULL AND p_view IS NULL;
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
  IF need_tasks THEN
    PERFORM public.dash_build_tasks(p_ref, p_stream, p_excl);
    IF p_view IS NOT NULL THEN
      DELETE FROM _dtask x WHERE NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN _dview v ON v.id = ti.task_def_id WHERE ti.id = x.id);
    END IF;
  END IF;

  SELECT array_agg(DISTINCT wd.version ORDER BY wd.version) INTO wf_versions FROM _dsite s JOIN public.workflow_definitions wd ON wd.id = s.wf;
  SELECT count(*) INTO flagged FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.admin_override;
  out_ := jsonb_build_object('meta', jsonb_build_object('project_wide', wide, 'workflow_versions', coalesce(to_jsonb(wf_versions), '[]'::jsonb), 'override_flagged_count', flagged,
    'overrides_excluded', p_excl, 'weight_set_id', ws, 'blocked_gates_available', blk_ok));

  IF p_sections && ARRAY['headline'] THEN
    out_ := out_ || jsonb_build_object('headline', public.dash_sec_status(p_ref) || jsonb_build_object('final_closure', public.dash_sec_closure(p_ref), 'project_status', ps_card));
  END IF;
  IF p_sections && ARRAY['pipeline', 'headline'] THEN
    ms := public.dash_sec_milestones(p_ref, CASE WHEN p_stream IN (SELECT DISTINCT stream_code FROM _dms WHERE stream_code IS NOT NULL) THEN p_stream END);
    IF p_view IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(x.e ORDER BY x.n), '[]'::jsonb) INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n) WHERE x.e ->> 'code' IN (SELECT code FROM _dviewms);
    END IF;
    -- Q186: a blocked count that cannot be known for the date is null ("historically unavailable"), not 0
    SELECT coalesce(jsonb_agg(CASE WHEN blk_ok THEN x.e || jsonb_build_object('blocked_available', true)
                                   ELSE x.e || jsonb_build_object('blocked', NULL, 'blocked_available', false) END ORDER BY x.n), '[]'::jsonb)
    INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n);
    out_ := out_ || jsonb_build_object('milestones', ms);
  END IF;
  IF p_sections && ARRAY['streams'] THEN out_ := out_ || jsonb_build_object('streams', public.dash_sec_streams()); END IF;
  IF p_sections && ARRAY['sla'] THEN out_ := out_ || jsonb_build_object('sla', public.dash_sec_sla(p_ref)); END IF;
  IF p_sections && ARRAY['gates'] THEN
    IF live THEN gt := public.dash_sec_gates(p_ref) || jsonb_build_object('status', 'live');
    ELSIF blk_ok THEN
      gt := jsonb_build_object('available', false, 'status', 'snapshot', 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb,
        'blocked_total', (SELECT count(*) FROM _dms m JOIN _dsite s ON s.id = m.site_id AND NOT s.cancelled WHERE m.blocked));
    ELSE
      gt := jsonb_build_object('available', false, 'status', 'historically_unavailable', 'blocked_total', NULL, 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb);
    END IF;
    out_ := out_ || jsonb_build_object('gates', gt);
  END IF;
  IF p_sections && ARRAY['issues'] THEN
    out_ := out_ || jsonb_build_object('issues', CASE WHEN p_issues THEN public.dash_sec_issues(p_ref, p_issue_scope) ELSE NULL END);
  END IF;
  IF p_sections && ARRAY['health', 'regions'] THEN
    hl := public.dash_sec_health(p_ref, wide, p_issue_scope, p_issues, rows_none, rows_region);
    -- D16: the draft label sits on each factor the owner has not approved; the index itself carries none (Q121)
    SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO appr FROM jsonb_array_elements_text(public.calc_setting('dashboard.health_approved_factors', '["D", "I"]'::jsonb)) x;
    hl := hl || jsonb_build_object('draft', false,
      'components', coalesce((SELECT jsonb_agg(c.e || jsonb_build_object('draft', NOT ((c.e ->> 'code') = ANY (appr))) ORDER BY c.n)
                              FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)), '[]'::jsonb),
      'draft_factors', coalesce((SELECT jsonb_agg(c.e ->> 'code' ORDER BY c.n) FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)
                                 WHERE NOT ((c.e ->> 'code') = ANY (appr))), '[]'::jsonb),
      'approved_factors', to_jsonb(appr));
  END IF;
  IF p_sections && ARRAY['health'] THEN out_ := out_ || jsonb_build_object('health', hl); END IF;
  IF p_sections && ARRAY['delay'] THEN out_ := out_ || jsonb_build_object('delay', public.dash_sec_delay(p_ref)); END IF;
  IF p_sections && ARRAY['regions'] THEN out_ := out_ || jsonb_build_object('regions', public.dash_sec_regions(hl, true, rows_region)); END IF;
  IF p_sections && ARRAY['ps'] THEN
    out_ := out_ || jsonb_build_object('ps', jsonb_build_object('card', ps_card, 'rows', CASE WHEN p_group = 'region' THEN rows_region WHEN p_group = 'site' THEN public.dash_ps_rows('site', wide) ELSE '[]'::jsonb END,
      'sites_in_scope', (SELECT count(*) FROM _dsite WHERE NOT cancelled)));
  END IF;
  RETURN out_;
END $$;

-- The kinds of the snapshots of the list (0046), plus `rebuilt` (Q186): the snapshot was taken after its own date (a catch-up or one taken by hand
-- for an earlier date), so its blocked gates are historically unavailable; `taken_at` is when it was stored.
CREATE OR REPLACE FUNCTION dash_snapshot_kind_list(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', q.d, 'kinds', q.kinds,
      'kind', CASE WHEN 'month_end' = ANY (q.kinds) THEN 'month_end' WHEN 'weekly' = ANY (q.kinds) THEN 'weekly' ELSE 'manual' END,
      'rebuilt', public.dash_local_date(q.taken_at) <> q.d, 'taken_at', q.taken_at) ORDER BY q.d DESC), '[]'::jsonb)
  FROM (SELECT s.d, s.taken_at, coalesce((SELECT array_agg(r.kind ORDER BY r.kind) FROM public.dash_snapshot_runs r WHERE r.snapshot_date = s.d), ARRAY[]::text[]) AS kinds
        FROM (SELECT snapshot_date AS d, min(created_at) AS taken_at FROM public.site_snapshots GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT p_limit) s) q
$$;

-- D186: the weekly kind falls on the weekday of the setting, Thursday (4) by default.
CREATE OR REPLACE FUNCTION dash_snapshot_kinds(p_date date) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN extract(dow FROM p_date)::integer = coalesce((public.calc_setting('dashboard.snapshot_weekday', '4'::jsonb) #>> '{}')::integer, 4) THEN 'weekly' END,
    CASE WHEN p_date = (date_trunc('month', p_date) + interval '1 month' - interval '1 day')::date THEN 'month_end' END], NULL)
$$;

-- 0039 body; a snapshot of an earlier date stores blocked as null (unknown) instead of false (Q186).
CREATE OR REPLACE FUNCTION dash_snapshot_take(p_date date) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ws uuid; n integer := 0; r record; res jsonb; excl boolean := coalesce((public.calc_setting('dashboard.exclude_overrides', 'true'::jsonb) #>> '{}')::boolean, true); card jsonb;
  live boolean := (p_date = public.cal_today());
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
      coalesce((SELECT jsonb_object_agg(m.code, jsonb_build_object('state', m.state, 'date', m.d, 'baseline', m.base, 'seq', m.seq, 'stream', m.stream_code, 'gate_open', m.gate_open,
                  'blocked', CASE WHEN live THEN m.blocked END))
                FROM _dms m WHERE m.site_id = s.id), '{}'::jsonb),
      coalesce((SELECT jsonb_object_agg(x.stream, x.status) FROM _dstr x WHERE x.site_id = s.id), '{}'::jsonb),
      coalesce((SELECT jsonb_object_agg(c.item, jsonb_build_array(c.done, c.applic, c.planned, c.plan_known)) FROM _dic c WHERE c.site_id = s.id), '{}'::jsonb),
      ps.pct
    FROM _dsite s LEFT JOIN per_site ps ON ps.site_code = s.site_code
    ON CONFLICT (snapshot_date, site_id) DO NOTHING RETURNING 1
  ) SELECT count(*) INTO n FROM ins;
  FOR r IN SELECT NULL::integer AS region_id UNION ALL SELECT id FROM public.regions ORDER BY 1 NULLS FIRST LOOP
    res := public.dash_core(p_date, NULL, r.region_id, NULL, NULL, NULL, excl, ws, ARRAY['headline', 'pipeline', 'streams', 'health', 'ps'], NULL, 'none', NULL, true);
    card := res #> '{ps,card}';
    INSERT INTO progress_snapshots (snapshot_date, weight_set_id, region_id, is_global, actual_pct, planned_pct, spi, plan_coverage, health_index, values)
    VALUES (p_date, ws, r.region_id, r.region_id IS NULL, coalesce((card ->> 'progress_pct')::numeric, 0), (card ->> 'planned_pct')::numeric, (card ->> 'spi')::numeric,
      (card ->> 'plan_coverage_pct')::numeric, (res #>> '{health,score}')::numeric,
      jsonb_build_object('headline', res -> 'headline', 'milestones', res -> 'milestones', 'streams', res -> 'streams', 'health', res -> 'health', 'project_status', card,
        'blocked_gates_available', live))
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Q116: the pipeline style
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_pipeline_variant() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN (public.calc_setting('dashboard.pipeline_variant', '"A"'::jsonb) #>> '{}') = 'B' THEN 'B' ELSE 'A' END
$$;

-- A System Admin or a holder of dashboard administer (for all regions) sets it, with a reason; audited with before and after.
CREATE OR REPLACE FUNCTION dash_set_pipeline_variant(p_variant text, p_reason text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); before_ text;
BEGIN
  IF a IS NULL OR NOT public.app_can('dashboard', 'administer') THEN
    RAISE EXCEPTION 'dashboard: a System Admin or a holder of dashboard administer chooses the pipeline style' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_variant IS NULL OR p_variant NOT IN ('A', 'B') THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/variant', 'code', 'invalid', 'message', 'The variant is A or B.'))));
  END IF;
  before_ := public.dash_pipeline_variant();
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.pipeline_variant', to_jsonb(p_variant), 'Q116: the pipeline style of the dashboard: A = progress rings (default), B = flat segmented track.', now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  PERFORM public.log_audit_write('settings.updated', 'setting', 'dashboard.pipeline_variant', jsonb_build_object('value', before_), jsonb_build_object('value', p_variant), btrim(p_reason));
  RETURN p_variant;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Ownership and rights. Everything runs as pmis_definer; pmis_app calls only the entry points.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'dash\_%' OR p.proname LIKE 'ps\_manual\_%' OR p.proname LIKE 'delay\_period\_%'
                                           OR p.proname IN ('ps_central_items', 'ps_plan_pct'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname <> 'dash_wd' THEN EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig); END IF;
  END LOOP;
  ALTER FUNCTION dash_owner_rows_frozen() OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION ps_manual_set(text, numeric, date, text, text), ps_manual_can_correct(), ps_manual_plan_set(text, jsonb, text, text), ps_plan_pct(jsonb, date) TO pmis_app;
    GRANT EXECUTE ON FUNCTION delay_period_can_propose(uuid), delay_period_propose(uuid, date, date, text, uuid, text, text), delay_period_decide(uuid, text, text, uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_pipeline_variant(), dash_set_pipeline_variant(text, text) TO pmis_app;
    -- read only: the rows change only through the functions above
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ps_manual_plans FROM pmis_app;
    GRANT SELECT ON ps_manual_plans TO pmis_app;
  END IF;
END $$;
