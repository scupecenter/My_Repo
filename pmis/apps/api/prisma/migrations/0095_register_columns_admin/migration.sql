-- 0095: the admin manages the columns of every register, renames the registers and their sections (owner request 2026-11-13 and the flexibility follow-up of the same day).
--
-- WHAT THIS ADDS.
--   1. register_fields: in_filter, in_template, in_export (visibility), is_system + system_reason (the columns code or derived rules depend on), version (ETag).
--      register_definitions.version (ETag of the rename). register_sections: the sections of a register (EN/AR name, order); register_fields.section keeps the section name.
--   2. Seed of the protected columns (is_system): derived columns, the date column of a task source, the natural keys of a template, and every column read by a
--      validation, rule or calculation function (computed from the function sources; reg_apply, reg_data_for and the one-off converters are not dependencies).
--   3. The doors (SECURITY DEFINER, owner pmis_definer, System Admin or a delegate of fields.edit for ALL regions, a reason, audited with before and after):
--        reg_fields_admin_json     the screen: register, sections and every column (also inactive) with usage counts
--        admin_reg_field_impact    the preview: records with a value, records lacking one, type conversion (how many convert, which fail), delete mode
--        admin_reg_field_save      add / edit a column (rename, required, section, order, visibility, list link, type change with a clean conversion of the values)
--        admin_reg_field_delete    HARD delete when no record of the register (any version) holds a value; otherwise deactivate (history kept)
--        admin_reg_fields_order    the order of the columns
--        admin_reg_section_save / admin_reg_section_delete   add, rename, reorder, delete when empty
--        admin_reg_definition_rename   the name of the register itself (EN/AR)
--   4. tpl_columns skips a column with in_template = false (the change of the column set issues the new template version through the existing statement triggers).
--
-- Rules. A protected column can be renamed, reordered, moved between sections and shown or hidden in lists, filters, templates and exports; its deletion, its
-- deactivation and its type change answer 409 system_field. A type change on a column with values is allowed when every value converts cleanly (409
-- conversion_unconfirmed until the caller confirms; 409 conversion_blocked with the failing values otherwise). Turning "required" on never blocks: the records that
-- lack a value are counted in the answer (they are asked for at their next submit).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns and the sections table
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE register_fields
  ADD COLUMN in_filter boolean NOT NULL DEFAULT false,
  ADD COLUMN in_template boolean NOT NULL DEFAULT true,
  ADD COLUMN in_export boolean NOT NULL DEFAULT true,
  ADD COLUMN is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN system_reason text,
  ADD COLUMN version integer NOT NULL DEFAULT 1;
COMMENT ON COLUMN register_fields.is_system IS '0095: code or a derived rule depends on this column: rename, order, section and visibility only; no delete, deactivation or type change.';
COMMENT ON COLUMN register_fields.in_filter IS '0095: offered as a filter on the register screen.';
COMMENT ON COLUMN register_fields.in_template IS '0095: a column of the register template.';
COMMENT ON COLUMN register_fields.in_export IS '0095: a column of the register export.';
ALTER TABLE register_definitions ADD COLUMN version integer NOT NULL DEFAULT 1;

CREATE TABLE register_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_key text NOT NULL REFERENCES register_definitions (register_key) ON DELETE CASCADE ON UPDATE CASCADE,
  name_en      text NOT NULL CHECK (char_length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar      text,
  sort_order   integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  CONSTRAINT register_sections_name_key UNIQUE (register_key, name_en)
);
COMMENT ON TABLE register_sections IS '0095: the sections of a register form. register_fields.section holds the section name_en. Written only through admin_reg_section_save / admin_reg_section_delete.';
INSERT INTO register_sections (register_key, name_en, sort_order)
SELECT x.register_key, x.section, (row_number() OVER (PARTITION BY x.register_key ORDER BY x.first_order, x.section) * 10)::int
FROM (SELECT register_key, section, min(sort_order) AS first_order FROM register_fields WHERE section IS NOT NULL AND btrim(section) <> '' GROUP BY register_key, section) x;
ALTER TABLE register_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON register_sections FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON register_sections FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
GRANT SELECT, INSERT, UPDATE, DELETE ON register_sections TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON register_fields TO pmis_definer;
GRANT SELECT, UPDATE ON register_definitions TO pmis_definer;
GRANT SELECT, UPDATE ON template_definitions TO pmis_definer;
GRANT SELECT, UPDATE ON register_records TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON register_sections FROM pmis_app;
    GRANT SELECT ON register_sections TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The protected columns (is_system)
-- ---------------------------------------------------------------------------------------------------------------------
-- Derived (filled by the system), the date column of a task source, the natural keys of a template, the columns the TypeScript services read by name.
UPDATE register_fields f SET is_system = true,
  system_reason = CASE
    WHEN f.derived THEN 'Filled by the system (a derived column).'
    WHEN EXISTS (SELECT 1 FROM register_task_sources s WHERE s.register_key = f.register_key AND (s.date_field = f.code OR s.data_eq ? f.code OR s.data_in ? f.code))
      THEN 'Drives the date of a workflow task (the register task source).'
    WHEN EXISTS (SELECT 1 FROM template_definitions t, jsonb_array_elements(coalesce(t.match_keys, '[]'::jsonb)) k, jsonb_array_elements_text(k) e
                 WHERE t.register_key = f.register_key AND e = f.code)
      THEN 'A natural key of the register template (rows are matched on it).'
    ELSE 'Read by the service code of the register (by name).' END
WHERE f.derived
   OR EXISTS (SELECT 1 FROM register_task_sources s WHERE s.register_key = f.register_key AND (s.date_field = f.code OR s.data_eq ? f.code OR s.data_in ? f.code))
   OR EXISTS (SELECT 1 FROM template_definitions t, jsonb_array_elements(coalesce(t.match_keys, '[]'::jsonb)) k, jsonb_array_elements_text(k) e
              WHERE t.register_key = f.register_key AND e = f.code)
   OR (f.register_key, f.code) IN (('procurement', 'members'), ('quality', 'record_code'), ('warehouse', 'exit_reason'), ('warehouse', 'doc_no'), ('warehouse', 'doc_date'));

-- Every column read by a validation, rule or calculation function of the database. The copy into the typed rows (reg_apply), the projection (reg_data_for) and the
-- one-off converters are not dependencies: they tolerate a missing key.
WITH deps AS (
  SELECT f.register_key, f.code, string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) AS fns
  FROM register_fields f
  JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace
    AND p.proname ~ '^(reg_|p5_|hlc_|fleet_|wh_|gecol_|dismantle_|p4a_|p4b_)'
    AND p.proname !~ '_feed_'
    AND p.proname NOT IN ('reg_apply', 'reg_data_for', 'reg_meeting_convert', 'hlc_legacy_to_drafts', 'reg_clean_data', 'reg_clean_cell', 'reg_split_values', 'reg_pick_user', 'reg_pick_site')
    AND p.prosrc ~ ('(->>?|#>>?|\?\|?)\s*''' || f.code || '''')
  WHERE NOT f.is_system AND f.is_active
  GROUP BY f.register_key, f.code
)
UPDATE register_fields f SET is_system = true, system_reason = 'Read by rule or validation code: ' || d.fns || '.'
FROM deps d WHERE f.register_key = d.register_key AND f.code = d.code;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Helpers (internal)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rcol_present(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v) <> 'null'
     AND NOT (jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = '')
     AND NOT (jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 0)
$$;

CREATE OR REPLACE FUNCTION rcol_err(p_path text, p_code text, p_msg text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(p_path, p_code, p_msg))); END $$;

-- The type of a column as the API names it. The storage types of the register engine stay (text, number, date, ...); the richer types are formats in options.
CREATE OR REPLACE FUNCTION rcol_eff_type(p_type text, p_options jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_type = 'number' AND jsonb_typeof(p_options) = 'object' AND p_options ? 'formula' THEN 'computed'
    WHEN p_type = 'list_code' THEN CASE WHEN coalesce((p_options ->> 'multiple')::boolean, false) THEN 'multi_list' ELSE 'list' END
    WHEN p_type = 'external_team' THEN 'external_party'
    WHEN p_type = 'file' THEN 'document'
    WHEN p_type = 'text' AND jsonb_typeof(p_options) = 'object' AND p_options ->> 'format' IN ('long_text', 'email', 'phone', 'link', 'datetime') THEN p_options ->> 'format'
    WHEN p_type = 'number' AND jsonb_typeof(p_options) = 'object' AND p_options ->> 'format' IN ('currency', 'percentage') THEN p_options ->> 'format'
    WHEN p_type = 'multi_site' AND jsonb_typeof(p_options) = 'object' AND p_options ->> 'format' = 'single' THEN 'site'
    ELSE p_type END
$$;

-- The storage (field_type, options, list_catalogue) of an API type.
CREATE OR REPLACE FUNCTION rcol_storage(p_type text, p_catalogue text, p_columns jsonb, p_formula jsonb, OUT o_type text, OUT o_options jsonb, OUT o_catalogue text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  o_options := NULL; o_catalogue := NULL;
  CASE p_type
    WHEN 'text' THEN o_type := 'text';
    WHEN 'long_text', 'email', 'phone', 'link', 'datetime' THEN o_type := 'text'; o_options := jsonb_build_object('format', p_type);
    WHEN 'number' THEN o_type := 'number';
    WHEN 'currency', 'percentage' THEN o_type := 'number'; o_options := jsonb_build_object('format', p_type);
    WHEN 'computed' THEN o_type := 'number'; o_options := jsonb_build_object('formula', p_formula);
    WHEN 'date', 'yes_no', 'user', 'multi_user', 'warehouse_item', 'multi_site' THEN o_type := p_type;
    WHEN 'list' THEN o_type := 'list'; o_catalogue := p_catalogue; o_options := public.list_active_codes(p_catalogue);
    WHEN 'multi_list' THEN o_type := 'list_code'; o_catalogue := p_catalogue; o_options := '{"multiple": true}'::jsonb;
    WHEN 'site' THEN o_type := 'multi_site'; o_options := '{"format": "single"}'::jsonb;
    WHEN 'external_party' THEN o_type := 'external_team';
    WHEN 'document' THEN o_type := 'file';
    WHEN 'child_list' THEN o_type := 'child_list'; o_options := jsonb_build_object('columns', p_columns);
  END CASE;
END $$;

-- The check of a format on one cleaned value. NULL = fine.
CREATE OR REPLACE FUNCTION rcol_format_error(p_fmt text, v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE t text := btrim(v #>> '{}'); ts timestamp;
BEGIN
  CASE p_fmt
    WHEN 'email' THEN IF jsonb_typeof(v) <> 'string' OR t !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' THEN RETURN 'An e-mail address.'; END IF;
    WHEN 'phone' THEN IF jsonb_typeof(v) <> 'string' OR t !~ '^\+?[0-9 ()-]{6,20}$' THEN RETURN 'A phone number (digits, spaces, + ( ) -).'; END IF;
    WHEN 'link' THEN IF jsonb_typeof(v) <> 'string' OR t !~* '^https?://[^[:space:]]{3,}$' THEN RETURN 'A link starting with http:// or https://.'; END IF;
    WHEN 'datetime' THEN
      IF jsonb_typeof(v) <> 'string' OR t !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$' THEN RETURN 'A date and time as YYYY-MM-DD HH:MM.'; END IF;
      BEGIN ts := t::timestamp; EXCEPTION WHEN others THEN RETURN 'Not a calendar date and time.'; END;
    WHEN 'percentage' THEN IF jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric NOT BETWEEN 0 AND 100 THEN RETURN 'A percentage from 0 to 100.'; END IF;
    WHEN 'single_site' THEN IF jsonb_typeof(v) = 'array' AND jsonb_array_length(v) > 1 THEN RETURN 'One site only.'; END IF;
    ELSE NULL;
  END CASE;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION rcol_json(f public.register_fields) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar, 'type', public.rcol_eff_type(f.field_type, f.options), 'required', f.required,
    'list_catalogue', f.list_catalogue, 'section', f.section, 'sort_order', f.sort_order, 'in_list', f.in_list, 'in_filter', f.in_filter, 'in_template', f.in_template,
    'in_export', f.in_export, 'is_active', f.is_active, 'is_system', f.is_system, 'version', f.version)
$$;

CREATE OR REPLACE FUNCTION reg_field_usage(p_register text, p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'records_with_value', count(*) FILTER (WHERE public.rcol_present(r.data -> p_code)),
    'records_missing_value', count(*) FILTER (WHERE r.is_current AND r.state <> 'voided' AND NOT public.rcol_present(r.data -> p_code)),
    'records_current', count(*) FILTER (WHERE r.is_current AND r.state <> 'voided'))
  FROM public.register_records r WHERE r.register_key = p_register
$$;

-- One value of a column converted to another type. Returns {"v": value} or {"e": message}.
CREATE OR REPLACE FUNCTION rcol_convert(v jsonb, p_to text, p_catalogue text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t text; parts text[]; x text; picked text; out jsonb := '[]'::jsonb; r jsonb; u uuid; msg text; fmt text;
BEGIN
  t := btrim(v #>> '{}');
  CASE p_to
    WHEN 'text', 'long_text', 'email', 'phone', 'link', 'datetime' THEN
      IF jsonb_typeof(v) = 'string' THEN
        IF char_length(t) > 2000 THEN RETURN jsonb_build_object('e', 'Longer than 2000 characters.'); END IF;
        r := jsonb_build_object('v', to_jsonb(t));
      ELSIF jsonb_typeof(v) = 'number' THEN r := jsonb_build_object('v', to_jsonb(v #>> '{}'));
      ELSIF jsonb_typeof(v) = 'boolean' THEN r := jsonb_build_object('v', to_jsonb(CASE WHEN (v #>> '{}')::boolean THEN 'Yes' ELSE 'No' END));
      ELSIF jsonb_typeof(v) = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) NOT IN ('string', 'number')) THEN
        r := jsonb_build_object('v', to_jsonb(array_to_string(ARRAY(SELECT e #>> '{}' FROM jsonb_array_elements(v) e), '; ')));
      ELSE RETURN jsonb_build_object('e', 'This value has no text form.');
      END IF;
      msg := public.rcol_format_error(p_to, r -> 'v');
      IF msg IS NOT NULL THEN RETURN jsonb_build_object('e', msg); END IF;
      RETURN r;
    WHEN 'number', 'currency', 'percentage' THEN
      IF jsonb_typeof(v) NOT IN ('string', 'number') THEN RETURN jsonb_build_object('e', 'Not a number.'); END IF;
      r := public.reg_clean_cell(jsonb_build_object('type', 'number'), to_jsonb(t));
      IF r ? 'v' THEN
        msg := public.rcol_format_error(p_to, r -> 'v');
        IF msg IS NOT NULL THEN RETURN jsonb_build_object('e', msg); END IF;
      END IF;
      RETURN r;
    WHEN 'date' THEN
      IF jsonb_typeof(v) <> 'string' THEN RETURN jsonb_build_object('e', 'Not a date.'); END IF;
      RETURN public.reg_clean_cell(jsonb_build_object('type', 'date'), to_jsonb(left(t, 10)));
    WHEN 'yes_no' THEN
      IF jsonb_typeof(v) = 'boolean' THEN RETURN jsonb_build_object('v', v); END IF;
      IF lower(t) IN ('yes', 'y', 'true', '1', 'نعم') THEN RETURN jsonb_build_object('v', true); END IF;
      IF lower(t) IN ('no', 'n', 'false', '0', 'لا') THEN RETURN jsonb_build_object('v', false); END IF;
      RETURN jsonb_build_object('e', 'Not Yes or No.');
    WHEN 'list', 'list_code' THEN
      IF jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 1 THEN v := v -> 0; t := btrim(v #>> '{}'); END IF;
      IF jsonb_typeof(v) NOT IN ('string', 'number') THEN RETURN jsonb_build_object('e', 'Not a value of the list.'); END IF;
      picked := public.reg_list_value(p_catalogue, t);
      IF picked IS NULL THEN RETURN jsonb_build_object('e', 'Not a value of the list.'); END IF;
      RETURN jsonb_build_object('v', to_jsonb(picked));
    WHEN 'multi_list' THEN
      parts := public.reg_split_values(v);
      IF parts IS NULL THEN RETURN jsonb_build_object('e', 'Not a list of values.'); END IF;
      FOREACH x IN ARRAY parts LOOP
        picked := public.reg_list_value(p_catalogue, x);
        IF picked IS NULL THEN RETURN jsonb_build_object('e', '"' || x || '" is not a value of the list.'); END IF;
        IF NOT out ? picked THEN out := out || to_jsonb(picked); END IF;
      END LOOP;
      RETURN jsonb_build_object('v', out);
    WHEN 'user' THEN
      IF jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 1 THEN v := v -> 0; t := btrim(v #>> '{}'); END IF;
      IF jsonb_typeof(v) <> 'string' THEN RETURN jsonb_build_object('e', 'Not a user.'); END IF;
      RETURN public.reg_clean_cell(jsonb_build_object('type', 'user'), to_jsonb(t));
    WHEN 'multi_user' THEN
      parts := public.reg_split_values(v);
      IF parts IS NULL THEN RETURN jsonb_build_object('e', 'Not a list of people.'); END IF;
      FOREACH x IN ARRAY parts LOOP
        u := public.reg_pick_user(x);
        IF u IS NULL THEN RETURN jsonb_build_object('e', 'Unknown user: "' || left(x, 60) || '".'); END IF;
        IF NOT out ? u::text THEN out := out || to_jsonb(u::text); END IF;
      END LOOP;
      RETURN jsonb_build_object('v', out);
    WHEN 'site', 'multi_site' THEN
      parts := public.reg_split_values(v);
      IF parts IS NULL THEN RETURN jsonb_build_object('e', 'Not a site.'); END IF;
      FOREACH x IN ARRAY parts LOOP
        u := public.reg_pick_site(x);
        IF u IS NULL THEN RETURN jsonb_build_object('e', 'Unknown site, or a site outside your regions: "' || left(x, 60) || '".'); END IF;
        IF NOT out ? u::text THEN out := out || to_jsonb(u::text); END IF;
      END LOOP;
      IF p_to = 'site' AND jsonb_array_length(out) > 1 THEN RETURN jsonb_build_object('e', 'More than one site.'); END IF;
      RETURN jsonb_build_object('v', out);
    WHEN 'external_party' THEN
      IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM public.external_teams e WHERE e.id = t::uuid AND e.is_active) THEN
        RETURN jsonb_build_object('e', 'Not an active external party.');
      END IF;
      RETURN jsonb_build_object('v', to_jsonb(lower(t)));
    WHEN 'warehouse_item' THEN
      SELECT w.id INTO u FROM public.warehouse_items w WHERE jsonb_typeof(v) = 'string'
        AND (CASE WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN w.id = t::uuid ELSE upper(w.item_code) = upper(t) END) LIMIT 1;
      IF u IS NULL THEN RETURN jsonb_build_object('e', 'No Warehouse item has this id or code.'); END IF;
      RETURN jsonb_build_object('v', to_jsonb(u::text));
    ELSE
      RETURN jsonb_build_object('e', 'This type cannot be reached from the current one: clear the values first.');
  END CASE;
END $$;

-- The conversion of every value of a column. p_apply writes the converted values (only when every value converts).
CREATE OR REPLACE FUNCTION rcol_conversion(p_register text, p_code text, p_to text, p_catalogue text, p_apply boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r record; c jsonb; ok int := 0; bad int := 0; fails jsonb := '[]'::jsonb; changes jsonb := '[]'::jsonb;
BEGIN
  FOR r IN SELECT x.id, x.data -> p_code AS v FROM public.register_records x WHERE x.register_key = p_register AND public.rcol_present(x.data -> p_code) ORDER BY x.created_at, x.id LOOP
    c := public.rcol_convert(r.v, p_to, p_catalogue);
    IF c ? 'v' THEN
      ok := ok + 1;
      IF c -> 'v' IS DISTINCT FROM r.v THEN changes := changes || jsonb_build_array(jsonb_build_array(r.id, c -> 'v')); END IF;
    ELSE
      bad := bad + 1;
      IF bad <= 20 THEN fails := fails || jsonb_build_object('record_id', r.id, 'value', r.v, 'message', c ->> 'e'); END IF;
    END IF;
  END LOOP;
  IF p_apply AND bad = 0 THEN
    UPDATE public.register_records x SET data = jsonb_set(x.data, ARRAY[p_code], ch.nv, false), version = x.version + 1, updated_at = now()
    FROM (SELECT (e ->> 0)::uuid AS id, e -> 1 AS nv FROM jsonb_array_elements(changes) e) ch WHERE x.id = ch.id;
  END IF;
  RETURN jsonb_build_object('convertible', ok, 'failed', bad, 'failures', fails, 'rewritten', jsonb_array_length(changes));
END $$;

CREATE OR REPLACE FUNCTION rcol_lock(p_register text, p_code text) RETURNS public.register_fields
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.register_fields%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.register_fields WHERE register_key = p_register AND code = p_code FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The column does not exist in this register.')); END IF;
  RETURN f;
END $$;

CREATE OR REPLACE FUNCTION rcol_need_register(p_register text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions WHERE register_key = p_register) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register does not exist.'));
  END IF;
END $$;

-- The formula of a computed column: {"op": sum|diff|product|ratio|days_between, "a": code, "b": code} over two other columns of the register.
CREATE OR REPLACE FUNCTION rcol_check_formula(p_register text, p_formula jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE k text;
BEGIN
  IF p_formula IS NULL OR jsonb_typeof(p_formula) <> 'object' OR coalesce(p_formula ->> 'op', '') NOT IN ('sum', 'diff', 'product', 'ratio', 'days_between') THEN
    PERFORM public.rcol_err('/formula', 'invalid', 'A formula needs op (sum, diff, product, ratio or days_between), a and b.');
  END IF;
  FOREACH k IN ARRAY ARRAY['a', 'b'] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.register_fields x WHERE x.register_key = p_register AND x.code = p_formula ->> k AND x.is_active AND NOT x.derived
                   AND x.field_type = CASE WHEN p_formula ->> 'op' = 'days_between' THEN 'date' ELSE 'number' END) THEN
      PERFORM public.rcol_err('/formula/' || k, 'invalid', CASE WHEN p_formula ->> 'op' = 'days_between' THEN 'A date column of this register.' ELSE 'A number column of this register (not computed).' END);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Reads
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_fields_admin_json(p_register text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.register_definitions%ROWTYPE;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_register;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register does not exist.')); END IF;
  RETURN jsonb_build_object(
    'register', jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'version', d.version),
    'sections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name_en', s.name_en, 'name_ar', s.name_ar, 'sort_order', s.sort_order, 'version', s.version,
        'field_count', (SELECT count(*) FROM public.register_fields f WHERE f.register_key = s.register_key AND f.section = s.name_en)) ORDER BY s.sort_order, s.name_en)
      FROM public.register_sections s WHERE s.register_key = p_register), '[]'::jsonb),
    'fields', coalesce((SELECT jsonb_agg(public.rcol_json(f) || jsonb_build_object('system_reason', f.system_reason, 'derived', f.derived, 'usage', public.reg_field_usage(f.register_key, f.code),
        'list_catalogue_name', (SELECT c.name_en FROM public.list_catalogues c WHERE c.code = f.list_catalogue))
        ORDER BY f.sort_order, f.code COLLATE "C")
      FROM public.register_fields f WHERE f.register_key = p_register), '[]'::jsonb));
END $$;

-- The preview of a change: p_patch may carry field_type, list_catalogue and required (as in admin_reg_field_save).
CREATE OR REPLACE FUNCTION admin_reg_field_impact(p_register text, p_code text, p_patch jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.register_fields%ROWTYPE; u jsonb; conv jsonb := NULL; to_t text; to_cat text; from_t text; used int;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  SELECT * INTO f FROM public.register_fields WHERE register_key = p_register AND code = p_code;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The column does not exist in this register.')); END IF;
  u := public.reg_field_usage(p_register, p_code);
  used := (u ->> 'records_with_value')::int;
  from_t := public.rcol_eff_type(f.field_type, f.options);
  to_t := coalesce(p_patch ->> 'field_type', from_t);
  to_cat := CASE WHEN p_patch ? 'list_catalogue' THEN p_patch ->> 'list_catalogue' ELSE f.list_catalogue END;
  IF used > 0 AND (to_t <> from_t OR to_cat IS DISTINCT FROM f.list_catalogue) THEN
    conv := public.rcol_conversion(p_register, p_code, to_t, to_cat, false);
  END IF;
  RETURN jsonb_build_object('code', p_code, 'is_system', f.is_system, 'system_reason', f.system_reason, 'usage', u,
    'delete_mode', CASE WHEN f.is_system THEN 'blocked' WHEN used = 0 THEN 'hard' ELSE 'deactivate' END,
    'conversion', conv,
    'required_missing', CASE WHEN coalesce((p_patch ->> 'required')::boolean, false) AND NOT f.required THEN (u ->> 'records_missing_value')::int END);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Writes
-- ---------------------------------------------------------------------------------------------------------------------
-- p_patch keys: label_en, label_ar, field_type, required, list_catalogue, section, sort_order, in_list, in_filter, in_template, in_export, is_active, columns (child_list).
CREATE OR REPLACE FUNCTION admin_reg_field_save(p_register text, p_code text, p_create boolean, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL,
                                                 p_confirm_conversion boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  f public.register_fields%ROWTYPE; old_f public.register_fields%ROWTYPE; k text; errs jsonb := '[]'::jsonb;
  to_t text; from_t text; new_type text; new_opts jsonb; new_cat text; conv jsonb; u jsonb; sys_keys text[] := ARRAY['label_en', 'label_ar', 'section', 'sort_order', 'in_list', 'in_filter', 'in_template', 'in_export'];
  converted int := 0; missing int := NULL; match_key boolean; changed_type boolean; st record; dcode text; dres jsonb; fm jsonb;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM public.rcol_need_register(p_register);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('label_en', 'label_ar', 'field_type', 'required', 'list_catalogue', 'section', 'sort_order', 'in_list', 'in_filter', 'in_template', 'in_export', 'is_active', 'columns', 'formula') THEN
      errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.');
    END IF;
  END LOOP;
  IF p_patch ? 'label_en' AND char_length(btrim(coalesce(p_patch ->> 'label_en', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || public.reg_err_item('/label_en', 'invalid', 'A label of 1 to 200 characters.'); END IF;
  IF p_patch ? 'label_ar' AND p_patch ->> 'label_ar' IS NOT NULL AND char_length(btrim(p_patch ->> 'label_ar')) > 200 THEN errs := errs || public.reg_err_item('/label_ar', 'invalid', 'Up to 200 characters.'); END IF;
  IF p_patch ? 'field_type' AND coalesce(p_patch ->> 'field_type', '') NOT IN ('text', 'long_text', 'email', 'phone', 'link', 'datetime', 'number', 'currency', 'percentage', 'date', 'yes_no', 'list', 'multi_list', 'user', 'multi_user', 'site', 'multi_site', 'external_party', 'warehouse_item', 'document', 'child_list', 'computed') THEN
    errs := errs || public.reg_err_item('/field_type', 'invalid', 'Not a column type.');
  END IF;
  IF p_patch ? 'sort_order' AND (jsonb_typeof(p_patch -> 'sort_order') <> 'number' OR (p_patch ->> 'sort_order')::numeric NOT BETWEEN 0 AND 100000) THEN errs := errs || public.reg_err_item('/sort_order', 'invalid', 'A whole number from 0 to 100000.'); END IF;
  FOREACH k IN ARRAY ARRAY['required', 'in_list', 'in_filter', 'in_template', 'in_export', 'is_active'] LOOP
    IF p_patch ? k AND jsonb_typeof(p_patch -> k) <> 'boolean' THEN errs := errs || public.reg_err_item('/' || k, 'invalid', 'true or false.'); END IF;
  END LOOP;
  IF p_patch ? 'section' AND p_patch ->> 'section' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.register_sections s WHERE s.register_key = p_register AND s.name_en = p_patch ->> 'section') THEN
    errs := errs || public.reg_err_item('/section', 'unknown_section', 'This section does not exist in the register: add it first.');
  END IF;
  IF p_patch ? 'list_catalogue' AND p_patch ->> 'list_catalogue' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.list_catalogues c WHERE c.code = p_patch ->> 'list_catalogue' AND c.is_active) THEN
    errs := errs || public.reg_err_item('/list_catalogue', 'unknown_list', 'This list does not exist or is inactive.');
  END IF;
  IF p_patch ? 'columns' AND (jsonb_typeof(p_patch -> 'columns') <> 'array' OR jsonb_array_length(p_patch -> 'columns') = 0) THEN errs := errs || public.reg_err_item('/columns', 'invalid', 'A child list needs at least one column.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_create THEN
    IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{0,40}$' THEN PERFORM public.rcol_err('/code', 'invalid', 'A code of lower-case letters, digits and _ (starting with a letter, up to 41 characters).'); END IF;
    IF EXISTS (SELECT 1 FROM public.register_fields x WHERE x.register_key = p_register AND x.code = p_code) THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This register has a column with this code already (it may be inactive).'));
    END IF;
    IF NOT (p_patch ? 'label_en') THEN PERFORM public.rcol_err('/label_en', 'required', 'The English label is required.'); END IF;
    IF NOT (p_patch ? 'field_type') THEN PERFORM public.rcol_err('/field_type', 'required', 'The type is required.'); END IF;
    to_t := p_patch ->> 'field_type';
    IF to_t IN ('list', 'multi_list') AND p_patch ->> 'list_catalogue' IS NULL THEN PERFORM public.rcol_err('/list_catalogue', 'required', 'A list column needs a list.'); END IF;
    IF to_t = 'child_list' AND NOT (p_patch ? 'columns') THEN PERFORM public.rcol_err('/columns', 'required', 'A child list needs its columns.'); END IF;
    IF to_t = 'computed' THEN PERFORM public.rcol_check_formula(p_register, p_patch -> 'formula'); END IF;
    SELECT * INTO st FROM public.rcol_storage(to_t, p_patch ->> 'list_catalogue', p_patch -> 'columns', p_patch -> 'formula');
    new_type := st.o_type; new_opts := st.o_options;
    IF to_t = 'document' THEN
      -- the Document Library slot of the column: one document type placed on this register, published at once (mandatory only when the column is required)
      dcode := 'RC_' || upper(left(regexp_replace(p_register || '_' || p_code, '[^a-zA-Z0-9]', '_', 'g'), 24)) || '_' || upper(substr(md5(p_register || ':' || p_code), 1, 3));
      dres := public.admin_save_document_type(NULL, jsonb_build_object('code', dcode, 'name_en', rpad(btrim(p_patch ->> 'label_en'), 2, ' '), 'name_ar', nullif(btrim(coalesce(p_patch ->> 'label_ar', '')), ''),
                'mandatory', coalesce((p_patch ->> 'required')::boolean, false), 'placements', jsonb_build_array(jsonb_build_object('target', 'register', 'ref', p_register))), p_reason, NULL);
      PERFORM public.admin_publish_document_type((dres ->> 'id')::uuid, NULL, 'new_only', current_date, p_reason);
      new_opts := jsonb_build_object('doc_type_code', dcode);
    END IF;
    INSERT INTO public.register_fields (register_key, code, label_en, label_ar, field_type, required, options, in_list, section, sort_order, is_active, list_catalogue, derived,
                                        in_filter, in_template, in_export)
    VALUES (p_register, p_code, btrim(p_patch ->> 'label_en'), nullif(btrim(coalesce(p_patch ->> 'label_ar', '')), ''), new_type, coalesce((p_patch ->> 'required')::boolean, false), new_opts,
            coalesce((p_patch ->> 'in_list')::boolean, false), p_patch ->> 'section',
            coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(x.sort_order), 0) + 10 FROM public.register_fields x WHERE x.register_key = p_register)), true,
            st.o_catalogue, to_t = 'computed',
            coalesce((p_patch ->> 'in_filter')::boolean, false), coalesce((p_patch ->> 'in_template')::boolean, true), coalesce((p_patch ->> 'in_export')::boolean, true))
    RETURNING * INTO f;
    PERFORM public.log_audit_write('register_field_create', 'register_field', p_register || ':' || p_code, NULL, public.rcol_json(f), p_reason);
    RETURN jsonb_build_object('code', f.code, 'version', f.version, 'converted', 0);
  END IF;

  old_f := public.rcol_lock(p_register, p_code);
  f := old_f;
  IF p_version IS NOT NULL AND p_version <> old_f.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it. Reload and try again.')); END IF;
  IF p_patch = '{}'::jsonb THEN PERFORM public.rcol_err('/', 'required', 'Change at least one field.'); END IF;

  IF old_f.is_system THEN
    FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
      IF NOT (k = ANY (sys_keys)) THEN
        PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'This column is protected: ' || coalesce(old_f.system_reason, 'code depends on it') || ' You can rename it, reorder it, move it to another section and show or hide it, but not change its type, requirement or list, or deactivate it.', 'reason', old_f.system_reason, 'key', k));
      END IF;
    END LOOP;
    IF p_patch ? 'in_template' AND (p_patch ->> 'in_template')::boolean = false THEN
      SELECT EXISTS (SELECT 1 FROM public.template_definitions t, jsonb_array_elements(coalesce(t.match_keys, '[]'::jsonb)) mk, jsonb_array_elements_text(mk) e
                     WHERE t.register_key = p_register AND e = p_code) INTO match_key;
      IF match_key THEN PERFORM public.rcol_err('/in_template', 'match_key', 'This column is a natural key of the register template and stays in it.'); END IF;
    END IF;
  END IF;

  f.label_en := coalesce(btrim(p_patch ->> 'label_en'), f.label_en);
  IF p_patch ? 'label_ar' THEN f.label_ar := nullif(btrim(coalesce(p_patch ->> 'label_ar', '')), ''); END IF;
  IF p_patch ? 'section' THEN f.section := p_patch ->> 'section'; END IF;
  f.sort_order := coalesce((p_patch ->> 'sort_order')::int, f.sort_order);
  f.in_list := coalesce((p_patch ->> 'in_list')::boolean, f.in_list);
  f.in_filter := coalesce((p_patch ->> 'in_filter')::boolean, f.in_filter);
  f.in_template := coalesce((p_patch ->> 'in_template')::boolean, f.in_template);
  f.in_export := coalesce((p_patch ->> 'in_export')::boolean, f.in_export);
  f.is_active := coalesce((p_patch ->> 'is_active')::boolean, f.is_active);
  IF p_patch ? 'required' THEN
    f.required := (p_patch ->> 'required')::boolean;
    IF f.required AND NOT old_f.required THEN missing := (public.reg_field_usage(p_register, p_code) ->> 'records_missing_value')::int; END IF;
  END IF;

  from_t := public.rcol_eff_type(old_f.field_type, old_f.options);
  IF p_patch ? 'formula' THEN
    IF from_t <> 'computed' THEN PERFORM public.rcol_err('/formula', 'invalid', 'Only a computed column has a formula.'); END IF;
    PERFORM public.rcol_check_formula(p_register, p_patch -> 'formula');
    f.options := jsonb_build_object('formula', p_patch -> 'formula');
  END IF;
  to_t := coalesce(p_patch ->> 'field_type', from_t);
  new_cat := CASE WHEN p_patch ? 'list_catalogue' THEN p_patch ->> 'list_catalogue' ELSE old_f.list_catalogue END;
  changed_type := to_t <> from_t OR (to_t IN ('list', 'multi_list') AND new_cat IS DISTINCT FROM old_f.list_catalogue);
  IF changed_type THEN
    IF to_t IN ('list', 'multi_list') AND new_cat IS NULL THEN PERFORM public.rcol_err('/list_catalogue', 'required', 'A list column needs a list.'); END IF;
    IF to_t = 'child_list' AND NOT (p_patch ? 'columns') THEN PERFORM public.rcol_err('/columns', 'required', 'A child list needs its columns.'); END IF;
    IF to_t IN ('computed', 'document', 'child_list') OR from_t IN ('computed', 'document', 'child_list') THEN
      PERFORM public.rcol_err('/field_type', 'not_convertible', 'A computed, document or child list column keeps its type: add a new column instead.');
    END IF;
    u := public.reg_field_usage(p_register, p_code);
    IF (u ->> 'records_with_value')::int > 0 THEN
      conv := public.rcol_conversion(p_register, p_code, to_t, new_cat, false);
      IF (conv ->> 'failed')::int > 0 THEN
        PERFORM public.wf_err('conversion_blocked', jsonb_build_object('detail', 'Some values cannot be converted to the new type; fix or clear them first.', 'conversion', conv));
      END IF;
      IF NOT coalesce(p_confirm_conversion, false) THEN
        PERFORM public.wf_err('conversion_unconfirmed', jsonb_build_object('detail', 'Every value converts. Confirm the conversion to continue.', 'conversion', conv));
      END IF;
      conv := public.rcol_conversion(p_register, p_code, to_t, new_cat, true);
      converted := (conv ->> 'rewritten')::int;
    END IF;
    SELECT * INTO st FROM public.rcol_storage(to_t, new_cat, p_patch -> 'columns', NULL);
    f.field_type := st.o_type; f.list_catalogue := st.o_catalogue; f.options := st.o_options;
  END IF;

  UPDATE public.register_fields x SET label_en = f.label_en, label_ar = f.label_ar, field_type = f.field_type, required = f.required, options = f.options, list_catalogue = f.list_catalogue,
    section = f.section, sort_order = f.sort_order, in_list = f.in_list, in_filter = f.in_filter, in_template = f.in_template, in_export = f.in_export, is_active = f.is_active,
    version = x.version + 1
  WHERE x.register_key = p_register AND x.code = p_code RETURNING * INTO f;
  PERFORM public.log_audit_write(CASE WHEN old_f.is_active AND NOT f.is_active THEN 'register_field_deactivate' WHEN NOT old_f.is_active AND f.is_active THEN 'register_field_reactivate'
                                      WHEN changed_type THEN 'register_field_type_change' ELSE 'register_field_update' END,
    'register_field', p_register || ':' || p_code, public.rcol_json(old_f), public.rcol_json(f) || CASE WHEN changed_type THEN jsonb_build_object('values_rewritten', converted) ELSE '{}'::jsonb END, p_reason);
  RETURN jsonb_build_object('code', f.code, 'version', f.version, 'converted', converted, 'records_missing_value', missing);
END $$;

CREATE OR REPLACE FUNCTION admin_reg_field_delete(p_register text, p_code text, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.register_fields%ROWTYPE; u jsonb; used int;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  f := public.rcol_lock(p_register, p_code);
  IF p_version IS NOT NULL AND p_version <> f.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it. Reload and try again.')); END IF;
  IF f.is_system THEN
    PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'This column is protected and cannot be deleted or deactivated: ' || coalesce(f.system_reason, 'code depends on it'), 'reason', f.system_reason));
  END IF;
  u := public.reg_field_usage(p_register, p_code);
  used := (u ->> 'records_with_value')::int;
  IF used = 0 THEN
    DELETE FROM public.register_fields WHERE register_key = p_register AND code = p_code;
    PERFORM public.log_audit_write('register_field_delete', 'register_field', p_register || ':' || p_code, public.rcol_json(f), NULL, p_reason);
    RETURN jsonb_build_object('mode', 'deleted', 'code', p_code, 'records_with_value', 0);
  END IF;
  UPDATE public.register_fields SET is_active = false, version = version + 1 WHERE register_key = p_register AND code = p_code RETURNING * INTO f;
  PERFORM public.log_audit_write('register_field_deactivate', 'register_field', p_register || ':' || p_code, NULL, public.rcol_json(f) || jsonb_build_object('records_with_value', used), p_reason);
  RETURN jsonb_build_object('mode', 'deactivated', 'code', p_code, 'records_with_value', used, 'version', f.version,
    'detail', used || ' record(s) hold a value for this column, so it is hidden from forms and lists and its history is kept. You can reactivate it.');
END $$;

CREATE OR REPLACE FUNCTION admin_reg_fields_order(p_register text, p_codes text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before_ jsonb; after_ jsonb; n int;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM public.rcol_need_register(p_register);
  IF p_codes IS NULL OR cardinality(p_codes) = 0 THEN PERFORM public.rcol_err('/codes', 'required', 'List the columns in their new order.'); END IF;
  IF (SELECT count(DISTINCT c) FROM unnest(p_codes) c) <> cardinality(p_codes) THEN PERFORM public.rcol_err('/codes', 'duplicate', 'A column appears twice.'); END IF;
  SELECT count(*) INTO n FROM public.register_fields WHERE register_key = p_register AND code = ANY (p_codes);
  IF n <> cardinality(p_codes) THEN PERFORM public.rcol_err('/codes', 'unknown', 'A column does not exist in this register.'); END IF;
  SELECT jsonb_object_agg(code, sort_order) INTO before_ FROM public.register_fields WHERE register_key = p_register AND code = ANY (p_codes);
  UPDATE public.register_fields f SET sort_order = o.ord::int * 10, version = f.version + 1
  FROM unnest(p_codes) WITH ORDINALITY AS o(code, ord) WHERE f.register_key = p_register AND f.code = o.code AND f.sort_order <> o.ord::int * 10;
  SELECT jsonb_object_agg(code, sort_order) INTO after_ FROM public.register_fields WHERE register_key = p_register AND code = ANY (p_codes);
  PERFORM public.log_audit_write('register_fields_reorder', 'register', p_register, before_, after_, p_reason);
  RETURN jsonb_build_object('ordered', cardinality(p_codes));
END $$;

-- p_id NULL = a new section. Keys: name_en, name_ar, sort_order. A rename moves the columns of the section with it.
CREATE OR REPLACE FUNCTION admin_reg_section_save(p_register text, p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.register_sections%ROWTYPE; old_s public.register_sections%ROWTYPE; k text; nm text;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM public.rcol_need_register(p_register);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('name_en', 'name_ar', 'sort_order') THEN PERFORM public.rcol_err('/' || k, 'unknown_field', 'This key cannot be set.'); END IF;
  END LOOP;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) NOT BETWEEN 1 AND 120 THEN PERFORM public.rcol_err('/name_en', 'invalid', 'A name of 1 to 120 characters.'); END IF;
  IF p_patch ? 'sort_order' AND (jsonb_typeof(p_patch -> 'sort_order') <> 'number' OR (p_patch ->> 'sort_order')::numeric NOT BETWEEN 0 AND 100000) THEN PERFORM public.rcol_err('/sort_order', 'invalid', 'A whole number from 0 to 100000.'); END IF;
  nm := btrim(p_patch ->> 'name_en');
  IF p_id IS NULL THEN
    IF nm IS NULL THEN PERFORM public.rcol_err('/name_en', 'required', 'The English name is required.'); END IF;
    IF EXISTS (SELECT 1 FROM public.register_sections x WHERE x.register_key = p_register AND lower(x.name_en) = lower(nm)) THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This register has a section with this name already.')); END IF;
    INSERT INTO public.register_sections (register_key, name_en, name_ar, sort_order)
    VALUES (p_register, nm, nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), ''), coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(x.sort_order), 0) + 10 FROM public.register_sections x WHERE x.register_key = p_register)))
    RETURNING * INTO s;
    PERFORM public.log_audit_write('register_section_create', 'register_section', p_register || ':' || s.name_en, NULL, to_jsonb(s) - 'id', p_reason);
    RETURN jsonb_build_object('id', s.id, 'version', s.version);
  END IF;
  SELECT * INTO old_s FROM public.register_sections WHERE id = p_id AND register_key = p_register FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The section does not exist in this register.')); END IF;
  IF p_version IS NOT NULL AND p_version <> old_s.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The section changed since you read it. Reload and try again.')); END IF;
  IF p_patch = '{}'::jsonb THEN PERFORM public.rcol_err('/', 'required', 'Change at least one field.'); END IF;
  IF nm IS NOT NULL AND lower(nm) <> lower(old_s.name_en) AND EXISTS (SELECT 1 FROM public.register_sections x WHERE x.register_key = p_register AND lower(x.name_en) = lower(nm) AND x.id <> p_id) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This register has a section with this name already.'));
  END IF;
  UPDATE public.register_sections SET name_en = coalesce(nm, name_en), name_ar = CASE WHEN p_patch ? 'name_ar' THEN nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') ELSE name_ar END,
    sort_order = coalesce((p_patch ->> 'sort_order')::int, sort_order), version = version + 1 WHERE id = p_id RETURNING * INTO s;
  IF s.name_en <> old_s.name_en THEN
    UPDATE public.register_fields SET section = s.name_en, version = version + 1 WHERE register_key = p_register AND section = old_s.name_en;
  END IF;
  PERFORM public.log_audit_write('register_section_update', 'register_section', p_register || ':' || s.name_en, to_jsonb(old_s) - 'id', to_jsonb(s) - 'id', p_reason);
  RETURN jsonb_build_object('id', s.id, 'version', s.version);
END $$;

CREATE OR REPLACE FUNCTION admin_reg_section_delete(p_register text, p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.register_sections%ROWTYPE; n int;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO s FROM public.register_sections WHERE id = p_id AND register_key = p_register FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The section does not exist in this register.')); END IF;
  SELECT count(*) INTO n FROM public.register_fields WHERE register_key = p_register AND section = s.name_en;
  IF n > 0 THEN PERFORM public.wf_err('section_not_empty', jsonb_build_object('detail', 'The section still holds ' || n || ' column(s). Move or delete them first.', 'count', n)); END IF;
  DELETE FROM public.register_sections WHERE id = p_id;
  PERFORM public.log_audit_write('register_section_delete', 'register_section', p_register || ':' || s.name_en, to_jsonb(s) - 'id', NULL, p_reason);
  RETURN jsonb_build_object('deleted', true);
END $$;

CREATE OR REPLACE FUNCTION admin_reg_definition_rename(p_register text, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.register_definitions%ROWTYPE; old_d public.register_definitions%ROWTYPE; k text;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('name_en', 'name_ar') THEN PERFORM public.rcol_err('/' || k, 'unknown_field', 'Only the names can be changed.'); END IF;
  END LOOP;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) NOT BETWEEN 1 AND 120 THEN PERFORM public.rcol_err('/name_en', 'invalid', 'A name of 1 to 120 characters.'); END IF;
  IF p_patch ? 'name_ar' AND char_length(btrim(coalesce(p_patch ->> 'name_ar', ''))) > 120 THEN PERFORM public.rcol_err('/name_ar', 'invalid', 'Up to 120 characters.'); END IF;
  IF p_patch = '{}'::jsonb THEN PERFORM public.rcol_err('/', 'required', 'Change at least one name.'); END IF;
  SELECT * INTO old_d FROM public.register_definitions WHERE register_key = p_register FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> old_d.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The register changed since you read it. Reload and try again.')); END IF;
  UPDATE public.register_definitions SET name_en = coalesce(btrim(p_patch ->> 'name_en'), name_en),
    name_ar = CASE WHEN p_patch ? 'name_ar' THEN nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') ELSE name_ar END, version = version + 1
  WHERE register_key = p_register RETURNING * INTO d;
  UPDATE public.template_definitions SET name = d.name_en, name_ar = d.name_ar, updated_at = now() WHERE register_key = p_register AND kind = 'register';
  PERFORM public.log_audit_write('register_rename', 'register', p_register, jsonb_build_object('name_en', old_d.name_en, 'name_ar', old_d.name_ar),
    jsonb_build_object('name_en', d.name_en, 'name_ar', d.name_ar), p_reason);
  RETURN jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'version', d.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Templates skip the columns hidden from them
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('public.tpl_columns(text)'::regprocedure) INTO src;
  IF position('f.register_key = p_register AND f.is_active' IN src) = 0 THEN RAISE EXCEPTION 'tpl_columns changed: update 0095'; END IF;
  src := replace(src, 'f.register_key = p_register AND f.is_active', 'f.register_key = p_register AND f.is_active AND f.in_template');
  EXECUTE src;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6b. The richer types: format checks on every entry, computed values, the data_type of a template column
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION reg_clean_data(text, jsonb) RENAME TO reg_clean_data_base;
CREATE OR REPLACE FUNCTION reg_clean_data(p_key text, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb; f record; msg text; errs jsonb := '[]'::jsonb;
BEGIN
  out := public.reg_clean_data_base(p_key, p_patch);
  FOR f IN SELECT x.code, CASE WHEN x.field_type = 'multi_site' THEN 'single_site' ELSE x.options ->> 'format' END AS fmt
           FROM public.register_fields x
           WHERE x.register_key = p_key AND x.is_active AND jsonb_typeof(x.options) = 'object' AND x.options ->> 'format' IS NOT NULL AND out ? x.code LOOP
    IF f.fmt = 'single' THEN f.fmt := 'single_site'; END IF;
    IF public.rcol_present(out -> f.code) THEN
      msg := public.rcol_format_error(f.fmt, out -> f.code);
      IF msg IS NOT NULL THEN errs := errs || public.reg_err_item('/data/' || f.code, 'invalid_format', msg); END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN out;
END $$;
ALTER FUNCTION reg_clean_data_base(text, jsonb) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION reg_clean_data_base(text, jsonb) FROM PUBLIC;

-- Computed columns: filled before every insert and every change of the data of a record. Records saved before the column existed get the value at their next save.
CREATE OR REPLACE FUNCTION reg_computed_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE f record; fm jsonb; a numeric; b numeric; res numeric;
BEGIN
  FOR f IN SELECT x.code, x.options -> 'formula' AS fm FROM public.register_fields x
           WHERE x.register_key = NEW.register_key AND x.is_active AND x.derived AND x.field_type = 'number' AND jsonb_typeof(x.options) = 'object' AND x.options ? 'formula' LOOP
    fm := f.fm; res := NULL;
    BEGIN
      IF fm ->> 'op' = 'days_between' THEN
        res := (NEW.data ->> (fm ->> 'b'))::date - (NEW.data ->> (fm ->> 'a'))::date;
      ELSE
        a := (NEW.data ->> (fm ->> 'a'))::numeric; b := (NEW.data ->> (fm ->> 'b'))::numeric;
        res := CASE fm ->> 'op' WHEN 'sum' THEN a + b WHEN 'diff' THEN a - b WHEN 'product' THEN a * b WHEN 'ratio' THEN CASE WHEN b = 0 THEN NULL ELSE round(a / b, 4) END END;
      END IF;
    EXCEPTION WHEN others THEN res := NULL;
    END;
    NEW.data := CASE WHEN res IS NULL THEN NEW.data - f.code ELSE jsonb_set(NEW.data, ARRAY[f.code], to_jsonb(res)) END;
  END LOOP;
  RETURN NEW;
END $$;
ALTER FUNCTION reg_computed_apply() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION reg_computed_apply() FROM PUBLIC;
CREATE TRIGGER register_records_computed BEFORE INSERT OR UPDATE OF data ON register_records FOR EACH ROW EXECUTE FUNCTION reg_computed_apply();

-- A template column carries the API type of a field, so an older file is judged by what a column means (a text turned into an e-mail is a type change).
ALTER FUNCTION tpl_columns(text) RENAME TO tpl_columns_core;
CREATE OR REPLACE FUNCTION tpl_columns(p_register text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(CASE WHEN t.e ->> 'kind' = 'field'
      THEN t.e || jsonb_build_object('data_type', (SELECT public.rcol_eff_type(f.field_type, f.options) FROM public.register_fields f WHERE f.register_key = p_register AND f.code = t.e ->> 'code'))
      ELSE t.e END ORDER BY t.o), '[]'::jsonb)
  FROM jsonb_array_elements(public.tpl_columns_core(p_register)) WITH ORDINALITY AS t(e, o)
$$;
ALTER FUNCTION tpl_columns_core(text) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION tpl_columns_core(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpl_columns_core(text) TO pmis_definer;
ALTER FUNCTION tpl_columns(text) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION tpl_columns(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpl_columns(text) TO pmis_definer, pmis_app;

CREATE OR REPLACE FUNCTION tpl_version_cols(p_kind text, p_columns jsonb) RETURNS TABLE (key text, header text, input boolean, sig jsonb)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  WITH c AS (
    SELECT NULL::text AS part, NULL::text AS sheet, x AS col FROM jsonb_array_elements(CASE WHEN p_kind = 'master' THEN '[]'::jsonb ELSE coalesce(p_columns, '[]'::jsonb) END) x
    UNION ALL
    SELECT pt ->> 'part', pt ->> 'sheet', x FROM jsonb_array_elements(CASE WHEN p_kind = 'master' THEN coalesce(p_columns, '[]'::jsonb) ELSE '[]'::jsonb END) pt
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(pt -> 'columns', '[]'::jsonb)) x
  )
  SELECT coalesce(c.part || '/', '') || (c.col ->> 'code'), c.col ->> 'header',
         (c.col ->> 'kind') IN ('site', 'record_type', 'field', 'custom', 'record_id', 'task') AND NOT coalesce((c.col ->> 'derived')::boolean, false),
         jsonb_strip_nulls(jsonb_build_object('header', c.col ->> 'header', 'type', c.col ->> 'type', 'kind', c.col ->> 'kind', 'required', coalesce((c.col ->> 'required')::boolean, false),
           'options', CASE WHEN c.col ->> 'type' = 'list' THEN c.col -> 'options' END, 'task', c.col ->> 'task', 'field', c.col ->> 'field', 'sheet', c.sheet,
           'candidates', c.col -> 'candidates', 'data_type', c.col ->> 'data_type'))
  FROM c
$$;

-- Owner decision 2026-11-14 (tolerant upload): a file of an older version of a REGISTER template is accepted when it can be matched by the column codes. A removed
-- column is ignored (with a warning), a new column stays empty, a rename, a change of the required flag or of the list values never matters; only a change of the
-- meaning of a column (its type) refuses the file. Stream and Master templates keep the D112 rule.
CREATE OR REPLACE FUNCTION tpl_version_compat(p_template text, p_version int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.template_definitions%ROWTYPE; o public.template_versions%ROWTYPE; c public.template_versions%ROWTYPE; inp jsonb; oth jsonb; removed jsonb; added jsonb; renamed jsonb;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  WITH a AS (SELECT * FROM public.tpl_version_cols(d.kind, o.columns)), b AS (SELECT * FROM public.tpl_version_cols(d.kind, c.columns)),
  ch AS (
    SELECT coalesce(a.key, b.key) AS key, coalesce(b.header, a.header) AS header, a.header AS old_header, b.header AS new_header,
      CASE WHEN a.key IS NULL THEN 'added' WHEN b.key IS NULL THEN 'removed'
           WHEN a.input AND NOT b.input THEN 'no_longer_typed' WHEN b.input AND NOT a.input THEN 'now_typed'
           WHEN a.sig ->> 'type' IS DISTINCT FROM b.sig ->> 'type' OR (a.sig ? 'data_type' AND b.sig ? 'data_type' AND a.sig ->> 'data_type' IS DISTINCT FROM b.sig ->> 'data_type') THEN 'type_changed'
           WHEN a.sig ->> 'header' IS DISTINCT FROM b.sig ->> 'header' THEN 'renamed' ELSE 'changed' END AS change,
      coalesce(a.input, false) OR coalesce(b.input, false) AS input
    FROM a FULL JOIN b ON b.key = a.key
    WHERE a.key IS NULL OR b.key IS NULL OR a.input IS DISTINCT FROM b.input OR a.sig IS DISTINCT FROM b.sig
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'header', ch.header, 'change', ch.change) ORDER BY ch.key)
                  FILTER (WHERE ch.input AND (d.kind <> 'register' OR ch.change = 'type_changed')), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'header', ch.header, 'change', ch.change) ORDER BY ch.key)
                  FILTER (WHERE NOT (ch.input AND (d.kind <> 'register' OR ch.change = 'type_changed'))), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'header', coalesce(ch.old_header, ch.header)) ORDER BY ch.key) FILTER (WHERE ch.input AND ch.change IN ('removed', 'no_longer_typed')), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'header', ch.header) ORDER BY ch.key) FILTER (WHERE ch.input AND ch.change IN ('added', 'now_typed')), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'from', ch.old_header, 'to', ch.new_header) ORDER BY ch.key) FILTER (WHERE ch.change = 'renamed'), '[]'::jsonb)
    INTO inp, oth, removed, added, renamed FROM ch;
  RETURN jsonb_build_object('template_id', p_template, 'kind', d.kind, 'from_version', p_version, 'to_version', c.version, 'is_current', o.is_current,
    'compatible', jsonb_array_length(inp) = 0, 'input_changes', inp, 'other_changes', oth,
    'removed_columns', CASE WHEN d.kind = 'register' THEN removed ELSE '[]'::jsonb END, 'added_columns', CASE WHEN d.kind = 'register' THEN added ELSE '[]'::jsonb END,
    'renamed_columns', renamed);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'rcol_present(jsonb)', 'rcol_err(text,text,text)', 'rcol_eff_type(text,jsonb)', 'rcol_storage(text,text,jsonb,jsonb)', 'rcol_format_error(text,jsonb)', 'rcol_check_formula(text,jsonb)', 'reg_clean_data(text,jsonb)', 'tpl_version_cols(text,jsonb)', 'tpl_version_compat(text,int)', 'rcol_json(register_fields)', 'reg_field_usage(text,text)', 'rcol_convert(jsonb,text,text)',
    'rcol_conversion(text,text,text,text,boolean)', 'rcol_lock(text,text)', 'rcol_need_register(text)', 'reg_fields_admin_json(text)', 'admin_reg_field_impact(text,text,jsonb)',
    'admin_reg_field_save(text,text,boolean,jsonb,text,integer,boolean)', 'admin_reg_field_delete(text,text,text,integer)', 'admin_reg_fields_order(text,text[],text)',
    'admin_reg_section_save(text,uuid,jsonb,text,integer)', 'admin_reg_section_delete(text,uuid,text)', 'admin_reg_definition_rename(text,jsonb,text,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'reg_fields_admin_json(text)', 'admin_reg_field_impact(text,text,jsonb)', 'admin_reg_field_save(text,text,boolean,jsonb,text,integer,boolean)', 'admin_reg_field_delete(text,text,text,integer)',
      'admin_reg_fields_order(text,text[],text)', 'admin_reg_section_save(text,uuid,jsonb,text,integer)', 'admin_reg_section_delete(text,uuid,text)', 'admin_reg_definition_rename(text,jsonb,text,integer)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

SELECT tpl_sync_all();

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('register_columns_admin_applied', 'register', NULL,
        jsonb_build_object('decision', 'owner request 2026-11-13: manage register columns, sections and names', 'functions', 'admin_reg_*', 'protected_columns', (SELECT count(*) FROM register_fields WHERE is_system)),
        'Migration 0095: the admin adds, edits, deletes columns of a register, renames registers and sections.');
