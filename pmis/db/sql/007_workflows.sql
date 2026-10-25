-- 007: workflow versions (milestones, gates, tasks), role integrity, site migration between versions.
-- Rules: a published version cannot be changed structurally (add/remove/reorder a milestone or gate, move a task between
-- stages); codes are immutable; a milestone or gate referenced by data cannot be deleted. Light edits on a published version
-- (display names, gate conditions and SLA, counts-in-Project-Status, approval levels, export column, custom fields, task
-- details and deactivation) are allowed; the API audits them. Structural change = clone to a draft, edit, publish.
-- The migration/seed role (pmis_migrator) bypasses the structural triggers; every other role, including pmis_app, does not.

ALTER TABLE stage_definitions ADD CONSTRAINT stage_definitions_seq_key UNIQUE (workflow_id, seq) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE phase_gate_rules  ADD CONSTRAINT phase_gate_rules_seq_key  UNIQUE (workflow_id, seq) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE phase_gate_rules  ADD CONSTRAINT phase_gate_rules_min_max  CHECK (min_wd >= 0 AND max_wd >= min_wd);

CREATE OR REPLACE FUNCTION wf_is_published(p_wf uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workflow_definitions WHERE id = p_wf AND status = 'published')
$$;

-- The version in force on a date: the latest published one that has started.
CREATE OR REPLACE FUNCTION active_workflow_id(p_on date DEFAULT current_date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM workflow_definitions WHERE status = 'published' AND effective_from <= p_on ORDER BY effective_from DESC, version DESC LIMIT 1
$$;

-- Publishing check: at least one active stage; gates point at stage codes of the same version; every task has its stage.
CREATE OR REPLACE FUNCTION wf_validate(p_wf uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stage_definitions WHERE workflow_id = p_wf AND is_active) THEN
    RAISE EXCEPTION 'a workflow version needs at least one active milestone' USING ERRCODE = 'check_violation';
  END IF;
  SELECT g.link_code INTO bad FROM phase_gate_rules g
   WHERE g.workflow_id = p_wf AND g.is_active
     AND (NOT EXISTS (SELECT 1 FROM stage_definitions s WHERE s.workflow_id = p_wf AND s.code = g.from_code)
       OR NOT EXISTS (SELECT 1 FROM stage_definitions s WHERE s.workflow_id = p_wf AND s.code = g.to_code)) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'gate % points at a milestone code that does not exist in this version', bad USING ERRCODE = 'check_violation'; END IF;
END $$;

CREATE OR REPLACE FUNCTION workflow_definitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NOT app_is_seeding() THEN RAISE EXCEPTION 'a workflow version starts as a draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN RAISE EXCEPTION 'a published workflow version cannot be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status <> 'published' OR (NEW.version, NEW.effective_from, NEW.published_at) IS DISTINCT FROM (OLD.version, OLD.effective_from, OLD.published_at) THEN
      RAISE EXCEPTION 'a published workflow version is immutable (clone it to a draft)' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'published' THEN
    IF NOT app_is_seeding() AND (coalesce(btrim(NEW.reason), '') = '' OR NEW.changed_by IS NULL) THEN
      RAISE EXCEPTION 'publishing needs a reason and changed_by' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM wf_validate(NEW.id);
    NEW.published_at := coalesce(NEW.published_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_definitions_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_definitions FOR EACH ROW EXECUTE FUNCTION workflow_definitions_guard();

-- "Referenced by data" checks must see every region: definer functions (owner pmis_definer).
CREATE OR REPLACE FUNCTION stage_in_use(p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id WHERE td.stage_id = p_stage)
      OR EXISTS (SELECT 1 FROM public.stage_definitions st
                 JOIN public.sites s ON s.workflow_version_id = st.workflow_id
                 JOIN public.baseline_entries be ON be.site_id = s.id AND be.milestone_code = st.code WHERE st.id = p_stage)
$$;
CREATE OR REPLACE FUNCTION workflow_has_sites(p_wf uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sites WHERE workflow_version_id = p_wf)
$$;

-- Milestones. Structural: insert, delete, seq, is_active, code, workflow. Light: names, approval_levels, counts_in_project_status,
-- master_export_column, custom.
CREATE OR REPLACE FUNCTION stage_definitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    IF wf_is_published(NEW.workflow_id) THEN RAISE EXCEPTION 'a published version cannot get a new milestone (use a draft)' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION 'a published version cannot lose a milestone (deactivate it in a new version)' USING ERRCODE = 'check_violation'; END IF;
    IF stage_in_use(OLD.id) THEN RAISE EXCEPTION 'milestone % is referenced by data: deactivate it in a new version instead', OLD.code USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.code, NEW.workflow_id) IS DISTINCT FROM (OLD.code, OLD.workflow_id) THEN
    RAISE EXCEPTION 'milestone codes and versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF wf_is_published(OLD.workflow_id) AND (NEW.seq, NEW.is_active) IS DISTINCT FROM (OLD.seq, OLD.is_active) THEN
    RAISE EXCEPTION 'order and active flag of a milestone are structural: change them in a draft version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_definitions_guard BEFORE INSERT OR UPDATE OR DELETE ON stage_definitions FOR EACH ROW EXECUTE FUNCTION stage_definitions_guard();

-- Gates. Structural: insert, delete, seq, from/to, is_active, code. Light: names, conditions, min/max (gate SLA), export column, custom.
CREATE OR REPLACE FUNCTION phase_gate_rules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    IF wf_is_published(NEW.workflow_id) THEN RAISE EXCEPTION 'a published version cannot get a new gate (use a draft)' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION 'a published version cannot lose a gate (deactivate it in a new version)' USING ERRCODE = 'check_violation'; END IF;
    IF workflow_has_sites(OLD.workflow_id) THEN RAISE EXCEPTION 'gate % is referenced by data', OLD.link_code USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.link_code, NEW.workflow_id) IS DISTINCT FROM (OLD.link_code, OLD.workflow_id) THEN
    RAISE EXCEPTION 'gate codes and versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF wf_is_published(OLD.workflow_id) AND (NEW.seq, NEW.from_code, NEW.to_code, NEW.is_active) IS DISTINCT FROM (OLD.seq, OLD.from_code, OLD.to_code, OLD.is_active) THEN
    RAISE EXCEPTION 'order, endpoints and active flag of a gate are structural: change them in a draft version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_gate_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON phase_gate_rules FOR EACH ROW EXECUTE FUNCTION phase_gate_rules_guard();

-- Tasks: may be added to a published version; code, workflow and milestone flag never change; a task moves between stages only
-- in a draft; deletion only in a draft (published: deactivate); milestone tasks are not deactivated on a published version.
CREATE OR REPLACE FUNCTION task_definitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION 'tasks of a published version are deactivated, not deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.code, NEW.workflow_id, NEW.is_milestone_task) IS DISTINCT FROM (OLD.code, OLD.workflow_id, OLD.is_milestone_task) THEN
    RAISE EXCEPTION 'task code, version and milestone flag are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF wf_is_published(OLD.workflow_id) THEN
    IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
      RAISE EXCEPTION 'moving a task between stages is structural: change it in a draft version' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.is_milestone_task AND NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'a milestone task cannot be deactivated on a published version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_definitions_guard BEFORE INSERT OR UPDATE OR DELETE ON task_definitions FOR EACH ROW EXECUTE FUNCTION task_definitions_guard();

-- Predecessors stay inside one version.
CREATE OR REPLACE FUNCTION task_predecessors_same_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT workflow_id FROM task_definitions WHERE id = NEW.task_def_id) IS DISTINCT FROM (SELECT workflow_id FROM task_definitions WHERE id = NEW.predecessor_id) THEN
    RAISE EXCEPTION 'a predecessor must belong to the same workflow version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_predecessors_same_version BEFORE INSERT OR UPDATE ON task_predecessors FOR EACH ROW EXECUTE FUNCTION task_predecessors_same_version();

-- A site runs on a published version, and changes version only through the migration function (or the migration role).
CREATE OR REPLACE FUNCTION sites_workflow_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workflow_version_id IS NOT DISTINCT FROM OLD.workflow_version_id THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NOT app_in_admin_path() THEN
    RAISE EXCEPTION 'sites change workflow version only through admin_migrate_sites_to_workflow()' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT wf_is_published(NEW.workflow_version_id) THEN
    RAISE EXCEPTION 'a site can only run on a published workflow version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sites_workflow_guard BEFORE INSERT OR UPDATE OF workflow_version_id ON sites FOR EACH ROW EXECUTE FUNCTION sites_workflow_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- Roles: sub-role = role with a parent (two levels), never deleted while assigned or referenced.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION role_in_use(p_role uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_role_assignments WHERE role_id = p_role)
      OR EXISTS (SELECT 1 FROM public.matrix_cell_assignees WHERE kind = 'role' AND ref_id = p_role)
      OR EXISTS (SELECT 1 FROM public.delegations WHERE target_role_id = p_role)
      OR EXISTS (SELECT 1 FROM public.roles WHERE parent_role_id = p_role)
$$;

CREATE OR REPLACE FUNCTION roles_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF role_in_use(OLD.id) THEN
      RAISE EXCEPTION 'role % is assigned or referenced: deactivate it instead of deleting', OLD.code USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'role codes are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_role_id IS NOT NULL THEN
    IF NEW.parent_role_id = NEW.id THEN RAISE EXCEPTION 'a role cannot be its own parent' USING ERRCODE = 'check_violation'; END IF;
    IF EXISTS (SELECT 1 FROM roles WHERE id = NEW.parent_role_id AND parent_role_id IS NOT NULL) THEN
      RAISE EXCEPTION 'sub-roles have a main role as parent (two levels only)' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM roles WHERE parent_role_id = NEW.id) THEN
      RAISE EXCEPTION 'a role that has sub-roles cannot become a sub-role' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_guard BEFORE INSERT OR UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION roles_guard();

CREATE OR REPLACE FUNCTION matrix_assignee_can_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'role' AND EXISTS (SELECT 1 FROM roles WHERE id = NEW.ref_id AND NOT can_hold_matrix_levels) THEN
    RAISE EXCEPTION 'this role may not hold matrix levels' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matrix_assignee_can_hold BEFORE INSERT OR UPDATE ON matrix_cell_assignees FOR EACH ROW EXECUTE FUNCTION matrix_assignee_can_hold();

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin functions (SECURITY DEFINER, owner pmis_definer). The actor (app.user_id) must be a System Admin or hold a delegation
-- covering workflow_versions.<action>; never judged from the region session.
-- ---------------------------------------------------------------------------------------------------------------------
-- Clone a version (stages, gates, tasks, predecessors, matrix cells and assignees, document placements, current SLA rules) to a draft.
CREATE OR REPLACE FUNCTION admin_create_workflow_draft(p_from uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nid uuid := gen_random_uuid(); nv integer; actor uuid := public.app_actor();
BEGIN
  IF NOT public.app_actor_is_admin('workflow_versions', 'create') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering workflow_versions.create required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  IF public.app_actor_region_filter('workflow_versions', 'create') IS NOT NULL THEN
    RAISE EXCEPTION 'a new workflow version is global: it needs an all-regions delegation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_definitions WHERE id = p_from) THEN RAISE EXCEPTION 'source version not found'; END IF;
  SELECT coalesce(max(version), 0) + 1 INTO nv FROM public.workflow_definitions;
  INSERT INTO public.workflow_definitions (id, version, status, effective_from, reason, changed_by) VALUES (nid, nv, 'draft', current_date, p_reason, actor);

  CREATE TEMP TABLE _st_map ON COMMIT DROP AS SELECT id AS old, gen_random_uuid() AS new FROM public.stage_definitions WHERE workflow_id = p_from;
  CREATE TEMP TABLE _td_map ON COMMIT DROP AS SELECT id AS old, gen_random_uuid() AS new FROM public.task_definitions WHERE workflow_id = p_from;
  CREATE TEMP TABLE _mc_map ON COMMIT DROP AS
    SELECT c.id AS old, gen_random_uuid() AS new FROM public.matrix_cells c JOIN _st_map m ON m.old = c.stage_id;

  INSERT INTO public.stage_definitions (id, workflow_id, code, seq, name_en, name_ar, milestone_name, master_export_column, counts_in_project_status, approval_levels, is_active, custom)
    SELECT m.new, nid, s.code, s.seq, s.name_en, s.name_ar, s.milestone_name, s.master_export_column, s.counts_in_project_status, s.approval_levels, s.is_active, s.custom
    FROM public.stage_definitions s JOIN _st_map m ON m.old = s.id;
  INSERT INTO public.phase_gate_rules (workflow_id, link_code, seq, name_en, name_ar, from_code, to_code, conditions, min_wd, max_wd, master_export_column, is_active, custom)
    SELECT nid, g.link_code, g.seq, g.name_en, g.name_ar, g.from_code, g.to_code, g.conditions, g.min_wd, g.max_wd, g.master_export_column, g.is_active, g.custom
    FROM public.phase_gate_rules g WHERE g.workflow_id = p_from;
  INSERT INTO public.task_definitions (id, workflow_id, code, stage_id, sort_order, name_en, name_ar, has_documents, is_milestone_task, counts_toward_milestone, approval_levels, condition_rule, default_external_party, is_active, reason, changed_by)
    SELECT t.new, nid, d.code, sm.new, d.sort_order, d.name_en, d.name_ar, d.has_documents, d.is_milestone_task, d.counts_toward_milestone, d.approval_levels, d.condition_rule, d.default_external_party, d.is_active, p_reason, actor
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
  INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, effective_to, reason, changed_by)
    SELECT td.new, r.min_working_days, r.max_working_days, r.start_event, r.scenario, r.region_id, r.calendar_id, r.effective_from, r.effective_to, r.reason, r.changed_by
    FROM public.sla_rules r JOIN _td_map td ON td.old = r.task_def_id WHERE r.effective_to IS NULL OR r.effective_to > current_date;

  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
  VALUES ('workflow_draft_created', 'workflow_definition', nid::text, p_reason, jsonb_build_object('from', p_from, 'version', nv), true, actor);
  RETURN nid;
END $$;

-- Preview (changes only, nothing applied) and apply share one change list.
-- Sites: p_sites, or NULL = every open site that is not on the target version.
-- Mapping is by stable task code: same code -> the instance is re-pointed to the target definition (history, steps, files and
-- completed state stay on the same row); target code missing on the site -> added locked; site task whose code is not in the
-- target -> kept as is if approved, otherwise marked N/A with a reason. Applicability (scope flags) is evaluated by the API
-- when the added tasks open.
CREATE OR REPLACE FUNCTION admin_workflow_migration_plan(p_sites uuid[], p_target uuid)
RETURNS TABLE (site_code text, task_code text, change text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rf int[];
BEGIN
  IF NOT public.app_actor_is_admin('workflow_versions', 'administer') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering workflow_versions.administer required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.wf_is_published(p_target) THEN RAISE EXCEPTION 'target version must be published'; END IF;
  rf := public.app_actor_region_filter('workflow_versions', 'administer');
  IF rf IS NOT NULL AND p_sites IS NOT NULL AND EXISTS (SELECT 1 FROM public.sites x WHERE x.id = ANY (p_sites) AND NOT (x.region_id = ANY (rf))) THEN
    RAISE EXCEPTION 'some of these sites are outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH elig AS (
    SELECT s.* FROM public.sites s
    WHERE s.workflow_version_id <> p_target AND (rf IS NULL OR s.region_id = ANY (rf))
      AND ((p_sites IS NULL AND s.is_active AND s.overall_status IN ('not_started', 'in_progress', 'on_hold')) OR s.id = ANY (p_sites))),
  cur AS (
    SELECT e.id AS site_id, e.site_code, ti.id AS ti_id, ti.state, od.code AS ocode, os.code AS ostage
    FROM elig e JOIN public.task_instances ti ON ti.site_id = e.id
    JOIN public.task_definitions od ON od.id = ti.task_def_id JOIN public.stage_definitions os ON os.id = od.stage_id),
  tgt AS (
    SELECT td.code, td.id, st.code AS scode FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
    WHERE td.workflow_id = p_target AND td.is_active)
  SELECT c.site_code, c.ocode, 'remap'::text, ('state ' || c.state || CASE WHEN c.ostage <> t.scode THEN '; stage ' || c.ostage || ' -> ' || t.scode ELSE '' END)
    FROM cur c JOIN tgt t ON t.code = c.ocode
  UNION ALL
  SELECT c.site_code, c.ocode, 'keep_completed', 'approved task not in target version; kept with history'
    FROM cur c WHERE c.state = 'approved' AND NOT EXISTS (SELECT 1 FROM tgt t WHERE t.code = c.ocode)
  UNION ALL
  SELECT c.site_code, c.ocode, 'mark_na', 'state ' || c.state || ' -> na (removed in target version)'
    FROM cur c WHERE c.state NOT IN ('approved', 'na', 'skipped') AND NOT EXISTS (SELECT 1 FROM tgt t WHERE t.code = c.ocode)
  UNION ALL
  SELECT e.site_code, t.code, 'add_locked', 'new task in stage ' || t.scode
    FROM elig e CROSS JOIN tgt t
    WHERE NOT EXISTS (SELECT 1 FROM cur c WHERE c.site_id = e.id AND c.ocode = t.code)
  UNION ALL
  SELECT e.site_code, be.milestone_code, 'baseline_orphan', 'baseline entry for a milestone code not in the target version'
    FROM elig e JOIN public.baseline_entries be ON be.site_id = e.id
    WHERE NOT EXISTS (SELECT 1 FROM public.stage_definitions st WHERE st.workflow_id = p_target AND st.code = be.milestone_code);
END $$;

CREATE OR REPLACE FUNCTION admin_migrate_sites_to_workflow(p_sites uuid[], p_target uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; rf int[]; n_remap int; n_na int; n_add int; n_sites int;
BEGIN
  IF NOT public.app_actor_is_admin('workflow_versions', 'administer') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering workflow_versions.administer required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  IF NOT public.wf_is_published(p_target) THEN RAISE EXCEPTION 'target version must be published'; END IF;
  rf := public.app_actor_region_filter('workflow_versions', 'administer');
  IF rf IS NOT NULL AND p_sites IS NOT NULL AND EXISTS (SELECT 1 FROM public.sites x WHERE x.id = ANY (p_sites) AND NOT (x.region_id = ANY (rf))) THEN
    RAISE EXCEPTION 'some of these sites are outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT array_agg(s.id) INTO ids FROM public.sites s
   WHERE s.workflow_version_id <> p_target AND (rf IS NULL OR s.region_id = ANY (rf))
     AND ((p_sites IS NULL AND s.is_active AND s.overall_status IN ('not_started', 'in_progress', 'on_hold')) OR s.id = ANY (p_sites));
  IF ids IS NULL THEN RETURN 0; END IF;

  -- 1. remap by code (before removals, so codes in the target are never marked N/A)
  WITH u AS (
    UPDATE public.task_instances ti SET task_def_id = nt.id, updated_at = now()
    FROM public.task_definitions od, public.task_definitions nt
    WHERE ti.site_id = ANY (ids) AND od.id = ti.task_def_id AND nt.workflow_id = p_target AND nt.code = od.code AND nt.is_active AND nt.id <> od.id
    RETURNING 1)
  SELECT count(*) INTO n_remap FROM u;
  -- 2. tasks whose code is not in the target: approved stay; others become N/A
  WITH u AS (
    UPDATE public.task_instances ti SET state = 'na', is_na = true, na_reason = 'removed in workflow version ' || (SELECT version FROM public.workflow_definitions WHERE id = p_target), updated_at = now()
    FROM public.task_definitions od
    WHERE ti.site_id = ANY (ids) AND od.id = ti.task_def_id AND od.workflow_id <> p_target
      AND ti.state NOT IN ('approved', 'na', 'skipped')
    RETURNING 1)
  SELECT count(*) INTO n_na FROM u;
  -- 3. missing target tasks, locked
  WITH i AS (
    INSERT INTO public.task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
    SELECT s.id, s.region_id, td.id, 'locked', coalesce(td.approval_levels, st.approval_levels),
           public.sla_rule_for(td.id, s.delivery_scenario, s.region_id, current_date), now()
    FROM public.sites s JOIN public.task_definitions td ON td.workflow_id = p_target AND td.is_active
    JOIN public.stage_definitions st ON st.id = td.stage_id
    WHERE s.id = ANY (ids) AND NOT EXISTS (SELECT 1 FROM public.task_instances t WHERE t.site_id = s.id AND t.task_def_id = td.id)
    RETURNING 1)
  SELECT count(*) INTO n_add FROM i;
  -- 4. the site moves
  UPDATE public.sites SET workflow_version_id = p_target, updated_at = now() WHERE id = ANY (ids);
  GET DIAGNOSTICS n_sites = ROW_COUNT;

  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
  VALUES ('workflow_migration', 'workflow_definition', p_target::text, p_reason,
          jsonb_build_object('sites', n_sites, 'remapped', n_remap, 'marked_na', n_na, 'added', n_add), true, public.app_actor());
  RETURN n_sites;
END $$;

ALTER FUNCTION wf_is_published(uuid) OWNER TO pmis_definer;
ALTER FUNCTION stage_in_use(uuid) OWNER TO pmis_definer;
ALTER FUNCTION workflow_has_sites(uuid) OWNER TO pmis_definer;
ALTER FUNCTION role_in_use(uuid) OWNER TO pmis_definer;
ALTER FUNCTION admin_create_workflow_draft(uuid, text) OWNER TO pmis_definer;
ALTER FUNCTION admin_workflow_migration_plan(uuid[], uuid) OWNER TO pmis_definer;
ALTER FUNCTION admin_migrate_sites_to_workflow(uuid[], uuid, text) OWNER TO pmis_definer;

GRANT SELECT ON workflow_definitions, phase_gate_rules, baseline_entries, user_role_assignments, matrix_cell_assignees, delegations, roles, task_predecessors,
  document_type_placements, matrix_cells, task_definitions, stage_definitions TO pmis_definer;
GRANT INSERT ON workflow_definitions, stage_definitions, phase_gate_rules, task_definitions, task_predecessors, matrix_cells, matrix_cell_assignees,
  document_type_placements, sla_rules, audit_log TO pmis_definer;
GRANT UPDATE ON task_instances, sites TO pmis_definer;
GRANT INSERT ON task_instances TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;

REVOKE ALL ON FUNCTION admin_create_workflow_draft(uuid, text), admin_workflow_migration_plan(uuid[], uuid), admin_migrate_sites_to_workflow(uuid[], uuid, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_create_workflow_draft(uuid, text), admin_workflow_migration_plan(uuid[], uuid), admin_migrate_sites_to_workflow(uuid[], uuid, text) TO pmis_app;
  END IF;
END $$;
