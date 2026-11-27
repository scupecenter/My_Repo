-- 0185_invoices_register: the Invoices register (owner approval 2026-11-27 via the project lead): the supplier and contractor invoices of the
-- project, from receipt to payment, linked to the procurement record they bill, with the dates the dashboard needs to show invoice ages.
-- Mirror: db/sql/184_invoices_register.sql (kept identical).
--
--   1. Lists InvoiceState and InvoiceKind (Settings > Dropdown lists: add, rename, reorder, hide; the codes never change). Cancelling is a state: nothing is deleted.
--   2. register_definitions row invoices (site-scoped, several per site, two levels: L1 Data Entry, L2 Data Reviewer & Approver), its fields and its Matrix row
--      (empty in the seed like every new register: the admin names the holders; until then a level with nobody goes to the System Admins' inbox).
--   3. The permission module invoices (no grant is seeded: no permission widening). The nav catalogue key.
--   4. The template TPL-INVOICES (match keys site + invoice number), issued by tpl_sync_all().
--   5. The Settings data reset: one resettable part, patched in place into data_reset_parts()/data_reset_register_part() (idempotent, anchored on the lessons row).
--   (The relation entry in record_related() is migration 0367, because that function is created by 0324, after this number.)
--
-- No new table and no new endpoint: the register framework runs the records, steps, levels and views. Existing registers and data are untouched.
SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('InvoiceState', 'Invoice state', 'حالة الفاتورة', false, 'pending', false, 'Where an invoice is between receipt and payment (owner approval 2026-11-27, Invoices).'),
  ('InvoiceKind',  'Invoice kind',  'نوع الفاتورة',  false, 'pending', false, 'Who or what an invoice bills (owner approval 2026-11-27, Invoices).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('InvoiceState', 'Received',     'Received',     'مستلمة',        10),
  ('InvoiceState', 'UnderReview',  'Under review', 'قيد المراجعة',  20),
  ('InvoiceState', 'Approved',     'Approved',     'معتمدة',        30),
  ('InvoiceState', 'Paid',         'Paid',         'مدفوعة',        40),
  ('InvoiceState', 'Disputed',     'Disputed',     'متنازع عليها',  50),
  ('InvoiceState', 'Cancelled',    'Cancelled',    'ملغاة',         60),
  ('InvoiceKind',  'Supplier',     'Supplier',     'مورّد',         10),
  ('InvoiceKind',  'Contractor',   'Contractor',   'مقاول',         20),
  ('InvoiceKind',  'Service',      'Service',      'خدمة',          30),
  ('InvoiceKind',  'Other',        'Other',        'أخرى',          40)
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('invoices', 'Invoices', 'الفواتير', 'invoices', 'register', true, true, ARRAY[]::text[], 2, '{"currency": "LYD"}'::jsonb, true, 200)
ON CONFLICT (register_key) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('invoices', 'invoice_no',              'Invoice No.',                 'رقم الفاتورة',                'text',      true,  false, false, NULL, true,  'Invoice', 10, NULL),
  ('invoices', 'invoice_kind',            'Kind',                        'النوع',                       'list_code', false, false, false, NULL, true,  'Invoice', 20, 'InvoiceKind'),
  ('invoices', 'supplier',                'Supplier / Contractor',       'المورّد / المقاول',           'text',      false, false, false, NULL, true,  'Invoice', 30, NULL),
  ('invoices', 'procurement_record_id',   'Order (Procurement record)',  'الطلب (سجل المشتريات)',       'text',      false, false, false, NULL, false, 'Invoice', 40, NULL),
  ('invoices', 'invoice_date',            'Invoice Date',                'تاريخ الفاتورة',              'date',      true,  true,  false, NULL, true,  'Invoice', 50, NULL),
  ('invoices', 'received_date',           'Received Date',               'تاريخ الاستلام',              'date',      false, true,  false, NULL, true,  'Invoice', 60, NULL),
  ('invoices', 'due_date',                'Due Date',                    'تاريخ الاستحقاق',             'date',      false, false, false, NULL, true,  'Invoice', 70, NULL),
  ('invoices', 'amount',                  'Amount (LYD)',                'المبلغ (دينار)',              'number',    true,  false, false, NULL, true,  'Amount',  80, NULL),
  ('invoices', 'invoice_state',           'Invoice state',               'حالة الفاتورة',               'list_code', false, false, false, NULL, true,  'Amount',  90, 'InvoiceState'),
  ('invoices', 'paid_date',               'Paid Date',                   'تاريخ الدفع',                 'date',      false, true,  false, NULL, true,  'Payment', 100, NULL),
  ('invoices', 'payment_ref',             'Payment reference',           'مرجع الدفع',                  'text',      false, false, false, NULL, false, 'Payment', 110, NULL),
  ('invoices', 'invoice_file',            'Invoice file',                'ملف الفاتورة',                'file',      false, false, false, NULL, false, 'Payment', 120, NULL),
  ('invoices', 'remark',                  'Remark',                      'ملاحظات',                     'text',      false, false, false, NULL, false, 'Remark',  130, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('invoices', 'registers', 30, '0185')
ON CONFLICT (key) DO NOTHING;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT 'TPL-INVOICES', r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, NULL, '[["site_code","invoice_no"]]'::jsonb, r.sort_order
FROM register_definitions r WHERE r.register_key = 'invoices'
ON CONFLICT (template_id) DO NOTHING;
SELECT tpl_sync_all();

-- data reset parts: patched in place (never redefined whole), anchored on the lessons_learned row of 0184
DO $$
DECLARE def text;
  marker text := '    (''lessons_learned'',    ''registers'', ''project'', 285, ''Lessons Learned'', ''الدروس المستفادة'', ''{sites}''::text[]),';
  add text := E'\n    (''invoices'',           ''registers'', ''project'', 290, ''Invoices'', ''الفواتير'', ''{sites,procurement}''::text[]),';
BEGIN
  def := pg_get_functiondef('public.data_reset_parts()'::regprocedure);
  IF position('''invoices''' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_parts() has no lessons_learned row to patch'; END IF;
    EXECUTE replace(def, marker, marker || add);
  END IF;
END $$;

DO $$
DECLARE def text; marker text := ', ''lessons_learned'') THEN p_key';
BEGIN
  def := pg_get_functiondef('public.data_reset_register_part(text)'::regprocedure);
  IF position('''invoices''' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_register_part() has no lessons_learned key to patch'; END IF;
    EXECUTE replace(def, marker, ', ''lessons_learned'', ''invoices'') THEN p_key');
  END IF;
END $$;
