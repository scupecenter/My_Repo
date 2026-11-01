-- 0026_warehouse: the Warehouse register in full (owner update 2026-11-01). Mirror: db/sql/025_warehouse.sql (kept identical).
--
-- What it builds (spec docs/spec/registers-and-streams.md 3.8, CLAUDE.md "Warehouse link" and "Items and work fields are data"):
--   * The register 'warehouse' on the generic framework: one record per document (Doc No.), record types pl, open, adj (no site) and te_dn, cw_dn, te_rn, cw_rn
--     (site required). Header fields are those of tblWHMovements (Doc No., Date, Status, Condition, Reason, Remark); the type is the record type. Entry,
--     review and approval, versions, void and audit are the register's own. The matrix row 'warehouse' was seeded in 0020 (Inventory Supervisor enters).
--   * The item master (warehouse_items) becomes editable data: name EN/AR, category, UoM, serial tracking, need rules, contract quantity, planned
--     delivery, progress item code. Written only by admin_save_warehouse_item (System Admin or a delegate of warehouse_items.edit, reason, audited, versioned).
--     Seed: the 28 CW items of the DN / RN forms and the 21 TE items of the Master WH sheet.
--   * Movement lines (wh_movements, wh_movement_lines): item, quantity (DN: approved and dispatched; RN: condition), serials for serial-tracked items.
--     A pending DN reserves its stock (it cannot be issued twice); an approved DN posts the issue to the site and an approved RN posts the return; a
--     PL / OPEN receipt and an ADJ adjustment change the central stock. A void of a pending document releases the reservation.
--   * Serials (warehouse_serials, existing): registered by an approved PL / OPEN, dispatched by an approved DN, returned by an approved RN.
--   * Stock is derived from the posted and pending lines (wh_stock_levels), never stored twice. The per-site net is also kept in warehouse_site_qty.dispatched.
-- ASSUMPTIONS (open questions Q104 and following): one central store; an RN cannot return more than the site holds (DN minus RN); serial statuses
-- 'In Stock', 'Dispatched', 'Returned'; item codes of the Master items without a code are generated; need quantities follow D58 where stated.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Framework: a type of a site-scoped register may have no site (PL, OPEN, ADJ). reg_save_record is replaced with that one change (0019 text otherwise).
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE register_definitions ADD COLUMN site_optional_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
COMMENT ON COLUMN register_definitions.site_optional_types IS 'Record types of a site-scoped register that have no site (they are global rows, Q69), for example the warehouse PL, OPEN and ADJ.';

CREATE OR REPLACE FUNCTION reg_save_record(p_key text, p_id uuid, p_version int, p_site uuid, p_record_type text, p_data jsonb, p_custom jsonb, p_party uuid, p_clear_party boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.register_definitions%ROWTYPE; s public.sites%ROWTYPE; r public.register_records%ROWTYPE; rid uuid; before jsonb;
  clean jsonb; cnt int; pin uuid; ent uuid; existing uuid; regs int[]; no_site boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register is not available.')); END IF;
  IF p_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.external_parties x WHERE x.id = p_party AND x.is_active) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/external_party_id', 'unknown_party', 'Unknown or inactive external party.')));
  END IF;
  IF p_record_type IS NOT NULL AND NOT (p_record_type = ANY (d.record_types)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a record type of this register.')));
  END IF;
  no_site := NOT d.site_scoped OR coalesce(p_record_type = ANY (d.site_optional_types), false);

  IF p_id IS NULL THEN
    -- create
    IF NOT no_site THEN
      IF p_site IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'required', 'The site is required.'))); END IF;
      SELECT * INTO s FROM public.sites WHERE id = p_site AND public.app_region_check(region_id);
      IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
      regs := public.wf_actor_regions(d.module_key, 'view');
      IF regs IS NOT NULL AND NOT (s.region_id = ANY (regs)) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
      PERFORM public.reg_require_grant(p_key, s.region_id, 'create');
      IF NOT public.reg_scope_ok(p_key, s.id) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'scope_conflict', 'The site scope says N/A for this register (DQ07).')));
      END IF;
      IF NOT d.multiple_per_site THEN
        SELECT x.id INTO existing FROM public.register_records x WHERE x.register_key = p_key AND x.site_id = s.id AND x.version_no = 1 AND x.state <> 'voided';
        IF existing IS NOT NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('existing_id', existing, 'detail', 'This site already has a ' || d.name_en || ' record: create a new version of it (Q55).')); END IF;
      END IF;
    ELSE
      IF p_site IS NOT NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'not_site_scoped', 'This register has no site.'))); END IF;
      PERFORM public.reg_require_grant(p_key, NULL, 'create');
    END IF;
    -- Q56 ownership: the entry holders of the register's own row (the System Admins when the row has nobody, B10)
    IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id) h WHERE h.user_id = actor)
            OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id)))) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder of the ' || d.name_en || ' row of the Matrix.'));
    END IF;
    clean := public.reg_clean_data(p_key, p_data);
    ent := gen_random_uuid();
    SELECT count(*) INTO cnt FROM public.reg_entry_holders(p_key, s.region_id);
    INSERT INTO public.register_records (entity_id, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, external_party_id, ball_in_court_user_id, created_by, level_opened_at)
    VALUES (ent, p_key, p_record_type, s.id, s.region_id, no_site, d.approval_levels, public.reg_merge_data('{}'::jsonb, clean), coalesce(p_custom, '{}'::jsonb), p_party,
            CASE WHEN cnt > 1 THEN actor END, actor, now())
    RETURNING id INTO rid;
    PERFORM public.reg_step(rid, 1, 'create', actor, NULL, NULL, 'entry', false, false);
    PERFORM public.reg_audit('register_record_create', rid, NULL, public.reg_snap(rid), NULL);
    RETURN rid;
  END IF;

  -- edit
  r := public.reg_lock(p_id, p_version);
  IF r.register_key <> p_key THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.')); END IF;
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A record can be edited only while it is in entry (it is ' || r.state || '): create a new version to change an approved record.'));
  END IF;
  PERFORM public.reg_require_grant(p_key, r.region_id, 'edit');
  PERFORM public.reg_require_actor(p_id, 'entry', actor);
  clean := public.reg_clean_data(p_key, p_data);
  before := public.reg_snap(p_id);
  SELECT count(*) INTO cnt FROM public.reg_eligible(p_id, 'entry');
  pin := CASE WHEN r.ball_in_court_user_id IS NULL AND cnt > 1 THEN actor ELSE r.ball_in_court_user_id END;
  UPDATE public.register_records SET
    data = public.reg_merge_data(data, clean),
    custom = CASE WHEN p_custom IS NOT NULL THEN jsonb_strip_nulls(custom || p_custom) ELSE custom END,
    external_party_id = CASE WHEN p_clear_party THEN NULL WHEN p_party IS NOT NULL THEN p_party ELSE external_party_id END,
    ball_in_court_user_id = pin, version = version + 1, updated_at = now()
  WHERE id = p_id;
  PERFORM public.reg_step(p_id, 1, 'edit', actor, NULL, 'entry', 'entry', false, false);
  PERFORM public.reg_audit('register_record_update', p_id, before, public.reg_snap(p_id), NULL);
  RETURN p_id;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The register: definition and header fields
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = true,
  record_types = ARRAY['te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj'], site_optional_types = ARRAY['pl', 'open', 'adj']
WHERE register_key = 'warehouse';

INSERT INTO register_fields (register_key, code, label_en, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('warehouse', 'doc_no',     'Doc No.',   'text', true,  false, false, NULL, true,  'Header', 10),
  ('warehouse', 'doc_date',   'Date',      'date', true,  false, false, NULL, true,  'Header', 20),
  ('warehouse', 'txn_status', 'Status',    'list', true,  false, false, '["Approved", "Dispatched", "Received", "Cancelled"]'::jsonb, true, 'Header', 30),
  ('warehouse', 'condition',  'Condition', 'list', false, false, false, '["Good", "Faulty", "Damaged"]'::jsonb, false, 'Return data', 40),
  ('warehouse', 'reason',     'Reason',    'list', false, false, false, '["Faulty or Damaged", "Relocation", "Cancellation", "Other", "Dismantle"]'::jsonb, false, 'Return data', 50),
  ('warehouse', 'remark',     'Remark',    'text', false, false, false, NULL, false, 'Remark', 60)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Item master: editable data
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE warehouse_items
  ADD COLUMN name_ar TEXT,
  ADD COLUMN manufacturer TEXT,
  ADD COLUMN contract_qty NUMERIC(14,3) CHECK (contract_qty IS NULL OR contract_qty >= 0),
  ADD COLUMN planned_delivery_date DATE,
  ADD COLUMN progress_item_code TEXT,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now();
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_code_format CHECK (item_code ~ '^[A-Z0-9][A-Z0-9_\-]{1,40}$');

CREATE TABLE warehouse_item_need_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID    NOT NULL REFERENCES warehouse_items (id) ON DELETE CASCADE ON UPDATE CASCADE,
  need_unit     TEXT    NOT NULL,
  quantity      NUMERIC(14,3),
  quantity_rule JSONB,
  applies_when  JSONB,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX warehouse_item_need_rules_item_idx ON warehouse_item_need_rules (item_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Movements and lines
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE wh_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     UUID    NOT NULL UNIQUE,                  -- the logical register record of the document
  record_id     UUID    NOT NULL,                         -- its first version
  record_type   TEXT    NOT NULL CHECK (record_type IN ('te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj')),
  kind          TEXT    NOT NULL CHECK (kind IN ('issue', 'return', 'receipt', 'adjustment')),
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'cancelled')),
  site_id       UUID,
  region_id     INTEGER,
  is_global     BOOLEAN NOT NULL DEFAULT false,
  form_id       UUID,                                     -- the generated DN / RN form, when the forms module links one
  cancel_reason TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  posted_at     TIMESTAMPTZ(6),
  version       INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT wh_movements_site_fkey FOREIGN KEY (site_id, region_id) REFERENCES sites (id, region_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT wh_movements_global_xor_site CHECK ((is_global AND site_id IS NULL AND region_id IS NULL) OR (NOT is_global AND site_id IS NOT NULL AND region_id IS NOT NULL))
);
CREATE INDEX wh_movements_site_idx ON wh_movements (site_id, status);
CREATE INDEX wh_movements_status_idx ON wh_movements (status, kind);

CREATE TABLE wh_movement_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id  UUID    NOT NULL REFERENCES wh_movements (id) ON DELETE CASCADE ON UPDATE CASCADE,
  item_id      UUID    NOT NULL REFERENCES warehouse_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  qty          NUMERIC(14,3) NOT NULL CHECK (qty <> 0),   -- DN: dispatched; RN: returned; PL / OPEN: received; ADJ: signed
  qty_approved NUMERIC(14,3) CHECK (qty_approved IS NULL OR qty_approved > 0),   -- DN form: Qty Approved
  condition    TEXT,                                      -- RN form: Good / Faulty / Damaged
  serials      TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  sort_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (movement_id, item_id)
);
CREATE INDEX wh_movement_lines_item_idx ON wh_movement_lines (item_id);

ALTER TABLE wh_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON wh_movements FOR SELECT USING (app_region_read(is_global, region_id));
CREATE POLICY rls_seed_write ON wh_movements FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE wh_movement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_movement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON wh_movement_lines FOR SELECT USING (EXISTS (SELECT 1 FROM wh_movements m WHERE m.id = movement_id));
CREATE POLICY rls_seed_write ON wh_movement_lines FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE warehouse_item_need_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_item_need_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON warehouse_item_need_rules FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON warehouse_item_need_rules FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON wh_movements FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON wh_movement_lines FOR EACH ROW EXECUTE FUNCTION reg_backstop();

GRANT SELECT, INSERT, UPDATE ON wh_movements, wh_movement_lines, warehouse_items, warehouse_serials, warehouse_site_qty TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_item_need_rules TO pmis_definer;
GRANT SELECT ON sites, register_records TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- the warehouse tables are written only through wh_* / admin_save_warehouse_item / reg_* functions
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON wh_movements, wh_movement_lines, warehouse_item_need_rules, warehouse_items, warehouse_serials, warehouse_site_qty FROM pmis_app;
    GRANT SELECT ON wh_movements, wh_movement_lines, warehouse_item_need_rules, warehouse_items, warehouse_serials, warehouse_site_qty TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Seed: the 28 CW items of the DN / RN forms (design/forms/source) and the 21 TE items of the Master WH sheet (rows 2-12). Idempotent.
--    CW codes follow the form numbering; Master items without a code get a generated one (ASSUMPTION).
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO warehouse_items (item_code, item_group, name, unit, serialised, progress_item_code) VALUES
  ('CW-01', 'CW', 'Tower', 'm', false, NULL), ('CW-02', 'CW', 'Mounting Pole', 'm', false, NULL), ('CW-03', 'CW', 'AC Cable 4x16 mm²', 'm', false, NULL),
  ('CW-04', 'CW', 'AC Cable 4x10 mm²', 'm', false, NULL), ('CW-05', 'CW', 'DC Cable 25 mm²', 'm', false, NULL), ('CW-06', 'CW', 'DC Cable 35 mm²', 'm', false, NULL),
  ('CW-07', 'CW', 'Fiber Cable – Patch Cord', 'm', false, NULL), ('CW-08', 'CW', 'Fiber Cable – Outdoor Shielded', 'm', false, NULL),
  ('CW-09', 'CW', 'Indoor Cable Tray', 'm', false, NULL), ('CW-10', 'CW', 'Outdoor Cable Tray', 'm', false, NULL), ('CW-11', 'CW', 'PVC Pipe 1"', 'm', false, NULL),
  ('CW-12', 'CW', 'PVC Pipe 1.5"', 'm', false, NULL), ('CW-13', 'CW', 'PVC Pipe 2"', 'm', false, NULL), ('CW-14', 'CW', 'GND Cable 16 mm²', 'm', false, NULL),
  ('CW-15', 'CW', 'GND Cable 35 mm²', 'm', false, NULL), ('CW-16', 'CW', 'GND Cable 50 mm²', 'm', false, NULL), ('CW-17', 'CW', 'Grounding Busbar', 'pcs', false, NULL),
  ('CW-18', 'CW', 'Grounding Copper Rod', 'pcs', false, NULL), ('CW-19', 'CW', 'Grounding Copper-plated Rod', 'pcs', false, NULL),
  ('CW-20', 'CW', 'Electrical Switch 63A 3P AC', 'pcs', false, NULL), ('CW-21', 'CW', 'Electrical Switch 63A 1P DC', 'pcs', false, NULL),
  ('CW-22', 'CW', 'Electrical Switch 32A 1P DC', 'pcs', false, NULL), ('CW-23', 'CW', 'Electrical Switch 16A 1P DC', 'pcs', false, NULL),
  ('CW-24', 'CW', 'Electrical Switch 10A 1P DC', 'pcs', false, NULL), ('CW-25', 'CW', 'AC Box', 'pcs', false, NULL), ('CW-26', 'CW', 'DC Box', 'pcs', false, NULL),
  ('CW-27', 'CW', 'AC Box Stand', 'pcs', false, NULL), ('CW-28', 'CW', 'Indoor Rack', 'pcs', false, NULL),
  ('C280500A101A', 'WL', 'cnWave 28 GHz BTS', 'pcs', true, 'BTS'), ('C000000L114A', 'WL', 'DC LPU Kit', 'pcs', false, NULL),
  ('WG5-DUAL-BS', 'WL', 'WiBAS G5 dual-BS', 'pcs', true, 'BTS'), ('HANT262890', 'WL', 'WiBAS Antenna', 'pcs', false, NULL),
  ('C280500C001A', 'CPE', 'cnWave C100', 'pcs', true, 'CPE'), ('WG5-CONN-PLUS', 'CPE', 'WiBAS G5 Connect+', 'pcs', true, 'CPE'),
  ('KZ00-65F', 'MW', 'UltraLink-GX80 Radio', 'pcs', true, 'PTP'), ('KH14-056', 'MW', 'MW Antenna ANT-7080-60P', 'pcs', false, NULL),
  ('S9500', 'IP', 'Router S9500-30XS', 'pcs', true, 'ROUTER'), ('S9501', 'IP', 'Router S9501-18SMT', 'pcs', true, 'ROUTER'), ('S9700', 'IP', 'Router S9700-53DX', 'pcs', true, 'ROUTER'),
  ('SFP-SM-10G-10KM', 'IP', 'SFP-SM-10G-10KM', 'pcs', false, NULL),
  ('MTS9514A', 'PWR', 'Cabinet MTS9514A', 'pcs', true, 'CABINET'), ('800-00211', 'PWR', 'Li Battery SLB48-300-147', 'pcs', true, 'BATTERY'),
  ('R450', 'CORE', 'Server Dell R450', 'pcs', true, 'CORE-SERVER'), ('R650', 'CORE', 'Server Dell R650', 'pcs', true, 'CORE-SERVER'),
  ('ERKA-2X2-5', 'Accessories', 'ERKA Shielded Outdoor 2x2.5 mm²', 'm', false, NULL), ('ERKA-4X0-75', 'Accessories', 'ERKA Shielded Outdoor 4x0.75 mm²', 'm', false, NULL),
  ('FIBER-OUTDOOR', 'Accessories', 'Fiber Optic Cable Outdoor', 'm', false, NULL), ('TELECOM-BRACKET', 'Accessories', 'Telecom Bracket', 'pcs', false, NULL),
  ('FIBER-CLAMP-4L8R', 'Accessories', 'Fiber Cable Clamp 4 Layers 8 Runs', 'pcs', false, NULL)
ON CONFLICT (item_code) DO NOTHING;

-- Need rules (Master WH row 12 "Need Unit"; quantities from D58 / D72 where stated: LPU Kit 2, Router 1, Cabinet 1, Battery 2; 1 per unit otherwise: ASSUMPTION)
INSERT INTO warehouse_item_need_rules (item_id, need_unit, quantity, sort_order)
SELECT i.id, v.unit, v.qty, 1 FROM (VALUES
  ('C280500A101A', 'Cambium Sector', 1), ('C000000L114A', 'LPU Kit', 2), ('WG5-DUAL-BS', 'Intracom Sector', 1), ('HANT262890', 'Intracom Sector', 1),
  ('KZ00-65F', 'MW Half-link', 1), ('KH14-056', 'MW Half-link', 1), ('S9500', 'Router', 1), ('S9501', 'Router', 1), ('S9700', 'Router', 1),
  ('MTS9514A', 'Cabinet', 1), ('800-00211', 'Battery', 2)
) AS v(code, unit, qty) JOIN warehouse_items i ON i.item_code = v.code
WHERE NOT EXISTS (SELECT 1 FROM warehouse_item_need_rules n WHERE n.item_id = i.id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Stock (derived) and the item writer
-- ---------------------------------------------------------------------------------------------------------------------
-- Central stock (p_site NULL): receipts and returns add, issues subtract, adjustments are signed; reserved = pending issues and pending negative
-- adjustments. Per site: net DN minus RN. Definer: the central store is not a regional thing (the API checks the module and the site).
CREATE OR REPLACE FUNCTION wh_stock_levels(p_item uuid DEFAULT NULL, p_site uuid DEFAULT NULL)
RETURNS TABLE (item_id uuid, on_hand numeric, reserved numeric, pending_issue numeric, pending_return numeric, available numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH l AS (
    SELECT li.item_id AS iid, li.qty, m.kind, m.status
    FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id
    WHERE m.status <> 'cancelled' AND (p_item IS NULL OR li.item_id = p_item)
      AND (p_site IS NULL OR (m.site_id = p_site AND m.kind IN ('issue', 'return')))
  ), s AS (
    SELECT l.iid,
      sum(CASE WHEN l.status = 'posted' THEN CASE WHEN p_site IS NULL THEN CASE l.kind WHEN 'issue' THEN -l.qty ELSE l.qty END
                                                  ELSE CASE l.kind WHEN 'issue' THEN l.qty ELSE -l.qty END END ELSE 0 END) AS oh,
      sum(CASE WHEN l.status = 'pending' AND p_site IS NULL AND (l.kind = 'issue' OR (l.kind = 'adjustment' AND l.qty < 0)) THEN abs(l.qty) ELSE 0 END) AS rs,
      sum(CASE WHEN l.status = 'pending' AND l.kind = 'issue' THEN l.qty ELSE 0 END) AS pi,
      sum(CASE WHEN l.status = 'pending' AND l.kind = 'return' THEN l.qty ELSE 0 END) AS pr
    FROM l GROUP BY l.iid
  )
  SELECT i.id, coalesce(s.oh, 0), coalesce(s.rs, 0), coalesce(s.pi, 0), coalesce(s.pr, 0), coalesce(s.oh, 0) - coalesce(s.rs, 0)
  FROM public.warehouse_items i LEFT JOIN s ON s.iid = i.id
  WHERE (p_item IS NULL OR i.id = p_item) AND (p_site IS NULL OR s.iid IS NOT NULL) AND (i.is_active OR s.iid IS NOT NULL)
$$;

CREATE OR REPLACE FUNCTION wh_item_json(i public.warehouse_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', i.item_code, 'name_en', i.name, 'name_ar', i.name_ar, 'uom', i.unit, 'category', i.item_group, 'serial_tracked', i.serialised,
    'manufacturer', i.manufacturer, 'contract_qty', i.contract_qty, 'planned_delivery_date', i.planned_delivery_date, 'progress_item_code', i.progress_item_code,
    'is_active', i.is_active, 'version', i.version,
    'need_rules', coalesce((SELECT jsonb_agg(jsonb_build_object('need_unit', n.need_unit, 'quantity', n.quantity, 'quantity_rule', n.quantity_rule, 'applies_when', n.applies_when) ORDER BY n.sort_order, n.id)
                            FROM public.warehouse_item_need_rules n WHERE n.item_id = i.id), '[]'::jsonb))
$$;

-- Add or edit an item (p_id NULL = add). p_patch keys: code (add only), name_en, name_ar, uom, category, serial_tracked, manufacturer, contract_qty,
-- planned_delivery_date, progress_item_code, is_active, need_rules (replaces the list). The code never changes. An item with movements keeps its unit
-- and its serial tracking, and cannot be deactivated while a movement of it is pending (422 item_in_use). Nothing is deleted.
CREATE OR REPLACE FUNCTION admin_save_warehouse_item(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.warehouse_items%ROWTYPE; old_i public.warehouse_items%ROWTYPE; iid uuid; before jsonb; used boolean; pend boolean; rule jsonb; n int := 0;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.warehouse_items x WHERE x.item_code = p_patch ->> 'code') THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'An item with this code exists already.'));
    END IF;
    INSERT INTO public.warehouse_items (item_code, item_group, name, name_ar, unit, serialised, manufacturer, contract_qty, planned_delivery_date, progress_item_code, is_active)
    VALUES (p_patch ->> 'code', coalesce(p_patch ->> 'category', 'General'), p_patch ->> 'name_en', p_patch ->> 'name_ar', p_patch ->> 'uom', coalesce((p_patch ->> 'serial_tracked')::boolean, false),
            p_patch ->> 'manufacturer', (p_patch ->> 'contract_qty')::numeric, (p_patch ->> 'planned_delivery_date')::date, p_patch ->> 'progress_item_code', coalesce((p_patch ->> 'is_active')::boolean, true))
    RETURNING * INTO i;
    iid := i.id;
    before := NULL;
  ELSE
    SELECT * INTO old_i FROM public.warehouse_items WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
    IF p_version IS NOT NULL AND p_version <> old_i.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    before := public.wh_item_json(old_i);
    used := EXISTS (SELECT 1 FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id WHERE li.item_id = p_id AND m.status <> 'cancelled')
            OR EXISTS (SELECT 1 FROM public.warehouse_serials s WHERE s.item_id = p_id);
    pend := EXISTS (SELECT 1 FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id WHERE li.item_id = p_id AND m.status = 'pending');
    IF used AND ((p_patch ? 'uom' AND p_patch ->> 'uom' IS DISTINCT FROM old_i.unit) OR (p_patch ? 'serial_tracked' AND (p_patch ->> 'serial_tracked')::boolean IS DISTINCT FROM old_i.serialised)) THEN
      PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'This item has movements: its unit and serial tracking can no longer change.',
        'errors', public.reg_err_item('/uom', 'item_in_use', 'The unit and the serial tracking of an item with movements are fixed.')));
    END IF;
    IF pend AND p_patch ? 'is_active' AND (p_patch ->> 'is_active')::boolean = false THEN
      PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'This item has pending movements: it cannot be deactivated yet.',
        'errors', public.reg_err_item('/is_active', 'item_in_use', 'Finish or cancel the pending movements first.')));
    END IF;
    UPDATE public.warehouse_items SET
      name = coalesce(p_patch ->> 'name_en', name),
      name_ar = CASE WHEN p_patch ? 'name_ar' THEN p_patch ->> 'name_ar' ELSE name_ar END,
      unit = coalesce(p_patch ->> 'uom', unit),
      item_group = coalesce(p_patch ->> 'category', item_group),
      serialised = coalesce((p_patch ->> 'serial_tracked')::boolean, serialised),
      manufacturer = CASE WHEN p_patch ? 'manufacturer' THEN p_patch ->> 'manufacturer' ELSE manufacturer END,
      contract_qty = CASE WHEN p_patch ? 'contract_qty' THEN (p_patch ->> 'contract_qty')::numeric ELSE contract_qty END,
      planned_delivery_date = CASE WHEN p_patch ? 'planned_delivery_date' THEN (p_patch ->> 'planned_delivery_date')::date ELSE planned_delivery_date END,
      progress_item_code = CASE WHEN p_patch ? 'progress_item_code' THEN p_patch ->> 'progress_item_code' ELSE progress_item_code END,
      is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
      version = version + 1, updated_at = now()
    WHERE id = p_id RETURNING * INTO i;
    iid := p_id;
  END IF;
  IF p_patch ? 'need_rules' THEN
    DELETE FROM public.warehouse_item_need_rules WHERE item_id = iid;
    FOR rule IN SELECT * FROM jsonb_array_elements(p_patch -> 'need_rules') LOOP
      n := n + 1;
      INSERT INTO public.warehouse_item_need_rules (item_id, need_unit, quantity, quantity_rule, applies_when, sort_order)
      VALUES (iid, rule ->> 'need_unit', (rule ->> 'quantity')::numeric, rule -> 'quantity_rule', rule -> 'applies_when', n);
    END LOOP;
    SELECT * INTO i FROM public.warehouse_items WHERE id = iid;
  END IF;
  PERFORM public.calc_audit(CASE WHEN p_id IS NULL THEN 'warehouse_item_create' WHEN (p_patch ->> 'is_active') = 'false' THEN 'warehouse_item_deactivate' ELSE 'warehouse_item_update' END,
    'warehouse_item', iid::text, before, public.wh_item_json(i), p_reason);
  RETURN jsonb_build_object('id', iid, 'version', i.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Create a movement (document with lines, in the register's entry state) and cancel a pending one
-- ---------------------------------------------------------------------------------------------------------------------
-- p_lines: [{item_id, qty, qty_approved?, condition?, serials?[]}]. p_data: the header fields of the register. The register checks the caller (grant,
-- entry holder, region); the stock rules are checked here and a pending DN reserves its quantities from the moment it exists.
CREATE OR REPLACE FUNCTION wh_create_movement(p_record_type text, p_site uuid, p_data jsonb, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rid uuid; rec public.register_records%ROWTYPE; mid uuid; kind_ text; ln jsonb; i int := 0; it public.warehouse_items%ROWTYPE; q numeric; qa numeric; errs jsonb := '[]'::jsonb;
  sers text[]; sn text; st record; net numeric; ser_row public.warehouse_serials%ROWTYPE; dup uuid; docno text; seen uuid[] := ARRAY[]::uuid[]; iid uuid;
BEGIN
  kind_ := CASE WHEN p_record_type IN ('te_dn', 'cw_dn') THEN 'issue' WHEN p_record_type IN ('te_rn', 'cw_rn') THEN 'return' WHEN p_record_type IN ('pl', 'open') THEN 'receipt' WHEN p_record_type = 'adj' THEN 'adjustment' END;
  IF kind_ IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a warehouse document type.')));
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/lines', 'required', 'At least one line is required.')));
  END IF;
  docno := btrim(coalesce(p_data ->> 'doc_no', ''));
  IF docno <> '' THEN
    SELECT x.id INTO dup FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(docno) LIMIT 1;
    IF dup IS NOT NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('existing_id', dup, 'detail', 'Duplicate Doc No.: ' || docno)); END IF;
  END IF;

  -- the register checks who may create (grant, entry holder, region of the site) and the header fields
  rid := public.reg_save_record('warehouse', NULL, NULL, p_site, p_record_type, coalesce(p_data, '{}'::jsonb), NULL, NULL, false);
  SELECT * INTO rec FROM public.register_records WHERE id = rid;
  INSERT INTO public.wh_movements (entity_id, record_id, record_type, kind, site_id, region_id, is_global, created_by)
  VALUES (rec.entity_id, rid, p_record_type, kind_, rec.site_id, rec.region_id, rec.is_global, public.app_actor()) RETURNING id INTO mid;

  -- lock the items in a fixed order: two documents cannot both take the last quantity
  PERFORM 1 FROM public.warehouse_items w WHERE w.id IN (SELECT (e ->> 'item_id')::uuid FROM jsonb_array_elements(p_lines) e WHERE e ->> 'item_id' ~* '^[0-9a-f-]{36}$') ORDER BY w.id FOR UPDATE;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    i := i + 1;
    IF coalesce(ln ->> 'item_id', '') !~* '^[0-9a-f-]{36}$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'required', 'The item is required.'); CONTINUE; END IF;
    iid := (ln ->> 'item_id')::uuid;
    SELECT * INTO it FROM public.warehouse_items w WHERE w.id = iid AND w.is_active;
    IF NOT FOUND THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'unknown_item', 'Unknown or inactive item.'); CONTINUE; END IF;
    IF iid = ANY (seen) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'duplicate', 'The item appears twice: use one line per item.'); CONTINUE; END IF;
    seen := seen || iid;
    IF coalesce(ln ->> 'qty', '') !~ '^-?[0-9]+(\.[0-9]{1,3})?$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'invalid', 'A number.'); CONTINUE; END IF;
    q := (ln ->> 'qty')::numeric;
    IF (kind_ <> 'adjustment' AND q <= 0) OR q = 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'not_positive', CASE WHEN kind_ = 'adjustment' THEN 'The quantity cannot be zero.' ELSE 'The quantity must be above zero (only an adjustment may be negative).' END); CONTINUE; END IF;
    IF lower(coalesce(it.unit, '')) IN ('pcs', 'set') AND q <> trunc(q) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'whole_units', 'No fraction in whole units (pieces and sets).'); CONTINUE; END IF;
    qa := NULL;
    IF ln ? 'qty_approved' AND jsonb_typeof(ln -> 'qty_approved') <> 'null' THEN
      IF kind_ <> 'issue' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty_approved', 'not_applicable', 'Qty Approved belongs to a delivery note.'); CONTINUE; END IF;
      IF coalesce(ln ->> 'qty_approved', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (ln ->> 'qty_approved')::numeric < q THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty_approved', 'below_dispatched', 'Qty Approved is a number not below the dispatched quantity.'); CONTINUE; END IF;
      qa := (ln ->> 'qty_approved')::numeric;
    END IF;
    IF ln ? 'condition' AND jsonb_typeof(ln -> 'condition') <> 'null' AND (kind_ <> 'return' OR ln ->> 'condition' NOT IN ('Good', 'Faulty', 'Damaged')) THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/condition', 'invalid', 'Condition (Good, Faulty, Damaged) belongs to a return note.'); CONTINUE;
    END IF;

    -- serials: PL, DN and RN rows of a serial-tracked item carry exactly one serial per unit (WH Serials, DQ19)
    sers := CASE WHEN ln ? 'serials' AND jsonb_typeof(ln -> 'serials') = 'array' THEN ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(ln -> 'serials') x) ELSE ARRAY[]::text[] END;
    IF cardinality(sers) <> (SELECT count(DISTINCT s) FROM unnest(sers) s) OR '' = ANY (sers) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'A serial appears twice or is empty.'); CONTINUE; END IF;
    IF NOT it.serialised AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_serial_tracked', 'This item is not serial-tracked.'); CONTINUE; END IF;
    IF it.serialised AND kind_ = 'adjustment' AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_applicable', 'An adjustment carries no serials.'); CONTINUE; END IF;
    IF it.serialised AND p_record_type <> 'open' AND kind_ <> 'adjustment' AND cardinality(sers) <> q THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_count', 'The serial count must equal the quantity (' || q || ').'); CONTINUE;
    END IF;
    IF it.serialised AND kind_ = 'adjustment' AND q < 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'serial_adjustment', 'A serial-tracked item cannot be adjusted down: return or correct the serials.'); CONTINUE; END IF;
    FOREACH sn IN ARRAY sers LOOP
      SELECT * INTO ser_row FROM public.warehouse_serials w WHERE w.serial_no = sn;
      IF kind_ = 'receipt' THEN
        IF FOUND OR EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'receipt' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'Duplicate serial: ' || sn);
        END IF;
      ELSIF kind_ = 'issue' THEN
        IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
        ELSIF ser_row.status IS DISTINCT FROM 'In Stock' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_not_in_stock', 'Serial not in stock: ' || sn);
        ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'issue' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial reserved by another pending delivery note: ' || sn);
        END IF;
      ELSIF kind_ = 'return' THEN
        IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
        ELSIF ser_row.site_id IS DISTINCT FROM rec.site_id OR ser_row.status IS DISTINCT FROM 'Dispatched' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'rn_without_dn', 'Return without a delivery note to this site: ' || sn);
        ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'return' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial in another pending return note: ' || sn);
        END IF;
      END IF;
    END LOOP;

    -- stock rules: an issue (or a negative adjustment) cannot take more than is available; a return cannot exceed what the site holds
    IF kind_ = 'issue' OR (kind_ = 'adjustment' AND q < 0) THEN
      SELECT * INTO st FROM public.wh_stock_levels(iid, NULL);
      IF st.available < abs(q) THEN
        PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'Not enough stock of ' || it.name || ': ' || st.available || ' available (' || st.on_hand || ' on hand, ' || st.reserved || ' reserved).',
          'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_stock', 'Available: ' || st.available)));
      END IF;
    ELSIF kind_ = 'return' THEN
      SELECT * INTO st FROM public.wh_stock_levels(iid, rec.site_id);
      net := coalesce(st.on_hand, 0) - coalesce(st.pending_return, 0);
      IF q > net THEN
        PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'The site holds ' || net || ' of ' || it.name || ' (delivered minus returned): it cannot return ' || q || '.',
          'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_on_site', 'The site holds ' || net)));
      END IF;
    END IF;
    INSERT INTO public.wh_movement_lines (movement_id, item_id, qty, qty_approved, condition, serials, sort_order)
    VALUES (mid, iid, q, qa, ln ->> 'condition', sers, i);
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN mid;
END $$;

-- Cancel a pending movement: the register record is voided (reason, audit) and the reservation is released by the state trigger below.
CREATE OR REPLACE FUNCTION wh_cancel_movement(p_id uuid, p_version integer, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.wh_movements%ROWTYPE; rec public.register_records%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.wh_movements WHERE id = p_id AND public.app_region_read(is_global, region_id) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The movement does not exist or is not visible to you.')); END IF;
  IF p_version IS NOT NULL AND p_version <> m.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF m.status <> 'pending' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a pending movement can be cancelled (it is ' || m.status || ').')); END IF;
  SELECT * INTO rec FROM public.register_records WHERE entity_id = m.entity_id AND state IN ('entry', 'in_review', 'in_approval') ORDER BY version_no DESC LIMIT 1;
  IF NOT FOUND THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The document has no open version.')); END IF;
  PERFORM public.reg_void_record(rec.id, rec.version, p_reason);
END $$;

-- The movement follows its register record: approved -> posted (stock, serials, site quantity), voided -> cancelled (reservation released).
CREATE OR REPLACE FUNCTION wh_on_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.wh_movements%ROWTYPE; ln public.wh_movement_lines%ROWTYPE; doc text := NEW.data ->> 'doc_no'; ddate date := coalesce((NEW.data ->> 'doc_date')::date, current_date); cond text;
BEGIN
  SELECT * INTO m FROM public.wh_movements WHERE entity_id = NEW.entity_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'pending' THEN RETURN NULL; END IF;
  IF NEW.state = 'voided' THEN
    UPDATE public.wh_movements SET status = 'cancelled', cancel_reason = NEW.void_reason, version = version + 1 WHERE id = m.id;
    RETURN NULL;
  END IF;
  FOR ln IN SELECT * FROM public.wh_movement_lines WHERE movement_id = m.id LOOP
    IF m.kind = 'receipt' AND cardinality(ln.serials) > 0 THEN
      INSERT INTO public.warehouse_serials (item_id, serial_no, pl_invoice_no, status, is_global) SELECT ln.item_id, s, doc, 'In Stock', true FROM unnest(ln.serials) s;
    ELSIF m.kind = 'issue' THEN
      UPDATE public.warehouse_serials SET site_id = m.site_id, region_id = m.region_id, is_global = false, dn_no = doc, dispatch_date = ddate, status = 'Dispatched'
        WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials);
    ELSIF m.kind = 'return' THEN
      cond := coalesce(ln.condition, NEW.data ->> 'condition', 'Good');
      UPDATE public.warehouse_serials SET rn_no = doc, return_condition = cond, status = CASE WHEN lower(cond) = 'good' THEN 'In Stock' ELSE 'Returned' END,
        site_id = NULL, region_id = NULL, is_global = true WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials);
    END IF;
    IF m.kind IN ('issue', 'return') THEN
      INSERT INTO public.warehouse_site_qty (site_id, region_id, item_id, dispatched) VALUES (m.site_id, m.region_id, ln.item_id, CASE m.kind WHEN 'issue' THEN ln.qty ELSE -ln.qty END)
      ON CONFLICT (site_id, item_id) DO UPDATE SET dispatched = public.warehouse_site_qty.dispatched + EXCLUDED.dispatched;
    END IF;
  END LOOP;
  UPDATE public.wh_movements SET status = 'posted', posted_at = now(), version = version + 1 WHERE id = m.id;
  RETURN NULL;
END $$;

CREATE TRIGGER z_wh_on_state AFTER UPDATE OF state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'warehouse' AND NEW.state IN ('approved', 'voided') AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION wh_on_state();

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Submit-time rules of the register (WH!K, DQ18-DQ20): lines, RN reason, Doc No. unique
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_validate_warehouse(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; errs jsonb := '[]'::jsonb; other uuid;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.register_key <> 'warehouse' THEN RETURN errs; END IF;
  IF r.record_type IS NULL THEN errs := errs || public.reg_err_item('/record_type', 'required', 'The document type is required.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_movements m JOIN public.wh_movement_lines l ON l.movement_id = m.id WHERE m.entity_id = r.entity_id) THEN
    errs := errs || public.reg_err_item('/lines', 'lines_required', 'A warehouse document needs at least one quantity: create it with POST /warehouse/movements.');
  END IF;
  IF r.record_type IN ('te_rn', 'cw_rn') AND btrim(coalesce(r.data ->> 'reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/reason', 'required', 'A return note needs a reason (BP 10).'); END IF;
  SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(r.data ->> 'doc_no') LIMIT 1;
  IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/doc_no', 'duplicate', 'Duplicate Doc No.'); END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION reg_validate(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_validate_core(p_record) || public.reg_validate_catalog(p_record) || public.reg_validate_warehouse(p_record)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean)', 'wh_stock_levels(uuid,uuid)', 'wh_item_json(warehouse_items)',
    'admin_save_warehouse_item(uuid,jsonb,text,integer)', 'wh_create_movement(text,uuid,jsonb,jsonb)', 'wh_cancel_movement(uuid,integer,text)', 'wh_on_state()', 'reg_validate_warehouse(uuid)', 'reg_validate(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean)', 'wh_stock_levels(uuid,uuid)', 'admin_save_warehouse_item(uuid,jsonb,text,integer)',
      'wh_create_movement(text,uuid,jsonb,jsonb)', 'wh_cancel_movement(uuid,integer,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
