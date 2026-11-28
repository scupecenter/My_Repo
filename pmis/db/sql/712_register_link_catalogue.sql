-- 0713_register_link_catalogue: Settings > Register links, on the D60 table register_links (0409, 0410). Mirror: db/sql/712_register_link_catalogue.sql (kept identical).
--
-- The screen to switch the declared links on and off, and to declare a new one, without code. It does not add a second list of links: it reads and writes the one
-- table register_links, so the picker, the Related records panel, the orphan report and the check on save (all D60) follow at once.
--   * register_links.rev: a counter bumped on every change of a row; the sum of the rev column is the version (ETag, If-Match) of the whole list.
--   * register_link_catalogue(): every declared link, switched-off ones included (register_links_of() lists only the active ones), the version and can_edit.
--   * admin_register_link_catalogue_save(links, reason, version): the System Admin (or an all-regions delegate of settings), with a reason and the audit. It switches a
--     link on or off (is_active), sets enforce and same_site, and declares a new link (a text field of the source register -> a register). A link is never deleted,
--     and the register, field and target of an existing link never change. Nothing else of the table changes.
-- Additive: one column, two functions, the INSERT and UPDATE grants the definer needs. No existing function, trigger or permission is replaced or widened.
SELECT set_config('app.region_ids', '*', true);

ALTER TABLE public.register_links ADD COLUMN IF NOT EXISTS rev integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION register_link_catalogue() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'links', (SELECT coalesce(jsonb_agg(jsonb_build_object('from_register', k.register_key, 'field', k.field_code, 'to_register', k.target_register,
                'target_record_type', k.target_record_type, 'target_state', k.target_state, 'same_site', k.same_site, 'enforce', k.enforce, 'enabled', k.is_active)
                ORDER BY k.sort_order, k.register_key, k.field_code), '[]'::jsonb) FROM public.register_links k),
    'version', (SELECT coalesce(sum(k.rev), 0)::integer FROM public.register_links k),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_register_link_catalogue_save(p_links jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; e jsonb; o public.register_links%ROWTYPE; i int := 0; k text; seen text[] := ARRAY[]::text[]; nxt integer; changed boolean := false; en boolean;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'array' OR jsonb_array_length(p_links) > 300 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links', 'invalid', 'A list of at most 300 links.')));
  END IF;
  LOCK TABLE public.register_links IN SHARE ROW EXCLUSIVE MODE;
  cur := public.register_link_catalogue();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  -- validate the whole list first, so a refused list changes nothing
  FOR e IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i, 'invalid', 'An object.'))); END IF;
    FOREACH k IN ARRAY ARRAY['from_register', 'field', 'to_register'] LOOP
      IF coalesce(e ->> k, '') !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/' || k, 'invalid', 'A register key or field code.')));
      END IF;
    END LOOP;
    IF (e ->> 'from_register') || '.' || (e ->> 'field') = ANY (seen) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i, 'duplicate', 'One link per field.')));
    END IF;
    seen := seen || ((e ->> 'from_register') || '.' || (e ->> 'field'));
    SELECT * INTO o FROM public.register_links x WHERE x.register_key = e ->> 'from_register' AND x.field_code = e ->> 'field';
    IF FOUND THEN
      IF o.target_register <> e ->> 'to_register' THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/to_register', 'builtin', 'A declared link keeps its target; switch it off instead.')));
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = e ->> 'from_register' AND d.kind = 'register')
       OR NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = e ->> 'to_register' AND d.kind = 'register') THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i, 'unknown_register', 'Both registers must exist.')));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = e ->> 'from_register' AND f.code = e ->> 'field' AND f.field_type = 'text') THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links/' || i || '/field', 'unknown_field', 'A text field of the source register.')));
      END IF;
    END IF;
  END LOOP;
  -- nothing is deleted: a declared link missing from the new list is refused
  IF EXISTS (SELECT 1 FROM public.register_links x WHERE NOT ((x.register_key || '.' || x.field_code) = ANY (seen))) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/links', 'no_delete', 'A link is switched off, never removed.')));
  END IF;
  SELECT coalesce(max(sort_order), 0) + 10 INTO nxt FROM public.register_links;
  FOR e IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    SELECT * INTO o FROM public.register_links x WHERE x.register_key = e ->> 'from_register' AND x.field_code = e ->> 'field';
    IF FOUND THEN
      UPDATE public.register_links SET is_active = coalesce((e ->> 'enabled')::boolean, o.is_active), enforce = coalesce((e ->> 'enforce')::boolean, o.enforce),
             same_site = coalesce((e ->> 'same_site')::boolean, o.same_site), rev = o.rev + 1
       WHERE register_key = o.register_key AND field_code = o.field_code
         AND (is_active, enforce, same_site) IS DISTINCT FROM (coalesce((e ->> 'enabled')::boolean, o.is_active), coalesce((e ->> 'enforce')::boolean, o.enforce), coalesce((e ->> 'same_site')::boolean, o.same_site));
      IF FOUND THEN changed := true; END IF;
    ELSE
      INSERT INTO public.register_links (register_key, field_code, target_register, enforce, same_site, is_active, sort_order)
      VALUES (e ->> 'from_register', e ->> 'field', e ->> 'to_register', coalesce((e ->> 'enforce')::boolean, false), coalesce((e ->> 'same_site')::boolean, false),
              coalesce((e ->> 'enabled')::boolean, true), nxt);
      nxt := nxt + 10; changed := true;
    END IF;
  END LOOP;
  IF NOT changed THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The links are already these.')); END IF;
  PERFORM public.log_audit_write('register_links_update', 'setting', 'register_links', jsonb_build_object('links', cur -> 'links'),
    jsonb_build_object('links', public.register_link_catalogue() -> 'links'), btrim(p_reason));
  RETURN public.register_link_catalogue();
END $$;

DO $$
DECLARE f text;
BEGIN
  GRANT INSERT, UPDATE ON public.register_links TO pmis_definer;
  FOREACH f IN ARRAY ARRAY['register_link_catalogue()', 'admin_register_link_catalogue_save(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_link_catalogue(), admin_register_link_catalogue_save(jsonb, text, integer) TO pmis_app;
  END IF;
END $$;
