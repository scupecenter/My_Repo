-- 0544: central contract items measured from source records. New measure_rule method
-- "warehouse": {"method":"warehouse","warehouse":<progress_item_code>,"central":true} -
-- progress = posted warehouse receipts / contracted quantity of the warehouse items that
-- carry that progress code (equipment supply). Manual entry stays as the fallback whenever
-- no source figure exists. The draft calibrated set v2 (0541) wires its equipment items
-- (BTS, PtP, CPE, Battery, Cabinet, Router, Core server) to their warehouse codes.
-- NMS has no warehouse progress code and the system has no training register, so 3.8 NMS
-- and 8.1 Vendor training stay manual (documented in the PR and docs).

-- dash_build_wi: expose the warehouse code of an item.
DO $$
DECLARE def text; marker text := E' END AS rkey,';
BEGIN
  def := pg_get_functiondef('public.dash_build_wi(uuid)'::regprocedure);
  IF position('whcode' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_wi() has no rkey anchor to patch'; END IF;
    EXECUTE replace(def, marker, marker || E'\n           CASE WHEN jsonb_typeof(i.measure_rule) = ''object'' AND coalesce(i.measure_rule ->> ''method'', ''none'') = ''warehouse'' THEN i.measure_rule ->> ''warehouse'' END AS whcode,');
  END IF;
END $$;

-- dash_build_items: central warehouse progress (receipts / contract).
DO $$
DECLARE def text; marker text := E'\n  PERFORM public.dash_build_manual(p_ref, NULL);';
BEGIN
  def := pg_get_functiondef('public.dash_build_items(date,uuid,boolean)'::regprocedure);
  IF position('_dcwh' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items() has no manual-build anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'\n  -- 0544: central items linked to warehouse source records: posted receipts over contracted quantity.\n'
      || E'  DROP TABLE IF EXISTS _dcwh;\n'
      || E'  CREATE TEMP TABLE _dcwh ON COMMIT DROP AS\n'
      || E'    SELECT w.item,\n'
      || E'           CASE WHEN c.contract > 0 THEN least(1, coalesce(r.received, 0) / c.contract) END AS pct\n'
      || E'    FROM _dwi w\n'
      || E'    CROSS JOIN LATERAL (SELECT sum(wi.contract_qty) AS contract FROM public.warehouse_items wi WHERE wi.progress_item_code = w.whcode AND wi.is_active) c\n'
      || E'    LEFT JOIN LATERAL (SELECT sum(l.qty) AS received FROM public.warehouse_items wi\n'
      || E'        JOIN public.wh_movement_lines l ON l.item_id = wi.id\n'
      || E'        JOIN public.wh_movements m ON m.id = l.movement_id AND m.kind = ''receipt'' AND m.status = ''posted''\n'
      || E'        WHERE wi.progress_item_code = w.whcode AND wi.is_active) r ON true\n'
      || E'    WHERE w.method = ''warehouse'' AND w.central AND w.iw > 0 AND w.whcode IS NOT NULL;\n'
      || E'  CREATE UNIQUE INDEX ON _dcwh (item);'
      || marker);
  END IF;
END $$;

-- dash_build_items_snap: snapshots never recomputed warehouse figures; keep an empty table so the shared reader works.
DO $$
DECLARE def text; marker text := E'  CREATE UNIQUE INDEX ON _dcrc (item);';
BEGIN
  def := pg_get_functiondef('public.dash_build_items_snap(date,uuid)'::regprocedure);
  IF position('_dcwh' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_build_items_snap() has no _dcrc anchor to patch'; END IF;
    EXECUTE replace(def, marker, marker || E'\n  DROP TABLE IF EXISTS _dcwh;\n  CREATE TEMP TABLE _dcwh (item text, pct numeric);\n  CREATE UNIQUE INDEX ON _dcwh (item);');
  END IF;
END $$;

-- dash_ps_rows: warehouse figures join the central chain ahead of the manual fallback.
DO $$
DECLARE def text; marker text;
BEGIN
  def := pg_get_functiondef('public.dash_ps_rows(text,boolean)'::regprocedure);
  IF position('_dcwh' IN def) = 0 THEN
    marker := E'least(1, greatest(0, coalesce(c.pct, m.pct)))';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no central pct anchor to patch'; END IF;
    def := replace(def, marker, E'least(1, greatest(0, coalesce(c.pct, wh.pct, m.pct)))');
    marker := E'LEFT JOIN _dcrc c ON c.item = w.item';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no _dcrc join anchor to patch'; END IF;
    def := replace(def, marker, marker || E' LEFT JOIN _dcwh wh ON wh.item = w.item');
    marker := E'AND ((w.method <> ''register'' AND m.item IS NOT NULL) OR (w.method = ''register'' AND (c.pct IS NOT NULL OR m.item IS NOT NULL)))';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_rows() has no central condition anchor to patch'; END IF;
    def := replace(def, marker,
      E'AND ((w.method NOT IN (''register'', ''warehouse'') AND m.item IS NOT NULL) OR (w.method = ''register'' AND (c.pct IS NOT NULL OR m.item IS NOT NULL)) OR (w.method = ''warehouse'' AND (wh.pct IS NOT NULL OR m.item IS NOT NULL)))');
    EXECUTE def;
  END IF;
END $$;

-- dash_ps_card: the item cards show the warehouse figure.
DO $$
DECLARE def text; marker text;
BEGIN
  def := pg_get_functiondef('public.dash_ps_card(boolean,jsonb)'::regprocedure);
  IF position('_dcwh' IN def) = 0 THEN
    marker := E'c.pct AS cpct,';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no cpct anchor to patch'; END IF;
    def := replace(def, marker, marker || E'\n           wh.pct AS whpct,');
    marker := E'LEFT JOIN _dcrc c ON c.item = w.item';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no _dcrc join anchor to patch'; END IF;
    def := replace(def, marker, marker || E' LEFT JOIN _dcwh wh ON wh.item = w.item');
    marker := E'CASE WHEN it0.cpct IS NOT NULL THEN least(1, greatest(0, it0.cpct)) WHEN it0.is_manual';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no pct case anchor to patch'; END IF;
    def := replace(def, marker, E'CASE WHEN it0.cpct IS NOT NULL THEN least(1, greatest(0, it0.cpct)) WHEN it0.whpct IS NOT NULL THEN least(1, greatest(0, it0.whpct)) WHEN it0.is_manual');
    marker := E'(it0.cpct IS NOT NULL OR it0.is_manual';
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no measured anchor to patch'; END IF;
    def := replace(def, marker, E'(it0.cpct IS NOT NULL OR it0.whpct IS NOT NULL OR it0.is_manual');
    EXECUTE def;
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

-- Wire the equipment items of the draft calibrated set v2 (0541) to their warehouse codes.
-- Idempotent: only items still on {"method":"none"} are moved; manual edits are respected.
UPDATE public.weight_items i
SET measure_rule = jsonb_build_object('method', 'warehouse', 'warehouse', m.wh, 'central', true)
FROM weight_activities a JOIN weight_sets s ON s.id = a.weight_set_id,
     (VALUES ('3.2', 'BTS'), ('3.3', 'PTP'), ('3.4', 'CPE'), ('3.5', 'BATTERY'), ('3.6', 'CABINET'), ('3.7', 'ROUTER'), ('3.9', 'CORE-SERVER')) AS m(icode, wh)
WHERE a.weight_set_id = s.id AND s.code = 'project_status' AND s.version = 2 AND s.status = 'draft'
  AND i.activity_id = a.id AND i.code = m.icode
  AND jsonb_typeof(i.measure_rule) = 'object' AND i.measure_rule ->> 'method' = 'none';
