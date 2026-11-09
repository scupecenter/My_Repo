-- 0082_nav_system_log: the System Log screen under "Logs & monitoring" (owner request of 2026-11-09; CHANGELOG 121, contract 0.15.2).
-- Mirror: db/sql/081_nav_system_log.sql (kept byte-identical).
--
-- WHAT.
--   1. The side-menu catalogue of 0081 gains the key logs.system (default heading logs), so a saved layout that holds the new screen is valid. Until a layout
--      is saved again the web appends the screen at the end of its default heading (resolveLayout); nothing else in a saved layout changes. Idempotent.
--   2. Saved views (0065) know the list screen system-log: its module is admin.system_log, so a view of the screen is shared only with people who may read
--      the System Log (a System Admin or view on admin.system_log, the rule of GET /system-log, log_can_read_ops of 0045). The body of sv_screen_module is
--      copied unchanged from 0065 with the one new line; owner, search_path and grants stay as they are.
-- No new right, no new table, no change to the System Log itself.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The menu catalogue
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('logs.system', 'logs', 43, '0082')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Saved views of the System Log screen
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_screen_module(p_screen text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_screen IS NULL THEN RETURN NULL; END IF;
  IF p_screen ~ '^register-[a-z0-9_]{2,60}$' THEN
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = substr(p_screen, 10) AND d.is_active);
  END IF;
  RETURN CASE p_screen
    WHEN 'sites' THEN 'sites'
    WHEN 'sites-stream' THEN 'sites'
    WHEN 'site-tasks' THEN 'sites'
    WHEN 'audit-log' THEN 'audit'
    WHEN 'field-changes' THEN 'audit'
    WHEN 'security-log' THEN 'admin.security_log'
    WHEN 'system-log' THEN 'admin.system_log'
    ELSE NULL END;
END $$;
