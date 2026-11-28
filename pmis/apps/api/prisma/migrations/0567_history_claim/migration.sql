-- Migration 0567 (hardening layer 1c, choices relayed by the parent 2026-11-27 22:04): History and Restore for the Warehouse item master and the Daily
-- Plan, and Claim / Triage of a Daily Plan day. Additive. Mirror: db/sql/566_history_claim.sql (kept identical).
--   1. hist_changes(before, after): the field diff of two audit snapshots.
--   2. wh_item_history(item): the audit trail of one item, newest first, with the field changes (System Admin or a warehouse_items delegate).
--      Restore is not a new write path: the web sends the old values through the normal item writer (rights, locks of 0565, reason, audit).
--   3. dp_plan_history(region, date): the audit trail of one plan day (rows changed, added, removed, locked, unlocked), with the field changes.
--   4. Claim and Triage of a plan day (target chosen by the parent: the plan day of a region, region + date): six nullable columns on daily_plans,
--      a trigger that starts a new plan day as 'pending', dp_plan_claim (claim / release), dp_plan_triage (accepted / deferred, with a note), and
--      dp_plan_triage_get. The holder is the L2 (approve) of the Daily Plan in the region, as for the registers (0340), or a System Admin. No new
--      permission and no widening. Reject and merge-as-duplicate of 0340 do not apply to a plan day (nothing to void or merge): not offered.
--      Existing plan days stay untriaged (NULL). The columns sit on daily_plans, which data reset already classifies (delete with the daily_plan part).

CREATE OR REPLACE FUNCTION hist_changes(p_before jsonb, p_after jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('field', k, 'from', p_before -> k, 'to', p_after -> k) ORDER BY k), '[]'::jsonb)
  FROM (SELECT DISTINCT key AS k FROM (SELECT jsonb_object_keys(coalesce(CASE WHEN jsonb_typeof(p_before) = 'object' THEN p_before END, '{}'::jsonb)) AS key
                                       UNION ALL SELECT jsonb_object_keys(coalesce(CASE WHEN jsonb_typeof(p_after) = 'object' THEN p_after END, '{}'::jsonb))) u) ks
  WHERE k <> 'version' AND (coalesce(p_before, '{}'::jsonb) -> k) IS DISTINCT FROM (coalesce(p_after, '{}'::jsonb) -> k)
$$;

CREATE OR REPLACE FUNCTION wh_item_history(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', false);
  IF NOT EXISTS (SELECT 1 FROM public.warehouse_items i WHERE i.id = p_id) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.'));
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id::text, 'at', a.at, 'action', a.action, 'actor', public.wfe_user_ref(a.actor_id),
                      'reason', a.reason, 'before', a.before, 'after', a.after, 'changes', public.hist_changes(a.before, a.after)) ORDER BY a.at DESC, a.id DESC)
                   FROM public.audit_log a WHERE a.entity_type = 'warehouse_item' AND a.entity_id = p_id::text), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION dp_plan_history(p_region integer, p_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_region_check(p_region) OR NOT public.dp_right(public.app_actor(), p_region, 'view') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You may not open the Daily Plan of this region.'));
  END IF;
  SELECT * INTO p FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date;
  IF p.id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id::text, 'at', a.at, 'action', a.action, 'actor', public.wfe_user_ref(a.actor_id),
                      'reason', a.reason, 'site_id', a.site_id, 'before', a.before, 'after', a.after,
                      'changes', public.hist_changes(a.before, a.after)) ORDER BY a.at DESC, a.id DESC)
                   FROM public.audit_log a WHERE a.entity_type = 'daily_plan' AND a.entity_id = p.id::text), '[]'::jsonb);
END $$;

ALTER TABLE daily_plans
  ADD COLUMN triage_state text,
  ADD COLUMN triage_note  text,
  ADD COLUMN triage_by    uuid REFERENCES users (id),
  ADD COLUMN triage_at    timestamptz(6),
  ADD COLUMN claimed_by   uuid REFERENCES users (id),
  ADD COLUMN claimed_at   timestamptz(6);
ALTER TABLE daily_plans ADD CONSTRAINT daily_plans_triage_state_check CHECK (triage_state IS NULL OR triage_state IN ('pending', 'accepted', 'deferred'));
CREATE INDEX daily_plans_triage_idx ON daily_plans (region_id, triage_state) WHERE triage_state IN ('pending', 'deferred');

-- a new plan day enters the queue
CREATE OR REPLACE FUNCTION dp_triage_default() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.triage_state IS NULL THEN NEW.triage_state := 'pending'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER daily_plans_triage_default BEFORE INSERT ON daily_plans FOR EACH ROW EXECUTE FUNCTION dp_triage_default();

CREATE OR REPLACE FUNCTION dp_plan_triage_json(p public.daily_plans) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('region_id', p.region_id, 'plan_date', p.plan_date, 'triage_state', p.triage_state, 'triage_note', p.triage_note,
    'triage_by', CASE WHEN p.triage_by IS NULL THEN NULL ELSE public.wfe_user_ref(p.triage_by) END, 'triage_at', p.triage_at,
    'claimed_by', CASE WHEN p.claimed_by IS NULL THEN NULL ELSE public.wfe_user_ref(p.claimed_by) END, 'claimed_at', p.claimed_at,
    'can_triage', public.app_user_is_system_admin(public.app_actor()) OR public.dp_holds(public.app_actor(), p.region_id, 'approve'))
$$;

CREATE OR REPLACE FUNCTION dp_plan_triage_get(p_region integer, p_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_region_check(p_region) OR NOT public.dp_right(public.app_actor(), p_region, 'view') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You may not open the Daily Plan of this region.'));
  END IF;
  SELECT * INTO p FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date;
  IF p.id IS NULL THEN
    RETURN jsonb_build_object('region_id', p_region, 'plan_date', p_date, 'triage_state', NULL, 'triage_note', NULL, 'triage_by', NULL, 'triage_at', NULL,
      'claimed_by', NULL, 'claimed_at', NULL, 'can_triage', false);
  END IF;
  RETURN public.dp_plan_triage_json(p);
END $$;

-- Take or give back the review of a plan day. The L2 holder of the region or a System Admin; a day claimed by someone else is taken over only by a System Admin.
CREATE OR REPLACE FUNCTION dp_plan_claim(p_region integer, p_date date, p_claim boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; a uuid := public.app_actor(); adm boolean := public.app_user_is_system_admin(public.app_actor());
BEGIN
  p := public.dp_for_change(p_region, p_date, NULL, true);
  IF NOT (adm OR public.dp_holds(a, p_region, 'approve')) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the L2 holders of the Daily Plan of this region claim a day.'));
  END IF;
  IF p_claim THEN
    IF p.claimed_by IS NOT NULL AND p.claimed_by <> a AND NOT adm THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This plan day is claimed by someone else.'));
    END IF;
    UPDATE public.daily_plans SET claimed_by = a, claimed_at = clock_timestamp() WHERE id = p.id RETURNING * INTO p;
  ELSE
    IF p.claimed_by IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This plan day is not claimed.')); END IF;
    IF p.claimed_by <> a AND NOT adm THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the person who claimed the day or a System Admin releases it.')); END IF;
    UPDATE public.daily_plans SET claimed_by = NULL, claimed_at = NULL WHERE id = p.id RETURNING * INTO p;
  END IF;
  PERFORM public.log_audit_write(CASE WHEN p_claim THEN 'daily_plan.claimed' ELSE 'daily_plan.released' END, 'daily_plan', p.id::text,
    NULL, jsonb_build_object('claimed', p_claim, 'plan_date', p_date), NULL, NULL, p_region);
  RETURN public.dp_plan_triage_json(p);
END $$;

-- Accept or defer a plan day, with a note. The L2 holder of the region or a System Admin. It never blocks editing or the lock of the day.
CREATE OR REPLACE FUNCTION dp_plan_triage(p_region integer, p_date date, p_state text, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; a uuid := public.app_actor(); before jsonb;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('accepted', 'deferred') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/state', 'not_in_list', 'accepted or deferred.')));
  END IF;
  IF coalesce(char_length(btrim(p_note)), 0) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/note', 'required', 'A note is required.')));
  END IF;
  p := public.dp_for_change(p_region, p_date, NULL, true);
  IF NOT (public.app_user_is_system_admin(a) OR public.dp_holds(a, p_region, 'approve')) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the L2 holders of the Daily Plan of this region triage a day.'));
  END IF;
  before := jsonb_build_object('triage_state', p.triage_state);
  UPDATE public.daily_plans SET triage_state = p_state, triage_note = btrim(p_note), triage_by = a, triage_at = clock_timestamp(), claimed_by = NULL, claimed_at = NULL
  WHERE id = p.id RETURNING * INTO p;
  PERFORM public.log_audit_write('daily_plan.triage_' || p_state, 'daily_plan', p.id::text, before,
    jsonb_build_object('triage_state', p_state, 'plan_date', p_date), btrim(p_note), NULL, p_region);
  RETURN public.dp_plan_triage_json(p);
END $$;

DO $$
BEGIN
  ALTER FUNCTION hist_changes(jsonb, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION wh_item_history(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION dp_plan_history(integer, date) OWNER TO pmis_definer;
  ALTER FUNCTION dp_triage_default() OWNER TO pmis_definer;
  ALTER FUNCTION dp_plan_triage_json(public.daily_plans) OWNER TO pmis_definer;
  ALTER FUNCTION dp_plan_triage_get(integer, date) OWNER TO pmis_definer;
  ALTER FUNCTION dp_plan_claim(integer, date, boolean) OWNER TO pmis_definer;
  ALTER FUNCTION dp_plan_triage(integer, date, text, text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION hist_changes(jsonb, jsonb), wh_item_history(uuid), dp_plan_history(integer, date), dp_triage_default(), dp_plan_triage_json(public.daily_plans),
    dp_plan_triage_get(integer, date), dp_plan_claim(integer, date, boolean), dp_plan_triage(integer, date, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION hist_changes(jsonb, jsonb), wh_item_history(uuid), dp_plan_history(integer, date), dp_triage_default(), dp_plan_triage_json(public.daily_plans),
    dp_plan_triage_get(integer, date), dp_plan_claim(integer, date, boolean), dp_plan_triage(integer, date, text, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION hist_changes(jsonb, jsonb), wh_item_history(uuid), dp_plan_history(integer, date), dp_plan_triage_json(public.daily_plans),
      dp_plan_triage_get(integer, date), dp_plan_claim(integer, date, boolean), dp_plan_triage(integer, date, text, text) TO pmis_app;
  END IF;
END $$;
