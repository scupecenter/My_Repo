-- 0078_procurement_members_template (owner decision Q519): the engineers of a Procurement assignment are entered by hand or through the approved Procurement template (TPL-PO).
-- The "members" column of the template is text, "1234:supervisor:lead; 5678:executor" (employee ID : role : optional "lead"); the API turns it into the member rows.
-- A child list whose options carry template_text is a typed column (not grey). The change of the field set issues the new template version (tpl_sync_all via the trigger).

CREATE OR REPLACE FUNCTION tpl_columns(p_register text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.register_definitions%ROWTYPE; ent text; out jsonb;
BEGIN
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_register;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  SELECT t.custom_entity INTO ent FROM public.template_definitions t WHERE t.register_key = p_register LIMIT 1;
  WITH cols AS (
    SELECT 10 AS grp, 0 AS ord, 'site_code'::text AS code, 'Site ID'::text AS label, 'text'::text AS type, 'site'::text AS kind, false AS required, false AS derived, NULL::jsonb AS options,
           NULL::boolean AS allow_other, NULL::boolean AS multiple
      WHERE d.site_scoped
    UNION ALL
    SELECT 20, 0, 'record_type', 'Record Type', 'list', 'record_type', false, false, to_jsonb(d.record_types), NULL, NULL WHERE cardinality(d.record_types) > 0
    UNION ALL
    SELECT 30, f.sort_order, f.code, f.label_en,
           CASE WHEN f.field_type = 'list_code' THEN CASE WHEN coalesce((f.options ->> 'multiple')::boolean, false) THEN 'multi_list' ELSE 'list' END ELSE f.field_type END,
           'field', f.required, f.derived OR f.field_type = 'file' OR (f.field_type = 'child_list' AND NOT coalesce((f.options ->> 'template_text')::boolean, false)),
           CASE WHEN f.list_catalogue IS NOT NULL THEN public.list_active_codes(f.list_catalogue)
                WHEN jsonb_typeof(f.options) = 'array' THEN f.options
                WHEN jsonb_typeof(f.options) = 'object' AND f.options ->> 'source' = 'permit_types'
                  THEN (SELECT coalesce(jsonb_agg(pt.code ORDER BY pt.sort_order, pt.code), '[]'::jsonb) FROM public.permit_types pt WHERE pt.is_active)
                WHEN f.field_type = 'yes_no' THEN '["Yes", "No"]'::jsonb END,
           CASE WHEN f.list_catalogue IS NOT NULL AND (SELECT c.allow_other FROM public.list_catalogues c WHERE c.code = f.list_catalogue) THEN true END,
           CASE WHEN f.field_type IN ('multi_user', 'multi_site') OR (f.field_type = 'list_code' AND coalesce((f.options ->> 'multiple')::boolean, false)) THEN true END
      FROM public.register_fields f WHERE f.register_key = p_register AND f.is_active
    UNION ALL
    SELECT 40, c.sort_order, c.code, c.label_en,
           CASE c.data_type::text WHEN 'multi_list' THEN 'text' WHEN 'file' THEN 'text' WHEN 'external_party' THEN 'text' ELSE c.data_type::text END,
           'custom', c.required, false,
           CASE WHEN c.data_type::text = 'list' AND c.validation ->> 'list_catalogue' IS NOT NULL THEN public.list_active_codes(c.validation ->> 'list_catalogue')
                WHEN c.data_type::text = 'list' THEN (SELECT coalesce(jsonb_agg(l.code ORDER BY l.sort_order, l.code), '[]'::jsonb) FROM public.field_list_values l WHERE l.field_id = c.id AND l.is_active)
                WHEN c.data_type::text = 'yes_no' THEN '["Yes", "No"]'::jsonb END,
           NULL, NULL
      FROM public.field_definitions c
      WHERE ent IS NOT NULL AND c.entity_type::text = ent AND c.is_active AND c.in_templates AND c.task_code IS NULL
        AND c.data_type::text NOT IN ('file', 'multi_list', 'user', 'external_party')
    UNION ALL
    SELECT 90, 0, 'record_id', 'Record ID', 'text', 'record_id', false, false, NULL::jsonb, NULL, NULL
  ), numbered AS (
    SELECT c.*, count(*) OVER (PARTITION BY lower(c.label)) AS same
    FROM cols c
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'code', n.code, 'header', CASE WHEN n.same > 1 THEN n.label || ' [' || n.code || ']' ELSE n.label END, 'type', n.type, 'kind', n.kind,
      'required', n.required, 'derived', n.derived, 'options', n.options, 'allow_other', n.allow_other, 'multiple', n.multiple)) ORDER BY n.grp, n.ord, n.code COLLATE "C"), '[]'::jsonb)
  INTO out FROM numbered n;
  RETURN out;
END $$;

UPDATE register_fields SET options = options || '{"template_text": true}'::jsonb
WHERE register_key = 'procurement' AND code = 'members' AND NOT coalesce((options ->> 'template_text')::boolean, false);
SELECT tpl_sync_all();
