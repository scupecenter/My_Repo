-- 0475_stock_low_alert_kind: the low-stock kind for the generic alert rules (0342), notifications only (D1; contract 0.15.537).
-- Mirror: db/sql/474_stock_low_alert_kind.sql (kept identical to prisma/migrations/0475_stock_low_alert_kind/migration.sql).
--
--   stock_below_reorder  {} no params  fires for every active warehouse item that has a reorder limit (warehouse_reorder_limits, 0413; set on the
--                        Warehouse Reorder tab or PUT /warehouse/reorder-limits/{id}) whose available stock (wh_stock_levels) is at or under the level.
--                        period: the working week (Sunday), target: the item id, so the reminder comes once a week while the item stays low.
--                        Audience: system admin or the module of the rule (warehouse). No region (stock is central).
--                        Placeholders: {{item}} (item code), {{available}}, {{level}}, {{qty}} (the reorder quantity, empty when not set).
--
-- The kind list, alert_rule_params_errs() and alert_rules_run() are accumulating objects, patched in place and idempotently as in 0408, so kinds added
-- by other migrations stay. Nothing new is stored: no table, no reset-plan change, no grant to a user role.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('stock_below_reorder' IN def) = 0 THEN
    IF position('''invoice_due_soon''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''invoice_due_soon''', '''invoice_due_soon'', ''stock_below_reorder'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('stock_below_reorder' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'stock_below_reorder' THEN
    IF p_params <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes no params.');
    END IF;
  $ins$;
    IF regexp_replace(def, 'ELSE(\s+errs := errs \|\| jsonb_build_object\(''path'', ''/kind'')', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rule_params_errs: the unknown-kind anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, 'ELSE(\s+errs := errs \|\| jsonb_build_object\(''path'', ''/kind'')', ins || 'ELSE\1');
  END IF;
END $$;

-- 3. the daily evaluation
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rules_run(date)'::regprocedure);
  IF position('stock_below_reorder' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'stock_below_reorder' THEN
      FOR c IN SELECT i.id, i.item_code, l.reorder_level, l.reorder_qty, coalesce(s.available, 0) AS available
               FROM public.warehouse_reorder_limits l
                 JOIN public.warehouse_items i ON i.id = l.item_id AND i.is_active
                 LEFT JOIN public.wh_stock_levels(NULL::uuid, NULL::uuid) s ON s.item_id = l.item_id
               WHERE coalesce(s.available, 0) <= l.reorder_level
               ORDER BY i.item_code LOOP
        t_en := replace(replace(replace(replace(replace(r.title_en, '{{item}}', c.item_code), '{{available}}', c.available::text), '{{level}}', c.reorder_level::text), '{{qty}}', coalesce(c.reorder_qty::text, '')), '{{region}}', '');
        t_ar := replace(replace(replace(replace(replace(r.title_ar, '{{item}}', c.item_code), '{{available}}', c.available::text), '{{level}}', c.reorder_level::text), '{{qty}}', coalesce(c.reorder_qty::text, '')), '{{region}}', '');
        b_en := replace(replace(replace(replace(replace(r.body_en, '{{item}}', c.item_code), '{{available}}', c.available::text), '{{level}}', c.reorder_level::text), '{{qty}}', coalesce(c.reorder_qty::text, '')), '{{region}}', '');
        b_ar := replace(replace(replace(replace(replace(r.body_ar, '{{item}}', c.item_code), '{{available}}', c.available::text), '{{level}}', c.reorder_level::text), '{{qty}}', coalesce(c.reorder_qty::text, '')), '{{region}}', '');
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.id::text, NULL,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/warehouse'), 'warehouse');
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

GRANT SELECT ON public.warehouse_reorder_limits, public.warehouse_items TO pmis_definer;
