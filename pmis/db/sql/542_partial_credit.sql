-- 0543: partial credit for in-progress tasks (PMI EVM percent-complete by level of effort inside
-- a task): a task that is applicable but not yet approved earns current_level / levels_required
-- of its item fraction. OFF by default (setting progress.partial_credit, {"enabled": bool});
-- a System Admin switches it in Settings with a reason. When off, every expression below
-- reduces exactly to the previous one (part = 0 everywhere). Frozen site snapshots keep their
-- integer counts (part = 0): partial credit is a live-view feature and never rewrites history.

CREATE OR REPLACE FUNCTION progress_partial_credit() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT coalesce((SELECT (s.value ->> 'enabled')::boolean FROM public.settings s WHERE s.key = 'progress.partial_credit'), false)
$$;

CREATE OR REPLACE FUNCTION progress_partial_credit_json() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
  SELECT jsonb_build_object('enabled', public.progress_partial_credit(), 'version', coalesce((s.value ->> 'version')::int, 0),
           'updated_at', s.updated_at, 'updated_by', s.updated_by)
  FROM public.settings s WHERE s.key = 'progress.partial_credit'
$$;

CREATE OR REPLACE FUNCTION admin_save_progress_partial_credit(p_enabled boolean, p_reason text, p_version integer) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE cur jsonb; v int; before jsonb;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'partial credit: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(public.reg_err_item('/enabled', 'required', 'true or false.')))); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'progress.partial_credit' FOR UPDATE;
  SELECT value INTO cur FROM public.settings WHERE key = 'progress.partial_credit';
  v := coalesce((cur ->> 'version')::int, 0);
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF coalesce((cur ->> 'enabled')::boolean, false) IS NOT DISTINCT FROM p_enabled THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  before := jsonb_build_object('enabled', coalesce((cur ->> 'enabled')::boolean, false));
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('progress.partial_credit', jsonb_build_object('version', v + 1, 'enabled', p_enabled),
          'Partial credit for in-progress tasks (migration 0543): a task earns current_level/levels_required of its item fraction. Off by default.',
          public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  PERFORM public.log_audit_write('progress_partial_credit_update', 'setting', 'progress.partial_credit', before,
    jsonb_build_object('enabled', p_enabled), btrim(p_reason));
  RETURN jsonb_build_object('enabled', p_enabled, 'version', v + 1, 'updated_at', now(), 'updated_by', public.app_actor());
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['progress_partial_credit()', 'progress_partial_credit_json()', 'admin_save_progress_partial_credit(boolean,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION progress_partial_credit_json(), admin_save_progress_partial_credit(boolean,text,integer) TO pmis_app;
  END IF;
END $$;

-- dash_build_items: fractional per-site credit column. part stays 0 unless the setting is on.
DO $$
DECLARE def text; marker text;
BEGIN
  def := pg_get_functiondef('public.dash_build_items(date,uuid,boolean)'::regprocedure);
  IF position(' AS part' IN def) = 0 THEN
    marker := E' AS plan_known\n    FROM _dsite s';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items() has no plan_known anchor to patch'; END IF;
    def := replace(def, marker,
      E' AS plan_known,\n      coalesce(sum(CASE WHEN public.progress_partial_credit() AND t.state NOT IN (''approved'', ''na'', ''skipped'') AND NOT t.is_na AND t.levels_required > 0\n'
      || E'        THEN least(t.current_level, t.levels_required)::numeric / t.levels_required END), 0) AS part\n    FROM _dsite s');
    marker := E'INSERT INTO _dic (site_id, act, item, applic, done, planned, plan_known)\n    SELECT site_id, act, item, applic, done, 0, 0 FROM _dcr';
    IF position(marker IN def) > 0 THEN
      def := replace(def, marker, E'INSERT INTO _dic (site_id, act, item, applic, done, planned, plan_known, part)\n    SELECT site_id, act, item, applic, done, 0, 0, 0 FROM _dcr');
    END IF;
    EXECUTE def;
  END IF;
END $$;

-- dash_build_items_snap: frozen snapshots carry no fractional credit.
DO $$
DECLARE def text; marker text := E'(e.value ->> 3)::bigint AS plan_known';
BEGIN
  def := pg_get_functiondef('public.dash_build_items_snap(date,uuid)'::regprocedure);
  IF position(' AS part' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items_snap() has no plan_known anchor to patch'; END IF;
    EXECUTE replace(def, marker, marker || E',\n      0::numeric AS part');
  END IF;
END $$;

-- dash_ps_rows: the fractional part joins the earned numerator of each item.
DO $$
DECLARE def text; marker text;
BEGIN
  def := pg_get_functiondef('public.dash_ps_rows(text,boolean)'::regprocedure);
  IF position('sum(c.part)' IN def) = 0 THEN
    marker := E'sum(c.planned) AS planned, sum(c.plan_known) AS plan_known';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no ic anchor to patch'; END IF;
    def := replace(def, marker, marker || E', sum(c.part) AS part');
    marker := E'least(1, ic.done::numeric / ic.applic) AS pct';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no pct anchor to patch'; END IF;
    def := replace(def, marker, E'least(1, (ic.done + ic.part) / ic.applic) AS pct');
    EXECUTE def;
  END IF;
END $$;

-- dash_ps_card: the item cards show the same fractional progress as the totals.
DO $$
DECLARE def text; marker text;
BEGIN
  def := pg_get_functiondef('public.dash_ps_card(boolean,jsonb)'::regprocedure);
  IF position('sum(c.part)' IN def) = 0 THEN
    marker := E'sum(c.done) AS done, sum(c.applic) AS applic FROM _dic';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no ic anchor to patch'; END IF;
    def := replace(def, marker, E'sum(c.done) AS done, sum(c.applic) AS applic, sum(c.part) AS part FROM _dic');
    marker := E'ic.applic, ic.done,';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no it0 anchor to patch'; END IF;
    def := replace(def, marker, E'ic.applic, ic.done, ic.part,');
    marker := E'WHEN it0.applic > 0 THEN least(1, it0.done::numeric / it0.applic) END AS pct';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no pct anchor to patch'; END IF;
    def := replace(def, marker, E'WHEN it0.applic > 0 THEN least(1, (it0.done + it0.part) / it0.applic) END AS pct');
    EXECUTE def;
  END IF;
END $$;
