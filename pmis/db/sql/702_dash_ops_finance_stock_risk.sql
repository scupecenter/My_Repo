-- 0703_dash_ops_finance_stock_risk (contract 0.15.563): three dashboard cards from the L4 priority map: invoice ages and due dates (ops_invoices), pending warehouse movements
-- (ops_warehouse) and stale open risks and issues (ops_stale). Mirror: db/sql/702_dash_ops_finance_stock_risk.sql (kept identical).
--
-- Additive: three card codes are added to the dashboard settings catalogue (migration 0108), so each card can be shown, hidden and ordered per tab in Settings > Dashboard like
-- every other ops card (0300-0306); the stored function text is patched, never replaced whole, so every other card stays. A card in the catalogue that no saved list names is
-- shown at the end, so the cards appear by default. No table, no data, no grant, no permission and no threshold change. Read only.

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_invoices"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_invoices","label_en":"Invoices: ages, due dates and overdue","label_ar":"الفواتير: الأعمار وتواريخ الاستحقاق والمتأخر"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_warehouse"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_warehouse","label_en":"Warehouse: movements waiting for entry, review or approval","label_ar":"المخازن: الحركات بانتظار الإدخال أو المراجعة أو الاعتماد"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_stale"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_stale","label_en":"Stale open risks and issues","label_ar":"المخاطر والمشكلات المفتوحة الراكدة"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
