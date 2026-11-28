-- 0565: keep the publish validation whole after 0552. 0552 replaced weight_set_errors in place with the measure-rule
-- check; in migration-number order that replace runs AFTER 0540/0544 and drops their register and warehouse blocks,
-- and its method whitelist does not know the warehouse method (0544), so a warehouse item could never publish. This
-- migration extends the whitelist and re-applies the 0540/0544 blocks. Every block below is idempotent: a database
-- that applied 0552 before this branch (deployed order, where 0540/0544 patched the 0552 body) changes nothing.

-- Method whitelist: warehouse (0544) joins none / tasks / register (0552).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.weight_set_errors(uuid)'::regprocedure);
  IF position(E'(''none'', ''tasks'', ''register'', ''warehouse'')' IN def) = 0 THEN
    IF position(E'(''none'', ''tasks'', ''register'')' IN def) = 0 THEN
      RAISE EXCEPTION 'weight_set_errors() has no method whitelist anchor to patch';
    END IF;
    EXECUTE replace(def, E'(''none'', ''tasks'', ''register'')', E'(''none'', ''tasks'', ''register'', ''warehouse'')');
  END IF;
END $$;

-- ------------------------------------------------------------------ weight_set_errors: validate register items at publish / preview
DO $$
DECLARE def text; marker text := E'\n  RETURN errs;';
BEGIN
  def := pg_get_functiondef('public.weight_set_errors(uuid)'::regprocedure);
  IF position('unknown_register' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'weight_set_errors() has no return anchor to patch'; END IF;
    EXECUTE replace(def, marker, E'\n'
      || E'  -- 0540: a register item names an enabled register; a site-scoped register is measured per site, a global one centrally.\n'
      || E'  FOR r IN SELECT i.code AS icode, i.measure_rule ->> ''register'' AS rk, coalesce((i.measure_rule ->> ''central'')::boolean, false) AS central\n'
      || E'           FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id\n'
      || E'           WHERE a.weight_set_id = p_set AND jsonb_typeof(i.measure_rule) = ''object'' AND i.measure_rule ->> ''method'' = ''register'' LOOP\n'
      || E'    IF r.rk IS NULL OR NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.rk AND d.is_active AND d.enabled) THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''unknown_register'', ''message'', ''Item '' || r.icode || '': the register "'' || coalesce(r.rk, '''') || ''" is not an enabled register.''));\n'
      || E'    ELSIF EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.rk AND d.site_scoped) AND r.central THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''invalid'', ''message'', ''Item '' || r.icode || '': a site-scoped register is measured per site, not centrally.''));\n'
      || E'    ELSIF EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.rk AND NOT d.site_scoped) AND NOT r.central THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''invalid'', ''message'', ''Item '' || r.icode || '': a register that is not site-scoped is measured centrally (central: true).''));\n'
      || E'    END IF;\n'
      || E'  END LOOP;'
      || marker);
  END IF;
END $$;

-- weight_set_errors: a warehouse item names its warehouse progress code.
DO $$
DECLARE def text; marker text := E'  RETURN errs;';
BEGIN
  def := pg_get_functiondef('public.weight_set_errors(uuid)'::regprocedure);
  IF position('unknown_warehouse' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'weight_set_errors() has no return anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'  -- 0544: a warehouse item names a warehouse progress code.\n'
      || E'  FOR r IN SELECT i.code AS icode, i.measure_rule ->> ''warehouse'' AS wh\n'
      || E'           FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id\n'
      || E'           WHERE a.weight_set_id = p_set AND jsonb_typeof(i.measure_rule) = ''object'' AND i.measure_rule ->> ''method'' = ''warehouse'' LOOP\n'
      || E'    IF r.wh IS NULL OR btrim(r.wh) = '''' THEN\n'
      || E'      errs := errs || jsonb_build_array(jsonb_build_object(''path'', ''/activities'', ''code'', ''unknown_warehouse'', ''message'', ''Item '' || r.icode || '': a warehouse item needs its warehouse progress code.''));\n'
      || E'    END IF;\n'
      || E'  END LOOP;\n'
      || marker);
  END IF;
END $$;
