-- 0562: the rules of structure-change proposals (slice 2 of 0560). The setting `registers.structure_change` says who proposes, who approves, when a second person is required,
-- the most items in one proposal and the two notices. The five doors of 0560 are patched IN PLACE from their stored text (idempotent, no door is redefined whole).
-- Defaults equal the behaviour of 0560 for approval (System Admin, a second person for a type change or a hide); the new defaults only widen nothing: proposers stay holders of the columns edit right.
-- Additive: one setting, five functions, two notification kinds in the mail catalogue (never mailed until an admin lists them). No table, no grant, no permission change.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('registers.structure_change',
        '{"who_proposes": "fields_editors", "who_approves": "admins", "two_person": "risky_only", "max_items": 200, "notify_approvers": true, "notify_proposer": true}'::jsonb,
        '0562: structure-change proposals. who_proposes: fields_editors|admins. who_approves: admins|fields_editors. two_person: risky_only|always (a type change or a hide always needs a second person). max_items 1..500. Notices to the approvers and to the proposer.',
        now())
ON CONFLICT (key) DO NOTHING;

-- the setting changes only through its door
DROP TRIGGER IF EXISTS b_settings_struct ON settings;
DROP TRIGGER IF EXISTS b_settings_struct_update ON settings;
DROP TRIGGER IF EXISTS b_settings_struct_delete ON settings;
CREATE TRIGGER b_settings_struct BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'registers.structure_change') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_struct_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'registers.structure_change' OR NEW.key = 'registers.structure_change') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_struct_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'registers.structure_change') EXECUTE FUNCTION settings_guarded_keys();

CREATE OR REPLACE FUNCTION struct_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'who_proposes', CASE WHEN v ->> 'who_proposes' = 'admins' THEN 'admins' ELSE 'fields_editors' END,
    'who_approves', CASE WHEN v ->> 'who_approves' = 'fields_editors' THEN 'fields_editors' ELSE 'admins' END,
    'two_person', CASE WHEN v ->> 'two_person' = 'always' THEN 'always' ELSE 'risky_only' END,
    'max_items', CASE WHEN (v ->> 'max_items') ~ '^[0-9]+$' AND (v ->> 'max_items')::int BETWEEN 1 AND 500 THEN (v ->> 'max_items')::int ELSE 200 END,
    'notify_approvers', coalesce((v ->> 'notify_approvers')::boolean, true),
    'notify_proposer', coalesce((v ->> 'notify_proposer')::boolean, true))
  FROM (SELECT coalesce((SELECT value FROM public.settings WHERE key = 'registers.structure_change'), '{}'::jsonb) AS v) s
$$;

CREATE OR REPLACE FUNCTION struct_cfg_of(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT p - 'updated_at' - 'updated_by' - 'version' - 'can_edit' $$;

CREATE OR REPLACE FUNCTION struct_policy_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'registers.structure_change';
  RETURN public.struct_cfg() || jsonb_build_object('updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('registers.structure_change'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_struct_policy(p_cfg jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; k text; errs jsonb := '[]'::jsonb; nxt jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_cfg IS NULL OR jsonb_typeof(p_cfg) <> 'object' THEN p_cfg := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_cfg) LOOP
    IF k NOT IN ('who_proposes', 'who_approves', 'two_person', 'max_items', 'notify_approvers', 'notify_proposer') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.'); END IF;
  END LOOP;
  IF p_cfg ? 'who_proposes' AND coalesce(p_cfg ->> 'who_proposes', '') NOT IN ('fields_editors', 'admins') THEN errs := errs || public.reg_err_item('/who_proposes', 'invalid', 'fields_editors or admins.'); END IF;
  IF p_cfg ? 'who_approves' AND coalesce(p_cfg ->> 'who_approves', '') NOT IN ('admins', 'fields_editors') THEN errs := errs || public.reg_err_item('/who_approves', 'invalid', 'admins or fields_editors.'); END IF;
  IF p_cfg ? 'two_person' AND coalesce(p_cfg ->> 'two_person', '') NOT IN ('risky_only', 'always') THEN errs := errs || public.reg_err_item('/two_person', 'invalid', 'risky_only or always. A type change or a hide always needs a second person.'); END IF;
  IF p_cfg ? 'max_items' AND (jsonb_typeof(p_cfg -> 'max_items') <> 'number' OR (p_cfg ->> 'max_items')::numeric <> trunc((p_cfg ->> 'max_items')::numeric) OR (p_cfg ->> 'max_items')::numeric NOT BETWEEN 1 AND 500) THEN
    errs := errs || public.reg_err_item('/max_items', 'out_of_range', 'A whole number from 1 to 500.'); END IF;
  IF p_cfg ? 'notify_approvers' AND jsonb_typeof(p_cfg -> 'notify_approvers') <> 'boolean' THEN errs := errs || public.reg_err_item('/notify_approvers', 'invalid', 'true or false.'); END IF;
  IF p_cfg ? 'notify_proposer' AND jsonb_typeof(p_cfg -> 'notify_proposer') <> 'boolean' THEN errs := errs || public.reg_err_item('/notify_proposer', 'invalid', 'true or false.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.settings (key, value, description, updated_at) VALUES ('registers.structure_change', '{}'::jsonb, '0562: structure-change proposals.', now()) ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'registers.structure_change' FOR UPDATE;
  cur := public.struct_policy_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  nxt := public.struct_cfg() || p_cfg;
  IF nxt = public.struct_cfg() THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These values are already set.')); END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'registers.structure_change';
  res := public.struct_policy_json();
  PERFORM public.log_audit_write('structure_policy_update', 'setting', 'registers.structure_change', public.struct_cfg_of(cur), public.struct_cfg_of(res), btrim(p_reason));
  RETURN res;
END $$;

-- who may propose / approve under the setting: a System Admin when the setting says admins; a holder of the columns edit right for all regions when it says fields_editors
CREATE OR REPLACE FUNCTION struct_require(p_what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.struct_cfg(); who text := CASE WHEN p_what = 'propose' THEN c ->> 'who_proposes' ELSE c ->> 'who_approves' END;
BEGIN
  IF who = 'admins' THEN
    IF NOT public.app_actor_is_system_admin() THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', CASE WHEN p_what = 'propose' THEN 'Only a System Admin proposes a structure change (Settings, Registers, Columns, rules).' ELSE 'Only a System Admin approves a structure proposal (Settings, Registers, Columns, rules).' END));
    END IF;
  ELSE
    PERFORM public.calc_require_admin('fields', true);
  END IF;
END $$;

-- patch the five doors in place
DO $$
DECLARE def text; nw text;
BEGIN
  -- the proposal JSON: a second person is needed for a risky item, or always when the rule says so
  def := pg_get_functiondef('public.structure_proposal_json(public.structure_proposals)'::regprocedure);
  IF position('struct_cfg' IN def) = 0 THEN
    nw := replace(def, '''needs_two_people'', EXISTS (', '''needs_two_people'', (public.struct_cfg() ->> ''two_person'' = ''always'') OR EXISTS (');
    IF nw = def THEN RAISE EXCEPTION 'structure_proposal_json: needs_two_people not found'; END IF;
    EXECUTE nw;
  END IF;

  -- create: who proposes, the size limit, the notice to the approvers
  def := pg_get_functiondef('public.admin_structure_proposal_create(text, jsonb, text, text, integer)'::regprocedure);
  IF position('struct_require' IN def) = 0 THEN
    nw := replace(def, E'  PERFORM public.calc_require_admin(''fields'', true);', E'  PERFORM public.struct_require(''propose'');');
    IF nw = def THEN RAISE EXCEPTION 'create: require not found'; END IF;
    def := nw;
    nw := replace(def, E'  SELECT array_agg(i ->> ''code'') INTO codes', E'  IF jsonb_array_length(items) > (public.struct_cfg() ->> ''max_items'')::int THEN\n    PERFORM public.wf_err(''validation_failed'', jsonb_build_object(''errors'', public.reg_err_item(''/rows'', ''too_many'', format(''A proposal holds at most %s items (Settings, Registers, Columns, rules). This one has %s.'', public.struct_cfg() ->> ''max_items'', jsonb_array_length(items)))));\n  END IF;\n  SELECT array_agg(i ->> ''code'') INTO codes');
    IF nw = def THEN RAISE EXCEPTION 'create: size limit anchor not found'; END IF;
    def := nw;
    nw := replace(def, 'app_user_is_system_admin(u.id);', 'app_user_is_system_admin(u.id) AND (public.struct_cfg() ->> ''notify_approvers'')::boolean;');
    IF nw = def THEN RAISE EXCEPTION 'create: notice anchor not found'; END IF;
    EXECUTE nw;
  END IF;

  -- decide: who approves, the notice to the proposer (also on a rejection), the kind structure_decision
  def := pg_get_functiondef('public.admin_structure_proposal_decide(uuid, text, text, integer)'::regprocedure);
  IF position('struct_require' IN def) = 0 THEN
    nw := replace(def, E'  PERFORM public.calc_require_admin(''fields'', true);', E'  PERFORM public.struct_require(''approve'');');
    IF nw = def THEN RAISE EXCEPTION 'decide: require not found'; END IF;
    def := nw;
    nw := replace(def, 'A different System Admin must approve a proposal that changes a type or hides a column.', 'A second person must approve this proposal: a type change or a hide always needs one, and the rule in Settings, Registers, Columns can ask for one every time.');
    IF nw = def THEN RAISE EXCEPTION 'decide: two person text not found'; END IF;
    def := nw;
    nw := replace(def, E'  IF NOT public.app_actor_is_system_admin() THEN PERFORM public.wf_err(''action_forbidden'', jsonb_build_object(''detail'', ''Only a System Admin approves a structure proposal.'')); END IF;\n', '');
    IF nw = def THEN RAISE EXCEPTION 'decide: admin check not found'; END IF;
    def := nw;
    nw := replace(def, E'p.decide_note);\n    RETURN public.structure_proposal_json(p);', E'p.decide_note);\n    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)\n    SELECT p.submitted_by, ''in_app'', ''structure_decision'', ''Your structure proposal was rejected'', format(''The change of the structure of %s was rejected: %s'', p.register_key, p.decide_note), ''/admin/settings/data/structure''\n    WHERE p.submitted_by <> who AND (public.struct_cfg() ->> ''notify_proposer'')::boolean;\n    RETURN public.structure_proposal_json(p);');
    IF nw = def THEN RAISE EXCEPTION 'decide: reject anchor not found'; END IF;
    def := nw;
    nw := replace(def, E'  SELECT p.submitted_by, ''in_app'', ''structure_proposal'', ''Your structure proposal was applied'',', E'  SELECT p.submitted_by, ''in_app'', ''structure_decision'', ''Your structure proposal was applied'',');
    IF nw = def THEN RAISE EXCEPTION 'decide: apply notice anchor not found'; END IF;
    def := nw;
    nw := replace(def, E'''/admin/settings/data/structure'';\n  RETURN public.structure_proposal_json(p);', E'''/admin/settings/data/structure'' WHERE p.submitted_by <> who AND (public.struct_cfg() ->> ''notify_proposer'')::boolean;\n  RETURN public.structure_proposal_json(p);');
    IF nw = def THEN RAISE EXCEPTION 'decide: apply notice end not found'; END IF;
    EXECUTE nw;
  END IF;

  -- revert: a proposal like any other (who proposes)
  def := pg_get_functiondef('public.admin_structure_proposal_revert(uuid, text)'::regprocedure);
  IF position('struct_require' IN def) = 0 THEN
    nw := replace(def, E'  PERFORM public.calc_require_admin(''fields'', true);', E'  PERFORM public.struct_require(''propose'');');
    IF nw = def THEN RAISE EXCEPTION 'revert: require not found'; END IF;
    EXECUTE nw;
  END IF;
END $$;

-- the two kinds join the mail catalogue (never mailed until an admin lists them), patched in place like 0364
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.mail_kind_catalogue()'::regprocedure);
  IF position('''structure_proposal''' IN def) = 0 THEN
    IF def !~ E'\\n\\s*\\]\\) WITH ORDINALITY' THEN RAISE EXCEPTION 'mail_kind_catalogue: the end of the kind list was not found'; END IF;
    def := regexp_replace(def, E'(\\n\\s*)\\]\\) WITH ORDINALITY', E',\\1  ''structure_proposal'', ''structure_decision''\\1]) WITH ORDINALITY');
    EXECUTE def;
  END IF;
END $$;

-- the reset role reads it and updates it (KEEP: user references are blanked for deactivated accounts like in the other kept tables)
GRANT SELECT, UPDATE ON structure_proposals TO pmis_reset_owner;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'structure_proposals' AND policyname = 'structure_proposals_reset') THEN
    CREATE POLICY structure_proposals_reset ON structure_proposals FOR ALL TO pmis_reset_owner USING (true) WITH CHECK (true);
  END IF;
END $$;

-- the proposals table (0560) has a decision in the reset plan: KEEP, like the register definitions it changes (configuration, not project data).
DO $$
DECLARE def text; n text := '''register_column_locks'', ';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('structure_proposals' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the configuration list (register_column_locks) was not found'; END IF;
    EXECUTE replace(def, n, n || '''structure_proposals'', ');
  END IF;
END $$;

-- owners and grants
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['struct_cfg()', 'struct_cfg_of(jsonb)', 'struct_policy_json()', 'admin_set_struct_policy(jsonb, text, integer)', 'struct_require(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['struct_policy_json()', 'admin_set_struct_policy(jsonb, text, integer)'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', fn); END IF;
  END LOOP;
  GRANT SELECT, UPDATE, INSERT ON settings TO pmis_definer;
END $$;
