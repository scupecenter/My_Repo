-- 010: departments, direct manager, messages and announcements (owner decision 2026-10-28, ADR 0013).
--
-- * Departments are an admin-managed list; each user may belong to one and may have one direct manager. Both are identity
--   data: written only through idm_* functions (owner pmis_identity_owner), like the rest of the users row.
-- * Messages: a thread between two people, an employee and their direct manager (either side may start it); a System
--   Admin may start a thread with anyone. Only the two participants can read it (row-level security). Replies are
--   append-only.
-- * Announcements: sent by a System Admin or a delegate holding announcements.create, to everyone or to chosen users,
--   groups, roles and departments. The recipients are fixed when it is sent. Each recipient answers once, agree or
--   disagree, and a disagreement needs a note. The sender and System Admins read the answers. Answers are append-only.
-- Writes go through SECURITY DEFINER functions; pmis_app only reads, filtered by row-level security.

-- ---------------------------------------------------------------------------------------------------------------------
-- Departments and the direct manager
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name_en     TEXT NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar     TEXT CHECK (name_ar IS NULL OR length(btrim(name_ar)) BETWEEN 1 AND 120),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN manager_id UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE users ADD COLUMN department_id UUID REFERENCES departments(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_manager_not_self CHECK (manager_id IS NULL OR manager_id <> id);
CREATE INDEX users_manager_idx ON users (manager_id);
CREATE INDEX users_department_idx ON users (department_id);

GRANT SELECT, INSERT, UPDATE ON departments TO pmis_identity_owner;

-- Create or edit a department (System Admin or a users.edit delegation for all regions).
CREATE OR REPLACE FUNCTION idm_department_save(p_id uuid, p_code text, p_name_en text, p_name_ar text, p_active boolean, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); did uuid; old jsonb;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  IF p_id IS NULL THEN
    INSERT INTO public.departments (code, name_en, name_ar, is_active)
    VALUES (upper(btrim(p_code)), btrim(p_name_en), nullif(btrim(p_name_ar), ''), coalesce(p_active, true)) RETURNING id INTO did;
  ELSE
    SELECT to_jsonb(d) INTO old FROM public.departments d WHERE d.id = p_id;
    IF old IS NULL THEN RAISE EXCEPTION 'department not found'; END IF;
    UPDATE public.departments SET code = upper(btrim(p_code)), name_en = btrim(p_name_en), name_ar = nullif(btrim(p_name_ar), ''),
      is_active = coalesce(p_active, is_active), updated_at = now() WHERE id = p_id;
    did := p_id;
  END IF;
  PERFORM public.idm_audit(CASE WHEN p_id IS NULL THEN 'department_created' ELSE 'department_updated' END, 'department', did::text, old,
    (SELECT to_jsonb(d) FROM public.departments d WHERE d.id = did), p_reason);
  RETURN did;
END $$;

-- Set a user's direct manager and department (either may be null). Refuses a manager loop.
CREATE OR REPLACE FUNCTION idm_set_user_org(p_user uuid, p_manager uuid, p_department uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); old jsonb; cur uuid := p_manager; depth int := 0;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  PERFORM public.idm_assert_user_change_allowed(p_user);
  SELECT jsonb_build_object('manager_id', manager_id, 'department_id', department_id) INTO old FROM public.users WHERE id = p_user;
  IF old IS NULL THEN RAISE EXCEPTION 'user not found'; END IF;
  IF p_manager IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_manager AND status = 'active') THEN
    RAISE EXCEPTION 'the manager must be an active user';
  END IF;
  IF p_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department AND is_active) THEN
    RAISE EXCEPTION 'the department must exist and be active';
  END IF;
  WHILE cur IS NOT NULL LOOP                       -- walking up from the new manager must never reach the user
    IF cur = p_user THEN RAISE EXCEPTION 'this would make a manager loop'; END IF;
    depth := depth + 1;
    IF depth > 50 THEN RAISE EXCEPTION 'manager chain too deep'; END IF;
    SELECT manager_id INTO cur FROM public.users WHERE id = cur;
  END LOOP;
  UPDATE public.users SET manager_id = p_manager, department_id = p_department, updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit('user_org_set', 'user', p_user::text, old,
    jsonb_build_object('manager_id', p_manager, 'department_id', p_department), p_reason);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE message_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject          TEXT NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_message_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE TABLE message_participants (
  thread_id     UUID NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  last_read_at  TIMESTAMPTZ(6),
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX message_participants_user_idx ON message_participants (user_id);
CREATE TABLE messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   UUID NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  is_original BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);
CREATE UNIQUE INDEX messages_one_original ON messages (thread_id) WHERE is_original;

-- Who may start a thread with whom: the direct manager link in either direction, or a System Admin to anyone.
CREATE OR REPLACE FUNCTION msg_can_start(p_from uuid, p_to uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_from IS DISTINCT FROM p_to AND EXISTS (SELECT 1 FROM public.users WHERE id = p_to AND status = 'active')
     AND (public.app_user_is_system_admin(p_from)
          OR EXISTS (SELECT 1 FROM public.users WHERE id = p_from AND manager_id = p_to)
          OR EXISTS (SELECT 1 FROM public.users WHERE id = p_to AND manager_id = p_from))
$$;

CREATE OR REPLACE FUNCTION msg_is_participant(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.message_participants WHERE thread_id = p_thread AND user_id = public.app_actor())
$$;

CREATE OR REPLACE FUNCTION msg_start(p_to uuid, p_subject text, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); tid uuid;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.msg_can_start(a, p_to) THEN
    RAISE EXCEPTION 'you can message your direct manager and the people who report to you' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.message_threads (subject, created_by) VALUES (btrim(p_subject), a) RETURNING id INTO tid;
  INSERT INTO public.message_participants (thread_id, user_id, last_read_at) VALUES (tid, a, now()), (tid, p_to, NULL);
  INSERT INTO public.messages (thread_id, author_id, body, is_original) VALUES (tid, a, p_body, true);
  RETURN tid;
END $$;

CREATE OR REPLACE FUNCTION msg_reply(p_thread uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); mid uuid;
BEGIN
  IF a IS NULL OR NOT public.msg_is_participant(p_thread) THEN
    RAISE EXCEPTION 'not a participant of this thread' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.messages (thread_id, author_id, body) VALUES (p_thread, a, p_body) RETURNING id INTO mid;
  UPDATE public.message_threads SET last_message_at = now() WHERE id = p_thread;
  UPDATE public.message_participants SET last_read_at = now() WHERE thread_id = p_thread AND user_id = a;
  RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION msg_mark_read(p_thread uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.message_participants SET last_read_at = now() WHERE thread_id = p_thread AND user_id = public.app_actor();
END $$;

-- Messages are never edited or deleted (except with their thread by the migration role).
CREATE OR REPLACE FUNCTION msg_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'messages are append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER messages_append_only BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION msg_block_mutation();

-- ---------------------------------------------------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE announcements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body         TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  audience_all BOOLEAN NOT NULL DEFAULT false,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE TABLE announcement_targets (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('user', 'group', 'role', 'department')),
  target_id       UUID NOT NULL,
  PRIMARY KEY (announcement_id, kind, target_id)
);
CREATE TABLE announcement_recipients (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX announcement_recipients_user_idx ON announcement_recipients (user_id);
CREATE TABLE announcement_responses (
  announcement_id UUID NOT NULL,
  user_id         UUID NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('agree', 'disagree')),
  note            TEXT CHECK (note IS NULL OR length(btrim(note)) <= 2000),
  responded_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id),
  FOREIGN KEY (announcement_id, user_id) REFERENCES announcement_recipients (announcement_id, user_id) ON DELETE CASCADE,
  CONSTRAINT announcement_disagree_needs_note CHECK (decision = 'agree' OR length(btrim(coalesce(note, ''))) >= 3)
);
CREATE TRIGGER announcement_responses_append_only BEFORE UPDATE OR DELETE ON announcement_responses
  FOR EACH ROW EXECUTE FUNCTION msg_block_mutation();

-- Sender, or a System Admin: may read the answers.
CREATE OR REPLACE FUNCTION ann_can_read_results(p_ann uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_actor_is_system_admin()
      OR EXISTS (SELECT 1 FROM public.announcements WHERE id = p_ann AND created_by = public.app_actor())
$$;

CREATE OR REPLACE FUNCTION ann_send(p_title text, p_body text, p_all boolean, p_users uuid[], p_groups uuid[], p_roles uuid[],
  p_departments uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); aid uuid; n int;
BEGIN
  IF a IS NULL OR NOT public.app_actor_is_admin('announcements', 'create') THEN
    RAISE EXCEPTION 'System Admin or a delegation of announcements.create required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.announcements (title, body, audience_all, created_by) VALUES (btrim(p_title), p_body, coalesce(p_all, false), a)
  RETURNING id INTO aid;
  INSERT INTO public.announcement_targets (announcement_id, kind, target_id)
  SELECT aid, k, t FROM (
    SELECT 'user' AS k, unnest(coalesce(p_users, '{}')) AS t UNION SELECT 'group', unnest(coalesce(p_groups, '{}'))
    UNION SELECT 'role', unnest(coalesce(p_roles, '{}')) UNION SELECT 'department', unnest(coalesce(p_departments, '{}'))) x;
  -- Recipients are fixed now: active users matching any target (role = an assignment valid today), never the sender.
  INSERT INTO public.announcement_recipients (announcement_id, user_id)
  SELECT DISTINCT aid, u.id FROM public.users u
  WHERE u.status = 'active' AND NOT u.is_break_glass AND u.id <> a AND (
        coalesce(p_all, false)
     OR u.id = ANY (coalesce(p_users, '{}'))
     OR u.department_id = ANY (coalesce(p_departments, '{}'))
     OR EXISTS (SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_active
                WHERE gm.user_id = u.id AND gm.group_id = ANY (coalesce(p_groups, '{}')))
     OR EXISTS (SELECT 1 FROM public.user_role_assignments r WHERE r.user_id = u.id AND r.role_id = ANY (coalesce(p_roles, '{}'))
                AND r.valid_from <= now() AND (r.valid_to IS NULL OR r.valid_to > now())));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'no active recipient matches this audience'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('announcement_sent', 'announcement', aid::text, jsonb_build_object('title', btrim(p_title), 'recipients', n), a);
  RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION ann_respond(p_ann uuid, p_decision text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL OR NOT EXISTS (SELECT 1 FROM public.announcement_recipients WHERE announcement_id = p_ann AND user_id = a) THEN
    RAISE EXCEPTION 'this announcement is not addressed to you' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.announcement_responses (announcement_id, user_id, decision, note)
  VALUES (p_ann, a, p_decision, nullif(btrim(p_note), ''));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security: pmis_app reads only what the signed-in actor may see
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE message_threads ENABLE ROW LEVEL SECURITY;      ALTER TABLE message_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE message_participants ENABLE ROW LEVEL SECURITY; ALTER TABLE message_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;             ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;        ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
ALTER TABLE announcement_targets ENABLE ROW LEVEL SECURITY; ALTER TABLE announcement_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE announcement_recipients ENABLE ROW LEVEL SECURITY; ALTER TABLE announcement_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE announcement_responses ENABLE ROW LEVEL SECURITY;  ALTER TABLE announcement_responses FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_select ON message_threads FOR SELECT USING (app_is_seeding() OR msg_is_participant(id));
CREATE POLICY rls_select ON message_participants FOR SELECT USING (app_is_seeding() OR msg_is_participant(thread_id));
CREATE POLICY rls_select ON messages FOR SELECT USING (app_is_seeding() OR msg_is_participant(thread_id));
CREATE POLICY rls_select ON announcements FOR SELECT USING (
  app_is_seeding() OR ann_can_read_results(id)
  OR EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = id AND r.user_id = app_actor()));
CREATE POLICY rls_select ON announcement_targets FOR SELECT USING (app_is_seeding() OR ann_can_read_results(announcement_id));
CREATE POLICY rls_select ON announcement_recipients FOR SELECT USING (
  app_is_seeding() OR user_id = app_actor() OR ann_can_read_results(announcement_id));
CREATE POLICY rls_select ON announcement_responses FOR SELECT USING (
  app_is_seeding() OR user_id = app_actor() OR ann_can_read_results(announcement_id));
-- The migration role (seeding) may still write directly; the app never does.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_threads','message_participants','messages','announcements','announcement_targets',
                           'announcement_recipients','announcement_responses'] LOOP
    EXECUTE format('CREATE POLICY rls_seed_write ON %I FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON message_threads, message_participants, messages, announcements, announcement_targets,
  announcement_recipients, announcement_responses TO pmis_definer;
GRANT SELECT ON users, groups, group_members, user_role_assignments TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['idm_department_save(uuid,text,text,text,boolean,text)','idm_set_user_org(uuid,uuid,uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['msg_can_start(uuid,uuid)','msg_is_participant(uuid)','msg_start(uuid,text,text)','msg_reply(uuid,text)',
    'msg_mark_read(uuid)','ann_can_read_results(uuid)',
    'ann_send(text,text,boolean,uuid[],uuid[],uuid[],uuid[])','ann_respond(uuid,text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['idm_department_save(uuid,text,text,text,boolean,text)','idm_set_user_org(uuid,uuid,uuid,text)',
      'msg_can_start(uuid,uuid)','msg_is_participant(uuid)','msg_start(uuid,text,text)','msg_reply(uuid,text)','msg_mark_read(uuid)',
      'ann_can_read_results(uuid)','ann_send(text,text,boolean,uuid[],uuid[],uuid[],uuid[])','ann_respond(uuid,text,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
