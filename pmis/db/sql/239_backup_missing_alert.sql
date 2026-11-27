-- 0240_backup_missing_alert: an admin alert when no backup succeeded in the last 24 hours (owner request 2026-11-26, relayed by the main agent; item 4).
--
-- Additive. The alert uses the existing security alert channel (security_alerts, sec_alert_raise_at: bell and mail to the System Admins as the alert
-- settings say) and the System Log. It reads the same System Log rows the data reset reads (source backup, level info, script db-backup, event
-- backup_ok, type full or diff: written by infra/backup/db-backup.sh). The window is a fixed 24 hours; it is not the data reset's backup_max_age_hours.
--   1. security_alerts_rule_check gains `backup_missing`.
--   2. Its default severity is high; the admin may change it like the other rules (sec_rule_default_severities).
--   3. backup_missing_check(): raises one alert per calendar day (dedup key) while the last success is older than 24 hours or there is none, and writes one
--      System Log row (source backup_check; the source `backup` stays reserved to the server's scripts). Returns 1 when it raised, 0 otherwise. Idempotent.

ALTER TABLE security_alerts DROP CONSTRAINT security_alerts_rule_check;
ALTER TABLE security_alerts ADD CONSTRAINT security_alerts_rule_check CHECK (rule IN ('failed_sign_ins', 'failed_sign_ins_ip', 'new_ip', 'large_export',
  'admin_set_changed', 'retention_reduced', 'alert_settings_weakened', 'audit_integrity_failure', 'malware_upload', 'break_glass_used', 'backup_missing'));

CREATE OR REPLACE FUNCTION sec_rule_default_severities() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT '{"failed_sign_ins": "medium", "failed_sign_ins_ip": "medium", "new_ip": "low", "large_export": "medium", "admin_set_changed": "high",
           "alert_settings_weakened": "high", "malware_upload": "high", "break_glass_used": "critical", "backup_missing": "high"}'::jsonb
$$;

CREATE OR REPLACE FUNCTION backup_missing_check() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ok record; today text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD'); raised boolean; ttl text; det jsonb;
BEGIN
  SELECT l.id, l.at, l.context INTO ok FROM public.system_log l
  WHERE l.source = 'backup' AND l.level = 'info' AND l.context ->> 'script' = 'db-backup' AND l.context ->> 'event' = 'backup_ok'
    AND l.context ->> 'type' IN ('full', 'diff')
  ORDER BY l.at DESC, l.id DESC LIMIT 1;
  IF ok.at IS NOT NULL AND ok.at > clock_timestamp() - interval '24 hours' THEN RETURN 0; END IF;
  ttl := CASE WHEN ok.at IS NULL THEN 'No successful backup is recorded'
              ELSE 'No successful backup in the last 24 hours (the last one: ' || to_char(ok.at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC)' END;
  det := jsonb_build_object('window_hours', 24, 'last_success_at', ok.at, 'last_success_system_log_id', ok.id, 'type', ok.context ->> 'type');
  raised := public.sec_alert_raise('backup_missing', 'high', ttl, det, 'backup_missing:' || today);
  IF raised THEN
    PERFORM public.log_system_write('warn', 'backup_check', ttl, det, NULL, NULL);
    RETURN 1;
  END IF;
  RETURN 0;
END $$;

DO $$
BEGIN
  ALTER FUNCTION backup_missing_check() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION backup_missing_check() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION backup_missing_check() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION backup_missing_check() TO pmis_app;
  END IF;
END $$;
