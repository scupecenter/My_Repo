-- 0053_p7_warehouse: work package P7 of the owner answers of 2026-11-04 (Q105, Q106, Q107) and the owner decision D6. Mirror: db/sql/052_p7_warehouse.sql
-- (kept identical). Plan: docs/plans/2026-11-04-owner-answers-gap.md section P7; answers: docs/spec/owner-answers-2026-11-04.md.
--
-- What it builds
--   1. Q105 quarantine. A Faulty or Damaged return no longer goes back into the stock: the returned quantity is held in `quarantine`, outside on_hand and
--      available. Only a Good return goes back to the stock. The effective condition of each return line (the line's own, else the document's, else Good)
--      is written on the line when the RN posts, so the stock never depends on a later edit. An RN whose reason is "Faulty or Damaged" must name a
--      condition before it is submitted. Serials of a Faulty or Damaged return stay "Returned" (never "In Stock"), as before.
--   2. Q106 numbering. `doc_sequences` is the numbering service, separate from the PDF: one sequence per document kind and region (pattern, reset rule,
--      counter per period), with the Q32 seed. A new movement without a Doc No. gets the next number of the active sequence of its type and region; a
--      manual unique number is still accepted. Every issued number is kept in `doc_number_issues` and is never issued again. The Doc No. of a posted
--      movement is locked: no later edit or new version of the record can change it. The forms module will reuse the same sequences (form_kind).
--   3. Q107 need rules. `warehouse_item_need_rules.status` (`confirmed`, `pending_configuration`) and `warehouse_items.code_source` (`master`,
--      `internal_provisional`). Only the D58 / D72 values the owner stated are confirmed (LPU Kit 2, Router 1, Cabinet 1, Battery 2); every other seeded
--      need keeps its current default but is pending configuration, and a pending need never counts toward "complete". The codes the Master WH sheet
--      carries are `master`; CW-01..CW-28 and the generated TE codes are `internal_provisional`. `quantity_rule` and `applies_when` get a documented shape:
--      how the units of a site are counted (per TE site, per RF sector of a WL vendor, per MW half-link), which items are alternatives (`group`, the three
--      router models), and when a rule applies (scope te_full / router_only (Q6), delivery scenario, regions).
--      `warehouse_region_vendors` is the Setting tblRegionVendor (D58): it is empty in the Master and stays empty until the owner gives it.
--   4. D6 (both). wh_site_dispatch(site): the TE Dispatch Complete date = the date of the latest posted TE DN of the site (Q65, for the Master comparison),
--      and, separately, GSDN Workspace status complete / short / pending_configuration / not_applicable against the site's approved need, line by line.
--   5. wh_config_gaps(): the owner data still missing (pending needs, provisional codes, regions without a WL vendor or a numbering sequence).
--   6. pmis_app only reads the new tables. Every write goes through the functions below (owner pmis_definer, search_path set), audited with
--      log_audit_write and a reason.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE wh_movements
  ADD COLUMN doc_no TEXT,
  ADD COLUMN doc_date DATE,
  ADD COLUMN sequence_key TEXT;
COMMENT ON COLUMN wh_movements.doc_no IS 'The Doc No. locked when the movement posted (Q106): the register record can no longer change it.';
COMMENT ON COLUMN wh_movements.doc_date IS 'The document date when the movement posted; the TE Dispatch Complete date is the latest posted TE DN date (Q65).';
COMMENT ON COLUMN wh_movements.sequence_key IS 'The numbering sequence that issued the Doc No. (NULL = typed by hand).';

ALTER TABLE warehouse_items ADD COLUMN code_source TEXT NOT NULL DEFAULT 'internal_provisional' CHECK (code_source IN ('master', 'internal_provisional'));
COMMENT ON COLUMN warehouse_items.code_source IS 'master = the item code of the Master WH sheet; internal_provisional = an internal code (CW-01..28, generated TE codes), not a confirmed manufacturer code (Q107).';
UPDATE warehouse_items SET code_source = 'master' WHERE item_code IN ('C280500A101A', 'C000000L114A', 'WG5-DUAL-BS', 'HANT262890', 'C280500C001A', 'WG5-CONN-PLUS',
  'KZ00-65F', 'KH14-056', 'S9500', 'S9501', 'S9700', 'MTS9514A', '800-00211', 'R450', 'R650');

ALTER TABLE warehouse_item_need_rules ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_configuration' CHECK (status IN ('confirmed', 'pending_configuration'));
ALTER TABLE warehouse_item_need_rules ADD CONSTRAINT warehouse_item_need_rules_confirmed_qty CHECK (status <> 'confirmed' OR quantity IS NOT NULL);
COMMENT ON COLUMN warehouse_item_need_rules.status IS 'confirmed = a need quantity the owner stated; pending_configuration = not given yet (it never counts toward complete, Q107).';
COMMENT ON COLUMN warehouse_item_need_rules.quantity_rule IS '{"per": "te_site" | "rf_sector" | "mw_half_link", "wl_vendor": "Cambium" | "Intracom", "group": "<items that are alternatives>"}; NULL = by the need unit name.';
COMMENT ON COLUMN warehouse_item_need_rules.applies_when IS '{"scope": ["te_full", "router_only"], "delivery_scenario": [...], "region_ids": [...]}; a missing key does not restrict; NULL = every TE site.';

-- The seed rules of 0026, only where nobody changed them: confirmed where the owner stated the value (D58 / D72), the rest pending (Q107); the unit
-- counting and Q6 (an IP Router Only site needs the router and nothing else from these rules).
UPDATE warehouse_item_need_rules n SET
  status = CASE WHEN (n.need_unit, n.quantity) IN (('LPU Kit', 2), ('Router', 1), ('Cabinet', 1), ('Battery', 2)) THEN 'confirmed' ELSE 'pending_configuration' END,
  quantity_rule = CASE n.need_unit
    WHEN 'Cambium Sector' THEN '{"per": "rf_sector", "wl_vendor": "Cambium"}'::jsonb
    WHEN 'Intracom Sector' THEN '{"per": "rf_sector", "wl_vendor": "Intracom"}'::jsonb
    WHEN 'MW Half-link' THEN '{"per": "mw_half_link"}'::jsonb
    WHEN 'Router' THEN '{"per": "te_site", "group": "ROUTER"}'::jsonb
    ELSE '{"per": "te_site"}'::jsonb END,
  applies_when = CASE WHEN n.need_unit = 'Router' THEN '{"scope": ["te_full", "router_only"]}'::jsonb ELSE '{"scope": ["te_full"]}'::jsonb END
FROM warehouse_items i
WHERE i.id = n.item_id AND n.quantity_rule IS NULL AND n.applies_when IS NULL
  AND (i.item_code, n.need_unit) IN (('C280500A101A', 'Cambium Sector'), ('C000000L114A', 'LPU Kit'), ('WG5-DUAL-BS', 'Intracom Sector'), ('HANT262890', 'Intracom Sector'),
    ('KZ00-65F', 'MW Half-link'), ('KH14-056', 'MW Half-link'), ('S9500', 'Router'), ('S9501', 'Router'), ('S9700', 'Router'), ('MTS9514A', 'Cabinet'), ('800-00211', 'Battery'));

-- Q105: the effective condition of the posted return lines (the line's own, else the document's, else Good), and the locked Doc No. and date of the
-- posted movements. The register backstop lets the migration role write (app_is_seeding).
UPDATE wh_movement_lines l SET condition = coalesce(l.condition, CASE WHEN r.data ->> 'condition' IN ('Good', 'Faulty', 'Damaged') THEN r.data ->> 'condition' END, 'Good')
FROM wh_movements m JOIN register_records r ON r.entity_id = m.entity_id AND r.is_current
WHERE l.movement_id = m.id AND m.status = 'posted' AND m.kind = 'return' AND l.condition IS NULL;
UPDATE wh_movements m SET doc_no = nullif(btrim(r.data ->> 'doc_no'), ''),
  doc_date = CASE WHEN r.data ->> 'doc_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (r.data ->> 'doc_date')::date END
FROM register_records r WHERE r.entity_id = m.entity_id AND r.is_current AND m.status = 'posted';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. New tables: numbering (Q106) and the region WL vendor (D58)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE doc_sequences (
  key            TEXT PRIMARY KEY CHECK (key ~ '^[A-Z0-9][A-Z0-9-]{1,40}$'),
  form_kind      TEXT CHECK (form_kind IN ('dn', 'rn', 'pac', 'fac', 'snag_list')),
  record_type    TEXT CHECK (record_type IN ('te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj')),
  region_id      INTEGER REFERENCES regions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  region_code    TEXT CHECK (region_code ~ '^[A-Z]{1,6}$'),
  pattern        TEXT    NOT NULL CHECK (char_length(pattern) BETWEEN 6 AND 80),
  reset          TEXT    NOT NULL DEFAULT 'yearly' CHECK (reset IN ('never', 'yearly')),
  last_issued    TEXT,
  last_issued_at TIMESTAMPTZ(6),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by     UUID,
  CONSTRAINT doc_sequences_target CHECK (form_kind IS NOT NULL OR record_type IS NOT NULL),
  CONSTRAINT doc_sequences_site_types CHECK (record_type IS NULL OR (record_type IN ('pl', 'open', 'adj')) = (region_id IS NULL))
);
COMMENT ON TABLE doc_sequences IS 'Numbering sequences (Q32, Q106): one per document kind and region; the counter lives in doc_sequence_counters (one per period). Configuration: written only by admin_save_doc_sequence.';
CREATE UNIQUE INDEX doc_sequences_one_active ON doc_sequences (record_type, coalesce(region_id, 0)) WHERE is_active AND record_type IS NOT NULL;
CREATE UNIQUE INDEX doc_sequences_one_active_form ON doc_sequences (form_kind, coalesce(region_id, 0)) WHERE is_active AND form_kind IS NOT NULL;

CREATE TABLE doc_sequence_counters (
  seq_key    TEXT    NOT NULL REFERENCES doc_sequences (key) ON DELETE RESTRICT ON UPDATE CASCADE,
  period     INTEGER NOT NULL,                 -- the year for a yearly reset, 0 for never
  next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  PRIMARY KEY (seq_key, period)
);

CREATE TABLE doc_number_issues (
  number      TEXT PRIMARY KEY,
  seq_key     TEXT NOT NULL REFERENCES doc_sequences (key) ON DELETE RESTRICT ON UPDATE CASCADE,
  target_kind TEXT NOT NULL,
  target_id   UUID,
  issued_by   UUID,
  issued_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
COMMENT ON TABLE doc_number_issues IS 'Every number a sequence issued. A number is never issued twice, even when its document is voided (CLAUDE.md "Numbers are never reused or deleted").';
CREATE INDEX doc_number_issues_lower_idx ON doc_number_issues (lower(number));

CREATE TABLE warehouse_region_vendors (
  region_id  INTEGER PRIMARY KEY REFERENCES regions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  wl_vendor  TEXT    NOT NULL CHECK (wl_vendor IN ('Cambium', 'Intracom')),
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by UUID
);
COMMENT ON TABLE warehouse_region_vendors IS 'Setting tblRegionVendor (D58): the WL vendor of each region decides whether the RF sectors of a site need Cambium or Intracom items. Empty in the Master.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doc_sequences', 'doc_sequence_counters', 'doc_number_issues', 'warehouse_region_vendors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY rls_seed_write ON %I FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON doc_sequences, doc_sequence_counters, doc_number_issues TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_region_vendors TO pmis_definer;
GRANT SELECT ON regions, sites, register_records TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON doc_sequences, doc_sequence_counters, doc_number_issues, warehouse_region_vendors FROM pmis_app;
    GRANT SELECT ON doc_sequences, doc_sequence_counters, doc_number_issues, warehouse_region_vendors TO pmis_app;
  END IF;
END $$;

-- Seed (Q32): the CW forms of Tripoli, the only region code known (TR). TE DN / RN and the store documents (PL, OPEN, ADJ) follow the same pattern
-- (ASSUMPTION, open question Q272). The other regions get a sequence when the admin enters their code: until then their documents take a typed number.
INSERT INTO doc_sequences (key, form_kind, record_type, region_id, region_code, pattern, reset) VALUES
  ('DN-CW-TR',  'dn',        'cw_dn', 1,    'TR', 'DN-CW-{REGION}-{YYYY}-{SEQ:4}',  'yearly'),
  ('RN-CW-TR',  'rn',        'cw_rn', 1,    'TR', 'RN-CW-{REGION}-{YYYY}-{SEQ:4}',  'yearly'),
  ('PAC-CW-TR', 'pac',       NULL,    1,    'TR', 'PAC-CW-{REGION}-{YYYY}-{SEQ:4}', 'yearly'),
  ('FAC-CW-TR', 'fac',       NULL,    1,    'TR', 'FAC-CW-{REGION}-{YYYY}-{SEQ:4}', 'yearly'),
  ('SL-CW-TR',  'snag_list', NULL,    1,    'TR', 'SL-CW-{REGION}-{YYYY}-{SEQ:4}',  'yearly'),
  ('DN-TE-TR',  NULL,        'te_dn', 1,    'TR', 'DN-TE-{REGION}-{YYYY}-{SEQ:4}',  'yearly'),
  ('RN-TE-TR',  NULL,        'te_rn', 1,    'TR', 'RN-TE-{REGION}-{YYYY}-{SEQ:4}',  'yearly'),
  ('PL-WH',     NULL,        'pl',    NULL, NULL, 'PL-WH-{YYYY}-{SEQ:4}',           'yearly'),
  ('OPEN-WH',   NULL,        'open',  NULL, NULL, 'OPEN-WH-{YYYY}-{SEQ:4}',         'yearly'),
  ('ADJ-WH',    NULL,        'adj',   NULL, NULL, 'ADJ-WH-{YYYY}-{SEQ:4}',          'yearly')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Numbering service (Q106)
-- ---------------------------------------------------------------------------------------------------------------------
-- Pattern tokens: {REGION} (the sequence's region code), {YYYY}, {YY}, {SEQ:n} (n = 1..9 digits, exactly once). Literal characters A-Z, 0-9, - / _ .
-- A yearly reset needs the year in the number, or the numbers would repeat. Returns the field errors (empty = valid).
CREATE OR REPLACE FUNCTION doc_pattern_errors(p_pattern text, p_reset text, p_region_code text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb; rest text;
BEGIN
  IF p_pattern IS NULL OR char_length(p_pattern) NOT BETWEEN 6 AND 80 THEN
    RETURN jsonb_build_array(jsonb_build_object('path', '/pattern', 'code', 'invalid', 'message', 'The pattern has 6 to 80 characters.'));
  END IF;
  IF (SELECT count(*) FROM regexp_matches(p_pattern, '\{SEQ:[1-9]\}', 'g')) <> 1 THEN
    errs := errs || jsonb_build_object('path', '/pattern', 'code', 'sequence_token', 'message', 'The pattern holds {SEQ:n} (n = 1 to 9 digits) exactly once.');
  END IF;
  rest := regexp_replace(regexp_replace(regexp_replace(regexp_replace(p_pattern, '\{SEQ:[1-9]\}', '', 'g'), '\{YYYY\}', '', 'g'), '\{YY\}', '', 'g'), '\{REGION\}', '', 'g');
  IF rest !~ '^[A-Z0-9/_.-]*$' THEN
    errs := errs || jsonb_build_object('path', '/pattern', 'code', 'invalid', 'message', 'Only the tokens {REGION}, {YYYY}, {YY}, {SEQ:n} and the characters A-Z 0-9 - / _ . are allowed.');
  END IF;
  IF p_reset = 'yearly' AND p_pattern !~ '\{YYYY\}|\{YY\}' THEN
    errs := errs || jsonb_build_object('path', '/pattern', 'code', 'year_required', 'message', 'A sequence that restarts every year needs {YYYY} or {YY} in the pattern.');
  END IF;
  IF p_pattern ~ '\{REGION\}' AND p_region_code IS NULL THEN
    errs := errs || jsonb_build_object('path', '/region_code', 'code', 'required', 'message', 'The pattern uses {REGION}: the region code is required.');
  END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION doc_format_number(p_pattern text, p_region_code text, p_year integer, p_seq integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE r text; w int;
BEGIN
  r := replace(replace(replace(p_pattern, '{YYYY}', lpad(p_year::text, 4, '0')), '{YY}', right(lpad(p_year::text, 4, '0'), 2)), '{REGION}', coalesce(p_region_code, ''));
  w := (substring(r FROM '\{SEQ:([1-9])\}'))::int;
  RETURN regexp_replace(r, '\{SEQ:[1-9]\}', lpad(p_seq::text, greatest(w, char_length(p_seq::text)), '0'));
END $$;

CREATE OR REPLACE FUNCTION doc_period(p_reset text, p_date date) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_reset = 'yearly' THEN extract(year FROM p_date)::int ELSE 0 END
$$;

CREATE OR REPLACE FUNCTION doc_today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (now() AT TIME ZONE 'Africa/Tripoli')::date
$$;

-- Issue the next number of a sequence (internal: called by wh_create_movement, later by the forms module; never by pmis_app). The counter row is locked,
-- so two documents never get the same number; a number already issued, or typed by hand on a warehouse document, is skipped.
CREATE OR REPLACE FUNCTION doc_next_number(p_key text, p_date date, p_target_kind text, p_target uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.doc_sequences%ROWTYPE; per int; n int; num text; tries int := 0; d date := coalesce(p_date, public.doc_today());
BEGIN
  SELECT * INTO s FROM public.doc_sequences WHERE key = p_key AND is_active FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  per := public.doc_period(s.reset, d);
  INSERT INTO public.doc_sequence_counters (seq_key, period, next_value) VALUES (p_key, per, 1) ON CONFLICT (seq_key, period) DO NOTHING;
  SELECT c.next_value INTO n FROM public.doc_sequence_counters c WHERE c.seq_key = p_key AND c.period = per FOR UPDATE;
  LOOP
    num := public.doc_format_number(s.pattern, s.region_code, extract(year FROM d)::int, n);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.doc_number_issues x WHERE lower(x.number) = lower(num))
          AND NOT EXISTS (SELECT 1 FROM public.register_records x WHERE x.register_key = 'warehouse' AND lower(x.data ->> 'doc_no') = lower(num));
    n := n + 1; tries := tries + 1;
    IF tries > 10000 THEN RAISE EXCEPTION 'doc_next_number: no free number in sequence %', p_key; END IF;
  END LOOP;
  UPDATE public.doc_sequence_counters SET next_value = n + 1 WHERE seq_key = p_key AND period = per;
  INSERT INTO public.doc_number_issues (number, seq_key, target_kind, target_id, issued_by) VALUES (num, p_key, p_target_kind, p_target, public.app_actor());
  UPDATE public.doc_sequences SET last_issued = num, last_issued_at = now() WHERE key = p_key;
  RETURN num;
END $$;

CREATE OR REPLACE FUNCTION doc_sequence_json(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('key', s.key, 'form_kind', s.form_kind, 'record_type', s.record_type, 'region_id', s.region_id, 'region_code', s.region_code,
    'pattern', s.pattern, 'reset', s.reset,
    'next_value', coalesce((SELECT c.next_value FROM public.doc_sequence_counters c WHERE c.seq_key = s.key AND c.period = public.doc_period(s.reset, public.doc_today())), 1),
    'last_issued', s.last_issued, 'last_issued_at', s.last_issued_at,
    'next_preview', public.doc_format_number(s.pattern, s.region_code, extract(year FROM public.doc_today())::int,
      coalesce((SELECT c.next_value FROM public.doc_sequence_counters c WHERE c.seq_key = s.key AND c.period = public.doc_period(s.reset, public.doc_today())), 1)),
    'is_active', s.is_active, 'version', s.version, 'updated_at', s.updated_at)
  FROM public.doc_sequences s WHERE s.key = p_key
$$;

-- Create (p_create) or edit a sequence: System Admin or a delegate of settings.edit for all regions, with a reason; audited with before and after.
-- p_patch keys: key, form_kind, record_type, region_id (create only), region_code, pattern, reset, next_value (only up), is_active. Unknown keys are refused.
CREATE OR REPLACE FUNCTION admin_save_doc_sequence(p_key text, p_create boolean, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.doc_sequences%ROWTYPE; before jsonb; errs jsonb := '[]'::jsonb; k text; per int; cur int; nv int;
  allowed text[] := CASE WHEN p_create THEN ARRAY['key', 'form_kind', 'record_type', 'region_id', 'region_code', 'pattern', 'reset', 'next_value', 'is_active']
                         ELSE ARRAY['region_code', 'pattern', 'reset', 'next_value', 'is_active'] END;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN p_patch := '{}'::jsonb; END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (k = ANY (allowed)) THEN errs := errs || public.reg_err_item('/' || k, 'unknown_field', 'This field cannot be set here.'); END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_create THEN
    IF coalesce(p_key, '') !~ '^[A-Z0-9][A-Z0-9-]{1,40}$' THEN errs := errs || public.reg_err_item('/key', 'invalid', 'Upper-case letters, digits and hyphens.'); END IF;
    IF p_patch ? 'form_kind' AND NOT (p_patch ->> 'form_kind' = ANY (ARRAY['dn', 'rn', 'pac', 'fac', 'snag_list'])) THEN errs := errs || public.reg_err_item('/form_kind', 'not_in_list', 'dn, rn, pac, fac or snag_list.'); END IF;
    IF p_patch ? 'record_type' AND NOT (p_patch ->> 'record_type' = ANY (ARRAY['te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj'])) THEN errs := errs || public.reg_err_item('/record_type', 'not_in_list', 'A warehouse document type.'); END IF;
    IF p_patch ->> 'form_kind' IS NULL AND p_patch ->> 'record_type' IS NULL THEN errs := errs || public.reg_err_item('/record_type', 'required', 'A sequence numbers a form kind, a warehouse document type, or both.'); END IF;
    IF p_patch ->> 'form_kind' IS NOT NULL AND p_patch ->> 'record_type' IS NOT NULL
       AND (p_patch ->> 'form_kind', p_patch ->> 'record_type') NOT IN (('dn', 'cw_dn'), ('rn', 'cw_rn')) THEN
      errs := errs || public.reg_err_item('/record_type', 'mismatch', 'Only the CW DN and RN forms share their sequence with a warehouse document type.');
    END IF;
    IF p_patch ? 'region_id' AND jsonb_typeof(p_patch -> 'region_id') <> 'null' AND NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id::text = p_patch ->> 'region_id') THEN
      errs := errs || public.reg_err_item('/region_id', 'unknown_region', 'Unknown region.');
    END IF;
    IF p_patch ->> 'record_type' IN ('pl', 'open', 'adj') AND p_patch ->> 'region_id' IS NOT NULL THEN errs := errs || public.reg_err_item('/region_id', 'not_site_scoped', 'PL, OPEN and ADJ have no site and no region.'); END IF;
    IF p_patch ->> 'record_type' IN ('te_dn', 'cw_dn', 'te_rn', 'cw_rn') AND p_patch ->> 'region_id' IS NULL THEN errs := errs || public.reg_err_item('/region_id', 'required', 'A DN or RN sequence belongs to a region.'); END IF;
    IF EXISTS (SELECT 1 FROM public.doc_sequences x WHERE x.key = p_key) THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A sequence with this key exists already.')); END IF;
  ELSE
    SELECT * INTO s FROM public.doc_sequences WHERE key = p_key FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The sequence does not exist.')); END IF;
    IF p_version IS NOT NULL AND p_version <> s.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    before := public.doc_sequence_json(p_key);
  END IF;
  IF p_patch ? 'region_code' AND jsonb_typeof(p_patch -> 'region_code') <> 'null' AND p_patch ->> 'region_code' !~ '^[A-Z]{1,6}$' THEN errs := errs || public.reg_err_item('/region_code', 'invalid', '1 to 6 upper-case letters.'); END IF;
  IF p_patch ? 'reset' AND NOT (p_patch ->> 'reset' = ANY (ARRAY['never', 'yearly'])) THEN errs := errs || public.reg_err_item('/reset', 'not_in_list', 'never or yearly.'); END IF;
  IF p_patch ? 'next_value' AND coalesce(p_patch ->> 'next_value', '') !~ '^[0-9]{1,9}$' THEN errs := errs || public.reg_err_item('/next_value', 'invalid', 'A whole number from 1.'); END IF;
  IF p_patch ? 'is_active' AND jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN errs := errs || public.reg_err_item('/is_active', 'invalid', 'true or false.'); END IF;
  IF p_create AND NOT (p_patch ? 'pattern') THEN errs := errs || public.reg_err_item('/pattern', 'required', 'The pattern is required.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  errs := public.doc_pattern_errors(coalesce(p_patch ->> 'pattern', s.pattern), coalesce(p_patch ->> 'reset', s.reset, 'yearly'),
    CASE WHEN p_patch ? 'region_code' THEN p_patch ->> 'region_code' ELSE s.region_code END);
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  BEGIN
    IF p_create THEN
      INSERT INTO public.doc_sequences (key, form_kind, record_type, region_id, region_code, pattern, reset, is_active, updated_by)
      VALUES (p_key, p_patch ->> 'form_kind', p_patch ->> 'record_type', (p_patch ->> 'region_id')::int, p_patch ->> 'region_code', p_patch ->> 'pattern',
              coalesce(p_patch ->> 'reset', 'yearly'), coalesce((p_patch ->> 'is_active')::boolean, true), public.app_actor())
      RETURNING * INTO s;
    ELSE
      UPDATE public.doc_sequences SET
        region_code = CASE WHEN p_patch ? 'region_code' THEN p_patch ->> 'region_code' ELSE region_code END,
        pattern = coalesce(p_patch ->> 'pattern', pattern), reset = coalesce(p_patch ->> 'reset', reset),
        is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
        version = version + 1, updated_at = now(), updated_by = public.app_actor()
      WHERE key = p_key RETURNING * INTO s;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'Another active sequence already numbers this type in this region.'));
  END;
  IF p_patch ? 'next_value' THEN
    nv := (p_patch ->> 'next_value')::int;
    per := public.doc_period(s.reset, public.doc_today());
    INSERT INTO public.doc_sequence_counters (seq_key, period, next_value) VALUES (s.key, per, 1) ON CONFLICT (seq_key, period) DO NOTHING;
    SELECT c.next_value INTO cur FROM public.doc_sequence_counters c WHERE c.seq_key = s.key AND c.period = per FOR UPDATE;
    IF nv < cur THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/next_value', 'only_up', 'The next number can only go up (it is ' || cur || '): numbers are never reused.')));
    END IF;
    UPDATE public.doc_sequence_counters SET next_value = nv WHERE seq_key = s.key AND period = per;
  END IF;
  PERFORM public.log_audit_write(CASE WHEN p_create THEN 'doc_sequence_create' ELSE 'doc_sequence_update' END, 'doc_sequence', s.key, before, public.doc_sequence_json(s.key), p_reason);
  RETURN public.doc_sequence_json(s.key);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Region WL vendor (D58, Setting tblRegionVendor)
-- ---------------------------------------------------------------------------------------------------------------------
-- Set (Cambium / Intracom) or clear (NULL) the WL vendor of a region: System Admin or a delegate of warehouse_items.edit for all regions, reason, audited.
CREATE OR REPLACE FUNCTION admin_save_region_vendor(p_region integer, p_vendor text, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.warehouse_region_vendors%ROWTYPE; before jsonb; after jsonb;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  IF NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id = p_region) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'Unknown region.')); END IF;
  IF p_vendor IS NOT NULL AND NOT (p_vendor = ANY (ARRAY['Cambium', 'Intracom'])) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/wl_vendor', 'not_in_list', 'Cambium or Intracom.')));
  END IF;
  SELECT * INTO v FROM public.warehouse_region_vendors WHERE region_id = p_region FOR UPDATE;
  IF FOUND THEN
    IF p_version IS NOT NULL AND p_version <> v.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    before := jsonb_build_object('region_id', v.region_id, 'wl_vendor', v.wl_vendor, 'version', v.version);
  END IF;
  IF p_vendor IS NULL THEN
    DELETE FROM public.warehouse_region_vendors WHERE region_id = p_region;
    after := jsonb_build_object('region_id', p_region, 'wl_vendor', NULL, 'version', coalesce(v.version, 0) + 1);
  ELSE
    INSERT INTO public.warehouse_region_vendors (region_id, wl_vendor, updated_by) VALUES (p_region, p_vendor, public.app_actor())
    ON CONFLICT (region_id) DO UPDATE SET wl_vendor = EXCLUDED.wl_vendor, version = public.warehouse_region_vendors.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
    RETURNING * INTO v;
    after := jsonb_build_object('region_id', v.region_id, 'wl_vendor', v.wl_vendor, 'version', v.version);
  END IF;
  PERFORM public.log_audit_write('warehouse_region_vendor_save', 'warehouse_region_vendor', p_region::text, before, after, p_reason);
  RETURN after;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Stock with quarantine (Q105)
-- ---------------------------------------------------------------------------------------------------------------------
-- Central stock (p_site NULL): receipts and Good returns add, issues subtract, adjustments are signed; a Faulty or Damaged return goes to quarantine,
-- never to on_hand or available. reserved = pending issues and pending negative adjustments. Per site: net DN minus RN (any condition), quarantine 0.
DROP FUNCTION wh_stock_levels(uuid, uuid);
CREATE FUNCTION wh_stock_levels(p_item uuid DEFAULT NULL, p_site uuid DEFAULT NULL)
RETURNS TABLE (item_id uuid, on_hand numeric, reserved numeric, pending_issue numeric, pending_return numeric, available numeric, quarantine numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH l AS (
    SELECT li.item_id AS iid, li.qty, m.kind, m.status, (m.kind = 'return' AND li.condition IN ('Faulty', 'Damaged')) AS quar
    FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id
    WHERE m.status <> 'cancelled' AND (p_item IS NULL OR li.item_id = p_item)
      AND (p_site IS NULL OR (m.site_id = p_site AND m.kind IN ('issue', 'return')))
  ), s AS (
    SELECT l.iid,
      sum(CASE WHEN l.status = 'posted' THEN
                 CASE WHEN p_site IS NULL THEN CASE WHEN l.kind = 'issue' THEN -l.qty WHEN l.quar THEN 0 ELSE l.qty END
                      ELSE CASE l.kind WHEN 'issue' THEN l.qty ELSE -l.qty END END
               ELSE 0 END) AS oh,
      sum(CASE WHEN l.status = 'pending' AND p_site IS NULL AND (l.kind = 'issue' OR (l.kind = 'adjustment' AND l.qty < 0)) THEN abs(l.qty) ELSE 0 END) AS rs,
      sum(CASE WHEN l.status = 'pending' AND l.kind = 'issue' THEN l.qty ELSE 0 END) AS pi,
      sum(CASE WHEN l.status = 'pending' AND l.kind = 'return' THEN l.qty ELSE 0 END) AS pr,
      sum(CASE WHEN l.status = 'posted' AND p_site IS NULL AND l.quar THEN l.qty ELSE 0 END) AS qu
    FROM l GROUP BY l.iid
  )
  SELECT i.id, coalesce(s.oh, 0), coalesce(s.rs, 0), coalesce(s.pi, 0), coalesce(s.pr, 0), coalesce(s.oh, 0) - coalesce(s.rs, 0), coalesce(s.qu, 0)
  FROM public.warehouse_items i LEFT JOIN s ON s.iid = i.id
  WHERE (p_item IS NULL OR i.id = p_item) AND (p_site IS NULL OR s.iid IS NOT NULL) AND (i.is_active OR s.iid IS NOT NULL)
$$;

-- The movement follows its register record: approved -> posted (stock, serials, site quantity), voided -> cancelled (reservation released). 0053: the
-- effective condition of each return line is written on the line (Q105), and the Doc No. and date are locked on the movement (Q106).
CREATE OR REPLACE FUNCTION wh_on_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.wh_movements%ROWTYPE; ln public.wh_movement_lines%ROWTYPE; doc text := nullif(btrim(NEW.data ->> 'doc_no'), '');
  ddate date := CASE WHEN NEW.data ->> 'doc_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (NEW.data ->> 'doc_date')::date ELSE public.doc_today() END; cond text;
BEGIN
  SELECT * INTO m FROM public.wh_movements WHERE entity_id = NEW.entity_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'pending' THEN RETURN NULL; END IF;
  IF NEW.state = 'voided' THEN
    UPDATE public.wh_movements SET status = 'cancelled', cancel_reason = NEW.void_reason, version = version + 1 WHERE id = m.id;
    RETURN NULL;
  END IF;
  FOR ln IN SELECT * FROM public.wh_movement_lines WHERE movement_id = m.id LOOP
    IF m.kind = 'receipt' AND cardinality(ln.serials) > 0 THEN
      INSERT INTO public.warehouse_serials (item_id, serial_no, pl_invoice_no, status, is_global) SELECT ln.item_id, s, doc, 'In Stock', true FROM unnest(ln.serials) s;
    ELSIF m.kind = 'issue' THEN
      UPDATE public.warehouse_serials SET site_id = m.site_id, region_id = m.region_id, is_global = false, dn_no = doc, dispatch_date = ddate, status = 'Dispatched'
        WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials);
    ELSIF m.kind = 'return' THEN
      cond := coalesce(ln.condition, CASE WHEN NEW.data ->> 'condition' IN ('Good', 'Faulty', 'Damaged') THEN NEW.data ->> 'condition' END, 'Good');
      UPDATE public.wh_movement_lines SET condition = cond WHERE id = ln.id AND condition IS DISTINCT FROM cond;
      UPDATE public.warehouse_serials SET rn_no = doc, return_condition = cond, status = CASE WHEN cond = 'Good' THEN 'In Stock' ELSE 'Returned' END,
        site_id = NULL, region_id = NULL, is_global = true WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials);
    END IF;
    IF m.kind IN ('issue', 'return') THEN
      INSERT INTO public.warehouse_site_qty (site_id, region_id, item_id, dispatched) VALUES (m.site_id, m.region_id, ln.item_id, CASE m.kind WHEN 'issue' THEN ln.qty ELSE -ln.qty END)
      ON CONFLICT (site_id, item_id) DO UPDATE SET dispatched = public.warehouse_site_qty.dispatched + EXCLUDED.dispatched;
    END IF;
  END LOOP;
  UPDATE public.wh_movements SET status = 'posted', posted_at = now(), doc_no = doc, doc_date = ddate, version = version + 1 WHERE id = m.id;
  RETURN NULL;
END $$;

-- Q106: the Doc No. of a posted movement is locked. No edit and no new version of its register record may change it.
CREATE OR REPLACE FUNCTION wh_doc_no_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE locked text;
BEGIN
  SELECT m.doc_no INTO locked FROM public.wh_movements m WHERE m.entity_id = NEW.entity_id AND m.status = 'posted' AND m.doc_no IS NOT NULL;
  IF locked IS NOT NULL AND nullif(btrim(NEW.data ->> 'doc_no'), '') IS DISTINCT FROM locked THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The Doc No. of a posted document is locked (' || locked || ').',
      'errors', public.reg_err_item('/data/doc_no', 'doc_no_locked', 'The Doc No. is locked after posting: ' || locked)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_wh_doc_no_lock BEFORE INSERT OR UPDATE OF data ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'warehouse') EXECUTE FUNCTION wh_doc_no_lock();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Create a movement: 0028 text plus automatic numbering (Q106)
-- ---------------------------------------------------------------------------------------------------------------------
-- A document without a Doc No. takes the next number of the active sequence of its type and region (none configured = it stays empty and must be
-- typed before the submit). A typed number is accepted when it is unique and was never issued by a sequence.
CREATE OR REPLACE FUNCTION wh_create_movement(p_record_type text, p_site uuid, p_data jsonb, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rid uuid; rec public.register_records%ROWTYPE; mid uuid; kind_ text; ln jsonb; i int := 0; it public.warehouse_items%ROWTYPE; q numeric; qa numeric; errs jsonb := '[]'::jsonb;
  sers text[]; sn text; st record; net numeric; ser_row public.warehouse_serials%ROWTYPE; dup uuid; docno text; seen uuid[] := ARRAY[]::uuid[]; iid uuid; seq text;
BEGIN
  kind_ := CASE WHEN p_record_type IN ('te_dn', 'cw_dn') THEN 'issue' WHEN p_record_type IN ('te_rn', 'cw_rn') THEN 'return' WHEN p_record_type IN ('pl', 'open') THEN 'receipt' WHEN p_record_type = 'adj' THEN 'adjustment' END;
  IF kind_ IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a warehouse document type.')));
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/lines', 'required', 'At least one line is required.')));
  END IF;
  -- the register checks who may create (grant, entry holder, region of the site) and the header fields
  rid := public.reg_save_record('warehouse', NULL, NULL, p_site, p_record_type, coalesce(p_data, '{}'::jsonb), NULL, NULL, false);
  SELECT * INTO rec FROM public.register_records WHERE id = rid;
  docno := btrim(coalesce(rec.data ->> 'doc_no', ''));
  IF docno <> '' THEN
    -- duplicate Doc No. only after authorization; the existing id is not returned (it may be outside the caller's regions)
    SELECT x.id INTO dup FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.id <> rid AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(docno) LIMIT 1;
    IF dup IS NOT NULL OR EXISTS (SELECT 1 FROM public.doc_number_issues x WHERE lower(x.number) = lower(docno)) THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'Duplicate Doc No.: ' || docno));
    END IF;
  ELSE
    SELECT k.key INTO seq FROM public.doc_sequences k WHERE k.is_active AND k.record_type = p_record_type AND k.region_id IS NOT DISTINCT FROM rec.region_id;
    IF seq IS NOT NULL THEN
      docno := public.doc_next_number(seq, CASE WHEN rec.data ->> 'doc_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (rec.data ->> 'doc_date')::date END, 'wh_movement', rec.entity_id);
      UPDATE public.register_records SET data = data || jsonb_build_object('doc_no', docno) WHERE id = rid;
      PERFORM public.log_audit_write('doc_number_issue', 'register_record', rid::text, NULL, jsonb_build_object('doc_no', docno, 'sequence_key', seq), NULL, rec.site_id, rec.region_id);
    END IF;
  END IF;
  INSERT INTO public.wh_movements (entity_id, record_id, record_type, kind, site_id, region_id, is_global, created_by, sequence_key)
  VALUES (rec.entity_id, rid, p_record_type, kind_, rec.site_id, rec.region_id, rec.is_global, public.app_actor(), seq) RETURNING id INTO mid;

  -- lock the items in a fixed order: two documents cannot both take the last quantity
  PERFORM 1 FROM public.warehouse_items w WHERE w.id IN (SELECT (e ->> 'item_id')::uuid FROM jsonb_array_elements(p_lines) e WHERE e ->> 'item_id' ~* '^[0-9a-f-]{36}$') ORDER BY w.id FOR UPDATE;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    i := i + 1;
    IF coalesce(ln ->> 'item_id', '') !~* '^[0-9a-f-]{36}$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'required', 'The item is required.'); CONTINUE; END IF;
    iid := (ln ->> 'item_id')::uuid;
    SELECT * INTO it FROM public.warehouse_items w WHERE w.id = iid AND w.is_active;
    IF NOT FOUND THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'unknown_item', 'Unknown or inactive item.'); CONTINUE; END IF;
    IF iid = ANY (seen) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'duplicate', 'The item appears twice: use one line per item.'); CONTINUE; END IF;
    seen := seen || iid;
    IF coalesce(ln ->> 'qty', '') !~ '^-?[0-9]+(\.[0-9]{1,3})?$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'invalid', 'A number.'); CONTINUE; END IF;
    q := (ln ->> 'qty')::numeric;
    IF (kind_ <> 'adjustment' AND q <= 0) OR q = 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'not_positive', CASE WHEN kind_ = 'adjustment' THEN 'The quantity cannot be zero.' ELSE 'The quantity must be above zero (only an adjustment may be negative).' END); CONTINUE; END IF;
    IF lower(coalesce(it.unit, '')) IN ('pcs', 'set') AND q <> trunc(q) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'whole_units', 'No fraction in whole units (pieces and sets).'); CONTINUE; END IF;
    qa := NULL;
    IF ln ? 'qty_approved' AND jsonb_typeof(ln -> 'qty_approved') <> 'null' THEN
      IF kind_ <> 'issue' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty_approved', 'not_applicable', 'Qty Approved belongs to a delivery note.'); CONTINUE; END IF;
      IF coalesce(ln ->> 'qty_approved', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (ln ->> 'qty_approved')::numeric < q THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty_approved', 'below_dispatched', 'Qty Approved is a number not below the dispatched quantity.'); CONTINUE; END IF;
      qa := (ln ->> 'qty_approved')::numeric;
    END IF;
    IF ln ? 'condition' AND jsonb_typeof(ln -> 'condition') <> 'null' AND (kind_ <> 'return' OR ln ->> 'condition' NOT IN ('Good', 'Faulty', 'Damaged')) THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/condition', 'invalid', 'Condition (Good, Faulty, Damaged) belongs to a return note.'); CONTINUE;
    END IF;

    -- serials: PL, DN and RN rows of a serial-tracked item carry exactly one serial per unit (WH Serials, DQ19)
    sers := CASE WHEN ln ? 'serials' AND jsonb_typeof(ln -> 'serials') = 'array' THEN ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(ln -> 'serials') x) ELSE ARRAY[]::text[] END;
    IF cardinality(sers) <> (SELECT count(DISTINCT s) FROM unnest(sers) s) OR '' = ANY (sers) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'A serial appears twice or is empty.'); CONTINUE; END IF;
    IF NOT it.serialised AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_serial_tracked', 'This item is not serial-tracked.'); CONTINUE; END IF;
    IF it.serialised AND kind_ = 'adjustment' AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_applicable', 'An adjustment carries no serials.'); CONTINUE; END IF;
    IF it.serialised AND p_record_type <> 'open' AND kind_ <> 'adjustment' AND cardinality(sers) <> q THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_count', 'The serial count must equal the quantity (' || q || ').'); CONTINUE;
    END IF;
    IF it.serialised AND kind_ = 'adjustment' AND q < 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'serial_adjustment', 'A serial-tracked item cannot be adjusted down: return or correct the serials.'); CONTINUE; END IF;
    FOREACH sn IN ARRAY sers LOOP
      SELECT * INTO ser_row FROM public.warehouse_serials w WHERE w.serial_no = sn;
      IF kind_ = 'receipt' THEN
        IF FOUND OR EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'receipt' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'Duplicate serial: ' || sn);
        END IF;
      ELSIF kind_ = 'issue' THEN
        IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
        ELSIF ser_row.status IS DISTINCT FROM 'In Stock' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_not_in_stock', 'Serial not in stock: ' || sn);
        ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'issue' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial reserved by another pending delivery note: ' || sn);
        END IF;
      ELSIF kind_ = 'return' THEN
        IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
        ELSIF ser_row.site_id IS DISTINCT FROM rec.site_id OR ser_row.status IS DISTINCT FROM 'Dispatched' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'rn_without_dn', 'Return without a delivery note to this site: ' || sn);
        ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'return' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial in another pending return note: ' || sn);
        END IF;
      END IF;
    END LOOP;

    -- stock rules: an issue (or a negative adjustment) cannot take more than is available; a return cannot exceed what the site holds
    IF kind_ = 'issue' OR (kind_ = 'adjustment' AND q < 0) THEN
      SELECT * INTO st FROM public.wh_stock_levels(iid, NULL);
      IF st.available < abs(q) THEN
        PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'Not enough stock of ' || it.name || ': ' || st.available || ' available (' || st.on_hand || ' on hand, ' || st.reserved || ' reserved).',
          'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_stock', 'Available: ' || st.available)));
      END IF;
    ELSIF kind_ = 'return' THEN
      SELECT * INTO st FROM public.wh_stock_levels(iid, rec.site_id);
      net := coalesce(st.on_hand, 0) - coalesce(st.pending_return, 0);
      IF q > net THEN
        PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'The site holds ' || net || ' of ' || it.name || ' (delivered minus returned): it cannot return ' || q || '.',
          'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_on_site', 'The site holds ' || net)));
      END IF;
    END IF;
    INSERT INTO public.wh_movement_lines (movement_id, item_id, qty, qty_approved, condition, serials, sort_order)
    VALUES (mid, iid, q, qa, ln ->> 'condition', sers, i);
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN mid;
END $$;

-- Submit-time rules (0026 text plus Q105): an RN returned as "Faulty or Damaged" names the condition of every line (on the line or on the document), so a
-- faulty item never goes back into the stock as Good by default.
CREATE OR REPLACE FUNCTION reg_validate_warehouse(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; errs jsonb := '[]'::jsonb; other uuid; ln record;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.register_key <> 'warehouse' THEN RETURN errs; END IF;
  IF r.record_type IS NULL THEN errs := errs || public.reg_err_item('/record_type', 'required', 'The document type is required.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_movements m JOIN public.wh_movement_lines l ON l.movement_id = m.id WHERE m.entity_id = r.entity_id) THEN
    errs := errs || public.reg_err_item('/lines', 'lines_required', 'A warehouse document needs at least one quantity: create it with POST /warehouse/movements.');
  END IF;
  IF r.record_type IN ('te_rn', 'cw_rn') AND btrim(coalesce(r.data ->> 'reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/reason', 'required', 'A return note needs a reason (BP 10).'); END IF;
  IF r.record_type IN ('te_rn', 'cw_rn') AND r.data ->> 'reason' = 'Faulty or Damaged' AND coalesce(r.data ->> 'condition', '') NOT IN ('Good', 'Faulty', 'Damaged') THEN
    FOR ln IN SELECT l.sort_order FROM public.wh_movements m JOIN public.wh_movement_lines l ON l.movement_id = m.id WHERE m.entity_id = r.entity_id AND l.condition IS NULL ORDER BY l.sort_order LOOP
      errs := errs || public.reg_err_item('/lines/' || (ln.sort_order - 1) || '/condition', 'condition_required', 'A return for Faulty or Damaged names the condition of each line (Q105).');
    END LOOP;
  END IF;
  SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(r.data ->> 'doc_no') LIMIT 1;
  IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/doc_no', 'duplicate', 'Duplicate Doc No.'); END IF;
  RETURN errs;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Item master writer: 0026 text plus code_source and the need rule status and shape (Q107)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wh_item_json(i public.warehouse_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', i.item_code, 'name_en', i.name, 'name_ar', i.name_ar, 'uom', i.unit, 'category', i.item_group, 'serial_tracked', i.serialised,
    'manufacturer', i.manufacturer, 'contract_qty', i.contract_qty, 'planned_delivery_date', i.planned_delivery_date, 'progress_item_code', i.progress_item_code,
    'code_source', i.code_source, 'is_active', i.is_active, 'version', i.version,
    'need_rules', coalesce((SELECT jsonb_agg(jsonb_build_object('need_unit', n.need_unit, 'quantity', n.quantity, 'status', n.status, 'quantity_rule', n.quantity_rule, 'applies_when', n.applies_when) ORDER BY n.sort_order, n.id)
                            FROM public.warehouse_item_need_rules n WHERE n.item_id = i.id), '[]'::jsonb))
$$;

-- The field errors of one need rule (path prefix p).
CREATE OR REPLACE FUNCTION wh_need_rule_errors(p_rule jsonb, p text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; qr jsonb := p_rule -> 'quantity_rule'; aw jsonb := p_rule -> 'applies_when'; v text;
BEGIN
  IF jsonb_typeof(p_rule) <> 'object' THEN RETURN jsonb_build_array(jsonb_build_object('path', p, 'code', 'invalid', 'message', 'A need rule is an object.')); END IF;
  IF btrim(coalesce(p_rule ->> 'need_unit', '')) = '' THEN errs := errs || jsonb_build_object('path', p || '/need_unit', 'code', 'required', 'message', 'The need unit is required.'); END IF;
  IF p_rule ? 'quantity' AND jsonb_typeof(p_rule -> 'quantity') NOT IN ('number', 'null') THEN errs := errs || jsonb_build_object('path', p || '/quantity', 'code', 'invalid', 'message', 'A number or null.');
  ELSIF jsonb_typeof(p_rule -> 'quantity') = 'number' AND (p_rule ->> 'quantity')::numeric < 0 THEN errs := errs || jsonb_build_object('path', p || '/quantity', 'code', 'invalid', 'message', 'Not below zero.'); END IF;
  IF p_rule ? 'status' AND coalesce(p_rule ->> 'status', '') NOT IN ('confirmed', 'pending_configuration') THEN errs := errs || jsonb_build_object('path', p || '/status', 'code', 'not_in_list', 'message', 'confirmed or pending_configuration.'); END IF;
  IF p_rule ->> 'status' = 'confirmed' AND jsonb_typeof(p_rule -> 'quantity') IS DISTINCT FROM 'number' THEN
    errs := errs || jsonb_build_object('path', p || '/quantity', 'code', 'required', 'message', 'A confirmed need has a quantity.');
  END IF;
  IF qr IS NOT NULL AND jsonb_typeof(qr) <> 'null' THEN
    IF jsonb_typeof(qr) <> 'object' THEN errs := errs || jsonb_build_object('path', p || '/quantity_rule', 'code', 'invalid', 'message', 'An object or null.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(qr) LOOP
        IF NOT (k = ANY (ARRAY['per', 'wl_vendor', 'group'])) THEN errs := errs || jsonb_build_object('path', p || '/quantity_rule/' || k, 'code', 'unknown_field', 'message', 'per, wl_vendor or group.'); END IF;
      END LOOP;
      IF qr ? 'per' AND coalesce(qr ->> 'per', '') NOT IN ('te_site', 'rf_sector', 'mw_half_link') THEN errs := errs || jsonb_build_object('path', p || '/quantity_rule/per', 'code', 'not_in_list', 'message', 'te_site, rf_sector or mw_half_link.'); END IF;
      IF qr ? 'wl_vendor' AND coalesce(qr ->> 'wl_vendor', '') NOT IN ('Cambium', 'Intracom') THEN errs := errs || jsonb_build_object('path', p || '/quantity_rule/wl_vendor', 'code', 'not_in_list', 'message', 'Cambium or Intracom.'); END IF;
      IF qr ? 'group' AND coalesce(qr ->> 'group', '') !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' THEN errs := errs || jsonb_build_object('path', p || '/quantity_rule/group', 'code', 'invalid', 'message', 'Upper-case letters, digits, - and _.'); END IF;
    END IF;
  END IF;
  IF aw IS NOT NULL AND jsonb_typeof(aw) <> 'null' THEN
    IF jsonb_typeof(aw) <> 'object' THEN errs := errs || jsonb_build_object('path', p || '/applies_when', 'code', 'invalid', 'message', 'An object or null.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(aw) LOOP
        IF NOT (k = ANY (ARRAY['scope', 'delivery_scenario', 'region_ids'])) THEN errs := errs || jsonb_build_object('path', p || '/applies_when/' || k, 'code', 'unknown_field', 'message', 'scope, delivery_scenario or region_ids.');
        ELSIF jsonb_typeof(aw -> k) <> 'array' THEN errs := errs || jsonb_build_object('path', p || '/applies_when/' || k, 'code', 'invalid', 'message', 'A list.');
        ELSE
          FOR v IN SELECT jsonb_array_elements_text(aw -> k) LOOP
            IF (k = 'scope' AND v NOT IN ('te_full', 'router_only'))
               OR (k = 'delivery_scenario' AND v NOT IN ('new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'))
               OR (k = 'region_ids' AND v !~ '^[1-9][0-9]{0,3}$') THEN
              errs := errs || jsonb_build_object('path', p || '/applies_when/' || k, 'code', 'not_in_list', 'message', 'Unknown value: ' || v);
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN errs;
END $$;

-- Add or edit an item (p_id NULL = add). 0026 text plus: code_source (master / internal_provisional); need_rules items carry status (default
-- pending_configuration: an unknown need is never 1 by default, Q107) and the documented quantity_rule / applies_when; every rule is validated.
CREATE OR REPLACE FUNCTION admin_save_warehouse_item(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i public.warehouse_items%ROWTYPE; old_i public.warehouse_items%ROWTYPE; iid uuid; before jsonb; used boolean; pend boolean; rule jsonb; n int := 0; errs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('warehouse_items', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch ? 'code_source' AND coalesce(p_patch ->> 'code_source', '') NOT IN ('master', 'internal_provisional') THEN
    errs := errs || public.reg_err_item('/code_source', 'not_in_list', 'master or internal_provisional.');
  END IF;
  IF p_patch ? 'need_rules' THEN
    IF jsonb_typeof(p_patch -> 'need_rules') <> 'array' THEN errs := errs || public.reg_err_item('/need_rules', 'invalid', 'A list.');
    ELSE
      FOR rule IN SELECT * FROM jsonb_array_elements(p_patch -> 'need_rules') LOOP
        errs := errs || public.wh_need_rule_errors(rule, '/need_rules/' || n);
        n := n + 1;
      END LOOP;
      n := 0;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.warehouse_items x WHERE x.item_code = p_patch ->> 'code') THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'An item with this code exists already.'));
    END IF;
    INSERT INTO public.warehouse_items (item_code, item_group, name, name_ar, unit, serialised, manufacturer, contract_qty, planned_delivery_date, progress_item_code, is_active, code_source)
    VALUES (p_patch ->> 'code', coalesce(p_patch ->> 'category', 'General'), p_patch ->> 'name_en', p_patch ->> 'name_ar', p_patch ->> 'uom', coalesce((p_patch ->> 'serial_tracked')::boolean, false),
            p_patch ->> 'manufacturer', (p_patch ->> 'contract_qty')::numeric, (p_patch ->> 'planned_delivery_date')::date, p_patch ->> 'progress_item_code', coalesce((p_patch ->> 'is_active')::boolean, true),
            coalesce(p_patch ->> 'code_source', 'internal_provisional'))
    RETURNING * INTO i;
    iid := i.id;
    before := NULL;
  ELSE
    SELECT * INTO old_i FROM public.warehouse_items WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The item does not exist.')); END IF;
    IF p_version IS NOT NULL AND p_version <> old_i.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
    before := public.wh_item_json(old_i);
    used := EXISTS (SELECT 1 FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id WHERE li.item_id = p_id AND m.status <> 'cancelled')
            OR EXISTS (SELECT 1 FROM public.warehouse_serials s WHERE s.item_id = p_id);
    pend := EXISTS (SELECT 1 FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id WHERE li.item_id = p_id AND m.status = 'pending');
    IF used AND ((p_patch ? 'uom' AND p_patch ->> 'uom' IS DISTINCT FROM old_i.unit) OR (p_patch ? 'serial_tracked' AND (p_patch ->> 'serial_tracked')::boolean IS DISTINCT FROM old_i.serialised)) THEN
      PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'This item has movements: its unit and serial tracking can no longer change.',
        'errors', public.reg_err_item('/uom', 'item_in_use', 'The unit and the serial tracking of an item with movements are fixed.')));
    END IF;
    IF pend AND p_patch ? 'is_active' AND (p_patch ->> 'is_active')::boolean = false THEN
      PERFORM public.wf_err('item_in_use', jsonb_build_object('detail', 'This item has pending movements: it cannot be deactivated yet.',
        'errors', public.reg_err_item('/is_active', 'item_in_use', 'Finish or cancel the pending movements first.')));
    END IF;
    UPDATE public.warehouse_items SET
      name = coalesce(p_patch ->> 'name_en', name),
      name_ar = CASE WHEN p_patch ? 'name_ar' THEN p_patch ->> 'name_ar' ELSE name_ar END,
      unit = coalesce(p_patch ->> 'uom', unit),
      item_group = coalesce(p_patch ->> 'category', item_group),
      serialised = coalesce((p_patch ->> 'serial_tracked')::boolean, serialised),
      manufacturer = CASE WHEN p_patch ? 'manufacturer' THEN p_patch ->> 'manufacturer' ELSE manufacturer END,
      contract_qty = CASE WHEN p_patch ? 'contract_qty' THEN (p_patch ->> 'contract_qty')::numeric ELSE contract_qty END,
      planned_delivery_date = CASE WHEN p_patch ? 'planned_delivery_date' THEN (p_patch ->> 'planned_delivery_date')::date ELSE planned_delivery_date END,
      progress_item_code = CASE WHEN p_patch ? 'progress_item_code' THEN p_patch ->> 'progress_item_code' ELSE progress_item_code END,
      code_source = coalesce(p_patch ->> 'code_source', code_source),
      is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
      version = version + 1, updated_at = now()
    WHERE id = p_id RETURNING * INTO i;
    iid := p_id;
  END IF;
  IF p_patch ? 'need_rules' THEN
    DELETE FROM public.warehouse_item_need_rules WHERE item_id = iid;
    FOR rule IN SELECT * FROM jsonb_array_elements(p_patch -> 'need_rules') LOOP
      n := n + 1;
      INSERT INTO public.warehouse_item_need_rules (item_id, need_unit, quantity, quantity_rule, applies_when, sort_order, status)
      VALUES (iid, btrim(rule ->> 'need_unit'), (rule ->> 'quantity')::numeric, nullif(rule -> 'quantity_rule', 'null'::jsonb), nullif(rule -> 'applies_when', 'null'::jsonb), n,
              coalesce(rule ->> 'status', 'pending_configuration'));
    END LOOP;
    SELECT * INTO i FROM public.warehouse_items WHERE id = iid;
  END IF;
  PERFORM public.log_audit_write(CASE WHEN p_id IS NULL THEN 'warehouse_item_create' WHEN (p_patch ->> 'is_active') = 'false' THEN 'warehouse_item_deactivate' ELSE 'warehouse_item_update' END,
    'warehouse_item', iid::text, before, public.wh_item_json(i), p_reason);
  RETURN jsonb_build_object('id', iid, 'version', i.version);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Site need and TE dispatch (D6: both)
-- ---------------------------------------------------------------------------------------------------------------------
-- The need of a TE site, one line per need unit and group (items of one group are alternatives, for example the three router models; every other item
-- is needed on its own, as Site Calc K compares them). units: te_site = 1; rf_sector = the Sectors of the approved RF & Design record when the region's
-- WL vendor is the rule's vendor (0 for the other vendor; unknown while the vendor or the design is missing); mw_half_link = D58 (1 when the site's own
-- MW Far-end is set, plus the sites whose Far-end is this site; unknown without an approved design). delivered = posted TE DN minus posted TE RN.
-- line_status: pending_configuration (a pending rule or unknown units: never complete, Q107), complete, short.
CREATE OR REPLACE FUNCTION wh_site_need_lines(p_site uuid)
RETURNS TABLE (need_unit text, need_group text, rule_status text, unit_source text, units numeric, quantity numeric, need numeric, delivered numeric, short numeric,
  line_status text, missing text, items jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE s public.sites%ROWTYPE; te_full boolean; router_only boolean; rf jsonb; vendor text; sectors numeric; halfs numeric;
BEGIN
  SELECT * INTO s FROM public.sites x WHERE x.id = p_site AND public.app_region_check(x.region_id);
  IF NOT FOUND THEN RETURN; END IF;
  te_full := s.scope_te_full = 'yes';
  router_only := NOT te_full AND s.scope_te_ip_router_only = 'yes';
  IF NOT (te_full OR router_only) THEN RETURN; END IF;
  SELECT r.data INTO rf FROM public.register_records r WHERE r.register_key = 'rf_design' AND r.site_id = s.id AND r.is_current LIMIT 1;
  SELECT v.wl_vendor INTO vendor FROM public.warehouse_region_vendors v WHERE v.region_id = s.region_id;
  sectors := CASE WHEN rf ->> 'sectors' ~ '^[0-9]{1,4}(\.0+)?$' THEN (rf ->> 'sectors')::numeric END;
  halfs := CASE WHEN rf IS NULL THEN NULL ELSE
    (CASE WHEN btrim(coalesce(rf ->> 'mw_far_end_site', '')) IN ('', 'N/A') THEN 0 ELSE 1 END)
    + (SELECT count(*) FROM public.register_records o JOIN public.sites os ON os.id = o.site_id
       WHERE o.register_key = 'rf_design' AND o.is_current AND os.is_active AND o.data ->> 'mw_far_end_site' = s.site_code) END;
  RETURN QUERY
  WITH r AS (
    SELECT i.id AS item_id, i.item_code, i.name AS item_name, n.need_unit AS nu, n.status AS st, n.quantity AS qty,
      coalesce(n.quantity_rule ->> 'per', CASE n.need_unit WHEN 'Cambium Sector' THEN 'rf_sector' WHEN 'Intracom Sector' THEN 'rf_sector' WHEN 'MW Half-link' THEN 'mw_half_link' ELSE 'te_site' END) AS per,
      coalesce(n.quantity_rule ->> 'wl_vendor', CASE n.need_unit WHEN 'Cambium Sector' THEN 'Cambium' WHEN 'Intracom Sector' THEN 'Intracom' END) AS wv,
      coalesce(n.quantity_rule ->> 'group', i.item_code) AS grp
    FROM public.warehouse_item_need_rules n JOIN public.warehouse_items i ON i.id = n.item_id
    WHERE i.is_active
      AND (n.applies_when IS NULL OR NOT (n.applies_when ? 'scope') OR (n.applies_when -> 'scope') ? (CASE WHEN te_full THEN 'te_full' ELSE 'router_only' END))
      AND (n.applies_when IS NULL OR NOT (n.applies_when ? 'delivery_scenario') OR (s.delivery_scenario IS NOT NULL AND (n.applies_when -> 'delivery_scenario') ? s.delivery_scenario::text))
      AND (n.applies_when IS NULL OR NOT (n.applies_when ? 'region_ids') OR (n.applies_when -> 'region_ids') @> to_jsonb(s.region_id))
  ), u AS (
    SELECT r.*,
      CASE r.per WHEN 'te_site' THEN 1::numeric
        WHEN 'rf_sector' THEN CASE WHEN r.wv IS NULL THEN sectors WHEN vendor IS NULL THEN NULL WHEN vendor <> r.wv THEN 0 ELSE sectors END
        WHEN 'mw_half_link' THEN halfs END AS un,
      CASE WHEN r.per = 'rf_sector' AND r.wv IS NOT NULL AND vendor IS NULL THEN 'region_wl_vendor'
           WHEN r.per = 'rf_sector' AND (vendor IS NULL OR vendor = r.wv OR r.wv IS NULL) AND sectors IS NULL THEN 'rf_design_sectors'
           WHEN r.per = 'mw_half_link' AND halfs IS NULL THEN 'rf_design' END AS miss,
      coalesce((SELECT sum(CASE m.record_type WHEN 'te_dn' THEN l.qty ELSE -l.qty END) FROM public.wh_movement_lines l JOIN public.wh_movements m ON m.id = l.movement_id
                WHERE m.site_id = s.id AND m.status = 'posted' AND m.record_type IN ('te_dn', 'te_rn') AND l.item_id = r.item_id), 0) AS dl
    FROM r
  ), g AS (
    SELECT u.nu, u.grp,
      CASE WHEN bool_and(u.st = 'confirmed' AND u.qty IS NOT NULL) THEN 'confirmed' ELSE 'pending_configuration' END AS rs,
      min(u.per) AS src, CASE WHEN bool_or(u.un IS NULL) THEN NULL ELSE max(u.un) END AS un, max(u.qty) AS qty, sum(u.dl) AS dl,
      CASE WHEN bool_or(u.st <> 'confirmed') THEN 'need_quantity' ELSE min(u.miss) END AS miss,
      jsonb_agg(jsonb_build_object('item_id', u.item_id, 'item_code', u.item_code, 'item_name', u.item_name, 'delivered', u.dl, 'rule_status', u.st) ORDER BY u.item_code COLLATE "C") AS its
    FROM u GROUP BY u.nu, u.grp
  )
  SELECT g.nu, g.grp, g.rs, g.src, g.un, g.qty,
    CASE WHEN g.rs = 'confirmed' AND g.un IS NOT NULL THEN g.qty * g.un END,
    g.dl,
    CASE WHEN g.rs = 'confirmed' AND g.un IS NOT NULL THEN greatest(g.qty * g.un - g.dl, 0) END,
    CASE WHEN g.rs <> 'confirmed' OR g.un IS NULL THEN 'pending_configuration' WHEN g.dl >= g.qty * g.un THEN 'complete' ELSE 'short' END,
    g.miss, g.its
  FROM g ORDER BY g.nu COLLATE "C", g.grp COLLATE "C";
END $$;

-- The two D6 values of a site. te_dispatch_complete_date = the date of the latest posted TE DN (Q65), compared with the Master; need_status =
-- not_applicable (no TE), short (a confirmed line is short), pending_configuration (a line cannot be judged yet, or no rule applies), complete.
CREATE OR REPLACE FUNCTION wh_site_dispatch(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; lines jsonb; dn record; st text; te boolean;
BEGIN
  SELECT * INTO s FROM public.sites x WHERE x.id = p_site AND public.app_region_check(x.region_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  te := s.scope_te_full = 'yes' OR s.scope_te_ip_router_only = 'yes';
  SELECT m.doc_date, m.doc_no INTO dn FROM public.wh_movements m
  WHERE m.site_id = s.id AND m.record_type = 'te_dn' AND m.status = 'posted' AND m.doc_date IS NOT NULL ORDER BY m.doc_date DESC, m.posted_at DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) INTO lines FROM public.wh_site_need_lines(s.id) l;
  st := CASE WHEN NOT te THEN 'not_applicable'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(lines) e WHERE e ->> 'line_status' = 'short') THEN 'short'
    WHEN jsonb_array_length(lines) = 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(lines) e WHERE e ->> 'line_status' = 'pending_configuration') THEN 'pending_configuration'
    ELSE 'complete' END;
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'region_id', s.region_id, 'te_applies', te,
    'router_only', s.scope_te_full <> 'yes' AND s.scope_te_ip_router_only = 'yes',
    'te_dispatch_complete_date', dn.doc_date, 'latest_te_dn_no', dn.doc_no, 'need_status', st,
    'short_lines', (SELECT count(*) FROM jsonb_array_elements(lines) e WHERE e ->> 'line_status' = 'short'),
    'pending_lines', (SELECT count(*) FROM jsonb_array_elements(lines) e WHERE e ->> 'line_status' = 'pending_configuration'),
    'lines', lines);
END $$;

-- The owner data still missing (Q107, D58, Q32), for the Warehouse screen.
CREATE OR REPLACE FUNCTION wh_config_gaps() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'pending_need_rules', coalesce((SELECT jsonb_agg(jsonb_build_object('item_id', i.id, 'item_code', i.item_code, 'item_name', i.name, 'need_unit', n.need_unit, 'quantity', n.quantity)
        ORDER BY i.item_code COLLATE "C", n.sort_order) FROM public.warehouse_item_need_rules n JOIN public.warehouse_items i ON i.id = n.item_id WHERE i.is_active AND n.status <> 'confirmed'), '[]'::jsonb),
    'provisional_codes', coalesce((SELECT jsonb_agg(jsonb_build_object('item_id', i.id, 'item_code', i.item_code, 'item_name', i.name, 'category', i.item_group) ORDER BY i.item_code COLLATE "C")
        FROM public.warehouse_items i WHERE i.is_active AND i.code_source = 'internal_provisional'), '[]'::jsonb),
    'regions_without_wl_vendor', coalesce((SELECT jsonb_agg(r.id ORDER BY r.id) FROM public.regions r WHERE NOT EXISTS (SELECT 1 FROM public.warehouse_region_vendors v WHERE v.region_id = r.id)), '[]'::jsonb),
    'regions_without_sequence', coalesce((SELECT jsonb_agg(jsonb_build_object('region_id', g.region_id, 'record_types', g.types) ORDER BY g.region_id)
        FROM (SELECT r.id AS region_id, jsonb_agg(t ORDER BY t COLLATE "C") AS types
              FROM public.regions r CROSS JOIN unnest(ARRAY['cw_dn', 'cw_rn', 'te_dn', 'te_rn']) t
              WHERE NOT EXISTS (SELECT 1 FROM public.doc_sequences k WHERE k.is_active AND k.record_type = t AND k.region_id = r.id)
              GROUP BY r.id) g), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['doc_pattern_errors(text,text,text)', 'doc_format_number(text,text,integer,integer)', 'doc_period(text,date)', 'doc_today()',
    'doc_next_number(text,date,text,uuid)', 'doc_sequence_json(text)', 'admin_save_doc_sequence(text,boolean,jsonb,text,integer)', 'admin_save_region_vendor(integer,text,text,integer)',
    'wh_stock_levels(uuid,uuid)', 'wh_on_state()', 'wh_doc_no_lock()', 'wh_create_movement(text,uuid,jsonb,jsonb)', 'reg_validate_warehouse(uuid)', 'wh_item_json(warehouse_items)',
    'wh_need_rule_errors(jsonb,text)', 'admin_save_warehouse_item(uuid,jsonb,text,integer)', 'wh_site_need_lines(uuid)', 'wh_site_dispatch(uuid)', 'wh_config_gaps()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['doc_sequence_json(text)', 'admin_save_doc_sequence(text,boolean,jsonb,text,integer)', 'admin_save_region_vendor(integer,text,text,integer)',
      'wh_stock_levels(uuid,uuid)', 'wh_create_movement(text,uuid,jsonb,jsonb)', 'admin_save_warehouse_item(uuid,jsonb,text,integer)', 'wh_site_dispatch(uuid)', 'wh_config_gaps()'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
