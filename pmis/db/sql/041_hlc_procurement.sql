-- 0042_hlc_procurement: the HLC fiber purchasing redesign (owner decision 2026-11-02, docs/spec/owner-answers-2026-10-29.md section "HLC fiber purchasing",
-- replaces the HLC part of Q56 and Q54/Q91 for C3/C4) and owner answer Q91 for GECOL (C1).
-- Mirror: db/sql/041_hlc_procurement.sql (kept identical to prisma/migrations/0042_hlc_procurement/migration.sql).
--
--   1. The HLC purchase request is a Procurement record of scope HLC. The scope is no longer refused as `wrong_register` (the refusal stays for GECOL, Q56).
--      The record holds the PR No., the PR date and the new field `hlc_approval_date` (the date HLC approved the request). For scope HLC the PR No. and the PR
--      date are required at submit, a site whose scope flag AD says N/A is refused (DQ07), and the approval date is refused on any other scope.
--   2. Who enters it. A scope of the Procurement register may have its own Matrix row (data: register_definitions.rules.scope_rows, seed {"HLC": "procurement_hlc"}).
--      The row `procurement_hlc` ("Procurement - HLC scope") is a register_definitions row that is not enabled: it exists for the Matrix only, like rf_design and
--      deliverables did. Its default holders: L1 = the HLC Fiber Team, L2 = the CW Team Lead (Q90). The entry level of a Procurement record is decided by the row of
--      its scope (reg_cell); the review and approve levels too, unless the record is the source of a task (Q43: the task's cells).
--      The database enforces it on every write path (manual entry, a new version, a template row): the trigger b_reg_scope_entry refuses a Procurement version
--      whose scope row the actor does not hold at L1 (or a change of scope to another row), with `not_eligible_holder`. So the HLC team cannot enter CW, TE or
--      Dismantle orders and the Procurement team cannot enter HLC requests, whatever the API does. reg_entry_holders(register, region) answers "may this person
--      start a record in this register" and is now the union of the register row and its scope rows; the scope check is the trigger.
--   3. The HLC register holds execution only, linked to the approved scope-HLC Procurement record: new fields `link_received_date` (handover from HLC) and
--      `in_service_date` (operation) beside `installation_date` and `tx_link_tested_date`; the link (`procurement_record_id`, `pr_no`, `hlc_approval_date`) is filled
--      by the database (derived, never typed) from the approved Procurement record of scope HLC of the site while the HLC record is in entry and when it is submitted.
--      One HLC record per site (Q55) and a new request as a new version are unchanged.
--      EXISTING HLC REQUEST DATA: the request fields `request_no` and `request_date` are deactivated (register_fields.is_active = false), so they can no longer be
--      typed (unknown_field) and leave the form and the TPL-HLC template (a new template version is issued by the database). Nothing is deleted or rewritten: the values
--      stay in register_records.data of every version (a new version copies them) and in hlc_records.request_no / request_date, so they remain readable (the API returns
--      them in `data`, the web shows them as a read-only "legacy request" block). No Procurement record is created from them: that would invent an approval and an
--      HLC approval date nobody entered. A site with a legacy request and no scope-HLC Procurement record shows the reviewer warning `no_approved_hlc_pr`, and the HLC
--      team enters the request again in Procurement. v_purchase_requests keeps a legacy HLC request only while the site has no scope-HLC Procurement record (no double count).
--   4. C3 (HLC request) closes from the approved Procurement record of scope HLC, on the HLC approval date (register_task_sources). Its SLA (B03) now runs from the
--      PR issue: new SLA start event `PR:<scope>` = the earliest PR date of the approved Procurement records of that scope on the site (`PR:HLC` for C3). A C3 task that
--      already started keeps its stored start date (as 0018 did for B-15). An approved scope-HLC order refreshes the site, so a C3 clock waiting for its PR starts then.
--   5. C4 (fiber done) closes on the in-service date of the HLC record (no longer TX Link Tested). Blocking at submit: the test is not before the installation, and the
--      operation is not before the test. Every other ordering issue of the HLC / HLC-PR dates is a warning to the reviewer only (Q96): reg_warnings(record).
--      The SLA end event of C-4 stays `hlc.installation_date` (Q54: the Master's end events stay during the parallel run).
--   6. Q91: an approved GECOL request closes C1 with the request date (register_task_sources gecol -> C1), as C2 and C4 close from their records, so the date is entered
--      once. When one approval closes a task and the same record is also the source of the next task that has just opened (for example a first GECOL version with the
--      request date and the Power-On date), reg_complete_task closes that one too, provided its L2 holders are the first task's (reg_cell_sig) and its mandatory
--      documents are in; otherwise it stays open (audited). C1 and C2 otherwise stay as they are.
--   7. Ownership: every function is owned by pmis_definer, SECURITY DEFINER with a fixed search_path, closed to PUBLIC; pmis_app may call reg_warnings and
--      reg_entry_scopes (read helpers of the record view) and reads the new columns. pmis_app stays read-only on every table touched here.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Catalogue: the scope row of the Matrix, the refused scopes, the fields
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order)
VALUES ('procurement_hlc', 'Procurement - HLC scope', 'المشتريات - نطاق HLC', 'procurement', 'register', true, true, ARRAY[]::text[], 2,
        '{"scope_of": "procurement", "scope": "HLC"}'::jsonb, false, 11)
ON CONFLICT (register_key) DO NOTHING;

UPDATE register_definitions
SET rules = (rules - 'refused_scopes')
            || jsonb_build_object('refused_scopes', coalesce(rules -> 'refused_scopes', '{}'::jsonb) - 'HLC')
            || jsonb_build_object('scope_rows', coalesce(rules -> 'scope_rows', '{}'::jsonb) || '{"HLC": "procurement_hlc"}'::jsonb)
WHERE register_key = 'procurement';
UPDATE register_definitions SET rules = rules || '{"counts_as_purchase_request": false, "purchase_request_in": "procurement"}'::jsonb WHERE register_key = 'hlc';

-- Procurement: the scope list gains HLC; the HLC approval date of the request
UPDATE register_fields SET options = options || '["HLC"]'::jsonb
WHERE register_key = 'procurement' AND code = 'scope' AND jsonb_typeof(options) = 'array' AND NOT options ? 'HLC';
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('procurement', 'hlc_approval_date', 'HLC Approval Date', 'تاريخ موافقة HLC', 'date', false, true, false, NULL, true, 'Request', 45)
ON CONFLICT (register_key, code) DO NOTHING;

-- HLC: execution only. The request fields are kept for the old data but cannot be typed any more.
UPDATE register_fields SET is_active = false, required = false, in_list = false WHERE register_key = 'hlc' AND code IN ('request_no', 'request_date');
UPDATE register_fields SET section = 'Status and team' WHERE register_key = 'hlc' AND code = 'fiber_uplink' AND section = 'Request';
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('hlc', 'pr_no',                 'HLC PR No.',                    'رقم طلب شراء HLC',           'text', false, false, true,  NULL, true,  'Purchase request', 1),
  ('hlc', 'hlc_approval_date',     'HLC Approval Date',             'تاريخ موافقة HLC',           'date', false, false, true,  NULL, false, 'Purchase request', 2),
  ('hlc', 'procurement_record_id', 'Procurement record',            'سجل المشتريات',              'text', false, false, true,  NULL, false, 'Purchase request', 3),
  ('hlc', 'link_received_date',    'Link Received (handover from HLC)', 'استلام الوصلة (تسليم من HLC)', 'date', false, true, false, NULL, true, 'Installation and test', 55),
  ('hlc', 'in_service_date',       'In Service (operation)',        'دخول الخدمة (التشغيل)',      'date', false, true,  false, NULL, true,  'In service', 75)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Typed tables: the approved values of the new fields (the old request columns of hlc_records stay as they are)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE procurement_records ADD COLUMN IF NOT EXISTS hlc_approval_date DATE;
ALTER TABLE hlc_records ADD COLUMN IF NOT EXISTS link_received_date DATE;
ALTER TABLE hlc_records ADD COLUMN IF NOT EXISTS in_service_date DATE;
ALTER TABLE hlc_records ADD COLUMN IF NOT EXISTS procurement_record_id UUID;
COMMENT ON COLUMN procurement_records.hlc_approval_date IS '0042: scope HLC only. The date HLC approved the request; closes C3 (owner decision 2026-11-02).';
COMMENT ON COLUMN hlc_records.request_no IS 'Legacy (before 0042): the HLC request is now a Procurement record of scope HLC. Kept readable, no longer written from new input.';
COMMENT ON COLUMN hlc_records.request_date IS 'Legacy (before 0042): the HLC request is now a Procurement record of scope HLC. Kept readable, no longer written from new input.';
COMMENT ON COLUMN hlc_records.in_service_date IS '0042: in service (operation); closes C4 (owner decision 2026-11-02).';
COMMENT ON COLUMN hlc_records.procurement_record_id IS '0042: the approved version of the scope-HLC Procurement record the execution is linked to.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Matrix: default holders of the HLC scope row (L1 = HLC Fiber Team, L2 = CW Team Lead per Q90). L2 is cell level 3 (0032).
--    Only missing cells are seeded; nothing that exists is overwritten.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE r record; cid uuid; ids uuid[]; n int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES (1, ARRAY['HLC_TEAM']), (3, ARRAY['CW_TL'])) AS v(lvl, role_codes) LOOP
    SELECT coalesce(array_agg(ro.id ORDER BY ro.code COLLATE "C"), ARRAY[]::uuid[]) INTO ids FROM roles ro WHERE ro.code = ANY (r.role_codes) AND ro.can_hold_matrix_levels;
    CONTINUE WHEN cardinality(ids) = 0;
    CONTINUE WHEN EXISTS (SELECT 1 FROM matrix_cells c WHERE c.register_key = 'procurement_hlc' AND c.level = r.lvl AND c.region_id IS NULL AND c.task_def_id IS NULL);
    INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('procurement_hlc', r.lvl, 'any_one', NULL, true, now()) RETURNING id INTO cid;
    INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN UPDATE matrix_state SET revision = revision + 1, updated_at = now(); END IF;
  INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
  VALUES ('hlc_procurement_applied', 'workflow', NULL,
          jsonb_build_object('matrix_row', 'procurement_hlc', 'cells_seeded', n, 'c1_source', 'gecol.request_date', 'c3_source', 'procurement[HLC].hlc_approval_date',
                             'c4_source', 'hlc.in_service_date', 'hlc_request_fields', 'deactivated, data kept'),
          'Owner decision 2026-11-02 (HLC fiber purchasing) and Q91 (migration 0042).');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Task sources (Q43 pattern of C2 / C4): C1 from the GECOL request, C3 from the scope-HLC order, C4 from the in-service date
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_task_sources (register_key, task_code, date_field, data_eq, data_in, sort_order) VALUES
  ('gecol',       'C1', 'request_date',      '{}'::jsonb,               '{}'::jsonb, 5),
  ('procurement', 'C3', 'hlc_approval_date', '{"scope": "HLC"}'::jsonb, '{}'::jsonb, 30)
ON CONFLICT (register_key, task_code) DO NOTHING;
UPDATE register_task_sources SET date_field = 'in_service_date' WHERE register_key = 'hlc' AND task_code = 'C4';

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Scope rows: which Matrix row decides a record, who may enter it
-- ---------------------------------------------------------------------------------------------------------------------
-- The Matrix row of a record: the row of its scope when the register maps that scope to an active row (rules.scope_rows), else the register's own row.
CREATE OR REPLACE FUNCTION reg_row_key(p_key text, p_data jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT s.register_key FROM public.register_definitions d
    JOIN public.register_definitions s ON s.register_key = d.rules -> 'scope_rows' ->> (p_data ->> 'scope') AND s.is_active
    WHERE d.register_key = p_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object' AND p_data ? 'scope'), p_key)
$$;

-- The cell that decides a level of a record. Entry: the row of the record (its scope row, 0042). Review and approve: the source task's cell when the record is
-- the source of a task (Q43), else the row of the record.
CREATE OR REPLACE FUNCTION reg_cell(p_record uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_kind <> 'entry' AND r.task_id IS NOT NULL THEN public.wf_cell(r.task_id, p_kind)
              ELSE public.reg_cell_row(public.reg_row_key(r.register_key, r.data), r.region_id, p_kind) END
  FROM public.register_records r WHERE r.id = p_record AND public.app_region_read(r.is_global, r.region_id)
$$;

-- The entry holders of one row (no scope union).
CREATE OR REPLACE FUNCTION reg_row_entry_holders(p_row text, p_region integer) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.user_id, e.via_group FROM public.reg_eligible_cell(public.reg_cell_row(p_row, p_region, 'entry'), p_region, public.reg_module(p_row), 'entry') e
  WHERE public.app_region_read(p_region IS NULL, p_region)
$$;

-- May this person start a record in the register for a site of this region? The holders of the register row and of its scope rows (0042). Which scope a
-- holder may enter is checked by the trigger b_reg_scope_entry on the record itself.
CREATE OR REPLACE FUNCTION reg_entry_holders(p_key text, p_region integer) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.user_id, (array_agg(u.via_group) FILTER (WHERE u.via_group IS NOT NULL))[1]
  FROM (
    SELECT h.user_id, h.via_group FROM public.reg_row_entry_holders(p_key, p_region) h
    UNION ALL
    SELECT h.user_id, h.via_group
    FROM public.register_definitions d
    CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(d.rules -> 'scope_rows') = 'object' THEN d.rules -> 'scope_rows' ELSE '{}'::jsonb END) AS m(scope, row_key)
    JOIN public.register_definitions s ON s.register_key = m.row_key AND s.is_active
    CROSS JOIN LATERAL public.reg_row_entry_holders(m.row_key, p_region) h
    WHERE d.register_key = p_key
  ) u
  GROUP BY u.user_id
$$;

-- The scopes the caller may enter in a register that has scope rows (NULL for any other register): the scopes of its own row when the caller holds L1 of that row
-- in a region they can see, plus each scope whose row they hold. A System Admin gets every scope (the database still applies the no-holder rule, B10).
CREATE OR REPLACE FUNCTION reg_entry_scopes(p_key text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); rows_ jsonb; opts text[]; out text[] := ARRAY[]::text[]; k text; v text;
BEGIN
  SELECT d.rules -> 'scope_rows' INTO rows_ FROM public.register_definitions d WHERE d.register_key = p_key;
  IF rows_ IS NULL OR jsonb_typeof(rows_) <> 'object' THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg(e ORDER BY o), ARRAY[]::text[]) INTO opts
  FROM public.register_fields f, jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.options) = 'array' THEN f.options ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)
  WHERE f.register_key = p_key AND f.code = 'scope';
  IF actor IS NULL THEN RETURN out; END IF;
  IF public.app_user_is_system_admin(actor) THEN RETURN opts; END IF;
  IF EXISTS (SELECT 1 FROM public.regions g CROSS JOIN LATERAL public.reg_row_entry_holders(p_key, g.id) h WHERE h.user_id = actor) THEN
    out := ARRAY(SELECT o FROM unnest(opts) o WHERE NOT rows_ ? o);
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(rows_) LOOP
    IF EXISTS (SELECT 1 FROM public.regions g CROSS JOIN LATERAL public.reg_row_entry_holders(v, g.id) h WHERE h.user_id = actor) AND k = ANY (opts) THEN
      out := out || k;
    END IF;
  END LOOP;
  RETURN ARRAY(SELECT o FROM unnest(opts) o WHERE o = ANY (out));
END $$;

-- The database check of the scope rows: a version of a register with scope rows may be written only by an L1 holder of the row of its scope (or, when that row has
-- nobody in the region, by a System Admin, B10). It runs on the insert of every version (manual entry, new version, template row, its validation probe) and on an
-- edit that moves the record to another row. Seeding and writes without an actor (none exist for these registers) are left alone.
CREATE OR REPLACE FUNCTION reg_scope_entry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); rk text; n int; holder boolean;
BEGIN
  IF public.app_is_seeding() OR actor IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = NEW.register_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object') THEN RETURN NEW; END IF;
  rk := public.reg_row_key(NEW.register_key, NEW.data);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state <> 'entry' OR rk = public.reg_row_key(OLD.register_key, OLD.data) THEN RETURN NEW; END IF;
  ELSIF NEW.state <> 'entry' THEN
    RETURN NEW;
  END IF;
  SELECT count(*)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder FROM public.reg_row_entry_holders(rk, NEW.region_id) h;
  IF NOT holder AND NOT (n = 0 AND public.app_user_is_system_admin(actor)) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail',
      'You are not an entry holder (L1) of the ' || coalesce((SELECT d.name_en FROM public.register_definitions d WHERE d.register_key = rk), rk)
      || ' row of the Matrix' || CASE WHEN NEW.data ? 'scope' THEN ' (scope ' || (NEW.data ->> 'scope') || ')' ELSE '' END || '.'));
  END IF;
  -- the claim pin of a new version follows the holders of its own row (one holder: nobody to claim against)
  IF TG_OP = 'INSERT' AND NEW.ball_in_court_user_id = actor AND n <= 1 THEN NEW.ball_in_court_user_id := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_reg_scope_entry BEFORE INSERT OR UPDATE OF data ON register_records FOR EACH ROW WHEN (NEW.register_key = 'procurement') EXECUTE FUNCTION reg_scope_entry_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The HLC record's link to its purchase request (derived, Q45): filled while the record is in entry and when it leaves entry (the submit)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_hlc_pr(p_site uuid) RETURNS TABLE (record_id uuid, pr_no text, pr_date date, hlc_approval_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.register_record_id, p.pr_no, p.pr_date, p.hlc_approval_date FROM public.procurement_records p
  WHERE p.site_id = p_site AND p.scope = 'HLC'
  ORDER BY (p.hlc_approval_date IS NULL), p.hlc_approval_date DESC, p.pr_date DESC NULLS LAST, p.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION reg_hlc_link_pr() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p record;
BEGIN
  IF NEW.site_id IS NULL THEN RETURN NEW; END IF;
  IF NOT (NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry')) THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.reg_hlc_pr(NEW.site_id);
  NEW.data := (NEW.data - 'procurement_record_id' - 'pr_no' - 'hlc_approval_date')
    || CASE WHEN p.record_id IS NULL THEN '{}'::jsonb
            ELSE jsonb_strip_nulls(jsonb_build_object('procurement_record_id', p.record_id::text, 'pr_no', p.pr_no, 'hlc_approval_date', p.hlc_approval_date::text)) END;
  RETURN NEW;
END $$;
CREATE TRIGGER b_reg_hlc_link_pr BEFORE INSERT OR UPDATE ON register_records FOR EACH ROW WHEN (NEW.register_key = 'hlc') EXECUTE FUNCTION reg_hlc_link_pr();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Validation (blocking at submit) and warnings for the reviewer (Q96)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_validate_core(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.register_records%ROWTYPE; errs jsonb := '[]'::jsonb; f record; dd jsonb; st text; ptype text; hx boolean; kind text;
  has_pr boolean; has_po boolean; pr date; po date; ti date; tx date; ifin date; req date; ins date; hlc boolean;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  dd := r.data;
  -- V4: required fields (blank is never N/A)
  FOR f IN SELECT x.code, x.label_en FROM public.register_fields x WHERE x.register_key = r.register_key AND x.required AND x.is_active AND NOT x.derived LOOP
    IF NOT (dd ? f.code) OR jsonb_typeof(dd -> f.code) = 'null' THEN
      errs := errs || public.reg_err_item('/data/' || f.code, 'required', f.label_en || ' is required.');
    END IF;
  END LOOP;
  IF r.site_id IS NOT NULL AND NOT public.reg_scope_ok(r.register_key, r.site_id) THEN
    errs := errs || public.reg_err_item('/site_id', 'scope_conflict', 'The site scope says N/A for this register (DQ07).');
  END IF;

  IF r.register_key = 'procurement' THEN
    has_pr := coalesce(dd ->> 'pr_no', dd ->> 'pr_date') IS NOT NULL;
    has_po := coalesce(dd ->> 'po_wo_no', dd ->> 'po_wo_date') IS NOT NULL;
    hlc := dd ->> 'scope' = 'HLC';
    IF dd ->> 'delivery' = 'In-House' AND has_pr THEN errs := errs || public.reg_err_item('/data/pr_no', 'in_house_with_pr', 'An in-house order has no PR.'); END IF;
    IF dd ->> 'delivery' = 'Outsourced' AND has_po AND NOT has_pr THEN errs := errs || public.reg_err_item('/data/pr_no', 'po_without_pr', 'An outsourced PO needs a PR.'); END IF;
    pr := (dd ->> 'pr_date')::date; po := (dd ->> 'po_wo_date')::date;
    IF pr IS NOT NULL AND po IS NOT NULL AND po < pr THEN errs := errs || public.reg_err_item('/data/po_wo_date', 'po_before_pr', 'The PO / WO date is before the PR date.'); END IF;
    IF dd ->> 'scope' = 'TE Installation' AND (has_pr OR has_po) THEN errs := errs || public.reg_err_item('/data/scope', 'no_pr_po', 'TE Installation has no PR, PO or WO.'); END IF;
    IF dd ? 'team_id' AND r.external_party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.external_teams t WHERE t.id = (dd ->> 'team_id')::uuid AND t.party_id = r.external_party_id) THEN
      errs := errs || public.reg_err_item('/data/team_id', 'team_of_other_contractor', 'The team belongs to another contractor.');
    END IF;
    -- 0042: the HLC purchase request (owner decision 2026-11-02)
    IF hlc THEN
      IF dd ->> 'pr_no' IS NULL THEN errs := errs || public.reg_err_item('/data/pr_no', 'required', 'An HLC request needs its PR No.'); END IF;
      IF dd ->> 'pr_date' IS NULL THEN errs := errs || public.reg_err_item('/data/pr_date', 'required', 'An HLC request needs its PR date.'); END IF;
      IF r.site_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.sites s WHERE s.id = r.site_id AND s.scope_hlc_fiber IS DISTINCT FROM 'yes') THEN
        errs := errs || public.reg_err_item('/site_id', 'scope_conflict', 'The site scope says N/A for HLC fiber (DQ07).');
      END IF;
    ELSIF dd ? 'hlc_approval_date' THEN
      errs := errs || public.reg_err_item('/data/hlc_approval_date', 'hlc_scope_only', 'The HLC approval date belongs to scope HLC only.');
    END IF;
  ELSIF r.register_key = 'gecol' THEN
    ifin := (dd ->> 'installation_finish')::date; req := (dd ->> 'request_date')::date;
    IF ifin IS NOT NULL AND req IS NOT NULL AND ifin < req THEN errs := errs || public.reg_err_item('/data/installation_finish', 'negative_duration', 'The installation finish is before the request date (DQ10).'); END IF;
  ELSIF r.register_key = 'hlc' THEN
    -- the two blocking date rules (owner decision 2026-11-02, Q96); every other order is a warning (reg_warnings)
    ti := (dd ->> 'installation_date')::date; tx := (dd ->> 'tx_link_tested_date')::date; ins := (dd ->> 'in_service_date')::date;
    IF ti IS NOT NULL AND tx IS NOT NULL AND tx < ti THEN errs := errs || public.reg_err_item('/data/tx_link_tested_date', 'before_installation', 'The TX link test is before the installation date.'); END IF;
    IF tx IS NOT NULL AND ins IS NOT NULL AND ins < tx THEN errs := errs || public.reg_err_item('/data/in_service_date', 'before_test', 'The in-service date is before the TX link test.'); END IF;
  ELSIF r.register_key = 'permits_hse' THEN
    st := lower(coalesce(dd ->> 'status', ''));
    ptype := dd ->> 'permit_type';
    hx := coalesce((dd ->> 'has_expiry')::boolean, (SELECT t.has_expiry FROM public.permit_types t WHERE t.code = ptype));
    kind := (SELECT t.kind FROM public.permit_types t WHERE t.code = ptype);
    IF st = 'n/a' AND btrim(coalesce(dd ->> 'na_reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/na_reason', 'required', 'N/A needs a reason (V5, D36).'); END IF;
    IF st <> 'n/a' AND dd ? 'na_reason' THEN errs := errs || public.reg_err_item('/data/na_reason', 'not_applicable', 'An N/A reason belongs to status N/A only.'); END IF;
    IF st = 'approved' AND NOT (dd ? 'valid_from') THEN errs := errs || public.reg_err_item('/data/valid_from', 'required', 'An approved permit needs Valid From.'); END IF;
    IF st = 'approved' AND hx IS TRUE AND NOT (dd ? 'valid_to') THEN errs := errs || public.reg_err_item('/data/valid_to', 'required', 'This permit has an expiry date: Valid To is required.'); END IF;
    IF hx IS FALSE AND dd ? 'valid_to' THEN errs := errs || public.reg_err_item('/data/valid_to', 'permanent', 'A permit without an expiry date has no Valid To (Q63c).'); END IF;
    IF dd ? 'valid_from' AND dd ? 'valid_to' AND (dd ->> 'valid_to')::date < (dd ->> 'valid_from')::date THEN errs := errs || public.reg_err_item('/data/valid_to', 'before_valid_from', 'Valid To is before Valid From.'); END IF;
    IF kind IS DISTINCT FROM 'ptw' THEN
      FOR f IN SELECT k FROM unnest(ARRAY['jsa_tra', 'toolbox_talk', 'work_at_height', 'lifting_plan', 'loto', 'rescue_plan', 'stop_work', 'stop_lifted_date']) k LOOP
        IF dd ? f.k THEN errs := errs || public.reg_err_item('/data/' || f.k, 'ptw_only', 'This field belongs to the PTW types only.'); END IF;
      END LOOP;
    END IF;
    IF dd ? 'stop_lifted_date' AND coalesce((dd ->> 'stop_work')::boolean, false) IS FALSE THEN
      errs := errs || public.reg_err_item('/data/stop_lifted_date', 'no_stop_work', 'A lift date needs Stop Work = Yes.');
    END IF;
  END IF;
  RETURN errs;
END $$;

-- Warnings for the reviewer (Q96: only the two date rules above block). Same shape as the field errors. A record the caller cannot read gives none.
CREATE OR REPLACE FUNCTION reg_warnings(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; dd jsonb; w jsonb := '[]'::jsonb; p record; lr date; ti date; tx date; ins date; ap date; pr date;
BEGIN
  SELECT * INTO r FROM public.register_records x WHERE x.id = p_record AND public.app_region_read(x.is_global, x.region_id);
  IF NOT FOUND THEN RETURN w; END IF;
  dd := r.data;
  IF r.register_key = 'hlc' THEN
    lr := (dd ->> 'link_received_date')::date; ti := (dd ->> 'installation_date')::date; tx := (dd ->> 'tx_link_tested_date')::date; ins := (dd ->> 'in_service_date')::date;
    SELECT * INTO p FROM public.reg_hlc_pr(r.site_id);
    IF p.record_id IS NULL THEN
      w := w || public.reg_err_item('/data/pr_no', 'no_approved_hlc_pr', 'The site has no approved HLC purchase request in Procurement yet.');
    ELSIF p.hlc_approval_date IS NULL THEN
      w := w || public.reg_err_item('/data/hlc_approval_date', 'hlc_not_approved', 'The HLC purchase request has no HLC approval date yet.');
    ELSE
      IF lr IS NOT NULL AND lr < p.hlc_approval_date THEN
        w := w || public.reg_err_item('/data/link_received_date', 'before_hlc_approval', 'The link was received before the HLC approval date ' || p.hlc_approval_date::text || '.');
      END IF;
      IF ti IS NOT NULL AND ti < p.hlc_approval_date THEN
        w := w || public.reg_err_item('/data/installation_date', 'before_hlc_approval', 'The installation is before the HLC approval date ' || p.hlc_approval_date::text || '.');
      END IF;
    END IF;
    IF lr IS NOT NULL AND ti IS NOT NULL AND ti < lr THEN
      w := w || public.reg_err_item('/data/installation_date', 'before_link_received', 'The installation is before the link was received from HLC.');
    END IF;
    IF tx IS NOT NULL AND ti IS NULL THEN
      w := w || public.reg_err_item('/data/installation_date', 'test_without_installation', 'A TX link test without an installation date.');
    END IF;
    IF ins IS NOT NULL AND tx IS NULL THEN
      w := w || public.reg_err_item('/data/tx_link_tested_date', 'in_service_without_test', 'In service without a TX link test date.');
    END IF;
  ELSIF r.register_key = 'procurement' AND dd ->> 'scope' = 'HLC' THEN
    ap := (dd ->> 'hlc_approval_date')::date; pr := (dd ->> 'pr_date')::date;
    IF ap IS NOT NULL AND pr IS NOT NULL AND ap < pr THEN
      w := w || public.reg_err_item('/data/hlc_approval_date', 'approval_before_pr', 'The HLC approval date is before the PR date.');
    END IF;
  END IF;
  RETURN w;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Projection into the typed tables (the new columns)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_apply(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb; hse jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  IF r.register_key = 'procurement' THEN
    INSERT INTO public.procurement_records (id, site_id, region_id, scope, delivery, pr_no, pr_date, po_wo_no, po_wo_date, party_id, team_id, order_status, remark, custom, register_record_id, record_version,
      hlc_approval_date)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'scope', d ->> 'delivery', d ->> 'pr_no', (d ->> 'pr_date')::date, d ->> 'po_wo_no', (d ->> 'po_wo_date')::date,
            r.external_party_id, (d ->> 'team_id')::uuid, d ->> 'order_status', d ->> 'remark', r.custom, r.id, r.version_no, (d ->> 'hlc_approval_date')::date)
    ON CONFLICT (id) DO UPDATE SET scope = EXCLUDED.scope, delivery = EXCLUDED.delivery, pr_no = EXCLUDED.pr_no, pr_date = EXCLUDED.pr_date, po_wo_no = EXCLUDED.po_wo_no,
      po_wo_date = EXCLUDED.po_wo_date, party_id = EXCLUDED.party_id, team_id = EXCLUDED.team_id, order_status = EXCLUDED.order_status, remark = EXCLUDED.remark,
      custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version, hlc_approval_date = EXCLUDED.hlc_approval_date;
  ELSIF r.register_key = 'gecol' THEN
    INSERT INTO public.gecol_records (id, site_id, region_id, pr_no, contractor, request_date, survey_date, layout_received, layout_approved, notice_date, mos_date, installation_finish,
      aat_acceptance_date, docs_approval_date, meter_no, power_on_date, billing_conversion_date, remark, custom, register_record_id, record_version)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'pr_no', d ->> 'contractor', (d ->> 'request_date')::date, (d ->> 'survey_date')::date, (d ->> 'layout_received')::date,
            (d ->> 'layout_approved')::date, (d ->> 'notice_date')::date, (d ->> 'mos_date')::date, (d ->> 'installation_finish')::date, (d ->> 'aat_acceptance_date')::date,
            (d ->> 'docs_approval_date')::date, d ->> 'meter_no', (d ->> 'power_on_date')::date, (d ->> 'billing_conversion_date')::date, d ->> 'remark', r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET pr_no = EXCLUDED.pr_no, contractor = EXCLUDED.contractor, request_date = EXCLUDED.request_date, survey_date = EXCLUDED.survey_date,
      layout_received = EXCLUDED.layout_received, layout_approved = EXCLUDED.layout_approved, notice_date = EXCLUDED.notice_date, mos_date = EXCLUDED.mos_date,
      installation_finish = EXCLUDED.installation_finish, aat_acceptance_date = EXCLUDED.aat_acceptance_date, docs_approval_date = EXCLUDED.docs_approval_date,
      meter_no = EXCLUDED.meter_no, power_on_date = EXCLUDED.power_on_date, billing_conversion_date = EXCLUDED.billing_conversion_date, remark = EXCLUDED.remark,
      custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  ELSIF r.register_key = 'hlc' THEN
    -- request_no / request_date: legacy values that a version carries over from before 0042 (never typed any more)
    INSERT INTO public.hlc_records (id, site_id, region_id, request_no, request_date, fiber_uplink, fiber_status, internal_fiber_team, installation_date, tx_link_tested_date, remark, custom,
      register_record_id, record_version, link_received_date, in_service_date, procurement_record_id)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'request_no', (d ->> 'request_date')::date, d ->> 'fiber_uplink', d ->> 'fiber_status', d ->> 'internal_fiber_team',
            (d ->> 'installation_date')::date, (d ->> 'tx_link_tested_date')::date, d ->> 'remark', r.custom, r.id, r.version_no,
            (d ->> 'link_received_date')::date, (d ->> 'in_service_date')::date, (d ->> 'procurement_record_id')::uuid)
    ON CONFLICT (id) DO UPDATE SET request_no = EXCLUDED.request_no, request_date = EXCLUDED.request_date, fiber_uplink = EXCLUDED.fiber_uplink, fiber_status = EXCLUDED.fiber_status,
      internal_fiber_team = EXCLUDED.internal_fiber_team, installation_date = EXCLUDED.installation_date, tx_link_tested_date = EXCLUDED.tx_link_tested_date,
      remark = EXCLUDED.remark, custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version,
      link_received_date = EXCLUDED.link_received_date, in_service_date = EXCLUDED.in_service_date, procurement_record_id = EXCLUDED.procurement_record_id;
  ELSIF r.register_key = 'permits_hse' THEN
    hse := jsonb_strip_nulls(jsonb_build_object('jsa_tra', d -> 'jsa_tra', 'toolbox_talk', d -> 'toolbox_talk', 'work_at_height', d -> 'work_at_height',
                                                'lifting_plan', d -> 'lifting_plan', 'loto', d -> 'loto', 'rescue_plan', d -> 'rescue_plan'));
    INSERT INTO public.permit_records (id, site_id, region_id, permit_type, applied_date, status, valid_from, valid_to, has_expiry, na_reason, na_approved_by, hse_checks,
      stop_work, stop_lifted_date, remark, custom, register_record_id, record_version)
    VALUES (r.entity_id, r.site_id, r.region_id, d ->> 'permit_type', (d ->> 'applied_date')::date, d ->> 'status', (d ->> 'valid_from')::date, (d ->> 'valid_to')::date,
            (d ->> 'has_expiry')::boolean, d ->> 'na_reason', d ->> 'na_approved_by', CASE WHEN hse = '{}'::jsonb THEN NULL ELSE hse END,
            coalesce((d ->> 'stop_work')::boolean, false), (d ->> 'stop_lifted_date')::date, d ->> 'remark', r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET permit_type = EXCLUDED.permit_type, applied_date = EXCLUDED.applied_date, status = EXCLUDED.status, valid_from = EXCLUDED.valid_from,
      valid_to = EXCLUDED.valid_to, has_expiry = EXCLUDED.has_expiry, na_reason = EXCLUDED.na_reason, na_approved_by = EXCLUDED.na_approved_by, hse_checks = EXCLUDED.hse_checks,
      stop_work = EXCLUDED.stop_work, stop_lifted_date = EXCLUDED.stop_lifted_date, remark = EXCLUDED.remark, custom = EXCLUDED.custom,
      register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  END IF;
  -- a registers without a typed table yet keeps its approved data in register_records only
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Closing the tasks of a record (Q43, Q91): the linked task, then the next source task of the same record that has just opened
-- ---------------------------------------------------------------------------------------------------------------------
-- Closes one task with the record's date (the body of the 0019 closing, shared). Returns the tasks it unlocked.
CREATE OR REPLACE FUNCTION reg_close_task(p_record uuid, p_task uuid, p_date_field text, p_actor uuid, p_stepup boolean, p_self boolean, p_note text) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; t public.task_instances%ROWTYPE; d date; before jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  d := (r.data ->> p_date_field)::date;
  before := public.wf_snap(t.id);
  UPDATE public.task_instances SET actual_date = d, state = 'approved', current_level = r.levels_required, levels_required = r.levels_required,
    path_frozen_at = coalesce(path_frozen_at, now()), submitted_date = coalesce(r.submitted_at::date, current_date), approved_date = current_date,
    ball_in_court_user_id = NULL, level_opened_at = NULL, self_approval = p_self, version = version + 1, updated_at = now()
  WHERE id = t.id;
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = t.id AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots sl
    WHERE sl.task_id = t.id AND f.slot_id = sl.id AND f.is_current AND f.approved_date IS NULL;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
  VALUES (t.id, r.levels_required, 'approve', p_actor, coalesce(p_note, 'approved with the register record ' || r.register_key || ' ' || r.id::text), t.state, 'approved',
          coalesce(p_stepup, false), coalesce(p_self, false), clock_timestamp());
  PERFORM public.wf_audit('task_approve', t.id, before, public.wf_snap(t.id) || jsonb_build_object('via_register_record', r.id, 'register', r.register_key), 'approved with a register record (Q43)');
  RETURN public.wf_unlock_successors(t.id);
END $$;

-- The holders of a cell as one comparable value (rule plus the sorted assignees): two cells with the same people are the same L2.
CREATE OR REPLACE FUNCTION reg_cell_sig(p_cell uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.rule::text || '|' || coalesce((SELECT string_agg(a.kind::text || ':' || a.ref_id::text, ',' ORDER BY a.kind::text COLLATE "C", a.ref_id::text COLLATE "C")
                                          FROM public.matrix_cell_assignees a WHERE a.cell_id = c.id), '')
  FROM public.matrix_cells c WHERE c.id = p_cell
$$;

-- Final approval of a task-source record: the task takes the record's date and is approved with it, one approval for both (Q43). Then (0042, Q91) every other
-- source task of the same register that the record matches and that is open now (typically the successor the first closing has just unlocked) is closed by the
-- same approval when its L2 holders are the ones of the first task, it has no other record in review and its mandatory documents are in. Anything else stays open.
CREATE OR REPLACE FUNCTION reg_complete_task(p_record uuid, p_actor uuid, p_stepup boolean, p_self boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.register_records%ROWTYPE; t public.task_instances%ROWTYPE; s public.register_task_sources%ROWTYPE; td_code text; d date; unlocked uuid[];
  src record; t2 public.task_instances%ROWTYPE; sig text; d2 date; done text[];
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.task_id IS NULL THEN RETURN ARRAY[]::uuid[]; END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = r.task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN ARRAY[]::uuid[]; END IF;
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.reg_audit('register_record_task_not_open', p_record, NULL, jsonb_build_object('task_id', t.id, 'task_state', t.state), 'the task is no longer open: left unchanged');
    RETURN ARRAY[]::uuid[];
  END IF;
  SELECT td.code INTO td_code FROM public.task_definitions td WHERE td.id = t.task_def_id;
  -- The data may have changed since the link (an edit after a rejection back to entry): the task is closed only by a record that matches its source
  -- row now. Otherwise the record stays approved on the register row, the link is dropped and the task stays open.
  IF NOT public.reg_source_matches(p_record, td_code) THEN
    UPDATE public.register_records SET task_id = NULL WHERE id = p_record;
    PERFORM public.reg_audit('register_record_task_unlinked', p_record, jsonb_build_object('task_id', t.id, 'task_code', td_code), jsonb_build_object('task_id', NULL),
      'the record no longer matches the source of task ' || td_code || ' (or its date is empty): approved on the register row only, the task stays open');
    RETURN ARRAY[]::uuid[];
  END IF;
  SELECT * INTO s FROM public.register_task_sources x WHERE x.register_key = r.register_key AND x.task_code = td_code;
  d := (r.data ->> s.date_field)::date;
  IF d > public.cal_today() THEN   -- the same rule as an actual date typed on the task (wf_save_entry)
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/' || s.date_field, 'future_date', 'An actual date cannot be in the future.')));
  END IF;
  sig := public.reg_cell_sig(public.wf_cell(t.id, 'approve'));
  unlocked := public.reg_close_task(p_record, t.id, s.date_field, p_actor, p_stepup, p_self, NULL);
  done := ARRAY[td_code];

  FOR src IN SELECT x.task_code, x.date_field FROM public.register_task_sources x
             WHERE x.register_key = r.register_key AND x.is_active AND x.task_code <> td_code ORDER BY x.sort_order, x.task_code LOOP
    IF NOT public.reg_source_matches(p_record, src.task_code) THEN CONTINUE; END IF;
    SELECT ti.* INTO t2 FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.sites st ON st.id = ti.site_id AND st.workflow_version_id = td.workflow_id
      WHERE ti.site_id = r.site_id AND td.code = src.task_code
      LIMIT 1;
    IF NOT FOUND OR t2.state NOT IN ('open', 'entry') OR t2.is_na THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = t2.id AND o.id <> p_record AND o.state IN ('in_review', 'in_approval')) THEN CONTINUE; END IF;
    d2 := (r.data ->> src.date_field)::date;
    IF sig IS NULL OR public.reg_cell_sig(public.wf_cell(t2.id, 'approve')) IS DISTINCT FROM sig OR d2 > public.cal_today() OR cardinality(public.wf_missing_slots(t2.id)) > 0 THEN
      PERFORM public.reg_audit('register_record_task_left_open', p_record, NULL, jsonb_build_object('task_id', t2.id, 'task_code', src.task_code),
        'the record is also the source of ' || src.task_code || ', but it has another L2 holder, a future date or missing documents: it stays open');
      CONTINUE;
    END IF;
    unlocked := unlocked || public.reg_close_task(p_record, t2.id, src.date_field, p_actor, p_stepup, p_self,
      'approved with the register record ' || r.register_key || ' ' || r.id::text || ' (same approval as ' || array_to_string(done, ', ') || ')');
    done := done || src.task_code;
  END LOOP;
  RETURN unlocked;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Calculation layer: the SLA start event PR:<scope> (C3 = PR:HLC), the refresh after an approved HLC order
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sla_start_ref_valid(p_ref text, p_workflow uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_ref IS NULL THEN false
    WHEN p_ref IN ('PRED', 'OPEN') THEN true
    WHEN p_ref LIKE 'DLP:%:%' OR p_ref LIKE 'DLPD:%:%' THEN
      EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = split_part(p_ref, ':', 2)) AND split_part(p_ref, ':', 3) <> ''
    WHEN p_ref LIKE 'PR:%' THEN
      EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = 'procurement' AND f.code = 'scope' AND jsonb_typeof(f.options) = 'array'
              AND f.options ? substr(p_ref, 4))
    WHEN p_ref ~ '^G[0-9]+$' THEN EXISTS (SELECT 1 FROM public.phase_gate_rules g WHERE g.workflow_id = p_workflow AND g.link_code = p_ref)
    ELSE EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = p_ref)
  END
$$;

CREATE OR REPLACE FUNCTION sla_resolve_start(p_task uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; d date; months integer; days integer; key text; today date := public.cal_today();
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_ref IS NULL OR p_ref = 'PRED' THEN
    SELECT max(public.sla_task_date(t.site_id, pd.code)) INTO d
    FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id WHERE tp.task_def_id = t.task_def_id;
    RETURN coalesce(d, today);
  ELSIF p_ref = 'OPEN' THEN
    RETURN today;
  ELSIF p_ref ~ '^G[0-9]+$' THEN
    RETURN (SELECT g.gate_date FROM public.gate_eval(t.site_id, p_ref) g);
  ELSIF p_ref LIKE 'PR:%' THEN
    -- 0042: the PR issue of a scope (C-3 = PR issue -> HLC approval): the earliest PR date of the approved Procurement records of that scope on the site
    RETURN (SELECT min(p.pr_date) FROM public.procurement_records p WHERE p.site_id = t.site_id AND p.scope = substr(p_ref, 4));
  ELSIF p_ref LIKE 'DLPD:%:%' THEN
    -- Q80: the task date plus calendar days (the Master's CW DLP end = CW PAC + CWDLPDays)
    key := split_part(p_ref, ':', 3);
    days := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, 90);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE d + days END;
  ELSIF p_ref LIKE 'DLP:%:%' THEN
    key := split_part(p_ref, ':', 3);
    months := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, CASE WHEN key = 'dlp.months.cw' THEN 3 ELSE 12 END);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE (d + make_interval(months => months))::date END;
  END IF;
  RETURN public.sla_task_date(t.site_id, p_ref);
END $$;

-- C3 (B03) now runs from the HLC PR issue. As in 0018, the rule rows are updated in place (a C3 task that already started keeps its stored start date), so the
-- freeze trigger is suspended for this one statement; the items of every rule-set version follow.
ALTER TABLE sla_rules DISABLE TRIGGER sla_rules_frozen;
UPDATE sla_rules r SET start_ref = 'PR:HLC' FROM task_definitions td WHERE td.id = r.task_def_id AND td.code = 'C3' AND r.start_ref = 'B1';
ALTER TABLE sla_rules ENABLE TRIGGER sla_rules_frozen;
UPDATE sla_rule_set_items i SET start_ref = 'PR:HLC' FROM task_definitions td WHERE td.id = i.task_def_id AND td.code = 'C3' AND i.start_ref = 'B1';

-- An approved scope-HLC order refreshes the site: a C3 clock that waited for its PR starts (calc_refresh_site re-opens clocks without a start).
CREATE TRIGGER calc_procurement_hlc_change AFTER INSERT OR UPDATE ON procurement_records FOR EACH ROW WHEN (NEW.scope = 'HLC') EXECUTE FUNCTION calc_after_register_change();

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Purchase requests (Q56 view): the scope-HLC orders are in the Procurement branch; a legacy HLC request counts only while the site has none
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_purchase_requests WITH (security_invoker = true) AS
  SELECT 'procurement'::text AS register_key, p.id AS record_id, p.site_id, p.region_id, p.scope, p.pr_no AS request_no, p.pr_date AS request_date
  FROM procurement_records p
  WHERE p.pr_no IS NOT NULL OR p.pr_date IS NOT NULL
  UNION ALL
  SELECT 'gecol'::text, g.id, g.site_id, g.region_id, 'GECOL'::text, g.pr_no, g.request_date
  FROM gecol_records g
  WHERE g.pr_no IS NOT NULL OR g.request_date IS NOT NULL
  UNION ALL
  SELECT 'hlc'::text, h.id, h.site_id, h.region_id, 'HLC'::text, h.request_no, h.request_date
  FROM hlc_records h
  WHERE (h.request_no IS NOT NULL OR h.request_date IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM procurement_records p WHERE p.site_id = h.site_id AND p.scope = 'HLC');

-- ---------------------------------------------------------------------------------------------------------------------
-- 12. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'reg_row_key(text,jsonb)', 'reg_cell(uuid,text)', 'reg_row_entry_holders(text,integer)', 'reg_entry_holders(text,integer)', 'reg_entry_scopes(text)',
    'reg_scope_entry_guard()', 'reg_hlc_pr(uuid)', 'reg_hlc_link_pr()', 'reg_validate_core(uuid)', 'reg_warnings(uuid)', 'reg_apply(uuid)',
    'reg_close_task(uuid,uuid,text,uuid,boolean,boolean,text)', 'reg_cell_sig(uuid)', 'reg_complete_task(uuid,uuid,boolean,boolean)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['reg_cell(uuid,text)', 'reg_entry_holders(text,integer)', 'reg_entry_scopes(text)', 'reg_warnings(uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON procurement_records, hlc_records, register_records, register_fields, register_definitions, register_task_sources FROM pmis_app;
    GRANT SELECT ON procurement_records, hlc_records, v_purchase_requests TO pmis_app;
  END IF;
END $$;
