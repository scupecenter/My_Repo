-- 0667: offline field forms with a signature pad (Ahmed's approved suggestion list, item 1, 2026-11-28). Stacked on field mode (0411).
-- Mirror of this file: apps/api/prisma/migrations/0667_field_forms/migration.sql (kept byte-identical).
--
-- WHAT.
--   * Guarded setting `field.forms` = {forms: [...]}: up to 20 admin-defined form kinds {code, name_en, name_ar, enabled, signature, fields[]}; a field is
--     {key, label_en, label_ar, type text|longtext|number|yesno|choice, required, options[] (choice only)}. Changed only through admin_set_field_forms
--     (System Admin or an all-regions delegate of `settings` edit, reason, If-Match, audit).
--   * Table field_form_submissions: one row per filled form of a site (answers, the signature as a small PNG data URL, the signer, the device time).
--     client_id is the id of the queued action on the device: unique, so a replay after a lost answer returns the first row (the durable idempotency).
--     A "door" table: the app role has no direct grant; it reads and writes only through field_form_submit() and field_forms_of_site(), which check the
--     region of the site (view right on `sites`) and that the form kind exists and is enabled. Nothing is ever updated or deleted by the app.
-- No permission or grant of a role changes. Configuration table rules: RLS on, KEEP in data_reset_plan(), pmis_reset_owner grant.

SELECT set_config('app.region_ids', '*', true);
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('field.forms', '{"forms": []}'::jsonb,
        'Field forms (0667): {forms: [{code, name_en, name_ar, enabled, signature, fields[]}]}. Changed only through admin_set_field_forms.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_field_forms ON settings;
DROP TRIGGER IF EXISTS b_settings_field_forms_update ON settings;
DROP TRIGGER IF EXISTS b_settings_field_forms_delete ON settings;
CREATE TRIGGER b_settings_field_forms BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'field.forms') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_field_forms_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'field.forms' OR NEW.key = 'field.forms') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_field_forms_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'field.forms') EXECUTE FUNCTION settings_guarded_keys();

CREATE TABLE IF NOT EXISTS field_form_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL UNIQUE,
  form_code     text NOT NULL CHECK (form_code ~ '^[a-z0-9_]{2,30}$'),
  site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  region_id     integer NOT NULL,
  answers       jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  signature     text CHECK (signature IS NULL OR (signature LIKE 'data:image/png;base64,%' AND char_length(signature) <= 300000)),
  signer_name   text CHECK (signer_name IS NULL OR char_length(btrim(signer_name)) BETWEEN 1 AND 120),
  captured_at   timestamptz(6) NOT NULL,
  submitted_by  uuid NOT NULL,
  submitted_at  timestamptz(6) NOT NULL DEFAULT now()
);
COMMENT ON TABLE field_form_submissions IS 'Field forms (contract 0.15.596): one filled form of a site, with the signature drawn on the device. Door table: written and read only by field_form_submit() and field_forms_of_site().';
CREATE INDEX IF NOT EXISTS field_form_submissions_site_idx ON field_form_submissions (site_id, submitted_at DESC);
ALTER TABLE field_form_submissions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'field_form_submissions' AND policyname = 'field_form_submissions_door') THEN
    CREATE POLICY field_form_submissions_door ON field_form_submissions FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
  END IF;
END $$;

-- The setting as stored; a damaged value reads as no forms.
CREATE OR REPLACE FUNCTION field_forms_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'field.forms';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' OR jsonb_typeof(v -> 'forms') <> 'array' THEN RETURN '{"forms": []}'::jsonb; END IF;
  RETURN jsonb_build_object('forms', v -> 'forms');
END $$;

CREATE OR REPLACE FUNCTION field_forms_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.field_forms_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'field.forms';
  RETURN c || jsonb_build_object(
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('field.forms'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_field_forms(p_body jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; f jsonb; fl jsonb; codes text[] := '{}'; keys text[]; n int := 0;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_body) x WHERE x <> 'forms')
     OR jsonb_typeof(p_body -> 'forms') <> 'array' OR jsonb_array_length(p_body -> 'forms') > 20 THEN
    PERFORM public.wfe_err1('/forms', 'invalid', 'Forms are a list of at most 20.');
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_body -> 'forms') LOOP
    IF jsonb_typeof(f) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(f) x WHERE x NOT IN ('code', 'name_en', 'name_ar', 'enabled', 'signature', 'fields'))
       OR jsonb_typeof(f -> 'code') <> 'string' OR (f ->> 'code') !~ '^[a-z0-9_]{2,30}$'
       OR jsonb_typeof(f -> 'name_en') <> 'string' OR char_length(btrim(f ->> 'name_en')) NOT BETWEEN 1 AND 80
       OR jsonb_typeof(f -> 'name_ar') <> 'string' OR char_length(btrim(f ->> 'name_ar')) > 80
       OR jsonb_typeof(f -> 'enabled') <> 'boolean' OR jsonb_typeof(f -> 'signature') <> 'boolean'
       OR jsonb_typeof(f -> 'fields') <> 'array' OR jsonb_array_length(f -> 'fields') > 30 THEN
      PERFORM public.wfe_err1('/forms', 'invalid', 'Each form is {code (2 to 30 of a-z, 0-9, _), name_en (1 to 80), name_ar (up to 80), enabled, signature, fields (at most 30)}.');
    END IF;
    IF (f ->> 'code') = ANY (codes) THEN PERFORM public.wfe_err1('/forms', 'invalid', 'A form code is used once.'); END IF;
    codes := codes || (f ->> 'code');
    keys := '{}';
    FOR fl IN SELECT value FROM jsonb_array_elements(f -> 'fields') LOOP
      IF jsonb_typeof(fl) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(fl) x WHERE x NOT IN ('key', 'label_en', 'label_ar', 'type', 'required', 'options'))
         OR jsonb_typeof(fl -> 'key') <> 'string' OR (fl ->> 'key') !~ '^[a-z0-9_]{2,30}$'
         OR jsonb_typeof(fl -> 'label_en') <> 'string' OR char_length(btrim(fl ->> 'label_en')) NOT BETWEEN 1 AND 80
         OR jsonb_typeof(fl -> 'label_ar') <> 'string' OR char_length(btrim(fl ->> 'label_ar')) > 80
         OR jsonb_typeof(fl -> 'type') <> 'string' OR (fl ->> 'type') NOT IN ('text', 'longtext', 'number', 'yesno', 'choice')
         OR jsonb_typeof(fl -> 'required') <> 'boolean'
         OR jsonb_typeof(fl -> 'options') <> 'array'
         OR ((fl ->> 'type') = 'choice' AND (jsonb_array_length(fl -> 'options') NOT BETWEEN 2 AND 20
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(fl -> 'options') o WHERE jsonb_typeof(o) <> 'string' OR char_length(btrim(o #>> '{}')) NOT BETWEEN 1 AND 60)))
         OR ((fl ->> 'type') <> 'choice' AND jsonb_array_length(fl -> 'options') <> 0) THEN
        PERFORM public.wfe_err1('/forms', 'invalid', 'Each field is {key, label_en (1 to 80), label_ar, type text|longtext|number|yesno|choice, required, options (2 to 20 texts for choice, else empty)}.');
      END IF;
      IF (fl ->> 'key') = ANY (keys) THEN PERFORM public.wfe_err1('/forms', 'invalid', 'A field key is used once in a form.'); END IF;
      keys := keys || (fl ->> 'key');
    END LOOP;
    n := n + 1;
  END LOOP;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('field.forms', '{"forms": []}'::jsonb, 'Field forms (0667). Changed only through admin_set_field_forms.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'field.forms' FOR UPDATE;
  cur := public.field_forms_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('field.forms') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur = jsonb_build_object('forms', p_body -> 'forms') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the field forms.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('forms', p_body -> 'forms'), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'field.forms';
  res := public.field_forms_state();
  PERFORM public.log_audit_write('field_forms_update', 'setting', 'field.forms', cur, public.field_forms_cfg(), btrim(p_reason));
  RETURN res;
END $$;

-- One filled form. The caller needs the view right on `sites` in the region of the site (the same right that lets them see the site in Field mode). The answers
-- are checked by the API against the form kind; here: the kind exists and is enabled, a signature is present when the kind asks for one. A replay of the same
-- client_id returns the first row (replayed = true) and never writes twice.
CREATE OR REPLACE FUNCTION field_form_submit(p_site uuid, p_client uuid, p_form text, p_answers jsonb, p_signature text, p_signer text, p_captured timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); regs int[]; reg int; frm jsonb; r public.field_form_submissions%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT s.region_id INTO reg FROM public.sites s WHERE s.id = p_site;
  IF reg IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND NOT (reg = ANY (regs)) THEN PERFORM public.wf_err('action_forbidden'); END IF;
  SELECT * INTO r FROM public.field_form_submissions WHERE client_id = p_client;
  IF FOUND THEN
    IF r.submitted_by <> a OR r.site_id <> p_site THEN PERFORM public.wf_err('action_forbidden'); END IF;
    RETURN jsonb_build_object('id', r.id, 'replayed', true, 'submitted_at', r.submitted_at);
  END IF;
  SELECT x INTO frm FROM jsonb_array_elements(public.field_forms_cfg() -> 'forms') x WHERE x ->> 'code' = p_form;
  IF frm IS NULL OR NOT (frm ->> 'enabled')::boolean THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/form_code', 'unknown_form', 'This form is not available.')));
  END IF;
  IF (frm ->> 'signature')::boolean AND (p_signature IS NULL OR coalesce(btrim(p_signer), '') = '') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/signature', 'required', 'This form needs the signer name and a signature.')));
  END IF;
  INSERT INTO public.field_form_submissions (client_id, form_code, site_id, region_id, answers, signature, signer_name, captured_at, submitted_by)
  VALUES (p_client, p_form, p_site, reg, p_answers, p_signature, nullif(btrim(p_signer), ''), p_captured, a)
  RETURNING * INTO r;
  PERFORM public.log_audit_write('field_form_submitted', 'field_form', r.id::text, NULL, jsonb_build_object('form', p_form, 'signed', p_signature IS NOT NULL), 'field form', p_site, reg);
  RETURN jsonb_build_object('id', r.id, 'replayed', false, 'submitted_at', r.submitted_at);
END $$;

-- The filled forms of a site (newest first, at most 100) without the signature image; field_form_signature() reads one image.
CREATE OR REPLACE FUNCTION field_forms_of_site(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE regs int[]; reg int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT s.region_id INTO reg FROM public.sites s WHERE s.id = p_site;
  IF reg IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND NOT (reg = ANY (regs)) THEN PERFORM public.wf_err('action_forbidden'); END IF;
  RETURN coalesce((SELECT jsonb_agg(j ORDER BY ts DESC) FROM (
    SELECT f.submitted_at AS ts, jsonb_build_object('id', f.id, 'form_code', f.form_code, 'answers', f.answers, 'signed', f.signature IS NOT NULL,
             'signer_name', f.signer_name, 'captured_at', f.captured_at, 'submitted_at', f.submitted_at,
             'submitted_by', public.wfe_user_ref(f.submitted_by)) AS j
      FROM public.field_form_submissions f WHERE f.site_id = p_site ORDER BY f.submitted_at DESC LIMIT 100) z), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION field_form_signature(p_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE regs int[]; f public.field_form_submissions%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO f FROM public.field_form_submissions WHERE id = p_id;
  IF NOT FOUND OR f.signature IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND NOT (f.region_id = ANY (regs)) THEN PERFORM public.wf_err('not_found'); END IF;
  RETURN f.signature;
END $$;

-- data reset: configuration (KEEP), patched in place (0361 pattern)
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''field_form_submissions''' IN def) = 0 THEN
    IF position('''phase_gate_rules''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    EXECUTE replace(def, '''phase_gate_rules''', '''phase_gate_rules'', ''field_form_submissions''');
  END IF;
END $$;

ALTER TABLE public.field_form_submissions OWNER TO pmis_definer;
REVOKE ALL ON public.field_form_submissions FROM PUBLIC;
GRANT SELECT, INSERT ON public.field_form_submissions TO pmis_definer;
GRANT SELECT ON public.sites TO pmis_definer;
GRANT SELECT, UPDATE ON public.field_form_submissions TO pmis_reset_owner;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['field_forms_cfg()', 'field_forms_state()', 'admin_set_field_forms(jsonb,text,integer)',
                           'field_form_submit(uuid,uuid,text,jsonb,text,text,timestamptz)', 'field_forms_of_site(uuid)', 'field_form_signature(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION field_forms_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_field_forms(jsonb, text, integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION field_form_submit(uuid, uuid, text, jsonb, text, text, timestamptz) TO pmis_app;
    GRANT EXECUTE ON FUNCTION field_forms_of_site(uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION field_form_signature(uuid) TO pmis_app;
    REVOKE ALL ON FUNCTION field_forms_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('field_forms_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'field.forms', 'table', 'field_form_submissions', 'doors', jsonb_build_array('field_form_submit', 'field_forms_of_site', 'field_form_signature', 'admin_set_field_forms')),
        'Offline field forms with a signature pad (migration 0667).');
