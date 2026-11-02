-- 0043_gates_scope_match: the gate-lock exempt list (owner decision 2026-11-02) and the team specialization / scope match of Procurement (Q97).
-- Mirror: db/sql/042_gates_scope_match.sql (kept byte-identical).
--
-- Nothing of an earlier migration is edited. Two parts:
--
--   1. Gate-lock exempt list (docs/spec/owner-answers-2026-10-29.md, row "Gate lock exempt list"; Q81 of 0018). D1 (TE access permission), the
--      DLP / FAC tasks B14, B15 and D18 and the dismantle tasks E2 and E3 join C1 to C4 in calc.gate_lock_exempt_tasks. The codes are MERGED into the
--      value that is there: an admin's own edits (added codes, prefixes such as "C*", their order) are kept and only the missing codes are appended.
--      A missing setting is created with C1 to C4 plus the new codes. Tasks that a closed gate already holds (lock_reason gate_closed:<gate>) and that
--      are now exempt open through calc_release_gated, the same unlock code of 0018 (state, audit, notice, SLA clock).
--
--   2. Q97 (default answer): Procurement checks that the team's specialization matches the order scope, through a match table in Settings that the
--      admin edits. A mismatch is refused with 422 team_scope_mismatch. Three tables, read-only for pmis_app:
--        team_scope_match_meta   one row: the ordered specializations (the columns of the grid), the version (If-Match), who and when;
--        team_scope_match_scopes the scopes (the rows of the grid), in order, each with an "exempt" flag (no check at all for that scope);
--        team_scope_match        one cell per scope x specialization: allowed yes / no.
--      Seed (spec registers-and-streams.md 3.3 and decision D37, Scope Match): CW, Tower Erection, Site Adaption, CW Dismantle and GECOL need a CW team;
--      TE Installation needs a TE team; TE Dismantle accepts a TE or a CW team. HLC is exempt (the HLC request has no contractor team). STA and ST
--      (the analysis provider, D37 is silent) have a row with no specialization allowed, so a team on such an order is refused until the owner
--      decides (conservative; owner question).
--      The check (reg_team_scope_check, a BEFORE trigger on register_records, like dismantle_rules of 0021) runs only for Procurement records that name
--      a team (data.team_id), on every save of a draft (insert, or a change of its data while in entry) and again at submit (the move out of entry), so
--      a table or team changed after the draft was saved is caught too. It is refused when:
--        the scope is not exempt and is not in the table at all            (conservative: an unknown scope accepts no team);
--        the team has no specialization                                   (conservative: it cannot be matched);
--        the cell scope x specialization is not allowed or does not exist.
--      Specializations are compared trimmed and case-insensitively (lower() of ASCII), scopes exactly (they are the closed list of the scope field).
--      Writer: admin_save_team_scope_match (System Admin or a delegation of admin.settings edit for all regions, a reason, If-Match version, an audit
--      row with before and after).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Gate-lock exempt list: merge the owner's codes into the current value
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('calc.gate_lock_exempt_tasks', '["C1","C2","C3","C4","D1","B14","B15","D18","E2","E3"]',
   'Task codes that a closed gate does not lock: GECOL and HLC (C1 to C4, in parallel with civil works), D1 (TE access permission), the DLP / FAC tasks B14, B15 and D18, and the dismantle tasks E2 and E3 (owner decision 2026-11-02). An entry ending in * is a prefix, for example "C*".',
   now())
ON CONFLICT (key) DO UPDATE SET
  value = CASE WHEN jsonb_typeof(settings.value) = 'array'
               THEN settings.value || coalesce((SELECT jsonb_agg(to_jsonb(c.code) ORDER BY c.ord)
                                                FROM unnest(ARRAY['D1', 'B14', 'B15', 'D18', 'E2', 'E3']) WITH ORDINALITY AS c(code, ord)
                                                WHERE NOT (settings.value ? c.code)), '[]'::jsonb)
               ELSE settings.value END,
  description = EXCLUDED.description,
  updated_at = now();

-- Tasks a closed gate holds today and that the list now exempts: open them through the unlock code of 0018 (nothing else of the site is recalculated).
DO $$
DECLARE s uuid;
BEGIN
  FOR s IN
    SELECT DISTINCT ti.site_id FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
    WHERE ti.state = 'locked' AND starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:') AND gate_lock_exempt(td.code)
    ORDER BY ti.site_id
  LOOP
    PERFORM calc_release_gated(s);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q97: the team specialization / scope match table
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE team_scope_match_meta (
  id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  specializations TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE team_scope_match_scopes (
  scope      TEXT    PRIMARY KEY CHECK (char_length(scope) BETWEEN 1 AND 60 AND scope = btrim(scope)),
  exempt     BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE team_scope_match (
  scope          TEXT    NOT NULL REFERENCES team_scope_match_scopes (scope) ON DELETE CASCADE ON UPDATE CASCADE,
  specialization TEXT    NOT NULL CHECK (char_length(specialization) BETWEEN 1 AND 60 AND specialization = btrim(specialization)),
  allowed        BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (scope, specialization)
);
CREATE UNIQUE INDEX team_scope_match_ci_idx ON team_scope_match (scope, lower(specialization));

COMMENT ON TABLE team_scope_match IS 'Q97: may a team of this specialization take a Procurement order of this scope. Written only by admin_save_team_scope_match.';

INSERT INTO team_scope_match_meta (id, specializations, version) VALUES (true, ARRAY['CW', 'TE'], 1) ON CONFLICT (id) DO NOTHING;

INSERT INTO team_scope_match_scopes (scope, exempt, sort_order) VALUES
  ('CW', false, 10), ('Tower Erection', false, 20), ('Site Adaption', false, 30), ('TE Installation', false, 40),
  ('CW Dismantle', false, 50), ('TE Dismantle', false, 60), ('STA', false, 70), ('ST', false, 80), ('GECOL', false, 90), ('HLC', true, 100)
ON CONFLICT (scope) DO NOTHING;

INSERT INTO team_scope_match (scope, specialization, allowed)
SELECT s.scope, sp.spec,
       CASE WHEN s.scope IN ('CW', 'Tower Erection', 'Site Adaption', 'CW Dismantle', 'GECOL') THEN sp.spec = 'CW'
            WHEN s.scope = 'TE Installation' THEN sp.spec = 'TE'
            WHEN s.scope = 'TE Dismantle' THEN true
            ELSE false END
FROM team_scope_match_scopes s CROSS JOIN (VALUES ('CW'), ('TE')) AS sp(spec)
WHERE NOT s.exempt
ON CONFLICT (scope, specialization) DO NOTHING;

-- The whole table as the API returns it (GetTeamScopeMatch): columns, then the rows in order with the allowed specializations of each.
CREATE OR REPLACE FUNCTION team_scope_match_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'specializations', to_jsonb(m.specializations),
    'scopes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'scope', s.scope, 'exempt', s.exempt,
               'allowed', coalesce((SELECT jsonb_agg(c.specialization ORDER BY array_position(m.specializations, c.specialization), c.specialization COLLATE "C")
                                    FROM public.team_scope_match c WHERE c.scope = s.scope AND c.allowed), '[]'::jsonb))
             ORDER BY s.sort_order, s.scope COLLATE "C")
      FROM public.team_scope_match_scopes s), '[]'::jsonb),
    'version', m.version, 'updated_at', m.updated_at, 'updated_by', m.updated_by)
  FROM public.team_scope_match_meta m WHERE m.id
$$;

-- The writer. p_config = {specializations: [text], scopes: [{scope, exempt, allowed: [text]}]}; the whole table is replaced (the rows are configuration,
-- nothing references them). Field-level errors as every settings save (unknown keys, blanks, duplicates, an allowed value that is not a column).
CREATE OR REPLACE FUNCTION admin_save_team_scope_match(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m public.team_scope_match_meta%ROWTYPE; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; k text; el jsonb; a jsonb; i integer; j integer;
  specs text[] := ARRAY[]::text[]; sp text; seen_scopes text[] := ARRAY[]::text[]; sc text;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO m FROM public.team_scope_match_meta WHERE id FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> m.version THEN PERFORM public.wf_err('precondition_failed'); END IF;

  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with specializations and scopes.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('specializations', 'scopes') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'specializations') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/specializations', 'required', 'The list of specializations is required.');
  ELSIF jsonb_array_length(p_config -> 'specializations') > 30 THEN
    errs := errs || public.reg_err_item('/specializations', 'too_many', 'At most 30 specializations.');
  ELSE
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'specializations') LOOP
      IF jsonb_typeof(el) <> 'string' OR char_length(btrim(el #>> '{}')) NOT BETWEEN 1 AND 60 THEN
        errs := errs || public.reg_err_item('/specializations/' || i, 'invalid', 'A specialization is a text of 1 to 60 characters.');
      ELSIF lower(btrim(el #>> '{}')) = ANY (SELECT lower(x) FROM unnest(specs) x) THEN
        errs := errs || public.reg_err_item('/specializations/' || i, 'duplicate', 'This specialization is listed twice.');
      ELSE specs := specs || btrim(el #>> '{}'); END IF;
      i := i + 1;
    END LOOP;
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
          IF k NOT IN ('scope', 'exempt', 'allowed') THEN errs := errs || public.reg_err_item('/scopes/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
        END LOOP;
        sc := btrim(coalesce(el ->> 'scope', ''));
        IF jsonb_typeof(el -> 'scope') IS DISTINCT FROM 'string' OR char_length(sc) NOT BETWEEN 1 AND 60 THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/scope', 'invalid', 'A scope is a text of 1 to 60 characters.');
        ELSIF sc = ANY (seen_scopes) THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/scope', 'duplicate', 'This scope is listed twice.');
        ELSE seen_scopes := seen_scopes || sc; END IF;
        IF el ? 'exempt' AND jsonb_typeof(el -> 'exempt') <> 'boolean' THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/exempt', 'invalid', 'true or false.');
        END IF;
        IF jsonb_typeof(el -> 'allowed') IS DISTINCT FROM 'array' THEN
          errs := errs || public.reg_err_item('/scopes/' || i || '/allowed', 'required', 'The allowed specializations are required (an empty list allows none).');
        ELSE
          j := 0;
          FOR a IN SELECT * FROM jsonb_array_elements(el -> 'allowed') LOOP
            IF jsonb_typeof(a) <> 'string' OR NOT (lower(btrim(a #>> '{}')) = ANY (SELECT lower(x) FROM unnest(specs) x)) THEN
              errs := errs || public.reg_err_item('/scopes/' || i || '/allowed/' || j, 'unknown_specialization', 'Not one of the listed specializations.');
            END IF;
            j := j + 1;
          END LOOP;
        END IF;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.team_scope_match_json();
  DELETE FROM public.team_scope_match_scopes;   -- the cells go with their scope (ON DELETE CASCADE)
  i := 0;
  FOR el IN SELECT * FROM jsonb_array_elements(p_config -> 'scopes') LOOP
    sc := btrim(el ->> 'scope');
    INSERT INTO public.team_scope_match_scopes (scope, exempt, sort_order) VALUES (sc, coalesce((el ->> 'exempt')::boolean, false), (i + 1) * 10);
    FOREACH sp IN ARRAY specs LOOP
      INSERT INTO public.team_scope_match (scope, specialization, allowed)
      VALUES (sc, sp, EXISTS (SELECT 1 FROM jsonb_array_elements_text(el -> 'allowed') x WHERE lower(btrim(x)) = lower(sp)));
    END LOOP;
    i := i + 1;
  END LOOP;
  UPDATE public.team_scope_match_meta SET specializations = specs, version = version + 1, updated_by = public.app_actor(), updated_at = now() WHERE id;
  after := public.team_scope_match_json();
  PERFORM public.calc_audit('team_scope_match_update', 'setting', 'team_scope_match', before - 'updated_at' - 'updated_by', after - 'updated_at' - 'updated_by', p_reason);
  RETURN after;
END $$;

-- The check (Q97). NULL when the team may take the order, otherwise the reason as {code, message}. Read by the trigger below and by tests.
CREATE OR REPLACE FUNCTION team_scope_problem(p_scope text, p_team uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sc public.team_scope_match_scopes%ROWTYPE; tname text; spec text;
BEGIN
  IF p_team IS NULL OR p_scope IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO sc FROM public.team_scope_match_scopes WHERE scope = p_scope;
  IF FOUND AND sc.exempt THEN RETURN NULL; END IF;
  SELECT t.name, nullif(btrim(coalesce(t.specialization, '')), '') INTO tname, spec FROM public.external_teams t WHERE t.id = p_team;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- an unknown team is refused by reg_clean_data (unknown_team)
  IF sc.scope IS NULL THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', spec,
      'message', 'The scope ' || p_scope || ' is not in the team / scope match table (Settings), so no team can take it. Ask the System Admin to add it.');
  END IF;
  IF spec IS NULL THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', NULL,
      'message', 'The team ' || coalesce(tname, '?') || ' has no specialization, so it cannot be matched to the scope ' || p_scope || '. Set it in the Contractors register.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_scope_match c WHERE c.scope = p_scope AND lower(c.specialization) = lower(spec) AND c.allowed) THEN
    RETURN jsonb_build_object('scope', p_scope, 'specialization', spec,
      'message', 'A ' || spec || ' team (' || coalesce(tname, '?') || ') cannot take a ' || p_scope || ' order (Settings, team / scope match).');
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION reg_team_scope_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p jsonb; team uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'entry' THEN RETURN NEW; END IF;
  ELSIF NOT ((NEW.state = 'entry' AND NEW.data IS DISTINCT FROM OLD.data) OR (OLD.state = 'entry' AND NEW.state NOT IN ('entry', 'voided'))) THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW.data ? 'team_id') OR coalesce(NEW.data ->> 'team_id', '') !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;
  team := (NEW.data ->> 'team_id')::uuid;
  p := public.team_scope_problem(NEW.data ->> 'scope', team);
  IF p IS NOT NULL THEN
    PERFORM public.wf_err('team_scope_mismatch', jsonb_build_object('detail', p ->> 'message', 'scope', p -> 'scope', 'specialization', p -> 'specialization',
      'errors', public.reg_err_item('/data/team_id', 'team_scope_mismatch', p ->> 'message')));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER b_team_scope_check BEFORE INSERT OR UPDATE ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'procurement') EXECUTE FUNCTION reg_team_scope_check();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Ownership and rights. pmis_app reads the three tables and calls the reader and the writer; it never writes the tables.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON team_scope_match_meta, team_scope_match_scopes, team_scope_match TO pmis_definer;
GRANT SELECT ON external_teams, settings TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['team_scope_match_json()', 'admin_save_team_scope_match(jsonb,text,integer)', 'team_scope_problem(text,uuid)', 'reg_team_scope_check()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON team_scope_match_meta, team_scope_match_scopes, team_scope_match TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON team_scope_match_meta, team_scope_match_scopes, team_scope_match FROM pmis_app;
    GRANT EXECUTE ON FUNCTION team_scope_match_json() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_save_team_scope_match(jsonb,text,integer) TO pmis_app;
  END IF;
END $$;
