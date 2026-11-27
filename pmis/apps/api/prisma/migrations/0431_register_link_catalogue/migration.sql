-- 0431_register_link_catalogue: ONE catalogue of the links between registers (decision L3 of the 2026-11-27 relations review). Mirror: db/sql/430_register_link_catalogue.sql.
--
--   Before: the link list lived inside record_related() (a VALUES list), the pickers were written one register at a time, and a new link had no check at all.
--   Now: the setting `registers.links` (a JSON list, no new table) is the single source. Each entry: from_register, field (a text field of that register that holds
--   the entity id), to_register, labels, picker (order = approved active Procurement orders, record = any current record of the target), validate (a blocking check on
--   write), same_site, approved_only, enabled, builtin. It drives (1) the Related-records panel (record_related reads it), (2) the picker of the record form (link-options),
--   (3) one blocking validation trigger for every register (a typed or imported id must be a current, visible record of the target), (4) the Settings screen.
--   A link is added later by data (Settings, or register_link_add() in a migration), never by code. A link is switched off, never deleted. Existing values are never
--   rewritten: the check runs only when the field changes. The Settings data reset and the migration role are exempt (nothing is stored in a table, so no reset part is needed).
--   Additive: one setting, one trigger, six functions. record_related() is patched in place (idempotent).

SELECT set_config('app.region_ids', '*', true);

-- the seed: every link the current record_related() lists (so links added by earlier migrations are kept), once
DO $$
DECLARE def text; seed jsonb; m text[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.settings WHERE key = 'registers.links') THEN RETURN; END IF;
  def := pg_get_functiondef('public.record_related(text,uuid)'::regprocedure);
  seed := '[]'::jsonb;
  FOR m IN SELECT regexp_matches(def, '\(''([a-z_0-9]+)'',\s*''([a-z_0-9]+)'',\s*''([a-z_0-9]+)''\)', 'g') LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(seed) e WHERE e ->> 'from_register' = m[1] AND e ->> 'field' = m[2]) THEN
      seed := seed || jsonb_build_array(jsonb_build_object(
        'from_register', m[1], 'field', m[2], 'to_register', m[3], 'builtin', true, 'enabled', true,
        'picker', CASE WHEN m[3] = 'procurement' THEN 'order' ELSE 'record' END,
        'validate', false, 'same_site', false, 'approved_only', m[3] = 'procurement'));
    END IF;
  END LOOP;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('registers.links', jsonb_build_object('links', seed), 'Register link catalogue (0431): the one list of the links between registers. Changed in Settings > Register links.', now());
END $$;

CREATE OR REPLACE FUNCTION register_links_active() RETURNS TABLE (from_register text, field text, to_register text, picker text, validate boolean, same_site boolean, approved_only boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT e ->> 'from_register', e ->> 'field', e ->> 'to_register', coalesce(e ->> 'picker', 'record'),
         coalesce((e ->> 'validate')::boolean, true), coalesce((e ->> 'same_site')::boolean, false), coalesce((e ->> 'approved_only')::boolean, false)
    FROM public.settings s, jsonb_array_elements(coalesce(s.value -> 'links', '[]'::jsonb)) e
   WHERE s.key = 'registers.links' AND coalesce((e ->> 'enabled')::boolean, true)
$$;

CREATE OR REPLACE FUNCTION register_links_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'registers.links';
  RETURN jsonb_build_object('links', coalesce(s.value -> 'links', '[]'::jsonb), 'version', public.settings_etag('registers.links'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

-- the whole list is saved at once; a builtin link can be switched off but never removed, and its register / field / target never change
CREATE OR REPLACE FUNCTION admin_register_links_save(p_links jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; e jsonb; o jsonb; clean jsonb := '[]'::jsonb; i int := 0; seen text[] := ARRAY[]::text[]; k text;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'array' OR jsonb_array_length(p_links) > 300 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links', 'invalid', 'A list of at most 300 links.')));
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at) VALUES ('registers.links', '{"links": []}'::jsonb, 'Register link catalogue (0431).', now()) ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'registers.links' FOR UPDATE;
  cur := public.register_links_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i, 'invalid', 'An object.'))); END IF;
    FOREACH k IN ARRAY ARRAY['from_register', 'field', 'to_register'] LOOP
      IF coalesce(e ->> k, '') !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/' || k, 'invalid', 'A register key or field code.')));
      END IF;
    END LOOP;
    SELECT x INTO o FROM jsonb_array_elements(coalesce(cur -> 'links', '[]'::jsonb)) x WHERE x ->> 'from_register' = e ->> 'from_register' AND x ->> 'field' = e ->> 'field';
    IF NOT (o IS NOT NULL AND coalesce((o ->> 'builtin')::boolean, false)) THEN
      IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = e ->> 'from_register' AND d.kind = 'register')
       OR NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = e ->> 'to_register' AND d.kind = 'register') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i, 'unknown_register', 'Both registers must exist.')));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = e ->> 'from_register' AND f.code = e ->> 'field' AND f.field_type = 'text') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/field', 'unknown_field', 'A text field of the source register.')));
    END IF;
    END IF;
    IF (e ->> 'from_register') || '.' || (e ->> 'field') = ANY (seen) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i, 'duplicate', 'One link per field.')));
    END IF;
    seen := seen || ((e ->> 'from_register') || '.' || (e ->> 'field'));
    IF coalesce(e ->> 'picker', 'record') NOT IN ('order', 'record') OR (e ->> 'picker' = 'order' AND e ->> 'to_register' <> 'procurement') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/picker', 'invalid', 'record, or order for Procurement.')));
    END IF;
    IF o IS NOT NULL AND coalesce((o ->> 'builtin')::boolean, false) AND (o ->> 'to_register') <> (e ->> 'to_register') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/to_register', 'builtin', 'A built-in link keeps its target; switch it off instead.')));
    END IF;
    clean := clean || jsonb_build_array(jsonb_build_object(
      'from_register', e ->> 'from_register', 'field', e ->> 'field', 'to_register', e ->> 'to_register',
      'label_en', left(nullif(btrim(coalesce(e ->> 'label_en', '')), ''), 120), 'label_ar', left(nullif(btrim(coalesce(e ->> 'label_ar', '')), ''), 120),
      'picker', coalesce(e ->> 'picker', 'record'), 'validate', coalesce((e ->> 'validate')::boolean, true), 'same_site', coalesce((e ->> 'same_site')::boolean, false),
      'approved_only', coalesce((e ->> 'approved_only')::boolean, false), 'enabled', coalesce((e ->> 'enabled')::boolean, true),
      'builtin', o IS NOT NULL AND coalesce((o ->> 'builtin')::boolean, false)));
  END LOOP;
  -- nothing is deleted: a link of the current list missing from the new one is refused
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(cur -> 'links', '[]'::jsonb)) x
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(clean) n WHERE n ->> 'from_register' = x ->> 'from_register' AND n ->> 'field' = x ->> 'field')) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links', 'no_delete', 'A link is switched off, never removed.')));
  END IF;
  IF clean = coalesce(cur -> 'links', '[]'::jsonb) THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The links are already these.')); END IF;
  UPDATE public.settings SET value = jsonb_build_object('links', clean), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'registers.links';
  PERFORM public.log_audit_write('register_links_update', 'setting', 'registers.links', jsonb_build_object('links', cur -> 'links'), jsonb_build_object('links', clean), btrim(p_reason));
  RETURN public.register_links_json();
END $$;

-- for a later migration: add a link (idempotent); the same list the Settings screen edits
CREATE OR REPLACE FUNCTION register_link_add(p_from text, p_field text, p_to text, p_label_en text DEFAULT NULL, p_label_ar text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb;
BEGIN
  SELECT value INTO cur FROM public.settings WHERE key = 'registers.links' FOR UPDATE;
  IF cur IS NULL THEN RAISE EXCEPTION 'registers.links is not seeded'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(cur -> 'links') x WHERE x ->> 'from_register' = p_from AND x ->> 'field' = p_field) THEN RETURN; END IF;
  UPDATE public.settings SET value = jsonb_build_object('links', (cur -> 'links') || jsonb_build_array(jsonb_build_object(
    'from_register', p_from, 'field', p_field, 'to_register', p_to, 'label_en', p_label_en, 'label_ar', p_label_ar, 'builtin', true, 'enabled', true,
    'picker', CASE WHEN p_to = 'procurement' THEN 'order' ELSE 'record' END, 'validate', true, 'same_site', false, 'approved_only', p_to = 'procurement'))),
    updated_at = clock_timestamp() WHERE key = 'registers.links';
END $$;

-- the picker of the form: the records a link field may name (the caller sees only what the matrix lets them see); a Procurement link is the order picker
CREATE OR REPLACE FUNCTION register_link_options(p_from text, p_field text, p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE l record; regs int[]; r jsonb;
BEGIN
  SELECT * INTO l FROM public.register_links_active() a WHERE a.from_register = p_from AND a.field = p_field;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  IF l.to_register = 'procurement' THEN RETURN public.wh_order_options(p_site); END IF;
  regs := public.wf_actor_regions(l.to_register, 'view');
  SELECT coalesce(jsonb_agg(jsonb_build_object('entity_id', x.entity_id, 'record_id', x.id, 'state', x.state, 'site_id', x.site_id, 'record_type', x.record_type,
           'title', public.related_item(x) ->> 'title') ORDER BY x.created_at DESC, x.id), '[]'::jsonb) INTO r
    FROM (SELECT * FROM public.register_records y
           WHERE y.register_key = l.to_register AND y.is_current AND y.state <> 'voided' AND (NOT l.approved_only OR y.state = 'approved')
             AND (regs IS NULL OR y.is_global OR y.region_id = ANY (regs)) AND (NOT l.same_site OR p_site IS NULL OR y.site_id = p_site)
           ORDER BY y.created_at DESC, y.id LIMIT 500) x;
  RETURN r;
END $$;

-- the one blocking check for every link of every register: a typed, imported or posted id must be a current, visible record of the target
CREATE OR REPLACE FUNCTION reg_links_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE l record; v text; errs jsonb := '[]'::jsonb; t public.register_records%ROWTYPE; regs int[];
BEGIN
  IF current_user = 'pmis_reset_owner' OR NEW.state = 'voided' THEN RETURN NEW; END IF;
  FOR l IN SELECT * FROM public.register_links_active() a WHERE a.from_register = NEW.register_key AND a.validate LOOP
    v := nullif(btrim(coalesce(NEW.data ->> l.field, '')), '');
    IF v IS NULL OR (TG_OP = 'UPDATE' AND nullif(btrim(coalesce(OLD.data ->> l.field, '')), '') IS NOT DISTINCT FROM v) THEN CONTINUE; END IF;
    IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      errs := errs || public.reg_err_item('/data/' || l.field, 'link_invalid', 'A record id of the ' || l.to_register || ' register.');
      CONTINUE;
    END IF;
    regs := public.wf_actor_regions(l.to_register, 'view');
    SELECT * INTO t FROM public.register_records x
     WHERE x.register_key = l.to_register AND x.entity_id = v::uuid AND x.is_current AND x.state <> 'voided'
       AND (NOT l.approved_only OR x.state = 'approved') AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.is_global OR x.region_id = ANY (regs));
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/' || l.field, 'link_not_found', 'Not a ' || CASE WHEN l.approved_only THEN 'approved ' ELSE '' END || 'record of the ' || l.to_register || ' register that you can see.');
    ELSIF l.same_site AND NEW.site_id IS NOT NULL AND t.site_id IS NOT NULL AND t.site_id <> NEW.site_id THEN
      errs := errs || public.reg_err_item('/data/' || l.field, 'link_other_site', 'The record belongs to another site.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS c_reg_links_check ON register_records;
CREATE TRIGGER c_reg_links_check BEFORE INSERT OR UPDATE OF data, state ON register_records FOR EACH ROW EXECUTE FUNCTION reg_links_check();

-- record_related() reads the catalogue instead of its own VALUES list (patched in place, idempotent)
DO $$
DECLARE def text; a int; b int; marker text := ') v(from_register, field, to_register)';
BEGIN
  def := pg_get_functiondef('public.record_related(text,uuid)'::regprocedure);
  IF position('register_links_active' IN def) > 0 THEN RETURN; END IF;
  a := position('SELECT * FROM (VALUES' IN def);
  b := position(marker IN def);
  IF a = 0 OR b = 0 THEN RAISE EXCEPTION 'record_related() has no link list to replace'; END IF;
  EXECUTE substr(def, 1, a - 1) || 'SELECT a.from_register, a.field, a.to_register FROM public.register_links_active() a' || substr(def, b + length(marker));
END $$;

-- the settings key changes only through its audited function (guard of 0072)
DROP TRIGGER IF EXISTS b_settings_reg_links ON settings;
DROP TRIGGER IF EXISTS b_settings_reg_links_update ON settings;
DROP TRIGGER IF EXISTS b_settings_reg_links_delete ON settings;
CREATE TRIGGER b_settings_reg_links BEFORE INSERT ON settings FOR EACH ROW WHEN (NEW.key = 'registers.links') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_reg_links_update BEFORE UPDATE ON settings FOR EACH ROW WHEN (OLD.key = 'registers.links' OR NEW.key = 'registers.links') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_reg_links_delete BEFORE DELETE ON settings FOR EACH ROW WHEN (OLD.key = 'registers.links') EXECUTE FUNCTION settings_guarded_keys();

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['register_links_active()', 'register_links_json()', 'admin_register_links_save(jsonb,text,integer)', 'register_link_add(text,text,text,text,text)', 'register_link_options(text,text,uuid)', 'reg_links_check()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_links_active(), register_links_json(), admin_register_links_save(jsonb, text, integer), register_link_options(text, text, uuid) TO pmis_app;
  END IF;
END $$;
