-- 0361: the Dashboard card "goals" is back in the card catalogue of Settings, Screens, Dashboard.
--
-- WHY. Migration 0260 (goals) added the card by rewriting the stored text of dashboard_settings_catalogue(). Migration 0300 (progress curve, ops_scurve) later
-- replaced the whole function from the 0230 text, which had no goals card, so on a fresh database the catalogue lost it (test/goals.test.ts failed on main).
-- WHAT. The same idempotent rewrite as 0260, run again from the stored text: it adds the goals card after the regions card only if it is missing, and nothing else
-- in the catalogue changes (the ops_procurement and ops_scurve cards stay). Safe to run twice. No table, no permission, no data change.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"goals"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"goals","label_en":"Goals with automatic progress","label_ar":"الأهداف مع التقدم التلقائي"},' || chr(10) || '      {"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
