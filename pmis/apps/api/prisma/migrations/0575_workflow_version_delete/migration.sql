-- 0575_workflow_version_delete (contract 0.15.436): an old published workflow version can be deleted, after a full snapshot is archived.
-- Mirror: db/sql/574_workflow_version_delete.sql (kept byte-identical).
--
-- Owner request (relayed 2026-11-27 20:35). A published version may be deleted only when (a) it is not the version in force and has already started, (b) no site is on
-- it and no site task or site migration uses it (otherwise a clear reason), (c) the caller holds workflow_versions administer (the publish right) for all regions, a
-- reason is given (the API adds the password step-up and the typed confirmation) and an audit row is written, (d) a full snapshot of the version is archived first.
-- Everything else about the guards stays: drafts are discarded as before, a published version is still immutable, deactivation still applies to tasks.
--
--   1. workflow_version_archive: the snapshot (the version row and every row of its milestones, gates, tasks, predecessors, matrix cells, SLA rules, rule set items,
--      document placements, scenario rules, streams and views) as one jsonb, with who, when and why. Written only by the definer function. A configuration table.
--   2. wf_version_delete_open(wf): true only inside the transaction that archived that version. The three structural guards and the version guard let the delete
--      through only then (patched in place, delete branch only).
--   3. admin_wf_delete_version(version, etag, reason): the one door.

CREATE TABLE workflow_version_archive (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL,
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL,
  reason       text NOT NULL CHECK (btrim(reason) <> ''),
  archived_by  uuid,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  archived_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX workflow_version_archive_version_idx ON workflow_version_archive (version, archived_at DESC);
COMMENT ON TABLE workflow_version_archive IS 'Full snapshot of a published workflow version taken before it is deleted (0575). Restorable by hand from the jsonb; configuration, kept on a data reset.';

CREATE OR REPLACE FUNCTION wf_version_delete_open(p_wf uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workflow_version_archive WHERE workflow_id = p_wf AND archived_xid = pg_current_xact_id())
$$;

-- The guards, patched in place (accumulating functions), delete branch only.
DO $$
DECLARE def text; nw text;
BEGIN
  def := pg_get_functiondef('public.workflow_definitions_guard()'::regprocedure);
  IF position('wf_version_delete_open' IN def) = 0 THEN
    nw := replace(def, E'IF OLD.status = ''published'' THEN RAISE EXCEPTION ''a published workflow version cannot be deleted''',
      E'IF OLD.status = ''published'' AND NOT (public.wf_version_delete_open(OLD.id) AND NOT public.workflow_has_sites(OLD.id) AND OLD.id IS DISTINCT FROM public.active_workflow_id()) THEN RAISE EXCEPTION ''a published workflow version cannot be deleted''');
    IF nw = def THEN RAISE EXCEPTION 'workflow_definitions_guard: the delete rule was not found'; END IF;
    EXECUTE nw;
  END IF;

  def := pg_get_functiondef('public.stage_definitions_guard()'::regprocedure);
  IF position('wf_version_delete_open' IN def) = 0 THEN
    nw := replace(def, E'IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION ''a published version cannot lose a milestone',
      E'IF wf_is_published(OLD.workflow_id) AND NOT wf_version_delete_open(OLD.workflow_id) THEN RAISE EXCEPTION ''a published version cannot lose a milestone');
    IF nw = def THEN RAISE EXCEPTION 'stage_definitions_guard: the delete rule was not found'; END IF;
    EXECUTE nw;
  END IF;

  def := pg_get_functiondef('public.phase_gate_rules_guard()'::regprocedure);
  IF position('wf_version_delete_open' IN def) = 0 THEN
    nw := replace(def, E'IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION ''a published version cannot lose a gate',
      E'IF wf_is_published(OLD.workflow_id) AND NOT wf_version_delete_open(OLD.workflow_id) THEN RAISE EXCEPTION ''a published version cannot lose a gate');
    IF nw = def THEN RAISE EXCEPTION 'phase_gate_rules_guard: the delete rule was not found'; END IF;
    EXECUTE nw;
  END IF;

  def := pg_get_functiondef('public.task_definitions_guard()'::regprocedure);
  IF position('wf_version_delete_open' IN def) = 0 THEN
    nw := replace(def, E'IF wf_is_published(OLD.workflow_id) THEN RAISE EXCEPTION ''tasks of a published version are deactivated, not deleted''',
      E'IF wf_is_published(OLD.workflow_id) AND NOT wf_version_delete_open(OLD.workflow_id) THEN RAISE EXCEPTION ''tasks of a published version are deactivated, not deleted''');
    IF nw = def THEN RAISE EXCEPTION 'task_definitions_guard: the delete rule was not found'; END IF;
    EXECUTE nw;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_wf_delete_version(p_version integer, p_etag integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; why jsonb := '[]'::jsonb; n integer; snap jsonb; aid uuid;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  PERFORM public.calc_require_reason(p_reason);
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'published' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a published version is deleted here; a draft is discarded.'));
  END IF;
  IF w.id = public.active_workflow_id() THEN why := why || to_jsonb('current'::text); END IF;
  IF w.effective_from > current_date THEN why := why || to_jsonb('not_started'::text); END IF;
  IF public.workflow_has_sites(w.id) THEN why := why || to_jsonb('sites'::text); END IF;
  SELECT count(*) INTO n FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id WHERE td.workflow_id = w.id;
  IF n > 0 THEN why := why || to_jsonb('site_tasks'::text); END IF;
  IF EXISTS (SELECT 1 FROM public.site_workflow_migrations WHERE from_version_id = w.id OR to_version_id = w.id) THEN why := why || to_jsonb('migrations'::text); END IF;
  IF jsonb_array_length(why) > 0 THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This version cannot be deleted: it is in force, has not started, a site is on it, site tasks use it, or a site migration refers to it.', 'reasons', why));
  END IF;

  snap := jsonb_build_object(
    'workflow', to_jsonb(w),
    'stages', coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM public.stage_definitions s WHERE s.workflow_id = w.id), '[]'::jsonb),
    'gates', coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM public.phase_gate_rules g WHERE g.workflow_id = w.id), '[]'::jsonb),
    'tasks', coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM public.task_definitions t WHERE t.workflow_id = w.id), '[]'::jsonb),
    'predecessors', coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM public.task_predecessors p WHERE p.task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)
                                                                                                 OR p.predecessor_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)), '[]'::jsonb),
    'matrix_cells', coalesce((SELECT jsonb_agg(to_jsonb(m)) FROM public.matrix_cells m WHERE m.stage_id IN (SELECT id FROM public.stage_definitions WHERE workflow_id = w.id)
                                                                                         OR m.task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)), '[]'::jsonb),
    'sla_rules', coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM public.sla_rules r WHERE r.task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)), '[]'::jsonb),
    'sla_rule_set_items', coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM public.sla_rule_set_items i WHERE i.task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)), '[]'::jsonb),
    'document_type_placements', coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM public.document_type_placements d WHERE d.task_def_id IN (SELECT id FROM public.task_definitions WHERE workflow_id = w.id)), '[]'::jsonb),
    'scenario_task_rules', coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM public.scenario_task_rules c WHERE c.workflow_id = w.id), '[]'::jsonb),
    'streams', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM public.workflow_streams x WHERE x.workflow_id = w.id), '[]'::jsonb),
    'views', coalesce((SELECT jsonb_agg(to_jsonb(v)) FROM public.workflow_views v WHERE v.workflow_id = w.id), '[]'::jsonb),
    'view_members', coalesce((SELECT jsonb_agg(to_jsonb(vm)) FROM public.workflow_view_members vm WHERE vm.workflow_id = w.id), '[]'::jsonb));

  INSERT INTO public.workflow_version_archive (workflow_id, version, snapshot, reason, archived_by)
  VALUES (w.id, w.version, snap, btrim(p_reason), public.app_actor()) RETURNING id INTO aid;

  BEGIN
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
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Other data still depends on this version: ' || SQLERRM));
  END;

  PERFORM public.wfe_audit('workflow_version_delete', 'workflow_definition', w.version::text,
    jsonb_build_object('version', w.version, 'status', 'published', 'effective_from', w.effective_from),
    jsonb_build_object('deleted', true, 'archive_id', aid), p_reason);
  RETURN jsonb_build_object('version', w.version, 'deleted', true, 'archive_id', aid);
END $$;

DO $$
BEGIN
  ALTER FUNCTION wf_version_delete_open(uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION wf_version_delete_open(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION wf_version_delete_open(uuid) TO pmis_definer;
  ALTER FUNCTION admin_wf_delete_version(integer, integer, text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION admin_wf_delete_version(integer, integer, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION admin_wf_delete_version(integer, integer, text) TO pmis_definer;
  GRANT SELECT, INSERT ON workflow_version_archive TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_wf_delete_version(integer, integer, text) TO pmis_app;
    -- the guards run as the caller, so the caller may ask the helper (it only reports whether this transaction archived the version)
    GRANT EXECUTE ON FUNCTION wf_version_delete_open(uuid) TO pmis_app;
  END IF;
END $$;

-- Data reset: the archive is configuration (KEEP), listed next to workflow_definitions. data_reset_plan() is an accumulating function: patched in place, idempotently.
GRANT SELECT, UPDATE ON workflow_version_archive TO pmis_reset_owner;
DO $$
DECLARE def text; n text := '''workflow_definitions'', ';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('workflow_version_archive' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the configuration list (workflow_definitions) was not found'; END IF;
    EXECUTE replace(def, n, n || '''workflow_version_archive'', ');
  END IF;
END $$;
