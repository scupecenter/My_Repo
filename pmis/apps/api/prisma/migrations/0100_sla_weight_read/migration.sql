-- 0100: read of the SLA rule and the weight of every task of one workflow version (F14, owner request 2026-11-15; contract 0.15.20; CHANGELOG 145).
--
-- WHY. The editor's detail panel must show the SLA and the weight of a draft task. The version read (0090) does not carry them, and the SLA list (0005/0017) reads
-- only the published workflow. This function answers per task: the weight columns and the base SLA rule in force today in that version.
-- Read only; it writes nothing. The rule shape is the one wf_sla_rule_json (0099) returns.

CREATE OR REPLACE FUNCTION wf_sla_weight_items(p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(s.x ORDER BY s.x ->> 'task_code'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object('task_code', td.code, 'counts_in_weight', td.counts_in_weight, 'weight_value', td.weight_value, 'weight_group', td.weight_group,
      'sla', (SELECT public.wf_sla_rule_json(r, td.code) FROM public.sla_rules r
              WHERE r.task_def_id = td.id AND r.scenario IS NULL AND r.region_id IS NULL AND r.effective_to IS NULL AND r.is_active
              ORDER BY r.effective_from DESC LIMIT 1)) AS x
    FROM public.task_definitions td JOIN public.workflow_definitions w ON w.id = td.workflow_id
    WHERE w.version = p_version AND td.is_active
  ) s
$$;

ALTER FUNCTION wf_sla_weight_items(integer) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION wf_sla_weight_items(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wf_sla_weight_items(integer) TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION wf_sla_weight_items(integer) TO pmis_app; END IF;
END $$;

-- 2. Database guard on publishing (F14, owner request 2026-11-15): a draft cannot become published while a weight group does not total 100.
-- The API answers 409 first; this trigger holds the same rule for every path that publishes (admin_wf_publish included).
CREATE OR REPLACE FUNCTION wf_weight_publish_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bad text;
BEGIN
  IF NEW.status = 'published' AND OLD.status = 'draft' THEN
    SELECT string_agg(x ->> 'group' || ' totals ' || (x ->> 'total'), ', ' ORDER BY x ->> 'group') INTO bad
      FROM jsonb_array_elements(public.wf_weight_totals(NEW.id)) AS x WHERE NOT (x ->> 'ok')::boolean;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'weight groups must total 100 before publishing: %', bad USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workflow_weight_publish_guard ON workflow_definitions;
CREATE TRIGGER workflow_weight_publish_guard BEFORE UPDATE OF status ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION wf_weight_publish_guard();

ALTER FUNCTION wf_weight_publish_guard() OWNER TO pmis_definer;
