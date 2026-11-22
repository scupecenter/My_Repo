-- 0132_site360_column_admin: Workflow Studio S2, the API to manage the Site Master columns (owner request 2026-11-22; plan docs/plans/2026-11-22-workflow-studio.md;
-- CHANGELOG 175; contract 0.15.43). Mirror: db/sql/131_site360_column_admin.sql (kept byte-identical).
--
-- WHAT THIS ADDS.
--   1. master_columns learns what an added column needs:
--        display_order         the place on the grid and in the menus, separate from ord (a new column can sit after any column); unique, deferred so a
--                              shift of the following columns is one statement. The Master order ord and the letter stay what the Master-format export uses.
--        name_ar               the Arabic name (the English name is `name`; `header` is "group / name").
--        value_type            text, number, date, list or yes_no; list_catalogue names the dropdown list of a `list` column. A column filled by a task input
--                              reads the input's own type and list (template_task_fields), so the two never differ; the columns here serve the other sources.
--        source_field_id       the site custom field (field_definitions, entity site) that fills an added column.
--        source_input_created  the column created its task input (deleted with the column when the column is deleted).
--        is_added              true for a column an admin added (ord 188 and up, letters GF, GG, ...); the 187 original columns are false.
--        is_protected + protected_reason   a column the system depends on: only a rename and its menus can change (seeded below from the owner and the kind of
--                              source of each original column).
--        version               the ETag of the column (If-Match).
--      owner gains the value `added` (an added column filled by a site field; a task-input column has the owner `task`).
--   2. site360_master_values (latest 0121, redefined in full; the only change is marked 0132): a site custom field named by master_columns.source_field_id
--      fills the added column. A task input column needs no change: the existing task branch reads template_task_fields.master_col, which the creation sets.
--   3. The doors (SECURITY DEFINER, owner pmis_definer; System Admin or a delegate of `fields` edit for ALL regions; a reason; the ETag; audited with before and after):
--        site360_columns_list / site360_column_get          the screen
--        site360_column_type_preview                         the values that would not convert to another type or list
--        site360_column_create / site360_column_update      add after any column, rename, retype, change list, band, group, place
--        site360_column_set_active                           deactivate and reactivate
--        site360_column_delete                               hard delete of an added column that never held a value
--      and the replacement of site360_set_sections (0101), which now bumps the version too and accepts any column order.
--
-- RULES. An original column keeps its letter, order, band, group and place. A protected column allows a rename and its menus only. A type or list change never
-- rewrites a stored value; the values that would not fit are counted by the preview. A task-input column's type follows the input (template_task_fields), a date key
-- of a task stays a date. Every write takes an advisory lock, so two admins cannot allocate the same order. The Master-format export already lists every active
-- master_columns row in ord order, so an added column follows the 187 under its letter.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE master_columns
  ADD COLUMN IF NOT EXISTS display_order integer,
  ADD COLUMN IF NOT EXISTS name_ar text,
  ADD COLUMN IF NOT EXISTS value_type text,
  ADD COLUMN IF NOT EXISTS list_catalogue text REFERENCES list_catalogues (code) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_field_id uuid REFERENCES field_definitions (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_input_created boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_added boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_protected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS protected_reason text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

UPDATE master_columns SET display_order = ord WHERE display_order IS NULL;
ALTER TABLE master_columns ALTER COLUMN display_order SET NOT NULL;

ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_display_order_key;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_display_order_key UNIQUE (display_order) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_owner_check;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_owner_check
  CHECK (owner IN ('row', 'key', 'identity', 'baseline', 'scope', 'calc', 'task', 'dismantle', 'issues', 'added'));
ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_value_type_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_value_type_chk
  CHECK (value_type IS NULL OR value_type IN ('text', 'number', 'date', 'list', 'yes_no'));
ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_list_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_list_chk CHECK (list_catalogue IS NULL OR value_type = 'list');
ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_added_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_added_chk CHECK (is_added = (ord > 187));
ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_protected_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_protected_chk CHECK (NOT is_protected OR protected_reason IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS master_columns_source_field_idx ON master_columns (source_field_id) WHERE source_field_id IS NOT NULL;

COMMENT ON COLUMN master_columns.display_order IS '0132: the place on the grid and in the menus (unique, deferred). ord and letter stay the Master order of the export; an added column takes the next free ord after the 187.';
COMMENT ON COLUMN master_columns.name_ar IS '0132: the Arabic name of the column.';
COMMENT ON COLUMN master_columns.value_type IS '0132: text, number, date, list or yes_no. A column filled by a task input reads the input (template_task_fields.field_type) instead.';
COMMENT ON COLUMN master_columns.list_catalogue IS '0132: the dropdown list of a list column (list_catalogues.code).';
COMMENT ON COLUMN master_columns.source_field_id IS '0132: the site custom field (field_definitions) that fills an added column.';
COMMENT ON COLUMN master_columns.source_input_created IS '0132: the column created its task input row (template_task_fields); deleting the column deletes the input.';
COMMENT ON COLUMN master_columns.is_added IS '0132: an admin added the column (ord 188 and up); the 187 original columns keep their letters and orders.';
COMMENT ON COLUMN master_columns.is_protected IS '0132: the system depends on the column; only a rename and its menus can change.';
COMMENT ON COLUMN master_columns.version IS '0132: the ETag of the column (If-Match); every write bumps it.';

-- The protected originals: the row number and Site ID, the identity and scope columns, baselines, calculated columns, milestone and gate dates, the columns a register
-- fills, the fields of the site record and the status columns. What stays open: the task input columns and the columns with no source yet.
UPDATE master_columns mc SET is_protected = true, protected_reason = x.why
FROM (
  SELECT m.ord, CASE
    WHEN 'status' = ANY (m.site360_sections) THEN 'Status column: the stored derived status of the site.'
    WHEN m.owner IN ('row', 'key') THEN 'Row number and Site ID: the key of every row.'
    WHEN m.owner = 'identity' THEN 'Identity column written by the approved RF & Design record.'
    WHEN m.owner = 'scope' THEN 'Scope flag: the scenario and workflow rules read it.'
    WHEN m.owner = 'baseline' OR m.source_kind = 'baseline' THEN 'Baseline: the latest approved baseline version of the milestone.'
    WHEN m.owner = 'calc' OR m.source_kind = 'derived' THEN 'Calculated by the calculation layer.'
    WHEN m.source_kind = 'milestone'
      OR EXISTS (SELECT 1 FROM stage_definitions sd WHERE sd.master_export_column = m.letter)
      OR EXISTS (SELECT 1 FROM phase_gate_rules pg WHERE pg.master_export_column = m.letter) THEN 'Milestone or phase gate date: the workflow and Project Status read it.'
    WHEN m.source_kind = 'register' THEN 'Filled by a register record: the register owns the value.'
    WHEN m.source_kind = 'site' THEN 'A field of the site record.'
  END AS why
  FROM master_columns m WHERE m.ord <= 187
) x
WHERE mc.ord = x.ord AND x.why IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Rights of the definer role (reads of the sources of a column and writes of the columns and of the task inputs)
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON master_columns TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON template_task_fields TO pmis_definer;
GRANT SELECT ON field_definitions, task_field_sources, task_definitions, task_instances, sites, external_parties, list_catalogues, list_values TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The view (latest 0121, redefined in full; the change of 0132 is the last branch)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW site360_master_values WITH (security_invoker = true) AS
SELECT x.site_id, x.ord, x.value, 'site'::text AS kind, NULL::text AS register_key,
  'site'::text AS src_kind, NULL::text AS src_ref, NULL::uuid AS src_id, x.field AS src_field
FROM (
  SELECT s.id AS site_id, v.ord, v.value, v.field
  FROM sites s
  JOIN regions r ON r.id = s.region_id
  LEFT JOIN clusters c ON c.id = s.cluster_id
  CROSS JOIN LATERAL (VALUES
    (2, s.site_code::text, 'site_code'), (3, s.owner_site_id, 'owner_site_id'), (4, s.name, 'name'), (5, r.name_en, 'region_id'),
    (6, s.sub_region, 'sub_region'), (7, c.cluster_code, 'cluster_id'),
    (8, s.latitude::text, 'latitude'), (9, s.longitude::text, 'longitude'), (10, s.site_type, 'site_type'), (11, s.site_scenario, 'site_scenario'),
    (12, s.uplink_site, 'uplink_site'), (13, s.tower_owner, 'tower_owner'),
    (14, s.existing_or_new, 'existing_or_new'), (15, s.rt_or_gf, 'rt_or_gf'), (16, s.tower_type, 'tower_type'), (17, s.tower_height_m::text, 'tower_height_m'),
    (19, s.rf_survey_date::text, 'rf_survey_date'), (20, s.acquisition_date::text, 'acquisition_date'), (24, s.project_phase, 'project_phase'),
    (25, s.delivery_batch, 'delivery_batch'),
    (26, s.delivery_scenario::text, 'delivery_scenario'), (27, s.scope_tower_erection::text, 'scope_tower_erection'),
    (28, s.scope_site_adaption::text, 'scope_site_adaption'), (29, s.scope_gecol_power::text, 'scope_gecol_power'),
    (30, s.scope_hlc_fiber::text, 'scope_hlc_fiber'), (31, s.scope_te_full::text, 'scope_te_full'),
    (32, s.scope_te_ip_router_only::text, 'scope_te_ip_router_only'), (33, s.cw_delivery_model, 'cw_delivery_model'),
    (180, s.current_milestone, 'current_milestone'), (181, s.next_milestone, 'next_milestone'), (182, s.overall_status::text, 'overall_status')
  ) AS v(ord, value, field)
  WHERE s.is_active
) x
UNION ALL
-- task-backed columns (0121: read from site360_task_cells; the source is the instance whose value is shown)
SELECT t.site_id, t.ord,
  CASE WHEN bool_or(t.projection = 'latest') THEN max(t.value) ELSE min(t.value) END AS value,
  'task'::text AS kind,
  NULL::text AS register_key,
  CASE WHEN bool_or(t.is_milestone_task) THEN 'milestone' ELSE 'task' END AS src_kind,
  'task'::text AS src_ref,
  CASE WHEN bool_or(t.projection = 'latest') THEN (array_agg(t.task_id ORDER BY t.value DESC NULLS LAST, t.task_id))[1]
       ELSE (array_agg(t.task_id ORDER BY t.value ASC NULLS LAST, t.task_id))[1] END AS src_id,
  CASE WHEN bool_or(t.projection = 'latest') THEN (array_agg(t.field_key ORDER BY t.value DESC NULLS LAST, t.task_id))[1]
       ELSE (array_agg(t.field_key ORDER BY t.value ASC NULLS LAST, t.task_id))[1] END AS src_field
FROM site360_task_cells t
GROUP BY t.site_id, t.ord
UNION ALL
-- register-owned columns: the current record of the site in the source register (its external party, or a field of its data)
SELECT s.id AS site_id, mc.ord, rv.value, 'register'::text AS kind, x.register_key,
  'register'::text, 'register'::text, rv.id, x.field_code
FROM sites s
JOIN task_definitions td ON td.workflow_id = s.workflow_version_id
JOIN task_field_sources x ON x.task_code = td.code AND x.is_active AND x.master_col IS NOT NULL
JOIN master_columns mc ON mc.letter = x.master_col
LEFT JOIN LATERAL (
  SELECT CASE WHEN x.field_code = 'external_party_id' THEN ep.name ELSE rr.data ->> x.field_code END AS value, rr.id
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
SELECT i.site_id, v.ord, v.value, 'issue'::text AS kind, 'issues'::text AS register_key,
  'register'::text, 'register'::text, i.register_record_id, v.field
FROM (
  SELECT DISTINCT ON (iss.site_id) iss.site_id, iss.title, iss.detail, iss.owner_text, iss.owner_id, iss.raised_date, iss.status, iss.register_record_id
  FROM issues iss
  ORDER BY iss.site_id, (iss.status = 'closed'), iss.raised_date DESC, iss.id
) i
LEFT JOIN users u ON u.id = i.owner_id
CROSS JOIN LATERAL (VALUES
  (183, i.title, 'title'), (184, coalesce(i.owner_text, u.display_name), 'owner'), (185, i.raised_date::text, 'raised_date'),
  (186, i.status::text, 'status'), (187, i.detail, 'detail')
) AS v(ord, value, field)
UNION ALL
-- calc columns held by the procurement register (AJ, AK; 0119): the first order of the site whose scope is a CW contractor scope of the
-- workbook (Master!AJ5 / AK5: every scope except GECOL, TE Installation, CW Dismantle, TE Dismantle, STA and ST, i.e. CW, Tower Erection and
-- Site Adaption) and whose order is neither cancelled nor rejected; a record whose register version was voided does not count either
SELECT f.site_id, v.ord, v.value, 'register'::text AS kind, 'procurement'::text AS register_key,
  'register'::text, 'register'::text, f.register_record_id, v.field
FROM (
  SELECT DISTINCT ON (pr.site_id) pr.site_id, pr.party_id, pr.team_id, pr.register_record_id
  FROM procurement_records pr
  WHERE pr.scope IN ('CW', 'Tower Erection', 'Site Adaption')
    AND NOT coalesce(proc_order_cancelled(pr.order_status), false)
    AND coalesce(pr.order_status, '') !~* '^\s*reject'
    AND NOT EXISTS (SELECT 1 FROM register_records rr WHERE rr.id = pr.register_record_id AND (rr.state = 'voided' OR rr.voided_at IS NOT NULL))
  ORDER BY pr.site_id, coalesce(pr.po_wo_date, pr.pr_date) NULLS LAST, pr.id
) f
JOIN sites s ON s.id = f.site_id AND s.is_active
CROSS JOIN LATERAL (VALUES (36, site360_party_name(f.party_id), 'party_id'), (37, site360_team_name(f.team_id), 'team_id')) AS v(ord, value, field)
UNION ALL
-- BW GECOL Status (0119): the workbook formula (Master!BW5 over GECOL!R) from the GECOL scope AC and the approved GECOL record of the site
SELECT s.id, 75,
  CASE
    WHEN s.scope_gecol_power::text = 'na' THEN 'N/A'
    WHEN g.site_id IS NOT NULL THEN
      CASE WHEN s.scope_gecol_power::text = 'yes' AND g.power_on_date BETWEEN DATE '2020-01-01' AND DATE '2035-12-31' THEN 'Done' ELSE 'Pending' END
    WHEN s.scope_gecol_power::text = 'yes' THEN 'Pending'
  END,
  'register'::text, 'gecol'::text,
  'derived'::text, CASE WHEN g.register_record_id IS NOT NULL THEN 'register' END, g.register_record_id, 'power_on_date'::text
FROM sites s
LEFT JOIN gecol_records g ON g.site_id = s.id
WHERE s.is_active
  AND (s.scope_gecol_power::text IN ('na', 'yes') OR g.site_id IS NOT NULL)
UNION ALL
-- AL CW Access Date: the earliest approved "Access - CW" permit of the site
SELECT p.site_id, 38, min(p.valid_from)::text, 'register'::text, 'permits_hse'::text,
  'register'::text, 'register'::text, (array_agg(p.register_record_id ORDER BY p.valid_from, p.id))[1], 'valid_from'::text
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
  'register'::text, 'hlc'::text,
  'derived'::text, CASE WHEN h.register_record_id IS NOT NULL THEN 'register' END, h.register_record_id, 'installation_date'::text
FROM sites s
LEFT JOIN hlc_records h ON h.site_id = s.id
WHERE s.is_active
  AND (s.scope_hlc_fiber::text IN ('na', 'yes') OR h.site_id IS NOT NULL)

UNION ALL
-- AH PR Status and AI PO / WO Status (owner decision 2026-11-15, decision 1): the Master formulas
SELECT x.site_id, v.ord, v.value, 'register'::text AS kind, 'procurement'::text AS register_key,
  'derived'::text, NULL::text, NULL::uuid, NULL::text
FROM (
  SELECT s.id AS site_id, s.scope_tower_erection, s.scope_site_adaption, s.cw_delivery_model,
    (s.scope_tower_erection IS NULL OR s.scope_site_adaption IS NULL OR s.scope_gecol_power IS NULL OR s.scope_hlc_fiber IS NULL
      OR s.scope_te_full IS NULL OR s.scope_te_ip_router_only IS NULL) AS any_blank,
    (SELECT count(*) FROM procurement_records pr WHERE pr.site_id = s.id AND pr.scope IN ('Tower Erection', 'CW')
       AND NOT coalesce(proc_order_cancelled(pr.order_status), false) AND coalesce(pr.order_status, '') <> 'Rejected'
       AND pr.pr_date >= DATE '2020-01-01') AS te_pr,
    (SELECT count(*) FROM procurement_records pr WHERE pr.site_id = s.id AND pr.scope IN ('Site Adaption', 'CW')
       AND NOT coalesce(proc_order_cancelled(pr.order_status), false) AND coalesce(pr.order_status, '') <> 'Rejected'
       AND pr.pr_date >= DATE '2020-01-01') AS sa_pr,
    (SELECT count(*) FROM procurement_records pr WHERE pr.site_id = s.id AND pr.scope IN ('Tower Erection', 'CW')
       AND NOT coalesce(proc_order_cancelled(pr.order_status), false) AND coalesce(pr.order_status, '') <> 'Rejected'
       AND pr.po_wo_date >= DATE '2020-01-01') AS te_po,
    (SELECT count(*) FROM procurement_records pr WHERE pr.site_id = s.id AND pr.scope IN ('Site Adaption', 'CW')
       AND NOT coalesce(proc_order_cancelled(pr.order_status), false) AND coalesce(pr.order_status, '') <> 'Rejected'
       AND pr.po_wo_date >= DATE '2020-01-01') AS sa_po
  FROM sites s
  WHERE s.is_active
) x
CROSS JOIN LATERAL (VALUES
  (34, CASE
     WHEN x.any_blank THEN 'Pending'
     WHEN (x.scope_tower_erection = 'na' AND x.scope_site_adaption = 'na') OR x.cw_delivery_model = 'In-House' THEN 'N/A'
     WHEN coalesce(x.cw_delivery_model, '') = '' THEN 'Pending'
     WHEN (x.scope_tower_erection IS DISTINCT FROM 'yes' OR x.te_pr > 0) AND (x.scope_site_adaption IS DISTINCT FROM 'yes' OR x.sa_pr > 0) THEN 'Done'
     ELSE 'Pending' END),
  (35, CASE
     WHEN x.any_blank THEN 'Pending'
     WHEN x.scope_tower_erection = 'na' AND x.scope_site_adaption = 'na' THEN 'N/A'
     WHEN (x.scope_tower_erection IS DISTINCT FROM 'yes' OR x.te_po > 0) AND (x.scope_site_adaption IS DISTINCT FROM 'yes' OR x.sa_po > 0) THEN 'Done'
     ELSE 'Pending' END)
) AS v(ord, value)
UNION ALL
-- gate readiness columns (owner decision 2026-11-15, decision 2): the date of the milestone before the gate, once it is approved
SELECT s.id AS site_id, mc.ord, to_char(coalesce(ti.actual_date, ti.approved_date), 'YYYY-MM-DD') AS value, 'task'::text AS kind, NULL::text AS register_key,
  'milestone'::text, 'task'::text, ti.id, CASE WHEN ti.actual_date IS NOT NULL THEN 'actual_date' ELSE 'approved_date' END
FROM sites s
JOIN phase_gate_rules g ON g.workflow_id = s.workflow_version_id AND g.is_active AND g.master_export_column IS NOT NULL
JOIN master_columns mc ON mc.letter = g.master_export_column
JOIN stage_definitions sd ON sd.workflow_id = g.workflow_id AND sd.code = g.from_code AND sd.is_active
JOIN task_definitions td ON td.stage_id = sd.id AND td.is_milestone_task
JOIN task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id AND ti.state = 'approved'
WHERE s.is_active
  AND coalesce(ti.actual_date, ti.approved_date) BETWEEN DATE '2020-01-01' AND DATE '2035-12-31'
UNION ALL
-- R Configuration (WL/MW/IP/PWR) (0119): the field `configuration` of the site's As-Built TE part in force (the approved version)
SELECT c.site_id, 18, c.value, 'register'::text, 'as_built'::text,
  'register'::text, 'register'::text, c.id, 'configuration'::text
FROM (
  SELECT DISTINCT ON (rr.site_id) rr.site_id, rr.data ->> 'configuration' AS value, rr.id
  FROM register_records rr
  WHERE rr.register_key = 'as_built' AND rr.record_type = 'te_part' AND rr.is_current AND rr.state = 'approved' AND rr.voided_at IS NULL
    AND nullif(btrim(rr.data ->> 'configuration'), '') IS NOT NULL
  ORDER BY rr.site_id, rr.version_no DESC, rr.id
) c
JOIN sites s ON s.id = c.site_id AND s.is_active
UNION ALL
-- 0121: the Baseline columns (U, AV, BO, BY, CT, DO, EK, ER, EX, FL): the baseline date of the milestone in the latest approved baseline version of
-- the site (MAXIFS over the Current approved baseline of the workbook; the rule of the site page). The baseline column is the Master column just
-- before the milestone column of the stage.
SELECT b.site_id, mc.ord, b.baseline_date::text, 'site'::text, NULL::text,
  'baseline'::text, 'baseline'::text, b.version_id, b.milestone_code
FROM (
  SELECT DISTINCT ON (be.site_id, be.milestone_code) be.site_id, be.milestone_code, be.baseline_date, be.version_id
  FROM baseline_entries be
  JOIN baseline_versions bv ON bv.id = be.version_id AND bv.status = 'approved'
  ORDER BY be.site_id, be.milestone_code, bv.version DESC
) b
JOIN sites s ON s.id = b.site_id AND s.is_active
JOIN stage_definitions sd ON sd.workflow_id = s.workflow_version_id AND sd.code = b.milestone_code AND sd.master_export_column IS NOT NULL
JOIN master_columns mm ON mm.letter = sd.master_export_column
JOIN master_columns mc ON mc.ord = mm.ord - 1 AND mc.source_kind = 'baseline'
WHERE b.baseline_date IS NOT NULL
UNION ALL
-- 0121: AR / AS CW Survey & Analysis Report Submitted / Approved Date: task B5 (STA / ST analysis report); a template mapping of the column wins
SELECT s.id, v.ord, v.value, 'task'::text, NULL::text,
  'task'::text, 'task'::text, ti.id, v.field
FROM sites s
JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'B5'
JOIN task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id
CROSS JOIN LATERAL (VALUES (44, ti.submitted_date::text, 'submitted_date'), (45, ti.approved_date::text, 'approved_date')) AS v(ord, value, field)
WHERE s.is_active AND v.value IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM template_task_fields m JOIN master_columns mx ON mx.letter = m.master_col WHERE mx.ord = v.ord AND m.is_active)
UNION ALL
-- 0121: CB TE Access Date: the earliest approved "Access - TE" permit of the site (Master!CB5, as AL)
SELECT p.site_id, 80, min(p.valid_from)::text, 'register'::text, 'permits_hse'::text,
  'register'::text, 'register'::text, (array_agg(p.register_record_id ORDER BY p.valid_from, p.id))[1], 'valid_from'::text
FROM permit_records p
JOIN sites s ON s.id = p.site_id AND s.is_active
WHERE p.permit_type = 'Access - TE' AND p.status = 'Approved' AND p.valid_from IS NOT NULL
GROUP BY p.site_id
UNION ALL
-- 0121: CE Vendor Team: the team of the first order of scope "TE Installation" that is neither cancelled nor rejected (Master!CE5)
SELECT f.site_id, 83, site360_team_name(f.team_id), 'register'::text, 'procurement'::text,
  'register'::text, 'register'::text, f.register_record_id, 'team_id'::text
FROM (
  SELECT DISTINCT ON (pr.site_id) pr.site_id, pr.team_id, pr.register_record_id
  FROM procurement_records pr
  WHERE pr.scope = 'TE Installation'
    AND NOT coalesce(proc_order_cancelled(pr.order_status), false)
    AND coalesce(pr.order_status, '') !~* '^\s*reject'
    AND NOT EXISTS (SELECT 1 FROM register_records rr WHERE rr.id = pr.register_record_id AND (rr.state = 'voided' OR rr.voided_at IS NOT NULL))
  ORDER BY pr.site_id, coalesce(pr.po_wo_date, pr.pr_date) NULLS LAST, pr.id
) f
JOIN sites s ON s.id = f.site_id AND s.is_active
UNION ALL
-- 0121: CZ RSL Deviation (dB): CY (MW Measured RSL) minus the RSL of the approved As-Built TE part, both numbers, the As-Built RSL not 0 (Master!CZ5)
SELECT c.site_id, 104, trim_scale(c.value::numeric - a.rsl::numeric)::text, 'register'::text, 'as_built'::text,
  'derived'::text, 'register'::text, a.id, 'rsl'::text
FROM (
  SELECT DISTINCT ON (tc.site_id) tc.site_id, btrim(tc.value) AS value
  FROM site360_task_cells tc
  WHERE tc.letter = 'CY' AND tc.value ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
  ORDER BY tc.site_id, tc.task_id
) c
JOIN (
  SELECT DISTINCT ON (rr.site_id) rr.site_id, rr.id, btrim(rr.data ->> 'rsl') AS rsl
  FROM register_records rr
  WHERE rr.register_key = 'as_built' AND rr.record_type = 'te_part' AND rr.is_current AND rr.state = 'approved' AND rr.voided_at IS NULL
    AND rr.data ->> 'rsl' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
  ORDER BY rr.site_id, rr.version_no DESC, rr.id
) a ON a.site_id = c.site_id
WHERE a.rsl::numeric <> 0
UNION ALL
-- 0121: DG Outage Duration (wd): from Window Start (DD) and Window End (DE), both valid dates (Master!DG5)
SELECT w.site_id, 111,
  CASE WHEN w.e < w.s THEN 'Date Error' ELSE cal_workdays_between(w.s, w.e)::text END,
  'task'::text, NULL::text,
  'derived'::text, 'task'::text, w.task_id, 'window_start, window_end'::text
FROM (
  SELECT tc.site_id, (array_agg(tc.task_id ORDER BY tc.task_id))[1] AS task_id,
    max(site360_date(tc.value)) FILTER (WHERE tc.letter = 'DD') AS s,
    max(site360_date(tc.value)) FILTER (WHERE tc.letter = 'DE') AS e
  FROM site360_task_cells tc
  WHERE tc.letter IN ('DD', 'DE')
  GROUP BY tc.site_id
) w
WHERE w.s BETWEEN DATE '2020-01-01' AND DATE '2035-12-31' AND w.e BETWEEN DATE '2020-01-01' AND DATE '2035-12-31'
UNION ALL
-- 0121: DH Legacy Dismantle Due: Cold Swap only, the On-Air date (DP) plus the maximum working days of SLA rule S-5 (Master!DH5)
SELECT s.id, 112, cal_add_workdays(dp.d, coalesce(r.max_working_days, 0))::text, 'task'::text, NULL::text,
  'derived'::text, 'task'::text, dp.task_id, 'actual_date + S-5'::text
FROM sites s
JOIN (
  SELECT DISTINCT ON (tc.site_id) tc.site_id, tc.task_id, site360_date(tc.value) AS d
  FROM site360_task_cells tc
  WHERE tc.letter = 'DP'
  ORDER BY tc.site_id, tc.value DESC NULLS LAST, tc.task_id
) dp ON dp.site_id = s.id
LEFT JOIN LATERAL (
  SELECT r.max_working_days
  FROM sla_rules r
  WHERE r.code = 'S-5' AND r.is_active
    AND (r.region_id IS NULL OR r.region_id = s.region_id)
    AND (r.scenario IS NULL OR r.scenario = s.delivery_scenario)
    AND r.effective_from <= dp.d AND (r.effective_to IS NULL OR r.effective_to > dp.d)
    AND (r.rule_set_id IS NULL OR EXISTS (SELECT 1 FROM sla_rule_sets rs WHERE rs.id = r.rule_set_id AND rs.status = 'published'))
  ORDER BY (r.region_id IS NOT NULL)::int * 2 + (r.scenario IS NOT NULL)::int DESC, r.effective_from DESC
  LIMIT 1
) r ON true
WHERE s.is_active AND s.delivery_scenario::text = 'cold_swap'
  AND dp.d BETWEEN DATE '2020-01-01' AND DATE '2035-12-31'
UNION ALL
-- 0121: DI Rollback Count: the approved (or applied) Change Control records of type "Cutover Rollback" of the site, 0 when none (Master!DI5)
SELECT s.id, 113,
  (SELECT count(*) FROM change_requests c
   WHERE c.site_id = s.id AND c.change_type = 'Cutover Rollback' AND c.status::text IN ('approved', 'applied') AND NOT coalesce(c.withdrawn, false))::text,
  'register'::text, 'change_control'::text,
  'derived'::text, NULL::text, NULL::uuid, 'change_type'::text
FROM sites s
WHERE s.is_active
UNION ALL
-- 0121: EN Cluster ID (= G) and EQ KPI Source Validation (Master!EN5, EQ5)
SELECT s.id, v.ord, v.value, 'task'::text, NULL::text,
  'derived'::text, NULL::text, NULL::uuid, v.field
FROM sites s
LEFT JOIN clusters c ON c.id = s.cluster_id
CROSS JOIN LATERAL (VALUES
  (144, nullif(c.cluster_code, ''), 'cluster_id'),
  (147, CASE
     WHEN nullif(c.cluster_code, '') IS NULL THEN 'Missing Cluster ID'
     ELSE CASE (SELECT count(DISTINCT s2.id) FROM sites s2 JOIN site360_task_cells e ON e.site_id = s2.id AND e.letter = 'EP'
                WHERE s2.cluster_id = s.cluster_id AND s2.is_active AND site360_date(e.value) IS NOT NULL)
            WHEN 0 THEN 'No Source' WHEN 1 THEN 'Valid' ELSE 'Multiple Sources' END
   END, 'cluster_id, EP')
) AS v(ord, value, field)
WHERE s.is_active AND v.value IS NOT NULL
UNION ALL
-- 0121: EW HOTO Package Date (the HOTO Package Valid Date: the later of the HOTO Package Actual Date and the Site Access & Keys Handover Date, both
-- valid) and FK Contractual Obligations Closure Date, from the approved Readiness & Handover record of the site (Master!EW5, FK5)
SELECT rh.site_id, v.ord, v.value, 'register'::text, 'readiness_handover'::text,
  'register'::text, 'register'::text, rh.register_record_id, v.field
FROM readiness_handover rh
JOIN sites s ON s.id = rh.site_id AND s.is_active
LEFT JOIN register_records rr ON rr.id = rh.register_record_id
CROSS JOIN LATERAL (SELECT site360_date(rr.data ->> 'hoto_package_actual_date') AS h, site360_date(rr.data ->> 'access_keys_handover_date') AS k) d
CROSS JOIN LATERAL (VALUES
  (153, CASE WHEN d.h BETWEEN DATE '2020-01-01' AND DATE '2035-12-31' AND d.k BETWEEN DATE '2020-01-01' AND DATE '2035-12-31'
             THEN greatest(d.h, d.k)::text END, 'hoto_package_actual_date, access_keys_handover_date'),
  (167, rh.obligations_closure_date::text, 'obligations_closure_date')
) AS v(ord, value, field)
WHERE v.value IS NOT NULL
UNION ALL
-- 0121: FA / FB CW DLP Start and End (Master!FA5, FB5: BV when valid; plus CWDLPDays) and FF / FG TE DLP Start and End (FF5, FG5: EL when valid;
-- EDATE plus TEDLPMonths)
SELECT b.site_id, v.ord, v.value, 'task'::text, NULL::text,
  'derived'::text, 'task'::text, b.task_id, v.field
FROM (
  SELECT DISTINCT ON (tc.site_id, tc.letter) tc.site_id, tc.letter, tc.task_id, site360_date(tc.value) AS d
  FROM site360_task_cells tc
  WHERE tc.letter IN ('BV', 'EL')
  ORDER BY tc.site_id, tc.letter, tc.value DESC NULLS LAST, tc.task_id
) b
CROSS JOIN LATERAL (VALUES
  (CASE b.letter WHEN 'BV' THEN 157 ELSE 162 END, b.d::text, 'actual_date'),
  (CASE b.letter WHEN 'BV' THEN 158 ELSE 163 END,
   CASE b.letter
     WHEN 'BV' THEN (b.d + coalesce((calc_setting('sla.dlp_days.cw', 'null'::jsonb) #>> '{}')::integer, 90))::text
     ELSE (b.d + make_interval(months => coalesce((calc_setting('dlp.months.te', 'null'::jsonb) #>> '{}')::integer, 12)))::date::text
   END,
   CASE b.letter WHEN 'BV' THEN 'actual_date + sla.dlp_days.cw' ELSE 'actual_date + dlp.months.te' END)
) AS v(ord, value, field)
WHERE b.d BETWEEN DATE '2020-01-01' AND DATE '2035-12-31'
UNION ALL
-- 0121: FN / FS Site RFD and FQ / FV Actual Date of the current Dismantle parts (cw, te), the record of FO / FT
SELECT d.site_id, v.ord, v.value, 'register'::text, 'dismantle'::text,
  'register'::text, 'register'::text, d.id, v.field
FROM (
  SELECT DISTINCT ON (rr.site_id, rr.record_type) rr.site_id, rr.record_type, rr.id, rr.data
  FROM register_records rr
  WHERE rr.register_key = 'dismantle' AND rr.is_current AND rr.voided_at IS NULL AND rr.record_type IN ('cw', 'te')
  ORDER BY rr.site_id, rr.record_type, rr.version_no DESC, rr.id
) d
JOIN sites s ON s.id = d.site_id AND s.is_active
CROSS JOIN LATERAL (VALUES
  (CASE d.record_type WHEN 'cw' THEN 170 ELSE 175 END, site360_date(d.data ->> 'rfd_date')::text, 'rfd_date'),
  (CASE d.record_type WHEN 'cw' THEN 173 ELSE 178 END, site360_date(d.data ->> 'work_end_date')::text, 'work_end_date')
) AS v(ord, value, field)
WHERE v.value IS NOT NULL
UNION ALL
-- 0121: a site custom field carrying the Master export column of a not-tracked column fills it (field visibility is applied by the API)
SELECT s.id, mc.ord, s.custom ->> fd.code, 'custom_field'::text, NULL::text,
  'custom_field'::text, 'custom_field'::text, fd.id, fd.code
FROM field_definitions fd
JOIN master_columns mc ON mc.letter = fd.master_export_column AND mc.source_kind = 'not_tracked'
CROSS JOIN sites s
WHERE fd.entity_type = 'site' AND fd.is_active AND s.is_active
  AND nullif(btrim(s.custom ->> fd.code), '') IS NOT NULL
UNION ALL
-- 0132: a site custom field chosen as the source of an added column (master_columns.source_field_id) fills it
SELECT s.id, mc.ord, s.custom ->> fd.code, 'custom_field'::text, NULL::text,
  'custom_field'::text, 'custom_field'::text, fd.id, fd.code
FROM master_columns mc
JOIN field_definitions fd ON fd.id = mc.source_field_id
CROSS JOIN sites s
WHERE fd.entity_type = 'site' AND fd.is_active AND s.is_active
  AND nullif(btrim(s.custom ->> fd.code), '') IS NOT NULL
;

COMMENT ON VIEW site360_master_values IS 'The Master values of each site and column with the source of each value (0104, F15, extended 0106 to 0112, 0119, 0121, 0132): the set-based read model of the SITE 360 grid rows and of the per-site sources. 0132: a site custom field fills an added column.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Small pure helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- The Master letter of an order: 1 = A, 26 = Z, 27 = AA, 187 = GE, 188 = GF.
CREATE OR REPLACE FUNCTION site360_col_letter(p_ord integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE n integer := p_ord; s text := '';
BEGIN
  IF n IS NULL OR n < 1 THEN RETURN NULL; END IF;
  WHILE n > 0 LOOP
    s := chr(65 + ((n - 1) % 26)) || s;
    n := (n - 1) / 26;
  END LOOP;
  RETURN s;
END $$;

-- The header of the Master sheet: "group / name", or the name alone when there is no group.
CREATE OR REPLACE FUNCTION site360_col_header(p_mid text, p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN nullif(btrim(coalesce(p_name, '')), '') IS NULL THEN NULL
              WHEN nullif(btrim(coalesce(p_mid, '')), '') IS NULL THEN btrim(p_name)
              ELSE btrim(p_mid) || ' / ' || btrim(p_name) END
$$;

-- The key of a new task input made from a column name: v:<slug>.
CREATE OR REPLACE FUNCTION site360_col_slug(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(nullif(left(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'), '_'), 50), ''), 'col')
$$;

CREATE OR REPLACE FUNCTION site360_col_err(p_path text, p_code text, p_msg text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('path', p_path, 'code', p_code, 'message', p_msg)
$$;

-- Why a stored value does not fit a type and list (NULL when it fits or is empty): not_a_number, not_a_date, not_yes_no, not_in_list. Text takes everything.
CREATE OR REPLACE FUNCTION site360_value_misfit(p_value text, p_type text, p_list text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN nullif(btrim(coalesce(p_value, '')), '') IS NULL THEN NULL
    WHEN p_type = 'number' THEN CASE WHEN btrim(p_value) ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN NULL ELSE 'not_a_number' END
    WHEN p_type = 'date' THEN CASE WHEN public.site360_date(p_value) IS NOT NULL THEN NULL ELSE 'not_a_date' END
    WHEN p_type = 'yes_no' THEN CASE WHEN lower(btrim(p_value)) IN ('yes', 'no', 'true', 'false', 'y', 'n', '1', '0') THEN NULL ELSE 'not_yes_no' END
    WHEN p_type = 'list' THEN CASE WHEN EXISTS (
        SELECT 1 FROM public.list_values lv
        WHERE lv.catalogue_code = p_list AND lv.is_active
          AND (lower(lv.code) = lower(btrim(p_value)) OR lower(lv.label_en) = lower(btrim(p_value)) OR lower(coalesce(lv.label_ar, '')) = lower(btrim(p_value))
               OR lower(btrim(p_value)) = ANY (SELECT lower(a) FROM unnest(lv.aliases) a))
      ) THEN NULL ELSE 'not_in_list' END
    ELSE NULL END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Reads (internal: owner pmis_definer, no rights for pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
-- The effective type and list of a column: the type of the task input that fills it (every input mapped to the letter; `locked_inputs` counts those whose key is
-- not a typed value, a date or the external party: they keep their type), else the column's own, else text.
CREATE OR REPLACE FUNCTION site360_col_effective(p_ord integer) RETURNS TABLE (value_type text, list_catalogue text, inputs integer, locked_inputs integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(x.ft, mc.value_type, 'text'), CASE WHEN x.ft IS NOT NULL THEN x.lc ELSE mc.list_catalogue END, coalesce(x.n, 0), coalesce(x.locked, 0)
  FROM public.master_columns mc
  LEFT JOIN LATERAL (
    SELECT (array_agg(t.field_type ORDER BY t.task_code, t.field_key))[1] AS ft, (array_agg(t.list_catalogue ORDER BY t.task_code, t.field_key))[1] AS lc,
           count(*)::int AS n, (count(*) FILTER (WHERE t.field_key NOT LIKE 'v:%'))::int AS locked
    FROM public.template_task_fields t WHERE t.master_col = mc.letter AND t.is_active
  ) x ON x.n > 0
  WHERE mc.ord = p_ord
$$;

-- The column as the Studio shows it.
CREATE OR REPLACE FUNCTION site360_col_json(p_ord integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'ord', mc.ord, 'letter', mc.letter, 'display_order', mc.display_order, 'group_top', mc.group_top, 'group_mid', mc.group_mid,
    'name_en', mc.name, 'name_ar', mc.name_ar, 'header', mc.header, 'value_type', e.value_type, 'list_catalogue', e.list_catalogue,
    'source', jsonb_build_object('kind', CASE
        WHEN mc.source_kind <> 'not_tracked' THEN mc.source_kind
        WHEN EXISTS (SELECT 1 FROM public.field_definitions f WHERE f.entity_type::text = 'site' AND f.is_active AND f.master_export_column = mc.letter) THEN 'custom_field'
        WHEN e.inputs > 0 THEN 'task'
        WHEN EXISTS (SELECT 1 FROM public.task_field_sources s WHERE s.is_active AND s.master_col = mc.letter) THEN 'register'
        ELSE 'not_tracked' END, 'note', mc.source_note)
      || jsonb_strip_nulls(jsonb_build_object('task_code', ti.task_code, 'field_key', ti.field_key, 'input_label', ti.label, 'input_read_only', ti.read_only,
           'site_field_id', sf.id, 'site_field_code', sf.code, 'site_field_label', sf.label_en)),
    'sections', to_jsonb(mc.site360_sections), 'is_protected', mc.is_protected, 'protected_reason', mc.protected_reason,
    'is_added', mc.is_added, 'is_active', mc.is_active, 'version', mc.version)
  FROM public.master_columns mc
  CROSS JOIN LATERAL public.site360_col_effective(mc.ord) e
  LEFT JOIN LATERAL (
    SELECT t.task_code, t.field_key, t.label, t.read_only FROM public.template_task_fields t
    WHERE t.master_col = mc.letter AND t.is_active ORDER BY t.task_code, t.field_key LIMIT 1
  ) ti ON true
  LEFT JOIN public.field_definitions sf ON sf.id = mc.source_field_id
  WHERE mc.ord = p_ord
$$;

-- The values a column holds in the sites, from the two sources an admin can give it: the task inputs mapped to its letter and a site custom field (the source of an
-- added column, or the field that carries the letter of a not-tracked column). The same reading as the view, for every site and without the caller's region filter.
CREATE OR REPLACE FUNCTION site360_col_values(p_ord integer) RETURNS TABLE (site_id uuid, site_code text, value text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id, s.site_code::text, nullif(btrim(v.val), '')
  FROM public.master_columns mc
  JOIN public.template_task_fields tf ON tf.master_col = mc.letter AND tf.is_active AND tf.field_key NOT LIKE 'r:%'
  JOIN public.task_definitions td ON td.code = tf.task_code
  JOIN public.sites s ON s.workflow_version_id = td.workflow_id AND s.is_active AND (tf.scenarios IS NULL OR s.delivery_scenario::text = ANY (tf.scenarios))
  JOIN public.task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id
  LEFT JOIN public.external_parties ep ON ep.id = ti.external_party_id
  CROSS JOIN LATERAL (SELECT CASE tf.field_key
      WHEN 'planned_date' THEN ti.planned_date::text
      WHEN 'planned_start' THEN ti.planned_start::text
      WHEN 'actual_start' THEN ti.actual_start::text
      WHEN 'actual_date' THEN ti.actual_date::text
      WHEN 'submitted_date' THEN ti.submitted_date::text
      WHEN 'approved_date' THEN ti.approved_date::text
      WHEN 'external_party' THEN ep.name
      ELSE CASE WHEN tf.field_key LIKE 'v:%' THEN ti."values" ->> substr(tf.field_key, 3) END
    END AS val) v
  WHERE mc.ord = p_ord AND nullif(btrim(v.val), '') IS NOT NULL
  UNION ALL
  SELECT s.id, s.site_code::text, nullif(btrim(s.custom ->> fd.code), '')
  FROM public.master_columns mc
  JOIN public.field_definitions fd ON fd.entity_type::text = 'site' AND fd.is_active
    AND (fd.id = mc.source_field_id OR (fd.master_export_column = mc.letter AND mc.source_kind = 'not_tracked'))
  CROSS JOIN public.sites s
  WHERE mc.ord = p_ord AND s.is_active AND nullif(btrim(s.custom ->> fd.code), '') IS NOT NULL
$$;

-- A register mapping (task_field_sources) an admin pointed at the column: its values are not read here, so the column is "in use" for a delete.
CREATE OR REPLACE FUNCTION site360_col_other_source(p_ord integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.task_field_sources x JOIN public.master_columns mc ON mc.letter = x.master_col WHERE mc.ord = p_ord AND x.is_active)
$$;

-- The column with its usage: value_count (null for a protected column, which the system fills) and delete_mode.
CREATE OR REPLACE FUNCTION site360_col_detail(p_ord integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mc public.master_columns%ROWTYPE; vc integer; other boolean;
BEGIN
  SELECT * INTO mc FROM public.master_columns WHERE ord = p_ord;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  vc := CASE WHEN mc.is_protected THEN NULL ELSE (SELECT count(DISTINCT v.site_id)::int FROM public.site360_col_values(p_ord) v) END;
  other := public.site360_col_other_source(p_ord);
  RETURN public.site360_col_json(p_ord) || jsonb_build_object('value_count', vc,
    'delete_mode', CASE WHEN mc.is_protected THEN 'blocked' WHEN mc.is_added AND coalesce(vc, 0) = 0 AND NOT other THEN 'hard' ELSE 'deactivate' END);
END $$;

-- How many values of the column fit a type and a list, and up to 50 that do not.
CREATE OR REPLACE FUNCTION site360_col_conversion(p_ord integer, p_type text, p_list text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mc public.master_columns%ROWTYPE; e record; total integer; bad integer; samples jsonb;
BEGIN
  SELECT * INTO mc FROM public.master_columns WHERE ord = p_ord;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  SELECT * INTO e FROM public.site360_col_effective(p_ord);
  WITH v AS (
    SELECT x.site_code, x.value, public.site360_value_misfit(x.value, p_type, p_list) AS why FROM public.site360_col_values(p_ord) x
  )
  SELECT count(*)::int, (count(*) FILTER (WHERE v.why IS NOT NULL))::int,
         coalesce((SELECT jsonb_agg(jsonb_build_object('site_code', q.site_code, 'value', q.value, 'reason', q.why) ORDER BY q.site_code COLLATE "C")
                   FROM (SELECT * FROM v WHERE v.why IS NOT NULL ORDER BY v.site_code COLLATE "C" LIMIT 50) q), '[]'::jsonb)
  INTO total, bad, samples FROM v;
  RETURN jsonb_build_object('ord', mc.ord, 'letter', mc.letter, 'from_type', e.value_type, 'to_type', p_type, 'from_list', e.list_catalogue, 'to_list', p_list,
    'total_values', total, 'convertible', total - bad, 'not_convertible', bad, 'samples', samples);
END $$;

-- The errors of a place: the column sits after the display order p_anchor_disp (p_self is left out of the neighbours when it moves). Inside a band (the
-- column before and the column after share it) the band is that band; inside a group, that group; at the end of a band or a group the column may extend it, join
-- the next one or start a new one, never a band or group that exists elsewhere.
CREATE OR REPLACE FUNCTION site360_col_place_errors(p_band text, p_grp text, p_anchor_disp integer, p_self integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE pv public.master_columns%ROWTYPE; nx public.master_columns%ROWTYPE; inside boolean; adj_l boolean; adj_r boolean; fresh_b boolean; fresh_g boolean; errs jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO pv FROM public.master_columns x WHERE x.is_active AND x.ord IS DISTINCT FROM p_self AND x.display_order <= p_anchor_disp ORDER BY x.display_order DESC LIMIT 1;
  SELECT * INTO nx FROM public.master_columns x WHERE x.is_active AND x.ord IS DISTINCT FROM p_self AND x.display_order > p_anchor_disp ORDER BY x.display_order ASC LIMIT 1;
  inside := pv.ord IS NOT NULL AND nx.ord IS NOT NULL AND pv.group_top IS NOT DISTINCT FROM nx.group_top;
  adj_l := pv.ord IS NOT NULL AND p_band IS NOT DISTINCT FROM pv.group_top;
  adj_r := nx.ord IS NOT NULL AND p_band IS NOT DISTINCT FROM nx.group_top;
  fresh_b := NOT EXISTS (SELECT 1 FROM public.master_columns x WHERE x.is_active AND x.ord IS DISTINCT FROM p_self AND x.group_top IS NOT DISTINCT FROM p_band);
  fresh_g := NOT EXISTS (SELECT 1 FROM public.master_columns x WHERE x.is_active AND x.ord IS DISTINCT FROM p_self AND x.group_top IS NOT DISTINCT FROM p_band
                           AND x.group_mid IS NOT DISTINCT FROM p_grp);
  IF inside THEN
    IF NOT adj_l THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/group_top', 'placement_splits_band', 'Here the column sits inside the band ' || coalesce(pv.group_top, '(none)') || '; use that band.'));
    ELSIF pv.group_mid IS NOT DISTINCT FROM nx.group_mid THEN
      IF p_grp IS DISTINCT FROM pv.group_mid THEN
        errs := errs || jsonb_build_array(public.site360_col_err('/group_mid', 'placement_splits_group', 'Here the column sits inside the group ' || coalesce(pv.group_mid, '(none)') || '; use that group.'));
      END IF;
    ELSIF NOT (p_grp IS NOT DISTINCT FROM pv.group_mid OR p_grp IS NOT DISTINCT FROM nx.group_mid OR fresh_g) THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/group_mid', 'placement_splits_group', 'Use the group before, the group after or a new group.'));
    END IF;
  ELSE
    IF NOT (adj_l OR adj_r OR fresh_b) THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/group_top', 'placement_splits_band', 'Use the band before, the band after or a new band.'));
    ELSIF NOT fresh_b AND NOT ((adj_l AND p_grp IS NOT DISTINCT FROM pv.group_mid) OR (adj_r AND p_grp IS NOT DISTINCT FROM nx.group_mid) OR fresh_g) THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/group_mid', 'placement_splits_group', 'Use the group before, the group after or a new group.'));
    END IF;
  END IF;
  RETURN errs;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The doors
-- ---------------------------------------------------------------------------------------------------------------------
-- The caller may manage the columns: a System Admin, or a delegate of fields.edit for all regions (the API asks before the step-up, so a plain user gets 403).
CREATE OR REPLACE FUNCTION site360_col_can_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.app_actor() IS NOT NULL AND public.app_actor_is_admin('fields', 'edit') AND public.app_actor_region_filter('fields', 'edit') IS NULL
$$;

CREATE OR REPLACE FUNCTION site360_columns_list(p_include_inactive boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  RETURN coalesce((SELECT jsonb_agg(public.site360_col_json(mc.ord) ORDER BY mc.display_order) FROM public.master_columns mc
                   WHERE mc.is_active OR coalesce(p_include_inactive, true)), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION site360_column_get(p_ord integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  RETURN public.site360_col_detail(p_ord);
END $$;

CREATE OR REPLACE FUNCTION site360_column_type_preview(p_ord integer, p_type text, p_list text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mc public.master_columns%ROWTYPE; v_list text := nullif(btrim(coalesce(p_list, '')), ''); errs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  SELECT * INTO mc FROM public.master_columns WHERE ord = p_ord;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF p_type IS NULL OR p_type NOT IN ('text', 'number', 'date', 'list', 'yes_no') THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'invalid', 'One of text, number, date, list, yes_no.'));
  ELSIF p_type = 'list' AND v_list IS NULL THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'list_required', 'A list column needs a dropdown list.'));
  ELSIF p_type <> 'list' AND v_list IS NOT NULL THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'list_not_allowed', 'Only a list column takes a dropdown list.'));
  ELSIF v_list IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.list_catalogues WHERE code = v_list AND is_active) THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'unknown_list', 'No active list has this code.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF mc.is_protected THEN
    PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'This column is protected: its type cannot change.', 'reason', mc.protected_reason));
  END IF;
  RETURN public.site360_col_conversion(p_ord, p_type, v_list);
END $$;

-- Add a column after any column. p_body: name_en, name_ar, group_top, group_mid, after_ord, value_type, list_catalogue, source, sections.
CREATE OR REPLACE FUNCTION site360_column_create(p_body jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b jsonb := CASE WHEN jsonb_typeof(p_body) = 'object' THEN p_body ELSE '{}'::jsonb END; errs jsonb := '[]'::jsonb; k text;
  v_name text; v_name_ar text; v_top text; v_mid text; v_after integer; v_type text; v_list text; src jsonb; skind text; tcode text; fkey text; found_input boolean := false;
  anchor public.master_columns%ROWTYPE; tf public.template_task_fields%ROWTYPE; fd public.field_definitions%ROWTYPE; secs text[]; new_ord integer; new_letter text; hdr text;
  n integer; src_note text; owner_v text; made_input boolean := false; field_id uuid;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('site360_master_columns'));

  FOR k IN SELECT jsonb_object_keys(b) LOOP
    IF k NOT IN ('name_en', 'name_ar', 'group_top', 'group_mid', 'after_ord', 'value_type', 'list_catalogue', 'source', 'sections') THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/' || k, 'unknown_field', 'This key cannot be set.'));
    END IF;
  END LOOP;
  v_name := btrim(coalesce(b ->> 'name_en', ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN errs := errs || jsonb_build_array(public.site360_col_err('/name_en', 'required', 'A name of 1 to 120 characters.')); END IF;
  v_name_ar := nullif(btrim(coalesce(b ->> 'name_ar', '')), '');
  IF char_length(coalesce(v_name_ar, '')) > 120 THEN errs := errs || jsonb_build_array(public.site360_col_err('/name_ar', 'invalid', 'Up to 120 characters.')); END IF;
  v_top := btrim(coalesce(b ->> 'group_top', ''));
  IF char_length(v_top) NOT BETWEEN 1 AND 80 THEN errs := errs || jsonb_build_array(public.site360_col_err('/group_top', 'required', 'A band of 1 to 80 characters.')); END IF;
  v_mid := nullif(btrim(coalesce(b ->> 'group_mid', '')), '');
  IF char_length(coalesce(v_mid, '')) > 80 THEN errs := errs || jsonb_build_array(public.site360_col_err('/group_mid', 'invalid', 'Up to 80 characters.')); END IF;
  IF coalesce(b ->> 'after_ord', '') !~ '^[0-9]{1,4}$' THEN errs := errs || jsonb_build_array(public.site360_col_err('/after_ord', 'required', 'The order of the column it sits after.'));
  ELSE v_after := (b ->> 'after_ord')::integer; END IF;
  v_type := nullif(btrim(coalesce(b ->> 'value_type', '')), '');
  IF v_type IS NOT NULL AND v_type NOT IN ('text', 'number', 'date', 'list', 'yes_no') THEN errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'invalid', 'One of text, number, date, list, yes_no.')); END IF;
  v_list := nullif(btrim(coalesce(b ->> 'list_catalogue', '')), '');
  src := b -> 'source';
  IF jsonb_typeof(src) IS DISTINCT FROM 'object' THEN errs := errs || jsonb_build_array(public.site360_col_err('/source', 'required', 'A source is required: a task input or a site field.'));
  ELSE
    skind := src ->> 'kind';
    IF skind IS NULL OR skind NOT IN ('task_input', 'site_field') THEN errs := errs || jsonb_build_array(public.site360_col_err('/source/kind', 'invalid', 'task_input or site_field.')); END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF lower(v_top) IN ('#', 'phase gate', 'status') THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/group_top', 'reserved_band', 'The bands #, Phase Gate and STATUS belong to the system.'));
  END IF;
  SELECT * INTO anchor FROM public.master_columns WHERE ord = v_after;
  IF anchor.ord IS NULL THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/after_ord', 'unknown_column', 'No Master column has this order.'));
  ELSE
    errs := errs || public.site360_col_place_errors(v_top, v_mid, anchor.display_order, NULL);
  END IF;

  IF skind = 'task_input' THEN
    tcode := btrim(coalesce(src ->> 'task_code', ''));
    fkey := nullif(btrim(coalesce(src ->> 'field_key', '')), '');
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE code = tcode) THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/source/task_code', 'unknown_task', 'No task of the workflow has this code.'));
    END IF;
    IF fkey IS NOT NULL AND fkey !~ '^(planned_date|planned_start|actual_start|actual_date|submitted_date|approved_date|external_party|v:[a-z0-9_]{1,60})$' THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/source/field_key', 'invalid', 'planned_date, planned_start, actual_start, actual_date, submitted_date, approved_date, external_party or v:<key>.'));
    END IF;
    IF jsonb_array_length(errs) = 0 AND fkey IS NOT NULL THEN
      SELECT * INTO tf FROM public.template_task_fields WHERE task_code = tcode AND field_key = fkey;
      found_input := tf.id IS NOT NULL;
    END IF;
    IF jsonb_array_length(errs) = 0 THEN
      IF found_input THEN
        IF NOT tf.is_active THEN errs := errs || jsonb_build_array(public.site360_col_err('/source/field_key', 'inactive_input', 'This task input is inactive.')); END IF;
        IF v_type IS NOT NULL AND v_type <> tf.field_type THEN errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'type_follows_source', 'The column takes the type of the task input (' || tf.field_type || ').')); END IF;
        IF b ? 'list_catalogue' AND v_list IS DISTINCT FROM tf.list_catalogue THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'type_follows_source', 'The column takes the list of the task input.')); END IF;
        v_type := tf.field_type; v_list := tf.list_catalogue;
      ELSE
        IF fkey IS NULL THEN fkey := 'v:' || public.site360_col_slug(v_name); END IF;
        IF fkey ~ '^(planned_date|planned_start|actual_start|actual_date|submitted_date|approved_date)$' THEN
          IF v_type IS NOT NULL AND v_type <> 'date' THEN errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'type_follows_source', 'A date of the task is a date.')); END IF;
          v_type := 'date'; v_list := NULL;
        ELSIF fkey = 'external_party' THEN
          IF v_type IS NOT NULL AND v_type <> 'text' THEN errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'type_follows_source', 'The external party is text.')); END IF;
          v_type := 'text'; v_list := NULL;
        ELSIF v_type IS NULL THEN
          errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'required', 'The type of the new task input is required.'));
        END IF;
      END IF;
    END IF;
  ELSIF skind = 'site_field' THEN
    IF coalesce(src ->> 'field_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/source/field_id', 'required', 'The id of a site custom field.'));
    ELSE
      field_id := (src ->> 'field_id')::uuid;
      SELECT * INTO fd FROM public.field_definitions WHERE id = field_id;
      IF fd.id IS NULL THEN errs := errs || jsonb_build_array(public.site360_col_err('/source/field_id', 'not_found', 'No custom field has this id.'));
      ELSIF fd.entity_type::text <> 'site' THEN errs := errs || jsonb_build_array(public.site360_col_err('/source/field_id', 'not_a_site_field', 'Only a site field can fill a column.'));
      ELSIF NOT fd.is_active THEN errs := errs || jsonb_build_array(public.site360_col_err('/source/field_id', 'inactive_field', 'This field is inactive.'));
      ELSE v_type := coalesce(v_type, CASE fd.data_type::text WHEN 'number' THEN 'number' WHEN 'date' THEN 'date' WHEN 'bool' THEN 'yes_no' ELSE 'text' END);
      END IF;
    END IF;
  END IF;
  IF v_type = 'list' AND v_list IS NULL THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'list_required', 'A list column needs a dropdown list.'));
  ELSIF v_type IS NOT NULL AND v_type <> 'list' AND v_list IS NOT NULL THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'list_not_allowed', 'Only a list column takes a dropdown list.'));
  ELSIF v_list IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.list_catalogues WHERE code = v_list AND is_active) THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'unknown_list', 'No active list has this code.'));
  END IF;

  IF b ? 'sections' THEN
    IF jsonb_typeof(b -> 'sections') <> 'array' THEN secs := ARRAY[]::text[];
    ELSE SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO secs FROM jsonb_array_elements_text(b -> 'sections') x;
    END IF;
  ELSIF anchor.ord IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO secs FROM unnest(anchor.site360_sections) x WHERE x <> 'status';
  ELSE secs := ARRAY[]::text[];
  END IF;
  IF cardinality(secs) = 0 OR NOT secs <@ ARRAY['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om']::text[] THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/sections', 'invalid', 'Choose one or more of the seven menus.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  -- conflicts: the source already feeds a column, the header exists, no room left
  IF skind = 'task_input' AND found_input AND tf.master_col IS NOT NULL THEN
    PERFORM public.wf_err('input_already_mapped', jsonb_build_object('detail', 'This task input already fills the Master column ' || tf.master_col || '.'));
  END IF;
  IF skind = 'site_field' AND (fd.master_export_column IS NOT NULL OR EXISTS (SELECT 1 FROM public.master_columns WHERE source_field_id = fd.id)) THEN
    PERFORM public.wf_err('field_already_mapped', jsonb_build_object('detail', 'This site field already fills a Master column.'));
  END IF;
  SELECT greatest(coalesce(max(ord), 187), 187) + 1 INTO new_ord FROM public.master_columns;
  IF new_ord > 1000 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(public.site360_col_err('/after_ord', 'too_many_columns', 'No more columns can be added.')))); END IF;
  new_letter := public.site360_col_letter(new_ord);
  hdr := public.site360_col_header(v_mid, v_name);
  IF EXISTS (SELECT 1 FROM public.master_columns WHERE header = hdr) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A Master column has this header already.'));
  END IF;
  IF skind = 'task_input' AND NOT found_input THEN
    n := 1;
    WHILE EXISTS (SELECT 1 FROM public.template_task_fields WHERE task_code = tcode AND field_key = fkey) LOOP
      n := n + 1;
      fkey := left(fkey, 58) || '_' || n::text;
    END LOOP;
  END IF;

  owner_v := CASE WHEN skind = 'task_input' THEN 'task' ELSE 'added' END;
  src_note := CASE WHEN skind = 'task_input' THEN 'Added in the Workflow Studio: input ' || fkey || ' of task ' || tcode || '.'
                   ELSE 'Added in the Workflow Studio: the site field ' || fd.code || '.' END;
  UPDATE public.master_columns SET display_order = display_order + 1 WHERE display_order > anchor.display_order;
  INSERT INTO public.master_columns (ord, letter, group_top, group_mid, name, name_ar, header, owner, is_active, display_order, value_type, list_catalogue, source_field_id,
                                      source_input_created, is_added, is_protected, source_kind, source_note, site360_sections, version)
  VALUES (new_ord, new_letter, v_top, v_mid, v_name, v_name_ar, hdr, owner_v, true, anchor.display_order + 1, v_type, v_list, CASE WHEN skind = 'site_field' THEN fd.id END,
          skind = 'task_input' AND NOT found_input, true, false, CASE WHEN skind = 'task_input' THEN 'task' ELSE 'custom_field' END, src_note, secs, 1);
  IF skind = 'task_input' THEN
    IF found_input THEN
      UPDATE public.template_task_fields SET master_col = new_letter WHERE id = tf.id;
    ELSE
      INSERT INTO public.template_task_fields (task_code, field_key, label, label_ar, field_type, list_catalogue, master_col, read_only, is_active)
      VALUES (tcode, fkey, v_name, v_name_ar, v_type, v_list, new_letter, fkey IN ('submitted_date', 'approved_date', 'external_party'), true);
    END IF;
  END IF;
  PERFORM public.log_audit_write('site360.column_created', 'master_column', new_letter, NULL::jsonb, public.site360_col_json(new_ord), btrim(p_reason), NULL, NULL, NULL, false);
  RETURN public.site360_col_detail(new_ord);
END $$;

-- Change a column. p_patch: name_en, name_ar, group_top, group_mid, after_ord, value_type, list_catalogue. p_version is the ETag (NULL = any).
CREATE OR REPLACE FUNCTION site360_column_update(p_ord integer, p_version integer, p_patch jsonb, p_confirm boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  col public.master_columns%ROWTYPE; b jsonb := CASE WHEN jsonb_typeof(p_patch) = 'object' THEN p_patch ELSE '{}'::jsonb END; k text; errs jsonb := '[]'::jsonb; before_ jsonb;
  e record; n_name text; n_name_ar text; n_top text; n_mid text; n_type text; n_list text; n_hdr text; anchor public.master_columns%ROWTYPE; prev_ord integer;
  type_changed boolean; layout_changed boolean; moved boolean := false; changed boolean; conv jsonb; new_disp integer;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('site360_master_columns'));
  SELECT * INTO col FROM public.master_columns WHERE ord = p_ord FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF p_version IS NOT NULL AND p_version <> col.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it. Reload and try again.'));
  END IF;
  FOR k IN SELECT jsonb_object_keys(b) LOOP
    IF k NOT IN ('name_en', 'name_ar', 'group_top', 'group_mid', 'after_ord', 'value_type', 'list_catalogue') THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/' || k, 'unknown_field', 'This key cannot be set.'));
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF col.is_protected AND EXISTS (SELECT 1 FROM jsonb_object_keys(b) x WHERE x NOT IN ('name_en', 'name_ar')) THEN
    PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'This column is protected: only its name and its menus can change.', 'reason', col.protected_reason));
  END IF;
  IF NOT col.is_added AND (b ? 'group_top' OR b ? 'group_mid' OR b ? 'after_ord') THEN
    PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'An original column keeps its letter, order, band, group and place.', 'reason', 'original_column'));
  END IF;

  n_name := CASE WHEN b ? 'name_en' THEN btrim(coalesce(b ->> 'name_en', '')) ELSE col.name END;
  IF b ? 'name_en' AND char_length(n_name) NOT BETWEEN 1 AND 120 THEN errs := errs || jsonb_build_array(public.site360_col_err('/name_en', 'required', 'A name of 1 to 120 characters.')); END IF;
  n_name_ar := CASE WHEN b ? 'name_ar' THEN nullif(btrim(coalesce(b ->> 'name_ar', '')), '') ELSE col.name_ar END;
  IF char_length(coalesce(n_name_ar, '')) > 120 THEN errs := errs || jsonb_build_array(public.site360_col_err('/name_ar', 'invalid', 'Up to 120 characters.')); END IF;
  n_top := CASE WHEN b ? 'group_top' THEN btrim(coalesce(b ->> 'group_top', '')) ELSE col.group_top END;
  IF b ? 'group_top' AND char_length(n_top) NOT BETWEEN 1 AND 80 THEN errs := errs || jsonb_build_array(public.site360_col_err('/group_top', 'required', 'A band of 1 to 80 characters.')); END IF;
  n_mid := CASE WHEN b ? 'group_mid' THEN nullif(btrim(coalesce(b ->> 'group_mid', '')), '') ELSE col.group_mid END;
  IF char_length(coalesce(n_mid, '')) > 80 THEN errs := errs || jsonb_build_array(public.site360_col_err('/group_mid', 'invalid', 'Up to 80 characters.')); END IF;

  SELECT * INTO e FROM public.site360_col_effective(p_ord);
  n_type := CASE WHEN b ? 'value_type' THEN nullif(btrim(coalesce(b ->> 'value_type', '')), '') ELSE e.value_type END;
  IF n_type IS NULL OR n_type NOT IN ('text', 'number', 'date', 'list', 'yes_no') THEN errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'invalid', 'One of text, number, date, list, yes_no.')); END IF;
  n_list := CASE WHEN b ? 'list_catalogue' THEN nullif(btrim(coalesce(b ->> 'list_catalogue', '')), '') WHEN n_type = 'list' THEN e.list_catalogue ELSE NULL END;
  IF n_type = 'list' AND n_list IS NULL THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'list_required', 'A list column needs a dropdown list.'));
  ELSIF n_type IS NOT NULL AND n_type <> 'list' AND n_list IS NOT NULL THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'list_not_allowed', 'Only a list column takes a dropdown list.'));
  ELSIF n_list IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.list_catalogues WHERE code = n_list AND is_active) THEN errs := errs || jsonb_build_array(public.site360_col_err('/list_catalogue', 'unknown_list', 'No active list has this code.'));
  END IF;
  type_changed := n_type IS DISTINCT FROM e.value_type OR n_list IS DISTINCT FROM e.list_catalogue;
  IF type_changed AND e.locked_inputs > 0 THEN
    errs := errs || jsonb_build_array(public.site360_col_err('/value_type', 'type_follows_source', 'A date or workflow field of a task keeps its type.'));
  END IF;

  layout_changed := (b ? 'group_top' AND n_top IS DISTINCT FROM col.group_top) OR (b ? 'group_mid' AND n_mid IS DISTINCT FROM col.group_mid);
  IF b ? 'after_ord' THEN
    IF coalesce(b ->> 'after_ord', '') !~ '^[0-9]{1,4}$' THEN errs := errs || jsonb_build_array(public.site360_col_err('/after_ord', 'invalid', 'The order of the column it sits after.'));
    ELSE
      SELECT * INTO anchor FROM public.master_columns WHERE ord = (b ->> 'after_ord')::integer;
      IF anchor.ord IS NULL THEN errs := errs || jsonb_build_array(public.site360_col_err('/after_ord', 'unknown_column', 'No Master column has this order.'));
      ELSIF anchor.ord = p_ord THEN errs := errs || jsonb_build_array(public.site360_col_err('/after_ord', 'invalid', 'A column cannot sit after itself.'));
      ELSE
        SELECT x.ord INTO prev_ord FROM public.master_columns x WHERE x.display_order < col.display_order ORDER BY x.display_order DESC LIMIT 1;
        moved := anchor.ord IS DISTINCT FROM prev_ord;
      END IF;
    END IF;
  END IF;
  IF jsonb_array_length(errs) = 0 AND (moved OR layout_changed) THEN
    IF lower(coalesce(n_top, '')) IN ('#', 'phase gate', 'status') THEN
      errs := errs || jsonb_build_array(public.site360_col_err('/group_top', 'reserved_band', 'The bands #, Phase Gate and STATUS belong to the system.'));
    ELSE
      errs := errs || public.site360_col_place_errors(n_top, n_mid, CASE WHEN moved THEN anchor.display_order ELSE col.display_order END, p_ord);
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  n_hdr := CASE WHEN n_name IS DISTINCT FROM col.name OR n_mid IS DISTINCT FROM col.group_mid THEN
                  CASE WHEN col.header IS NOT DISTINCT FROM public.site360_col_header(col.group_mid, col.name) THEN public.site360_col_header(n_mid, n_name) ELSE coalesce(n_name, col.header) END
                ELSE col.header END;
  IF n_hdr IS DISTINCT FROM col.header AND EXISTS (SELECT 1 FROM public.master_columns WHERE header = n_hdr AND ord <> p_ord) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A Master column has this header already.'));
  END IF;
  changed := n_name IS DISTINCT FROM col.name OR n_name_ar IS DISTINCT FROM col.name_ar OR n_top IS DISTINCT FROM col.group_top OR n_mid IS DISTINCT FROM col.group_mid OR moved OR type_changed;
  IF NOT changed THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.')); END IF;
  IF type_changed THEN
    conv := public.site360_col_conversion(p_ord, n_type, n_list);
    IF (conv ->> 'not_convertible')::integer > 0 AND NOT coalesce(p_confirm, false) THEN
      PERFORM public.wf_err('conversion_unconfirmed', jsonb_build_object('detail', 'Some values do not fit the new type or list. They stay as they are; confirm to continue.', 'conversion', conv));
    END IF;
  END IF;

  before_ := public.site360_col_json(p_ord);
  IF moved THEN
    new_disp := anchor.display_order + 1;
    UPDATE public.master_columns SET display_order = display_order + 1 WHERE display_order > anchor.display_order AND ord <> p_ord;
  ELSE
    new_disp := col.display_order;
  END IF;
  UPDATE public.master_columns SET name = n_name, name_ar = n_name_ar, group_top = n_top, group_mid = n_mid, header = n_hdr, display_order = new_disp,
         value_type = CASE WHEN type_changed THEN n_type ELSE value_type END, list_catalogue = CASE WHEN type_changed THEN n_list ELSE list_catalogue END,
         version = version + 1
   WHERE ord = p_ord;
  IF type_changed THEN
    UPDATE public.template_task_fields SET field_type = n_type, list_catalogue = n_list, options = NULL WHERE master_col = col.letter AND is_active;
  END IF;
  PERFORM public.log_audit_write('site360.column_updated', 'master_column', col.letter, before_, public.site360_col_json(p_ord), btrim(p_reason), NULL, NULL, NULL, false);
  RETURN public.site360_col_detail(p_ord);
END $$;

-- Deactivate or reactivate: the column leaves or returns to the menus, the grid and the export; nothing else changes.
CREATE OR REPLACE FUNCTION site360_column_set_active(p_ord integer, p_version integer, p_active boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE col public.master_columns%ROWTYPE; before_ jsonb;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('site360_master_columns'));
  SELECT * INTO col FROM public.master_columns WHERE ord = p_ord FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF p_version IS NOT NULL AND p_version <> col.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it. Reload and try again.'));
  END IF;
  IF col.is_protected THEN
    PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'This column is protected: it cannot be deactivated.', 'reason', col.protected_reason));
  END IF;
  IF col.is_active = coalesce(p_active, false) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN col.is_active THEN 'The column is active already.' ELSE 'The column is inactive already.' END));
  END IF;
  before_ := public.site360_col_json(p_ord);
  UPDATE public.master_columns SET is_active = p_active, version = version + 1 WHERE ord = p_ord;
  PERFORM public.log_audit_write(CASE WHEN p_active THEN 'site360.column_reactivated' ELSE 'site360.column_deactivated' END, 'master_column', col.letter,
    before_, public.site360_col_json(p_ord), btrim(p_reason), NULL, NULL, NULL, false);
  RETURN public.site360_col_detail(p_ord);
END $$;

-- Hard delete of an added column that never held a value; the task input it created goes with it, an input it only linked is released.
CREATE OR REPLACE FUNCTION site360_column_delete(p_ord integer, p_version integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE col public.master_columns%ROWTYPE; before_ jsonb; vc integer; removed boolean := false;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM pg_advisory_xact_lock(hashtext('site360_master_columns'));
  SELECT * INTO col FROM public.master_columns WHERE ord = p_ord FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF p_version IS NOT NULL AND p_version <> col.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it. Reload and try again.'));
  END IF;
  IF NOT col.is_added THEN
    PERFORM public.wf_err('system_field', jsonb_build_object('detail', 'An original column is never deleted.', 'reason', 'original_column'));
  END IF;
  SELECT count(DISTINCT v.site_id)::int INTO vc FROM public.site360_col_values(p_ord) v;
  IF vc > 0 OR public.site360_col_other_source(p_ord) THEN
    PERFORM public.wf_err('column_in_use', jsonb_build_object('detail', 'The column holds values: deactivate it instead.', 'why', CASE WHEN vc > 0 THEN 'has_values' ELSE 'other_source' END, 'count', vc));
  END IF;
  before_ := public.site360_col_json(p_ord);
  IF col.source_input_created THEN
    DELETE FROM public.template_task_fields WHERE master_col = col.letter;
    removed := FOUND;
  ELSE
    UPDATE public.template_task_fields SET master_col = NULL WHERE master_col = col.letter;
  END IF;
  DELETE FROM public.master_columns WHERE ord = p_ord;
  PERFORM public.log_audit_write('site360.column_deleted', 'master_column', col.letter, before_, NULL::jsonb, btrim(p_reason), NULL, NULL, NULL, false);
  RETURN jsonb_build_object('ord', col.ord, 'letter', col.letter, 'deleted', true, 'removed_input', removed);
END $$;

-- The menus of a column (0101), now also bumping the version of the column; any column order.
CREATE OR REPLACE FUNCTION site360_set_sections(p_ord integer, p_sections text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid; rs text := btrim(coalesce(p_reason, '')); before_j jsonb; col record; sec text[]; errs jsonb := '[]'::jsonb;
BEGIN
  a := public.app_actor();
  IF a IS NULL OR NOT public.app_has_permission(a, 'admin.settings', 'edit') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a user who may edit the settings can change the SITE 360 menus of a column.'));
  END IF;
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.'));
  END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO sec FROM unnest(coalesce(p_sections, '{}'::text[])) AS x;
  IF cardinality(sec) = 0 OR NOT sec <@ ARRAY['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om']::text[] THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/sections', 'code', 'invalid', 'message', 'Choose one or more of the seven menus. The status columns are in every menu and cannot be changed.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT * INTO col FROM public.master_columns WHERE ord = p_ord;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF 'status' = ANY (col.site360_sections) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/sections', 'code', 'invalid', 'message', 'The status columns are in every menu and cannot be changed.'))));
  END IF;
  before_j := jsonb_build_object('ord', col.ord, 'letter', col.letter, 'sections', to_jsonb(col.site360_sections));
  UPDATE public.master_columns SET site360_sections = sec, version = version + 1 WHERE ord = p_ord;
  PERFORM public.log_audit_write('site360.column_sections_changed', 'master_column', col.letter, before_j,
    jsonb_build_object('ord', col.ord, 'letter', col.letter, 'sections', to_jsonb(sec)), rs, NULL, NULL, NULL, false);
  RETURN jsonb_build_object('ord', col.ord, 'letter', col.letter, 'sections', to_jsonb(sec));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'site360_col_letter(integer)', 'site360_col_header(text, text)', 'site360_col_slug(text)', 'site360_col_err(text, text, text)',
    'site360_value_misfit(text, text, text)', 'site360_col_effective(integer)', 'site360_col_json(integer)', 'site360_col_values(integer)',
    'site360_col_other_source(integer)', 'site360_col_detail(integer)', 'site360_col_conversion(integer, text, text)',
    'site360_col_place_errors(text, text, integer, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'site360_col_can_admin()', 'site360_columns_list(boolean)', 'site360_column_get(integer)', 'site360_column_type_preview(integer, text, text)',
    'site360_column_create(jsonb, text)', 'site360_column_update(integer, integer, jsonb, boolean, text)', 'site360_column_set_active(integer, integer, boolean, text)',
    'site360_column_delete(integer, integer, text)', 'site360_set_sections(integer, text[], text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
END $$;
