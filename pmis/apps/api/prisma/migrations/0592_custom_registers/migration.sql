-- 0531_custom_registers: admin-defined custom registers without code (item 11).
-- Mirror: db/sql/530_custom_registers.sql (kept byte-identical).
--
-- A custom register is a row of register_definitions with is_custom = true, its fields in register_fields, and its records in register_records, run by the
-- generic reg_* functions of 0019 (the pattern of Dismantle, Lessons Learned and Invoices). No table and no endpoint per register, no typed projection,
-- no task source. Two approval levels like every register (the 0035 rule: approval_levels = 2).
--
--   1. register_definitions.is_custom, created_by, created_at (additive). The key of a custom register always starts with custom_ and a built-in key never does.
--   2. custom_register_key(name): the key is generated from the English name (letters only, because the register key rule of 0019 allows letters and underscores).
--   3. admin_register_create: creates the definition, disabled. The module key is the register key; no grant is seeded (a module starts with the System Admins
--      and the admin gives it out in Roles and Responsibilities: no permission widening).
--   4. admin_register_update: rename (en/ar) and hide or show. Hide, never delete. Showing again is checked against the limit.
--   5. admin_register_enable: checks the register has columns and a required column, adds the side-menu catalogue key, the upload/download template
--      (match keys: the site code and the first required column, or that column alone when the register has no site) and issues the template.
--      The columns are added with the existing column door admin_reg_field_save (0095) before enabling.
--   6. The limit registers.custom_max (Settings > Security > Limits): ops_limits_catalogue() is an accumulating function, so it is patched in place,
--      anchored on the first key of its list, and idempotent.
--   7. The Settings data reset: custom registers are one resettable part, custom_registers (data_reset_parts() and data_reset_register_part() are patched in
--      place, idempotently), so the coverage check never stops a reset because of a custom register.
--
-- All doors are SECURITY DEFINER, owned by pmis_definer, executable by the API role only. The System Admin (or a delegate of fields.edit for all regions) is
-- checked inside; the API adds the step-up. Nothing existing is changed; built-in registers are never editable through these doors.

-- the tables below have forced row-level security; this runs as the migration role, which sees every region
SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The marker columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE register_definitions
  ADD COLUMN IF NOT EXISTS is_custom  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'register_definitions_custom_key_chk') THEN
    ALTER TABLE register_definitions ADD CONSTRAINT register_definitions_custom_key_chk
      CHECK ((is_custom AND register_key LIKE 'custom\_%') OR (NOT is_custom AND register_key NOT LIKE 'custom\_%'));
  END IF;
END $$;

GRANT INSERT, UPDATE ON register_definitions TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON template_definitions TO pmis_definer;
GRANT SELECT ON register_fields TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The generated key
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION custom_register_key(p_name text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE base text; k text; n int := 0;
BEGIN
  base := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z]+', '_', 'g'), '_');
  IF char_length(base) < 2 THEN base := 'register'; END IF;
  base := btrim(left('custom_' || base, 26), '_');
  k := base;
  WHILE EXISTS (SELECT 1 FROM public.register_definitions WHERE register_key = k) LOOP
    n := n + 1;
    IF n > 676 THEN PERFORM public.rcol_err('/name_en', 'invalid', 'Too many registers have a name like this one. Choose another name.'); END IF;
    k := base || '_' || chr(97 + ((n - 1) / 26) % 26) || chr(97 + (n - 1) % 26);
  END LOOP;
  RETURN k;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Create (disabled)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_register_create(p_name_en text, p_name_ar text, p_site_scoped boolean, p_multiple_per_site boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; d public.register_definitions%ROWTYPE; lim integer; cnt integer;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF char_length(btrim(coalesce(p_name_en, ''))) NOT BETWEEN 2 AND 80 THEN PERFORM public.rcol_err('/name_en', 'invalid', 'A name of 2 to 80 characters in English is required.'); END IF;
  IF p_name_ar IS NOT NULL AND char_length(btrim(p_name_ar)) > 80 THEN PERFORM public.rcol_err('/name_ar', 'invalid', 'Up to 80 characters.'); END IF;
  IF p_site_scoped IS NULL THEN PERFORM public.rcol_err('/site_scoped', 'required', 'Say whether each record belongs to a site.'); END IF;
  IF p_multiple_per_site IS NULL THEN PERFORM public.rcol_err('/multiple_per_site', 'required', 'Say whether a site may have several records.'); END IF;
  IF NOT p_site_scoped AND NOT p_multiple_per_site THEN
    PERFORM public.rcol_err('/multiple_per_site', 'invalid', 'A register without a site always allows several records.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_definitions x WHERE lower(btrim(x.name_en)) = lower(btrim(p_name_en))) THEN
    PERFORM public.rcol_err('/name_en', 'duplicate', 'A register with this name exists already.');
  END IF;
  IF nullif(btrim(coalesce(p_name_ar, '')), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.register_definitions x WHERE x.name_ar IS NOT NULL AND btrim(x.name_ar) = btrim(p_name_ar)) THEN
    PERFORM public.rcol_err('/name_ar', 'duplicate', 'A register with this Arabic name exists already.');
  END IF;
  lim := public.ops_limit('registers.custom_max');
  SELECT count(*) INTO cnt FROM public.register_definitions WHERE is_custom AND is_active;
  IF cnt >= lim THEN
    PERFORM public.rcol_err('/', 'limit_reached', format('The limit of %s custom registers is reached (Settings > Security > Limits). Hide one or raise the limit.', lim));
  END IF;
  k := public.custom_register_key(p_name_en);
  INSERT INTO public.register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules,
                                           enabled, sort_order, is_active, is_custom, created_by, created_at)
  VALUES (k, btrim(p_name_en), nullif(btrim(coalesce(p_name_ar, '')), ''), k, 'register', p_site_scoped, p_multiple_per_site, ARRAY[]::text[], 2, '{}'::jsonb,
          false, (SELECT greatest(1000, coalesce(max(x.sort_order), 0) + 10) FROM public.register_definitions x), true, true, public.app_actor(), clock_timestamp())
  RETURNING * INTO d;
  PERFORM public.log_audit_write('register_create', 'register', k, NULL,
    jsonb_build_object('register_key', k, 'name_en', d.name_en, 'name_ar', d.name_ar, 'site_scoped', d.site_scoped, 'multiple_per_site', d.multiple_per_site, 'enabled', false),
    btrim(p_reason));
  RETURN jsonb_build_object('register_key', k, 'module_key', d.module_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'site_scoped', d.site_scoped,
                            'multiple_per_site', d.multiple_per_site, 'enabled', false, 'is_active', true, 'version', d.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Rename, hide, show
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_register_update(p_key text, p_patch jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.register_definitions%ROWTYPE; before jsonb; k text; lim integer; cnt integer;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key FOR UPDATE;
  IF NOT FOUND OR NOT d.is_custom THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This is not a custom register.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The register changed since you read it. Reload and try again.'));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN PERFORM public.rcol_err('/', 'required', 'Change at least one field.'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('name_en', 'name_ar', 'is_active') THEN PERFORM public.rcol_err('/' || k, 'unknown_field', 'This key cannot be set.'); END IF;
  END LOOP;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) NOT BETWEEN 2 AND 80 THEN
    PERFORM public.rcol_err('/name_en', 'invalid', 'A name of 2 to 80 characters in English is required.');
  END IF;
  IF p_patch ? 'name_ar' AND p_patch ->> 'name_ar' IS NOT NULL AND char_length(btrim(p_patch ->> 'name_ar')) > 80 THEN PERFORM public.rcol_err('/name_ar', 'invalid', 'Up to 80 characters.'); END IF;
  IF p_patch ? 'is_active' AND jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN PERFORM public.rcol_err('/is_active', 'invalid', 'true or false.'); END IF;
  IF p_patch ? 'name_en' AND EXISTS (SELECT 1 FROM public.register_definitions x WHERE x.register_key <> p_key AND lower(btrim(x.name_en)) = lower(btrim(p_patch ->> 'name_en'))) THEN
    PERFORM public.rcol_err('/name_en', 'duplicate', 'A register with this name exists already.');
  END IF;
  IF p_patch ? 'name_ar' AND nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.register_definitions x WHERE x.register_key <> p_key AND x.name_ar IS NOT NULL AND btrim(x.name_ar) = btrim(p_patch ->> 'name_ar')) THEN
    PERFORM public.rcol_err('/name_ar', 'duplicate', 'A register with this Arabic name exists already.');
  END IF;
  IF (p_patch ->> 'is_active')::boolean IS TRUE AND NOT d.is_active THEN
    lim := public.ops_limit('registers.custom_max');
    SELECT count(*) INTO cnt FROM public.register_definitions WHERE is_custom AND is_active;
    IF cnt >= lim THEN PERFORM public.rcol_err('/is_active', 'limit_reached', format('The limit of %s custom registers is reached (Settings > Security > Limits).', lim)); END IF;
  END IF;
  before := jsonb_build_object('name_en', d.name_en, 'name_ar', d.name_ar, 'is_active', d.is_active);
  UPDATE public.register_definitions SET
    name_en = CASE WHEN p_patch ? 'name_en' THEN btrim(p_patch ->> 'name_en') ELSE name_en END,
    name_ar = CASE WHEN p_patch ? 'name_ar' THEN nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') ELSE name_ar END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::boolean ELSE is_active END,
    version = version + 1
  WHERE register_key = p_key RETURNING * INTO d;
  UPDATE public.template_definitions SET name = d.name_en, name_ar = d.name_ar WHERE register_key = p_key AND kind = 'register';
  PERFORM public.log_audit_write('register_update', 'register', p_key, before, jsonb_build_object('name_en', d.name_en, 'name_ar', d.name_ar, 'is_active', d.is_active), btrim(p_reason));
  RETURN jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'enabled', d.enabled, 'is_active', d.is_active, 'version', d.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Enable (menu key, template)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_register_enable(p_key text, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.register_definitions%ROWTYPE; mk text; keys jsonb; nfields integer;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key FOR UPDATE;
  IF NOT FOUND OR NOT d.is_custom THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This is not a custom register.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The register changed since you read it. Reload and try again.'));
  END IF;
  IF NOT d.is_active THEN PERFORM public.rcol_err('/', 'hidden', 'Show the register first.'); END IF;
  IF d.enabled THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This register is enabled already.')); END IF;
  SELECT count(*) INTO nfields FROM public.register_fields f WHERE f.register_key = p_key AND f.is_active AND NOT f.derived;
  IF nfields = 0 THEN PERFORM public.rcol_err('/fields', 'required', 'Add at least one column before enabling the register.'); END IF;
  SELECT f.code INTO mk FROM public.register_fields f
   WHERE f.register_key = p_key AND f.is_active AND NOT f.derived AND f.required AND f.in_template
   ORDER BY f.sort_order, f.code LIMIT 1;
  IF mk IS NULL THEN PERFORM public.rcol_err('/fields', 'required', 'Add at least one required column that is in the template: it identifies a record when a file is uploaded.'); END IF;
  keys := CASE WHEN d.site_scoped THEN jsonb_build_array(jsonb_build_array('site_code', mk)) ELSE jsonb_build_array(jsonb_build_array(mk)) END;
  UPDATE public.register_definitions SET enabled = true, version = version + 1 WHERE register_key = p_key RETURNING * INTO d;
  INSERT INTO public.template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
  VALUES ('TPL-' || upper(replace(p_key, '_', '-')), d.name_en, d.name_ar, p_key, 'register', p_key, d.module_key, NULL, keys, d.sort_order)
  ON CONFLICT (template_id) DO NOTHING;
  PERFORM public.tpl_sync_all();
  PERFORM public.log_audit_write('register_enable', 'register', p_key, jsonb_build_object('enabled', false), jsonb_build_object('enabled', true, 'match_keys', keys), btrim(p_reason));
  RETURN jsonb_build_object('register_key', d.register_key, 'enabled', true, 'is_active', d.is_active, 'version', d.version, 'template_id', 'TPL-' || upper(replace(p_key, '_', '-')), 'match_keys', keys);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The limit (patched in place, anchored on the first key of the list)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  anchor text := 'jsonb_build_object(''key'', ''session.idle_hours''';
  entry text := E'jsonb_build_object(''key'', ''registers.custom_max'', ''group'', ''registers'', ''unit'', ''registers'', ''default'', 20, ''min'', 1, ''max'', 100),\n    ';
BEGIN
  d := pg_get_functiondef('public.ops_limits_catalogue()'::regprocedure);
  IF position('registers.custom_max' IN d) > 0 THEN RETURN; END IF;
  IF position(anchor IN d) = 0 THEN RAISE EXCEPTION 'ops_limits_catalogue(): the first key of the limit list was not found'; END IF;
  EXECUTE replace(d, anchor, entry || anchor);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The Settings data reset: every custom register is one part
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  marker text := '    (''incidents'',          ''registers'', ''project'', 280, ''Incidents & Security'', ''الحوادث والأمن'', ''{sites}''::text[]),';
  add text := E'\n    (''custom_registers'',   ''registers'', ''project'', 290, ''Custom registers'', ''السجلات المخصصة'', ''{sites}''::text[]),';
BEGIN
  d := pg_get_functiondef('public.data_reset_parts()'::regprocedure);
  IF position('custom_registers' IN d) = 0 THEN
    IF position(marker IN d) = 0 THEN RAISE EXCEPTION 'data_reset_parts() has no incidents row to patch'; END IF;
    EXECUTE replace(d, marker, marker || add);
  END IF;
END $$;

DO $$
DECLARE d text; marker text := '    WHEN p_key = ''site_creation'' THEN ''sites''';
BEGIN
  d := pg_get_functiondef('public.data_reset_register_part(text)'::regprocedure);
  IF position('custom_registers' IN d) = 0 THEN
    IF position(marker IN d) = 0 THEN RAISE EXCEPTION 'data_reset_register_part() has no site_creation key to patch'; END IF;
    EXECUTE replace(d, marker, marker || E'\n    WHEN p_key LIKE ''custom\\_%'' THEN ''custom_registers''');
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['custom_register_key(text)', 'admin_register_create(text,text,boolean,boolean,text)', 'admin_register_update(text,jsonb,text,integer)',
                           'admin_register_enable(text,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_register_create(text, text, boolean, boolean, text), admin_register_update(text, jsonb, text, integer),
                              admin_register_enable(text, text, integer) TO pmis_app;
  END IF;
END $$;

-- The menu key of the one "Custom registers" entry (it opens the hub of the enabled custom registers). Additive; an existing key is kept.
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in) VALUES
  ('registers.custom', 'registers', 270, '0531')
ON CONFLICT (key) DO NOTHING;
