-- 0741_personal_record_templates (contract 0.15.621): save a register record as a template, start a new one from a template or a previous record (improvement list item 8).
-- Mirror: apps/api/prisma/migrations/0741_personal_record_templates/migration.sql (kept byte-identical).
--
-- Additive and personal. A template is the field values the person chose to keep (plain values only: text, number, list, yes/no), under a name, for one register.
-- It is the person's own: nobody else sees it, and using it only fills the form; the normal create still checks every right, field rule and value. Hidden, never deleted.
--   1. user_record_templates: at most 30 active per person and register, names unique per person and register among the active ones; the values at most 20 KB.
--   2. record_tpl_list(register_key), record_tpl_save(...), record_tpl_archive(id).

CREATE TABLE user_record_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  register_key  text NOT NULL CHECK (register_key ~ '^[a-z][a-z0-9_-]{0,80}$'),
  name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  record_type   text CHECK (record_type IS NULL OR record_type ~ '^[a-z][a-z0-9_-]{0,80}$'),
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 20480),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_record_templates_name_uq ON user_record_templates (user_id, register_key, lower(btrim(name))) WHERE is_active;

ALTER TABLE user_record_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_record_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON user_record_templates FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON user_record_templates FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

CREATE OR REPLACE FUNCTION record_tpl_json(t public.user_record_templates) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', t.id, 'register_key', t.register_key, 'name', t.name, 'record_type', t.record_type, 'data', t.payload, 'created_at', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;

CREATE OR REPLACE FUNCTION record_tpl_list(p_register text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(public.record_tpl_json(t) ORDER BY lower(t.name)) FROM public.user_record_templates t WHERE t.user_id = a AND t.is_active AND t.register_key = p_register), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION record_tpl_save(p_register text, p_name text, p_type text, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); n text := btrim(coalesce(p_name, '')); t public.user_record_templates%ROWTYPE;
BEGIN
  IF p_register IS NULL OR p_register !~ '^[a-z][a-z0-9_-]{0,80}$' THEN PERFORM public.sv_fail('validation_failed', 'Give the register.'); END IF;
  IF n = '' OR char_length(n) > 60 THEN PERFORM public.sv_fail('validation_failed', 'A template name has 1 to 60 characters.'); END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' OR pg_column_size(p_data) > 20480 THEN PERFORM public.sv_fail('validation_failed', 'The values must be an object of at most 20 KB.'); END IF;
  IF (SELECT count(*) FROM public.user_record_templates x WHERE x.user_id = a AND x.is_active AND x.register_key = p_register) >= 30 THEN PERFORM public.sv_fail('validation_failed', 'At most 30 templates per register. Hide one you no longer use.'); END IF;
  IF EXISTS (SELECT 1 FROM public.user_record_templates x WHERE x.user_id = a AND x.is_active AND x.register_key = p_register AND lower(btrim(x.name)) = lower(n)) THEN PERFORM public.sv_fail('duplicate', 'You already have a template with this name.'); END IF;
  INSERT INTO public.user_record_templates (user_id, register_key, name, record_type, payload) VALUES (a, p_register, n, p_type, p_data) RETURNING * INTO t;
  RETURN public.record_tpl_json(t);
END $$;

CREATE OR REPLACE FUNCTION record_tpl_archive(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); t public.user_record_templates%ROWTYPE;
BEGIN
  UPDATE public.user_record_templates x SET is_active = false WHERE x.id = p_id AND x.user_id = a AND x.is_active RETURNING * INTO t;
  IF t.id IS NULL THEN PERFORM public.sv_fail('not_found', 'The template does not exist.'); END IF;
  RETURN public.record_tpl_json(t);
END $$;

-- Ownership and grants (0166 pattern)
DO $$
BEGIN
  ALTER TABLE user_record_templates OWNER TO pmis_definer;
  ALTER FUNCTION record_tpl_json(public.user_record_templates) OWNER TO pmis_definer;
  ALTER FUNCTION record_tpl_list(text) OWNER TO pmis_definer;
  ALTER FUNCTION record_tpl_save(text, text, text, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION record_tpl_archive(uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION record_tpl_json(public.user_record_templates), record_tpl_list(text), record_tpl_save(text, text, text, jsonb), record_tpl_archive(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION record_tpl_json(public.user_record_templates), record_tpl_list(text), record_tpl_save(text, text, text, jsonb), record_tpl_archive(uuid) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON user_record_templates TO pmis_app;
    GRANT EXECUTE ON FUNCTION record_tpl_list(text), record_tpl_save(text, text, text, jsonb), record_tpl_archive(uuid) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): personal data, KEPT with saved_views. Patch the accumulating function idempotently (0361 pattern).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''user_record_templates''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''user_record_templates''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.user_record_templates TO pmis_reset_owner;
