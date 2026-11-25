-- 0153_backup_log_superuser: the server's backup script can write its System Log row again.
--
-- Owner report 2026-11-25: on the server, `db-backup.sh full` printed "full (full) to repository 1: ok" and then "could not write the System
-- Log row", so the data reset in Settings stayed blocked on "no successful backup within 24 hours".
--
-- Cause: the guard added by 0146 to log_system_write refuses the source 'backup' when pg_has_role(session_user, 'pmis_app', 'MEMBER') is true.
-- PostgreSQL answers true for a superuser on every role, and the backup scripts run as the postgres superuser (infra/backup/db-common.sh,
-- psql over the local socket), so the scripts were refused as if they were the API.
--
-- Fix: the guard applies to a session role that is not a superuser and is pmis_app or a member of it. The API (pmis_app, never a superuser,
-- checked by the DB-security suite) is still refused; the server's scripts (postgres) write the row. Redefined from its latest definition
-- (0146); the only change is the superuser exception. Owner, search_path, SECURITY DEFINER and the grants stay as they were.

CREATE OR REPLACE FUNCTION log_system_write(p_level text, p_source text, p_message text, p_context jsonb, p_user uuid, p_request_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- 0146: the backup precondition of the data reset reads these rows, so a pmis_app session (the API) can never write one.
  -- 0153: pg_has_role is true for a superuser on every role, so a superuser session (the server's backup scripts) is not treated as pmis_app.
  IF lower(btrim(coalesce(p_source, ''))) = 'backup'
     AND NOT coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), false)
     AND pg_has_role(session_user, 'pmis_app', 'MEMBER') THEN
    RAISE EXCEPTION 'the System Log source backup is written by the server''s backup scripts only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.system_log (level, source, message, context, user_id, request_id)
  VALUES (p_level::"LogLevel", left(coalesce(p_source, 'api'), 40), left(coalesce(p_message, ''), 2000),
    CASE WHEN p_context IS NULL OR length(p_context::text) <= 20000 THEN p_context ELSE jsonb_build_object('truncated', true) END,
    p_user, left(coalesce(p_request_id, public.log_ctx('request_id')), 64));
END $$;
