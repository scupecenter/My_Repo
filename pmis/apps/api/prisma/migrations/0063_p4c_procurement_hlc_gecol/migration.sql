-- 0063_p4c_procurement_hlc_gecol: work package P4c of the owner answers of 2026-11-04 (docs/plans/2026-11-04-owner-answers-gap.md section P4c; the owner made every
-- answer binding, D0). Q114, Q139, Q148, Q150 and Q151.
-- Mirror: db/sql/062_p4c_procurement_hlc_gecol.sql (kept identical to prisma/migrations/0063_p4c_procurement_hlc_gecol/migration.sql).
--
--   Q150  Several HLC purchase requests per site. The HLC execution record names the requests that cover it (table hlc_pr_links, one row per HLC version and
--         request; a new version copies them, an approved version keeps them as history). The requests "required for the approved scope" are the requests the
--         record names, or, while it names none, every scope-HLC Procurement record of the site that was submitted at least once. A cancelled request (its approved
--         version has an order status starting with "Cancel") and a voided one never count. C3 closes only when EVERY required request has an approved version
--         with an HLC approval date, on the latest of those dates: never on the first one or the latest one alone. The HLC record's derived link
--         (pr_no, hlc_approval_date, procurement_record_id) follows the same set.
--   Q148  Execution needs the approved HLC purchase request(s). A draft and a survey stay free (warning only). Once the HLC record holds an execution date
--         (installation, TX link test or in service) its submit and its final approval are refused (`no_approved_hlc_pr`) until the required requests are
--         all approved by HLC, wherever HLC purchasing applies (site scope AD = yes and C3 not N/A). An emergency exception is an explicit field
--         (pr_exception = true with pr_exception_reason): only a person who holds `administer` on the HLC module in the region (or a System Admin) may submit it,
--         the reviewer sees a warning, and the final approval writes an audit row.
--   Q139  One-time assisted migration of the legacy HLC requests (request_no / request_date kept since 0042) into draft Procurement records of scope HLC:
--         hlc_legacy_to_drafts(p_dry_run, p_reason). Only the number and the date that exist are copied; no approver and no HLC approval date are invented.
--         Each draft is linked to its legacy record (hlc_legacy_migrations), a second run creates nothing (de-duplicated by the link and by an existing request
--         of the site with the same PR No.), the dry run is the preview. The HLC team completes the drafts and they go through the usual approval; the legacy
--         row leaves v_purchase_requests once the site has an approved scope-HLC request (0042, unchanged).
--   Q114  Dismantle FO / FT. A Dismantle part names its execution mode. Outsourced: the contractor comes from the approved, active Procurement order of the
--         site and scope (CW Dismantle or TE Dismantle) named in procurement_order_id; the database fills it when there is exactly one, and asks for an
--         explicit choice when there are several (`order_choice_required`). The contractor (external_party_id) is then derived from that order and cannot be
--         typed differently (`contractor_from_order`). In-House: the internal team is named (internal_team), no contractor and no order. The derived contractor
--         is kept on each approved version (history); a later change is a new version with its review. A part without an execution mode keeps the behaviour of
--         0021 / 0029 (typed contractor) with a reviewer warning.
--   Q151  GECOL order warnings, configurable: setting gecol.order_warnings {enabled, chains, billing_after, version}. Each chain is a list of GECOL date fields
--         in their expected order; a step without a date is skipped; a later step dated before an earlier one is a reviewer warning (`gecol_order`).
--         billing_after names the contract event the billing conversion follows (none by default). The step order and the billing event are owner data
--         that the GECOL team has not confirmed yet (C list item 8), so the setting is seeded with the draft order of the answer and enabled = false:
--         the current behaviour (no GECOL order warning) stays the default. C-2 negative (installation finish before the request) stays blocking (0042).
--         Readers and writer: gecol_order_warnings_json(), admin_save_gecol_order_warnings(config, reason, version) (System Admin or a delegation of
--         admin.settings edit for all regions, a reason, If-Match, audited through log_audit_write).
--
--   Composition with the other packages: reg_validate, reg_warnings and reg_complete_task are WRAPPED, not rewritten. Each existing function is renamed
--   (*_pre_0063) and a new function of the same name calls it and adds the P4c part, so whatever an earlier migration put in them is kept.
--   Ownership: every function is owned by pmis_definer, SECURITY DEFINER with a fixed search_path, closed to PUBLIC; pmis_app calls only the readers,
--   hlc_set_pr_links, hlc_legacy_to_drafts (which check the actor themselves) and admin_save_gecol_order_warnings. pmis_app stays read-only on every table.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Fields (Q114 Dismantle execution, Q148 the emergency exception of the HLC record) and the GECOL setting (Q151)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('dismantle', 'execution_mode',       'Execution Mode',              'طريقة التنفيذ',               'list', false, false, false, '["Outsourced", "In-House"]'::jsonb, true, 'Execution', 32),
  ('dismantle', 'procurement_order_id', 'Procurement Order',           'أمر المشتريات',               'text', false, false, false, NULL, false, 'Execution', 34),
  ('dismantle', 'internal_team',        'Internal Team (In-House)',    'الفريق الداخلي المنفذ',       'text', false, false, false, NULL, false, 'Execution', 36),
  ('hlc',       'pr_exception',         'Emergency Exception (no approved PR)', 'استثناء طارئ (بدون طلب شراء معتمد)', 'yes_no', false, false, false, NULL, false, 'Purchase request', 4),
  ('hlc',       'pr_exception_reason',  'Emergency Exception Reason',  'سبب الاستثناء الطارئ',        'text', false, false, false, NULL, false, 'Purchase request', 5)
ON CONFLICT (register_key, code) DO NOTHING;

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('gecol.order_warnings',
   '{"enabled": false, "chains": [["request_date", "survey_date", "layout_received", "layout_approved"], ["installation_finish", "aat_acceptance_date", "power_on_date"]], "billing_after": null, "version": 1}'::jsonb,
   'Q151: reviewer warnings on the order of the GECOL dates. Each chain lists GECOL date fields in their expected order (a step without a date is skipped); billing_after = the contract event the billing conversion follows (null = no check). Draft order of the owner answer, to be confirmed by the GECOL team: off by default.',
   now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Tables: the HLC record <-> purchase request links (Q150) and the legacy migration links (Q139)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE hlc_pr_links (
  hlc_record_id         UUID        NOT NULL REFERENCES register_records (id) ON DELETE CASCADE,   -- the HLC version that names the request
  procurement_entity_id UUID        NOT NULL,                                                       -- the logical Procurement record (scope HLC)
  site_id               UUID        NOT NULL,
  region_id             INTEGER     NOT NULL,
  created_by            UUID,
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (hlc_record_id, procurement_entity_id)
);
CREATE INDEX hlc_pr_links_entity_idx ON hlc_pr_links (procurement_entity_id);
COMMENT ON TABLE hlc_pr_links IS '0063 (Q150): the HLC purchase requests an HLC execution record version covers. Written only by hlc_set_pr_links and the new-version copy.';

CREATE TABLE hlc_legacy_migrations (
  hlc_entity_id         UUID        PRIMARY KEY,          -- the logical HLC record whose legacy request was migrated
  hlc_record_id         UUID        NOT NULL,             -- the version the legacy values were read from
  procurement_entity_id UUID        NOT NULL,             -- the draft created, or the existing request it was matched to
  procurement_record_id UUID        NOT NULL,
  outcome               TEXT        NOT NULL CHECK (outcome IN ('created', 'linked_existing')),
  request_no            TEXT,
  request_date          DATE,
  site_id               UUID        NOT NULL,
  region_id             INTEGER     NOT NULL,
  migrated_by           UUID        NOT NULL,
  migrated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  reason                TEXT        NOT NULL
);
COMMENT ON TABLE hlc_legacy_migrations IS '0063 (Q139): one row per legacy HLC request moved to a Procurement draft of scope HLC (or matched to an existing request). Written only by hlc_legacy_to_drafts.';

CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON hlc_pr_links FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON hlc_legacy_migrations FOR EACH ROW EXECUTE FUNCTION reg_backstop();
ALTER TABLE hlc_pr_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hlc_pr_links FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON hlc_pr_links FOR SELECT USING (app_region_read(false, region_id));
CREATE POLICY rls_seed_write ON hlc_pr_links FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE hlc_legacy_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hlc_legacy_migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON hlc_legacy_migrations FOR SELECT USING (app_region_read(false, region_id));
CREATE POLICY rls_seed_write ON hlc_legacy_migrations FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
GRANT SELECT, INSERT, UPDATE, DELETE ON hlc_pr_links, hlc_legacy_migrations TO pmis_definer;
GRANT INSERT, UPDATE ON settings TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The required HLC purchase requests of a site (Q150)
-- ---------------------------------------------------------------------------------------------------------------------
-- A cancelled order: the order status list (ProcStatus) is still free text (open question), so any status that starts with "cancel" counts.
CREATE OR REPLACE FUNCTION proc_order_cancelled(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT coalesce(p_status, '') ~* '^\s*cancel' $$;

-- The requests an HLC record version names (empty = none named).
CREATE OR REPLACE FUNCTION hlc_links_of(p_hlc_record uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(l.procurement_entity_id ORDER BY l.created_at, l.procurement_entity_id), ARRAY[]::uuid[]) FROM public.hlc_pr_links l WHERE l.hlc_record_id = p_hlc_record
$$;

-- The required requests of a site: the named ones (p_links), or while none is named every scope-HLC request submitted at least once. Cancelled and voided
-- requests are left out. record_id = the approved version in force, else the latest version.
CREATE OR REPLACE FUNCTION hlc_pr_set(p_site uuid, p_links uuid[]) RETURNS TABLE (entity_id uuid, record_id uuid, pr_no text, pr_date date, hlc_approval_date date, approved boolean, linked boolean, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH ent AS (
    SELECT r.entity_id, (array_agg(r.id ORDER BY r.version_no DESC))[1] AS latest_id, bool_or(r.submitted_at IS NOT NULL OR r.state = 'approved') AS submitted
    FROM public.register_records r
    WHERE r.register_key = 'procurement' AND r.site_id = p_site AND r.state <> 'voided' AND r.data ->> 'scope' = 'HLC'
    GROUP BY r.entity_id
  )
  SELECT e.entity_id, coalesce(c.id, l.id), coalesce(c.data, l.data) ->> 'pr_no', (coalesce(c.data, l.data) ->> 'pr_date')::date,
         (c.data ->> 'hlc_approval_date')::date, c.id IS NOT NULL, e.entity_id = ANY (coalesce(p_links, ARRAY[]::uuid[])), l.state
  FROM ent e
  JOIN public.register_records l ON l.id = e.latest_id
  LEFT JOIN public.register_records c ON c.entity_id = e.entity_id AND c.is_current AND c.state = 'approved' AND c.data ->> 'scope' = 'HLC'
  WHERE NOT public.proc_order_cancelled(c.data ->> 'order_status')
    AND CASE WHEN cardinality(coalesce(p_links, ARRAY[]::uuid[])) > 0 THEN e.entity_id = ANY (p_links) ELSE e.submitted END
$$;

-- The state of that set: complete = at least one request and every one approved with an HLC approval date; last_* = the approved request with the latest
-- HLC approval date (the one that completes the scope).
CREATE OR REPLACE FUNCTION hlc_pr_status(p_site uuid, p_links uuid[])
RETURNS TABLE (n integer, n_approved integer, n_dated integer, complete boolean, last_date date, last_record uuid, pr_list text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*)::int, (count(*) FILTER (WHERE s.approved))::int, (count(*) FILTER (WHERE s.approved AND s.hlc_approval_date IS NOT NULL))::int,
    count(*) > 0 AND count(*) = count(*) FILTER (WHERE s.approved AND s.hlc_approval_date IS NOT NULL),
    max(s.hlc_approval_date) FILTER (WHERE s.approved),
    (array_agg(s.record_id ORDER BY s.hlc_approval_date DESC NULLS LAST, s.pr_date DESC NULLS LAST, s.record_id) FILTER (WHERE s.approved))[1],
    string_agg(s.pr_no, ', ' ORDER BY s.pr_date NULLS LAST, s.pr_no) FILTER (WHERE s.approved AND s.pr_no IS NOT NULL)
  FROM public.hlc_pr_set(p_site, p_links) s
$$;

-- The links that decide C3: those of the site's HLC version in force (none = every submitted request).
CREATE OR REPLACE FUNCTION hlc_scope_links(p_site uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT public.hlc_links_of(r.id) FROM public.register_records r
                   WHERE r.register_key = 'hlc' AND r.site_id = p_site AND r.is_current AND r.state = 'approved' LIMIT 1), ARRAY[]::uuid[])
$$;

-- Does HLC purchasing apply to the site (scope AD = yes and C3 not N/A)?
CREATE OR REPLACE FUNCTION hlc_purchase_applies(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND s.scope_hlc_fiber = 'yes')
     AND NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
                     JOIN public.sites st ON st.id = ti.site_id AND st.workflow_version_id = td.workflow_id
                     WHERE ti.site_id = p_site AND td.code = 'C3' AND (ti.is_na OR ti.state IN ('na', 'skipped')))
$$;

-- The derived link of the HLC record (0042 picked the latest approved request; Q150 follows the required set). Filled while the record is in entry and when it
-- leaves entry. One request: its link as before. Several: the PR numbers of the approved ones, and the HLC approval date and record only once all are approved.
CREATE OR REPLACE FUNCTION reg_hlc_link_pr() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; links uuid[]; out jsonb := '{}'::jsonb;
BEGIN
  IF NEW.site_id IS NULL THEN RETURN NEW; END IF;
  IF NOT (NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry')) THEN RETURN NEW; END IF;
  links := CASE WHEN TG_OP = 'INSERT' THEN ARRAY[]::uuid[] ELSE public.hlc_links_of(NEW.id) END;
  IF cardinality(links) = 0 AND TG_OP = 'INSERT' AND NEW.supersedes_id IS NOT NULL THEN links := public.hlc_links_of(NEW.supersedes_id); END IF;   -- copied after the insert
  SELECT * INTO s FROM public.hlc_pr_status(NEW.site_id, links);
  IF s.n_approved > 0 THEN
    IF s.n = 1 THEN
      out := jsonb_build_object('procurement_record_id', s.last_record::text, 'pr_no', s.pr_list, 'hlc_approval_date', s.last_date::text);
    ELSE
      out := jsonb_build_object('pr_no', s.pr_list);
      IF s.complete THEN out := out || jsonb_build_object('procurement_record_id', s.last_record::text, 'hlc_approval_date', s.last_date::text); END IF;
    END IF;
  END IF;
  NEW.data := (NEW.data - 'procurement_record_id' - 'pr_no' - 'hlc_approval_date') || jsonb_strip_nulls(out);
  RETURN NEW;
END $$;

-- A new HLC version names the same requests as the version it replaces (it can change them while in entry).
CREATE OR REPLACE FUNCTION hlc_pr_links_copy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.hlc_pr_links (hlc_record_id, procurement_entity_id, site_id, region_id, created_by)
  SELECT NEW.id, l.procurement_entity_id, NEW.site_id, NEW.region_id, NEW.created_by FROM public.hlc_pr_links l WHERE l.hlc_record_id = NEW.supersedes_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER hlc_pr_links_new_version AFTER INSERT ON register_records FOR EACH ROW
  WHEN (NEW.register_key = 'hlc' AND NEW.supersedes_id IS NOT NULL) EXECUTE FUNCTION hlc_pr_links_copy();

-- The L1 of an HLC record in entry names the requests that cover it (replaces the list; an empty list = every submitted request of the site).
CREATE OR REPLACE FUNCTION hlc_set_pr_links(p_record uuid, p_version integer, p_entities uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before uuid[]; e uuid; i int := 0; errs jsonb := '[]'::jsonb; ents uuid[];
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF r.register_key <> 'hlc' THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.')); END IF;
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The purchase requests are named while the record is in entry: create a new version to change an approved record.'));
  END IF;
  PERFORM public.reg_require_grant('hlc', r.region_id, 'edit');
  PERFORM public.reg_require_actor(p_record, 'entry', actor);
  ents := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_entities, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
  IF cardinality(ents) > 20 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/procurement_entity_ids', 'too_many', 'At most 20 purchase requests.')));
  END IF;
  FOREACH e IN ARRAY ents LOOP
    IF NOT EXISTS (SELECT 1 FROM public.register_records p WHERE p.entity_id = e AND p.register_key = 'procurement' AND p.site_id = r.site_id
                   AND p.state <> 'voided' AND p.data ->> 'scope' = 'HLC') THEN
      errs := errs || public.reg_err_item('/procurement_entity_ids/' || i, 'not_hlc_pr', 'Not an HLC purchase request (Procurement, scope HLC) of this site.');
    END IF;
    i := i + 1;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := public.hlc_links_of(p_record);
  DELETE FROM public.hlc_pr_links WHERE hlc_record_id = p_record;
  INSERT INTO public.hlc_pr_links (hlc_record_id, procurement_entity_id, site_id, region_id, created_by)
  SELECT p_record, x, r.site_id, r.region_id, actor FROM unnest(ents) x;
  UPDATE public.register_records SET version = version + 1, updated_at = now() WHERE id = p_record;   -- re-derives the link (reg_hlc_link_pr)
  PERFORM public.log_audit_write('hlc_pr_links_set', 'register_record', p_record::text, jsonb_build_object('procurement_entity_ids', to_jsonb(before)),
    jsonb_build_object('procurement_entity_ids', to_jsonb(ents)), NULL, r.site_id, r.region_id);
  RETURN to_jsonb(ents);
END $$;

-- What the record view shows (contract HlcPurchaseRequests): the required set, every request of the site the L1 may name, and whether the set is complete.
CREATE OR REPLACE FUNCTION hlc_pr_view(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; links uuid[]; s record; req jsonb; cand jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records x WHERE x.id = p_record AND x.register_key = 'hlc' AND public.app_region_read(x.is_global, x.region_id);
  IF NOT FOUND OR r.site_id IS NULL THEN RETURN NULL; END IF;
  links := public.hlc_links_of(r.id);
  SELECT * INTO s FROM public.hlc_pr_status(r.site_id, links);
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_id', x.entity_id, 'record_id', x.record_id, 'pr_no', x.pr_no, 'pr_date', x.pr_date,
           'hlc_approval_date', x.hlc_approval_date, 'approved', x.approved, 'state', x.state)) ORDER BY x.pr_date NULLS LAST, x.pr_no), '[]'::jsonb)
    INTO req FROM public.hlc_pr_set(r.site_id, links) x;
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_id', c.entity_id, 'record_id', c.id, 'pr_no', c.data ->> 'pr_no', 'pr_date', c.data ->> 'pr_date',
           'state', c.state, 'cancelled', public.proc_order_cancelled(c.data ->> 'order_status'), 'linked', c.entity_id = ANY (links))) ORDER BY c.data ->> 'pr_date', c.id), '[]'::jsonb)
    INTO cand
    FROM (SELECT DISTINCT ON (p.entity_id) p.* FROM public.register_records p
          WHERE p.register_key = 'procurement' AND p.site_id = r.site_id AND p.state <> 'voided' AND p.data ->> 'scope' = 'HLC'
          ORDER BY p.entity_id, p.is_current DESC, p.version_no DESC) c;
  RETURN jsonb_build_object('linked_explicitly', cardinality(links) > 0, 'complete', s.complete, 'required', s.n, 'approved_by_hlc', s.n_dated,
    'hlc_approval_date', CASE WHEN s.complete THEN s.last_date END, 'items', req, 'candidates', cand);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Dismantle FO / FT from the Procurement order (Q114)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dismantle_scope_of(p_part text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT CASE p_part WHEN 'cw' THEN 'CW Dismantle' WHEN 'te' THEN 'TE Dismantle' END $$;

-- The approved, active orders of a site and scope: the approved Procurement version in force, not cancelled.
CREATE OR REPLACE FUNCTION dismantle_active_orders(p_site uuid, p_scope text) RETURNS TABLE (entity_id uuid, record_id uuid, party_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.entity_id, r.id, r.external_party_id FROM public.register_records r
  WHERE r.register_key = 'procurement' AND r.site_id = p_site AND r.is_current AND r.state = 'approved' AND r.data ->> 'scope' = p_scope
    AND NOT public.proc_order_cancelled(r.data ->> 'order_status')
$$;

CREATE OR REPLACE FUNCTION dismantle_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := NEW.data; xmode text := NEW.data ->> 'execution_mode'; scope text := public.dismantle_scope_of(NEW.record_type); errs jsonb := '[]'::jsonb;
  leaving boolean := TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state NOT IN ('entry', 'voided');
  final boolean := TG_OP = 'UPDATE' AND NEW.state = 'approved' AND OLD.state <> 'approved';
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
  typed boolean := (TG_OP = 'INSERT' AND NEW.supersedes_id IS NULL AND NEW.external_party_id IS NOT NULL)
                   OR (TG_OP = 'UPDATE' AND NEW.external_party_id IS DISTINCT FROM OLD.external_party_id);
  n int; one uuid; ord uuid; party uuid;
BEGIN
  IF NOT (live OR final) THEN RETURN NEW; END IF;          -- a version in review or approved is history
  IF xmode IS NULL THEN
    IF d ? 'procurement_order_id' THEN errs := errs || public.reg_err_item('/data/procurement_order_id', 'execution_mode_required', 'Choose the execution mode (Outsourced or In-House) first.'); END IF;
    IF d ? 'internal_team' THEN errs := errs || public.reg_err_item('/data/internal_team', 'execution_mode_required', 'Choose the execution mode (Outsourced or In-House) first.'); END IF;
  ELSIF xmode = 'In-House' THEN
    IF d ? 'procurement_order_id' THEN errs := errs || public.reg_err_item('/data/procurement_order_id', 'in_house_no_order', 'In-house work has no Procurement order.'); END IF;
    IF typed AND NEW.external_party_id IS NOT NULL THEN
      errs := errs || public.reg_err_item('/external_party_id', 'in_house_no_contractor', 'In-house work names the internal team, not a contractor.');
    ELSIF live THEN
      NEW.external_party_id := NULL;
    END IF;
    IF (leaving OR final) AND btrim(coalesce(d ->> 'internal_team', '')) = '' THEN
      errs := errs || public.reg_err_item('/data/internal_team', 'required', 'In-house work names the internal team that does it.');
    END IF;
  ELSE
    IF d ? 'internal_team' THEN errs := errs || public.reg_err_item('/data/internal_team', 'outsourced_no_internal_team', 'Outsourced work takes its contractor from the Procurement order.'); END IF;
    SELECT count(*)::int, (array_agg(o.entity_id))[1] INTO n, one FROM public.dismantle_active_orders(NEW.site_id, scope) o;
    IF d ? 'procurement_order_id' THEN
      IF coalesce(d ->> 'procurement_order_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        errs := errs || public.reg_err_item('/data/procurement_order_id', 'invalid', 'A Procurement record id.');
      ELSE
        ord := (d ->> 'procurement_order_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.dismantle_active_orders(NEW.site_id, scope) o WHERE o.entity_id = ord) THEN
          errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_not_active',
            'Not an approved, active Procurement order of scope ' || coalesce(scope, '?') || ' on this site.');
          ord := NULL;
        END IF;
      END IF;
    ELSIF n = 1 AND NEW.state = 'entry' THEN
      ord := one;
      NEW.data := d || jsonb_build_object('procurement_order_id', one::text);    -- the only active order: no choice to make
    ELSIF leaving OR final THEN
      errs := errs || CASE WHEN n = 0
        THEN public.reg_err_item('/data/procurement_order_id', 'no_active_order', 'The site has no approved, active Procurement order of scope ' || coalesce(scope, '?') || '.')
        ELSE public.reg_err_item('/data/procurement_order_id', 'order_choice_required', 'The site has ' || n || ' active ' || coalesce(scope, '?') || ' orders: choose the one this work belongs to.') END;
    END IF;
    IF live THEN
      -- outsourced: the contractor is always the order's (none while no order is chosen)
      IF ord IS NOT NULL THEN SELECT o.party_id INTO party FROM public.dismantle_active_orders(NEW.site_id, scope) o WHERE o.entity_id = ord; END IF;
      IF typed AND NEW.external_party_id IS NOT NULL AND NEW.external_party_id IS DISTINCT FROM party THEN
        errs := errs || public.reg_err_item('/external_party_id', 'contractor_from_order', 'The contractor comes from the Procurement order and cannot be typed here.');
      ELSE
        NEW.external_party_id := party;
      END IF;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
-- after b_dismantle_rules (the RFD first), on every write of the data or the contractor, and on the submit and the final approval
CREATE TRIGGER b_dismantle_rules_q114 BEFORE INSERT OR UPDATE OF data, external_party_id, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'dismantle') EXECUTE FUNCTION dismantle_order_rules();

-- The picker of the Dismantle form: the active orders of the site and part, with what the screen shows. Needs the site's region and the Dismantle module.
CREATE OR REPLACE FUNCTION dismantle_order_options(p_site uuid, p_part text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; regs int[] := public.wf_actor_regions('dismantle', 'view'); out jsonb;
BEGIN
  SELECT * INTO s FROM public.sites x WHERE x.id = p_site AND public.app_region_read(false, x.region_id);
  IF NOT FOUND OR (regs IS NOT NULL AND NOT (s.region_id = ANY (regs))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  IF public.dismantle_scope_of(p_part) IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'The part is cw or te.')));
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'scope', r.data ->> 'scope', 'delivery', r.data ->> 'delivery',
           'pr_no', r.data ->> 'pr_no', 'po_wo_no', r.data ->> 'po_wo_no', 'po_wo_date', r.data ->> 'po_wo_date', 'order_status', r.data ->> 'order_status',
           'external_party', CASE WHEN ep.id IS NOT NULL THEN jsonb_build_object('id', ep.id, 'name', ep.name, 'type', ep.type::text) END))
           ORDER BY r.data ->> 'po_wo_date' NULLS LAST, r.id), '[]'::jsonb)
    INTO out
    FROM public.dismantle_active_orders(p_site, public.dismantle_scope_of(p_part)) o
    JOIN public.register_records r ON r.id = o.record_id
    LEFT JOIN public.external_parties ep ON ep.id = o.party_id;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Validation (blocking): wraps reg_validate (Q148, Q114 at submit)
-- ---------------------------------------------------------------------------------------------------------------------
-- Q148: an HLC record with an execution date needs the required requests approved by HLC, or an emergency exception given by a person allowed to give it.
CREATE OR REPLACE FUNCTION hlc_exec_field(p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_data ? 'installation_date' THEN 'installation_date' WHEN p_data ? 'tx_link_tested_date' THEN 'tx_link_tested_date'
              WHEN p_data ? 'in_service_date' THEN 'in_service_date' END
$$;

CREATE OR REPLACE FUNCTION hlc_exception_allowed(p_actor uuid, p_region integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE regs int[];
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM public.app_actor() THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(p_actor) THEN RETURN true; END IF;
  regs := public.wf_actor_regions('hlc', 'administer');
  RETURN regs IS NULL OR p_region = ANY (regs);
END $$;

-- The HLC check shared by the submit (reg_validate) and the final approval (trigger below). Returns field errors.
CREATE OR REPLACE FUNCTION hlc_pr_gate(p_record uuid, p_data jsonb, p_site uuid, p_region integer, p_check_actor boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb; ex boolean := coalesce((p_data ->> 'pr_exception')::boolean, false); ef text := public.hlc_exec_field(p_data); s record;
BEGIN
  IF NOT ex AND p_data ? 'pr_exception_reason' THEN
    errs := errs || public.reg_err_item('/data/pr_exception_reason', 'not_applicable', 'A reason belongs to an emergency exception only.');
  END IF;
  IF ef IS NULL OR p_site IS NULL OR NOT public.hlc_purchase_applies(p_site) THEN RETURN errs; END IF;
  SELECT * INTO s FROM public.hlc_pr_status(p_site, public.hlc_links_of(p_record));
  IF s.complete THEN RETURN errs; END IF;
  IF ex THEN
    IF btrim(coalesce(p_data ->> 'pr_exception_reason', '')) = '' THEN
      errs := errs || public.reg_err_item('/data/pr_exception_reason', 'required', 'An emergency exception needs its reason.');
    END IF;
    IF p_check_actor AND NOT public.hlc_exception_allowed(public.app_actor(), p_region) THEN
      errs := errs || public.reg_err_item('/data/pr_exception', 'pr_exception_forbidden', 'Only a person who holds administer on HLC (or a System Admin) may give an emergency exception.');
    END IF;
  ELSE
    errs := errs || public.reg_err_item('/data/' || ef, 'no_approved_hlc_pr',
      CASE WHEN s.n = 0 THEN 'Execution needs the approved HLC purchase request of the site (C3): Procurement has none yet.'
           ELSE 'Execution needs every HLC purchase request of the scope approved by HLC (C3): ' || s.n_dated || ' of ' || s.n || ' so far.' END);
  END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION reg_validate_p4c(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  IF r.register_key = 'hlc' THEN RETURN public.hlc_pr_gate(r.id, r.data, r.site_id, r.region_id, true); END IF;
  RETURN '[]'::jsonb;   -- Dismantle (Q114) is checked by its row trigger, on the submit and the final approval
END $$;

ALTER FUNCTION reg_validate(uuid) RENAME TO reg_validate_pre_0063;
CREATE FUNCTION reg_validate(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_validate_pre_0063(p_record) || public.reg_validate_p4c(p_record)
$$;

-- Q148 again at the final approval of an HLC record (the requests may have changed since the submit), and the audit row of an emergency exception.
CREATE OR REPLACE FUNCTION hlc_approval_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb; s record;
BEGIN
  errs := public.hlc_pr_gate(NEW.id, NEW.data, NEW.site_id, NEW.region_id, false);
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF coalesce((NEW.data ->> 'pr_exception')::boolean, false) AND public.hlc_exec_field(NEW.data) IS NOT NULL THEN
    SELECT * INTO s FROM public.hlc_pr_status(NEW.site_id, public.hlc_links_of(NEW.id));
    IF NOT s.complete THEN
      PERFORM public.log_audit_write('hlc_pr_exception_approved', 'register_record', NEW.id::text, NULL,
        jsonb_build_object('pr_exception', true, 'required_requests', s.n, 'approved_by_hlc', s.n_dated, 'execution_field', public.hlc_exec_field(NEW.data)),
        NEW.data ->> 'pr_exception_reason', NEW.site_id, NEW.region_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_hlc_approval_guard BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (NEW.register_key = 'hlc' AND NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved') EXECUTE FUNCTION hlc_approval_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Reviewer warnings: wraps reg_warnings (Q150 for HLC, Q151 for GECOL, Q114 for Dismantle)
-- ---------------------------------------------------------------------------------------------------------------------
-- The setting of Q151, with its defaults when the row is missing.
CREATE OR REPLACE FUNCTION gecol_order_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT '{"enabled": false, "chains": [], "billing_after": null, "version": 0}'::jsonb || coalesce(public.calc_setting('gecol.order_warnings', '{}'::jsonb), '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION gecol_field_label(p_code text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT f.label_en FROM public.register_fields f WHERE f.register_key = 'gecol' AND f.code = p_code), p_code)
$$;

CREATE OR REPLACE FUNCTION gecol_order_warnings(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg jsonb := public.gecol_order_cfg(); w jsonb := '[]'::jsonb; chain jsonb; code text; d date; prev date; prev_code text; ev text; evd date; bd date;
BEGIN
  IF NOT coalesce((cfg ->> 'enabled')::boolean, false) THEN RETURN w; END IF;
  FOR chain IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cfg -> 'chains') = 'array' THEN cfg -> 'chains' ELSE '[]'::jsonb END) LOOP
    prev := NULL; prev_code := NULL;
    CONTINUE WHEN jsonb_typeof(chain) <> 'array';
    FOR code IN SELECT * FROM jsonb_array_elements_text(chain) LOOP
      BEGIN d := (p_data ->> code)::date; EXCEPTION WHEN others THEN d := NULL; END;
      CONTINUE WHEN d IS NULL;                                 -- a step that does not apply (no date) is skipped
      IF prev IS NOT NULL AND d < prev THEN
        w := w || jsonb_build_array(jsonb_build_object('path', '/data/' || code, 'code', 'gecol_order', 'related_path', '/data/' || prev_code,
          'message', public.gecol_field_label(code) || ' is before ' || public.gecol_field_label(prev_code) || '.'));
      ELSE
        prev := d; prev_code := code;
      END IF;
    END LOOP;
  END LOOP;
  ev := nullif(cfg ->> 'billing_after', '');
  IF ev IS NOT NULL THEN
    BEGIN evd := (p_data ->> ev)::date; bd := (p_data ->> 'billing_conversion_date')::date; EXCEPTION WHEN others THEN evd := NULL; END;
    IF evd IS NOT NULL AND bd IS NOT NULL AND bd < evd THEN
      w := w || jsonb_build_array(jsonb_build_object('path', '/data/billing_conversion_date', 'code', 'billing_before_event', 'related_path', '/data/' || ev,
        'message', 'The billing conversion is before ' || public.gecol_field_label(ev) || ' (the contract event it follows).'));
    END IF;
  END IF;
  RETURN w;
END $$;

CREATE OR REPLACE FUNCTION reg_warnings_p4c(p_record uuid, p_base jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; dd jsonb; w jsonb := coalesce(p_base, '[]'::jsonb); s record; links uuid[]; lr date; ti date;
BEGIN
  SELECT * INTO r FROM public.register_records x WHERE x.id = p_record AND public.app_region_read(x.is_global, x.region_id);
  IF NOT FOUND THEN RETURN w; END IF;
  dd := r.data;
  IF r.register_key = 'hlc' AND r.site_id IS NOT NULL THEN
    -- the 0042 warnings that read one request are replaced by the set of Q150
    SELECT coalesce(jsonb_agg(e), '[]'::jsonb) INTO w FROM jsonb_array_elements(w) e
      WHERE e ->> 'code' NOT IN ('no_approved_hlc_pr', 'hlc_not_approved', 'before_hlc_approval');
    links := public.hlc_links_of(r.id);
    SELECT * INTO s FROM public.hlc_pr_status(r.site_id, links);
    IF s.n_approved = 0 THEN
      w := w || public.reg_err_item('/data/pr_no', 'no_approved_hlc_pr', 'The site has no approved HLC purchase request in Procurement yet.');
    ELSIF NOT s.complete THEN
      w := w || CASE WHEN s.n = 1 THEN public.reg_err_item('/data/hlc_approval_date', 'hlc_not_approved', 'The HLC purchase request has no HLC approval date yet.')
                     ELSE public.reg_err_item('/data/hlc_approval_date', 'hlc_prs_incomplete', s.n_dated || ' of ' || s.n || ' required HLC purchase requests are approved by HLC.') END;
    ELSE
      lr := (dd ->> 'link_received_date')::date; ti := (dd ->> 'installation_date')::date;
      IF lr IS NOT NULL AND lr < s.last_date THEN
        w := w || public.reg_err_item('/data/link_received_date', 'before_hlc_approval', 'The link was received before the HLC approval date ' || s.last_date::text || '.');
      END IF;
      IF ti IS NOT NULL AND ti < s.last_date THEN
        w := w || public.reg_err_item('/data/installation_date', 'before_hlc_approval', 'The installation is before the HLC approval date ' || s.last_date::text || '.');
      END IF;
    END IF;
    IF cardinality(links) = 0 AND s.n > 1 THEN
      w := w || public.reg_err_item('/data/pr_no', 'hlc_prs_not_linked', 'The site has ' || s.n || ' HLC purchase requests: name the ones this record covers (otherwise every submitted one is required).');
    END IF;
    IF coalesce((dd ->> 'pr_exception')::boolean, false) AND NOT s.complete THEN
      w := w || public.reg_err_item('/data/pr_exception', 'pr_exception_used', 'Emergency exception: execution without the approved HLC purchase request(s). Reason: ' || coalesce(dd ->> 'pr_exception_reason', '—'));
    END IF;
  ELSIF r.register_key = 'gecol' THEN
    w := w || public.gecol_order_warnings(dd);
  ELSIF r.register_key = 'dismantle' THEN
    IF NOT (dd ? 'execution_mode') THEN
      w := w || public.reg_err_item('/data/execution_mode', 'execution_mode_missing', 'No execution mode: the contractor is typed, not taken from the Procurement order (Q114).');
    ELSIF dd ->> 'execution_mode' = 'Outsourced' AND r.state = 'entry' AND NOT (dd ? 'procurement_order_id') THEN
      w := w || public.reg_err_item('/data/procurement_order_id', 'order_not_chosen', 'Choose the Procurement order of this work before the submit.');
    ELSIF dd ->> 'execution_mode' = 'Outsourced' AND r.external_party_id IS NULL AND dd ? 'procurement_order_id' THEN
      w := w || public.reg_err_item('/external_party_id', 'order_without_contractor', 'The chosen Procurement order names no contractor.');
    END IF;
  END IF;
  RETURN w;
END $$;

ALTER FUNCTION reg_warnings(uuid) RENAME TO reg_warnings_pre_0063;
CREATE FUNCTION reg_warnings(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_warnings_p4c(p_record, public.reg_warnings_pre_0063(p_record))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. C3 closes when every required HLC request is approved by HLC (Q150): wraps reg_complete_task
-- ---------------------------------------------------------------------------------------------------------------------
-- Closes C3 of a site with an explicit date (the latest HLC approval date of the set); the body of reg_close_task (0042) with the date given.
CREATE OR REPLACE FUNCTION hlc_c3_close(p_record uuid, p_task uuid, p_date date, p_actor uuid, p_stepup boolean, p_self boolean, p_note text) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; t public.task_instances%ROWTYPE; before jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  before := public.wf_snap(t.id);
  UPDATE public.task_instances SET actual_date = p_date, state = 'approved', current_level = r.levels_required, levels_required = r.levels_required,
    path_frozen_at = coalesce(path_frozen_at, now()), submitted_date = coalesce(r.submitted_at::date, current_date), approved_date = current_date,
    ball_in_court_user_id = NULL, level_opened_at = NULL, self_approval = p_self, version = version + 1, updated_at = now()
  WHERE id = t.id;
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = t.id AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots sl
    WHERE sl.task_id = t.id AND f.slot_id = sl.id AND f.is_current AND f.approved_date IS NULL;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
  VALUES (t.id, r.levels_required, 'approve', p_actor, p_note, t.state, 'approved', coalesce(p_stepup, false), coalesce(p_self, false), clock_timestamp());
  PERFORM public.wf_audit('task_approve', t.id, before, public.wf_snap(t.id) || jsonb_build_object('via_register_record', r.id, 'register', r.register_key, 'q150', true),
    'approved when every HLC purchase request of the scope was approved by HLC (Q150)');
  RETURN public.wf_unlock_successors(t.id);
END $$;

-- After a final approval of an HLC request or of an HLC record: C3 closes when it is open and the set of the scope is complete; otherwise it waits (audited).
CREATE OR REPLACE FUNCTION hlc_c3_sync(p_record uuid, p_actor uuid, p_stepup boolean, p_self boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; t public.task_instances%ROWTYPE; s record; links uuid[];
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.site_id IS NULL THEN RETURN ARRAY[]::uuid[]; END IF;
  SELECT ti.* INTO t FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id
    JOIN public.sites st ON st.id = ti.site_id AND st.workflow_version_id = td.workflow_id
    WHERE ti.site_id = r.site_id AND td.code = 'C3' LIMIT 1 FOR UPDATE OF ti;
  IF NOT FOUND OR t.state NOT IN ('open', 'entry') OR t.is_na THEN RETURN ARRAY[]::uuid[]; END IF;
  links := public.hlc_scope_links(r.site_id);
  SELECT * INTO s FROM public.hlc_pr_status(r.site_id, links);
  IF NOT s.complete OR s.last_date IS NULL OR s.last_date > public.cal_today() THEN
    IF r.register_key = 'procurement' AND r.data ? 'hlc_approval_date' THEN
      PERFORM public.log_audit_write('hlc_c3_waiting', 'register_record', r.id::text, NULL,
        jsonb_build_object('task_id', t.id, 'required_requests', s.n, 'approved_by_hlc', s.n_dated, 'linked_explicitly', cardinality(links) > 0),
        'C3 waits for every HLC purchase request of the scope (Q150)', r.site_id, r.region_id);
    END IF;
    RETURN ARRAY[]::uuid[];
  END IF;
  RETURN public.hlc_c3_close(p_record, t.id, s.last_date, p_actor, p_stepup, p_self,
    'approved with the register record ' || r.register_key || ' ' || r.id::text || ': every HLC purchase request of the scope is approved by HLC ('
    || s.n || ', latest ' || s.last_date::text || ', Q150)');
END $$;

ALTER FUNCTION reg_complete_task(uuid, uuid, boolean, boolean) RENAME TO reg_complete_task_pre_0063;
CREATE FUNCTION reg_complete_task(p_record uuid, p_actor uuid, p_stepup boolean, p_self boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; code text; unlocked uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.register_key = 'procurement' AND r.data ->> 'scope' = 'HLC' THEN
    -- Q150: an HLC request never closes C3 alone. The link made at the submit stays only while the record still matches the C3 source.
    IF r.task_id IS NOT NULL THEN
      SELECT td.code INTO code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id WHERE ti.id = r.task_id;
      IF code IS DISTINCT FROM 'C3' OR NOT public.reg_source_matches(p_record, 'C3') THEN
        RETURN public.reg_complete_task_pre_0063(p_record, p_actor, p_stepup, p_self);
      END IF;
    END IF;
    RETURN public.hlc_c3_sync(p_record, p_actor, p_stepup, p_self);
  END IF;
  IF r.register_key = 'hlc' THEN unlocked := public.hlc_c3_sync(p_record, p_actor, p_stepup, p_self); END IF;   -- the approved links may complete the set
  RETURN unlocked || public.reg_complete_task_pre_0063(p_record, p_actor, p_stepup, p_self);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Q139: the legacy HLC requests into Procurement drafts (one-time, assisted, previewed, de-duplicated)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hlc_legacy_to_drafts(p_dry_run boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); regs int[]; h record; items jsonb := '[]'::jsonb; outcome text; dup uuid; dup_rec uuid; ent uuid; rid uuid; pd date; pno text;
  data jsonb; n_create int := 0; n_link int := 0; n_done int := 0; lv int; uid text; dropped boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_admin('procurement', 'administer') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy HLC migration needs a System Admin or a delegation of administer on Procurement.'));
  END IF;
  IF NOT coalesce(p_dry_run, true) THEN PERFORM public.calc_require_reason(p_reason); END IF;
  regs := public.app_actor_region_filter('procurement', 'administer');
  SELECT d.approval_levels INTO lv FROM public.register_definitions d WHERE d.register_key = 'procurement';
  FOR h IN
    SELECT DISTINCT ON (x.entity_id) x.id, x.entity_id, x.site_id, x.region_id, s.site_code,
      nullif(btrim(coalesce(x.data ->> 'request_no', '')), '') AS request_no, x.data ->> 'request_date' AS request_date
    FROM public.register_records x JOIN public.sites s ON s.id = x.site_id
    WHERE x.register_key = 'hlc' AND x.state <> 'voided' AND (x.data ? 'request_no' OR x.data ? 'request_date')
      AND (regs IS NULL OR x.region_id = ANY (regs)) AND public.app_region_read(false, x.region_id)
    ORDER BY x.entity_id, x.is_current DESC, x.version_no DESC
  LOOP
    dup := NULL; dup_rec := NULL; rid := NULL; dropped := false;
    BEGIN pd := h.request_date::date; EXCEPTION WHEN others THEN pd := NULL; END;
    IF pd IS NOT NULL AND (pd < DATE '2020-01-01' OR pd > public.cal_today()) THEN pd := NULL; END IF;
    dropped := h.request_date IS NOT NULL AND pd IS NULL;
    pno := left(h.request_no, 2000);
    SELECT m.procurement_record_id INTO rid FROM public.hlc_legacy_migrations m WHERE m.hlc_entity_id = h.entity_id;
    IF rid IS NOT NULL THEN
      outcome := 'already_migrated'; n_done := n_done + 1;
    ELSE
      IF pno IS NOT NULL THEN
        SELECT p.entity_id, p.id INTO dup, dup_rec FROM public.register_records p
          WHERE p.register_key = 'procurement' AND p.site_id = h.site_id AND p.state <> 'voided' AND p.data ->> 'scope' = 'HLC'
            AND lower(btrim(coalesce(p.data ->> 'pr_no', ''))) = lower(pno)
          ORDER BY p.is_current DESC, p.version_no DESC LIMIT 1;
      END IF;
      IF dup IS NOT NULL THEN
        outcome := 'duplicate'; rid := dup_rec; n_link := n_link + 1;
        IF NOT coalesce(p_dry_run, true) THEN
          INSERT INTO public.hlc_legacy_migrations (hlc_entity_id, hlc_record_id, procurement_entity_id, procurement_record_id, outcome, request_no, request_date, site_id, region_id, migrated_by, reason)
          VALUES (h.entity_id, h.id, dup, dup_rec, 'linked_existing', pno, pd, h.site_id, h.region_id, actor, btrim(p_reason));
        END IF;
      ELSE
        outcome := 'create'; n_create := n_create + 1;
        IF NOT coalesce(p_dry_run, true) THEN
          data := jsonb_strip_nulls(jsonb_build_object('scope', 'HLC', 'pr_no', pno, 'pr_date', pd::text,
            'remark', 'Migrated from the legacy HLC request of the HLC register (Q139): complete it and submit it.'));
          ent := gen_random_uuid();
          -- the draft belongs to the HLC Fiber Team (the procurement_hlc row decides its entry level); it is created by this function, not typed by the actor,
          -- so the entry-holder guard of the scope rows (b_reg_scope_entry, 0042) is not asked for it: the actor is cleared for this one insert
          uid := current_setting('app.user_id', true);
          PERFORM set_config('app.user_id', '', true);
          INSERT INTO public.register_records (entity_id, register_key, site_id, region_id, is_global, levels_required, data, custom, created_by, level_opened_at)
          VALUES (ent, 'procurement', h.site_id, h.region_id, false, coalesce(lv, 2), data, '{}'::jsonb, actor, now())
          RETURNING id INTO rid;
          PERFORM set_config('app.user_id', coalesce(uid, ''), true);
          PERFORM public.reg_step(rid, 1, 'create', actor, 'migrated from the legacy HLC request (Q139)', NULL, 'entry', false, false);
          PERFORM public.log_audit_write('hlc_legacy_draft_created', 'register_record', rid::text, NULL,
            jsonb_build_object('data', data, 'legacy_hlc_record_id', h.id, 'legacy_request_no', h.request_no, 'legacy_request_date', h.request_date), btrim(p_reason), h.site_id, h.region_id);
          INSERT INTO public.hlc_legacy_migrations (hlc_entity_id, hlc_record_id, procurement_entity_id, procurement_record_id, outcome, request_no, request_date, site_id, region_id, migrated_by, reason)
          VALUES (h.entity_id, h.id, ent, rid, 'created', pno, pd, h.site_id, h.region_id, actor, btrim(p_reason));
        END IF;
      END IF;
    END IF;
    items := items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('hlc_record_id', h.id, 'hlc_entity_id', h.entity_id, 'site_id', h.site_id, 'site_code', h.site_code,
      'region_id', h.region_id, 'request_no', h.request_no, 'request_date', h.request_date, 'outcome', outcome, 'procurement_record_id', rid,
      'date_dropped', CASE WHEN dropped THEN true END)));
  END LOOP;
  IF NOT coalesce(p_dry_run, true) THEN
    PERFORM public.log_audit_write('hlc_legacy_migration_run', 'setting', 'hlc_legacy_to_drafts', NULL,
      jsonb_build_object('created', n_create, 'linked_existing', n_link, 'already_migrated', n_done), btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('dry_run', coalesce(p_dry_run, true), 'items', items,
    'counts', jsonb_build_object('create', n_create, 'duplicate', n_link, 'already_migrated', n_done));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Q151: reader and writer of the GECOL order warnings
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gecol_order_warnings_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('enabled', coalesce((c ->> 'enabled')::boolean, false), 'chains', coalesce(c -> 'chains', '[]'::jsonb), 'billing_after', c -> 'billing_after',
    'version', coalesce((c ->> 'version')::int, 0), 'updated_at', (SELECT s.updated_at FROM public.settings s WHERE s.key = 'gecol.order_warnings'),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'gecol.order_warnings'),
    'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar) ORDER BY f.sort_order), '[]'::jsonb)
               FROM public.register_fields f WHERE f.register_key = 'gecol' AND f.field_type = 'date' AND f.is_active))
  FROM (SELECT public.gecol_order_cfg() AS c) x
$$;

CREATE OR REPLACE FUNCTION admin_save_gecol_order_warnings(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; k text; chain jsonb; el jsonb; i int; j int; seen text[]; dates text[]; ev jsonb; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM 1 FROM public.settings WHERE key = 'gecol.order_warnings' FOR UPDATE;
  cur := public.gecol_order_cfg();
  v := coalesce((cur ->> 'version')::int, 0);
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  SELECT coalesce(array_agg(f.code), ARRAY[]::text[]) INTO dates FROM public.register_fields f WHERE f.register_key = 'gecol' AND f.field_type = 'date' AND f.is_active;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with enabled, chains and billing_after.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('enabled', 'chains', 'billing_after') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.'); END IF;
  IF jsonb_typeof(p_config -> 'chains') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/chains', 'required', 'The list of chains is required (it may be empty).');
  ELSIF jsonb_array_length(p_config -> 'chains') > 10 THEN
    errs := errs || public.reg_err_item('/chains', 'too_many', 'At most 10 chains.');
  ELSE
    i := 0;
    FOR chain IN SELECT * FROM jsonb_array_elements(p_config -> 'chains') LOOP
      IF jsonb_typeof(chain) <> 'array' OR jsonb_array_length(chain) < 2 OR jsonb_array_length(chain) > 20 THEN
        errs := errs || public.reg_err_item('/chains/' || i, 'invalid', 'A chain lists 2 to 20 GECOL date fields in their expected order.');
      ELSE
        seen := ARRAY[]::text[]; j := 0;
        FOR el IN SELECT * FROM jsonb_array_elements(chain) LOOP
          IF jsonb_typeof(el) <> 'string' OR NOT ((el #>> '{}') = ANY (dates)) THEN
            errs := errs || public.reg_err_item('/chains/' || i || '/' || j, 'unknown_field', 'Not a date field of the GECOL register.');
          ELSIF (el #>> '{}') = ANY (seen) THEN
            errs := errs || public.reg_err_item('/chains/' || i || '/' || j, 'duplicate', 'This field is listed twice in the chain.');
          ELSE seen := seen || (el #>> '{}'); END IF;
          j := j + 1;
        END LOOP;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  ev := p_config -> 'billing_after';
  IF ev IS NOT NULL AND jsonb_typeof(ev) <> 'null' THEN
    IF jsonb_typeof(ev) <> 'string' OR NOT ((ev #>> '{}') = ANY (dates)) OR (ev #>> '{}') = 'billing_conversion_date' THEN
      errs := errs || public.reg_err_item('/billing_after', 'unknown_field', 'A GECOL date field other than the billing conversion, or null.');
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.gecol_order_warnings_json() - 'fields' - 'updated_at' - 'updated_by';
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('gecol.order_warnings', jsonb_build_object('enabled', p_config -> 'enabled', 'chains', p_config -> 'chains',
            'billing_after', coalesce(p_config -> 'billing_after', 'null'::jsonb), 'version', v + 1),
          'Q151: reviewer warnings on the order of the GECOL dates (see migration 0063).', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  after := public.gecol_order_warnings_json();
  PERFORM public.log_audit_write('gecol_order_warnings_update', 'setting', 'gecol.order_warnings', before, after - 'fields' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('p4c_procurement_hlc_gecol_applied', 'workflow', NULL,
        jsonb_build_object('q150', 'C3 closes when every required HLC request is approved by HLC', 'q148', 'execution dates need the approved HLC requests or an emergency exception',
                           'q139', 'hlc_legacy_to_drafts', 'q114', 'Dismantle contractor from the Procurement order', 'q151', 'gecol.order_warnings (off by default)'),
        'Owner answers 2026-11-04 Q114, Q139, Q148, Q150, Q151 (migration 0063).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'proc_order_cancelled(text)', 'hlc_links_of(uuid)', 'hlc_pr_set(uuid,uuid[])', 'hlc_pr_status(uuid,uuid[])', 'hlc_scope_links(uuid)', 'hlc_purchase_applies(uuid)',
    'reg_hlc_link_pr()', 'hlc_pr_links_copy()', 'hlc_set_pr_links(uuid,integer,uuid[])', 'hlc_pr_view(uuid)', 'dismantle_scope_of(text)',
    'dismantle_active_orders(uuid,text)', 'dismantle_order_rules()', 'dismantle_order_options(uuid,text)', 'hlc_exec_field(jsonb)', 'hlc_exception_allowed(uuid,integer)',
    'hlc_pr_gate(uuid,jsonb,uuid,integer,boolean)', 'reg_validate_p4c(uuid)', 'reg_validate_pre_0063(uuid)', 'reg_validate(uuid)', 'hlc_approval_guard()',
    'gecol_order_cfg()', 'gecol_field_label(text)', 'gecol_order_warnings(jsonb)', 'reg_warnings_p4c(uuid,jsonb)', 'reg_warnings_pre_0063(uuid)', 'reg_warnings(uuid)',
    'hlc_c3_close(uuid,uuid,date,uuid,boolean,boolean,text)', 'hlc_c3_sync(uuid,uuid,boolean,boolean)', 'reg_complete_task_pre_0063(uuid,uuid,boolean,boolean)',
    'reg_complete_task(uuid,uuid,boolean,boolean)', 'hlc_legacy_to_drafts(boolean,text)', 'gecol_order_warnings_json()', 'admin_save_gecol_order_warnings(jsonb,text,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON FUNCTION reg_warnings_pre_0063(uuid) FROM pmis_app;
    FOREACH f IN ARRAY ARRAY['reg_warnings(uuid)', 'hlc_pr_view(uuid)', 'hlc_set_pr_links(uuid,integer,uuid[])', 'dismantle_order_options(uuid,text)',
                             'hlc_legacy_to_drafts(boolean,text)', 'gecol_order_warnings_json()', 'admin_save_gecol_order_warnings(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON hlc_pr_links, hlc_legacy_migrations FROM pmis_app;
    GRANT SELECT ON hlc_pr_links, hlc_legacy_migrations TO pmis_app;
  END IF;
END $$;
