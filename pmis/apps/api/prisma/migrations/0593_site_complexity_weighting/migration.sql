-- 0593: site-complexity weighting in the progress calculation (owner approval 2026-11-28, relayed by Main; plan
-- 2026-11-27-progress-standards "Site-complexity weighting factor"). Automatic and derived: no manual field. A
-- site's coefficient is its applicable weight (the sum of the in-force item weights whose tasks apply on that
-- site) over the average of the active sites, clamped to [0.25, 4]. Region and project rollups then weigh each
-- site's task instances by that coefficient; a site's own progress row is unchanged (the coefficient cancels in
-- its own ratio). The setting dashboard.site_complexity_weighting (default true) pins every coefficient to 1
-- when switched off, which is exactly the previous behaviour. Snapshot builds derive the coefficient from the
-- snapshot's own stored items, so a historical date keeps its historical coefficients. Every block is idempotent.

-- ------------------------------------------------------------------ dash_build_items: build the coefficient map (live data)
DO $$
DECLARE def text; marker text := E'  PERFORM public.dash_build_manual(p_ref, NULL);';
BEGIN
  def := pg_get_functiondef('public.dash_build_items(date, uuid, boolean)'::regprocedure);
  IF position('TEMP TABLE _dscf' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items() has no build_manual anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'  -- 0593: site-complexity coefficients. Derived from the weight set in force and task applicability:\n'
      || E'  -- the item weights whose tasks apply on the site, over the project average, clamped to [0.25, 4].\n'
      || E'  DROP TABLE IF EXISTS _dscf;\n'
      || E'  CREATE TEMP TABLE _dscf ON COMMIT DROP AS\n'
      || E'    WITH site_items AS (\n'
      || E'      SELECT DISTINCT s.id AS site_id, w.act, w.item, w.iw\n'
      || E'      FROM public.sites s\n'
      || E'      JOIN _dwi w ON w.method = ''tasks'' AND w.item IS NOT NULL AND w.iw > 0\n'
      || E'      JOIN _dwt k ON k.item = w.item\n'
      || E'      JOIN public.task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = k.task_code\n'
      || E'      JOIN public.task_instances t ON t.site_id = s.id AND t.task_def_id = td.id\n'
      || E'      WHERE s.is_active AND s.overall_status IS DISTINCT FROM ''cancelled''\n'
      || E'        AND t.state NOT IN (''na'', ''skipped'') AND NOT t.is_na\n'
      || E'    ), sw AS (SELECT site_id, sum(iw) AS w FROM site_items GROUP BY site_id),\n'
      || E'    av AS (SELECT avg(w) AS a FROM sw)\n'
      || E'    SELECT sw.site_id,\n'
      || E'           CASE WHEN NOT coalesce((public.calc_setting(''dashboard.site_complexity_weighting'', ''true''::jsonb) #>> ''{}'')::boolean, true)\n'
      || E'                  OR av.a IS NULL OR av.a = 0 THEN 1::numeric\n'
      || E'                ELSE greatest(0.25, least(4::numeric, sw.w / av.a)) END AS coeff\n'
      || E'    FROM sw CROSS JOIN av;\n'
      || E'  CREATE UNIQUE INDEX ON _dscf (site_id);\n'
      || marker);
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_build_items_snap: the same map from the snapshot's own stored items
DO $$
DECLARE def text; marker text := E'  PERFORM public.dash_build_manual(p_date, (SELECT min(created_at) FROM public.site_snapshots WHERE snapshot_date = p_date));';
BEGIN
  def := pg_get_functiondef('public.dash_build_items_snap(date, uuid)'::regprocedure);
  IF position('TEMP TABLE _dscf' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items_snap() has no build_manual anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'  -- 0593: the same coefficients as the live build, derived from the snapshot''s stored items so a\n'
      || E'  -- historical date keeps the coefficients of that date.\n'
      || E'  DROP TABLE IF EXISTS _dscf;\n'
      || E'  CREATE TEMP TABLE _dscf ON COMMIT DROP AS\n'
      || E'    WITH sw AS (\n'
      || E'      SELECT ss.site_id, sum(w.iw) AS w\n'
      || E'      FROM public.site_snapshots ss CROSS JOIN LATERAL jsonb_each(ss.items) e\n'
      || E'      JOIN _dwi w ON w.item = e.key AND w.method = ''tasks'' AND w.iw > 0\n'
      || E'      WHERE ss.snapshot_date = p_date AND (e.value ->> 1)::bigint > 0\n'
      || E'      GROUP BY ss.site_id\n'
      || E'    ), av AS (SELECT avg(w) AS a FROM sw)\n'
      || E'    SELECT sw.site_id,\n'
      || E'           CASE WHEN NOT coalesce((public.calc_setting(''dashboard.site_complexity_weighting'', ''true''::jsonb) #>> ''{}'')::boolean, true)\n'
      || E'                  OR av.a IS NULL OR av.a = 0 THEN 1::numeric\n'
      || E'                ELSE greatest(0.25, least(4::numeric, sw.w / av.a)) END AS coeff\n'
      || E'    FROM sw CROSS JOIN av;\n'
      || E'  CREATE UNIQUE INDEX ON _dscf (site_id);\n'
      || marker);
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_ps_rows: weigh each site's instances by its coefficient
DO $$
DECLARE def text;
  old_ic text := E'           c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic, sum(c.planned) AS planned, sum(c.plan_known) AS plan_known, sum(c.part) AS part\n    FROM _dic c JOIN _dsite s ON s.id = c.site_id LEFT JOIN public.regions r ON r.id = s.region_id';
  new_ic text := E'           c.act, c.item, sum(c.done * coalesce(f.coeff, 1)) AS done, sum(c.applic * coalesce(f.coeff, 1)) AS applic, sum(c.planned * coalesce(f.coeff, 1)) AS planned, sum(c.plan_known * coalesce(f.coeff, 1)) AS plan_known, sum(c.part * coalesce(f.coeff, 1)) AS part\n    FROM _dic c JOIN _dsite s ON s.id = c.site_id LEFT JOIN _dscf f ON f.site_id = c.site_id LEFT JOIN public.regions r ON r.id = s.region_id';
BEGIN
  def := pg_get_functiondef('public.dash_ps_rows(text, boolean)'::regprocedure);
  IF position('_dscf f ON' IN def) = 0 THEN
    IF position(old_ic IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no ic anchor to patch'; END IF;
    EXECUTE replace(def, old_ic, new_ic);
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_ps_card: the same weighting, plus the flag that says it is on
DO $$
DECLARE def text;
  old_ic text := E'  WITH ic AS (SELECT c.act, c.item, sum(c.done) AS done, sum(c.applic) AS applic, sum(c.part) AS part FROM _dic c JOIN _dsite s ON s.id = c.site_id GROUP BY c.act, c.item),';
  new_ic text := E'  WITH ic AS (SELECT c.act, c.item, sum(c.done * coalesce(f.coeff, 1)) AS done, sum(c.applic * coalesce(f.coeff, 1)) AS applic, sum(c.part * coalesce(f.coeff, 1)) AS part FROM _dic c JOIN _dsite s ON s.id = c.site_id LEFT JOIN _dscf f ON f.site_id = c.site_id GROUP BY c.act, c.item),';
BEGIN
  def := pg_get_functiondef('public.dash_ps_card(boolean, jsonb)'::regprocedure);
  IF position('_dscf f ON' IN def) = 0 THEN
    IF position(old_ic IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no ic anchor to patch'; END IF;
    EXECUTE replace(def, old_ic, new_ic);
  END IF;
END $$;

DO $$
DECLARE def text; marker text := E'    ''central_line'', cline);';
BEGIN
  def := pg_get_functiondef('public.dash_ps_card(boolean, jsonb)'::regprocedure);
  IF position('site_complexity_weighting' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no central_line anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'    ''central_line'', cline,\n'
      || E'    -- 0593: whether site-complexity weighting was on for this card.\n'
      || E'    ''site_complexity_weighting'', coalesce((public.calc_setting(''dashboard.site_complexity_weighting'', ''true''::jsonb) #>> ''{}'')::boolean, true));');
  END IF;
END $$;
