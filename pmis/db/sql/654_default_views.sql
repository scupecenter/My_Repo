-- 0655_default_views (contract 0.15.582): a default saved view per screen, chosen by each person (proposal "default view per screen in Settings").
-- Mirror: apps/api/prisma/migrations/0655_default_views/migration.sql (kept byte-identical).
--
-- Additive. Personal and permission-respecting, the same shape as the home pins of 0344: a default is the caller's own, the check is the view's own
-- read check (sv_can_read), and a view that was deactivated or became unreadable drops out of the list (the screen then opens on its built-in view).
-- No grant, role, permission or audit change (a personal display preference).
--   1. user_default_views: one row per caller and screen (the view applies to that screen only).
--   2. default_view_set(uuid) / default_view_clear(uuid): set and clear; the set reads the view through sv_can_read (not_found otherwise).
--   3. default_views(): the caller's defaults (screen and view; inactive or unreadable views drop out).

CREATE TABLE user_default_views (
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  screen_key  text NOT NULL CHECK (screen_key ~ '^[a-z][a-z0-9_-]{1,80}$'),
  view_id     uuid NOT NULL REFERENCES saved_views(id) ON UPDATE CASCADE ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, screen_key)
);

ALTER TABLE user_default_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_default_views FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON user_default_views FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON user_default_views FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

CREATE OR REPLACE FUNCTION default_view_set(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.saved_views x WHERE x.id = p_view;
  IF v.id IS NULL OR NOT v.is_active OR NOT public.sv_can_read(p_view, a) THEN
    PERFORM public.sv_fail('not_found', 'The view does not exist or is not visible to you.');
  END IF;
  INSERT INTO public.user_default_views (user_id, screen_key, view_id) VALUES (a, v.screen_key, p_view)
  ON CONFLICT (user_id, screen_key) DO UPDATE SET view_id = EXCLUDED.view_id, updated_at = now();
  RETURN jsonb_build_object('view_id', p_view, 'screen_key', v.screen_key, 'is_default', true);
END $$;

CREATE OR REPLACE FUNCTION default_view_clear(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); sk text;
BEGIN
  DELETE FROM public.user_default_views d WHERE d.user_id = a AND d.view_id = p_view RETURNING d.screen_key INTO sk;
  RETURN jsonb_build_object('view_id', p_view, 'screen_key', sk, 'is_default', false);
END $$;

CREATE OR REPLACE FUNCTION default_views() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('screen_key', d.screen_key, 'view_id', v.id, 'name', v.name) ORDER BY d.screen_key)
  FROM public.user_default_views d JOIN public.saved_views v ON v.id = d.view_id AND v.is_active AND v.screen_key = d.screen_key
  WHERE d.user_id = a AND public.sv_can_read(v.id, a)), '[]'::jsonb);
END $$;

-- Ownership and grants (0166 pattern)
DO $$
BEGIN
  ALTER TABLE user_default_views OWNER TO pmis_definer;
  ALTER FUNCTION default_view_set(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION default_view_clear(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION default_views() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION default_view_set(uuid), default_view_clear(uuid), default_views() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION default_view_set(uuid), default_view_clear(uuid), default_views() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON user_default_views TO pmis_app;
    GRANT EXECUTE ON FUNCTION default_view_set(uuid), default_view_clear(uuid), default_views() TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): user_default_views is a personal display preference (KEEP, with saved_views). data_reset_plan() is an accumulating
-- function: patch the stored text idempotently (0361 pattern), never redefine it from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''user_default_views''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''user_default_views''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.user_default_views TO pmis_reset_owner;
