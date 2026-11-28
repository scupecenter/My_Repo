-- 0621_plan_freezes: freeze the plan (the approved baselines of every site) as a named version, and report the variance of what was actually done against it
-- (contract 0.15.480). Additive. Mirror: db/sql/620_plan_freezes.sql (kept identical to prisma/migrations/0621_plan_freezes/migration.sql).
--
-- WHAT. A freeze copies, for every active site, the approved baseline date of each milestone as it stands today. It is a picture: baseline_versions and
-- baseline_entries (the official baselines the dashboard and the sites use) are not read-write here and nothing in them changes. Later the report compares
-- the frozen dates with what was done (the approved milestone task, its actual date) per stage, per region and for the worst rows. A re-baseline after
-- the freeze therefore never rewrites the freeze.
-- WHO. Freezing and hiding a freeze: a System Admin. Reading the list and the report: view on the dashboard module, limited to the caller's regions.
-- Hide, never delete. Calendar days (actual minus frozen date; negative is early). Every freeze and hide is one audit row.

CREATE TABLE public.plan_freezes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  site_count integer NOT NULL DEFAULT 0,
  row_count integer NOT NULL DEFAULT 0,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by uuid NOT NULL REFERENCES public.users(id),
  removed_at timestamptz
);
CREATE TABLE public.plan_freeze_rows (
  freeze_id uuid NOT NULL REFERENCES public.plan_freezes(id),
  site_id uuid NOT NULL,
  region_id integer NOT NULL,
  milestone_code text NOT NULL,
  baseline_date date NOT NULL,
  PRIMARY KEY (freeze_id, site_id, milestone_code)
);
CREATE INDEX plan_freeze_rows_region_idx ON public.plan_freeze_rows (freeze_id, region_id);

ALTER TABLE public.plan_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_freezes FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON public.plan_freezes FOR SELECT USING (true);
CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON public.plan_freezes FOR EACH ROW EXECUTE FUNCTION public.wf_backstop();
ALTER TABLE public.plan_freeze_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_freeze_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON public.plan_freeze_rows FOR SELECT USING (public.app_region_check(region_id));
CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON public.plan_freeze_rows FOR EACH ROW EXECUTE FUNCTION public.wf_backstop();

-- The caller must be a System Admin (freeze, hide); a read needs view on the dashboard module. Answers the regions of the read (NULL = every region).
CREATE OR REPLACE FUNCTION public.plan_freeze_scope(p_write boolean) RETURNS int[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); regs int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_write THEN
    IF NOT public.app_user_is_system_admin(actor) THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin freezes the plan.')); END IF;
    RETURN NULL;
  END IF;
  regs := public.wf_actor_regions('dashboard', 'view');
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN PERFORM public.wf_err('action_forbidden'); END IF;
  RETURN regs;
END $$;

-- Freeze the plan now: one row per active site and milestone that has an approved baseline date.
CREATE OR REPLACE FUNCTION public.plan_freeze_create(p_label text, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); fid uuid; n_rows int; n_sites int; lbl text := btrim(coalesce(p_label, ''));
BEGIN
  PERFORM public.plan_freeze_scope(true);
  IF char_length(lbl) NOT BETWEEN 1 AND 120 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/label', 'code', 'invalid', 'message', 'A name of 1 to 120 characters.'))));
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 1000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/note', 'code', 'invalid', 'message', 'At most 1000 characters.'))));
  END IF;
  IF (SELECT count(*) FROM public.plan_freezes WHERE removed_at IS NULL) >= 50 THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'There are 50 frozen plans. Hide one first.'));
  END IF;
  INSERT INTO public.plan_freezes (label, note, frozen_by) VALUES (lbl, nullif(btrim(coalesce(p_note, '')), ''), actor) RETURNING id INTO fid;
  INSERT INTO public.plan_freeze_rows (freeze_id, site_id, region_id, milestone_code, baseline_date)
    SELECT fid, x.site_id, x.region_id, x.milestone_code, x.baseline_date
      FROM (SELECT DISTINCT ON (be.site_id, be.milestone_code) be.site_id, s.region_id, be.milestone_code, be.baseline_date
              FROM public.baseline_entries be
              JOIN public.baseline_versions bv ON bv.id = be.version_id AND bv.status = 'approved'
              JOIN public.sites s ON s.id = be.site_id AND s.is_active AND s.overall_status IS DISTINCT FROM 'cancelled'
             WHERE be.baseline_date IS NOT NULL
             ORDER BY be.site_id, be.milestone_code, bv.version DESC) x;
  GET DIAGNOSTICS n_rows = ROW_COUNT;
  SELECT count(DISTINCT site_id)::int INTO n_sites FROM public.plan_freeze_rows WHERE freeze_id = fid;
  UPDATE public.plan_freezes SET site_count = n_sites, row_count = n_rows WHERE id = fid;
  PERFORM public.log_audit_write('plan_freeze_create', 'plan_freeze', fid::text, NULL, jsonb_build_object('label', lbl, 'sites', n_sites, 'rows', n_rows), NULL, NULL, NULL);
  RETURN jsonb_build_object('id', fid, 'sites', n_sites, 'rows', n_rows);
END $$;

CREATE OR REPLACE FUNCTION public.plan_freeze_hide(p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE f public.plan_freezes%ROWTYPE;
BEGIN
  PERFORM public.plan_freeze_scope(true);
  SELECT * INTO f FROM public.plan_freezes WHERE id = p_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  UPDATE public.plan_freezes SET removed_at = now() WHERE id = p_id;
  PERFORM public.log_audit_write('plan_freeze_hide', 'plan_freeze', p_id::text, jsonb_build_object('label', f.label), NULL, NULL, NULL, NULL);
END $$;

CREATE OR REPLACE FUNCTION public.plan_freezes_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); can boolean; items jsonb;
BEGIN
  PERFORM public.plan_freeze_scope(false);
  can := public.app_user_is_system_admin(actor);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'label', f.label, 'note', f.note, 'site_count', f.site_count, 'row_count', f.row_count,
           'frozen_at', f.frozen_at, 'frozen_by_name', u.display_name) ORDER BY f.frozen_at DESC, f.id), '[]'::jsonb)
    INTO items FROM public.plan_freezes f LEFT JOIN public.users u ON u.id = f.frozen_by WHERE f.removed_at IS NULL;
  RETURN jsonb_build_object('items', items, 'can_freeze', can);
END $$;

-- Variance of a frozen plan against what was done: per stage, per region and the worst rows (calendar days, actual minus frozen date; open rows past their date count as overdue).
CREATE OR REPLACE FUNCTION public.plan_freeze_report(p_id uuid, p_region integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE regs int[]; f public.plan_freezes%ROWTYPE; today date := public.cal_today(); res jsonb;
BEGIN
  regs := public.plan_freeze_scope(false);
  SELECT * INTO f FROM public.plan_freezes WHERE id = p_id AND removed_at IS NULL;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  WITH _pfr AS MATERIALIZED (
    SELECT r.site_id, r.region_id, r.milestone_code AS code, r.baseline_date AS base, act.d AS actual
      FROM public.plan_freeze_rows r
      LEFT JOIN LATERAL (
        SELECT min(coalesce(t.actual_date, t.approved_date)) AS d
          FROM public.sites s
          JOIN public.stage_definitions sd ON sd.workflow_id = s.workflow_version_id AND sd.code = r.milestone_code
          JOIN public.task_definitions td ON td.stage_id = sd.id AND td.is_milestone_task
          JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id AND t.state = 'approved'
         WHERE s.id = r.site_id) act ON true
     WHERE r.freeze_id = p_id AND (regs IS NULL OR r.region_id = ANY (regs)) AND (p_region IS NULL OR r.region_id = p_region))
  SELECT jsonb_build_object(
    'freeze', jsonb_build_object('id', f.id, 'label', f.label, 'note', f.note, 'frozen_at', f.frozen_at),
    'as_of', today,
    'totals', (SELECT jsonb_build_object('rows', count(*), 'done', count(*) FILTER (WHERE actual IS NOT NULL),
                 'done_late', count(*) FILTER (WHERE actual > base), 'open_overdue', count(*) FILTER (WHERE actual IS NULL AND base < today),
                 'avg_days', round(avg(actual - base) FILTER (WHERE actual IS NOT NULL), 1)) FROM _pfr),
    'stages', coalesce((SELECT jsonb_agg(jsonb_build_object('code', p.code,
                 'name_en', (SELECT sd.name_en FROM public.stage_definitions sd WHERE sd.code = p.code AND sd.is_active ORDER BY sd.workflow_id LIMIT 1),
                 'name_ar', (SELECT sd.name_ar FROM public.stage_definitions sd WHERE sd.code = p.code AND sd.is_active ORDER BY sd.workflow_id LIMIT 1),
                 'rows', p.n, 'done', p.done, 'done_late', p.late, 'open_overdue', p.overdue, 'avg_days', p.avg_d, 'worst_days', p.worst) ORDER BY p.code)
               FROM (SELECT code, count(*) AS n, count(*) FILTER (WHERE actual IS NOT NULL) AS done, count(*) FILTER (WHERE actual > base) AS late,
                            count(*) FILTER (WHERE actual IS NULL AND base < today) AS overdue,
                            round(avg(actual - base) FILTER (WHERE actual IS NOT NULL), 1) AS avg_d, max(actual - base) AS worst FROM _pfr GROUP BY code) p), '[]'::jsonb),
    'regions', coalesce((SELECT jsonb_agg(jsonb_build_object('region_id', q.region_id, 'rows', q.n, 'done', q.done, 'done_late', q.late, 'open_overdue', q.overdue, 'avg_days', q.avg_d) ORDER BY q.region_id)
               FROM (SELECT region_id, count(*) AS n, count(*) FILTER (WHERE actual IS NOT NULL) AS done, count(*) FILTER (WHERE actual > base) AS late,
                            count(*) FILTER (WHERE actual IS NULL AND base < today) AS overdue, round(avg(actual - base) FILTER (WHERE actual IS NOT NULL), 1) AS avg_d
                       FROM _pfr GROUP BY region_id) q), '[]'::jsonb),
    'worst', coalesce((SELECT jsonb_agg(jsonb_build_object('site_id', w.site_id, 'site_code', w.site_code, 'region_id', w.region_id, 'code', w.code, 'base', w.base,
                 'actual', w.actual, 'days', w.days, 'open', w.actual IS NULL) ORDER BY w.days DESC, w.site_code, w.code)
               FROM (SELECT x.site_id, s.site_code, x.region_id, x.code, x.base, x.actual, (coalesce(x.actual, today) - x.base) AS days
                       FROM _pfr x JOIN public.sites s ON s.id = x.site_id WHERE coalesce(x.actual, today) > x.base
                      ORDER BY (coalesce(x.actual, today) - x.base) DESC, s.site_code, x.code LIMIT 50) w), '[]'::jsonb)) INTO res;
  RETURN res;
END $$;

-- Data reset coverage (0152): a freeze belongs to the project data of the sites (MIXED over the sites part). data_reset_plan() is patched in place and idempotently.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''plan_freezes''' IN def) = 0 THEN
    IF position('(''levels_conversions'',' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the mixed list anchor was not found'; END IF;
    def := replace(def, '(''levels_conversions'',',
      '(''plan_freezes'', ''mixed'', ''*'', ''ARRAY[''''sites'''']''),' || chr(10) || '    (''plan_freeze_rows'', ''mixed'', ''*'', ''ARRAY[''''sites'''']''),' || chr(10) || '    (''levels_conversions'',');
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.plan_freezes TO pmis_definer;
GRANT SELECT, INSERT ON public.plan_freeze_rows TO pmis_definer;
GRANT SELECT, DELETE ON public.plan_freezes, public.plan_freeze_rows TO pmis_reset_owner;
GRANT SELECT ON public.baseline_entries, public.baseline_versions, public.sites, public.stage_definitions, public.task_definitions, public.task_instances, public.users TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['plan_freeze_scope(boolean)', 'plan_freeze_create(text,text)', 'plan_freeze_hide(uuid)', 'plan_freezes_json()', 'plan_freeze_report(uuid,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.plan_freeze_create(text, text), public.plan_freeze_hide(uuid), public.plan_freezes_json(), public.plan_freeze_report(uuid, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION public.plan_freeze_scope(boolean) FROM pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.plan_freezes, public.plan_freeze_rows FROM pmis_app;
    GRANT SELECT ON public.plan_freezes, public.plan_freeze_rows TO pmis_app;
  END IF;
END $$;
