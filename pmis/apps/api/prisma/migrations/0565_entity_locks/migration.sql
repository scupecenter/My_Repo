-- Migration 0565 (hardening layer 1a, owner choices relayed 2026-11-27): locks for the Warehouse item master and movements, on the same
-- model as the register locks of 0103. Additive. Mirror: db/sql/564_entity_locks.sql (kept identical).
--   1. entity_locks / entity_column_locks: one open lock per target (kind + id) or per column (kind + code); lock and unlock are both kept.
--      Kinds: wh_item, wh_movement now; daily_plan and daily_plan_row are used by the next migration (0566). The 0103 tables are untouched.
--   2. ent_lock_require / ent_lock_check / ent_lock_set / ent_column_lock_set: the same administer right, reason, audit; System Admins exempt.
--   3. Writers patched in place (pg_get_functiondef, idempotent): admin_save_warehouse_item, admin_save_warehouse_item_custom,
--      wh_create_movement, wh_create_quarantine_exit, wh_cancel_movement.
--   4. admin_delete_warehouse_item now HIDES the item (is_active = false, reason, audit). Nothing is deleted any more.
--   5. Data reset: both tables are classified KEEP (no foreign keys; a lock on a removed target is ignored by the screen).

CREATE TABLE entity_locks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind   text NOT NULL CHECK (target_kind IN ('wh_item', 'wh_movement', 'daily_plan', 'daily_plan_row')),
  target_id     uuid NOT NULL,
  reason        text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  locked_by     uuid NOT NULL,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  unlocked_by   uuid,
  unlocked_at   timestamptz,
  unlock_reason text,
  CONSTRAINT entity_locks_unlock_pair CHECK ((unlocked_at IS NULL) = (unlocked_by IS NULL))
);
CREATE UNIQUE INDEX entity_locks_open_idx ON entity_locks (target_kind, target_id) WHERE unlocked_at IS NULL;

CREATE TABLE entity_column_locks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind   text NOT NULL CHECK (target_kind IN ('wh_item', 'wh_movement', 'daily_plan_row')),
  field_code    text NOT NULL CHECK (char_length(field_code) BETWEEN 1 AND 64),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  locked_by     uuid NOT NULL,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  unlocked_by   uuid,
  unlocked_at   timestamptz,
  unlock_reason text,
  CONSTRAINT entity_column_locks_unlock_pair CHECK ((unlocked_at IS NULL) = (unlocked_by IS NULL))
);
CREATE UNIQUE INDEX entity_column_locks_open_idx ON entity_column_locks (target_kind, field_code) WHERE unlocked_at IS NULL;

CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON entity_locks FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON entity_column_locks FOR EACH ROW EXECUTE FUNCTION reg_backstop();

-- The administer right of the target. wh_item: the module warehouse_items in every region. wh_movement: the register 'warehouse' in the movement's region.
-- daily_plan / daily_plan_row: the Daily Plan right dp_right in the plan's region.
CREATE OR REPLACE FUNCTION ent_lock_require(p_kind text, p_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); reg int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind = 'wh_item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.warehouse_items i WHERE i.id = p_id) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
    IF public.wf_actor_regions('warehouse_items', 'administer') IS NOT NULL THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'An item lock needs administer on the item master in all regions.'));
    END IF;
  ELSIF p_kind = 'wh_movement' THEN
    SELECT m.region_id INTO reg FROM public.wh_movements m WHERE m.id = p_id;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The movement does not exist.')); END IF;
    PERFORM public.reg_require_grant('warehouse', reg, 'administer');
  ELSIF p_kind = 'daily_plan' THEN
    SELECT p.region_id INTO reg FROM public.daily_plans p WHERE p.id = p_id;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The plan does not exist.')); END IF;
    IF NOT public.dp_right(actor, reg, 'administer') THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need administer on the Daily Plan in this region.')); END IF;
  ELSIF p_kind = 'daily_plan_row' THEN
    SELECT r.region_id INTO reg FROM public.daily_plan_rows r WHERE r.id = p_id;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The row does not exist.')); END IF;
    IF NOT public.dp_right(actor, reg, 'administer') THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need administer on the Daily Plan in this region.')); END IF;
  ELSE
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kind', 'not_in_list', 'Unknown lock target.')));
  END IF;
END $$;

-- Refuses a write that touches a locked target or a locked column (403 register_locked). A create passes p_id NULL (columns only). System Admins are exempt.
CREATE OR REPLACE FUNCTION ent_lock_check(p_kind text, p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE hit text;
BEGIN
  IF public.app_user_is_system_admin(public.app_actor()) THEN RETURN; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.entity_locks l WHERE l.target_kind = p_kind AND l.target_id = p_id AND l.unlocked_at IS NULL) THEN
    PERFORM public.wf_err('register_locked', jsonb_build_object('detail', 'This record is locked. Only a System Admin can change it, or it must be unlocked first.'));
  END IF;
  IF p_data IS NOT NULL AND jsonb_typeof(p_data) = 'object' THEN
    SELECT c.field_code INTO hit FROM public.entity_column_locks c
    WHERE c.target_kind = p_kind AND c.unlocked_at IS NULL AND p_data ? c.field_code LIMIT 1;
    IF hit IS NOT NULL THEN
      PERFORM public.wf_err('register_locked', jsonb_build_object('detail', 'The column "' || hit || '" is locked.',
        'errors', public.reg_err_item('/' || hit, 'register_locked', 'This column is locked.')));
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ent_lock_set(p_kind text, p_id uuid, p_locked boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); was boolean;
BEGIN
  PERFORM public.ent_lock_require(p_kind, p_id);
  IF coalesce(btrim(p_reason), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason is required.')));
  END IF;
  was := EXISTS (SELECT 1 FROM public.entity_locks l WHERE l.target_kind = p_kind AND l.target_id = p_id AND l.unlocked_at IS NULL);
  IF p_locked AND was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is already locked.')); END IF;
  IF NOT p_locked AND NOT was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is not locked.')); END IF;
  IF p_locked THEN
    INSERT INTO public.entity_locks (target_kind, target_id, reason, locked_by) VALUES (p_kind, p_id, p_reason, actor);
  ELSE
    UPDATE public.entity_locks SET unlocked_by = actor, unlocked_at = now(), unlock_reason = p_reason WHERE target_kind = p_kind AND target_id = p_id AND unlocked_at IS NULL;
  END IF;
  PERFORM public.log_audit_write(CASE WHEN p_locked THEN 'entity_lock' ELSE 'entity_unlock' END, p_kind, p_id::text,
    jsonb_build_object('locked', was), jsonb_build_object('locked', p_locked), btrim(p_reason));
END $$;

CREATE OR REPLACE FUNCTION ent_column_lock_set(p_kind text, p_code text, p_locked boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); was boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind NOT IN ('wh_item', 'wh_movement', 'daily_plan_row') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kind', 'not_in_list', 'Unknown lock target.')));
  END IF;
  IF coalesce(btrim(p_code), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/field', 'required', 'The column is required.')));
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason is required.')));
  END IF;
  -- a column is shared by every region: administer in all regions
  IF p_kind = 'wh_item' THEN
    IF public.wf_actor_regions('warehouse_items', 'administer') IS NOT NULL THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'A column lock covers every region: it needs administer in all regions.')); END IF;
  ELSIF p_kind = 'wh_movement' THEN
    PERFORM public.reg_require_grant('warehouse', NULL, 'administer');
    IF public.wf_actor_regions(public.reg_module('warehouse'), 'administer') IS NOT NULL THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'A column lock covers every region: it needs administer in all regions.')); END IF;
  ELSE
    IF NOT (public.app_user_is_system_admin(actor) OR EXISTS (SELECT 1 FROM public.regions r WHERE public.dp_right(actor, r.id, 'administer'))) THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need administer on the Daily Plan.'));
    END IF;
  END IF;
  was := EXISTS (SELECT 1 FROM public.entity_column_locks c WHERE c.target_kind = p_kind AND c.field_code = p_code AND c.unlocked_at IS NULL);
  IF p_locked AND was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This column is already locked.')); END IF;
  IF NOT p_locked AND NOT was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This column is not locked.')); END IF;
  IF p_locked THEN
    INSERT INTO public.entity_column_locks (target_kind, field_code, reason, locked_by) VALUES (p_kind, p_code, p_reason, actor);
  ELSE
    UPDATE public.entity_column_locks SET unlocked_by = actor, unlocked_at = now(), unlock_reason = p_reason WHERE target_kind = p_kind AND field_code = p_code AND unlocked_at IS NULL;
  END IF;
  PERFORM public.log_audit_write(CASE WHEN p_locked THEN 'entity_column_lock' ELSE 'entity_column_unlock' END, p_kind, p_code,
    jsonb_build_object('locked', was), jsonb_build_object('locked', p_locked), btrim(p_reason));
END $$;

-- Writers: one ent_lock_check line after the first reason/BEGIN anchor; patched in place, idempotent (the stored text is the base).
DO $$
DECLARE def text; spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('public.admin_save_warehouse_item(uuid,jsonb,text,integer)',        'PERFORM public.calc_require_reason(p_reason);', E'\n  PERFORM public.ent_lock_check(''wh_item'', p_id, p_patch);'),
    ('public.admin_save_warehouse_item_custom(uuid,jsonb,text,integer)', 'PERFORM public.calc_require_reason(p_reason);', E'\n  PERFORM public.ent_lock_check(''wh_item'', p_id, p_patch);'),
    ('public.wh_create_movement(text,uuid,jsonb,jsonb)',                 NULL, E'\n  PERFORM public.ent_lock_check(''wh_movement'', NULL, p_data);'),
    ('public.wh_create_quarantine_exit(text,jsonb,jsonb)',               NULL, E'\n  PERFORM public.ent_lock_check(''wh_movement'', NULL, p_data);'),
    ('public.wh_cancel_movement(uuid,integer,text)',                     NULL, E'\n  PERFORM public.ent_lock_check(''wh_movement'', p_id, NULL);')
  ) v(fn, anchor, line) LOOP
    def := pg_get_functiondef(spec.fn::regprocedure);
    IF position('ent_lock_check' IN def) = 0 THEN
      IF spec.anchor IS NOT NULL THEN
        IF position(spec.anchor IN def) = 0 THEN RAISE EXCEPTION '%: anchor not found', spec.fn; END IF;
        def := overlay(def PLACING spec.anchor || spec.line FROM position(spec.anchor IN def) FOR length(spec.anchor));
      ELSE
        IF position(E'\nBEGIN' IN def) = 0 THEN RAISE EXCEPTION '%: BEGIN not found', spec.fn; END IF;
        def := overlay(def PLACING E'\nBEGIN' || spec.line FROM position(E'\nBEGIN' IN def) FOR 6);
      END IF;
      EXECUTE def;
    END IF;
  END LOOP;
END $$;

-- Hide, never delete: the old delete door (0160) now hides the item. The signature stays, so the API call is unchanged.
CREATE OR REPLACE FUNCTION admin_delete_warehouse_item(p_id uuid, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.warehouse_items%ROWTYPE; before jsonb;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO i FROM public.warehouse_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> i.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The item changed since you read it.')); END IF;
  PERFORM public.ent_lock_check('wh_item', p_id, NULL);
  before := public.wh_item_json(i);
  UPDATE public.warehouse_items SET is_active = false, version = version + 1, updated_at = now() WHERE id = p_id;
  PERFORM public.log_audit_write('warehouse_item_hide', 'warehouse_item', p_id::text, before, public.wh_item_json((SELECT x FROM public.warehouse_items x WHERE x.id = p_id)), btrim(p_reason));
  RETURN jsonb_build_object('id', p_id, 'deleted', true, 'hidden', true);
END $$;

-- The open locks for the lock lists (record and column), optionally of one kind. A definer function: the application role has no table rights on the targets (movements, plans).
CREATE OR REPLACE FUNCTION ent_lock_list(p_kind text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'records', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.locked_at DESC) FROM (
      SELECT l.id::text AS id, l.target_kind AS kind, l.target_id::text AS target_id, l.reason, l.locked_at::text AS locked_at, u.display_name AS locked_by,
        CASE l.target_kind WHEN 'wh_item' THEN (SELECT i.item_code FROM public.warehouse_items i WHERE i.id = l.target_id)
          WHEN 'wh_movement' THEN (SELECT m.doc_no FROM public.wh_movements m WHERE m.id = l.target_id)
          WHEN 'daily_plan' THEN (SELECT p.plan_date::text FROM public.daily_plans p WHERE p.id = l.target_id)
          WHEN 'daily_plan_row' THEN (SELECT p.plan_date::text FROM public.daily_plan_rows r JOIN public.daily_plans p ON p.id = r.plan_id WHERE r.id = l.target_id) END AS label
      FROM public.entity_locks l LEFT JOIN public.users u ON u.id = l.locked_by
      WHERE l.unlocked_at IS NULL AND (p_kind IS NULL OR l.target_kind = p_kind) ORDER BY l.locked_at DESC LIMIT 500) x), '[]'::jsonb),
    'columns', coalesce((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.locked_at DESC) FROM (
      SELECT c.id::text AS id, c.target_kind AS kind, c.field_code AS field, c.reason, c.locked_at::text AS locked_at, u.display_name AS locked_by
      FROM public.entity_column_locks c LEFT JOIN public.users u ON u.id = c.locked_by
      WHERE c.unlocked_at IS NULL AND (p_kind IS NULL OR c.target_kind = p_kind) ORDER BY c.locked_at DESC LIMIT 500) y), '[]'::jsonb))
$$;

DO $$
BEGIN
  ALTER TABLE entity_locks OWNER TO pmis_definer;
  ALTER TABLE entity_column_locks OWNER TO pmis_definer;
  ALTER FUNCTION ent_lock_require(text, uuid) OWNER TO pmis_definer;
  ALTER FUNCTION ent_lock_check(text, uuid, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION ent_lock_set(text, uuid, boolean, text) OWNER TO pmis_definer;
  ALTER FUNCTION ent_column_lock_set(text, text, boolean, text) OWNER TO pmis_definer;
  ALTER FUNCTION ent_lock_list(text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION ent_lock_require(text, uuid), ent_lock_check(text, uuid, jsonb), ent_lock_set(text, uuid, boolean, text), ent_column_lock_set(text, text, boolean, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION ent_lock_list(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION ent_lock_list(text) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION ent_lock_require(text, uuid), ent_lock_check(text, uuid, jsonb), ent_lock_set(text, uuid, boolean, text), ent_column_lock_set(text, text, boolean, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON entity_locks, entity_column_locks TO pmis_app;
    GRANT EXECUTE ON FUNCTION ent_lock_list(text) TO pmis_app;
    GRANT EXECUTE ON FUNCTION ent_lock_require(text, uuid), ent_lock_check(text, uuid, jsonb), ent_lock_set(text, uuid, boolean, text), ent_column_lock_set(text, text, boolean, text) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): KEEP, like record_edit_presence. Patched in place (0345 pattern), never redefined.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''entity_locks''' IN def) = 0 THEN
    IF position('''user_sessions''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''user_sessions''', '''user_sessions'', ''entity_locks'', ''entity_column_locks''');
  END IF;
  EXECUTE def;
END $$;
GRANT SELECT, UPDATE ON public.entity_locks, public.entity_column_locks TO pmis_reset_owner;
