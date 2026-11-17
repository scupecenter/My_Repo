-- 0121_master_sources: P1 Master of the read-only audit of 2026-11-17 (audit A, findings A3, A7, F-A01, F-A02, F-A06; CHANGELOG 160; contract 0.15.35).
-- Mirror: db/sql/120_master_sources.sql (kept byte-identical). Number 0120 is reserved for the export work in flight.
--
-- 1. master_columns.source_kind and source_note: the kind of source of each of the 187 Master columns (site field, task, milestone, register
--    record, baseline, derived formula, custom field, or not tracked) and a short English note of the rule. Seed data; the API reads it for the grid
--    header and for the source of a cell. A column that has no source anywhere in the system is `not_tracked`, so the grid shows a visible marker
--    instead of an empty cell that looks like missing data. A not-tracked column becomes `custom_field` when an admin adds a site custom field that
--    carries its Master export column (the projection below reads it).
-- 2. site360_task_cells: the task cells of the Master (a task field mapped to a Master column, latest 0119 task branch) as a security-invoker view, so
--    the task branch and the derived columns read one definition of the task value.
-- 3. site360_master_values (latest 0119, redefined in full; changes marked 0121):
--    a. four columns appended, the source of each value from the same branch that computes it (no second copy of the column logic):
--       src_kind  site | task | milestone | register | baseline | derived | custom_field,
--       src_ref   the table of src_id: task (task_instances), register (register_records), baseline (baseline_versions), custom_field
--                 (field_definitions), or NULL,
--       src_id    the id of the source row (the task instance, the register record version, the baseline version, the field), NULL for a count or
--                 a formula over several rows,
--       src_field the field read (a site column, a task field, a register data key, a milestone code).
--       Unused by the rows page (it selects the old five columns only; the planner drops the unused outputs), read by the per-site source door
--       GET /site360/sites/{site_id}/sources.
--    b. sources for the 34 columns that were always blank (audit A section 7; R was fixed in 0119), each from the workbook formula of its column
--       (GSDN_Site_Master.xlsx, Master row 5), read for structure only:
--       U, AV, BO, BY, CT, DO, EK, ER, EX, FL  Baseline of each milestone: MAXIFS(tblBaselineApproved[<milestone>], site, Current = Yes); here the
--             baseline_date of the latest approved baseline version of the site and milestone (the rule of the site page, sites.service), the
--             baseline column being the Master column just before the milestone column of the stage (V, AW, BP, BZ, CU, DP, EL, ES, EY, FM).
--       AR, AS  CW Survey & Analysis Report Submitted / Approved Date (input columns in the workbook; the SLA sheet B-5 ends at "Report Submitted
--             (Master AR)"): the submitted and approved dates of task B5 (STA / ST analysis report). A template mapping of these columns wins.
--       CB    TE Access Date: MINIFS(Permits Valid From, site, type "Access - TE", status Approved), as AL for "Access - CW".
--       CE    Vendor Team: the team of the first order of scope "TE Installation" that is neither cancelled nor rejected (Master!CE5), as AJ / AK.
--       CZ    RSL Deviation (dB): CY (MW Measured RSL, task D8) minus the RSL of the site's approved As-Built TE part; empty when either is not a
--             number or the As-Built RSL is 0 (Master!CZ5).
--       DG    Outage Duration (wd): from DD / DE (cutover window, task D10): "Date Error" when the end is before the start, 0 on the same day, else
--             the working days after the start up to the end (NETWORKDAYS.INTL(start + 1, end, Fri-Sat, Holidays) = cal_workdays_between).
--       DH    Legacy Dismantle Due: Cold Swap sites only, the On-Air date (DP) plus the maximum working days of the SLA rule S-5 (Legacy Dismantle,
--             WORKDAY.INTL(DP, SLA_Max_S5)).
--       DI    Rollback Count: the approved (or applied) Change Control records of type "Cutover Rollback" of the site (COUNTIFS; 0 when none).
--       EN    Cluster ID: = G (the site's cluster code).
--       EQ    KPI Source Validation: "Missing Cluster ID" without a cluster; else the number of active sites of the cluster with a KPI Acceptance
--             Source Date (EP, task F2): 0 "No Source", more than 1 "Multiple Sources", else "Valid". Counted over the sites the caller may see.
--       EW    HOTO Package Date: the HOTO Package Valid Date of Readiness & Handover = the later of the HOTO Package Actual Date and the Site Access &
--             Keys Handover Date when both are valid dates, from the approved record of the site.
--       FK    Contractual Obligations Closure Date: obligations_closure_date of the approved Readiness & Handover record.
--       FA, FB  CW DLP Start = CW PAC Actual (BV) when valid; End = Start + CWDLPDays (setting sla.dlp_days.cw, default 90, as 0018).
--       FF, FG  TE DLP Start = TE PAC (EL) when valid; End = EDATE(Start, TEDLPMonths) (setting dlp.months.te, default 12, as 0052).
--       FN, FS  Site CW / TE RFD: rfd_date of the current Dismantle part (cw / te), the same record as FO / FT.
--       FQ, FV  CW / TE Actual Date: work_end_date of the current Dismantle part (the end of the dismantling work).
--       FP, FU, FR, FW  Planned Date and RN Date of the Dismantle parts: no source in the system (the register has no planned date and the RN is a
--             reference, not a date: owner questions Q99 / Q101 / U4). Not tracked; an admin may add a site custom field carrying the column.
--    c. a site custom field (field_definitions, entity site) carrying the Master export column of a not-tracked column fills it (kind custom_field).
--    No column moves between menus (U1 to U6 wait for the owner). No personal column is in the 187 Master columns (Q469 personal data stays out).
-- 4. site360_date(text): a date read from a text, NULL when the text is not a date (a bad value never breaks the projection). Invoker, immutable.
-- Rights: the views are security_invoker (row security of every table applies to the caller), SELECT to pmis_app. site360_date has owner
-- pmis_definer, EXECUTE revoked from PUBLIC and granted to pmis_app. master_columns stays read-only for pmis_app (app_grants.sql, 0049).
-- No SECURITY DEFINER function is added: the source of a value is read with the caller's own rights, so a record the caller may not read never
-- yields its id.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The kind of source of each Master column
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE master_columns ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE master_columns ADD COLUMN IF NOT EXISTS source_note text;

UPDATE master_columns mc SET source_kind = CASE
    WHEN mc.ord IN (22, 49, 68, 78, 99, 120, 142, 149, 155, 169) THEN 'milestone'                 -- the milestone columns (stage master_export_column)
    WHEN mc.ord IN (23, 50, 69, 79, 100, 121, 143, 150, 156) THEN 'milestone'                     -- gate readiness: the date of the milestone before the gate
    WHEN mc.ord IN (21, 48, 67, 77, 98, 119, 141, 148, 154, 168) THEN 'baseline'
    WHEN mc.ord IN (172, 174, 177, 179) THEN 'not_tracked'
    WHEN mc.ord IN (1, 34, 35, 75, 76, 104, 111, 112, 113, 144, 147, 157, 158, 162, 163) THEN 'derived'
    WHEN mc.ord IN (18, 36, 37, 38, 80, 83, 153, 167, 170, 173, 175, 178, 183, 184, 185, 186, 187) THEN 'register'
    WHEN EXISTS (SELECT 1 FROM task_field_sources x WHERE x.master_col = mc.letter) THEN 'register'
    WHEN mc.ord BETWEEN 2 AND 33 OR mc.ord IN (180, 181, 182) THEN 'site'
    WHEN mc.owner = 'task' THEN 'task'
  END;

UPDATE master_columns mc SET source_note = n.note
FROM (VALUES
  (1, 'Running number of the row in view.'),
  (18, 'As-Built: Configuration (WL/MW/IP/PWR) of the approved TE part (0119).'),
  (21, 'Baseline of MS1 Site Release: latest approved baseline version of the site.'),
  (23, 'Gate readiness: the date of the milestone before the gate, once approved.'),
  (34, 'Workbook formula over the CW scope flags and the procurement orders (PR dates).'),
  (35, 'Workbook formula over the CW scope flags and the procurement orders (PO / WO dates).'),
  (36, 'First order of scope CW, Tower Erection or Site Adaption, neither cancelled nor rejected: contractor.'),
  (37, 'First order of scope CW, Tower Erection or Site Adaption, neither cancelled nor rejected: team.'),
  (38, 'Earliest approved permit "Access - CW": Valid From.'),
  (44, 'Task B5 (STA / ST analysis report): submitted date.'),
  (45, 'Task B5 (STA / ST analysis report): approved date.'),
  (48, 'Baseline of MS2 PRE-CW Completion: latest approved baseline version of the site.'),
  (67, 'Baseline of MS3 CW Completion: latest approved baseline version of the site.'),
  (75, 'N/A when the GECOL scope is N/A; Done when the scope is Yes and the Power-On Date is set; else Pending.'),
  (76, 'N/A when the HLC scope is N/A; Done when the scope is Yes and the Installation Date is set; else Pending.'),
  (77, 'Baseline of MS4 Site RFI: latest approved baseline version of the site.'),
  (80, 'Earliest approved permit "Access - TE": Valid From.'),
  (83, 'First order of scope TE Installation, neither cancelled nor rejected: team.'),
  (98, 'Baseline of MS5 TE Completion: latest approved baseline version of the site.'),
  (104, 'CY (MW Measured RSL) minus the RSL of the approved As-Built TE part; empty when the As-Built RSL is 0.'),
  (111, 'Working days from Window Start (DD) to Window End (DE); Date Error when the end is earlier.'),
  (112, 'Cold Swap only: On-Air date (DP) plus the maximum working days of SLA rule S-5 (Legacy Dismantle).'),
  (113, 'Approved Change Control records of type Cutover Rollback of the site.'),
  (119, 'Baseline of MS6 On-Air: latest approved baseline version of the site.'),
  (141, 'Baseline of MS7 TE PAC: latest approved baseline version of the site.'),
  (144, 'Cluster ID of the site (= G).'),
  (147, 'Missing Cluster ID, No Source, Multiple Sources or Valid: sites of the cluster with a KPI Acceptance Source Date (EP).'),
  (148, 'Baseline of MS8 KPI Acceptance: latest approved baseline version of the site.'),
  (153, 'Readiness & Handover: the later of HOTO Package Actual Date and Site Access & Keys Handover Date, when both are set.'),
  (154, 'Baseline of MS9 HOTO: latest approved baseline version of the site.'),
  (157, 'CW PAC Actual Date (BV).'),
  (158, 'CW DLP Start (FA) plus the CW DLP days (setting sla.dlp_days.cw, default 90).'),
  (162, 'TE PAC Date (EL).'),
  (163, 'TE DLP Start (FF) plus the TE DLP months (setting dlp.months.te, default 12).'),
  (167, 'Readiness & Handover: Obligations Closure Date of the approved record.'),
  (168, 'Baseline of MS10 Final Closure: latest approved baseline version of the site.'),
  (170, 'Dismantle CW part: RFD Date.'),
  (172, 'Not tracked: the Dismantle register has no planned date (owner question U4).'),
  (173, 'Dismantle CW part: Work End Date.'),
  (174, 'Not tracked: the RN is a reference, not a date, until the Warehouse RN link exists (Q101, U4).'),
  (175, 'Dismantle TE part: RFD Date.'),
  (177, 'Not tracked: the Dismantle register has no planned date (owner question U4).'),
  (178, 'Dismantle TE part: Work End Date.'),
  (179, 'Not tracked: the RN is a reference, not a date, until the Warehouse RN link exists (Q101, U4).'),
  (180, 'Stored derived status of the site (calculation layer).'),
  (181, 'Stored derived status of the site (calculation layer).'),
  (182, 'Stored derived status of the site (calculation layer).')
) AS n(ord, note)
WHERE mc.ord = n.ord;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM master_columns WHERE source_kind IS NULL) THEN
    RAISE EXCEPTION 'master column without a source kind: %', (SELECT string_agg(letter, ', ' ORDER BY ord) FROM master_columns WHERE source_kind IS NULL);
  END IF;
END $$;

ALTER TABLE master_columns ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_source_kind_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_source_kind_chk
  CHECK (source_kind IN ('site', 'task', 'milestone', 'register', 'baseline', 'derived', 'custom_field', 'not_tracked'));
COMMENT ON COLUMN master_columns.source_kind IS 'The kind of source of the column (0121): site, task, milestone, register, baseline, derived, custom_field or not_tracked (no source in the system).';
COMMENT ON COLUMN master_columns.source_note IS 'A short English note of the rule of the column (0121), shown with the source of a cell.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. A date from a text (NULL when it is not one)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site360_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p !~ '^\s*\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN substr(btrim(p), 1, 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;
COMMENT ON FUNCTION site360_date(text) IS 'A date read from the first 10 characters of a text (YYYY-MM-DD, a date-time allowed), NULL otherwise (0121).';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The task cells of the Master (the task branch of 0119, before its aggregation)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW site360_task_cells WITH (security_invoker = true) AS
SELECT s.id AS site_id, mc.ord, mc.letter, tf.projection, tf.field_key, td.code AS task_code, td.is_milestone_task, ti.id AS task_id,
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
WHERE s.is_active;

COMMENT ON VIEW site360_task_cells IS 'The task cells of the Master (0121): each active site, Master column and task instance mapped to it by the stream template fields, with the value.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The SITE 360 view (latest 0119), with the source of each value
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
;

COMMENT ON VIEW site360_master_values IS 'The Master values of each site and column with the source of each value (0104, F15, extended 0106 to 0112, 0119, 0121): the set-based read model of the SITE 360 grid rows and of the per-site sources.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION site360_date(text) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION site360_date(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION site360_date(text) TO pmis_app;
    GRANT SELECT ON site360_master_values, site360_task_cells TO pmis_app;
  END IF;
END $$;
