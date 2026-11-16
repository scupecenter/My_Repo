-- 0111 (F15, 2026-11-15): two more calc columns, translated from the formulas of the Master workbook (GSDN_Site_Master.xlsx, sheet Master),
-- read with openpyxl. The view (0107 body) gains two register-owned branches; each carries its register key, so the rows endpoint shows
-- it only to a user who may view that register (B3).
--   AL CW Access Date (ord 38): MINIFS of Valid From over the approved "Access - CW" permits of the site; blank when there is none.
--     Source: permit_records (register permits_hse, approved values only).
--   BX HLC Fiber Status (ord 76), from the HLC sheet's tblFiber Status and Master AD (HLC Fiber scope): "N/A" when the scope is N/A;
--     with an HLC record of the site: "Done" when the scope is Yes, the record is the single one and its Installation Date is inside the
--     valid window, else "Pending"; without a record: "Pending" when the scope is Yes, else blank. Source: hlc_records (register hlc).
-- The valid window is Setting!B6 and B7 of the workbook (Earliest valid date 2020-01-01, Latest valid date 2035-12-31); it is written
-- here as constants until the calc settings carry it (open).
-- Not translated yet: PR Status (AH) and PO / WO Status (AI). Their Master formulas count procurement orders of the scopes "Tower
-- Erection" and "Site Adaption", while procurement_records holds CW and TE only (open); and the gate readiness columns (AX, BQ, CA, ...),
-- which read the Site Calc sheet.

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
JOIN sites s ON s.id = g.site_id AND s.is_active

UNION ALL
-- AL CW Access Date: the earliest approved "Access - CW" permit of the site
SELECT p.site_id, 38, min(p.valid_from)::text, 'register'::text, 'permits_hse'::text
FROM permit_records p
JOIN sites s ON s.id = p.site_id AND s.is_active
WHERE p.permit_type = 'Access - CW' AND p.status = 'Approved' AND p.valid_from IS NOT NULL
GROUP BY p.site_id
UNION ALL
-- BX HLC Fiber Status (the workbook's tblFiber Status, from the HLC scope AD)
SELECT s.id, 76,
  CASE
    WHEN s.scope_hlc_fiber::text = 'na' THEN 'N/A'
    WHEN h.site_id IS NOT NULL THEN
      CASE WHEN s.scope_hlc_fiber::text = 'yes' AND h.installation_date BETWEEN DATE '2020-01-01' AND DATE '2035-12-31' THEN 'Done' ELSE 'Pending' END
    WHEN s.scope_hlc_fiber::text = 'yes' THEN 'Pending'
  END,
  'register'::text, 'hlc'::text
FROM sites s
LEFT JOIN hlc_records h ON h.site_id = s.id
WHERE s.is_active
  AND (s.scope_hlc_fiber::text IN ('na', 'yes') OR h.site_id IS NOT NULL);


COMMENT ON VIEW site360_master_values IS 'The Master values of each site and column (0104, F15, extended 0106): the set-based read model of the SITE 360 grid rows.';
