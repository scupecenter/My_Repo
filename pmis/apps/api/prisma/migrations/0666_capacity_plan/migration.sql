-- 0666: resource capacity planning (crews and skills per region against the planned tasks; Ahmed's approved suggestion list, item 2, 2026-11-28).
-- Mirror of this file: apps/api/prisma/migrations/0666_capacity_plan/migration.sql (kept byte-identical).
--
-- WHAT. One guarded setting `capacity.plan` = {skills, crews, efforts, days_per_week, utilization_pct, horizon_weeks}:
--   skills   up to 30 of {code, name_en, name_ar}
--   crews    up to 200 of {id, region_id 1..7, name, size 1..200, skills: [skill codes]}
--   efforts  up to 500 of {task_code, skill, person_days > 0}: the effort one task of that definition needs, in one skill
--   days_per_week 1..7, utilization_pct 10..100 (the share of a crew's days that can go to planned tasks), horizon_weeks 1..26.
-- It changes only through admin_set_capacity_plan (System Admin or a delegate of `settings` edit for all regions, reason, If-Match, audit).
-- capacity_plan_state() is the signed-in read door. The weekly plan itself is computed by the API from open tasks and this setting: no table.
-- No table, no column, no permission or grant change beyond the two doors.

SELECT set_config('app.region_ids', '*', true);
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('capacity.plan',
        '{"skills": [], "crews": [], "efforts": [], "days_per_week": 5, "utilization_pct": 80, "horizon_weeks": 8}'::jsonb,
        'Resource capacity planning (0666): {skills, crews, efforts, days_per_week, utilization_pct, horizon_weeks}. Changed only through admin_set_capacity_plan.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_capacity_plan ON settings;
DROP TRIGGER IF EXISTS b_settings_capacity_plan_update ON settings;
DROP TRIGGER IF EXISTS b_settings_capacity_plan_delete ON settings;
CREATE TRIGGER b_settings_capacity_plan BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'capacity.plan') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_capacity_plan_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'capacity.plan' OR NEW.key = 'capacity.plan') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_capacity_plan_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'capacity.plan') EXECUTE FUNCTION settings_guarded_keys();

-- The setting as stored (only the door writes it); a damaged value reads as the default.
CREATE OR REPLACE FUNCTION capacity_plan_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; d jsonb := '{"skills": [], "crews": [], "efforts": [], "days_per_week": 5, "utilization_pct": 80, "horizon_weeks": 8}'::jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'capacity.plan';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN d; END IF;
  RETURN d || v;
END $$;

CREATE OR REPLACE FUNCTION capacity_plan_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.capacity_plan_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'capacity.plan';
  RETURN c || jsonb_build_object(
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('capacity.plan'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_capacity_plan(p_body jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; nxt jsonb; bad text; e jsonb; sk text[] := '{}'; ids text[] := '{}'; s text; n numeric;
        skills jsonb := '[]'::jsonb; crews jsonb := '[]'::jsonb; efforts jsonb := '[]'::jsonb; k text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wfe_err1('/', 'invalid', 'The capacity plan settings must be an object.');
  END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p_body) key
   WHERE key NOT IN ('skills', 'crews', 'efforts', 'days_per_week', 'utilization_pct', 'horizon_weeks');
  IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  IF jsonb_typeof(p_body -> 'days_per_week') <> 'number' OR (p_body ->> 'days_per_week')::numeric NOT BETWEEN 1 AND 7 OR (p_body ->> 'days_per_week')::numeric <> trunc((p_body ->> 'days_per_week')::numeric) THEN
    PERFORM public.wfe_err1('/days_per_week', 'invalid', 'Working days per week is a whole number from 1 to 7.');
  END IF;
  IF jsonb_typeof(p_body -> 'utilization_pct') <> 'number' OR (p_body ->> 'utilization_pct')::numeric NOT BETWEEN 10 AND 100 OR (p_body ->> 'utilization_pct')::numeric <> trunc((p_body ->> 'utilization_pct')::numeric) THEN
    PERFORM public.wfe_err1('/utilization_pct', 'invalid', 'The share of crew days that planned tasks may use is a whole percent from 10 to 100.');
  END IF;
  IF jsonb_typeof(p_body -> 'horizon_weeks') <> 'number' OR (p_body ->> 'horizon_weeks')::numeric NOT BETWEEN 1 AND 26 OR (p_body ->> 'horizon_weeks')::numeric <> trunc((p_body ->> 'horizon_weeks')::numeric) THEN
    PERFORM public.wfe_err1('/horizon_weeks', 'invalid', 'The planning horizon is a whole number of weeks from 1 to 26.');
  END IF;
  -- skills
  IF jsonb_typeof(p_body -> 'skills') <> 'array' OR jsonb_array_length(p_body -> 'skills') > 30 THEN
    PERFORM public.wfe_err1('/skills', 'invalid', 'Skills are a list of at most 30.');
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_body -> 'skills') LOOP
    IF jsonb_typeof(e) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) x WHERE x NOT IN ('code', 'name_en', 'name_ar'))
       OR jsonb_typeof(e -> 'code') <> 'string' OR (e ->> 'code') !~ '^[a-z0-9_]{2,30}$'
       OR jsonb_typeof(e -> 'name_en') <> 'string' OR char_length(btrim(e ->> 'name_en')) NOT BETWEEN 1 AND 60
       OR jsonb_typeof(e -> 'name_ar') <> 'string' OR char_length(btrim(e ->> 'name_ar')) > 60 THEN
      PERFORM public.wfe_err1('/skills', 'invalid', 'Each skill is {code (2 to 30 of a-z, 0-9, _), name_en (1 to 60), name_ar (up to 60)}.');
    END IF;
    IF (e ->> 'code') = ANY (sk) THEN PERFORM public.wfe_err1('/skills', 'invalid', 'A skill code is used once.'); END IF;
    sk := sk || (e ->> 'code');
    skills := skills || jsonb_build_array(jsonb_build_object('code', e ->> 'code', 'name_en', btrim(e ->> 'name_en'), 'name_ar', btrim(e ->> 'name_ar')));
  END LOOP;
  -- crews
  IF jsonb_typeof(p_body -> 'crews') <> 'array' OR jsonb_array_length(p_body -> 'crews') > 200 THEN
    PERFORM public.wfe_err1('/crews', 'invalid', 'Crews are a list of at most 200.');
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_body -> 'crews') LOOP
    IF jsonb_typeof(e) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) x WHERE x NOT IN ('id', 'region_id', 'name', 'size', 'skills'))
       OR jsonb_typeof(e -> 'id') <> 'string' OR char_length(btrim(e ->> 'id')) NOT BETWEEN 1 AND 40
       OR jsonb_typeof(e -> 'region_id') <> 'number' OR (e ->> 'region_id')::numeric NOT BETWEEN 1 AND 7 OR (e ->> 'region_id')::numeric <> trunc((e ->> 'region_id')::numeric)
       OR jsonb_typeof(e -> 'name') <> 'string' OR char_length(btrim(e ->> 'name')) NOT BETWEEN 1 AND 80
       OR jsonb_typeof(e -> 'size') <> 'number' OR (e ->> 'size')::numeric NOT BETWEEN 1 AND 200 OR (e ->> 'size')::numeric <> trunc((e ->> 'size')::numeric)
       OR jsonb_typeof(e -> 'skills') <> 'array' OR jsonb_array_length(e -> 'skills') > 30 THEN
      PERFORM public.wfe_err1('/crews', 'invalid', 'Each crew is {id, region_id 1 to 7, name (1 to 80), size (1 to 200 people), skills (codes of the skills list)}.');
    END IF;
    IF btrim(e ->> 'id') = ANY (ids) THEN PERFORM public.wfe_err1('/crews', 'invalid', 'A crew id is used once.'); END IF;
    ids := ids || btrim(e ->> 'id');
    FOR s IN SELECT jsonb_array_elements_text(e -> 'skills') LOOP
      IF NOT (s = ANY (sk)) THEN PERFORM public.wfe_err1('/crews', 'invalid', format('The crew skill %s is not in the skills list.', s)); END IF;
    END LOOP;
    crews := crews || jsonb_build_array(jsonb_build_object('id', btrim(e ->> 'id'), 'region_id', (e ->> 'region_id')::int, 'name', btrim(e ->> 'name'),
                                                          'size', (e ->> 'size')::int, 'skills', (SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x), '[]'::jsonb) FROM jsonb_array_elements_text(e -> 'skills') x)));
  END LOOP;
  -- efforts
  IF jsonb_typeof(p_body -> 'efforts') <> 'array' OR jsonb_array_length(p_body -> 'efforts') > 500 THEN
    PERFORM public.wfe_err1('/efforts', 'invalid', 'Efforts are a list of at most 500.');
  END IF;
  ids := '{}';
  FOR e IN SELECT value FROM jsonb_array_elements(p_body -> 'efforts') LOOP
    IF jsonb_typeof(e) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) x WHERE x NOT IN ('task_code', 'skill', 'person_days'))
       OR jsonb_typeof(e -> 'task_code') <> 'string' OR char_length(btrim(e ->> 'task_code')) NOT BETWEEN 1 AND 60
       OR jsonb_typeof(e -> 'skill') <> 'string' OR NOT ((e ->> 'skill') = ANY (sk))
       OR jsonb_typeof(e -> 'person_days') <> 'number' OR (e ->> 'person_days')::numeric <= 0 OR (e ->> 'person_days')::numeric > 365 THEN
      PERFORM public.wfe_err1('/efforts', 'invalid', 'Each effort is {task_code, skill (from the skills list), person_days above 0 and up to 365}.');
    END IF;
    k := btrim(e ->> 'task_code');
    IF k = ANY (ids) THEN PERFORM public.wfe_err1('/efforts', 'invalid', 'A task code has one effort.'); END IF;
    ids := ids || k;
    efforts := efforts || jsonb_build_array(jsonb_build_object('task_code', k, 'skill', e ->> 'skill', 'person_days', round((e ->> 'person_days')::numeric, 2)));
  END LOOP;
  nxt := jsonb_build_object('skills', skills, 'crews', crews, 'efforts', efforts, 'days_per_week', (p_body ->> 'days_per_week')::int,
                            'utilization_pct', (p_body ->> 'utilization_pct')::int, 'horizon_weeks', (p_body ->> 'horizon_weeks')::int);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('capacity.plan', '{"skills": [], "crews": [], "efforts": [], "days_per_week": 5, "utilization_pct": 80, "horizon_weeks": 8}'::jsonb,
          'Resource capacity planning (0666). Changed only through admin_set_capacity_plan.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'capacity.plan' FOR UPDATE;
  cur := public.capacity_plan_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('capacity.plan') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur = nxt THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the capacity plan settings.'));
  END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'capacity.plan';
  res := public.capacity_plan_state();
  PERFORM public.log_audit_write('capacity_plan_update', 'setting', 'capacity.plan', cur, public.capacity_plan_cfg(), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['capacity_plan_cfg()', 'capacity_plan_state()', 'admin_set_capacity_plan(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION capacity_plan_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_capacity_plan(jsonb, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION capacity_plan_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in) VALUES
  ('capacity', 'work', 267, '0666')
ON CONFLICT (key) DO NOTHING;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('capacity_plan_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'capacity.plan', 'read', 'capacity_plan_state', 'write', 'admin_set_capacity_plan', 'audit', jsonb_build_array('capacity_plan_update')),
        'Resource capacity planning: crews and skills per region against planned tasks (migration 0666).');
