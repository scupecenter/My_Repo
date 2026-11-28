-- 0643: the register rules screen lists the rules keys of every register (contract 0.15.572). Until now the screen (0430) edited only the three keys of Invoices, and
-- the other keys of a register (the currency of Financial Advances, whether a register is part of the Master workbook, the scope maps of Procurement, Permits and the
-- Quality teams) could only be read or changed by SQL. Now:
--   1. register_rule_catalogue() also lists the keys that are simple and that the database reads: financial_advances.currency (text, default LYD) and master_export
--      (yes/no, default yes) of the registers that carry it (car_dispatcher, financial_advances, daily_plan). Patched in place (stored text, asserted, idempotent).
--      Keys that nothing reads (counts_as_purchase_request, purchase_request_in) are not offered.
--   2. reg_rules_json() lists every active register that has rules, and gives per register `other`: the keys that are not in the catalogue (scope maps, scopes, field
--      lists, the Daily Plan levels), read only on the screen. Patched in place.
-- The writer (admin_register_rules) is unchanged: it still accepts only keys of the catalogue, with a reason, the ETag and the audit. Additive: two patched functions,
-- no table, no grant, no permission change.

DO $$
DECLARE def text; n text; cnt int;
BEGIN
  def := pg_get_functiondef('public.register_rule_catalogue()'::regprocedure);
  IF position('master_export' IN def) = 0 THEN
    n := E'''label_ar'', ''الفاتورة يجب أن تحدد شركة المورّد''))';
    cnt := (length(def) - length(replace(def, n, ''))) / length(n);
    IF cnt <> 1 THEN RAISE EXCEPTION 'register_rule_catalogue: the end of the list is there % times, expected 1', cnt; END IF;
    def := replace(def, n, E'''label_ar'', ''الفاتورة يجب أن تحدد شركة المورّد''),\n'
      || E'    jsonb_build_object(''register_key'', ''financial_advances'', ''key'', ''currency'', ''type'', ''text'', ''default'', ''LYD'',\n'
      || E'      ''label_en'', ''Currency of the advances'', ''label_ar'', ''عملة العهد''),\n'
      || E'    jsonb_build_object(''register_key'', ''financial_advances'', ''key'', ''master_export'', ''type'', ''boolean'', ''default'', true,\n'
      || E'      ''label_en'', ''Include this register in the Master workbook (the Master template changes: download it again)'', ''label_ar'', ''تضمين هذا السجل في ملف الماستر (يتغير قالب الماستر: نزّله من جديد)''),\n'
      || E'    jsonb_build_object(''register_key'', ''car_dispatcher'', ''key'', ''master_export'', ''type'', ''boolean'', ''default'', true,\n'
      || E'      ''label_en'', ''Include this register in the Master workbook (the Master template changes: download it again)'', ''label_ar'', ''تضمين هذا السجل في ملف الماستر (يتغير قالب الماستر: نزّله من جديد)''),\n'
      || E'    jsonb_build_object(''register_key'', ''daily_plan'', ''key'', ''master_export'', ''type'', ''boolean'', ''default'', true,\n'
      || E'      ''label_en'', ''Include this register in the Master workbook (the Master template changes: download it again)'', ''label_ar'', ''تضمين هذا السجل في ملف الماستر (يتغير قالب الماستر: نزّله من جديد)''))');
    EXECUTE def;
  END IF;
END $$;

DO $$
DECLARE def text; n text; cnt int;
BEGIN
  def := pg_get_functiondef('public.reg_rules_json()'::regprocedure);
  IF position('''other''' IN def) = 0 THEN
    n := E'''rules'', d.rules, ''version'', d.version)';
    cnt := (length(def) - length(replace(def, n, ''))) / length(n);
    IF cnt <> 1 THEN RAISE EXCEPTION 'reg_rules_json: the item line is there % times, expected 1', cnt; END IF;
    def := replace(def, n, E'''rules'', d.rules, ''version'', d.version,\n'
      || E'      ''other'', (SELECT coalesce(jsonb_object_agg(e.key, e.value), ''{}''::jsonb) FROM jsonb_each(coalesce(d.rules, ''{}''::jsonb)) e\n'
      || E'                 WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.register_rule_catalogue()) c WHERE c ->> ''register_key'' = d.register_key AND c ->> ''key'' = e.key)))');
    n := E'AND d.register_key IN (SELECT DISTINCT c ->> ''register_key'' FROM jsonb_array_elements(public.register_rule_catalogue()) c)';
    cnt := (length(def) - length(replace(def, n, ''))) / length(n);
    IF cnt <> 1 THEN RAISE EXCEPTION 'reg_rules_json: the register filter is there % times, expected 1', cnt; END IF;
    def := replace(def, n, E'AND (coalesce(d.rules, ''{}''::jsonb) <> ''{}''::jsonb OR d.register_key IN (SELECT DISTINCT c ->> ''register_key'' FROM jsonb_array_elements(public.register_rule_catalogue()) c))');
    EXECUTE def;
  END IF;
END $$;
