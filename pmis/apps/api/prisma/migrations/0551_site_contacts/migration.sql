-- 0551_site_contacts: the Site Contacts book (item C6, agreed 2026-11-26): the people a site depends on (landlord, municipality, security, GECOL, HLC,
-- contractor contacts) in one place, linked to the registers that need them (a site access request goes to several parties).
-- Mirror: db/sql/550_site_contacts.sql (kept identical to prisma/migrations/0551_site_contacts/migration.sql).
--
-- What exists already and is reused (checked before building): external_parties (companies of the Contractors list: the contact points to one, no second company
-- list), sites and regions (row scope), the register framework (records, two approval levels, Matrix row, field settings, import template, audit), the list
-- catalogue (Settings > Dropdown lists), register_links (D60: declared links, picker, Related records panel, optional check). Nothing of this is copied.
-- There was no contacts table or screen before (users are staff; external_teams have no phone or e-mail).
--
--   1. List ContactRole (Settings > Dropdown lists: add, rename, reorder, hide; the codes never change).
--   2. Register site_contacts: site-scoped, several per site, two levels (L1 Data Entry, L2 Data Reviewer & Approver), Matrix row empty (the convention of
--      0076: the admin chooses who enters and approves; a level with nobody goes to the System Admins' inbox). Fields: name, role, company (a Contractors-list
--      company), organization (free text, filled from the company), phone, second phone, e-mail, other sites it serves, links to the acquisition, permit,
--      GECOL and HLC record, access note, valid to, remark.
--   3. Row trigger site_contacts_rules: in entry only, only for a changed value. Auto-fill: the organization from the company when empty; the e-mail is lower
--      case and trimmed. Checks: the e-mail looks like an address, the phone has digits only (plus a leading + and spaces/dashes), the company is an active company,
--      each link id is a uuid. The check that a link points to a current record of the right register and site is the generic one of register_links (declared
--      below, enforce off, so nothing is refused until the admin switches it on in Settings).
--   4. Read scope: the module site_contacts gets the view right for exactly the profiles that already view Acquisition (Ahmed: "inherit the acquisition
--      register's read scope per region"). The regions come from the user's assignments as always. No create, edit, approve or other right is given: those start
--      with the System Admins. No role or region changes.
--   5. Nav catalogue key, import template, the Settings data reset part (the register is one resettable part), the register links declaration.
-- No new table, no new endpoint. Existing registers, records and rights are untouched. Nothing is deleted.
SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('ContactRole', 'Contact role', 'دور جهة الاتصال', false, 'pending', false, 'Who a Site Contacts record is (C6).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('ContactRole', 'Landlord',     'Landlord / site owner', 'مالك الموقع',      10),
  ('ContactRole', 'Municipality', 'Municipality',          'البلدية',          20),
  ('ContactRole', 'Security',     'Security / guard',      'الأمن / الحراسة',   30),
  ('ContactRole', 'GECOL',        'GECOL contact',         'جهة اتصال GECOL',  40),
  ('ContactRole', 'HLC',          'HLC contact',           'جهة اتصال HLC',    50),
  ('ContactRole', 'Contractor',   'Contractor contact',    'جهة اتصال المقاول', 60),
  ('ContactRole', 'Access',       'Access / gate keeper',  'مسؤول الدخول',     70),
  ('ContactRole', 'Other',        'Other',                 'أخرى',             80)
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('site_contacts', 'Site Contacts', 'جهات اتصال المواقع', 'site_contacts', 'register', true, true, ARRAY[]::text[], 2, '{}'::jsonb, true, 195)
ON CONFLICT (register_key) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('site_contacts', 'contact_name',          'Contact name',            'اسم جهة الاتصال',        'text',       true,  false, false, NULL, true,  'Contact', 10,  NULL),
  ('site_contacts', 'contact_role',          'Role',                    'الدور',                  'list_code',  true,  false, false, NULL, true,  'Contact', 20,  'ContactRole'),
  ('site_contacts', 'party_id',              'Company (Contractors list)', 'الشركة (قائمة المقاولين)', 'text',  false, false, false, NULL, false, 'Contact', 30,  NULL),
  ('site_contacts', 'organization',          'Organization',            'الجهة',                  'text',       false, false, false, NULL, true,  'Contact', 40,  NULL),
  ('site_contacts', 'phone',                 'Phone',                   'الهاتف',                 'text',       false, false, false, NULL, true,  'Contact', 50,  NULL),
  ('site_contacts', 'phone_alt',             'Second phone',            'هاتف ثانٍ',              'text',       false, false, false, NULL, false, 'Contact', 60,  NULL),
  ('site_contacts', 'email',                 'E-mail',                  'البريد الإلكتروني',      'text',       false, false, false, NULL, true,  'Contact', 70,  NULL),
  ('site_contacts', 'also_site_ids',         'Also serves these sites', 'يخدم المواقع التالية أيضًا', 'multi_site', false, false, false, NULL, false, 'Links', 80, NULL),
  ('site_contacts', 'acquisition_record_id', 'Acquisition record',      'سجل الاستحواذ',          'text',       false, false, false, NULL, false, 'Links', 90,  NULL),
  ('site_contacts', 'permit_record_id',      'Permit record',           'سجل التصريح',            'text',       false, false, false, NULL, false, 'Links', 100, NULL),
  ('site_contacts', 'gecol_record_id',       'GECOL record',            'سجل GECOL',              'text',       false, false, false, NULL, false, 'Links', 110, NULL),
  ('site_contacts', 'hlc_record_id',         'HLC record',              'سجل HLC',                'text',       false, false, false, NULL, false, 'Links', 120, NULL),
  ('site_contacts', 'access_note',           'Access note',             'ملاحظة الدخول',          'text',       false, false, false, NULL, false, 'Remark', 130, NULL),
  ('site_contacts', 'valid_to',              'Valid to',                'صالح حتى',               'date',       false, false, false, NULL, true,  'Remark', 140, NULL),
  ('site_contacts', 'remark',                'Remark',                  'ملاحظات',                'text',       false, false, false, NULL, false, 'Remark', 150, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION site_contacts_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := NEW.data; errs jsonb := '[]'::jsonb; pn text; f text;
  uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
  changed boolean;
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  -- auto-fill: the e-mail is stored trimmed and in lower case
  IF coalesce(d ->> 'email', '') <> '' AND d ->> 'email' <> lower(btrim(d ->> 'email')) THEN
    NEW.data := jsonb_set(NEW.data, '{email}', to_jsonb(lower(btrim(d ->> 'email')))); d := NEW.data;
  END IF;
  IF coalesce(d ->> 'email', '') <> '' AND NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'email' IS NOT DISTINCT FROM d ->> 'email')
     AND d ->> 'email' !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    errs := errs || public.reg_err_item('/data/email', 'invalid_email', 'Not an e-mail address.');
  END IF;
  FOREACH f IN ARRAY ARRAY['phone', 'phone_alt'] LOOP
    IF coalesce(d ->> f, '') <> '' AND NOT (TG_OP = 'UPDATE' AND OLD.data ->> f IS NOT DISTINCT FROM d ->> f)
       AND d ->> f !~ '^\+?[0-9][0-9 ()-]{4,24}$' THEN
      errs := errs || public.reg_err_item('/data/' || f, 'invalid_phone', 'Digits only, with an optional leading +, spaces, dashes or brackets.');
    END IF;
  END LOOP;
  IF coalesce(d ->> 'party_id', '') = '' THEN NEW.data := NEW.data - 'party_id';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'party_id' IS NOT DISTINCT FROM d ->> 'party_id') THEN
    IF d ->> 'party_id' !~* uuid_re THEN
      errs := errs || public.reg_err_item('/data/party_id', 'invalid', 'A company id.');
    ELSE
      SELECT x.name INTO pn FROM public.external_parties x WHERE x.id = (d ->> 'party_id')::uuid AND x.is_active;
      IF NOT FOUND THEN errs := errs || public.reg_err_item('/data/party_id', 'unknown_company', 'Not an active company of the Contractors list.');
      ELSIF coalesce(d ->> 'organization', '') = '' THEN NEW.data := jsonb_set(NEW.data, '{organization}', to_jsonb(pn));   -- auto-fill
      END IF;
    END IF;
  END IF;
  FOREACH f IN ARRAY ARRAY['acquisition_record_id', 'permit_record_id', 'gecol_record_id', 'hlc_record_id'] LOOP
    IF coalesce(d ->> f, '') = '' THEN NEW.data := NEW.data - f;
    ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> f IS NOT DISTINCT FROM d ->> f) AND d ->> f !~* uuid_re THEN
      errs := errs || public.reg_err_item('/data/' || f, 'invalid', 'A record id.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_site_contacts_rules ON register_records;
CREATE TRIGGER b_site_contacts_rules BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'site_contacts') EXECUTE FUNCTION site_contacts_rules();

-- read scope: the profiles that already view Acquisition also view Site Contacts (view only; the regions come from their assignments)
INSERT INTO permission_grants (profile_id, module_key, action)
SELECT g.profile_id, 'site_contacts', 'view'::"PermissionAction" FROM permission_grants g WHERE g.module_key = 'acquisition' AND g.action = 'view'::"PermissionAction"
ON CONFLICT DO NOTHING;

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('site_contacts', 'registers', 36, '0551')
ON CONFLICT (key) DO NOTHING;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT 'TPL-SITE-CONTACTS', r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, NULL, '[["site_code","contact_name","contact_role"]]'::jsonb, r.sort_order
FROM register_definitions r WHERE r.register_key = 'site_contacts'
ON CONFLICT (template_id) DO NOTHING;
SELECT tpl_sync_all();

-- the declared links (D60): shown in the Related records panel of both sides and picked from the generic picker; enforce stays off until the admin
-- switches it on. Declared only when register_links exists (it is created by 0409, which runs before this migration on every database that has it).
DO $$
BEGIN
  IF to_regclass('public.register_links') IS NOT NULL THEN
    INSERT INTO public.register_links (register_key, field_code, target_register, target_record_type, same_site, label_fields, enforce, sort_order)
    SELECT v.* FROM (VALUES
      ('site_contacts', 'acquisition_record_id', 'acquisition', NULL, true, ARRAY['owner_landlord', 'address'], false, 200),
      ('site_contacts', 'permit_record_id',      'permits_hse', NULL, true, ARRAY['permit_type', 'status'],     false, 210),
      ('site_contacts', 'gecol_record_id',       'gecol',       NULL, true, ARRAY['pr_no', 'contractor'],      false, 220),
      ('site_contacts', 'hlc_record_id',         'hlc',         NULL, true, ARRAY['request_no', 'fiber_status'],        false, 230)
    ) v(register_key, field_code, target_register, target_record_type, same_site, label_fields, enforce, sort_order)
    WHERE EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = v.target_register)
    ON CONFLICT (register_key, field_code) DO NOTHING;
  END IF;
END $$;

-- data_reset_parts()/data_reset_register_part(): patched in place and idempotently (0184 pattern), anchored on the invoices row/key of 0185
DO $$
DECLARE def text;
  marker text := '    (''invoices'',           ''registers'', ''project'', 290, ''Invoices'', ''الفواتير'', ''{sites,procurement}''::text[]),';
  add text := E'\n    (''site_contacts'',      ''registers'', ''project'', 295, ''Site Contacts'', ''جهات اتصال المواقع'', ''{sites}''::text[]),';
BEGIN
  def := pg_get_functiondef('public.data_reset_parts()'::regprocedure);
  IF position('site_contacts' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_parts() has no invoices row to patch'; END IF;
    EXECUTE replace(def, marker, marker || add);
  END IF;
END $$;

DO $$
DECLARE def text; marker text := ', ''invoices'') THEN p_key';
BEGIN
  def := pg_get_functiondef('public.data_reset_register_part(text)'::regprocedure);
  IF position('site_contacts' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_register_part() has no invoices key to patch'; END IF;
    EXECUTE replace(def, marker, ', ''invoices'', ''site_contacts'') THEN p_key');
  END IF;
END $$;
