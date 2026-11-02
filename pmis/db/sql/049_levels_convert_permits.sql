-- 0050_levels_convert_permits: two owner decisions of 2026-11-02 (docs/spec/owner-answers-2026-10-29.md rows "Three-level paths -> L1/L2" and "Who enters
-- permits (L1)", Q85, Q90).
-- Mirror: db/sql/049_levels_convert_permits.sql (kept identical to prisma/migrations/0050_levels_convert_permits/migration.sql).
--
--   1. Old 3-level paths become the two fixed levels. 0032 left every task and register record that was already submitted on its 3-level snapshot (B7).
--      The owner decided: the old final approver becomes L2 and the old review level is dropped. levels_convert_two() converts every OPEN item
--      (levels_required = 3; task state not approved / na / skipped; record state not approved / voided):
--        * at level 1 (entry, including after a rejection): only the snapshot changes (levels_required = 2);
--        * waiting at level 2 (review): it moves to L2 (state in_approval, current level 2). The review holders are no longer asked: a pin on a review
--          holder who does not hold L2 is cleared, the votes of an all_members review are removed, and an all_members approve rule gets its votes from the
--          L2 holders in a new round. The L2 holders are told;
--        * waiting at level 3 (approve): it stays at L2 (current level 2); its votes (all_members) move from level 3 to level 2, so they stay the old final
--          approvers' votes.
--      The holders of L2 are the cells stored at matrix level 3 (the engine reads them for the final approver), so "the old final approver" is exactly who
--      the engine already asks. The level actors of the dropped path (level 2 and 3 acts recorded before a rejection) are removed from the snapshot tables;
--      they stay in workflow_steps / register_steps (history display is untouched) and in the audit row.
--      Approved, voided, N/A and skipped items are never touched. Items at one level (levels_required = 1) are not part of this decision and are left.
--      One audit row per converted item with before and after (reason "owner decision: two levels"); the version counter rises, so a screen holding the old
--      item gets 412 and reloads. Idempotent: a second run finds nothing to convert. p_dry_run = true only counts; p_sites limits a run to some sites (default: all). Not granted to the application role.
--   2. Cell level 2 (the old review cell) has no use any more: matrix_cells.retired_at is set on every level-2 cell (the data and the holders are kept for
--      history); a new level-2 cell (a workflow draft copies cells) is retired on insert.
--   3. Permits & HSE per stream (Q90, owner answer "Who enters permits"). The permit type decides the stream (permit_types.stream: the Access and PTW types
--      of TE are TE, those of CW are CW; the others have none and stay on the Permits & HSE row, which covers CW). The Matrix gets the row `permits_hse_te`
--      ("Permits & HSE - TE stream"), a register_definitions row that is not enabled (like procurement_hlc, 0042) and is mapped by
--      register_definitions.rules.scope_rows {"TE": "permits_hse_te"} with rules.scope_from = 'permit_stream'. Default holders: permits_hse L1 = Site
--      Engineers (CW), L2 = CW Team Lead; permits_hse_te L1 = Site Engineers (TE), L2 = TE Team Lead. Seeded only where the cell is missing, has no
--      holder, or still carries exactly the untouched 0035 seed (CW and TE Team Lead on the one row, never edited through the Matrix).
--      The trigger b_reg_scope_entry now covers permits_hse too: a permit version of a TE type is written only by an L1 holder of permits_hse_te, one of a
--      CW or untyped type only by an L1 holder of permits_hse (a System Admin only when the row has nobody, B10). The Matrix screen lists the new row.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Cell level 2 is retired (data kept)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE matrix_cells ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ(6);
COMMENT ON COLUMN matrix_cells.retired_at IS '0050: set on every level-2 cell. Two fixed levels (owner decision 2026-11-01): L1 = cell level 1, L2 = cell level 3; the old review cell is kept for history only.';

CREATE OR REPLACE FUNCTION matrix_cells_retire_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.level = 2 AND NEW.retired_at IS NULL THEN NEW.retired_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_matrix_cells_retire_review BEFORE INSERT OR UPDATE OF level ON matrix_cells FOR EACH ROW EXECUTE FUNCTION matrix_cells_retire_review();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The conversion
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION levels_convert_two(p_dry_run boolean DEFAULT false, p_sites uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t public.task_instances%ROWTYPE; r public.register_records%ROWTYPE;
  c_t int := 0; c_t1 int := 0; c_t2 int := 0; c_t3 int := 0; c_r int := 0; c_r1 int := 0; c_r2 int := 0; c_r3 int := 0; c_cells int := 0;
  b jsonb; hist jsonb; new_level int; new_state text; rl public."MatrixRule"; h record; pin uuid; nround int;
  reason constant text := 'owner decision: two levels';
BEGIN
  PERFORM set_config('app.region_ids', '*', true);

  -- tasks
  FOR t IN SELECT * FROM public.task_instances x WHERE x.levels_required = 3 AND x.state NOT IN ('approved', 'na', 'skipped') AND (p_sites IS NULL OR x.site_id = ANY (p_sites)) ORDER BY x.id FOR UPDATE LOOP
    c_t := c_t + 1;
    IF t.current_level >= 3 THEN c_t3 := c_t3 + 1; ELSIF t.current_level = 2 THEN c_t2 := c_t2 + 1; ELSE c_t1 := c_t1 + 1; END IF;
    CONTINUE WHEN p_dry_run;
    b := public.wf_snap(t.id);
    hist := jsonb_build_object(
      'level_actors', (SELECT coalesce(jsonb_agg(jsonb_build_object('level', a.level, 'user_id', a.user_id, 'how', a.how) ORDER BY a.level), '[]'::jsonb)
                       FROM public.task_level_actors a WHERE a.task_id = t.id AND a.level >= 2),
      'voters', (SELECT coalesce(jsonb_agg(jsonb_build_object('level', v.level, 'round', v.round, 'user_id', v.user_id, 'voted', v.voted_at IS NOT NULL) ORDER BY v.level, v.user_id), '[]'::jsonb)
                 FROM public.task_level_voters v WHERE v.task_id = t.id AND v.level >= 2 AND v.round = t.level_round),
      'ball_in_court_user_id', t.ball_in_court_user_id);
    new_level := least(t.current_level, 2);
    new_state := CASE WHEN t.state = 'in_review' THEN 'in_approval' ELSE t.state::text END;
    pin := t.ball_in_court_user_id;
    nround := t.level_round;
    DELETE FROM public.task_level_actors a WHERE a.task_id = t.id AND a.level >= 2;
    UPDATE public.task_instances SET levels_required = 2 WHERE id = t.id;
    IF t.current_level = 2 AND t.state = 'in_review' THEN
      -- the review holders are dropped: their votes go, a pin on somebody who does not hold L2 goes, an all_members L2 asks its own holders
      DELETE FROM public.task_level_voters v WHERE v.task_id = t.id AND v.level = 2 AND v.round = t.level_round;
      IF pin IS NOT NULL AND NOT public.wf_is_eligible(t.id, 'approve', pin) THEN pin := NULL; END IF;
      rl := public.wf_rule(t.id, 'approve');
      IF rl = 'all_members' THEN
        nround := t.level_round + 1;
        INSERT INTO public.task_level_voters (task_id, level, round, user_id) SELECT t.id, 2, nround, e.user_id FROM public.wf_eligible(t.id, 'approve') e;
        pin := NULL;
      END IF;
    ELSIF t.current_level >= 3 THEN
      UPDATE public.task_level_voters v SET level = 2 WHERE v.task_id = t.id AND v.level = 3 AND v.round = t.level_round;
    END IF;
    UPDATE public.task_instances SET current_level = new_level, state = new_state::public."TaskState", level_round = nround, ball_in_court_user_id = pin,
      version = version + 1, updated_at = now() WHERE id = t.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('levels_converted_two', 'task', t.id::text, t.site_id, t.region_id, b || jsonb_build_object('dropped', hist),
            public.wf_snap(t.id) || jsonb_build_object('l2_holders', 'old final approvers (matrix level 3 cells)'), reason, public.app_actor());
    IF t.state = 'in_review' THEN
      FOR h IN SELECT e.user_id FROM public.wf_eligible(t.id, 'approve') e ORDER BY e.user_id LIMIT 20 LOOP
        PERFORM public.wf_notify(h.user_id, 'task_assigned', 'A task is waiting for your approval (L2)', public.wf_label(t.id), t.id);
      END LOOP;
      IF NOT public.wf_has_holder(t.id, 'approve') THEN
        PERFORM public.wf_notify_admins('no_eligible_holder', 'No holder for a task level', public.wf_label(t.id) || ': nobody can act on the approve level.', t.id);
      END IF;
    END IF;
  END LOOP;

  -- register records
  FOR r IN SELECT * FROM public.register_records x WHERE x.levels_required = 3 AND x.state NOT IN ('approved', 'voided') AND (p_sites IS NULL OR x.site_id = ANY (p_sites)) ORDER BY x.id FOR UPDATE LOOP
    c_r := c_r + 1;
    IF r.current_level >= 3 THEN c_r3 := c_r3 + 1; ELSIF r.current_level = 2 THEN c_r2 := c_r2 + 1; ELSE c_r1 := c_r1 + 1; END IF;
    CONTINUE WHEN p_dry_run;
    b := public.reg_snap(r.id);
    hist := jsonb_build_object(
      'level_actors', (SELECT coalesce(jsonb_agg(jsonb_build_object('level', a.level, 'user_id', a.user_id, 'how', a.how) ORDER BY a.level), '[]'::jsonb)
                       FROM public.register_level_actors a WHERE a.record_id = r.id AND a.level >= 2),
      'voters', (SELECT coalesce(jsonb_agg(jsonb_build_object('level', v.level, 'round', v.round, 'user_id', v.user_id, 'voted', v.voted_at IS NOT NULL) ORDER BY v.level, v.user_id), '[]'::jsonb)
                 FROM public.register_level_voters v WHERE v.record_id = r.id AND v.level >= 2 AND v.round = r.level_round),
      'ball_in_court_user_id', r.ball_in_court_user_id);
    new_level := least(r.current_level, 2);
    new_state := CASE WHEN r.state = 'in_review' THEN 'in_approval' ELSE r.state END;
    pin := r.ball_in_court_user_id;
    nround := r.level_round;
    DELETE FROM public.register_level_actors a WHERE a.record_id = r.id AND a.level >= 2;
    UPDATE public.register_records SET levels_required = 2 WHERE id = r.id;
    IF r.current_level = 2 AND r.state = 'in_review' THEN
      DELETE FROM public.register_level_voters v WHERE v.record_id = r.id AND v.level = 2 AND v.round = r.level_round;
      IF pin IS NOT NULL AND NOT public.reg_is_eligible(r.id, 'approve', pin) THEN pin := NULL; END IF;
      rl := public.reg_rule(r.id, 'approve');
      IF rl = 'all_members' THEN
        nround := r.level_round + 1;
        INSERT INTO public.register_level_voters (record_id, level, round, user_id) SELECT r.id, 2, nround, e.user_id FROM public.reg_eligible(r.id, 'approve') e;
        pin := NULL;
      END IF;
    ELSIF r.current_level >= 3 THEN
      UPDATE public.register_level_voters v SET level = 2 WHERE v.record_id = r.id AND v.level = 3 AND v.round = r.level_round;
    END IF;
    UPDATE public.register_records SET current_level = new_level, state = new_state, level_round = nround, ball_in_court_user_id = pin,
      version = version + 1, updated_at = now() WHERE id = r.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('levels_converted_two', 'register_record', r.id::text, r.site_id, r.region_id, b || jsonb_build_object('dropped', hist),
            public.reg_snap(r.id) || jsonb_build_object('l2_holders', 'old final approvers (matrix level 3 cells)'), reason, public.app_actor());
    IF r.state = 'in_review' THEN
      FOR h IN SELECT e.user_id FROM public.reg_eligible(r.id, 'approve') e ORDER BY e.user_id LIMIT 20 LOOP
        PERFORM public.reg_notify(h.user_id, 'task_assigned', 'A record is waiting for your approval (L2)', public.reg_label(r.id), r.id);
      END LOOP;
      IF NOT public.reg_has_holder(r.id, 'approve') THEN
        PERFORM public.reg_notify_admins('no_eligible_holder', 'No holder for a register level', public.reg_label(r.id) || ': nobody can act on the approve level.', r.id);
      END IF;
    END IF;
  END LOOP;

  -- cell level 2 is retired once no open item can read it (a run limited to some sites leaves the cells alone)
  IF NOT p_dry_run AND p_sites IS NULL THEN
    UPDATE public.matrix_cells SET retired_at = now() WHERE level = 2 AND retired_at IS NULL;
    GET DIAGNOSTICS c_cells = ROW_COUNT;
    IF c_t + c_r + c_cells > 0 THEN
      UPDATE public.matrix_state SET revision = revision + 1, updated_at = now();
      INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
      VALUES ('levels_conversion_run', 'workflow', NULL,
              jsonb_build_object('tasks', c_t, 'tasks_at_l1', c_t1, 'tasks_from_review', c_t2, 'tasks_at_approve', c_t3,
                                 'records', c_r, 'records_at_l1', c_r1, 'records_from_review', c_r2, 'records_at_approve', c_r3, 'cells_retired', c_cells),
              reason, public.app_actor());
    END IF;
  END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'tasks', c_t, 'tasks_at_l1', c_t1, 'tasks_from_review', c_t2, 'tasks_at_approve', c_t3,
                            'records', c_r, 'records_at_l1', c_r1, 'records_from_review', c_r2, 'records_at_approve', c_r3, 'cells_retired', c_cells);
END $$;

ALTER FUNCTION levels_convert_two(boolean, uuid[]) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION levels_convert_two(boolean, uuid[]) FROM PUBLIC;
ALTER FUNCTION matrix_cells_retire_review() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION matrix_cells_retire_review() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Permits & HSE per stream
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE permit_types ADD COLUMN IF NOT EXISTS stream TEXT CHECK (stream IN ('CW', 'TE'));
COMMENT ON COLUMN permit_types.stream IS '0050: the stream whose team enters the permit (Q90): CW or TE; NULL = no stream, entered on the Permits & HSE row (which covers CW).';
UPDATE permit_types SET stream = 'CW' WHERE code IN ('Access - CW', 'PTW - CW') AND stream IS NULL;
UPDATE permit_types SET stream = 'TE' WHERE code IN ('Access - TE', 'PTW - TE') AND stream IS NULL;

INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order)
VALUES ('permits_hse_te', 'Permits & HSE - TE stream', 'التصاريح والسلامة - مسار TE', 'permits_hse', 'register', true, true, ARRAY[]::text[], 2,
        '{"scope_of": "permits_hse", "scope": "TE"}'::jsonb, false, 51)
ON CONFLICT (register_key) DO NOTHING;
UPDATE register_definitions
SET rules = rules || jsonb_build_object('scope_from', 'permit_stream', 'scope_rows', coalesce(rules -> 'scope_rows', '{}'::jsonb) || '{"TE": "permits_hse_te"}'::jsonb)
WHERE register_key = 'permits_hse';

-- The scope of a record: its `scope` field, or (rules.scope_from = 'permit_stream') the stream of its permit type.
CREATE OR REPLACE FUNCTION reg_scope_of(p_key text, p_data jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN d.rules ->> 'scope_from' = 'permit_stream' THEN (SELECT t.stream FROM public.permit_types t WHERE t.code = p_data ->> 'permit_type')
              ELSE p_data ->> 'scope' END
  FROM public.register_definitions d WHERE d.register_key = p_key
$$;

CREATE OR REPLACE FUNCTION reg_row_key(p_key text, p_data jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT s.register_key FROM public.register_definitions d
    JOIN public.register_definitions s ON s.register_key = d.rules -> 'scope_rows' ->> public.reg_scope_of(p_key, p_data) AND s.is_active
    WHERE d.register_key = p_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object'), p_key)
$$;

-- The scopes a caller may enter: only registers whose scope is a field list have them; permits are judged per permit type by the trigger.
CREATE OR REPLACE FUNCTION reg_entry_scopes(p_key text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); rows_ jsonb; opts text[]; out text[] := ARRAY[]::text[]; k text; v text;
BEGIN
  SELECT d.rules -> 'scope_rows' INTO rows_ FROM public.register_definitions d WHERE d.register_key = p_key AND coalesce(d.rules ->> 'scope_from', '') <> 'permit_stream';
  IF rows_ IS NULL OR jsonb_typeof(rows_) <> 'object' THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg(e ORDER BY o), ARRAY[]::text[]) INTO opts
  FROM public.register_fields f, jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.options) = 'array' THEN f.options ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)
  WHERE f.register_key = p_key AND f.code = 'scope';
  IF actor IS NULL THEN RETURN out; END IF;
  IF public.app_user_is_system_admin(actor) THEN RETURN opts; END IF;
  IF EXISTS (SELECT 1 FROM public.regions g CROSS JOIN LATERAL public.reg_row_entry_holders(p_key, g.id) h WHERE h.user_id = actor) THEN
    out := ARRAY(SELECT o FROM unnest(opts) o WHERE NOT rows_ ? o);
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(rows_) LOOP
    IF EXISTS (SELECT 1 FROM public.regions g CROSS JOIN LATERAL public.reg_row_entry_holders(v, g.id) h WHERE h.user_id = actor) AND k = ANY (opts) THEN
      out := out || k;
    END IF;
  END LOOP;
  RETURN ARRAY(SELECT o FROM unnest(opts) o WHERE o = ANY (out));
END $$;

CREATE OR REPLACE FUNCTION reg_scope_entry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); rk text; n int; holder boolean; sc text;
BEGIN
  IF public.app_is_seeding() OR actor IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = NEW.register_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object') THEN RETURN NEW; END IF;
  rk := public.reg_row_key(NEW.register_key, NEW.data);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state <> 'entry' OR rk = public.reg_row_key(OLD.register_key, OLD.data) THEN RETURN NEW; END IF;
  ELSIF NEW.state <> 'entry' THEN
    RETURN NEW;
  END IF;
  sc := public.reg_scope_of(NEW.register_key, NEW.data);
  SELECT count(*)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder FROM public.reg_row_entry_holders(rk, NEW.region_id) h;
  IF NOT holder AND NOT (n = 0 AND public.app_user_is_system_admin(actor)) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail',
      'You are not an entry holder (L1) of the ' || coalesce((SELECT d.name_en FROM public.register_definitions d WHERE d.register_key = rk), rk)
      || ' row of the Matrix' || CASE WHEN sc IS NOT NULL THEN ' (' || CASE WHEN NEW.register_key = 'permits_hse' THEN 'stream ' ELSE 'scope ' END || sc || ')' ELSE '' END || '.'));
  END IF;
  -- the claim pin of a new version follows the holders of its own row (one holder: nobody to claim against)
  IF TG_OP = 'INSERT' AND NEW.ball_in_court_user_id = actor AND n <= 1 THEN NEW.ball_in_court_user_id := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_reg_scope_entry ON register_records;
CREATE TRIGGER b_reg_scope_entry BEFORE INSERT OR UPDATE OF data ON register_records FOR EACH ROW WHEN (NEW.register_key IN ('procurement', 'permits_hse')) EXECUTE FUNCTION reg_scope_entry_guard();

-- Default holders (Q85, Q90): seeded only where the cell is missing, has no holder, or still is the untouched 0035 seed of the Permits & HSE L2.
DO $$
DECLARE
  r record; cid uuid; ids uuid[]; n_seeded int := 0; n_replaced int := 0; had int; cw uuid; te uuid;
BEGIN
  SELECT ro.id INTO cw FROM roles ro WHERE ro.code = 'CW_TL';
  SELECT ro.id INTO te FROM roles ro WHERE ro.code = 'TE_TL';
  FOR r IN SELECT * FROM (VALUES
    ('permits_hse',    1, ARRAY['SITE_ENG_CW']),
    ('permits_hse',    3, ARRAY['CW_TL']),
    ('permits_hse_te', 1, ARRAY['SITE_ENG_TE']),
    ('permits_hse_te', 3, ARRAY['TE_TL'])
  ) AS v(row_key, lvl, role_codes) LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = r.row_key);
    SELECT coalesce(array_agg(ro.id ORDER BY ro.code COLLATE "C"), ARRAY[]::uuid[]) INTO ids FROM roles ro WHERE ro.code = ANY (r.role_codes) AND ro.can_hold_matrix_levels;
    CONTINUE WHEN cardinality(ids) = 0;
    SELECT c.id INTO cid FROM matrix_cells c WHERE c.register_key = r.row_key AND c.level = r.lvl AND c.region_id IS NULL AND c.task_def_id IS NULL ORDER BY c.id LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES (r.row_key, r.lvl, 'any_one', NULL, true, now()) RETURNING id INTO cid;
      INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
      n_seeded := n_seeded + 1;
    ELSE
      SELECT count(*)::int INTO had FROM matrix_cell_assignees a WHERE a.cell_id = cid;
      IF had = 0 THEN
        INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
        n_seeded := n_seeded + 1;
      ELSIF r.row_key = 'permits_hse' AND r.lvl = 3 AND cw IS NOT NULL AND te IS NOT NULL AND had = 2
            AND (SELECT count(*) FROM matrix_cell_assignees a WHERE a.cell_id = cid AND a.kind = 'role' AND a.ref_id IN (cw, te)) = 2
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
  VALUES ('permits_per_stream_applied', 'workflow', NULL,
          jsonb_build_object('matrix_row', 'permits_hse_te', 'cells_seeded', n_seeded, 'cells_replaced', n_replaced, 'te_types', jsonb_build_array('Access - TE', 'PTW - TE')),
          'Owner answers Q90 and "Who enters permits (L1)" (2026-11-02): CW permits by the CW team, TE permits by the TE team (migration 0050).');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['reg_scope_of(text,jsonb)', 'reg_row_key(text,jsonb)', 'reg_entry_scopes(text)', 'reg_scope_entry_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION reg_entry_scopes(text) TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON permit_types FROM pmis_app;
  END IF;
END $$;

-- 5. Convert what is in flight now (a database without open 3-level items converts nothing and writes nothing).
SELECT levels_convert_two(false);
