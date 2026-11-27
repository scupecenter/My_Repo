-- 0344_home_view_pins (contract 0.15.245): pin a saved view as a card on the home dashboard (owner request 2026-11-27, item 16 of the
-- 2026-11-27 batch, item 16). Mirror: db/sql/343_home_view_pins.sql (kept identical).
--
-- Additive. Personal and permission-respecting: a pin is the caller's own, the pin check is the view's own read check (sv_can_read), and the
-- counter the card shows is computed by the screen's own list endpoint for the caller. No grant, role, permission or audit change (a personal
-- display preference, like the drafts of 0065).
--   1. home_view_pins: one row per caller and view, at most 12 per caller, position kept for ordering.
--   2. home_pin_view(uuid) / home_unpin_view(uuid): pin and unpin; the pin reads the view through sv_can_read (a view the caller may not
--      read answers not_found, exactly like sv_get).
--   3. home_pins(): the caller's pins, newest positions last, with the view's name and screen (inactive views drop out).
--   4. dashboard_settings_catalogue gains the card `pinned_views` (kept at the end, migration 0108 rule).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE home_view_pins (
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  view_id     uuid NOT NULL REFERENCES saved_views(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position    integer NOT NULL CHECK (position >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, view_id)
);
CREATE INDEX home_view_pins_user ON home_view_pins (user_id, position);

ALTER TABLE home_view_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_view_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON home_view_pins FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON home_view_pins FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Pin and unpin
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION home_pin_view(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE; pos integer;
BEGIN
  SELECT * INTO v FROM public.saved_views x WHERE x.id = p_view;
  IF v.id IS NULL OR NOT v.is_active OR NOT public.sv_can_read(p_view, a) THEN
    PERFORM public.sv_fail('not_found', 'The view does not exist or is not visible to you.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.home_view_pins p WHERE p.user_id = a AND p.view_id = p_view)
     AND (SELECT count(*) FROM public.home_view_pins p WHERE p.user_id = a) >= 12 THEN
    PERFORM public.sv_fail('validation_failed', 'At most 12 pinned views.', '{"errors":[{"path":"/view","code":"too_many"}]}');
  END IF;
  pos := coalesce((SELECT max(p.position) FROM public.home_view_pins p WHERE p.user_id = a), 0) + 1;
  INSERT INTO public.home_view_pins (user_id, view_id, position) VALUES (a, p_view, pos)
  ON CONFLICT (user_id, view_id) DO NOTHING;
  RETURN jsonb_build_object('view_id', p_view, 'pinned_home', true);
END $$;

CREATE OR REPLACE FUNCTION home_unpin_view(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  DELETE FROM public.home_view_pins p WHERE p.user_id = a AND p.view_id = p_view;
  RETURN jsonb_build_object('view_id', p_view, 'pinned_home', false);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The caller's pins
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION home_pins() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('view_id', v.id, 'name', v.name, 'screen_key', v.screen_key, 'filters', v.filters, 'position', p.position) ORDER BY p.position)
  FROM public.home_view_pins p JOIN public.saved_views v ON v.id = p.view_id AND v.is_active
  WHERE p.user_id = a AND public.sv_can_read(v.id, a)), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The dashboard card catalogue gains `pinned_views`. The catalogue is an accumulating function: patch the stored
-- text idempotently (the 0361 pattern), never replace it from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"pinned_views"' IN def) = 0 THEN
    IF position('"code":"ops_scurve"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the ops_scurve card was not found'; END IF;
    def := replace(def, '"code":"ops_scurve","label_en":"Progress curve: planned vs actual, velocity and forecast","label_ar":"منحنى التقدم: المخطط مقابل الفعلي والسرعة والتوقع"}',
      '"code":"ops_scurve","label_en":"Progress curve: planned vs actual, velocity and forecast","label_ar":"منحنى التقدم: المخطط مقابل الفعلي والسرعة والتوقع"},' || chr(10) || '      {"code":"pinned_views","label_en":"Pinned views","label_ar":"العروض المثبتة"}');
    EXECUTE def;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants (0166 pattern)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE home_view_pins OWNER TO pmis_definer;
  ALTER FUNCTION home_pin_view(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION home_unpin_view(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION home_pins() OWNER TO pmis_definer;
  ALTER FUNCTION dashboard_settings_catalogue() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION home_pin_view(uuid), home_unpin_view(uuid), home_pins() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION home_pin_view(uuid), home_unpin_view(uuid), home_pins() TO pmis_definer;
  GRANT EXECUTE ON FUNCTION dashboard_settings_catalogue() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON home_view_pins TO pmis_app;
    GRANT EXECUTE ON FUNCTION home_pin_view(uuid), home_unpin_view(uuid), home_pins() TO pmis_app;
    GRANT EXECUTE ON FUNCTION dashboard_settings_catalogue() TO pmis_app;
  END IF;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- Data reset coverage (0152): home_view_pins is a personal display preference (KEEP, with saved_views). data_reset_plan() is
-- an accumulating function: patch the stored text idempotently (0361 pattern), never redefine it from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''home_view_pins''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''home_view_pins''');
  END IF;
  EXECUTE def;
END $$;

-- the reset role reads every classified table and takes the share lock of a KEEP table (0152 privilege check)
GRANT SELECT, UPDATE ON public.home_view_pins TO pmis_reset_owner;
