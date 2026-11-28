-- Item 9 (0.15.561): the group summary row of grouped tables (a count and a status distribution bar on every group header) is one more Display option,
-- `groupbar`, on the same framework as text size, alignment, wrap and zebra rows: the organization default is Settings > Screens > Tables (setting
-- `table.display`, audited), the person's own choice is per screen in the Layout panel (and kept by saved views). Additive: no table, no new
-- function, no permission change. Both functions are changed in place and idempotently; the key is optional in the PUT body, so an older client that
-- sends the five old keys keeps working and the missing key reads as the seed (on).

CREATE OR REPLACE FUNCTION table_display_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"size": "md", "align": "start", "density": "comfortable", "wrap": false, "zebra": true, "groupbar": true}'::jsonb
$$;

DO $$
DECLARE def text; a1 text := '''wrap'', ''zebra'') THEN'; a2 text := 'IF jsonb_typeof(d -> ''zebra'') IS DISTINCT FROM ''boolean'' THEN errs := errs || public.reg_err_item(''/defaults/zebra'', ''invalid'', ''true or false.''); END IF;';
BEGIN
  def := pg_get_functiondef('public.admin_set_table_display(jsonb,text,integer)'::regprocedure);
  IF position('groupbar' IN def) = 0 THEN
    IF position(a1 IN def) = 0 OR position(a2 IN def) = 0 THEN RAISE EXCEPTION 'admin_set_table_display: the zebra anchors (0148) were not found'; END IF;
    def := replace(def, a1, '''wrap'', ''zebra'', ''groupbar'') THEN');
    def := replace(def, a2, a2 || ' IF d ? ''groupbar'' AND jsonb_typeof(d -> ''groupbar'') IS DISTINCT FROM ''boolean'' THEN errs := errs || public.reg_err_item(''/defaults/groupbar'', ''invalid'', ''true or false.''); END IF;');
    EXECUTE def;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('group_summary_display_applied', 'workflow', NULL,
        jsonb_build_object('table_display_key', 'groupbar', 'default', true),
        'Group summary row on grouped tables, a Display option (migration 0652, contract 0.15.561).');
