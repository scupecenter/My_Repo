-- 0413 (contract 0.15.342): logistics depth, phase 3.
--   1. Reorder limits per warehouse item: a level below which the item is flagged "below reorder", and a suggested reorder quantity. Configuration (KEEP in the
--      data reset). Written only by admin_save_reorder_limit (System Admin or a delegate of warehouse_items.edit for all regions, reason, audited, versioned).
--   2. Supplier returns (RMA): the follow-up of a "returned to supplier" quarantine exit (Q270): what the supplier did (replaced, credited, rejected) and when.
--      Tracking only: stock moves through the existing quarantine exit, never through this table. Written by wh_rma_save / wh_rma_set_status for the actors
--      with the warehouse create right. Additive. The stored text of data_reset_plan() is patched in place, idempotently.

CREATE TABLE warehouse_reorder_limits (
  item_id       UUID PRIMARY KEY REFERENCES warehouse_items (id) ON DELETE CASCADE ON UPDATE CASCADE,
  reorder_level NUMERIC(14,3) NOT NULL CHECK (reorder_level >= 0),
  reorder_qty   NUMERIC(14,3) CHECK (reorder_qty IS NULL OR reorder_qty > 0),
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by    UUID
);
COMMENT ON TABLE warehouse_reorder_limits IS 'Reorder limit of a warehouse item (contract 0.15.342): flagged "below reorder" when the available stock is at or under the level. Configuration; no row = no limit.';

CREATE TABLE wh_rma (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rma_no           TEXT NOT NULL UNIQUE,
  item_id          UUID NOT NULL REFERENCES warehouse_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  qty              NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  supplier         TEXT NOT NULL CHECK (char_length(btrim(supplier)) BETWEEN 1 AND 200),
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'replaced', 'credited', 'rejected', 'closed')),
  reason           TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  movement_id      UUID REFERENCES wh_movements (id) ON DELETE SET NULL ON UPDATE CASCADE,
  sent_on          DATE NOT NULL DEFAULT current_date,
  resolved_on      DATE,
  resolution_note  TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  version          INTEGER NOT NULL DEFAULT 1,
  created_by       UUID,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by       UUID
);
COMMENT ON TABLE wh_rma IS 'Supplier return (RMA) follow-up (contract 0.15.342): the items sent back to the supplier from quarantine and what the supplier did. Tracking only, no stock effect.';
CREATE INDEX wh_rma_item_idx ON wh_rma (item_id);
CREATE INDEX wh_rma_status_idx ON wh_rma (status);
CREATE SEQUENCE wh_rma_no_seq;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouse_reorder_limits', 'wh_rma'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY rls_seed_write ON %I FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_reorder_limits, wh_rma TO pmis_definer;
GRANT USAGE, SELECT ON SEQUENCE wh_rma_no_seq TO pmis_definer;
GRANT SELECT ON warehouse_items, wh_movements TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON warehouse_reorder_limits, wh_rma FROM pmis_app;
    GRANT SELECT ON warehouse_reorder_limits, wh_rma TO pmis_app;
  END IF;
END $$;

-- Set (or clear with a NULL level) the reorder limit of an item.
CREATE OR REPLACE FUNCTION admin_save_reorder_limit(p_item uuid, p_level numeric, p_qty numeric, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.warehouse_reorder_limits%ROWTYPE; before jsonb; after jsonb;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  IF NOT EXISTS (SELECT 1 FROM public.warehouse_items i WHERE i.id = p_item) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'Unknown item.')); END IF;
  IF p_level IS NOT NULL AND p_level < 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reorder_level', 'out_of_range', 'Zero or more.')));
  END IF;
  IF p_qty IS NOT NULL AND p_qty <= 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reorder_qty', 'out_of_range', 'Above zero, or empty.')));
  END IF;
  SELECT * INTO v FROM public.warehouse_reorder_limits WHERE item_id = p_item FOR UPDATE;
  IF FOUND THEN
    IF p_version IS NOT NULL AND p_version <> v.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    before := jsonb_build_object('item_id', v.item_id, 'reorder_level', v.reorder_level, 'reorder_qty', v.reorder_qty, 'version', v.version);
  END IF;
  IF p_level IS NULL THEN
    DELETE FROM public.warehouse_reorder_limits WHERE item_id = p_item;
    after := jsonb_build_object('item_id', p_item, 'reorder_level', NULL, 'reorder_qty', NULL, 'version', coalesce(v.version, 0) + 1);
  ELSE
    INSERT INTO public.warehouse_reorder_limits (item_id, reorder_level, reorder_qty, updated_by) VALUES (p_item, p_level, p_qty, public.app_actor())
    ON CONFLICT (item_id) DO UPDATE SET reorder_level = EXCLUDED.reorder_level, reorder_qty = EXCLUDED.reorder_qty, version = public.warehouse_reorder_limits.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
    RETURNING * INTO v;
    after := jsonb_build_object('item_id', v.item_id, 'reorder_level', v.reorder_level, 'reorder_qty', v.reorder_qty, 'version', v.version);
  END IF;
  PERFORM public.log_audit_write('warehouse_reorder_limit_save', 'warehouse_reorder_limit', p_item::text, before, after, p_reason);
  RETURN after;
END $$;

-- New supplier return (RMA): the caller needs the warehouse create right. The number comes from a sequence and is never reused.
CREATE OR REPLACE FUNCTION wh_rma_create(p_item uuid, p_qty numeric, p_supplier text, p_reason text, p_movement uuid DEFAULT NULL, p_sent_on date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.wh_rma%ROWTYPE; errs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.reg_require_grant('warehouse', NULL, 'create');
  IF NOT EXISTS (SELECT 1 FROM public.warehouse_items i WHERE i.id = p_item) THEN errs := errs || public.reg_err_item('/item_id', 'unknown_item', 'Unknown item.'); END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN errs := errs || public.reg_err_item('/qty', 'not_positive', 'The quantity must be above zero.'); END IF;
  IF char_length(btrim(coalesce(p_supplier, ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || public.reg_err_item('/supplier', 'required', 'The supplier is required.'); END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 1000 THEN errs := errs || public.reg_err_item('/reason', 'required', 'A reason of 3 to 1000 characters is required.'); END IF;
  IF p_movement IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_movements m WHERE m.id = p_movement AND m.kind = 'quarantine_exit' AND m.exit_kind = 'returned_to_supplier') THEN
    errs := errs || public.reg_err_item('/movement_id', 'not_found', 'Not a "returned to supplier" quarantine exit.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.wh_rma (rma_no, item_id, qty, supplier, reason, movement_id, sent_on, created_by, updated_by)
  VALUES ('RMA-' || lpad(nextval('public.wh_rma_no_seq')::text, 5, '0'), p_item, p_qty, btrim(p_supplier), btrim(p_reason), p_movement, coalesce(p_sent_on, current_date), public.app_actor(), public.app_actor())
  RETURNING * INTO r;
  PERFORM public.log_audit_write('wh_rma_create', 'wh_rma', r.id::text, NULL, to_jsonb(r), p_reason);
  RETURN to_jsonb(r);
END $$;

-- Move an RMA to its next status: sent -> replaced | credited | rejected -> closed. A closed RMA does not change.
CREATE OR REPLACE FUNCTION wh_rma_set_status(p_id uuid, p_status text, p_note text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.wh_rma%ROWTYPE; before jsonb; ok boolean;
BEGIN
  PERFORM public.reg_require_grant('warehouse', NULL, 'create');
  SELECT * INTO r FROM public.wh_rma WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'Unknown RMA.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  ok := (r.status = 'sent' AND p_status IN ('replaced', 'credited', 'rejected')) OR (r.status IN ('replaced', 'credited', 'rejected') AND p_status = 'closed');
  IF NOT ok THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/status', 'bad_transition', 'From ' || r.status || ' to ' || coalesce(p_status, 'null') || ' is not allowed.'))); END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 1000 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/note', 'too_long', 'At most 1000 characters.'))); END IF;
  before := to_jsonb(r);
  UPDATE public.wh_rma SET status = p_status, resolution_note = coalesce(nullif(btrim(p_note), ''), resolution_note), resolved_on = coalesce(resolved_on, current_date),
    version = version + 1, updated_at = now(), updated_by = public.app_actor() WHERE id = p_id RETURNING * INTO r;
  PERFORM public.log_audit_write('wh_rma_status', 'wh_rma', r.id::text, before, to_jsonb(r), p_note);
  RETURN to_jsonb(r);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['admin_save_reorder_limit(uuid,numeric,numeric,text,integer)', 'wh_rma_create(uuid,numeric,text,text,uuid,date)', 'wh_rma_set_status(uuid,text,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;

-- Data reset coverage (0152): the limits are configuration (KEEP, beside the region vendors); the RMA rows are a supplier-return journal (LOG, kept on a reset,
-- like job_runs: a reset of the warehouse part clears the movements, the item master and the supplier claims stay). data_reset_plan() is an accumulating function: patched in place, idempotently, never redefined from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''warehouse_reorder_limits''' IN def) = 0 THEN
    IF position('''warehouse_region_vendors''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''warehouse_region_vendors''', '''warehouse_region_vendors'', ''warehouse_reorder_limits''');
  END IF;
  IF position('''wh_rma''' IN def) = 0 THEN
    IF position('''job_runs''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the log list anchor was not found'; END IF;
    def := replace(def, '''job_runs''', '''job_runs'', ''wh_rma''');
  END IF;
  EXECUTE def;
END $$;
GRANT SELECT, UPDATE ON public.warehouse_reorder_limits, public.wh_rma TO pmis_reset_owner;
