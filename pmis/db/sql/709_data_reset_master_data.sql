-- 0710: Settings > Data reset, master data parts (Ahmed's decision: master data tied to the project must be deletable on request).
-- Mirror: db/sql/709_data_reset_master_data.sql (kept byte-identical). Additive: no table, column, permission, role, grant or default value changes for any user role.
-- Three new resettable parts, each OFF by default and never part of "everything" (kind identity, so data_reset_project_parts() does not list them):
--   master_warehouse_items  the item master and its rules: warehouse_items, warehouse_item_need_rules, warehouse_region_vendors, warehouse_reorder_limits, and the
--                           supplier returns (wh_rma, whose key to an item is RESTRICT). The Warehouse part (movements, stock) depends on it, so it goes along.
--                           The as-built item list stays; its link to a deleted item is cleared (warehouse_item_id = NULL) in the same transaction.
--   master_vehicles         the vehicles of the Car Dispatcher (register records of type vehicle). The Car Dispatcher bookings depend on it and go along.
--   master_contractors      the Contractors register (companies, teams, contracts): external_parties, external_party_contracts, external_teams,
--                           external_team_specializations, contractor_alerts_sent and the register records of the Contractors register. Project rows name
--                           companies (RESTRICT keys), so the sites part depends on it: choosing it takes every project part along (the screen shows that).
-- Never deleted by any part: settings, definitions, templates, roles, permissions, groups, the audit log and the security log.
-- data_reset_parts(), data_reset_plan() and data_reset_core() are accumulating functions: patched in place from pg_get_functiondef(), idempotently, and an
-- anchor that is not found raises (nothing is changed). The reset itself is unchanged for every scope that does not name a master part.

DO $$
DECLARE def text; marker text := ') v(code, grp, kind, ord, label_en, label_ar, depends_on)'; n text; nw text;
BEGIN
  def := pg_get_functiondef('public.data_reset_parts()'::regprocedure);
  IF position('master_warehouse_items' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_parts: the end of the list was not found'; END IF;
    nw := replace(def, marker, $r$,
    ('master_warehouse_items', 'registers', 'identity', 300, 'Master data: Warehouse item catalogue (items, rules, supplier returns)', 'البيانات الأساسية: دليل أصناف المخزن (الأصناف والقواعد ومرتجعات الموردين)', '{}'::text[]),
    ('master_vehicles',        'registers', 'identity', 310, 'Master data: Vehicles register', 'البيانات الأساسية: سجل المركبات', '{}'::text[]),
    ('master_contractors',     'registers', 'identity', 320, 'Master data: Contractors (companies, teams, contracts)', 'البيانات الأساسية: المقاولون (الشركات والفرق والعقود)', '{}'::text[])
  $r$ || marker);
    -- the dependants: the part that uses the master data goes along when the master data is chosen
    n := regexp_replace(nw, '(\(''warehouse'',[^\n]*)''\{sites\}''::text\[\]\)', '\1''{sites,master_warehouse_items}''::text[])');
    IF n = nw THEN RAISE EXCEPTION 'data_reset_parts: the warehouse row was not found'; END IF;
    nw := regexp_replace(n, '(\(''car_dispatcher'',[^\n]*)''\{sites,procurement\}''::text\[\]\)', '\1''{sites,procurement,master_vehicles}''::text[])');
    IF n = nw THEN RAISE EXCEPTION 'data_reset_parts: the car_dispatcher row was not found'; END IF;
    n := regexp_replace(nw, '(\(''sites'',[^\n]*)''\{\}''::text\[\]\)', '\1''{master_contractors}''::text[])');
    IF n = nw THEN RAISE EXCEPTION 'data_reset_parts: the sites row was not found'; END IF;
    EXECUTE n;
  END IF;
END $$;

DO $$
DECLARE def text; nw text; tok text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('master_warehouse_items' IN def) = 0 THEN
    -- out of the keep list
    FOREACH tok IN ARRAY ARRAY['warehouse_items', 'warehouse_item_need_rules', 'warehouse_region_vendors', 'warehouse_reorder_limits',
                               'external_parties', 'external_party_contracts', 'external_teams', 'external_team_specializations', 'contractor_alerts_sent'] LOOP
      nw := regexp_replace(def, '''' || tok || '''\s*,\s*', '');
      IF nw = def THEN RAISE EXCEPTION 'data_reset_plan: % was not found in the keep list', tok; END IF;
      def := nw;
    END LOOP;
    -- out of the log list
    nw := regexp_replace(def, ',\s*''wh_rma''', '');
    IF nw = def THEN RAISE EXCEPTION 'data_reset_plan: wh_rma was not found in the log list'; END IF;
    def := nw;
    -- into the delete list
    IF position(') d(tbl, action, part, parts_expr)' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the delete list anchor was not found'; END IF;
    def := replace(def, ') d(tbl, action, part, parts_expr)', $r$,
    ('warehouse_items', 'delete', 'master_warehouse_items', 'ARRAY[''master_warehouse_items'']'),
    ('warehouse_item_need_rules', 'delete', 'master_warehouse_items', 'ARRAY[''master_warehouse_items'']'),
    ('warehouse_region_vendors', 'delete', 'master_warehouse_items', 'ARRAY[''master_warehouse_items'']'),
    ('warehouse_reorder_limits', 'delete', 'master_warehouse_items', 'ARRAY[''master_warehouse_items'']'),
    ('wh_rma', 'delete', 'master_warehouse_items', 'ARRAY[''master_warehouse_items'']'),
    ('external_parties', 'delete', 'master_contractors', 'ARRAY[''master_contractors'']'),
    ('external_party_contracts', 'delete', 'master_contractors', 'ARRAY[''master_contractors'']'),
    ('external_teams', 'delete', 'master_contractors', 'ARRAY[''master_contractors'']'),
    ('external_team_specializations', 'delete', 'master_contractors', 'ARRAY[''master_contractors'']'),
    ('contractor_alerts_sent', 'delete', 'master_contractors', 'ARRAY[''master_contractors'']')
  ) d(tbl, action, part, parts_expr)$r$);
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT, DELETE ON public.warehouse_items, public.warehouse_item_need_rules, public.warehouse_region_vendors, public.warehouse_reorder_limits, public.wh_rma,
  public.external_parties, public.external_party_contracts, public.external_teams, public.external_team_specializations, public.contractor_alerts_sent TO pmis_reset_owner;

DO $$
DECLARE def text; nw text; a text; b text;
BEGIN
  def := pg_get_functiondef('public.data_reset_core(boolean,text,jsonb,uuid,uuid,text[],uuid[])'::regprocedure);
  IF position('master_contractors' IN def) = 0 THEN
    -- 1. the delete order: children before parents (the item and company tables come after every table that points at them)
    a := '''stored_object_meta''];';
    IF position(a IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: the end of the delete order was not found'; END IF;
    def := replace(def, a, '''wh_rma'', ''warehouse_item_need_rules'', ''warehouse_region_vendors'', ''warehouse_reorder_limits'', ''warehouse_items'', ''contractor_alerts_sent'','
      || ' ''external_team_specializations'', ''external_teams'', ''external_party_contracts'', ''external_parties'', ' || a);
    -- 2. register entities of the master data are kept unless their master part is in the scope; in the scope they belong to that part
    a := 'bool_or(rr.register_key = ''contractors'' OR (rr.register_key = ''car_dispatcher'' AND rr.record_type = ''vehicle''))';
    IF position(a IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: the kept entities anchor was not found'; END IF;
    def := replace(def, a, 'bool_or((rr.register_key = ''contractors'' AND ''master_contractors'' <> ALL (scope)) OR (rr.register_key = ''car_dispatcher'' AND rr.record_type = ''vehicle'' AND ''master_vehicles'' <> ALL (scope)))');
    a := 'array_agg(DISTINCT coalesce(public.data_reset_register_part(rr.register_key), ''sites''))';
    IF position(a IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: the entity parts anchor was not found'; END IF;
    def := replace(def, a, 'array_agg(DISTINCT CASE WHEN rr.register_key = ''contractors'' THEN ''master_contractors'' WHEN rr.register_key = ''car_dispatcher'' AND rr.record_type = ''vehicle'' THEN ''master_vehicles'' ELSE coalesce(public.data_reset_register_part(rr.register_key), ''sites'') END)');
    -- 3. the as-built item list stays: its link to a deleted catalogue item is cleared first (that key is RESTRICT)
    a := 'FOREACH t IN ARRAY ord LOOP';
    IF position(a IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: the delete loop was not found'; END IF;
    def := replace(def, a, E'IF ''master_warehouse_items'' = ANY (scope) THEN UPDATE public.as_built_items SET warehouse_item_id = NULL WHERE warehouse_item_id IS NOT NULL; END IF;\n  ' || a);
    EXECUTE def;
  END IF;
END $$;
