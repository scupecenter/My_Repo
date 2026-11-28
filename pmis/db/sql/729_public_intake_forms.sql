-- 0730_public_intake_forms (contract 0.15.600): a shareable public intake form that outsiders fill without an account. It creates a record of a
-- triage-enabled register (Issue Log, Change Control Log) that lands in the existing triage queue (0340); nothing else about the register changes.
-- Mirror: db/sql/729_public_intake_forms.sql (kept byte-identical).
--
-- Additive: two tables, eight functions. No existing table, column or function is changed.
--   * A form belongs to one register, one site and one owner (an entry holder of that register's Matrix row). The record is created AS THE OWNER, through
--     the register's own create function, so every register rule, the owner's live rights, the audit and the triage default apply unchanged.
--   * The link is a random token (32 bytes). Only its SHA-256 is stored; the token is shown once, when the form is created or the link is replaced.
--   * Creating or replacing a link refuses while the admin lock block_public_sharing is on (assertSharingAllowed in the API). While it is on, every public
--     link answers like an unknown link.
--   * The public side reads only the shown fields of the form (label, type, list options), never the site, the owner or the register records.
--   * Limits: per form and hour (max_per_hour, default 20) and per sender and hour (the API stores a keyed hash of the address, never the address).
--   * intake_submissions keeps who sent what: the reporter name and contact (free text, optional) and the record created.

CREATE TABLE intake_forms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  register_key  text NOT NULL REFERENCES register_definitions (register_key) ON UPDATE CASCADE ON DELETE CASCADE,
  site_id       uuid NOT NULL REFERENCES sites (id) ON UPDATE CASCADE ON DELETE CASCADE,
  record_type   text,
  field_codes   text[] NOT NULL CHECK (cardinality(field_codes) BETWEEN 1 AND 20),
  fixed         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fixed) = 'object'),
  intro_en      text CHECK (intro_en IS NULL OR char_length(intro_en) <= 600),
  intro_ar      text CHECK (intro_ar IS NULL OR char_length(intro_ar) <= 600),
  thanks_en     text CHECK (thanks_en IS NULL OR char_length(thanks_en) <= 300),
  thanks_ar     text CHECK (thanks_ar IS NULL OR char_length(thanks_ar) <= 300),
  owner_id      uuid NOT NULL REFERENCES users (id) ON UPDATE CASCADE,
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint    text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  expires_at    timestamptz,
  max_per_hour  integer NOT NULL DEFAULT 20 CHECK (max_per_hour BETWEEN 1 AND 500),
  ask_contact   boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_by    uuid NOT NULL REFERENCES users (id) ON UPDATE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE intake_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id          uuid NOT NULL REFERENCES intake_forms (id) ON UPDATE CASCADE ON DELETE CASCADE,
  record_id        uuid REFERENCES register_records (id) ON UPDATE CASCADE ON DELETE SET NULL,
  sender_hash      text NOT NULL,
  reporter_name    text CHECK (reporter_name IS NULL OR char_length(reporter_name) <= 120),
  reporter_contact text CHECK (reporter_contact IS NULL OR char_length(reporter_contact) <= 160),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_submissions_form_idx ON intake_submissions (form_id, created_at DESC);
CREATE INDEX intake_submissions_sender_idx ON intake_submissions (form_id, sender_hash, created_at DESC);

ALTER TABLE intake_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_forms FORCE ROW LEVEL SECURITY;
ALTER TABLE intake_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_submissions FORCE ROW LEVEL SECURITY;
-- nobody reads the tables directly: the functions below are the only door (the token hash never leaves the database)
CREATE POLICY rls_seed_write ON intake_forms FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
CREATE POLICY rls_seed_write ON intake_submissions FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- the fields a public form may show: active, typed by the sender, one of text / number / date / list / yes_no
CREATE OR REPLACE FUNCTION intake_field_ok(p_key text, p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = p_key AND f.code = p_code AND f.is_active AND NOT f.derived
                 AND f.field_type IN ('text', 'number', 'date', 'list', 'yes_no'))
$$;

-- list the forms the caller manages (their own; a System Admin sees all) with the counters of the screen
CREATE OR REPLACE FUNCTION intake_forms_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); adm boolean;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  adm := coalesce(public.app_user_is_system_admin(a), false);
  RETURN jsonb_build_object('sharing_locked', public.security_lock_active('block_public_sharing'), 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'register_key', f.register_key, 'register_name_en', d.name_en, 'register_name_ar', d.name_ar,
      'site_id', f.site_id, 'site_code', s.site_code, 'record_type', f.record_type, 'field_codes', to_jsonb(f.field_codes), 'fixed', f.fixed,
      'intro_en', f.intro_en, 'intro_ar', f.intro_ar, 'thanks_en', f.thanks_en, 'thanks_ar', f.thanks_ar, 'owner_id', f.owner_id, 'owner_name', u.display_name,
      'token_hint', f.token_hint, 'is_active', f.is_active, 'expires_at', f.expires_at, 'max_per_hour', f.max_per_hour, 'ask_contact', f.ask_contact,
      'version', f.version, 'created_at', f.created_at, 'updated_at', f.updated_at,
      'submissions_total', (SELECT count(*) FROM public.intake_submissions x WHERE x.form_id = f.id),
      'submissions_24h', (SELECT count(*) FROM public.intake_submissions x WHERE x.form_id = f.id AND x.created_at > now() - interval '24 hours'),
      'last_submission_at', (SELECT max(x.created_at) FROM public.intake_submissions x WHERE x.form_id = f.id)) ORDER BY f.created_at DESC)
    FROM public.intake_forms f JOIN public.register_definitions d ON d.register_key = f.register_key JOIN public.sites s ON s.id = f.site_id
    JOIN public.users u ON u.id = f.owner_id WHERE adm OR f.owner_id = a OR f.created_by = a), '[]'::jsonb));
END $$;

-- the last submissions of one form (the manager's view: reporter, time, the record and its triage state)
CREATE OR REPLACE FUNCTION intake_submissions_json(p_form uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); f public.intake_forms%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO f FROM public.intake_forms WHERE id = p_form;
  IF f.id IS NULL OR NOT (f.owner_id = a OR f.created_by = a OR coalesce(public.app_user_is_system_admin(a), false)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The form does not exist or is not visible to you.'));
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'created_at', x.created_at, 'reporter_name', x.reporter_name, 'reporter_contact', x.reporter_contact,
    'record_id', x.record_id, 'triage_state', r.triage_state, 'state', r.state) ORDER BY x.created_at DESC)
    FROM (SELECT * FROM public.intake_submissions s2 WHERE s2.form_id = p_form ORDER BY s2.created_at DESC LIMIT 50) x
    LEFT JOIN public.register_records r ON r.id = x.record_id), '[]'::jsonb);
END $$;

-- create (p_id NULL) or edit a form. p_hash is the SHA-256 of a new token (create and "replace link"); the token itself is made by the API and never stored.
CREATE OR REPLACE FUNCTION intake_form_save(p_id uuid, p_version int, p jsonb, p_hash text, p_hint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a uuid := public.app_actor(); f public.intake_forms%ROWTYPE; d public.register_definitions%ROWTYPE; s public.sites%ROWTYPE; rid uuid; code text; k text;
  codes text[]; fixed jsonb; adm boolean; owner uuid; rkey text; sid uuid; rtype text;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  adm := coalesce(public.app_user_is_system_admin(a), false);
  IF p_id IS NOT NULL THEN
    SELECT * INTO f FROM public.intake_forms WHERE id = p_id FOR UPDATE;
    IF f.id IS NULL OR NOT (adm OR f.owner_id = a OR f.created_by = a) THEN
      PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The form does not exist or is not visible to you.'));
    END IF;
    IF p_version IS DISTINCT FROM f.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  END IF;
  rkey := coalesce(p ->> 'register_key', f.register_key); sid := coalesce((p ->> 'site_id')::uuid, f.site_id);
  rtype := CASE WHEN p ? 'record_type' THEN nullif(p ->> 'record_type', '') ELSE f.record_type END;
  IF p_id IS NOT NULL AND (rkey <> f.register_key OR sid <> f.site_id) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/register_key', 'immutable', 'The register and the site of a form cannot change: make a new form.')));
  END IF;
  SELECT * INTO d FROM public.register_definitions WHERE register_key = rkey AND is_active AND enabled AND triage_enabled;
  IF NOT FOUND THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/register_key', 'no_triage', 'Only a register with a triage queue takes records from a public form.')));
  END IF;
  IF rtype IS NOT NULL AND NOT (rtype = ANY (d.record_types)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a record type of this register.')));
  END IF;
  SELECT * INTO s FROM public.sites WHERE id = sid AND public.app_region_check(region_id);
  IF s.id IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
  owner := coalesce(f.owner_id, a);
  IF p_id IS NULL OR rkey IS NOT NULL THEN
    -- the owner (the person the records are created as) must be able to create here: the same checks as reg_save_record
    IF owner = a THEN PERFORM public.reg_require_grant(rkey, s.region_id, 'create'); END IF;
    IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(rkey, s.region_id) h WHERE h.user_id = owner)
            OR (public.app_user_is_system_admin(owner) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(rkey, s.region_id)))) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'The owner of the form is not an entry holder of the ' || d.name_en || ' row of the Matrix.'));
    END IF;
  END IF;
  codes := coalesce(ARRAY(SELECT jsonb_array_elements_text(p -> 'field_codes')), f.field_codes);
  IF codes IS NULL OR cardinality(codes) NOT BETWEEN 1 AND 20 OR cardinality(codes) <> (SELECT count(DISTINCT c) FROM unnest(codes) c) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/field_codes', 'invalid', 'Choose between 1 and 20 different fields.')));
  END IF;
  FOREACH code IN ARRAY codes LOOP
    IF NOT public.intake_field_ok(rkey, code) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/field_codes', 'unknown_field', 'The field ' || code || ' cannot be asked on a public form.')));
    END IF;
  END LOOP;
  fixed := coalesce(p -> 'fixed', f.fixed, '{}'::jsonb);
  IF jsonb_typeof(fixed) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/fixed', 'invalid', 'An object of field values.'))); END IF;
  FOR k IN SELECT jsonb_object_keys(fixed) LOOP
    IF k = ANY (codes) OR NOT public.intake_field_ok(rkey, k) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/fixed', 'unknown_field', 'The preset ' || k || ' is not a field a form can preset (or it is also asked).')));
    END IF;
  END LOOP;
  IF p_id IS NULL THEN
    IF p_hash IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/token', 'required', 'A link is needed.'))); END IF;
    INSERT INTO public.intake_forms (name, register_key, site_id, record_type, field_codes, fixed, intro_en, intro_ar, thanks_en, thanks_ar, owner_id, token_hash, token_hint,
      expires_at, max_per_hour, ask_contact, created_by)
    VALUES (btrim(p ->> 'name'), rkey, sid, rtype, codes, fixed, nullif(btrim(p ->> 'intro_en'), ''), nullif(btrim(p ->> 'intro_ar'), ''), nullif(btrim(p ->> 'thanks_en'), ''),
      nullif(btrim(p ->> 'thanks_ar'), ''), a, p_hash, p_hint, (p ->> 'expires_at')::timestamptz, coalesce((p ->> 'max_per_hour')::int, 20), coalesce((p ->> 'ask_contact')::boolean, true), a)
    RETURNING id INTO rid;
    PERFORM public.log_audit_write('intake_form_create', 'intake_form', rid::text, NULL, jsonb_build_object('name', btrim(p ->> 'name'), 'register_key', rkey, 'site_id', sid, 'fields', codes), NULL);
    RETURN rid;
  END IF;
  UPDATE public.intake_forms SET name = coalesce(btrim(p ->> 'name'), name), record_type = rtype, field_codes = codes, fixed = fixed,
    intro_en = CASE WHEN p ? 'intro_en' THEN nullif(btrim(p ->> 'intro_en'), '') ELSE intro_en END, intro_ar = CASE WHEN p ? 'intro_ar' THEN nullif(btrim(p ->> 'intro_ar'), '') ELSE intro_ar END,
    thanks_en = CASE WHEN p ? 'thanks_en' THEN nullif(btrim(p ->> 'thanks_en'), '') ELSE thanks_en END, thanks_ar = CASE WHEN p ? 'thanks_ar' THEN nullif(btrim(p ->> 'thanks_ar'), '') ELSE thanks_ar END,
    expires_at = CASE WHEN p ? 'expires_at' THEN (p ->> 'expires_at')::timestamptz ELSE expires_at END, max_per_hour = coalesce((p ->> 'max_per_hour')::int, max_per_hour),
    ask_contact = coalesce((p ->> 'ask_contact')::boolean, ask_contact), is_active = coalesce((p ->> 'is_active')::boolean, is_active),
    token_hash = coalesce(p_hash, token_hash), token_hint = CASE WHEN p_hash IS NULL THEN token_hint ELSE p_hint END, version = version + 1, updated_at = now()
  WHERE id = p_id;
  PERFORM public.log_audit_write(CASE WHEN p_hash IS NOT NULL THEN 'intake_form_link_replace' WHEN p ? 'is_active' THEN 'intake_form_switch' ELSE 'intake_form_update' END,
    'intake_form', p_id::text, jsonb_build_object('is_active', f.is_active), jsonb_build_object('is_active', coalesce((p ->> 'is_active')::boolean, f.is_active)), NULL);
  RETURN p_id;
END $$;

CREATE OR REPLACE FUNCTION intake_form_delete(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); f public.intake_forms%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO f FROM public.intake_forms WHERE id = p_id FOR UPDATE;
  IF f.id IS NULL OR NOT (f.owner_id = a OR f.created_by = a OR coalesce(public.app_user_is_system_admin(a), false)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The form does not exist or is not visible to you.'));
  END IF;
  IF f.is_active THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Switch the form off before deleting it.')); END IF;
  DELETE FROM public.intake_forms WHERE id = p_id;
  PERFORM public.log_audit_write('intake_form_delete', 'intake_form', p_id::text, jsonb_build_object('name', f.name), NULL, NULL);
END $$;

-- PUBLIC SIDE (no signed-in actor). One answer for every failure: NULL (the API says 404). The sharing lock, the switch, the expiry and the owner's account
-- are all checked here, on every call.
CREATE OR REPLACE FUNCTION intake_form_peek(p_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.intake_forms%ROWTYPE;
BEGIN
  IF public.app_actor() IS NOT NULL THEN RETURN NULL; END IF;
  IF public.security_lock_active('block_public_sharing') THEN RETURN NULL; END IF;
  SELECT * INTO f FROM public.intake_forms WHERE token_hash = p_hash AND is_active AND (expires_at IS NULL OR expires_at > now());
  IF f.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = f.owner_id AND u.status = 'active' AND u.deleted_at IS NULL) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', f.id, 'name', f.name, 'intro_en', f.intro_en, 'intro_ar', f.intro_ar, 'thanks_en', f.thanks_en, 'thanks_ar', f.thanks_ar,
    'ask_contact', f.ask_contact, 'owner_id', f.owner_id, 'register_key', f.register_key, 'site_id', f.site_id, 'record_type', f.record_type, 'fixed', f.fixed,
    'fields', coalesce((SELECT jsonb_agg(jsonb_build_object('code', g.code, 'label_en', g.label_en, 'label_ar', g.label_ar, 'type', g.field_type, 'required', g.required,
        'options', CASE WHEN jsonb_typeof(g.options) = 'array' THEN g.options END) ORDER BY array_position(f.field_codes, g.code))
      FROM public.register_fields g WHERE g.register_key = f.register_key AND g.code = ANY (f.field_codes) AND g.is_active), '[]'::jsonb));
END $$;

-- the hourly caps: answers the seconds to wait (0 = free). Counted from intake_submissions, so every API instance shares them.
CREATE OR REPLACE FUNCTION intake_quota_wait(p_form uuid, p_sender text) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.intake_forms%ROWTYPE; n int; oldest timestamptz;
BEGIN
  SELECT * INTO f FROM public.intake_forms WHERE id = p_form;
  IF f.id IS NULL THEN RETURN 0; END IF;
  SELECT count(*), min(created_at) INTO n, oldest FROM public.intake_submissions WHERE form_id = p_form AND created_at > now() - interval '1 hour';
  IF n >= f.max_per_hour THEN RETURN greatest(1, ceil(extract(epoch FROM (oldest + interval '1 hour' - now())))::int); END IF;
  SELECT count(*), min(created_at) INTO n, oldest FROM public.intake_submissions WHERE form_id = p_form AND sender_hash = p_sender AND created_at > now() - interval '1 hour';
  IF n >= greatest(3, f.max_per_hour / 5) THEN RETURN greatest(1, ceil(extract(epoch FROM (oldest + interval '1 hour' - now())))::int); END IF;
  RETURN 0;
END $$;

-- called by the API, in the owner's context, right after the record was created
CREATE OR REPLACE FUNCTION intake_submission_log(p_form uuid, p_record uuid, p_sender text, p_name text, p_contact text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.intake_submissions (form_id, record_id, sender_hash, reporter_name, reporter_contact)
  VALUES (p_form, p_record, p_sender, nullif(btrim(p_name), ''), nullif(btrim(p_contact), ''));
  PERFORM public.log_audit_write('intake_submission', 'intake_form', p_form::text, NULL, jsonb_build_object('record_id', p_record), NULL);
END $$;

-- Ownership and grants (0166 pattern)
DO $$
BEGIN
  ALTER TABLE intake_forms OWNER TO pmis_definer;
  ALTER TABLE intake_submissions OWNER TO pmis_definer;
  ALTER FUNCTION intake_field_ok(text, text) OWNER TO pmis_definer;
  ALTER FUNCTION intake_forms_json() OWNER TO pmis_definer;
  ALTER FUNCTION intake_submissions_json(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION intake_form_save(uuid, int, jsonb, text, text) OWNER TO pmis_definer;
  ALTER FUNCTION intake_form_delete(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION intake_form_peek(text) OWNER TO pmis_definer;
  ALTER FUNCTION intake_quota_wait(uuid, text) OWNER TO pmis_definer;
  ALTER FUNCTION intake_submission_log(uuid, uuid, text, text, text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION intake_field_ok(text, text), intake_forms_json(), intake_submissions_json(uuid), intake_form_save(uuid, int, jsonb, text, text), intake_form_delete(uuid),
    intake_form_peek(text), intake_quota_wait(uuid, text), intake_submission_log(uuid, uuid, text, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION intake_field_ok(text, text), intake_forms_json(), intake_submissions_json(uuid), intake_form_save(uuid, int, jsonb, text, text), intake_form_delete(uuid),
    intake_form_peek(text), intake_quota_wait(uuid, text), intake_submission_log(uuid, uuid, text, text, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION intake_forms_json(), intake_submissions_json(uuid), intake_form_save(uuid, int, jsonb, text, text), intake_form_delete(uuid),
      intake_form_peek(text), intake_quota_wait(uuid, text), intake_submission_log(uuid, uuid, text, text, text) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): the forms are configuration and the submissions their intake log: both are KEPT (with saved_views); a form goes with its site
-- (ON DELETE CASCADE) and a submission loses its record link when the record is reset. Patch data_reset_plan() in place, idempotently (0361 pattern).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''intake_forms''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''intake_forms'', ''intake_submissions''');
  END IF;
  EXECUTE def;
END $$;
GRANT SELECT, UPDATE, DELETE ON public.intake_forms TO pmis_reset_owner;
GRANT SELECT, UPDATE, DELETE ON public.intake_submissions TO pmis_reset_owner;
