-- Region health card (contract 0.15.241; CHANGELOG RegionHealth; owner request 2026-11-27, item 12 of the PM-platforms research).
--
-- One new dashboard card, region_health: the current-week health of every region of the Weekly status (on track, at risk, off track) with the
-- "missing update" flag when no region update was posted this week. Additive: the catalogue gains the card, and a card no tab layout names is shown
-- at the end by default (migration 0108), so existing layouts do not change. The data is read by GET /status-updates/region-health (no table, no
-- permission change: the same Sites regions scope as the Weekly status list).


-- The catalogue is an accumulating function: patch the stored text idempotently (the 0361 pattern), never replace it from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"region_health"' IN def) = 0 THEN
    IF position('{"code":"regions","label_en"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions","label_en":"Regions","label_ar":"المناطق"},', '{"code":"regions","label_en":"Regions","label_ar":"المناطق"},' || chr(10) || '      {"code":"region_health","label_en":"Region health","label_ar":"صحة المناطق"},');
    EXECUTE def;
  END IF;
END $$;
