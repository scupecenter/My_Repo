-- 0094: workflow editor phase 2 (owner requests 2026-11-13): insert a task between existing tasks with cascade rewiring, edit successors, structural edit of a draft (milestones, gates, task moves) and revert of a site migration.
--
-- WHY. Phase 1 (0090) creates a task with its predecessors and replaces the predecessors of one task. The owner's example is a new work step inside Civil Works,
-- placed among the existing tasks: the tasks that follow it must wait for it, and the old direct link from its predecessor to them may go.
--
-- WHAT THIS ADDS (System Admin or a delegate of task_definitions.create / edit for ALL regions, reason 3+ characters, audited with before and after):
--   wfe_insert_plan                 internal: the rewiring of an insert and the cycle check (no grant to pmis_app)
--   admin_wf_task_insert_preview    read-only preview of the affected chain (rewired successors, removed links, cycle, open sites, B8 warning)
--   admin_wf_task_insert            one transaction: admin_wf_task_create (0090) + the new task becomes a predecessor of the chosen successors + the old direct links
--                                   are removed when asked + optionally admin_add_task_to_open_sites (0007/0069) and the release of the new task on those sites
--   admin_wf_task_successors        replace the successors of a task (the links where it is the predecessor); a cycle is refused as a field error on /successors
-- Decision B9: a new task inside an existing stage is not a structural change, the freeze does not block it. Decision B8: counting tasks need the Master impact
-- confirmation on a published version during the parallel run (inherited from admin_wf_task_create).

CREATE OR REPLACE FUNCTION wfe_insert_plan(p_wf uuid, p_preds text[], p_succs text[], p_remove boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c text; errs jsonb := '[]'::jsonb; rew jsonb := '[]'::jsonb; via text[]; s record; cur text[]; rem text[]; nrem integer := 0; preds text[]; succs text[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[]) INTO preds FROM unnest(coalesce(p_preds, ARRAY[]::text[])) x;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[]) INTO succs FROM unnest(coalesce(p_succs, ARRAY[]::text[])) x;
  FOREACH c IN ARRAY preds LOOP
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = p_wf AND code = c AND is_active) THEN
      errs := errs || jsonb_build_object('path', '/predecessors', 'code', 'unknown', 'message', 'The predecessor ' || c || ' is not an active task of this version.');
    END IF;
  END LOOP;
  FOREACH c IN ARRAY succs LOOP
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = p_wf AND code = c AND is_active) THEN
      errs := errs || jsonb_build_object('path', '/successors', 'code', 'unknown', 'message', 'The successor ' || c || ' is not an active task of this version.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) = 0 AND cardinality(preds) > 0 AND cardinality(succs) > 0 THEN
    WITH RECURSIVE anc(id) AS (
      SELECT id FROM public.task_definitions WHERE workflow_id = p_wf AND code = ANY (preds)
      UNION
      SELECT tp.predecessor_id FROM public.task_predecessors tp JOIN anc ON tp.task_def_id = anc.id)
    SELECT array_agg(td.code ORDER BY td.code) INTO via FROM anc JOIN public.task_definitions td ON td.id = anc.id WHERE td.code = ANY (succs);
    IF via IS NOT NULL THEN
      errs := errs || jsonb_build_object('path', '/successors', 'code', 'cycle',
        'message', 'A cycle: ' || array_to_string(via, ', ') || ' already comes before one of the chosen predecessors, so it cannot wait for the new task.');
    END IF;
  END IF;
  IF jsonb_array_length(errs) = 0 THEN
    FOR s IN SELECT td.id, td.code, td.name_en, td.name_ar, st.code AS stage_code FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
              WHERE td.workflow_id = p_wf AND td.code = ANY (succs) ORDER BY st.seq, td.sort_order, td.code LOOP
      SELECT coalesce(array_agg(p.code ORDER BY p.code), ARRAY[]::text[]) INTO cur FROM public.task_predecessors tp JOIN public.task_definitions p ON p.id = tp.predecessor_id WHERE tp.task_def_id = s.id;
      rem := CASE WHEN coalesce(p_remove, false) THEN ARRAY(SELECT x FROM unnest(cur) x WHERE x = ANY (preds) ORDER BY x) ELSE ARRAY[]::text[] END;
      nrem := nrem + cardinality(rem);
      rew := rew || jsonb_build_object('successor', s.code, 'name_en', s.name_en, 'name_ar', s.name_ar, 'stage_code', s.stage_code,
        'predecessors_before', to_jsonb(cur), 'removed_links', to_jsonb(rem), 'predecessors_after', to_jsonb(ARRAY(SELECT x FROM unnest(cur) x WHERE NOT (x = ANY (rem)) ORDER BY x)));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('valid', jsonb_array_length(errs) = 0, 'errors', errs, 'predecessors', to_jsonb(preds), 'successors', to_jsonb(succs),
    'rewiring', rew, 'removed_link_count', nrem);
END $$;

CREATE OR REPLACE FUNCTION admin_wf_task_insert_preview(p_version integer, p_stage text, p_preds text[], p_succs text[], p_remove boolean, p_counts boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; plan jsonb; n integer := 0; warns jsonb := '[]'::jsonb; errs jsonb; pr boolean := public.wfe_parallel_run_active();
BEGIN
  PERFORM public.wfe_require('task_definitions', 'create');
  SELECT * INTO w FROM public.workflow_definitions WHERE version = p_version;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The workflow version does not exist.')); END IF;
  plan := public.wfe_insert_plan(w.id, p_preds, p_succs, p_remove);
  errs := plan -> 'errors';
  IF NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_stage AND is_active) THEN
    errs := errs || jsonb_build_object('path', '/stage_code', 'code', 'unknown', 'message', 'This milestone does not exist or is inactive in the version.');
  END IF;
  IF w.status = 'published' THEN
    SELECT count(*) INTO n FROM public.sites s WHERE s.is_active AND s.overall_status IN ('not_started', 'in_progress', 'on_hold') AND s.workflow_version_id = w.id;
    IF coalesce(p_counts, true) THEN warns := warns || to_jsonb('counting_task_may_move_milestone'::text); END IF;
  END IF;
  RETURN plan || jsonb_build_object('valid', jsonb_array_length(errs) = 0, 'errors', errs, 'warnings', warns, 'version_status', w.status, 'open_sites', n,
    'master_confirmation_needed', pr AND w.status = 'published' AND coalesce(p_counts, true), 'confirmation_phrase', CASE WHEN pr THEN 'master-impact' END);
END $$;

CREATE OR REPLACE FUNCTION admin_wf_task_insert(p_version integer, p_etag integer, p_stage text, p_code text, p_name_en text, p_name_ar text, p_counts boolean,
  p_has_documents boolean, p_after text, p_preds text[], p_succs text[], p_remove boolean, p_open_sites boolean, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; plan jsonb; res jsonb; nid uuid; r jsonb; sid uuid; pid uuid; rc text; n integer := 0; i record; hold record; first_err jsonb;
BEGIN
  PERFORM public.wfe_require('task_definitions', 'create');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  plan := public.wfe_insert_plan(w.id, p_preds, p_succs, coalesce(p_remove, false));
  IF NOT (plan ->> 'valid')::boolean THEN
    first_err := plan -> 'errors' -> 0;
    PERFORM public.wfe_err1(first_err ->> 'path', first_err ->> 'code', first_err ->> 'message');
  END IF;
  res := public.admin_wf_task_create(p_version, p_etag, p_stage, p_code, p_name_en, p_name_ar, p_counts, p_has_documents, p_after, p_preds, p_reason, p_confirm);
  nid := (res ->> 'task_id')::uuid;
  FOR r IN SELECT * FROM jsonb_array_elements(plan -> 'rewiring') LOOP
    SELECT id INTO sid FROM public.task_definitions WHERE workflow_id = w.id AND code = r ->> 'successor';
    BEGIN
      FOR rc IN SELECT * FROM jsonb_array_elements_text(r -> 'removed_links') LOOP
        SELECT id INTO pid FROM public.task_definitions WHERE workflow_id = w.id AND code = rc;
        DELETE FROM public.task_predecessors WHERE task_def_id = sid AND predecessor_id = pid;
      END LOOP;
      INSERT INTO public.task_predecessors (task_def_id, predecessor_id) VALUES (sid, nid) ON CONFLICT DO NOTHING;
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM LIKE '%cycle%' THEN PERFORM public.wfe_err1('/successors', 'cycle', 'These successors would create a cycle.'); END IF;
      RAISE;
    END;
  END LOOP;
  IF coalesce(p_open_sites, false) AND w.status = 'published' THEN
    PERFORM public.wfe_require('task_definitions', 'edit');
    n := public.admin_add_task_to_open_sites(nid, NULL, p_reason);
    -- the new task starts locked on each site; release it where everything before it is done (and no gate holds it)
    FOR i IN SELECT ti.id FROM public.task_instances ti
              WHERE ti.task_def_id = nid AND ti.state = 'locked'
                AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = p2.predecessor_id
                                 WHERE p2.task_def_id = nid AND pi.state NOT IN ('approved', 'na', 'skipped')) ORDER BY ti.id LOOP
      SELECT * INTO hold FROM public.wf_gate_hold(i.id);
      IF hold.gate_code IS NULL THEN PERFORM public.wf_open_locked(i.id, 'task added to the open site'); END IF;
    END LOOP;
  END IF;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_insert', 'task_definition', p_code, NULL,
    jsonb_build_object('version', w.version, 'status', w.status, 'stage', p_stage, 'after_task', p_after, 'predecessors', plan -> 'predecessors', 'successors', plan -> 'successors',
                       'rewiring', plan -> 'rewiring', 'removed_direct_links', coalesce(p_remove, false), 'open_sites_added', n, 'counts_toward_milestone', coalesce(p_counts, true)), p_reason);
  RETURN jsonb_build_object('task_id', nid, 'task_code', p_code, 'warnings', res -> 'warnings', 'rewiring', plan -> 'rewiring', 'open_sites_added', n,
    'version', public.wfe_version_json(w.id));
END $$;

CREATE OR REPLACE FUNCTION admin_wf_task_successors(p_version integer, p_etag integer, p_task text, p_codes text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; sc text; sid uuid; sact boolean; before_ text[]; seen text[] := ARRAY[]::text[];
BEGIN
  PERFORM public.wfe_require('task_definitions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  SELECT coalesce(array_agg(x.code ORDER BY x.code), ARRAY[]::text[]) INTO before_
    FROM public.task_predecessors tp JOIN public.task_definitions x ON x.id = tp.task_def_id WHERE tp.predecessor_id = t.id;
  FOREACH sc IN ARRAY coalesce(p_codes, ARRAY[]::text[]) LOOP
    IF sc = p_task THEN PERFORM public.wfe_err1('/successors', 'self', 'A task cannot wait for itself.'); END IF;
    IF sc = ANY (seen) THEN PERFORM public.wfe_err1('/successors', 'duplicate', 'The successor ' || sc || ' is listed twice.'); END IF;
    seen := seen || sc;
    SELECT id, is_active INTO sid, sact FROM public.task_definitions WHERE workflow_id = w.id AND code = sc;
    IF sid IS NULL THEN PERFORM public.wfe_err1('/successors', 'unknown', 'The successor ' || sc || ' is not a task of this version.'); END IF;
    IF t.is_active AND NOT sact THEN PERFORM public.wfe_err1('/successors', 'inactive', 'The successor ' || sc || ' is inactive.'); END IF;
  END LOOP;
  IF (SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) FROM unnest(seen) x) = before_ THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The successors do not change.'));
  END IF;
  BEGIN
    DELETE FROM public.task_predecessors WHERE predecessor_id = t.id;
    FOREACH sc IN ARRAY seen LOOP
      INSERT INTO public.task_predecessors (task_def_id, predecessor_id) SELECT id, t.id FROM public.task_definitions WHERE workflow_id = w.id AND code = sc;
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE '%cycle%' THEN
      PERFORM public.wfe_err1('/successors', 'cycle', 'These successors would create a cycle: a task cannot, directly or through others, wait for a task that waits for it.');
    END IF;
    RAISE;
  END;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_successors', 'task_definition', p_task, jsonb_build_object('successors', to_jsonb(before_)),
    jsonb_build_object('version', w.version, 'status', w.status, 'successors', (SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) FROM unnest(seen) x)), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'wfe_insert_plan(uuid,text[],text[],boolean)', 'admin_wf_task_insert_preview(integer,text,text[],text[],boolean,boolean)',
    'admin_wf_task_insert(integer,integer,text,text,text,text,boolean,boolean,text,text[],text[],boolean,boolean,text,text)', 'admin_wf_task_successors(integer,integer,text,text[],text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'admin_wf_task_insert_preview(integer,text,text[],text[],boolean,boolean)',
      'admin_wf_task_insert(integer,integer,text,text,text,text,boolean,boolean,text,text[],text[],boolean,boolean,text,text)', 'admin_wf_task_successors(integer,integer,text,text[],text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- pmis_definer reads and moves the task instances of the open sites it adds the task to (wf_open_locked / wf_gate_hold are definer functions of their own)
GRANT SELECT ON task_instances TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- C. Structural edit of a draft (PUT /workflow/versions/{version}) and the revert of a site migration (owner decisions 2026-11-13)
-- ---------------------------------------------------------------------------------------------------------------------
-- Maximum flexibility: milestones and gates are added, renamed, reordered and deactivated (never deleted: history), tasks move between milestones, gate conditions and
-- SLA are edited, all in a draft that is published as a new version (reason, step-up and the typed confirmation of the publish stay). The list order is the order.
-- A milestone or gate that is not in the list is deactivated. B9 (the freeze of 0090) stays a setting that is off until an admin sets a window; with no setting nothing
-- is frozen, and the owner declared the pilot complete on 2026-11-13.
GRANT INSERT ON stage_definitions, phase_gate_rules TO pmis_definer;

CREATE OR REPLACE FUNCTION wfe_structure_snapshot(p_wf uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'milestones', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', code, 'is_active', is_active, 'name_en', name_en, 'name_ar', name_ar, 'counts_in_project_status', counts_in_project_status) ORDER BY seq, code), '[]'::jsonb)
                     FROM public.stage_definitions WHERE workflow_id = p_wf),
    'gates', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', link_code, 'is_active', is_active, 'from', from_code, 'to', to_code, 'name_en', name_en, 'name_ar', name_ar,
                                                           'conditions', conditions, 'sla_min_wd', min_wd, 'sla_max_wd', max_wd) ORDER BY seq, link_code), '[]'::jsonb)
                FROM public.phase_gate_rules WHERE workflow_id = p_wf),
    'task_stage', (SELECT coalesce(jsonb_object_agg(td.code, st.code), '{}'::jsonb) FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id WHERE td.workflow_id = p_wf))
$$;

CREATE OR REPLACE FUNCTION admin_wf_structure_replace(p_version integer, p_etag integer, p_structure jsonb, p_reason text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; ms jsonb; gs jsonb; mv jsonb; e jsonb; o integer; c text; ex public.stage_definitions%ROWTYPE; gx public.phase_gate_rules%ROWTYPE;
  mcodes text[] := ARRAY[]::text[]; gcodes text[] := ARRAY[]::text[]; act boolean; before_ jsonb; after_ jsonb; errs jsonb; nm_en text; nm_ar text; fm text; tm text; mn integer; mx integer; cond jsonb;
  tid uuid; sid uuid; act_by text;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Structural changes are made in a draft version: copy the published version to a draft first.')); END IF;
  IF jsonb_typeof(p_structure) <> 'object' OR jsonb_typeof(p_structure -> 'milestones') <> 'array' OR jsonb_typeof(p_structure -> 'gates') <> 'array' THEN
    PERFORM public.wfe_err1('/milestones', 'required', 'Send the complete list of milestones and of gates.');
  END IF;
  IF jsonb_array_length(p_structure -> 'milestones') > 60 OR jsonb_array_length(p_structure -> 'gates') > 80 THEN PERFORM public.wfe_err1('/milestones', 'too_many_rows', 'Too many milestones or gates.'); END IF;
  ms := p_structure -> 'milestones';
  gs := p_structure -> 'gates';
  before_ := public.wfe_structure_snapshot(w.id);
  UPDATE public.stage_definitions SET seq = seq + 100000 WHERE workflow_id = w.id;

  FOR e, o IN SELECT x, (n)::integer FROM jsonb_array_elements(ms) WITH ORDINALITY AS t(x, n) LOOP
    c := e ->> 'code';
    IF c IS NULL OR c !~ '^[A-Z][A-Z0-9_-]{0,19}$' THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/code', 'invalid', 'A code of 1 to 20 characters: capital letters, digits, - and _, starting with a letter.'); END IF;
    IF c = ANY (mcodes) THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/code', 'duplicate', 'The milestone ' || c || ' is listed twice.'); END IF;
    mcodes := mcodes || c;
    act := coalesce((e ->> 'is_active')::boolean, true);
    SELECT * INTO ex FROM public.stage_definitions WHERE workflow_id = w.id AND code = c;
    nm_en := CASE WHEN e ? 'name_en' THEN btrim(e ->> 'name_en') WHEN FOUND THEN ex.name_en END;
    nm_ar := CASE WHEN e ? 'name_ar' THEN nullif(btrim(coalesce(e ->> 'name_ar', '')), '') WHEN FOUND THEN ex.name_ar END;
    IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
    IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/milestones/' || (o - 1) || '/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
    IF ex.id IS NOT NULL THEN
      UPDATE public.stage_definitions SET seq = o, name_en = nm_en, milestone_name = nm_en, name_ar = nm_ar, is_active = act,
             counts_in_project_status = coalesce((e ->> 'counts_in_project_status')::boolean, ex.counts_in_project_status) WHERE id = ex.id;
    ELSE
      INSERT INTO public.stage_definitions (workflow_id, code, seq, name_en, name_ar, milestone_name, counts_in_project_status, approval_levels, is_active)
      VALUES (w.id, c, o, nm_en, nm_ar, nm_en, coalesce((e ->> 'counts_in_project_status')::boolean, true), 2, act);
    END IF;
  END LOOP;
  IF cardinality(mcodes) = 0 THEN PERFORM public.wfe_err1('/milestones', 'required', 'A version needs at least one milestone.'); END IF;
  SELECT string_agg(st.code, ', ' ORDER BY st.code) INTO c FROM public.stage_definitions st WHERE st.workflow_id = w.id AND NOT (st.code = ANY (mcodes));
  IF c IS NOT NULL THEN PERFORM public.wfe_err1('/milestones', 'missing', 'List every milestone of the version (missing: ' || c || '). To remove one, send it with is_active false.'); END IF;

  FOR mv IN SELECT x FROM jsonb_array_elements(coalesce(p_structure -> 'task_moves', '[]'::jsonb)) AS t(x) LOOP
    PERFORM public.wfe_require('task_definitions', 'edit');
    SELECT id INTO tid FROM public.task_definitions WHERE workflow_id = w.id AND code = mv ->> 'task_code';
    IF tid IS NULL THEN PERFORM public.wfe_err1('/task_moves', 'unknown', 'The task ' || coalesce(mv ->> 'task_code', '?') || ' is not a task of this version.'); END IF;
    SELECT id INTO sid FROM public.stage_definitions WHERE workflow_id = w.id AND code = mv ->> 'stage_code' AND is_active;
    IF sid IS NULL THEN PERFORM public.wfe_err1('/task_moves', 'unknown_stage', 'The milestone ' || coalesce(mv ->> 'stage_code', '?') || ' does not exist or is inactive.'); END IF;
    UPDATE public.task_definitions SET stage_id = sid, sort_order = coalesce((SELECT max(sort_order) FROM public.task_definitions WHERE stage_id = sid), 0) + 10,
           reason = btrim(p_reason), changed_by = public.app_actor()
     WHERE id = tid AND stage_id <> sid;
  END LOOP;
  SELECT string_agg(td.code, ', ' ORDER BY td.code) INTO c FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
   WHERE st.workflow_id = w.id AND NOT st.is_active AND td.is_active;
  IF c IS NOT NULL THEN PERFORM public.wfe_err1('/milestones', 'has_active_tasks', 'Active tasks (' || c || ') are in an inactive milestone: move them to another milestone first (task_moves) or deactivate them.'); END IF;

  FOR e, o IN SELECT x, (n)::integer FROM jsonb_array_elements(gs) WITH ORDINALITY AS t(x, n) LOOP
    c := e ->> 'code';
    IF c IS NULL OR c !~ '^[A-Z][A-Z0-9_-]{0,19}$' THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/code', 'invalid', 'A code of 1 to 20 characters: capital letters, digits, - and _, starting with a letter.'); END IF;
    IF c = ANY (gcodes) THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/code', 'duplicate', 'The gate ' || c || ' is listed twice.'); END IF;
    gcodes := gcodes || c;
    act := coalesce((e ->> 'is_active')::boolean, true);
    SELECT * INTO gx FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = c;
    nm_en := CASE WHEN e ? 'name_en' THEN btrim(e ->> 'name_en') WHEN FOUND THEN gx.name_en END;
    nm_ar := CASE WHEN e ? 'name_ar' THEN nullif(btrim(coalesce(e ->> 'name_ar', '')), '') WHEN FOUND THEN gx.name_ar END;
    fm := CASE WHEN e ? 'from_milestone' THEN e ->> 'from_milestone' WHEN FOUND THEN gx.from_code END;
    tm := CASE WHEN e ? 'to_milestone' THEN e ->> 'to_milestone' WHEN FOUND THEN gx.to_code END;
    mn := CASE WHEN e ? 'sla_min_wd' THEN (e ->> 'sla_min_wd')::integer WHEN FOUND THEN gx.min_wd ELSE 0 END;
    mx := CASE WHEN e ? 'sla_max_wd' THEN (e ->> 'sla_max_wd')::integer WHEN FOUND THEN gx.max_wd ELSE 0 END;
    cond := CASE WHEN e ? 'conditions' THEN e -> 'conditions' WHEN FOUND THEN coalesce(gx.conditions, '[]'::jsonb) ELSE '[]'::jsonb END;
    IF char_length(coalesce(nm_en, '')) NOT BETWEEN 1 AND 200 THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/name_en', 'required', 'The English name is required (up to 200 characters).'); END IF;
    IF nm_ar IS NOT NULL AND char_length(nm_ar) > 200 THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/name_ar', 'too_long', 'Up to 200 characters.'); END IF;
    IF fm IS NULL OR tm IS NULL OR fm = tm OR NOT (fm = ANY (mcodes)) OR NOT (tm = ANY (mcodes)) THEN
      PERFORM public.wfe_err1('/gates/' || (o - 1) || '/from_milestone', 'invalid', 'A gate sits between two different milestones of the version.');
    END IF;
    IF act AND (NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = fm AND is_active) OR NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = tm AND is_active)) THEN
      PERFORM public.wfe_err1('/gates/' || (o - 1) || '/from_milestone', 'inactive', 'An active gate needs two active milestones.');
    END IF;
    IF mn < 0 OR mx < mn THEN PERFORM public.wfe_err1('/gates/' || (o - 1) || '/sla_max_wd', 'invalid', 'The maximum working days cannot be below the minimum, and neither can be negative.'); END IF;
    errs := public.wfe_gate_conditions_ok(cond);
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
    IF gx.id IS NOT NULL THEN
      UPDATE public.phase_gate_rules SET seq = o, name_en = nm_en, name_ar = nm_ar, from_code = fm, to_code = tm, conditions = cond, min_wd = mn, max_wd = mx, is_active = act WHERE id = gx.id;
    ELSE
      INSERT INTO public.phase_gate_rules (workflow_id, link_code, seq, name_en, name_ar, from_code, to_code, conditions, min_wd, max_wd, is_active)
      VALUES (w.id, c, o, nm_en, nm_ar, fm, tm, cond, mn, mx, act);
    END IF;
  END LOOP;
  UPDATE public.phase_gate_rules SET is_active = false WHERE workflow_id = w.id AND NOT (link_code = ANY (gcodes)) AND is_active;

  after_ := public.wfe_structure_snapshot(w.id);
  IF after_ = before_ THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.')); END IF;
  PERFORM public.wfe_need_master_confirm(p_confirm);
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_structure_replace', 'workflow_definition', w.version::text, before_ || jsonb_build_object('version', w.version),
    after_ || jsonb_build_object('version', w.version, 'status', w.status), p_reason);
  RETURN public.wfe_version_json(w.id);
END $$;

-- A migration can be reverted while the site is still on the version it moved to, nothing moved it since, the migration retired no task (those became N/A and their
-- previous state is not kept) and no task was approved on the site after the move.
CREATE OR REPLACE FUNCTION wfe_migration_revertible(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.reverted_at IS NULL AND s.workflow_version_id = m.to_version_id
     AND NOT EXISTS (SELECT 1 FROM public.site_workflow_migrations m2 WHERE m2.site_id = m.site_id AND m2.migrated_at > m.migrated_at)
     AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(m.summary -> 'tasks_retired') = 'array' THEN m.summary -> 'tasks_retired' END), 0) = 0
     AND NOT EXISTS (SELECT 1 FROM public.task_instances ti WHERE ti.site_id = m.site_id AND ti.state = 'approved' AND ti.updated_at > m.migrated_at)
    FROM public.site_workflow_migrations m JOIN public.sites s ON s.id = m.site_id WHERE m.id = p_id
$$;

CREATE OR REPLACE FUNCTION admin_wf_revert_migration(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m public.site_workflow_migrations%ROWTYPE; rf int[]; fv integer; tv integer; sc text;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO m FROM public.site_workflow_migrations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The migration does not exist.')); END IF;
  rf := public.app_actor_region_filter('workflow_versions', 'administer');
  IF rf IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sites WHERE id = m.site_id AND region_id = ANY (rf)) THEN
    RAISE EXCEPTION 'this site is outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.wfe_migration_revertible(p_id) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This migration cannot be reverted: it was reverted already, the site moved again, the migration retired tasks, or a task was approved on the site since.'));
  END IF;
  PERFORM public.admin_migrate_sites_to_workflow(ARRAY[m.site_id], m.from_version_id, p_reason);
  UPDATE public.site_workflow_migrations SET reverted_at = now() WHERE id = p_id;
  SELECT version INTO fv FROM public.workflow_definitions WHERE id = m.from_version_id;
  SELECT version INTO tv FROM public.workflow_definitions WHERE id = m.to_version_id;
  SELECT site_code INTO sc FROM public.sites WHERE id = m.site_id;
  PERFORM public.wfe_audit('workflow_migration_revert', 'site', sc, jsonb_build_object('version', tv), jsonb_build_object('version', fv, 'migration_id', p_id), p_reason);
  RETURN jsonb_build_object('id', p_id, 'site_id', m.site_id, 'site_code', sc, 'reverted_to_version', fv);
END $$;

CREATE OR REPLACE FUNCTION wf_site_migrations_json(p_site uuid, p_to_version integer, p_limit integer, p_offset integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE rf int[]; tot integer; items jsonb;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  rf := public.app_actor_region_filter('workflow_versions', 'administer');
  SELECT count(*) INTO tot FROM public.site_workflow_migrations m JOIN public.sites s ON s.id = m.site_id JOIN public.workflow_definitions tv ON tv.id = m.to_version_id
   WHERE (p_site IS NULL OR m.site_id = p_site) AND (p_to_version IS NULL OR tv.version = p_to_version) AND (rf IS NULL OR s.region_id = ANY (rf));
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'migrated_at') DESC, x ->> 'id'), '[]'::jsonb) INTO items FROM (
    SELECT jsonb_build_object('id', m.id, 'site_id', m.site_id, 'site_code', s.site_code, 'from_version', fv.version, 'to_version', tv.version, 'reason', m.reason,
             'migrated_by', public.wfe_user_ref(m.migrated_by), 'migrated_at', m.migrated_at, 'date_changes', '[]'::jsonb, 'reverted_at', m.reverted_at,
             'revertible', public.wfe_migration_revertible(m.id)) AS x
      FROM public.site_workflow_migrations m JOIN public.sites s ON s.id = m.site_id
      JOIN public.workflow_definitions fv ON fv.id = m.from_version_id JOIN public.workflow_definitions tv ON tv.id = m.to_version_id
     WHERE (p_site IS NULL OR m.site_id = p_site) AND (p_to_version IS NULL OR tv.version = p_to_version) AND (rf IS NULL OR s.region_id = ANY (rf))
     ORDER BY m.migrated_at DESC, m.id LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0))) q;
  RETURN jsonb_build_object('items', items, 'total', tot);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['wfe_structure_snapshot(uuid)', 'admin_wf_structure_replace(integer,integer,jsonb,text,text)', 'wfe_migration_revertible(uuid)', 'admin_wf_revert_migration(uuid,text)',
                           'wf_site_migrations_json(uuid,integer,integer,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['admin_wf_structure_replace(integer,integer,jsonb,text,text)', 'admin_wf_revert_migration(uuid,text)', 'wf_site_migrations_json(uuid,integer,integer,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- Owner rule 2026-11-13 (flexibility with data safety): an item that site data never referenced is deleted for real (draft only); an item that is referenced (site tasks,
-- matrix cells, SLA rules, baselines, gate history, or the same code in another version) is deactivated instead and the answer says why.
GRANT DELETE ON workflow_definitions, stage_definitions, task_definitions, phase_gate_rules, matrix_cells, sla_rules, sla_rule_set_items, document_type_placements, scenario_task_rules TO pmis_definer;
GRANT SELECT ON matrix_cells, sla_rules, sla_rule_set_items, document_type_placements, site_gate_state, site_gate_events TO pmis_definer;

CREATE OR REPLACE FUNCTION wfe_item_refs(p_kind text, p_wf uuid, p_code text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r text[] := ARRAY[]::text[]; tid uuid; sid uuid;
BEGIN
  IF p_kind = 'task' THEN
    SELECT id INTO tid FROM public.task_definitions WHERE workflow_id = p_wf AND code = p_code;
    IF EXISTS (SELECT 1 FROM public.task_instances WHERE task_def_id = tid) THEN r := r || 'site_tasks'; END IF;
    IF EXISTS (SELECT 1 FROM public.matrix_cells WHERE task_def_id = tid) THEN r := r || 'matrix'; END IF;
    IF EXISTS (SELECT 1 FROM public.sla_rules WHERE task_def_id = tid) OR EXISTS (SELECT 1 FROM public.sla_rule_set_items WHERE task_def_id = tid) THEN r := r || 'sla_rules'; END IF;
    IF EXISTS (SELECT 1 FROM public.document_type_placements WHERE task_def_id = tid) THEN r := r || 'document_types'; END IF;
    IF EXISTS (SELECT 1 FROM public.task_definitions WHERE code = p_code AND workflow_id <> p_wf) THEN r := r || 'other_version'; END IF;
  ELSIF p_kind = 'milestone' THEN
    SELECT id INTO sid FROM public.stage_definitions WHERE workflow_id = p_wf AND code = p_code;
    IF EXISTS (SELECT 1 FROM public.task_definitions WHERE stage_id = sid) THEN r := r || 'has_tasks'; END IF;
    IF EXISTS (SELECT 1 FROM public.matrix_cells WHERE stage_id = sid) THEN r := r || 'matrix'; END IF;
    IF EXISTS (SELECT 1 FROM public.baseline_entries WHERE milestone_code = p_code) THEN r := r || 'baselines'; END IF;
    IF EXISTS (SELECT 1 FROM public.phase_gate_rules WHERE workflow_id = p_wf AND (from_code = p_code OR to_code = p_code)) THEN r := r || 'gates'; END IF;
    IF EXISTS (SELECT 1 FROM public.stage_definitions WHERE code = p_code AND workflow_id <> p_wf) THEN r := r || 'other_version'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.site_gate_state WHERE gate_code = p_code) OR EXISTS (SELECT 1 FROM public.site_gate_events WHERE gate_code = p_code) THEN r := r || 'gate_history'; END IF;
    IF EXISTS (SELECT 1 FROM public.phase_gate_rules WHERE link_code = p_code AND workflow_id <> p_wf) THEN r := r || 'other_version'; END IF;
  END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION admin_wf_item_remove(p_version integer, p_etag integer, p_kind text, p_code text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; refs text[]; hard boolean; tid uuid; sid uuid; act text;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_kind NOT IN ('task', 'milestone', 'gate') THEN PERFORM public.wfe_err1('/kind', 'invalid', 'kind is task, milestone or gate.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF (p_kind = 'task' AND NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = w.id AND code = p_code))
     OR (p_kind = 'milestone' AND NOT EXISTS (SELECT 1 FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_code))
     OR (p_kind = 'gate' AND NOT EXISTS (SELECT 1 FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = p_code)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist in this version.'));
  END IF;
  refs := public.wfe_item_refs(p_kind, w.id, p_code);
  IF w.status <> 'draft' THEN refs := refs || 'published_version'; END IF;
  hard := cardinality(refs) = 0;
  IF p_kind = 'task' THEN
    SELECT id INTO tid FROM public.task_definitions WHERE workflow_id = w.id AND code = p_code;
    IF hard THEN
      DELETE FROM public.task_predecessors WHERE task_def_id = tid OR predecessor_id = tid;
      DELETE FROM public.task_definitions WHERE id = tid;
    ELSE
      UPDATE public.task_definitions SET is_active = false, reason = btrim(p_reason), changed_by = public.app_actor() WHERE id = tid;
    END IF;
  ELSIF p_kind = 'milestone' THEN
    SELECT id INTO sid FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_code;
    IF hard THEN
      DELETE FROM public.stage_definitions WHERE id = sid;
    ELSE
      IF EXISTS (SELECT 1 FROM public.task_definitions WHERE stage_id = sid AND is_active) THEN
        PERFORM public.wfe_err1('/code', 'has_active_tasks', 'Move or deactivate the active tasks of this milestone first.');
      END IF;
      UPDATE public.stage_definitions SET is_active = false WHERE id = sid;
      UPDATE public.phase_gate_rules SET is_active = false WHERE workflow_id = w.id AND (from_code = p_code OR to_code = p_code);
    END IF;
  ELSE
    IF hard THEN DELETE FROM public.phase_gate_rules WHERE workflow_id = w.id AND link_code = p_code;
    ELSE UPDATE public.phase_gate_rules SET is_active = false WHERE workflow_id = w.id AND link_code = p_code; END IF;
  END IF;
  act := CASE WHEN hard THEN 'deleted' ELSE 'deactivated' END;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('wf_item_' || act, 'workflow_' || p_kind, p_code, jsonb_build_object('version', w.version), jsonb_build_object('version', w.version, 'outcome', act, 'why', to_jsonb(refs)), p_reason);
  RETURN jsonb_build_object('outcome', act, 'why', to_jsonb(refs), 'version', public.wfe_version_json(w.id));
END $$;

CREATE OR REPLACE FUNCTION admin_wf_discard_draft(p_version integer, p_etag integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; refs integer;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a draft can be discarded; a published version is kept for history.')); END IF;
  SELECT count(*) INTO refs FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id WHERE td.workflow_id = w.id;
  IF refs > 0 THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Site tasks already use this draft.')); END IF;
  DELETE FROM public.task_predecessors WHERE task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)
                                           OR predecessor_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id);
  DELETE FROM public.matrix_cells WHERE stage_id IN (SELECT id FROM public.stage_definitions WHERE workflow_id = w.id)
                                     OR task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id);
  DELETE FROM public.sla_rules WHERE task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id);
  DELETE FROM public.sla_rule_set_items WHERE task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id);
  DELETE FROM public.document_type_placements WHERE task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id);
  DELETE FROM public.scenario_task_rules WHERE workflow_id = w.id;
  DELETE FROM public.task_definitions WHERE workflow_id = w.id;
  DELETE FROM public.phase_gate_rules WHERE workflow_id = w.id;
  DELETE FROM public.stage_definitions WHERE workflow_id = w.id;
  DELETE FROM public.workflow_definitions WHERE id = w.id;
  PERFORM public.wfe_audit('workflow_draft_discard', 'workflow_definition', w.version::text, jsonb_build_object('version', w.version, 'status', 'draft'), jsonb_build_object('discarded', true), p_reason);
  RETURN jsonb_build_object('version', w.version, 'discarded', true);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['wfe_item_refs(text,uuid,text)', 'admin_wf_item_remove(integer,integer,text,text,text)', 'admin_wf_discard_draft(integer,integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_wf_item_remove(integer,integer,text,text,text), admin_wf_discard_draft(integer,integer,text) TO pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('workflow_editor_insert_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner request 2026-11-13: workflow editor phase 2', 'functions', 'admin_wf_task_insert, admin_wf_task_successors'),
        'Migration 0094: a task is inserted between existing tasks with cascade rewiring; successors are edited.');
