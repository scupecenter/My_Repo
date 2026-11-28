-- 0745_company_contacts_documents (contract 0.15.625): contacts, documents and certificates with expiry, and the document types of a contractor company (Companies proposal K3).
-- Mirror: db/sql/744_company_contacts_documents.sql (kept byte-identical).
--
-- A "company" is a row of external_parties (the Contractors list). Everything here hangs on it by party_id and is additive: nothing existing is changed.
--   1. company_document_types: the one list of document types (commercial registration, tax, insurance, safety, trade licence, ISO, staff certificates), edited in
--      Settings > Registers > Contractors: label EN/AR, "required for" company types (seeded EMPTY, so nothing is required until the owner says so), the lead days of the
--      expiry alert, shown or hidden (never deleted). The version of the list is the sum of rev (ETag, If-Match).
--   2. company_contacts: several people per company (name, role, phone, email, one primary). Hidden with is_active, never deleted.
--   3. company_documents: one row per document of a company (type, number, issue and expiry date, notes, one stored file). A new copy of a certificate is a new row; the
--      older row stays as history (hide only). The file goes through the same store, scan and encryption as every document (StorageService).
--   4. company_compliance(party) / company_compliance_all(): expired, expiring (inside the lead days of its type) and missing required documents. It is the red chip of
--      the company, and the compliance input of the contractor ranking.
--   5. company_documents_daily_alerts(): the same alert as the safety certificate (contractors_daily_alerts, D145b): once per document and stage (due, expired), to the
--      contractor alert roles of Settings > Contractors (the System Admins when nobody holds them). Information only: nothing is blocked.
-- Audited: every save writes audit_log (company_contact_save, company_document_save, company_doc_types_update). The tables are in data_reset_plan() as KEEP (master data
-- with external_parties), and pmis_reset_owner gets its grants. No existing function, trigger or permission is replaced or widened.
SELECT set_config('app.region_ids', '*', true);

CREATE TABLE company_document_types (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  label_en    text NOT NULL CHECK (char_length(btrim(label_en)) BETWEEN 1 AND 80),
  label_ar    text CHECK (label_ar IS NULL OR char_length(btrim(label_ar)) BETWEEN 1 AND 80),
  required_for text[] NOT NULL DEFAULT ARRAY[]::text[],
  lead_days   integer NOT NULL DEFAULT 30 CHECK (lead_days BETWEEN 0 AND 365),
  has_expiry  boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100,
  rev         integer NOT NULL DEFAULT 1
);
INSERT INTO company_document_types (code, label_en, label_ar, lead_days, has_expiry, sort_order) VALUES
  ('commercial_registration', 'Commercial registration', 'السجل التجاري', 30, true, 10),
  ('tax',                     'Tax certificate',         'الشهادة الضريبية', 30, true, 20),
  ('insurance',               'Insurance',               'التأمين', 30, true, 30),
  ('safety',                  'Safety certificate',      'شهادة السلامة', 30, true, 40),
  ('trade_licence',           'Trade licence',           'الرخصة التجارية', 30, true, 50),
  ('iso',                     'ISO certificate',         'شهادة الأيزو', 60, true, 60),
  ('staff_certificate',       'Staff certificate',       'شهادة العاملين', 30, true, 70)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE company_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id    uuid NOT NULL REFERENCES external_parties (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  role        text CHECK (role IS NULL OR char_length(role) <= 120),
  phone       text CHECK (phone IS NULL OR char_length(phone) <= 40),
  email       text CHECK (email IS NULL OR (char_length(email) <= 200 AND email ~ '^[^@\s]+@[^@\s]+$')),
  is_primary  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  rev         integer NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_contacts_party_idx ON company_contacts (party_id);
CREATE UNIQUE INDEX company_contacts_one_primary ON company_contacts (party_id) WHERE is_primary AND is_active;

CREATE TABLE company_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id      uuid NOT NULL REFERENCES external_parties (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  type_code     text NOT NULL REFERENCES company_document_types (code) ON UPDATE CASCADE,
  title         text CHECK (title IS NULL OR char_length(title) <= 160),
  doc_number    text CHECK (doc_number IS NULL OR char_length(doc_number) <= 80),
  issued_on     date,
  expires_on    date,
  notes         text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  storage_key   text,
  original_name text,
  mime_type     text,
  size_bytes    bigint,
  sha256        text,
  is_active     boolean NOT NULL DEFAULT true,
  rev           integer NOT NULL DEFAULT 1,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX company_documents_party_idx ON company_documents (party_id, type_code);
CREATE INDEX company_documents_expiry_idx ON company_documents (expires_on) WHERE is_active AND expires_on IS NOT NULL;

ALTER TABLE company_document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_document_types FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON company_document_types FOR SELECT USING (app_actor() IS NOT NULL OR app_is_seeding());
CREATE POLICY rls_seed_write ON company_document_types FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE company_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON company_contacts FOR SELECT USING (app_actor() IS NOT NULL OR app_is_seeding());
CREATE POLICY rls_seed_write ON company_contacts FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE company_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON company_documents FOR SELECT USING (app_actor() IS NOT NULL OR app_is_seeding());
CREATE POLICY rls_seed_write ON company_documents FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Document types (Settings)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_doc_types_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'types', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'label_en', t.label_en, 'label_ar', t.label_ar, 'required_for', to_jsonb(t.required_for),
                'lead_days', t.lead_days, 'has_expiry', t.has_expiry, 'is_active', t.is_active) ORDER BY t.sort_order, t.code), '[]'::jsonb) FROM public.company_document_types t),
    'party_types', (SELECT coalesce(jsonb_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::jsonb) FROM pg_enum e JOIN pg_type y ON y.oid = e.enumtypid WHERE y.typname = 'ExternalPartyType'),
    'version', (SELECT coalesce(sum(t.rev), 0)::integer FROM public.company_document_types t),
    'can_edit', (public.app_actor_is_admin('admin.settings', 'edit') AND public.app_actor_region_filter('admin.settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_save_company_doc_types(p_types jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before jsonb; e jsonb; i int := 0; o public.company_document_types%ROWTYPE; seen text[] := ARRAY[]::text[]; rf text[]; x text; nxt integer; ld integer;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_types IS NULL OR jsonb_typeof(p_types) <> 'array' OR jsonb_array_length(p_types) > 60 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types', 'invalid', 'A list of at most 60 types.')));
  END IF;
  LOCK TABLE public.company_document_types IN SHARE ROW EXCLUSIVE MODE;
  before := public.company_doc_types_json();
  IF p_version IS NOT NULL AND p_version <> (before ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_types) LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' OR coalesce(e ->> 'code', '') !~ '^[a-z][a-z0-9_]{1,40}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types/' || i || '/code', 'invalid', 'A code of lower-case letters, digits and underscores.')));
    END IF;
    IF (e ->> 'code') = ANY (seen) THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types/' || i, 'duplicate', 'One entry per code.'))); END IF;
    seen := seen || (e ->> 'code');
    IF char_length(btrim(coalesce(e ->> 'label_en', ''))) NOT BETWEEN 1 AND 80 OR (e ? 'label_ar' AND jsonb_typeof(e -> 'label_ar') = 'string' AND char_length(btrim(e ->> 'label_ar')) > 80) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types/' || i || '/label_en', 'invalid', 'A label of 1 to 80 characters.')));
    END IF;
    IF e ? 'lead_days' AND (jsonb_typeof(e -> 'lead_days') <> 'number' OR (e ->> 'lead_days')::numeric NOT BETWEEN 0 AND 365 OR (e ->> 'lead_days')::numeric <> trunc((e ->> 'lead_days')::numeric)) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types/' || i || '/lead_days', 'out_of_range', 'A whole number of days from 0 to 365.')));
    END IF;
    IF e ? 'required_for' THEN
      IF jsonb_typeof(e -> 'required_for') <> 'array' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types/' || i || '/required_for', 'invalid', 'A list of company types.'))); END IF;
      FOR x IN SELECT jsonb_array_elements_text(e -> 'required_for') LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_enum en JOIN pg_type y ON y.oid = en.enumtypid WHERE y.typname = 'ExternalPartyType' AND en.enumlabel = x) THEN
          PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/types/' || i || '/required_for', 'unknown_type', x || ' is not a company type.')));
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  SELECT coalesce(max(sort_order), 0) + 10 INTO nxt FROM public.company_document_types;
  FOR e IN SELECT * FROM jsonb_array_elements(p_types) LOOP
    SELECT * INTO o FROM public.company_document_types t WHERE t.code = e ->> 'code';
    rf := CASE WHEN e ? 'required_for' THEN ARRAY(SELECT DISTINCT jsonb_array_elements_text(e -> 'required_for')) ELSE NULL END;
    ld := CASE WHEN e ? 'lead_days' THEN (e ->> 'lead_days')::integer ELSE NULL END;
    IF FOUND THEN
      UPDATE public.company_document_types SET label_en = btrim(e ->> 'label_en'),
        label_ar = CASE WHEN e ? 'label_ar' THEN nullif(btrim(e ->> 'label_ar'), '') ELSE o.label_ar END,
        required_for = coalesce(rf, o.required_for), lead_days = coalesce(ld, o.lead_days),
        has_expiry = coalesce((e ->> 'has_expiry')::boolean, o.has_expiry), is_active = coalesce((e ->> 'is_active')::boolean, o.is_active), rev = o.rev + 1
       WHERE code = o.code
         AND (label_en, label_ar, required_for, lead_days, has_expiry, is_active) IS DISTINCT FROM
             (btrim(e ->> 'label_en'), CASE WHEN e ? 'label_ar' THEN nullif(btrim(e ->> 'label_ar'), '') ELSE o.label_ar END, coalesce(rf, o.required_for), coalesce(ld, o.lead_days),
              coalesce((e ->> 'has_expiry')::boolean, o.has_expiry), coalesce((e ->> 'is_active')::boolean, o.is_active));
    ELSE
      INSERT INTO public.company_document_types (code, label_en, label_ar, required_for, lead_days, has_expiry, is_active, sort_order)
      VALUES (e ->> 'code', btrim(e ->> 'label_en'), nullif(btrim(e ->> 'label_ar'), ''), coalesce(rf, ARRAY[]::text[]), coalesce(ld, 30),
              coalesce((e ->> 'has_expiry')::boolean, true), coalesce((e ->> 'is_active')::boolean, true), nxt);
      nxt := nxt + 10;
    END IF;
  END LOOP;
  IF (public.company_doc_types_json() -> 'types') IS DISTINCT FROM (before -> 'types') THEN
    PERFORM public.log_audit_write('company_doc_types_update', 'setting', 'company_document_types', before -> 'types', public.company_doc_types_json() -> 'types', p_reason);
  END IF;
  RETURN public.company_doc_types_json();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Contacts
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_contact_json(c public.company_contacts) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', c.id, 'party_id', c.party_id, 'name', c.name, 'role', c.role, 'phone', c.phone, 'email', c.email, 'is_primary', c.is_primary,
    'is_active', c.is_active, 'version', c.rev, 'updated_at', c.updated_at)
$$;

CREATE OR REPLACE FUNCTION company_contacts_list(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_parties p WHERE p.id = p_party) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The company does not exist.')); END IF;
  RETURN coalesce((SELECT jsonb_agg(public.company_contact_json(c) ORDER BY c.is_active DESC, c.is_primary DESC, c.name, c.id) FROM public.company_contacts c WHERE c.party_id = p_party), '[]'::jsonb);
END $$;

-- p_id NULL creates; otherwise updates (p_version is the contact's version, If-Match). Hide with is_active false; a contact is never deleted.
CREATE OR REPLACE FUNCTION company_contact_save(p_party uuid, p_id uuid, p jsonb, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); o public.company_contacts%ROWTYPE; n public.company_contacts%ROWTYPE; errs jsonb := '[]'::jsonb; k text;
  nm text; em text; prim boolean; act boolean;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_parties x WHERE x.id = p_party) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The company does not exist.')); END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.'))); END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY (ARRAY['name', 'role', 'phone', 'email', 'is_primary', 'is_active'])) THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF p_id IS NOT NULL THEN
    SELECT * INTO o FROM public.company_contacts WHERE id = p_id AND party_id = p_party FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The contact does not exist.')); END IF;
    IF p_version IS NOT NULL AND p_version <> o.rev THEN PERFORM public.wf_err('precondition_failed'); END IF;
  END IF;
  nm := CASE WHEN p ? 'name' THEN btrim(p ->> 'name') ELSE o.name END;
  em := CASE WHEN p ? 'email' THEN nullif(btrim(coalesce(p ->> 'email', '')), '') ELSE o.email END;
  prim := coalesce((p ->> 'is_primary')::boolean, o.is_primary, false);
  act := coalesce((p ->> 'is_active')::boolean, o.is_active, true);
  IF coalesce(nm, '') = '' OR char_length(nm) > 120 THEN errs := errs || public.reg_err_item('/name', 'required', 'A name of 1 to 120 characters.'); END IF;
  IF em IS NOT NULL AND (char_length(em) > 200 OR em !~ '^[^@\s]+@[^@\s]+$') THEN errs := errs || public.reg_err_item('/email', 'invalid', 'Not an email address.'); END IF;
  IF p ? 'phone' AND char_length(coalesce(p ->> 'phone', '')) > 40 THEN errs := errs || public.reg_err_item('/phone', 'too_long', 'At most 40 characters.'); END IF;
  IF p ? 'role' AND char_length(coalesce(p ->> 'role', '')) > 120 THEN errs := errs || public.reg_err_item('/role', 'too_long', 'At most 120 characters.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF NOT act THEN prim := false; END IF;
  IF prim THEN UPDATE public.company_contacts SET is_primary = false, rev = rev + 1, updated_at = now() WHERE party_id = p_party AND is_primary AND id IS DISTINCT FROM p_id; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.company_contacts (party_id, name, role, phone, email, is_primary, is_active, created_by)
    VALUES (p_party, nm, nullif(btrim(coalesce(p ->> 'role', '')), ''), nullif(btrim(coalesce(p ->> 'phone', '')), ''), em, prim, act, a) RETURNING * INTO n;
    PERFORM public.log_audit_write('company_contact_save', 'company_contact', n.id::text, NULL, public.company_contact_json(n), NULL);
  ELSE
    UPDATE public.company_contacts SET name = nm,
      role = CASE WHEN p ? 'role' THEN nullif(btrim(coalesce(p ->> 'role', '')), '') ELSE o.role END,
      phone = CASE WHEN p ? 'phone' THEN nullif(btrim(coalesce(p ->> 'phone', '')), '') ELSE o.phone END,
      email = em, is_primary = prim, is_active = act, rev = o.rev + 1, updated_at = now() WHERE id = p_id RETURNING * INTO n;
    PERFORM public.log_audit_write('company_contact_save', 'company_contact', n.id::text, public.company_contact_json(o), public.company_contact_json(n), NULL);
  END IF;
  RETURN public.company_contact_json(n);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Documents and certificates
-- ---------------------------------------------------------------------------------------------------------------------
-- 'expired', 'expiring' (inside the lead days of its type), 'valid', or 'no_expiry'
CREATE OR REPLACE FUNCTION company_doc_status(p_expires date, p_lead integer) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_expires IS NULL THEN 'no_expiry' WHEN p_expires < public.cal_today() THEN 'expired'
              WHEN p_expires <= public.cal_today() + coalesce(p_lead, 30) THEN 'expiring' ELSE 'valid' END
$$;

CREATE OR REPLACE FUNCTION company_document_json(d public.company_documents) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', d.id, 'party_id', d.party_id, 'type_code', d.type_code,
    'type_label_en', (SELECT t.label_en FROM public.company_document_types t WHERE t.code = d.type_code),
    'type_label_ar', (SELECT t.label_ar FROM public.company_document_types t WHERE t.code = d.type_code),
    'title', d.title, 'doc_number', d.doc_number, 'issued_on', d.issued_on, 'expires_on', d.expires_on, 'notes', d.notes,
    'has_file', d.storage_key IS NOT NULL, 'original_name', d.original_name, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes,
    'status', public.company_doc_status(d.expires_on, (SELECT t.lead_days FROM public.company_document_types t WHERE t.code = d.type_code)),
    'is_active', d.is_active, 'version', d.rev, 'updated_at', d.updated_at)
$$;

CREATE OR REPLACE FUNCTION company_documents_list(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_parties p WHERE p.id = p_party) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The company does not exist.')); END IF;
  RETURN coalesce((SELECT jsonb_agg(public.company_document_json(d) ORDER BY d.is_active DESC, d.type_code, d.expires_on DESC NULLS FIRST, d.id) FROM public.company_documents d WHERE d.party_id = p_party), '[]'::jsonb);
END $$;

-- The stored file of one document (for the download): the key and the file facts. The API checks the module right before calling it.
CREATE OR REPLACE FUNCTION company_document_file(p_party uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.company_documents%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.company_documents x WHERE x.id = p_id AND x.party_id = p_party AND x.storage_key IS NOT NULL;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document has no file.')); END IF;
  PERFORM public.log_audit_write('company_document_download', 'company_document', d.id::text, NULL,
    jsonb_build_object('party_id', d.party_id, 'original_name', d.original_name, 'size_bytes', d.size_bytes, 'sha256', d.sha256), NULL);
  RETURN jsonb_build_object('storage_key', d.storage_key, 'original_name', d.original_name, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes);
END $$;

-- p_id NULL creates; otherwise updates. p may carry file {storage_key, original_name, mime_type, size_bytes, sha256}, written by the API after the store accepted the bytes.
-- A new file replaces the pointer of this row only; to keep the older certificate as history, add a new row instead.
CREATE OR REPLACE FUNCTION company_document_save(p_party uuid, p_id uuid, p jsonb, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); o public.company_documents%ROWTYPE; n public.company_documents%ROWTYPE; errs jsonb := '[]'::jsonb; k text; f jsonb := p -> 'file';
  tc text; iss date; exp date; act boolean; hasexp boolean;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_parties x WHERE x.id = p_party) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The company does not exist.')); END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.'))); END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY (ARRAY['type_code', 'title', 'doc_number', 'issued_on', 'expires_on', 'notes', 'is_active', 'file'])) THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF p_id IS NOT NULL THEN
    SELECT * INTO o FROM public.company_documents WHERE id = p_id AND party_id = p_party FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document does not exist.')); END IF;
    IF p_version IS NOT NULL AND p_version <> o.rev THEN PERFORM public.wf_err('precondition_failed'); END IF;
  END IF;
  tc := CASE WHEN p ? 'type_code' THEN p ->> 'type_code' ELSE o.type_code END;
  BEGIN
    iss := CASE WHEN p ? 'issued_on' THEN nullif(p ->> 'issued_on', '')::date ELSE o.issued_on END;
    exp := CASE WHEN p ? 'expires_on' THEN nullif(p ->> 'expires_on', '')::date ELSE o.expires_on END;
  EXCEPTION WHEN others THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/expires_on', 'invalid', 'A date as YYYY-MM-DD.')));
  END;
  act := coalesce((p ->> 'is_active')::boolean, o.is_active, true);
  SELECT t.has_expiry INTO hasexp FROM public.company_document_types t WHERE t.code = tc AND (t.is_active OR tc IS NOT DISTINCT FROM o.type_code);
  IF NOT FOUND THEN errs := errs || public.reg_err_item('/type_code', 'unknown_type', 'Choose a document type of Settings > Contractors > Documents.'); END IF;
  IF iss IS NOT NULL AND exp IS NOT NULL AND exp < iss THEN errs := errs || public.reg_err_item('/expires_on', 'before_issue', 'The expiry cannot be before the issue date.'); END IF;
  IF p ? 'title' AND char_length(coalesce(p ->> 'title', '')) > 160 THEN errs := errs || public.reg_err_item('/title', 'too_long', 'At most 160 characters.'); END IF;
  IF p ? 'doc_number' AND char_length(coalesce(p ->> 'doc_number', '')) > 80 THEN errs := errs || public.reg_err_item('/doc_number', 'too_long', 'At most 80 characters.'); END IF;
  IF p ? 'notes' AND char_length(coalesce(p ->> 'notes', '')) > 2000 THEN errs := errs || public.reg_err_item('/notes', 'too_long', 'At most 2000 characters.'); END IF;
  IF f IS NOT NULL AND (jsonb_typeof(f) <> 'object' OR coalesce(f ->> 'storage_key', '') = '') THEN errs := errs || public.reg_err_item('/file', 'invalid', 'A stored file.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.company_documents (party_id, type_code, title, doc_number, issued_on, expires_on, notes, storage_key, original_name, mime_type, size_bytes, sha256, is_active, created_by)
    VALUES (p_party, tc, nullif(btrim(coalesce(p ->> 'title', '')), ''), nullif(btrim(coalesce(p ->> 'doc_number', '')), ''), iss, exp, nullif(btrim(coalesce(p ->> 'notes', '')), ''),
            f ->> 'storage_key', f ->> 'original_name', f ->> 'mime_type', (f ->> 'size_bytes')::bigint, f ->> 'sha256', act, a) RETURNING * INTO n;
    PERFORM public.log_audit_write('company_document_save', 'company_document', n.id::text, NULL, public.company_document_json(n), NULL);
  ELSE
    UPDATE public.company_documents SET type_code = tc,
      title = CASE WHEN p ? 'title' THEN nullif(btrim(coalesce(p ->> 'title', '')), '') ELSE o.title END,
      doc_number = CASE WHEN p ? 'doc_number' THEN nullif(btrim(coalesce(p ->> 'doc_number', '')), '') ELSE o.doc_number END,
      issued_on = iss, expires_on = exp,
      notes = CASE WHEN p ? 'notes' THEN nullif(btrim(coalesce(p ->> 'notes', '')), '') ELSE o.notes END,
      storage_key = coalesce(f ->> 'storage_key', o.storage_key), original_name = CASE WHEN f IS NOT NULL THEN f ->> 'original_name' ELSE o.original_name END,
      mime_type = CASE WHEN f IS NOT NULL THEN f ->> 'mime_type' ELSE o.mime_type END, size_bytes = CASE WHEN f IS NOT NULL THEN (f ->> 'size_bytes')::bigint ELSE o.size_bytes END,
      sha256 = CASE WHEN f IS NOT NULL THEN f ->> 'sha256' ELSE o.sha256 END, is_active = act, rev = o.rev + 1, updated_at = now() WHERE id = p_id RETURNING * INTO n;
    PERFORM public.log_audit_write('company_document_save', 'company_document', n.id::text, public.company_document_json(o), public.company_document_json(n), NULL);
  END IF;
  RETURN public.company_document_json(n);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Compliance: the chip of the company and the compliance factor of the ranking
-- ---------------------------------------------------------------------------------------------------------------------
-- Per company: the type of each required or held document is judged by its newest active document (the latest expiry; no expiry = valid).
--   status: expired (a held document expired, or a required type has only expired documents), missing (a required type has none), expiring, ok.
CREATE OR REPLACE FUNCTION company_compliance_rows(p_party uuid) RETURNS TABLE (party_id uuid, status text, expired integer, expiring integer, missing integer, valid integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH p AS (SELECT x.id, x.type::text AS ptype FROM public.external_parties x WHERE x.is_active AND (p_party IS NULL OR x.id = p_party)),
  held AS (  -- the newest active document of each type
    SELECT DISTINCT ON (d.party_id, d.type_code) d.party_id, d.type_code, d.expires_on, t.lead_days
    FROM public.company_documents d JOIN public.company_document_types t ON t.code = d.type_code
    WHERE d.is_active AND d.party_id IN (SELECT id FROM p)
    ORDER BY d.party_id, d.type_code, d.expires_on DESC NULLS FIRST, d.updated_at DESC),
  req AS (SELECT p.id AS party_id, t.code FROM p JOIN public.company_document_types t ON t.is_active AND p.ptype = ANY (t.required_for)),
  j AS (
    SELECT h.party_id, public.company_doc_status(h.expires_on, h.lead_days) AS st FROM held h JOIN public.company_document_types t ON t.code = h.type_code AND t.is_active
    UNION ALL
    SELECT r.party_id, 'missing' FROM req r WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.party_id = r.party_id AND h.type_code = r.code))
  SELECT p.id, CASE WHEN count(*) FILTER (WHERE j.st = 'expired') > 0 THEN 'expired' WHEN count(*) FILTER (WHERE j.st = 'missing') > 0 THEN 'missing'
                    WHEN count(*) FILTER (WHERE j.st = 'expiring') > 0 THEN 'expiring' ELSE 'ok' END,
         (count(*) FILTER (WHERE j.st = 'expired'))::integer, (count(*) FILTER (WHERE j.st = 'expiring'))::integer, (count(*) FILTER (WHERE j.st = 'missing'))::integer,
         (count(*) FILTER (WHERE j.st IN ('valid', 'no_expiry')))::integer
  FROM p LEFT JOIN j ON j.party_id = p.id GROUP BY p.id
$$;

CREATE OR REPLACE FUNCTION company_compliance(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.company_compliance_rows(p_party);
  IF NOT FOUND THEN RETURN jsonb_build_object('party_id', p_party, 'status', 'ok', 'expired', 0, 'expiring', 0, 'missing', 0, 'valid', 0); END IF;
  RETURN jsonb_build_object('party_id', r.party_id, 'status', r.status, 'expired', r.expired, 'expiring', r.expiring, 'missing', r.missing, 'valid', r.valid);
END $$;

CREATE OR REPLACE FUNCTION company_compliance_all() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('party_id', r.party_id, 'status', r.status, 'expired', r.expired, 'expiring', r.expiring, 'missing', r.missing, 'valid', r.valid)
                   ORDER BY r.party_id) FROM public.company_compliance_rows(NULL) r), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The daily alert (the same shape as the safety certificate alert, D145b). Idempotent: once per document and stage. Returns the notifications written.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_documents_daily_alerts() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE today date := public.cal_today(); t record; stage text; u uuid; n integer := 0; ok boolean; who uuid[];
BEGIN
  FOR t IN SELECT d.id, d.expires_on AS exp, ty.label_en AS tl, p.id AS pid, p.name AS pname
           FROM public.company_documents d JOIN public.company_document_types ty ON ty.code = d.type_code AND ty.is_active
           JOIN public.external_parties p ON p.id = d.party_id AND p.is_active
           WHERE d.is_active AND d.expires_on IS NOT NULL AND d.expires_on <= today + ty.lead_days ORDER BY d.expires_on, d.id LOOP
    stage := CASE WHEN t.exp < today THEN 'expired' ELSE 'due' END;
    INSERT INTO public.contractor_alerts_sent (kind, ref_id, detail) VALUES ('company_doc_' || stage, t.id, t.exp::text) ON CONFLICT DO NOTHING RETURNING true INTO ok;
    IF ok IS NULL THEN CONTINUE; END IF;
    who := ARRAY(SELECT x FROM public.p4b_recipients(NULL) x);
    IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_admins()); END IF;
    FOREACH u IN ARRAY who LOOP
      INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
      VALUES (u, 'in_app', 'company_document', CASE stage WHEN 'expired' THEN 'A company document has expired' ELSE 'A company document expires soon' END,
              t.pname || ': ' || t.tl || ' ' || CASE stage WHEN 'expired' THEN 'expired on ' ELSE 'expires on ' END || t.exp::text || '. Information only: orders and assignments are not blocked.',
              '/companies/' || t.pid::text);
      n := n + 1;
    END LOOP;
    ok := NULL;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and rights (0166 pattern): pmis_app calls the functions and never touches the tables.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON company_document_types, company_contacts, company_documents TO pmis_definer;
GRANT SELECT ON external_parties, users TO pmis_definer;
GRANT SELECT, INSERT ON contractor_alerts_sent TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  ALTER TABLE company_document_types OWNER TO pmis_definer;
  ALTER TABLE company_contacts OWNER TO pmis_definer;
  ALTER TABLE company_documents OWNER TO pmis_definer;
  FOREACH f IN ARRAY ARRAY['company_doc_types_json()', 'admin_save_company_doc_types(jsonb,text,integer)', 'company_contact_json(company_contacts)', 'company_contacts_list(uuid)',
    'company_contact_save(uuid,uuid,jsonb,integer)', 'company_document_json(company_documents)', 'company_doc_status(date,integer)', 'company_documents_list(uuid)',
    'company_document_file(uuid,uuid)', 'company_document_save(uuid,uuid,jsonb,integer)', 'company_compliance_rows(uuid)', 'company_compliance(uuid)', 'company_compliance_all()',
    'company_documents_daily_alerts()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON company_document_types, company_contacts, company_documents FROM pmis_app;
    FOREACH f IN ARRAY ARRAY['company_doc_types_json()', 'admin_save_company_doc_types(jsonb,text,integer)', 'company_contacts_list(uuid)', 'company_contact_save(uuid,uuid,jsonb,integer)',
      'company_documents_list(uuid)', 'company_document_file(uuid,uuid)', 'company_document_save(uuid,uuid,jsonb,integer)', 'company_compliance(uuid)', 'company_compliance_all()',
      'company_documents_daily_alerts()'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- Data reset coverage (0152): the company contacts and documents are master data with external_parties (KEEP). data_reset_plan() is an accumulating function:
-- patch the stored text idempotently (0361 pattern), never redefine it from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''company_contacts''' IN def) = 0 THEN
    IF position('''contractor_alerts_sent''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the master data anchor was not found'; END IF;
    def := replace(def, '''contractor_alerts_sent''', '''contractor_alerts_sent'', ''company_document_types'', ''company_contacts'', ''company_documents''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.company_document_types, public.company_contacts, public.company_documents TO pmis_reset_owner;
