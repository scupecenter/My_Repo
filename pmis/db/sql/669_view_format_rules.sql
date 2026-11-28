-- Conditional formatting rules per view (0.15.590): `columns.rules` of a saved view holds the person's display rules (a condition on one column and a
-- colour for the cell or the row). A rule on a column the reader may not see is removed from what that reader gets and counted in `stripped_columns`,
-- like the hidden columns of `order`, `hidden` and `width`. Additive: no table, no new function, no permission change. `sv_strip` is changed in place
-- and idempotently (the anchor is the final RETURN, which does not depend on indentation).

DO $$
DECLARE def text; a text := 'RETURN jsonb_build_object(''filters'', f, ''columns'', c, ''sort'', s,';
BEGIN
  def := pg_get_functiondef('public.sv_strip(text,jsonb,jsonb,jsonb)'::regprocedure);
  IF position('''rules''' IN def) = 0 THEN
    IF position(a IN def) = 0 THEN RAISE EXCEPTION 'sv_strip: the RETURN anchor (0117) was not found'; END IF;
    def := replace(def, a,
      'IF jsonb_typeof(c -> ''rules'') = ''array'' THEN '
      || 'SELECT coalesce(jsonb_agg(x ORDER BY o), ''[]''::jsonb) INTO e FROM jsonb_array_elements(c -> ''rules'') WITH ORDINALITY q(x, o) WHERE NOT public.sv_hidden_column(p_screen, x ->> ''col''); '
      || 'SELECT gone || coalesce(array_agg(x ->> ''col''), ARRAY[]::text[]) INTO gone FROM jsonb_array_elements(c -> ''rules'') q(x) WHERE public.sv_hidden_column(p_screen, x ->> ''col''); '
      || 'c := jsonb_set(c, ''{rules}'', e); END IF; ' || a);
    EXECUTE def;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('view_format_rules_applied', 'workflow', NULL,
        jsonb_build_object('columns_key', 'rules', 'strips_hidden_columns', true),
        'Conditional formatting rules per saved view (migration 0670, contract 0.15.590).');
