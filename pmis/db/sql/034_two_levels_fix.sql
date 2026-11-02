-- 0035_two_levels_fix: finishes what 0032_two_levels left open (owner decisions 2026-11-01 "two fixed levels" and 2026-11-02 Q85, Q86, Q90).
-- Mirror: db/sql/034_two_levels_fix.sql (kept identical to prisma/migrations/0035_two_levels_fix/migration.sql).
--
--   1. Default holders of the other registers and Dismantle (Q85, two levels). L1 Data Entry = the owning team; L2 Data Reviewer & Approver = the Team Lead of the
--      stream (CW, TE, or RF & Design / Acquisition); Contractors, Risks and Deliverables are approved by the Project Manager (L2 = PM). L2 is cell level 3 (the
--      cell the engine reads for the final approver); L1 is cell level 1.
--      Q90: L2 of Procurement, GECOL, HLC and the permits is the Team Lead (CW Team Lead; permits of both streams: the CW and the TE Team Lead, because the
--      one Permits & HSE row holds both kinds of permit).
--      "Seed only where cells are missing; never overwrite existing ones" is read like this, and nothing else is written:
--        * a cell that is missing, or has no holder, gets the default holders;
--        * a cell that still carries exactly the holder the old 3-level seed gave it (the Project Manager role as the final approver of a row whose L2 is now the
--          Team Lead) AND has never been edited through the Matrix (no `matrix_cell_*` audit row for that cell) is the untouched seed, not a choice of the
--          admin: it takes the new default;
--        * every other cell is left exactly as it is (an admin's choice, an edit that was audited, a different holder). The middle cell (level 2) is not touched.
--      The Warehouse row has no stream, so its L2 is left as it is (open question for the owner).
--   2. matrix_delete_cell: deletes a region or task override cell (Q86). A row default cannot be deleted. It needs System Admin or a delegation with matrix.edit
--      (for all regions when the override has no region), a reason of 3 characters or more, the matrix revision the caller read, and it audits the cell with
--      its before values. The row default then applies again. The only writer besides matrix_save (the Matrix tables stay closed to the application role).
--   3. The matrix revision rises when anything was seeded, so an open matrix editor reloads.

-- the tables below have forced row-level security; this runs as the migration role, which sees every region
SELECT set_config('app.region_ids', '*', true);

DO $$
DECLARE
  r record; cid uuid; ids uuid[]; pm uuid; n_seeded int := 0; n_replaced int := 0; had int;
BEGIN
  SELECT ro.id INTO pm FROM roles ro WHERE ro.code = 'PM';
  FOR r IN SELECT * FROM (VALUES
    -- row,                 cell level, role codes,                              may replace the untouched legacy PM seed
    ('procurement',         3, ARRAY['CW_TL'],                                   false),
    ('gecol',               3, ARRAY['CW_TL'],                                   false),
    ('hlc',                 3, ARRAY['CW_TL'],                                   false),
    ('permits_hse',         3, ARRAY['CW_TL', 'TE_TL'],                          false),
    ('rf_design',           1, ARRAY['RF_ENG', 'MW_ENG', 'ACQ_TEAM'],            false),
    ('rf_design',           3, ARRAY['RFD_ACQ_TL'],                              true),
    ('acquisition',         1, ARRAY['RF_ENG', 'MW_ENG', 'ACQ_TEAM'],            false),
    ('acquisition',         3, ARRAY['RFD_ACQ_TL'],                              true),
    ('quality',             1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE'],              false),
    ('quality',             3, ARRAY['CW_TL', 'TE_TL'],                          true),
    ('issues',              1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE', 'PROJ_SUPPORT'], false),
    ('issues',              3, ARRAY['CW_TL', 'TE_TL'],                          true),
    ('change_control',      1, ARRAY['PROJ_SUPPORT'],                            false),
    ('change_control',      3, ARRAY['CW_TL', 'TE_TL'],                          true),
    ('readiness_handover',  1, ARRAY['SITE_ENG_TE', 'HOTO_ENG'],                 false),
    ('readiness_handover',  3, ARRAY['TE_TL'],                                   true),
    ('as_built',            1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE'],              false),
    ('as_built',            3, ARRAY['CW_TL', 'TE_TL'],                          true),
    ('meetings',            1, ARRAY['PROJ_SUPPORT'],                            false),
    ('meetings',            3, ARRAY['CW_TL', 'TE_TL'],                          true),
    ('dismantle',           1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE'],              false),
    ('dismantle',           3, ARRAY['CW_TL', 'TE_TL'],                          true),
    ('warehouse',           1, ARRAY['INV_SUP'],                                 false),
    ('contractors',         1, ARRAY['PROJ_SUPPORT'],                            false),
    ('contractors',         3, ARRAY['PM'],                                      false),
    ('risks',               1, ARRAY['PROJ_SUPPORT'],                            false),
    ('risks',               3, ARRAY['PM'],                                      false),
    ('deliverables',        1, ARRAY['PROJ_SUPPORT'],                            false),
    ('deliverables',        3, ARRAY['PM'],                                      false)
  ) AS v(row_key, lvl, role_codes, replace_legacy) LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = r.row_key);
    SELECT coalesce(array_agg(ro.id ORDER BY ro.code COLLATE "C"), ARRAY[]::uuid[]) INTO ids FROM roles ro WHERE ro.code = ANY (r.role_codes) AND ro.can_hold_matrix_levels;
    CONTINUE WHEN cardinality(ids) = 0;
    SELECT c.id INTO cid FROM matrix_cells c
      WHERE c.register_key = r.row_key AND c.level = r.lvl AND c.region_id IS NULL AND c.task_def_id IS NULL ORDER BY c.id LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES (r.row_key, r.lvl, 'any_one', NULL, true, now()) RETURNING id INTO cid;
      INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
      n_seeded := n_seeded + 1;
    ELSE
      SELECT count(*)::int INTO had FROM matrix_cell_assignees a WHERE a.cell_id = cid;
      IF had = 0 THEN
        INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
        n_seeded := n_seeded + 1;
      ELSIF r.replace_legacy AND pm IS NOT NULL AND had = 1
            AND EXISTS (SELECT 1 FROM matrix_cell_assignees a WHERE a.cell_id = cid AND a.kind = 'role' AND a.ref_id = pm)
            AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type = 'matrix_cell' AND l.entity_id = cid::text) THEN
        DELETE FROM matrix_cell_assignees a WHERE a.cell_id = cid;
        INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
        UPDATE matrix_cells SET updated_at = now() WHERE id = cid;
        n_replaced := n_replaced + 1;
      END IF;
    END IF;
  END LOOP;

  IF n_seeded + n_replaced > 0 THEN
    UPDATE matrix_state SET revision = revision + 1, updated_at = now();
  END IF;
  INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
  VALUES ('two_levels_defaults_applied', 'workflow', NULL, jsonb_build_object('cells_seeded', n_seeded, 'cells_replaced', n_replaced),
          'Owner answers Q85 and Q90 (2026-11-02): default L1 and L2 holders of the registers and Dismantle (migration 0035).');
END $$;

-- 2. Q86: delete a region or task override cell. The row default then applies again.
CREATE OR REPLACE FUNCTION matrix_delete_cell(p_version int, p_cell uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); st public.matrix_state%ROWTYPE; c public.matrix_cells%ROWTYPE; before jsonb; rev int; sys boolean;
BEGIN
  IF actor IS NULL OR NOT public.app_actor_is_admin('matrix', 'edit') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering matrix.edit required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  sys := public.app_actor_is_system_admin();
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of at least 3 characters is required.'))));
  END IF;
  SELECT * INTO st FROM public.matrix_state WHERE id FOR UPDATE;   -- one editor at a time
  IF p_version IS NOT NULL AND p_version <> st.revision THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The matrix changed since you read it. Reload and try again.'));
  END IF;
  SELECT * INTO c FROM public.matrix_cells WHERE id = p_cell FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No such matrix cell.'));
  END IF;
  IF c.region_id IS NULL AND c.task_def_id IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cell_id', 'code', 'row_default', 'message', 'A row default cannot be deleted: only a region or task override can.'))));
  END IF;
  IF c.region_id IS NOT NULL THEN
    IF NOT public.app_actor_is_admin('matrix', 'edit', ARRAY[c.region_id]) THEN
      RAISE EXCEPTION 'matrix: no matrix.edit right for region %', c.region_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT sys AND public.app_actor_region_filter('matrix', 'edit') IS NOT NULL THEN
    RAISE EXCEPTION 'matrix: a cell for all regions needs a delegation for all regions' USING ERRCODE = 'insufficient_privilege';
  END IF;

  before := public.matrix_cell_json(p_cell);
  -- the holders first, explicitly: the delete runs as the definer, a cascade would run as the table owner and meet the backstop
  DELETE FROM public.matrix_cell_assignees a WHERE a.cell_id = p_cell;
  DELETE FROM public.matrix_cells WHERE id = p_cell;
  PERFORM public.matrix_audit('matrix_cell_delete', 'matrix_cell', p_cell::text, c.region_id, before, NULL, p_reason);
  UPDATE public.matrix_state SET revision = revision + 1, updated_by = actor, updated_at = now() WHERE id RETURNING revision INTO rev;
  RETURN jsonb_build_object('revision', rev, 'deleted', true);
END $$;

ALTER FUNCTION matrix_delete_cell(int, uuid, text) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION matrix_delete_cell(int, uuid, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION matrix_delete_cell(int, uuid, text) TO pmis_app;
  END IF;
END $$;
