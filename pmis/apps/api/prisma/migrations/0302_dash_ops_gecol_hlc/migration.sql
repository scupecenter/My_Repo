-- 0302_dash_ops_gecol_hlc (contract 0.15.201): the dashboard follow-up card "Power and fiber readiness" (owner approval
-- 2026-11-26, dashboard proposals item 4). Mirror: db/sql/301_dash_ops_gecol_hlc.sql (kept identical).
--
-- Additive: one card code, ops_gecol_hlc, is added to the dashboard settings catalogue (migration 0108), so the card can be shown,
-- hidden and ordered per tab in Settings > Dashboard like every other card; the cards of 0189, 0190 and 0191 are restated unchanged.
-- A card in the catalogue that no saved list names is shown at the end, so the card appears by default. No table, no data, no
-- grant, no permission and no threshold changes.

-- The card joins the card catalogue by patching the stored function text (as 0260 does), never by replacing the whole function: a whole replacement
-- would drop a card another migration added (the goals card was lost that way). Idempotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_gecol_hlc"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_gecol_hlc","label_en":"Power and fiber readiness: GECOL and HLC waiting sites by age","label_ar":"جاهزية الكهرباء والألياف: مواقع GECOL وHLC المنتظرة حسب العمر"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
