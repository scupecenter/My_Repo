-- Migration 0102: dropdown lists (F17). The list catalogue of migration 0057 gains value types, dependent lists, a default value,
-- a multi-select flag, a colour per value, a deactivation record and a hard delete that is allowed only when a value is unused.
--
--   1. list_catalogues: value_type (text, number, date, person, site, vendor), multi_select, parent_catalogue (a dependent list).
--      A value_type or a parent can change only while the list has no value (value_type_locked, parent_locked). A parent chain may not loop.
--   2. list_values: colour (#RRGGBB), parent_value_id (the value of the parent list it depends on), is_default (one per list, active),
--      deactivate_reason / deactivated_at / deactivated_by (set with every deactivation, cleared on reactivation).
--   3. Hard delete (admin_delete_list_value): refused while the value is the default, is the parent of a dependent value, or may be stored
--      in a record: a register list field holding the code, a child-list column of the list, or a task template field bound to the list
--      (this last one is checked at list level, the conservative choice). The trigger repeats the rule, so no other path can delete a used value.
--   4. admin_save_list_value checks a new value against its type (person: an employee ID of a user, site: a site code, vendor: the name of an
--      active external party, number, date) and against the parent list (parent_code).
--
-- Every change is audited with before and after values and a reason (calc_require_reason). The database checks System Admin or a delegate
-- of fields edit for all regions (calc_require_admin), as before.

ALTER TABLE list_catalogues
  ADD COLUMN value_type TEXT NOT NULL DEFAULT 'text' CHECK (value_type IN ('text', 'number', 'date', 'person', 'site', 'vendor')),
  ADD COLUMN multi_select BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN parent_catalogue TEXT REFERENCES list_catalogues (code) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT list_catalogues_parent_not_self CHECK (parent_catalogue IS NULL OR parent_catalogue <> code);

ALTER TABLE list_values
  ADD COLUMN colour TEXT CHECK (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$'),
  ADD COLUMN parent_value_id UUID REFERENCES list_values (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN deactivate_reason TEXT,
  ADD COLUMN deactivated_at TIMESTAMPTZ(6),
  ADD COLUMN deactivated_by UUID,
  ADD CONSTRAINT list_values_default_is_active CHECK (NOT is_default OR is_active);
CREATE UNIQUE INDEX list_values_one_default ON list_values (catalogue_code) WHERE is_default;
CREATE INDEX list_values_parent_idx ON list_values (parent_value_id) WHERE parent_value_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Usage of a value (used by the delete rule and by the trigger)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_value_in_use(p_catalogue text, p_code text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.list_values d WHERE d.parent_value_id = p_id)
  OR EXISTS (SELECT 1 FROM public.register_fields f JOIN public.register_records r ON r.register_key = f.register_key
             WHERE f.list_catalogue = p_catalogue
               AND (r.data -> f.code = to_jsonb(p_code) OR (jsonb_typeof(r.data -> f.code) = 'array' AND r.data -> f.code ? p_code)))
  OR EXISTS (SELECT 1 FROM public.register_fields f, jsonb_array_elements(CASE WHEN jsonb_typeof(f.options -> 'columns') = 'array' THEN f.options -> 'columns' ELSE '[]'::jsonb END) c
             WHERE c ->> 'list_catalogue' = p_catalogue)
  OR EXISTS (SELECT 1 FROM public.template_task_fields t WHERE t.list_catalogue = p_catalogue)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Guard: a value is never deleted while it is used or is the default; the other rules of migration 0057 stay
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_values_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_default OR public.list_value_in_use(OLD.catalogue_code, OLD.code, OLD.id) THEN
      RAISE EXCEPTION 'a list value in use or the default is deactivated, never deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.catalogue_code IS DISTINCT FROM OLD.catalogue_code THEN
    RAISE EXCEPTION 'the code and the list of a value never change (deactivate it and add a new one)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. JSON shapes
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_catalogue_json(c public.list_catalogues) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', c.code, 'name_en', c.name_en, 'name_ar', c.name_ar, 'description', c.description, 'critical', c.critical, 'status', c.status,
    'allow_other', c.allow_other, 'is_active', c.is_active, 'version', c.version, 'value_type', c.value_type, 'multi_select', c.multi_select,
    'parent_catalogue', c.parent_catalogue)
$$;

CREATE OR REPLACE FUNCTION list_value_json(v public.list_values) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', v.id, 'code', v.code, 'label_en', v.label_en, 'label_ar', v.label_ar, 'aliases', to_jsonb(v.aliases), 'groups', to_jsonb(v.groups),
    'sort_order', v.sort_order, 'is_active', v.is_active, 'version', v.version, 'colour', v.colour, 'is_default', v.is_default,
    'parent_value_id', v.parent_value_id, 'parent_code', (SELECT p.code FROM public.list_values p WHERE p.id = v.parent_value_id),
    'deactivate_reason', v.deactivate_reason, 'deactivated_at', v.deactivated_at)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Catalogue: value type, multi-select and parent (dependent list)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_save_list_catalogue(p_code text, p_create boolean, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.list_catalogues%ROWTYPE; old_c public.list_catalogues%ROWTYPE; k text; errs jsonb := '[]'::jsonb; actor uuid := public.app_actor();
  has_values boolean; anc_hit boolean;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('name_en', 'name_ar', 'description', 'critical', 'status', 'allow_other', 'is_active', 'value_type', 'multi_select', 'parent_catalogue') THEN
      errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.');
    END IF;
  END LOOP;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) NOT BETWEEN 2 AND 200 THEN
    errs := errs || public.reg_err_item('/name_en', 'invalid', 'A name of 2 to 200 characters.');
  END IF;
  IF p_patch ? 'status' AND coalesce(p_patch ->> 'status', '') NOT IN ('pending', 'confirmed') THEN
    errs := errs || public.reg_err_item('/status', 'invalid', 'pending or confirmed.');
  END IF;
  IF p_patch ? 'value_type' AND coalesce(p_patch ->> 'value_type', '') NOT IN ('text', 'number', 'date', 'person', 'site', 'vendor') THEN
    errs := errs || public.reg_err_item('/value_type', 'invalid', 'text, number, date, person, site or vendor.');
  END IF;
  FOREACH k IN ARRAY ARRAY['critical', 'allow_other', 'is_active', 'multi_select'] LOOP
    IF p_patch ? k AND jsonb_typeof(p_patch -> k) <> 'boolean' THEN errs := errs || public.reg_err_item('/' || k, 'invalid', 'true or false.'); END IF;
  END LOOP;
  IF p_patch ? 'parent_catalogue' AND jsonb_typeof(p_patch -> 'parent_catalogue') NOT IN ('string', 'null') THEN
    errs := errs || public.reg_err_item('/parent_catalogue', 'invalid', 'The code of a list, or null.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_create THEN
    IF p_code IS NULL OR p_code !~ '^[A-Z][A-Za-z0-9]{1,40}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/code', 'invalid', 'A code like TeamType: a capital letter, then letters and digits.')));
    END IF;
    IF NOT (p_patch ? 'name_en') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/name_en', 'required', 'The name is required.'))); END IF;
    IF EXISTS (SELECT 1 FROM public.list_catalogues x WHERE lower(x.code) = lower(p_code)) THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A list with this code exists already.'));
    END IF;
    IF coalesce((p_patch ->> 'critical')::boolean, false) AND coalesce((p_patch ->> 'allow_other')::boolean, false) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/allow_other', 'critical_closed', 'A critical list accepts only its own values.')));
    END IF;
    IF coalesce(p_patch ->> 'status', 'pending') = 'confirmed' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'no_values', 'Add the values before confirming the list.')));
    END IF;
    IF nullif(p_patch ->> 'parent_catalogue', '') IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.list_catalogues x WHERE x.code = p_patch ->> 'parent_catalogue' AND x.is_active) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_catalogue', 'unknown_list', 'The parent list does not exist or is inactive.')));
    END IF;
    INSERT INTO public.list_catalogues (code, name_en, name_ar, description, critical, status, allow_other, is_active, value_type, multi_select, parent_catalogue, updated_by)
    VALUES (p_code, btrim(p_patch ->> 'name_en'), nullif(btrim(p_patch ->> 'name_ar'), ''), nullif(btrim(p_patch ->> 'description'), ''),
            coalesce((p_patch ->> 'critical')::boolean, false), 'pending', coalesce((p_patch ->> 'allow_other')::boolean, false), coalesce((p_patch ->> 'is_active')::boolean, true),
            coalesce(p_patch ->> 'value_type', 'text'), coalesce((p_patch ->> 'multi_select')::boolean, false), nullif(p_patch ->> 'parent_catalogue', ''), actor)
    RETURNING * INTO c;
    PERFORM public.log_audit_write('list_catalogue_create', 'list_catalogue', c.code, NULL, public.list_catalogue_json(c), p_reason);
    RETURN jsonb_build_object('code', c.code, 'version', c.version);
  END IF;

  SELECT * INTO old_c FROM public.list_catalogues WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The list does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> old_c.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The list changed since you read it. Reload and try again.')); END IF;
  IF p_patch = '{}'::jsonb THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'required', 'Change at least one field.'))); END IF;
  has_values := EXISTS (SELECT 1 FROM public.list_values v WHERE v.catalogue_code = p_code);
  -- the type and the parent decide how the values are read: they change only while the list has no value
  IF p_patch ? 'value_type' AND p_patch ->> 'value_type' <> old_c.value_type AND has_values THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/value_type', 'value_type_locked', 'The type of a list with values cannot change: create a new list.')));
  END IF;
  IF p_patch ? 'parent_catalogue' AND nullif(p_patch ->> 'parent_catalogue', '') IS DISTINCT FROM old_c.parent_catalogue AND has_values THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_catalogue', 'parent_locked', 'The parent of a list with values cannot change.')));
  END IF;
  IF nullif(p_patch ->> 'parent_catalogue', '') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.list_catalogues x WHERE x.code = p_patch ->> 'parent_catalogue' AND x.is_active) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_catalogue', 'unknown_list', 'The parent list does not exist or is inactive.')));
    END IF;
    -- a parent chain that returns to this list would make a loop of values
    WITH RECURSIVE anc(code) AS (
      SELECT p_patch ->> 'parent_catalogue'
      UNION
      SELECT l.parent_catalogue FROM public.list_catalogues l JOIN anc ON l.code = anc.code WHERE l.parent_catalogue IS NOT NULL)
    SELECT EXISTS (SELECT 1 FROM anc WHERE anc.code = p_code) INTO anc_hit;
    IF anc_hit THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_catalogue', 'cycle', 'A list cannot depend on itself, directly or through another list.')));
    END IF;
  END IF;

  c := old_c;
  c.name_en := coalesce(btrim(p_patch ->> 'name_en'), c.name_en);
  IF p_patch ? 'name_ar' THEN c.name_ar := nullif(btrim(p_patch ->> 'name_ar'), ''); END IF;
  IF p_patch ? 'description' THEN c.description := nullif(btrim(p_patch ->> 'description'), ''); END IF;
  c.critical := coalesce((p_patch ->> 'critical')::boolean, c.critical);
  c.status := coalesce(p_patch ->> 'status', c.status);
  c.allow_other := coalesce((p_patch ->> 'allow_other')::boolean, c.allow_other);
  c.is_active := coalesce((p_patch ->> 'is_active')::boolean, c.is_active);
  c.value_type := coalesce(p_patch ->> 'value_type', c.value_type);
  c.multi_select := coalesce((p_patch ->> 'multi_select')::boolean, c.multi_select);
  IF p_patch ? 'parent_catalogue' THEN c.parent_catalogue := nullif(p_patch ->> 'parent_catalogue', ''); END IF;
  IF c.critical AND c.allow_other THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/allow_other', 'critical_closed', 'A critical list accepts only its own values.')));
  END IF;
  IF c.status = 'confirmed' AND NOT has_values THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'no_values', 'Add the values before confirming the list.')));
  END IF;
  -- a list that other lists depend on stays active
  IF NOT c.is_active AND old_c.is_active AND EXISTS (SELECT 1 FROM public.list_catalogues x WHERE x.parent_catalogue = p_code AND x.is_active) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'has_dependent_lists', 'Another list depends on this one: deactivate that list first.')));
  END IF;

  UPDATE public.list_catalogues SET name_en = c.name_en, name_ar = c.name_ar, description = c.description, critical = c.critical, status = c.status,
    allow_other = c.allow_other, is_active = c.is_active, value_type = c.value_type, multi_select = c.multi_select, parent_catalogue = c.parent_catalogue,
    version = version + 1, updated_at = now(), updated_by = actor
  WHERE code = p_code RETURNING * INTO c;
  PERFORM public.list_refresh_fields(c.code);
  PERFORM public.log_audit_write('list_catalogue_update', 'list_catalogue', c.code, public.list_catalogue_json(old_c), public.list_catalogue_json(c), p_reason);
  RETURN jsonb_build_object('code', c.code, 'version', c.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Value: colour, default, dependent value, type check on creation, deactivation rules
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_save_list_value(p_catalogue text, p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cat public.list_catalogues%ROWTYPE; v public.list_values%ROWTYPE; old_v public.list_values%ROWTYPE; k text; t text; errs jsonb := '[]'::jsonb; actor uuid := public.app_actor();
  tokens text[]; v_aliases text[]; v_groups text[]; v_parent uuid; ok_type boolean := true; day date;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO cat FROM public.list_catalogues WHERE code = p_catalogue FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The list does not exist.')); END IF;
  -- Q292: the values of TeamSpecialization come from the table of Settings, team specialization / scope match (team_specializations): never edited here
  IF cat.code = 'TeamSpecialization' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object(
      'detail', 'The team specializations are managed in Settings, Team specialization / scope match. This list mirrors that table, so its values cannot be edited here.',
      'errors', public.reg_err_item('/', 'managed_elsewhere', 'The team specializations are managed in Settings, Team specialization / scope match; this list mirrors that table and is never edited on its own.')));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('code', 'label_en', 'label_ar', 'aliases', 'groups', 'sort_order', 'is_active', 'colour', 'is_default', 'parent_code') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This key cannot be set.'); END IF;
  END LOOP;
  IF p_id IS NOT NULL AND p_patch ? 'code' THEN errs := errs || public.reg_err_item('/code', 'field_read_only', 'The code of a value never changes: deactivate it and add a new value.'); END IF;
  IF p_id IS NULL AND (p_patch ->> 'code' IS NULL OR char_length(p_patch ->> 'code') NOT BETWEEN 1 AND 80 OR p_patch ->> 'code' <> btrim(p_patch ->> 'code') OR p_patch ->> 'code' ~ '[[:cntrl:];]') THEN
    errs := errs || public.reg_err_item('/code', 'invalid', 'A code of 1 to 80 characters, without outer spaces or ";".');
  END IF;
  IF p_patch ? 'label_en' AND char_length(btrim(coalesce(p_patch ->> 'label_en', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || public.reg_err_item('/label_en', 'invalid', 'A label of 1 to 200 characters.'); END IF;
  IF p_patch ? 'aliases' AND (jsonb_typeof(p_patch -> 'aliases') <> 'array' OR jsonb_array_length(p_patch -> 'aliases') > 20
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'aliases') a WHERE jsonb_typeof(a) <> 'string' OR char_length(btrim(a #>> '{}')) NOT BETWEEN 1 AND 80)) THEN
    errs := errs || public.reg_err_item('/aliases', 'invalid', 'Up to 20 texts of 1 to 80 characters.');
  END IF;
  IF p_patch ? 'groups' AND (jsonb_typeof(p_patch -> 'groups') <> 'array' OR jsonb_array_length(p_patch -> 'groups') > 10
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'groups') a WHERE jsonb_typeof(a) <> 'string' OR (a #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_ -]{0,30}$')) THEN
    errs := errs || public.reg_err_item('/groups', 'invalid', 'Up to 10 group codes (letters, digits, space, - and _).');
  END IF;
  IF p_patch ? 'sort_order' AND (jsonb_typeof(p_patch -> 'sort_order') <> 'number' OR (p_patch ->> 'sort_order')::numeric NOT BETWEEN 0 AND 100000) THEN errs := errs || public.reg_err_item('/sort_order', 'invalid', 'A whole number from 0 to 100000.'); END IF;
  IF p_patch ? 'is_active' AND jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN errs := errs || public.reg_err_item('/is_active', 'invalid', 'true or false.'); END IF;
  IF p_patch ? 'is_default' AND jsonb_typeof(p_patch -> 'is_default') <> 'boolean' THEN errs := errs || public.reg_err_item('/is_default', 'invalid', 'true or false.'); END IF;
  IF p_patch ? 'colour' AND jsonb_typeof(p_patch -> 'colour') <> 'null' AND (jsonb_typeof(p_patch -> 'colour') <> 'string' OR (p_patch ->> 'colour') !~ '^#[0-9A-Fa-f]{6}$') THEN
    errs := errs || public.reg_err_item('/colour', 'invalid', 'A colour as #RRGGBB.');
  END IF;
  IF p_patch ? 'parent_code' AND cat.parent_catalogue IS NULL AND jsonb_typeof(p_patch -> 'parent_code') <> 'null' THEN
    errs := errs || public.reg_err_item('/parent_code', 'not_dependent', 'This list does not depend on another list.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  -- a dependent list: each value names a value of its parent list, and that value is active
  IF cat.parent_catalogue IS NOT NULL AND (p_id IS NULL OR p_patch ? 'parent_code') THEN
    IF nullif(p_patch ->> 'parent_code', '') IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_code', 'required', 'A dependent value needs a value of the parent list.')));
    END IF;
    SELECT x.id INTO v_parent FROM public.list_values x WHERE x.catalogue_code = cat.parent_catalogue AND x.code = p_patch ->> 'parent_code';
    IF v_parent IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_code', 'unknown_value', 'The value of the parent list does not exist.')));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.list_values x WHERE x.id = v_parent AND x.is_active) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parent_code', 'parent_inactive', 'The value of the parent list is deactivated.')));
    END IF;
  END IF;

  IF p_patch ? 'aliases' THEN SELECT coalesce(array_agg(DISTINCT btrim(a)), ARRAY[]::text[]) INTO v_aliases FROM jsonb_array_elements_text(p_patch -> 'aliases') a; END IF;
  IF p_patch ? 'groups' THEN SELECT coalesce(array_agg(DISTINCT a ORDER BY a), ARRAY[]::text[]) INTO v_groups FROM jsonb_array_elements_text(p_patch -> 'groups') a; END IF;

  IF p_id IS NULL THEN
    -- the value must fit the type of its list: a person, a site or a vendor is an entry of the registry
    IF cat.value_type = 'number' THEN ok_type := p_patch ->> 'code' ~ '^-?[0-9]+(\.[0-9]+)?$';
    ELSIF cat.value_type = 'date' THEN
      ok_type := p_patch ->> 'code' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
      IF ok_type THEN
        BEGIN day := (p_patch ->> 'code')::date; EXCEPTION WHEN others THEN ok_type := false; END;
      END IF;
    ELSIF cat.value_type = 'person' THEN ok_type := EXISTS (SELECT 1 FROM public.users u WHERE u.employee_id = p_patch ->> 'code' AND u.deleted_at IS NULL);
    ELSIF cat.value_type = 'site' THEN ok_type := EXISTS (SELECT 1 FROM public.sites s WHERE s.site_code = p_patch ->> 'code');
    ELSIF cat.value_type = 'vendor' THEN ok_type := EXISTS (SELECT 1 FROM public.external_parties e WHERE e.name = p_patch ->> 'code' AND e.is_active);
    END IF;
    IF NOT ok_type THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/code', 'wrong_type',
        'This value does not fit the type of the list (' || cat.value_type || '): ' ||
        CASE cat.value_type WHEN 'number' THEN 'a number' WHEN 'date' THEN 'a date as YYYY-MM-DD' WHEN 'person' THEN 'an employee ID of a user'
          WHEN 'site' THEN 'a site code' WHEN 'vendor' THEN 'the name of an active external party' ELSE 'text' END || '.')));
    END IF;
    INSERT INTO public.list_values (catalogue_code, code, label_en, label_ar, aliases, groups, sort_order, is_active, colour, parent_value_id, is_default, updated_by)
    VALUES (cat.code, p_patch ->> 'code', coalesce(btrim(p_patch ->> 'label_en'), p_patch ->> 'code'), nullif(btrim(p_patch ->> 'label_ar'), ''), coalesce(v_aliases, ARRAY[]::text[]),
            coalesce(v_groups, ARRAY[]::text[]), coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(x.sort_order), 0) + 10 FROM public.list_values x WHERE x.catalogue_code = cat.code)),
            coalesce((p_patch ->> 'is_active')::boolean, true), nullif(p_patch ->> 'colour', ''), v_parent, false, actor)
    ON CONFLICT (catalogue_code, code) DO NOTHING
    RETURNING * INTO v;
    IF v.id IS NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This list has a value with this code already.')); END IF;
    IF coalesce((p_patch ->> 'is_default')::boolean, false) THEN
      IF NOT v.is_active THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_default', 'inactive', 'A deactivated value cannot be the default.'))); END IF;
      UPDATE public.list_values SET is_default = false, version = version + 1 WHERE catalogue_code = cat.code AND is_default;
      UPDATE public.list_values SET is_default = true, version = version + 1 WHERE id = v.id RETURNING * INTO v;
    END IF;
  ELSE
    SELECT * INTO old_v FROM public.list_values WHERE id = p_id AND catalogue_code = cat.code FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The value does not exist in this list.')); END IF;
    IF p_version IS NOT NULL AND p_version <> old_v.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The value changed since you read it. Reload and try again.')); END IF;
    IF p_patch = '{}'::jsonb THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'required', 'Change at least one field.'))); END IF;
    -- a critical list never loses its last active value (that would block every approval of the registers that use it)
    IF cat.critical AND old_v.is_active AND (p_patch ->> 'is_active') = 'false'
       AND NOT EXISTS (SELECT 1 FROM public.list_values x WHERE x.catalogue_code = cat.code AND x.is_active AND x.id <> old_v.id) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'last_active_value', 'A critical list keeps at least one active value.')));
    END IF;
    -- deactivating: the default moves first, and a value that active dependent values use stays active
    IF old_v.is_active AND (p_patch ->> 'is_active') = 'false' THEN
      IF old_v.is_default THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'is_default', 'The default value cannot be deactivated: choose another default first.')));
      END IF;
      IF EXISTS (SELECT 1 FROM public.list_values d WHERE d.parent_value_id = old_v.id AND d.is_active) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'has_dependents', 'Values of a dependent list use this value: deactivate them first.')));
      END IF;
    END IF;
    IF (p_patch ->> 'is_default') = 'true' AND NOT coalesce((p_patch ->> 'is_active')::boolean, old_v.is_active) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_default', 'inactive', 'A deactivated value cannot be the default.')));
    END IF;
    IF (p_patch ->> 'is_default') = 'true' THEN
      UPDATE public.list_values SET is_default = false, version = version + 1 WHERE catalogue_code = cat.code AND is_default AND id <> old_v.id;
    END IF;
    UPDATE public.list_values SET
      label_en = coalesce(btrim(p_patch ->> 'label_en'), label_en),
      label_ar = CASE WHEN p_patch ? 'label_ar' THEN nullif(btrim(p_patch ->> 'label_ar'), '') ELSE label_ar END,
      aliases = coalesce(v_aliases, list_values.aliases),
      groups = coalesce(v_groups, list_values.groups),
      sort_order = coalesce((p_patch ->> 'sort_order')::int, sort_order),
      is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
      colour = CASE WHEN p_patch ? 'colour' THEN nullif(p_patch ->> 'colour', '') ELSE colour END,
      parent_value_id = CASE WHEN p_patch ? 'parent_code' THEN v_parent ELSE parent_value_id END,
      is_default = CASE WHEN p_patch ? 'is_default' THEN (p_patch ->> 'is_default')::boolean AND coalesce((p_patch ->> 'is_active')::boolean, is_active) ELSE is_default END,
      deactivate_reason = CASE WHEN (p_patch ->> 'is_active') = 'false' AND old_v.is_active THEN p_reason
                               WHEN (p_patch ->> 'is_active') = 'true' THEN NULL ELSE deactivate_reason END,
      deactivated_at = CASE WHEN (p_patch ->> 'is_active') = 'false' AND old_v.is_active THEN now()
                            WHEN (p_patch ->> 'is_active') = 'true' THEN NULL ELSE deactivated_at END,
      deactivated_by = CASE WHEN (p_patch ->> 'is_active') = 'false' AND old_v.is_active THEN actor
                            WHEN (p_patch ->> 'is_active') = 'true' THEN NULL ELSE deactivated_by END,
      version = version + 1, updated_at = now(), updated_by = actor
    WHERE id = p_id RETURNING * INTO v;
  END IF;

  -- a code, a label or an alias names one value only (ignoring case), so a typed text never means two values
  tokens := ARRAY[lower(v.code), lower(v.label_en)] || CASE WHEN v.label_ar IS NOT NULL THEN ARRAY[lower(v.label_ar)] ELSE ARRAY[]::text[] END
            || (SELECT coalesce(array_agg(lower(a)), ARRAY[]::text[]) FROM unnest(v.aliases) a);
  FOREACH t IN ARRAY tokens LOOP
    IF EXISTS (SELECT 1 FROM public.list_values x WHERE x.catalogue_code = cat.code AND x.id <> v.id
               AND (lower(x.code) = t OR lower(x.label_en) = t OR lower(coalesce(x.label_ar, '')) = t OR EXISTS (SELECT 1 FROM unnest(x.aliases) a WHERE lower(a) = t))) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(CASE WHEN p_patch ? 'aliases' THEN '/aliases' ELSE '/label_en' END, 'duplicate',
        'Another value of this list already uses "' || t || '" as its code, label or alias.')));
    END IF;
  END LOOP;

  PERFORM public.list_refresh_fields(cat.code);
  UPDATE public.list_catalogues SET version = version + 1, updated_at = now(), updated_by = actor WHERE code = cat.code;
  PERFORM public.log_audit_write(CASE WHEN p_id IS NULL THEN 'list_value_create' WHEN old_v.is_active AND NOT v.is_active THEN 'list_value_deactivate' ELSE 'list_value_update' END,
    'list_catalogue', cat.code || ':' || v.code, CASE WHEN p_id IS NULL THEN NULL ELSE public.list_value_json(old_v) END, public.list_value_json(v), p_reason);
  RETURN jsonb_build_object('id', v.id, 'version', v.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Hard delete: only a value that is not the default and is not used (the trigger repeats the rule)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_delete_list_value(p_catalogue text, p_id uuid, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cat public.list_catalogues%ROWTYPE; v public.list_values%ROWTYPE; actor uuid := public.app_actor();
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO cat FROM public.list_catalogues WHERE code = p_catalogue FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The list does not exist.')); END IF;
  IF cat.code = 'TeamSpecialization' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'managed_elsewhere', 'This list mirrors another table and is never edited on its own.')));
  END IF;
  SELECT * INTO v FROM public.list_values WHERE id = p_id AND catalogue_code = cat.code FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The value does not exist in this list.')); END IF;
  IF p_version IS NOT NULL AND p_version <> v.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The value changed since you read it. Reload and try again.')); END IF;
  IF v.is_default THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'is_default', 'The default value cannot be deleted: choose another default first.')));
  END IF;
  IF public.list_value_in_use(cat.code, v.code, v.id) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'in_use',
      'The value is used by records, dependent values or task fields: deactivate it instead.')));
  END IF;
  PERFORM public.log_audit_write('list_value_delete', 'list_catalogue', cat.code || ':' || v.code, public.list_value_json(v), NULL, p_reason);
  DELETE FROM public.list_values WHERE id = v.id;
  PERFORM public.list_refresh_fields(cat.code);
  UPDATE public.list_catalogues SET version = version + 1, updated_at = now(), updated_by = actor WHERE code = cat.code;
  RETURN jsonb_build_object('deleted', true, 'code', v.code);
END $$;
