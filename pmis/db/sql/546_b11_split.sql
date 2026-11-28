-- 0.15.269: the B11 split (owner decision 2026-11-27). A draft workflow version 2 is created as a full
-- copy of version 1 (the same copy admin_create_workflow_draft makes, plus scenario_task_rules, which
-- that path does not copy) with the split applied:
--   B11 "Site adaption items" keeps feeding weight item 4.1; new B12 "Internal AC/DC" (4.3) and new
--   B16 "Site internal fiber" (4.5) sit after B9 like B11 in MS3, count toward MS3, and copy the B11
--   SLA (4/8 working days from CW MOS Actual, anchor B9). B9, B11, B12 and B16 apply to every site:
--   the B9/B11 adaption_only scenario rules are not copied. GECOL (C1/C2) and HLC (C3/C4) rules are unchanged.
--   The MS3 milestone task gains B12 and B16 as predecessors (MS3 needs B10, B11, B12 and B16).
-- The transition: the published v1 weight set keeps reading B11 only; the draft v2 weight set reads
-- 4.3 = [B11,B12] and 4.5 = [B11,B16], and because dash_build_items joins the tasks of the site's own
-- workflow version, a site on v1 resolves only B11 while a site on v2 resolves the new tasks too.
-- admin_migrate_sites_to_workflow carries the split over a migration: an approved B11 approves B12/B16
-- with the B11 dates (audit line per carried task); a B11 still open leaves B12/B16 open, not locked.
-- Sites stay on their version until a migration is approved; old versions are untouched. Idempotent:
-- skips when version 2 already exists.

DO $$
DECLARE
  src uuid; nid uuid := gen_random_uuid(); actor uuid := '00000000-0000-0000-0000-000000000000';
  b11 uuid; st_ms3 uuid; b9 uuid; b12 uuid := gen_random_uuid(); b16 uuid := gen_random_uuid(); ms3t uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.workflow_definitions WHERE version = 2) THEN
    RAISE NOTICE 'workflow version 2 already exists; the B11 split draft is not recreated';
    RETURN;
  END IF;
  SELECT id INTO src FROM public.workflow_definitions WHERE version = 1 AND status = 'published';
  IF src IS NULL THEN RAISE EXCEPTION 'workflow version 1 (published) not found; cannot create the B11 split draft' USING ERRCODE = 'check_violation'; END IF;

  INSERT INTO public.workflow_definitions (id, version, status, effective_from, reason, changed_by)
  VALUES (nid, 2, 'draft', current_date, 'B11 split: B12 Internal AC/DC, B16 Site internal fiber (0.15.269, owner decision 2026-11-27)', actor);

  CREATE TEMP TABLE _st_map ON COMMIT DROP AS SELECT id AS old, gen_random_uuid() AS new FROM public.stage_definitions WHERE workflow_id = src;
  CREATE TEMP TABLE _td_map ON COMMIT DROP AS SELECT id AS old, gen_random_uuid() AS new FROM public.task_definitions WHERE workflow_id = src;
  CREATE TEMP TABLE _mc_map ON COMMIT DROP AS
    SELECT c.id AS old, gen_random_uuid() AS new FROM public.matrix_cells c JOIN _st_map m ON m.old = c.stage_id;

  INSERT INTO public.stage_definitions (id, workflow_id, code, seq, name_en, name_ar, milestone_name, master_export_column, counts_in_project_status, approval_levels, is_active, custom)
    SELECT m.new, nid, s.code, s.seq, s.name_en, s.name_ar, s.milestone_name, s.master_export_column, s.counts_in_project_status, s.approval_levels, s.is_active, s.custom
    FROM public.stage_definitions s JOIN _st_map m ON m.old = s.id;
  INSERT INTO public.phase_gate_rules (workflow_id, link_code, seq, name_en, name_ar, from_code, to_code, conditions, min_wd, max_wd, master_export_column, is_active, custom)
    SELECT nid, g.link_code, g.seq, g.name_en, g.name_ar, g.from_code, g.to_code, g.conditions, g.min_wd, g.max_wd, g.master_export_column, g.is_active, g.custom
    FROM public.phase_gate_rules g WHERE g.workflow_id = src;
  INSERT INTO public.task_definitions (id, workflow_id, code, stage_id, sort_order, name_en, name_ar, has_documents, is_milestone_task, counts_toward_milestone, approval_levels, condition_rule, default_external_party, is_active, reason, changed_by)
    SELECT t.new, nid, d.code, sm.new, d.sort_order, d.name_en, d.name_ar, d.has_documents, d.is_milestone_task, d.counts_toward_milestone, d.approval_levels, d.condition_rule, d.default_external_party, d.is_active, d.reason, d.changed_by
    FROM public.task_definitions d JOIN _td_map t ON t.old = d.id JOIN _st_map sm ON sm.old = d.stage_id;
  INSERT INTO public.task_predecessors (task_def_id, predecessor_id)
    SELECT a.new, b.new FROM public.task_predecessors p JOIN _td_map a ON a.old = p.task_def_id JOIN _td_map b ON b.old = p.predecessor_id;
  INSERT INTO public.matrix_cells (id, stage_id, task_def_id, level, rule, region_id, is_global, updated_by)
    SELECT mc.new, sm.new, td.new, c.level, c.rule, c.region_id, c.is_global, actor
    FROM public.matrix_cells c JOIN _mc_map mc ON mc.old = c.id JOIN _st_map sm ON sm.old = c.stage_id LEFT JOIN _td_map td ON td.old = c.task_def_id;
  INSERT INTO public.matrix_cell_assignees (cell_id, kind, ref_id)
    SELECT mc.new, a.kind, a.ref_id FROM public.matrix_cell_assignees a JOIN _mc_map mc ON mc.old = a.cell_id;
  INSERT INTO public.document_type_placements (doc_type_id, kind, task_def_id, snag_type_id, register_key)
    SELECT p.doc_type_id, p.kind, td.new, p.snag_type_id, p.register_key
    FROM public.document_type_placements p JOIN _td_map td ON td.old = p.task_def_id;
  INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, effective_to, reason, changed_by, start_ref, end_ref, code, rule_set_id)
    SELECT td.new, r.min_working_days, r.max_working_days, r.start_event, r.scenario, r.region_id, r.calendar_id, r.effective_from, r.effective_to, r.reason, r.changed_by, r.start_ref, r.end_ref, r.code, r.rule_set_id
    FROM public.sla_rules r JOIN _td_map td ON td.old = r.task_def_id WHERE r.effective_to IS NULL OR r.effective_to > current_date;
  -- Applicability (scenario_task_rules) keyed by task code; the draft-copy path does not carry it. The
  -- B11 adaption_only rule is deliberately dropped: B11 applies to every site from v2 on.
  INSERT INTO public.scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason, version, created_by)
    SELECT nid, r.task_code, r.scenario, r.rule, r.flag_expr, 'B11 split: copied from version 1', 1, actor
    FROM public.scenario_task_rules r
    WHERE r.workflow_id = src AND r.is_active AND NOT (r.task_code IN ('B9', 'B11') AND r.rule = 'flag' AND r.flag_expr = 'adaption_only');

  -- The split: B12 and B16 after B9 like B11 (the MS3 milestone task moves to the end of the stage).
  SELECT sm.new INTO st_ms3 FROM _st_map sm JOIN public.stage_definitions s ON s.id = sm.old WHERE s.code = 'MS3';
  SELECT tm.new INTO b9 FROM _td_map tm JOIN public.task_definitions d ON d.id = tm.old WHERE d.code = 'B9';
  SELECT tm.new INTO b11 FROM _td_map tm JOIN public.task_definitions d ON d.id = tm.old WHERE d.code = 'B11';
  SELECT tm.new INTO ms3t FROM _td_map tm JOIN public.task_definitions d ON d.id = tm.old WHERE d.code = 'MS3';
  UPDATE public.task_definitions SET sort_order = 70 WHERE id = ms3t;
  INSERT INTO public.task_definitions (id, workflow_id, code, stage_id, sort_order, name_en, name_ar, has_documents, is_milestone_task, counts_toward_milestone, approval_levels, condition_rule, default_external_party, is_active, reason, changed_by)
    SELECT x.id, nid, x.code, st_ms3, x.sort_order, x.name_en, x.name_ar, d.has_documents, false, true, d.approval_levels, NULL, NULL, true,
           'B11 split (0.15.269, owner decision 2026-11-27)', actor
    FROM (VALUES (b12, 'B12', 50, 'Internal AC/DC', 'الكهرباء الداخلية AC/DC'),
                 (b16, 'B16', 60, 'Site internal fiber', 'الألياف البصرية الداخلية للموقع')) AS x(id, code, sort_order, name_en, name_ar)
    CROSS JOIN (SELECT has_documents, approval_levels FROM public.task_definitions WHERE id = b11) d;
  INSERT INTO public.task_predecessors (task_def_id, predecessor_id) VALUES (b12, b9), (b16, b9), (ms3t, b12), (ms3t, b16);
  -- The SLA of B11 (4/8 working days from CW MOS Actual, anchor B9) copied for B12 and B16.
  INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by, start_ref, end_ref, code)
    SELECT x.new_task, r.min_working_days, r.max_working_days, r.start_event, r.scenario, r.region_id, r.calendar_id, r.effective_from,
           'B11 split: copied from B11 (0.15.269)', actor, r.start_ref, r.end_ref, x.new_code
    FROM public.sla_rules r CROSS JOIN (VALUES (b12, 'B-12'), (b16, 'B-16')) AS x(new_task, new_code)
    WHERE r.task_def_id = b11 AND r.effective_to IS NULL;

  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
  VALUES ('workflow_draft_created', 'workflow_definition', nid::text, 'B11 split (0.15.269, owner decision 2026-11-27)',
          jsonb_build_object('from', src, 'version', 2, 'added', jsonb_build_array('B12', 'B16'), 'dropped_rule', 'B11 adaption_only'), true, actor);
END $$;

-- B9 and B11 apply to every site from v2 on: no adaption_only rule on either (also when the draft
-- already existed, e.g. created by hand before this migration).
DELETE FROM public.scenario_task_rules r
USING public.workflow_definitions w
WHERE r.workflow_id = w.id AND w.version = 2 AND r.task_code IN ('B9', 'B11') AND r.rule = 'flag' AND r.flag_expr = 'adaption_only';

-- The draft calibrated weight set v2 (0541) reads the split: 4.3 = [B11,B12], 4.5 = [B11,B16].
-- The published v1 set keeps reading B11 only (frozen; old-version sites resolve only B11 anyway).
UPDATE public.weight_items i
SET measure_rule = jsonb_set(i.measure_rule, '{tasks}', '["B11", "B12"]'::jsonb)
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND s.version = 2 AND s.status = 'draft'
  AND i.code = '4.3' AND i.measure_rule -> 'tasks' = '["B11"]'::jsonb;
UPDATE public.weight_items i
SET measure_rule = jsonb_set(i.measure_rule, '{tasks}', '["B11", "B16"]'::jsonb)
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND s.version = 2 AND s.status = 'draft'
  AND i.code = '4.5' AND i.measure_rule -> 'tasks' = '["B11"]'::jsonb;

-- The migration carry-over: an approved B11 approves B12/B16 with the B11 dates (audit line each);
-- a B11 still open leaves B12/B16 open. Applies only when the target version has B12/B16.
DO $$
DECLARE def text;
  anchor text := E'  -- 4. the site moves';
  carry text := E'  -- 0547 (0.15.269, B11 split): carry the split over a migration to a version that has B12/B16:\n'
    || E'  -- an approved B11 approves B12 and B16 with the B11 dates; a B11 still open leaves B12/B16 open.\n'
    || E'  IF EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_target AND td.code = ''B12'' AND td.is_active) THEN\n'
    || E'    WITH b11 AS (\n'
    || E'      SELECT ti.site_id, ti.state, ti.actual_date, ti.approved_date\n'
    || E'      FROM public.task_instances ti JOIN public.task_definitions od ON od.id = ti.task_def_id\n'
    || E'      WHERE ti.site_id = ANY (ids) AND od.workflow_id = p_target AND od.code = ''B11''\n'
    || E'    ), u AS (\n'
    || E'      UPDATE public.task_instances ti\n'
    || E'      SET state = ''approved'', current_level = ti.levels_required, actual_date = b.actual_date,\n'
    || E'          submitted_date = coalesce(ti.submitted_date, b.actual_date), approved_date = coalesce(b.approved_date, b.actual_date),\n'
    || E'          admin_override = true, updated_at = now()\n'
    || E'      FROM b11 b JOIN public.task_definitions td ON td.workflow_id = p_target AND td.code IN (''B12'', ''B16'') AND td.is_active\n'
    || E'      WHERE ti.task_def_id = td.id AND ti.site_id = b.site_id AND b.state = ''approved'' AND ti.state NOT IN (''approved'', ''na'', ''skipped'')\n'
    || E'      RETURNING ti.site_id, ti.id\n'
    || E'    )\n'
    || E'    INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)\n'
    || E'    SELECT ''workflow_migration_b11_split'', ''site'', site_id::text, p_reason,\n'
    || E'           jsonb_build_object(''task_instance'', id, ''note'', ''B11 approved: B12/B16 approved with the B11 date''), true, public.app_actor()\n'
    || E'    FROM u;\n'
    || E'    WITH b11 AS (\n'
    || E'      SELECT ti.site_id, ti.state FROM public.task_instances ti JOIN public.task_definitions od ON od.id = ti.task_def_id\n'
    || E'      WHERE ti.site_id = ANY (ids) AND od.workflow_id = p_target AND od.code = ''B11''\n'
    || E'    )\n'
    || E'    UPDATE public.task_instances ti SET state = ''open'', updated_at = now()\n'
    || E'    FROM b11 b JOIN public.task_definitions td ON td.workflow_id = p_target AND td.code IN (''B12'', ''B16'') AND td.is_active\n'
    || E'    WHERE ti.task_def_id = td.id AND ti.site_id = b.site_id AND ti.state = ''locked'' AND b.state NOT IN (''approved'', ''na'', ''skipped'');\n'
    || E'  END IF;\n';
BEGIN
  def := pg_get_functiondef('admin_migrate_sites_to_workflow(uuid[],uuid,text)'::regprocedure);
  IF position(anchor in def) = 0 THEN RAISE EXCEPTION 'admin_migrate_sites_to_workflow: anchor not found; review before applying 0547' USING ERRCODE = 'check_violation'; END IF;
  IF position('workflow_migration_b11_split' in def) > 0 THEN RETURN; END IF;
  def := replace(def, anchor, carry || anchor);
  EXECUTE def;
END $$;
