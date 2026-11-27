-- 0280_ui_features: the interface features of the 2026-11-27 PM-platforms research (items 6 to 15) are configured in one guarded setting, ui.features,
-- Administration > Settings > Screens > Interface. Mirror: db/sql/279_ui_features.sql (kept byte-identical).
--
-- The value is {sections: {avatars, new_badge, ...}, version}. Each section is a closed object with its own field errors; a later migration adds a section by
-- replacing ui_features_validate() and ui_features_seed() (additive: a section missing from the stored value takes its seed). The setting is read by every
-- signed-in user (the screens need it to draw) and written only through admin_set_ui_features: System Admin or a delegate of admin.settings edit for all
-- regions, a reason, If-Match (the version), one audit row with before and after.
--
-- Sections of this migration:
--   avatars    {style: initials | gradient | geometric | none, shape: circle | rounded, palette: brand | varied, in_lists: boolean}
--   new_badge  {enabled: boolean, days: 1..90}   a "New" badge beside a feature that now sits next to the old way, for this many days after its release date
--
-- Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked; pmis_app executes the reader and
-- the door only. No table is added.

SELECT set_config('app.region_ids', '*', true);

CREATE OR REPLACE FUNCTION ui_features_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"avatars": {"style": "gradient", "shape": "circle", "palette": "varied", "in_lists": true},
           "new_badge": {"enabled": true, "days": 14}}'::jsonb
$$;

-- Checks one section object; appends field errors to errs. Sections are validated one by one so a later migration only adds a branch.
CREATE OR REPLACE FUNCTION ui_features_validate(p_sections jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; s jsonb; kk text; n integer;
BEGIN
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'object' THEN
    RETURN public.reg_err_item('/sections', 'required', 'An object of sections.') || '[]'::jsonb;
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_sections) LOOP
    IF k NOT IN ('avatars', 'new_badge') THEN errs := errs || public.reg_err_item('/sections/' || k, 'unknown_key', 'Unknown section.'); END IF;
  END LOOP;

  s := p_sections -> 'avatars';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/avatars', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('style', 'shape', 'palette', 'in_lists') THEN errs := errs || public.reg_err_item('/sections/avatars/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'style') IS DISTINCT FROM 'string' OR (s ->> 'style') NOT IN ('initials', 'gradient', 'geometric', 'none') THEN
        errs := errs || public.reg_err_item('/sections/avatars/style', 'invalid', 'initials, gradient, geometric or none.'); END IF;
      IF jsonb_typeof(s -> 'shape') IS DISTINCT FROM 'string' OR (s ->> 'shape') NOT IN ('circle', 'rounded') THEN
        errs := errs || public.reg_err_item('/sections/avatars/shape', 'invalid', 'circle or rounded.'); END IF;
      IF jsonb_typeof(s -> 'palette') IS DISTINCT FROM 'string' OR (s ->> 'palette') NOT IN ('brand', 'varied') THEN
        errs := errs || public.reg_err_item('/sections/avatars/palette', 'invalid', 'brand or varied.'); END IF;
      IF jsonb_typeof(s -> 'in_lists') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/avatars/in_lists', 'invalid', 'true or false.'); END IF;
    END IF;
  END IF;

  s := p_sections -> 'new_badge';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/new_badge', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('enabled', 'days') THEN errs := errs || public.reg_err_item('/sections/new_badge/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'enabled') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/new_badge/enabled', 'invalid', 'true or false.'); END IF;
      IF jsonb_typeof(s -> 'days') IS DISTINCT FROM 'number' OR (s ->> 'days') !~ '^[0-9]+$' THEN
        errs := errs || public.reg_err_item('/sections/new_badge/days', 'invalid', 'A whole number of days from 1 to 90.');
      ELSE
        n := (s ->> 'days')::integer;
        IF n < 1 OR n > 90 THEN errs := errs || public.reg_err_item('/sections/new_badge/days', 'out_of_range', 'From 1 to 90 days.'); END IF;
      END IF;
    END IF;
  END IF;
  RETURN errs;
END $$;

-- GET /settings/ui-features: {sections, version, updated_at?, updated_by?}; sections missing from the stored value take the seed.
CREATE OR REPLACE FUNCTION ui_features_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; d jsonb; k text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'ui features: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'ui.features';
  d := public.ui_features_seed();
  FOR k IN SELECT jsonb_object_keys(d) LOOP
    d := jsonb_set(d, ARRAY[k], (d -> k) || coalesce(s.value -> 'sections' -> k, '{}'::jsonb));
  END LOOP;
  RETURN jsonb_build_object('sections', d, 'version', coalesce((s.value ->> 'version')::integer, 0))
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- PUT /settings/ui-features. p_body = {sections: {...}} (closed; a partial set of sections is merged over the current value, each section complete); the reason apart.
CREATE OR REPLACE FUNCTION admin_set_ui_features(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; k text; merged jsonb; iv integer; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('ui.features', jsonb_build_object('sections', '{}'::jsonb, 'version', 0),
          'Interface features (avatars, new badge, inbox, menus, mobile; migration 0280).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'ui.features' FOR UPDATE;
  cur := public.ui_features_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with sections.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k <> 'sections' THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  errs := errs || public.ui_features_validate(p_body -> 'sections');
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  merged := (cur -> 'sections') || (p_body -> 'sections');

  SELECT coalesce((value ->> 'version')::integer, 0) INTO iv FROM public.settings WHERE key = 'ui.features';
  UPDATE public.settings SET value = jsonb_build_object('sections', merged, 'version', iv + 1), updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE key = 'ui.features';
  res := public.ui_features_json();
  PERFORM public.log_audit_write('ui_features_update', 'setting', 'ui.features', cur -> 'sections', res -> 'sections', btrim(p_reason));
  RETURN res;
END $$;

-- the key changes only through its audited door (as the other guarded settings); an UPDATE is guarded on the old and the new key
CREATE TRIGGER b_settings_uifeat_insert BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'ui.features') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_uifeat_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ui.features' OR NEW.key = 'ui.features') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_uifeat_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ui.features') EXECUTE FUNCTION settings_guarded_keys();

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_features_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'ui.features with admin_set_ui_features; read by every signed-in user'),
        'Interface features setting (migration 0280, contract 0.15.185).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_features_seed()', 'ui_features_validate(jsonb)', 'ui_features_json()', 'admin_set_ui_features(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['ui_features_json()', 'admin_set_ui_features(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
