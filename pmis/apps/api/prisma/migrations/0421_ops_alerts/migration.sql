-- 0421_ops_alerts: two admin alerts for operations (production readiness review, item 4; owner approval D62 relayed by the main agent).
--
-- Additive. Both use the existing security alert channel (security_alerts, sec_alert_raise: bell and mail to the System Admins as the alert settings
-- say, severity editable in Settings like the other rules). mail.notification_kinds is NOT touched (decision Q250).
--   1. security_alerts_rule_check gains `backup_late` and `job_failed`; sec_rule_default_severities gains backup_late high and job_failed medium.
--      Both are PATCHED IN PLACE from the stored text (idempotent), never rewritten from an old base, so rules added by other migrations stay.
--   2. backup_late_alert(message): called by infra/backup/db-backup-check.sh (as the database superuser) when WAL archiving or a backup is late.
--      One alert per 6 hours (dedup key by hour bucket of 6). Returns true when it raised.
--   3. job_failed_alert(job, error): called by the API when a background job run fails. One alert per job and calendar day.
-- No new table, no new right.

DO $$
DECLARE def text; cn text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c WHERE c.conrelid = 'public.security_alerts'::regclass AND c.conname = 'security_alerts_rule_check';
  IF def IS NOT NULL AND def NOT LIKE '%backup_late%' THEN
    def := replace(def, '''backup_missing''::text', '''backup_missing''::text, ''backup_late''::text, ''job_failed''::text');
    IF def NOT LIKE '%backup_late%' THEN RAISE EXCEPTION 'security_alerts_rule_check: unexpected definition'; END IF;
    ALTER TABLE public.security_alerts DROP CONSTRAINT security_alerts_rule_check;
    EXECUTE 'ALTER TABLE public.security_alerts ADD CONSTRAINT security_alerts_rule_check ' || def;
  END IF;
END $$;

DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef('public.sec_rule_default_severities()'::regprocedure) INTO def;
  IF def NOT LIKE '%backup_late%' THEN
    def := replace(def, '"backup_missing": "high"', '"backup_missing": "high", "backup_late": "high", "job_failed": "medium"');
    IF def NOT LIKE '%backup_late%' THEN RAISE EXCEPTION 'sec_rule_default_severities: unexpected definition'; END IF;
    EXECUTE def;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION backup_late_alert(p_message text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bucket text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '-' || (extract(hour FROM clock_timestamp() AT TIME ZONE 'UTC')::int / 6)::text;
        msg text := left(coalesce(nullif(btrim(p_message), ''), 'The database backup check found a problem'), 500);
BEGIN
  RETURN public.sec_alert_raise('backup_late', 'high', 'Database backup or WAL archiving is late', jsonb_build_object('message', msg), 'backup_late:' || bucket);
END $$;

CREATE OR REPLACE FUNCTION job_failed_alert(p_job text, p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE today text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD'); j text := left(coalesce(nullif(btrim(p_job), ''), 'unknown'), 80);
BEGIN
  RETURN public.sec_alert_raise('job_failed', 'medium', 'A background job failed: ' || j,
    jsonb_build_object('job', j, 'error', left(coalesce(p_error, ''), 300)), 'job_failed:' || j || ':' || today);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['backup_late_alert(text)', 'job_failed_alert(text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION job_failed_alert(text, text) TO pmis_app;  -- the API raises it; backup_late_alert is for the database superuser script only
  END IF;
END $$;
