-- 0576_settings_change_log (contract 0.15.433): a read-only change log for the Dashboard settings and the Goals settings.
-- Mirror: db/sql/575_settings_change_log.sql (kept byte-identical).
--
-- Both screens show only a version number and the last editor. Every save already writes an audit row with the actor, the time, the reason and the values before
-- and after (dashboard_settings_update, goals_update and the guarded writers of the single dashboard settings). This migration adds only a guarded reader of those
-- rows, no new table and no new write:
--   settings_change_log(scope, limit): scope 'dashboard' (dashboard.settings, health bands, snapshot weekday, forecast window, progress colours) or 'goals'
--   (dashboard.goals); newest first, at most 200 rows; each row has the time, the actor, the action, the setting, the reason and the list of fields that changed
--   with their before and after values (the top level of the saved value; the catalogue and the version counter are left out).
-- Rights: the reader of the Settings screen (admin.settings view) is checked by the API; the function itself needs a signed-in actor and reads only the audit rows
-- of those settings. It never returns another entity's audit rows, so the audit log's own reader rules are not widened.

CREATE OR REPLACE FUNCTION settings_change_log(p_scope text, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids text[]; lim int := least(greatest(coalesce(p_limit, 50), 1), 200); out jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_scope = 'dashboard' THEN
    ids := ARRAY['dashboard.settings', 'dashboard.health_bands', 'dashboard.snapshot_weekday', 'dashboard.forecast_window_weeks', 'dashboard.progress_rag'];
  ELSIF p_scope = 'goals' THEN
    ids := ARRAY['dashboard.goals'];
  ELSE
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/scope', 'invalid', 'dashboard or goals.')));
  END IF;
  SELECT coalesce(jsonb_agg(r ORDER BY (r ->> 'id')::bigint DESC), '[]'::jsonb) INTO out FROM (
    SELECT jsonb_build_object(
             'id', a.id,
             'at', a.at,
             'action', a.action,
             'setting', a.entity_id,
             'reason', a.reason,
             'actor', CASE WHEN a.actor_id IS NULL THEN NULL ELSE jsonb_build_object('id', a.actor_id, 'display_name', coalesce(u.display_name, ''), 'employee_id', nullif(btrim(u.employee_id), '')) END,
             'changes', coalesce((
               SELECT jsonb_agg(jsonb_build_object('field', k, 'before', b.value -> k, 'after', n.value -> k) ORDER BY k)
                 FROM (SELECT coalesce(a.before, '{}'::jsonb) - 'catalogue' - 'version' AS value) b,
                      (SELECT coalesce(a.after, '{}'::jsonb) - 'catalogue' - 'version' AS value) n,
                      LATERAL (SELECT jsonb_object_keys(b.value || n.value) AS k) ks
                WHERE (b.value -> k) IS DISTINCT FROM (n.value -> k)), '[]'::jsonb)) AS r
      FROM public.audit_log a LEFT JOIN public.users u ON u.id = a.actor_id
     WHERE a.entity_type = 'setting' AND a.entity_id = ANY (ids)
     ORDER BY a.id DESC LIMIT lim) q;
  RETURN out;
END
$$;

DO $$
BEGIN
  ALTER FUNCTION settings_change_log(text, integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION settings_change_log(text, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION settings_change_log(text, integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION settings_change_log(text, integer) TO pmis_app;
  END IF;
END $$;
