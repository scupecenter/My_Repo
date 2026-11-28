-- 0.15.269: the milestone and phase-gate date rule (owner decision 2026-11-27). For a site whose
-- workflow is version 2 or newer:
--   * a milestone task's date is the date of its last linked task (the latest actual date of its
--     predecessor tasks); it is set automatically, never typed;
--   * a phase gate takes the milestone's date, nothing else: the gate conditions (permits, tasks,
--     date fields with offsets) and Change Control suspensions still decide open/blocked, but they
--     no longer move the date.
-- Sites on version 1 keep today's behaviour exactly (typed milestone dates; gates take the latest of
-- their conditions and shift past suspensions). No existing date is changed: the rule applies at the
-- next entry save / submit / gate evaluation of a v2+ site, so historical approved dates stand.

-- Sets the milestone task's actual date from its linked (predecessor) tasks, when every one is approved.
CREATE OR REPLACE FUNCTION public.wf_milestone_auto_date(p_task uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  UPDATE public.task_instances t
     SET actual_date = x.d, updated_at = now()
    FROM (
      SELECT t0.id,
             max(x.actual_date) AS d,
             count(*) FILTER (WHERE x.state = 'approved') AS approved_cnt,
             count(*) AS applicable_cnt
        FROM public.task_instances t0
        JOIN public.task_definitions td ON td.id = t0.task_def_id AND td.is_milestone_task
        JOIN public.sites s ON s.id = t0.site_id
        JOIN public.workflow_definitions w ON w.id = s.workflow_version_id AND w.version >= 2
        JOIN public.task_predecessors p ON p.task_def_id = td.id
        JOIN public.task_instances x ON x.task_def_id = p.predecessor_id AND x.site_id = t0.site_id
           AND x.state NOT IN ('na', 'skipped') AND NOT x.is_na
       WHERE t0.id = p_task
       GROUP BY t0.id
    ) x
   WHERE t.id = x.id
     AND x.applicable_cnt > 0
     AND x.approved_cnt = x.applicable_cnt
     AND x.d IS NOT NULL
     AND t.actual_date IS DISTINCT FROM x.d;
END $function$;

DO $$
DECLARE def text; anchor text;
BEGIN
  -- wf_save_entry: after the entry save, a v2+ milestone task's date is the computed one (a typed value is replaced).
  def := pg_get_functiondef('wf_save_entry(uuid,integer,jsonb)'::regprocedure);
  anchor := E'  PERFORM public.wf_audit(''task_entry_update'', p_task, before,';
  IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'wf_save_entry: anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
  IF position('wf_milestone_auto_date' in def) = 0 THEN
    def := replace(def, anchor, E'  PERFORM public.wf_milestone_auto_date(p_task);\n' || anchor);
    EXECUTE def;
  END IF;

  -- wf_complete_hw: at submit, compute the milestone date first so the mandatory check passes without a typed date.
  def := pg_get_functiondef('wf_complete_hw(uuid,integer,text,text,boolean,uuid)'::regprocedure);
  IF position('wf_milestone_auto_date' in def) = 0 THEN
    anchor := E'  IF p_action = ''submit'' THEN\n    IF t.actual_date IS NULL THEN missing_f := ARRAY[''actual_date'']; END IF;';
    IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'wf_complete_hw: anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
    def := replace(def, anchor,
      E'  IF p_action = ''submit'' THEN\n    PERFORM public.wf_milestone_auto_date(p_task);\n    SELECT ti.actual_date INTO t.actual_date FROM public.task_instances ti WHERE ti.id = p_task;\n    IF t.actual_date IS NULL THEN missing_f := ARRAY[''actual_date'']; END IF;');
    EXECUTE def;
  END IF;

  -- gate_eval: on a v2+ site the gate takes the milestone date; conditions and suspensions only block.
  def := pg_get_functiondef('gate_eval(uuid,text)'::regprocedure);
  anchor := E'DECLARE\n  s public.sites%ROWTYPE; g public.phase_gate_rules%ROWTYPE; m record; cond jsonb; g0 date; d date; nd date; i integer; rs jsonb; blocked boolean;';
  IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'gate_eval: DECLARE anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
  IF position('v2 boolean' in def) = 0 THEN
    def := replace(def, anchor, anchor || E'\n  v2 boolean;');
    anchor := E'  g0 := m.ms_date; base_date := g0; d := g0;';
    IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'gate_eval: seed anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
    def := replace(def, anchor, anchor || E'\n  SELECT wd.version >= 2 INTO v2 FROM public.workflow_definitions wd WHERE wd.id = s.workflow_version_id;');
    anchor := E'    EXIT WHEN nd = d;\n    d := nd;';
    IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'gate_eval: loop anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
    def := replace(def, anchor, E'    EXIT WHEN nd = d OR v2;\n    d := CASE WHEN v2 THEN g0 ELSE nd END;');
    anchor := E'    d := w.resumed_on; shifted := true;';
    IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'gate_eval: suspension anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
    def := replace(def, anchor, E'    IF v2 THEN EXIT; END IF;\n    d := w.resumed_on; shifted := true;');
    EXECUTE def;
  END IF;

  -- calc_manual_milestone_guard: the manual-milestone gate guard (calc.milestone_manual, default ["MS4"]) keeps
  -- governing v1 sites only. On a v2+ site every milestone, Site RFI (MS4) included, is automatic, so the typed-date
  -- guard would reject the value the rule itself is about to compute (owner decision 2026-11-27: Site RFI is
  -- automatic like every other milestone; its date is the date of its last linked task).
  def := pg_get_functiondef('calc_manual_milestone_guard()'::regprocedure);
  IF position('0548: on a v2+ site the milestone date is computed' in def) = 0 THEN
    anchor := E'  SELECT * INTO s FROM public.sites WHERE id = NEW.site_id;';
    IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'calc_manual_milestone_guard: anchor not found; review before applying 0548' USING ERRCODE = 'check_violation'; END IF;
    def := replace(def, anchor, anchor || E'\n  -- 0548: on a v2+ site the milestone date is computed, never typed; the manual-milestone guard does not apply (Site RFI is automatic there).\n  IF (SELECT wd.version >= 2 FROM public.workflow_definitions wd WHERE wd.id = s.workflow_version_id) THEN RETURN NEW; END IF;');
    EXECUTE def;
  END IF;

  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
  VALUES ('progress_standards_ms_autodate', 'workflow_definition', 'rule', 'Milestone auto-date and gate date rule (0.15.269, owner decision 2026-11-27)',
          jsonb_build_object('rule', 'v2+: milestone date = last linked task date (auto); gate date = milestone date; conditions/suspensions only block'), true,
          '00000000-0000-0000-0000-000000000000');
END $$;
