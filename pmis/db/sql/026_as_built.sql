-- 0027_as_built: the As-Built register with an editable item list (owner decisions 2026-10-29 and 2026-11-01; CLAUDE.md "Items and work fields are data").
-- Mirror: db/sql/026_as_built.sql (kept identical).
--
--   * Register 'as_built': one record per site (Q55 pattern). Its fixed fields are the TE configuration columns AI:BO of the spec (3.14) that are text or lists
--     (vendors, types, heights, power data); its QUANTITIES are items.
--   * as_built_items is the editable item list: the 31 CW quantities (Master As-Built D:AH) and the TE quantity items (Sector Qty, MW Antenna Qty, Router Qty,
--     Battery Qty, Patch Cord 1 / 2 Qty). The admin adds, renames, edits and deactivates items (admin_save_as_built_item: System Admin or a delegate of
--     fields.edit, reason, audited with before and after, versioned). An item can be linked to a Warehouse item code (Q74) and keeps its Master column.
--   * Every active item is a number field of the register (register_fields, code q_<item code>): it appears in the form, the record data, templates and
--     the Master-format export, and is validated like the seeded ones. The sync is a trigger, so a new item needs no code change.
--   * Quantity rules (spec 3.14): not below zero; whole numbers for pieces and sets.
--   Typed effects of Master BU (CW As-Built Submitted) and EF (As-Built Date), Q68 / Q99, are not projected here (see the open questions).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The item list
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE as_built_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT    NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{1,29}$'),
  section           TEXT    NOT NULL CHECK (section IN ('cw', 'te')),
  name_en           TEXT    NOT NULL,
  name_ar           TEXT,
  unit              TEXT    NOT NULL DEFAULT 'pcs',
  master_column     TEXT,                                  -- the Master As-Built column of the item, kept for the Master-format export
  warehouse_item_id UUID    REFERENCES warehouse_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- Q74: linked by Warehouse item code
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX as_built_items_warehouse_item_key ON as_built_items (warehouse_item_id) WHERE warehouse_item_id IS NOT NULL;

ALTER TABLE as_built_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE as_built_items FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON as_built_items FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON as_built_items FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

GRANT SELECT, INSERT, UPDATE ON as_built_items TO pmis_definer;
GRANT INSERT, UPDATE ON register_fields TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON as_built_items FROM pmis_app;
    GRANT SELECT ON as_built_items TO pmis_app;
  END IF;
END $$;

-- An item is a number field of the register.
CREATE OR REPLACE FUNCTION as_built_item_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, is_active)
  VALUES ('as_built', 'q_' || lower(NEW.code), NEW.name_en, NEW.name_ar, 'number', false, false, false, NULL, false,
          CASE NEW.section WHEN 'cw' THEN 'CW quantities' ELSE 'TE items' END, CASE NEW.section WHEN 'cw' THEN 100 ELSE 400 END + NEW.sort_order, NEW.is_active)
  ON CONFLICT (register_key, code) DO UPDATE SET label_en = EXCLUDED.label_en, label_ar = EXCLUDED.label_ar, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;
  RETURN NULL;
END $$;
CREATE TRIGGER as_built_item_sync AFTER INSERT OR UPDATE ON as_built_items FOR EACH ROW EXECUTE FUNCTION as_built_item_sync();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The register and its fixed fields (spec 3.14; calc AV MW Uplink Site is not a field)
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = false WHERE register_key = 'as_built';

INSERT INTO register_fields (register_key, code, label_en, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('as_built', 'configuration',        'Configuration (WL/MW/IP/PWR)', 'text',   false, false, false, NULL, true,  'WL', 500),
  ('as_built', 'wl_vendor',            'WL Vendor',                    'list',   false, false, false, NULL, false, 'WL', 510),
  ('as_built', 'wl_antenna_type',      'WL Antenna Type',              'list',   false, false, false, NULL, false, 'WL', 520),
  ('as_built', 'rf_height',            'RF Height (m)',                'number', false, false, false, NULL, false, 'WL', 530),
  ('as_built', 'azimuth',              'Azimuth',                      'text',   false, false, false, NULL, false, 'WL', 540),
  ('as_built', 'm_tilt',               'M-Tilt',                       'text',   false, false, false, NULL, false, 'WL', 550),
  ('as_built', 'mw_vendor',            'MW Vendor',                    'list',   false, false, false, NULL, false, 'MW', 560),
  ('as_built', 'mw_antenna_type',      'MW Antenna Type',              'list',   false, false, false, NULL, false, 'MW', 570),
  ('as_built', 'mw_antenna_height',    'MW Antenna Height (m)',        'number', false, false, false, NULL, false, 'MW', 580),
  ('as_built', 'mw_azimuth',           'MW Azimuth',                   'text',   false, false, false, NULL, false, 'MW', 590),
  ('as_built', 'rsl',                  'RSL (dBm)',                    'number', false, false, false, NULL, false, 'MW', 600),
  ('as_built', 'ip_vendor',            'IP Vendor',                    'list',   false, false, false, NULL, false, 'IP', 610),
  ('as_built', 'router_type',          'Router Type',                  'list',   false, false, false, NULL, false, 'IP', 620),
  ('as_built', 'rectifier_status',     'Rectifier Status',             'list',   false, false, false, NULL, false, 'Power', 630),
  ('as_built', 'power_vendor',         'Power Vendor',                 'list',   false, false, false, NULL, false, 'Power', 640),
  ('as_built', 'rated_rectifier_kw',   'Rated Rectifier (kW)',         'number', false, false, false, NULL, false, 'Power', 650),
  ('as_built', 'no_charger_existing',  'No. Charger (Existing)',       'number', false, false, false, NULL, false, 'Power', 660),
  ('as_built', 'max_charger_w',        'Max Charger (W)',              'number', false, false, false, NULL, false, 'Power', 670),
  ('as_built', 'mdb_type',             'MDB Type',                     'list',   false, false, false, NULL, false, 'Power', 680),
  ('as_built', 'battery_type',         'Battery Type',                 'list',   false, false, false, NULL, false, 'Power', 690),
  ('as_built', 'battery_model',        'Battery Model',                'text',   false, false, false, NULL, false, 'Power', 700),
  ('as_built', 'battery_capacity_ah',  'Battery Capacity (AH)',        'number', false, false, false, NULL, false, 'Power', 710),
  ('as_built', 'backup_time_h',        'Backup Time (h)',              'number', false, false, false, NULL, false, 'Power', 720),
  ('as_built', 'dg',                   'D.G',                          'text',   false, false, false, NULL, false, 'Power', 730),
  ('as_built', 'patch_cord_1',         'Patch Cord 1',                 'text',   false, false, false, NULL, false, 'Patch cords', 740),
  ('as_built', 'patch_cord_2',         'Patch Cord 2',                 'text',   false, false, false, NULL, false, 'Patch cords', 750)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Seed items (Master As-Built row 2, D:AH; the TE quantity columns AK, AQ, AX, BI, BM, BO). Linked to the Warehouse items by the WH "As-Built Item" row (Q74).
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO as_built_items (code, section, name_en, unit, master_column, warehouse_item_id, sort_order)
SELECT v.code, v.section, v.name, v.unit, v.col, w.id, v.ord
FROM (VALUES
  ('TOWER', 'cw', 'Tower (m)', 'm', 'D', 'CW-01', 1), ('MOUNTING_POLE', 'cw', 'Mounting Pole (m)', 'm', 'E', 'CW-02', 2),
  ('CONCRETE_PLAIN', 'cw', 'Concrete Plain (m3)', 'm3', 'F', NULL, 3), ('CONCRETE_REINF', 'cw', 'Concrete Reinforcement (m3)', 'm3', 'G', NULL, 4),
  ('AC_CABLE_4X16', 'cw', 'AC Cable 4x16 (m)', 'm', 'H', 'CW-03', 5), ('AC_CABLE_4X10', 'cw', 'AC Cable 4x10 (m)', 'm', 'I', 'CW-04', 6),
  ('DC_CABLE_25', 'cw', 'DC Cable 25 (m)', 'm', 'J', 'CW-05', 7), ('DC_CABLE_35', 'cw', 'DC Cable 35 (m)', 'm', 'K', 'CW-06', 8),
  ('PATCH_CORD_FIBER', 'cw', 'Patch Cord Fiber (m)', 'm', 'L', 'CW-07', 9), ('OUTDOOR_SHIELD_FIBER', 'cw', 'Outdoor Shield Fiber (m)', 'm', 'M', 'CW-08', 10),
  ('INDOOR_CABLE_TRAY', 'cw', 'Indoor Cable Tray (m)', 'm', 'N', 'CW-09', 11), ('OUTDOOR_CABLE_TRAY', 'cw', 'Outdoor Cable Tray (m)', 'm', 'O', 'CW-10', 12),
  ('PVC_1', 'cw', 'PVC 1" (m)', 'm', 'P', 'CW-11', 13), ('PVC_1_5', 'cw', 'PVC 1.5" (m)', 'm', 'Q', 'CW-12', 14), ('PVC_2', 'cw', 'PVC 2" (m)', 'm', 'R', 'CW-13', 15),
  ('GND_16', 'cw', 'GND 16 (m)', 'm', 'S', 'CW-14', 16), ('GND_35', 'cw', 'GND 35 (m)', 'm', 'T', 'CW-15', 17), ('GND_50', 'cw', 'GND 50 (m)', 'm', 'U', 'CW-16', 18),
  ('BUSBAR', 'cw', 'Busbar (pcs)', 'pcs', 'V', 'CW-17', 19), ('COPPER_ROD', 'cw', 'Copper Rod (pcs)', 'pcs', 'W', 'CW-18', 20),
  ('COPPER_PLATED_ROD', 'cw', 'Copper-plated Rod (pcs)', 'pcs', 'X', 'CW-19', 21), ('MANHOLE', 'cw', 'Manhole (pcs)', 'pcs', 'Y', NULL, 22),
  ('SW_63A_3P_AC', 'cw', '63A 3P AC (pcs)', 'pcs', 'Z', 'CW-20', 23), ('SW_63A_1P_DC', 'cw', '63A 1P DC (pcs)', 'pcs', 'AA', 'CW-21', 24),
  ('SW_32A_1P_DC', 'cw', '32A 1P DC (pcs)', 'pcs', 'AB', 'CW-22', 25), ('SW_16A_1P_DC', 'cw', '16A 1P DC (pcs)', 'pcs', 'AC', 'CW-23', 26),
  ('SW_10A_1P_DC', 'cw', '10A 1P DC (pcs)', 'pcs', 'AD', 'CW-24', 27), ('AC_BOX', 'cw', 'AC Box (pcs)', 'pcs', 'AE', 'CW-25', 28),
  ('DC_BOX', 'cw', 'DC Box (pcs)', 'pcs', 'AF', 'CW-26', 29), ('AC_BOX_STAND', 'cw', 'AC Box Stand (pcs)', 'pcs', 'AG', 'CW-27', 30),
  ('INDOOR_RACK', 'cw', 'Indoor Rack (pcs)', 'pcs', 'AH', 'CW-28', 31),
  ('SECTOR_QTY', 'te', 'Sector Qty', 'pcs', 'AK', NULL, 1), ('MW_ANTENNA_QTY', 'te', 'MW Antenna Qty', 'pcs', 'AQ', NULL, 2), ('ROUTER_QTY', 'te', 'Router Qty', 'pcs', 'AX', NULL, 3),
  ('BATTERY_QTY', 'te', 'Battery Qty', 'pcs', 'BI', NULL, 4), ('PATCH_CORD_1_QTY', 'te', 'Patch Cord 1 Qty', 'qty', 'BM', NULL, 5), ('PATCH_CORD_2_QTY', 'te', 'Patch Cord 2 Qty', 'qty', 'BO', NULL, 6)
) AS v(code, section, name, unit, col, wh, ord)
LEFT JOIN warehouse_items w ON w.item_code = v.wh
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The writer: add, rename, edit, link, deactivate (never deleted). p_patch keys: code and section (add only), name_en, name_ar, unit, master_column,
--    warehouse_item_code (null unlinks), sort_order, is_active.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION as_built_item_json(i public.as_built_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', i.code, 'section', i.section, 'name_en', i.name_en, 'name_ar', i.name_ar, 'unit', i.unit, 'master_column', i.master_column,
    'warehouse_item_code', (SELECT w.item_code FROM public.warehouse_items w WHERE w.id = i.warehouse_item_id), 'sort_order', i.sort_order, 'is_active', i.is_active, 'version', i.version)
$$;

CREATE OR REPLACE FUNCTION admin_save_as_built_item(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.as_built_items%ROWTYPE; old_i public.as_built_items%ROWTYPE; iid uuid; wh uuid; used boolean;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch ? 'warehouse_item_code' AND p_patch ->> 'warehouse_item_code' IS NOT NULL THEN
    SELECT w.id INTO wh FROM public.warehouse_items w WHERE w.item_code = p_patch ->> 'warehouse_item_code';
    IF wh IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/warehouse_item_code', 'unknown_warehouse_item', 'No Warehouse item has this code.'))); END IF;
    IF EXISTS (SELECT 1 FROM public.as_built_items x WHERE x.warehouse_item_id = wh AND x.id IS DISTINCT FROM p_id) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/warehouse_item_code', 'already_linked', 'Another As-Built item is linked to this Warehouse item.')));
    END IF;
  END IF;
  IF p_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.as_built_items x WHERE x.code = p_patch ->> 'code') THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'An As-Built item with this code exists already.')); END IF;
    INSERT INTO public.as_built_items (code, section, name_en, name_ar, unit, master_column, warehouse_item_id, sort_order, is_active)
    VALUES (p_patch ->> 'code', p_patch ->> 'section', p_patch ->> 'name_en', p_patch ->> 'name_ar', coalesce(p_patch ->> 'unit', 'pcs'), p_patch ->> 'master_column', wh,
            coalesce((p_patch ->> 'sort_order')::int, (SELECT coalesce(max(x.sort_order), 0) + 1 FROM public.as_built_items x WHERE x.section = p_patch ->> 'section')), coalesce((p_patch ->> 'is_active')::boolean, true))
    RETURNING * INTO i;
    iid := i.id;
    PERFORM public.calc_audit('as_built_item_create', 'as_built_item', iid::text, NULL, public.as_built_item_json(i), p_reason);
  ELSE
    SELECT * INTO old_i FROM public.as_built_items WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
    IF p_version IS NOT NULL AND p_version <> old_i.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    used := EXISTS (SELECT 1 FROM public.register_records r WHERE r.register_key = 'as_built' AND r.data ? ('q_' || lower(old_i.code)));
    IF used AND p_patch ? 'unit' AND p_patch ->> 'unit' IS DISTINCT FROM old_i.unit THEN
      PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'Records hold values of this item: its unit can no longer change.',
        'errors', public.reg_err_item('/unit', 'item_in_use', 'The unit of an item with values is fixed.')));
    END IF;
    UPDATE public.as_built_items SET
      name_en = coalesce(p_patch ->> 'name_en', name_en),
      name_ar = CASE WHEN p_patch ? 'name_ar' THEN p_patch ->> 'name_ar' ELSE name_ar END,
      unit = coalesce(p_patch ->> 'unit', unit),
      master_column = CASE WHEN p_patch ? 'master_column' THEN p_patch ->> 'master_column' ELSE master_column END,
      warehouse_item_id = CASE WHEN p_patch ? 'warehouse_item_code' THEN wh ELSE warehouse_item_id END,
      sort_order = coalesce((p_patch ->> 'sort_order')::int, sort_order),
      is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
      version = version + 1, updated_at = now()
    WHERE id = p_id RETURNING * INTO i;
    iid := p_id;
    PERFORM public.calc_audit(CASE WHEN (p_patch ->> 'is_active') = 'false' THEN 'as_built_item_deactivate' ELSE 'as_built_item_update' END,
      'as_built_item', iid::text, public.as_built_item_json(old_i), public.as_built_item_json(i), p_reason);
  END IF;
  RETURN jsonb_build_object('id', iid, 'version', i.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Quantity rules at submit (spec 3.14): not below zero; whole numbers for pieces and sets
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_validate_as_built(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; errs jsonb := '[]'::jsonb; it record; v numeric;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.register_key <> 'as_built' THEN RETURN errs; END IF;
  FOR it IN SELECT 'q_' || lower(a.code) AS fc, a.unit FROM public.as_built_items a WHERE r.data ? ('q_' || lower(a.code)) LOOP
    v := (r.data ->> it.fc)::numeric;
    IF v < 0 THEN errs := errs || public.reg_err_item('/data/' || it.fc, 'negative', 'A quantity cannot be below zero.');
    ELSIF lower(it.unit) IN ('pcs', 'set') AND v <> trunc(v) THEN errs := errs || public.reg_err_item('/data/' || it.fc, 'whole_units', 'No fraction in whole units (pieces and sets).'); END IF;
  END LOOP;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION reg_validate(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_validate_core(p_record) || public.reg_validate_catalog(p_record) || public.reg_validate_warehouse(p_record) || public.reg_validate_as_built(p_record)
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['as_built_item_sync()', 'as_built_item_json(as_built_items)', 'admin_save_as_built_item(uuid,jsonb,text,integer)', 'reg_validate_as_built(uuid)', 'reg_validate(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_save_as_built_item(uuid,jsonb,text,integer) TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Custom fields (CLAUDE.md "Custom fields"): the generic check of 0007 runs on the records of the registers of 0025 and 0027 too, for the entity of each register.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('quality', 'quality'), ('issues', 'issue'), ('risks', 'risk'), ('change_control', 'change_request'), ('readiness_handover', 'readiness'),
    ('as_built', 'as_built'), ('meetings', 'meeting'), ('rf_design', 'rf_design'), ('acquisition', 'acquisition'), ('contractors', 'external_party')) AS v(k, e) LOOP
    EXECUTE format('CREATE TRIGGER custom_validate_%s BEFORE INSERT OR UPDATE OF custom ON register_records FOR EACH ROW WHEN (NEW.register_key = %L) EXECUTE FUNCTION custom_validate(%L)', r.k, r.k, r.e);
  END LOOP;
END $$;
