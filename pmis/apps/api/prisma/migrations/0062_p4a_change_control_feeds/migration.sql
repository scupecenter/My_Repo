-- 0062_p4a_change_control_feeds: work package P4a of the owner answers of 2026-11-04 (Q103 except Quality, Q108, Q113, Q225; CHANGELOG 89; contract 0.12.10).
-- Mirrored byte-identically as db/sql/061_p4a_change_control_feeds.sql.
--
-- An approved register record now reaches the calculation layer. Nothing reads a draft, a record in review, a rejected or a voided version: every feed
-- runs on the final approval only (trigger zz_p4a_feed, after z_catalog_on_approved), is keyed on the logical record (entity_id), so a re-approval or a
-- new version updates the same typed row (idempotent), and a voided correction leaves the approved version in force (R9).
--
--   1. Change Control -> change_requests (Q103; the gates and the delay read it, 0017 gate_eval, 0039 / 0046 dashboard). One row per logical record,
--      id = entity_id. Every change type is written (Suspension -> suspension, Resumption -> resumption, Scope Change -> scope_change,
--      Baseline Re-plan -> date_change, the others -> other). Suspensions and resumptions carry BOTH dates (coordination with P1, Q180):
--        approval_date     the date of the final approval (Q45, unchanged);
--        suspension_start  suspension rows: the effective start (new field suspension_start), or the approval date when none was typed;
--        resumption_date   resumption rows: the effective resumption (new field resumption_date), or the approval date when none was typed;
--        effective_from_approval  true when the effective date fell back to the approval date;
--        paired_change_id  a resumption names the suspension it ends, and that suspension names the resumption.
--      How the gates read the rows is NOT changed here (P1 owns gate_eval and cc_suspension_windows).
--      Withdraw: a new version with withdrawn = Yes, once approved, sets status = 'rejected' and withdrawn = true; every reader filters on
--      status approved / applied, so the change stops counting. A suspension that a resumption ends cannot be withdrawn before that resumption.
--      Cancellation: an approved one sets the site's overall_status to cancelled (rules.md 2.4); its withdrawal restores the earlier status.
--      Scope Change / Data Correction whose field_item names a site field (site.custom.<code>, site.<scope flag>, site.site_scenario) is applied to the
--      site on approval (status 'applied'), audited, the site is recalculated and the P1 hooks run when they exist (wf_apply_applicability,
--      scope_scenario_conflicts: a conflict refuses the approval).
--   2. Q225: field_definitions.requires_approval (near_airport = true). site_save_custom refuses those fields (approval_required); site_propose_change
--      opens a Change Control draft (Scope Change, field_item site.custom.<code>, old and new value) that goes through L1 -> L2 and applies on approval.
--   3. RF & Design -> rf_design_records and the site identity columns (Master C:Q; delivery_scenario follows the site scenario).
--   4. Acquisition -> acquisition_candidates; the selected candidate's sign-off date is sites.acquisition_date (Master T) and closes A3 (Q43 task source).
--   5. Readiness & Handover -> readiness_handover; O&M acceptance closes D17 (so MS9 follows it) and the closure approval closes Z1 (Q43 task sources).
--      Gate G6 keeps no condition on Commissioning Power Safe (owner answer Q77).
--   6. Issues -> issues and Risks -> risks (the site detail's open issue count and the health index inputs).
--   7. Q113: As-Built has two parts, record types cw_part and te_part, each with its own L1 -> L2 approval (one logical record per site and part).
--      BU (cw_as_built_submitted) is filled by the CW part's submission (Yes, or N/A for a part declared not applicable) with cw_submitted_date;
--      EF (as_built_date) is the TE part's submission date (typed by L1 when the vendor submitted earlier, otherwise GSDN Workspace submission date).
--      Never the approval date. Existing records are migrated. as_built_records keeps one row per site with both parts.
--   8. Q108: the item-type fields WL / MW antenna type and router type pick an active Warehouse item of their group (as_built_type_sources; the
--      options follow the Warehouse catalogue); whole numbers also for the unit qty. RF Height is read as a number (D108b, P5 owns the type).
--   pmis_app stays read-only: no new writer is granted, the fed tables lose their write rights (db/sql/app_grants.sql).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns of the fed tables (additive) and the new register fields
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE change_requests
  ADD COLUMN register_record_id      UUID,
  ADD COLUMN record_version          INTEGER,
  ADD COLUMN change_type             TEXT,
  ADD COLUMN withdrawn               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN effective_from_approval BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN applied                 JSONB,
  ADD COLUMN previous_overall_status TEXT;
CREATE INDEX change_requests_register_record_idx ON change_requests (register_record_id) WHERE register_record_id IS NOT NULL;

ALTER TABLE rf_design_records      ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER;
ALTER TABLE acquisition_candidates ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER;
ALTER TABLE readiness_handover     ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER, ADD COLUMN commissioning_power_safe_date DATE;
ALTER TABLE issues                 ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER, ADD COLUMN blocked_gate_or_task TEXT;
ALTER TABLE risks                  ADD COLUMN register_record_id UUID, ADD COLUMN record_version INTEGER;
ALTER TABLE as_built_records
  ADD COLUMN cw_record_id      UUID,
  ADD COLUMN te_record_id      UUID,
  ADD COLUMN cw_as_built_submitted TEXT,            -- Master BU
  ADD COLUMN cw_submitted_date DATE,
  ADD COLUMN cw_approved_date  DATE,
  ADD COLUMN te_submitted_date DATE,                -- Master EF
  ADD COLUMN te_approved_date  DATE,
  ADD COLUMN rf_height_m       NUMERIC(8,2);
CREATE UNIQUE INDEX as_built_records_site_key ON as_built_records (site_id);

-- Q225: a site field that changes rules (permits, scope) is changed through a proposal and its approval, never edited directly.
ALTER TABLE field_definitions ADD COLUMN requires_approval BOOLEAN NOT NULL DEFAULT false;
UPDATE field_definitions SET requires_approval = true WHERE entity_type = 'site' AND code = 'near_airport' AND task_code IS NULL;
-- The flag is set by a migration (or a future audited admin function owned by pmis_definer), never by a plain table write of the application role.
CREATE OR REPLACE FUNCTION p4a_requires_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'pmis_definer' OR public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT' AND NEW.requires_approval) OR (TG_OP = 'UPDATE' AND NEW.requires_approval IS DISTINCT FROM OLD.requires_approval) THEN
    RAISE EXCEPTION 'field_definitions.requires_approval is changed only through the audited configuration path (Q225)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_p4a_requires_approval_guard BEFORE INSERT OR UPDATE OF requires_approval ON field_definitions FOR EACH ROW EXECUTE FUNCTION p4a_requires_approval_guard();

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('change_control', 'suspension_start', 'Suspension Start (effective)', 'بداية الإيقاف (الفعلية)', 'date', false, false, false, NULL, true, 'Effective dates', 75),
  ('change_control', 'resumption_date',  'Resumption Date (effective)',  'تاريخ الاستئناف (الفعلي)', 'date', false, false, false, NULL, true, 'Effective dates', 76),
  ('change_control', 'withdrawn',        'Withdrawn',                    'مسحوب',                    'list', false, false, false, '["Yes"]'::jsonb, false, 'Withdrawal', 130),
  ('as_built', 'part_not_applicable', 'Part not applicable', 'الجزء غير منطبق', 'list', false, false, false, '["Yes"]'::jsonb, false, 'Part', 5),
  ('as_built', 'na_reason',           'N/A Reason',          'سبب عدم الانطباق',  'text', false, false, false, NULL, false, 'Part', 6),
  ('as_built', 'cw_submitted_date',   'CW Part Submitted Date', 'تاريخ تقديم جزء CW', 'date', false, false, true, NULL, true, 'CW submission', 91)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Shared helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- Audit rows go through log_audit_write (the verified actor). A feed without a signed-in actor only happens in maintenance by the migration role.
CREATE OR REPLACE FUNCTION p4a_audit(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text, p_site uuid, p_region integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor() IS NOT NULL THEN
    PERFORM public.log_audit_write(p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason, p_site, p_region);
  ELSE
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason) VALUES (p_action, p_entity_type, p_entity_id, p_site, p_region, p_before, p_after, p_reason);
  END IF;
END $$;

-- A P1 hook, when P1 has built it (merge-order safe). Returns the rows it answered as a JSON array, or NULL when the hook does not exist.
CREATE OR REPLACE FUNCTION p4a_hook(p_name text, p_site uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE res jsonb;
BEGIN
  IF p_name NOT IN ('wf_apply_applicability', 'scope_scenario_conflicts') OR to_regprocedure('public.' || p_name || '(uuid)') IS NULL THEN RETURN NULL; END IF;
  IF p_name = 'wf_apply_applicability' THEN
    EXECUTE format('SELECT to_jsonb(ARRAY[public.%I($1)::text])', p_name) INTO res USING p_site;
  ELSE
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM public.%I($1) x', p_name) INTO res USING p_site;
  END IF;
  RETURN res;
END $$;

-- A number from a register value: a plain number, or (after P5's "number plus note", D108b) an object whose "value" is the number.
CREATE OR REPLACE FUNCTION p4a_num(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric
              WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v #>> '{}')::numeric
              WHEN jsonb_typeof(v) = 'object' THEN public.p4a_num(v -> 'value') END
$$;

CREATE OR REPLACE FUNCTION p4a_date(v text) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT CASE WHEN v ~ '^\d{4}-\d{2}-\d{2}$' THEN v::date END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Site fields that a Change Control record can change (Q225): site.custom.<code>, the six scope flags and the site scenario
-- ---------------------------------------------------------------------------------------------------------------------
-- The value of a site field as Change Control text (Old Value / New Value). An empty field is '(none)'.
CREATE OR REPLACE FUNCTION p4a_site_value_text(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN v IS NULL OR v = 'null'::jsonb THEN '(none)' WHEN v = 'true'::jsonb THEN 'Yes' WHEN v = 'false'::jsonb THEN 'No' ELSE v #>> '{}' END
$$;

CREATE OR REPLACE FUNCTION p4a_scope_flags() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full', 'scope_te_ip_router_only'] $$;

-- The current value of the site field named by a field item, as text; NULL when the item names no known site field.
CREATE OR REPLACE FUNCTION p4a_site_current(p_site uuid, p_item text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; col text;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_item LIKE 'site.custom.%' THEN
    IF NOT EXISTS (SELECT 1 FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.task_code IS NULL AND d.is_active AND d.code = substr(p_item, 13)) THEN RETURN NULL; END IF;
    RETURN public.p4a_site_value_text(s.custom -> substr(p_item, 13));
  END IF;
  col := substr(p_item, 6);
  IF col = ANY (public.p4a_scope_flags()) THEN
    RETURN CASE (to_jsonb(s) ->> col) WHEN 'yes' THEN 'Yes' WHEN 'na' THEN 'N/A' ELSE '(none)' END;
  ELSIF col = 'site_scenario' THEN
    RETURN coalesce(s.site_scenario, '(none)');
  END IF;
  RETURN NULL;
END $$;

-- The new value of a site field from its Change Control text, as JSON (custom fields) or as the column text; raises a field error when invalid.
CREATE OR REPLACE FUNCTION p4a_site_parse(p_item text, p_text text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fd public.field_definitions%ROWTYPE; v jsonb; err text; t text := btrim(coalesce(p_text, '')); col text;
BEGIN
  IF p_item LIKE 'site.custom.%' THEN
    SELECT * INTO fd FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.task_code IS NULL AND d.is_active AND d.code = substr(p_item, 13);
    IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/field_item', 'unknown_site_field', 'No active site field has this code.'))); END IF;
    IF t IN ('', '(none)') THEN v := NULL;
    ELSIF fd.data_type::text = 'bool' THEN
      v := CASE WHEN lower(t) IN ('yes', 'true', '1') THEN 'true'::jsonb WHEN lower(t) IN ('no', 'false', '0') THEN 'false'::jsonb END;
      IF v IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/new_value', 'invalid', 'Yes or No.'))); END IF;
    ELSIF fd.data_type::text = 'number' THEN
      IF t !~ '^-?[0-9]+(\.[0-9]+)?$' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/new_value', 'invalid', 'A number.'))); END IF;
      v := to_jsonb(t::numeric);
    ELSE v := to_jsonb(t);
    END IF;
    IF v IS NULL AND fd.required THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/new_value', 'required', 'This site field is required.'))); END IF;
    IF v IS NOT NULL THEN
      err := public.custom_check_value(fd, v);
      IF err IS NOT NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/new_value', 'invalid', err))); END IF;
    END IF;
    RETURN coalesce(v, 'null'::jsonb);
  END IF;
  col := substr(p_item, 6);
  IF col = ANY (public.p4a_scope_flags()) THEN
    IF lower(t) IN ('yes', 'y') THEN RETURN to_jsonb('yes'::text); END IF;
    IF lower(t) IN ('n/a', 'na') THEN RETURN to_jsonb('na'::text); END IF;
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/new_value', 'invalid', 'A scope flag is Yes or N/A.')));
  ELSIF col = 'site_scenario' THEN
    IF t NOT IN ('New Build', 'Expansion', 'Hot Swap', 'Cold Swap', 'Relocation') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/new_value', 'invalid', 'New Build, Expansion, Hot Swap, Cold Swap or Relocation.')));
    END IF;
    RETURN to_jsonb(t);
  END IF;
  PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/data/field_item', 'unknown_site_field', 'Not a site field that Change Control can change.')));
  RETURN NULL;
END $$;

-- The submit checks of a site field change: a known field, a valid new value, and an Old Value that is still the site's value (no stale proposal).
CREATE OR REPLACE FUNCTION p4a_site_change_errors(p_site uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item text := p_data ->> 'field_item'; cur text;
BEGIN
  IF item IS NULL OR item NOT LIKE 'site.%' THEN RETURN '[]'::jsonb; END IF;
  cur := public.p4a_site_current(p_site, item);
  IF cur IS NULL THEN RETURN public.reg_err_item('/data/field_item', 'unknown_site_field', 'Not a site field that Change Control can change (site.custom.<code>, site.<scope flag>, site.site_scenario).'); END IF;
  BEGIN
    PERFORM public.p4a_site_parse(item, p_data ->> 'new_value');
  EXCEPTION WHEN raise_exception THEN
    RETURN public.reg_err_item('/data/new_value', 'invalid', 'The new value is not valid for this site field.');
  END;
  IF btrim(coalesce(p_data ->> 'old_value', '')) <> cur THEN
    RETURN public.reg_err_item('/data/old_value', 'old_value_changed', 'The site value is now "' || cur || '": correct the Old Value.');
  END IF;
  RETURN '[]'::jsonb;
END $$;

-- Applies an approved site field change to the site, audited; then the site is recalculated and P1's applicability runs when it exists.
CREATE OR REPLACE FUNCTION p4a_apply_site_change(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; item text; v jsonb; col text; before_ text; res jsonb; conflicts jsonb; c jsonb; real_conflicts jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  item := r.data ->> 'field_item';
  before_ := public.p4a_site_current(r.site_id, item);
  v := public.p4a_site_parse(item, r.data ->> 'new_value');
  IF item LIKE 'site.custom.%' THEN
    UPDATE public.sites SET custom = CASE WHEN v = 'null'::jsonb THEN custom - substr(item, 13) ELSE custom || jsonb_build_object(substr(item, 13), v) END, updated_at = clock_timestamp()
    WHERE id = r.site_id;
  ELSE
    col := substr(item, 6);
    IF col = 'site_scenario' THEN
      UPDATE public.sites SET site_scenario = v #>> '{}', delivery_scenario = replace(lower(v #>> '{}'), ' ', '_')::"DeliveryScenario", updated_at = clock_timestamp() WHERE id = r.site_id;
    ELSE
      EXECUTE format('UPDATE public.sites SET %I = $1::"ScopeFlag", updated_at = clock_timestamp() WHERE id = $2', col) USING v #>> '{}', r.site_id;
    END IF;
  END IF;
  res := jsonb_build_object('field', item, 'before', before_, 'after', public.p4a_site_current(r.site_id, item), 'record_id', r.id);
  PERFORM public.p4a_audit('site_change_applied', 'site', r.site_id::text, jsonb_build_object('field', item, 'value', before_), res,
    'approved Change Control ' || coalesce(r.data ->> 'change_id', r.id::text) || ' (Q225)', r.site_id, r.region_id);
  PERFORM public.p4a_hook('wf_apply_applicability', r.site_id);
  conflicts := public.p4a_hook('scope_scenario_conflicts', r.site_id);
  IF conflicts IS NOT NULL THEN
    FOR c IN SELECT * FROM jsonb_array_elements(conflicts) LOOP
      IF c IS NOT NULL AND c NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb, 'false'::jsonb, '""'::jsonb) THEN real_conflicts := real_conflicts || jsonb_build_array(c); END IF;
    END LOOP;
    IF jsonb_array_length(real_conflicts) > 0 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('conflicts', real_conflicts,
        'errors', public.reg_err_item('/data/new_value', 'scope_scenario_conflict', 'The scope and the scenario of the site conflict after this change (Q3): it cannot be approved.')));
    END IF;
  END IF;
  PERFORM public.calc_refresh_site(r.site_id);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q225: the direct edit refuses rule-affecting fields; a proposal opens a Change Control draft
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_save_custom(p_site uuid, p_seen timestamptz, p_patch jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.sites%ROWTYPE; k text; fd public.field_definitions%ROWTYPE; acc text; err text; v jsonb;
  errs jsonb := '[]'::jsonb; before_ jsonb := '{}'::jsonb; after_ jsonb := '{}'::jsonb; newc jsonb; regs int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  regs := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (regs IS NOT NULL AND NOT (s.region_id = ANY (regs))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  PERFORM public.wf_require_grant(s.region_id, 'edit');
  IF p_seen IS NOT NULL AND s.updated_at IS DISTINCT FROM p_seen THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The site changed since you read it. Reload and try again.'));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/custom', 'code', 'required', 'message', 'Send at least one field.'))));
  END IF;
  newc := coalesce(s.custom, '{}'::jsonb);
  FOR k IN SELECT jsonb_object_keys(p_patch) ORDER BY 1 LOOP
    SELECT * INTO fd FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.code = k AND d.task_code IS NULL;
    v := p_patch -> k;
    IF NOT FOUND OR NOT fd.is_active THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'unknown_field', 'message', 'No active site field has this code.'));
      CONTINUE;
    END IF;
    acc := coalesce(public.app_resolve_field_access(actor, fd.id)::text, 'edit');
    IF acc <> 'edit' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'field_read_only', 'message', 'You may not edit this field.'));
      CONTINUE;
    END IF;
    -- Q225: a field that changes rules is changed by an approved proposal only; the approved value stays until the decision
    IF fd.requires_approval THEN
      err := CASE WHEN v IS NULL OR v = 'null'::jsonb THEN NULL ELSE public.custom_check_value(fd, v) END;
      IF err IS NOT NULL THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'invalid', 'message', err));
      ELSIF (newc -> k) IS DISTINCT FROM (CASE WHEN v = 'null'::jsonb THEN NULL ELSE v END) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'approval_required',
          'message', 'This field changes permits or scope: propose the change; it applies after L2 approval (Q225).'));
      END IF;
      CONTINUE;
    END IF;
    IF v IS NULL OR v = 'null'::jsonb THEN
      IF fd.required THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'required', 'message', 'This field is required.'));
        CONTINUE;
      END IF;
      before_ := before_ || jsonb_build_object(k, newc -> k);
      after_ := after_ || jsonb_build_object(k, NULL);
      newc := newc - k;
    ELSE
      err := public.custom_check_value(fd, v);
      IF err IS NOT NULL THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'invalid', 'message', err));
        CONTINUE;
      END IF;
      before_ := before_ || jsonb_build_object(k, newc -> k);
      after_ := after_ || jsonb_build_object(k, v);
      newc := newc || jsonb_build_object(k, v);
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF newc IS NOT DISTINCT FROM coalesce(s.custom, '{}'::jsonb) THEN
    RETURN jsonb_build_object('updated_at', s.updated_at, 'changed', false);
  END IF;
  UPDATE public.sites SET custom = newc, updated_at = clock_timestamp() WHERE id = p_site RETURNING * INTO s;
  PERFORM public.log_audit_write('site_custom_update', 'site', p_site::text, jsonb_build_object('custom', before_), jsonb_build_object('custom', after_),
    nullif(btrim(coalesce(p_reason, '')), ''), p_site, s.region_id);
  RETURN jsonb_build_object('updated_at', s.updated_at, 'changed', true);
END $$;

-- p_patch: {code: value} of fields that require approval. One Change Control draft per field, entered by the caller as L1 (the caller must be an L1
-- holder of the Change Control row and hold its create right in the site's region; reg_save_record checks it). Returns {items: [{field, record_id, change_id}]}.
CREATE OR REPLACE FUNCTION site_propose_change(p_site uuid, p_patch jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.sites%ROWTYPE; regs int[]; k text; v jsonb; fd public.field_definitions%ROWTYPE; acc text; err text;
  errs jsonb := '[]'::jsonb; items jsonb := '[]'::jsonb; rid uuid; cid text; oldt text; newt text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  regs := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (regs IS NOT NULL AND NOT (s.region_id = ANY (regs))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN
    errs := errs || public.reg_err_item('/reason', 'required', 'A proposal needs a reason.');
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    errs := errs || public.reg_err_item('/custom', 'required', 'Send at least one field.');
  ELSE
    FOR k, v IN SELECT * FROM jsonb_each(p_patch) ORDER BY 1 LOOP
      SELECT * INTO fd FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.code = k AND d.task_code IS NULL AND d.is_active;
      IF NOT FOUND THEN errs := errs || public.reg_err_item('/custom/' || k, 'unknown_field', 'No active site field has this code.'); CONTINUE; END IF;
      IF NOT fd.requires_approval THEN errs := errs || public.reg_err_item('/custom/' || k, 'no_approval_needed', 'This field is edited directly.'); CONTINUE; END IF;
      acc := coalesce(public.app_resolve_field_access(actor, fd.id)::text, 'edit');
      IF acc <> 'edit' THEN errs := errs || public.reg_err_item('/custom/' || k, 'field_read_only', 'You may not edit this field.'); CONTINUE; END IF;
      IF v = 'null'::jsonb THEN
        IF fd.required THEN errs := errs || public.reg_err_item('/custom/' || k, 'required', 'This field is required.'); CONTINUE; END IF;
      ELSE
        err := public.custom_check_value(fd, v);
        IF err IS NOT NULL THEN errs := errs || public.reg_err_item('/custom/' || k, 'invalid', err); CONTINUE; END IF;
      END IF;
      IF (s.custom -> k) IS NOT DISTINCT FROM (CASE WHEN v = 'null'::jsonb THEN NULL ELSE v END) THEN
        errs := errs || public.reg_err_item('/custom/' || k, 'unchanged', 'The site has this value already.');
      END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_patch) ORDER BY 1 LOOP
    oldt := public.p4a_site_value_text(s.custom -> k);
    newt := public.p4a_site_value_text(v);
    cid := 'SFC-' || s.site_code || '-' || upper(k) || '-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4);
    rid := public.reg_save_record('change_control', NULL, NULL, p_site, NULL,
      jsonb_build_object('change_id', cid, 'change_type', 'Scope Change', 'change_scope', 'Field', 'field_item', 'site.custom.' || k, 'old_value', oldt, 'new_value', newt,
                         'reason', btrim(p_reason), 'request_date', current_date::text), NULL, NULL, false);
    items := items || jsonb_build_array(jsonb_build_object('field', k, 'record_id', rid, 'change_id', cid, 'old_value', oldt, 'new_value', newt));
  END LOOP;
  PERFORM public.log_audit_write('site_change_proposed', 'site', p_site::text, NULL, jsonb_build_object('proposals', items), btrim(p_reason), p_site, s.region_id);
  RETURN jsonb_build_object('items', items);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. As-Built parts (Q113) and the Warehouse lookups of the item types (Q108)
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_definitions SET record_types = ARRAY['cw_part', 'te_part'], multiple_per_site = true WHERE register_key = 'as_built';
UPDATE template_definitions SET match_keys = '[["site_code","record_type"]]'::jsonb WHERE register_key = 'as_built' AND kind = 'register';
-- BU is filled by the CW part's submission (never typed); EF stays typed for a vendor submission before GSDN Workspace entry, else the submission date fills it.
UPDATE register_fields SET derived = true, section = 'CW submission' WHERE register_key = 'as_built' AND code = 'cw_as_built_submitted';
UPDATE task_field_sources SET record_type = 'cw_part' WHERE register_key = 'as_built' AND field_code = 'cw_as_built_submitted';
UPDATE task_field_sources SET record_type = 'te_part' WHERE register_key = 'as_built' AND field_code = 'as_built_date';

-- Which part owns a field of the As-Built register.
CREATE OR REPLACE FUNCTION p4a_as_built_part(p_code text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_code IN ('part_not_applicable', 'na_reason') THEN 'both'
    WHEN p_code IN ('cw_as_built_submitted', 'cw_submitted_date') THEN 'cw_part'
    WHEN p_code LIKE 'q\_%' THEN coalesce((SELECT CASE a.section WHEN 'cw' THEN 'cw_part' ELSE 'te_part' END FROM public.as_built_items a WHERE 'q_' || lower(a.code) = p_code), 'te_part')
    ELSE 'te_part' END
$$;

-- Data migration: every existing record gets its part. A record with TE values only is the TE part; any other one is the CW part, and when its
-- version in force also holds TE values, those values move to a new TE part record of the site (approved as it was, so EF is kept).
DO $$
DECLARE r record; ent uuid; te jsonb; k text;
BEGIN
  UPDATE register_records x SET record_type = CASE
      WHEN NOT EXISTS (SELECT 1 FROM public.register_records y, jsonb_object_keys(y.data) kk WHERE y.entity_id = x.entity_id AND public.p4a_as_built_part(kk) = 'cw_part')
       AND EXISTS (SELECT 1 FROM public.register_records y, jsonb_object_keys(y.data) kk WHERE y.entity_id = x.entity_id AND public.p4a_as_built_part(kk) = 'te_part')
      THEN 'te_part' ELSE 'cw_part' END
  WHERE x.register_key = 'as_built' AND x.record_type IS NULL;
  FOR r IN SELECT * FROM register_records x WHERE x.register_key = 'as_built' AND x.record_type = 'cw_part' AND x.is_current AND x.state = 'approved'
             AND NOT EXISTS (SELECT 1 FROM register_records t WHERE t.register_key = 'as_built' AND t.site_id = x.site_id AND t.record_type = 'te_part' AND t.state <> 'voided') LOOP
    te := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(r.data) LOOP
      IF public.p4a_as_built_part(k) = 'te_part' THEN te := te || jsonb_build_object(k, r.data -> k); END IF;
    END LOOP;
    IF te = '{}'::jsonb THEN CONTINUE; END IF;
    ent := gen_random_uuid();
    INSERT INTO register_records (entity_id, version_no, is_current, register_key, record_type, site_id, region_id, is_global, state, current_level, levels_required, path_frozen_at,
      data, custom, source, created_by, created_at, updated_at, submitted_at, approved_at, approved_by)
    VALUES (ent, 1, true, 'as_built', 'te_part', r.site_id, r.region_id, false, 'approved', r.current_level, r.levels_required, r.path_frozen_at,
      te, '{}'::jsonb, r.source, r.created_by, r.created_at, now(), r.submitted_at, r.approved_at, r.approved_by);
    UPDATE register_records SET data = (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(r.data) e WHERE public.p4a_as_built_part(e.key) <> 'te_part')
    WHERE id = r.id;
    INSERT INTO audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
    VALUES ('as_built_part_split', 'register_record', r.id::text, r.site_id, r.region_id, jsonb_build_object('data', r.data),
            jsonb_build_object('cw_part', r.id, 'te_part_entity', ent, 'te_data', te), 'migration 0062 (Q113): the As-Built record is split into a CW and a TE part');
  END LOOP;
END $$;
CREATE UNIQUE INDEX register_records_as_built_part_idx ON register_records (site_id, record_type) WHERE version_no = 1 AND state <> 'voided' AND register_key = 'as_built';

-- Q108: the item-type fields pick an active Warehouse item of their group. The list follows the Warehouse catalogue; a group with no active item keeps free text.
CREATE TABLE as_built_type_sources (
  field_code TEXT PRIMARY KEY,
  item_group TEXT NOT NULL
);
ALTER TABLE as_built_type_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE as_built_type_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON as_built_type_sources FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON as_built_type_sources FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
INSERT INTO as_built_type_sources (field_code, item_group) VALUES ('wl_antenna_type', 'WL'), ('mw_antenna_type', 'MW'), ('router_type', 'IP') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION p4a_sync_as_built_types() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; opts jsonb;
BEGIN
  FOR s IN SELECT * FROM public.as_built_type_sources LOOP
    SELECT jsonb_agg(w.item_code ORDER BY w.item_code) INTO opts FROM public.warehouse_items w WHERE w.item_group = s.item_group AND w.is_active;
    UPDATE public.register_fields SET options = opts WHERE register_key = 'as_built' AND code = s.field_code AND options IS DISTINCT FROM opts;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER p4a_sync_as_built_types AFTER INSERT OR UPDATE OR DELETE ON warehouse_items FOR EACH STATEMENT EXECUTE FUNCTION p4a_sync_as_built_types();
DO $$
DECLARE s record; opts jsonb;
BEGIN
  FOR s IN SELECT * FROM as_built_type_sources LOOP
    SELECT jsonb_agg(w.item_code ORDER BY w.item_code) INTO opts FROM warehouse_items w WHERE w.item_group = s.item_group AND w.is_active;
    UPDATE register_fields SET options = opts WHERE register_key = 'as_built' AND code = s.field_code;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Before a record is written: the As-Built part of a new record (inferred from its values when the caller names none) and one record per site and part
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION p4a_as_built_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE existing uuid;
BEGIN
  IF NEW.record_type IS NULL THEN
    NEW.record_type := CASE WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.data) k WHERE public.p4a_as_built_part(k) = 'te_part') THEN 'te_part' ELSE 'cw_part' END;
  END IF;
  IF NEW.version_no = 1 THEN
    SELECT x.id INTO existing FROM public.register_records x
    WHERE x.register_key = 'as_built' AND x.site_id = NEW.site_id AND x.record_type = NEW.record_type AND x.version_no = 1 AND x.state <> 'voided' AND x.entity_id <> NEW.entity_id;
    IF existing IS NOT NULL THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('existing_id', existing, 'detail', 'This site already has an As-Built ' || replace(NEW.record_type, '_', ' ') || ': create a new version of it (Q55, Q113).'));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_p4a_as_built_insert BEFORE INSERT ON register_records FOR EACH ROW WHEN (NEW.register_key = 'as_built') EXECUTE FUNCTION p4a_as_built_insert();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. At submission (the record leaves Data Entry): the P4a rules, and BU / EF of the As-Built parts
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION p4a_submit_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := NEW.data; errs jsonb := '[]'::jsonb; ct text := NEW.data ->> 'change_type'; k text; susp public.change_requests%ROWTYPE; eff date; me public.change_requests%ROWTYPE;
  na boolean; v numeric; it record; grp text;
BEGIN
  IF NEW.register_key = 'change_control' THEN
    IF d ? 'suspension_start' AND ct IS DISTINCT FROM 'Suspension' THEN errs := errs || public.reg_err_item('/data/suspension_start', 'not_applicable', 'The suspension start belongs to a Suspension.'); END IF;
    IF d ? 'resumption_date' AND ct IS DISTINCT FROM 'Resumption' THEN errs := errs || public.reg_err_item('/data/resumption_date', 'not_applicable', 'The resumption date belongs to a Resumption.'); END IF;
    SELECT * INTO me FROM public.change_requests c WHERE c.id = NEW.entity_id;
    IF d ? 'withdrawn' THEN
      IF NEW.version_no = 1 OR me.id IS NULL THEN
        errs := errs || public.reg_err_item('/data/withdrawn', 'not_applicable', 'Only an approved change is withdrawn, with a new version of it. Void a draft instead.');
      ELSIF ct = 'Suspension' AND me.paired_change_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.change_requests rr WHERE rr.id = me.paired_change_id AND rr.status IN ('approved', 'applied')) THEN
        errs := errs || public.reg_err_item('/data/withdrawn', 'resumed_already', 'A resumption ends this suspension: withdraw the resumption first.');
      END IF;
    ELSIF ct = 'Resumption' THEN
      -- the suspension it ends: approved, not withdrawn, not ended by another resumption, and starting no later than the resumption
      eff := coalesce(public.p4a_date(d ->> 'resumption_date'), current_date);
      SELECT c.* INTO susp FROM public.change_requests c
      WHERE c.site_id = NEW.site_id AND c.kind = 'suspension' AND c.status IN ('approved', 'applied') AND c.id <> NEW.entity_id
        AND (c.paired_change_id IS NULL OR c.paired_change_id = NEW.entity_id OR NOT EXISTS (SELECT 1 FROM public.change_requests o WHERE o.id = c.paired_change_id AND o.status IN ('approved', 'applied')))
      ORDER BY coalesce(c.suspension_start, c.approval_date) DESC LIMIT 1;
      IF susp.id IS NULL THEN
        errs := errs || public.reg_err_item('/data/change_type', 'no_open_suspension', 'The site has no approved suspension that is still open.');
      ELSIF eff < coalesce(susp.suspension_start, susp.approval_date) THEN
        errs := errs || public.reg_err_item('/data/resumption_date', 'before_suspension', 'The resumption is before the start of the suspension (' || coalesce(susp.suspension_start, susp.approval_date)::text || ').');
      END IF;
    END IF;
    IF ct IN ('Scope Change', 'Data Correction') AND NOT (d ? 'withdrawn') THEN errs := errs || public.p4a_site_change_errors(NEW.site_id, d); END IF;

  ELSIF NEW.register_key = 'as_built' THEN
    na := lower(coalesce(d ->> 'part_not_applicable', '')) = 'yes';
    FOR k IN SELECT jsonb_object_keys(d) LOOP
      IF public.p4a_as_built_part(k) NOT IN ('both', NEW.record_type) THEN
        errs := errs || public.reg_err_item('/data/' || k, 'not_applicable', 'This field belongs to the ' || replace(public.p4a_as_built_part(k), '_', ' ') || ' (Q113).');
      ELSIF na AND k NOT IN ('part_not_applicable', 'na_reason') THEN
        errs := errs || public.reg_err_item('/data/' || k, 'not_applicable', 'A part that does not apply holds no values.');
      END IF;
    END LOOP;
    IF na AND btrim(coalesce(d ->> 'na_reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/na_reason', 'required', 'N/A needs a reason.'); END IF;
    IF NOT na AND d ? 'na_reason' THEN errs := errs || public.reg_err_item('/data/na_reason', 'not_applicable', 'An N/A reason belongs to a part that does not apply.'); END IF;
    -- Q108: whole numbers also for the unit qty (pieces and sets are checked since 0027)
    FOR it IN SELECT 'q_' || lower(a.code) AS fc FROM public.as_built_items a WHERE lower(a.unit) = 'qty' AND d ? ('q_' || lower(a.code)) LOOP
      v := public.p4a_num(d -> it.fc);
      IF v IS NOT NULL AND v <> trunc(v) THEN errs := errs || public.reg_err_item('/data/' || it.fc, 'whole_units', 'No fraction in whole units.'); END IF;
    END LOOP;
    -- Q108: a type field picks an item of its Warehouse group (when the group has items; a value kept from before is not checked again)
    FOR it IN SELECT s.field_code, s.item_group FROM public.as_built_type_sources s WHERE d ? s.field_code LOOP
      IF EXISTS (SELECT 1 FROM public.warehouse_items w WHERE w.item_group = it.item_group AND w.is_active)
         AND NOT EXISTS (SELECT 1 FROM public.warehouse_items w WHERE w.item_group = it.item_group AND w.item_code = d ->> it.field_code)
         AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = NEW.entity_id AND o.is_current AND o.data ->> it.field_code = d ->> it.field_code) THEN
        errs := errs || public.reg_err_item('/data/' || it.field_code, 'not_in_warehouse', 'Pick an item of the Warehouse group ' || it.item_group || ' (Q108).');
      END IF;
    END LOOP;
    IF jsonb_array_length(errs) = 0 THEN
      -- Q113: BU and EF come from the part's submission, never from its approval
      IF NEW.record_type = 'cw_part' THEN
        NEW.data := NEW.data || jsonb_build_object('cw_as_built_submitted', CASE WHEN na THEN 'N/A' ELSE 'Yes' END, 'cw_submitted_date', current_date::text);
      ELSIF NOT na AND NOT (d ? 'as_built_date') THEN
        NEW.data := NEW.data || jsonb_build_object('as_built_date', current_date::text);
      END IF;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p4a_submit_check BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (OLD.state = 'entry' AND NEW.state IN ('in_review', 'in_approval', 'approved') AND NEW.register_key IN ('change_control', 'as_built'))
  EXECUTE FUNCTION p4a_submit_check();

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The feeds (final approval only)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION p4a_feed_change(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.register_records%ROWTYPE; d jsonb; ct text; k "ChangeKind"; appr date; wd boolean; st "ChangeStatus"; eff_s date; eff_r date; from_appr boolean := false;
  pair uuid; code text; req uuid; before_ jsonb; after_ jsonb; applied_ jsonb; prev text; cur public.change_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;   -- re-read: the approval fields of Q45 are in the data now
  d := r.data; ct := d ->> 'change_type';
  k := CASE ct WHEN 'Suspension' THEN 'suspension' WHEN 'Resumption' THEN 'resumption' WHEN 'Scope Change' THEN 'scope_change' WHEN 'Baseline Re-plan' THEN 'date_change' ELSE 'other' END;
  appr := coalesce(public.p4a_date(d ->> 'approval_date'), r.approved_at::date, current_date);
  wd := lower(coalesce(d ->> 'withdrawn', '')) = 'yes';
  st := CASE WHEN wd THEN 'rejected' ELSE 'approved' END;
  SELECT * INTO cur FROM public.change_requests WHERE id = r.entity_id;
  before_ := CASE WHEN cur.id IS NULL THEN NULL ELSE to_jsonb(cur) END;
  IF k = 'suspension' THEN eff_s := public.p4a_date(d ->> 'suspension_start'); from_appr := eff_s IS NULL; eff_s := coalesce(eff_s, appr); END IF;
  IF k = 'resumption' THEN
    eff_r := public.p4a_date(d ->> 'resumption_date'); from_appr := eff_r IS NULL; eff_r := coalesce(eff_r, appr);
    SELECT c.id INTO pair FROM public.change_requests c
    WHERE c.site_id = r.site_id AND c.kind = 'suspension' AND c.status IN ('approved', 'applied') AND c.id <> r.entity_id
      AND (c.paired_change_id IS NULL OR c.paired_change_id = r.entity_id OR NOT EXISTS (SELECT 1 FROM public.change_requests o WHERE o.id = c.paired_change_id AND o.status IN ('approved', 'applied')))
      AND coalesce(c.suspension_start, c.approval_date) <= eff_r
    ORDER BY coalesce(c.suspension_start, c.approval_date) DESC LIMIT 1;
  END IF;
  code := coalesce(nullif(d ->> 'change_id', ''), 'CC-' || r.entity_id::text);
  IF EXISTS (SELECT 1 FROM public.change_requests c WHERE c.change_code = code AND c.id <> r.entity_id) THEN code := code || '-' || substr(r.entity_id::text, 1, 8); END IF;
  SELECT x.created_by INTO req FROM public.register_records x WHERE x.entity_id = r.entity_id ORDER BY x.version_no LIMIT 1;
  req := coalesce(req, r.created_by, r.approved_by);
  INSERT INTO public.change_requests (id, change_code, site_id, region_id, is_global, kind, scope_item, old_value, new_value, reason, request_date, status, approved_by,
    approval_date, ticket_id, requested_by, suspension_start, resumption_date, paired_change_id, custom, register_record_id, record_version, change_type, withdrawn, effective_from_approval)
  VALUES (r.entity_id, code, r.site_id, r.region_id, r.is_global, k, d ->> 'field_item', d ->> 'old_value', d ->> 'new_value', d ->> 'reason', public.p4a_date(d ->> 'request_date'), st,
    r.approved_by, appr, d ->> 'change_ticket_id', req, eff_s, eff_r, CASE WHEN k = 'resumption' AND NOT wd THEN pair END, r.custom, r.id, r.version_no, ct, wd, from_appr)
  ON CONFLICT (id) DO UPDATE SET change_code = EXCLUDED.change_code, kind = EXCLUDED.kind, scope_item = EXCLUDED.scope_item, old_value = EXCLUDED.old_value,
    new_value = EXCLUDED.new_value, reason = EXCLUDED.reason, request_date = EXCLUDED.request_date, status = EXCLUDED.status, approved_by = EXCLUDED.approved_by,
    approval_date = EXCLUDED.approval_date, ticket_id = EXCLUDED.ticket_id, suspension_start = EXCLUDED.suspension_start, resumption_date = EXCLUDED.resumption_date,
    paired_change_id = CASE WHEN EXCLUDED.kind = 'suspension' THEN change_requests.paired_change_id ELSE EXCLUDED.paired_change_id END,
    custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version, change_type = EXCLUDED.change_type,
    withdrawn = EXCLUDED.withdrawn, effective_from_approval = EXCLUDED.effective_from_approval;
  -- the pair of a suspension and the resumption that ends it
  UPDATE public.change_requests SET paired_change_id = NULL WHERE kind = 'suspension' AND paired_change_id = r.entity_id AND (k <> 'resumption' OR wd OR id IS DISTINCT FROM pair);
  IF k = 'resumption' AND NOT wd AND pair IS NOT NULL THEN UPDATE public.change_requests SET paired_change_id = r.entity_id WHERE id = pair; END IF;
  IF k <> 'suspension' OR wd THEN
    UPDATE public.change_requests SET paired_change_id = NULL WHERE id = r.entity_id AND kind = 'suspension';
  END IF;
  -- a site field change applies to the site (Q225)
  IF NOT wd AND ct IN ('Scope Change', 'Data Correction') AND coalesce(d ->> 'field_item', '') LIKE 'site.%' THEN
    applied_ := public.p4a_apply_site_change(r.id);
    UPDATE public.change_requests SET status = 'applied', applied = applied_ WHERE id = r.entity_id;
  END IF;
  -- Cancellation (rules.md 2.4): the site leaves the execution scope; a withdrawal brings its earlier status back
  IF ct = 'Cancellation' AND r.site_id IS NOT NULL THEN
    SELECT s.overall_status::text INTO prev FROM public.sites s WHERE s.id = r.site_id;
    IF NOT wd AND prev <> 'cancelled' THEN
      UPDATE public.change_requests SET previous_overall_status = prev WHERE id = r.entity_id;
      UPDATE public.sites SET overall_status = 'cancelled', updated_at = clock_timestamp() WHERE id = r.site_id;
      PERFORM public.p4a_audit('site_cancelled', 'site', r.site_id::text, jsonb_build_object('overall_status', prev), jsonb_build_object('overall_status', 'cancelled'),
        'approved Change Control ' || code || ' (Cancellation)', r.site_id, r.region_id);
    ELSIF wd AND prev = 'cancelled' THEN
      SELECT coalesce(c.previous_overall_status, 'in_progress') INTO prev FROM public.change_requests c WHERE c.id = r.entity_id;
      UPDATE public.sites SET overall_status = prev::"OverallStatus", updated_at = clock_timestamp() WHERE id = r.site_id;
      PERFORM public.p4a_audit('site_cancellation_withdrawn', 'site', r.site_id::text, jsonb_build_object('overall_status', 'cancelled'), jsonb_build_object('overall_status', prev),
        'withdrawn Change Control ' || code, r.site_id, r.region_id);
    END IF;
  END IF;
  SELECT to_jsonb(c) INTO after_ FROM public.change_requests c WHERE c.id = r.entity_id;
  PERFORM public.p4a_audit(CASE WHEN before_ IS NULL THEN 'change_request_fed' ELSE 'change_request_refed' END, 'change_request', r.entity_id::text, before_, after_,
    'approved Change Control ' || code || ' version ' || r.version_no, r.site_id, r.region_id);
END $$;

CREATE OR REPLACE FUNCTION p4a_feed_rf(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb; s public.sites%ROWTYPE; s2 public.sites%ROWTYPE; scen text; changed jsonb := '{}'::jsonb; c text;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  INSERT INTO public.rf_design_records (id, site_id, region_id, nominal_plan_issue_date, nominal_lat, nominal_lon, search_ring_radius_m, search_ring_received_date,
    antenna_height_m, sectors, azimuths, tilt, tss_plan_date, custom, register_record_id, record_version)
  VALUES (r.entity_id, r.site_id, r.region_id, public.p4a_date(d ->> 'nominal_plan_issue_date'), public.p4a_num(d -> 'nominal_latitude'), public.p4a_num(d -> 'nominal_longitude'),
    round(public.p4a_num(d -> 'search_ring_radius'))::int, public.p4a_date(d ->> 'search_ring_received'), public.p4a_num(d -> 'antenna_height'), round(public.p4a_num(d -> 'sectors'))::int,
    d ->> 'azimuths', d ->> 'tilt', public.p4a_date(d ->> 'tss_plan'), r.custom, r.id, r.version_no)
  ON CONFLICT (id) DO UPDATE SET nominal_plan_issue_date = EXCLUDED.nominal_plan_issue_date, nominal_lat = EXCLUDED.nominal_lat, nominal_lon = EXCLUDED.nominal_lon,
    search_ring_radius_m = EXCLUDED.search_ring_radius_m, search_ring_received_date = EXCLUDED.search_ring_received_date, antenna_height_m = EXCLUDED.antenna_height_m,
    sectors = EXCLUDED.sectors, azimuths = EXCLUDED.azimuths, tilt = EXCLUDED.tilt, tss_plan_date = EXCLUDED.tss_plan_date, custom = EXCLUDED.custom,
    register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  -- the site identity (Master C:Q): only the values the record holds; an empty value never clears the site
  SELECT * INTO s FROM public.sites WHERE id = r.site_id FOR UPDATE;
  scen := d ->> 'site_scenario';
  UPDATE public.sites SET
    owner_site_id = coalesce(d ->> 'site_owner_id', owner_site_id), sub_region = coalesce(d ->> 'sub_region', sub_region),
    latitude = coalesce(public.p4a_num(d -> 'latitude'), latitude), longitude = coalesce(public.p4a_num(d -> 'longitude'), longitude),
    site_type = coalesce(d ->> 'site_type', site_type), site_scenario = coalesce(scen, site_scenario),
    delivery_scenario = CASE WHEN scen IN ('New Build', 'Expansion', 'Hot Swap', 'Cold Swap', 'Relocation') THEN replace(lower(scen), ' ', '_')::"DeliveryScenario" ELSE delivery_scenario END,
    tower_owner = coalesce(d ->> 'tower_owner', tower_owner), existing_or_new = coalesce(d ->> 'existing_or_new', existing_or_new), rt_or_gf = coalesce(d ->> 'rt_or_gf', rt_or_gf),
    tower_type = coalesce(d ->> 'tower_type', tower_type), tower_height_m = coalesce(public.p4a_num(d -> 'tower_height'), tower_height_m),
    rf_survey_date = coalesce(public.p4a_date(d ->> 'rf_survey_actual_date'), rf_survey_date)
  WHERE id = r.site_id RETURNING * INTO s2;
  FOREACH c IN ARRAY ARRAY['owner_site_id', 'sub_region', 'latitude', 'longitude', 'site_type', 'site_scenario', 'delivery_scenario', 'tower_owner', 'existing_or_new', 'rt_or_gf',
                           'tower_type', 'tower_height_m', 'rf_survey_date'] LOOP
    IF (to_jsonb(s) -> c) IS DISTINCT FROM (to_jsonb(s2) -> c) THEN changed := changed || jsonb_build_object(c, jsonb_build_object('before', to_jsonb(s) -> c, 'after', to_jsonb(s2) -> c)); END IF;
  END LOOP;
  IF changed <> '{}'::jsonb THEN
    UPDATE public.sites SET updated_at = clock_timestamp() WHERE id = r.site_id;
    PERFORM public.p4a_audit('site_identity_fed', 'site', r.site_id::text, NULL, jsonb_build_object('changes', changed, 'record_id', r.id),
      'approved RF & Design record version ' || r.version_no, r.site_id, r.region_id);
    IF changed ? 'delivery_scenario' THEN PERFORM public.p4a_hook('wf_apply_applicability', r.site_id); END IF;
    PERFORM public.calc_refresh_site(r.site_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION p4a_feed_acquisition(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb; old_d date; new_d date;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  INSERT INTO public.acquisition_candidates (id, site_id, region_id, candidate_no, latitude, longitude, address, submitted_date, mw_los_check, test_pit_result, tss_date, selected,
    selection_date, owner_name, ownership_type, contact_person, phone, email, negotiation_start, contract_no, contract_signoff_date, lease_expiry_date, title_verified, custom,
    register_record_id, record_version)
  VALUES (r.entity_id, r.site_id, r.region_id, coalesce(d ->> 'candidate', '?'), public.p4a_num(d -> 'latitude'), public.p4a_num(d -> 'longitude'), d ->> 'address',
    public.p4a_date(d ->> 'candidate_submitted_date'), d ->> 'mw_los_check', d ->> 'test_pit_result', public.p4a_date(d ->> 'tss_date'), coalesce(d ->> 'selected', '') = 'Yes',
    public.p4a_date(d ->> 'selection_date'), d ->> 'owner_landlord', d ->> 'ownership_type', d ->> 'contact_person', d ->> 'phone', d ->> 'email',
    public.p4a_date(d ->> 'negotiation_start_date'), d ->> 'contract_no', public.p4a_date(d ->> 'contract_signoff_date'), public.p4a_date(d ->> 'lease_expiry_date'),
    CASE d ->> 'title_verified' WHEN 'Yes' THEN true WHEN 'No' THEN false END, r.custom, r.id, r.version_no)
  ON CONFLICT (id) DO UPDATE SET candidate_no = EXCLUDED.candidate_no, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, address = EXCLUDED.address,
    submitted_date = EXCLUDED.submitted_date, mw_los_check = EXCLUDED.mw_los_check, test_pit_result = EXCLUDED.test_pit_result, tss_date = EXCLUDED.tss_date,
    selected = EXCLUDED.selected, selection_date = EXCLUDED.selection_date, owner_name = EXCLUDED.owner_name, ownership_type = EXCLUDED.ownership_type,
    contact_person = EXCLUDED.contact_person, phone = EXCLUDED.phone, email = EXCLUDED.email, negotiation_start = EXCLUDED.negotiation_start,
    contract_no = EXCLUDED.contract_no, contract_signoff_date = EXCLUDED.contract_signoff_date, lease_expiry_date = EXCLUDED.lease_expiry_date,
    title_verified = EXCLUDED.title_verified, custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  -- Master T: the contract sign-off of the selected candidate (none selected = no acquisition date)
  SELECT acquisition_date INTO old_d FROM public.sites WHERE id = r.site_id;
  SELECT max(a.contract_signoff_date) INTO new_d FROM public.acquisition_candidates a WHERE a.site_id = r.site_id AND a.selected;
  IF new_d IS DISTINCT FROM old_d THEN
    UPDATE public.sites SET acquisition_date = new_d, updated_at = clock_timestamp() WHERE id = r.site_id;
    PERFORM public.p4a_audit('site_acquisition_fed', 'site', r.site_id::text, jsonb_build_object('acquisition_date', old_d), jsonb_build_object('acquisition_date', new_d, 'record_id', r.id),
      'approved Acquisition record (Master T)', r.site_id, r.region_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION p4a_feed_readiness(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  INSERT INTO public.readiness_handover (id, site_id, region_id, commissioning_power_safe, commissioning_power_safe_date, uplink_ready_date, om_checklist, na_reason, om_accepted_by,
    om_acceptance_date, site_access_keys_handed, hoto_package_date, legacy_handover_date, obligations_closure_date, closure_approved_by, closure_approval_date, closure_ready, custom,
    register_record_id, record_version)
  VALUES (r.entity_id, r.site_id, r.region_id, CASE WHEN d ? 'commissioning_power_safe_date' THEN true END, public.p4a_date(d ->> 'commissioning_power_safe_date'),
    public.p4a_date(d ->> 'uplink_ready_date'), d ->> 'om_checklist', d ->> 'na_reason', d ->> 'om_accepted_by', public.p4a_date(d ->> 'om_acceptance_date'),
    CASE WHEN d ? 'access_keys_handover_date' THEN true END, public.p4a_date(d ->> 'hoto_package_actual_date'), public.p4a_date(d ->> 'legacy_handover_date'),
    public.p4a_date(d ->> 'obligations_closure_date'), d ->> 'closure_approved_by', public.p4a_date(d ->> 'closure_approval_date'),
    (d ? 'obligations_closure_date' AND d ? 'closure_approval_date'), r.custom, r.id, r.version_no)
  ON CONFLICT (id) DO UPDATE SET commissioning_power_safe = EXCLUDED.commissioning_power_safe, commissioning_power_safe_date = EXCLUDED.commissioning_power_safe_date,
    uplink_ready_date = EXCLUDED.uplink_ready_date, om_checklist = EXCLUDED.om_checklist, na_reason = EXCLUDED.na_reason, om_accepted_by = EXCLUDED.om_accepted_by,
    om_acceptance_date = EXCLUDED.om_acceptance_date, site_access_keys_handed = EXCLUDED.site_access_keys_handed, hoto_package_date = EXCLUDED.hoto_package_date,
    legacy_handover_date = EXCLUDED.legacy_handover_date, obligations_closure_date = EXCLUDED.obligations_closure_date, closure_approved_by = EXCLUDED.closure_approved_by,
    closure_approval_date = EXCLUDED.closure_approval_date, closure_ready = EXCLUDED.closure_ready, custom = EXCLUDED.custom,
    register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
END $$;

CREATE OR REPLACE FUNCTION p4a_status(p_text text) RETURNS "RegisterStatus"
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN lower(coalesce(p_text, '')) ~ '^(closed|resolved|done|cancel)' THEN 'closed' WHEN lower(coalesce(p_text, '')) ~ '^(in.?progress|ongoing|mitigat)' THEN 'in_progress'
              WHEN lower(coalesce(p_text, '')) IN ('n/a', 'na') THEN 'na' ELSE 'open' END::"RegisterStatus"
$$;

CREATE OR REPLACE FUNCTION p4a_feed_issue_risk(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  IF r.register_key = 'issues' THEN
    IF r.site_id IS NULL OR public.p4a_date(d ->> 'raised_date') IS NULL THEN RETURN; END IF;
    INSERT INTO public.issues (id, site_id, region_id, title, detail, owner_id, party_id, raised_date, due_date, status, closed_date, custom, register_record_id, record_version, blocked_gate_or_task)
    VALUES (r.entity_id, r.site_id, r.region_id, coalesce(d ->> 'pending_issue', '?'), concat_ws(E'\n', d ->> 'root_cause', d ->> 'corrective_action', d ->> 'remark'),
      CASE WHEN d ->> 'owner_user' ~* '^[0-9a-f-]{36}$' THEN (d ->> 'owner_user')::uuid END, r.external_party_id, public.p4a_date(d ->> 'raised_date'),
      public.p4a_date(d ->> 'due_date'), public.p4a_status(d ->> 'issue_status'), public.p4a_date(d ->> 'resolution_date'), r.custom, r.id, r.version_no, nullif(btrim(coalesce(d ->> 'blocked_gate_or_task', '')), ''))
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, owner_id = EXCLUDED.owner_id, party_id = EXCLUDED.party_id, raised_date = EXCLUDED.raised_date,
      due_date = EXCLUDED.due_date, status = EXCLUDED.status, closed_date = EXCLUDED.closed_date, custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id,
      record_version = EXCLUDED.record_version, blocked_gate_or_task = EXCLUDED.blocked_gate_or_task;
  ELSE
    -- a risk without its assessment has no score: it is not projected (an unfed score shows "not available", never 0)
    IF public.p4a_num(d -> 'probability') IS NULL OR public.p4a_num(d -> 'impact') IS NULL THEN RETURN; END IF;
    INSERT INTO public.risks (id, risk_code, statement, category, scope, affected_sites, probability, impact, response, mitigation, risk_owner, action_owner, target_date, status, trend,
      last_review, next_review, region_id, is_global, custom, register_record_id, record_version)
    VALUES (r.entity_id, coalesce(d ->> 'risk_id', '?'), coalesce(d ->> 'risk_statement', '?'), d ->> 'category', d ->> 'scope', round(public.p4a_num(d -> 'affected_sites'))::int,
      public.p4a_num(d -> 'probability')::int, public.p4a_num(d -> 'impact')::int, d ->> 'response', d ->> 'mitigation_action', d ->> 'risk_owner', d ->> 'action_owner',
      public.p4a_date(d ->> 'target_date'), public.p4a_status(d ->> 'status'), d ->> 'trend', public.p4a_date(d ->> 'last_review_date'), public.p4a_date(d ->> 'next_review_date'),
      r.region_id, r.is_global, r.custom, r.id, r.version_no)
    ON CONFLICT (id) DO UPDATE SET risk_code = EXCLUDED.risk_code, statement = EXCLUDED.statement, category = EXCLUDED.category, scope = EXCLUDED.scope,
      affected_sites = EXCLUDED.affected_sites, probability = EXCLUDED.probability, impact = EXCLUDED.impact, response = EXCLUDED.response, mitigation = EXCLUDED.mitigation,
      risk_owner = EXCLUDED.risk_owner, action_owner = EXCLUDED.action_owner, target_date = EXCLUDED.target_date, status = EXCLUDED.status, trend = EXCLUDED.trend,
      last_review = EXCLUDED.last_review, next_review = EXCLUDED.next_review, custom = EXCLUDED.custom, register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  END IF;
END $$;

-- One row per site with both As-Built parts in force (BU and EF from their submission, the approval dates beside them).
CREATE OR REPLACE FUNCTION p4a_feed_as_built(p_site uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cw public.register_records%ROWTYPE; te public.register_records%ROWTYPE; q jsonb := '{}'::jsonb; e record; reg int;
BEGIN
  SELECT * INTO cw FROM public.register_records WHERE register_key = 'as_built' AND site_id = p_site AND record_type = 'cw_part' AND is_current;
  SELECT * INTO te FROM public.register_records WHERE register_key = 'as_built' AND site_id = p_site AND record_type = 'te_part' AND is_current;
  FOR e IN SELECT x.key, x.value FROM jsonb_each(coalesce(cw.data, '{}'::jsonb) || coalesce(te.data, '{}'::jsonb)) x WHERE x.key LIKE 'q\_%' LOOP
    IF public.p4a_num(e.value) IS NOT NULL THEN q := q || jsonb_build_object(upper(substr(e.key, 3)), public.p4a_num(e.value)); END IF;
  END LOOP;
  SELECT region_id INTO reg FROM public.sites WHERE id = p_site;
  INSERT INTO public.as_built_records (id, site_id, region_id, submitted_date, quantities, custom, cw_record_id, te_record_id, cw_as_built_submitted, cw_submitted_date, cw_approved_date,
    te_submitted_date, te_approved_date, rf_height_m)
  VALUES (p_site, p_site, reg, public.p4a_date(te.data ->> 'as_built_date'), q, coalesce(cw.custom, '{}'::jsonb) || coalesce(te.custom, '{}'::jsonb), cw.id, te.id,
    cw.data ->> 'cw_as_built_submitted', public.p4a_date(cw.data ->> 'cw_submitted_date'), cw.approved_at::date, public.p4a_date(te.data ->> 'as_built_date'), te.approved_at::date,
    public.p4a_num(te.data -> 'rf_height'))
  ON CONFLICT (site_id) DO UPDATE SET submitted_date = EXCLUDED.submitted_date, quantities = EXCLUDED.quantities, custom = EXCLUDED.custom, cw_record_id = EXCLUDED.cw_record_id,
    te_record_id = EXCLUDED.te_record_id, cw_as_built_submitted = EXCLUDED.cw_as_built_submitted, cw_submitted_date = EXCLUDED.cw_submitted_date,
    cw_approved_date = EXCLUDED.cw_approved_date, te_submitted_date = EXCLUDED.te_submitted_date, te_approved_date = EXCLUDED.te_approved_date, rf_height_m = EXCLUDED.rf_height_m;
END $$;

CREATE OR REPLACE FUNCTION p4a_feed_on_approved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  CASE NEW.register_key
    WHEN 'change_control' THEN PERFORM public.p4a_feed_change(NEW.id);
    WHEN 'rf_design' THEN IF NEW.site_id IS NOT NULL THEN PERFORM public.p4a_feed_rf(NEW.id); END IF;
    WHEN 'acquisition' THEN IF NEW.site_id IS NOT NULL THEN PERFORM public.p4a_feed_acquisition(NEW.id); END IF;
    WHEN 'readiness_handover' THEN IF NEW.site_id IS NOT NULL THEN PERFORM public.p4a_feed_readiness(NEW.id); END IF;
    WHEN 'as_built' THEN IF NEW.site_id IS NOT NULL THEN PERFORM public.p4a_feed_as_built(NEW.site_id); END IF;
    WHEN 'issues', 'risks' THEN PERFORM public.p4a_feed_issue_risk(NEW.id);
    ELSE NULL;
  END CASE;
  RETURN NULL;
END $$;
CREATE TRIGGER zz_p4a_feed AFTER UPDATE OF state ON register_records
  FOR EACH ROW WHEN (NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved'
                     AND NEW.register_key IN ('change_control', 'rf_design', 'acquisition', 'readiness_handover', 'as_built', 'issues', 'risks'))
  EXECUTE FUNCTION p4a_feed_on_approved();

-- Records approved before this migration feed their typed rows now (idempotent: the same functions, keyed on the logical record).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT x.id, x.register_key, x.site_id FROM register_records x WHERE x.is_current AND x.state = 'approved'
             AND x.register_key IN ('change_control', 'rf_design', 'acquisition', 'readiness_handover', 'as_built', 'issues', 'risks') ORDER BY x.approved_at, x.id LOOP
    CASE r.register_key
      WHEN 'change_control' THEN PERFORM p4a_feed_change(r.id);
      WHEN 'rf_design' THEN IF r.site_id IS NOT NULL THEN PERFORM p4a_feed_rf(r.id); END IF;
      WHEN 'acquisition' THEN IF r.site_id IS NOT NULL THEN PERFORM p4a_feed_acquisition(r.id); END IF;
      WHEN 'readiness_handover' THEN IF r.site_id IS NOT NULL THEN PERFORM p4a_feed_readiness(r.id); END IF;
      WHEN 'as_built' THEN IF r.site_id IS NOT NULL THEN PERFORM p4a_feed_as_built(r.site_id); END IF;
      ELSE PERFORM p4a_feed_issue_risk(r.id);
    END CASE;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Task sources (Q43 pattern): the selected candidate's sign-off closes A3; O&M acceptance closes D17 (MS9 follows); the closure approval closes Z1
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_task_sources (register_key, task_code, date_field, data_eq, data_in, sort_order) VALUES
  ('acquisition',        'A3',  'contract_signoff_date', '{"selected": "Yes"}'::jsonb, '{}'::jsonb, 10),
  ('readiness_handover', 'D17', 'om_acceptance_date',    '{}'::jsonb,                   '{}'::jsonb, 10),
  ('readiness_handover', 'Z1',  'closure_approval_date', '{}'::jsonb,                   '{}'::jsonb, 20)
ON CONFLICT (register_key, task_code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Rights. Every function is owned by pmis_definer and closed to PUBLIC; pmis_app calls only site_propose_change and stays read-only on the fed tables.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON change_requests, rf_design_records, acquisition_candidates, readiness_handover, as_built_records, issues, risks TO pmis_definer;
GRANT SELECT ON as_built_type_sources, warehouse_items, as_built_items, task_field_sources, template_definitions TO pmis_definer;
GRANT SELECT, UPDATE ON sites TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'p4a_audit(text,text,text,jsonb,jsonb,text,uuid,integer)', 'p4a_hook(text,uuid)', 'p4a_num(jsonb)', 'p4a_date(text)', 'p4a_site_value_text(jsonb)', 'p4a_scope_flags()',
    'p4a_site_current(uuid,text)', 'p4a_site_parse(text,text)', 'p4a_site_change_errors(uuid,jsonb)', 'p4a_apply_site_change(uuid)',
    'site_save_custom(uuid,timestamptz,jsonb,text)', 'site_propose_change(uuid,jsonb,text)', 'p4a_as_built_part(text)', 'p4a_sync_as_built_types()', 'p4a_as_built_insert()',
    'p4a_submit_check()', 'p4a_feed_change(uuid)', 'p4a_feed_rf(uuid)', 'p4a_feed_acquisition(uuid)', 'p4a_feed_readiness(uuid)', 'p4a_status(text)',
    'p4a_feed_issue_risk(uuid)', 'p4a_feed_as_built(uuid)', 'p4a_feed_on_approved()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION site_save_custom(uuid,timestamptz,jsonb,text), site_propose_change(uuid,jsonb,text) TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON change_requests, rf_design_records, acquisition_candidates, readiness_handover, as_built_records, issues, risks, as_built_type_sources FROM pmis_app;
    GRANT SELECT ON change_requests, rf_design_records, acquisition_candidates, readiness_handover, as_built_records, issues, risks, as_built_type_sources TO pmis_app;
  END IF;
END $$;
