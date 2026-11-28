-- 0716_dash_stock_card (contract 0.15.593): the warehouse stock card of the dashboard. Mirror: db/sql/715_dash_stock_card.sql (kept byte-identical).
--
-- Read only and additive: one function, the card code `warehouse_stock` in the dashboard settings catalogue. No table, no setting, no grant change.
--   wh_stock_summary(p_from, p_to, p_regions): per item group, the quantities
--     received   posted receipts (kind receipt: packing lists and opening balances) with a posting date in the period
--     issued     posted issues (delivery notes) to sites in the period
--     returned   posted returns (return notes) from sites in the period
--     on_hand, reserved, available   today, from wh_stock_levels(): the same figures as Warehouse > Stock (the period never changes them)
--   plus the same flows split by region of the site (issued and returned only: receipts and the stock are central, there is one warehouse stock).
-- Region scope: p_regions limits the site movements (issues and returns) to the caller's warehouse regions; NULL = all. Receipts and on hand are central
-- stock and are shown to every reader of the module, as Warehouse > Stock already does. Quantities of items with different units are added as numbers;
-- `mixed_units` says when a group holds more than one unit so the card can say so.

CREATE OR REPLACE FUNCTION wh_stock_summary(p_from date, p_to date, p_regions integer[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb; d_to date := coalesce(p_to, public.cal_today()); d_from date := coalesce(p_from, public.cal_today() - 29);
BEGIN
  IF d_from > d_to THEN
    PERFORM public.sv_fail('validation_failed', 'The period starts after it ends.', '{"errors":[{"path":"/from","code":"invalid_range"}]}');
  END IF;
  WITH fl AS (
    SELECT i.item_group AS grp, m.kind, m.region_id, li.qty
    FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id AND m.status = 'posted'
    JOIN public.warehouse_items i ON i.id = li.item_id
    WHERE m.kind IN ('receipt', 'issue', 'return') AND (m.posted_at AT TIME ZONE 'Africa/Tripoli')::date BETWEEN d_from AND d_to
      AND (m.kind = 'receipt' OR p_regions IS NULL OR m.region_id = ANY (p_regions))
  ), sl AS (
    SELECT i.item_group AS grp, count(*) AS items, count(DISTINCT i.unit) FILTER (WHERE i.unit IS NOT NULL) AS units,
           sum(s.on_hand) AS on_hand, sum(s.reserved) AS reserved, sum(s.available) AS available
    FROM public.warehouse_items i JOIN public.wh_stock_levels(NULL, NULL) s ON s.item_id = i.id GROUP BY i.item_group
  ), g AS (
    SELECT sl.grp, sl.items, sl.units, sl.on_hand, sl.reserved, sl.available,
      coalesce((SELECT sum(qty) FROM fl WHERE fl.grp = sl.grp AND fl.kind = 'receipt'), 0) AS received,
      coalesce((SELECT sum(qty) FROM fl WHERE fl.grp = sl.grp AND fl.kind = 'issue'), 0) AS issued,
      coalesce((SELECT sum(qty) FROM fl WHERE fl.grp = sl.grp AND fl.kind = 'return'), 0) AS returned
    FROM sl
  ), r AS (
    SELECT fl.grp, fl.region_id, sum(fl.qty) FILTER (WHERE fl.kind = 'issue') AS issued, sum(fl.qty) FILTER (WHERE fl.kind = 'return') AS returned
    FROM fl WHERE fl.kind IN ('issue', 'return') AND fl.region_id IS NOT NULL GROUP BY fl.grp, fl.region_id
  )
  SELECT jsonb_build_object('from', d_from, 'to', d_to,
    'totals', jsonb_build_object('received', coalesce(sum(g.received), 0)::float8, 'issued', coalesce(sum(g.issued), 0)::float8, 'returned', coalesce(sum(g.returned), 0)::float8,
      'on_hand', coalesce(sum(g.on_hand), 0)::float8, 'reserved', coalesce(sum(g.reserved), 0)::float8, 'available', coalesce(sum(g.available), 0)::float8),
    'groups', coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'items', g.items, 'mixed_units', g.units > 1,
      'received', g.received::float8, 'issued', g.issued::float8, 'returned', g.returned::float8,
      'on_hand', g.on_hand::float8, 'reserved', g.reserved::float8, 'available', g.available::float8,
      'by_region', coalesce((SELECT jsonb_agg(jsonb_build_object('region_id', r.region_id, 'issued', coalesce(r.issued, 0)::float8, 'returned', coalesce(r.returned, 0)::float8)
                                ORDER BY r.region_id) FROM r WHERE r.grp = g.grp), '[]'::jsonb)) ORDER BY g.grp), '[]'::jsonb))
  INTO out_ FROM g;
  RETURN out_;
END $$;

DO $$
BEGIN
  ALTER FUNCTION wh_stock_summary(date, date, integer[]) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION wh_stock_summary(date, date, integer[]) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION wh_stock_summary(date, date, integer[]) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION wh_stock_summary(date, date, integer[]) TO pmis_app;
  END IF;
END $$;

-- The card joins the dashboard settings catalogue (idempotent; the function accumulates: patched, never redefined).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.dashboard_settings_catalogue()'::regprocedure);
  IF position('"code":"warehouse_stock"' IN def) = 0 THEN
    IF position('{"code":"regions"' IN def) = 0 THEN RAISE EXCEPTION 'dashboard_settings_catalogue: the regions card was not found'; END IF;
    def := replace(def, '{"code":"regions"', '{"code":"warehouse_stock","label_en":"Warehouse stock: received, issued, returned, on hand and available per item group","label_ar":"مخزون المستودع: المستلم والمصروف والمرتجع والمتوفر لكل مجموعة أصناف"},{"code":"regions"');
    EXECUTE def;
  END IF;
END $$;
