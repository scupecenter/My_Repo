-- 0540_progress_register_method: a new measure_rule method "register" for Project Status weight items (progress-calc
-- standards review, owner approval 2026-11-27; contract 0.15.269). Recurring per-site work enters the progress calculation as
-- level-of-effort / apportioned effort: the approved records of a register against the preventive-maintenance schedules due
-- (pm.schedules, 0261). LOE items earn over time and never produce schedule variance, so they are excluded from the planned /
-- SPI denominator. Activation happens through a new weight-set version in the existing admin flow (Settings > Weights);
-- published sets and frozen snapshots are untouched (all patches are additive and keyed on method = 'register', which no
-- published set uses). Mirror: db/sql/539_progress_register_method.sql (kept byte-identical).
--
--   measure_rule: {"method":"register","register":"<register_key>","loe":true,"central":false}
--     - A site-scoped register is measured per site (central false): each active PM schedule of the register on the site
--       expects one approved record per period (every N weeks/months). The current period runs from next_due - step to
--       next_due; a schedule whose next_due is on or before the reference date is due and earns nothing until its record is
--       approved; a schedule whose period has not started yet is not due. A site without schedules does not count (the item
--       weight redistributes, exactly like a tasks item without applicable instances).
--     - A register that is not site-scoped is measured once for the whole project (central true); when no schedule exists the
--       manual central value of the item stays the fallback (Q118), unchanged.
--     - "loe" (default true): the item is left out of planned_pct, the SPI denominator, plan coverage and the partial index.
--
-- Patched in place and idempotent (never a whole redefinition), so additions of other migrations stay:
--   dash_build_wi        reads the register key and the LOE flag into _dwi (rkey, loe)
--   dash_build_items     builds _dcr (per site) and _dcrc (central) and adds the register rows to _dic
--   dash_build_items_snap  an empty _dcrc (a saved snapshot has no register measurement; the manual fallback still shows)
--   dash_ps_rows         carries loe, joins _dcrc for central register items, and excludes LOE items from plan / SPI
--   dash_ps_card         the card shows register-measured items (source first, manual value as fallback)
--   weight_set_errors    publish-time validation: the register exists and is enabled; site-scoped = per site, global = central

-- ------------------------------------------------------------------ dash_build_wi: rkey + loe
DO $$
DECLARE def text; marker text := E'           CASE WHEN jsonb_typeof(i.measure_rule) = ''object'' THEN coalesce((i.measure_rule ->> ''central'')::boolean, false) ELSE false END AS central\n    FROM public.weight_activities';
BEGIN
  def := pg_get_functiondef('public.dash_build_wi(uuid)'::regprocedure);
  IF position('AS rkey' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_wi() has no central-flag anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'           CASE WHEN jsonb_typeof(i.measure_rule) = ''object'' THEN coalesce((i.measure_rule ->> ''central'')::boolean, false) ELSE false END AS central,\n'
      || E'           CASE WHEN jsonb_typeof(i.measure_rule) = ''object'' AND coalesce(i.measure_rule ->> ''method'', ''none'') = ''register'' THEN i.measure_rule ->> ''register'' END AS rkey,\n'
      || E'           CASE WHEN jsonb_typeof(i.measure_rule) = ''object'' AND coalesce(i.measure_rule ->> ''method'', ''none'') = ''register'' THEN coalesce((i.measure_rule ->> ''loe'')::boolean, true)\n'
      || E'                WHEN jsonb_typeof(i.measure_rule) = ''object'' THEN coalesce((i.measure_rule ->> ''loe'')::boolean, false) ELSE false END AS loe\n'
      || E'    FROM public.weight_activities');
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_build_items: _dcr / _dcrc and the register rows of _dic
DO $$
DECLARE def text; marker text := E'\n  PERFORM public.dash_build_manual(p_ref, NULL);';
BEGIN
  def := pg_get_functiondef('public.dash_build_items(date,uuid,boolean)'::regprocedure);
  IF position('_dcr' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items() has no manual-build anchor to patch'; END IF;
    EXECUTE replace(def, marker, E'\n'
      || E'  -- 0540: register-method items (LOE / apportioned effort). A schedule in its current period expects one approved record.\n'
      || E'  DROP TABLE IF EXISTS _dcr;\n'
      || E'  CREATE TEMP TABLE _dcr ON COMMIT DROP AS\n'
      || E'    SELECT s.id AS site_id, w.act, w.item,\n'
      || E'           count(*) FILTER (WHERE ev.in_period) AS applic,\n'
      || E'           count(*) FILTER (WHERE ev.in_period AND ev.covered) AS done\n'
      || E'    FROM _dsite s\n'
      || E'    JOIN _dwi w ON w.method = ''register'' AND w.item IS NOT NULL AND w.iw > 0 AND NOT w.central AND w.rkey IS NOT NULL\n'
      || E'    JOIN LATERAL (\n'
      || E'      SELECT e, (e ->> ''next_due'')::date AS nd,\n'
      || E'             CASE e ->> ''unit'' WHEN ''week'' THEN make_interval(weeks => (e ->> ''every'')::int) ELSE make_interval(months => (e ->> ''every'')::int) END AS step\n'
      || E'      FROM jsonb_array_elements(coalesce((SELECT v.value -> ''schedules'' FROM public.settings v WHERE v.key = ''pm.schedules''), ''[]''::jsonb)) e\n'
      || E'      WHERE coalesce((e ->> ''active'')::boolean, true) AND e ->> ''register_key'' = w.rkey AND e ->> ''site_id'' = s.id::text\n'
      || E'    ) sch ON TRUE\n'
      || E'    CROSS JOIN LATERAL (SELECT (sch.nd <= p_ref OR sch.nd - sch.step <= p_ref) AS in_period,\n'
      || E'        (sch.nd > p_ref AND EXISTS (SELECT 1 FROM public.register_records r\n'
      || E'            WHERE r.register_key = w.rkey AND r.site_id = s.id AND r.is_current AND r.state = ''approved'' AND r.approved_at IS NOT NULL\n'
      || E'              AND r.approved_at::date >= (sch.nd - sch.step)::date AND r.approved_at::date <= p_ref\n'
      || E'              AND (sch.e ->> ''record_type'' IS NULL OR r.record_type = sch.e ->> ''record_type''))) AS covered) ev\n'
      || E'    WHERE NOT s.cancelled\n'
      || E'    GROUP BY s.id, w.act, w.item;\n'
      || E'  INSERT INTO _dic (site_id, act, item, applic, done, planned, plan_known)\n'
      || E'    SELECT site_id, act, item, applic, done, 0, 0 FROM _dcr WHERE applic > 0 OR done > 0;\n'
      || E'  DROP TABLE IF EXISTS _dcrc;\n'
      || E'  CREATE TEMP TABLE _dcrc ON COMMIT DROP AS\n'
      || E'    SELECT w.item,\n'
      || E'           CASE WHEN count(*) FILTER (WHERE ev.in_period) > 0\n'
      || E'                THEN least(1, count(*) FILTER (WHERE ev.in_period AND ev.covered)::numeric / count(*) FILTER (WHERE ev.in_period)) END AS pct\n'
      || E'    FROM _dwi w\n'
      || E'    JOIN LATERAL (\n'
      || E'      SELECT e, (e ->> ''next_due'')::date AS nd,\n'
      || E'             CASE e ->> ''unit'' WHEN ''week'' THEN make_interval(weeks => (e ->> ''every'')::int) ELSE make_interval(months => (e ->> ''every'')::int) END AS step\n'
      || E'      FROM jsonb_array_elements(coalesce((SELECT v.value -> ''schedules'' FROM public.settings v WHERE v.key = ''pm.schedules''), ''[]''::jsonb)) e\n'
      || E'      WHERE coalesce((e ->> ''active'')::boolean, true) AND e ->> ''register_key'' = w.rkey AND e ->> ''site_id'' IS NULL\n'
      || E'    ) sch ON TRUE\n'
      || E'    CROSS JOIN LATERAL (SELECT (sch.nd <= p_ref OR sch.nd - sch.step <= p_ref) AS in_period,\n'
      || E'        (sch.nd > p_ref AND EXISTS (SELECT 1 FROM public.register_records r\n'
      || E'            WHERE r.register_key = w.rkey AND r.site_id IS NULL AND r.is_current AND r.state = ''approved'' AND r.approved_at IS NOT NULL\n'
      || E'              AND r.approved_at::date >= (sch.nd - sch.step)::date AND r.approved_at::date <= p_ref\n'
      || E'              AND (sch.e ->> ''record_type'' IS NULL OR r.record_type = sch.e ->> ''record_type''))) AS covered) ev\n'
      || E'    WHERE w.method = ''register'' AND w.central AND w.iw > 0 AND w.rkey IS NOT NULL\n'
      || E'    GROUP BY w.item;\n'
      || E'  CREATE UNIQUE INDEX ON _dcrc (item);\n'
      || marker);
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_build_items_snap: an empty _dcrc for the snapshot path
DO $$
DECLARE def text; marker text := E'\n  PERFORM public.dash_build_manual(p_date, (SELECT min(created_at) FROM public.site_snapshots WHERE snapshot_date = p_date));';
BEGIN
  def := pg_get_functiondef('public.dash_build_items_snap(date,uuid)'::regprocedure);
  IF def IS NOT NULL AND position('_dcrc' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items_snap() has no manual-build anchor to patch'; END IF;
    EXECUTE replace(def, marker, E'\n  DROP TABLE IF EXISTS _dcrc;\n  CREATE TEMP TABLE _dcrc (item text, pct numeric);\n  CREATE UNIQUE INDEX ON _dcrc (item);' || marker);
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_ps_rows: carry loe, join _dcrc, exclude LOE from plan / SPI
DO $$
DECLARE def text;
  m_it1 text := E'           least(1, ic.done::numeric / ic.applic) AS pct,\n           CASE WHEN ic.plan_known = ic.applic THEN least(1, ic.planned::numeric / ic.applic) END AS ppct\n    FROM ic JOIN _dwi w ON w.item = ic.item';
  m_central text := E'    SELECT g.gk, g.label, w.act, w.item, w.iw, w.aw, least(1, greatest(0, m.pct)), CASE WHEN mp.ppct IS NOT NULL THEN least(1, greatest(0, mp.ppct)) END\n    FROM g CROSS JOIN _dwi w JOIN _dman m ON m.item = w.item LEFT JOIN _dmplan mp ON mp.item = w.item\n    WHERE wide AND w.central AND w.method <> ''tasks'' AND w.iw > 0';
  m_act text := E'    SELECT gk, max(label) AS label, act, max(aw) AS aw, sum(iw) AS sw, sum(iw * pct) / sum(iw) AS apct,\n           CASE WHEN count(*) FILTER (WHERE ppct IS NULL) = 0 THEN sum(iw * ppct) / sum(iw) END AS pplan,\n           coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL), 0) / sum(iw) AS cov,\n           coalesce(sum(iw * pct) FILTER (WHERE ppct IS NOT NULL), 0) AS pa_num,\n           coalesce(sum(iw * ppct) FILTER (WHERE ppct IS NOT NULL), 0) AS pp_num,\n           coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL), 0) AS pw\n    FROM it GROUP BY gk, act';
  m_tot text := E'    SELECT gk, max(label) AS label, sum(aw * apct) / sum(aw) AS actual,\n           CASE WHEN count(*) FILTER (WHERE pplan IS NULL) = 0 THEN sum(aw * pplan) / sum(aw) END AS planned,\n           sum(aw * cov) / sum(aw) AS coverage,\n           sum(aw * pa_num / sw) AS pa, sum(aw * pp_num / sw) AS pp, sum(aw * pw / sw) AS pwt\n    FROM act GROUP BY gk';
BEGIN
  def := pg_get_functiondef('public.dash_ps_rows(text,boolean)'::regprocedure);
  IF position('w.loe' IN def) = 0 THEN
    IF position(m_it1 IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no tasks-item anchor to patch'; END IF;
    def := replace(def, m_it1, E'           least(1, ic.done::numeric / ic.applic) AS pct,\n           CASE WHEN ic.plan_known = ic.applic THEN least(1, ic.planned::numeric / ic.applic) END AS ppct, w.loe\n    FROM ic JOIN _dwi w ON w.item = ic.item');
    IF position(m_central IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no central-item anchor to patch'; END IF;
    def := replace(def, m_central,
      E'    SELECT g.gk, g.label, w.act, w.item, w.iw, w.aw, least(1, greatest(0, coalesce(c.pct, m.pct))),\n'
      || E'           CASE WHEN NOT w.loe AND mp.ppct IS NOT NULL THEN least(1, greatest(0, mp.ppct)) END, w.loe\n'
      || E'    FROM g CROSS JOIN _dwi w LEFT JOIN _dcrc c ON c.item = w.item LEFT JOIN _dman m ON m.item = w.item LEFT JOIN _dmplan mp ON mp.item = w.item\n'
      || E'    WHERE wide AND w.central AND w.method <> ''tasks'' AND w.iw > 0\n'
      || E'      AND ((w.method <> ''register'' AND m.item IS NOT NULL) OR (w.method = ''register'' AND (c.pct IS NOT NULL OR m.item IS NOT NULL)))');
    IF position(m_act IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no activity anchor to patch'; END IF;
    def := replace(def, m_act,
      E'    SELECT gk, max(label) AS label, act, max(aw) AS aw, sum(iw) AS sw, sum(iw) FILTER (WHERE NOT loe) AS swl,\n'
      || E'           count(*) FILTER (WHERE NOT loe) > 0 AS plannable, sum(iw * pct) / sum(iw) AS apct,\n'
      || E'           CASE WHEN count(*) FILTER (WHERE NOT loe) = 0 THEN NULL\n'
      || E'                WHEN count(*) FILTER (WHERE ppct IS NULL AND NOT loe) = 0 THEN sum(iw * ppct) FILTER (WHERE NOT loe) / sum(iw) FILTER (WHERE NOT loe) END AS pplan,\n'
      || E'           CASE WHEN count(*) FILTER (WHERE NOT loe) = 0 THEN 1\n'
      || E'                ELSE coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL AND NOT loe), 0) / sum(iw) FILTER (WHERE NOT loe) END AS cov,\n'
      || E'           coalesce(sum(iw * pct) FILTER (WHERE ppct IS NOT NULL AND NOT loe), 0) AS pa_num,\n'
      || E'           coalesce(sum(iw * ppct) FILTER (WHERE ppct IS NOT NULL AND NOT loe), 0) AS pp_num,\n'
      || E'           coalesce(sum(iw) FILTER (WHERE ppct IS NOT NULL AND NOT loe), 0) AS pw\n'
      || E'    FROM it GROUP BY gk, act');
    IF position(m_tot IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no total anchor to patch'; END IF;
    def := replace(def, m_tot,
      E'    SELECT gk, max(label) AS label, sum(aw * apct) / sum(aw) AS actual,\n'
      || E'           CASE WHEN count(*) FILTER (WHERE pplan IS NULL AND plannable) = 0 THEN sum(aw * pplan) FILTER (WHERE plannable) / sum(aw) FILTER (WHERE plannable) END AS planned,\n'
      || E'           sum(aw * cov) / sum(aw) AS coverage,\n'
      || E'           sum(aw * pa_num / nullif(swl, 0)) AS pa, sum(aw * pp_num / nullif(swl, 0)) AS pp, sum(aw * pw / nullif(swl, 0)) AS pwt\n'
      || E'    FROM act GROUP BY gk');
    EXECUTE def;
  END IF;
END $$;

-- ------------------------------------------------------------------ dash_ps_card: register-measured items in the card
DO $$
DECLARE def text;
  m_join text := E'    FROM _dwi w LEFT JOIN ic ON ic.item = w.item LEFT JOIN _dman m ON m.item = w.item LEFT JOIN _dmplan mp ON mp.item = w.item WHERE w.item IS NOT NULL';
  m_man text := E'           (p_project_wide AND w.central AND w.method <> ''tasks'' AND m.item IS NOT NULL) AS is_manual, m.pct AS mpct, m.value_pct AS mval, m.effective_date AS meff, m.version AS mver,';
  m_pct text := E'           CASE WHEN it0.is_manual THEN least(1, greatest(0, it0.mpct)) WHEN it0.applic > 0 THEN least(1, it0.done::numeric / it0.applic) END AS pct,';
  m_msr text := E'           (it0.iw > 0 AND (it0.is_manual OR (it0.method = ''tasks'' AND coalesce(it0.applic, 0) > 0 AND NOT (it0.central AND NOT p_project_wide)))) AS measured';
  m_reason text := E'WHEN i.method <> ''tasks'' THEN ''no_data'' WHEN coalesce(i.applic, 0) = 0 THEN ''not_applicable''';
  m_mjson text := E'''manual'', CASE WHEN i.is_manual THEN jsonb_build_object(''value_pct'', i.mval, ''effective_date'', i.meff, ''version'', i.mver) END,';
BEGIN
  def := pg_get_functiondef('public.dash_ps_card(boolean,jsonb)'::regprocedure);
  IF position('cpct' IN def) = 0 THEN
    IF position(m_join IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no item-join anchor to patch'; END IF;
    def := replace(def, m_join, E'    FROM _dwi w LEFT JOIN ic ON ic.item = w.item LEFT JOIN _dman m ON m.item = w.item LEFT JOIN _dmplan mp ON mp.item = w.item LEFT JOIN _dcrc c ON c.item = w.item WHERE w.item IS NOT NULL');
    IF position(m_man IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no is_manual anchor to patch'; END IF;
    def := replace(def, m_man, m_man || E'\n           c.pct AS cpct,');
    IF position(m_pct IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no pct anchor to patch'; END IF;
    def := replace(def, m_pct, E'           CASE WHEN it0.cpct IS NOT NULL THEN least(1, greatest(0, it0.cpct)) WHEN it0.is_manual THEN least(1, greatest(0, it0.mpct)) WHEN it0.applic > 0 THEN least(1, it0.done::numeric / it0.applic) END AS pct,');
    IF position(m_msr IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no measured anchor to patch'; END IF;
    def := replace(def, m_msr, E'           (it0.iw > 0 AND (it0.cpct IS NOT NULL OR it0.is_manual OR (it0.method IN (''tasks'', ''register'') AND coalesce(it0.applic, 0) > 0 AND NOT (it0.central AND NOT p_project_wide)))) AS measured');
    IF position(m_reason IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no reason anchor to patch'; END IF;
    def := replace(def, m_reason, E'WHEN i.method = ''register'' AND NOT i.central THEN ''not_applicable'' WHEN i.method <> ''tasks'' THEN ''no_data'' WHEN coalesce(i.applic, 0) = 0 THEN ''not_applicable''');
    IF position(m_mjson IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no manual-json anchor to patch'; END IF;
    def := replace(def, m_mjson, E'''manual'', CASE WHEN i.is_manual AND i.cpct IS NULL THEN jsonb_build_object(''value_pct'', i.mval, ''effective_date'', i.meff, ''version'', i.mver) END,\n          ''register_measured'', i.cpct IS NOT NULL,');
    EXECUTE def;
  END IF;
END $$;

-- ------------------------------------------------------------------ weight_set_errors: validate register items at publish / preview
DO $$
DECLARE def text; marker text := E'\n  RETURN errs;';
BEGIN
  def := pg_get_functiondef('public.weight_set_errors(uuid)'::regprocedure);
  IF position('unknown_register' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'weight_set_errors() has no return anchor to patch'; END IF;
    EXECUTE replace(def, marker, E'\n'
      || E'  -- 0540: a register item names an enabled register; a site-scoped register is measured per site, a global one centrally.\n'
      || E'  FOR r IN SELECT i.code AS icode, i.measure_rule ->> ''register'' AS rk, coalesce((i.measure_rule ->> ''central'')::boolean, false) AS central\n'
      || E'           FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id\n'
      || E'           WHERE a.weight_set_id = p_set AND jsonb_typeof(i.measure_rule) = ''object'' AND i.measure_rule ->> ''method'' = ''register'' LOOP\n'
      || E'    IF r.rk IS NULL OR NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.rk AND d.is_active AND d.enabled) THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''unknown_register'', ''message'', ''Item '' || r.icode || '': the register "'' || coalesce(r.rk, '''') || ''" is not an enabled register.''));\n'
      || E'    ELSIF EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.rk AND d.site_scoped) AND r.central THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''invalid'', ''message'', ''Item '' || r.icode || '': a site-scoped register is measured per site, not centrally.''));\n'
      || E'    ELSIF EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.rk AND NOT d.site_scoped) AND NOT r.central THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''invalid'', ''message'', ''Item '' || r.icode || '': a register that is not site-scoped is measured centrally (central: true).''));\n'
      || E'    END IF;\n'
      || E'  END LOOP;'
      || marker);
  END IF;
END $$;
