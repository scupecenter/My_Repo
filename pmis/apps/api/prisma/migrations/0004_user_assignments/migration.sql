-- 003: role assignments. Integrity plus the single resolver the API uses to fill app.region_ids.

-- Exactly one of role_id / sub_role_id.
ALTER TABLE user_role_assignments ADD CONSTRAINT user_role_assignments_one_target
  CHECK ((role_id IS NOT NULL) <> (sub_role_id IS NOT NULL));
ALTER TABLE user_role_assignments ADD CONSTRAINT user_role_assignments_valid_range
  CHECK (valid_to IS NULL OR valid_to > valid_from);
-- At most one primary assignment per user; no duplicate assignment of the same role/sub-role starting at the same time.
CREATE UNIQUE INDEX user_role_assignments_one_primary ON user_role_assignments (user_id) WHERE is_primary;
CREATE UNIQUE INDEX user_role_assignments_no_dup ON user_role_assignments (user_id, coalesce(role_id, sub_role_id), valid_from);

-- Scope is an explicit opt-in. all_regions / all_modules = true grants everything; otherwise only the child rows count.
-- An assignment with the flag false and no rows contributes nothing (fail closed).

-- Region value for the session: the union of the user's active assignments.
--   '*'   if the user is active and any active assignment has all_regions = true
--   '1,3' union of the regions listed on active assignments otherwise
--   ''    if nothing applies (pending_assignment, suspended, expired, no regions): the user sees nothing
-- Usage by the API, once per transaction:  SELECT set_config('app.region_ids', app_resolve_region_ids($1), true);
CREATE OR REPLACE FUNCTION app_resolve_region_ids(p_user uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH act AS (
    SELECT a.id, a.all_regions
    FROM user_role_assignments a
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM act WHERE all_regions) THEN '*'
    ELSE coalesce((SELECT string_agg(DISTINCT r.region_id::text, ',')
                   FROM user_role_assignment_regions r JOIN act ON act.id = r.assignment_id), '')
  END
$$;

-- Modules: NULL = all modules (explicit all_modules), empty array = none, otherwise the union.
CREATE OR REPLACE FUNCTION app_resolve_modules(p_user uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  WITH act AS (
    SELECT a.id, a.all_modules
    FROM user_role_assignments a
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM act WHERE all_modules) THEN NULL
    ELSE coalesce((SELECT array_agg(DISTINCT m.module_key)
                   FROM user_role_assignment_modules m JOIN act ON act.id = m.assignment_id), ARRAY[]::text[])
  END
$$;

-- Deferred check at commit: an active assignment must have all_regions = true or at least one region row, and likewise
-- for modules. Deferral lets the API insert the assignment and its child rows in one transaction.
CREATE OR REPLACE FUNCTION assignment_scope_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE aid uuid; a user_role_assignments%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'user_role_assignments' THEN aid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN aid := OLD.assignment_id;
  ELSE aid := NEW.assignment_id;
  END IF;
  SELECT * INTO a FROM user_role_assignments WHERE id = aid;
  IF NOT FOUND OR (a.valid_to IS NOT NULL AND a.valid_to <= now()) THEN RETURN NULL; END IF;
  IF NOT a.all_regions AND NOT EXISTS (SELECT 1 FROM user_role_assignment_regions WHERE assignment_id = aid) THEN
    RAISE EXCEPTION 'assignment % needs all_regions = true or at least one region', aid USING ERRCODE = 'check_violation';
  END IF;
  IF NOT a.all_modules AND NOT EXISTS (SELECT 1 FROM user_role_assignment_modules WHERE assignment_id = aid) THEN
    RAISE EXCEPTION 'assignment % needs all_modules = true or at least one module', aid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER user_role_assignments_scope AFTER INSERT OR UPDATE ON user_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_scope_check();
CREATE CONSTRAINT TRIGGER user_role_assignment_regions_scope AFTER DELETE OR UPDATE ON user_role_assignment_regions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_scope_check();
CREATE CONSTRAINT TRIGGER user_role_assignment_modules_scope AFTER DELETE OR UPDATE ON user_role_assignment_modules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assignment_scope_check();
