-- 0142_staff_registry_api: the staff registry in the database and the four routes the web calls (owner request 2026-10-25, settles B13; CHANGELOG 192;
-- contract 0.15.56). Mirror: db/sql/141_staff_registry_api.sql (kept byte-identical).
--
-- WHAT THIS ADDS. Until now the registry lived only in the contract and the web mocks: no table, no function (open question Q155). This migration adds
--   1. staff_registry: one row per Aljeel employee (employee ID of 4 digits, name EN/AR, email, phone, position, team, main role, home region, status, notes,
--      the fields hidden for this one employee, version). Never hard-deleted (a trigger refuses DELETE and TRUNCATE); unique employee ID, email (case-blind)
--      and phone. The home region is for display only: it does not limit who sees the row (spec staff-registry section 1), so the table has no region RLS.
--   2. The field-visibility settings of email and phone: staff_registry_visibility_state (one row: version, who, when), staff_registry_visibility_fields
--      (default_visible per field, true by default = every signed-in employee sees it) and staff_registry_visibility_entries (roles, groups or persons who see
--      a field when the default is off, and who never see it; deny wins).
--   3. No seed: the registry starts empty (Q611). The synthetic draft db/seed/staff-registry.draft.csv is loaded only by the tests, never by a migration.
--   4. The doors (SECURITY DEFINER, owner pmis_definer, search_path pg_catalog, public, pg_temp, PUBLIC revoked):
--        people_staff_can_admin()                                   who may administer the registry (API entry: asked before the step-up)
--        people_staff_card(text)                                    GET /staff-registry/{employee_id}: the hover card, visibility applied here
--        people_staff_visibility_get()                              GET /staff-registry/visibility
--        people_save_staff_visibility(jsonb, text, integer)         PUT /staff-registry/visibility (reason, step-up, If-Match, audited)
--        people_save_staff(text, jsonb, text, integer)              PATCH /staff-registry/{employee_id} (reason, step-up, If-Match, audited)
--      and the internal helpers people_staff_json, people_staff_assignee_json, people_staff_visibility_json, people_staff_matches, people_staff_sees,
--      people_staff_on_behalf and the guard people_staff_no_delete (nothing granted to pmis_app).
--
-- WHO. Administering the registry (its visibility settings and its rows) is a configuration write (CLAUDE.md "Delegation covers anything"): the System Admin,
-- or a holder of `users.edit` for all regions, as the grid says (app_has_permission) and held for all regions (app_can), since the registry is not region data
-- (Q610: the same right as the other people data; a dedicated right can be added later). Reading a card is open to every signed-in employee.
--
-- VISIBILITY (CLAUDE.md "Staff registry"). For the viewer V and a field F (email, phone) of the employee E: a registry administrator sees everything (they read
-- the full rows anyway); otherwise F is hidden when E hides it for himself (hidden_fields), or when V matches a deny entry of F (as the person, through an active
-- role assignment, or as a member of an active group); otherwise F is shown when its default is on, or when V matches an allow entry. A hidden field is never
-- sent: the card carries null and names it in hidden_fields. Card reads are not audited (spec section 6); no phone or email ever goes to the System Log.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE staff_registry (
  employee_id   text PRIMARY KEY CONSTRAINT staff_registry_employee_id_check CHECK (employee_id ~ '^[0-9]{4}$'),
  name_en       text NOT NULL CONSTRAINT staff_registry_name_en_check CHECK (char_length(btrim(name_en)) BETWEEN 2 AND 200),
  name_ar       text NOT NULL CONSTRAINT staff_registry_name_ar_check CHECK (char_length(btrim(name_ar)) BETWEEN 2 AND 200),
  email         text NOT NULL CONSTRAINT staff_registry_email_check CHECK (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone         text NOT NULL CONSTRAINT staff_registry_phone_check CHECK (phone ~ '^\+218 9[0-9] [0-9]{3} [0-9]{4}$'),
  position      text NOT NULL CONSTRAINT staff_registry_position_check CHECK (char_length(btrim(position)) BETWEEN 1 AND 200),
  team          text NOT NULL DEFAULT 'none' CONSTRAINT staff_registry_team_check CHECK (team IN ('cw', 'te', 'both', 'none')),
  main_role     text CONSTRAINT staff_registry_main_role_check CHECK (main_role IS NULL OR char_length(main_role) <= 200),
  region        text NOT NULL CONSTRAINT staff_registry_region_check CHECK (region IN ('Tripoli', 'Middle', 'WM', 'Zawia', 'Benghazi', 'GM', 'Sebha', 'All')),
  status        text NOT NULL DEFAULT 'active' CONSTRAINT staff_registry_status_check CHECK (status IN ('active', 'inactive')),
  notes         text CONSTRAINT staff_registry_notes_check CHECK (notes IS NULL OR char_length(notes) <= 2000),
  hidden_fields text[] NOT NULL DEFAULT '{}' CONSTRAINT staff_registry_hidden_fields_check CHECK (hidden_fields <@ ARRAY['email', 'phone']::text[]),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX staff_registry_email_key ON staff_registry (lower(email));
CREATE UNIQUE INDEX staff_registry_phone_key ON staff_registry (phone);

COMMENT ON TABLE staff_registry IS '0142 (B13): the Aljeel staff registry. Written only through people_save_staff (System Admin or an all-regions users.edit holder, reason, step-up, If-Match, audited); read only through people_staff_card (visibility applied) and the admin doors. Never hard-deleted.';
COMMENT ON COLUMN staff_registry.region IS '0142: the home region, for display only; it never limits who sees the row (assignments do, B3).';
COMMENT ON COLUMN staff_registry.hidden_fields IS '0142: email and/or phone hidden for this one employee from everyone except the registry administrators.';
COMMENT ON COLUMN staff_registry.version IS '0142: the ETag of the row (If-Match); every change bumps it.';

CREATE TABLE staff_registry_visibility_state (
  id         boolean PRIMARY KEY DEFAULT true CONSTRAINT staff_registry_visibility_state_one CHECK (id),
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id) ON DELETE RESTRICT
);
CREATE TABLE staff_registry_visibility_fields (
  field           text PRIMARY KEY CONSTRAINT staff_registry_visibility_fields_field_check CHECK (field IN ('email', 'phone')),
  default_visible boolean NOT NULL DEFAULT true
);
CREATE TABLE staff_registry_visibility_entries (
  field  text NOT NULL REFERENCES staff_registry_visibility_fields (field) ON DELETE RESTRICT,
  mode   text NOT NULL CONSTRAINT staff_registry_visibility_entries_mode_check CHECK (mode IN ('allow', 'deny')),
  kind   text NOT NULL CONSTRAINT staff_registry_visibility_entries_kind_check CHECK (kind IN ('user', 'role', 'group')),
  ref_id uuid NOT NULL,
  ord    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (field, mode, kind, ref_id)
);
COMMENT ON TABLE staff_registry_visibility_fields IS '0142: who sees email and phone on the registry card. default_visible true (the default) = every signed-in employee. Written only through people_save_staff_visibility.';
COMMENT ON TABLE staff_registry_visibility_entries IS '0142: per field, the roles, groups or persons who see it when the default is off (allow) and who never see it (deny wins). Written only through people_save_staff_visibility.';

INSERT INTO staff_registry_visibility_state (id) VALUES (true);
INSERT INTO staff_registry_visibility_fields (field, default_visible) VALUES ('email', true), ('phone', true);

-- Never hard-deleted (spec section 2): rows are deactivated. The guard runs as its writer, so it refuses everyone, the definer included.
CREATE OR REPLACE FUNCTION people_staff_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'staff registry rows are never deleted: deactivate the row instead' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER staff_registry_no_delete BEFORE DELETE ON staff_registry FOR EACH ROW EXECUTE FUNCTION people_staff_no_delete();
CREATE TRIGGER staff_registry_no_truncate BEFORE TRUNCATE ON staff_registry FOR EACH STATEMENT EXECUTE FUNCTION people_staff_no_delete();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. No seed (Q611, decided 2026-11-23): the registry starts empty. The production server already holds real accounts, so the synthetic draft
--    (db/seed/staff-registry.draft.csv) is never loaded by a migration; the tests load it themselves, and the owner fills the registry through the screens and
--    the import.
-- ---------------------------------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Rights of the definer role
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON staff_registry TO pmis_definer;
GRANT SELECT, UPDATE ON staff_registry_visibility_state TO pmis_definer;
GRANT SELECT, UPDATE ON staff_registry_visibility_fields TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON staff_registry_visibility_entries TO pmis_definer;
GRANT SELECT ON users, roles, groups, group_members, user_role_assignments, delegations TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Helpers (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- The caller may administer the registry: the System Admin, or `users.edit` as the permission grid resolves it (assignments, delegations) AND held for all
-- regions (app_can: configuration is not region data, so a Tripoli-only delegate cannot). Asked by the API before the step-up, so a plain user gets 403.
CREATE OR REPLACE FUNCTION people_staff_can_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.app_actor() IS NOT NULL
     AND (public.app_actor_is_system_admin()
          OR (public.app_has_permission(public.app_actor(), 'users', 'edit') AND public.app_can('users', 'edit')))
$$;

-- "X on behalf of System Admin": the admin who delegated, for a delegate; NULL for a System Admin or a holder through a profile.
CREATE OR REPLACE FUNCTION people_staff_on_behalf() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN public.app_actor_is_system_admin() THEN NULL
              ELSE coalesce(public.app_ctx_on_behalf_user(),
                            (SELECT d.from_user_id FROM public.app_user_delegations(public.app_actor()) x(id) JOIN public.delegations d ON d.id = x.id
                             WHERE public.deleg_covers(d.id, 'users', 'edit') AND d.all_regions ORDER BY d.created_at LIMIT 1)) END
$$;

-- The full row (StaffMember): only for the registry administrators.
CREATE OR REPLACE FUNCTION people_staff_json(p_employee_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
      'employee_id', s.employee_id, 'name_en', s.name_en, 'name_ar', s.name_ar, 'email', s.email, 'phone', s.phone, 'position', s.position,
      'team', s.team, 'region', s.region, 'status', s.status, 'hidden_fields', to_jsonb(s.hidden_fields), 'version', s.version,
      'updated_at', s.updated_at,
      'updated_by', CASE WHEN ub.id IS NOT NULL THEN jsonb_build_object('id', ub.id, 'display_name', ub.display_name, 'employee_id', nullif(btrim(ub.employee_id), '')) END))
    || jsonb_build_object('main_role', s.main_role, 'notes', s.notes,
      'linked_user', (SELECT jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', u.employee_id)
                      FROM public.users u WHERE u.employee_id = s.employee_id AND u.purged_at IS NULL ORDER BY u.deleted_at NULLS FIRST LIMIT 1))
  FROM public.staff_registry s LEFT JOIN public.users ub ON ub.id = s.updated_by
  WHERE s.employee_id = p_employee_id
$$;

-- One entry of an allow or deny list, as MatrixAssignee (label and the person's data read from the source, never from the request).
CREATE OR REPLACE FUNCTION people_staff_assignee_json(p_kind text, p_ref uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'user' THEN (SELECT jsonb_build_object('kind', 'user', 'ref_id', p_ref, 'user_id', p_ref,
                        'label', coalesce(u.display_name, 'Unknown person'), 'employee_id', nullif(btrim(u.employee_id), ''),
                        'account_status', CASE WHEN u.id IS NULL OR u.deleted_at IS NOT NULL THEN 'deleted'
                                               WHEN u.status IN ('suspended', 'disabled') THEN 'deactivated' ELSE 'active' END)
                      FROM (SELECT p_ref AS id) k LEFT JOIN public.users u ON u.id = k.id)
    WHEN 'role' THEN (SELECT jsonb_build_object('kind', 'role', 'ref_id', p_ref, 'label', coalesce(r.name_en, 'Unknown role'), 'employee_id', NULL)
                      FROM (SELECT p_ref AS id) k LEFT JOIN public.roles r ON r.id = k.id)
    ELSE (SELECT jsonb_build_object('kind', 'group', 'ref_id', p_ref, 'label', coalesce(g.name, 'Unknown group'), 'employee_id', NULL)
          FROM (SELECT p_ref AS id) k LEFT JOIN public.groups g ON g.id = k.id)
  END
$$;

-- StaffVisibility: the two fields, their lists, the version and who changed them last.
CREATE OR REPLACE FUNCTION people_staff_visibility_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'fields', (SELECT jsonb_object_agg(f.field, jsonb_build_object(
                 'default_visible', f.default_visible,
                 'allow', coalesce((SELECT jsonb_agg(public.people_staff_assignee_json(e.kind, e.ref_id) ORDER BY e.ord, e.kind, e.ref_id)
                                    FROM public.staff_registry_visibility_entries e WHERE e.field = f.field AND e.mode = 'allow'), '[]'::jsonb),
                 'deny', coalesce((SELECT jsonb_agg(public.people_staff_assignee_json(e.kind, e.ref_id) ORDER BY e.ord, e.kind, e.ref_id)
                                   FROM public.staff_registry_visibility_entries e WHERE e.field = f.field AND e.mode = 'deny'), '[]'::jsonb)))
               FROM public.staff_registry_visibility_fields f),
    'version', st.version, 'updated_at', st.updated_at)
    || CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('updated_by', jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', nullif(btrim(u.employee_id), '')))
            ELSE '{}'::jsonb END
  FROM public.staff_registry_visibility_state st LEFT JOIN public.users u ON u.id = st.updated_by
$$;

-- The viewer matches an entry of the field's allow or deny list: as the person, through an active role assignment, or as a member of an active group.
CREATE OR REPLACE FUNCTION people_staff_matches(p_viewer uuid, p_field text, p_mode text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_registry_visibility_entries e
    WHERE e.field = p_field AND e.mode = p_mode AND (
         (e.kind = 'user' AND e.ref_id = p_viewer)
      OR (e.kind = 'role' AND EXISTS (SELECT 1 FROM public.user_role_assignments a
                                      WHERE a.user_id = p_viewer AND a.role_id = e.ref_id AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())))
      OR (e.kind = 'group' AND EXISTS (SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_active
                                       WHERE gm.group_id = e.ref_id AND gm.user_id = p_viewer))))
$$;

-- May the viewer see the field of this row (the rule in the header). p_admin: the viewer administers the registry.
CREATE OR REPLACE FUNCTION people_staff_sees(p_viewer uuid, p_admin boolean, p_field text, p_hidden text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_viewer IS NOT NULL AND (
    coalesce(p_admin, false)
    OR (NOT (p_field = ANY (coalesce(p_hidden, '{}'::text[])))
        AND NOT public.people_staff_matches(p_viewer, p_field, 'deny')
        AND (coalesce((SELECT f.default_visible FROM public.staff_registry_visibility_fields f WHERE f.field = p_field), true)
             OR public.people_staff_matches(p_viewer, p_field, 'allow'))))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The doors
-- ---------------------------------------------------------------------------------------------------------------------
-- GET /staff-registry/{employee_id}: the hover card for any signed-in employee. Hidden fields are null and named; an inactive person is still returned.
CREATE OR REPLACE FUNCTION people_staff_card(p_employee_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); s public.staff_registry%ROWTYPE; adm boolean; see_email boolean; see_phone boolean; hidden text[] := '{}';
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_employee_id IS NULL OR p_employee_id !~ '^[0-9]{4}$' THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This employee ID is not in the staff registry.'));
  END IF;
  SELECT * INTO s FROM public.staff_registry WHERE employee_id = p_employee_id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This employee ID is not in the staff registry.')); END IF;
  adm := public.people_staff_can_admin();
  see_email := public.people_staff_sees(a, adm, 'email', s.hidden_fields);
  see_phone := public.people_staff_sees(a, adm, 'phone', s.hidden_fields);
  IF NOT see_email THEN hidden := hidden || 'email'::text; END IF;
  IF NOT see_phone THEN hidden := hidden || 'phone'::text; END IF;
  RETURN jsonb_build_object('employee_id', s.employee_id, 'name_en', s.name_en, 'name_ar', s.name_ar, 'position', s.position, 'team', s.team,
    'region', s.region, 'status', s.status,
    'email', CASE WHEN see_email THEN to_jsonb(s.email) ELSE 'null'::jsonb END,
    'phone', CASE WHEN see_phone THEN to_jsonb(s.phone) ELSE 'null'::jsonb END,
    'hidden_fields', to_jsonb(hidden), 'version', s.version);
END $$;

-- GET /staff-registry/visibility: the settings, for the registry administrators.
CREATE OR REPLACE FUNCTION people_staff_visibility_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.people_staff_can_admin() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin or an all-regions holder of users.edit sees the registry visibility settings.'));
  END IF;
  RETURN public.people_staff_visibility_json();
END $$;

-- PUT /staff-registry/visibility. p_fields = {email?: {default_visible, allow[], deny[]}, phone?: ...}; each field given replaces that field's settings. An entry
-- is {kind: user|role|group, ref_id}; its label is read from the source. A person must be an account that was never purged, a role or a group must exist.
CREATE OR REPLACE FUNCTION people_save_staff_visibility(p_fields jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE st public.staff_registry_visibility_state%ROWTYPE; before_ jsonb; after_ jsonb; errs jsonb := '[]'::jsonb; f text; fv jsonb; m text; e jsonb;
        i integer; k text; r text; rid uuid; ok boolean;
BEGIN
  IF NOT public.people_staff_can_admin() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin or an all-regions holder of users.edit changes who sees email and phone.'));
  END IF;
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 1000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.'));
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' OR p_fields = '{}'::jsonb THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/fields', 'code', 'required', 'message', 'Give the settings of email, phone or both.'));
  ELSE
    FOR f IN SELECT jsonb_object_keys(p_fields) LOOP
      fv := p_fields -> f;
      IF f NOT IN ('email', 'phone') THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/fields/' || left(f, 40), 'code', 'unknown_field', 'message', 'Only email and phone follow visibility settings.'));
        CONTINUE;
      END IF;
      IF jsonb_typeof(fv) <> 'object' OR jsonb_typeof(fv -> 'default_visible') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(fv -> 'allow') IS DISTINCT FROM 'array' OR jsonb_typeof(fv -> 'deny') IS DISTINCT FROM 'array' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/fields/' || f, 'code', 'invalid', 'message', 'Give default_visible, allow and deny.'));
        CONTINUE;
      END IF;
      FOREACH m IN ARRAY ARRAY['allow', 'deny'] LOOP
        IF jsonb_array_length(fv -> m) > 500 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/fields/' || f || '/' || m, 'code', 'too_big', 'message', 'At most 500 entries.'));
          CONTINUE;
        END IF;
        i := 0;
        FOR e IN SELECT x FROM jsonb_array_elements(fv -> m) x LOOP
          k := e ->> 'kind'; r := e ->> 'ref_id'; ok := false;
          IF k IN ('user', 'role', 'group') AND r ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            rid := r::uuid;
            ok := CASE k WHEN 'user' THEN EXISTS (SELECT 1 FROM public.users u WHERE u.id = rid AND u.purged_at IS NULL)
                         WHEN 'role' THEN EXISTS (SELECT 1 FROM public.roles x WHERE x.id = rid)
                         ELSE EXISTS (SELECT 1 FROM public.groups x WHERE x.id = rid) END;
          END IF;
          IF NOT ok THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/fields/' || f || '/' || m || '/' || i, 'code', 'invalid',
              'message', 'Name an existing person, role or group (kind and ref_id).'));
          END IF;
          i := i + 1;
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT * INTO st FROM public.staff_registry_visibility_state WHERE id FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> st.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The visibility settings changed since you read them. Reload and try again.'));
  END IF;
  before_ := public.people_staff_visibility_json() -> 'fields';
  FOR f IN SELECT jsonb_object_keys(p_fields) LOOP
    fv := p_fields -> f;
    UPDATE public.staff_registry_visibility_fields SET default_visible = (fv ->> 'default_visible')::boolean WHERE field = f;
    DELETE FROM public.staff_registry_visibility_entries WHERE field = f;
    FOREACH m IN ARRAY ARRAY['allow', 'deny'] LOOP
      INSERT INTO public.staff_registry_visibility_entries (field, mode, kind, ref_id, ord)
      SELECT f, m, x.value ->> 'kind', (x.value ->> 'ref_id')::uuid, min(x.ordinality)::int
      FROM jsonb_array_elements(fv -> m) WITH ORDINALITY x
      GROUP BY x.value ->> 'kind', (x.value ->> 'ref_id')::uuid;
    END LOOP;
  END LOOP;
  after_ := public.people_staff_visibility_json() -> 'fields';
  IF after_ IS DISTINCT FROM before_ THEN
    UPDATE public.staff_registry_visibility_state SET version = version + 1, updated_at = clock_timestamp(), updated_by = public.app_actor() WHERE id;
    PERFORM public.log_audit_write('staff_registry.visibility_changed', 'staff_registry_visibility', 'email_phone', before_, after_, btrim(p_reason),
      NULL, NULL, public.people_staff_on_behalf(), false);
  END IF;
  RETURN public.people_staff_visibility_json();
END $$;

-- PATCH /staff-registry/{employee_id}: edit a row, or hide email or phone for this one employee (hidden_fields). The employee ID never changes here.
-- Allowed keys: name_en, name_ar, email, phone, position, team, main_role, region, notes, hidden_fields. Uniqueness of email (case-blind) and phone is checked
-- here, without echoing any value. One audit row with the full row before and after (as every other audited change); nothing goes to the System Log.
CREATE OR REPLACE FUNCTION people_save_staff(p_employee_id text, p_patch jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.staff_registry%ROWTYPE; n public.staff_registry%ROWTYPE; errs jsonb := '[]'::jsonb; k text; v jsonb; before_ jsonb; after_ jsonb; hf text[];
BEGIN
  IF NOT public.people_staff_can_admin() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin or an all-regions holder of users.edit edits the staff registry.'));
  END IF;
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p_employee_id IS NULL OR p_employee_id !~ '^[0-9]{4}$' THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This employee ID is not in the staff registry.'));
  END IF;
  SELECT * INTO s FROM public.staff_registry WHERE employee_id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This employee ID is not in the staff registry.')); END IF;

  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 1000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.'));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/', 'code', 'required', 'message', 'Give at least one field to change.'));
    p_patch := '{}'::jsonb;
  END IF;
  n := s;
  FOR k, v IN SELECT * FROM jsonb_each(p_patch) LOOP
    CASE k
      WHEN 'employee_id' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/employee_id', 'code', 'read_only', 'message', 'The employee ID cannot change: deactivate the row and add a new one.'));
      WHEN 'name_en', 'name_ar', 'position' THEN
        IF jsonb_typeof(v) <> 'string' OR char_length(btrim(v #>> '{}')) NOT BETWEEN (k = 'position')::int * -1 + 2 AND 200 THEN   -- position 1, names 2
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'invalid', 'message',
            CASE WHEN k = 'position' THEN 'A position of 1 to 200 characters.' ELSE 'A name of 2 to 200 characters.' END));
        ELSIF k = 'name_en' THEN n.name_en := btrim(v #>> '{}');
        ELSIF k = 'name_ar' THEN n.name_ar := btrim(v #>> '{}');
        ELSE n.position := btrim(v #>> '{}');
        END IF;
      WHEN 'email' THEN
        IF jsonb_typeof(v) <> 'string' OR char_length(btrim(v #>> '{}')) > 254 OR btrim(v #>> '{}') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/email', 'code', 'invalid', 'message', 'A valid email address.'));
        ELSE n.email := btrim(v #>> '{}');
        END IF;
      WHEN 'phone' THEN
        IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^\+218 9[0-9] [0-9]{3} [0-9]{4}$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/phone', 'code', 'invalid', 'message', 'The registry format is +218 9X XXX XXXX.'));
        ELSE n.phone := v #>> '{}';
        END IF;
      WHEN 'team' THEN
        IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('cw', 'te', 'both', 'none') THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/team', 'code', 'invalid', 'message', 'One of cw, te, both, none.'));
        ELSE n.team := v #>> '{}';
        END IF;
      WHEN 'region' THEN
        IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('Tripoli', 'Middle', 'WM', 'Zawia', 'Benghazi', 'GM', 'Sebha', 'All') THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/region', 'code', 'invalid', 'message', 'One of the 7 regions, or All.'));
        ELSE n.region := v #>> '{}';
        END IF;
      WHEN 'main_role', 'notes' THEN
        IF jsonb_typeof(v) = 'null' THEN
          IF k = 'main_role' THEN n.main_role := NULL; ELSE n.notes := NULL; END IF;
        ELSIF jsonb_typeof(v) <> 'string' OR char_length(v #>> '{}') > 200 + (k = 'notes')::int * 1800 THEN   -- notes 2000, main role 200
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'invalid', 'message', 'Text, or null.'));
        ELSIF k = 'main_role' THEN n.main_role := nullif(btrim(v #>> '{}'), '');
        ELSE n.notes := nullif(btrim(v #>> '{}'), '');
        END IF;
      WHEN 'hidden_fields' THEN
        IF jsonb_typeof(v) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) x WHERE jsonb_typeof(x) <> 'string' OR x #>> '{}' NOT IN ('email', 'phone')) THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/hidden_fields', 'code', 'invalid', 'message', 'A list of email and phone.'));
        ELSE
          SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO hf FROM jsonb_array_elements_text(v) x;
          n.hidden_fields := hf;
        END IF;
      ELSE
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || left(k, 60), 'code', 'unknown_field', 'message', 'This field does not exist or cannot be changed here.'));
    END CASE;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_version IS NOT NULL AND p_version <> s.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The registry row changed since you read it. Reload and try again.'));
  END IF;
  IF lower(n.email) <> lower(s.email) AND EXISTS (SELECT 1 FROM public.staff_registry o WHERE lower(o.email) = lower(n.email) AND o.employee_id <> s.employee_id) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'Another registry row has this email.'));
  END IF;
  IF n.phone <> s.phone AND EXISTS (SELECT 1 FROM public.staff_registry o WHERE o.phone = n.phone AND o.employee_id <> s.employee_id) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'Another registry row has this phone.'));
  END IF;
  IF (n.name_en, n.name_ar, n.email, n.phone, n.position, n.team, n.main_role, n.region, n.notes, n.hidden_fields)
     IS NOT DISTINCT FROM (s.name_en, s.name_ar, s.email, s.phone, s.position, s.team, s.main_role, s.region, s.notes, s.hidden_fields) THEN
    RETURN public.people_staff_json(s.employee_id);   -- nothing changes: no new version, no audit row
  END IF;
  before_ := public.people_staff_json(s.employee_id) - 'linked_user' - 'updated_by' - 'updated_at';
  UPDATE public.staff_registry SET name_en = n.name_en, name_ar = n.name_ar, email = n.email, phone = n.phone, position = n.position, team = n.team,
         main_role = n.main_role, region = n.region, notes = n.notes, hidden_fields = n.hidden_fields,
         version = version + 1, updated_at = clock_timestamp(), updated_by = public.app_actor()
   WHERE employee_id = s.employee_id;
  after_ := public.people_staff_json(s.employee_id) - 'linked_user' - 'updated_by' - 'updated_at';
  PERFORM public.log_audit_write(CASE WHEN n.hidden_fields IS DISTINCT FROM s.hidden_fields
                                       AND (n.name_en, n.name_ar, n.email, n.phone, n.position, n.team, n.main_role, n.region, n.notes)
                                           IS NOT DISTINCT FROM (s.name_en, s.name_ar, s.email, s.phone, s.position, s.team, s.main_role, s.region, s.notes)
                                  THEN 'staff_registry.fields_hidden' ELSE 'staff_registry.updated' END,
    'staff_registry', s.employee_id, before_, after_, btrim(p_reason), NULL, NULL, public.people_staff_on_behalf(), false);
  RETURN public.people_staff_json(s.employee_id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION people_staff_no_delete() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION people_staff_no_delete() FROM PUBLIC;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'people_staff_on_behalf()', 'people_staff_json(text)', 'people_staff_assignee_json(text, uuid)', 'people_staff_visibility_json()',
    'people_staff_matches(uuid, text, text)', 'people_staff_sees(uuid, boolean, text, text[])'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f);
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'people_staff_can_admin()', 'people_staff_card(text)', 'people_staff_visibility_get()',
    'people_save_staff_visibility(jsonb, text, integer)', 'people_save_staff(text, jsonb, text, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
  -- the blanket grant of db/sql/app_grants.sql is narrowed there too; this keeps a database that skips it closed
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON staff_registry, staff_registry_visibility_state, staff_registry_visibility_fields, staff_registry_visibility_entries FROM pmis_app;
  END IF;
END $$;
