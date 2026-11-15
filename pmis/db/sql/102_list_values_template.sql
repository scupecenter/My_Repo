-- Migration 0103 (F17 follow-up): the approved template of a list's values (kind list_values, TPL-LISTVALUES) and a wider usage check.
--   1. The template kind list_values and its one version. The Excel import of a list's values accepts this template only (its _tpl sheet names
--      TPL-LISTVALUES and the current version); any other file is rejected and the rejection is written to the System Log.
--   2. list_value_in_use also looks at the custom values of sites and tasks (sites.custom, task_instances.custom). The check is a text match on
--      the jsonb, so it is conservative: a match only refuses the hard delete; the value is then deactivated instead.

ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_kind_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_kind_check
  CHECK (kind IN ('register', 'stream', 'master', 'sites', 'list_values'));
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_scope_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_scope_check CHECK (
  (kind = 'register' AND register_key IS NOT NULL AND stream_code IS NULL)
  OR (kind = 'stream' AND stream_code IS NOT NULL AND register_key IS NULL)
  OR (kind IN ('master', 'sites', 'list_values') AND register_key IS NULL AND stream_code IS NULL));

-- The columns of the list values template: one row per value (the code is the key; the rest is what an admin may set).
CREATE OR REPLACE FUNCTION tpl_list_values_columns() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('code', 'code',        'header', 'Value code',         'type', 'text',   'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'label_en',    'header', 'Label EN',           'type', 'text',   'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'label_ar',    'header', 'Label AR',           'type', 'text',   'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'aliases',     'header', 'Aliases (separate with ;)', 'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'colour',      'header', 'Colour (#RRGGBB)',   'type', 'text',   'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'parent_code', 'header', 'Parent value',       'type', 'text',   'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'sort_order',  'header', 'Sort order',         'type', 'number', 'kind', 'field', 'required', false, 'derived', false))
$$;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, module_key, match_keys, sort_order, is_master_format)
VALUES ('TPL-LISTVALUES', 'List values', 'قيم القوائم', 'list_value', 'list_values', NULL, '[["code"]]', 3, false)
ON CONFLICT (template_id) DO NOTHING;

INSERT INTO template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
SELECT d.id, 1, public.tpl_header_checksum(public.tpl_list_values_columns()), 1, public.tpl_list_values_columns(), true,
       public.tpl_field_hash(public.tpl_list_values_columns()), 'first version'
FROM template_definitions d
WHERE d.template_id = 'TPL-LISTVALUES' AND NOT EXISTS (SELECT 1 FROM template_versions v WHERE v.template_def_id = d.id);
UPDATE template_definitions SET current_version = 1, updated_at = now() WHERE template_id = 'TPL-LISTVALUES' AND current_version < 1;

-- tpl_sync as built in 0070, with the kind list_values (0103): an unknown kind must never fall through to the Master columns.
CREATE OR REPLACE FUNCTION tpl_sync(p_template text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.template_definitions%ROWTYPE; cols jsonb; h text; cs text; cur public.template_versions%ROWTYPE; fsv integer; nv integer; why text;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.kind = 'register' THEN
    cols := public.tpl_columns(d.register_key); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'register fields changed';
  ELSIF d.kind = 'stream' THEN
    cols := public.tpl_stream_columns(d.stream_code); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'stream tasks or fields changed';
  ELSIF d.kind = 'sites' THEN
    cols := public.tpl_sites_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'site template columns or lists changed';
  ELSIF d.kind = 'list_values' THEN
    cols := public.tpl_list_values_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'list values template changed';
  ELSE
    cols := public.tpl_master_parts(); h := public.tpl_master_hash(cols); cs := public.tpl_master_checksum(cols); why := 'Master columns, tasks or register fields changed';
  END IF;
  SELECT version INTO fsv FROM public.field_set_versions WHERE entity_type::text = d.custom_entity;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  -- nothing changed (the usual case): no lock is taken, so the saves of other screens never wait for this check
  IF FOUND AND cur.field_set_hash IS NOT DISTINCT FROM h THEN RETURN cur.version; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE id = d.id FOR UPDATE;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF NOT FOUND THEN
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
    VALUES (d.id, 1, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, 'first version'));
    UPDATE public.template_definitions SET current_version = 1, updated_at = now() WHERE id = d.id;
    RETURN 1;
  END IF;
  IF cur.field_set_hash IS DISTINCT FROM h THEN
    nv := cur.version + 1;
    UPDATE public.template_versions SET is_current = false, retired_at = now() WHERE id = cur.id;
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason, published_by)
    VALUES (d.id, nv, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, why), public.app_actor());
    UPDATE public.template_definitions SET current_version = nv, updated_at = now() WHERE id = d.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('template_version_issued', 'template', p_template, jsonb_build_object('version', cur.version, 'field_set_hash', cur.field_set_hash),
            jsonb_build_object('version', nv, 'field_set_hash', h, 'columns', jsonb_array_length(cols)), coalesce(p_reason, why), public.app_actor());
    RETURN nv;
  END IF;
  RETURN cur.version;
END $$;

-- The usage check (0102) plus the custom values of sites and tasks. The text match finds the code as a jsonb string, arrays included.
CREATE OR REPLACE FUNCTION list_value_in_use(p_catalogue text, p_code text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.list_values d WHERE d.parent_value_id = p_id)
  OR EXISTS (SELECT 1 FROM public.register_fields f JOIN public.register_records r ON r.register_key = f.register_key
             WHERE f.list_catalogue = p_catalogue
               AND (r.data -> f.code = to_jsonb(p_code) OR (jsonb_typeof(r.data -> f.code) = 'array' AND r.data -> f.code ? p_code)))
  OR EXISTS (SELECT 1 FROM public.register_fields f, jsonb_array_elements(CASE WHEN jsonb_typeof(f.options -> 'columns') = 'array' THEN f.options -> 'columns' ELSE '[]'::jsonb END) c
             WHERE c ->> 'list_catalogue' = p_catalogue)
  OR EXISTS (SELECT 1 FROM public.template_task_fields t WHERE t.list_catalogue = p_catalogue)
  OR EXISTS (SELECT 1 FROM public.task_instances ti WHERE strpos(ti.custom::text, '"' || p_code || '"') > 0)
  OR EXISTS (SELECT 1 FROM public.sites s WHERE strpos(s.custom::text, '"' || p_code || '"') > 0)
$$;
