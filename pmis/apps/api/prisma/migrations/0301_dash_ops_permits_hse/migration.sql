-- 0301_dash_ops_permits_hse (contract 0.15.200): the dashboard follow-up card "Permits and HSE" (owner approval 2026-11-26,
-- dashboard proposals item 3). Mirror: db/sql/300_dash_ops_permits_hse.sql (kept identical).
--
-- Additive: one card code, ops_permits_hse, is added to the dashboard settings catalogue (migration 0108), so the card can be shown,
-- hidden and ordered per tab in Settings > Dashboard like every other card; the stored function text is patched, so
-- every other card stays as it is. A card in the catalogue that no saved list names is shown at the end, so the card appears by
-- default. No table, no data, no grant, no permission and no threshold changes.

-- The card joins the card catalogue by patching the stored function text (as 0260 does), never by replacing the whole function: a whole replacement
-- would drop a card another migration added (the goals card was lost that way). Idempotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_permits_hse"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_permits_hse","label_en":"Permits and HSE: status, validity, stop-work and PTW checks","label_ar":"التصاريح والسلامة: الحالة والصلاحية وإيقاف العمل وفحوصات تصاريح العمل"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
