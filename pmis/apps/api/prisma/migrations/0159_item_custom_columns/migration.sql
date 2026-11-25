-- 0159 (P6): custom columns for the Warehouse items catalogue, on the EXISTING engine (field_definitions + the `custom` JSONB of warehouse_items + the custom_validate trigger).
-- Nothing new is stored. What was missing is a writer:
--   1. item_fields_json(entity)                      the columns (field_definitions rows) of an entity, active and hidden, with the number of items that hold a value.
--   2. admin_item_field_save(entity, code, create, patch, reason, version)
--                                                    add or change a column: labels, type (text, number, date, bool), required, section, order, template/export/filter flags, hide.
--                                                    No delete: a column with values is hidden (is_active = false), the values stay (the existing guard also refuses a delete).
--   3. admin_save_warehouse_item_custom(id, patch, reason, version)
--                                                    the values of one item, merged into `custom` (null clears); the existing trigger validates them; version + audit row like the item save.
-- Same right as the other column admin screens: System Admin or a delegate of `fields` edit for all regions. Reason of 3 characters or more. Audit rows through log_audit_write.
-- Entity types handled today: warehouse_item. (As-built items are fields of the as_built register and use the register column admin; sites keep their own screen.)

GRANT INSERT, UPDATE ON field_definitions TO pmis_definer;

CREATE OR REPLACE FUNCTION item_field_entity(p_entity text) RETURNS "FieldEntityType"
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_entity IS DISTINCT FROM 'warehouse_item' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/entity', 'unknown_entity', 'Only warehouse_item has item columns here.')));
  END IF;
  RETURN p_entity::"FieldEntityType";
END $$;

CREATE OR REPLACE FUNCTION item_field_json(f public.field_definitions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar, 'data_type', f.data_type::text, 'required', f.required, 'section', f.section,
    'sort_order', f.sort_order, 'in_templates', f.in_templates, 'in_exports', f.in_exports, 'in_list_filters', f.in_list_filters, 'is_active', f.is_active,
    'version', f.version, 'has_values', public.field_has_values(f.entity_type, f.code))
$$;

CREATE OR REPLACE FUNCTION item_fields_json(p_entity text, p_include_inactive boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e "FieldEntityType" := public.item_field_entity(p_entity);
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  RETURN coalesce((SELECT jsonb_agg(public.item_field_json(f) ORDER BY f.sort_order, f.code COLLATE "C") FROM public.field_definitions f
                   WHERE f.entity_type = e AND f.task_code IS NULL AND (f.is_active OR coalesce(p_include_inactive, true))), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION admin_item_field_save(p_entity text, p_code text, p_create boolean, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e "FieldEntityType" := public.item_field_entity(p_entity); f public.field_definitions%ROWTYPE; before jsonb; errs jsonb := '[]'::jsonb; k text; t text;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object is expected.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (k = ANY (ARRAY['label_en', 'label_ar', 'data_type', 'required', 'section', 'sort_order', 'in_templates', 'in_exports', 'in_list_filters', 'is_active'])) THEN
      errs := errs || public.reg_err_item('/' || left(k, 60), 'unknown_field', 'This property cannot be set.');
    END IF;
  END LOOP;
  IF p_patch ? 'data_type' AND coalesce(p_patch ->> 'data_type', '') NOT IN ('text', 'number', 'date', 'bool') THEN
    errs := errs || public.reg_err_item('/data_type', 'not_in_list', 'text, number, date or bool.');
  END IF;
  IF p_patch ? 'label_en' AND btrim(coalesce(p_patch ->> 'label_en', '')) = '' THEN errs := errs || public.reg_err_item('/label_en', 'required', 'The English name is required.'); END IF;
  IF p_create THEN
    IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{1,40}$' THEN errs := errs || public.reg_err_item('/code', 'invalid', 'Lower case letters, digits and _, 2 to 41 characters, starting with a letter.'); END IF;
    IF NOT (p_patch ? 'label_en') THEN errs := errs || public.reg_err_item('/label_en', 'required', 'The English name is required.'); END IF;
    IF NOT (p_patch ? 'data_type') THEN errs := errs || public.reg_err_item('/data_type', 'required', 'The type is required.'); END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_create THEN
    IF EXISTS (SELECT 1 FROM public.field_definitions WHERE entity_type = e AND code = p_code) THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A column with this code exists already.'));
    END IF;
    INSERT INTO public.field_definitions (entity_type, code, label_en, label_ar, data_type, required, section, sort_order, in_templates, in_exports, in_list_filters, is_active, reason, changed_by)
    VALUES (e, p_code, btrim(p_patch ->> 'label_en'), nullif(btrim(coalesce(p_patch ->> 'label_ar', '')), ''), (p_patch ->> 'data_type')::"FieldDataType",
            coalesce((p_patch ->> 'required')::boolean, false), nullif(btrim(coalesce(p_patch ->> 'section', '')), ''),
            coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(sort_order), 0) + 10 FROM public.field_definitions WHERE entity_type = e)),
            coalesce((p_patch ->> 'in_templates')::boolean, true), coalesce((p_patch ->> 'in_exports')::boolean, true), coalesce((p_patch ->> 'in_list_filters')::boolean, false),
            coalesce((p_patch ->> 'is_active')::boolean, true), btrim(p_reason), public.app_actor())
    RETURNING * INTO f;
    PERFORM public.log_audit_write('item_column_created', 'field_definition', e::text || '.' || f.code, NULL::jsonb, public.item_field_json(f), btrim(p_reason));
    RETURN public.item_field_json(f);
  END IF;

  SELECT * INTO f FROM public.field_definitions WHERE entity_type = e AND code = p_code AND task_code IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No column has this code.')); END IF;
  IF p_version IS NOT NULL AND p_version <> f.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it.')); END IF;
  IF p_patch ? 'data_type' AND (p_patch ->> 'data_type') <> f.data_type::text AND public.field_has_values(e, f.code) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data_type', 'field_in_use', 'This column holds values: its type cannot change. Hide it and add a new one.')));
  END IF;
  before := public.item_field_json(f);
  UPDATE public.field_definitions SET
    label_en = coalesce(btrim(p_patch ->> 'label_en'), label_en),
    label_ar = CASE WHEN p_patch ? 'label_ar' THEN nullif(btrim(coalesce(p_patch ->> 'label_ar', '')), '') ELSE label_ar END,
    data_type = coalesce((p_patch ->> 'data_type')::"FieldDataType", data_type),
    required = coalesce((p_patch ->> 'required')::boolean, required),
    section = CASE WHEN p_patch ? 'section' THEN nullif(btrim(coalesce(p_patch ->> 'section', '')), '') ELSE section END,
    sort_order = coalesce((p_patch ->> 'sort_order')::int, sort_order),
    in_templates = coalesce((p_patch ->> 'in_templates')::boolean, in_templates),
    in_exports = coalesce((p_patch ->> 'in_exports')::boolean, in_exports),
    in_list_filters = coalesce((p_patch ->> 'in_list_filters')::boolean, in_list_filters),
    is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
    version = version + 1, reason = btrim(p_reason), changed_by = public.app_actor(), changed_at = now()
  WHERE id = f.id RETURNING * INTO f;
  PERFORM public.log_audit_write(CASE WHEN (p_patch ->> 'is_active') = 'false' THEN 'item_column_hidden' WHEN (p_patch ->> 'is_active') = 'true' THEN 'item_column_shown' ELSE 'item_column_updated' END,
    'field_definition', e::text || '.' || f.code, before, public.item_field_json(f), btrim(p_reason));
  RETURN public.item_field_json(f);
END $$;

-- The values of one item. p_patch: {code: value | null}; null clears. The trigger custom_validate checks the type, the list and the required rule of each active column.
CREATE OR REPLACE FUNCTION admin_save_warehouse_item_custom(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.warehouse_items%ROWTYPE; before jsonb; merged jsonb; k text; errs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/custom', 'invalid', 'An object is expected.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.field_definitions WHERE entity_type = 'warehouse_item' AND code = k AND is_active AND task_code IS NULL) THEN
      errs := errs || public.reg_err_item('/custom/' || left(k, 60), 'unknown_field', 'No active column has this code.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  SELECT * INTO i FROM public.warehouse_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> i.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The item changed since you read it.')); END IF;
  before := public.wh_item_json(i);
  merged := coalesce(i.custom, '{}'::jsonb) || p_patch;
  merged := coalesce((SELECT jsonb_object_agg(key, value) FROM jsonb_each(merged) WHERE jsonb_typeof(value) <> 'null'), '{}'::jsonb);
  UPDATE public.warehouse_items SET custom = merged, version = version + 1, updated_at = now() WHERE id = p_id RETURNING * INTO i;
  PERFORM public.log_audit_write('warehouse_item_custom_update', 'warehouse_item', p_id::text, before, public.wh_item_json(i), btrim(p_reason));
  RETURN jsonb_build_object('id', p_id, 'version', i.version);
END $$;

-- wh_item_json: the item answer carries its custom values
CREATE OR REPLACE FUNCTION wh_item_json(i public.warehouse_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', i.item_code, 'name_en', i.name, 'name_ar', i.name_ar, 'uom', i.unit, 'category', i.item_group, 'serial_tracked', i.serialised,
    'manufacturer', i.manufacturer, 'contract_qty', i.contract_qty, 'planned_delivery_date', i.planned_delivery_date, 'progress_item_code', i.progress_item_code,
    'code_source', i.code_source, 'is_active', i.is_active, 'version', i.version, 'custom', coalesce(i.custom, '{}'::jsonb),
    'need_rules', coalesce((SELECT jsonb_agg(jsonb_build_object('need_unit', n.need_unit, 'quantity', n.quantity, 'status', n.status, 'quantity_rule', n.quantity_rule, 'applies_when', n.applies_when) ORDER BY n.sort_order, n.id)
                            FROM public.warehouse_item_need_rules n WHERE n.item_id = i.id), '[]'::jsonb))
$$;

DO $$
DECLARE f text;
BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'item_field_entity(text)', 'item_field_json(public.field_definitions)', 'item_fields_json(text,boolean)',
    'admin_item_field_save(text,text,boolean,jsonb,text,integer)', 'admin_save_warehouse_item_custom(uuid,jsonb,text,integer)'
  ]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION item_fields_json(text,boolean), admin_item_field_save(text,text,boolean,jsonb,text,integer), admin_save_warehouse_item_custom(uuid,jsonb,text,integer) TO pmis_app;
  END IF;
END $$;
