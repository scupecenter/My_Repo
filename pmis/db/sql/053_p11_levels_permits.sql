-- 0054_p11_levels_permits: work package P11 of the owner answers of 2026-11-04 (docs/spec/owner-answers-2026-11-04.md Q215, Q216, Q217, Q220, Q221, Q222, and
-- the owner decision D220b of docs/plans/2026-11-04-owner-answers-gap.md). Follows 0050_levels_convert_permits.
-- Mirror: db/sql/053_p11_levels_permits.sql (kept identical to prisma/migrations/0054_p11_levels_permits/migration.sql).
--
--   1. The conversion record (Q215, Q216). New table levels_conversions: one row per item that left an old path (3 levels in 0050, 1 level here), with the
--      time, the migration, the reason, the snapshot of the old path (the audit "before", including the dropped level actors and votes), the people told and
--      when. The 0050 conversions are filled in from their audit rows. pmis_app reads it (the history label); nobody but the definer functions writes it.
--   2. Q215: every converted item gets a one-off in-app notice (kind `levels_converted`) to the old reviewer (the level-2 actors and voters, the reviewer the item
--      was pinned to, and the review-cell holders when it was waiting at review) and to the entry person (the level-1 actors, the last submitter, the record's
--      creator; the L1 holders when nobody entered it yet), saying what changed and who is asked now. Sent once (levels_conversions.notified_at); the items
--      0050 already converted are told by this migration. A closed item (approved, N/A, skipped, voided) is not told.
--   3. Q216: the history of a task or record marks the steps of the old path (level 2 and 3, recorded before the conversion) as `previous_path`; the API and the
--      screens label them "previous path before conversion". The steps are never changed.
--   4. Q217: levels_convert_two() also converts open items frozen on a 1-level snapshot (path frozen, levels_required = 1, not approved / N/A / skipped /
--      voided) to L1 / L2. A dry run lists them first (the impact report, `one_level_items`); the migration writes that report to the audit log
--      (`levels_conversion_impact`) before it converts. An item whose L2 has no holder is converted and HELD: levels_conversions.held, the System Admins get a
--      setup alert (`no_eligible_holder`), and its submission is refused (422 `empty_cell`) until the Responsibility Matrix names an L2 holder; the hold is
--      then released (audited). No approver is invented.
--   5. Q220 and D220b: permit_types.stream allows CW, TE, ACQ (the shared Acquisition / RF & Design stream) and OM (O&M). New column
--      permit_types.stream_options: the streams a purpose-based type may be entered on; the person entering the permit chooses (new register field
--      `permit_stream`, required for those types). Fixed: Access / PTW - CW -> CW, Access / PTW - TE -> TE, City Council and Civil Aviation -> ACQ.
--      By purpose: Access / PTW - Dismantle (CW or TE), Access - Survey (ACQ or CW), Access - QC / Maintenance (CW, TE or OM), Security Clearance and
--      Other Permit (any). The stream decides the Matrix row: CW -> permits_hse, TE -> permits_hse_te, ACQ -> permits_hse_acq, OM -> permits_hse_om (two new
--      Matrix-only rows; defaults: ACQ L1 = Acquisition Team and RF Engineer, L2 = RF & Design / Acquisition Team Lead; O&M has no holder until the admin names
--      one, B10). The entry-holder trigger refuses a missing (`stream_required`), unknown (`stream_not_allowed`) or contradicting (`stream_fixed`) stream.
--      A new version of a record entered before the choice existed may be opened by an L1 holder of any of its type's streams; the stream is chosen before save.
--   6. Q221: the entry-holder check of a permit runs at every save of a draft (not only when its row changes) and again at submit (trigger
--      b_reg_permit_submit). A draft held by somebody who is no longer qualified is moved: reg_permit_transfer() (the API's
--      POST /registers/permits_hse/records/{id}/transfer, asked by that person or taken over by a qualified holder) and permit_drafts_recheck() (run by this
--      migration over every open permit draft) pin it to the only qualified holder (or leave it open to all of them), tell them and the previous holder
--      (kind `permit_transferred`), and write a step `transfer` and an audit row. Nothing is deleted; approved records keep their history.
--   7. Q222: reg_entry_permit_types() returns the permit types the caller may enter (with the streams they may choose); the catalogue sends it as
--      `entry_permit_types`, and the form shows only those. The database still decides on every write.
--   8. Ownership: every function is owned by pmis_definer, SECURITY DEFINER with a fixed search_path, closed to PUBLIC; pmis_app may call
--      reg_entry_permit_types() and reg_permit_transfer() and reads levels_conversions. pmis_app stays read-only on every table touched here.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The conversion record
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE levels_conversions (
  entity_type      text NOT NULL CHECK (entity_type IN ('task', 'register_record')),
  entity_id        uuid NOT NULL,
  site_id          uuid,
  region_id        integer,
  converted_at     timestamptz NOT NULL,
  levels_before    integer NOT NULL CHECK (levels_before IN (1, 3)),
  migration        text NOT NULL,
  reason           text NOT NULL,
  old_path         jsonb NOT NULL DEFAULT '{}'::jsonb,
  people           jsonb NOT NULL DEFAULT '{}'::jsonb,
  audit_id         bigint,
  notified_at      timestamptz,
  notified_users   uuid[],
  held             boolean NOT NULL DEFAULT false,
  hold_released_at timestamptz,
  PRIMARY KEY (entity_type, entity_id)
);
COMMENT ON TABLE levels_conversions IS '0054 (Q215-Q217): one row per task or register record moved from an old 3-level or 1-level path to L1/L2: when, by which migration and why, the old path snapshot, who was told (once), and the hold of a converted item without an L2 holder.';
CREATE INDEX levels_conversions_held ON levels_conversions (entity_type, entity_id) WHERE held AND hold_released_at IS NULL;

ALTER TABLE levels_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE levels_conversions FORCE ROW LEVEL SECURITY;
-- read like the item itself: the region filter of task_instances / register_records applies inside the subquery
CREATE POLICY rls_select ON levels_conversions FOR SELECT USING (
  (entity_type = 'task' AND EXISTS (SELECT 1 FROM task_instances t WHERE t.id = levels_conversions.entity_id))
  OR (entity_type = 'register_record' AND EXISTS (SELECT 1 FROM register_records r WHERE r.id = levels_conversions.entity_id)));
CREATE POLICY rls_seed_write ON levels_conversions FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
GRANT SELECT, INSERT, UPDATE ON levels_conversions TO pmis_definer;

-- the step of a draft that was moved to a qualified holder (Q221)
ALTER TABLE register_steps DROP CONSTRAINT IF EXISTS register_steps_action_check;
ALTER TABLE register_steps ADD CONSTRAINT register_steps_action_check
  CHECK (action IN ('create', 'edit', 'submit', 'review', 'approve', 'reject', 'auto_skip', 'claim', 'release', 'new_version', 'void', 'transfer'));

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Who is told about a conversion (Q215)
-- ---------------------------------------------------------------------------------------------------------------------
-- The old reviewers and the entry people of a converted item, from the audit snapshot of the old path (p_before, with `dropped`) and the history.
CREATE OR REPLACE FUNCTION levels_conv_people(p_type text, p_id uuid, p_before jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rev uuid[] := ARRAY[]::uuid[]; ent uuid[] := ARRAY[]::uuid[]; waiting boolean := coalesce(p_before ->> 'state', '') = 'in_review';
BEGIN
  rev := ARRAY(
    SELECT (a ->> 'user_id')::uuid FROM jsonb_array_elements(coalesce(p_before -> 'dropped' -> 'level_actors', '[]'::jsonb)) a WHERE (a ->> 'level')::int = 2 AND a ->> 'user_id' IS NOT NULL
    UNION SELECT (v ->> 'user_id')::uuid FROM jsonb_array_elements(coalesce(p_before -> 'dropped' -> 'voters', '[]'::jsonb)) v WHERE (v ->> 'level')::int = 2 AND v ->> 'user_id' IS NOT NULL
    UNION SELECT (p_before ->> 'pinned_to')::uuid WHERE waiting AND p_before ->> 'pinned_to' IS NOT NULL);
  IF p_type = 'task' THEN
    IF waiting THEN rev := rev || ARRAY(SELECT e.user_id FROM public.wf_eligible(p_id, 'review') e ORDER BY e.user_id LIMIT 20); END IF;
    ent := ARRAY(
      SELECT a.user_id FROM public.task_level_actors a WHERE a.task_id = p_id AND a.level = 1 AND a.user_id IS NOT NULL
      UNION SELECT s.acted_by FROM (SELECT w.acted_by FROM public.workflow_steps w WHERE w.task_id = p_id AND w.action::text = 'submit' AND w.acted_by IS NOT NULL
                                    ORDER BY w.created_at DESC, w.id DESC LIMIT 1) s);
    IF cardinality(ent) = 0 THEN ent := ARRAY(SELECT e.user_id FROM public.wf_eligible(p_id, 'entry') e ORDER BY e.user_id LIMIT 20); END IF;
  ELSE
    IF waiting THEN rev := rev || ARRAY(SELECT e.user_id FROM public.reg_eligible(p_id, 'review') e ORDER BY e.user_id LIMIT 20); END IF;
    ent := ARRAY(
      SELECT a.user_id FROM public.register_level_actors a WHERE a.record_id = p_id AND a.level = 1 AND a.user_id IS NOT NULL
      UNION SELECT s.acted_by FROM (SELECT w.acted_by FROM public.register_steps w WHERE w.record_id = p_id AND w.action = 'submit' AND w.acted_by IS NOT NULL
                                    ORDER BY w.created_at DESC, w.id DESC LIMIT 1) s
      UNION SELECT r.created_by FROM public.register_records r WHERE r.id = p_id AND r.created_by IS NOT NULL);
    IF cardinality(ent) = 0 THEN ent := ARRAY(SELECT e.user_id FROM public.reg_eligible(p_id, 'entry') e ORDER BY e.user_id LIMIT 20); END IF;
  END IF;
  RETURN jsonb_build_object('old_reviewers', to_jsonb(ARRAY(SELECT DISTINCT x FROM unnest(rev) x ORDER BY 1)),
                            'entry_people', to_jsonb(ARRAY(SELECT DISTINCT x FROM unnest(ent) x ORDER BY 1)));
END $$;

-- The one-off notice of a conversion. Returns how many people were told (0 when the notice went out before or the item is closed).
CREATE OR REPLACE FUNCTION levels_conversion_notify(p_type text, p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c public.levels_conversions%ROWTYPE; st text; lvl int; label text; names text; asked text; body text; whom uuid[]; u uuid; told uuid[] := ARRAY[]::uuid[]; has_l2 boolean;
BEGIN
  SELECT * INTO c FROM public.levels_conversions WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND OR c.notified_at IS NOT NULL THEN RETURN 0; END IF;
  IF p_type = 'task' THEN
    SELECT t.state::text, t.current_level INTO st, lvl FROM public.task_instances t WHERE t.id = p_id;
    label := public.wf_label(p_id);
    SELECT string_agg(x.display_name, ', ' ORDER BY x.display_name) INTO names
    FROM (SELECT u2.display_name FROM public.wf_eligible(p_id, 'approve') e JOIN public.users u2 ON u2.id = e.user_id ORDER BY u2.display_name LIMIT 3) x;
    has_l2 := public.wf_has_holder(p_id, 'approve');
  ELSE
    SELECT r.state, r.current_level INTO st, lvl FROM public.register_records r WHERE r.id = p_id;
    label := public.reg_label(p_id);
    SELECT string_agg(x.display_name, ', ' ORDER BY x.display_name) INTO names
    FROM (SELECT u2.display_name FROM public.reg_eligible(p_id, 'approve') e JOIN public.users u2 ON u2.id = e.user_id ORDER BY u2.display_name LIMIT 3) x;
    has_l2 := public.reg_has_holder(p_id, 'approve');
  END IF;
  IF st IS NULL OR st IN ('approved', 'na', 'skipped', 'voided') THEN
    UPDATE public.levels_conversions SET notified_at = now(), notified_users = ARRAY[]::uuid[] WHERE entity_type = p_type AND entity_id = p_id;
    RETURN 0;
  END IF;
  asked := CASE
    WHEN c.held AND c.hold_released_at IS NULL AND NOT has_l2 THEN 'It is held until the Responsibility Matrix names an L2 holder (the System Admins were alerted).'
    WHEN st IN ('in_review', 'in_approval') THEN 'It now waits for L2 (Data Reviewer & Approver): ' || coalesce(names, 'nobody yet (the System Admins were alerted)') || '.'
    ELSE 'It is at L1 (Data Entry); after submission it goes to L2 (Data Reviewer & Approver): ' || coalesce(names, 'nobody yet') || '.' END;
  body := label || ': ' || CASE WHEN c.levels_before = 3
    THEN 'the approval path is now two levels (owner decision). The old review level was dropped; its acts stay in the history as "previous path before conversion". '
    ELSE 'this item had one level (self-approval) and now has two levels, L1 and L2 (owner decision). ' END || asked;
  whom := ARRAY(SELECT DISTINCT (x #>> '{}')::uuid FROM jsonb_array_elements(coalesce(c.people -> 'old_reviewers', '[]'::jsonb) || coalesce(c.people -> 'entry_people', '[]'::jsonb)) x);
  FOR u IN SELECT x.id FROM public.users x WHERE x.id = ANY (whom) AND x.status = 'active' AND x.deleted_at IS NULL ORDER BY x.id LIMIT 40 LOOP
    IF p_type = 'task' THEN PERFORM public.wf_notify(u, 'levels_converted', 'Approval path changed to two levels', body, p_id);
    ELSE PERFORM public.reg_notify(u, 'levels_converted', 'Approval path changed to two levels', body, p_id); END IF;
    told := told || u;
  END LOOP;
  UPDATE public.levels_conversions SET notified_at = now(), notified_users = told WHERE entity_type = p_type AND entity_id = p_id;
  RETURN cardinality(told);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The conversion (0050 extended): 3-level items as before, plus 1-level items (Q217), with the conversion record and the notices (Q215)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION levels_convert_two(p_dry_run boolean DEFAULT false, p_sites uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t public.task_instances%ROWTYPE; r public.register_records%ROWTYPE;
  c_t int := 0; c_t1 int := 0; c_t2 int := 0; c_t3 int := 0; c_r int := 0; c_r1 int := 0; c_r2 int := 0; c_r3 int := 0; c_cells int := 0;
  o_t int := 0; o_th int := 0; o_r int := 0; o_rh int := 0; told int := 0; items jsonb := '[]'::jsonb;
  b jsonb; hist jsonb; new_level int; new_state text; rl public."MatrixRule"; h record; pin uuid; nround int; aid bigint; held boolean;
  reason constant text := 'owner decision: two levels';
  reason1 constant text := 'owner decision: two levels (Q217, item on a one-level snapshot)';
BEGIN
  PERFORM set_config('app.region_ids', '*', true);

  -- tasks on 3 levels (0050)
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
    b := b || jsonb_build_object('dropped', hist);
    -- who is told is decided on the old path, before it changes
    INSERT INTO public.levels_conversions (entity_type, entity_id, site_id, region_id, converted_at, levels_before, migration, reason, old_path, people)
    VALUES ('task', t.id, t.site_id, t.region_id, clock_timestamp(), 3, '0054', reason, b, public.levels_conv_people('task', t.id, b))
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
    new_level := least(t.current_level, 2);
    new_state := CASE WHEN t.state = 'in_review' THEN 'in_approval' ELSE t.state::text END;
    pin := t.ball_in_court_user_id;
    nround := t.level_round;
    DELETE FROM public.task_level_actors a WHERE a.task_id = t.id AND a.level >= 2;
    UPDATE public.task_instances SET levels_required = 2 WHERE id = t.id;
    IF t.current_level = 2 AND t.state = 'in_review' THEN
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
    VALUES ('levels_converted_two', 'task', t.id::text, t.site_id, t.region_id, b,
            public.wf_snap(t.id) || jsonb_build_object('l2_holders', 'old final approvers (matrix level 3 cells)'), reason, public.app_actor())
    RETURNING id INTO aid;
    UPDATE public.levels_conversions SET audit_id = aid WHERE entity_type = 'task' AND entity_id = t.id;
    IF t.state = 'in_review' THEN
      FOR h IN SELECT e.user_id FROM public.wf_eligible(t.id, 'approve') e ORDER BY e.user_id LIMIT 20 LOOP
        PERFORM public.wf_notify(h.user_id, 'task_assigned', 'A task is waiting for your approval (L2)', public.wf_label(t.id), t.id);
      END LOOP;
      IF NOT public.wf_has_holder(t.id, 'approve') THEN
        PERFORM public.wf_notify_admins('no_eligible_holder', 'No holder for a task level', public.wf_label(t.id) || ': nobody can act on the approve level.', t.id);
      END IF;
    END IF;
    told := told + public.levels_conversion_notify('task', t.id);
  END LOOP;

  -- tasks on 1 level (Q217): open, frozen on a one-level snapshot
  FOR t IN SELECT * FROM public.task_instances x WHERE x.levels_required = 1 AND x.path_frozen_at IS NOT NULL AND x.state NOT IN ('approved', 'na', 'skipped')
           AND (p_sites IS NULL OR x.site_id = ANY (p_sites)) ORDER BY x.id FOR UPDATE LOOP
    held := NOT public.wf_has_holder(t.id, 'approve');
    o_t := o_t + 1;
    IF held THEN o_th := o_th + 1; END IF;
    IF p_dry_run THEN
      IF jsonb_array_length(items) < 500 THEN
        items := items || jsonb_build_array(jsonb_build_object('entity_type', 'task', 'id', t.id, 'label', public.wf_label(t.id), 'state', t.state, 'l2_holder', NOT held));
      END IF;
      CONTINUE;
    END IF;
    b := public.wf_snap(t.id);
    INSERT INTO public.levels_conversions (entity_type, entity_id, site_id, region_id, converted_at, levels_before, migration, reason, old_path, people, held)
    VALUES ('task', t.id, t.site_id, t.region_id, clock_timestamp(), 1, '0054', reason1, b, public.levels_conv_people('task', t.id, b), held)
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
    UPDATE public.task_instances SET levels_required = 2, current_level = least(greatest(current_level, 0), 1), version = version + 1, updated_at = now() WHERE id = t.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('levels_converted_two', 'task', t.id::text, t.site_id, t.region_id, b, public.wf_snap(t.id) || jsonb_build_object('held', held), reason1, public.app_actor())
    RETURNING id INTO aid;
    UPDATE public.levels_conversions SET audit_id = aid WHERE entity_type = 'task' AND entity_id = t.id;
    IF held THEN
      PERFORM public.wf_notify_admins('no_eligible_holder', 'Set an L2 holder: a converted task is held',
        public.wf_label(t.id) || ': it was converted to two levels (Q217) and nobody holds its L2. It cannot be submitted until the Responsibility Matrix names one.', t.id);
    END IF;
    told := told + public.levels_conversion_notify('task', t.id);
  END LOOP;

  -- register records on 3 levels (0050)
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
    b := b || jsonb_build_object('dropped', hist);
    INSERT INTO public.levels_conversions (entity_type, entity_id, site_id, region_id, converted_at, levels_before, migration, reason, old_path, people)
    VALUES ('register_record', r.id, r.site_id, r.region_id, clock_timestamp(), 3, '0054', reason, b, public.levels_conv_people('register_record', r.id, b))
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
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
    VALUES ('levels_converted_two', 'register_record', r.id::text, r.site_id, r.region_id, b,
            public.reg_snap(r.id) || jsonb_build_object('l2_holders', 'old final approvers (matrix level 3 cells)'), reason, public.app_actor())
    RETURNING id INTO aid;
    UPDATE public.levels_conversions SET audit_id = aid WHERE entity_type = 'register_record' AND entity_id = r.id;
    IF r.state = 'in_review' THEN
      FOR h IN SELECT e.user_id FROM public.reg_eligible(r.id, 'approve') e ORDER BY e.user_id LIMIT 20 LOOP
        PERFORM public.reg_notify(h.user_id, 'task_assigned', 'A record is waiting for your approval (L2)', public.reg_label(r.id), r.id);
      END LOOP;
      IF NOT public.reg_has_holder(r.id, 'approve') THEN
        PERFORM public.reg_notify_admins('no_eligible_holder', 'No holder for a register level', public.reg_label(r.id) || ': nobody can act on the approve level.', r.id);
      END IF;
    END IF;
    told := told + public.levels_conversion_notify('register_record', r.id);
  END LOOP;

  -- register records on 1 level (Q217)
  FOR r IN SELECT * FROM public.register_records x WHERE x.levels_required = 1 AND x.path_frozen_at IS NOT NULL AND x.state NOT IN ('approved', 'voided')
           AND (p_sites IS NULL OR x.site_id = ANY (p_sites)) ORDER BY x.id FOR UPDATE LOOP
    held := NOT public.reg_has_holder(r.id, 'approve');
    o_r := o_r + 1;
    IF held THEN o_rh := o_rh + 1; END IF;
    IF p_dry_run THEN
      IF jsonb_array_length(items) < 500 THEN
        items := items || jsonb_build_array(jsonb_build_object('entity_type', 'register_record', 'id', r.id, 'label', public.reg_label(r.id), 'state', r.state, 'l2_holder', NOT held));
      END IF;
      CONTINUE;
    END IF;
    b := public.reg_snap(r.id);
    INSERT INTO public.levels_conversions (entity_type, entity_id, site_id, region_id, converted_at, levels_before, migration, reason, old_path, people, held)
    VALUES ('register_record', r.id, r.site_id, r.region_id, clock_timestamp(), 1, '0054', reason1, b, public.levels_conv_people('register_record', r.id, b), held)
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
    UPDATE public.register_records SET levels_required = 2, current_level = 1, version = version + 1, updated_at = now() WHERE id = r.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('levels_converted_two', 'register_record', r.id::text, r.site_id, r.region_id, b, public.reg_snap(r.id) || jsonb_build_object('held', held), reason1, public.app_actor())
    RETURNING id INTO aid;
    UPDATE public.levels_conversions SET audit_id = aid WHERE entity_type = 'register_record' AND entity_id = r.id;
    IF held THEN
      PERFORM public.reg_notify_admins('no_eligible_holder', 'Set an L2 holder: a converted record is held',
        public.reg_label(r.id) || ': it was converted to two levels (Q217) and nobody holds its L2. It cannot be submitted until the Responsibility Matrix names one.', r.id);
    END IF;
    told := told + public.levels_conversion_notify('register_record', r.id);
  END LOOP;

  -- cell level 2 is retired once no open item can read it (a run limited to some sites leaves the cells alone)
  IF NOT p_dry_run AND p_sites IS NULL THEN
    UPDATE public.matrix_cells SET retired_at = now() WHERE level = 2 AND retired_at IS NULL;
    GET DIAGNOSTICS c_cells = ROW_COUNT;
    IF c_t + c_r + o_t + o_r + c_cells > 0 THEN
      UPDATE public.matrix_state SET revision = revision + 1, updated_at = now();
      INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
      VALUES ('levels_conversion_run', 'workflow', NULL,
              jsonb_build_object('tasks', c_t, 'tasks_at_l1', c_t1, 'tasks_from_review', c_t2, 'tasks_at_approve', c_t3,
                                 'records', c_r, 'records_at_l1', c_r1, 'records_from_review', c_r2, 'records_at_approve', c_r3, 'cells_retired', c_cells,
                                 'one_level_tasks', o_t, 'one_level_tasks_held', o_th, 'one_level_records', o_r, 'one_level_records_held', o_rh, 'people_told', told),
              reason, public.app_actor());
    END IF;
  END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'tasks', c_t, 'tasks_at_l1', c_t1, 'tasks_from_review', c_t2, 'tasks_at_approve', c_t3,
                            'records', c_r, 'records_at_l1', c_r1, 'records_from_review', c_r2, 'records_at_approve', c_r3, 'cells_retired', c_cells,
                            'one_level_tasks', o_t, 'one_level_tasks_held', o_th, 'one_level_records', o_r, 'one_level_records_held', o_rh,
                            'people_told', told)
         || CASE WHEN p_dry_run THEN jsonb_build_object('one_level_items', items) ELSE '{}'::jsonb END;
END $$;

-- The hold of a converted item without an L2 holder (Q217): its submission is refused until the Matrix names one; then the hold is released (audited).
CREATE OR REPLACE FUNCTION levels_hold_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind text := TG_ARGV[0]; has_l2 boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.levels_conversions c WHERE c.entity_type = kind AND c.entity_id = NEW.id AND c.held AND c.hold_released_at IS NULL) THEN RETURN NEW; END IF;
  has_l2 := CASE WHEN kind = 'task' THEN public.wf_has_holder(NEW.id, 'approve') ELSE public.reg_has_holder(NEW.id, 'approve') END;
  IF NOT has_l2 THEN
    PERFORM public.wf_err('empty_cell', jsonb_build_object('detail',
      'This item was converted to two levels (owner decision Q217) and nobody holds its L2 (Data Reviewer & Approver): it is held until the Responsibility Matrix names one.'));
  END IF;
  UPDATE public.levels_conversions SET hold_released_at = now() WHERE entity_type = kind AND entity_id = NEW.id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES ('levels_hold_released', kind, NEW.id::text, NEW.site_id, NEW.region_id, jsonb_build_object('held', true), jsonb_build_object('held', false),
          'an L2 holder is now named in the Responsibility Matrix (Q217)', public.app_actor());
  RETURN NEW;
END $$;
CREATE TRIGGER b_levels_hold BEFORE UPDATE OF state ON task_instances FOR EACH ROW
  WHEN (NEW.state IN ('in_review', 'in_approval', 'approved') AND OLD.state NOT IN ('in_review', 'in_approval', 'approved')) EXECUTE FUNCTION levels_hold_guard('task');
CREATE TRIGGER b_levels_hold BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (NEW.state IN ('in_review', 'in_approval', 'approved') AND OLD.state NOT IN ('in_review', 'in_approval', 'approved')) EXECUTE FUNCTION levels_hold_guard('register_record');

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Permits per stream (Q220, D220b)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE permit_types DROP CONSTRAINT IF EXISTS permit_types_stream_check;
ALTER TABLE permit_types ADD CONSTRAINT permit_types_stream_check CHECK (stream IN ('CW', 'TE', 'ACQ', 'OM'));
ALTER TABLE permit_types ADD COLUMN IF NOT EXISTS stream_options text[];
ALTER TABLE permit_types ADD CONSTRAINT permit_types_stream_options_check
  CHECK (stream_options IS NULL OR (cardinality(stream_options) >= 2 AND stream_options <@ ARRAY['CW', 'TE', 'ACQ', 'OM']::text[] AND stream IS NULL));
COMMENT ON COLUMN permit_types.stream IS '0050/0054: the fixed stream whose team enters the permit (Q90, Q220): CW, TE, ACQ (Acquisition / RF & Design) or OM; NULL with stream_options = chosen per permit.';
COMMENT ON COLUMN permit_types.stream_options IS '0054 (D220b): the streams a purpose-based type may be entered on; the person entering the permit chooses one (register field permit_stream, required).';

UPDATE permit_types SET stream = 'ACQ', stream_options = NULL WHERE code IN ('City Council Permit', 'Civil Aviation Authority Permit') AND stream IS NULL;
UPDATE permit_types SET stream = NULL, stream_options = ARRAY['CW', 'TE'] WHERE code IN ('Access - Dismantle', 'PTW - Dismantle') AND stream IS NULL;
UPDATE permit_types SET stream = NULL, stream_options = ARRAY['ACQ', 'CW'] WHERE code = 'Access - Survey' AND stream IS NULL;
UPDATE permit_types SET stream = NULL, stream_options = ARRAY['CW', 'TE', 'OM'] WHERE code = 'Access - QC / Maintenance' AND stream IS NULL;
UPDATE permit_types SET stream = NULL, stream_options = ARRAY['CW', 'TE', 'ACQ', 'OM'] WHERE code IN ('Security Clearance', 'Other Permit') AND stream IS NULL;

INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('permits_hse_acq', 'Permits & HSE - Acquisition / RF & Design stream', 'التصاريح والسلامة - مسار الاستحواذ / التصميم', 'permits_hse', 'register', true, true, ARRAY[]::text[], 2,
   '{"scope_of": "permits_hse", "scope": "ACQ"}'::jsonb, false, 52),
  ('permits_hse_om', 'Permits & HSE - O&M stream', 'التصاريح والسلامة - مسار التشغيل والصيانة', 'permits_hse', 'register', true, true, ARRAY[]::text[], 2,
   '{"scope_of": "permits_hse", "scope": "OM"}'::jsonb, false, 53)
ON CONFLICT (register_key) DO NOTHING;
UPDATE register_definitions
SET rules = rules || jsonb_build_object('scope_rows', coalesce(rules -> 'scope_rows', '{}'::jsonb) || '{"ACQ": "permits_hse_acq", "OM": "permits_hse_om"}'::jsonb)
WHERE register_key = 'permits_hse';

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('permits_hse', 'permit_stream', 'Stream (by purpose)', 'المسار (حسب الغرض)', 'list', false, false, false, '["CW", "TE", "ACQ", "OM"]'::jsonb, true, 'Permit', 15)
ON CONFLICT (register_key, code) DO NOTHING;

-- The stream of a permit: the fixed stream of its type, else the stream chosen on the permit when the type allows it (NULL = none yet).
CREATE OR REPLACE FUNCTION reg_permit_stream(p_data jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(t.stream, CASE WHEN p_data ->> 'permit_stream' = ANY (t.stream_options) THEN p_data ->> 'permit_stream' END)
  FROM public.permit_types t WHERE t.code = p_data ->> 'permit_type'
$$;

-- What is wrong with the stream of a permit (an error list as reg_err_item), or NULL.
CREATE OR REPLACE FUNCTION reg_permit_stream_issue(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.permit_types%ROWTYPE; s text := nullif(btrim(coalesce(p_data ->> 'permit_stream', '')), '');
BEGIN
  SELECT * INTO t FROM public.permit_types x WHERE x.code = p_data ->> 'permit_type';
  IF NOT FOUND THEN RETURN NULL; END IF;   -- no or unknown type: the field rules answer
  IF t.stream_options IS NOT NULL THEN
    IF s IS NULL THEN
      RETURN public.reg_err_item('/data/permit_stream', 'stream_required',
        'Choose the stream of this ' || t.code || ' permit by its purpose (' || array_to_string(t.stream_options, ', ') || ').');
    ELSIF NOT (s = ANY (t.stream_options)) THEN
      RETURN public.reg_err_item('/data/permit_stream', 'stream_not_allowed', 'A ' || t.code || ' permit is entered on ' || array_to_string(t.stream_options, ', ') || ' only.');
    END IF;
    RETURN NULL;
  END IF;
  IF s IS NOT NULL AND s IS DISTINCT FROM coalesce(t.stream, 'CW') THEN
    RETURN public.reg_err_item('/data/permit_stream', 'stream_fixed', 'A ' || t.code || ' permit always belongs to the ' || coalesce(t.stream, 'CW') || ' stream.');
  END IF;
  RETURN NULL;
END $$;

-- The scope of a record: its `scope` field, or (rules.scope_from = 'permit_stream') the stream of the permit.
CREATE OR REPLACE FUNCTION reg_scope_of(p_key text, p_data jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN d.rules ->> 'scope_from' = 'permit_stream' THEN public.reg_permit_stream(p_data) ELSE p_data ->> 'scope' END
  FROM public.register_definitions d WHERE d.register_key = p_key
$$;

-- The Matrix row of a permit stream (CW and no stream: the Permits & HSE row itself).
CREATE OR REPLACE FUNCTION reg_permit_row(p_stream text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT s.register_key FROM public.register_definitions d JOIN public.register_definitions s ON s.register_key = d.rules -> 'scope_rows' ->> p_stream AND s.is_active
                   WHERE d.register_key = 'permits_hse'), 'permits_hse')
$$;

-- The entry-holder check (0042, 0050), extended: a permit is checked at every save of its draft (Q221) and its stream must be right (D220b).
CREATE OR REPLACE FUNCTION reg_scope_entry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); rk text; n int; holder boolean; sc text; issue jsonb; permit boolean := NEW.register_key = 'permits_hse'; opening boolean := false;
BEGIN
  IF public.app_is_seeding() OR actor IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = NEW.register_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object') THEN RETURN NEW; END IF;
  IF NEW.state <> 'entry' THEN RETURN NEW; END IF;
  rk := public.reg_row_key(NEW.register_key, NEW.data);
  IF permit THEN
    issue := public.reg_permit_stream_issue(NEW.data);
    -- a new version of a permit entered before the stream choice existed: it opens without a stream, which is chosen before it is saved
    opening := TG_OP = 'INSERT' AND NEW.supersedes_id IS NOT NULL AND issue IS NOT NULL AND issue -> 0 ->> 'code' = 'stream_required';
    IF issue IS NOT NULL AND NOT opening THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', issue)); END IF;
  ELSIF TG_OP = 'UPDATE' AND rk = public.reg_row_key(OLD.register_key, OLD.data) THEN
    RETURN NEW;
  END IF;
  sc := public.reg_scope_of(NEW.register_key, NEW.data);
  IF opening THEN
    SELECT count(DISTINCT h.user_id)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder
    FROM public.permit_types t CROSS JOIN LATERAL unnest(t.stream_options) o CROSS JOIN LATERAL public.reg_row_entry_holders(public.reg_permit_row(o), NEW.region_id) h
    WHERE t.code = NEW.data ->> 'permit_type';
  ELSE
    SELECT count(*)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder FROM public.reg_row_entry_holders(rk, NEW.region_id) h;
  END IF;
  IF NOT holder AND NOT (n = 0 AND public.app_user_is_system_admin(actor)) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail',
      'You are not an entry holder (L1) of the ' || coalesce((SELECT d.name_en FROM public.register_definitions d WHERE d.register_key = rk), rk)
      || ' row of the Matrix' || CASE WHEN sc IS NOT NULL THEN ' (' || CASE WHEN permit THEN 'stream ' ELSE 'scope ' END || sc || ')' ELSE '' END || '.'
      || CASE WHEN permit AND TG_OP = 'UPDATE' THEN ' Ask for a transfer of the draft to a qualified holder.' ELSE '' END));
  END IF;
  -- the claim pin of a new version follows the holders of its own row (one holder: nobody to claim against)
  IF TG_OP = 'INSERT' AND NEW.ball_in_court_user_id = actor AND n <= 1 THEN NEW.ball_in_court_user_id := NULL; END IF;
  RETURN NEW;
END $$;

-- Q221: the same check again at submit (the state leaves entry), whatever path submits it.
CREATE OR REPLACE FUNCTION reg_permit_submit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); rk text; n int; holder boolean; issue jsonb;
BEGIN
  IF public.app_is_seeding() OR actor IS NULL THEN RETURN NEW; END IF;
  issue := public.reg_permit_stream_issue(NEW.data);
  IF issue IS NOT NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', issue)); END IF;
  rk := public.reg_row_key(NEW.register_key, NEW.data);
  SELECT count(*)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder FROM public.reg_row_entry_holders(rk, NEW.region_id) h;
  IF NOT holder AND NOT (n = 0 AND public.app_user_is_system_admin(actor)) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail',
      'You are no longer an entry holder (L1) of the ' || coalesce((SELECT d.name_en FROM public.register_definitions d WHERE d.register_key = rk), rk)
      || ' row of the Matrix, so you cannot submit this permit. Ask for a transfer of the draft to a qualified holder.'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_reg_permit_submit BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (NEW.register_key = 'permits_hse' AND OLD.state = 'entry' AND NEW.state IN ('in_review', 'in_approval', 'approved')) EXECUTE FUNCTION reg_permit_submit_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Moving a draft to a qualified holder (Q221)
-- ---------------------------------------------------------------------------------------------------------------------
-- Pins the draft to p_target (NULL: open to every qualified holder), writes the step, tells the qualified holders and the previous holder (or the System
-- Admins when nobody qualifies) and audits. Internal: called by reg_permit_transfer and permit_drafts_recheck.
CREATE OR REPLACE FUNCTION reg_permit_move(p_record uuid, p_prev uuid, p_target uuid, p_holders uuid[], p_note text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb; label text; rowname text; u uuid; body text;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  before := public.reg_snap(p_record);
  UPDATE public.register_records SET ball_in_court_user_id = p_target, version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.reg_step(p_record, 1, 'transfer', actor, coalesce(p_note, p_reason), 'entry', 'entry', false, false);
  label := public.reg_label(p_record);
  SELECT d.name_en INTO rowname FROM public.register_definitions d WHERE d.register_key = public.reg_row_key(r.register_key, r.data);
  body := label || ': the draft is now with the entry holders of the ' || coalesce(rowname, 'Permits & HSE') || ' row'
          || CASE WHEN p_target IS NOT NULL THEN ' (' || coalesce((SELECT x.display_name FROM public.users x WHERE x.id = p_target), 'one holder') || ')' ELSE '' END
          || '. Nothing in it was lost.' || CASE WHEN p_note IS NOT NULL THEN ' Note: ' || p_note ELSE '' END;
  FOR u IN SELECT x FROM unnest(p_holders) x WHERE x IS DISTINCT FROM actor ORDER BY 1 LIMIT 20 LOOP
    PERFORM public.reg_notify(u, 'permit_transferred', 'A permit draft was moved to you', body, p_record);
  END LOOP;
  IF p_prev IS NOT NULL AND p_prev IS DISTINCT FROM actor AND NOT (p_prev = ANY (p_holders))
     AND EXISTS (SELECT 1 FROM public.users x WHERE x.id = p_prev AND x.status = 'active' AND x.deleted_at IS NULL) THEN
    PERFORM public.reg_notify(p_prev, 'permit_transferred', 'Your permit draft was moved', body, p_record);
  END IF;
  IF cardinality(p_holders) = 0 THEN
    PERFORM public.reg_notify_admins('no_eligible_holder', 'No holder for a permit draft', label || ': nobody holds L1 of the ' || coalesce(rowname, 'Permits & HSE') || ' row.', p_record);
  END IF;
  IF actor IS NOT NULL THEN
    PERFORM public.log_audit_write('register_record_transfer', 'register_record', p_record::text, before, public.reg_snap(p_record), coalesce(p_note, p_reason), r.site_id, r.region_id, NULL);
  ELSE
    PERFORM public.reg_audit('register_record_transfer', p_record, before, public.reg_snap(p_record), p_reason);
  END IF;
END $$;

-- The API's transfer: the person who holds the draft and no longer qualifies hands it over, or a qualified holder takes over a draft held by such a person.
CREATE OR REPLACE FUNCTION reg_permit_transfer(p_record uuid, p_version int, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; holders uuid[]; prev uuid; target uuid; note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF r.register_key <> 'permits_hse' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a Permits & HSE draft can be transferred.')); END IF;
  IF r.state <> 'entry' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a draft (in entry) can be transferred; it is ' || r.state || '.')); END IF;
  IF length(note) > 2000 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/note', 'too_long', 'Up to 2000 characters.'))); END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'view');
  holders := ARRAY(SELECT h.user_id FROM public.reg_row_entry_holders(public.reg_row_key(r.register_key, r.data), r.region_id) h ORDER BY h.user_id);
  prev := coalesce(r.ball_in_court_user_id, r.created_by);
  IF actor = ANY (holders) THEN
    IF r.ball_in_court_user_id IS NULL OR r.ball_in_court_user_id = ANY (holders) THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nobody who lost the right to enter it holds this draft: there is nothing to transfer.'));
    END IF;
    target := actor;   -- a qualified holder takes it over
  ELSE
    IF actor IS DISTINCT FROM prev THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who holds this draft, or an entry holder (L1) of its row, can transfer it.'));
    END IF;
    target := CASE WHEN cardinality(holders) = 1 THEN holders[1] END;
  END IF;
  PERFORM public.reg_permit_move(p_record, prev, target, holders, note, 'the holder of the draft is no longer an entry holder of its row (Q221)');
  RETURN jsonb_build_object('step_ids', '[]'::jsonb, 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

-- Every open permit draft whose holder (its pin, else its creator) is no longer an entry holder of its row is moved (run by this migration; not for the API).
CREATE OR REPLACE FUNCTION permit_drafts_recheck(p_dry_run boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; holders uuid[]; prev uuid; n int := 0; ids jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.region_ids', '*', true);
  FOR r IN SELECT * FROM public.register_records x WHERE x.register_key = 'permits_hse' AND x.state = 'entry' ORDER BY x.id FOR UPDATE LOOP
    prev := coalesce(r.ball_in_court_user_id, r.created_by);
    CONTINUE WHEN prev IS NULL;
    holders := ARRAY(SELECT h.user_id FROM public.reg_row_entry_holders(public.reg_row_key(r.register_key, r.data), r.region_id) h ORDER BY h.user_id);
    CONTINUE WHEN prev = ANY (holders) OR (cardinality(holders) = 0 AND public.app_user_is_system_admin(prev));
    n := n + 1;
    IF jsonb_array_length(ids) < 500 THEN ids := ids || to_jsonb(r.id); END IF;
    CONTINUE WHEN p_dry_run;
    PERFORM public.reg_permit_move(r.id, prev, CASE WHEN cardinality(holders) = 1 THEN holders[1] END, holders, NULL,
      'recheck of the open permit drafts (Q221): the holder is no longer an entry holder of the row of the permit');
  END LOOP;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'moved', n, 'record_ids', ids);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The permit types the caller may enter (Q222)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_entry_permit_types() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); held text[]; t record; s text[]; out jsonb := '[]'::jsonb;
BEGIN
  IF actor IS NULL THEN RETURN out; END IF;
  -- the streams whose row the caller holds at L1 in a region they can see (a System Admin: all of them; the database still applies B10)
  held := ARRAY(SELECT x FROM unnest(ARRAY['CW', 'TE', 'ACQ', 'OM']) x
                WHERE public.app_user_is_system_admin(actor)
                   OR EXISTS (SELECT 1 FROM public.regions g CROSS JOIN LATERAL public.reg_row_entry_holders(public.reg_permit_row(x), g.id) h WHERE h.user_id = actor));
  FOR t IN SELECT * FROM public.permit_types p WHERE p.is_active ORDER BY p.sort_order, p.code LOOP
    s := ARRAY(SELECT x FROM unnest(coalesce(t.stream_options, ARRAY[coalesce(t.stream, 'CW')])) x WHERE x = ANY (held));
    CONTINUE WHEN cardinality(s) = 0;
    out := out || jsonb_build_array(jsonb_build_object('code', t.code, 'stream', t.stream, 'choose_stream', t.stream_options IS NOT NULL, 'streams', to_jsonb(s)));
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Default holders of the new rows: Acquisition / RF & Design (Q220). O&M has none until the admin names them (B10).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE r record; cid uuid; ids uuid[]; n_seeded int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('permits_hse_acq', 1, ARRAY['ACQ_TEAM', 'RF_ENG']),
    ('permits_hse_acq', 3, ARRAY['RFD_ACQ_TL'])
  ) AS v(row_key, lvl, role_codes) LOOP
    SELECT coalesce(array_agg(ro.id ORDER BY ro.code COLLATE "C"), ARRAY[]::uuid[]) INTO ids FROM roles ro WHERE ro.code = ANY (r.role_codes) AND ro.can_hold_matrix_levels;
    CONTINUE WHEN cardinality(ids) = 0;
    SELECT c.id INTO cid FROM matrix_cells c WHERE c.register_key = r.row_key AND c.level = r.lvl AND c.region_id IS NULL AND c.task_def_id IS NULL ORDER BY c.id LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES (r.row_key, r.lvl, 'any_one', NULL, true, now()) RETURNING id INTO cid;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM matrix_cell_assignees a WHERE a.cell_id = cid) THEN
      INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
      n_seeded := n_seeded + 1;
    END IF;
  END LOOP;
  UPDATE matrix_state SET revision = revision + 1, updated_at = now();
  INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
  VALUES ('permits_streams_applied', 'workflow', NULL,
          jsonb_build_object('matrix_rows', jsonb_build_array('permits_hse_acq', 'permits_hse_om'), 'cells_seeded', n_seeded,
            'types', (SELECT jsonb_object_agg(t.code, coalesce(to_jsonb(t.stream), to_jsonb(t.stream_options))) FROM permit_types t)),
          'Owner answers Q220 and D220b (2026-11-04): the stream follows the activity; purpose-based permit types are entered on the stream the entering person chooses (migration 0054).');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['levels_conv_people(text,uuid,jsonb)', 'levels_conversion_notify(text,uuid)', 'levels_convert_two(boolean,uuid[])', 'levels_hold_guard()',
                           'reg_permit_stream(jsonb)', 'reg_permit_stream_issue(jsonb)', 'reg_scope_of(text,jsonb)', 'reg_permit_row(text)', 'reg_scope_entry_guard()',
                           'reg_permit_submit_guard()', 'reg_permit_move(uuid,uuid,uuid,uuid[],text,text)', 'reg_permit_transfer(uuid,integer,text)',
                           'permit_drafts_recheck(boolean)', 'reg_entry_permit_types()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION reg_entry_permit_types() TO pmis_app;
    GRANT EXECUTE ON FUNCTION reg_permit_transfer(uuid, integer, text) TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON levels_conversions, permit_types, register_steps FROM pmis_app;
    GRANT SELECT ON levels_conversions TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Apply now
-- ---------------------------------------------------------------------------------------------------------------------
-- 9a. Q215 / Q216: the items 0050 already converted get their conversion record and their one-off notice.
INSERT INTO levels_conversions (entity_type, entity_id, site_id, region_id, converted_at, levels_before, migration, reason, old_path, audit_id)
SELECT l.entity_type, l.entity_id::uuid, l.site_id, l.region_id, l.at, 3, '0050', coalesce(l.reason, 'owner decision: two levels'), coalesce(l.before, '{}'::jsonb), l.id
FROM audit_log l
WHERE l.action = 'levels_converted_two' AND l.entity_type IN ('task', 'register_record') AND l.entity_id ~ '^[0-9a-f-]{36}$'
ORDER BY l.id
ON CONFLICT (entity_type, entity_id) DO NOTHING;
UPDATE levels_conversions c SET people = levels_conv_people(c.entity_type, c.entity_id, c.old_path) WHERE c.migration = '0050' AND c.people = '{}'::jsonb;
DO $$
DECLARE c record; n int := 0;
BEGIN
  FOR c IN SELECT entity_type, entity_id FROM levels_conversions WHERE migration = '0050' AND notified_at IS NULL ORDER BY converted_at, entity_id LOOP
    n := n + levels_conversion_notify(c.entity_type, c.entity_id);
  END LOOP;
  IF n > 0 THEN
    INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
    VALUES ('levels_conversion_notices', 'workflow', NULL, jsonb_build_object('people_told', n), 'Owner answer Q215 (2026-11-04): the old reviewer and the entry person of every item converted by 0050 are told once.');
  END IF;
END $$;

-- 9b. Q217: the impact report first, then the conversion (a database without such items converts nothing and writes nothing but the report).
DO $$
DECLARE rep jsonb := levels_convert_two(true);
BEGIN
  IF (rep ->> 'one_level_tasks')::int + (rep ->> 'one_level_records')::int + (rep ->> 'tasks')::int + (rep ->> 'records')::int > 0 THEN
    INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
    VALUES ('levels_conversion_impact', 'workflow', NULL, rep, 'Owner answer Q217 (2026-11-04): impact report before the open items on one level are converted to L1 / L2.');
  END IF;
END $$;
SELECT levels_convert_two(false);

-- 9c. Q221: every open permit draft is checked against the rows of this migration.
SELECT permit_drafts_recheck(false);
