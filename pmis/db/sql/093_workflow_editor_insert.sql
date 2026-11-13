-- 0094: workflow editor phase 2 (owner request 2026-11-13): insert a task between existing tasks of a stage with cascade rewiring, and edit the successors of a task.
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

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('workflow_editor_insert_applied', 'workflow', NULL,
        jsonb_build_object('decision', 'owner request 2026-11-13: workflow editor phase 2', 'functions', 'admin_wf_task_insert, admin_wf_task_successors'),
        'Migration 0094: a task is inserted between existing tasks with cascade rewiring; successors are edited.');
