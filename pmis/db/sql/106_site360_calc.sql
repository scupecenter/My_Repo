-- 0107 (F15, 2026-11-15): the calc columns of the Master that the procurement and GECOL registers already hold. The view gains
-- register-owned branches, each read from the tables the registers use (no formula is copied):
--   AJ Contractor Name (ord 36) and AK Contractor Team (ord 37): the party and team of the first active CW procurement order
--   (the earliest by PO/WO or PR date; an order whose status starts with "cancel" is not active, proc_order_cancelled as in 0063);
--   BW GECOL Status (ord 75): the status of the GECOL record (the GECOL register, C2).
-- Each branch carries its register_key, so the rows endpoint shows it only to a user who may view that register (B3).
-- Still open (owner answer needed): PR Status (AH), PO / WO Status (AI), CW Access Date (AL), HLC Fiber Status (BX) and the gate
-- readiness columns (AX, BQ, CA and the others): their Master formula is not written in the spec yet.

-- 0106 (F15, 2026-11-15): the SITE 360 read model covers the register-owned Master columns (task_field_sources: the current record of
-- the site, its external party or field) and the issue columns (GA:GE, the open issue of the site first). The view gains register_key
-- (the register the value comes from, NULL for the site and task values): the rows endpoint shows a register value only to a user who may
-- view that register (module grant, B3), as the Master export does. Calc columns owned by the Project Status formulas stay open.

-- The party and team names come from two readers owned by pmis_definer (SECURITY DEFINER, closed to PUBLIC), as the other readers of the
-- registers do: pmis_app holds no SELECT on external_parties and external_teams. pmis_app executes them only.
CREATE OR REPLACE FUNCTION site360_party_name(p_party uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT ep.name FROM public.external_parties ep WHERE ep.id = p_party
$$;
CREATE OR REPLACE FUNCTION site360_team_name(p_team uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT et.name FROM public.external_teams et WHERE et.id = p_team
$$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_definer') THEN
    ALTER FUNCTION site360_party_name(uuid) OWNER TO pmis_definer;
    ALTER FUNCTION site360_team_name(uuid) OWNER TO pmis_definer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON FUNCTION site360_party_name(uuid), site360_team_name(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION site360_party_name(uuid), site360_team_name(uuid) TO pmis_app;
    -- the cancelled-order test of 0063 is closed to PUBLIC (owner pmis_definer); the view calls it as the caller, so the app role needs EXECUTE
    GRANT EXECUTE ON FUNCTION proc_order_cancelled(text) TO pmis_app;
  END IF;
END $$;

CREATE OR REPLACE VIEW site360_master_values WITH (security_invoker = true) AS
SELECT x.site_id, x.ord, x.value, 'site'::text AS kind, NULL::text AS register_key
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
  'task'::text AS kind,
  NULL::text AS register_key
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
GROUP BY t.site_id, t.ord
UNION ALL
-- register-owned columns: the current record of the site in the source register (its external party, or a field of its data)
SELECT s.id AS site_id, mc.ord, rv.value, 'register'::text AS kind, x.register_key
FROM sites s
JOIN task_definitions td ON td.workflow_id = s.workflow_version_id
JOIN task_field_sources x ON x.task_code = td.code AND x.is_active AND x.master_col IS NOT NULL
JOIN master_columns mc ON mc.letter = x.master_col
LEFT JOIN LATERAL (
  SELECT CASE WHEN x.field_code = 'external_party_id' THEN ep.name ELSE rr.data ->> x.field_code END AS value
  FROM register_records rr
  LEFT JOIN external_parties ep ON ep.id = rr.external_party_id
  WHERE rr.register_key = x.register_key AND rr.site_id = s.id AND rr.is_current AND rr.voided_at IS NULL
    AND (x.record_type IS NULL OR rr.record_type = x.record_type)
  ORDER BY rr.version_no DESC
  LIMIT 1
) rv ON true
WHERE s.is_active
UNION ALL
-- issue columns (GA:GE): the open issue of the site first, else the latest one
SELECT i.site_id, v.ord, v.value, 'issue'::text AS kind, 'issues'::text AS register_key
FROM (
  SELECT DISTINCT ON (iss.site_id) iss.site_id, iss.title, iss.detail, iss.owner_text, iss.owner_id, iss.raised_date, iss.status
  FROM issues iss
  ORDER BY iss.site_id, (iss.status = 'closed'), iss.raised_date DESC, iss.id
) i
LEFT JOIN users u ON u.id = i.owner_id
CROSS JOIN LATERAL (VALUES
  (183, i.title), (184, coalesce(i.owner_text, u.display_name)), (185, i.raised_date::text), (186, i.status::text), (187, i.detail)
) AS v(ord, value)
UNION ALL
-- calc columns held by the procurement register: the first active CW order of the site (AJ, AK)
SELECT f.site_id, v.ord, v.value, 'register'::text AS kind, 'procurement'::text AS register_key
FROM (
  SELECT DISTINCT ON (pr.site_id) pr.site_id, pr.party_id, pr.team_id
  FROM procurement_records pr
  WHERE pr.scope = 'CW' AND NOT proc_order_cancelled(pr.order_status)
  ORDER BY pr.site_id, coalesce(pr.po_wo_date, pr.pr_date) NULLS LAST, pr.id
) f
JOIN sites s ON s.id = f.site_id AND s.is_active
CROSS JOIN LATERAL (VALUES (36, site360_party_name(f.party_id)), (37, site360_team_name(f.team_id))) AS v(ord, value)
UNION ALL
-- calc column held by the GECOL register: the GECOL status of the site (BW)
SELECT g.site_id, 75, g.status, 'register'::text, 'gecol'::text
FROM gecol_records g
JOIN sites s ON s.id = g.site_id AND s.is_active;

COMMENT ON VIEW site360_master_values IS 'The Master values of each site and column (0104, F15, extended 0106): the set-based read model of the SITE 360 grid rows.';
