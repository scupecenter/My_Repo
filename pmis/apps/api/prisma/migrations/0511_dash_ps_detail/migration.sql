-- 0511_dash_ps_detail (contract 0.15.209): the dashboard card "Project Status detail" (the compact A1..A8 table whose items open and close;
-- approved by Ahmed 2026-11-27 20:22, relayed by the main agent). Mirror: db/sql/510_dash_ps_detail.sql (kept identical).
--
-- Additive: one card code, ps_detail, is added to the dashboard settings catalogue, so the card can be shown, hidden and ordered per
-- tab in Settings > Dashboard like every other card. A card in the catalogue that no saved list names is shown at the end, so the card
-- appears by default. No table, no data, no grant, no permission and no threshold changes; the figures are the activities and items that
-- GET /dashboard and GET /project-status already return.

-- The card joins the card catalogue by patching the stored function text (as 0260 does), never by replacing the whole function: a whole replacement
-- would drop a card another migration added (the goals card was lost that way). Idempotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ps_detail"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ps_detail","label_en":"Project Status detail: activities A1..A8 with their items","label_ar":"تفصيل حالة المشروع: الأنشطة A1..A8 وبنودها"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
