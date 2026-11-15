-- Mirror of apps/api/prisma/migrations/0104_site360_rows/migration.sql (0104 -> 103).
-- 0104 (F15, 2026-11-15): SITE 360 grid rows. A set-based read model of the Master values of each site, so the grid page is one query
-- (no per-site N+1 path). A plain view, not materialised: it is always current and stays the one source of truth (the values are the
-- site, task and workflow rows; the grid writes through the same paths). security_invoker keeps the RLS of sites and task_instances.
-- Covered: the identity and scope columns of the site (Master B:H, J:T, X:AG), the progress columns (FX:FZ) and the task fields of the
-- workflow (planned / actual / submitted / approved dates, the external party, v:<key> values), with the projection (earliest or latest)
-- and the delivery scenario of each task field. Not covered yet (NULL in the view, reported as open): calc columns owned by a register
-- or by the Project Status formulas, the r:<register>.<field> fields, the issue columns (GA:GE), the cluster optimisation.

CREATE OR REPLACE VIEW site360_master_values WITH (security_invoker = true) AS
SELECT x.site_id, x.ord, x.value, 'site'::text AS kind
FROM (
  SELECT s.id AS site_id, v.ord, v.value
  FROM sites s
  JOIN regions r ON r.id = s.region_id
  LEFT JOIN clusters c ON c.id = s.cluster_id
  CROSS JOIN LATERAL (VALUES
    (2, s.site_code::text), (3, s.owner_site_id), (4, s.name), (5, r.name_en), (6, s.sub_region), (7, c.cluster_code),
    (8, s.latitude::text), (9, s.longitude::text), (10, s.site_type), (11, s.site_scenario), (12, s.uplink_site), (13, s.tower_owner),
    (14, s.existing_or_new), (15, s.rt_or_gf), (16, s.tower_type), (17, s.tower_height_m::text), (18, s.config_summary),
    (19, s.rf_survey_date::text), (20, s.acquisition_date::text), (24, s.project_phase), (25, s.delivery_batch),
    (26, s.delivery_scenario::text), (27, s.scope_tower_erection::text), (28, s.scope_site_adaption::text), (29, s.scope_gecol_power::text),
    (30, s.scope_hlc_fiber::text), (31, s.scope_te_full::text), (32, s.scope_te_ip_router_only::text), (33, s.cw_delivery_model),
    (180, s.current_milestone), (181, s.next_milestone), (182, s.overall_status::text)
  ) AS v(ord, value)
  WHERE s.is_active
) x
UNION ALL
SELECT t.site_id, t.ord,
  CASE WHEN bool_or(t.projection = 'latest') THEN max(t.value) ELSE min(t.value) END AS value,
  'task'::text AS kind
FROM (
  SELECT s.id AS site_id, mc.ord, tf.projection,
    CASE tf.field_key
      WHEN 'planned_date' THEN ti.planned_date::text
      WHEN 'planned_start' THEN ti.planned_start::text
      WHEN 'actual_start' THEN ti.actual_start::text
      WHEN 'actual_date' THEN ti.actual_date::text
      WHEN 'submitted_date' THEN ti.submitted_date::text
      WHEN 'approved_date' THEN ti.approved_date::text
      WHEN 'external_party' THEN ep.name
      ELSE CASE WHEN tf.field_key LIKE 'v:%' THEN ti."values" ->> substr(tf.field_key, 3) END
    END AS value
  FROM sites s
  JOIN task_definitions td ON td.workflow_id = s.workflow_version_id
  JOIN template_task_fields tf ON tf.task_code = td.code AND tf.is_active AND tf.master_col IS NOT NULL
    AND tf.field_key NOT LIKE 'r:%'
    AND (tf.scenarios IS NULL OR s.delivery_scenario::text = ANY (tf.scenarios))
  JOIN master_columns mc ON mc.letter = tf.master_col
  JOIN task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id
  LEFT JOIN external_parties ep ON ep.id = ti.external_party_id
  WHERE s.is_active
) t
GROUP BY t.site_id, t.ord;

COMMENT ON VIEW site360_master_values IS 'The Master values of each site and column (0104, F15): the set-based read model of the SITE 360 grid rows. Plain view, always current.';

-- The grid is read by the application role. Views are not covered by the table grants of app_grants.sql, so the view is granted here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON site360_master_values TO pmis_app;
  END IF;
END
$$;

