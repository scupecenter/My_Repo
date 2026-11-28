-- 0560_structure_proposals: change the structure of a register by uploading a modified template (Data entry proposals S1 to S9, approved by the owner 2026-11-27 09:50 and 09:54; contract 0.15.401).
-- Mirror: db/sql/559_structure_proposals.sql (kept byte-identical).
--
-- Nothing changes from Excel directly. The "Structure" sheet of a downloaded register template (or the system's own column screen) becomes a STRUCTURE PROPOSAL: the rows are
-- read, compared with register_fields (the live definition), every item gets its effect on the data (admin_reg_field_impact / rcol_conversion) and the forbidden items (S8) are
-- marked blocked. A System Admin approves (step-up in the API): the approval applies each item through the EXISTING column doors of migration 0094 (admin_reg_field_save) in one
-- transaction (one item fails = all roll back); tpl_sync_all() then issues the new template version by the existing triggers, and old files follow rule D112. A rollback is a
-- proposal of its own (the "before" snapshot of the items) that goes through the same approval. Hiding (is_active false) replaces deleting; codes never change.
-- The two-person rule (submitter <> approver) is always on when the proposal changes a type or hides a column.

-- 1. The proposals. Written only by the doors below (owner pmis_definer); the API role has no write right on the table.
CREATE TABLE IF NOT EXISTS structure_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_key    text NOT NULL REFERENCES register_definitions (register_key),
  status          text NOT NULL DEFAULT 'pending',
  source          text NOT NULL DEFAULT 'excel',
  template_version integer,
  submitted_by    uuid NOT NULL,
  submitted_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason          text NOT NULL,
  rows            jsonb NOT NULL DEFAULT '[]'::jsonb,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  before_rows     jsonb NOT NULL DEFAULT '[]'::jsonb,
  reverts_id      uuid REFERENCES structure_proposals (id),
  decided_by      uuid,
  decided_at      timestamptz,
  decide_note     text,
  applied_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT structure_proposals_status_chk CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'reverted')),
  CONSTRAINT structure_proposals_source_chk CHECK (source IN ('excel', 'system'))
);
CREATE INDEX IF NOT EXISTS structure_proposals_register_idx ON structure_proposals (register_key, submitted_at DESC);
ALTER TABLE structure_proposals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'structure_proposals' AND policyname = 'structure_proposals_door') THEN
    CREATE POLICY structure_proposals_door ON structure_proposals FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
  END IF;
END $$;
DO $$ BEGIN
  EXECUTE 'ALTER TABLE structure_proposals OWNER TO pmis_definer';
  EXECUTE 'REVOKE ALL ON structure_proposals FROM PUBLIC';
  EXECUTE 'GRANT ALL ON structure_proposals TO pmis_definer';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON structure_proposals FROM pmis_app'; END IF;
END $$;

-- 2. The diff of a set of sheet rows against the live definition. Keys of a row: code, label_en, label_ar, type, required, list_catalogue, section, sort_order,
-- in_list, in_filter, in_template, in_export, is_active (a missing key means unchanged). Returns the items.
CREATE OR REPLACE FUNCTION structure_diff(p_register text, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r jsonb; f public.register_fields%ROWTYPE; cur jsonb; ccode text; items jsonb := '[]'::jsonb; changes text[]; patch jsonb; blocked text; impact jsonb; k text;
  new_t text; conv jsonb; seen text[] := ARRAY[]::text[]; is_new boolean; k2 text;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows', 'required', 'The Structure sheet has no rows.')));
  END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    ccode := btrim(coalesce(r ->> 'code', ''));
    IF ccode = '' THEN CONTINUE; END IF;
    IF ccode = ANY (seen) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows', 'duplicate', format('The code %s appears twice in the sheet.', left(ccode, 60)))));
    END IF;
    seen := seen || ccode;
    SELECT * INTO f FROM public.register_fields x WHERE x.register_key = p_register AND x.code = ccode;
    is_new := NOT FOUND;
    changes := ARRAY[]::text[]; patch := '{}'::jsonb; blocked := NULL; impact := NULL; conv := NULL;
    IF is_new THEN
      changes := ARRAY['add'];
      FOREACH k IN ARRAY ARRAY['label_en', 'label_ar', 'required', 'list_catalogue', 'section', 'sort_order', 'in_list', 'in_filter', 'in_template', 'in_export', 'is_active'] LOOP
        IF r ? k THEN patch := patch || jsonb_build_object(k, r -> k); END IF;
      END LOOP;
      IF r ? 'type' THEN patch := patch || jsonb_build_object('field_type', r -> 'type'); END IF;
      IF ccode !~ '^[a-z][a-z0-9_]{0,40}$' THEN blocked := 'invalid_code';
      ELSIF coalesce(btrim(r ->> 'label_en'), '') = '' OR coalesce(r ->> 'type', '') = '' THEN blocked := 'new_column_incomplete';
      END IF;
    ELSE
      cur := public.rcol_json(f);
      IF r ? 'label_en' AND r ->> 'label_en' IS DISTINCT FROM f.label_en OR r ? 'label_ar' AND r ->> 'label_ar' IS DISTINCT FROM f.label_ar THEN
        changes := array_append(changes, 'rename'::text);
        IF r ? 'label_en' THEN patch := patch || jsonb_build_object('label_en', r -> 'label_en'); END IF;
        IF r ? 'label_ar' THEN patch := patch || jsonb_build_object('label_ar', r -> 'label_ar'); END IF;
      END IF;
      IF r ? 'sort_order' AND (r ->> 'sort_order')::numeric IS DISTINCT FROM f.sort_order::numeric THEN
        changes := array_append(changes, 'reorder'::text); patch := patch || jsonb_build_object('sort_order', r -> 'sort_order');
      END IF;
      IF r ? 'section' AND r ->> 'section' IS DISTINCT FROM f.section THEN changes := array_append(changes, 'section'::text); patch := patch || jsonb_build_object('section', r -> 'section'); END IF;
      FOREACH k IN ARRAY ARRAY['in_list', 'in_filter', 'in_template', 'in_export'] LOOP
        IF r ? k AND (r ->> k)::boolean IS DISTINCT FROM (cur ->> k)::boolean THEN
          IF NOT 'visibility' = ANY (changes) THEN changes := array_append(changes, 'visibility'::text); END IF;
          patch := patch || jsonb_build_object(k, r -> k);
        END IF;
      END LOOP;
      IF r ? 'is_active' AND (r ->> 'is_active')::boolean IS DISTINCT FROM f.is_active THEN
        changes := array_append(changes, CASE WHEN (r ->> 'is_active')::boolean THEN 'show' ELSE 'hide' END);
        patch := patch || jsonb_build_object('is_active', r -> 'is_active');
      END IF;
      IF r ? 'required' AND (r ->> 'required')::boolean IS DISTINCT FROM f.required THEN changes := array_append(changes, 'required'::text); patch := patch || jsonb_build_object('required', r -> 'required'); END IF;
      new_t := coalesce(r ->> 'type', cur ->> 'type');
      IF new_t IS DISTINCT FROM cur ->> 'type' OR (r ? 'list_catalogue' AND r ->> 'list_catalogue' IS DISTINCT FROM f.list_catalogue) THEN
        changes := array_append(changes, 'type'::text);
        IF r ? 'type' THEN patch := patch || jsonb_build_object('field_type', r -> 'type'); END IF;
        IF r ? 'list_catalogue' THEN patch := patch || jsonb_build_object('list_catalogue', r -> 'list_catalogue'); END IF;
      END IF;
      IF cardinality(changes) > 0 THEN
        impact := public.admin_reg_field_impact(p_register, ccode, patch);
        conv := impact -> 'conversion';
        IF f.is_system AND EXISTS (SELECT 1 FROM unnest(changes) c WHERE c IN ('type', 'hide', 'required')) THEN blocked := 'system_column';
        ELSIF conv IS NOT NULL AND conv <> 'null'::jsonb AND coalesce((conv ->> 'failed')::int, 0) > 0 THEN blocked := 'conversion_blocked';
        ELSIF patch ? 'section' AND patch ->> 'section' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.register_sections s WHERE s.register_key = p_register AND s.name_en = patch ->> 'section') THEN blocked := 'unknown_section';
        ELSIF patch ? 'list_catalogue' AND patch ->> 'list_catalogue' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.list_catalogues c WHERE c.code = patch ->> 'list_catalogue' AND c.is_active) THEN blocked := 'unknown_list';
        END IF;
      END IF;
    END IF;
    IF cardinality(changes) > 0 THEN
      items := items || jsonb_build_object('code', ccode, 'create', is_new, 'changes', to_jsonb(changes), 'patch', patch, 'blocked', blocked, 'impact', impact,
        'from', CASE WHEN is_new THEN NULL ELSE cur END);
    END IF;
  END LOOP;
  RETURN items;
END $$;

-- 3. The proposal JSON.
CREATE OR REPLACE FUNCTION structure_proposal_json(p structure_proposals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', p.id, 'register_key', p.register_key, 'status', p.status, 'source', p.source, 'template_version', p.template_version,
    'submitted_by', (SELECT jsonb_build_object('id', u.id, 'display_name', u.display_name) FROM public.users u WHERE u.id = p.submitted_by), 'submitted_at', p.submitted_at, 'reason', p.reason,
    'items', p.items, 'summary', (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT c AS k, count(*) AS n FROM jsonb_array_elements(p.items) i, jsonb_array_elements_text(i -> 'changes') c GROUP BY c) s),
    'blocked_count', (SELECT count(*) FROM jsonb_array_elements(p.items) i WHERE i ->> 'blocked' IS NOT NULL),
    'needs_two_people', EXISTS (SELECT 1 FROM jsonb_array_elements(p.items) i, jsonb_array_elements_text(i -> 'changes') c WHERE c IN ('type', 'hide')),
    'reverts_id', p.reverts_id, 'decided_by', (SELECT jsonb_build_object('id', u.id, 'display_name', u.display_name) FROM public.users u WHERE u.id = p.decided_by),
    'decided_at', p.decided_at, 'decide_note', p.decide_note, 'applied_at', p.applied_at, 'version', p.version)
$$;

-- 4. Make a proposal (nothing is written to the register).
CREATE OR REPLACE FUNCTION admin_structure_proposal_create(p_register text, p_rows jsonb, p_reason text, p_source text DEFAULT 'excel', p_template_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who uuid := public.app_actor(); items jsonb; p public.structure_proposals; codes text[];
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM public.rcol_need_register(p_register);
  IF coalesce(p_source, 'excel') NOT IN ('excel', 'system') THEN PERFORM public.rcol_err('/source', 'invalid', 'excel or system.'); END IF;
  items := public.structure_diff(p_register, p_rows);
  IF jsonb_array_length(items) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows', 'no_change', 'The sheet describes the structure the register has already: nothing to propose.')));
  END IF;
  SELECT array_agg(i ->> 'code') INTO codes FROM jsonb_array_elements(items) i WHERE NOT (i ->> 'create')::boolean;
  INSERT INTO public.structure_proposals (register_key, source, template_version, submitted_by, reason, rows, items, before_rows)
  VALUES (p_register, coalesce(p_source, 'excel'), p_template_version, who, btrim(p_reason), p_rows, items,
          coalesce((SELECT jsonb_agg(public.rcol_json(f) ORDER BY f.sort_order) FROM public.register_fields f WHERE f.register_key = p_register AND f.code = ANY (coalesce(codes, ARRAY[]::text[]))), '[]'::jsonb))
  RETURNING * INTO p;
  PERFORM public.log_audit_write('structure_proposal_submit', 'register', p_register, NULL, jsonb_build_object('proposal', p.id, 'items', jsonb_array_length(items), 'source', p.source), p_reason);
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT u.id, 'in_app', 'structure_proposal', 'A structure proposal waits for review', format('A change of the structure of %s was proposed (%s items).', p_register, jsonb_array_length(items)), '/admin/settings/data/structure'
  FROM public.users u WHERE u.id <> who AND u.status = 'active' AND public.app_user_is_system_admin(u.id);
  RETURN public.structure_proposal_json(p);
END $$;

-- 5. Read.
CREATE OR REPLACE FUNCTION admin_structure_proposals_json(p_register text DEFAULT NULL, p_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(public.structure_proposal_json(p) ORDER BY p.submitted_at DESC) FROM (
    SELECT * FROM public.structure_proposals x WHERE (p_register IS NULL OR x.register_key = p_register) AND (p_status IS NULL OR x.status = p_status) ORDER BY x.submitted_at DESC LIMIT 200) p), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION admin_structure_proposal_get(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.structure_proposals;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  SELECT * INTO p FROM public.structure_proposals WHERE id = p_id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This proposal does not exist.')); END IF;
  RETURN public.structure_proposal_json(p);
END $$;

-- 6. Decide. Approve: System Admin (the API asks for a step-up), no blocked item, two people when a type changes or a column is hidden; the items are applied through the 0094 doors.
CREATE OR REPLACE FUNCTION admin_structure_proposal_decide(p_id uuid, p_action text, p_note text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who uuid := public.app_actor(); p public.structure_proposals; i jsonb; pj jsonb; ord text[];
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  IF p_action NOT IN ('approve', 'reject') THEN PERFORM public.rcol_err('/action', 'invalid', 'approve or reject.'); END IF;
  SELECT * INTO p FROM public.structure_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This proposal does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> p.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p.status <> 'pending' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', format('The proposal is %s, not waiting for review.', p.status))); END IF;
  IF p_action = 'reject' THEN
    IF char_length(btrim(coalesce(p_note, ''))) < 3 THEN PERFORM public.rcol_err('/note', 'required', 'A rejection needs a note (at least 3 characters).'); END IF;
    UPDATE public.structure_proposals SET status = 'rejected', decided_by = who, decided_at = clock_timestamp(), decide_note = btrim(p_note), version = version + 1 WHERE id = p.id RETURNING * INTO p;
    PERFORM public.log_audit_write('structure_proposal_reject', 'register', p.register_key, NULL, jsonb_build_object('proposal', p.id), p.decide_note);
    RETURN public.structure_proposal_json(p);
  END IF;
  IF NOT public.app_actor_is_system_admin() THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin approves a structure proposal.')); END IF;
  pj := public.structure_proposal_json(p);
  IF (pj ->> 'blocked_count')::int > 0 THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The proposal has a blocked item: it cannot be approved until the value is fixed or the item is left out. Make a new proposal.'));
  END IF;
  IF (pj ->> 'needs_two_people')::boolean AND p.submitted_by = who THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'A different System Admin must approve a proposal that changes a type or hides a column.'));
  END IF;
  -- adds first (a section or list they name exists already), then the changes of the existing columns; one failure rolls back the whole approval
  FOR i IN SELECT x FROM jsonb_array_elements(p.items) x ORDER BY (NOT (x ->> 'create')::boolean), x ->> 'code' LOOP
    PERFORM public.admin_reg_field_save(p.register_key, i ->> 'code', (i ->> 'create')::boolean, i -> 'patch', 'Structure proposal ' || p.id::text || ': ' || p.reason, NULL, true);
  END LOOP;
  UPDATE public.structure_proposals SET status = 'applied', decided_by = who, decided_at = clock_timestamp(), applied_at = clock_timestamp(), decide_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1
  WHERE id = p.id RETURNING * INTO p;
  PERFORM public.log_audit_write('structure_proposal_apply', 'register', p.register_key, p.before_rows, jsonb_build_object('proposal', p.id, 'items', jsonb_array_length(p.items)), coalesce(p.decide_note, p.reason));
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT p.submitted_by, 'in_app', 'structure_proposal', 'Your structure proposal was applied', format('The change of the structure of %s was approved and applied. A new template version is issued.', p.register_key), '/admin/settings/data/structure';
  RETURN public.structure_proposal_json(p);
END $$;

-- 7. Undo: a proposal of its own that restores the "before" values of an applied one (columns it added are hidden, never deleted). It goes through the same approval.
CREATE OR REPLACE FUNCTION admin_structure_proposal_revert(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who uuid := public.app_actor(); p public.structure_proposals; rows jsonb; items jsonb; np public.structure_proposals;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO p FROM public.structure_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This proposal does not exist.')); END IF;
  IF p.status <> 'applied' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only an applied proposal can be undone.')); END IF;
  rows := coalesce((SELECT jsonb_agg(jsonb_build_object('code', b ->> 'code', 'label_en', b -> 'label_en', 'label_ar', b -> 'label_ar', 'type', b -> 'type', 'required', b -> 'required',
      'list_catalogue', b -> 'list_catalogue', 'section', b -> 'section', 'sort_order', b -> 'sort_order', 'in_list', b -> 'in_list', 'in_filter', b -> 'in_filter',
      'in_template', b -> 'in_template', 'in_export', b -> 'in_export', 'is_active', b -> 'is_active')) FROM jsonb_array_elements(p.before_rows) b), '[]'::jsonb)
    || coalesce((SELECT jsonb_agg(jsonb_build_object('code', i ->> 'code', 'is_active', false)) FROM jsonb_array_elements(p.items) i WHERE (i ->> 'create')::boolean), '[]'::jsonb);
  items := public.structure_diff(p.register_key, rows);
  IF jsonb_array_length(items) = 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows', 'no_change', 'Nothing to undo: the structure is as it was.'))); END IF;
  INSERT INTO public.structure_proposals (register_key, source, submitted_by, reason, rows, items, before_rows, reverts_id)
  VALUES (p.register_key, 'system', who, btrim(p_reason), rows, items,
          coalesce((SELECT jsonb_agg(public.rcol_json(f) ORDER BY f.sort_order) FROM public.register_fields f WHERE f.register_key = p.register_key AND f.code IN (SELECT i ->> 'code' FROM jsonb_array_elements(items) i)), '[]'::jsonb), p.id)
  RETURNING * INTO np;
  PERFORM public.log_audit_write('structure_proposal_revert_submit', 'register', p.register_key, NULL, jsonb_build_object('proposal', np.id, 'reverts', p.id), p_reason);
  RETURN public.structure_proposal_json(np);
END $$;
-- The undo marks the proposal it reverts when it is applied.
CREATE OR REPLACE FUNCTION structure_proposal_mark_reverted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'applied' AND OLD.status <> 'applied' AND NEW.reverts_id IS NOT NULL THEN
    UPDATE public.structure_proposals SET status = 'reverted', version = version + 1 WHERE id = NEW.reverts_id AND status = 'applied';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS structure_proposals_mark_reverted ON structure_proposals;
CREATE TRIGGER structure_proposals_mark_reverted AFTER UPDATE ON structure_proposals FOR EACH ROW EXECUTE FUNCTION structure_proposal_mark_reverted();

-- 8. Rights: the doors keep the default execute right (as in 0094); the helpers are for the doors only.
DO $$ DECLARE fn text; BEGIN
  FOREACH fn IN ARRAY ARRAY['admin_structure_proposal_create(text, jsonb, text, text, integer)', 'admin_structure_proposals_json(text, text)', 'admin_structure_proposal_get(uuid)',
      'admin_structure_proposal_decide(uuid, text, text, integer)', 'admin_structure_proposal_revert(uuid, text)', 'structure_diff(text, jsonb)', 'structure_proposal_mark_reverted()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', fn);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION structure_diff(text, jsonb) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION structure_proposal_mark_reverted() FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION structure_diff(text, jsonb) TO pmis_definer';
END $$;
