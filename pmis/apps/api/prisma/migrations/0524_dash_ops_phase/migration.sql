-- 0524_dash_ops_phase (contract 0.15.367): the dashboard card "Phase scope" (sites per project phase with progress and derived targets;
-- approved by Ahmed 2026-11-27 20:28, relayed by the main agent). Mirror: db/sql/523_dash_ops_phase.sql (kept identical).
--
-- Additive: one card code, ops_phase, is added to the dashboard settings catalogue, so the card can be shown, hidden and ordered per
-- tab in Settings > Dashboard like every other card. A card in the catalogue that no saved list names is shown at the end, so the card
-- appears by default. No table, no data, no grant, no permission and no threshold changes; the figures come from the sites table
-- through GET /dashboard/ops.

-- The card joins the card catalogue by patching the stored function text (as 0260 does), never by replacing the whole function: a whole replacement
-- would drop a card another migration added (the goals card was lost that way). Idempotent: nothing happens when the card is already there.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"ops_phase"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"ops_phase","label_en":"Phase scope: sites per project phase, progress and derived targets","label_ar":"نطاق المراحل: المواقع لكل مرحلة والتقدم والمستهدفات المشتقة"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
