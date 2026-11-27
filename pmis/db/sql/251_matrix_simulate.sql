-- 0252: "Who approves?" simulation for the Responsibility Matrix (contract 0.16.0 placeholder 0.15.100, item 9). Read only: one STABLE function, no table, no write.
-- For a site and a stage task (or a register) it returns, for L1 and L2: the cell that decides (task cell before stage cell, region cell before the default
-- cell, as the engine finds it), its rule, the active people who would hold the level and how each reaches it (named, role, group), and, when nobody holds it,
-- the people who could act through the admin path (System Admins and delegates whose delegation covers the module and the region of the site).
-- System Admin or a delegate of the matrix only. It changes nothing and writes no audit row.

CREATE OR REPLACE FUNCTION matrix_simulate(p_site uuid, p_kind text, p_code text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s record; td record; rd record; v_stage uuid; v_module text; lv int; v_need text; cell public.matrix_cells%ROWTYPE; holders jsonb; fb jsonb; levels jsonb := '[]'::jsonb; label text; label_ar text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT (public.app_actor_is_admin('matrix', 'view') OR public.app_actor_is_admin('matrix', 'edit')) THEN
    RAISE EXCEPTION 'matrix simulation: System Admin or a delegate of the Responsibility Matrix required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.site_code, x.name, x.region_id INTO s FROM public.sites x WHERE x.id = p_site;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist.')); END IF;
  IF p_kind = 'task' THEN
    SELECT t.id, t.stage_id, t.name_en, t.name_ar INTO td FROM public.task_definitions t WHERE t.workflow_id = public.active_workflow_id() AND t.code = p_code;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in the active workflow.')); END IF;
    v_stage := td.stage_id; v_module := 'sites'; label := td.name_en; label_ar := td.name_ar;
  ELSIF p_kind = 'register' THEN
    SELECT d.module_key, d.name_en, d.name_ar INTO rd FROM public.register_definitions d WHERE d.register_key = p_code AND d.is_active AND d.enabled;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The register does not exist or is not enabled.')); END IF;
    v_module := rd.module_key; label := rd.name_en; label_ar := rd.name_ar;
  ELSE
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kind', 'invalid', 'task or register.')));
  END IF;
  FOREACH lv IN ARRAY ARRAY[1, 3] LOOP
    v_need := CASE lv WHEN 1 THEN 'entry' ELSE 'approve' END;
    IF p_kind = 'task' THEN
      SELECT c.* INTO cell FROM public.matrix_cells c
       WHERE c.stage_id = v_stage AND c.level = lv AND c.retired_at IS NULL AND (c.task_def_id IS NULL OR c.task_def_id = td.id) AND (c.region_id IS NULL OR c.region_id = s.region_id)
       ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id LIMIT 1;
    ELSE
      SELECT c.* INTO cell FROM public.matrix_cells c
       WHERE c.register_key = p_code AND c.level = lv AND c.retired_at IS NULL AND (c.region_id IS NULL OR c.region_id = s.region_id)
       ORDER BY (c.region_id IS NOT NULL)::int DESC, c.id LIMIT 1;
    END IF;
    holders := '[]'::jsonb; fb := '[]'::jsonb;
    IF cell.id IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', h.uid, 'name', h.name, 'email', h.email, 'via', h.via) ORDER BY h.name), '[]'::jsonb) INTO holders FROM (
        SELECT x.uid, u.display_name AS name, u.email, array_agg(DISTINCT x.via ORDER BY x.via) AS via FROM (
          SELECT a.ref_id AS uid, 'named'::text AS via FROM public.matrix_cell_assignees a WHERE a.cell_id = cell.id AND a.kind = 'user'
          UNION ALL
          SELECT ua.user_id, 'role: ' || ro.name_en FROM public.matrix_cell_assignees a
            JOIN public.roles ro ON ro.id = a.ref_id AND ro.is_active AND ro.can_hold_matrix_levels
            JOIN public.user_role_assignments ua ON ua.role_id = ro.id AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
            WHERE a.cell_id = cell.id AND a.kind = 'role' AND ua.permission_level >= v_need::public."PermissionLevel"
              AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rr WHERE rr.assignment_id = ua.id AND rr.region_id = s.region_id))
              AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules mm WHERE mm.assignment_id = ua.id AND mm.module_key = v_module))
          UNION ALL
          SELECT gm.user_id, 'group: ' || gr.name FROM public.matrix_cell_assignees a
            JOIN public.groups gr ON gr.id = a.ref_id AND gr.is_active JOIN public.group_members gm ON gm.group_id = gr.id
            WHERE a.cell_id = cell.id AND a.kind = 'group'
        ) x JOIN public.users u ON u.id = x.uid AND u.deleted_at IS NULL AND u.status::text = 'active' AND NOT u.is_break_glass
        GROUP BY x.uid, u.display_name, u.email) h;
    END IF;
    IF jsonb_array_length(holders) = 0 THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.display_name, 'email', u.email,
               'via', CASE WHEN public.app_user_is_system_admin(u.id) THEN 'system_admin' ELSE 'delegate' END) ORDER BY u.display_name), '[]'::jsonb) INTO fb
        FROM public.users u WHERE u.deleted_at IS NULL AND u.status::text = 'active' AND NOT u.is_break_glass
         AND (public.app_user_is_system_admin(u.id) OR public.app_delegation_covers(u.id, v_module, 'edit'::public."PermissionAction", ARRAY[s.region_id]));
    END IF;
    levels := levels || jsonb_build_array(jsonb_build_object('level_code', CASE lv WHEN 1 THEN 'L1' ELSE 'L2' END,
      'source', CASE WHEN cell.id IS NULL THEN 'none' WHEN cell.region_id IS NULL THEN 'default' ELSE 'region' END,
      'task_specific', cell.task_def_id IS NOT NULL, 'rule', CASE WHEN cell.id IS NULL THEN NULL ELSE cell.rule::text END,
      'holders', holders, 'fallback', fb));
  END LOOP;
  RETURN jsonb_build_object('site', jsonb_build_object('id', s.id, 'site_code', s.site_code, 'name', s.name, 'region_id', s.region_id),
    'kind', p_kind, 'code', p_code, 'name_en', label, 'name_ar', label_ar, 'module', v_module, 'levels', levels);
END $$;

DO $$
BEGIN
  ALTER FUNCTION matrix_simulate(uuid, text, text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION matrix_simulate(uuid, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION matrix_simulate(uuid, text, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION matrix_simulate(uuid, text, text) TO pmis_app;
  END IF;
END $$;
