-- 0622_assignment_rules: auto-assign by rule, on top of the Responsibility Matrix (contract 0.15.481). Additive. Mirror: db/sql/621_assignment_rules.sql
-- (kept identical to prisma/migrations/0622_assignment_rules/migration.sql). Builds on the Automation centre (0612).
--
-- WHAT. A System Admin keeps a short list of rules such as "region X, this task or register, this level: person Y". When a level opens with the rule
-- "any one" and nobody was named, the most specific matching rule names its person as the one holding the ball, and that person is told. This is the same
-- pin an assignment by hand sets. A rule never adds a holder: the person must already be eligible for that level by the matrix, the grants and the region, or the
-- rule is skipped and the level opens as before. Several-must-agree levels (all members) are not touched.
-- Earlier decision: a separate routing engine was dropped because the matrix already routes (plan 2026-11-07). This is not an engine: it only picks among the
-- people the matrix already allows, as the 2026-11-28 request for rule-based assignment asks.
--
-- SPECIFICITY. A rule can name a region, a task code (or a register key) and a level kind (entry, review, approve); an empty field means any. The score is
-- region 4, code 2, level 1; ties go to the older rule. Hide, never delete. Audit assign_rule_create, assign_rule_update, assign_rule_remove.

CREATE TABLE public.assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applies_to text NOT NULL CHECK (applies_to IN ('task', 'record')),
  region_id integer,
  item_key text CHECK (item_key IS NULL OR char_length(item_key) BETWEEN 1 AND 80),
  level_kind text CHECK (level_kind IS NULL OR level_kind IN ('entry', 'review', 'approve')),
  user_id uuid NOT NULL REFERENCES public.users(id),
  enabled boolean NOT NULL DEFAULT true,
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  version integer NOT NULL DEFAULT 1,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL REFERENCES public.users(id)
);
CREATE INDEX assignment_rules_live_idx ON public.assignment_rules (applies_to) WHERE enabled AND removed_at IS NULL;
ALTER TABLE public.assignment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignment_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON public.assignment_rules FOR SELECT USING (public.app_user_is_system_admin(public.app_actor()));
CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON public.assignment_rules FOR EACH ROW EXECUTE FUNCTION public.wf_backstop();

-- The picks: the most specific enabled rule whose person is eligible for the level. NULL when none matches.
CREATE OR REPLACE FUNCTION public.assign_rule_pick_task(p_task uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.user_id FROM public.assignment_rules a
    JOIN public.task_instances t ON t.id = p_task
    JOIN public.task_definitions td ON td.id = t.task_def_id
   WHERE a.applies_to = 'task' AND a.enabled AND a.removed_at IS NULL
     AND (a.region_id IS NULL OR a.region_id = t.region_id)
     AND (a.item_key IS NULL OR a.item_key = td.code)
     AND (a.level_kind IS NULL OR a.level_kind = p_kind)
     AND EXISTS (SELECT 1 FROM public.wf_eligible(p_task, p_kind) e WHERE e.user_id = a.user_id)
   ORDER BY (CASE WHEN a.region_id IS NOT NULL THEN 4 ELSE 0 END + CASE WHEN a.item_key IS NOT NULL THEN 2 ELSE 0 END + CASE WHEN a.level_kind IS NOT NULL THEN 1 ELSE 0 END) DESC,
            a.created_at, a.id
   LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.assign_rule_pick_record(p_record uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.user_id FROM public.assignment_rules a
    JOIN public.register_records r ON r.id = p_record
   WHERE a.applies_to = 'record' AND a.enabled AND a.removed_at IS NULL
     AND (a.region_id IS NULL OR a.region_id = r.region_id)
     AND (a.item_key IS NULL OR a.item_key = r.register_key)
     AND (a.level_kind IS NULL OR a.level_kind = p_kind)
     AND EXISTS (SELECT 1 FROM public.reg_eligible(p_record, p_kind) e WHERE e.user_id = a.user_id)
   ORDER BY (CASE WHEN a.region_id IS NOT NULL THEN 4 ELSE 0 END + CASE WHEN a.item_key IS NOT NULL THEN 2 ELSE 0 END + CASE WHEN a.level_kind IS NOT NULL THEN 1 ELSE 0 END) DESC,
            a.created_at, a.id
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.assignment_rules_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_user_is_system_admin(public.app_actor()) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin manages assignment rules.'));
  END IF;
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'applies_to', a.applies_to, 'region_id', a.region_id, 'item_key', a.item_key,
      'level_kind', a.level_kind, 'user_id', a.user_id, 'user_name', u.display_name, 'enabled', a.enabled, 'note', a.note, 'version', a.version,
      'eligible_now', true) ORDER BY a.created_at, a.id)
    FROM public.assignment_rules a JOIN public.users u ON u.id = a.user_id WHERE a.removed_at IS NULL), '[]'::jsonb));
END $$;

-- Create (p_id null), change (If-Match p_version) or remove ({"removed": true}). Keys: applies_to, region_id, item_key, level_kind, user_id, enabled, note.
CREATE OR REPLACE FUNCTION public.assignment_rule_save(p_id uuid, p_version integer, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); cur public.assignment_rules; k text; errs jsonb := '[]'::jsonb;
  a_to text; a_reg int; a_key text; a_kind text; a_user uuid; a_en boolean; a_note text; before jsonb; after jsonb; rid uuid;
BEGIN
  IF actor IS NULL OR NOT public.app_user_is_system_admin(actor) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin manages assignment rules.'));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/', 'code', 'invalid', 'message', 'A JSON object.'))));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('applies_to', 'region_id', 'item_key', 'level_kind', 'user_id', 'enabled', 'note', 'removed') THEN
      errs := errs || jsonb_build_object('path', '/' || k, 'code', 'unknown_key', 'message', 'Unknown key.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO cur FROM public.assignment_rules WHERE id = p_id AND removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    IF p_version IS NULL OR p_version <> cur.version THEN
      PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The rule changed since you read it. Reload and try again.'));
    END IF;
    before := jsonb_build_object('applies_to', cur.applies_to, 'region_id', cur.region_id, 'item_key', cur.item_key, 'level_kind', cur.level_kind, 'user_id', cur.user_id, 'enabled', cur.enabled, 'note', cur.note);
    IF (p_patch ->> 'removed') = 'true' THEN
      UPDATE public.assignment_rules SET removed_at = now(), version = version + 1, updated_at = now(), updated_by = actor WHERE id = p_id;
      PERFORM public.log_audit_write('assign_rule_remove', 'assignment_rule', p_id::text, before, NULL, NULL, NULL, NULL);
      RETURN jsonb_build_object('id', p_id, 'version', cur.version + 1);
    END IF;
  END IF;
  a_to := CASE WHEN p_patch ? 'applies_to' THEN p_patch ->> 'applies_to' ELSE cur.applies_to END;
  IF a_to IS NULL OR a_to NOT IN ('task', 'record') THEN errs := errs || jsonb_build_object('path', '/applies_to', 'code', 'invalid', 'message', 'task or record.'); END IF;
  a_reg := CASE WHEN p_patch ? 'region_id' THEN nullif(p_patch ->> 'region_id', '')::int ELSE cur.region_id END;
  IF a_reg IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.regions WHERE id = a_reg) THEN errs := errs || jsonb_build_object('path', '/region_id', 'code', 'unknown', 'message', 'Unknown region.'); END IF;
  a_key := CASE WHEN p_patch ? 'item_key' THEN nullif(btrim(p_patch ->> 'item_key'), '') ELSE cur.item_key END;
  IF a_key IS NOT NULL AND char_length(a_key) > 80 THEN errs := errs || jsonb_build_object('path', '/item_key', 'code', 'invalid', 'message', 'At most 80 characters.'); END IF;
  a_kind := CASE WHEN p_patch ? 'level_kind' THEN nullif(p_patch ->> 'level_kind', '') ELSE cur.level_kind END;
  IF a_kind IS NOT NULL AND a_kind NOT IN ('entry', 'review', 'approve') THEN errs := errs || jsonb_build_object('path', '/level_kind', 'code', 'invalid', 'message', 'entry, review or approve.'); END IF;
  a_user := CASE WHEN p_patch ? 'user_id' THEN nullif(p_patch ->> 'user_id', '')::uuid ELSE cur.user_id END;
  IF a_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = a_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass) THEN
    errs := errs || jsonb_build_object('path', '/user_id', 'code', 'invalid', 'message', 'The person must be an active user.');
  END IF;
  a_en := CASE WHEN p_patch ? 'enabled' THEN (p_patch ->> 'enabled')::boolean ELSE coalesce(cur.enabled, true) END;
  a_note := CASE WHEN p_patch ? 'note' THEN nullif(btrim(p_patch ->> 'note'), '') ELSE cur.note END;
  IF a_note IS NOT NULL AND char_length(a_note) > 300 THEN errs := errs || jsonb_build_object('path', '/note', 'code', 'invalid', 'message', 'At most 300 characters.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  after := jsonb_build_object('applies_to', a_to, 'region_id', a_reg, 'item_key', a_key, 'level_kind', a_kind, 'user_id', a_user, 'enabled', a_en, 'note', a_note);
  IF p_id IS NULL THEN
    INSERT INTO public.assignment_rules (applies_to, region_id, item_key, level_kind, user_id, enabled, note, created_by, updated_by)
    VALUES (a_to, a_reg, a_key, a_kind, a_user, a_en, a_note, actor, actor) RETURNING id INTO rid;
    PERFORM public.log_audit_write('assign_rule_create', 'assignment_rule', rid::text, NULL, after, NULL, NULL, a_reg);
    RETURN jsonb_build_object('id', rid, 'version', 1);
  END IF;
  IF after = before THEN RETURN jsonb_build_object('id', p_id, 'version', cur.version); END IF;
  UPDATE public.assignment_rules SET applies_to = a_to, region_id = a_reg, item_key = a_key, level_kind = a_kind, user_id = a_user, enabled = a_en, note = a_note,
         version = version + 1, updated_at = now(), updated_by = actor WHERE id = p_id;
  PERFORM public.log_audit_write('assign_rule_update', 'assignment_rule', p_id::text, before, after, NULL, NULL, a_reg);
  RETURN jsonb_build_object('id', p_id, 'version', cur.version + 1);
END $$;

-- Wire the picks into the two level openers, patched in place and idempotently (the 0361 pattern). Each anchor must exist or the migration stops.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wf_open_level(uuid,integer,uuid)'::regprocedure);
  IF position('assign_rule_pick_task' IN def) = 0 THEN
    IF position('rl public."MatrixRule";' IN def) = 0 OR position('  UPDATE public.task_instances SET state = st' IN def) = 0
       OR position('ball_in_court_user_id = CASE WHEN rl = ''any_one'' THEN p_pin END' IN def) = 0 OR position('  IF rl = ''all_members'' THEN' IN def) = 0 THEN
      RAISE EXCEPTION 'wf_open_level: an anchor was not found';
    END IF;
    def := replace(def, 'rl public."MatrixRule";', 'rl public."MatrixRule"; ar uuid;');
    def := replace(def, '  UPDATE public.task_instances SET state = st',
      '  ar := CASE WHEN rl = ''any_one'' AND p_pin IS NULL THEN public.assign_rule_pick_task(p_task, k) END;' || chr(10) || '  UPDATE public.task_instances SET state = st');
    def := replace(def, 'ball_in_court_user_id = CASE WHEN rl = ''any_one'' THEN p_pin END', 'ball_in_court_user_id = CASE WHEN rl = ''any_one'' THEN coalesce(p_pin, ar) END');
    def := replace(def, '  IF rl = ''all_members'' THEN',
      '  IF ar IS NOT NULL THEN PERFORM public.wf_notify(ar, ''task_assigned'', ''A task was assigned to you by a rule'', public.wf_label(p_task), p_task); END IF;' || chr(10) || '  IF rl = ''all_members'' THEN');
    EXECUTE def;
  END IF;
  def := pg_get_functiondef('public.reg_open_level(uuid,integer,uuid)'::regprocedure);
  IF position('assign_rule_pick_record' IN def) = 0 THEN
    IF position('rl public."MatrixRule";' IN def) = 0 OR position('  UPDATE public.register_records SET state = st' IN def) = 0
       OR position('ball_in_court_user_id = CASE WHEN rl = ''any_one'' THEN p_pin END' IN def) = 0 OR position('  IF rl = ''all_members'' THEN' IN def) = 0 THEN
      RAISE EXCEPTION 'reg_open_level: an anchor was not found';
    END IF;
    def := replace(def, 'rl public."MatrixRule";', 'rl public."MatrixRule"; ar uuid;');
    def := replace(def, '  UPDATE public.register_records SET state = st',
      '  ar := CASE WHEN rl = ''any_one'' AND p_pin IS NULL THEN public.assign_rule_pick_record(p_record, k) END;' || chr(10) || '  UPDATE public.register_records SET state = st');
    def := replace(def, 'ball_in_court_user_id = CASE WHEN rl = ''any_one'' THEN p_pin END', 'ball_in_court_user_id = CASE WHEN rl = ''any_one'' THEN coalesce(p_pin, ar) END');
    def := replace(def, '  IF rl = ''all_members'' THEN',
      '  IF ar IS NOT NULL THEN PERFORM public.reg_notify(ar, ''task_assigned'', ''A record was assigned to you by a rule'', public.reg_label(p_record), p_record); END IF;' || chr(10) || '  IF rl = ''all_members'' THEN');
    EXECUTE def;
  END IF;
END $$;

-- Data reset coverage (0152): the rules are configuration and are kept (a reset of project data never removes them).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''assignment_rules''' IN def) = 0 THEN
    IF (length(def) - length(replace(def, '''data_reset_marker''', ''))) <> length('''data_reset_marker''') THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''data_reset_marker''', '''data_reset_marker'', ''assignment_rules''');
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.assignment_rules TO pmis_definer;
GRANT SELECT ON public.task_instances, public.task_definitions, public.register_records, public.users, public.regions TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['assign_rule_pick_task(uuid,text)', 'assign_rule_pick_record(uuid,text)', 'assignment_rules_json()', 'assignment_rule_save(uuid,integer,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.assignment_rules_json(), public.assignment_rule_save(uuid, integer, jsonb) TO pmis_app;
    REVOKE ALL ON FUNCTION public.assign_rule_pick_task(uuid, text), public.assign_rule_pick_record(uuid, text) FROM pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assignment_rules FROM pmis_app;
    GRANT SELECT ON public.assignment_rules TO pmis_app;
  END IF;
END $$;
