-- 0490_milestone_weight: the weight of a milestone, stored in the workflow version and edited in the draft (D53b, owner approval relayed 2026-11-27). Additive.
-- Mirror: db/sql/489_milestone_weight.sql (kept identical to prisma/migrations/0490_milestone_weight/migration.sql).
--
-- WHY. A task already has counts_in_weight, weight_value and weight_group (0109). A milestone had none, so the editor could not say how much a milestone
-- weighs in the project. This migration only STORES and SHOWS the weight. It is not read by any progress calculation: that use is a separate decision.
--
--   1. stage_definitions gets counts_in_weight (default false), weight_value (0..100, default 0) and weight_group (same shape as the task group).
--      Every existing row keeps the defaults: nothing changes for any site, report or dashboard.
--   2. admin_wf_milestone_weight(version, etag, milestone, counts, weight, group, reason): a draft only, same right as the task weight (`weights` edit),
--      reason, ETag, audit row with before and after. A published version is refused (409 invalid_transition).
--   3. wfe_version_json lists the three fields on each milestone; admin_wf_create_draft copies them to a new draft. Both are patched in place by their stored
--      text (idempotent, anchored, they raise when the anchor is missing).
-- No permission, role, grant or default-value change. No new table (so no data_reset_plan row).

ALTER TABLE stage_definitions
  ADD COLUMN IF NOT EXISTS counts_in_weight boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weight_value numeric(7, 3) NOT NULL DEFAULT 0 CHECK (weight_value >= 0 AND weight_value <= 100),
  ADD COLUMN IF NOT EXISTS weight_group text CHECK (weight_group IS NULL OR weight_group ~ '^[A-Z0-9_-]{1,20}$');

CREATE OR REPLACE FUNCTION admin_wf_milestone_weight(p_version integer, p_etag integer, p_milestone text, p_counts boolean, p_weight numeric, p_group text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE; s public.stage_definitions%ROWTYPE; before_ jsonb; grp text := nullif(btrim(coalesce(p_group, '')), '');
BEGIN
  PERFORM public.wfe_require('weights', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_counts IS NULL THEN PERFORM public.wfe_err1('/counts_in_weight', 'required', 'counts_in_weight is true or false.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The weight is changed in a draft version: copy the published version to a draft first.')); END IF;
  SELECT * INTO s FROM public.stage_definitions WHERE workflow_id = w.id AND code = p_milestone;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The milestone does not exist in this version.')); END IF;
  IF p_counts AND (p_weight IS NULL OR p_weight < 0 OR p_weight > 100) THEN PERFORM public.wfe_err1('/weight_value', 'invalid', 'The weight is 0 to 100 percent.'); END IF;
  IF p_counts AND grp IS NULL THEN PERFORM public.wfe_err1('/weight_group', 'required', 'A milestone that counts needs a weight group.'); END IF;
  IF grp IS NOT NULL AND grp !~ '^[A-Z0-9_-]{1,20}$' THEN PERFORM public.wfe_err1('/weight_group', 'invalid', 'The group is up to 20 capitals, digits, _ or -.'); END IF;
  IF NOT p_counts THEN p_weight := 0; END IF;
  before_ := jsonb_build_object('counts_in_weight', s.counts_in_weight, 'weight_value', s.weight_value, 'weight_group', s.weight_group);
  IF (p_counts, p_weight, grp) IS NOT DISTINCT FROM (s.counts_in_weight, s.weight_value, s.weight_group) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  UPDATE public.stage_definitions SET counts_in_weight = p_counts, weight_value = p_weight, weight_group = grp WHERE id = s.id;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_milestone_weight', 'stage_definition', p_milestone, before_,
    jsonb_build_object('counts_in_weight', p_counts, 'weight_value', p_weight, 'weight_group', grp), p_reason);
  RETURN jsonb_build_object('version', public.wfe_version_json(w.id));
END $$;

DO $$
DECLARE def text; anchor text; fixed text;
BEGIN
  -- the version JSON lists the weight of each milestone
  def := pg_get_functiondef('public.wfe_version_json(uuid)'::regprocedure);
  IF position('''counts_in_weight'', s.counts_in_weight' IN def) = 0 THEN
    anchor := '''counts_in_project_status'', s.counts_in_project_status,';
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'wfe_version_json: the milestone anchor was not found'; END IF;
    fixed := replace(def, anchor, anchor || ' ''counts_in_weight'', s.counts_in_weight, ''weight_value'', s.weight_value, ''weight_group'', s.weight_group,');
    EXECUTE fixed;
  END IF;
  -- a new draft copies the milestone weights of its parent
  def := pg_get_functiondef('public.admin_wf_create_draft(integer,text)'::regprocedure);
  IF position('UPDATE public.stage_definitions n SET counts_in_weight' IN def) = 0 THEN
    anchor := 'UPDATE public.sla_rules r SET unit = o.unit';
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'admin_wf_create_draft: the anchor was not found'; END IF;
    fixed := replace(def, anchor, 'UPDATE public.stage_definitions n SET counts_in_weight = o.counts_in_weight, weight_value = o.weight_value, weight_group = o.weight_group
    FROM public.stage_definitions o WHERE o.workflow_id = w.id AND n.workflow_id = nid AND o.code = n.code;
  ' || anchor);
    EXECUTE fixed;
  END IF;
END $$;

DO $$
BEGIN
  ALTER FUNCTION admin_wf_milestone_weight(integer,integer,text,boolean,numeric,text,text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION admin_wf_milestone_weight(integer,integer,text,boolean,numeric,text,text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION admin_wf_milestone_weight(integer,integer,text,boolean,numeric,text,text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_wf_milestone_weight(integer,integer,text,boolean,numeric,text,text) TO pmis_app;
  END IF;
END $$;
