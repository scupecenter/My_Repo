-- 0308_dash_ops_compare (contract 0.15.207): the dashboard follow-up card "Comparison of regions and contractors" (owner approval 2026-11-26,
-- dashboard proposals item 10). Mirror: db/sql/307_dash_ops_compare.sql (kept identical).
--
-- WHAT THIS ADDS (additive; no table, setting, grant or other function changes).
--   The card code ops_compare in the dashboard settings catalogue (migration 0108); the earlier cards are restated unchanged.
-- Already present and NOT rebuilt: the A4 landscape print of the dashboard (F6/F13) and the filters by project phase, delivery batch, site type and
-- tower owner (the unified filter, screen dashboard, 0.15.45). This package adds the quick dropdowns for them and the comparison card.

SELECT set_config('app.region_ids', '*', true);

-- The card joins the card catalogue by patching the stored function text (as 0260 does), never by replacing the whole function: a whole replacement
-- would drop a card another migration added (the goals card was lost that way). Idempotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_compare"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_compare","label_en":"Comparison: regions and contractors side by side","label_ar":"مقارنة المناطق والمقاولين جنباً إلى جنب"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
