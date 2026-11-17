-- 0119_p0_value_fixes: the P0 "wrong values" fixes of the read-only audit of 2026-11-17 (audit reports A, B, C and E; CHANGELOG 158).
-- Mirror: db/sql/118_p0_value_fixes.sql (kept byte-identical).
--
-- 1. SITE 360 view site360_master_values (latest definition 0112, redefined in full; changes marked 0119):
--    a. BW GECOL Status (ord 75) read gecol_records.status, which nothing writes (no register field, reg_apply of 0042 never sets it), so it was
--       empty for every approved GECOL record (audit B section 4, A section 6). It is now the workbook formula (Master!BW5 over GECOL!R): N/A when the
--       GECOL scope (AC) is N/A; with the approved GECOL record of the site, Done when AC is Yes and the Power-On Date is inside the valid window,
--       else Pending; without a record, Pending when AC is Yes; empty otherwise. The same shape as BX (HLC Fiber, 0111); GECOL Power stays its own
--       register and column, apart from HLC Fiber.
--    b. AJ Contractor Name / AK Contractor Team (ords 36, 37) took the first order of scope CW only and did not leave out rejected orders (audit A
--       section 6, 0112:97). The workbook (Master!AJ5 / AK5) takes the first order of the site whose scope is none of GECOL, TE Installation,
--       CW Dismantle, TE Dismantle, STA and ST and whose status is neither Cancelled nor Rejected. Over the workbook's scope list (tblProcScope)
--       that is CW, Tower Erection and Site Adaption, the list used here (the scopes the system added later, HLC and the field-work scopes, are no
--       CW contractor order and stay out). Cancelled (proc_order_cancelled) and rejected (a status that starts with "reject") orders and a record
--       whose register version was voided are left out.
--    c. R Configuration (WL/MW/IP/PWR) (ord 18) read sites.config_summary, which nothing writes (audit A section 7). The workbook reads it from
--       As-Built (Master!R5 = tblAsBuilt[Configuration (WL/MW/IP/PWR)]); it is now the field `configuration` of the site's approved As-Built TE
--       part in force. Empty when there is none (no value is invented).
-- 2. Dashboard drill-downs (audit E section 2): dash_drill_sites returns the set of sites a dashboard card counts, with the dashboard's own engine
--    (dash_build_facts / dash_build_facts_snap, the stream and view rules of dash_core, the caller's dashboard.view regions, the ref_date and its
--    snapshot exactly as dash_overview): `p_status` = the sites of a derived overall status (headline.by_overall_status), `p_milestone` = the sites
--    (not cancelled) whose milestone is done on the reference date (milestones[].completed: the RFI, On-Air, HOTO and Final Closure cards). GET /sites
--    reads it through the new filters dashboard_status, milestone_reached and ref_date (contract 0.15.33), so a card count equals its list count.
-- 3. Car Dispatcher (audit C, X4 / D2): when a vehicle record version is voided and the vehicle then has no approved version in force, its future
--    reservations (those that start after today, cal_today) are cancelled in the same transaction (state `cancelled`, a new value of the check),
--    with one audit row (vehicle_reservations_cancel) listing them; reservations that started already stay as they are. An approved version cannot
--    be voided (reg_void_record, 0103), so voiding a draft new version of a vehicle in force cancels nothing. fa_after is redefined from 0093.
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. pmis_app gets
-- dash_drill_sites (read only; it raises like dash_overview for a caller without dashboard.view). fa_after keeps its owner and rights (no grant).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The SITE 360 view (latest 0112)
-- ---------------------------------------------------------------------------------------------------------------------
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
    (14, s.existing_or_new), (15, s.rt_or_gf), (16, s.tower_type), (17, s.tower_height_m::text),
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
-- calc columns held by the procurement register (AJ, AK; changed 0119): the first order of the site whose scope is a CW contractor scope of the
-- workbook (Master!AJ5 / AK5: every scope except GECOL, TE Installation, CW Dismantle, TE Dismantle, STA and ST, i.e. CW, Tower Erection and
-- Site Adaption) and whose order is neither cancelled nor rejected; a record whose register version was voided does not count either
SELECT f.site_id, v.ord, v.value, 'register'::text AS kind, 'procurement'::text AS register_key
FROM (
  SELECT DISTINCT ON (pr.site_id) pr.site_id, pr.party_id, pr.team_id
  FROM procurement_records pr
  WHERE pr.scope IN ('CW', 'Tower Erection', 'Site Adaption')
    AND NOT coalesce(proc_order_cancelled(pr.order_status), false)
    AND coalesce(pr.order_status, '') !~* '^\s*reject'
    AND NOT EXISTS (SELECT 1 FROM register_records rr WHERE rr.id = pr.register_record_id AND (rr.state = 'voided' OR rr.voided_at IS NOT NULL))
  ORDER BY pr.site_id, coalesce(pr.po_wo_date, pr.pr_date) NULLS LAST, pr.id
) f
JOIN sites s ON s.id = f.site_id AND s.is_active
CROSS JOIN LATERAL (VALUES (36, site360_party_name(f.party_id)), (37, site360_team_name(f.team_id))) AS v(ord, value)
UNION ALL
-- BW GECOL Status (changed 0119): the workbook formula (Master!BW5 over GECOL!R, tblPower[Status]) from the GECOL scope AC and the approved GECOL
-- record of the site (gecol_records, written by reg_apply on the final approval): N/A when AC is N/A; with a record, Done when AC is Yes and the
-- Power-On Date (Meter Charging) is inside the valid window, else Pending; without a record, Pending when AC is Yes. The column
-- gecol_records.status is not read any more: nothing writes it. GECOL Power stays apart from HLC Fiber (BX).
SELECT s.id, 75,
  CASE
    WHEN s.scope_gecol_power::text = 'na' THEN 'N/A'
    WHEN g.site_id IS NOT NULL THEN
      CASE WHEN s.scope_gecol_power::text = 'yes' AND g.power_on_date BETWEEN DATE '2020-01-01' AND DATE '2035-12-31' THEN 'Done' ELSE 'Pending' END
    WHEN s.scope_gecol_power::text = 'yes' THEN 'Pending'
  END,
  'register'::text, 'gecol'::text
FROM sites s
LEFT JOIN gecol_records g ON g.site_id = s.id
WHERE s.is_active
  AND (s.scope_gecol_power::text IN ('na', 'yes') OR g.site_id IS NOT NULL)
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
  AND (s.scope_hlc_fiber::text IN ('na', 'yes') OR h.site_id IS NOT NULL)

UNION ALL
-- AH PR Status and AI PO / WO Status (owner decision 2026-11-15, decision 1): the Master formulas
SELECT x.site_id, v.ord, v.value, 'register'::text AS kind, 'procurement'::text AS register_key
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
SELECT s.id AS site_id, mc.ord, to_char(coalesce(ti.actual_date, ti.approved_date), 'YYYY-MM-DD') AS value, 'task'::text AS kind, NULL::text AS register_key
FROM sites s
JOIN phase_gate_rules g ON g.workflow_id = s.workflow_version_id AND g.is_active AND g.master_export_column IS NOT NULL
JOIN master_columns mc ON mc.letter = g.master_export_column
JOIN stage_definitions sd ON sd.workflow_id = g.workflow_id AND sd.code = g.from_code AND sd.is_active
JOIN task_definitions td ON td.stage_id = sd.id AND td.is_milestone_task
JOIN task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id AND ti.state = 'approved'
WHERE s.is_active
  AND coalesce(ti.actual_date, ti.approved_date) BETWEEN DATE '2020-01-01' AND DATE '2035-12-31'
UNION ALL
-- R Configuration (WL/MW/IP/PWR) (0119): the workbook reads it from As-Built (Master!R5 = tblAsBuilt[Configuration (WL/MW/IP/PWR)]); here the field
-- `configuration` of the site's As-Built TE part in force (the approved version; the field belongs to the TE part, p4a_as_built_part of 0062).
-- sites.config_summary is not read any more: nothing writes it. Empty when the site has no approved TE part with a configuration.
SELECT c.site_id, 18, c.value, 'register'::text, 'as_built'::text
FROM (
  SELECT DISTINCT ON (rr.site_id) rr.site_id, rr.data ->> 'configuration' AS value
  FROM register_records rr
  WHERE rr.register_key = 'as_built' AND rr.record_type = 'te_part' AND rr.is_current AND rr.state = 'approved' AND rr.voided_at IS NULL
    AND nullif(btrim(rr.data ->> 'configuration'), '') IS NOT NULL
  ORDER BY rr.site_id, rr.version_no DESC, rr.id
) c
JOIN sites s ON s.id = c.site_id AND s.is_active
;

COMMENT ON VIEW site360_master_values IS 'The Master values of each site and column (0104, F15, extended 0106 to 0112, 0119): the set-based read model of the SITE 360 grid rows.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The sites a dashboard card counts (GET /sites dashboard_status, milestone_reached, ref_date)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dash_drill_sites(p_ref date, p_region integer, p_cluster text, p_scenario text, p_stream text, p_view text, p_status text, p_milestone text)
RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a record; today date := public.cal_today(); ref date := coalesce(p_ref, today); snap date; ids uuid[];
BEGIN
  IF p_status IS NULL AND p_milestone IS NULL THEN RETURN NULL; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('not_started', 'in_progress', 'on_hold', 'completed', 'cancelled') THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/dashboard_status', 'code', 'invalid', 'message', 'Unknown overall status.'))));
  END IF;
  -- the rules of dash_overview: the caller's dashboard.view regions, no future date, the snapshot of a past date when there is one
  SELECT * INTO a FROM public.dash_actor_scope();
  IF ref > today THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/ref_date', 'code', 'in_future', 'message', 'The reference date cannot be in the future.')))); END IF;
  IF ref < today AND EXISTS (SELECT 1 FROM public.site_snapshots WHERE snapshot_date = ref) THEN snap := ref; END IF;
  -- the sites and milestone facts of dash_core (latest 0092), with its stream and view rules
  PERFORM public.dash_build_cal();
  IF snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(snap, a.scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(ref, a.scope, p_region, p_cluster, p_scenario); END IF;
  IF snap IS NULL AND p_stream IS NOT NULL THEN PERFORM public.dash_build_streams(ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  IF p_view IS NOT NULL THEN
    PERFORM public.dash_build_view(p_view);
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM public.task_instances t JOIN _dview v ON v.id = t.task_def_id
                                           WHERE t.site_id = s.id AND t.state NOT IN ('na', 'skipped') AND NOT t.is_na);
  END IF;
  IF p_status IS NOT NULL THEN
    -- headline.by_overall_status (dash_sec_status)
    SELECT array_agg(s.id ORDER BY s.id) INTO ids FROM _dsite s WHERE s.status = p_status;
  ELSE
    -- milestones[].completed (dash_sec_milestones): the sites that are not cancelled and whose milestone is done on the reference date
    SELECT array_agg(DISTINCT m.site_id) INTO ids FROM _dms m JOIN _dsite s ON s.id = m.site_id WHERE NOT s.cancelled AND m.code = p_milestone AND m.state = 'done';
  END IF;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Car Dispatcher: a voided vehicle cancels its future reservations
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE vehicle_reservations DROP CONSTRAINT vehicle_reservations_state_check;
ALTER TABLE vehicle_reservations ADD CONSTRAINT vehicle_reservations_state_check CHECK (state IN ('reserved', 'released', 'cancelled'));
COMMENT ON COLUMN vehicle_reservations.state IS 'reserved (holds the vehicle), released (the booking was returned, cancelled, voided or approved again), cancelled (0119: the vehicle was voided before the reservation started).';

-- fa_after (latest 0093, changes marked 0119)
CREATE OR REPLACE FUNCTION fa_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE gone jsonb;
BEGIN
  IF public.app_is_seeding() THEN RETURN NULL; END IF;
  IF NEW.register_key = 'procurement' THEN
    IF NEW.state = 'approved' AND public.fa_field_work(NEW.data) THEN
      IF NOT NEW.historical_direct_approved THEN PERFORM public.fa_open_drafts(NEW.id); END IF;   -- 0093
      PERFORM public.fleet_sync(NEW.entity_id);
    END IF;
  ELSIF NEW.state = 'voided' AND NEW.register_key = 'car_dispatcher' THEN
    UPDATE public.vehicle_reservations SET state = 'released', released_at = now() WHERE booking_entity_id = NEW.entity_id AND state = 'reserved';
    IF NEW.record_type = 'booking' AND NOT public.fa_blank(NEW.data, 'procurement_record_id') THEN PERFORM public.fleet_sync((NEW.data ->> 'procurement_record_id')::uuid); END IF;
    -- 0119 (audit C, X4): a vehicle left with no approved version in force cancels its reservations that have not started yet; started ones stay
    IF NEW.record_type = 'vehicle' AND NOT EXISTS (SELECT 1 FROM public.register_records v WHERE v.entity_id = NEW.entity_id AND v.state = 'approved') THEN
      WITH c AS (
        UPDATE public.vehicle_reservations SET state = 'cancelled', released_at = now()
        WHERE vehicle_entity_id = NEW.entity_id AND state = 'reserved' AND lower(period) > public.cal_today()
        RETURNING id, booking_entity_id, lower(period) AS from_date, upper(period) - 1 AS to_date
      )
      SELECT jsonb_agg(jsonb_build_object('reservation_id', c.id, 'booking_entity_id', c.booking_entity_id, 'from_date', c.from_date, 'to_date', c.to_date) ORDER BY c.from_date, c.id)
        INTO gone FROM c;
      IF gone IS NOT NULL THEN
        PERFORM public.reg_audit('vehicle_reservations_cancel', NEW.id, jsonb_build_object('state', 'reserved', 'reservations', gone),
          jsonb_build_object('state', 'cancelled', 'reservations', gone, 'vehicle_entity_id', NEW.entity_id), coalesce(NEW.void_reason, 'vehicle voided'));
      END IF;
    END IF;
  ELSIF NEW.state = 'approved' AND NEW.record_type IN ('booking', 'advance') AND NOT public.fa_blank(NEW.data, 'procurement_record_id') THEN
    PERFORM public.fleet_sync((NEW.data ->> 'procurement_record_id')::uuid);
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dash_drill_sites(date,integer,text,text,text,text,text,text)', 'fa_after()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dash_drill_sites(date, integer, text, text, text, text, text, text) TO pmis_app;
  END IF;
END $$;
