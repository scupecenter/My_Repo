-- 0620_sub_tasks: sub-tasks under a task or a register record, with an owner, a status and a progress that rolls up to the parent (contract 0.15.474). Additive.
-- Mirror: db/sql/619_sub_tasks.sql (kept identical to prisma/migrations/0620_sub_tasks/migration.sql).
--
-- WHAT. A small checklist-with-owners under any task (task_instances) or register record (the logical record, entity_id). A sub-task has a title, an optional owner,
-- a status (open, doing, done), a progress 0..100 and an optional due date. The parent shows the roll-up: how many sub-tasks are done and their mean progress.
-- The roll-up is information only: it never changes the parent's state, level, dates, SLA or approval. Nothing in the workflow engine changes.
--
-- WHO. Reading follows the parent: whoever may view the task (module sites) or the record (its register module) in its region. Adding, editing and removing need the
-- entry level of the same module and region. The owner of a sub-task may also change its status and progress with view rights only. The owner must be an active user
-- who can see the parent's region and module. No permission is widened, no role or grant is added.
--
-- RULES. done = progress 100; a progress of 100 sets done; a progress above 0 on an open sub-task sets doing; open = 0. Removing a sub-task hides it (removed_at), it is
-- never deleted. Every create, change and removal is one audit row (sub_task_create, sub_task_update, sub_task_remove). Global records (no region) take no sub-tasks,
-- as they take no comments. Writes go only through the functions below (definer-owned; the app role reads nothing from the table directly).

CREATE TABLE public.sub_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_kind text NOT NULL CHECK (parent_kind IN ('task', 'record')),
  task_id uuid,
  record_entity_id uuid,
  region_id integer NOT NULL,
  module_key text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  owner_user_id uuid REFERENCES public.users(id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'doing', 'done')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  due_date date,
  version integer NOT NULL DEFAULT 1,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL REFERENCES public.users(id),
  CONSTRAINT sub_tasks_parent_ck CHECK ((parent_kind = 'task' AND task_id IS NOT NULL AND record_entity_id IS NULL)
                                     OR (parent_kind = 'record' AND record_entity_id IS NOT NULL AND task_id IS NULL)),
  CONSTRAINT sub_tasks_done_ck CHECK ((state = 'done') = (progress = 100))
);
CREATE INDEX sub_tasks_task_idx ON public.sub_tasks (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX sub_tasks_record_idx ON public.sub_tasks (record_entity_id) WHERE record_entity_id IS NOT NULL;
CREATE INDEX sub_tasks_owner_idx ON public.sub_tasks (owner_user_id) WHERE owner_user_id IS NOT NULL AND removed_at IS NULL;

ALTER TABLE public.sub_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sub_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON public.sub_tasks FOR SELECT USING (public.app_region_check(region_id));
CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON public.sub_tasks FOR EACH ROW EXECUTE FUNCTION public.wf_backstop();

-- The shared check: the parent exists and the caller can see it (and, for a write, holds the entry level). Answers {region, module}.
CREATE OR REPLACE FUNCTION public.sub_task_ctx(p_kind text, p_parent uuid, p_write boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; rr public.register_records%ROWTYPE; regs int[]; mod text; reg int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind = 'task' THEN
    SELECT * INTO t FROM public.task_instances WHERE id = p_parent;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    mod := 'sites'; reg := t.region_id;
  ELSIF p_kind = 'record' THEN
    SELECT * INTO rr FROM public.register_records WHERE entity_id = p_parent ORDER BY is_current DESC, version_no DESC LIMIT 1;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    mod := public.reg_module(rr.register_key); reg := rr.region_id;
    IF mod IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
    IF reg IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'A global record has no region, so it takes no sub-tasks.')); END IF;
  ELSE
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'parent_kind is task or record.'));
  END IF;
  regs := public.wf_actor_regions(mod, 'view');
  IF regs IS NOT NULL AND (cardinality(regs) = 0 OR NOT (reg = ANY (regs))) THEN PERFORM public.wf_err('not_found'); END IF;
  IF p_write THEN
    regs := public.wf_actor_regions(mod, 'entry');
    IF regs IS NOT NULL AND (cardinality(regs) = 0 OR NOT (reg = ANY (regs))) THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need the entry level here to change the sub-tasks.')); END IF;
  END IF;
  RETURN jsonb_build_object('region', reg, 'module', mod);
END $$;

-- The sub-tasks of a parent with the roll-up (done count and mean progress of the visible, not removed sub-tasks) and whether the caller may add.
CREATE OR REPLACE FUNCTION public.sub_tasks_json(p_kind text, p_parent uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ctx jsonb; actor uuid := public.app_actor(); can boolean := true; items jsonb; tot int; dn int; prog int;
BEGIN
  ctx := public.sub_task_ctx(p_kind, p_parent, false);
  BEGIN PERFORM public.sub_task_ctx(p_kind, p_parent, true); EXCEPTION WHEN OTHERS THEN can := false; END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'state', s.state, 'progress', s.progress, 'due_date', s.due_date,
           'owner_id', s.owner_user_id, 'owner_name', u.display_name, 'version', s.version, 'mine', s.owner_user_id = actor,
           'created_at', s.created_at, 'updated_at', s.updated_at) ORDER BY s.created_at, s.id), '[]'::jsonb),
         count(*)::int, count(*) FILTER (WHERE s.state = 'done')::int, coalesce(round(avg(s.progress))::int, 0)
    INTO items, tot, dn, prog
    FROM public.sub_tasks s LEFT JOIN public.users u ON u.id = s.owner_user_id
   WHERE s.removed_at IS NULL AND s.parent_kind = p_kind AND coalesce(s.task_id, s.record_entity_id) = p_parent;
  RETURN jsonb_build_object('items', items, 'rollup', jsonb_build_object('total', tot, 'done', dn, 'progress', prog), 'can_edit', can);
END $$;

-- Create (p_id null), change (If-Match p_version) or remove ({"removed": true}) a sub-task. The patch keys: title, owner_id (null clears), state, progress, due_date (null clears), removed.
CREATE OR REPLACE FUNCTION public.sub_task_save(p_kind text, p_parent uuid, p_id uuid, p_version integer, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); ctx jsonb; reg int; mod text; cur public.sub_tasks; s_state text; s_prog int; s_title text; s_owner uuid; s_due date;
  only_progress boolean; before jsonb; after jsonb; rid uuid; errs jsonb := '[]'::jsonb; k text;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/', 'code', 'invalid', 'message', 'The sub-task is a JSON object.'))));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('title', 'owner_id', 'state', 'progress', 'due_date', 'removed') THEN
      errs := errs || jsonb_build_object('path', '/' || k, 'code', 'unknown_key', 'message', 'Unknown key.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_id IS NULL THEN
    ctx := public.sub_task_ctx(p_kind, p_parent, true);
  ELSE
    SELECT * INTO cur FROM public.sub_tasks x WHERE x.id = p_id AND x.removed_at IS NULL AND x.parent_kind = p_kind AND coalesce(x.task_id, x.record_entity_id) = p_parent FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    IF p_version IS NULL OR p_version <> cur.version THEN
      PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The sub-task changed since you read it. Reload and try again.'));
    END IF;
    only_progress := NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) kk WHERE kk NOT IN ('state', 'progress'));
    IF cur.owner_user_id = actor AND only_progress THEN
      ctx := public.sub_task_ctx(p_kind, p_parent, false);
    ELSE
      ctx := public.sub_task_ctx(p_kind, p_parent, true);
    END IF;
  END IF;
  reg := (ctx ->> 'region')::int; mod := ctx ->> 'module';

  s_title := CASE WHEN p_patch ? 'title' THEN btrim(p_patch ->> 'title') ELSE cur.title END;
  IF s_title IS NULL OR char_length(s_title) NOT BETWEEN 1 AND 200 THEN
    errs := errs || jsonb_build_object('path', '/title', 'code', 'invalid', 'message', 'A title of 1 to 200 characters.');
  END IF;
  s_owner := CASE WHEN p_patch ? 'owner_id' THEN nullif(p_patch ->> 'owner_id', '')::uuid ELSE cur.owner_user_id END;
  IF s_owner IS NOT NULL AND s_owner IS DISTINCT FROM cur.owner_user_id AND NOT public.reg_user_in_scope(s_owner, reg, mod) THEN
    errs := errs || jsonb_build_object('path', '/owner_id', 'code', 'invalid', 'message', 'The owner must be an active user who can see this region and module.');
  END IF;
  s_state := CASE WHEN p_patch ? 'state' THEN p_patch ->> 'state' ELSE coalesce(cur.state, 'open') END;
  IF s_state NOT IN ('open', 'doing', 'done') THEN errs := errs || jsonb_build_object('path', '/state', 'code', 'invalid', 'message', 'open, doing or done.'); s_state := 'open'; END IF;
  IF p_patch ? 'progress' THEN
    IF coalesce(p_patch ->> 'progress', '') !~ '^[0-9]{1,3}$' OR (p_patch ->> 'progress')::int > 100 THEN
      errs := errs || jsonb_build_object('path', '/progress', 'code', 'invalid', 'message', 'A whole number from 0 to 100.'); s_prog := 0;
    ELSE s_prog := (p_patch ->> 'progress')::int; END IF;
  ELSE s_prog := coalesce(cur.progress, 0); END IF;
  s_due := CASE WHEN p_patch ? 'due_date' THEN nullif(p_patch ->> 'due_date', '')::date ELSE cur.due_date END;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  -- done = 100; a progress above 0 on an open sub-task is doing; a status change alone moves the progress with it
  IF p_patch ? 'state' AND NOT (p_patch ? 'progress') THEN
    s_prog := CASE s_state WHEN 'done' THEN 100 WHEN 'open' THEN 0 ELSE CASE WHEN s_prog IN (0, 100) THEN 50 ELSE s_prog END END;
  END IF;
  IF s_prog = 100 THEN s_state := 'done';
  ELSIF s_state = 'done' THEN s_state := 'doing'; IF s_prog = 0 THEN s_prog := 50; END IF;
  ELSIF s_prog > 0 THEN s_state := 'doing';
  ELSE s_state := 'open'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.sub_tasks (parent_kind, task_id, record_entity_id, region_id, module_key, title, owner_user_id, state, progress, due_date, created_by, updated_by)
    VALUES (p_kind, CASE WHEN p_kind = 'task' THEN p_parent END, CASE WHEN p_kind = 'record' THEN p_parent END, reg, mod, s_title, s_owner, s_state, s_prog, s_due, actor, actor)
    RETURNING id INTO rid;
    after := jsonb_build_object('title', s_title, 'owner_id', s_owner, 'state', s_state, 'progress', s_prog, 'due_date', s_due, 'parent_kind', p_kind, 'parent', p_parent);
    PERFORM public.log_audit_write('sub_task_create', 'sub_task', rid::text, NULL, after, NULL, NULL, reg);
    RETURN jsonb_build_object('id', rid, 'version', 1);
  END IF;

  before := jsonb_build_object('title', cur.title, 'owner_id', cur.owner_user_id, 'state', cur.state, 'progress', cur.progress, 'due_date', cur.due_date);
  IF (p_patch ->> 'removed') = 'true' THEN
    UPDATE public.sub_tasks SET removed_at = now(), version = version + 1, updated_at = now(), updated_by = actor WHERE id = p_id;
    PERFORM public.log_audit_write('sub_task_remove', 'sub_task', p_id::text, before, NULL, NULL, NULL, reg);
    RETURN jsonb_build_object('id', p_id, 'version', cur.version + 1);
  END IF;
  after := jsonb_build_object('title', s_title, 'owner_id', s_owner, 'state', s_state, 'progress', s_prog, 'due_date', s_due);
  IF after = before THEN RETURN jsonb_build_object('id', p_id, 'version', cur.version); END IF;
  UPDATE public.sub_tasks SET title = s_title, owner_user_id = s_owner, state = s_state, progress = s_prog, due_date = s_due,
         version = version + 1, updated_at = now(), updated_by = actor WHERE id = p_id;
  PERFORM public.log_audit_write('sub_task_update', 'sub_task', p_id::text, before, after, NULL, NULL, reg);
  RETURN jsonb_build_object('id', p_id, 'version', cur.version + 1);
END $$;

-- Data reset coverage (0152): a sub-task goes with its parent: tasks with the sites part, a record's with the parts of its logical record (kept records keep theirs).
-- data_reset_plan() is an accumulating function: patched in place and idempotently (0361 pattern).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''sub_tasks''' IN def) = 0 THEN
    IF position('(''levels_conversions'',' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the mixed list anchor was not found'; END IF;
    def := replace(def, '(''levels_conversions'',',
      '(''sub_tasks'', ''mixed'', ''*'', ''CASE WHEN t.record_entity_id IS NULL THEN ARRAY[''''sites''''] WHEN EXISTS (SELECT 1 FROM pg_temp.reset_ent e WHERE e.entity_id = t.record_entity_id AND e.kept)'
      || ' THEN ''''{}''''::text[] ELSE coalesce((SELECT e.parts FROM pg_temp.reset_ent e WHERE e.entity_id = t.record_entity_id), ARRAY[''''sites'''']) END''),' || chr(10) || '    (''levels_conversions'',');
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sub_tasks TO pmis_definer;
GRANT SELECT, DELETE ON public.sub_tasks TO pmis_reset_owner;
GRANT SELECT ON public.task_instances, public.register_records, public.users, public.register_definitions TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['sub_task_ctx(text,uuid,boolean)', 'sub_tasks_json(text,uuid)', 'sub_task_save(text,uuid,uuid,integer,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.sub_tasks_json(text, uuid), public.sub_task_save(text, uuid, uuid, integer, jsonb) TO pmis_app;
    REVOKE ALL ON FUNCTION public.sub_task_ctx(text, uuid, boolean) FROM pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.sub_tasks FROM pmis_app;
    GRANT SELECT ON public.sub_tasks TO pmis_app;
  END IF;
END $$;
