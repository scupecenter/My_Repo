-- 0713_dash_user_widgets (contract 0.15.585): per-user dashboard widgets. Each user arranges and hides the cards of their own dashboard tabs and keeps
-- named layout templates. Mirror: db/sql/712_dash_user_widgets.sql (kept identical).
--
-- Additive. Reuses the F20 layout shape (order + hidden per tab pmo/cw/te) and the F20 card catalogue; no second catalogue. Personal display
-- preference, like the pinned views (0344): no grant, role, permission, visibility or audit change; a hidden card only changes what the caller sees,
-- the data of every card is still filtered by the caller's own rights.
--   1. dash_user_layouts: one row per caller and tab (the caller's own order and hidden cards; no row = the global layout of Settings > Dashboard).
--   2. dash_user_templates: named sets of the three tab layouts of the caller, at most 20 per caller.
--   3. dash_my_layouts() / dash_my_layout_save(tab, order, hidden, version) / dash_my_layout_reset(tab) and
--      dash_my_templates() / dash_my_template_save(name, layouts) / dash_my_template_apply(id) / dash_my_template_delete(id).
-- Card codes are checked against dashboard_settings_catalogue(), so a card added later is accepted without a change here.

CREATE TABLE dash_user_layouts (
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  tab         text NOT NULL CHECK (tab IN ('pmo', 'cw', 'te')),
  card_order  text[] NOT NULL DEFAULT '{}',
  hidden      text[] NOT NULL DEFAULT '{}',
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tab)
);

CREATE TABLE dash_user_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  layouts     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX dash_user_templates_user ON dash_user_templates (user_id, created_at);

ALTER TABLE dash_user_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dash_user_layouts FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON dash_user_layouts FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON dash_user_layouts FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE dash_user_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dash_user_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON dash_user_templates FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON dash_user_templates FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- Validation helper: known card codes (from the F20 catalogue), no duplicates, a card in at most one list.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_user_layout_check(p_order text[], p_hidden text[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE codes text[]; c text;
BEGIN
  SELECT array_agg(e ->> 'code') INTO codes FROM jsonb_array_elements(public.dashboard_settings_catalogue() -> 'cards') e;
  FOREACH c IN ARRAY coalesce(p_order, '{}') || coalesce(p_hidden, '{}') LOOP
    IF NOT (c = ANY (codes)) THEN
      PERFORM public.sv_fail('validation_failed', 'Unknown dashboard card.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cards', 'code', 'unknown_card', 'value', c)))::text);
    END IF;
  END LOOP;
  IF (SELECT count(*) <> count(DISTINCT x) FROM unnest(coalesce(p_order, '{}') || coalesce(p_hidden, '{}')) x) THEN
    PERFORM public.sv_fail('validation_failed', 'A card is listed twice.', '{"errors":[{"path":"/cards","code":"duplicate"}]}');
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The caller's layouts: { pmo: {order, hidden, version}, ... } for the tabs the caller customised.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_my_layouts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_object_agg(l.tab, jsonb_build_object('order', to_jsonb(l.card_order), 'hidden', to_jsonb(l.hidden), 'version', l.version))
    FROM public.dash_user_layouts l WHERE l.user_id = a), '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION dash_my_layout_save(p_tab text, p_order text[], p_hidden text[], p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); cur integer;
BEGIN
  IF p_tab NOT IN ('pmo', 'cw', 'te') THEN
    PERFORM public.sv_fail('validation_failed', 'Unknown tab.', '{"errors":[{"path":"/tab","code":"unknown_tab"}]}');
  END IF;
  PERFORM public.dash_user_layout_check(p_order, p_hidden);
  SELECT l.version INTO cur FROM public.dash_user_layouts l WHERE l.user_id = a AND l.tab = p_tab FOR UPDATE;
  IF cur IS NULL THEN
    IF p_version IS NOT NULL AND p_version <> 0 THEN PERFORM public.sv_fail('precondition_failed', 'The layout changed since you read it. Reload and try again.'); END IF;
    INSERT INTO public.dash_user_layouts (user_id, tab, card_order, hidden) VALUES (a, p_tab, coalesce(p_order, '{}'), coalesce(p_hidden, '{}'));
    cur := 1;
  ELSE
    IF p_version IS DISTINCT FROM cur THEN PERFORM public.sv_fail('precondition_failed', 'The layout changed since you read it. Reload and try again.'); END IF;
    UPDATE public.dash_user_layouts SET card_order = coalesce(p_order, '{}'), hidden = coalesce(p_hidden, '{}'), version = cur + 1, updated_at = now()
      WHERE user_id = a AND tab = p_tab;
    cur := cur + 1;
  END IF;
  RETURN jsonb_build_object('tab', p_tab, 'order', to_jsonb(coalesce(p_order, '{}')), 'hidden', to_jsonb(coalesce(p_hidden, '{}')), 'version', cur);
END $$;

-- Back to the global layout of the tab (the settings of the admins).
CREATE OR REPLACE FUNCTION dash_my_layout_reset(p_tab text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  DELETE FROM public.dash_user_layouts l WHERE l.user_id = a AND l.tab = p_tab;
  RETURN jsonb_build_object('tab', p_tab, 'reset', true);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Templates: a named set of the caller's tab layouts. A template holds { pmo?: {order, hidden}, cw?, te? }; a tab it omits keeps the
-- global layout when the template is applied.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_my_templates() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'layouts', t.layouts, 'created_at', t.created_at) ORDER BY t.created_at, t.id)
    FROM public.dash_user_templates t WHERE t.user_id = a), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION dash_my_template_save(p_name text, p_layouts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); tb text; o text[]; h text[]; nm text := btrim(coalesce(p_name, '')); new_id uuid;
BEGIN
  IF nm = '' OR length(nm) > 80 THEN
    PERFORM public.sv_fail('validation_failed', 'The name is required (80 characters at most).', '{"errors":[{"path":"/name","code":"invalid"}]}');
  END IF;
  IF p_layouts IS NULL OR jsonb_typeof(p_layouts) <> 'object' THEN
    PERFORM public.sv_fail('validation_failed', 'The layouts are required.', '{"errors":[{"path":"/layouts","code":"invalid"}]}');
  END IF;
  FOR tb IN SELECT jsonb_object_keys(p_layouts) LOOP
    IF tb NOT IN ('pmo', 'cw', 'te') THEN
      PERFORM public.sv_fail('validation_failed', 'Unknown tab.', '{"errors":[{"path":"/layouts","code":"unknown_tab"}]}');
    END IF;
    SELECT coalesce(array_agg(x), '{}') INTO o FROM jsonb_array_elements_text(coalesce(p_layouts -> tb -> 'order', '[]'::jsonb)) x;
    SELECT coalesce(array_agg(x), '{}') INTO h FROM jsonb_array_elements_text(coalesce(p_layouts -> tb -> 'hidden', '[]'::jsonb)) x;
    PERFORM public.dash_user_layout_check(o, h);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.dash_user_templates t WHERE t.user_id = a AND t.name = nm)
     AND (SELECT count(*) FROM public.dash_user_templates t WHERE t.user_id = a) >= 20 THEN
    PERFORM public.sv_fail('validation_failed', 'At most 20 templates.', '{"errors":[{"path":"/name","code":"too_many"}]}');
  END IF;
  INSERT INTO public.dash_user_templates (user_id, name, layouts) VALUES (a, nm, p_layouts)
  ON CONFLICT (user_id, name) DO UPDATE SET layouts = EXCLUDED.layouts
  RETURNING dash_user_templates.id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'name', nm, 'layouts', p_layouts);
END $$;

-- Applies a template of the caller: each tab the template holds replaces the caller's layout of that tab (version moves on).
CREATE OR REPLACE FUNCTION dash_my_template_apply(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); t public.dash_user_templates%ROWTYPE; tb text; o text[]; h text[];
BEGIN
  SELECT * INTO t FROM public.dash_user_templates x WHERE x.id = p_id AND x.user_id = a;
  IF t.id IS NULL THEN PERFORM public.sv_fail('not_found', 'The template does not exist.'); END IF;
  FOR tb IN SELECT jsonb_object_keys(t.layouts) LOOP
    SELECT coalesce(array_agg(x), '{}') INTO o FROM jsonb_array_elements_text(coalesce(t.layouts -> tb -> 'order', '[]'::jsonb)) x;
    SELECT coalesce(array_agg(x), '{}') INTO h FROM jsonb_array_elements_text(coalesce(t.layouts -> tb -> 'hidden', '[]'::jsonb)) x;
    -- a card the catalogue no longer has is dropped, so an old template still applies
    o := coalesce((SELECT array_agg(c) FROM unnest(o) c WHERE c IN (SELECT e ->> 'code' FROM jsonb_array_elements(public.dashboard_settings_catalogue() -> 'cards') e)), '{}');
    h := coalesce((SELECT array_agg(c) FROM unnest(h) c WHERE c IN (SELECT e ->> 'code' FROM jsonb_array_elements(public.dashboard_settings_catalogue() -> 'cards') e)), '{}');
    INSERT INTO public.dash_user_layouts (user_id, tab, card_order, hidden) VALUES (a, tb, o, h)
    ON CONFLICT (user_id, tab) DO UPDATE SET card_order = EXCLUDED.card_order, hidden = EXCLUDED.hidden, version = public.dash_user_layouts.version + 1, updated_at = now();
  END LOOP;
  RETURN public.dash_my_layouts();
END $$;

CREATE OR REPLACE FUNCTION dash_my_template_delete(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  DELETE FROM public.dash_user_templates t WHERE t.id = p_id AND t.user_id = a;
  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants (0166 pattern)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE dash_user_layouts OWNER TO pmis_definer;
  ALTER TABLE dash_user_templates OWNER TO pmis_definer;
  ALTER FUNCTION dash_user_layout_check(text[], text[]) OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_layouts() OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_layout_save(text, text[], text[], integer) OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_layout_reset(text) OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_templates() OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_template_save(text, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_template_apply(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION dash_my_template_delete(uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION dash_user_layout_check(text[], text[]), dash_my_layouts(), dash_my_layout_save(text, text[], text[], integer), dash_my_layout_reset(text),
    dash_my_templates(), dash_my_template_save(text, jsonb), dash_my_template_apply(uuid), dash_my_template_delete(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION dash_user_layout_check(text[], text[]), dash_my_layouts(), dash_my_layout_save(text, text[], text[], integer), dash_my_layout_reset(text),
    dash_my_templates(), dash_my_template_save(text, jsonb), dash_my_template_apply(uuid), dash_my_template_delete(uuid) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON dash_user_layouts, dash_user_templates TO pmis_app;
    GRANT EXECUTE ON FUNCTION dash_my_layouts(), dash_my_layout_save(text, text[], text[], integer), dash_my_layout_reset(text),
      dash_my_templates(), dash_my_template_save(text, jsonb), dash_my_template_apply(uuid), dash_my_template_delete(uuid) TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Data reset coverage (0152): both tables are personal display preferences (KEEP, with saved_views). data_reset_plan() is an accumulating
-- function: patch the stored text idempotently (0361 pattern), never redefine it from an old base.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''dash_user_layouts''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''dash_user_layouts'', ''dash_user_templates''');
  END IF;
  EXECUTE def;
END $$;

GRANT SELECT, UPDATE ON public.dash_user_layouts, public.dash_user_templates TO pmis_reset_owner;
