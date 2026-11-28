-- 0642: the data upload validates link fields (contract 0.15.571). Today a link typed in a cell that is not an id, or an id of no record, passes the staging of a
-- row without a word (the entry rules of some registers run on the probe record, but show their message under the wrong column; the links of Procurement in HLC,
-- Car Dispatcher and Financial Advances, the booking to extend, the vehicle and the advance to extend have no rule in entry at all).
--   1. imp_link_errors(register, data): the link fields that have no rule of their own in entry (procurement_record_id of hlc, car_dispatcher and financial_advances;
--      vehicle_id and parent_booking_id of car_dispatcher; parent_advance_id of financial_advances). A value that is not an id, or is the id of no record of the register
--      it points at, is an error with a clear message on that column. A blank value is no error. Read only.
--      The links that already have a rule (invoices, issues, quality, change control, dismantle, warehouse, risks) are NOT checked a second time here.
--   2. imp_stage_register_row is patched in place (from the stored text, asserted, idempotent): (a) it calls imp_link_errors on the cleaned values and puts each error on
--      its column of the error report (P4); (b) an error that a rule of the register raises while the probe record is written is now shown on its own column with its own
--      message (the rules answer a list of errors with a path; the old code kept only "The row is not valid." under Record ID).
-- Nothing is blocked that entry accepts: the rules run in the same way when a person types the value. Additive: one read-only function and one in-place patch. No table,
-- no grant on a table, no permission change.

CREATE OR REPLACE FUNCTION imp_link_errors(p_key text, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  errs jsonb := '[]'::jsonb; r record; v text; ok boolean; uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('hlc',                'procurement_record_id', 'procurement',        NULL::text, 'A Procurement record id.',                           'Not a Procurement record that you can see.'),
      ('car_dispatcher',     'procurement_record_id', 'procurement',        NULL,       'A Procurement record id.',                           'Not a Procurement record that you can see.'),
      ('financial_advances', 'procurement_record_id', 'procurement',        NULL,       'A Procurement record id.',                           'Not a Procurement record that you can see.'),
      ('car_dispatcher',     'vehicle_id',            'car_dispatcher',     'vehicle',  'A vehicle id.',                                      'Unknown vehicle.'),
      ('car_dispatcher',     'parent_booking_id',     'car_dispatcher',     'booking',  'A booking id.',                                      'Not a booking of the Car Dispatcher register.'),
      ('financial_advances', 'parent_advance_id',     'financial_advances', 'advance',  'An advance id.',                                     'Not an advance of the Financial Advances register.')
    ) v(reg, fld, target, rtype, bad_msg, none_msg) WHERE v.reg = p_key LOOP
    v := nullif(btrim(p_data ->> r.fld), '');
    CONTINUE WHEN v IS NULL;
    IF v !~* uuid_re THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || r.fld, 'code', 'invalid', 'message', r.bad_msg));
      CONTINUE;
    END IF;
    -- the id of the record (its entity, or for the HLC link one of its version rows), not voided, in the caller's regions
    SELECT EXISTS (SELECT 1 FROM public.register_records t
                   WHERE t.register_key = r.target AND t.state <> 'voided' AND (t.entity_id = v::uuid OR t.id = v::uuid)
                     AND (r.rtype IS NULL OR (r.rtype = 'vehicle' AND t.record_type = 'vehicle') OR (r.rtype <> 'vehicle' AND t.record_type IS DISTINCT FROM 'vehicle'))
                     AND (r.rtype IS DISTINCT FROM 'advance' OR t.record_type = 'advance')
                     AND public.app_region_read(t.is_global, t.region_id)) INTO ok;
    IF NOT ok THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || r.fld, 'code', 'link_not_found', 'message', r.none_msg));
    END IF;
  END LOOP;
  RETURN errs;
END $$;
COMMENT ON FUNCTION imp_link_errors(text, jsonb) IS '0642: link fields without an entry rule: not an id, or the id of no record (read only, for the data upload).';
REVOKE ALL ON FUNCTION imp_link_errors(text, jsonb) FROM PUBLIC;
DO $$ BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION imp_link_errors(text, jsonb) TO pmis_definer';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION imp_link_errors(text, jsonb) TO pmis_app'; END IF;
END $$;

DO $$
DECLARE def text; n text; cnt int;
BEGIN
  def := pg_get_functiondef('public.imp_stage_register_row(text,jsonb,jsonb,jsonb,uuid,text,integer[],integer[],integer[],integer[])'::regprocedure);
  IF position('imp_link_errors' IN def) = 0 THEN
    -- (a) the link check, after the values are cleaned
    n := E'  clean := jsonb_strip_nulls(clean);\n';
    cnt := (length(def) - length(replace(def, n, ''))) / length(n);
    IF cnt <> 1 THEN RAISE EXCEPTION 'imp_stage_register_row: the clean line is there % times, expected 1', cnt; END IF;
    def := replace(def, n, n || E'  FOR item IN SELECT * FROM jsonb_array_elements(public.imp_link_errors(p_key, clean)) LOOP\n'
      || E'    errs := errs || public.imp_cell_err(p_cols, regexp_replace(item ->> ''path'', ''^/data/'', ''''), item ->> ''code'', item ->> ''message'');\n'
      || E'    clean := clean - regexp_replace(item ->> ''path'', ''^/data/'', '''');\n  END LOOP;\n');
    -- (b) the errors of the rules of the register on the probe record keep their column and their message
    n := E'perrs := jsonb_build_array(jsonb_build_object(''path'', ''/row'', ''code'', ''invalid'', ''message'', left(perr, 300)));';
    cnt := (length(def) - length(replace(def, n, ''))) / length(n);
    IF cnt <> 1 THEN RAISE EXCEPTION 'imp_stage_register_row: the probe error line is there % times, expected 1', cnt; END IF;
    def := replace(def, n, E'perrs := CASE WHEN j ->> ''code'' = ''validation_failed'' AND jsonb_typeof(j -> ''extra'' -> ''errors'') = ''array'' AND jsonb_array_length(j -> ''extra'' -> ''errors'') > 0\n'
      || E'                       THEN j -> ''extra'' -> ''errors''\n'
      || E'                       ELSE jsonb_build_array(jsonb_build_object(''path'', ''/row'', ''code'', ''invalid'', ''message'', left(perr, 300))) END;');
    EXECUTE def;
  END IF;
END $$;
