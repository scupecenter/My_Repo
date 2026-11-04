-- 0061_p4b_contractors: work package P4b of the owner answers of 2026-11-04 (Q110, Q142 to Q147) and the owner decision D145b.
-- Mirror: db/sql/060_p4b_contractors.sql (kept byte-identical).
--
-- Nothing of an earlier migration is edited. The functions of 0043 that P4b owns (team_scope_match_json, admin_save_team_scope_match,
-- team_scope_problem, reg_team_scope_check) are replaced with the same signatures. reg_validate_catalog (0025) is renamed reg_validate_catalog_base
-- and wrapped, so whatever an earlier migration put in it is kept. The generic list and field-type code (reg_clean_data, register field types) is not
-- touched: the new values are data (register_fields rows, options) and P4b tables.
--
--   Q143  One catalogue of team specializations (team_specializations): code, EN/AR label, functional group (CW or TE), aliases. Seed: the 8 agreed
--         values Tower RT, Tower GF, Adaption, TE, Dismantle, GECOL, Fiber, Survey (an approved analysis specialization is added by the admin).
--         Names are matched through the code, the labels and the aliases (trimmed, case and punctuation ignored), never by plain text compare.
--         A team holds several specializations (external_team_specializations; register field more_specializations beside the main one). The match
--         table keeps its rows (scopes) and cells (scope x code) and gains allowed groups per scope (team_scope_match_groups): a scope that allows
--         the group CW accepts every specialization of that group, including one added later. The 0043 columns are converted: TE became the code TE,
--         CW became the group CW (the old meaning is kept), any other column a new catalogue code.
--   Q142  A team may be saved as a draft without a specialization; one is required at submit (before it is activated and can take an order) unless
--         the team status is inactive or closed. Old teams without one are listed in the completeness report and take no new order.
--   Q144  A scope missing from the table accepts no team. HLC is exempt only from naming a team: a named team is always checked (HLC: Fiber), and
--         needs an active contract for the scope.
--   Q110  One external party per company. The Company Type maps explicitly (external_party_type_map); an unknown type becomes other, the party is
--         marked type_review and the System Admins get a review alert. A team and a contract link to their company by party id (the record's
--         external_party_id); the name is only used to find the id when it is unique, an ambiguous name is never linked. Contracts are their own
--         records (record type contract of the Contractors register, projected into external_party_contracts) with ref, scopes, dates and status;
--         the party status stays separate. The contract that covers the scope on the date decides the eligibility. The company record's own
--         contract fields become a contract with no scope list (covers every scope; listed in the completeness report).
--   Q145  Approved orders are never changed. A draft is checked again at submit, and the check records the match table version it used
--         (team_scope_checks). GET /reports/team-scope-mismatch lists the running orders that no longer match (specialization, team or party
--         inactive, no contract today, Stop Work on the site), with a corrective action; the daily job alerts Procurement once per order and reason.
--   Q146  A GECOL record is approved only with its party (external_party_id, or the GECOL Contractor name when it is unique), an active party and an
--         active contract covering the scope GECOL on the request date. No team is asked for (the register has none).
--   Q147  The match table is readable read-only by Procurement and Contractors (API), saved by a System Admin or a delegation of admin.settings
--         edit for all regions with a reason and the version; a change that affects eligibility needs a fresh step-up. CW Delivery Model (scopes of
--         contractor_rules.cw_delivery_scopes): an Outsourced order that has its PO / WO needs its party and an active contract for the scope on the
--         order date; an In-House order names a qualified internal team (team type in contractor_rules.internal_team_types). Warehouse is not required.
--   D145b A team carries a safety certificate expiry date, as information only. The daily job alerts the team's owner / lead (team_lead_user) and
--         Procurement (holders of contractor_rules.recipient_roles; the System Admins when nobody holds them) when it is within
--         contractor_rules.safety_cert_lead_days (default 30) and again when it has expired. It never blocks an order or an assignment.
--
-- pmis_app reads the new tables and writes none of them (db/sql/app_grants.sql). Audit rows go through log_audit_write.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Helpers and the specialization catalogue (Q143)
-- ---------------------------------------------------------------------------------------------------------------------
-- The comparison form of a name: lower case, spaces and ASCII punctuation removed ("Tower-RT", "tower rt" and "TOWER_RT" are one name).
CREATE OR REPLACE FUNCTION p4b_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT regexp_replace(lower(btrim(coalesce(p, ''))), '[[:space:][:punct:]]+', '', 'g')
$$;

-- A comma separated text as its trimmed, non-empty parts (comma, semicolon or the Arabic comma).
CREATE OR REPLACE FUNCTION p4b_split(p text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(array_agg(btrim(x) ORDER BY o), ARRAY[]::text[])
  FROM unnest(regexp_split_to_array(coalesce(p, ''), '[,;،]')) WITH ORDINALITY AS t(x, o) WHERE btrim(x) <> ''
$$;

CREATE TABLE team_specializations (
  code       TEXT    PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{0,29}$'),
  label_en   TEXT    NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 60 AND label_en = btrim(label_en)),
  label_ar   TEXT    CHECK (label_ar IS NULL OR char_length(label_ar) BETWEEN 1 AND 60),
  func_group TEXT    CHECK (func_group IN ('CW', 'TE')),
  aliases    TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0
);
COMMENT ON TABLE team_specializations IS 'Q143: the catalogue of team specializations (codes of the Contractors register and of the team / scope match). Written only by admin_save_team_scope_match; never deleted.';

INSERT INTO team_specializations (code, label_en, label_ar, func_group, sort_order) VALUES
  ('TOWER_RT',  'Tower RT',  'برج سطح',        'CW', 10),
  ('TOWER_GF',  'Tower GF',  'برج أرضي',       'CW', 20),
  ('ADAPTION',  'Adaption',  'تهيئة الموقع',   'CW', 30),
  ('TE',        'TE',        'تركيب المعدات',  'TE', 40),
  ('DISMANTLE', 'Dismantle', 'تفكيك',          NULL, 50),
  ('GECOL',     'GECOL',     'كهرباء GECOL',   NULL, 60),
  ('FIBER',     'Fiber',     'ألياف',          NULL, 70),
  ('SURVEY',    'Survey',    'مسح',            NULL, 80)
ON CONFLICT (code) DO NOTHING;

-- A name (code, label or alias) as its catalogue code; NULL when it is none of them. Inactive codes only when asked (the admin re-activates one).
CREATE OR REPLACE FUNCTION team_spec_resolve(p text, p_with_inactive boolean DEFAULT false) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.code FROM public.team_specializations s
  WHERE (s.is_active OR p_with_inactive) AND public.p4b_norm(p) <> ''
    AND (public.p4b_norm(s.code) = public.p4b_norm(p) OR public.p4b_norm(s.label_en) = public.p4b_norm(p) OR public.p4b_norm(s.label_ar) = public.p4b_norm(p)
         OR EXISTS (SELECT 1 FROM unnest(s.aliases) a WHERE public.p4b_norm(a) = public.p4b_norm(p)))
  ORDER BY s.is_active DESC, s.sort_order, s.code LIMIT 1
$$;

CREATE OR REPLACE FUNCTION team_spec_labels(p_codes text[]) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT nullif(string_agg(s.label_en, ', ' ORDER BY s.sort_order, s.code), '') FROM public.team_specializations s WHERE s.code = ANY (coalesce(p_codes, ARRAY[]::text[]))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Parties, teams and contracts (Q110, D145b)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE external_parties
  ADD COLUMN type_review      BOOLEAN NOT NULL DEFAULT false,   -- Q110: the Company Type was not one of the known types; it was set to other
  ADD COLUMN source_record_id UUID;                             -- the approved Contractors record it was projected from
ALTER TABLE external_teams
  ADD COLUMN safety_cert_expiry DATE,                           -- D145b: information only, never blocks
  ADD COLUMN lead_user_id       UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN source_record_id   UUID;

CREATE TABLE external_team_specializations (
  team_id UUID NOT NULL REFERENCES external_teams (id) ON DELETE CASCADE,
  code    TEXT NOT NULL REFERENCES team_specializations (code) ON UPDATE CASCADE,
  PRIMARY KEY (team_id, code)
);

CREATE TABLE external_party_type_map (
  source     TEXT PRIMARY KEY CHECK (source = p4b_norm(source) AND source <> ''),
  party_type "ExternalPartyType" NOT NULL
);
COMMENT ON TABLE external_party_type_map IS 'Q110: the explicit conversion of a Company Type (compared through p4b_norm) to the external party type. Anything else becomes other with a review alert.';
INSERT INTO external_party_type_map (source, party_type) VALUES
  ('cwcontractor', 'cw_contractor'), ('tevendor', 'te_vendor'), ('gecol', 'gecol'), ('hlc', 'hlc'), ('supplier', 'supplier'), ('landlord', 'landlord'), ('other', 'other')
ON CONFLICT (source) DO NOTHING;

CREATE TABLE external_party_contracts (
  id               UUID PRIMARY KEY,                             -- the logical Contractors record (or the company, origin = company)
  party_id         UUID NOT NULL REFERENCES external_parties (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  contract_ref     TEXT,
  scopes           TEXT[],                                       -- NULL = the scope is not specified (the company record's contract): every scope
  start_date       DATE,
  end_date         DATE,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'terminated', 'expired')),
  origin           TEXT NOT NULL CHECK (origin IN ('company', 'contract')),
  source_record_id UUID,
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX external_party_contracts_party_idx ON external_party_contracts (party_id);
COMMENT ON TABLE external_party_contracts IS 'Q110: the contracts of an external party. Written only by the approval of a Contractors record (company or contract).';

-- The active contract of a party that covers the scope on the date (NULL = none).
CREATE OR REPLACE FUNCTION party_contract_for(p_party uuid, p_scope text, p_on date) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id FROM public.external_party_contracts c
  WHERE c.party_id = p_party AND c.status = 'active'
    AND (c.start_date IS NULL OR c.start_date <= p_on) AND (c.end_date IS NULL OR c.end_date >= p_on)
    AND (c.scopes IS NULL OR p_scope = ANY (c.scopes))
  ORDER BY c.end_date DESC NULLS FIRST, c.id LIMIT 1
$$;

-- The specialization codes of a team: the catalogue rows of external_team_specializations, else its legacy text resolved part by part.
CREATE OR REPLACE FUNCTION team_spec_codes(p_team uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.external_team_specializations x WHERE x.team_id = p_team)
    THEN (SELECT coalesce(array_agg(x.code ORDER BY s.sort_order), ARRAY[]::text[]) FROM public.external_team_specializations x
          JOIN public.team_specializations s ON s.code = x.code AND s.is_active WHERE x.team_id = p_team)
    ELSE (SELECT coalesce(array_agg(DISTINCT c), ARRAY[]::text[]) FROM public.external_teams t
          CROSS JOIN LATERAL unnest(public.p4b_split(t.specialization)) AS part
          CROSS JOIN LATERAL (SELECT public.team_spec_resolve(part) AS c) r WHERE t.id = p_team AND r.c IS NOT NULL) END
$$;

-- Rules of the package, one row (Q145, Q147, D145b), written only by admin_save_contractor_rules.
CREATE TABLE contractor_rules (
  id                    BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  safety_cert_lead_days INTEGER NOT NULL DEFAULT 30 CHECK (safety_cert_lead_days BETWEEN 0 AND 365),
  recipient_roles       TEXT[]  NOT NULL DEFAULT ARRAY['PROC_TEAM']::TEXT[],
  cw_delivery_scopes    TEXT[]  NOT NULL DEFAULT ARRAY['CW', 'Tower Erection', 'Site Adaption', 'CW Dismantle']::TEXT[],
  internal_team_types   TEXT[]  NOT NULL DEFAULT ARRAY['Internal', 'In-House']::TEXT[],
  closed_order_statuses TEXT[]  NOT NULL DEFAULT ARRAY['Closed', 'Cancelled', 'Completed']::TEXT[],
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by            UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
INSERT INTO contractor_rules (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- The record of every check at submit (Q145: the order keeps the rule version it was checked under).
CREATE TABLE team_scope_checks (
  record_id       UUID PRIMARY KEY REFERENCES register_records (id) ON DELETE CASCADE,
  entity_id       UUID NOT NULL,
  match_version   INTEGER NOT NULL,
  scope           TEXT,
  team_id         UUID,
  specializations TEXT[],
  contract_id     UUID,
  checked_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Alerts already sent (one per kind, object and detail).
CREATE TABLE contractor_alerts_sent (
  kind    TEXT NOT NULL,
  ref_id  UUID NOT NULL,
  detail  TEXT NOT NULL,
  sent_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id, detail)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The team / scope match: groups, conversion of the 0043 columns, reader, writer and the check (Q143, Q144, Q147)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE team_scope_match_groups (
  scope      TEXT NOT NULL REFERENCES team_scope_match_scopes (scope) ON DELETE CASCADE ON UPDATE CASCADE,
  func_group TEXT NOT NULL CHECK (func_group IN ('CW', 'TE')),
  PRIMARY KEY (scope, func_group)
);

DO $$
DECLARE col text; code text; n integer := 100; specs text[];
BEGIN
  SELECT m.specializations INTO specs FROM team_scope_match_meta m WHERE m.id;
  -- every old column: a group (CW, TE when it is not a code), a catalogue code, or a new code
  FOREACH col IN ARRAY coalesce(specs, ARRAY[]::text[]) LOOP
    code := team_spec_resolve(col, true);
    IF code IS NULL AND upper(btrim(col)) = 'CW' THEN
      INSERT INTO team_scope_match_groups (scope, func_group)
      SELECT c.scope, 'CW' FROM team_scope_match c WHERE c.specialization = col AND c.allowed ON CONFLICT DO NOTHING;
      DELETE FROM team_scope_match WHERE specialization = col;
      CONTINUE;
    END IF;
    IF code IS NULL THEN
      code := left(nullif(btrim(regexp_replace(upper(col), '[^A-Z0-9]+', '_', 'g'), '_'), ''), 30);
      IF code IS NULL OR code !~ '^[A-Z]' THEN code := 'SPEC_' || n; END IF;
      n := n + 10;
      INSERT INTO team_specializations (code, label_en, sort_order) VALUES (code, left(btrim(col), 60), n) ON CONFLICT (code) DO NOTHING;
    END IF;
    IF code <> col THEN
      INSERT INTO team_scope_match (scope, specialization, allowed)
      SELECT c.scope, code, c.allowed FROM team_scope_match c WHERE c.specialization = col
      ON CONFLICT (scope, specialization) DO UPDATE SET allowed = team_scope_match.allowed OR EXCLUDED.allowed;
      DELETE FROM team_scope_match WHERE specialization = col;
    END IF;
  END LOOP;
  -- Q144: HLC keeps "no team needed" (exempt) but a named team must be a Fiber team; Q143: the dismantle and GECOL codes take their own scopes
  INSERT INTO team_scope_match (scope, specialization, allowed)
  SELECT v.scope, v.code, true FROM (VALUES ('HLC', 'FIBER'), ('GECOL', 'GECOL'), ('CW Dismantle', 'DISMANTLE'), ('TE Dismantle', 'DISMANTLE')) AS v(scope, code)
  WHERE EXISTS (SELECT 1 FROM team_scope_match_scopes s WHERE s.scope = v.scope)
  ON CONFLICT (scope, specialization) DO UPDATE SET allowed = true;
  -- one cell per scope and active code
  INSERT INTO team_scope_match (scope, specialization, allowed)
  SELECT s.scope, t.code, false FROM team_scope_match_scopes s CROSS JOIN team_specializations t WHERE t.is_active
  ON CONFLICT (scope, specialization) DO NOTHING;
  UPDATE team_scope_match_meta SET specializations = (SELECT array_agg(t.code ORDER BY t.sort_order, t.code) FROM team_specializations t WHERE t.is_active),
    version = version + 1, updated_at = now() WHERE id;
END $$;

-- Teams of before this migration: their specialization text resolved into codes (a text that is a group or unknown resolves to nothing: completeness report).
INSERT INTO external_team_specializations (team_id, code)
SELECT DISTINCT t.id, team_spec_resolve(part) FROM external_teams t CROSS JOIN LATERAL unnest(p4b_split(t.specialization)) AS part
WHERE team_spec_resolve(part) IS NOT NULL
ON CONFLICT DO NOTHING;

-- Companies of before this migration: their own contract fields become a contract with no scope list.
INSERT INTO external_party_contracts (id, party_id, contract_ref, scopes, start_date, end_date, status, origin)
SELECT p.id, p.id, p.contract_ref, NULL, p.contract_start, CASE WHEN p.contract_end >= p.contract_start OR p.contract_start IS NULL THEN p.contract_end END, 'active', 'company'
FROM external_parties p WHERE p.contract_ref IS NOT NULL OR p.contract_start IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- The whole table as the API returns it.
CREATE OR REPLACE FUNCTION team_scope_match_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'specializations', coalesce((SELECT jsonb_agg(t.code ORDER BY t.sort_order, t.code) FROM public.team_specializations t WHERE t.is_active), '[]'::jsonb),
    'groups', '["CW", "TE"]'::jsonb,
    'catalogue', coalesce((SELECT jsonb_agg(jsonb_build_object('code', t.code, 'label_en', t.label_en, 'label_ar', t.label_ar, 'group', t.func_group,
                                                               'aliases', to_jsonb(t.aliases), 'is_active', t.is_active) ORDER BY t.is_active DESC, t.sort_order, t.code)
                           FROM public.team_specializations t), '[]'::jsonb),
    'scopes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'scope', s.scope, 'exempt', s.exempt,
               'allowed', coalesce((SELECT jsonb_agg(c.specialization ORDER BY t.sort_order, t.code) FROM public.team_scope_match c
                                    JOIN public.team_specializations t ON t.code = c.specialization AND t.is_active WHERE c.scope = s.scope AND c.allowed), '[]'::jsonb),
               'allowed_groups', coalesce((SELECT jsonb_agg(g.func_group ORDER BY g.func_group) FROM public.team_scope_match_groups g WHERE g.scope = s.scope), '[]'::jsonb))
             ORDER BY s.sort_order, s.scope COLLATE "C")
      FROM public.team_scope_match_scopes s), '[]'::jsonb),
    'version', m.version, 'updated_at', m.updated_at, 'updated_by', m.updated_by)
  FROM public.team_scope_match_meta m WHERE m.id
$$;

-- What decides eligibility (Q147: a change of it needs a step-up): the rows, the active codes with their group and aliases. Labels do not.
CREATE OR REPLACE FUNCTION team_scope_match_rules(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('scopes', j -> 'scopes',
    'codes', coalesce((SELECT jsonb_agg(jsonb_build_object('code', e ->> 'code', 'group', e -> 'group', 'aliases', e -> 'aliases') ORDER BY e ->> 'code')
                       FROM jsonb_array_elements(j -> 'catalogue') e WHERE (e ->> 'is_active')::boolean), '[]'::jsonb))
$$;

-- The writer. p_config = {specializations: [name], scopes: [{scope, exempt, allowed: [name], allowed_groups: [CW|TE]}], catalogue?: [{code, label_en,
-- label_ar, group, aliases}]}. specializations are the active columns in order: each name is a catalogue code, label or alias, or a new code; a
-- catalogue code that is not listed is deactivated (never deleted). The rows are replaced (nothing references them).
CREATE OR REPLACE FUNCTION admin_save_team_scope_match(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m public.team_scope_match_meta%ROWTYPE; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; k text; el jsonb; a jsonb; i integer; j integer;
  codes text[] := ARRAY[]::text[]; cd text; nm text; sc text; seen_scopes text[] := ARRAY[]::text[]; allowed text[]; grps text[]; n integer;
  labels_before jsonb; labels_after jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO m FROM public.team_scope_match_meta WHERE id FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> m.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with specializations and scopes.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('specializations', 'scopes', 'catalogue') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;

  -- shape first: nothing is written while the body is malformed
  IF jsonb_typeof(p_config -> 'specializations') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/specializations', 'required', 'The list of specializations is required.');
  ELSIF jsonb_array_length(p_config -> 'specializations') > 30 THEN
    errs := errs || public.reg_err_item('/specializations', 'too_many', 'At most 30 specializations.');
  ELSE
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'specializations') LOOP
      IF jsonb_typeof(el) <> 'string' OR char_length(btrim(el #>> '{}')) NOT BETWEEN 1 AND 60 THEN
        errs := errs || public.reg_err_item('/specializations/' || i, 'invalid', 'A specialization is a text of 1 to 60 characters.');
      ELSIF public.team_spec_resolve(el #>> '{}', true) IS NULL AND upper(btrim(el #>> '{}')) IN ('CW', 'TE') THEN
        errs := errs || public.reg_err_item('/specializations/' || i, 'is_a_group', btrim(el #>> '{}') || ' is a functional group, not a specialization: allow the group on the scope (allowed_groups).');
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF p_config ? 'catalogue' THEN
    IF jsonb_typeof(p_config -> 'catalogue') <> 'array' OR jsonb_array_length(p_config -> 'catalogue') > 60 THEN
      errs := errs || public.reg_err_item('/catalogue', 'invalid', 'A list of at most 60 specializations.');
    ELSE
      i := 0;
      FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'catalogue') LOOP
        IF jsonb_typeof(el) <> 'object' THEN errs := errs || public.reg_err_item('/catalogue/' || i, 'invalid', 'An object with code and labels.');
        ELSE
          FOR k IN SELECT jsonb_object_keys(el) LOOP
            IF k NOT IN ('code', 'label_en', 'label_ar', 'group', 'aliases', 'is_active') THEN errs := errs || public.reg_err_item('/catalogue/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
          END LOOP;
          IF jsonb_typeof(el -> 'code') IS DISTINCT FROM 'string' THEN errs := errs || public.reg_err_item('/catalogue/' || i || '/code', 'required', 'The code is required.'); END IF;
          IF jsonb_typeof(el -> 'label_en') IS DISTINCT FROM 'string' OR char_length(btrim(el ->> 'label_en')) NOT BETWEEN 1 AND 60 THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/label_en', 'invalid', 'A label of 1 to 60 characters.');
          END IF;
          IF el ? 'label_ar' AND jsonb_typeof(el -> 'label_ar') NOT IN ('string', 'null') OR char_length(coalesce(el ->> 'label_ar', '')) > 60 THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/label_ar', 'invalid', 'A label of at most 60 characters.');
          END IF;
          IF el ? 'group' AND jsonb_typeof(el -> 'group') <> 'null' AND coalesce(el ->> 'group', '') NOT IN ('CW', 'TE') THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/group', 'invalid', 'CW, TE or null.');
          END IF;
          IF el ? 'aliases' AND (jsonb_typeof(el -> 'aliases') <> 'array' OR jsonb_array_length(el -> 'aliases') > 20
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'aliases') x WHERE jsonb_typeof(x) <> 'string' OR char_length(btrim(x #>> '{}')) NOT BETWEEN 1 AND 60)) THEN
            errs := errs || public.reg_err_item('/catalogue/' || i || '/aliases', 'invalid', 'At most 20 names of 1 to 60 characters.');
          END IF;
        END IF;
        i := i + 1;
      END LOOP;
    END IF;
  END IF;
  IF jsonb_typeof(p_config -> 'scopes') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/scopes', 'required', 'The list of scopes is required.');
  ELSIF jsonb_array_length(p_config -> 'scopes') > 60 THEN
    errs := errs || public.reg_err_item('/scopes', 'too_many', 'At most 60 scopes.');
  ELSE
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'scopes') LOOP
      IF jsonb_typeof(el) <> 'object' THEN
        errs := errs || public.reg_err_item('/scopes/' || i, 'invalid', 'A row is an object with scope, exempt and allowed.');
      ELSE
        FOR k IN SELECT jsonb_object_keys(el) LOOP
          IF k NOT IN ('scope', 'exempt', 'allowed', 'allowed_groups') THEN errs := errs || public.reg_err_item('/scopes/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
        END LOOP;
        sc := btrim(coalesce(el ->> 'scope', ''));
        IF jsonb_typeof(el -> 'scope') IS DISTINCT FROM 'string' OR char_length(sc) NOT BETWEEN 1 AND 60 THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/scope', 'invalid', 'A scope is a text of 1 to 60 characters.');
        ELSIF sc = ANY (seen_scopes) THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/scope', 'duplicate', 'This scope is listed twice.');
        ELSE seen_scopes := seen_scopes || sc; END IF;
        IF el ? 'exempt' AND jsonb_typeof(el -> 'exempt') <> 'boolean' THEN errs := errs || public.reg_err_item('/scopes/' || i || '/exempt', 'invalid', 'true or false.'); END IF;
        IF jsonb_typeof(el -> 'allowed') IS DISTINCT FROM 'array' THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed', 'required', 'The allowed specializations are required (an empty list allows none).');
        ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'allowed') x WHERE jsonb_typeof(x) <> 'string') THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed', 'invalid', 'A list of specialization codes.');
        END IF;
        IF el ? 'allowed_groups' AND (jsonb_typeof(el -> 'allowed_groups') <> 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(el -> 'allowed_groups') x WHERE coalesce(x #>> '{}', '') NOT IN ('CW', 'TE'))) THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed_groups', 'invalid', 'A list of the groups CW and TE.');
        END IF;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.team_scope_match_json();
  SELECT jsonb_agg(jsonb_build_array(t.code, t.label_en, t.label_ar, t.is_active) ORDER BY t.code) INTO labels_before FROM public.team_specializations t;

  -- the columns: resolve, create the new codes, order them, deactivate the codes that are not listed
  i := 0; n := (SELECT coalesce(max(sort_order), 0) FROM public.team_specializations);
  FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'specializations') LOOP
    nm := btrim(el #>> '{}');
    cd := public.team_spec_resolve(nm, true);
    IF cd IS NULL THEN
      cd := left(nullif(btrim(regexp_replace(upper(nm), '[^A-Z0-9]+', '_', 'g'), '_'), ''), 30);
      IF cd IS NULL OR cd !~ '^[A-Z]' OR EXISTS (SELECT 1 FROM public.team_specializations t WHERE t.code = cd) THEN n := n + 1; cd := 'SPEC_' || n; END IF;
      INSERT INTO public.team_specializations (code, label_en, sort_order) VALUES (cd, nm, 0);
    END IF;
    IF cd = ANY (codes) THEN
      errs := errs || public.reg_err_item('/specializations/' || i, 'duplicate', 'This specialization is listed twice.');
    ELSE codes := codes || cd; END IF;
    i := i + 1;
  END LOOP;
  UPDATE public.team_specializations t SET is_active = (t.code = ANY (codes)),
    sort_order = coalesce(array_position(codes, t.code) * 10, 1000 + t.sort_order % 1000);

  -- labels, group and aliases of the listed codes
  IF p_config ? 'catalogue' THEN
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'catalogue') LOOP
      cd := upper(btrim(el ->> 'code'));
      IF NOT EXISTS (SELECT 1 FROM public.team_specializations t WHERE t.code = cd) THEN
        errs := errs || public.reg_err_item('/catalogue/' || i || '/code', 'not_a_column', 'Not a code of the specializations (add it to the list first).');
      ELSE
        UPDATE public.team_specializations t SET label_en = btrim(el ->> 'label_en'),
          label_ar = CASE WHEN el ? 'label_ar' THEN nullif(btrim(coalesce(el ->> 'label_ar', '')), '') ELSE t.label_ar END,
          func_group = CASE WHEN el ? 'group' THEN el ->> 'group' ELSE t.func_group END,
          aliases = CASE WHEN el ? 'aliases' THEN (SELECT coalesce(array_agg(DISTINCT btrim(x)), ARRAY[]::text[]) FROM jsonb_array_elements_text(el -> 'aliases') x) ELSE t.aliases END
        WHERE t.code = cd;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  -- one name means one code (codes, labels and aliases of all codes, active or not)
  FOR nm IN
    SELECT x.tok FROM (SELECT t.code, public.p4b_norm(v) AS tok FROM public.team_specializations t
                       CROSS JOIN LATERAL unnest(ARRAY[t.code, t.label_en, t.label_ar] || t.aliases) AS v WHERE public.p4b_norm(v) <> '') x
    GROUP BY x.tok HAVING count(DISTINCT x.code) > 1
  LOOP
    errs := errs || public.reg_err_item('/catalogue', 'name_clash', 'The name "' || nm || '" belongs to more than one specialization.');
  END LOOP;

  -- the rows
  DELETE FROM public.team_scope_match_scopes;   -- the cells and the groups go with their scope (ON DELETE CASCADE)
  i := 0;
  FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'scopes') LOOP
    sc := btrim(el ->> 'scope');
    allowed := ARRAY[]::text[];
    j := 0;
    FOR a IN SELECT * FROM jsonb_array_elements(el -> 'allowed') LOOP
      cd := public.team_spec_resolve(a #>> '{}');
      IF cd IS NULL OR NOT (cd = ANY (codes)) THEN
        errs := errs || public.reg_err_item('/scopes/' || i || '/allowed/' || j, 'unknown_specialization', 'Not one of the listed specializations.');
      ELSE allowed := allowed || cd; END IF;
      j := j + 1;
    END LOOP;
    grps := CASE WHEN el ? 'allowed_groups' THEN ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(el -> 'allowed_groups') x) ELSE ARRAY[]::text[] END;
    INSERT INTO public.team_scope_match_scopes (scope, exempt, sort_order) VALUES (sc, coalesce((el ->> 'exempt')::boolean, false), (i + 1) * 10);
    INSERT INTO public.team_scope_match (scope, specialization, allowed) SELECT sc, c, c = ANY (allowed) FROM unnest(codes) c;
    INSERT INTO public.team_scope_match_groups (scope, func_group) SELECT sc, g FROM unnest(grps) g;
    i := i + 1;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  UPDATE public.team_scope_match_meta SET specializations = codes, version = version + 1, updated_by = public.app_actor(), updated_at = now() WHERE id;
  after := public.team_scope_match_json();
  -- Q147: a change that affects eligibility needs a fresh step-up of the session (labels alone do not)
  IF public.team_scope_match_rules(before) IS DISTINCT FROM public.team_scope_match_rules(after) AND NOT public.log_actor_stepped_up() THEN
    PERFORM public.wf_err('step_up_required', '{}'::jsonb);
  END IF;
  -- the list of the Contractors team field follows the active labels (when it is still a plain list of texts)
  SELECT jsonb_agg(jsonb_build_array(t.code, t.label_en, t.label_ar, t.is_active) ORDER BY t.code) INTO labels_after FROM public.team_specializations t;
  IF labels_after IS DISTINCT FROM labels_before THEN
    UPDATE public.register_fields f SET options = (SELECT jsonb_agg(t.label_en ORDER BY t.sort_order, t.code) FROM public.team_specializations t WHERE t.is_active)
    WHERE f.register_key = 'contractors' AND f.code = 'specialization' AND f.field_type = 'list' AND (f.options IS NULL OR jsonb_typeof(f.options) = 'array');
  END IF;
  PERFORM public.log_audit_write('team_scope_match_update', 'setting', 'team_scope_match', before - 'updated_at' - 'updated_by', after - 'updated_at' - 'updated_by', p_reason);
  RETURN after;
END $$;

-- The check (Q97, Q143, Q144). NULL when the team may take an order of the scope, otherwise {scope, specialization, message}.
CREATE OR REPLACE FUNCTION team_scope_problem(p_scope text, p_team uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sc public.team_scope_match_scopes%ROWTYPE; tname text; legacy text; codes text[]; labels text;
BEGIN
  IF p_team IS NULL OR p_scope IS NULL THEN RETURN NULL; END IF;
  SELECT t.name, nullif(btrim(coalesce(t.specialization, '')), '') INTO tname, legacy FROM public.external_teams t WHERE t.id = p_team;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- an unknown team is refused by reg_clean_data (unknown_team)
  SELECT * INTO sc FROM public.team_scope_match_scopes WHERE scope = p_scope;
  codes := public.team_spec_codes(p_team);
  labels := public.team_spec_labels(codes);
  IF sc.scope IS NULL THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', labels,
      'message', 'The scope ' || p_scope || ' is not in the team / scope match table (Settings), so no team can take it. Ask the System Admin to add it.');
  END IF;
  IF cardinality(codes) = 0 THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', legacy,
      'message', 'The team ' || coalesce(tname, '?') || CASE WHEN legacy IS NULL THEN ' has no specialization'
        ELSE ' has no specialization of the catalogue (' || legacy || ' is not one)' END || ', so it cannot be matched to the scope ' || p_scope || '. Set it in the Contractors register.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_scope_match c WHERE c.scope = p_scope AND c.allowed AND c.specialization = ANY (codes))
     AND NOT EXISTS (SELECT 1 FROM public.team_scope_match_groups g JOIN public.team_specializations t ON t.func_group = g.func_group AND t.is_active
                     WHERE g.scope = p_scope AND t.code = ANY (codes)) THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', labels,
      'message', 'A ' || labels || ' team (' || coalesce(tname, '?') || ') cannot take a ' || p_scope || ' order (Settings, team / scope match).');
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Procurement: the team check on every save of a draft, and at submit the contract and the CW Delivery Model (Q110, Q144, Q145, Q147)
-- ---------------------------------------------------------------------------------------------------------------------
-- The blocking problems of a Procurement record at submit, as field errors. Not the specialization (team_scope_problem, its own error code).
CREATE OR REPLACE FUNCTION p4b_procurement_problems(r public.register_records) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := r.data; errs jsonb := '[]'::jsonb; cfg public.contractor_rules%ROWTYPE; scope text := r.data ->> 'scope'; delivery text := r.data ->> 'delivery';
  team uuid; tparty uuid; tpname text; tpactive boolean; ttype text; on_date date; cw boolean; has_order boolean;
BEGIN
  SELECT * INTO cfg FROM public.contractor_rules WHERE id;
  on_date := coalesce((d ->> 'po_wo_date')::date, (d ->> 'pr_date')::date, public.cal_today());
  cw := scope = ANY (cfg.cw_delivery_scopes);
  has_order := coalesce(d ->> 'po_wo_no', d ->> 'po_wo_date') IS NOT NULL;
  IF coalesce(d ->> 'team_id', '') ~* '^[0-9a-f-]{36}$' THEN team := (d ->> 'team_id')::uuid; END IF;
  IF team IS NOT NULL THEN
    SELECT t.party_id, p.name, p.is_active, t.team_type INTO tparty, tpname, tpactive, ttype FROM public.external_teams t JOIN public.external_parties p ON p.id = t.party_id WHERE t.id = team;
    IF cw AND delivery = 'In-House' THEN
      -- Q147: an in-house order names a qualified internal team (the specialization is checked by team_scope_problem); no contract
      IF NOT EXISTS (SELECT 1 FROM unnest(cfg.internal_team_types) x WHERE public.p4b_norm(x) = public.p4b_norm(ttype)) THEN
        errs := errs || public.reg_err_item('/data/team_id', 'not_internal_team', 'An in-house order needs an internal team (team type ' || array_to_string(cfg.internal_team_types, ' or ') || ').');
      END IF;
    ELSIF tparty IS NOT NULL THEN
      IF NOT tpactive THEN
        errs := errs || public.reg_err_item('/data/team_id', 'party_inactive', 'The contractor ' || tpname || ' of the team is inactive.');
      ELSIF public.party_contract_for(tparty, scope, on_date) IS NULL THEN
        errs := errs || public.reg_err_item('/data/team_id', 'no_active_contract',
          'The contractor ' || tpname || ' of the team has no active contract covering ' || coalesce(scope, '?') || ' on ' || on_date::text || ' (Contractors register).');
      END IF;
    END IF;
  ELSIF cw AND delivery = 'In-House' THEN
    errs := errs || public.reg_err_item('/data/team_id', 'internal_team_required', 'An in-house ' || scope || ' order names the qualified internal team that does the work (CW Delivery Model).');
  END IF;
  IF cw AND delivery = 'Outsourced' AND has_order THEN
    -- Q147: an outsourced order, once it has its PO / WO, is tied to its party and an active contract for the scope
    IF r.external_party_id IS NULL THEN
      errs := errs || public.reg_err_item('/external_party_id', 'party_required', 'An outsourced ' || scope || ' order with a PO / WO needs its contractor (CW Delivery Model).');
    ELSIF (tparty IS NULL OR tparty <> r.external_party_id) AND public.party_contract_for(r.external_party_id, scope, on_date) IS NULL THEN
      errs := errs || public.reg_err_item('/external_party_id', 'no_active_contract',
        'The contractor has no active contract covering ' || scope || ' on ' || on_date::text || ' (Contractors register).');
    END IF;
  END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION reg_team_scope_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p jsonb; team uuid; submit boolean; errs jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'entry' THEN RETURN NEW; END IF;
    submit := false;
  ELSE
    submit := OLD.state = 'entry' AND NEW.state NOT IN ('entry', 'voided');
    IF NOT (submit OR (NEW.state = 'entry' AND NEW.data IS DISTINCT FROM OLD.data)) THEN RETURN NEW; END IF;
  END IF;
  IF coalesce(NEW.data ->> 'team_id', '') ~* '^[0-9a-f-]{36}$' THEN team := (NEW.data ->> 'team_id')::uuid; END IF;
  p := public.team_scope_problem(NEW.data ->> 'scope', team);
  IF p IS NOT NULL THEN
    PERFORM public.wf_err('team_scope_mismatch', jsonb_build_object('detail', p ->> 'message', 'scope', p -> 'scope', 'specialization', p -> 'specialization',
      'errors', public.reg_err_item('/data/team_id', 'team_scope_mismatch', p ->> 'message')));
  END IF;
  IF submit THEN
    errs := public.p4b_procurement_problems(NEW);
    IF jsonb_array_length(errs) > 0 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', errs -> 0 ->> 'message', 'errors', errs));
    END IF;
    INSERT INTO public.team_scope_checks (record_id, entity_id, match_version, scope, team_id, specializations, contract_id)
    VALUES (NEW.id, NEW.entity_id, (SELECT m.version FROM public.team_scope_match_meta m WHERE m.id), NEW.data ->> 'scope', team,
            CASE WHEN team IS NOT NULL THEN public.team_spec_codes(team) END,
            public.party_contract_for(coalesce((SELECT t.party_id FROM public.external_teams t WHERE t.id = team), NEW.external_party_id), NEW.data ->> 'scope',
                                      coalesce((NEW.data ->> 'po_wo_date')::date, (NEW.data ->> 'pr_date')::date, public.cal_today())))
    ON CONFLICT (record_id) DO UPDATE SET match_version = EXCLUDED.match_version, scope = EXCLUDED.scope, team_id = EXCLUDED.team_id,
      specializations = EXCLUDED.specializations, contract_id = EXCLUDED.contract_id, checked_at = now();
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. GECOL: the party, its active contract and the scope at approval (Q146)
-- ---------------------------------------------------------------------------------------------------------------------
-- The one party of this exact name (case-insensitive); NULL when there is none or more than one (an ambiguous name is never linked, Q110).
CREATE OR REPLACE FUNCTION p4b_party_by_name(p_name text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(p.id::text)::uuid END FROM public.external_parties p
  WHERE btrim(coalesce(p_name, '')) <> '' AND lower(btrim(p.name)) = lower(btrim(p_name))
$$;

CREATE OR REPLACE FUNCTION p4b_gecol_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE party uuid := NEW.external_party_id; pname text; pactive boolean; on_date date := coalesce((NEW.data ->> 'request_date')::date, public.cal_today()); errs jsonb := '[]'::jsonb;
BEGIN
  IF party IS NULL THEN party := public.p4b_party_by_name(NEW.data ->> 'contractor'); END IF;
  SELECT p.name, p.is_active INTO pname, pactive FROM public.external_parties p WHERE p.id = party;
  IF party IS NULL THEN
    errs := public.reg_err_item('/external_party_id', 'gecol_party_required', 'A GECOL record is approved with its party: choose it (or a GECOL Contractor name that matches one company of the Contractors register).');
  ELSIF NOT pactive THEN
    errs := public.reg_err_item('/external_party_id', 'party_inactive', 'The party ' || pname || ' is inactive.');
  ELSIF public.party_contract_for(party, 'GECOL', on_date) IS NULL THEN
    errs := public.reg_err_item('/external_party_id', 'no_active_contract', 'The party ' || pname || ' has no active contract covering GECOL on ' || on_date::text || ' (Contractors register).');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', errs -> 0 ->> 'message', 'errors', errs)); END IF;
  NEW.external_party_id := party;   -- the link by id from now on
  RETURN NEW;
END $$;

CREATE TRIGGER b_p4b_gecol_approval BEFORE UPDATE OF state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'gecol' AND NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved') EXECUTE FUNCTION p4b_gecol_approval();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The Contractors register: contract records, more specializations, the safety certificate, the link by id (Q110, Q142, Q143, D145b)
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_definitions SET record_types = record_types || ARRAY['contract'] WHERE register_key = 'contractors' AND NOT ('contract' = ANY (record_types));

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('contractors', 'contract_scopes',      'Contract Scopes (comma separated)', 'نطاقات العقد (مفصولة بفواصل)', 'text', false, false, false, NULL, false, 'Contract', 45),
  ('contractors', 'contract_status',      'Contract Status',                   'حالة العقد',                    'list', false, false, false, '["Active", "Suspended", "Terminated", "Expired"]'::jsonb, false, 'Contract', 47),
  ('contractors', 'more_specializations', 'Other Specializations',             'تخصصات أخرى',                   'text', false, false, false, NULL, false, 'Teams', 105),
  ('contractors', 'safety_cert_expiry',   'Safety Certificate Expiry',         'انتهاء شهادة السلامة',          'date', false, false, false, NULL, false, 'Teams', 115),
  ('contractors', 'team_lead_user',       'Team Owner / Lead (Aljeel)',        'مسؤول الفريق (الجيل)',          'user', false, false, false, NULL, false, 'Teams', 120)
ON CONFLICT (register_key, code) DO NOTHING;

-- The main specialization becomes a pick list of the catalogue labels, while it is still a free list (a later field type keeps its own values).
UPDATE register_fields SET options = (SELECT jsonb_agg(t.label_en ORDER BY t.sort_order, t.code) FROM team_specializations t WHERE t.is_active)
WHERE register_key = 'contractors' AND code = 'specialization' AND field_type = 'list' AND options IS NULL;

-- Saving a team or a contract in entry: the company link by id, the other specializations and the contract scopes as catalogue values.
CREATE OR REPLACE FUNCTION p4b_contractors_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; pname text; part text; cd text; codes text[] := ARRAY[]::text[]; main text; errs jsonb := '[]'::jsonb; scopes text[] := ARRAY[]::text[]; sc text;
BEGIN
  IF NEW.state <> 'entry' OR coalesce(NEW.record_type, '') NOT IN ('team', 'contract') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.data IS NOT DISTINCT FROM OLD.data AND NEW.external_party_id IS NOT DISTINCT FROM OLD.external_party_id THEN RETURN NEW; END IF;
    -- Q110: the company by id. A changed company name finds its id again; the id wins over a name that does not match it.
    IF NEW.external_party_id IS NOT DISTINCT FROM OLD.external_party_id AND (d ->> 'contractor') IS DISTINCT FROM (OLD.data ->> 'contractor') THEN
      NEW.external_party_id := NULL;
    END IF;
  END IF;
  IF NEW.external_party_id IS NOT NULL THEN
    SELECT p.name INTO pname FROM public.external_parties p WHERE p.id = NEW.external_party_id;
    IF NOT (d ? 'contractor') THEN d := d || jsonb_build_object('contractor', pname);
    ELSIF lower(btrim(d ->> 'contractor')) <> lower(btrim(pname)) THEN
      errs := errs || public.reg_err_item('/data/contractor', 'contractor_mismatch', 'The contractor name is not the name of the chosen company (' || pname || ').');
    END IF;
  ELSIF d ? 'contractor' THEN
    NEW.external_party_id := public.p4b_party_by_name(d ->> 'contractor');
  END IF;
  IF NEW.record_type = 'team' AND d ? 'more_specializations' THEN
    main := public.team_spec_resolve(d ->> 'specialization');
    FOREACH part IN ARRAY public.p4b_split(d ->> 'more_specializations') LOOP
      cd := public.team_spec_resolve(part);
      IF cd IS NULL THEN
        errs := errs || public.reg_err_item('/data/more_specializations', 'unknown_specialization', part || ' is not a specialization of the catalogue (Settings, team / scope match).');
      ELSIF cd IS DISTINCT FROM main AND NOT (cd = ANY (codes)) THEN codes := codes || cd; END IF;
    END LOOP;
    d := CASE WHEN cardinality(codes) = 0 THEN d - 'more_specializations' ELSE d || jsonb_build_object('more_specializations', public.team_spec_labels(codes)) END;
  END IF;
  IF NEW.record_type = 'contract' AND d ? 'contract_scopes' THEN
    FOREACH part IN ARRAY public.p4b_split(d ->> 'contract_scopes') LOOP
      SELECT s.scope INTO sc FROM public.team_scope_match_scopes s WHERE lower(s.scope) = lower(part);
      IF sc IS NULL THEN errs := errs || public.reg_err_item('/data/contract_scopes', 'unknown_scope', part || ' is not an order scope (Settings, team / scope match).');
      ELSIF NOT (sc = ANY (scopes)) THEN scopes := scopes || sc; END IF;
      sc := NULL;
    END LOOP;
    d := CASE WHEN cardinality(scopes) = 0 THEN d - 'contract_scopes' ELSE d || jsonb_build_object('contract_scopes', array_to_string(scopes, ', ')) END;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  NEW.data := d;
  RETURN NEW;
END $$;

CREATE TRIGGER b_p4b_contractors_entry BEFORE INSERT OR UPDATE ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'contractors') EXECUTE FUNCTION p4b_contractors_entry();

-- Submit rules of the Contractors register, around the 0025 rules (reg_validate calls reg_validate_catalog by name).
ALTER FUNCTION reg_validate_catalog(uuid) RENAME TO reg_validate_catalog_base;

CREATE OR REPLACE FUNCTION reg_validate_contractors_p4b(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d jsonb; errs jsonb := '[]'::jsonb; k text; part text; n integer := 0; other uuid;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  IF r.record_type = 'team' THEN
    -- Q142, Q143: an active team needs at least one specialization of the catalogue (a draft may be saved without)
    IF d ? 'specialization' THEN
      IF public.team_spec_resolve(d ->> 'specialization') IS NULL THEN
        errs := errs || public.reg_err_item('/data/specialization', 'unknown_specialization',
          (d ->> 'specialization') || CASE WHEN upper(btrim(d ->> 'specialization')) IN ('CW', 'TE') THEN ' is a functional group: choose the specialization of the team.' ELSE ' is not a specialization of the catalogue.' END);
      ELSE n := n + 1; END IF;
    END IF;
    n := n + cardinality(public.p4b_split(d ->> 'more_specializations'));
    IF n = 0 AND lower(coalesce(d ->> 'team_status', 'active')) NOT IN ('inactive', 'closed') THEN
      errs := errs || public.reg_err_item('/data/specialization', 'specialization_required', 'An active team needs at least one specialization before it can take an order (Q142).');
    END IF;
    IF r.external_party_id IS NULL AND d ? 'contractor'
       AND (SELECT count(*) FROM public.external_parties p WHERE lower(btrim(p.name)) = lower(btrim(d ->> 'contractor'))) > 1 THEN
      errs := errs || public.reg_err_item('/data/contractor', 'ambiguous_contractor', 'More than one company has this name: choose the company itself.');
    END IF;
  ELSIF r.record_type = 'contract' THEN
    FOR k IN SELECT jsonb_object_keys(d) LOOP
      IF NOT (k = ANY (ARRAY['contractor', 'contract_ref', 'contract_start', 'contract_end', 'contract_scopes', 'contract_status'])) THEN
        errs := errs || public.reg_err_item('/data/' || k, 'not_applicable', 'This field does not belong to a contract.');
      END IF;
    END LOOP;
    IF r.external_party_id IS NULL THEN
      errs := errs || public.reg_err_item('/data/contractor', CASE WHEN d ? 'contractor' THEN 'unknown_contractor' ELSE 'required' END,
        'A contract belongs to one approved company of the register (by its exact name).');
    END IF;
    IF btrim(coalesce(d ->> 'contract_ref', '')) = '' THEN errs := errs || public.reg_err_item('/data/contract_ref', 'required', 'The contract reference is required.'); END IF;
    IF NOT (d ? 'contract_start') THEN errs := errs || public.reg_err_item('/data/contract_start', 'required', 'The contract start is required.'); END IF;
    IF d ? 'contract_start' AND d ? 'contract_end' AND (d ->> 'contract_end')::date < (d ->> 'contract_start')::date THEN
      errs := errs || public.reg_err_item('/data/contract_end', 'date_error', 'The contract end is before its start.');
    END IF;
    IF cardinality(public.p4b_split(d ->> 'contract_scopes')) = 0 THEN
      errs := errs || public.reg_err_item('/data/contract_scopes', 'required', 'A contract names the order scopes it covers.');
    END IF;
    SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'contractors' AND x.record_type = 'contract' AND x.entity_id <> r.entity_id AND x.state <> 'voided'
      AND x.external_party_id = r.external_party_id AND lower(btrim(x.data ->> 'contract_ref')) = lower(btrim(d ->> 'contract_ref')) LIMIT 1;
    IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/contract_ref', 'duplicate', 'This company has a contract with this reference already.'); END IF;
  END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION reg_validate_catalog(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; errs jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.register_key IS DISTINCT FROM 'contractors' THEN RETURN public.reg_validate_catalog_base(p_record); END IF;
  IF r.record_type = 'contract' THEN RETURN public.reg_validate_contractors_p4b(p_record); END IF;
  errs := public.reg_validate_catalog_base(p_record);
  IF r.record_type = 'team' THEN
    -- the fields P4b adds to a team are its own (0025 lists the older ones only)
    SELECT coalesce(jsonb_agg(e), '[]'::jsonb) INTO errs FROM jsonb_array_elements(errs) e
    WHERE NOT (e ->> 'code' = 'not_applicable' AND e ->> 'path' IN ('/data/more_specializations', '/data/safety_cert_expiry', '/data/team_lead_user'));
  END IF;
  RETURN errs || public.reg_validate_contractors_p4b(p_record);
END $$;

-- After the final approval (after z_catalog_on_approved of 0025, which runs first by name): the type mapping with its review alert, the team by
-- party id with its specializations, certificate and lead, and the contracts.
CREATE OR REPLACE FUNCTION p4b_contractors_on_approved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; mapped "ExternalPartyType"; party uuid; codes text[] := ARRAY[]::text[]; part text; cd text; active boolean;
BEGIN
  IF NEW.record_type = 'company' THEN
    SELECT m.party_type INTO mapped FROM public.external_party_type_map m WHERE m.source = public.p4b_norm(d ->> 'company_type');
    UPDATE public.external_parties SET type = coalesce(mapped, 'other'), type_review = (mapped IS NULL), company_type = d ->> 'company_type', source_record_id = NEW.id
    WHERE id = NEW.entity_id;
    IF mapped IS NULL THEN
      PERFORM public.reg_notify_admins('party_type_review', 'Review the type of a contractor',
        (d ->> 'contractor_name') || ': the company type "' || coalesce(d ->> 'company_type', '') || '" is not a known type, so the party was set to other (Q110).', NEW.id);
    END IF;
    IF d ? 'contract_ref' OR d ? 'contract_start' THEN
      INSERT INTO public.external_party_contracts (id, party_id, contract_ref, scopes, start_date, end_date, status, origin, source_record_id)
      VALUES (NEW.entity_id, NEW.entity_id, d ->> 'contract_ref', NULL, (d ->> 'contract_start')::date, (d ->> 'contract_end')::date, 'active', 'company', NEW.id)
      ON CONFLICT (id) DO UPDATE SET contract_ref = EXCLUDED.contract_ref, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, source_record_id = EXCLUDED.source_record_id, updated_at = now();
    ELSE
      DELETE FROM public.external_party_contracts WHERE id = NEW.entity_id AND origin = 'company';
    END IF;
  ELSIF NEW.record_type = 'team' THEN
    party := coalesce(NEW.external_party_id, public.p4b_party_by_name(d ->> 'contractor'));
    IF party IS NULL THEN RETURN NULL; END IF;
    FOREACH part IN ARRAY (CASE WHEN d ? 'specialization' THEN ARRAY[d ->> 'specialization'] ELSE ARRAY[]::text[] END) || public.p4b_split(d ->> 'more_specializations') LOOP
      cd := public.team_spec_resolve(part);
      IF cd IS NOT NULL AND NOT (cd = ANY (codes)) THEN codes := codes || cd; END IF;
    END LOOP;
    active := lower(coalesce(d ->> 'team_status', 'active')) NOT IN ('inactive', 'closed');
    INSERT INTO public.external_teams (id, party_id, name, team_type, specialization, is_active, safety_cert_expiry, lead_user_id, source_record_id)
    VALUES (NEW.entity_id, party, d ->> 'team_name', d ->> 'team_type', coalesce(public.team_spec_labels(codes), d ->> 'specialization'), active,
            (d ->> 'safety_cert_expiry')::date, (d ->> 'team_lead_user')::uuid, NEW.id)
    ON CONFLICT (id) DO UPDATE SET party_id = EXCLUDED.party_id, name = EXCLUDED.name, team_type = EXCLUDED.team_type, specialization = EXCLUDED.specialization,
      is_active = EXCLUDED.is_active, safety_cert_expiry = EXCLUDED.safety_cert_expiry, lead_user_id = EXCLUDED.lead_user_id, source_record_id = EXCLUDED.source_record_id;
    DELETE FROM public.external_team_specializations WHERE team_id = NEW.entity_id;
    INSERT INTO public.external_team_specializations (team_id, code) SELECT NEW.entity_id, c FROM unnest(codes) c;
  ELSIF NEW.record_type = 'contract' AND NEW.external_party_id IS NOT NULL THEN
    INSERT INTO public.external_party_contracts (id, party_id, contract_ref, scopes, start_date, end_date, status, origin, source_record_id)
    VALUES (NEW.entity_id, NEW.external_party_id, d ->> 'contract_ref', public.p4b_split(d ->> 'contract_scopes'), (d ->> 'contract_start')::date, (d ->> 'contract_end')::date,
            lower(coalesce(d ->> 'contract_status', 'Active')), 'contract', NEW.id)
    ON CONFLICT (id) DO UPDATE SET party_id = EXCLUDED.party_id, contract_ref = EXCLUDED.contract_ref, scopes = EXCLUDED.scopes, start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date, status = EXCLUDED.status, source_record_id = EXCLUDED.source_record_id, updated_at = now();
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER z_p4b_contractors_on_approved AFTER UPDATE OF state ON register_records
  FOR EACH ROW WHEN (NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved' AND NEW.register_key = 'contractors') EXECUTE FUNCTION p4b_contractors_on_approved();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Reports: running orders that no longer match (Q145) and the completeness of the Contractors data (Q142, Q110)
-- ---------------------------------------------------------------------------------------------------------------------
-- Every running order with its problems on p_on (no visibility filter: the readers and the daily job filter).
CREATE OR REPLACE FUNCTION p4b_order_problems(p_on date) RETURNS TABLE (record_id uuid, entity_id uuid, site_id uuid, region_id integer, scope text, delivery text,
  team_id uuid, party_id uuid, order_status text, problems jsonb, checked_version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg public.contractor_rules%ROWTYPE; o record; probs jsonb; p jsonb; t record; cpart uuid;
BEGIN
  SELECT * INTO cfg FROM public.contractor_rules WHERE id;
  FOR o IN
    SELECT pr.id AS eid, pr.register_record_id AS rid, pr.site_id AS sid, pr.region_id AS reg, pr.scope AS sc, pr.delivery AS dl, pr.team_id AS tid, pr.party_id AS pid,
           pr.order_status AS os, pr.po_wo_no AS po
    FROM public.procurement_records pr
    WHERE NOT EXISTS (SELECT 1 FROM unnest(cfg.closed_order_statuses) x WHERE public.p4b_norm(x) = public.p4b_norm(pr.order_status))
    ORDER BY pr.site_id, pr.id
  LOOP
    probs := '[]'::jsonb;
    IF o.tid IS NOT NULL THEN
      SELECT et.name, et.is_active AS t_active, et.safety_cert_expiry, et.team_type, ep.id AS party, ep.name AS pname, ep.is_active AS p_active
        INTO t FROM public.external_teams et JOIN public.external_parties ep ON ep.id = et.party_id WHERE et.id = o.tid;
      p := public.team_scope_problem(o.sc, o.tid);
      IF p IS NOT NULL THEN probs := probs || jsonb_build_object('code', 'specialization_mismatch', 'severity', 'eligibility', 'message', p ->> 'message'); END IF;
      IF NOT t.t_active THEN probs := probs || jsonb_build_object('code', 'team_inactive', 'severity', 'eligibility', 'message', 'The team ' || t.name || ' is inactive.'); END IF;
      IF NOT t.p_active THEN probs := probs || jsonb_build_object('code', 'party_inactive', 'severity', 'eligibility', 'message', 'The contractor ' || t.pname || ' is inactive.'); END IF;
      IF NOT (o.sc = ANY (cfg.cw_delivery_scopes) AND o.dl = 'In-House') AND public.party_contract_for(t.party, o.sc, p_on) IS NULL THEN
        probs := probs || jsonb_build_object('code', 'no_active_contract', 'severity', 'eligibility', 'message', 'The contractor ' || t.pname || ' has no active contract covering ' || o.sc || ' today.');
      END IF;
      IF t.safety_cert_expiry IS NOT NULL AND t.safety_cert_expiry < p_on THEN
        probs := probs || jsonb_build_object('code', 'safety_cert_expired', 'severity', 'info', 'message', 'The safety certificate of the team expired on ' || t.safety_cert_expiry::text || ' (information only).');
      END IF;
      cpart := t.party;
    ELSE cpart := NULL; END IF;
    IF o.sc = ANY (cfg.cw_delivery_scopes) AND o.dl = 'Outsourced' AND o.po IS NOT NULL AND o.pid IS NOT NULL AND o.pid IS DISTINCT FROM cpart
       AND public.party_contract_for(o.pid, o.sc, p_on) IS NULL THEN
      probs := probs || jsonb_build_object('code', 'no_active_contract', 'severity', 'eligibility', 'message', 'The contractor of the order has no active contract covering ' || o.sc || ' today.');
    END IF;
    IF EXISTS (SELECT 1 FROM public.permit_records pm WHERE pm.site_id = o.sid AND pm.stop_work AND (pm.stop_lifted_date IS NULL OR pm.stop_lifted_date > p_on)) THEN
      probs := probs || jsonb_build_object('code', 'stop_work', 'severity', 'eligibility', 'message', 'A Stop Work is active on the site (Permits & HSE).');
    END IF;
    IF jsonb_array_length(probs) > 0 THEN
      record_id := o.rid; entity_id := o.eid; site_id := o.sid; region_id := o.reg; scope := o.sc; delivery := o.dl; team_id := o.tid; party_id := o.pid; order_status := o.os;
      problems := probs;
      checked_version := (SELECT c.match_version FROM public.team_scope_checks c WHERE c.record_id = o.rid);
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- The report for the caller: the regions in which they may read Procurement (B3).
CREATE OR REPLACE FUNCTION team_scope_mismatch_report() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE regs int[] := public.wf_actor_regions('procurement', 'view'); today date := public.cal_today();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object('as_of', today, 'match_version', (SELECT m.version FROM public.team_scope_match_meta m WHERE m.id), 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'record_id', x.record_id, 'entity_id', x.entity_id, 'site_id', x.site_id, 'site_code', s.site_code, 'region_id', x.region_id, 'scope', x.scope, 'delivery', x.delivery,
      'order_status', x.order_status,
      'team', CASE WHEN x.team_id IS NULL THEN NULL ELSE jsonb_build_object('id', x.team_id, 'name', t.name, 'specializations', to_jsonb(public.team_spec_codes(x.team_id))) END,
      'party', CASE WHEN x.party_id IS NULL THEN NULL ELSE jsonb_build_object('id', x.party_id, 'name', p.name) END,
      'problems', x.problems, 'checked_match_version', x.checked_version) ORDER BY s.site_code, x.record_id)
    FROM public.p4b_order_problems(today) x
    JOIN public.sites s ON s.id = x.site_id
    LEFT JOIN public.external_teams t ON t.id = x.team_id
    LEFT JOIN public.external_parties p ON p.id = x.party_id
    WHERE regs IS NULL OR x.region_id = ANY (regs)), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION contractors_completeness_report() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); today date := public.cal_today(); lead integer := (SELECT safety_cert_lead_days FROM public.contractor_rules WHERE id);
BEGIN
  IF a IS NULL OR NOT public.app_has_permission(a, 'contractors', 'view') THEN
    RAISE EXCEPTION 'contractors completeness: contractors view required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object('as_of', today,
    'teams', coalesce((
      SELECT jsonb_agg(jsonb_build_object('team_id', t.id, 'name', t.name, 'party', jsonb_build_object('id', p.id, 'name', p.name), 'record_id', t.source_record_id,
               'specialization_text', t.specialization, 'safety_cert_expiry', t.safety_cert_expiry, 'issues', z.issues) ORDER BY p.name, t.name)
      FROM public.external_teams t JOIN public.external_parties p ON p.id = t.party_id
      CROSS JOIN LATERAL (SELECT to_jsonb(array_remove(ARRAY[
          CASE WHEN cardinality(public.team_spec_codes(t.id)) = 0 AND t.specialization IS NULL THEN 'no_specialization' END,
          CASE WHEN cardinality(public.team_spec_codes(t.id)) = 0 AND t.specialization IS NOT NULL THEN 'unknown_specialization' END,
          CASE WHEN t.safety_cert_expiry < today THEN 'safety_cert_expired' END,
          CASE WHEN t.safety_cert_expiry >= today AND t.safety_cert_expiry <= today + lead THEN 'safety_cert_due' END], NULL)) AS issues) z
      WHERE t.is_active AND jsonb_array_length(z.issues) > 0), '[]'::jsonb),
    'parties', coalesce((
      SELECT jsonb_agg(jsonb_build_object('party_id', p.id, 'name', p.name, 'type', p.type, 'company_type', p.company_type, 'record_id', p.source_record_id, 'issues', z.issues) ORDER BY p.name)
      FROM public.external_parties p
      CROSS JOIN LATERAL (SELECT to_jsonb(array_remove(ARRAY[
          CASE WHEN p.type_review THEN 'type_review' END,
          CASE WHEN NOT EXISTS (SELECT 1 FROM public.external_party_contracts c WHERE c.party_id = p.id AND c.status = 'active'
                                AND (c.start_date IS NULL OR c.start_date <= today) AND (c.end_date IS NULL OR c.end_date >= today)) THEN 'no_active_contract' END], NULL)) AS issues) z
      WHERE p.is_active AND jsonb_array_length(z.issues) > 0), '[]'::jsonb),
    'contracts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('contract_id', c.id, 'party', jsonb_build_object('id', p.id, 'name', p.name), 'contract_ref', c.contract_ref, 'origin', c.origin,
               'start_date', c.start_date, 'end_date', c.end_date, 'status', c.status, 'issues', z.issues) ORDER BY p.name, c.contract_ref)
      FROM public.external_party_contracts c JOIN public.external_parties p ON p.id = c.party_id
      CROSS JOIN LATERAL (SELECT to_jsonb(array_remove(ARRAY[
          CASE WHEN c.scopes IS NULL THEN 'scope_not_specified' END,
          CASE WHEN c.status = 'active' AND c.end_date < today THEN 'past_end_date' END], NULL)) AS issues) z
      WHERE jsonb_array_length(z.issues) > 0), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The rules screen and the daily alerts (D145b, Q145)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION contractor_rules_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('safety_cert_lead_days', c.safety_cert_lead_days, 'recipient_roles', to_jsonb(c.recipient_roles), 'cw_delivery_scopes', to_jsonb(c.cw_delivery_scopes),
    'internal_team_types', to_jsonb(c.internal_team_types), 'closed_order_statuses', to_jsonb(c.closed_order_statuses),
    'version', c.version, 'updated_at', c.updated_at, 'updated_by', c.updated_by)
  FROM public.contractor_rules c WHERE c.id
$$;

CREATE OR REPLACE FUNCTION admin_save_contractor_rules(p jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.contractor_rules%ROWTYPE; errs jsonb := '[]'::jsonb; k text; before jsonb; lead integer; arrs text[] := ARRAY['recipient_roles', 'cw_delivery_scopes', 'internal_team_types', 'closed_order_statuses'];
  v text[]; x text;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO c FROM public.contractor_rules WHERE id FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> c.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.'))); END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY (arrs || 'safety_cert_lead_days'::text)) THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'safety_cert_lead_days') IS DISTINCT FROM 'number' OR (p ->> 'safety_cert_lead_days')::numeric NOT BETWEEN 0 AND 365
     OR (p ->> 'safety_cert_lead_days')::numeric <> trunc((p ->> 'safety_cert_lead_days')::numeric) THEN
    errs := errs || public.reg_err_item('/safety_cert_lead_days', 'out_of_range', 'A whole number of days from 0 to 365.');
  END IF;
  FOREACH k IN ARRAY arrs LOOP
    IF jsonb_typeof(p -> k) IS DISTINCT FROM 'array' OR jsonb_array_length(p -> k) > 30
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p -> k) e WHERE jsonb_typeof(e) <> 'string' OR char_length(btrim(e #>> '{}')) NOT BETWEEN 1 AND 60) THEN
      errs := errs || public.reg_err_item('/' || k, 'invalid', 'A list of at most 30 texts of 1 to 60 characters.');
    END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'recipient_roles') = 'array' THEN
    FOR x IN SELECT jsonb_array_elements_text(p -> 'recipient_roles') LOOP
      IF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.code = btrim(x)) THEN errs := errs || public.reg_err_item('/recipient_roles', 'unknown_role', x || ' is not a role code.'); END IF;
    END LOOP;
  END IF;
  IF jsonb_typeof(p -> 'cw_delivery_scopes') = 'array' THEN
    FOR x IN SELECT jsonb_array_elements_text(p -> 'cw_delivery_scopes') LOOP
      IF NOT EXISTS (SELECT 1 FROM public.team_scope_match_scopes s WHERE s.scope = btrim(x)) THEN errs := errs || public.reg_err_item('/cw_delivery_scopes', 'unknown_scope', x || ' is not an order scope.'); END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := public.contractor_rules_json();
  lead := (p ->> 'safety_cert_lead_days')::integer;
  UPDATE public.contractor_rules SET safety_cert_lead_days = lead,
    recipient_roles = ARRAY(SELECT DISTINCT btrim(e) FROM jsonb_array_elements_text(p -> 'recipient_roles') e),
    cw_delivery_scopes = ARRAY(SELECT DISTINCT btrim(e) FROM jsonb_array_elements_text(p -> 'cw_delivery_scopes') e),
    internal_team_types = ARRAY(SELECT DISTINCT btrim(e) FROM jsonb_array_elements_text(p -> 'internal_team_types') e),
    closed_order_statuses = ARRAY(SELECT DISTINCT btrim(e) FROM jsonb_array_elements_text(p -> 'closed_order_statuses') e),
    version = version + 1, updated_by = public.app_actor(), updated_at = now() WHERE id;
  -- Q147: the CW Delivery Model scopes and the internal team types decide eligibility: a change needs a fresh step-up
  SELECT * INTO c FROM public.contractor_rules WHERE id;
  IF (SELECT array_agg(z.v ORDER BY z.v) FROM unnest(c.cw_delivery_scopes) AS z(v)) IS DISTINCT FROM (SELECT array_agg(z.v ORDER BY z.v) FROM jsonb_array_elements_text(before -> 'cw_delivery_scopes') AS z(v))
     OR (SELECT array_agg(z.v ORDER BY z.v) FROM unnest(c.internal_team_types) AS z(v)) IS DISTINCT FROM (SELECT array_agg(z.v ORDER BY z.v) FROM jsonb_array_elements_text(before -> 'internal_team_types') AS z(v)) THEN
    IF NOT public.log_actor_stepped_up() THEN PERFORM public.wf_err('step_up_required', '{}'::jsonb); END IF;
  END IF;
  PERFORM public.log_audit_write('contractor_rules_update', 'setting', 'contractor_rules', before - 'updated_at' - 'updated_by', public.contractor_rules_json() - 'updated_at' - 'updated_by', p_reason);
  RETURN public.contractor_rules_json();
END $$;

-- Holders of the recipient roles (Procurement by default) whose assignment covers the region (NULL = any region), active now.
CREATE OR REPLACE FUNCTION p4b_recipients(p_region integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT ua.user_id FROM public.user_role_assignments ua
  JOIN public.roles r ON r.id = ua.role_id AND r.code = ANY (coalesce((SELECT c.recipient_roles FROM public.contractor_rules c WHERE c.id), ARRAY[]::text[]))
  JOIN public.users u ON u.id = ua.user_id AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
  WHERE ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
    AND (p_region IS NULL OR ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions x WHERE x.assignment_id = ua.id AND x.region_id = p_region))
$$;

CREATE OR REPLACE FUNCTION p4b_admins() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
  JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL AND NOT x.is_break_glass
$$;

-- The daily alerts. Idempotent: each (kind, object, detail) is alerted once. Returns the notifications written.
--   D145b: a team certificate within the lead days ("due") and once expired ("expired"), to the team's lead and Procurement. Information only.
--   Q145:  a running order with an eligibility problem, once per order and problem code, to Procurement of the order's region (of any region when
--          nobody holds it there; the System Admins when nobody holds it at all).
CREATE OR REPLACE FUNCTION contractors_daily_alerts() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg public.contractor_rules%ROWTYPE; today date := public.cal_today(); t record; o record; pr jsonb; stage text; u uuid; n integer := 0; ok boolean;
  who uuid[]; lnk text;
BEGIN
  SELECT * INTO cfg FROM public.contractor_rules WHERE id;
  FOR t IN SELECT et.id, et.name, et.safety_cert_expiry AS exp, et.lead_user_id, et.source_record_id, ep.name AS pname
           FROM public.external_teams et JOIN public.external_parties ep ON ep.id = et.party_id
           WHERE et.is_active AND et.safety_cert_expiry IS NOT NULL AND et.safety_cert_expiry <= today + cfg.safety_cert_lead_days ORDER BY et.safety_cert_expiry, et.id LOOP
    stage := CASE WHEN t.exp < today THEN 'expired' ELSE 'due' END;
    INSERT INTO public.contractor_alerts_sent (kind, ref_id, detail) VALUES ('safety_cert_' || stage, t.id, t.exp::text) ON CONFLICT DO NOTHING RETURNING true INTO ok;
    IF ok IS NULL THEN CONTINUE; END IF;
    who := ARRAY(SELECT x FROM public.p4b_recipients(NULL) x UNION SELECT us.id FROM public.users us WHERE us.id = t.lead_user_id AND us.status = 'active' AND us.deleted_at IS NULL);
    IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_admins()); END IF;
    lnk := CASE WHEN t.source_record_id IS NOT NULL THEN '/registers/contractors/records/' || t.source_record_id::text ELSE '/reports/contractors' END;
    FOREACH u IN ARRAY who LOOP
      INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
      VALUES (u, 'in_app', 'team_safety_cert', CASE stage WHEN 'expired' THEN 'A team safety certificate has expired' ELSE 'A team safety certificate expires soon' END,
              t.name || ' (' || t.pname || '): the safety certificate ' || CASE stage WHEN 'expired' THEN 'expired on ' ELSE 'expires on ' END || t.exp::text
              || '. Information only: orders and assignments are not blocked (D145b).', lnk);
      n := n + 1;
    END LOOP;
    ok := NULL;
  END LOOP;
  FOR o IN SELECT * FROM public.p4b_order_problems(today) LOOP
    FOR pr IN SELECT e FROM jsonb_array_elements(o.problems) e WHERE e ->> 'severity' = 'eligibility' LOOP
      INSERT INTO public.contractor_alerts_sent (kind, ref_id, detail) VALUES ('order_mismatch', o.entity_id, pr ->> 'code') ON CONFLICT DO NOTHING RETURNING true INTO ok;
      IF ok IS NULL THEN CONTINUE; END IF;
      who := ARRAY(SELECT public.p4b_recipients(o.region_id));
      IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_recipients(NULL)); END IF;   -- nobody for the region: Procurement of any region
      IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_admins()); END IF;
      FOREACH u IN ARRAY who LOOP
        INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
        VALUES (u, 'in_app', 'order_team_mismatch', 'A running order no longer matches its team or contract',
                coalesce((SELECT s.site_code FROM public.sites s WHERE s.id = o.site_id), '?') || ' / ' || coalesce(o.scope, '?') || ': ' || (pr ->> 'message')
                || ' See Reports, team / scope mismatch.', '/registers/procurement/records/' || o.record_id::text);
        n := n + 1;
      END LOOP;
      ok := NULL;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and rights. pmis_app reads the new tables and calls the readers and writers; it never writes the tables.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON team_specializations, team_scope_match_groups, external_team_specializations, external_party_contracts, external_party_type_map,
  contractor_rules, team_scope_checks, contractor_alerts_sent TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_scope_match_meta, team_scope_match_scopes, team_scope_match TO pmis_definer;
GRANT SELECT, UPDATE ON external_parties, external_teams, register_fields TO pmis_definer;
GRANT SELECT ON procurement_records, permit_records, sites, roles, user_role_assignments, user_role_assignment_regions, users, groups, group_members TO pmis_definer;
GRANT SELECT, INSERT ON notifications TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['team_spec_resolve(text,boolean)', 'team_spec_labels(text[])', 'party_contract_for(uuid,text,date)', 'team_spec_codes(uuid)',
    'team_scope_match_json()', 'admin_save_team_scope_match(jsonb,text,integer)', 'team_scope_problem(text,uuid)', 'p4b_procurement_problems(register_records)',
    'reg_team_scope_check()', 'p4b_party_by_name(text)', 'p4b_gecol_approval()', 'p4b_contractors_entry()', 'reg_validate_contractors_p4b(uuid)',
    'reg_validate_catalog(uuid)', 'reg_validate_catalog_base(uuid)', 'p4b_contractors_on_approved()', 'p4b_order_problems(date)', 'team_scope_mismatch_report()',
    'contractors_completeness_report()', 'contractor_rules_json()', 'admin_save_contractor_rules(jsonb,text,integer)', 'p4b_recipients(integer)', 'p4b_admins()',
    'contractors_daily_alerts()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON team_specializations, team_scope_match_groups, external_team_specializations, external_party_contracts, external_party_type_map, contractor_rules TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON team_specializations, team_scope_match_groups, external_team_specializations, external_party_contracts, external_party_type_map,
      contractor_rules FROM pmis_app;
    REVOKE ALL ON team_scope_checks, contractor_alerts_sent FROM pmis_app;
    FOREACH f IN ARRAY ARRAY['team_scope_match_json()', 'admin_save_team_scope_match(jsonb,text,integer)', 'team_scope_mismatch_report()', 'contractors_completeness_report()',
      'contractor_rules_json()', 'admin_save_contractor_rules(jsonb,text,integer)', 'contractors_daily_alerts()'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
