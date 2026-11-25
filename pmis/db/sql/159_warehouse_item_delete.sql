-- 0160: real delete of a warehouse item that has no data (owner decision 2026-11-25, 23:00: "for items with no data both delete and deactivate are possible").
--   * wh_item_deletable(id): true when nothing points to the item: no movement line (any status, cancelled ones included), no serial, no site quantity row,
--     no As-Built item linked to it. The need rules belong to the item and go with it.
--   * admin_delete_warehouse_item(id, reason, version): System Admin or a delegate of warehouse_items.edit, reason of 3 characters or more, version check,
--     audit row with the item as it was. An item with any data answers item_in_use (409): it can only be deactivated, as before.
-- Deactivate stays as it is (admin_save_warehouse_item with is_active = false).

GRANT DELETE ON warehouse_items TO pmis_definer;

CREATE OR REPLACE FUNCTION wh_item_deletable(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT (EXISTS (SELECT 1 FROM public.wh_movement_lines li WHERE li.item_id = p_id)
           OR EXISTS (SELECT 1 FROM public.warehouse_serials s WHERE s.item_id = p_id)
           OR EXISTS (SELECT 1 FROM public.warehouse_site_qty q WHERE q.item_id = p_id)
           OR EXISTS (SELECT 1 FROM public.as_built_items ab WHERE ab.warehouse_item_id = p_id))
$$;

CREATE OR REPLACE FUNCTION admin_delete_warehouse_item(p_id uuid, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.warehouse_items%ROWTYPE; before jsonb;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO i FROM public.warehouse_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> i.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The item changed since you read it.')); END IF;
  IF NOT public.wh_item_deletable(p_id) THEN
    PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'This item has movements, serials, site quantities or an As-Built link: it can only be deactivated.',
      'errors', public.reg_err_item('/', 'item_in_use', 'An item with data cannot be deleted. Deactivate it instead.')));
  END IF;
  before := public.wh_item_json(i);
  DELETE FROM public.warehouse_item_need_rules WHERE item_id = p_id;
  DELETE FROM public.warehouse_items WHERE id = p_id;
  PERFORM public.log_audit_write('warehouse_item_delete', 'warehouse_item', p_id::text, before, NULL, btrim(p_reason));
  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOR f IN SELECT unnest(ARRAY['wh_item_deletable(uuid)', 'admin_delete_warehouse_item(uuid,text,integer)']) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION wh_item_deletable(uuid), admin_delete_warehouse_item(uuid,text,integer) TO pmis_app;
  END IF;
END $$;
