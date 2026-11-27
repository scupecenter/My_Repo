-- 0405 (contract 0.15.267): the write door of the custom field definitions, admin_save_field (POST and PATCH /custom-fields, assignment from the project lead via Main).
-- Additive: one function, no table, no permission, role or grant change. The tables (field_definitions, field_list_values, field_permissions, migration 0007) and their guards
-- (field_definitions_guard, field_list_values_guard, field_set_bump, the template trigger) already exist; this is the audited door that was documented (x-db-path admin_save_field) but never written.
-- Who: System Admin, or a delegate of the custom fields (`fields` edit) for all regions (site_master_col_can_admin, the rule of the Master column doors). The API also asks for step-up.
-- Create (p_id NULL): entity_type, code, label_en, data_type are required. Update: only the keys sent change; entity_type, task_code, code and data_type never change on update
--   (the contract has them in the create body only), and a field that holds values keeps its list options (they are switched off, never removed). Nothing is deleted: is_active=false hides the field.
-- Access: visible_to_role_ids and editable_by_role_ids become field rules per active role (hidden, read, edit; both empty = no rules, the entity permission decides, ADR 0003; editable empty with
--   visible set = visible roles may edit). The rules are written ONLY through the existing identity door idm_field_permission_set, so its checks apply (a rule that applies to the actor is refused).
-- p_version is the If-Match version (NULL on create). Audited as custom_field_create / custom_field_update with before and after and the reason.

CREATE OR REPLACE FUNCTION admin_save_field(p_id uuid, p_input jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  errs jsonb := '[]'::jsonb; k text; cur public.field_definitions%ROWTYPE; fid uuid; creating boolean := (p_id IS NULL);
  allowed text[] := ARRAY['label_en','label_ar','required','validation','default_value','section','sort_order','list_values','visible_to_role_ids','editable_by_role_ids',
                          'in_templates','in_exports','in_list_filters','master_export_column','is_active'];
  create_only text[] := ARRAY['entity_type','task_code','code','data_type'];
  v_entity text; v_code text; v_type text; v_task text; before jsonb; after jsonb; lv jsonb; o jsonb; i int; seen text[] := '{}'; vis uuid[]; edt uuid[]; rl record; rid uuid;
  holds boolean := false; vk text; want_acc text; cur_acc text; has_vis boolean; has_edt boolean;
BEGIN
  IF NOT coalesce(public.site_master_col_can_admin(), false) THEN
    RAISE EXCEPTION 'custom fields: System Admin or a delegate of the custom fields for all regions only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_input) LOOP
    IF k = ANY(allowed) OR (creating AND k = ANY(create_only)) THEN CONTINUE; END IF;
    errs := errs || public.reg_err_item('/' || k, CASE WHEN k = ANY(create_only) THEN 'immutable' ELSE 'unknown_key' END,
                                        CASE WHEN k = ANY(create_only) THEN 'Cannot be changed after the field is created.' ELSE 'Unknown key.' END);
  END LOOP;

  IF NOT creating THEN
    SELECT * INTO cur FROM public.field_definitions WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'custom field not found' USING ERRCODE = 'no_data_found'; END IF;
    IF p_version IS NOT NULL AND p_version <> cur.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    v_entity := cur.entity_type::text; v_code := cur.code; v_type := cur.data_type::text; v_task := cur.task_code;
    holds := public.field_has_values(cur.entity_type, cur.code);
  ELSE
    v_entity := p_input ->> 'entity_type'; v_code := p_input ->> 'code'; v_type := p_input ->> 'data_type'; v_task := p_input ->> 'task_code';
    IF v_entity IS NULL OR NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FieldEntityType' AND e.enumlabel = v_entity) THEN
      errs := errs || public.reg_err_item('/entity_type', 'invalid', 'A custom field entity.');
    END IF;
    IF v_code IS NULL OR v_code !~ '^[a-z][a-z0-9_]{1,40}$' THEN errs := errs || public.reg_err_item('/code', 'invalid', 'Lower case letters, digits and underscores, starting with a letter (2 to 41 characters).'); END IF;
    IF v_type IS NULL OR NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FieldDataType' AND e.enumlabel = v_type) THEN
      errs := errs || public.reg_err_item('/data_type', 'invalid', 'A data type.');
    END IF;
    IF v_task IS NOT NULL AND (v_entity IS DISTINCT FROM 'task_instance' OR NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.code = v_task)) THEN
      errs := errs || public.reg_err_item('/task_code', 'invalid', 'Only for a task field, and an existing task code.');
    END IF;
    IF jsonb_array_length(errs) = 0 AND EXISTS (SELECT 1 FROM public.field_definitions f WHERE f.entity_type::text = v_entity AND f.code = v_code) THEN
      errs := errs || public.reg_err_item('/code', 'duplicate', 'A field with this code exists for this entity (deactivate it instead).');
    END IF;
    IF NOT (p_input ? 'label_en') THEN errs := errs || public.reg_err_item('/label_en', 'required', 'Required.'); END IF;
  END IF;

  IF p_input ? 'label_en' AND (jsonb_typeof(p_input -> 'label_en') <> 'string' OR btrim(p_input ->> 'label_en') = '' OR length(p_input ->> 'label_en') > 200) THEN errs := errs || public.reg_err_item('/label_en', 'invalid', 'Text of 1 to 200 characters.'); END IF;
  IF p_input ? 'label_ar' AND jsonb_typeof(p_input -> 'label_ar') NOT IN ('string', 'null') THEN errs := errs || public.reg_err_item('/label_ar', 'invalid', 'Text or null.'); END IF;
  IF p_input ? 'section' AND jsonb_typeof(p_input -> 'section') NOT IN ('string', 'null') THEN errs := errs || public.reg_err_item('/section', 'invalid', 'Text or null.'); END IF;
  FOREACH vk IN ARRAY ARRAY['required','in_templates','in_exports','in_list_filters','is_active'] LOOP
    IF p_input ? vk AND jsonb_typeof(p_input -> vk) <> 'boolean' THEN errs := errs || public.reg_err_item('/' || vk, 'invalid', 'true or false.'); END IF;
  END LOOP;
  IF p_input ? 'sort_order' AND (jsonb_typeof(p_input -> 'sort_order') <> 'number' OR (p_input ->> 'sort_order') !~ '^-?[0-9]{1,6}$') THEN errs := errs || public.reg_err_item('/sort_order', 'invalid', 'A whole number.'); END IF;
  IF p_input ? 'master_export_column' AND jsonb_typeof(p_input -> 'master_export_column') NOT IN ('string', 'null') THEN errs := errs || public.reg_err_item('/master_export_column', 'invalid', 'Text or null.'); END IF;
  IF p_input ? 'validation' AND p_input -> 'validation' <> 'null'::jsonb THEN
    IF jsonb_typeof(p_input -> 'validation') <> 'object' THEN errs := errs || public.reg_err_item('/validation', 'invalid', 'An object.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(p_input -> 'validation') LOOP
        IF k NOT IN ('min','max','min_length','max_length','pattern') THEN errs := errs || public.reg_err_item('/validation/' || k, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF p_input -> 'validation' ? 'pattern' THEN
        IF jsonb_typeof(p_input -> 'validation' -> 'pattern') <> 'string' OR length(p_input -> 'validation' ->> 'pattern') > 200 THEN errs := errs || public.reg_err_item('/validation/pattern', 'invalid', 'A pattern of at most 200 characters.');
        ELSE BEGIN PERFORM '' ~ (p_input -> 'validation' ->> 'pattern'); EXCEPTION WHEN OTHERS THEN errs := errs || public.reg_err_item('/validation/pattern', 'invalid', 'Not a valid regular expression.'); END;
        END IF;
      END IF;
    END IF;
  END IF;
  lv := p_input -> 'list_values';
  IF p_input ? 'list_values' THEN
    IF jsonb_typeof(lv) <> 'array' OR jsonb_array_length(lv) > 200 THEN errs := errs || public.reg_err_item('/list_values', 'invalid', 'A list of at most 200 options.');
    ELSE
      i := 0;
      FOR o IN SELECT * FROM jsonb_array_elements(lv) LOOP
        IF jsonb_typeof(o) <> 'object' OR coalesce(o ->> 'value', '') = '' OR coalesce(o ->> 'label_en', '') = '' OR length(o ->> 'value') > 80 THEN
          errs := errs || public.reg_err_item('/list_values/' || i, 'invalid', 'An option has a value (up to 80 characters) and a label_en.');
        ELSIF (o ->> 'value') = ANY(seen) THEN errs := errs || public.reg_err_item('/list_values/' || i, 'duplicate', 'The same value twice.');
        ELSE seen := seen || (o ->> 'value'); END IF;
        i := i + 1;
      END LOOP;
    END IF;
  END IF;
  IF v_type IN ('list', 'multi_list') AND creating AND (NOT (p_input ? 'list_values') OR jsonb_typeof(lv) IS DISTINCT FROM 'array' OR jsonb_array_length(lv) = 0) THEN
    errs := errs || public.reg_err_item('/list_values', 'required', 'A list field needs at least one option.');
  END IF;
  IF v_type NOT IN ('list', 'multi_list') AND p_input ? 'list_values' AND jsonb_typeof(lv) = 'array' AND jsonb_array_length(lv) > 0 THEN
    errs := errs || public.reg_err_item('/list_values', 'invalid', 'Only a list field has options.');
  END IF;
  has_vis := p_input ? 'visible_to_role_ids'; has_edt := p_input ? 'editable_by_role_ids';
  FOREACH vk IN ARRAY ARRAY['visible_to_role_ids','editable_by_role_ids'] LOOP
    IF p_input ? vk THEN
      IF jsonb_typeof(p_input -> vk) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_input -> vk) e WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        errs := errs || public.reg_err_item('/' || vk, 'invalid', 'A list of role ids.');
      ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_input -> vk) AS t(v) WHERE NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = t.v::uuid AND r.is_active)) THEN
        errs := errs || public.reg_err_item('/' || vk, 'unknown_role', 'An active role.');
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF creating THEN
    INSERT INTO public.field_definitions (entity_type, task_code, code, label_en, label_ar, data_type, required, validation, default_value, section, sort_order,
                                          in_templates, in_exports, in_list_filters, master_export_column, is_active, reason, changed_by)
    VALUES (v_entity::public."FieldEntityType", v_task, v_code, btrim(p_input ->> 'label_en'), p_input ->> 'label_ar', v_type::public."FieldDataType",
            coalesce((p_input ->> 'required')::boolean, false), NULLIF(p_input -> 'validation', 'null'::jsonb), NULLIF(p_input -> 'default_value', 'null'::jsonb), p_input ->> 'section',
            coalesce((p_input ->> 'sort_order')::int, 0), coalesce((p_input ->> 'in_templates')::boolean, false), coalesce((p_input ->> 'in_exports')::boolean, false),
            coalesce((p_input ->> 'in_list_filters')::boolean, false), p_input ->> 'master_export_column', coalesce((p_input ->> 'is_active')::boolean, true), btrim(p_reason), public.app_actor())
    RETURNING id INTO fid;
    before := NULL;
  ELSE
    fid := cur.id;
    before := public.custom_field_json(fid);
    UPDATE public.field_definitions f SET
      label_en = CASE WHEN p_input ? 'label_en' THEN btrim(p_input ->> 'label_en') ELSE f.label_en END,
      label_ar = CASE WHEN p_input ? 'label_ar' THEN p_input ->> 'label_ar' ELSE f.label_ar END,
      required = CASE WHEN p_input ? 'required' THEN (p_input ->> 'required')::boolean ELSE f.required END,
      validation = CASE WHEN p_input ? 'validation' THEN NULLIF(p_input -> 'validation', 'null'::jsonb) ELSE f.validation END,
      default_value = CASE WHEN p_input ? 'default_value' THEN NULLIF(p_input -> 'default_value', 'null'::jsonb) ELSE f.default_value END,
      section = CASE WHEN p_input ? 'section' THEN p_input ->> 'section' ELSE f.section END,
      sort_order = CASE WHEN p_input ? 'sort_order' THEN (p_input ->> 'sort_order')::int ELSE f.sort_order END,
      in_templates = CASE WHEN p_input ? 'in_templates' THEN (p_input ->> 'in_templates')::boolean ELSE f.in_templates END,
      in_exports = CASE WHEN p_input ? 'in_exports' THEN (p_input ->> 'in_exports')::boolean ELSE f.in_exports END,
      in_list_filters = CASE WHEN p_input ? 'in_list_filters' THEN (p_input ->> 'in_list_filters')::boolean ELSE f.in_list_filters END,
      master_export_column = CASE WHEN p_input ? 'master_export_column' THEN p_input ->> 'master_export_column' ELSE f.master_export_column END,
      is_active = CASE WHEN p_input ? 'is_active' THEN (p_input ->> 'is_active')::boolean ELSE f.is_active END,
      reason = btrim(p_reason), changed_by = public.app_actor()   -- config_touch bumps version and changed_at
    WHERE f.id = fid;
  END IF;

  IF p_input ? 'list_values' THEN
    -- options are upserted by value; an option that is no longer sent is switched off, never removed
    FOR o IN SELECT * FROM jsonb_array_elements(lv) LOOP
      INSERT INTO public.field_list_values (field_id, code, label_en, label_ar, sort_order, is_active)
      VALUES (fid, o ->> 'value', o ->> 'label_en', o ->> 'label_ar', 0, coalesce((o ->> 'is_active')::boolean, true))
      ON CONFLICT (field_id, code) DO UPDATE SET label_en = EXCLUDED.label_en, label_ar = EXCLUDED.label_ar, is_active = EXCLUDED.is_active;
    END LOOP;
    i := 0;
    FOR o IN SELECT * FROM jsonb_array_elements(lv) LOOP
      UPDATE public.field_list_values SET sort_order = i WHERE field_id = fid AND code = o ->> 'value';
      i := i + 1;
    END LOOP;
    UPDATE public.field_list_values SET is_active = false WHERE field_id = fid AND is_active AND NOT (code = ANY(seen));
  END IF;

  IF has_vis OR has_edt THEN
    SELECT coalesce(array_agg(t.v::uuid), '{}') INTO vis FROM jsonb_array_elements_text(CASE WHEN has_vis THEN p_input -> 'visible_to_role_ids' ELSE
      (SELECT coalesce(jsonb_agg(p.role_id), '[]'::jsonb) FROM public.field_permissions p WHERE p.field_id = fid AND p.role_id IS NOT NULL AND p.access::text IN ('read', 'edit')) END) AS t(v);
    SELECT coalesce(array_agg(t.v::uuid), '{}') INTO edt FROM jsonb_array_elements_text(CASE WHEN has_edt THEN p_input -> 'editable_by_role_ids' ELSE
      (SELECT coalesce(jsonb_agg(p.role_id), '[]'::jsonb) FROM public.field_permissions p WHERE p.field_id = fid AND p.role_id IS NOT NULL AND p.access::text = 'edit') END) AS t(v);
    -- field rules are identity data: they are written only through the existing door idm_field_permission_set (reason, the actor needs `fields` edit, nobody changes a rule
    -- that applies to them, nobody gives more access than they have). Only the roles whose rule changes are touched; A listed role gets an explicit "edit" rule, so the lists read back as they were sent.
    FOR rl IN SELECT id FROM public.roles WHERE is_active ORDER BY id LOOP
      want_acc := CASE
        WHEN cardinality(vis) = 0 AND cardinality(edt) = 0 THEN NULL
        WHEN cardinality(vis) > 0 AND NOT (rl.id = ANY(vis)) AND NOT (rl.id = ANY(edt)) THEN 'hidden'
        WHEN cardinality(edt) > 0 AND NOT (rl.id = ANY(edt)) THEN 'read'
        ELSE 'edit' END;
      SELECT p.access::text INTO cur_acc FROM public.field_permissions p WHERE p.field_id = fid AND p.role_id = rl.id;
      IF cur_acc IS DISTINCT FROM want_acc THEN
        PERFORM public.idm_field_permission_set(fid, rl.id, NULL::uuid, want_acc::public."FieldAccess", btrim(p_reason));
      END IF;
    END LOOP;
  END IF;

  after := public.custom_field_json(fid);
  PERFORM public.log_audit_write(CASE WHEN creating THEN 'custom_field_create' ELSE 'custom_field_update' END, 'custom_field', fid::text, before, after, btrim(p_reason));
  RETURN after;
END $$;

-- one field as the contract shows it (the database names; the API maps entity and type names)
CREATE OR REPLACE FUNCTION custom_field_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'id', fd.id, 'entity_type', fd.entity_type, 'task_code', fd.task_code, 'code', fd.code, 'label_en', fd.label_en, 'label_ar', fd.label_ar, 'data_type', fd.data_type,
    'required', fd.required, 'validation', fd.validation, 'default_value', fd.default_value, 'section', fd.section, 'sort_order', fd.sort_order,
    'in_templates', fd.in_templates, 'in_exports', fd.in_exports, 'in_list_filters', fd.in_list_filters, 'master_export_column', fd.master_export_column,
    'is_active', fd.is_active, 'version', fd.version))
  || jsonb_build_object(
    'list_values', coalesce((SELECT jsonb_agg(jsonb_build_object('value', l.code, 'label_en', l.label_en, 'label_ar', l.label_ar, 'is_active', l.is_active) ORDER BY l.sort_order, l.code)
                             FROM public.field_list_values l WHERE l.field_id = fd.id), '[]'::jsonb),
    'visible_to_role_ids', coalesce((SELECT jsonb_agg(p.role_id ORDER BY p.role_id) FROM public.field_permissions p WHERE p.field_id = fd.id AND p.role_id IS NOT NULL AND p.access::text IN ('read', 'edit')), '[]'::jsonb),
    'editable_by_role_ids', coalesce((SELECT jsonb_agg(p.role_id ORDER BY p.role_id) FROM public.field_permissions p WHERE p.field_id = fd.id AND p.role_id IS NOT NULL AND p.access::text = 'edit'), '[]'::jsonb))
  FROM public.field_definitions fd WHERE fd.id = p_id
$$;

GRANT SELECT, INSERT, UPDATE ON field_definitions, field_list_values TO pmis_definer;
GRANT EXECUTE ON FUNCTION idm_field_permission_set(uuid, uuid, uuid, "FieldAccess", text) TO pmis_definer;
GRANT SELECT ON roles, task_definitions, field_permissions TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['admin_save_field(uuid,jsonb,text,integer)', 'custom_field_json(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_save_field(uuid, jsonb, text, integer), custom_field_json(uuid) TO pmis_app;
  END IF;
END $$;
