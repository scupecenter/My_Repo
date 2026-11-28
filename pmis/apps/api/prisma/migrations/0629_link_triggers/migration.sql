-- 0629_link_triggers: cross-module triggers on the register links (L5, contract 0.15.488). Additive.
-- Mirror: db/sql/628_link_triggers.sql (kept identical to prisma/migrations/0629_link_triggers/migration.sql).
--
-- Choice: a trigger never writes a record. It PROPOSES: when a record of a register is approved and the record it links to (register_links, 0409) carries another
-- value in a date or list field, the daily job writes one proposal (before and after value) and tells the entry holders of the target row of the Matrix. A
-- holder then makes a new version of the approved target record with the existing mechanism (reg_new_version and reg_save_record, as that person, with the
-- grants, the Matrix and the approval chain). The approved record stays in force until the new version is approved. Nothing is written in place.
--   1. link_triggers: opt-in per declared link (off by default): the source field (of the register that holds the link) copied to a target field (of the linked
--      register). Only date and list fields of the same type; never a derived field.
--   2. link_trigger_proposals: the before/after log (a journal): open, applied (with the new version) or dismissed, who and when.
--   3. link_triggers_json / link_trigger_save (System Admin, reason, audit), link_trigger_preview (the dry run: what a run would propose, writes nothing),
--      link_triggers_run (the daily job: proposals, notifications, one audit row per trigger run), link_trigger_proposals_json and link_trigger_proposal_close
--      (the holder or an admin closes a proposal; an applied one must point to a real new version that carries the proposed value).
-- No grant, role or permission is changed. data_reset_plan() is patched in place and idempotently.

CREATE TABLE IF NOT EXISTS link_triggers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_key  text NOT NULL,
  field_code    text NOT NULL,
  source_field  text NOT NULL CHECK (source_field ~ '^[a-z][a-z0-9_]{0,40}$'),
  target_field  text NOT NULL CHECK (target_field ~ '^[a-z][a-z0-9_]{0,40}$'),
  enabled       boolean NOT NULL DEFAULT false,
  rev           integer NOT NULL DEFAULT 1,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (register_key, field_code, target_field),
  FOREIGN KEY (register_key, field_code) REFERENCES register_links (register_key, field_code) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS link_trigger_proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id     uuid NOT NULL REFERENCES link_triggers(id) ON DELETE CASCADE,
  source_record  uuid NOT NULL,
  target_entity  uuid NOT NULL,
  target_record  uuid NOT NULL,
  target_register text NOT NULL,
  target_field   text NOT NULL,
  before_value   text,
  after_value    text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dismissed')),
  new_record     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  closed_by      uuid REFERENCES users(id),
  UNIQUE (trigger_id, source_record)
);
CREATE INDEX IF NOT EXISTS link_trigger_proposals_open ON link_trigger_proposals (status, created_at DESC);

ALTER TABLE link_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_triggers FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_seed_write ON link_triggers FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE link_trigger_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_trigger_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_seed_write ON link_trigger_proposals FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- the fields a trigger may copy: date and list fields, not derived
CREATE OR REPLACE FUNCTION link_trigger_field_type(p_register text, p_field text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT f.field_type FROM public.register_fields f WHERE f.register_key = p_register AND f.code = p_field AND NOT f.derived AND f.field_type IN ('date', 'list', 'list_code') LIMIT 1
$$;

CREATE OR REPLACE FUNCTION link_triggers_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN jsonb_build_object(
    'links', (SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', k.register_key, 'field_code', k.field_code, 'target_register', k.target_register,
        'source_fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'field_type', f.field_type) ORDER BY f.code), '[]'::jsonb) FROM public.register_fields f
                           WHERE f.register_key = k.register_key AND NOT f.derived AND f.field_type IN ('date', 'list', 'list_code')),
        'target_fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'field_type', f.field_type) ORDER BY f.code), '[]'::jsonb) FROM public.register_fields f
                           WHERE f.register_key = k.target_register AND NOT f.derived AND f.field_type IN ('date', 'list', 'list_code'))
      ) ORDER BY k.sort_order, k.register_key, k.field_code), '[]'::jsonb) FROM public.register_links k WHERE k.is_active),
    'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'register_key', t.register_key, 'field_code', t.field_code, 'target_register', k.target_register,
        'source_field', t.source_field, 'target_field', t.target_field, 'enabled', t.enabled, 'rev', t.rev,
        'open_proposals', (SELECT count(*) FROM public.link_trigger_proposals p WHERE p.trigger_id = t.id AND p.status = 'open'))
        ORDER BY t.register_key, t.field_code, t.target_field), '[]'::jsonb)
      FROM public.link_triggers t JOIN public.register_links k ON k.register_key = t.register_key AND k.field_code = t.field_code));
END $$;

CREATE OR REPLACE FUNCTION link_trigger_save(p_id uuid, p_register text, p_field text, p_source_field text, p_target_field text, p_enabled boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE k public.register_links%ROWTYPE; st text; tt text; tid uuid; before jsonb; after jsonb; errs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN errs := errs || jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of at least 3 characters.'); END IF;
  IF p_id IS NOT NULL THEN
    SELECT x.* INTO k FROM public.register_links x JOIN public.link_triggers t ON t.register_key = x.register_key AND t.field_code = x.field_code WHERE t.id = p_id;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'There is no such trigger.')); END IF;
  ELSE
    SELECT * INTO k FROM public.register_links x WHERE x.register_key = p_register AND x.field_code = p_field AND x.is_active;
    IF NOT FOUND THEN errs := errs || jsonb_build_object('path', '/field_code', 'code', 'invalid', 'message', 'A declared, active link of the register.'); END IF;
  END IF;
  IF k.register_key IS NOT NULL THEN
    st := public.link_trigger_field_type(k.register_key, p_source_field);
    tt := public.link_trigger_field_type(k.target_register, p_target_field);
    IF st IS NULL THEN errs := errs || jsonb_build_object('path', '/source_field', 'code', 'invalid', 'message', 'A date or list field of the register, not derived.'); END IF;
    IF tt IS NULL THEN errs := errs || jsonb_build_object('path', '/target_field', 'code', 'invalid', 'message', 'A date or list field of the linked register, not derived.'); END IF;
    IF st IS NOT NULL AND tt IS NOT NULL AND st <> tt THEN errs := errs || jsonb_build_object('path', '/target_field', 'code', 'invalid', 'message', 'The two fields must have the same type.'); END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.link_triggers (register_key, field_code, source_field, target_field, enabled, created_by)
    VALUES (k.register_key, k.field_code, p_source_field, p_target_field, coalesce(p_enabled, false), public.app_actor())
    ON CONFLICT (register_key, field_code, target_field) DO NOTHING RETURNING id INTO tid;
    IF tid IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/target_field', 'code', 'duplicate', 'message', 'This link already has a trigger for that field.')))); END IF;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO after FROM public.link_triggers x WHERE x.id = tid;
    PERFORM public.log_audit_write('link_trigger_create', 'link_trigger', tid::text, NULL, after, btrim(p_reason));
  ELSE
    tid := p_id;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO before FROM public.link_triggers x WHERE x.id = tid;
    UPDATE public.link_triggers x SET source_field = p_source_field, enabled = coalesce(p_enabled, x.enabled), rev = x.rev + 1, updated_at = now()
     WHERE x.id = tid AND p_target_field = x.target_field;
    IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/target_field', 'code', 'immutable', 'message', 'The target field of a trigger does not change.')))); END IF;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO after FROM public.link_triggers x WHERE x.id = tid;
    PERFORM public.log_audit_write('link_trigger_update', 'link_trigger', tid::text, before, after, btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('id', tid);
END $$;

-- What a run would propose now for one trigger: approved current source rows whose link points at an approved current target row with another value, no open
-- version of that target, no proposal yet for that source version. Read only.
CREATE OR REPLACE FUNCTION link_trigger_pending(p_trigger uuid)
RETURNS TABLE (source_record uuid, source_code text, target_entity uuid, target_record uuid, target_register text, target_code text, target_region integer, before_value text, after_value text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.data ->> 'code', g.entity_id, g.id, k.target_register, g.data ->> 'code', g.region_id, nullif(g.data ->> t.target_field, ''), s.data ->> t.source_field
    FROM public.link_triggers t
    JOIN public.register_links k ON k.register_key = t.register_key AND k.field_code = t.field_code AND k.is_active
    JOIN public.register_records s ON s.register_key = t.register_key AND s.is_current AND s.state = 'approved' AND coalesce(s.data ->> t.source_field, '') <> ''
    JOIN public.register_records g ON g.register_key = k.target_register AND g.is_current AND g.state = 'approved'
         AND (g.entity_id::text = s.data ->> t.field_code OR g.id::text = s.data ->> t.field_code)
   WHERE t.id = p_trigger
     AND coalesce(g.data ->> t.target_field, '') <> (s.data ->> t.source_field)
     AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = g.entity_id AND o.state IN ('entry', 'in_review', 'in_approval'))
     AND NOT EXISTS (SELECT 1 FROM public.link_trigger_proposals p WHERE p.trigger_id = t.id AND p.source_record = s.id)
   ORDER BY s.id
$$;

CREATE OR REPLACE FUNCTION link_trigger_preview(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE total integer;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  IF NOT EXISTS (SELECT 1 FROM public.link_triggers t WHERE t.id = p_id) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'There is no such trigger.')); END IF;
  SELECT count(*) INTO total FROM public.link_trigger_pending(p_id);
  RETURN jsonb_build_object('dry_run', true, 'total', total, 'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('source_code', q.source_code, 'target_register', q.target_register,
      'target_code', q.target_code, 'before', q.before_value, 'after', q.after_value)), '[]'::jsonb) FROM (SELECT * FROM public.link_trigger_pending(p_id) LIMIT 200) q));
END $$;

-- The daily run: writes the proposals of every enabled trigger (at most 500 per trigger and run), one in-app notification per entry holder and trigger, and one
-- audit row per trigger that proposed something (the system, via job). A second run adds nothing (the proposal is unique per trigger and source version).
CREATE OR REPLACE FUNCTION link_triggers_run() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t record; r record; n integer; total integer := 0; h record; tr text;
BEGIN
  FOR t IN SELECT x.id, x.register_key, x.field_code, x.target_field, k.target_register FROM public.link_triggers x
           JOIN public.register_links k ON k.register_key = x.register_key AND k.field_code = x.field_code AND k.is_active WHERE x.enabled ORDER BY x.register_key, x.field_code, x.target_field LOOP
    n := 0;
    FOR r IN SELECT * FROM public.link_trigger_pending(t.id) LIMIT 500 LOOP
      INSERT INTO public.link_trigger_proposals (trigger_id, source_record, target_entity, target_record, target_register, target_field, before_value, after_value)
      VALUES (t.id, r.source_record, r.target_entity, r.target_record, r.target_register, t.target_field, r.before_value, r.after_value)
      ON CONFLICT (trigger_id, source_record) DO NOTHING;
      IF FOUND THEN
        n := n + 1;
        FOR h IN SELECT DISTINCT e.user_id FROM public.reg_entry_holders(r.target_register, r.target_region) e LOOP
          IF NOT EXISTS (SELECT 1 FROM public.notifications x WHERE x.user_id = h.user_id AND x.kind = 'alert_rule' AND x.link = '/link-proposals' AND x.read_at IS NULL
                           AND x.title = 'Proposed update from a linked record') THEN
            INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
            VALUES (h.user_id, 'in_app', 'alert_rule', 'Proposed update from a linked record',
                    'A linked record changed. Review the proposed new version of ' || coalesce(r.target_code, r.target_register) || ' (' || t.target_field || ').', '/link-proposals',
                    (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = r.target_register));
          END IF;
        END LOOP;
      END IF;
    END LOOP;
    IF n > 0 THEN
      INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, via, job_name)
      VALUES ('link_trigger_run', 'link_trigger', t.id::text, jsonb_build_object('register', t.register_key, 'field', t.field_code, 'target_field', t.target_field, 'proposals', n),
              'Automatic run of a link trigger: proposals only, no record changed', 'job', 'link_triggers');
      total := total + n;
    END IF;
  END LOOP;
  RETURN total;
END $$;

-- the caller's proposals: an entry holder of the target row (or an admin of settings); open ones by default
CREATE OR REPLACE FUNCTION link_trigger_proposals_json(p_status text DEFAULT 'open') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'target_register', q.target_register, 'target_record', q.target_record,
        'target_version', q.version_no, 'target_code', q.tcode, 'target_field', q.target_field, 'before', q.before_value, 'after', q.after_value, 'created_at', q.created_at,
        'closed_at', q.closed_at, 'new_record', q.new_record) ORDER BY q.created_at DESC, q.id)
    FROM (SELECT p.*, g.version AS version_no, g.data ->> 'code' AS tcode FROM public.link_trigger_proposals p JOIN public.register_records g ON g.id = p.target_record
           WHERE (p_status = 'all' OR p.status = coalesce(p_status, 'open'))
             AND (public.app_actor_is_admin('settings', 'edit') OR EXISTS (SELECT 1 FROM public.reg_entry_holders(p.target_register, g.region_id) e WHERE e.user_id = a))
           ORDER BY p.created_at DESC LIMIT 200) q), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION link_trigger_proposal_close(p_id uuid, p_status text, p_new_record uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); p public.link_trigger_proposals%ROWTYPE; g public.register_records%ROWTYPE; n public.register_records%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_status NOT IN ('applied', 'dismissed') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/status', 'code', 'invalid', 'message', 'applied or dismissed')))); END IF;
  SELECT * INTO p FROM public.link_trigger_proposals x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'There is no such proposal.')); END IF;
  SELECT * INTO g FROM public.register_records x WHERE x.id = p.target_record;
  IF NOT (public.app_actor_is_admin('settings', 'edit') OR EXISTS (SELECT 1 FROM public.reg_entry_holders(p.target_register, g.region_id) e WHERE e.user_id = a)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'There is no such proposal.'));
  END IF;
  IF p.status <> 'open' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The proposal is closed already.')); END IF;
  IF p_status = 'applied' THEN
    SELECT * INTO n FROM public.register_records x WHERE x.id = p_new_record;
    IF NOT FOUND OR n.entity_id <> p.target_entity OR n.supersedes_id IS DISTINCT FROM p.target_record OR n.state <> 'entry' OR n.created_by IS DISTINCT FROM a
       OR coalesce(n.data ->> p.target_field, '') <> p.after_value THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/new_record', 'code', 'invalid',
        'message', 'The new version must be yours, in entry, made from the target record and carry the proposed value.'))));
    END IF;
  END IF;
  UPDATE public.link_trigger_proposals x SET status = p_status, new_record = CASE WHEN p_status = 'applied' THEN p_new_record END, closed_at = now(), closed_by = a WHERE x.id = p_id;
  PERFORM public.log_audit_write('link_trigger_proposal_' || p_status, 'link_trigger_proposal', p_id::text,
    jsonb_build_object('field', p.target_field, 'value', p.before_value), jsonb_build_object('field', p.target_field, 'value', p.after_value, 'new_record', p_new_record), 'Proposal of a link trigger');
  RETURN jsonb_build_object('id', p_id, 'status', p_status);
END $$;

-- data reset (0152): triggers are configuration (KEEP), proposals a journal (LOG). data_reset_plan() is patched in place and idempotently.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''link_triggers''' IN def) = 0 THEN
    IF position('''phase_gate_rules''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''phase_gate_rules''', '''phase_gate_rules'', ''link_triggers''');
  END IF;
  IF position('''link_trigger_proposals''' IN def) = 0 THEN
    IF position('''job_runs''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the log list anchor was not found'; END IF;
    def := replace(def, '''job_runs''', '''job_runs'', ''link_trigger_proposals''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.link_triggers, public.link_trigger_proposals TO pmis_reset_owner;
ALTER TABLE public.link_triggers OWNER TO pmis_definer;
ALTER TABLE public.link_trigger_proposals OWNER TO pmis_definer;
REVOKE ALL ON public.link_triggers, public.link_trigger_proposals FROM PUBLIC;
GRANT INSERT ON public.audit_log TO pmis_definer;
GRANT SELECT ON public.register_records, public.register_links, public.register_fields TO pmis_definer;
GRANT SELECT, INSERT ON public.notifications TO pmis_definer;
DO $$
BEGIN
  ALTER FUNCTION link_trigger_field_type(text, text) OWNER TO pmis_definer;
  ALTER FUNCTION link_triggers_json() OWNER TO pmis_definer;
  ALTER FUNCTION link_trigger_save(uuid, text, text, text, text, boolean, text) OWNER TO pmis_definer;
  ALTER FUNCTION link_trigger_pending(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION link_trigger_preview(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION link_triggers_run() OWNER TO pmis_definer;
  ALTER FUNCTION link_trigger_proposals_json(text) OWNER TO pmis_definer;
  ALTER FUNCTION link_trigger_proposal_close(uuid, text, uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION link_trigger_field_type(text, text), link_triggers_json(), link_trigger_save(uuid, text, text, text, text, boolean, text), link_trigger_pending(uuid),
    link_trigger_preview(uuid), link_triggers_run(), link_trigger_proposals_json(text), link_trigger_proposal_close(uuid, text, uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION link_trigger_field_type(text, text), link_triggers_json(), link_trigger_save(uuid, text, text, text, text, boolean, text), link_trigger_pending(uuid),
    link_trigger_preview(uuid), link_triggers_run(), link_trigger_proposals_json(text), link_trigger_proposal_close(uuid, text, uuid) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION link_triggers_json(), link_trigger_save(uuid, text, text, text, text, boolean, text), link_trigger_preview(uuid), link_triggers_run(),
      link_trigger_proposals_json(text), link_trigger_proposal_close(uuid, text, uuid) TO pmis_app;
  END IF;
END $$;
