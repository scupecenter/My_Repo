-- 006: task-definition protection and versioning, admin "add task to open sites", custom fields, permission grid.
-- Applied after 0001..0006. The fixed (protected) rows are created by the migration/seed role (pmis_migrator, see 002);
-- no session setting bypasses a protection. Session variables used: app.region_ids ('*' = full access) and app.user_id
-- (caller identity for the resolvers and audit rows; it grants no bypass).

-- ---------------------------------------------------------------------------------------------------------------------
-- A. Milestones and phase gates are code-defined: no insert, delete or rename (protected flag + trigger).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stage_definitions_protect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'stages/milestones are fixed and cannot be inserted' USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stages/milestones cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.code, NEW.seq, NEW.name_en, NEW.name_ar, NEW.milestone_name, NEW.is_protected, NEW.is_active)
     IS DISTINCT FROM (OLD.code, OLD.seq, OLD.name_en, OLD.name_ar, OLD.milestone_name, OLD.is_protected, OLD.is_active) THEN
    RAISE EXCEPTION 'stage % is a fixed milestone: it cannot be renamed, reordered or deactivated (approval_levels is editable)', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_definitions_protect BEFORE INSERT OR UPDATE OR DELETE ON stage_definitions FOR EACH ROW EXECUTE FUNCTION stage_definitions_protect();

CREATE OR REPLACE FUNCTION phase_gate_rules_protect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'phase gates are fixed and cannot be inserted' USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'phase gates cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.link_code, NEW.from_milestone, NEW.to_milestone, NEW.is_protected)
     IS DISTINCT FROM (OLD.link_code, OLD.from_milestone, OLD.to_milestone, OLD.is_protected) THEN
    RAISE EXCEPTION 'phase gate % is fixed: only min_wd / max_wd are editable', OLD.link_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_gate_rules_protect BEFORE INSERT OR UPDATE OR DELETE ON phase_gate_rules FOR EACH ROW EXECUTE FUNCTION phase_gate_rules_protect();

-- Task definitions: the admin adds, renames, reorders, re-links and deactivates ordinary tasks inside a fixed stage.
-- code, stage_id and the protected/milestone flags never change; protected (milestone/gate) rows cannot be deleted, renamed or deactivated.
CREATE OR REPLACE FUNCTION task_definitions_protect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_protected OR NEW.is_milestone_task THEN
      RAISE EXCEPTION 'milestone/gate tasks are fixed and cannot be inserted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.is_protected THEN RAISE EXCEPTION 'milestone/gate task % cannot be deleted', OLD.code USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.code, NEW.stage_id, NEW.is_protected, NEW.is_milestone_task) IS DISTINCT FROM (OLD.code, OLD.stage_id, OLD.is_protected, OLD.is_milestone_task) THEN
    RAISE EXCEPTION 'task % : code, stage and milestone flags are immutable', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.is_protected AND (NEW.name_en, NEW.name_ar, NEW.is_active, NEW.counts_toward_milestone)
     IS DISTINCT FROM (OLD.name_en, OLD.name_ar, OLD.is_active, OLD.counts_toward_milestone) THEN
    RAISE EXCEPTION 'milestone/gate task % cannot be renamed or deactivated', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_definitions_protect BEFORE INSERT OR UPDATE OR DELETE ON task_definitions FOR EACH ROW EXECUTE FUNCTION task_definitions_protect();

-- ---------------------------------------------------------------------------------------------------------------------
-- B. Versioning: every real change bumps version/changed_at and must carry a reason and the author.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION config_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version' - 'changed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'changed_at') THEN
    IF NOT app_is_seeding() AND (coalesce(btrim(NEW.reason), '') = '' OR NEW.changed_by IS NULL) THEN
      RAISE EXCEPTION '% change needs a reason and changed_by', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    NEW.version := OLD.version + 1;
    NEW.changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_definitions_touch BEFORE UPDATE ON task_definitions FOR EACH ROW EXECUTE FUNCTION config_touch();
CREATE TRIGGER field_definitions_touch BEFORE UPDATE ON field_definitions FOR EACH ROW EXECUTE FUNCTION config_touch();
CREATE TRIGGER permission_profiles_touch BEFORE UPDATE ON permission_profiles FOR EACH ROW EXECUTE FUNCTION config_touch();

-- ---------------------------------------------------------------------------------------------------------------------
-- C. Predecessors: no self link, no cycles.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_predecessors ADD CONSTRAINT task_predecessors_not_self CHECK (task_def_id <> predecessor_id);

CREATE OR REPLACE FUNCTION task_predecessors_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE r(id) AS (
      SELECT NEW.predecessor_id
      UNION
      SELECT p.predecessor_id FROM task_predecessors p JOIN r ON p.task_def_id = r.id
    ) SELECT 1 FROM r WHERE id = NEW.task_def_id) THEN
    RAISE EXCEPTION 'predecessor link would create a cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_predecessors_no_cycle BEFORE INSERT OR UPDATE ON task_predecessors FOR EACH ROW EXECUTE FUNCTION task_predecessors_no_cycle();

-- ---------------------------------------------------------------------------------------------------------------------
-- D. Admin path: add a (new) task to the sites that are open now.
-- SECURITY DEFINER (owner pmis_definer, BYPASSRLS) because it writes task_instances in every region; the caller must hold a
-- '*' session. The API passes the sites the condition_rule says apply (p_sites), or NULL for all open sites. SLA rule,
-- document slots, template and matrix cells come from the existing tables: sla_rule_for() is used here; slots are created
-- lazily from document_type_placements and matrix cells are read from matrix_cells when the task opens.
-- Delegation of this action to non-admins is handled in the API through `delegations`; the database only sees a '*' session.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_add_task_to_open_sites(p_task uuid, p_sites uuid[], p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE td public.task_definitions%ROWTYPE; lv integer; n integer;
BEGIN
  IF NOT public.app_is_full_access() THEN
    RAISE EXCEPTION 'admin path: full-access session required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT * INTO td FROM public.task_definitions WHERE id = p_task AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'task definition not found or inactive'; END IF;
  SELECT coalesce(td.approval_levels, s.approval_levels) INTO lv FROM public.stage_definitions s WHERE s.id = td.stage_id;

  WITH ins AS (
    INSERT INTO public.task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
    SELECT s.id, s.region_id, td.id, 'locked', lv,
           public.sla_rule_for(td.id, s.delivery_scenario, s.region_id, current_date), now()
    FROM public.sites s
    WHERE s.is_active AND s.overall_status IN ('not_started', 'in_progress', 'on_hold')
      AND (p_sites IS NULL OR s.id = ANY (p_sites))
      AND NOT EXISTS (SELECT 1 FROM public.task_instances t WHERE t.site_id = s.id AND t.task_def_id = td.id)
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;

  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
  VALUES ('add_task_to_open_sites', 'task_definition', td.code, p_reason,
          jsonb_build_object('sites_added', n, 'restricted_to', to_jsonb(p_sites)), true,
          nullif(current_setting('app.user_id', true), '')::uuid);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- E. Custom fields: set-version counter, no hard delete once values exist, immutable identity.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION field_table(e "FieldEntityType") RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE e::text
    WHEN 'site' THEN 'sites' WHEN 'task_instance' THEN 'task_instances' WHEN 'rf_design' THEN 'rf_design_records'
    WHEN 'acquisition' THEN 'acquisition_candidates' WHEN 'procurement' THEN 'procurement_records'
    WHEN 'gecol' THEN 'gecol_records' WHEN 'hlc' THEN 'hlc_records' WHEN 'permit' THEN 'permit_records'
    WHEN 'warehouse_item' THEN 'warehouse_items' WHEN 'warehouse_serial' THEN 'warehouse_serials'
    WHEN 'quality' THEN 'quality_inspections' WHEN 'issue' THEN 'issues' WHEN 'risk' THEN 'risks'
    WHEN 'change_request' THEN 'change_requests' WHEN 'readiness' THEN 'readiness_handover'
    WHEN 'as_built' THEN 'as_built_records' WHEN 'meeting' THEN 'meetings' WHEN 'external_party' THEN 'external_parties'
  END
$$;

-- Does any row, in ANY region, hold a value for this field? Must see all rows: SECURITY DEFINER, owner pmis_definer.
CREATE OR REPLACE FUNCTION field_has_values(e "FieldEntityType", p_code text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE custom ? $1)', public.field_table(e)) INTO r USING p_code;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION field_definitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF field_has_values(OLD.entity_type, OLD.code) THEN
      RAISE EXCEPTION 'field % holds values: deactivate it instead of deleting', OLD.code USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.entity_type, NEW.code, NEW.data_type, NEW.task_def_id) IS DISTINCT FROM (OLD.entity_type, OLD.code, OLD.data_type, OLD.task_def_id)
     AND field_has_values(OLD.entity_type, OLD.code) THEN
    RAISE EXCEPTION 'field % holds values: entity, code, type and task cannot change', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_definitions_guard BEFORE UPDATE OR DELETE ON field_definitions FOR EACH ROW EXECUTE FUNCTION field_definitions_guard();

CREATE OR REPLACE FUNCTION field_list_values_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE f field_definitions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO f FROM field_definitions WHERE id = OLD.field_id;
    IF FOUND AND field_has_values(f.entity_type, f.code) THEN
      RAISE EXCEPTION 'list option % is on a field that holds values: deactivate it instead', OLD.code USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.field_id IS DISTINCT FROM OLD.field_id OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'list option field and code are immutable (deactivate and add a new option)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_list_values_guard BEFORE UPDATE OR DELETE ON field_list_values FOR EACH ROW EXECUTE FUNCTION field_list_values_guard();

-- Field-set version per entity type (templates record it; older template versions are rejected on upload).
CREATE OR REPLACE FUNCTION field_set_bump() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE e "FieldEntityType";
BEGIN
  IF TG_TABLE_NAME = 'field_definitions' THEN
    e := CASE WHEN TG_OP = 'DELETE' THEN OLD.entity_type ELSE NEW.entity_type END;
  ELSE
    SELECT entity_type INTO e FROM field_definitions WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.field_id ELSE NEW.field_id END;
  END IF;
  IF e IS NOT NULL THEN
    INSERT INTO field_set_versions (entity_type, version, updated_at) VALUES (e, 1, now())
    ON CONFLICT (entity_type) DO UPDATE SET version = field_set_versions.version + 1, updated_at = now();
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER field_definitions_bump AFTER INSERT OR UPDATE OR DELETE ON field_definitions FOR EACH ROW EXECUTE FUNCTION field_set_bump();
CREATE TRIGGER field_list_values_bump AFTER INSERT OR UPDATE OR DELETE ON field_list_values FOR EACH ROW EXECUTE FUNCTION field_set_bump();

ALTER TABLE field_permissions ADD CONSTRAINT field_permissions_one_subject CHECK ((role_id IS NOT NULL) <> (profile_id IS NOT NULL));
CREATE UNIQUE INDEX field_permissions_role_key ON field_permissions (field_id, role_id) WHERE role_id IS NOT NULL;
CREATE UNIQUE INDEX field_permissions_profile_key ON field_permissions (field_id, profile_id) WHERE profile_id IS NOT NULL;
ALTER TABLE field_definitions ADD CONSTRAINT field_definitions_task_scope CHECK (task_def_id IS NULL OR entity_type = 'task_instance');
-- Field codes are unique per entity; a task-scoped code must not clash with a global one (one JSONB key space).
-- (unique (entity_type, code) in the schema already guarantees this.)

-- ---------------------------------------------------------------------------------------------------------------------
-- F. Validation of the `custom` JSONB on every entity table.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION custom_check_value(f field_definitions, v jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE t text := jsonb_typeof(v); s text; n numeric; d date; el jsonb; vmin text := f.validation->>'min'; vmax text := f.validation->>'max';
BEGIN
  CASE f.data_type::text
    WHEN 'text' THEN
      IF t <> 'string' THEN RETURN 'must be text'; END IF;
      s := v #>> '{}';
      IF f.validation ? 'min_length' AND length(s) < (f.validation->>'min_length')::int THEN RETURN 'too short'; END IF;
      IF f.validation ? 'max_length' AND length(s) > (f.validation->>'max_length')::int THEN RETURN 'too long'; END IF;
      IF f.validation ? 'pattern' AND s !~ (f.validation->>'pattern') THEN RETURN 'does not match the pattern'; END IF;
    WHEN 'number' THEN
      IF t <> 'number' THEN RETURN 'must be a number'; END IF;
      n := (v #>> '{}')::numeric;
      IF vmin IS NOT NULL AND n < vmin::numeric THEN RETURN 'below minimum'; END IF;
      IF vmax IS NOT NULL AND n > vmax::numeric THEN RETURN 'above maximum'; END IF;
    WHEN 'date' THEN
      IF t <> 'string' OR (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN 'must be an ISO date (YYYY-MM-DD)'; END IF;
      BEGIN d := (v #>> '{}')::date; EXCEPTION WHEN others THEN RETURN 'not a valid date'; END;
      IF vmin IS NOT NULL AND d < vmin::date THEN RETURN 'before minimum date'; END IF;
      IF vmax IS NOT NULL AND d > vmax::date THEN RETURN 'after maximum date'; END IF;
    WHEN 'bool' THEN
      IF t <> 'boolean' THEN RETURN 'must be true or false'; END IF;
    WHEN 'list' THEN
      IF t <> 'string' OR NOT EXISTS (SELECT 1 FROM field_list_values l WHERE l.field_id = f.id AND l.code = (v #>> '{}') AND l.is_active) THEN
        RETURN 'not an active list option';
      END IF;
    WHEN 'multi_list' THEN
      IF t <> 'array' THEN RETURN 'must be a list of options'; END IF;
      FOR el IN SELECT * FROM jsonb_array_elements(v) LOOP
        IF jsonb_typeof(el) <> 'string' OR NOT EXISTS (SELECT 1 FROM field_list_values l WHERE l.field_id = f.id AND l.code = (el #>> '{}') AND l.is_active) THEN
          RETURN 'contains an option that is not active';
        END IF;
      END LOOP;
    WHEN 'user' THEN
      IF t <> 'string' OR (v #>> '{}') !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = (v #>> '{}')::uuid) THEN RETURN 'unknown user'; END IF;
    WHEN 'external_party' THEN
      IF t <> 'string' OR (v #>> '{}') !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM external_parties p WHERE p.id = (v #>> '{}')::uuid) THEN RETURN 'unknown external party'; END IF;
    WHEN 'file' THEN
      IF t <> 'string' OR length(v #>> '{}') = 0 THEN RETURN 'must be a stored file key'; END IF;
  END CASE;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION custom_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e "FieldEntityType" := TG_ARGV[0]::"FieldEntityType";
  newc jsonb := coalesce(NEW.custom, '{}'::jsonb);
  oldc jsonb := CASE WHEN TG_OP = 'UPDATE' THEN coalesce(OLD.custom, '{}'::jsonb) ELSE '{}'::jsonb END;
  tdef uuid := nullif(to_jsonb(NEW)->>'task_def_id', '')::uuid;
  f field_definitions%ROWTYPE; k text; v jsonb; changed boolean; err text;
BEGIN
  IF jsonb_typeof(newc) <> 'object' THEN
    RAISE EXCEPTION 'custom must be a JSON object' USING ERRCODE = 'check_violation';
  END IF;
  FOR k IN SELECT jsonb_object_keys(newc) LOOP
    IF NOT EXISTS (SELECT 1 FROM field_definitions d WHERE d.entity_type = e AND d.code = k AND (d.task_def_id IS NULL OR d.task_def_id = tdef)) THEN
      RAISE EXCEPTION 'unknown custom field "%" on %', k, TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  FOR f IN SELECT * FROM field_definitions d WHERE d.entity_type = e AND (d.task_def_id IS NULL OR d.task_def_id = tdef) LOOP
    IF TG_OP = 'INSERT' AND f.is_active AND f.default_value IS NOT NULL AND NOT newc ? f.code THEN
      newc := newc || jsonb_build_object(f.code, f.default_value);
    END IF;
    v := newc -> f.code;
    changed := v IS DISTINCT FROM (oldc -> f.code);
    IF NOT f.is_active THEN
      IF changed THEN RAISE EXCEPTION 'field "%" is deactivated: its values are kept but cannot be changed', f.code USING ERRCODE = 'check_violation'; END IF;
      CONTINUE;
    END IF;
    IF (v IS NULL OR v = 'null'::jsonb) THEN
      IF f.required AND (TG_OP = 'INSERT' OR changed) THEN
        RAISE EXCEPTION 'field "%" is required', f.code USING ERRCODE = 'check_violation';
      END IF;
    ELSIF changed THEN
      err := custom_check_value(f, v);
      IF err IS NOT NULL THEN RAISE EXCEPTION 'field "%": %', f.code, err USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END LOOP;
  NEW.custom := newc;
  RETURN NEW;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT e::text AS e, field_table(e) AS t FROM unnest(enum_range(NULL::"FieldEntityType")) e LOOP
    EXECUTE format('CREATE TRIGGER custom_validate BEFORE INSERT OR UPDATE OF custom ON %I FOR EACH ROW EXECUTE FUNCTION custom_validate(%L)', r.t, r.e);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- G. Permission grid resolvers (SECURITY DEFINER, owner pmis_definer). Effective permission = union over the user's ACTIVE
-- assignments (user active, dates current), limited to the modules of each assignment (all_modules or a listed module).
-- Regions are limited separately by app.region_ids (RLS). Callable for oneself (app.user_id) or by a full-access session.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_assert_self_or_admin(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT app_is_full_access() AND coalesce(current_setting('app.user_id', true), '') <> p_user::text THEN
    RAISE EXCEPTION 'permission resolver: only for yourself or from a full-access session' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_resolve_permissions(p_user uuid) RETURNS TABLE (module_key text, action "PermissionAction")
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_assert_self_or_admin(p_user);
  RETURN QUERY
  WITH act AS (
    SELECT a.id, a.all_modules
    FROM public.user_role_assignments a JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
  SELECT DISTINCT g.module_key, g.action
  FROM act
  JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = act.id
  JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
  JOIN public.permission_grants g ON g.profile_id = pp.id
  WHERE act.all_modules
     OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = act.id AND m.module_key = split_part(g.module_key, '.', 1));
END $$;

-- A grant on "sites" covers "sites" and every screen "sites.*".
CREATE OR REPLACE FUNCTION app_has_permission(p_user uuid, p_module text, p_action "PermissionAction") RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_resolve_permissions(p_user) r
                 WHERE r.action = p_action AND (p_module = r.module_key OR p_module LIKE r.module_key || '.%'))
$$;

-- Field access for a user: most permissive of the matching rules (by profile of an active assignment, or by the assignment's
-- role/sub-role's role). NULL = no field rule, so the entity-level permission decides.
CREATE OR REPLACE FUNCTION app_resolve_field_access(p_user uuid, p_field uuid) RETURNS "FieldAccess"
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE best integer;
BEGIN
  PERFORM public.app_assert_self_or_admin(p_user);
  WITH act AS (
    SELECT a.id, coalesce(a.role_id, sr.role_id) AS role_id
    FROM public.user_role_assignments a
    JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
    LEFT JOIN public.sub_roles sr ON sr.id = a.sub_role_id
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
  SELECT max(CASE fp.access::text WHEN 'hidden' THEN 0 WHEN 'read' THEN 1 ELSE 2 END) INTO best
  FROM public.field_permissions fp
  WHERE fp.field_id = p_field
    AND (fp.role_id IN (SELECT role_id FROM act)
         OR fp.profile_id IN (SELECT ap.profile_id FROM act JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = act.id));
  RETURN CASE best WHEN 0 THEN 'hidden' WHEN 1 THEN 'read' WHEN 2 THEN 'edit' ELSE NULL END::"FieldAccess";
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- H. Ownership and grants for the definer functions.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION admin_add_task_to_open_sites(uuid, uuid[], text) OWNER TO pmis_definer;
ALTER FUNCTION field_has_values("FieldEntityType", text) OWNER TO pmis_definer;
ALTER FUNCTION app_resolve_permissions(uuid) OWNER TO pmis_definer;
ALTER FUNCTION app_has_permission(uuid, text, "PermissionAction") OWNER TO pmis_definer;
ALTER FUNCTION app_resolve_field_access(uuid, uuid) OWNER TO pmis_definer;

GRANT SELECT ON users, user_role_assignments, user_role_assignment_modules, user_role_assignment_profiles,
  permission_profiles, permission_grants, field_permissions, sub_roles, stage_definitions, task_definitions, sites TO pmis_definer;
GRANT SELECT ON field_definitions, field_list_values, external_parties, work_calendars, sla_rules TO pmis_definer; -- read by custom_validate / sla_rule_for when the definer inserts tasks
GRANT INSERT ON task_instances, audit_log TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT field_table(e) AS t FROM unnest(enum_range(NULL::"FieldEntityType")) e LOOP
    EXECUTE format('GRANT SELECT ON %I TO pmis_definer', r.t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION admin_add_task_to_open_sites(uuid, uuid[], text), field_has_values("FieldEntityType", text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_add_task_to_open_sites(uuid, uuid[], text), field_has_values("FieldEntityType", text) TO pmis_app;
  END IF;
END $$;
-- app_resolve_permissions / app_has_permission / app_resolve_field_access keep the default PUBLIC execute: they guard themselves.
