-- 0040_x_features_fix: review fixes for the UI plan features X1 to X7 (phase 4b, migration 0031).
-- Mirror: db/sql/039_x_features_fix.sql (kept identical to prisma/migrations/0040_x_features_fix/migration.sql).
--
--   X3 / X2  One rule for "who can see the item": x_user_can_read(user, module, region) answers from the permission grid of that user (the profile grants of
--            the active assignments, each limited to its own regions and modules, plus delegations), exactly like wf_actor_regions does for the caller.
--            wf_user_in_scope only looked at the assignment scope, so a person whose role holds no `view` grant on the module could still be mentioned
--            (the notification carries the comment text) or be notified as a follower. Now used by task comments, record comments and followers.
--            A duplicate in the mention list makes one notification, and the audit row names only the people who were actually mentioned.
--   X1       notifications carry region_id and module_key (filled by a trigger from task_id or the register link) so the inbox can hide, at read time, what the
--            caller can no longer read (a region or a module taken away after the notification was written).
--   X7       x_status_edit asks for the lead right again: an author who is no longer a lead of the region cannot edit.

-- ---------------------------------------------------------------------------------------------------------------------
-- One rule: can this user read this module in this region right now?
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION x_user_can_read(p_user uuid, p_module text, p_region int) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_user IS NULL OR p_module IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass) THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_role_assignments ua
    WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
      AND (p_region IS NULL OR ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
      AND EXISTS (SELECT 1 FROM public.user_role_assignment_profiles ap
                  JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
                  JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = 'view'
                  WHERE ap.assignment_id = ua.id AND (p_module = g.module_key OR p_module LIKE g.module_key || '.%')
                    AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m
                                                   WHERE m.assignment_id = ua.id AND m.module_key = split_part(g.module_key, '.', 1))))
  ) OR EXISTS (
    SELECT 1 FROM public.app_user_delegations(p_user) x(id) JOIN public.delegations d ON d.id = x.id
    WHERE public.deleg_covers(d.id, p_module, 'view'::"PermissionAction")
      AND (p_region IS NULL OR d.all_regions OR EXISTS (SELECT 1 FROM public.delegation_regions dr WHERE dr.delegation_id = d.id AND dr.region_id = p_region))
  );
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- X2: followers hear only about what they can read now
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION x_notify_watchers(p_site uuid, p_entity uuid, p_actor uuid, p_title text, p_body text, p_link text, p_task uuid, p_region int, p_module text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT DISTINCT w.user_id FROM public.watches w
           WHERE ((w.entity_type = 'site' AND w.entity_id = p_site) OR (w.entity_type = 'register_record' AND w.entity_id = p_entity))
             AND w.user_id IS DISTINCT FROM p_actor LOOP
    IF public.x_user_can_read(u, p_module, p_region) THEN
      INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link) VALUES (u, 'in_app', 'followed_change', p_title, p_body, p_task, p_link);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- X3: mentions on tasks and on register records
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_add_comment(p_task uuid, p_body text, p_mentions uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; cid uuid; m uuid; done uuid[] := ARRAY[]::uuid[];
BEGIN
  t := public.wf_lock_task(p_task, NULL);
  IF coalesce(btrim(p_body), '') = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The comment is empty.')); END IF;
  INSERT INTO public.comments (task_id, region_id, author_id, body) VALUES (p_task, t.region_id, actor, p_body) RETURNING id INTO cid;
  FOREACH m IN ARRAY coalesce(p_mentions, ARRAY[]::uuid[]) LOOP
    -- only people who can read the task (Sites module, this region, `view` in their grid) are mentioned and notified; the notification carries the comment text
    IF m <> actor AND NOT (m = ANY (done)) AND public.x_user_can_read(m, 'sites', t.region_id) THEN
      INSERT INTO public.comment_mentions (comment_id, user_id) VALUES (cid, m) ON CONFLICT DO NOTHING;
      PERFORM public.wf_notify(m, 'mention', 'You were mentioned', public.wf_label(p_task) || ': ' || left(p_body, 200), p_task);
      done := done || m;
    END IF;
  END LOOP;
  PERFORM public.wf_audit('task_comment', p_task, NULL, jsonb_build_object('comment_id', cid, 'body', p_body, 'mentions', to_jsonb(done)), NULL);
  RETURN cid;
END $$;

CREATE OR REPLACE FUNCTION reg_add_comment(p_key text, p_record uuid, p_body text, p_mentions uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; regs int[]; mod text; cid uuid; m uuid; done uuid[] := ARRAY[]::uuid[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.register_records WHERE id = p_record AND register_key = p_key;
  mod := public.reg_module(p_key);
  regs := CASE WHEN mod IS NULL THEN ARRAY[]::int[] ELSE public.wf_actor_regions(mod, 'view') END;
  IF NOT FOUND OR (regs IS NOT NULL AND (cardinality(regs) = 0 OR NOT (r.is_global OR r.region_id = ANY (regs)))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.'));
  END IF;
  IF r.region_id IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Comments on a global record (no region) are not supported yet.'));
  END IF;
  IF coalesce(btrim(p_body), '') = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The comment is empty.')); END IF;
  -- the thread belongs to the record, not to one version: entity_id is the stable entity id
  INSERT INTO public.comments (region_id, entity_type, entity_id, author_id, body) VALUES (r.region_id, 'register_record', r.entity_id, actor, p_body) RETURNING id INTO cid;
  FOREACH m IN ARRAY coalesce(p_mentions, ARRAY[]::uuid[]) LOOP
    -- only people who can read the record (the register's module, this region, `view` in their grid) are mentioned and notified; anyone else is dropped silently
    IF m <> actor AND NOT (m = ANY (done)) AND public.x_user_can_read(m, mod, r.region_id) THEN
      INSERT INTO public.comment_mentions (comment_id, user_id) VALUES (cid, m) ON CONFLICT DO NOTHING;
      PERFORM public.reg_notify(m, 'mention', 'You were mentioned', public.reg_label(p_record) || ': ' || left(p_body, 200), p_record);
      done := done || m;
    END IF;
  END LOOP;
  PERFORM public.reg_audit('register_record_comment', p_record, NULL, jsonb_build_object('comment_id', cid, 'body', p_body, 'mentions', to_jsonb(done)), NULL);
  RETURN cid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- X1: where a notification points (filled once, at insert)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN region_id integer REFERENCES regions(id);
ALTER TABLE notifications ADD COLUMN module_key text;

-- A task notification belongs to the Sites module and the task's region; a register notification (link /registers/<key>/records/<id>) to the register's module and the
-- record's region (no region = a global record). Anything else (system, delegation, announcement ...) is personal and has neither.
CREATE OR REPLACE FUNCTION x_notification_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m text[];
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT t.region_id, 'sites' INTO NEW.region_id, NEW.module_key FROM public.task_instances t WHERE t.id = NEW.task_id;
  ELSIF NEW.link IS NOT NULL THEN
    m := regexp_match(NEW.link, '^/registers/([^/]+)/records/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$');
    IF m IS NOT NULL THEN
      SELECT r.region_id, public.reg_module(r.register_key) INTO NEW.region_id, NEW.module_key FROM public.register_records r WHERE r.id = m[2]::uuid AND r.register_key = m[1];
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_scope BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION x_notification_scope();
CREATE INDEX notifications_user_module_idx ON notifications (user_id, module_key) WHERE module_key IS NOT NULL;

GRANT SELECT ON task_instances, register_records TO pmis_definer;

-- Rows written before this migration.
UPDATE notifications n SET region_id = t.region_id, module_key = 'sites' FROM task_instances t WHERE n.task_id = t.id;
UPDATE notifications n SET region_id = r.region_id, module_key = reg_module(r.register_key)
  FROM register_records r
  WHERE n.task_id IS NULL AND n.link ~ '^/registers/[^/]+/records/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND r.id = (regexp_match(n.link, '^/registers/[^/]+/records/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'))[1]::uuid AND r.register_key = (regexp_match(n.link, '^/registers/([^/]+)/records/'))[1];

-- ---------------------------------------------------------------------------------------------------------------------
-- X7: the author must still be a lead of the region
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION x_status_edit(p_id uuid, p_version int, p_health text, p_summary text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); u public.status_updates%ROWTYPE; seen int[]; lead int[]; b jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO u FROM public.status_updates WHERE id = p_id FOR UPDATE;
  seen := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (seen IS NOT NULL AND (cardinality(seen) = 0 OR (u.region_id IS NOT NULL AND NOT (u.region_id = ANY (seen))))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The status update does not exist or is not visible to you.'));
  END IF;
  IF u.author_id <> actor THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the author edits a status update.')); END IF;
  lead := public.wf_actor_regions('overrides.reassign', 'administer');
  IF lead IS NOT NULL AND (cardinality(lead) = 0 OR u.region_id IS NULL OR NOT (u.region_id = ANY (lead))) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a lead (the reassign grant) of this region, or a System Admin, edits its status update.'));
  END IF;
  IF p_version IS NOT NULL AND p_version <> u.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The status update changed since you read it.')); END IF;
  IF public.cal_today() > u.week_start + 6 THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The week of this update has ended; it can no longer be edited.')); END IF;
  b := jsonb_build_object('health', u.health, 'summary', u.summary);
  UPDATE public.status_updates SET health = coalesce(p_health, health), summary = coalesce(btrim(p_summary), summary), version = version + 1, updated_at = now() WHERE id = p_id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, before, after, actor_id)
  VALUES ('status_update_edit', 'status_update', p_id::text, u.region_id, b,
          (SELECT jsonb_build_object('health', s.health, 'summary', s.summary) FROM public.status_updates s WHERE s.id = p_id), actor);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'x_user_can_read(uuid,text,int)', 'x_notify_watchers(uuid,uuid,uuid,text,text,text,uuid,int,text)', 'wf_add_comment(uuid,text,uuid[])',
    'reg_add_comment(text,uuid,text,uuid[])', 'x_notification_scope()', 'x_status_edit(uuid,int,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['wf_add_comment(uuid,text,uuid[])', 'reg_add_comment(text,uuid,text,uuid[])', 'x_status_edit(uuid,int,text,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
