-- 0031_x_inbox_follow_status: additive tables and functions for the UI plan features X1, X2, X3, X7 and the `via` of DD6 (UI/UX plan 2026-11-01, sections 2.5 and 2.15).
-- Mirror: db/sql/030_x_inbox_follow_status.sql (kept identical to prisma/migrations/0031_x_inbox_follow_status/migration.sql).
--
--   X1  notifications.snoozed_until; the table becomes row-level protected: a user reads and updates only their own rows (read_at, snoozed_until);
--       rows are created only by the definer functions (wf_notify, reg_notify, calc_alert, x_notify_watchers).
--   X2  watches (follow a site or a register record) written only by x_follow / x_unfollow; followers get a `followed_change` notification when a task
--       of the site or the record changes, and only while they can still read it (wf_user_in_scope / reg_user_in_scope).
--   X3  reg_add_comment: comments and @mentions on register records; a mentioned person who cannot read the record is neither notified nor stored.
--       (Task comments already do this in wf_add_comment.)
--   X7  status_updates (weekly summary and health per region or team), written only by x_status_post / x_status_edit; never removed.
--   DD6 wf_audit and reg_audit add `via` ('button', 'drag', 'bulk') to the audit row when the API sets the transaction-local setting app.via. No rule changes.
-- X4, X5 and X6 need no schema: they read the audit log, the tasks and the existing gate logic.

-- ---------------------------------------------------------------------------------------------------------------------
-- X1: the inbox
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN snoozed_until timestamptz;
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON notifications FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_update ON notifications FOR UPDATE USING (user_id = app_actor()) WITH CHECK (user_id = app_actor());
CREATE POLICY rls_seed_write ON notifications FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- X2: follow
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL CHECK (entity_type IN ('site', 'register_record')),
  entity_id uuid NOT NULL, -- the site id, or register_records.entity_id (stable across the versions of a record)
  site_id uuid REFERENCES sites(id),
  register_key text,
  region_id integer REFERENCES regions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watches_unique UNIQUE (user_id, entity_type, entity_id),
  CONSTRAINT watches_register_key CHECK ((entity_type = 'register_record') = (register_key IS NOT NULL))
);
CREATE INDEX watches_entity_idx ON watches (entity_type, entity_id);
ALTER TABLE watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE watches FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON watches FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON watches FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- Follow a site (p_type 'site', p_id = site id) or a register record (p_type 'register_record', p_id = any version row of the record, p_key = register key).
-- Only what the caller can read can be followed; anything else answers not_found. Idempotent.
CREATE OR REPLACE FUNCTION x_follow(p_type text, p_id uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); s public.sites%ROWTYPE; r public.register_records%ROWTYPE; regs int[]; mod text; w public.watches%ROWTYPE; made boolean := false;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_type = 'site' THEN
    SELECT * INTO s FROM public.sites WHERE id = p_id;
    regs := public.wf_actor_regions('sites', 'view');
    IF NOT FOUND OR (regs IS NOT NULL AND NOT (s.region_id = ANY (regs))) THEN
      PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
    END IF;
    INSERT INTO public.watches (user_id, entity_type, entity_id, site_id, region_id) VALUES (actor, 'site', s.id, s.id, s.region_id)
      ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING RETURNING * INTO w;
    made := FOUND;
  ELSIF p_type = 'register_record' THEN
    SELECT * INTO r FROM public.register_records WHERE id = p_id AND register_key = p_key;
    mod := public.reg_module(p_key);
    regs := CASE WHEN mod IS NULL THEN ARRAY[]::int[] ELSE public.wf_actor_regions(mod, 'view') END;
    IF NOT FOUND OR (regs IS NOT NULL AND (cardinality(regs) = 0 OR NOT (r.is_global OR r.region_id = ANY (regs)))) THEN
      PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.'));
    END IF;
    INSERT INTO public.watches (user_id, entity_type, entity_id, site_id, register_key, region_id) VALUES (actor, 'register_record', r.entity_id, r.site_id, r.register_key, r.region_id)
      ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING RETURNING * INTO w;
    made := FOUND;
  ELSE
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Only a site or a register record can be followed.'));
  END IF;
  IF NOT made THEN
    SELECT * INTO w FROM public.watches WHERE user_id = actor AND entity_type = p_type AND entity_id = CASE WHEN p_type = 'site' THEN p_id ELSE r.entity_id END;
  ELSE
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, after, actor_id)
    VALUES ('follow', 'watch', w.id::text, w.site_id, w.region_id, jsonb_build_object('entity_type', w.entity_type, 'entity_id', w.entity_id, 'register_key', w.register_key), actor);
  END IF;
  RETURN jsonb_build_object('id', w.id, 'entity_type', w.entity_type, 'entity_id', w.entity_id, 'register_key', w.register_key, 'site_id', w.site_id, 'created_at', w.created_at);
END $$;

-- Stop following. Needs no read right (it only removes the caller's own watch); true when a watch was removed.
CREATE OR REPLACE FUNCTION x_unfollow(p_type text, p_id uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); ent uuid; w public.watches%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_type = 'site' THEN ent := p_id;
  ELSIF p_type = 'register_record' THEN SELECT r.entity_id INTO ent FROM public.register_records r WHERE r.id = p_id AND r.register_key = p_key;
  ELSE PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Only a site or a register record can be followed.'));
  END IF;
  DELETE FROM public.watches WHERE user_id = actor AND entity_type = p_type AND entity_id = ent RETURNING * INTO w;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, actor_id)
  VALUES ('unfollow', 'watch', w.id::text, w.site_id, w.region_id, jsonb_build_object('entity_type', w.entity_type, 'entity_id', w.entity_id, 'register_key', w.register_key), actor);
  RETURN true;
END $$;

-- One `followed_change` notification per follower of the site or of the record, except the person who acted, and only for followers who can read it now:
-- Sites for a task change (p_module = 'sites'), the register's module for a register change (also for the followers of its site).
CREATE OR REPLACE FUNCTION x_notify_watchers(p_site uuid, p_entity uuid, p_actor uuid, p_title text, p_body text, p_link text, p_task uuid, p_region int, p_module text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT DISTINCT w.user_id FROM public.watches w
           WHERE ((w.entity_type = 'site' AND w.entity_id = p_site) OR (w.entity_type = 'register_record' AND w.entity_id = p_entity))
             AND w.user_id IS DISTINCT FROM p_actor LOOP
    IF (p_module = 'sites' AND public.wf_user_in_scope(u, p_region)) OR (p_module <> 'sites' AND public.reg_user_in_scope(u, p_region, p_module)) THEN
      INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link) VALUES (u, 'in_app', 'followed_change', p_title, p_body, p_task, p_link);
    END IF;
  END LOOP;
END $$;

-- The task audit row: the same row as before, plus `via` (DD6) and the follower notifications (X2) for the state-changing actions.
CREATE OR REPLACE FUNCTION wf_audit(p_action text, p_task uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; v text := nullif(current_setting('app.via', true), ''); a jsonb := p_after;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF v IN ('button', 'drag', 'bulk') AND p_action <> 'task_unlock' THEN a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', v); END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'task', p_task::text, t.site_id, t.region_id, p_before, a, p_reason, public.app_actor());
  IF p_action IN ('task_start', 'task_submit', 'task_review', 'task_approve', 'task_reject', 'task_unlock') THEN
    PERFORM public.x_notify_watchers(t.site_id, NULL, public.app_actor(), 'A followed site changed', public.wf_label(p_task) || ': ' || substr(p_action, 6), '/tasks/' || p_task::text, p_task, t.region_id, 'sites');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reg_audit(p_action text, p_record uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; v text := nullif(current_setting('app.via', true), ''); a jsonb := p_after;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF v IN ('button', 'drag', 'bulk') THEN a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', v); END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'register_record', p_record::text, r.site_id, r.region_id, p_before, a, p_reason, public.app_actor());
  IF p_action IN ('register_record_create', 'register_record_submit', 'register_record_review', 'register_record_approve', 'register_record_reject',
                  'register_record_void', 'register_record_new_version') THEN
    PERFORM public.x_notify_watchers(r.site_id, r.entity_id, public.app_actor(), 'A followed record changed', public.reg_label(p_record) || ': ' || substr(p_action, 17),
      '/registers/' || r.register_key || '/records/' || p_record::text, NULL, r.region_id, public.reg_module(r.register_key));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- X3: comments with @mentions on register records (task comments: wf_add_comment, unchanged)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_add_comment(p_key text, p_record uuid, p_body text, p_mentions uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; regs int[]; mod text; cid uuid; m uuid;
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
    -- only people who can read the record are mentioned and notified; anyone else is dropped silently (no sign that the record exists)
    IF m <> actor AND public.reg_user_in_scope(m, r.region_id, mod) THEN
      INSERT INTO public.comment_mentions (comment_id, user_id) VALUES (cid, m) ON CONFLICT DO NOTHING;
      PERFORM public.reg_notify(m, 'mention', 'You were mentioned', public.reg_label(p_record) || ': ' || left(p_body, 200), p_record);
    END IF;
  END LOOP;
  PERFORM public.reg_audit('register_record_comment', p_record, NULL, jsonb_build_object('comment_id', cid, 'body', p_body, 'mentions', to_jsonb(coalesce(p_mentions, ARRAY[]::uuid[]))), NULL);
  RETURN cid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- X7: weekly status updates
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE status_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('region', 'team')),
  region_id integer REFERENCES regions(id), -- required for a region update; optional for a team update (null = all regions)
  team text CHECK (team IN ('cw', 'te')),
  week_start date NOT NULL, -- the Sunday that opens the working week (the weekend is Friday and Saturday)
  health text NOT NULL CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  author_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT status_updates_scope_shape CHECK ((scope = 'region' AND region_id IS NOT NULL AND team IS NULL) OR (scope = 'team' AND team IS NOT NULL)),
  CONSTRAINT status_updates_week_sunday CHECK (extract(dow FROM week_start) = 0)
);
CREATE INDEX status_updates_scope_idx ON status_updates (week_start DESC, region_id, team);
ALTER TABLE status_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON status_updates FOR SELECT USING (app_is_seeding() OR app_region_read(region_id IS NULL, region_id));
CREATE POLICY rls_seed_write ON status_updates FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- Never removed (corrections are edits, which the audit log keeps with before and after).
CREATE OR REPLACE FUNCTION status_updates_block_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'status_updates rows are never removed (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER status_updates_no_removal BEFORE DELETE ON status_updates FOR EACH ROW EXECUTE FUNCTION status_updates_block_removal();
CREATE TRIGGER status_updates_no_truncation BEFORE TRUNCATE ON status_updates FOR EACH STATEMENT EXECUTE FUNCTION status_updates_block_removal();

-- The lead of a region (or of a team) is whoever holds the `reassign` grant (B12b) there, or a System Admin. The caller must also be able to see the region.
CREATE OR REPLACE FUNCTION x_status_post(p_scope text, p_region int, p_team text, p_health text, p_summary text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); lead int[]; seen int[]; sid uuid; errs jsonb := '[]'::jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_scope = 'region' AND p_region IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/region_id', 'code', 'required', 'message', 'A region update needs region_id.')); END IF;
  IF p_scope = 'region' AND p_team IS NOT NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/team', 'code', 'invalid', 'message', 'A region update has no team.')); END IF;
  IF p_scope = 'team' AND p_team IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/team', 'code', 'required', 'message', 'A team update needs team.')); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  lead := public.wf_actor_regions('overrides.reassign', 'administer');
  seen := public.wf_actor_regions('sites', 'view');
  IF (lead IS NOT NULL AND (cardinality(lead) = 0 OR p_region IS NULL OR NOT (p_region = ANY (lead))))
     OR (seen IS NOT NULL AND (cardinality(seen) = 0 OR (p_region IS NOT NULL AND NOT (p_region = ANY (seen))) OR (p_region IS NULL))) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a lead (the reassign grant) of this region, or a System Admin, writes its status update.'));
  END IF;
  INSERT INTO public.status_updates (scope, region_id, team, week_start, health, summary, author_id)
  VALUES (p_scope, p_region, p_team, public.cal_today() - extract(dow FROM public.cal_today())::int, p_health, btrim(p_summary), actor) RETURNING id INTO sid;
  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, after, actor_id)
  VALUES ('status_update_post', 'status_update', sid::text, p_region, jsonb_build_object('scope', p_scope, 'team', p_team, 'health', p_health, 'summary', btrim(p_summary)), actor);
  RETURN sid;
END $$;

-- Edit: only the author, only inside the week of the update, with If-Match.
CREATE OR REPLACE FUNCTION x_status_edit(p_id uuid, p_version int, p_health text, p_summary text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); u public.status_updates%ROWTYPE; seen int[]; b jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO u FROM public.status_updates WHERE id = p_id FOR UPDATE;
  seen := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (seen IS NOT NULL AND (cardinality(seen) = 0 OR (u.region_id IS NOT NULL AND NOT (u.region_id = ANY (seen))))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The status update does not exist or is not visible to you.'));
  END IF;
  IF u.author_id <> actor THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the author edits a status update.')); END IF;
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
GRANT SELECT, INSERT, UPDATE, DELETE ON watches TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON status_updates TO pmis_definer;
GRANT SELECT ON sites, register_records TO pmis_definer;
GRANT INSERT ON audit_log, comments, comment_mentions, notifications TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'x_follow(text,uuid,text)', 'x_unfollow(text,uuid,text)', 'x_notify_watchers(uuid,uuid,uuid,text,text,text,uuid,int,text)',
    'wf_audit(text,uuid,jsonb,jsonb,text)', 'reg_audit(text,uuid,jsonb,jsonb,text)', 'reg_add_comment(text,uuid,text,uuid[])',
    'x_status_post(text,int,text,text,text)', 'x_status_edit(uuid,int,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'x_follow(text,uuid,text)', 'x_unfollow(text,uuid,text)', 'reg_add_comment(text,uuid,text,uuid[])', 'x_status_post(text,int,text,text,text)', 'x_status_edit(uuid,int,text,text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
ALTER FUNCTION status_updates_block_removal() OWNER TO pmis_definer;
