-- 0542: estimated man-days (and an optional planned duration) on task definitions, and a
-- suggested item weight derived from them (WBS effort-based weighting, PMI practice).
--
-- est_man_days / planned_duration_days live on the versioned task_definitions row, so they
-- are edited in a draft version and freeze at publish like every other task attribute.
-- The weight editor (wf_sla_weight_items) reports, per task that counts in weight and has a
-- group, suggested_weight = 100 * est_man_days / sum(est_man_days of the group's counting
-- tasks). It is a suggestion only: the 100-percent group guard (wf_weight_publish_guard /
-- wf_weight_totals) stays the sole hard rule and nothing auto-applies the suggestion.
ALTER TABLE task_definitions
  ADD COLUMN IF NOT EXISTS est_man_days numeric(8,1),
  ADD COLUMN IF NOT EXISTS planned_duration_days integer;
ALTER TABLE task_definitions
  DROP CONSTRAINT IF EXISTS task_definitions_est_man_days_ck,
  ADD CONSTRAINT task_definitions_est_man_days_ck CHECK (est_man_days IS NULL OR est_man_days >= 0),
  DROP CONSTRAINT IF EXISTS task_definitions_planned_duration_days_ck,
  ADD CONSTRAINT task_definitions_planned_duration_days_ck CHECK (planned_duration_days IS NULL OR planned_duration_days > 0);

-- wf_sla_weight_items: add the estimates and the group-share suggestion.
DO $$
DECLARE def text; marker text := E'\'weight_group\', td.weight_group,';
BEGIN
  def := pg_get_functiondef('public.wf_sla_weight_items(integer)'::regprocedure);
  IF position('suggested_weight' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'wf_sla_weight_items() has no weight_group anchor to patch'; END IF;
    EXECUTE replace(def, marker,
      E'\'weight_group\', td.weight_group, \'est_man_days\', td.est_man_days, \'planned_duration_days\', td.planned_duration_days,\n'
      || E'      \'suggested_weight\', CASE WHEN td.counts_in_weight AND td.weight_group IS NOT NULL AND td.est_man_days IS NOT NULL AND td.est_man_days > 0\n'
      || E'        AND sum(td.est_man_days) OVER (PARTITION BY td.workflow_id, td.weight_group) > 0\n'
      || E'        THEN round(100 * td.est_man_days / sum(td.est_man_days) OVER (PARTITION BY td.workflow_id, td.weight_group), 1) END,');
  END IF;
END $$;

-- Draft-only writer for the two estimate fields, same shape as admin_wf_task_weight (0109).
CREATE OR REPLACE FUNCTION admin_wf_task_estimate(p_version integer, p_etag integer, p_task text, p_est_man_days numeric, p_planned_duration_days integer, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $$
DECLARE w public.workflow_definitions%ROWTYPE; t public.task_definitions%ROWTYPE; before_ jsonb;
BEGIN
  PERFORM public.wfe_require('weights', 'edit');
  PERFORM public.calc_require_reason(p_reason);
  IF p_est_man_days IS NOT NULL AND p_est_man_days < 0 THEN PERFORM public.wfe_err1('/est_man_days', 'invalid', 'The estimated man-days are zero or more.'); END IF;
  IF p_planned_duration_days IS NOT NULL AND p_planned_duration_days <= 0 THEN PERFORM public.wfe_err1('/planned_duration_days', 'invalid', 'The planned duration is at least one day.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The estimate is changed in a draft version: copy the published version to a draft first.')); END IF;
  SELECT * INTO t FROM public.task_definitions WHERE workflow_id = w.id AND code = p_task;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist in this version.')); END IF;
  before_ := jsonb_build_object('est_man_days', t.est_man_days, 'planned_duration_days', t.planned_duration_days);
  IF (p_est_man_days, p_planned_duration_days) IS NOT DISTINCT FROM (t.est_man_days, t.planned_duration_days) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.'));
  END IF;
  UPDATE public.task_definitions SET est_man_days = p_est_man_days, planned_duration_days = p_planned_duration_days, reason = btrim(p_reason), changed_by = public.app_actor()
    WHERE id = t.id;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_task_estimate', 'task_definition', p_task, before_,
    jsonb_build_object('est_man_days', p_est_man_days, 'planned_duration_days', p_planned_duration_days), p_reason);
  RETURN jsonb_build_object('version', public.wfe_version_json(w.id), 'items', public.wf_sla_weight_items(p_version));
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', 'admin_wf_task_estimate(integer,integer,text,numeric,integer,text)');
  GRANT EXECUTE ON FUNCTION admin_wf_task_estimate(integer,integer,text,numeric,integer,text) TO pmis_app;
END $$;
