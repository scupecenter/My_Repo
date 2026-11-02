-- 0046_dashboard_owner_answers: the dashboard follow-up from the owner's answers of 2026-11-02 (Q118, Q121, Q122, Q126, Q127).
-- Mirror: db/sql/045_dashboard_owner_answers.sql (kept identical to prisma/migrations/0046_dashboard_owner_answers/migration.sql).
--
-- What this adds
--   * Q118  Manual percentage of the central Project Status items (the project-wide items with no data in the PMIS: 1.3, 1.5, 3.2 to 3.9,
--           6.1, 6.6, 7.7, 8.1). ps_manual_values keeps every entry (value, effective date, reason, who, when; one version number per item),
--           append-only. ps_manual_set writes one (audited through log_audit_write). The value in force on a date is the entry with the latest
--           effective date on or before it (the highest version on the same date). A measured central item counts in every Project Status
--           figure by its weight, in every scope; meta.central_items_hidden counts only the central items still without a value.
--           A saved snapshot reads the values that were known when it was taken (created_at), so a later back-dated entry never moves it.
--           Writers: a System Admin, an active holder of a role named in the setting dashboard.manual_items.roles (default ["PM"]) on an
--           all-regions assignment, or anyone holding dashboard.project_status edit (a grant or a delegation) for all regions.
--   * Q121  Health index factors D and I approved: the health section is no longer a draft (health.draft false).
--   * Q122  Delay attribution periods on a task (from, to, party, reason), entered by the reviewer (an L2 holder of the task), a System Admin,
--           or anyone holding dashboard.delay edit in the task's region; voided with a reason, never deleted; audited. Delay attribution now
--           works day by day: the working days after the due date, minus the days under a Change Control suspension (suspension approval
--           date up to the day before the resumption approval date), go to the party of the period that covers them, otherwise to the rule of
--           0039 (the task's external party, else its default type, else unassigned). Periods of one task may not overlap.
--   * Q126  View filter (CW / TE / O&M of workflow_views) on the dashboard, beside the stream filter.
--   * Q127  Snapshot schedule: a weekly snapshot every Sunday (setting dashboard.snapshot_weekday, 0 = Sunday, Africa/Tripoli dates of
--           cal_today) and a month-end snapshot on the last day of every month. dash_snapshot_runs records (date, kind) once; a date is
--           never snapshotted twice (site_snapshots stays keyed by date). The daily job catches up a due date it missed within the last
--           dashboard.snapshot_catchup_days (7) days.
--
-- pmis_app reads the new tables and writes nothing in them (db/sql/app_grants.sql).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('dashboard.manual_items.roles', '["PM"]', 'Q118: role codes whose holders (on an all-regions assignment) enter the manual percentage of the central Project Status items. A System Admin and anyone holding dashboard.project_status edit for all regions may too.', now()),
  ('dashboard.snapshot_weekday', '0', 'Q127: the weekday of the weekly dashboard snapshot (0 = Sunday ... 6 = Saturday), on the Africa/Tripoli date.', now()),
  ('dashboard.snapshot_catchup_days', '7', 'Q127: the daily job takes a weekly or month-end snapshot that is due within this many days and was not taken (for example after a stop of the server).', now())
ON CONFLICT (key) DO NOTHING;

UPDATE settings SET description = 'Health index bands (Q35): green from this score, amber from this score, red below. Factors D and I approved by the owner (Q121).', updated_at = now()
WHERE key = 'dashboard.health_bands';
UPDATE settings SET description = 'Not used since 0046 (Q127): the weekly snapshot is taken on the weekday of dashboard.snapshot_weekday, and a month-end snapshot on the last day of each month.', updated_at = now()
WHERE key = 'dashboard.snapshot_every_days';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE ps_manual_values (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code      TEXT          NOT NULL CHECK (item_code ~ '^[A-Za-z0-9._-]{1,20}$'),
  version        INTEGER       NOT NULL CHECK (version >= 1),
  value_pct      NUMERIC(6, 3) NOT NULL CHECK (value_pct >= 0 AND value_pct <= 100),
  effective_date DATE          NOT NULL,
  reason         TEXT          NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  entered_by     UUID          NOT NULL REFERENCES users (id),
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (item_code, version)
);
CREATE INDEX ps_manual_values_item_idx ON ps_manual_values (item_code, effective_date DESC, version DESC);
ALTER TABLE ps_manual_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE ps_manual_values FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON ps_manual_values FOR SELECT USING (true);   -- project-wide figures, not region data; the API asks for dashboard.view

CREATE TABLE task_delay_periods (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID        NOT NULL REFERENCES task_instances (id) ON DELETE CASCADE,
  site_id           UUID        NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  region_id         INTEGER     NOT NULL REFERENCES regions (id),
  from_date         DATE        NOT NULL,
  to_date           DATE        NOT NULL,
  party             TEXT        NOT NULL CHECK (party IN ('gecol', 'hlc', 'client', 'contractor', 'external', 'aljeel')),
  external_party_id UUID        REFERENCES external_parties (id),
  reason            TEXT        NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  created_by        UUID        NOT NULL REFERENCES users (id),
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  voided_at         TIMESTAMPTZ(6),
  voided_by         UUID        REFERENCES users (id),
  void_reason       TEXT,
  CHECK (from_date <= to_date),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX task_delay_periods_task_idx ON task_delay_periods (task_id) WHERE voided_at IS NULL;
CREATE INDEX task_delay_periods_site_idx ON task_delay_periods (site_id);
ALTER TABLE task_delay_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_delay_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON task_delay_periods FOR SELECT USING (app_region_read(false, region_id));

CREATE TABLE dash_snapshot_runs (
  snapshot_date DATE        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('weekly', 'month_end')),
  sites         INTEGER     NOT NULL DEFAULT 0,
  source        TEXT        NOT NULL DEFAULT 'schedule' CHECK (source IN ('schedule', 'catch_up', 'migrated')),
  taken_at      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (snapshot_date, kind)
);
ALTER TABLE dash_snapshot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dash_snapshot_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON dash_snapshot_runs FOR SELECT USING (true);

-- The snapshots made before this migration were weekly ones (0039 took one every 7 days).
INSERT INTO dash_snapshot_runs (snapshot_date, kind, sites, source)
SELECT snapshot_date, 'weekly', count(*), 'migrated' FROM site_snapshots GROUP BY snapshot_date
ON CONFLICT DO NOTHING;

-- Append-only: a manual value and a snapshot run are never changed or deleted; a delay period only gets its void stamp once.
CREATE OR REPLACE FUNCTION dash_owner_rows_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END IF;
  IF TG_TABLE_NAME = 'task_delay_periods' THEN
    IF (to_jsonb(OLD) ->> 'voided_at') IS NULL AND (to_jsonb(NEW) ->> 'voided_at') IS NOT NULL
       AND (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason') = (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% rows are never rewritten', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER ps_manual_values_frozen BEFORE UPDATE OR DELETE ON ps_manual_values FOR EACH ROW EXECUTE FUNCTION dash_owner_rows_frozen();
CREATE TRIGGER task_delay_periods_frozen BEFORE UPDATE OR DELETE ON task_delay_periods FOR EACH ROW EXECUTE FUNCTION dash_owner_rows_frozen();
CREATE TRIGGER dash_snapshot_runs_frozen BEFORE UPDATE OR DELETE ON dash_snapshot_runs FOR EACH ROW EXECUTE FUNCTION dash_owner_rows_frozen();

GRANT SELECT, INSERT ON ps_manual_values, dash_snapshot_runs TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON task_delay_periods TO pmis_definer;
GRANT SELECT ON workflow_views, workflow_view_members, external_parties, roles, user_role_assignments, change_requests TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q118: manual percentage of the central items
-- ---------------------------------------------------------------------------------------------------------------------
-- May the signed-in actor enter a manual value? (System Admin and all-region grants through app_can; the roles of the setting on an all-regions assignment.)
CREATE OR REPLACE FUNCTION ps_manual_can_edit() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); roles_ text[];
BEGIN
  IF a IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = a AND u.status = 'active') THEN RETURN false; END IF;
  IF public.app_can('dashboard.project_status', 'edit') THEN RETURN true; END IF;
  SELECT array_agg(x) INTO roles_ FROM jsonb_array_elements_text(public.calc_setting('dashboard.manual_items.roles', '["PM"]'::jsonb)) x;
  RETURN EXISTS (SELECT 1 FROM public.user_role_assignments ua JOIN public.roles r ON r.id = ua.role_id AND r.is_active
                 WHERE ua.user_id = a AND ua.all_regions AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                   AND r.code = ANY (coalesce(roles_, '{}')));
END $$;

-- The central items of the Project Status weight set in force on a date (code, names, weight, activity).
CREATE OR REPLACE FUNCTION ps_central_items(p_on date) RETURNS TABLE (item_code text, name_en text, name_ar text, weight numeric, activity_code text, activity_name_en text, activity_name_ar text, sort integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.code, i.name, i.name_ar, i.weight, a.code, a.name, a.name_ar, (a.sort * 1000 + i.sort)
  FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id
  WHERE a.weight_set_id = public.weight_set_in_force('project_status', p_on)
    AND jsonb_typeof(i.measure_rule) = 'object' AND coalesce((i.measure_rule ->> 'central')::boolean, false) AND coalesce(i.measure_rule ->> 'method', 'none') <> 'tasks'
$$;

-- Enter a manual value (Q118). p_value 0..100 (3 decimals), p_effective today or earlier, reason required. Returns the new row as jsonb.
CREATE OR REPLACE FUNCTION ps_manual_set(p_item text, p_value numeric, p_effective date, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); w numeric; ver integer; prev public.ps_manual_values%ROWTYPE; r public.ps_manual_values%ROWTYPE; errs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.ps_manual_can_edit() THEN
    RAISE EXCEPTION 'project status: the Project Manager, a System Admin or a holder of dashboard.project_status edit for all regions enters manual values' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  SELECT c.weight INTO w FROM public.ps_central_items(public.cal_today()) c WHERE c.item_code = p_item;
  IF NOT FOUND OR coalesce(w, 0) <= 0 THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/item_code', 'code', 'not_central_item',
      'message', 'Only a weighted central item of the Project Status weight set in force takes a manual value.'))));
  END IF;
  IF p_value IS NULL OR p_value < 0 OR p_value > 100 OR round(p_value, 3) <> p_value THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/value_pct', 'code', 'invalid', 'message', 'The value is 0 to 100 with at most 3 decimals.'));
  END IF;
  IF p_effective IS NULL OR p_effective > public.cal_today() THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'in_future', 'message', 'The effective date is today or earlier.'));
  ELSIF p_effective < DATE '2020-01-01' THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'invalid', 'message', 'The effective date is too early.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.ps_manual.' || p_item));
  SELECT coalesce(max(version), 0) + 1 INTO ver FROM public.ps_manual_values WHERE item_code = p_item;
  SELECT * INTO prev FROM public.ps_manual_values WHERE item_code = p_item AND effective_date <= p_effective ORDER BY effective_date DESC, version DESC LIMIT 1;
  INSERT INTO public.ps_manual_values (item_code, version, value_pct, effective_date, reason, entered_by)
  VALUES (p_item, ver, p_value, p_effective, btrim(p_reason), a) RETURNING * INTO r;
  PERFORM public.log_audit_write('project_status.manual_value_set', 'ps_manual_value', p_item,
    CASE WHEN prev.id IS NULL THEN NULL ELSE jsonb_build_object('value_pct', prev.value_pct, 'effective_date', prev.effective_date, 'version', prev.version) END,
    jsonb_build_object('item_code', p_item, 'value_pct', r.value_pct, 'effective_date', r.effective_date, 'version', r.version, 'id', r.id), btrim(p_reason));
  RETURN jsonb_build_object('id', r.id, 'item_code', r.item_code, 'version', r.version, 'value_pct', r.value_pct, 'effective_date', r.effective_date,
    'reason', r.reason, 'entered_by', r.entered_by, 'created_at', r.created_at);
END $$;

-- The values in force on p_ref, as known at p_known (NULL = everything entered so far). Temporary table _dman (item, pct 0..1, value_pct, effective_date, version).
CREATE OR REPLACE FUNCTION dash_build_manual(p_ref date, p_known timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS _dman;
  CREATE TEMP TABLE _dman ON COMMIT DROP AS
    SELECT DISTINCT ON (v.item_code) v.item_code AS item, v.value_pct / 100.0 AS pct, v.value_pct, v.effective_date, v.version
    FROM public.ps_manual_values v
    WHERE v.effective_date <= p_ref AND (p_known IS NULL OR v.created_at <= p_known)
    ORDER BY v.item_code, v.effective_date DESC, v.version DESC;
  CREATE UNIQUE INDEX ON _dman (item);
END $$;

-- 0039 body plus the manual values of the reference date.
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
  PERFORM public.dash_build_manual(p_ref, NULL);
END $$;

-- 0039 body plus the manual values known when the snapshot was taken.
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
  PERFORM public.dash_build_manual(p_date, (SELECT min(created_at) FROM public.site_snapshots WHERE snapshot_date = p_date));
END $$;

-- Project Status rows (0039) with the measured central items: a central item with a manual value in force counts in every group of the call by its
-- weight. A manual item has no baseline, so a group that has one shows no Planned (the 0039 rule: Planned only when every measured item has a plan).
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
  ), g AS (
    SELECT DISTINCT gk, label FROM ic
  ), it AS (
    SELECT ic.gk, ic.label, w.act, w.item, w.item_name, w.iw, w.aw,
           least(1, ic.done::numeric / ic.applic) AS pct,
           CASE WHEN ic.plan_known = ic.applic THEN least(1, ic.planned::numeric / ic.applic) END AS ppct
    FROM ic JOIN _dwi w ON w.item = ic.item WHERE ic.applic > 0 AND w.iw > 0 AND NOT (w.central AND NOT p_project_wide)
    UNION ALL
    SELECT g.gk, g.label, w.act, w.item, w.item_name, w.iw, w.aw, least(1, greatest(0, m.pct)), NULL::numeric
    FROM g CROSS JOIN _dwi w JOIN _dman m ON m.item = w.item
    WHERE w.central AND w.method <> 'tasks' AND w.iw > 0
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

-- The Project Status card (0039) with the manual values: a central item with a value in force is measured (its `manual` block names the value, the
-- effective date and the version); central_items_hidden counts the weighted central items that still have no value, when the scope is not the project.
CREATE OR REPLACE FUNCTION dash_ps_card(p_project_wide boolean, p_rows_none jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE head jsonb; acts jsonb; hidden int;
BEGIN
  head := coalesce(p_rows_none, public.dash_ps_rows('none', p_project_wide)) -> 0;
  WITH ic AS (SELECT c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic FROM _dic c JOIN _dsite s ON s.id = c.site_id GROUP BY c.act, c.item),
  it0 AS (
    SELECT w.act, w.item, w.item_name, w.item_name_ar, w.iw, w.unit, w.method, w.central, ic.applic, ic.done,
           (w.central AND w.method <> 'tasks' AND m.item IS NOT NULL) AS is_manual, m.pct AS mpct, m.value_pct AS mval, m.effective_date AS meff, m.version AS mver
    FROM _dwi w LEFT JOIN ic ON ic.item = w.item LEFT JOIN _dman m ON m.item = w.item WHERE w.item IS NOT NULL
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
          'reason', CASE WHEN i.iw = 0 THEN 'not_weighted' WHEN i.measured THEN NULL WHEN i.method <> 'tasks' THEN 'no_data' WHEN i.central AND NOT p_project_wide THEN 'central_hidden' WHEN coalesce(i.applic, 0) = 0 THEN 'not_applicable' END)
          ORDER BY i.item) FROM it i WHERE i.act = a.act)) ORDER BY a.asort)
  INTO acts FROM a;
  SELECT count(*) INTO hidden FROM _dwi w WHERE w.item IS NOT NULL AND w.central AND NOT p_project_wide AND w.iw > 0
    AND NOT (w.method <> 'tasks' AND EXISTS (SELECT 1 FROM _dman m WHERE m.item = w.item));
  RETURN jsonb_build_object('progress_pct', coalesce((head ->> 'progress_pct')::numeric, 0), 'planned_pct', head -> 'planned_pct', 'spi', head -> 'spi',
    'plan_coverage_pct', coalesce((head ->> 'plan_coverage_pct')::numeric, 0), 'activities', coalesce(acts, '[]'::jsonb), 'central_items_hidden', hidden,
    'manual_items_measured', (SELECT count(*) FROM _dwi w JOIN _dman m ON m.item = w.item WHERE w.central AND w.method <> 'tasks' AND w.iw > 0));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q122: delay attribution periods
-- ---------------------------------------------------------------------------------------------------------------------
-- The reviewer of a task (an L2 holder; the review level of an older 3-level task too), a System Admin, or a holder of dashboard.delay edit in its region.
CREATE OR REPLACE FUNCTION delay_period_can_edit(p_task uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); reg integer; regs integer[];
BEGIN
  IF a IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = a AND u.status = 'active') THEN RETURN false; END IF;
  SELECT t.region_id INTO reg FROM public.task_instances t WHERE t.id = p_task;
  IF NOT FOUND THEN RETURN false; END IF;
  regs := public.wf_actor_regions('dashboard.delay', 'edit');
  IF regs IS NULL OR reg = ANY (regs) THEN RETURN true; END IF;
  RETURN public.wf_is_eligible(p_task, 'approve', a) OR public.wf_is_eligible(p_task, 'review', a);
END $$;

CREATE OR REPLACE FUNCTION delay_period_json(p public.task_delay_periods) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', p.id, 'task_id', p.task_id, 'from_date', p.from_date, 'to_date', p.to_date, 'party', p.party,
    'external_party_id', p.external_party_id, 'reason', p.reason, 'created_by', p.created_by, 'created_at', p.created_at,
    'voided_at', p.voided_at, 'voided_by', p.voided_by, 'void_reason', p.void_reason)
$$;

CREATE OR REPLACE FUNCTION delay_period_add(p_task uuid, p_from date, p_to date, p_party text, p_external uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); t record; errs jsonb := '[]'::jsonb; r public.task_delay_periods%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'delay periods: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT ti.id, ti.site_id, ti.region_id INTO t FROM public.task_instances ti WHERE ti.id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
  IF NOT public.delay_period_can_edit(p_task) THEN
    RAISE EXCEPTION 'delay periods: the reviewer of the task, a System Admin or a holder of dashboard.delay edit records them' USING ERRCODE = 'insufficient_privilege';
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
  IF jsonb_array_length(errs) = 0 AND EXISTS (SELECT 1 FROM public.task_delay_periods x WHERE x.task_id = p_task AND x.voided_at IS NULL
                                               AND daterange(x.from_date, x.to_date, '[]') && daterange(p_from, p_to, '[]')) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/from_date', 'code', 'period_overlap', 'message', 'The period overlaps another period of this task.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.task_delay_periods (task_id, site_id, region_id, from_date, to_date, party, external_party_id, reason, created_by)
  VALUES (p_task, t.site_id, t.region_id, p_from, p_to, p_party, p_external, btrim(p_reason), a) RETURNING * INTO r;
  PERFORM public.log_audit_write('delay_period.added', 'task_delay_period', r.id::text, NULL, public.delay_period_json(r), btrim(p_reason), t.site_id, t.region_id);
  RETURN public.delay_period_json(r);
END $$;

CREATE OR REPLACE FUNCTION delay_period_void(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); p public.task_delay_periods%ROWTYPE; r public.task_delay_periods%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'delay periods: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO p FROM public.task_delay_periods WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(p.region_id) THEN PERFORM public.calc_err('not_found', jsonb_build_object('detail', 'The period does not exist or is not visible to you.')); END IF;
  IF NOT public.delay_period_can_edit(p.task_id) THEN
    RAISE EXCEPTION 'delay periods: the reviewer of the task, a System Admin or a holder of dashboard.delay edit voids them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p.voided_at IS NOT NULL THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'The period is voided already.')); END IF;
  UPDATE public.task_delay_periods SET voided_at = clock_timestamp(), voided_by = a, void_reason = btrim(p_reason) WHERE id = p_id RETURNING * INTO r;
  PERFORM public.log_audit_write('delay_period.voided', 'task_delay_period', r.id::text, public.delay_period_json(p), public.delay_period_json(r), btrim(p_reason), r.site_id, r.region_id);
  RETURN public.delay_period_json(r);
END $$;

-- Delay attribution (rules.md section 8, Q122), day by day over the late tasks of _dtask:
--   window   the working days after the due date up to the reference date (open) or up to the end of the SLA clock (closed);
--   minus    the days of a Change Control suspension of the site (from its approval date up to the day before the next resumption approval date);
--   party    the period of the task that covers the day, otherwise the 0039 rule (external party of the task, default type, unassigned).
-- A late task without a due date (or whose window is empty) keeps its 0039 figure (days_over) under the 0039 rule.
CREATE OR REPLACE FUNCTION dash_sec_delay(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH lt AS (
    SELECT t.id, t.site_id, t.days_over, t.due_date, t.external_party_id, t.default_party,
           CASE WHEN t.phase = 'open' THEN p_ref ELSE least(p_ref, coalesce(ti.sla_end_date, t.done_date, p_ref)) END AS end_d
    FROM _dtask t JOIN public.task_instances ti ON ti.id = t.id
    WHERE t.phase <> 'none' AND t.cls = 'late' AND t.days_over > 0
  ), dy AS (
    SELECT lt.id, lt.site_id, c.d FROM lt JOIN _dcal c ON c.is_wd AND c.d > lt.due_date AND c.d <= lt.end_d WHERE lt.due_date IS NOT NULL
  ), susp AS (
    SELECT s.site_id, s.approval_date AS f,
           (SELECT min(r.approval_date) FROM public.change_requests r WHERE r.site_id = s.site_id AND r.kind = 'resumption' AND r.status IN ('approved', 'applied')
              AND r.approval_date IS NOT NULL AND r.approval_date > s.approval_date AND r.approval_date <= p_ref) AS t
    FROM public.change_requests s
    WHERE s.kind = 'suspension' AND s.status IN ('approved', 'applied') AND s.approval_date IS NOT NULL AND s.approval_date <= p_ref
      AND s.site_id IN (SELECT site_id FROM lt)
  ), dd AS (
    SELECT dy.id, dy.site_id, dy.d,
      EXISTS (SELECT 1 FROM susp WHERE susp.site_id = dy.site_id AND dy.d >= susp.f AND (susp.t IS NULL OR dy.d < susp.t)) AS suspended,
      (SELECT p.id FROM public.task_delay_periods p WHERE p.task_id = dy.id AND p.voided_at IS NULL AND dy.d BETWEEN p.from_date AND p.to_date ORDER BY p.from_date, p.created_at LIMIT 1) AS period_id
    FROM dy
  ), rows_ AS (
    SELECT dd.id AS task_id, 1 AS wd, dd.suspended, p.party AS period_party, p.external_party_id AS period_ext, lt.external_party_id, lt.default_party
    FROM dd JOIN lt ON lt.id = dd.id LEFT JOIN public.task_delay_periods p ON p.id = dd.period_id
    UNION ALL
    SELECT lt.id, lt.days_over, false, NULL, NULL, lt.external_party_id, lt.default_party
    FROM lt WHERE NOT EXISTS (SELECT 1 FROM dy WHERE dy.id = lt.id)
  ), keyed AS (
    SELECT r.task_id, r.wd, r.suspended, r.period_party,
      CASE WHEN r.period_party IS NOT NULL THEN 'period:' || r.period_party || coalesce(':' || r.period_ext::text, '')
           WHEN r.external_party_id IS NOT NULL THEN 'party:' || r.external_party_id::text
           WHEN r.default_party IS NOT NULL THEN 'type:' || r.default_party ELSE 'unassigned' END AS pkey,
      CASE WHEN r.period_party IS NOT NULL THEN 'period' WHEN r.external_party_id IS NOT NULL THEN 'external' WHEN r.default_party IS NOT NULL THEN 'default_type' ELSE 'unassigned' END AS kind,
      CASE WHEN r.period_party IS NOT NULL THEN coalesce(pe.name, r.period_party) ELSE coalesce(ep.name, r.default_party, 'unassigned') END AS party,
      CASE WHEN r.period_party IS NOT NULL THEN r.period_ext ELSE r.external_party_id END AS ext_id,
      CASE WHEN r.period_party IS NOT NULL THEN pe.type::text ELSE ep.type::text END AS ptype
    FROM rows_ r LEFT JOIN public.external_parties ep ON ep.id = r.external_party_id LEFT JOIN public.external_parties pe ON pe.id = r.period_ext
  ), g AS (
    SELECT pkey, max(kind) AS kind, max(party) AS party, max(ext_id::text) AS external_party_id, max(ptype) AS ptype, max(period_party) AS period_party,
           count(DISTINCT task_id) AS late_tasks, sum(wd) AS wd
    FROM keyed WHERE NOT suspended GROUP BY pkey
  ), tot AS (
    SELECT coalesce(sum(wd), 0) AS wd, coalesce(sum(wd) FILTER (WHERE pkey = 'unassigned'), 0) AS un, coalesce(sum(wd) FILTER (WHERE kind = 'period'), 0) AS per FROM g
  )
  SELECT jsonb_build_object('total_late_working_days', tot.wd, 'unattributed_pct', CASE WHEN tot.wd > 0 THEN round(tot.un * 100.0 / tot.wd, 2) ELSE 0 END,
    'overlapping_periods', 0, 'periods_supported', true,
    'suspended_working_days', (SELECT count(*) FROM keyed WHERE suspended),
    'period_working_days', tot.per,
    'periods_count', (SELECT count(*) FROM public.task_delay_periods p WHERE p.voided_at IS NULL AND p.task_id IN (SELECT id FROM lt)),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('party', g.party, 'external_party_id', g.external_party_id, 'party_type', g.ptype, 'kind', g.kind,
        'period_party', g.period_party, 'late_tasks', g.late_tasks, 'late_working_days', g.wd, 'share_pct', round(g.wd * 100.0 / nullif(tot.wd, 0), 2))
        ORDER BY g.wd DESC, g.party) FROM g), '[]'::jsonb))
  INTO out_ FROM tot;
  RETURN out_;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q126: the CW / TE / O&M views of the workflow, for the dashboard. _dview holds the task definitions of the view, _dviewms its milestones:
--    the stages that are whole members of the view, or, for a view made of single tasks only (O&M), the stages of those tasks.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_build_view(p_view text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE om boolean := ((public.calc_setting('views.om_team_assigned', 'false'::jsonb) #>> '{}') = 'true');
BEGIN
  DROP TABLE IF EXISTS _dview; DROP TABLE IF EXISTS _dviewms;
  CREATE TEMP TABLE _dview ON COMMIT DROP AS
    SELECT DISTINCT vtd.id, vst.code AS stage_code, vm.member_kind
    FROM public.task_definitions vtd JOIN public.stage_definitions vst ON vst.id = vtd.stage_id
    JOIN public.workflow_view_members vm ON vm.workflow_id = vst.workflow_id AND vm.view_code = p_view
      AND ((vm.member_kind = 'stage' AND vm.member_code = vst.code) OR (vm.member_kind = 'task' AND vm.member_code = vtd.code))
      AND (vm.om_assigned IS NULL OR vm.om_assigned = om)
    WHERE vtd.is_active AND vst.is_active;
  CREATE INDEX ON _dview (id);
  CREATE TEMP TABLE _dviewms ON COMMIT DROP AS
    SELECT DISTINCT stage_code AS code FROM _dview
    WHERE member_kind = 'stage' OR NOT EXISTS (SELECT 1 FROM _dview x WHERE x.member_kind = 'stage');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Orchestration with the view filter (p_view), the Q122 delay and the approved health index (Q121)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid,
  p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean, p_view text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; wf_versions int[];
  rows_none jsonb; rows_region jsonb; ms jsonb;
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  IF p_snap IS NULL AND (p_stream IS NOT NULL OR p_sections && ARRAY['streams']) THEN PERFORM public.dash_build_streams(p_ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  IF p_view IS NOT NULL THEN
    -- the sites with at least one task of the view that applies
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
    'overrides_excluded', p_excl, 'weight_set_id', ws));

  IF p_sections && ARRAY['headline'] THEN
    out_ := out_ || jsonb_build_object('headline', public.dash_sec_status(p_ref) || jsonb_build_object('final_closure', public.dash_sec_closure(p_ref), 'project_status', ps_card));
  END IF;
  IF p_sections && ARRAY['pipeline', 'headline'] THEN
    ms := public.dash_sec_milestones(p_ref, CASE WHEN p_stream IN (SELECT DISTINCT stream_code FROM _dms WHERE stream_code IS NOT NULL) THEN p_stream END);
    IF p_view IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(x.e ORDER BY x.n), '[]'::jsonb) INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n) WHERE x.e ->> 'code' IN (SELECT code FROM _dviewms);
    END IF;
    out_ := out_ || jsonb_build_object('milestones', ms);
  END IF;
  IF p_sections && ARRAY['streams'] THEN out_ := out_ || jsonb_build_object('streams', public.dash_sec_streams()); END IF;
  IF p_sections && ARRAY['sla'] THEN out_ := out_ || jsonb_build_object('sla', public.dash_sec_sla(p_ref)); END IF;
  IF p_sections && ARRAY['gates'] THEN out_ := out_ || jsonb_build_object('gates', public.dash_sec_gates(p_ref)); END IF;
  IF p_sections && ARRAY['issues'] THEN
    out_ := out_ || jsonb_build_object('issues', CASE WHEN p_issues THEN public.dash_sec_issues(p_ref, p_issue_scope) ELSE NULL END);
  END IF;
  IF p_sections && ARRAY['health', 'regions'] THEN
    hl := public.dash_sec_health(p_ref, wide, p_issue_scope, p_issues, rows_none, rows_region) || jsonb_build_object('draft', false);  -- Q121: factors D and I approved
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

-- The 0039 signature, without a view.
CREATE OR REPLACE FUNCTION dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid,
  p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.dash_core(p_ref, p_scope, p_region, p_cluster, p_scenario, p_stream, p_excl, p_ws, p_sections, p_snap, p_group, p_issue_scope, p_issues, NULL::text)
$$;

-- The kinds of the snapshots of the dates of the list (weekly, month_end; manual = taken by hand, without a scheduled run).
CREATE OR REPLACE FUNCTION dash_snapshot_kind_list(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', q.d, 'kinds', q.kinds,
      'kind', CASE WHEN 'month_end' = ANY (q.kinds) THEN 'month_end' WHEN 'weekly' = ANY (q.kinds) THEN 'weekly' ELSE 'manual' END) ORDER BY q.d DESC), '[]'::jsonb)
  FROM (SELECT s.d, coalesce((SELECT array_agg(r.kind ORDER BY r.kind) FROM public.dash_snapshot_runs r WHERE r.snapshot_date = s.d), ARRAY[]::text[]) AS kinds
        FROM (SELECT DISTINCT snapshot_date AS d FROM public.site_snapshots ORDER BY snapshot_date DESC LIMIT p_limit) s) q
$$;

-- GET /dashboard with the view filter.
CREATE OR REPLACE FUNCTION dash_overview(p_ref date, p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_view text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a record; today date := public.cal_today(); ref date := coalesce(p_ref, today); snap date; res jsonb;
BEGIN
  SELECT * INTO a FROM public.dash_actor_scope();
  IF ref > today THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/ref_date', 'code', 'in_future', 'message', 'The reference date cannot be in the future.')))); END IF;
  IF ref < today AND EXISTS (SELECT 1 FROM public.site_snapshots WHERE snapshot_date = ref) THEN snap := ref; END IF;
  res := public.dash_core(ref, a.scope, p_region, p_cluster, p_scenario, p_stream, p_excl, NULL,
    ARRAY['headline', 'pipeline', 'streams', 'sla', 'gates', 'issues', 'health', 'delay', 'regions'], snap, 'none', a.issue_scope, a.issues_ok, p_view);
  RETURN res || jsonb_build_object('basis', jsonb_build_object('ref_date', ref, 'today', today,
    'source', CASE WHEN ref = today THEN 'live' WHEN snap IS NOT NULL THEN 'snapshot' ELSE 'as_of_computed' END,
    'snapshot_date', snap,
    'snapshots', coalesce((SELECT jsonb_agg(d ORDER BY d DESC) FROM (SELECT DISTINCT snapshot_date AS d FROM public.site_snapshots ORDER BY snapshot_date DESC LIMIT 60) q), '[]'::jsonb),
    'snapshot_kinds', public.dash_snapshot_kind_list(60)));
END $$;

-- The 0039 signature, without a view.
CREATE OR REPLACE FUNCTION dash_overview(p_ref date, p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.dash_overview(p_ref, p_region, p_cluster, p_scenario, p_stream, p_excl, NULL::text)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q127: snapshot schedule
-- ---------------------------------------------------------------------------------------------------------------------
-- The scheduled kinds of a date: weekly on the weekday of the setting (0 = Sunday), month_end on the last day of the month.
CREATE OR REPLACE FUNCTION dash_snapshot_kinds(p_date date) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN extract(dow FROM p_date)::integer = coalesce((public.calc_setting('dashboard.snapshot_weekday', '0'::jsonb) #>> '{}')::integer, 0) THEN 'weekly' END,
    CASE WHEN p_date = (date_trunc('month', p_date) + interval '1 month' - interval '1 day')::date THEN 'month_end' END], NULL)
$$;

-- The (date, kind) pairs due on p_today that have no run yet: the dates of the last dashboard.snapshot_catchup_days days, today included.
CREATE OR REPLACE FUNCTION dash_snapshot_due(p_today date) RETURNS TABLE (snapshot_date date, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT g.d, k.kind
  FROM (SELECT x::date AS d FROM generate_series(p_today - (greatest(1, least(31, coalesce((public.calc_setting('dashboard.snapshot_catchup_days', '7'::jsonb) #>> '{}')::integer, 7))) - 1),
                                                 p_today, interval '1 day') x) g
  CROSS JOIN LATERAL unnest(public.dash_snapshot_kinds(g.d)) AS k(kind)
  WHERE NOT EXISTS (SELECT 1 FROM public.dash_snapshot_runs r WHERE r.snapshot_date = g.d AND r.kind = k.kind)
  ORDER BY g.d, k.kind
$$;

-- Takes the due snapshots of p_today (default today). A date is snapshotted once (site_snapshots is keyed by date): a second kind on the same date,
-- or a run of a date that was taken by hand, records the run and stores nothing new. Returns the site rows stored.
CREATE OR REPLACE FUNCTION dash_snapshot_scheduled(p_today date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE today date := coalesce(p_today, public.cal_today()); r record; n integer; total integer := 0;
BEGIN
  IF today > public.cal_today() THEN RAISE EXCEPTION 'a snapshot cannot be taken for a future date' USING ERRCODE = 'check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.dashboard_snapshot_runs'));
  FOR r IN SELECT * FROM public.dash_snapshot_due(today) LOOP
    n := public.dash_snapshot_take(r.snapshot_date);
    INSERT INTO public.dash_snapshot_runs (snapshot_date, kind, sites, source)
    VALUES (r.snapshot_date, r.kind, n, CASE WHEN r.snapshot_date = today THEN 'schedule' ELSE 'catch_up' END)
    ON CONFLICT DO NOTHING;
    total := total + n;
  END LOOP;
  RETURN total;
END $$;

-- The daily job's entry point (0039 name): the schedule above instead of "7 days since the last one".
CREATE OR REPLACE FUNCTION dash_snapshot_weekly() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.dash_snapshot_scheduled(public.cal_today())
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights. Everything runs as pmis_definer; pmis_app calls only the entry points.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'dash\_%' OR p.proname LIKE 'ps\_manual\_%' OR p.proname LIKE 'delay\_period\_%' OR p.proname = 'ps_central_items')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname <> 'dash_wd' THEN EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig); END IF;
  END LOOP;
  ALTER FUNCTION dash_owner_rows_frozen() OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dash_overview(date, integer, text, text, text, boolean, text) TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_overview(date, integer, text, text, text, boolean) TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_project_status(date, integer, uuid, text, uuid, boolean) TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_snapshot_weekly() TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_snapshot_kind_list(integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION ps_manual_can_edit(), ps_manual_set(text, numeric, date, text), ps_central_items(date) TO pmis_app;
    GRANT EXECUTE ON FUNCTION delay_period_can_edit(uuid), delay_period_add(uuid, date, date, text, uuid, text), delay_period_void(uuid, text) TO pmis_app;
    -- read only: the rows change only through the functions above
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ps_manual_values, task_delay_periods, dash_snapshot_runs FROM pmis_app;
    GRANT SELECT ON ps_manual_values, task_delay_periods, dash_snapshot_runs TO pmis_app;
  END IF;
END $$;
