-- 0772_register_link_fills (contract 0.15.648): "approval fills the linked record", edited in Settings (automation item 9).
-- Mirror: db/sql/771_register_link_fills.sql (kept byte-identical).
--
-- What already exists (D60, 0409/0410, 0713): register_links declares which field of a register points at a record of another register (for example an invoice
-- points at its procurement record, an issue at its order). This migration adds the rule "when a record gets its final approval, copy field A of it into field B of
-- the record it links to", so the delivery and invoice fields of the order are filled by the document that proves them instead of typed twice.
--   1. register_link_fills: one row per (register, link field, target field): the source field of the approved record and the target field of the linked record.
--      Seeded EMPTY, so nothing fires until the owner writes a rule. Rows are never deleted: a row is hidden with is_active.
--   2. Trigger reg_link_fills_apply (AFTER UPDATE OF state on register_records): when a current record becomes approved, each active row copies the value into the
--      linked record. Safe by construction: only a record still in entry is filled (an approved or locked record is never touched), only an EMPTY target field
--      (a value typed by a person is never overwritten), only a non-empty source value, and each fill is written to the audit log.
--   3. register_link_fills_json() and admin_save_register_link_fills(rows, reason, version): reason, If-Match and audit; the link must be declared in
--      register_links, the two fields must be fields of their registers and of the same field type.
-- The new table is classified in data_reset_plan() as KEEP (config) by patching the stored function in place, and pmis_reset_owner gets its grants.
CREATE TABLE IF NOT EXISTS register_link_fills (
  register_key  text    NOT NULL,
  link_field    text    NOT NULL,
  target_field  text    NOT NULL CHECK (target_field ~ '^[a-z][a-z0-9_]{0,40}$'),
  source_field  text    NOT NULL CHECK (source_field ~ '^[a-z][a-z0-9_]{0,40}$'),
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  rev           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (register_key, link_field, target_field),
  FOREIGN KEY (register_key, link_field) REFERENCES register_links (register_key, field_code) ON UPDATE CASCADE
);
COMMENT ON TABLE register_link_fills IS '0772: copy a field of an approved record into the empty field of the record it links to (Settings, seeded empty).';
ALTER TABLE register_link_fills ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_link_fills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON register_link_fills;
CREATE POLICY rls_select ON register_link_fills FOR SELECT USING (true);
DROP POLICY IF EXISTS rls_seed_write ON register_link_fills;
CREATE POLICY rls_seed_write ON register_link_fills FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
GRANT SELECT, INSERT, UPDATE ON register_link_fills TO pmis_definer;
GRANT SELECT ON register_links, register_fields, register_definitions TO pmis_definer;

CREATE OR REPLACE FUNCTION reg_link_fills_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k record; tid text; tgt record; sv jsonb; nd jsonb;
BEGIN
  IF NOT NEW.is_current OR NEW.state <> 'approved' OR OLD.state = 'approved' THEN RETURN NEW; END IF;
  FOR k IN SELECT f.link_field, f.source_field, f.target_field, l.target_register
             FROM public.register_link_fills f JOIN public.register_links l ON l.register_key = f.register_key AND l.field_code = f.link_field AND l.is_active
            WHERE f.register_key = NEW.register_key AND f.is_active ORDER BY f.sort_order, f.link_field, f.target_field LOOP
    sv := NEW.data -> k.source_field;
    tid := NEW.data ->> k.link_field;
    IF sv IS NULL OR sv = 'null'::jsonb OR coalesce(NEW.data ->> k.source_field, '') = '' OR tid IS NULL
       OR tid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN CONTINUE; END IF;
    FOR tgt IN SELECT t.id, t.data FROM public.register_records t
                WHERE t.register_key = k.target_register AND (t.entity_id = tid::uuid OR t.id = tid::uuid) AND t.is_current AND t.state = 'entry'
                  AND t.id <> NEW.id AND coalesce(t.data ->> k.target_field, '') = '' LOOP
      nd := tgt.data || jsonb_build_object(k.target_field, sv);
      UPDATE public.register_records SET data = nd WHERE id = tgt.id;
      IF public.app_actor() IS NOT NULL THEN
        PERFORM public.log_audit_write('register_link_fill', 'register_record', tgt.id::text, jsonb_build_object(k.target_field, tgt.data -> k.target_field),
                  jsonb_build_object(k.target_field, sv), 'filled from the approved record ' || NEW.id::text, NEW.site_id, NEW.region_id);
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;
ALTER FUNCTION reg_link_fills_apply() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION reg_link_fills_apply() FROM PUBLIC;
DROP TRIGGER IF EXISTS zz_reg_link_fills ON register_records;
CREATE TRIGGER zz_reg_link_fills AFTER UPDATE OF state ON register_records FOR EACH ROW
  WHEN (NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved') EXECUTE FUNCTION reg_link_fills_apply();

CREATE OR REPLACE FUNCTION register_link_fills_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', f.register_key, 'link_field', f.link_field, 'target_field', f.target_field,
                'source_field', f.source_field, 'sort_order', f.sort_order, 'is_active', f.is_active) ORDER BY f.register_key, f.sort_order, f.link_field, f.target_field), '[]'::jsonb)
             FROM public.register_link_fills f),
    'links', (SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', l.register_key, 'link_field', l.field_code, 'target_register', l.target_register,
                'source_fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'label_en', x.label_en, 'label_ar', x.label_ar, 'field_type', x.field_type) ORDER BY x.sort_order, x.code), '[]'::jsonb)
                                  FROM public.register_fields x WHERE x.register_key = l.register_key AND NOT x.derived),
                'target_fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', y.code, 'label_en', y.label_en, 'label_ar', y.label_ar, 'field_type', y.field_type) ORDER BY y.sort_order, y.code), '[]'::jsonb)
                                  FROM public.register_fields y WHERE y.register_key = l.target_register AND NOT y.derived)) ORDER BY l.register_key, l.sort_order, l.field_code), '[]'::jsonb)
             FROM public.register_links l WHERE l.is_active),
    'version', (SELECT coalesce(sum(f.rev), 0)::integer + count(*)::integer FROM public.register_link_fills f),
    'can_edit', (public.app_actor_is_admin('admin.settings', 'edit') AND public.app_actor_region_filter('admin.settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_save_register_link_fills(p_rows jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before jsonb; e jsonb; i int := 0; o public.register_link_fills%ROWTYPE; seen text[] := ARRAY[]::text[]; nxt integer; tr text; st text; tt text; act boolean;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 60 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows', 'invalid', 'A list of at most 60 rows.')));
  END IF;
  LOCK TABLE public.register_link_fills IN SHARE ROW EXCLUSIVE MODE;
  before := public.register_link_fills_json();
  IF p_version IS NOT NULL AND p_version <> (before ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i, 'invalid', 'An object.'))); END IF;
    SELECT l.target_register INTO tr FROM public.register_links l WHERE l.register_key = e ->> 'register_key' AND l.field_code = e ->> 'link_field' AND l.is_active;
    IF tr IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/link_field', 'unknown_link', 'A link declared in Register links.')));
    END IF;
    SELECT f.field_type INTO st FROM public.register_fields f WHERE f.register_key = e ->> 'register_key' AND f.code = e ->> 'source_field' AND NOT f.derived;
    IF st IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/source_field', 'unknown_field', 'A field of the approved register.')));
    END IF;
    SELECT f.field_type INTO tt FROM public.register_fields f WHERE f.register_key = tr AND f.code = e ->> 'target_field' AND NOT f.derived;
    IF tt IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/target_field', 'unknown_field', 'A field of the linked register.')));
    END IF;
    IF st <> tt THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/target_field', 'type_mismatch', 'The two fields must have the same type.')));
    END IF;
    IF (e ->> 'register_key') || '/' || (e ->> 'link_field') || '/' || (e ->> 'target_field') = ANY (seen) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i, 'duplicate', 'One row per link and target field.')));
    END IF;
    seen := seen || ((e ->> 'register_key') || '/' || (e ->> 'link_field') || '/' || (e ->> 'target_field'));
  END LOOP;
  SELECT coalesce(max(sort_order), 0) + 10 INTO nxt FROM public.register_link_fills;
  FOR e IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO o FROM public.register_link_fills t WHERE t.register_key = e ->> 'register_key' AND t.link_field = e ->> 'link_field' AND t.target_field = e ->> 'target_field';
    IF FOUND THEN
      act := coalesce((e ->> 'is_active')::boolean, o.is_active);
      UPDATE public.register_link_fills SET source_field = e ->> 'source_field', is_active = act, rev = o.rev + 1
       WHERE register_key = o.register_key AND link_field = o.link_field AND target_field = o.target_field
         AND (source_field, is_active) IS DISTINCT FROM (e ->> 'source_field', act);
    ELSE
      INSERT INTO public.register_link_fills (register_key, link_field, target_field, source_field, sort_order, is_active)
      VALUES (e ->> 'register_key', e ->> 'link_field', e ->> 'target_field', e ->> 'source_field', coalesce((e ->> 'sort_order')::integer, nxt), coalesce((e ->> 'is_active')::boolean, true));
      nxt := nxt + 10;
    END IF;
  END LOOP;
  IF (public.register_link_fills_json() -> 'rows') IS DISTINCT FROM (before -> 'rows') THEN
    PERFORM public.log_audit_write('register_link_fills_update', 'setting', 'register_link_fills', before -> 'rows', public.register_link_fills_json() -> 'rows', p_reason);
  END IF;
  RETURN public.register_link_fills_json();
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['register_link_fills_json()', 'admin_save_register_link_fills(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
END $$;

-- Data reset coverage (0152): configuration (KEEP). data_reset_plan() is patched in place (0361 pattern), never redefined.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''register_link_fills''' IN def) = 0 THEN
    IF position('''register_links''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: register_links of 0409 was not found'; END IF;
    def := replace(def, '''register_links''', '''register_links'', ''register_link_fills''');
  END IF;
  EXECUTE def;
END $$;
GRANT SELECT, UPDATE ON public.register_link_fills TO pmis_reset_owner;
