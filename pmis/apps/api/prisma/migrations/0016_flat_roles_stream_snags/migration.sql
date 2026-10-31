-- 0016_flat_roles_stream_snags: owner decisions of 2026-10-29. Mirror: db/sql/015_flat_roles_stream_snags.sql (kept identical).
--
-- 1. D1, flat roles. There is no main/sub-role split any more: every role is a plain role whose name and properties are edited in
--    Roles & Responsibilities. The parent link (roles.parent_role_id, with its index and foreign key) is dropped after every
--    existing link is cleared; no role, name or code is touched. The guard functions (role_in_use, roles_guard) no longer look at a
--    parent. idm_role_save keeps its signature (same owner, same grants, so callers and fixtures keep working) but its p_parent
--    argument is deprecated: any non-NULL value is refused with check_violation.
-- 2. Q25 / E6, stream-scoped snag blocking. CW PAC (B13) and CW FAC (B15) cannot be submitted, reviewed or approved while an open CW
--    snag exists on the site; TE PAC (D16) and TE FAC (D18) likewise for open TE snags. The stream of a snag is the existing column
--    snags.scope ('CW' or 'TE'); no column is added. The old rule (only a snag linked by task_id blocks, at the final approval of any
--    task) is removed. The wf_* functions are redefined with CREATE OR REPLACE, so owner and grants of 0015 stay as they are.
--
-- Contents: 1 flat roles  2 snag blocking  3 ownership and execute rights.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Flat roles
-- ---------------------------------------------------------------------------------------------------------------------
-- Guards first: they must stop reading parent_role_id before the column can go.
CREATE OR REPLACE FUNCTION role_in_use(p_role uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_role_assignments WHERE role_id = p_role)
      OR EXISTS (SELECT 1 FROM public.matrix_cell_assignees WHERE kind = 'role' AND ref_id = p_role)
      OR EXISTS (SELECT 1 FROM public.delegations WHERE target_role_id = p_role)
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
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION idm_role_save(p_id uuid, p_code text, p_name_en text, p_name_ar text, p_desc_en text, p_desc_ar text, p_parent uuid, p_team "TeamKind",
  p_default_profile uuid, p_default_all_regions boolean, p_default_all_modules boolean, p_can_hold boolean, p_sort int, p_active boolean, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid; rid uuid := p_id; o public.roles%ROWTYPE;
BEGIN
  IF p_parent IS NOT NULL THEN
    RAISE EXCEPTION 'roles are flat: a role cannot have a parent' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('roles', CASE WHEN p_id IS NULL THEN 'create' ELSE 'edit' END::"PermissionAction");
  IF NOT public.app_actor_is_system_admin() THEN
    IF coalesce(p_default_all_regions, false) THEN RAISE EXCEPTION 'default_all_regions is System-Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF coalesce(p_default_all_modules, false) AND NOT public.idm_actor_all_modules() THEN RAISE EXCEPTION 'you cannot make a role default to all modules' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;
  IF p_default_profile IS NOT NULL AND NOT public.idm_profile_within_actor(p_default_profile) THEN
    RAISE EXCEPTION 'default profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    a := public.idm_actor('roles', 'create');
    INSERT INTO public.roles (code, name_en, name_ar, description_en, description_ar, team, default_profile_id, default_all_regions,
      default_all_modules, can_hold_matrix_levels, sort, is_active)
    VALUES (p_code, p_name_en, p_name_ar, p_desc_en, p_desc_ar, coalesce(p_team, 'none'), p_default_profile, coalesce(p_default_all_regions, false),
      coalesce(p_default_all_modules, false), coalesce(p_can_hold, true), coalesce(p_sort, 0), coalesce(p_active, true)) RETURNING id INTO rid;
    PERFORM public.idm_audit('role_created', 'role', rid::text, NULL, jsonb_build_object('code', p_code, 'name_en', p_name_en), p_reason);
  ELSE
    a := public.idm_actor('roles', 'edit');
    SELECT * INTO o FROM public.roles WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
    IF p_default_profile IS DISTINCT FROM o.default_profile_id AND public.idm_actor_holds_role(p_id) THEN
      RAISE EXCEPTION 'you cannot change the default profile of a role you hold' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.roles SET name_en = coalesce(p_name_en, name_en), name_ar = p_name_ar, description_en = p_desc_en, description_ar = p_desc_ar,
      team = coalesce(p_team, team), default_profile_id = p_default_profile,
      default_all_regions = coalesce(p_default_all_regions, default_all_regions), default_all_modules = coalesce(p_default_all_modules, default_all_modules),
      can_hold_matrix_levels = coalesce(p_can_hold, can_hold_matrix_levels), sort = coalesce(p_sort, sort), is_active = coalesce(p_active, is_active)
    WHERE id = p_id;
    PERFORM public.idm_audit('role_updated', 'role', p_id::text, to_jsonb(o), jsonb_build_object('name_en', p_name_en, 'is_active', p_active), p_reason);
  END IF;
  PERFORM public.idm_assert_role_within_actor(rid); -- post-state
  RETURN rid;
END $$;

-- Clear every parent link (the migration role is "seeding", so the identity backstop lets this through), then drop the column.
UPDATE roles SET parent_role_id = NULL WHERE parent_role_id IS NOT NULL;
ALTER TABLE roles DROP COLUMN parent_role_id;   -- also drops roles_parent_role_id_idx and roles_parent_role_id_fkey

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Stream-scoped snag blocking
-- ---------------------------------------------------------------------------------------------------------------------
-- The stream whose open snags block a task: CW for CW PAC (B13) and CW FAC (B15), TE for TE PAC (D16) and TE FAC (D18);
-- NULL for every other task. Task codes are stable across workflow versions.
-- Internal (not granted to the application role): no region gate, so the engine's check can never fail open.
CREATE OR REPLACE FUNCTION wf_snag_scope_of(p_task uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE td.code WHEN 'B13' THEN 'CW' WHEN 'B15' THEN 'CW' WHEN 'D16' THEN 'TE' WHEN 'D18' THEN 'TE' END
  FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id
  WHERE t.id = p_task
$$;

CREATE OR REPLACE FUNCTION wf_open_snags_of(p_task uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*)::int
  FROM public.task_instances t
  JOIN public.snags s ON s.site_id = t.site_id
  JOIN public.snag_types st ON st.id = s.snag_type_id
  WHERE t.id = p_task
    AND upper(btrim(s.scope)) = public.wf_snag_scope_of(p_task)
    AND s.status IN ('open', 'fix_uploaded', 'in_review')
    AND st.blocks_preliminary_acceptance
$$;

-- Read helpers for the task view: the same values, limited to tasks in the caller's regions.
CREATE OR REPLACE FUNCTION wf_snag_scope(p_task uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.wf_snag_scope_of(t.id) FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id)
$$;

-- Open snags of that stream on the task's site (not only those linked to the task); 0 for a task no snag can block.
-- Open = open, fix uploaded or in review (the fix is approved by the workflow before the snag closes).
CREATE OR REPLACE FUNCTION wf_open_snags(p_task uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.wf_open_snags_of(t.id) FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id)
$$;

-- Submit, review and approve share one function (0015); its old final-approval snag check is replaced by the stream rule.
CREATE OR REPLACE FUNCTION wf_complete(p_task uuid, p_version int, p_action text, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; n int; lvl int; k text; mode text;
  ch record; before jsonb; step_ids uuid[] := ARRAY[]::uuid[]; sk int; self boolean; unlocked uuid[] := ARRAY[]::uuid[];
  missing_f text[] := ARRAY[]::text[]; missing_s text[]; after_state public."TaskState"; v_left int; n_snags int; v_scope text; sid uuid; first boolean;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF (p_action = 'submit' AND t.state <> 'entry') OR (p_action = 'review' AND t.state <> 'in_review') OR (p_action = 'approve' AND t.state <> 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is ' || t.state::text || ': ' || p_action || ' is not possible now.'));
  END IF;
  before := public.wf_snap(p_task);
  first := t.path_frozen_at IS NULL;
  n := public.wf_task_levels(p_task);
  lvl := t.current_level;
  k := public.wf_kind(n, lvl);
  IF p_action = 'review' AND k <> 'review' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is at the approve level.')); END IF;
  IF p_action = 'approve' AND k <> 'approve' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is not at the approve level.')); END IF;
  PERFORM public.wf_require_grant(t.region_id, CASE k WHEN 'entry' THEN 'edit' WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  mode := public.wf_require_actor(p_task, k, actor);

  -- E6 / Q25: the four acceptances are blocked by the open snags of their own stream, whatever the action (submit, review, approve).
  v_scope := public.wf_snag_scope_of(p_task);
  IF v_scope IS NOT NULL THEN
    n_snags := public.wf_open_snags_of(p_task);
    IF n_snags > 0 THEN PERFORM public.wf_err('open_snags', jsonb_build_object('count', n_snags, 'scope', v_scope)); END IF;
  END IF;

  IF p_action = 'submit' THEN
    IF t.actual_date IS NULL THEN missing_f := ARRAY['actual_date']; END IF;
    IF cardinality(missing_f) > 0 THEN PERFORM public.wf_err('mandatory_fields_missing', jsonb_build_object('missing', to_jsonb(missing_f))); END IF;
    missing_s := public.wf_missing_slots(p_task);
    IF cardinality(missing_s) > 0 THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(missing_s))); END IF;
    IF first THEN
      UPDATE public.task_instances SET levels_required = n, path_frozen_at = now() WHERE id = p_task;   -- B7
    END IF;
  END IF;

  -- all_members: record the vote; the level completes with the last vote
  IF mode = 'vote' THEN
    UPDATE public.task_level_voters SET voted_at = now() WHERE task_id = p_task AND level = lvl AND round = t.level_round AND user_id = actor;
    SELECT count(*) INTO v_left FROM public.task_level_voters WHERE task_id = p_task AND level = lvl AND round = t.level_round AND voted_at IS NULL;
    IF v_left > 0 THEN
      sid := public.wf_step(p_task, lvl, p_action, actor, p_note, t.state, t.state, false, false);
      UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = p_task;
      PERFORM public.wf_audit('task_' || p_action || '_vote', p_task, before, public.wf_snap(p_task), p_note);
      RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb, 'votes_missing', v_left);
    END IF;
  END IF;

  SELECT * INTO ch FROM public.wf_chain(p_task, lvl, actor);
  IF ch.is_final THEN
    IF k <> 'approve' THEN PERFORM public.wf_require_grant(t.region_id, 'approve'); END IF;
    IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- B5 and the final approval
  END IF;

  self := ch.is_final AND (n = 1 OR n = ANY (ch.skipped));
  after_state := CASE WHEN ch.is_final THEN 'approved'
                      ELSE CASE public.wf_kind(n, ch.next_level) WHEN 'review' THEN 'in_review' WHEN 'approve' THEN 'in_approval' ELSE 'entry' END END;

  sid := public.wf_step(p_task, lvl, p_action, actor, p_note, t.state, after_state, coalesce(p_stepup, false) AND ch.is_final, self);
  step_ids := step_ids || sid;
  INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, lvl, actor, 'acted')
    ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  FOREACH sk IN ARRAY ch.skipped LOOP
    sid := public.wf_step(p_task, sk, 'auto_skip', actor, 'level skipped: same holder', t.state, after_state, false, self);
    step_ids := step_ids || sid;
    INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, sk, actor, 'skipped')
      ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'skipped', acted_at = now();
  END LOOP;

  IF p_action = 'submit' THEN
    UPDATE public.task_instances SET submitted_date = current_date WHERE id = p_task;
    UPDATE public.document_slots SET status = 'in_review', reject_reason = NULL WHERE task_id = p_task AND status = 'uploaded';
  END IF;

  IF ch.is_final THEN
    UPDATE public.task_instances SET state = 'approved', current_level = n, approved_date = current_date, ball_in_court_user_id = NULL,
      level_opened_at = NULL, self_approval = self WHERE id = p_task;
    UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
    UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
      WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
    unlocked := public.wf_unlock_successors(p_task);
  ELSE
    PERFORM public.wf_open_level(p_task, ch.next_level, NULL);
  END IF;
  UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = p_task;

  PERFORM public.wf_audit('task_' || p_action, p_task, before,
    public.wf_snap(p_task) || jsonb_build_object('skipped_levels', to_jsonb(ch.skipped), 'self_approval_flag', self), p_note);
  FOREACH sk IN ARRAY ch.skipped LOOP
    PERFORM public.wf_audit('task_auto_skip', p_task, jsonb_build_object('level', sk, 'holder', actor),
      jsonb_build_object('level', sk, 'skipped', true, 'reason', 'same holder', 'self_approval', self), 'level skipped: same holder');
  END LOOP;

  RETURN jsonb_build_object('step_ids', to_jsonb(step_ids), 'skipped_levels', to_jsonb(ch.skipped), 'unlocked_task_ids', to_jsonb(unlocked));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Ownership and execute rights (CREATE OR REPLACE keeps those of the existing functions; the new ones are set here)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION wf_snag_scope_of(uuid) OWNER TO pmis_definer;
ALTER FUNCTION wf_open_snags_of(uuid) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION wf_snag_scope_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION wf_open_snags_of(uuid) FROM PUBLIC;
ALTER FUNCTION wf_snag_scope(uuid) OWNER TO pmis_definer;
ALTER FUNCTION wf_open_snags(uuid) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION wf_snag_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION wf_open_snags(uuid) FROM PUBLIC;
DO $$
BEGIN
  -- the task view shows the open-snag count as a lock reason
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION wf_open_snags(uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION wf_snag_scope(uuid) TO pmis_app;
  END IF;
END $$;
