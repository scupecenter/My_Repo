-- 0074: big New sites batches (technical decision of 2026-11-05, CHANGELOG 106).
--
-- WHY. The owner sent a New sites batch of 469 rows (TPL-SITE-NEW, 0070) while holding L1 and L2 of the Matrix row site_creation: the send is a
-- self-approval that creates every site in the same call. It took about 0.31 s per site (145 s for 469), so nginx answered 504 after 120 s, and the API
-- request transaction (TxInterceptor, a Prisma interactive transaction with a 30 s timeout) was rolled back anyway: nothing was kept. An L2 "approve all"
-- of a site batch and the Master import apply take the same path.
--
-- WHAT THIS CHANGES.
--   1. Faster site creation (same final data, same audit row per N/A task):
--      a. wf_apply_applicability_run: on a brand-new site (site_create_apply) every task is decided first (the rules read only the site and its scope
--         exceptions, never the state of another task), the N/A tasks are written in one statement with one audit row each, in the same order, and the
--         successors are opened once at the end, with the same gate test, instead of after each N/A. A task that becomes N/A in the same pass is therefore
--         no longer opened first and N/A right after: no transient "task_unlock" audit row, no "task ready" or "no holder" notice and no document slot
--         for it. The final task states, lock reasons, gates and SLA fields are the same (checked on 40 synthetic sites). Every other site (an approved
--         scope change, the admin path, P4a) keeps the step-by-step way, unchanged; wf_apply_applicability_core is a wrapper of it.
--      b. site_create_apply runs the calculation layer once, at the end (pmis.calc_busy, as wf_apply_applicability_core already did for its own pass).
--      c. custom_validate returns at once for a new row with no custom value when no active custom field of the entity has a default or is required
--         (the full check runs otherwise; the result is the same).
--      d. sla_task_close skips the update of an N/A task whose clock is already clear.
--      e. audit_log_fill reads the verified context once per row (log_ctx_values) instead of ten times (one HMAC check each). Same values.
--      Measured on 40 New Build / Hot Swap / Expansion sites (a self-approved send, pmis_app with a signed context): 12.9 s before, 3.0 s after.
--   2. A send or an approval of a New sites batch with more rows than the setting imports.async_rows (default 50) runs in the background: the request
--      checks everything (visibility, If-Match, the uploader, the state, the note, L1 / L2 of the Matrix row with the grid right, and the step-up from the
--      verified context) in imp_async_start and records a run in import_batch_jobs; the batch shows the status `processing` (computed, the stored status
--      is unchanged) and its progress. The API then calls imp_async_step chunk by chunk, each chunk in its own transaction under a newly signed context of
--      the same person: the person must be the one who asked (app_actor()), and every row is checked again by the same functions as the synchronous call.
--      The step-up is the one verified at the request (stored by imp_async_start; pmis_app cannot write the table and cannot pass it as a parameter). A
--      second send, a decision or a discard is refused while the run is active (409 batch_processing). imp_async_pending lists the runs left in
--      processing so that the API resumes them after a restart; imp_async_abandon stops a run (its person, or anyone once that person can no longer act).
--      When the run ends, the batch gets its status and its one audit row and notices, exactly as the synchronous call would write them.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp for the new functions, owner pmis_definer, EXECUTE revoked from PUBLIC;
-- pmis_app is granted only the doors imp_async_start, imp_async_step, imp_async_pending, imp_async_abandon and imp_batch_job_json. No new table right.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The applicability of a site: the step-by-step way, and the fast way of a brand-new site
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_apply_applicability_run(p_site uuid, p_reason text, p_fresh boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; t record; x record; y record; conf jsonb; changed jsonb := '[]'::jsonb; kept jsonb := '[]'::jsonb; before jsonb; hold record; opened boolean;
  cur_state text; cur_reason text; was_busy text := coalesce(current_setting('pmis.calc_busy', true), ''); na_ids uuid[] := ARRAY[]::uuid[];
  fresh boolean; n_before jsonb[] := ARRAY[]::jsonb[]; n_source text[] := ARRAY[]::text[]; n_rule text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  conf := public.scope_scenario_conflicts(p_site);
  IF jsonb_array_length(conf) > 0 THEN
    PERFORM public.calc_err('scope_scenario_conflict', jsonb_build_object('detail', 'The scenario and the scope flags disagree. Review them before the scope is applied.', 'conflicts', conf));
  END IF;
  PERFORM set_config('pmis.calc_busy', '1', true);
  -- 0074: a brand-new site (every task locked or open, nothing entered, nothing N/A yet) takes the fast way: the rules read only the site and its
  -- exceptions, never the state of another task, so every task is decided first, the N/A tasks are written in one statement with one audit row each
  -- (in the same order), and the successors are opened once at the end. Any other site takes the step-by-step way below, unchanged.
  fresh := p_fresh AND NOT EXISTS (SELECT 1 FROM public.task_instances ti WHERE ti.site_id = p_site AND ti.state NOT IN ('locked', 'open', 'entry'));
  IF fresh THEN
    FOR t IN
      SELECT ti.id, td.code, ti.state::text AS state FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"
    LOOP
      SELECT * INTO x FROM public.site_task_rule(p_site, t.code);
      IF x.applies IS FALSE THEN
        na_ids := na_ids || t.id; n_before := n_before || public.wf_snap(t.id); n_source := n_source || x.source; n_rule := n_rule || x.rule_reason;
        changed := changed || jsonb_build_array(jsonb_build_object('task_code', t.code, 'from', t.state, 'to', 'na', 'source', x.source));
      END IF;
    END LOOP;
    IF cardinality(na_ids) > 0 THEN
      -- the clock of an N/A task is cleared here (sla_task_close finds nothing left to clear)
      UPDATE public.task_instances ti SET state = 'na', is_na = true, na_reason = left('applicability: ' || coalesce(u.rule_reason, u.source), 500),
        ball_in_court_user_id = NULL, lock_reason = NULL, version = ti.version + 1, updated_at = now(),
        due_date = NULL, sla_target_date = NULL, sla_start_date = NULL, sla_end_date = NULL, sla_elapsed_wd = NULL
      FROM unnest(na_ids, n_source, n_rule) AS u(id, source, rule_reason) WHERE ti.id = u.id;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      SELECT 'task_applicability_na', 'task', u.id::text, s.id, s.region_id, u.before,
             public.wf_snap(u.id) || jsonb_build_object('source', u.source, 'rule', u.rule_reason), p_reason, public.app_actor()
      FROM unnest(na_ids, n_before, n_source, n_rule) WITH ORDINALITY AS u(id, before, source, rule_reason, ord) ORDER BY u.ord;
    END IF;
  END IF;
  FOR t IN
    SELECT ti.id, td.code, td.id AS def_id FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
    WHERE ti.site_id = p_site AND NOT fresh ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"
  LOOP
    SELECT ti.state::text, ti.na_reason INTO cur_state, cur_reason FROM public.task_instances ti WHERE ti.id = t.id;
    SELECT * INTO x FROM public.site_task_rule(p_site, t.code);
    IF x.applies IS FALSE AND cur_state NOT IN ('na', 'skipped') THEN
      IF cur_state IN ('locked', 'open', 'entry') THEN
        before := public.wf_snap(t.id);
        UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = left('applicability: ' || coalesce(x.rule_reason, x.source), 500),
          ball_in_court_user_id = NULL, lock_reason = NULL, version = version + 1, updated_at = now()
        WHERE id = t.id;
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
        VALUES ('task_applicability_na', 'task', t.id::text, s.id, s.region_id, before,
                public.wf_snap(t.id) || jsonb_build_object('source', x.source, 'rule', x.rule_reason), p_reason, public.app_actor());
        PERFORM public.wf_unlock_successors(t.id);
        changed := changed || jsonb_build_array(jsonb_build_object('task_code', t.code, 'from', cur_state, 'to', 'na', 'source', x.source));
      ELSE
        kept := kept || jsonb_build_array(jsonb_build_object('task_code', t.code, 'state', cur_state, 'reason', 'in_progress_or_approved'));
      END IF;
    ELSIF x.applies IS TRUE AND cur_state = 'na' AND starts_with(coalesce(cur_reason, ''), 'applicability:') THEN
      before := public.wf_snap(t.id);
      UPDATE public.task_instances SET state = 'locked', is_na = false, na_reason = NULL, current_level = 0, version = version + 1, updated_at = now() WHERE id = t.id;
      opened := false;
      IF NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = p_site AND pi.task_def_id = p2.predecessor_id
                     WHERE p2.task_def_id = t.def_id AND pi.state NOT IN ('approved', 'na', 'skipped')) THEN
        SELECT * INTO hold FROM public.wf_gate_hold(t.id);
        IF hold.gate_code IS NOT NULL THEN
          UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code WHERE id = t.id;
        ELSE
          opened := public.wf_open_locked(t.id, 'applies again: ' || coalesce(x.source, ''));
        END IF;
      END IF;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_applicability_restore', 'task', t.id::text, s.id, s.region_id, before,
              public.wf_snap(t.id) || jsonb_build_object('source', x.source, 'exception_id', x.exception_id), p_reason, public.app_actor());
      changed := changed || jsonb_build_array(jsonb_build_object('task_code', t.code, 'from', 'na', 'to', CASE WHEN opened THEN 'open' ELSE 'locked' END, 'source', x.source));
    END IF;
  END LOOP;
  IF fresh AND cardinality(na_ids) > 0 THEN
    FOR y IN
      SELECT ti.id,
        (SELECT pi.id FROM public.task_predecessors p3 JOIN public.task_instances pi ON pi.site_id = p_site AND pi.task_def_id = p3.predecessor_id
         WHERE p3.task_def_id = ti.task_def_id AND pi.id = ANY (na_ids) ORDER BY array_position(na_ids, pi.id) DESC LIMIT 1) AS trigger_id
      FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
      WHERE ti.site_id = p_site AND ti.state = 'locked'
        AND EXISTS (SELECT 1 FROM public.task_predecessors p1 JOIN public.task_instances pi ON pi.site_id = p_site AND pi.task_def_id = p1.predecessor_id
                    WHERE p1.task_def_id = ti.task_def_id AND pi.id = ANY (na_ids))
        AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = p_site AND pi.task_def_id = p2.predecessor_id
                        WHERE p2.task_def_id = ti.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped'))
      ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"
    LOOP
      SELECT * INTO hold FROM public.wf_gate_hold(y.id);
      IF hold.gate_code IS NOT NULL THEN
        UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code WHERE id = y.id AND lock_reason IS DISTINCT FROM 'gate_closed:' || hold.gate_code;
      ELSE
        PERFORM public.wf_open_locked(y.id, 'predecessor ' || public.wf_label(y.trigger_id) || ' approved');
      END IF;
    END LOOP;
  END IF;
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  IF was_busy <> '1' THEN PERFORM public.calc_refresh_site(p_site); END IF;
  RETURN jsonb_build_object('site_id', p_site, 'changed', changed, 'kept', kept);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION wf_apply_applicability_core(p_site uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.wf_apply_applicability_run(p_site, p_reason, false);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. custom_validate: the fast return of a new row without custom values (the rest as 0007)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION custom_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e "FieldEntityType" := TG_ARGV[0]::"FieldEntityType";
  newc jsonb := coalesce(NEW.custom, '{}'::jsonb);
  oldc jsonb;
  tcode text;
  f field_definitions%ROWTYPE; k text; v jsonb; changed boolean; err text;
BEGIN
  IF TG_OP = 'INSERT' AND newc = '{}'::jsonb
     AND NOT EXISTS (SELECT 1 FROM field_definitions d WHERE d.entity_type = e AND d.is_active AND (d.required OR d.default_value IS NOT NULL)) THEN
    NEW.custom := newc;
    RETURN NEW;
  END IF;
  oldc := CASE WHEN TG_OP = 'UPDATE' THEN coalesce(OLD.custom, '{}'::jsonb) ELSE '{}'::jsonb END;
  tcode := CASE WHEN TG_ARGV[0] = 'task_instance' THEN (SELECT td.code FROM task_definitions td WHERE td.id = (to_jsonb(NEW)->>'task_def_id')::uuid) END;
  IF jsonb_typeof(newc) <> 'object' THEN
    RAISE EXCEPTION 'custom must be a JSON object' USING ERRCODE = 'check_violation';
  END IF;
  FOR k IN SELECT jsonb_object_keys(newc) LOOP
    IF NOT EXISTS (SELECT 1 FROM field_definitions d WHERE d.entity_type = e AND d.code = k AND (d.task_code IS NULL OR d.task_code = tcode)) THEN
      RAISE EXCEPTION 'unknown custom field "%" on %', k, TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  FOR f IN SELECT * FROM field_definitions d WHERE d.entity_type = e AND (d.task_code IS NULL OR d.task_code = tcode) LOOP
    IF TG_OP = 'INSERT' AND f.is_active AND f.default_value IS NOT NULL AND NOT newc ? f.code THEN
      newc := newc || jsonb_build_object(f.code, f.default_value);
    END IF;
    v := newc -> f.code;
    changed := v IS DISTINCT FROM (oldc -> f.code);
    IF NOT f.is_active THEN
      IF changed THEN RAISE EXCEPTION 'field "%" is deactivated: its values are kept but cannot be changed', f.code USING ERRCODE = 'check_violation'; END IF;
      CONTINUE;
    END IF;
    IF (v IS NULL OR v = 'null'::jsonb) THEN
      IF f.required AND (TG_OP = 'INSERT' OR changed) THEN
        RAISE EXCEPTION 'field "%" is required', f.code USING ERRCODE = 'check_violation';
      END IF;
    ELSIF changed THEN
      err := custom_check_value(f, v);
      IF err IS NOT NULL THEN RAISE EXCEPTION 'field "%": %', f.code, err USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END LOOP;
  NEW.custom := newc;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. site_create_apply (as 0070): the fast applicability of a new site, the calculation once at the end; sla_task_close (as 0052) skips a no-op update
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_create_apply(p_draft uuid, p_self boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.site_drafts%ROWTYPE; v jsonb; c jsonb; wf uuid := public.active_workflow_id(); sid uuid; cid uuid; ccode text; created_cluster boolean := false; t record; s jsonb;
  actor uuid := public.app_actor(); first_seq int; applied jsonb; errs jsonb := '[]'::jsonb; e jsonb; why text;
  was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- 0074: the calculation layer runs once, at the end (the opening of the first tasks and the applicability no longer refresh the site in between)
  PERFORM set_config('pmis.calc_busy', '1', true);
  SELECT * INTO d FROM public.site_drafts WHERE id = p_draft FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist.')); END IF;
  IF d.status NOT IN ('entry', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The draft is ' || d.status || '.'));
  END IF;
  -- checked again now: a Site ID, a list or a rule may have changed since the draft was entered
  v := public.site_new_clean(d.data, d.id);
  IF jsonb_array_length(v -> 'errors') > 0 THEN
    FOR e IN SELECT * FROM jsonb_array_elements(v -> 'errors') LOOP
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || (e ->> 'field'), 'code', e ->> 'code', 'message', e ->> 'message'));
    END LOOP;
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs, 'detail', 'The site cannot be created: ' || coalesce(errs -> 0 ->> 'message', 'a value is not valid') ));
  END IF;
  c := v -> 'clean';
  IF wf IS NULL OR NOT public.wf_is_published(wf) THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'There is no published workflow version.')); END IF;

  -- the cluster of the row: an existing one, or a new one in the site's region
  IF c ->> 'cluster_code' IS NOT NULL THEN
    SELECT id INTO cid FROM public.clusters WHERE upper(cluster_code) = upper(c ->> 'cluster_code');
    IF cid IS NULL THEN
      INSERT INTO public.clusters (cluster_code, region_id, is_global) VALUES (c ->> 'cluster_code', (c ->> 'region_id')::int, false) RETURNING id INTO cid;
      created_cluster := true;
      PERFORM public.log_audit_write('cluster_create', 'cluster', cid::text, NULL, jsonb_build_object('cluster_code', c ->> 'cluster_code', 'region_id', (c ->> 'region_id')::int),
        'created with the first site of the cluster (site creation, draft ' || d.id::text || ')', NULL, (c ->> 'region_id')::int);
    END IF;
  END IF;

  INSERT INTO public.sites (site_code, owner_site_id, name, name_ar, region_id, workflow_version_id, sub_region, cluster_id, latitude, longitude, address, site_type, site_scenario,
    project_phase, delivery_batch, delivery_scenario, cw_delivery_model, rf_survey_date, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber,
    scope_te_full, scope_te_ip_router_only, overall_status, updated_at)
  VALUES (c ->> 'site_code', c ->> 'owner_site_id', c ->> 'name', c ->> 'name_ar', (c ->> 'region_id')::int, wf, c ->> 'sub_region', cid,
    (c ->> 'latitude')::numeric, (c ->> 'longitude')::numeric, c ->> 'address', c ->> 'site_type', c ->> 'site_scenario', c ->> 'project_phase', c ->> 'delivery_batch',
    (c ->> 'delivery_scenario')::"DeliveryScenario", c ->> 'cw_delivery_model', (c ->> 'rf_survey_date')::date,
    coalesce((c ->> 'scope_tower_erection')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_site_adaption')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_gecol_power')::"ScopeFlag", 'na'),
    coalesce((c ->> 'scope_hlc_fiber')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_te_full')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_te_ip_router_only')::"ScopeFlag", 'na'),
    'not_started', clock_timestamp())
  RETURNING id INTO sid;

  -- every task of the workflow version in force, locked, with its levels and SLA rule (the pattern of admin_migrate_sites_to_workflow)
  INSERT INTO public.task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
  SELECT s2.id, s2.region_id, td.id, 'locked', coalesce(td.approval_levels, st.approval_levels), public.sla_rule_for(td.id, s2.delivery_scenario, s2.region_id, current_date), now()
  FROM public.sites s2 JOIN public.task_definitions td ON td.workflow_id = wf AND td.is_active JOIN public.stage_definitions st ON st.id = td.stage_id AND st.is_active
  WHERE s2.id = sid;

  -- the engine opens the first tasks: those of the first stage that wait for no predecessor (a dismantle task is opened by hand, Q382)
  SELECT min(st.seq) INTO first_seq FROM public.stage_definitions st WHERE st.workflow_id = wf AND st.is_active;
  FOR t IN SELECT ti.id FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions st ON st.id = td.stage_id
           WHERE ti.site_id = sid AND st.seq = first_seq AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p WHERE p.task_def_id = td.id) ORDER BY td.sort_order, td.code LOOP
    PERFORM public.wf_open_locked(t.id, 'site created');
  END LOOP;

  why := 'site created (' || CASE WHEN d.batch_id IS NOT NULL THEN 'batch ' || d.batch_id::text || ' row ' || coalesce(d.batch_row_id::text, '?') ELSE 'draft ' || d.id::text END || ')';
  -- the scenario applicability of P1: tasks that the scenario and the scope flags make N/A, and the chain that follows
  applied := public.wf_apply_applicability_run(sid, why, true);   -- 0074: a brand-new site, the successors are opened once at the end

  UPDATE public.site_drafts SET status = 'approved', site_id = sid, decided_by = actor, decided_at = clock_timestamp(), self_approval = p_self, version = version + 1, updated_at = clock_timestamp()
  WHERE id = d.id;

  SELECT jsonb_build_object('site_code', s3.site_code, 'name', s3.name, 'name_ar', s3.name_ar, 'region_id', s3.region_id, 'cluster_code', c ->> 'cluster_code',
           'cluster_created', created_cluster, 'delivery_scenario', s3.delivery_scenario, 'workflow_version_id', s3.workflow_version_id, 'tasks', (SELECT count(*) FROM public.task_instances WHERE site_id = sid),
           'applicability_changed', jsonb_array_length(applied -> 'changed'), 'draft_id', d.id, 'batch_id', d.batch_id, 'batch_row_id', d.batch_row_id,
           'self_approval', p_self, 'created_by', d.created_by)
    INTO s FROM public.sites s3 WHERE s3.id = sid;
  PERFORM public.log_audit_write('site_create', 'site', sid::text, NULL, s, why, sid, (c ->> 'region_id')::int);

  -- Q466: a Cancelled row creates the site and then cancels it, so its history exists
  IF c ->> 'overall_status' = 'cancelled' THEN
    UPDATE public.sites SET overall_status = 'cancelled', updated_at = clock_timestamp() WHERE id = sid;
    PERFORM public.log_audit_write('site_cancelled', 'site', sid::text, jsonb_build_object('overall_status', 'not_started'), jsonb_build_object('overall_status', 'cancelled'),
      'created as Cancelled (Q466): ' || why, sid, (c ->> 'region_id')::int);
  END IF;
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  PERFORM public.calc_refresh_site(sid);
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION sla_task_close(p_task uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.sla_rules%ROWTYPE; e date; el integer;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.state IN ('na', 'skipped') THEN
    -- 0074: only when something is left to clear (the fast applicability of a new site clears it in the same statement as the N/A)
    UPDATE public.task_instances SET due_date = NULL, sla_target_date = NULL, sla_start_date = NULL, sla_end_date = NULL, sla_elapsed_wd = NULL
    WHERE id = p_task AND (due_date IS NOT NULL OR sla_target_date IS NOT NULL OR sla_start_date IS NOT NULL OR sla_end_date IS NOT NULL OR sla_elapsed_wd IS NOT NULL);
    RETURN;
  END IF;
  IF t.sla_start_date IS NULL OR t.sla_rule_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = t.sla_rule_id;
  e := CASE r.end_ref
         WHEN 'gecol.installation_finish' THEN coalesce((SELECT g.installation_finish FROM public.gecol_records g WHERE g.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'hlc.installation_date' THEN coalesce((SELECT h.installation_date FROM public.hlc_records h WHERE h.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'hlc.in_service_date' THEN coalesce((SELECT h.in_service_date FROM public.hlc_records h WHERE h.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'task.layout_submitted_date' THEN public.task_value_date(t.values, 'layout_submitted_date')
         ELSE coalesce(t.actual_date, t.approved_date) END;
  el := public.cal_workdays_between(t.sla_start_date, e, r.calendar_id);
  UPDATE public.task_instances SET sla_end_date = e, sla_elapsed_wd = el WHERE id = p_task;
  IF el < 0 THEN
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('sla_negative_duration', 'task', p_task::text, t.site_id, t.region_id,
            jsonb_build_object('sla_start_date', t.sla_start_date, 'sla_end_date', e),
            jsonb_build_object('sla_elapsed_wd', el), 'data quality: the actual date is before the SLA start (Q82)', public.app_actor());
    PERFORM public.calc_alert(p_task, 'sla_negative_duration', 'SLA duration is negative',
      public.wf_label(p_task) || ': the actual date ' || e::text || ' is before the SLA start ' || t.sla_start_date::text || ' (' || el::text || ' working days). Please review the dates.');
  END IF;
END $$;
-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The audit context read once per row
-- ---------------------------------------------------------------------------------------------------------------------
-- audit_log_fill reads the verified context once per row (it read it ten times, one HMAC check each). Same values as log_ctx / app_ctx_get / app_ctx_via.
CREATE OR REPLACE FUNCTION log_ctx_values() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.app_ctx(); h text := nullif(current_setting('app.via', true), ''); v text;
BEGIN
  IF c IS NOT NULL THEN
    v := nullif(c ->> 'via', '');
    IF v = 'manual' AND h IN ('button', 'drag', 'bulk') THEN v := h; END IF;
    RETURN jsonb_build_object('ip', nullif(c ->> 'ip', ''), 'user_agent', nullif(c ->> 'ua', ''), 'request_id', nullif(c ->> 'rid', ''), 'session_id', nullif(c ->> 'sid', ''),
      'auth_method', nullif(c ->> 'am', ''), 'mfa', nullif(c ->> 'mfa', ''), 'stepup', nullif(coalesce(c ->> 'su', 'false'), ''), 'device', nullif(c ->> 'dev', ''),
      'job_name', nullif(c ->> 'job', ''), 'via', nullif(v, ''));
  END IF;
  IF public.app_ctx_legacy() THEN
    RETURN jsonb_build_object('ip', nullif(current_setting('app.ip', true), ''), 'user_agent', nullif(current_setting('app.user_agent', true), ''),
      'request_id', nullif(current_setting('app.request_id', true), ''), 'session_id', nullif(current_setting('app.session_id', true), ''),
      'auth_method', nullif(current_setting('app.auth_method', true), ''), 'mfa', nullif(current_setting('app.mfa', true), ''),
      'stepup', nullif(current_setting('app.stepup', true), ''), 'device', nullif(current_setting('app.device', true), ''),
      'job_name', nullif(current_setting('app.job_name', true), ''), 'via', h);
  END IF;
  RETURN '{}'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION audit_log_fill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v text; c jsonb := public.log_ctx_values();
BEGIN
  IF NEW.ip IS NULL AND c ->> 'ip' IS NOT NULL THEN
    BEGIN NEW.ip := host((c ->> 'ip')::inet); EXCEPTION WHEN others THEN NEW.ip := NULL; END;
  END IF;
  IF NEW.user_agent IS NULL THEN NEW.user_agent := left(c ->> 'user_agent', 400); END IF;
  IF NEW.request_id IS NULL THEN NEW.request_id := left(c ->> 'request_id', 64); END IF;
  IF NEW.session_id IS NULL AND c ->> 'session_id' IS NOT NULL THEN
    BEGIN NEW.session_id := (c ->> 'session_id')::uuid; EXCEPTION WHEN others THEN NEW.session_id := NULL; END;
  END IF;
  IF NEW.auth_method IS NULL THEN
    v := c ->> 'auth_method';
    NEW.auth_method := CASE WHEN v IN ('local', 'oidc', 'break_glass') THEN v END;
  END IF;
  IF NEW.mfa IS NULL THEN NEW.mfa := CASE c ->> 'mfa' WHEN 'true' THEN true WHEN 'false' THEN false END; END IF;
  IF NEW.stepup_verified IS NULL THEN NEW.stepup_verified := CASE c ->> 'stepup' WHEN 'true' THEN true WHEN 'false' THEN false END; END IF;
  IF NEW.device IS NULL THEN
    v := c ->> 'device';
    IF v IS NOT NULL AND length(v) <= 400 THEN
      BEGIN NEW.device := nullif(public.log_clean_device(v::jsonb), '{}'::jsonb); EXCEPTION WHEN others THEN NEW.device := NULL; END;
    END IF;
  END IF;
  IF NEW.job_name IS NULL THEN NEW.job_name := left(c ->> 'job_name', 80); END IF;
  IF NEW.batch_row IS NULL THEN NEW.batch_row := coalesce(public.log_jsonb_uuid(NEW.after, 'batch_row_id'), public.imp_current_row()); END IF;
  IF NEW.batch_id IS NULL THEN
    NEW.batch_id := coalesce(public.log_jsonb_uuid(NEW.after, 'batch_id'), (SELECT x.batch_id FROM public.import_batch_rows x WHERE x.id = NEW.batch_row));
  END IF;
  IF NEW.via IS NULL THEN
    v := c ->> 'via';
    NEW.via := CASE
      WHEN NEW.batch_row IS NOT NULL OR NEW.batch_id IS NOT NULL OR NEW.after ->> 'via' = 'batch' THEN 'template'
      WHEN v = 'job' THEN 'job'
      WHEN v = 'api' THEN 'api'
      WHEN v = 'bulk' OR NEW.after ->> 'via' = 'bulk' THEN 'bulk'
      WHEN v IN ('manual', 'button', 'drag') THEN 'manual'
      ELSE NULL END;
  END IF;
  IF NEW.module_key IS NULL THEN NEW.module_key := public.log_audit_module(NEW.entity_type, NEW.entity_id, NEW.before, NEW.after); END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The batch status `processing` and the background job of a big New sites batch
-- ---------------------------------------------------------------------------------------------------------------------
-- One row per background run of a send or an "approve" of a New sites batch. Written only by the imp_async_* functions (owner pmis_definer); the
-- application role has no right on it (it reads the progress through imp_batch_job_json). `items` is the fixed list of the rows an approval decides
-- (taken when it was asked), `pos` how many of them are done; a send needs no list (the rows still to send are those without a draft).
CREATE TABLE import_batch_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid NOT NULL REFERENCES import_batches (id),
  kind            text NOT NULL CHECK (kind IN ('submit', 'decide')),
  action          text CHECK (action IS NULL OR action = 'approve'),
  scope           text CHECK (scope IS NULL OR scope IN ('all', 'rows')),
  items           jsonb,
  note            text CHECK (note IS NULL OR char_length(note) <= 2000),
  actor_id        uuid NOT NULL REFERENCES users (id),
  stepup_verified boolean NOT NULL,
  stepup_until    timestamptz,
  session_id      uuid,
  auth_method     text,
  mfa             boolean,
  request_id      text,
  prev_status     text NOT NULL,
  state           text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  rows_total      integer NOT NULL CHECK (rows_total >= 0),
  rows_done       integer NOT NULL DEFAULT 0,
  pos             integer NOT NULL DEFAULT 0,
  n_submitted     integer NOT NULL DEFAULT 0,
  n_decided       integer NOT NULL DEFAULT 0,
  n_approved      integer NOT NULL DEFAULT 0,
  n_rejected      integer NOT NULL DEFAULT 0,
  n_failed        integer NOT NULL DEFAULT 0,
  failed          jsonb NOT NULL DEFAULT '[]'::jsonb,
  chunks          integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz
);
CREATE UNIQUE INDEX import_batch_jobs_one_running ON import_batch_jobs (batch_id) WHERE state = 'running';
CREATE INDEX import_batch_jobs_batch ON import_batch_jobs (batch_id, created_at DESC);
COMMENT ON TABLE import_batch_jobs IS '0074: the background run of the send or the approval of a big New sites batch (status processing). Written only by imp_async_*; no right for pmis_app.';
ALTER TABLE import_batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch_jobs FORCE ROW LEVEL SECURITY;   -- no policy: only the definer functions (pmis_definer bypasses row security) read it
REVOKE ALL ON import_batch_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON import_batch_jobs TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON import_batch_jobs FROM pmis_app; END IF;
END $$;

-- The batch size above which a send or an approval of a New sites batch runs in the background (Q: technical decision of 2026-11-05).
INSERT INTO settings (key, value, description, updated_at)
VALUES ('imports.async_rows', '50'::jsonb, 'A New sites batch with more rows than this to send or to approve is processed in the background (status processing, in chunks), never in one HTTP request (0074).', now())
ON CONFLICT (key) DO NOTHING;

-- `processing` is shown while a background run is active; the stored status is unchanged (the per-row functions read it).
CREATE OR REPLACE FUNCTION imp_status_of(p_batch uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE b public.import_batches%ROWTYPE; n_open int; n_ok int; n_rej int;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j WHERE j.batch_id = p_batch AND j.state = 'running') THEN RETURN 'processing'; END IF;   -- 0074
  IF b.status NOT IN ('in_approval', 'partially_approved', 'approved', 'rejected') THEN RETURN b.status; END IF;
  SELECT count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision IN ('pending', 'pending_previous_approval')),
         count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'approved'),
         count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'rejected')
    INTO n_open, n_ok, n_rej FROM public.v_import_rows x WHERE x.batch_id = p_batch;
  RETURN CASE WHEN n_open > 0 AND n_ok + n_rej = 0 THEN 'in_approval' WHEN n_open > 0 THEN 'partially_approved' WHEN n_ok > 0 THEN 'approved' ELSE 'rejected' END;
END $$;

-- The progress of the latest background run of a batch the caller may see (NULL when it never had one).
CREATE OR REPLACE FUNCTION imp_batch_job_json(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('job_id', j.id, 'kind', j.kind, 'state', j.state, 'rows_total', j.rows_total, 'rows_done', j.rows_done,
           'percent', CASE WHEN j.rows_total = 0 THEN 100 ELSE floor(100.0 * j.rows_done / j.rows_total)::int END,
           'submitted', j.n_submitted, 'approved', j.n_approved, 'rejected', j.n_rejected, 'failed', j.n_failed,
           'started_at', j.created_at, 'updated_at', j.heartbeat_at, 'finished_at', j.finished_at, 'error', j.error)
  FROM public.import_batch_jobs j
  WHERE j.batch_id = p_batch AND public.app_actor() IS NOT NULL AND public.imp_batch_visible(p_batch)
  ORDER BY j.created_at DESC LIMIT 1
$$;

-- Refused while a background run is active: a second send, a decision or a discard (409 batch_processing).
CREATE OR REPLACE FUNCTION imp_async_guard(p_batch uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.import_batch_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.import_batch_jobs x WHERE x.batch_id = p_batch AND x.state = 'running';
  IF FOUND THEN
    PERFORM public.wf_err('batch_processing', jsonb_build_object('detail', 'The batch is being processed (' || j.rows_done || ' of ' || j.rows_total || ' rows). Wait until it ends.',
      'rows_done', j.rows_done, 'rows_total', j.rows_total));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The send and the decision of a New sites batch, split into "rows" and "finish" so that a background run can do the rows in chunks.
--    The synchronous functions are the same composition as before (identical answers, audit rows and notices).
-- ---------------------------------------------------------------------------------------------------------------------
-- Sends up to p_limit rows (NULL: all). p_stepup: the step-up of the request (the synchronous call) or the one verified when the background run was asked.
-- p_async: a row whose sender holds L2 but has no verified step-up is left as a draft waiting for L2 instead of failing the whole call.
CREATE OR REPLACE FUNCTION imp_submit_site_rows(p_batch uuid, p_limit integer, p_stepup boolean, p_async boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); r public.import_batch_rows%ROWTYPE; v jsonb; c jsonb; rid int; did uuid; sid uuid; self boolean; submitted int := 0; processed int := 0;
  failed jsonb := '[]'::jsonb; j jsonb; msg text; code text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL ORDER BY x.row_no LIMIT p_limit LOOP
    processed := processed + 1;
    BEGIN
      v := public.site_new_clean(r.payload -> 'data', NULL);
      IF jsonb_array_length(v -> 'errors') > 0 THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.site_draft_errors(v -> 'errors'), 'detail', coalesce(v -> 'errors' -> 0 ->> 'message', 'The row is not valid.')));
      END IF;
      c := v -> 'clean'; rid := (c ->> 'region_id')::int;
      IF NOT (public.site_new_may('create', rid) AND public.site_new_holds(rid, 'entry')) THEN
        PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Data Entry holder (L1) of the Site creation row of the Matrix in this region.'));
      END IF;
      INSERT INTO public.site_drafts (site_code, region_id, data, status, created_by, submitted_by, submitted_at, batch_id, batch_row_id)
      VALUES (c ->> 'site_code', rid, c, 'in_approval', actor, actor, clock_timestamp(), p_batch, r.id) RETURNING id INTO did;
      UPDATE public.import_batch_rows SET site_draft_id = did WHERE id = r.id;
      self := public.site_new_holds(rid, 'approve') AND public.site_new_may('approve', rid);
      IF self AND NOT coalesce(p_stepup, false) THEN
        IF p_async THEN self := false; ELSE PERFORM public.wf_err('step_up_required'); END IF;
      END IF;
      IF self THEN
        sid := public.site_create_apply(did, true);
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), site_id = sid WHERE id = r.id;
      END IF;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The row could not be sent. See the System Log (template-check) for the technical reason.' END;
      code := coalesce(j ->> 'code', 'row_failed');
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', site_draft_id = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('code', code, 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', code, 'message', left(msg, 300)));
    END;
  END LOOP;
  RETURN jsonb_build_object('submitted', submitted, 'processed', processed, 'failed', failed);
END $$;

-- The end of a send: the status, the audit row and the notice to the L2 holders, once.
CREATE OR REPLACE FUNCTION imp_submit_site_finish(p_batch uuid, p_prev_status text, p_submitted integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text; rid int;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := CASE WHEN p_submitted > 0 OR p_prev_status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE p_prev_status END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_submit', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('submitted', p_submitted, 'held', 0, 'failed', p_failed, 'status', new_st), NULL);
  IF p_submitted > 0 THEN
    FOR rid IN SELECT DISTINCT x.region_id FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.site_draft_id IS NOT NULL AND x.decision = 'pending' AND x.region_id IS NOT NULL LOOP
      PERFORM public.site_draft_notify_l2(rid, b.file_name, (SELECT x.site_draft_id FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.region_id = rid AND x.site_draft_id IS NOT NULL LIMIT 1));
    END LOOP;
  END IF;
  RETURN new_st;
END $$;

-- The synchronous send (as 0070): the uploader sends the valid rows; a person who holds both levels approves at once (B5, step-up).
CREATE OR REPLACE FUNCTION imp_submit_site_batch(p_batch uuid, p_version integer, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; res jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  res := public.imp_submit_site_rows(p_batch, NULL, public.app_ctx_stepup(), false);
  PERFORM public.imp_submit_site_finish(p_batch, b.status, (res ->> 'submitted')::int, jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('submitted', (res ->> 'submitted')::int, 'held', '[]'::jsonb, 'failed', res -> 'failed');
END $$;

-- Decides the rows of a New sites batch (the loop of 0070). Returns the counts and the first refusal of the authority (the caller raises it when nothing was decided).
CREATE OR REPLACE FUNCTION imp_decide_site_rows(p_batch uuid, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); r public.v_import_rows%ROWTYPE; dr public.site_drafts%ROWTYPE; item jsonb; act text; rnote text;
  decided int := 0; approved int := 0; rejected int := 0; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; msg text; sid uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.action = 'create' AND EXISTS (SELECT 1 FROM public.import_batch_rows q WHERE q.id = x.id AND q.site_draft_id IS NOT NULL)
             AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision = 'pending') OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.row_no LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision IN ('approved', 'rejected') THEN CONTINUE; END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO dr FROM public.site_drafts WHERE id = (SELECT q.site_draft_id FROM public.import_batch_rows q WHERE q.id = r.id) FOR UPDATE;
      IF dr.status <> 'in_approval' THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition', 'message', 'The site draft is ' || dr.status || '.'));
        CONTINUE;
      END IF;
      IF NOT (public.site_new_may('approve', dr.region_id) AND public.site_new_holds(dr.region_id, 'approve')) THEN
        BEGIN
          PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Review and Approve holder (L2) of the Site creation row in this region.'));
        EXCEPTION WHEN others THEN first_forbidden := coalesce(first_forbidden, SQLERRM);
        END;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'not_eligible_holder',
          'message', 'You are not a Review and Approve holder (L2) of the Site creation row in this region.'));
        CONTINUE;
      END IF;
      IF act = 'reject' THEN
        UPDATE public.site_drafts SET status = 'rejected', decided_by = actor, decided_at = clock_timestamp(), decision_note = left(rnote, 2000), version = version + 1, updated_at = clock_timestamp() WHERE id = dr.id;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = 'reject' WHERE id = r.id;
        PERFORM public.log_audit_write('site_draft_return', 'site_draft', dr.id::text, jsonb_build_object('status', 'in_approval'), jsonb_build_object('status', 'rejected', 'note', left(rnote, 2000)), rnote, NULL, dr.region_id);
        rejected := rejected + 1; decided := decided + 1;
      ELSE
        IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
        sid := public.site_create_apply(dr.id, dr.created_by = actor);
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = 'approve', site_id = sid WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
      END IF;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j ->> 'code' IN ('not_eligible_holder', 'action_forbidden') AND first_forbidden IS NULL THEN first_forbidden := SQLERRM; END IF;
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be decided', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The row could not be decided. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'failed', failed, 'first_forbidden', first_forbidden);
END $$;

-- The end of a decision: the status, the note of a return, the audit row and the notice to the uploader, once.
CREATE OR REPLACE FUNCTION imp_decide_site_finish(p_batch uuid, p_action text, p_scope text, p_note text, p_decided integer, p_approved integer, p_rejected integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_' || p_action, 'import_batch', p_batch::text, NULL,
    jsonb_build_object('scope', p_scope, 'decided', p_decided, 'approved', p_approved, 'rejected', p_rejected, 'held', 0, 'failed', p_failed, 'status', new_st), p_note);
  IF b.uploaded_by <> actor AND p_decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
    VALUES (b.uploaded_by, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || p_approved || ' approved, ' || p_rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/templates/batches/' || p_batch::text, 'sites');
  END IF;
  RETURN new_st;
END $$;

-- The synchronous decision (as 0070).
CREATE OR REPLACE FUNCTION imp_decide_site_batch(p_batch uuid, p_version integer, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; res jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF p_action NOT IN ('approve', 'reject', 'discard') OR p_scope NOT IN ('all', 'rows') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope: a site has two levels, approve or reject.'))));
  END IF;
  IF p_action = 'discard' THEN
    IF b.uploaded_by <> actor AND NOT public.app_user_is_system_admin(actor) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can discard it.'));
    END IF;
    IF b.status <> 'validated' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a batch that has not been sent can be discarded. Return the rows with a note instead.'));
    END IF;
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = coalesce(nullif(btrim(p_note), ''), 'discarded') WHERE batch_id = p_batch;
    UPDATE public.import_batches SET status = 'discarded', note = nullif(btrim(p_note), ''), closed_at = now(), version = version + 1 WHERE id = p_batch;
    PERFORM public.log_audit_write('import_batch_discard', 'import_batch', p_batch::text, NULL, jsonb_build_object('status', 'discarded'), p_note);
    RETURN jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'held', '[]'::jsonb, 'failed', '[]'::jsonb);
  END IF;
  IF b.status NOT IN ('in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
  END IF;
  IF p_action = 'reject' AND coalesce(btrim(p_note), '') = '' AND p_scope = 'all' THEN PERFORM public.wf_err('note_required'); END IF;
  IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
  END IF;
  res := public.imp_decide_site_rows(p_batch, p_action, p_scope, p_rows, p_note, public.app_ctx_stepup());
  IF (res ->> 'decided')::int = 0 AND res ->> 'first_forbidden' IS NOT NULL THEN RAISE EXCEPTION '%', res ->> 'first_forbidden' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.imp_decide_site_finish(p_batch, p_action, p_scope, p_note, (res ->> 'decided')::int, (res ->> 'approved')::int, (res ->> 'rejected')::int,
    jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('decided', (res ->> 'decided')::int, 'approved', (res ->> 'approved')::int, 'rejected', (res ->> 'rejected')::int, 'held', '[]'::jsonb, 'failed', res -> 'failed');
END $$;

-- The dispatchers (as 0070), with the guard of a running background job.
CREATE OR REPLACE FUNCTION imp_submit_batch(p_batch uuid, p_version integer, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.imp_async_guard(p_batch);
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.entity = 'site') THEN
    RETURN public.imp_submit_site_batch(p_batch, p_version, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_submit_stream_batch(p_batch, p_version, p_stepup);
  END IF;
  RETURN public.imp_submit_register_batch(p_batch, p_version, p_stepup);
END $$;

CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version integer, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.imp_async_guard(p_batch);
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.entity = 'site') THEN
    RETURN public.imp_decide_site_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL AND b.mode = 'draft') THEN
    RETURN public.imp_decide_draft_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_decide_stream_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  RETURN public.imp_decide_register_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The background run: asked by the request, done in chunks, each chunk in its own transaction under the signed context of the same person
-- ---------------------------------------------------------------------------------------------------------------------
-- Asked by the request (POST submit or POST decisions). Every check of the request runs here, in the request transaction: the visibility and the If-Match
-- (imp_lock_batch), the uploader for a send, the state, the note, the rows, the authority of the person (L1, L2 of the Matrix row with the grid right),
-- and the step-up when an approval or a self-approval is final, read from the verified context (app_ctx_stepup), never from a parameter.
-- Returns {queued: false} when the request should run as before (not a New sites batch, a return, or not more rows than imports.async_rows).
-- Otherwise it records the run (status processing) and returns {queued: true, job}. Nothing is created or decided here.
CREATE OR REPLACE FUNCTION imp_async_start(p_batch uuid, p_version integer, p_kind text, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup_until timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; lim int; n int; items jsonb; su boolean := public.app_ctx_stepup(); jid uuid; noted boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind NOT IN ('submit', 'decide') THEN RAISE EXCEPTION 'imp_async_start: kind is submit or decide' USING ERRCODE = 'invalid_parameter_value'; END IF;
  PERFORM public.imp_async_guard(p_batch);
  IF NOT EXISTS (SELECT 1 FROM public.import_batches x WHERE x.id = p_batch AND x.entity = 'site') THEN RETURN jsonb_build_object('queued', false); END IF;
  IF p_kind = 'decide' AND p_action IS DISTINCT FROM 'approve' THEN RETURN jsonb_build_object('queued', false); END IF;
  b := public.imp_lock_batch(p_batch, p_version);
  BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;

  IF p_kind = 'submit' THEN
    IF b.uploaded_by <> actor THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
    END IF;
    IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
    END IF;
    SELECT count(*) INTO n FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL;
    IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
    -- B5: a sender who also holds L2 of a region of the rows approves at once, so the step-up is needed now (as the synchronous send, which refuses it all)
    IF NOT su AND EXISTS (SELECT 1 FROM (SELECT DISTINCT x.region_id FROM public.import_batch_rows x
                                         WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL AND x.region_id IS NOT NULL) g
                          WHERE public.site_new_holds(g.region_id, 'approve') AND public.site_new_may('approve', g.region_id)) THEN
      PERFORM public.wf_err('step_up_required');
    END IF;
  ELSE
    IF p_scope NOT IN ('all', 'rows') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope: a site has two levels, approve or reject.'))));
    END IF;
    IF b.status NOT IN ('in_approval', 'partially_approved') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
    END IF;
    IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
    END IF;
    -- the fixed list of the rows to decide, in the order of the synchronous call (row number); a decided row is skipped there as well
    SELECT coalesce(jsonb_agg(CASE WHEN p_scope = 'all' THEN jsonb_build_object('row_id', x.id, 'decision', 'approved') ELSE it.e END ORDER BY x.row_no), '[]'::jsonb), count(*)
      INTO items, n
    FROM public.v_import_rows x
    LEFT JOIN LATERAL (SELECT e FROM jsonb_array_elements(CASE WHEN p_scope = 'rows' THEN p_rows ELSE '[]'::jsonb END) e WHERE (e ->> 'row_id')::uuid = x.id LIMIT 1) it ON true
    WHERE x.batch_id = p_batch AND x.action = 'create' AND EXISTS (SELECT 1 FROM public.import_batch_rows q WHERE q.id = x.id AND q.site_draft_id IS NOT NULL)
      AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
      AND x.eff_decision NOT IN ('approved', 'rejected')
      AND ((p_scope = 'all' AND x.eff_decision = 'pending') OR (p_scope = 'rows' AND it.e IS NOT NULL));
    IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
    -- a return needs a note (as the synchronous call, which refuses the whole decision)
    SELECT bool_and(coalesce(nullif(btrim(e ->> 'note'), ''), nullif(btrim(p_note), '')) IS NOT NULL) INTO noted FROM jsonb_array_elements(items) e WHERE e ->> 'decision' = 'rejected';
    IF noted IS FALSE THEN PERFORM public.wf_err('note_required'); END IF;
    -- the authority: L2 of the Site creation row with the approve right, in a region of the rows (otherwise 403, as the synchronous call when nothing could be decided)
    IF NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT d.region_id FROM jsonb_array_elements(items) e JOIN public.import_batch_rows q ON q.id = (e ->> 'row_id')::uuid
                                  JOIN public.site_drafts d ON d.id = q.site_draft_id WHERE d.status = 'in_approval') g
                   WHERE public.site_new_may('approve', g.region_id) AND public.site_new_holds(g.region_id, 'approve')) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Review and Approve holder (L2) of the Site creation row in this region.'));
    END IF;
    IF NOT su AND EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE e ->> 'decision' IS DISTINCT FROM 'rejected') THEN PERFORM public.wf_err('step_up_required'); END IF;
  END IF;

  INSERT INTO public.import_batch_jobs (batch_id, kind, action, scope, items, note, actor_id, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, prev_status, rows_total)
  VALUES (p_batch, p_kind, CASE WHEN p_kind = 'decide' THEN 'approve' END, CASE WHEN p_kind = 'decide' THEN p_scope END, CASE WHEN p_kind = 'decide' THEN items END,
          CASE WHEN p_kind = 'decide' THEN left(p_note, 2000) END, actor, su, CASE WHEN su THEN p_stepup_until END,
          CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
          public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END,
          left(public.app_ctx_get('request_id'), 64), b.status, n)
  RETURNING id INTO jid;
  UPDATE public.import_batches SET version = version + 1 WHERE id = p_batch;   -- a stale If-Match is refused from now on
  PERFORM public.log_audit_write('import_batch_processing', 'import_batch', p_batch::text, jsonb_build_object('status', b.status),
    jsonb_build_object('status', 'processing', 'job_id', jid, 'kind', p_kind, 'action', CASE WHEN p_kind = 'decide' THEN 'approve' END, 'scope', CASE WHEN p_kind = 'decide' THEN p_scope END,
      'rows', n, 'stepup', su), CASE WHEN p_kind = 'decide' THEN p_note END);
  RETURN jsonb_build_object('queued', true, 'job', public.imp_batch_job_json(p_batch));
END $$;

-- One chunk of a background run, in the caller's transaction. The caller must be the person who asked for the run (app_actor() under a verified
-- context); the rights of the rows are checked again for every row by the same functions as the synchronous call. The step-up is the one verified when the
-- run was asked (stored by imp_async_start, which pmis_app cannot write). Returns the progress; state done when the last chunk finished the run.
-- A run that another process is working on answers {state: busy}.
CREATE OR REPLACE FUNCTION imp_async_step(p_job uuid, p_chunk integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); j public.import_batch_jobs%ROWTYPE; chunk int := greatest(1, least(coalesce(p_chunk, 25), 100)); res jsonb; slice jsonb; done boolean;
  n_proc int; f jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.import_batch_jobs WHERE id = p_job) THEN RETURN jsonb_build_object('job_id', p_job, 'state', 'busy'); END IF;
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The background run does not exist.'));
  END IF;
  IF j.actor_id <> actor THEN
    RAISE EXCEPTION 'only the person who asked for the run continues it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF j.state <> 'running' THEN RETURN public.imp_batch_job_json(j.batch_id); END IF;
  PERFORM 1 FROM public.import_batches WHERE id = j.batch_id FOR UPDATE;
  IF j.kind = 'submit' THEN
    res := public.imp_submit_site_rows(j.batch_id, chunk, j.stepup_verified, true);
    n_proc := (res ->> 'processed')::int;
    done := n_proc < chunk OR NOT EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.batch_id = j.batch_id AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL);
    f := res -> 'failed';
    UPDATE public.import_batch_jobs SET rows_done = least(rows_total, rows_done + n_proc), n_submitted = n_submitted + (res ->> 'submitted')::int,
      n_approved = (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = j.batch_id AND x.action = 'create' AND x.decision = 'approved'),
      n_failed = n_failed + jsonb_array_length(f), failed = CASE WHEN jsonb_array_length(failed) < 500 THEN failed || f ELSE failed END,
      chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  ELSE
    SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb) INTO slice FROM jsonb_array_elements(j.items) WITH ORDINALITY AS t(e, o) WHERE o > j.pos AND o <= j.pos + chunk;
    n_proc := jsonb_array_length(slice);
    IF n_proc > 0 THEN
      res := public.imp_decide_site_rows(j.batch_id, 'approve', 'rows', slice, j.note, j.stepup_verified);
    ELSE
      res := jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'failed', '[]'::jsonb);
    END IF;
    f := res -> 'failed';
    done := j.pos + n_proc >= jsonb_array_length(j.items);
    UPDATE public.import_batch_jobs SET pos = pos + n_proc, rows_done = least(rows_total, rows_done + n_proc), n_decided = n_decided + (res ->> 'decided')::int,
      n_approved = n_approved + (res ->> 'approved')::int, n_rejected = n_rejected + (res ->> 'rejected')::int,
      n_failed = n_failed + jsonb_array_length(f), failed = CASE WHEN jsonb_array_length(failed) < 500 THEN failed || f ELSE failed END,
      chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  END IF;
  IF done THEN PERFORM public.imp_async_close(p_job, 'done', NULL); END IF;
  RETURN public.imp_batch_job_json(j.batch_id);
END $$;

-- Ends a run: the finish of the send or the decision (status, the one audit row, the notices, as the synchronous call), and the run's own state.
CREATE OR REPLACE FUNCTION imp_async_close(p_job uuid, p_state text, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.import_batch_jobs%ROWTYPE; st text;
BEGIN
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.state <> 'running' THEN RETURN; END IF;
  UPDATE public.import_batch_jobs SET state = p_state, error = left(p_error, 500), finished_at = clock_timestamp(), heartbeat_at = clock_timestamp() WHERE id = p_job;
  IF public.app_actor() IS NOT NULL THEN
    IF j.kind = 'submit' THEN
      st := public.imp_submit_site_finish(j.batch_id, j.prev_status, j.n_submitted, j.n_failed);
    ELSE
      st := public.imp_decide_site_finish(j.batch_id, 'approve', j.scope, j.note, j.n_decided, j.n_approved, j.n_rejected, j.n_failed);
    END IF;
  ELSE
    -- the person can no longer act (deactivated or deleted): the rows done so far stay, the status follows them, the audit row names no actor
    st := CASE WHEN j.kind = 'submit' AND j.n_submitted = 0 AND j.prev_status = 'validated' THEN j.prev_status ELSE public.imp_status_of_after(j.batch_id) END;
    UPDATE public.import_batches SET status = st, version = version + 1,
      submitted_at = CASE WHEN j.kind = 'submit' AND j.n_submitted > 0 THEN coalesce(submitted_at, now()) ELSE submitted_at END,
      submitted_by = CASE WHEN j.kind = 'submit' AND j.n_submitted > 0 THEN coalesce(submitted_by, j.actor_id) ELSE submitted_by END,
      rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = j.batch_id AND action = 'error') WHERE id = j.batch_id;
  END IF;
  IF p_state <> 'done' THEN
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('import_batch_processing_stopped', 'import_batch', j.batch_id::text, jsonb_build_object('status', 'processing'),
            jsonb_build_object('status', st, 'job_id', j.id, 'kind', j.kind, 'rows_total', j.rows_total, 'rows_done', j.rows_done, 'failed', j.n_failed), left(p_error, 2000), public.app_actor());
  END IF;
END $$;

-- The runs left in processing (a restart of the API, a lost process), for the resume job. Only what is needed to sign the person's context again; any
-- context may read it (the step itself checks the person). A run is listed when nothing happened for p_idle seconds (0 = every running one).
CREATE OR REPLACE FUNCTION imp_async_pending(p_idle integer DEFAULT 0)
RETURNS TABLE (job_id uuid, batch_id uuid, actor_id uuid, actor_active boolean, stepup_until timestamptz, session_id uuid, auth_method text, mfa boolean, request_id text, heartbeat_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT j.id, j.batch_id, j.actor_id, EXISTS (SELECT 1 FROM public.users u WHERE u.id = j.actor_id AND u.status = 'active' AND u.deleted_at IS NULL),
         j.stepup_until, j.session_id, j.auth_method, j.mfa, j.request_id, j.heartbeat_at
  FROM public.import_batch_jobs j
  WHERE j.state = 'running' AND j.heartbeat_at <= clock_timestamp() - make_interval(secs => greatest(coalesce(p_idle, 0), 0))
  ORDER BY j.created_at
$$;

-- Stops a run: by the person who asked for it (for example after repeated failures of a chunk), or by anyone when that person can no longer act.
CREATE OR REPLACE FUNCTION imp_async_abandon(p_job uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.import_batch_jobs%ROWTYPE; actor uuid := public.app_actor();
BEGIN
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The background run does not exist.')); END IF;
  IF j.state <> 'running' THEN RETURN jsonb_build_object('job_id', j.id, 'state', j.state); END IF;
  IF NOT (coalesce(actor = j.actor_id, false) OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = j.actor_id AND u.status = 'active' AND u.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'only the person who asked for the run stops it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF actor IS NOT NULL AND actor <> j.actor_id THEN
    RAISE EXCEPTION 'only the person who asked for the run stops it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.import_batches WHERE id = j.batch_id FOR UPDATE;
  PERFORM public.imp_async_close(p_job, 'failed', coalesce(nullif(btrim(p_reason), ''), 'stopped'));
  RETURN jsonb_build_object('job_id', j.id, 'state', 'failed');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, UPDATE ON import_batches, import_batch_rows TO pmis_definer;
GRANT SELECT ON users, settings TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['wf_apply_applicability_run', 'wf_apply_applicability_core', 'site_create_apply', 'sla_task_close',
             'log_ctx_values', 'audit_log_fill', 'imp_status_of', 'imp_batch_job_json', 'imp_async_guard', 'imp_submit_site_rows', 'imp_submit_site_finish',
             'imp_submit_site_batch', 'imp_decide_site_rows', 'imp_decide_site_finish', 'imp_decide_site_batch', 'imp_submit_batch', 'imp_decide_batch',
             'imp_async_start', 'imp_async_step', 'imp_async_close', 'imp_async_pending', 'imp_async_abandon'])
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      IF f.proname IN ('imp_batch_job_json', 'imp_submit_batch', 'imp_decide_batch', 'imp_async_start', 'imp_async_step', 'imp_async_pending', 'imp_async_abandon', 'imp_status_of') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f.sig);
      END IF;
    END IF;
  END LOOP;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('bulk_site_async_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'imports.async_rows', 'default_rows', 50, 'status', 'processing', 'fast_applicability', true),
        'Technical decision of 2026-11-05 (CHANGELOG 106): a big New sites batch runs in the background in chunks; faster site creation (migration 0074).');
