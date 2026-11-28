-- 0628_saved_view_watches: "alert me when this view has at least N rows" (contract 0.15.487). Personal, additive; notifications only.
-- Mirror: db/sql/627_saved_view_watches.sql (kept identical to prisma/migrations/0628_saved_view_watches/migration.sql).
--
-- Why not a server job: a saved view is a per-screen filter that only the screen's own list endpoint can evaluate, as the viewing user (row security and the
-- caller's regions apply). The server cannot count a user's view on its own. So the web asks the same list endpoint the home pin card uses (limit 1, the counts) when
-- the owner's home dashboard loads and reports the count; the database decides, and writes at most one in-app notification per view and day.
--   1. saved_view_watches: one row per user and view (at most 20 per user): min_rows 1..100000 and last_alert_on (the day of the last notification).
--   2. saved_view_watch_set(view, min_rows): create or change the caller's watch; min_rows NULL removes it. The view is read through sv_can_read (not visible = not_found).
--   3. saved_view_watches(): the caller's watches with the view's name and screen.
--   4. saved_view_watch_report(view, count): for the caller's own watch only. When count >= min_rows and no notification was written today, writes one in-app notification
--      (kind alert_rule, to the caller only) and returns {notified: true}; otherwise {notified: false}. The count is the caller's own figure and only ever notifies the caller.
-- No grant, role or permission change. saved_view_watches is a personal preference (KEEP with saved_views, reset grants added).

CREATE TABLE saved_view_watches (
  user_id       uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  view_id       uuid NOT NULL REFERENCES saved_views(id) ON UPDATE CASCADE ON DELETE CASCADE,
  min_rows      integer NOT NULL CHECK (min_rows BETWEEN 1 AND 100000),
  last_alert_on date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, view_id)
);
CREATE INDEX saved_view_watches_user ON saved_view_watches (user_id);

ALTER TABLE saved_view_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view_watches FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON saved_view_watches FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON saved_view_watches FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

CREATE OR REPLACE FUNCTION saved_view_watch_set(p_view uuid, p_min integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE;
BEGIN
  IF p_min IS NULL THEN
    DELETE FROM public.saved_view_watches w WHERE w.user_id = a AND w.view_id = p_view;
    RETURN jsonb_build_object('view_id', p_view, 'min_rows', NULL);
  END IF;
  IF p_min < 1 OR p_min > 100000 THEN
    PERFORM public.sv_fail('validation_failed', 'min_rows is 1 to 100000.', '{"errors":[{"path":"/min_rows","code":"invalid"}]}');
  END IF;
  SELECT * INTO v FROM public.saved_views x WHERE x.id = p_view;
  IF v.id IS NULL OR NOT v.is_active OR NOT public.sv_can_read(p_view, a) THEN
    PERFORM public.sv_fail('not_found', 'The view does not exist or is not visible to you.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.saved_view_watches w WHERE w.user_id = a AND w.view_id = p_view)
     AND (SELECT count(*) FROM public.saved_view_watches w WHERE w.user_id = a) >= 20 THEN
    PERFORM public.sv_fail('validation_failed', 'At most 20 watched views.', '{"errors":[{"path":"/view","code":"too_many"}]}');
  END IF;
  INSERT INTO public.saved_view_watches (user_id, view_id, min_rows) VALUES (a, p_view, p_min)
  ON CONFLICT (user_id, view_id) DO UPDATE SET min_rows = EXCLUDED.min_rows, last_alert_on = NULL;
  RETURN jsonb_build_object('view_id', p_view, 'min_rows', p_min);
END $$;

CREATE OR REPLACE FUNCTION saved_view_watches() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('view_id', v.id, 'name', v.name, 'screen_key', v.screen_key, 'min_rows', w.min_rows) ORDER BY v.name, v.id)
    FROM public.saved_view_watches w JOIN public.saved_views v ON v.id = w.view_id AND v.is_active
    WHERE w.user_id = a AND public.sv_can_read(v.id, a)), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION saved_view_watch_report(p_view uuid, p_count integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); w public.saved_view_watches%ROWTYPE; v public.saved_views%ROWTYPE; today date := public.cal_today(); loc text; path text; reg text;
BEGIN
  SELECT * INTO w FROM public.saved_view_watches x WHERE x.user_id = a AND x.view_id = p_view;
  IF w.view_id IS NULL OR p_count IS NULL OR p_count < w.min_rows OR w.last_alert_on = today THEN
    RETURN jsonb_build_object('view_id', p_view, 'notified', false);
  END IF;
  SELECT * INTO v FROM public.saved_views x WHERE x.id = p_view;
  IF v.id IS NULL OR NOT v.is_active OR NOT public.sv_can_read(p_view, a) THEN
    RETURN jsonb_build_object('view_id', p_view, 'notified', false);
  END IF;
  SELECT CASE WHEN u.locale = 'ar' THEN 'ar' ELSE 'en' END INTO loc FROM public.users u WHERE u.id = a;
  reg := substring(v.screen_key FROM '^register-([a-z0-9_]{2,60})$');
  path := CASE WHEN v.screen_key = 'sites' THEN '/sites' WHEN reg IS NOT NULL THEN '/registers/' || reg ELSE '/' END;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (a, 'in_app', 'alert_rule',
          CASE WHEN loc = 'ar' THEN 'تنبيه العرض المحفوظ: ' || v.name ELSE 'Saved view alert: ' || v.name END,
          CASE WHEN loc = 'ar' THEN 'يحتوي العرض المحفوظ على ' || p_count || ' صفاً، والحد الذي حددته ' || w.min_rows || '.'
               ELSE 'The saved view has ' || p_count || ' row(s); your limit is ' || w.min_rows || '.' END,
          path || '?view_id=' || p_view::text);
  UPDATE public.saved_view_watches x SET last_alert_on = today WHERE x.user_id = a AND x.view_id = p_view;
  RETURN jsonb_build_object('view_id', p_view, 'notified', true);
END $$;

DO $$
BEGIN
  ALTER TABLE saved_view_watches OWNER TO pmis_definer;
  ALTER FUNCTION saved_view_watch_set(uuid, integer) OWNER TO pmis_definer;
  ALTER FUNCTION saved_view_watches() OWNER TO pmis_definer;
  ALTER FUNCTION saved_view_watch_report(uuid, integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION saved_view_watch_set(uuid, integer), saved_view_watches(), saved_view_watch_report(uuid, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION saved_view_watch_set(uuid, integer), saved_view_watches(), saved_view_watch_report(uuid, integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON saved_view_watches TO pmis_app;
    GRANT EXECUTE ON FUNCTION saved_view_watch_set(uuid, integer), saved_view_watches(), saved_view_watch_report(uuid, integer) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): a personal preference (KEEP, with saved_views). data_reset_plan() is patched in place and idempotently.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''saved_view_watches''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''saved_view_watches''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.saved_view_watches TO pmis_reset_owner;
