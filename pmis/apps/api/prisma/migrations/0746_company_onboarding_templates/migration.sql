-- 0746_company_onboarding_templates (contract 0.15.626): the onboarding checklist, the bulk status change, and the three import/export templates of a company (Companies proposal K4).
-- Mirror: db/sql/745_company_onboarding_templates.sql (kept byte-identical). Stacked on 0745 (K3: contacts, documents, document types).
--
-- A "company" is a row of external_parties. Additive: nothing existing is changed except one patch of tpl_sync (a branch per new template kind, 0564 pattern) and the
-- kind constraint of template_definitions.
--   1. company_onboarding_items: the checklist items, edited in Settings > Registers > Contractors: label EN/AR, "applies to" company types (seeded EMPTY, so no
--      checklist shows until the owner picks the types), shown or hidden (never deleted). Seed: documents received, safety induction, insurance, reference check.
--   2. company_onboarding: one row per company and item: Not started / In progress / Approved, who approved and when, a note. No workflow engine: a status is
--      changed in one step by an editor of Contractors or Procurement, and the change is audited.
--   3. company_onboarding_json(party), company_onboarding_set(...), company_onboarding_bulk(parties, item, status, note) (all or nothing, at most 200 companies),
--      company_onboarding_overview(): the progress of every company for the list.
--   4. Templates TPL-COMPANY-CONTACTS, TPL-COMPANY-DOCUMENTS and TPL-COMPANY-ONBOARDING (data hub catalogue, download blank or filled, versioned with tpl_sync) and
--      company_import_rows(kind, rows, meta): all or nothing, every row goes through the doors of K3 (company_contact_save, company_document_save) or of this file
--      (company_onboarding_apply), so validation and audit are the ones of the screens. A blank cell changes nothing. Files are never part of a template: attach
--      the file to the document on the company page.
-- Not covered here: manual entries, notes and custom factors of the company (K5): their tables do not exist yet. When K5 adds them, it adds a template kind the same way.
-- The tables are in data_reset_plan() as KEEP and pmis_reset_owner gets its grants.
SELECT set_config('app.region_ids', '*', true);

CREATE TABLE company_onboarding_items (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  label_en     text NOT NULL CHECK (char_length(btrim(label_en)) BETWEEN 1 AND 80),
  label_ar     text CHECK (label_ar IS NULL OR char_length(btrim(label_ar)) BETWEEN 1 AND 80),
  required_for text[] NOT NULL DEFAULT ARRAY[]::text[],
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 100,
  rev          integer NOT NULL DEFAULT 1
);
INSERT INTO company_onboarding_items (code, label_en, label_ar, sort_order) VALUES
  ('documents_received', 'Documents received', 'استلام المستندات', 10),
  ('safety_induction',   'Safety induction',   'التوعية بالسلامة', 20),
  ('insurance',          'Insurance',          'التأمين', 30),
  ('reference_check',    'Reference check',    'التحقق من المراجع', 40)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE company_onboarding (
  party_id    uuid NOT NULL REFERENCES external_parties (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  item_code   text NOT NULL REFERENCES company_onboarding_items (code) ON UPDATE CASCADE,
  status      text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'approved')),
  approver_id uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at  timestamptz,
  note        text CHECK (note IS NULL OR char_length(note) <= 1000),
  rev         integer NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, item_code)
);

ALTER TABLE company_onboarding_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_onboarding_items FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON company_onboarding_items FOR SELECT USING (app_actor() IS NOT NULL OR app_is_seeding());
CREATE POLICY rls_seed_write ON company_onboarding_items FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE company_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_onboarding FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON company_onboarding FOR SELECT USING (app_actor() IS NOT NULL OR app_is_seeding());
CREATE POLICY rls_seed_write ON company_onboarding FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Checklist items (Settings)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_onboarding_items_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'label_en', t.label_en, 'label_ar', t.label_ar, 'required_for', to_jsonb(t.required_for),
                'is_active', t.is_active) ORDER BY t.sort_order, t.code), '[]'::jsonb) FROM public.company_onboarding_items t),
    'party_types', (SELECT coalesce(jsonb_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::jsonb) FROM pg_enum e JOIN pg_type y ON y.oid = e.enumtypid WHERE y.typname = 'ExternalPartyType'),
    'version', (SELECT coalesce(sum(t.rev), 0)::integer FROM public.company_onboarding_items t),
    'can_edit', (public.app_actor_is_admin('admin.settings', 'edit') AND public.app_actor_region_filter('admin.settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_save_company_onboarding_items(p_items jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before jsonb; e jsonb; i int := 0; o public.company_onboarding_items%ROWTYPE; seen text[] := ARRAY[]::text[]; rf text[]; x text; nxt integer;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 40 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items', 'invalid', 'A list of at most 40 items.')));
  END IF;
  LOCK TABLE public.company_onboarding_items IN SHARE ROW EXCLUSIVE MODE;
  before := public.company_onboarding_items_json();
  IF p_version IS NOT NULL AND p_version <> (before ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' OR coalesce(e ->> 'code', '') !~ '^[a-z][a-z0-9_]{1,40}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items/' || i || '/code', 'invalid', 'A code of lower-case letters, digits and underscores.')));
    END IF;
    IF (e ->> 'code') = ANY (seen) THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items/' || i, 'duplicate', 'One entry per code.'))); END IF;
    seen := seen || (e ->> 'code');
    IF char_length(btrim(coalesce(e ->> 'label_en', ''))) NOT BETWEEN 1 AND 80 OR (e ? 'label_ar' AND jsonb_typeof(e -> 'label_ar') = 'string' AND char_length(btrim(e ->> 'label_ar')) > 80) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items/' || i || '/label_en', 'invalid', 'A label of 1 to 80 characters.')));
    END IF;
    IF e ? 'required_for' THEN
      IF jsonb_typeof(e -> 'required_for') <> 'array' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items/' || i || '/required_for', 'invalid', 'A list of company types.'))); END IF;
      FOR x IN SELECT jsonb_array_elements_text(e -> 'required_for') LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_enum en JOIN pg_type y ON y.oid = en.enumtypid WHERE y.typname = 'ExternalPartyType' AND en.enumlabel = x) THEN
          PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/items/' || i || '/required_for', 'unknown_type', x || ' is not a company type.')));
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  SELECT coalesce(max(sort_order), 0) + 10 INTO nxt FROM public.company_onboarding_items;
  FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO o FROM public.company_onboarding_items t WHERE t.code = e ->> 'code';
    rf := CASE WHEN e ? 'required_for' THEN ARRAY(SELECT DISTINCT jsonb_array_elements_text(e -> 'required_for')) ELSE NULL END;
    IF FOUND THEN
      UPDATE public.company_onboarding_items SET label_en = btrim(e ->> 'label_en'),
        label_ar = CASE WHEN e ? 'label_ar' THEN nullif(btrim(e ->> 'label_ar'), '') ELSE o.label_ar END,
        required_for = coalesce(rf, o.required_for), is_active = coalesce((e ->> 'is_active')::boolean, o.is_active), rev = o.rev + 1
       WHERE code = o.code
         AND (label_en, label_ar, required_for, is_active) IS DISTINCT FROM
             (btrim(e ->> 'label_en'), CASE WHEN e ? 'label_ar' THEN nullif(btrim(e ->> 'label_ar'), '') ELSE o.label_ar END, coalesce(rf, o.required_for),
              coalesce((e ->> 'is_active')::boolean, o.is_active));
    ELSE
      INSERT INTO public.company_onboarding_items (code, label_en, label_ar, required_for, is_active, sort_order)
      VALUES (e ->> 'code', btrim(e ->> 'label_en'), nullif(btrim(e ->> 'label_ar'), ''), coalesce(rf, ARRAY[]::text[]), coalesce((e ->> 'is_active')::boolean, true), nxt);
      nxt := nxt + 10;
    END IF;
  END LOOP;
  IF (public.company_onboarding_items_json() -> 'items') IS DISTINCT FROM (before -> 'items') THEN
    PERFORM public.log_audit_write('company_onboarding_items_update', 'setting', 'company_onboarding_items', before -> 'items', public.company_onboarding_items_json() -> 'items', p_reason);
  END IF;
  RETURN public.company_onboarding_items_json();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The checklist of a company
-- ---------------------------------------------------------------------------------------------------------------------
-- An item applies to a company when its type is in the item's "applies to" list (empty list: applies to nobody). An item that was already given a status keeps showing.
CREATE OR REPLACE FUNCTION company_onboarding_json(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ty text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT p.type::text INTO ty FROM public.external_parties p WHERE p.id = p_party;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The company does not exist.')); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('code', i.code, 'label_en', i.label_en, 'label_ar', i.label_ar, 'status', coalesce(o.status, 'not_started'),
      'approver_id', o.approver_id, 'approver_name', u.display_name, 'decided_at', o.decided_at, 'note', o.note, 'updated_at', o.updated_at) ORDER BY i.sort_order, i.code)
    FROM public.company_onboarding_items i LEFT JOIN public.company_onboarding o ON o.item_code = i.code AND o.party_id = p_party
    LEFT JOIN public.users u ON u.id = o.approver_id
    WHERE (i.is_active AND ty = ANY (i.required_for)) OR o.party_id IS NOT NULL), '[]'::jsonb);
END $$;

-- One change of one status. Approved records who approved and when; any other status clears them. Returns the row as json and whether anything changed.
CREATE OR REPLACE FUNCTION company_onboarding_apply(p_party uuid, p_item text, p_status text, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); ty text; it public.company_onboarding_items%ROWTYPE; o public.company_onboarding%ROWTYPE; had boolean; nt text; changed boolean := false; n public.company_onboarding%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT p.type::text INTO ty FROM public.external_parties p WHERE p.id = p_party;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The company does not exist.')); END IF;
  SELECT * INTO it FROM public.company_onboarding_items WHERE code = p_item;
  IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/item', 'unknown_item', 'Choose an item of Settings > Contractors > Onboarding.'))); END IF;
  IF p_status IS NULL OR p_status NOT IN ('not_started', 'in_progress', 'approved') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'invalid', 'Not started, In progress or Approved.')));
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 1000 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/note', 'too_long', 'At most 1000 characters.'))); END IF;
  SELECT * INTO o FROM public.company_onboarding WHERE party_id = p_party AND item_code = p_item FOR UPDATE;
  had := FOUND;
  IF NOT had AND NOT (it.is_active AND ty = ANY (it.required_for)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/item', 'not_applicable', 'This item does not apply to the type of this company.')));
  END IF;
  nt := CASE WHEN p_note IS NULL THEN o.note ELSE nullif(btrim(p_note), '') END;
  IF had AND o.status = p_status AND o.note IS NOT DISTINCT FROM nt THEN
    RETURN jsonb_build_object('party_id', p_party, 'item', p_item, 'status', o.status, 'changed', false);
  END IF;
  IF had THEN
    UPDATE public.company_onboarding SET status = p_status, note = nt,
      approver_id = CASE WHEN p_status = 'approved' THEN CASE WHEN o.status = 'approved' THEN o.approver_id ELSE a END ELSE NULL END,
      decided_at = CASE WHEN p_status = 'approved' THEN CASE WHEN o.status = 'approved' THEN o.decided_at ELSE now() END ELSE NULL END,
      rev = o.rev + 1, updated_by = a, updated_at = now() WHERE party_id = p_party AND item_code = p_item RETURNING * INTO n;
  ELSE
    INSERT INTO public.company_onboarding (party_id, item_code, status, approver_id, decided_at, note, updated_by)
    VALUES (p_party, p_item, p_status, CASE WHEN p_status = 'approved' THEN a END, CASE WHEN p_status = 'approved' THEN now() END, nt, a) RETURNING * INTO n;
  END IF;
  changed := true;
  PERFORM public.log_audit_write('company_onboarding_set', 'company_onboarding', p_party::text || '/' || p_item,
    CASE WHEN had THEN jsonb_build_object('status', o.status, 'note', o.note) END, jsonb_build_object('status', n.status, 'note', n.note, 'approver_id', n.approver_id), NULL);
  RETURN jsonb_build_object('party_id', p_party, 'item', p_item, 'status', n.status, 'changed', changed);
END $$;

CREATE OR REPLACE FUNCTION company_onboarding_set(p_party uuid, p_item text, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN public.company_onboarding_apply(p_party, p_item, p_status, p_note);
END $$;

-- The bulk action of the company list: one item, one status, many companies. All or nothing: one refused company refuses the call (errors at /parties/<n>).
CREATE OR REPLACE FUNCTION company_onboarding_bulk(p_parties uuid[], p_item text, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE pid uuid; i integer := 0; errs jsonb := '[]'::jsonb; msg text; r jsonb; n_changed integer := 0; n_same integer := 0; seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_parties IS NULL OR cardinality(p_parties) = 0 OR cardinality(p_parties) > 200 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/parties', 'invalid', 'Between 1 and 200 companies.')));
  END IF;
  FOREACH pid IN ARRAY p_parties LOOP
    i := i + 1;
    IF pid = ANY (seen) THEN CONTINUE; END IF;
    seen := seen || pid;
    BEGIN
      r := public.company_onboarding_apply(pid, p_item, p_status, p_note);
      IF (r ->> 'changed')::boolean THEN n_changed := n_changed + 1; ELSE n_same := n_same + 1; END IF;
    EXCEPTION WHEN others THEN
      msg := SQLERRM;
      IF msg LIKE 'wf:%' THEN
        errs := errs || public.reg_err_item('/parties/' || i, split_part(msg, ':', 2), 'This company was refused.');
      ELSE
        errs := errs || public.reg_err_item('/parties/' || i, 'invalid', 'This company was refused.');
      END IF;
    END;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN jsonb_build_object('companies', cardinality(seen), 'changed', n_changed, 'unchanged', n_same, 'item', p_item, 'status', p_status);
END $$;

-- Progress of every company for the list: applicable items, approved items, in progress items.
CREATE OR REPLACE FUNCTION company_onboarding_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('party_id', q.id, 'total', q.total, 'approved', q.approved, 'in_progress', q.in_progress,
      'status', CASE WHEN q.total = 0 THEN 'none' WHEN q.approved = q.total THEN 'approved' WHEN q.approved + q.in_progress > 0 THEN 'in_progress' ELSE 'not_started' END) ORDER BY q.id)
    FROM (
      SELECT p.id, count(i.code)::integer AS total, count(*) FILTER (WHERE o.status = 'approved')::integer AS approved, count(*) FILTER (WHERE o.status = 'in_progress')::integer AS in_progress
      FROM public.external_parties p
      LEFT JOIN public.company_onboarding_items i ON i.is_active AND p.type::text = ANY (i.required_for)
      LEFT JOIN public.company_onboarding o ON o.party_id = p.id AND o.item_code = i.code
      WHERE p.is_active GROUP BY p.id) q), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Templates: columns, catalogue, tpl_sync
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_kind_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_kind_check
  CHECK (kind IN ('register', 'stream', 'master', 'sites', 'list_values', 'holidays', 'daily_plan', 'company_contacts', 'company_documents', 'company_onboarding'));
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_scope_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_scope_check CHECK (
  (kind = 'register' AND register_key IS NOT NULL AND stream_code IS NULL)
  OR (kind = 'stream' AND stream_code IS NOT NULL AND register_key IS NULL)
  OR (kind IN ('master', 'sites', 'list_values', 'holidays', 'daily_plan', 'company_contacts', 'company_documents', 'company_onboarding') AND register_key IS NULL AND stream_code IS NULL));

CREATE OR REPLACE FUNCTION tpl_company_contacts_columns() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('code', 'company',    'header', 'Company (name as in the list)', 'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'name',       'header', 'Contact name',                  'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'role',       'header', 'Role',                          'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'phone',      'header', 'Phone',                         'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'email',      'header', 'Email',                         'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'is_primary', 'header', 'Primary contact (yes / no)',    'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'is_active',  'header', 'Active (yes / no)',             'type', 'text', 'kind', 'field', 'required', false, 'derived', false))
$$;

CREATE OR REPLACE FUNCTION tpl_company_documents_columns() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('code', 'company',    'header', 'Company (name as in the list)', 'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'type',       'header', 'Document type',                 'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'title',      'header', 'Title',                         'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'doc_number', 'header', 'Number',                        'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'issued_on',  'header', 'Issue date (YYYY-MM-DD)',       'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'expires_on', 'header', 'Expiry date (YYYY-MM-DD)',      'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'notes',      'header', 'Notes',                         'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'is_active',  'header', 'Active (yes / no)',             'type', 'text', 'kind', 'field', 'required', false, 'derived', false))
$$;

CREATE OR REPLACE FUNCTION tpl_company_onboarding_columns() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('code', 'company',     'header', 'Company (name as in the list)',                      'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'item',        'header', 'Checklist item',                                     'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'status',      'header', 'Status (Not started / In progress / Approved)',      'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'note',        'header', 'Note',                                               'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'approved_by', 'header', 'Approved by (read only)',                            'type', 'text', 'kind', 'field', 'required', false, 'derived', true),
    jsonb_build_object('code', 'decided_on',  'header', 'Approved on (read only)',                            'type', 'text', 'kind', 'field', 'required', false, 'derived', true))
$$;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, module_key, match_keys, sort_order, is_master_format) VALUES
  ('TPL-COMPANY-CONTACTS',   'Company contacts',            'جهات اتصال الشركات',        'company_contact',    'company_contacts',   'contractors', '[["company","name"]]', 6, false),
  ('TPL-COMPANY-DOCUMENTS',  'Company documents',           'مستندات الشركات',           'company_document',   'company_documents',  'contractors', '[["company","type","doc_number"]]', 7, false),
  ('TPL-COMPANY-ONBOARDING', 'Company onboarding checklist', 'قائمة تأهيل الشركات',      'company_onboarding', 'company_onboarding', 'contractors', '[["company","item"]]', 8, false)
ON CONFLICT (template_id) DO NOTHING;

INSERT INTO template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
SELECT d.id, 1, public.tpl_header_checksum(c.cols), 1, c.cols, true, public.tpl_field_hash(c.cols), 'first version'
FROM template_definitions d
JOIN (VALUES ('TPL-COMPANY-CONTACTS', public.tpl_company_contacts_columns()), ('TPL-COMPANY-DOCUMENTS', public.tpl_company_documents_columns()),
             ('TPL-COMPANY-ONBOARDING', public.tpl_company_onboarding_columns())) AS c(tid, cols) ON c.tid = d.template_id
WHERE NOT EXISTS (SELECT 1 FROM template_versions v WHERE v.template_def_id = d.id);
UPDATE template_definitions SET current_version = 1, updated_at = now() WHERE template_id IN ('TPL-COMPANY-CONTACTS', 'TPL-COMPANY-DOCUMENTS', 'TPL-COMPANY-ONBOARDING') AND current_version < 1;

-- tpl_sync patched in place (no whole redefinition): one branch per kind, before the holidays branch. Idempotent.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.tpl_sync(text,text)'::regprocedure);
  IF position('company_contacts' IN def) = 0 THEN
    IF position('  ELSIF d.kind = ''holidays'' THEN' IN def) = 0 THEN RAISE EXCEPTION 'tpl_sync: the holidays branch is not where 0746 expects it'; END IF;
    def := replace(def, '  ELSIF d.kind = ''holidays'' THEN',
      '  ELSIF d.kind = ''company_contacts'' THEN' || E'\n' ||
      '    cols := public.tpl_company_contacts_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := ''company contacts template changed'';' || E'\n' ||
      '  ELSIF d.kind = ''company_documents'' THEN' || E'\n' ||
      '    cols := public.tpl_company_documents_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := ''company documents template changed'';' || E'\n' ||
      '  ELSIF d.kind = ''company_onboarding'' THEN' || E'\n' ||
      '    cols := public.tpl_company_onboarding_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := ''company onboarding template changed'';' || E'\n' ||
      '  ELSIF d.kind = ''holidays'' THEN');
    EXECUTE def;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Export rows (the filled copy) and the import
-- ---------------------------------------------------------------------------------------------------------------------
-- The rows of a filled copy, keyed by column code. p_parties NULL = every active company. At most 5000 rows. Hidden contacts and documents are not exported.
CREATE OR REPLACE FUNCTION company_export_rows(p_kind text, p_parties uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind = 'company_contacts' THEN
    RETURN coalesce((SELECT jsonb_agg(x.j) FROM (
      SELECT jsonb_build_object('company', p.name, 'name', c.name, 'role', c.role, 'phone', c.phone, 'email', c.email,
        'is_primary', CASE WHEN c.is_primary THEN 'yes' ELSE 'no' END, 'is_active', 'yes') AS j
      FROM public.company_contacts c JOIN public.external_parties p ON p.id = c.party_id
      WHERE c.is_active AND (p_parties IS NULL OR p.id = ANY (p_parties)) ORDER BY p.name, c.is_primary DESC, c.name, c.id LIMIT 5000) x), '[]'::jsonb);
  ELSIF p_kind = 'company_documents' THEN
    RETURN coalesce((SELECT jsonb_agg(x.j) FROM (
      SELECT jsonb_build_object('company', p.name, 'type', t.label_en, 'title', d.title, 'doc_number', d.doc_number, 'issued_on', d.issued_on::text,
        'expires_on', d.expires_on::text, 'notes', d.notes, 'is_active', 'yes') AS j
      FROM public.company_documents d JOIN public.external_parties p ON p.id = d.party_id JOIN public.company_document_types t ON t.code = d.type_code
      WHERE d.is_active AND (p_parties IS NULL OR p.id = ANY (p_parties)) ORDER BY p.name, t.sort_order, d.expires_on NULLS LAST, d.id LIMIT 5000) x), '[]'::jsonb);
  ELSIF p_kind = 'company_onboarding' THEN
    RETURN coalesce((SELECT jsonb_agg(x.j) FROM (
      SELECT jsonb_build_object('company', p.name, 'item', i.label_en,
        'status', CASE coalesce(o.status, 'not_started') WHEN 'approved' THEN 'Approved' WHEN 'in_progress' THEN 'In progress' ELSE 'Not started' END,
        'note', o.note, 'approved_by', u.display_name, 'decided_on', o.decided_at::date::text) AS j
      FROM public.external_parties p
      JOIN public.company_onboarding_items i ON (i.is_active AND p.type::text = ANY (i.required_for))
      LEFT JOIN public.company_onboarding o ON o.party_id = p.id AND o.item_code = i.code
      LEFT JOIN public.users u ON u.id = o.approver_id
      WHERE p.is_active AND (p_parties IS NULL OR p.id = ANY (p_parties)) ORDER BY p.name, i.sort_order, i.code LIMIT 5000) x), '[]'::jsonb);
  END IF;
  PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kind', 'unknown_kind', 'Not a company template.')));
END $$;

-- POST /companies/import, after the API checked the file (size, xlsx guard, the _tpl sheet naming a company template and its current version, the header row).
-- p_rows = [{line, <column code>: text, ...}] as read from the Data sheet. A blank cell changes nothing. A company is found by its name (case and spaces ignored);
-- two companies with the same name are refused (ambiguous). All or nothing: one refused row refuses the file (errors at /rows/<line>/<field>).
CREATE OR REPLACE FUNCTION company_import_rows(p_kind text, p_rows jsonb, p_meta jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r jsonb; ln integer; pid uuid; nn integer; c public.company_contacts%ROWTYPE; d public.company_documents%ROWTYPE; ty public.company_document_types%ROWTYPE; it public.company_onboarding_items%ROWTYPE;
  v text; body jsonb; errs jsonb := '[]'::jsonb; e jsonb; msg text; code text; extra jsonb; import_id uuid := gen_random_uuid(); res jsonb; found boolean; st text; seen text[] := ARRAY[]::text[]; dk text;
  n_add integer := 0; n_upd integer := 0; n_same integer := 0; yes boolean;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'company import: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('company_contacts', 'company_documents', 'company_onboarding') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kind', 'unknown_kind', 'Not a company template.')));
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/file', 'empty', 'The Data sheet has no row.')));
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    ln := (r ->> 'line')::integer;
    BEGIN
      v := lower(btrim(coalesce(r ->> 'company', '')));
      IF v = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/company', 'required', 'The company is required.'))); END IF;
      SELECT count(*), min(p.id::text)::uuid INTO nn, pid FROM public.external_parties p WHERE lower(btrim(p.name)) = v;
      IF nn = 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/company', 'not_found', 'No company has this name.'))); END IF;
      IF nn > 1 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/company', 'ambiguous', 'More than one company has this name.'))); END IF;
      body := '{}'::jsonb;
      IF p_kind = 'company_contacts' THEN
        v := btrim(coalesce(r ->> 'name', ''));
        IF v = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/name', 'required', 'The contact name is required.'))); END IF;
        dk := pid::text || '|' || lower(v);
        IF dk = ANY (seen) THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/name', 'duplicate', 'This contact appears twice in the file.'))); END IF;
        seen := seen || dk;
        SELECT * INTO c FROM public.company_contacts x WHERE x.party_id = pid AND lower(btrim(x.name)) = lower(v) ORDER BY x.is_active DESC, x.created_at LIMIT 1;
        found := FOUND;
        FOREACH code IN ARRAY ARRAY['role', 'phone', 'email'] LOOP
          IF btrim(coalesce(r ->> code, '')) <> '' AND (NOT found OR btrim(r ->> code) IS DISTINCT FROM (to_jsonb(c) ->> code)) THEN body := body || jsonb_build_object(code, btrim(r ->> code)); END IF;
        END LOOP;
        FOREACH code IN ARRAY ARRAY['is_primary', 'is_active'] LOOP
          v := lower(btrim(coalesce(r ->> code, '')));
          IF v = '' THEN CONTINUE; END IF;
          IF v NOT IN ('yes', 'y', 'true', '1', 'no', 'n', 'false', '0') THEN
            PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/' || code, 'invalid', 'yes or no.')));
          END IF;
          yes := v IN ('yes', 'y', 'true', '1');
          IF NOT found OR yes IS DISTINCT FROM (to_jsonb(c) ->> code)::boolean THEN body := body || jsonb_build_object(code, yes); END IF;
        END LOOP;
        IF found AND body = '{}'::jsonb THEN n_same := n_same + 1;
        ELSIF found THEN PERFORM public.company_contact_save(pid, c.id, body, NULL); n_upd := n_upd + 1;
        ELSE PERFORM public.company_contact_save(pid, NULL, body || jsonb_build_object('name', btrim(r ->> 'name')), NULL); n_add := n_add + 1;
        END IF;
      ELSIF p_kind = 'company_documents' THEN
        v := lower(btrim(coalesce(r ->> 'type', '')));
        IF v = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/type', 'required', 'The document type is required.'))); END IF;
        SELECT * INTO ty FROM public.company_document_types t WHERE t.is_active AND (t.code = v OR lower(t.label_en) = v OR lower(coalesce(t.label_ar, '')) = v) ORDER BY t.sort_order LIMIT 1;
        IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/type', 'unknown_type', 'Choose a document type of Settings > Contractors > Documents.'))); END IF;
        FOREACH code IN ARRAY ARRAY['issued_on', 'expires_on'] LOOP
          IF btrim(coalesce(r ->> code, '')) <> '' AND btrim(r ->> code) !~ '^\d{4}-\d{2}-\d{2}$' THEN
            PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/' || code, 'invalid', 'A date as YYYY-MM-DD.')));
          END IF;
        END LOOP;
        dk := pid::text || '|' || ty.code || '|' || lower(btrim(coalesce(r ->> 'doc_number', ''))) || '|' || btrim(coalesce(r ->> 'expires_on', ''));
        IF dk = ANY (seen) THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/type', 'duplicate', 'This document appears twice in the file.'))); END IF;
        seen := seen || dk;
        -- the match: same company and type, and the same number (or, with no number in the file, the same expiry date); the newest one when several
        SELECT * INTO d FROM public.company_documents x WHERE x.party_id = pid AND x.type_code = ty.code AND x.is_active
          AND CASE WHEN btrim(coalesce(r ->> 'doc_number', '')) <> '' THEN lower(btrim(coalesce(x.doc_number, ''))) = lower(btrim(r ->> 'doc_number'))
                   ELSE x.expires_on IS NOT DISTINCT FROM nullif(btrim(coalesce(r ->> 'expires_on', '')), '')::date END
          ORDER BY x.created_at DESC LIMIT 1;
        found := FOUND;
        FOREACH code IN ARRAY ARRAY['title', 'doc_number', 'issued_on', 'expires_on', 'notes'] LOOP
          IF btrim(coalesce(r ->> code, '')) <> '' AND (NOT found OR btrim(r ->> code) IS DISTINCT FROM (to_jsonb(d) ->> code)) THEN body := body || jsonb_build_object(code, btrim(r ->> code)); END IF;
        END LOOP;
        v := lower(btrim(coalesce(r ->> 'is_active', '')));
        IF v <> '' THEN
          IF v NOT IN ('yes', 'y', 'true', '1', 'no', 'n', 'false', '0') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/is_active', 'invalid', 'yes or no.'))); END IF;
          yes := v IN ('yes', 'y', 'true', '1');
          IF NOT found OR yes IS DISTINCT FROM d.is_active THEN body := body || jsonb_build_object('is_active', yes); END IF;
        END IF;
        IF found AND body = '{}'::jsonb THEN n_same := n_same + 1;
        ELSIF found THEN PERFORM public.company_document_save(pid, d.id, body, NULL); n_upd := n_upd + 1;
        ELSE PERFORM public.company_document_save(pid, NULL, body || jsonb_build_object('type_code', ty.code), NULL); n_add := n_add + 1;
        END IF;
      ELSE
        v := lower(btrim(coalesce(r ->> 'item', '')));
        IF v = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/item', 'required', 'The checklist item is required.'))); END IF;
        SELECT * INTO it FROM public.company_onboarding_items t WHERE t.code = v OR lower(t.label_en) = v OR lower(coalesce(t.label_ar, '')) = v ORDER BY t.is_active DESC LIMIT 1;
        IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/item', 'unknown_item', 'Choose an item of Settings > Contractors > Onboarding.'))); END IF;
        dk := pid::text || '|' || it.code;
        IF dk = ANY (seen) THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/item', 'duplicate', 'This item appears twice for this company.'))); END IF;
        seen := seen || dk;
        v := lower(btrim(coalesce(r ->> 'status', '')));
        st := CASE replace(v, ' ', '_') WHEN 'not_started' THEN 'not_started' WHEN 'in_progress' THEN 'in_progress' WHEN 'approved' THEN 'approved' ELSE NULL END;
        IF st IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'invalid', 'Not started, In progress or Approved.'))); END IF;
        res := public.company_onboarding_apply(pid, it.code, st, nullif(btrim(coalesce(r ->> 'note', '')), ''));
        IF (res ->> 'changed')::boolean THEN n_upd := n_upd + 1; ELSE n_same := n_same + 1; END IF;
      END IF;
    EXCEPTION WHEN others THEN
      msg := SQLERRM;
      IF msg LIKE 'wf:%:%' THEN
        code := split_part(msg, ':', 2);
        BEGIN extra := substr(msg, length('wf:' || code || ':') + 1)::jsonb; EXCEPTION WHEN others THEN extra := '{}'::jsonb; END;
        IF jsonb_typeof(extra -> 'errors') = 'array' THEN
          FOR e IN SELECT * FROM jsonb_array_elements(extra -> 'errors') LOOP
            errs := errs || jsonb_build_array(jsonb_set(e, '{path}', to_jsonb('/rows/' || ln || coalesce(e ->> 'path', '/'))));
          END LOOP;
        ELSE
          errs := errs || public.reg_err_item('/rows/' || ln, code, coalesce(extra ->> 'detail', 'The row was refused.'));
        END IF;
      ELSE
        errs := errs || public.reg_err_item('/rows/' || ln, 'invalid', 'The row could not be applied.');
      END IF;
    END;
    EXIT WHEN jsonb_array_length(errs) >= 100;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs));
  END IF;
  PERFORM public.log_audit_write('company.template_import', 'company_import', import_id::text, NULL,
    jsonb_build_object('kind', p_kind, 'file_name', p_meta ->> 'file_name', 'template_version', p_meta -> 'template_version', 'rows', jsonb_array_length(p_rows),
                       'added', n_add, 'updated', n_upd, 'unchanged', n_same), NULL);
  RETURN jsonb_build_object('id', import_id, 'rows', jsonb_array_length(p_rows), 'added', n_add, 'updated', n_upd, 'unchanged', n_same);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and rights (0166 pattern)
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON company_onboarding_items, company_onboarding TO pmis_definer;
GRANT SELECT ON external_parties, users, company_contacts, company_documents, company_document_types TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  ALTER TABLE company_onboarding_items OWNER TO pmis_definer;
  ALTER TABLE company_onboarding OWNER TO pmis_definer;
  FOREACH f IN ARRAY ARRAY['company_onboarding_items_json()', 'admin_save_company_onboarding_items(jsonb,text,integer)', 'company_onboarding_json(uuid)',
    'company_onboarding_apply(uuid,text,text,text)', 'company_onboarding_set(uuid,text,text,text)', 'company_onboarding_bulk(uuid[],text,text,text)', 'company_onboarding_overview()',
    'tpl_company_contacts_columns()', 'tpl_company_documents_columns()', 'tpl_company_onboarding_columns()', 'company_export_rows(text,uuid[])', 'company_import_rows(text,jsonb,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON company_onboarding_items, company_onboarding FROM pmis_app;
    FOREACH f IN ARRAY ARRAY['company_onboarding_items_json()', 'admin_save_company_onboarding_items(jsonb,text,integer)', 'company_onboarding_json(uuid)', 'company_onboarding_set(uuid,text,text,text)',
      'company_onboarding_bulk(uuid[],text,text,text)', 'company_onboarding_overview()', 'company_export_rows(text,uuid[])', 'company_import_rows(text,jsonb,jsonb)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- Data reset coverage (0152): master data with external_parties (KEEP). data_reset_plan() is patched in place (0361 pattern), never redefined.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''company_onboarding''' IN def) = 0 THEN
    IF position('''company_documents''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the company tables of 0745 were not found'; END IF;
    def := replace(def, '''company_documents''', '''company_documents'', ''company_onboarding_items'', ''company_onboarding''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.company_onboarding_items, public.company_onboarding TO pmis_reset_owner;
