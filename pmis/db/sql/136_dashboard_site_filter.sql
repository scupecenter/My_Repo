-- 0137_dashboard_site_filter: the unified filter on the dashboard (owner request 2026-11-22, CHANGELOG 183; contract 0.15.45). Mirror: db/sql/136_dashboard_site_filter.sql
-- (kept byte-identical).
--
-- WHAT THIS CHANGES. The dashboard engine (dash_core, used by dash_overview and dash_project_status) learns one more way to narrow the sites: the API compiles the
-- `filter` tree of the request against the sites whitelist (screen `dashboard`), reads the ids of the matching sites for the caller (row security applies) and passes
-- them in the transaction-local setting pmis.dash_sites (uuids separated by commas, or the word none for an empty set). dash_core then keeps only these sites in the
-- facts (_dsite, _dms, _dstr), exactly as the stream and view filters do, and the result is no longer "project wide" (central Project Status items stay hidden, as
-- for a region or a cluster). The setting only narrows: the caller's dashboard.view regions are applied first, and an unset or empty setting changes nothing, so the
-- snapshot job and every other caller behave as before. No signature changes (so no wrapper and no grant changes).
--
-- The body below is the latest definition (0092, db/sql/091_historical_direct_approval.sql) with the three changes marked 0137.

CREATE OR REPLACE FUNCTION public.dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid, p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean, p_view text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; hist int; wf_versions int[];
  rows_none jsonb; rows_region jsonb; ms jsonb; live boolean := (p_ref = public.cal_today()); blk_ok boolean; appr text[]; gt jsonb;
  v_sites text := nullif(current_setting('pmis.dash_sites', true), '');   -- 0137: the site set of the unified filter (null = no filter)
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  -- 0137 (contract 0.15.45): the site set of the `filter` tree (GET /dashboard, /project-status, the export), computed by the API on `sites` for the caller and passed as
  -- the transaction-local setting pmis.dash_sites (uuids separated by commas, or the word none). It only narrows what the caller's regions already allow.
  IF v_sites IS NOT NULL THEN
    IF v_sites = 'none' THEN DELETE FROM _dsite;
    ELSE DELETE FROM _dsite s WHERE s.id NOT IN (SELECT x::uuid FROM unnest(string_to_array(v_sites, ',')) x); END IF;
    DELETE FROM _dms m WHERE NOT EXISTS (SELECT 1 FROM _dsite s WHERE s.id = m.site_id);
    IF to_regclass('pg_temp._dstr') IS NOT NULL THEN DELETE FROM _dstr d WHERE NOT EXISTS (SELECT 1 FROM _dsite s WHERE s.id = d.site_id); END IF;
  END IF;
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
  wide := all_regions AND p_region IS NULL AND p_cluster IS NULL AND p_scenario IS NULL AND p_stream IS NULL AND p_view IS NULL AND v_sites IS NULL;   -- 0137: a narrowed set is not the whole project
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
  SELECT count(*) INTO flagged FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.admin_override OR t.historical_no_documents OR t.lock_bypassed OR t.historical_direct_approved;   -- 0085: a lock bypass too; 0092: a direct approval too
  SELECT count(*) INTO hist FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.historical_no_documents;   -- 0073 (Q462)
  out_ := jsonb_build_object('meta', jsonb_build_object('project_wide', wide, 'workflow_versions', coalesce(to_jsonb(wf_versions), '[]'::jsonb), 'override_flagged_count', flagged, 'historical_flagged_count', hist,
    'lock_bypass_flagged_count', (SELECT count(*) FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.lock_bypassed),
    'historical_direct_flagged_count', (SELECT count(*) FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.historical_direct_approved),   -- 0092
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
END $function$;
