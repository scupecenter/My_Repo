-- 0149_daily_plan: My Work > Daily Plan, the daily progress and the plan of the next working day (plan W7, owner decisions 2026-11-23; contract 0.15.67; CHANGELOG 203).
-- Mirror: db/sql/148_daily_plan.sql (kept byte-identical).
--
-- WHAT THIS ADDS. The two tables of the owner's daily Excel sheet (Daily Progress of a day, Tomorrow Plan of the next working day) as one plan per region per day:
--   1. daily_plans: the header of the plan of one region on one day (version = the ETag of every change, the lock, the reminder marker). A header exists only
--      once somebody changed the plan, locked it, or the job locked it or sent its reminder; until then the plan is the auto-filled rows only.
--   2. daily_plan_rows: what people changed in a plan: the manual values of the auto-filled columns (overrides, each change audited with before and after),
--      Reason (if not reach target) and Remark, sites added by hand (origin added) and auto rows removed by hand (removed). When the day is locked every
--      visible row is frozen (frozen = the whole row as it was), so a locked day reads the same whatever happens to the tasks later.
--   3. The auto-filled columns (dp_site_auto), never retyped: from Site Master the Site ID, Tower Owner, Owner ID, Latitude, Longitude, Region, Site Type and
--      SOW (the Delivery Scenario and the scope flags that are yes); from the Procurement assignment of the day (field-work dates covering the day; else the
--      site's latest active order) the Vendor / Contractor name (its external party or team; In-House otherwise) and the AAT SE (the members of role
--      supervisor, else every member); Access Valid from an approved CW permit valid that day (Yes, with its end date), else the CW access permission task B3
--      approved by that day (Yes), else No; Planned Work = the tasks planned that day (planned date or planned start) and the field work scheduled that day;
--      Actual Work = the tasks with an actual date that day and the field work that ended that day. A site is in the plan of its region when it has any of
--      these that day, or was added by hand, and was not removed.
--   4. Below target: on a day up to today, fewer actual items than planned items (one item per line). Such a row needs a Reason: a row save is refused without
--      one (422, /reason required), and so is the lock by L2 (422, errors per site). The automatic lock locks anyway and the rows stay flagged.
--   5. Rights (owner decisions W7 1 and 2): a Responsibility Matrix row "Daily Plan" (register_definitions daily_plan, not a register: enabled = false, so no
--      register API lists it), seeded L1 Site Engineers (CW), Site Engineers (TE), CW Team Lead and TE Team Lead, L2 CW Team Lead and TE Team Lead. L1 of the
--      region (or a System Admin) edits the rows and adds or removes sites; L2 of the region (or a System Admin) locks the day; a locked day is read-only except
--      through an admin override (unlock: System Admin or a delegate of overrides.unlock for the region, reason, step-up, flagged admin override). A person holds
--      the row through the module daily_plan or sites. Reading follows the region scope of the session (the regions the person's assignments cover; the
--      Project Manager and the System Admins see all).
--   6. Settings > My Work > Daily Plan (setting daily_plan.settings, guarded): the visible columns and their order per tab, the default region scope, the time
--      after which today's plan locks automatically (empty = never) and the hour of the reminder to the L1 holders when the next working day's plan is empty
--      (empty = no reminder). admin_set_daily_plan_settings: System Admin or a delegate of admin.settings edit for all regions, reason, If-Match, closed body,
--      audited with before and after.
--   7. dp_tick (the job, every 5 minutes): the automatic lock of today's plans after the set time, and the reminder (once per region and day).
--   8. Saved views: the screen daily-plan reads module daily_plan; a person with the Site Register (sites view) may keep views of it too (sv_screen_module and
--      sv_module_ok redefined from 0138, the lines marked 0149).
--
-- SECURITY. Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked. pmis_app executes the
-- doors only: daily_plan_json, dp_save_row, dp_add_site, dp_remove_site, dp_lock, dp_unlock, dp_export_json, dp_settings_json, admin_set_daily_plan_settings and
-- dp_tick. The two tables have row security forced (read by region) and no right for pmis_app (db/sql/app_grants.sql). Each door takes the actor from
-- app_actor(), checks the region scope and the Matrix level itself, checks the plan version under a row lock and audits every write with before and after.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. Rights of the definer role
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON sites, regions, task_instances, task_definitions, register_records, register_definitions, external_parties, external_teams, users, settings,
  matrix_cells, matrix_cell_assignees, roles, user_role_assignments, user_role_assignment_regions, user_role_assignment_modules, groups, group_members TO pmis_definer;
GRANT INSERT, UPDATE ON settings TO pmis_definer;
GRANT INSERT ON notifications, audit_log TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE daily_plans (
  id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id   integer        NOT NULL REFERENCES regions (id),
  plan_date   date           NOT NULL,
  version     integer        NOT NULL DEFAULT 1 CHECK (version >= 1),
  locked_at   timestamptz(6),
  locked_by   uuid           REFERENCES users (id),
  lock_kind   text           CHECK (lock_kind IS NULL OR lock_kind IN ('manual', 'auto')),
  unlocked_at timestamptz(6),
  unlocked_by uuid           REFERENCES users (id),
  reminded_at timestamptz(6),
  created_by  uuid           REFERENCES users (id),
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_by  uuid           REFERENCES users (id),
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT daily_plans_one_per_region_day UNIQUE (region_id, plan_date),
  CONSTRAINT daily_plans_lock_kind CHECK ((locked_at IS NULL) = (lock_kind IS NULL))
);
CREATE INDEX daily_plans_date_idx ON daily_plans (plan_date);

CREATE TABLE daily_plan_rows (
  id         uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid           NOT NULL REFERENCES daily_plans (id) ON DELETE CASCADE,
  region_id  integer        NOT NULL REFERENCES regions (id),
  site_id    uuid           NOT NULL REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE,
  origin     text           NOT NULL CHECK (origin IN ('auto', 'added')),
  removed    boolean        NOT NULL DEFAULT false,
  overrides  jsonb          NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides) = 'object'),
  reason     text           CHECK (reason IS NULL OR char_length(reason) <= 1000),
  remark     text           CHECK (remark IS NULL OR char_length(remark) <= 1000),
  frozen     jsonb,
  updated_by uuid           REFERENCES users (id),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT daily_plan_rows_one_per_site UNIQUE (plan_id, site_id),
  CONSTRAINT daily_plan_rows_added_not_removed CHECK (NOT (origin = 'added' AND removed))
);
CREATE INDEX daily_plan_rows_site_idx ON daily_plan_rows (site_id);

-- The auto-filled columns read the tasks of a region on one day.
CREATE INDEX IF NOT EXISTS task_instances_region_planned_idx ON task_instances (region_id, planned_date) WHERE planned_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_instances_region_actual_idx ON task_instances (region_id, actual_date) WHERE actual_date IS NOT NULL;

-- Row security: by the region of the plan. pmis_app has no right on either table (also in db/sql/app_grants.sql); everything goes through the doors.
ALTER TABLE daily_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_plan_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_plan_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON daily_plans FOR SELECT USING (public.app_region_check(region_id));
CREATE POLICY rls_select ON daily_plan_rows FOR SELECT USING (public.app_region_check(region_id));
REVOKE ALL ON daily_plans, daily_plan_rows FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON daily_plans, daily_plan_rows TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON daily_plans, daily_plan_rows FROM pmis_app; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The Responsibility Matrix row "Daily Plan" (owner decision W7 2) with its default holders (seed; the admin edits them in the Matrix)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order)
VALUES ('daily_plan', 'Daily Plan', 'الخطة اليومية', 'daily_plan', 'register', true, true, ARRAY[]::text[], 2,
        '{"matrix_only": true, "master_export": false, "l1": "edits the rows", "l2": "locks the day"}'::jsonb, false, 170)
ON CONFLICT (register_key) DO NOTHING;

DO $$
DECLARE cid uuid; v record;
BEGIN
  FOR v IN SELECT * FROM (VALUES (1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE', 'CW_TL', 'TE_TL']), (3, ARRAY['CW_TL', 'TE_TL'])) x(lvl, codes) LOOP
    IF NOT EXISTS (SELECT 1 FROM matrix_cells c WHERE c.register_key = 'daily_plan' AND c.level = v.lvl AND c.region_id IS NULL AND c.task_def_id IS NULL) THEN
      INSERT INTO matrix_cells (stage_id, task_def_id, level, rule, region_id, is_global, register_key, updated_at)
      VALUES (NULL, NULL, v.lvl, 'any_one', NULL, true, 'daily_plan', now()) RETURNING id INTO cid;
      INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', r.id FROM roles r WHERE r.code = ANY (v.codes);
    END IF;
  END LOOP;
  UPDATE matrix_state SET revision = revision + 1, updated_at = now();
END $$;

-- The screen in the side menu (My Work > Daily Plan, owner decision W7): its key in the catalogue that validates a saved menu layout (0081).
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('daily_plan', 'work', 2, '0149')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Settings > My Work > Daily Plan
-- ---------------------------------------------------------------------------------------------------------------------
-- The columns of each tab, in the order of the owner's sheet (the export and the copy for email keep this order whatever the settings say).
CREATE OR REPLACE FUNCTION dp_columns_default(p_tab text) RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_tab
    WHEN 'progress' THEN ARRAY['no', 'site_code', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se',
                               'planned_work', 'actual_work', 'reason']
    WHEN 'tomorrow' THEN ARRAY['no', 'site_code', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se',
                               'access_valid', 'planned_work', 'remark']
  END
$$;

-- Every column a tab may show (the owner's columns plus Site Name, Actual Work, Access Valid, Reason and Remark on either tab).
CREATE OR REPLACE FUNCTION dp_columns_known() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['no', 'site_code', 'site_name', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se',
               'access_valid', 'planned_work', 'actual_work', 'reason', 'remark']
$$;

-- The auto-filled columns a person may change by hand (Site ID and Region identify the row and the plan: never overridden).
CREATE OR REPLACE FUNCTION dp_override_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['tower_owner', 'owner_id', 'latitude', 'longitude', 'site_type', 'sow', 'contractor', 'aat_se', 'access_valid', 'planned_work', 'actual_work']
$$;

-- The settings in force (the stored value over the defaults).
CREATE OR REPLACE FUNCTION dp_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
           'columns', jsonb_build_object('progress', to_jsonb(public.dp_columns_default('progress')), 'tomorrow', to_jsonb(public.dp_columns_default('tomorrow'))),
           'default_region_scope', 'mine', 'auto_lock_time', NULL, 'reminder_hour', NULL, 'version', 0)
         || coalesce((SELECT s.value FROM public.settings s WHERE s.key = 'daily_plan.settings' AND jsonb_typeof(s.value) = 'object'), '{}'::jsonb)
$$;

-- GET /settings/daily-plan: every signed-in user (the screen reads its columns).
CREATE OR REPLACE FUNCTION dp_settings_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'daily plan settings: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'daily_plan.settings';
  RETURN public.dp_cfg()
    || jsonb_build_object('known_columns', to_jsonb(public.dp_columns_known()),
                          'default_columns', jsonb_build_object('progress', to_jsonb(public.dp_columns_default('progress')), 'tomorrow', to_jsonb(public.dp_columns_default('tomorrow'))))
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- PUT /settings/daily-plan. p_body = {columns: {progress, tomorrow}, default_region_scope, auto_lock_time, reminder_hour} (closed); the reason apart;
-- p_version = If-Match (NULL = *).
CREATE OR REPLACE FUNCTION admin_set_daily_plan_settings(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur jsonb; errs jsonb := '[]'::jsonb; k text; tab text; arr jsonb; x jsonb; seen text[]; nv jsonb; res jsonb; tm text; n numeric;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('daily_plan.settings', '{"version": 0}'::jsonb, 'W7 (migration 0149): Settings > My Work > Daily Plan (columns, default region scope, automatic lock, reminder).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'daily_plan.settings' FOR UPDATE;
  cur := public.dp_cfg();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with columns, default_region_scope, auto_lock_time and reminder_hour.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('columns', 'default_region_scope', 'auto_lock_time', 'reminder_hour') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  -- columns: both tabs, each a list of known columns without repeats that holds the Site ID
  IF jsonb_typeof(p_body -> 'columns') IS DISTINCT FROM 'object' THEN
    errs := errs || public.reg_err_item('/columns', 'required', 'The columns of the Progress and Tomorrow tabs are required.');
  ELSE
    FOR k IN SELECT jsonb_object_keys(p_body -> 'columns') LOOP
      IF k NOT IN ('progress', 'tomorrow') THEN errs := errs || public.reg_err_item('/columns/' || k, 'unknown_key', 'Unknown tab.'); END IF;
    END LOOP;
    FOREACH tab IN ARRAY ARRAY['progress', 'tomorrow'] LOOP
      arr := p_body -> 'columns' -> tab;
      IF jsonb_typeof(arr) IS DISTINCT FROM 'array' OR jsonb_array_length(arr) = 0 THEN
        errs := errs || public.reg_err_item('/columns/' || tab, 'required', 'A list of at least one column.');
        CONTINUE;
      END IF;
      seen := ARRAY[]::text[];
      FOR x IN SELECT e FROM jsonb_array_elements(arr) e LOOP
        IF jsonb_typeof(x) <> 'string' OR NOT (x #>> '{}') = ANY (public.dp_columns_known()) THEN
          errs := errs || public.reg_err_item('/columns/' || tab, 'unknown_column', 'Unknown column ' || left(x::text, 60) || '.');
        ELSIF (x #>> '{}') = ANY (seen) THEN
          errs := errs || public.reg_err_item('/columns/' || tab, 'duplicate', 'The column ' || (x #>> '{}') || ' is listed twice.');
        ELSE
          seen := seen || (x #>> '{}');
        END IF;
      END LOOP;
      IF NOT 'site_code' = ANY (seen) THEN errs := errs || public.reg_err_item('/columns/' || tab, 'site_code_required', 'The Site ID column is always shown.'); END IF;
    END LOOP;
  END IF;
  IF jsonb_typeof(p_body -> 'default_region_scope') IS DISTINCT FROM 'string' OR (p_body ->> 'default_region_scope') NOT IN ('mine', 'all') THEN
    errs := errs || public.reg_err_item('/default_region_scope', 'invalid', 'mine (the regions where you hold the Daily Plan) or all (every region you can see).');
  END IF;
  IF NOT (p_body ? 'auto_lock_time') THEN
    errs := errs || public.reg_err_item('/auto_lock_time', 'required', 'A time HH:MM, or null for no automatic lock.');
  ELSIF jsonb_typeof(p_body -> 'auto_lock_time') <> 'null' THEN
    tm := p_body ->> 'auto_lock_time';
    IF jsonb_typeof(p_body -> 'auto_lock_time') <> 'string' OR tm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      errs := errs || public.reg_err_item('/auto_lock_time', 'invalid', 'A time HH:MM (00:00 to 23:59), or null.');
    END IF;
  END IF;
  IF NOT (p_body ? 'reminder_hour') THEN
    errs := errs || public.reg_err_item('/reminder_hour', 'required', 'An hour from 0 to 23, or null for no reminder.');
  ELSIF jsonb_typeof(p_body -> 'reminder_hour') <> 'null' THEN
    IF jsonb_typeof(p_body -> 'reminder_hour') <> 'number' OR (p_body ->> 'reminder_hour')::numeric <> trunc((p_body ->> 'reminder_hour')::numeric) THEN
      errs := errs || public.reg_err_item('/reminder_hour', 'invalid', 'A whole hour.');
    ELSE
      n := (p_body ->> 'reminder_hour')::numeric;
      IF n < 0 OR n > 23 THEN errs := errs || public.reg_err_item('/reminder_hour', 'out_of_range', 'From 0 to 23.'); END IF;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  nv := jsonb_build_object('columns', jsonb_build_object('progress', p_body -> 'columns' -> 'progress', 'tomorrow', p_body -> 'columns' -> 'tomorrow'),
                           'default_region_scope', p_body -> 'default_region_scope', 'auto_lock_time', p_body -> 'auto_lock_time',
                           'reminder_hour', p_body -> 'reminder_hour', 'version', (cur ->> 'version')::integer + 1);
  UPDATE public.settings SET value = nv, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'daily_plan.settings';
  res := public.dp_settings_json();
  PERFORM public.log_audit_write('daily_plan_settings_update', 'setting', 'daily_plan.settings', cur - 'version', nv - 'version', btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Who holds the Daily Plan row, and what a plan holds
-- ---------------------------------------------------------------------------------------------------------------------
-- The holders of L1 (entry) or L2 (approve) of the Daily Plan row in a region: the region cell over the global cell, held through the module daily_plan or sites.
CREATE OR REPLACE FUNCTION dp_holders(p_region integer, p_kind text) RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH cell AS (
    SELECT c.id FROM public.matrix_cells c
    WHERE c.register_key = 'daily_plan' AND c.level = CASE p_kind WHEN 'entry' THEN 1 ELSE 3 END AND c.task_def_id IS NULL AND c.retired_at IS NULL
      AND (c.region_id IS NULL OR c.region_id = p_region)
    ORDER BY (c.region_id IS NOT NULL) DESC, c.id LIMIT 1)
  SELECT DISTINCT e.user_id FROM cell
  CROSS JOIN LATERAL (SELECT x.user_id FROM public.reg_eligible_cell(cell.id, p_region, 'daily_plan', p_kind::public."PermissionLevel") x
                      UNION SELECT x.user_id FROM public.reg_eligible_cell(cell.id, p_region, 'sites', p_kind::public."PermissionLevel") x) e
$$;

CREATE OR REPLACE FUNCTION dp_holds(p_user uuid, p_region integer, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_user IS NOT NULL AND EXISTS (SELECT 1 FROM public.dp_holders(p_region, p_kind) h WHERE h.user_id = p_user)
$$;

-- May the actor unlock (admin override) a plan of this region? A System Admin, or a delegate of overrides.unlock for the region.
CREATE OR REPLACE FUNCTION dp_may_unlock(p_user uuid, p_region integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_user IS NOT NULL AND (public.app_user_is_system_admin(p_user) OR EXISTS (
    SELECT 1 FROM public.app_user_delegations(p_user) x(id) JOIN public.delegations d ON d.id = x.id
    WHERE public.deleg_covers(d.id, 'overrides.unlock', 'administer')
      AND (d.all_regions OR EXISTS (SELECT 1 FROM public.delegation_regions dr WHERE dr.delegation_id = d.id AND dr.region_id = p_region))))
$$;

-- Lines of a work cell (one item per line; empty lines do not count).
CREATE OR REPLACE FUNCTION dp_count_lines(p text) RETURNS integer
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*)::integer FROM regexp_split_to_table(coalesce(p, ''), E'\\n') l WHERE btrim(l) <> ''
$$;

-- The auto-filled values of a site on a day (see the header, item 3), with the planned and actual items.
CREATE OR REPLACE FUNCTION dp_site_auto(p_site uuid, p_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; rg public.regions%ROWTYPE; sow text; planned jsonb; actual jsonb; fw jsonb; fw_done jsonb; orders uuid[]; contractor text; se text;
  access text; pv record; b3 date;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO rg FROM public.regions WHERE id = s.region_id;
  sow := concat_ws(': ', CASE WHEN s.delivery_scenario IS NOT NULL THEN initcap(replace(s.delivery_scenario::text, '_', ' ')) END,
           nullif(concat_ws(', ',
             CASE WHEN s.scope_tower_erection::text = 'yes' THEN 'Tower Erection' END, CASE WHEN s.scope_site_adaption::text = 'yes' THEN 'Site Adaption' END,
             CASE WHEN s.scope_gecol_power::text = 'yes' THEN 'GECOL Power' END, CASE WHEN s.scope_hlc_fiber::text = 'yes' THEN 'HLC Fiber' END,
             CASE WHEN s.scope_te_full::text = 'yes' THEN 'TE Full Scope' END, CASE WHEN s.scope_te_ip_router_only::text = 'yes' THEN 'TE IP Router Only' END), ''));

  -- tasks planned and done that day
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'task', 'code', d.code, 'label', d.code || ' ' || d.name_en, 'label_ar', d.code || ' ' || coalesce(d.name_ar, d.name_en))
                            ORDER BY d.sort_order, d.code) FILTER (WHERE t.planned_date = p_date OR t.planned_start = p_date), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('kind', 'task', 'code', d.code, 'label', d.code || ' ' || d.name_en, 'label_ar', d.code || ' ' || coalesce(d.name_ar, d.name_en))
                            ORDER BY d.sort_order, d.code) FILTER (WHERE t.actual_date = p_date), '[]'::jsonb)
  INTO planned, actual
  FROM public.task_instances t JOIN public.task_definitions d ON d.id = t.task_def_id
  WHERE t.site_id = p_site AND NOT t.is_na AND t.state NOT IN ('na', 'skipped')
    AND (t.planned_date = p_date OR t.planned_start = p_date OR t.actual_date = p_date);

  -- the Procurement assignments of the day: field-work dates covering it (current, not voided, not cancelled or rejected)
  SELECT coalesce(array_agg(r.id ORDER BY r.created_at), ARRAY[]::uuid[]) INTO orders
  FROM public.register_records r
  WHERE r.register_key = 'procurement' AND r.site_id = p_site AND r.is_current AND r.voided_at IS NULL
    AND coalesce(r.data ->> 'order_status', 'Active') NOT IN ('Cancelled', 'Rejected')
    AND public.ssa_iso_date(r.data ->> 'planned_start') <= p_date
    AND p_date <= coalesce(public.ssa_iso_date(r.data ->> 'actual_end'), public.ssa_iso_date(r.data ->> 'planned_end'), public.ssa_iso_date(r.data ->> 'planned_start'));
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'field_work', 'code', coalesce(r.data ->> 'scope', 'Field work'),
                                               'label', coalesce(r.data ->> 'scope', 'Field work') || coalesce(' (' || coalesce(nullif(r.data ->> 'po_wo_no', ''), nullif(r.data ->> 'pr_no', '')) || ')', ''))
                            ORDER BY r.created_at), '[]'::jsonb)
  INTO fw FROM public.register_records r WHERE r.id = ANY (orders);
  -- the field work that ended that day counts as done
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'field_work', 'code', coalesce(r.data ->> 'scope', 'Field work'),
                                               'label', coalesce(r.data ->> 'scope', 'Field work') || coalesce(' (' || coalesce(nullif(r.data ->> 'po_wo_no', ''), nullif(r.data ->> 'pr_no', '')) || ')', ''))
                            ORDER BY r.created_at), '[]'::jsonb)
  INTO fw_done FROM public.register_records r WHERE r.id = ANY (orders) AND public.ssa_iso_date(r.data ->> 'actual_end') = p_date;
  -- with no assignment that day, the site's latest active order names the contractor and the AAT SE
  IF cardinality(orders) = 0 THEN
    SELECT coalesce(array_agg(x.id), ARRAY[]::uuid[]) INTO orders FROM (
      SELECT r.id FROM public.register_records r
      WHERE r.register_key = 'procurement' AND r.site_id = p_site AND r.is_current AND r.voided_at IS NULL AND r.state = 'approved'
        AND coalesce(r.data ->> 'order_status', 'Active') = 'Active'
      ORDER BY coalesce(public.ssa_iso_date(r.data ->> 'po_wo_date'), public.ssa_iso_date(r.data ->> 'pr_date'), r.created_at::date) DESC, r.created_at DESC LIMIT 1) x;
  END IF;
  SELECT string_agg(DISTINCT n, ', ') INTO contractor FROM (
    SELECT coalesce(ep.name, et.name, CASE WHEN r.data ->> 'delivery' = 'In-House' THEN 'In-House' END) AS n
    FROM public.register_records r
    LEFT JOIN public.external_parties ep ON ep.id = r.external_party_id
    LEFT JOIN public.external_teams et ON et.id::text = r.data ->> 'team_id'
    WHERE r.id = ANY (orders)) z WHERE n IS NOT NULL;
  SELECT string_agg(DISTINCT u.display_name, ', ') INTO se
  FROM public.register_records r
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.data -> 'members') = 'array' THEN r.data -> 'members' ELSE '[]'::jsonb END) m
  JOIN public.users u ON u.id::text = m ->> 'user_id'
  WHERE r.id = ANY (orders)
    AND (m ->> 'member_role' = 'supervisor'
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.data -> 'members') = 'array' THEN r.data -> 'members' ELSE '[]'::jsonb END) m2
                        WHERE m2 ->> 'member_role' = 'supervisor'));

  -- Access Valid: an approved CW permit valid that day, else B3 (CW access permission) approved by that day
  SELECT public.ssa_iso_date(r.data ->> 'valid_to') AS valid_to INTO pv
  FROM public.register_records r
  WHERE r.register_key = 'permits_hse' AND r.site_id = p_site AND r.is_current AND r.voided_at IS NULL
    AND r.data ->> 'permit_stream' = 'CW' AND r.data ->> 'status' = 'Approved'
    AND coalesce(public.ssa_iso_date(r.data ->> 'valid_from'), p_date) <= p_date
    AND coalesce(public.ssa_iso_date(r.data ->> 'valid_to'), p_date) >= p_date
  ORDER BY public.ssa_iso_date(r.data ->> 'valid_to') DESC NULLS FIRST LIMIT 1;
  IF FOUND THEN
    access := 'Yes' || coalesce(' (to ' || to_char(pv.valid_to, 'YYYY-MM-DD') || ')', '');
  ELSE
    SELECT t.actual_date INTO b3 FROM public.task_instances t JOIN public.task_definitions d ON d.id = t.task_def_id
    WHERE t.site_id = p_site AND d.code = 'B3' AND t.state = 'approved' AND t.actual_date <= p_date LIMIT 1;
    access := CASE WHEN b3 IS NOT NULL THEN 'Yes' ELSE 'No' END;
  END IF;

  RETURN jsonb_build_object(
    'site_code', s.site_code, 'site_name', s.name, 'region', coalesce(rg.name_en, rg.code), 'tower_owner', s.tower_owner, 'owner_id', s.owner_site_id,
    'latitude', CASE WHEN s.latitude IS NULL THEN NULL ELSE s.latitude::text END, 'longitude', CASE WHEN s.longitude IS NULL THEN NULL ELSE s.longitude::text END,
    'site_type', s.site_type, 'sow', nullif(sow, ''), 'contractor', contractor, 'aat_se', se, 'access_valid', access,
    'planned_work', nullif((SELECT string_agg(e ->> 'label', E'\n') FROM jsonb_array_elements(planned || fw) e), ''),
    'actual_work', nullif((SELECT string_agg(e ->> 'label', E'\n') FROM jsonb_array_elements(actual || fw_done) e), ''),
    'planned_items', planned || fw, 'actual_items', actual || fw_done);
END $$;

-- The sites with work on a day in a region (tasks planned or done, field work scheduled or ended).
CREATE OR REPLACE FUNCTION dp_auto_sites(p_region integer, p_date date) RETURNS TABLE (site_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.site_id FROM public.task_instances t JOIN public.sites s ON s.id = t.site_id AND s.is_active AND s.region_id = p_region
  WHERE t.region_id = p_region AND NOT t.is_na AND t.state NOT IN ('na', 'skipped')
    AND (t.planned_date = p_date OR t.planned_start = p_date OR t.actual_date = p_date)
  UNION
  SELECT r.site_id FROM public.register_records r JOIN public.sites s ON s.id = r.site_id AND s.is_active AND s.region_id = p_region
  WHERE r.register_key = 'procurement' AND r.region_id = p_region AND r.is_current AND r.voided_at IS NULL
    AND coalesce(r.data ->> 'order_status', 'Active') NOT IN ('Cancelled', 'Rejected')
    AND ((public.ssa_iso_date(r.data ->> 'planned_start') <= p_date
          AND p_date <= coalesce(public.ssa_iso_date(r.data ->> 'actual_end'), public.ssa_iso_date(r.data ->> 'planned_end'), public.ssa_iso_date(r.data ->> 'planned_start')))
         OR public.ssa_iso_date(r.data ->> 'actual_end') = p_date)
$$;

-- One row of a plan as the API returns it (DailyPlanRow): the auto values, the manual ones over them, the counts and the target flags.
CREATE OR REPLACE FUNCTION dp_row_json(p_region integer, p_date date, p_site uuid, p_row public.daily_plan_rows) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE auto jsonb; vals jsonb := '{}'::jsonb; k text; ov jsonb := coalesce(p_row.overrides, '{}'::jsonb); pc integer; ac integer; below boolean;
BEGIN
  auto := public.dp_site_auto(p_site, p_date);
  IF auto IS NULL THEN RETURN NULL; END IF;
  FOREACH k IN ARRAY public.dp_override_keys() LOOP
    vals := vals || jsonb_build_object(k, CASE WHEN ov ? k THEN ov -> k ELSE auto -> k END);
  END LOOP;
  vals := vals || jsonb_build_object('site_code', auto -> 'site_code', 'site_name', auto -> 'site_name', 'region', auto -> 'region');
  pc := CASE WHEN ov ? 'planned_work' THEN public.dp_count_lines(ov ->> 'planned_work') ELSE jsonb_array_length(auto -> 'planned_items') END;
  ac := CASE WHEN ov ? 'actual_work' THEN public.dp_count_lines(ov ->> 'actual_work') ELSE jsonb_array_length(auto -> 'actual_items') END;
  below := p_date <= public.cal_today() AND ac < pc;
  RETURN jsonb_build_object(
    'region_id', p_region, 'site_id', p_site, 'site_code', auto ->> 'site_code', 'site_name', auto ->> 'site_name',
    'origin', coalesce(p_row.origin, 'auto'), 'values', vals,
    'auto', (SELECT jsonb_object_agg(x, auto -> x) FROM unnest(public.dp_override_keys()) x),
    'overridden', to_jsonb(ARRAY(SELECT x FROM unnest(public.dp_override_keys()) x WHERE ov ? x)),
    'reason', p_row.reason, 'remark', p_row.remark,
    'planned_items', auto -> 'planned_items', 'actual_items', auto -> 'actual_items',
    'planned_count', pc, 'actual_count', ac, 'below_target', below,
    'reason_missing', below AND btrim(coalesce(p_row.reason, '')) = '', 'frozen', false);
END $$;

-- The visible rows of a plan, live (auto sites and added sites, less the removed ones), ordered by Site ID.
CREATE OR REPLACE FUNCTION dp_live_rows(p_region integer, p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH p AS (SELECT id FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date),
  ids AS (
    SELECT a.site_id FROM public.dp_auto_sites(p_region, p_date) a
    UNION SELECT r.site_id FROM public.daily_plan_rows r JOIN p ON p.id = r.plan_id WHERE r.origin = 'added')
  SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'site_code'), '[]'::jsonb) FROM (
    SELECT public.dp_row_json(p_region, p_date, ids.site_id, r) AS j
    FROM ids LEFT JOIN public.daily_plan_rows r ON r.site_id = ids.site_id AND r.plan_id = (SELECT id FROM p)
    WHERE NOT coalesce(r.removed, false)) z
  WHERE j IS NOT NULL
$$;

-- The rows of a plan: the frozen ones of a locked day, else the live ones.
CREATE OR REPLACE FUNCTION dp_rows(p_region integer, p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p.locked_at IS NOT NULL THEN
           (SELECT coalesce(jsonb_agg(r.frozen || jsonb_build_object('frozen', true) ORDER BY r.frozen ->> 'site_code'), '[]'::jsonb)
            FROM public.daily_plan_rows r WHERE r.plan_id = p.id AND r.frozen IS NOT NULL AND NOT r.removed)
         ELSE public.dp_live_rows(p_region, p_date) END
  FROM (SELECT (SELECT x.locked_at FROM public.daily_plans x WHERE x.region_id = p_region AND x.plan_date = p_date) AS locked_at,
               (SELECT x.id FROM public.daily_plans x WHERE x.region_id = p_region AND x.plan_date = p_date) AS id) p
$$;

-- The header of a plan as the API returns it (DailyPlanRegion), with what the actor may do.
CREATE OR REPLACE FUNCTION dp_plan_head(p_region integer, p_date date, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; rg public.regions%ROWTYPE; a uuid := public.app_actor(); admin boolean := public.app_user_is_system_admin(public.app_actor());
BEGIN
  SELECT * INTO p FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date;
  SELECT * INTO rg FROM public.regions WHERE id = p_region;
  RETURN jsonb_build_object(
    'region_id', p_region, 'region_code', rg.code, 'region_name_en', rg.name_en, 'region_name_ar', rg.name_ar, 'plan_date', p_date,
    'version', coalesce(p.version, 0), 'locked', p.locked_at IS NOT NULL, 'lock_kind', p.lock_kind, 'locked_at', p.locked_at,
    'locked_by', CASE WHEN p.locked_by IS NULL THEN NULL ELSE public.wfe_user_ref(p.locked_by) END,
    'unlocked_at', p.unlocked_at, 'unlocked_by', CASE WHEN p.unlocked_by IS NULL THEN NULL ELSE public.wfe_user_ref(p.unlocked_by) END,
    'updated_at', p.updated_at, 'updated_by', CASE WHEN p.updated_by IS NULL THEN NULL ELSE public.wfe_user_ref(p.updated_by) END,
    'row_count', jsonb_array_length(p_rows),
    'reason_missing_count', (SELECT count(*) FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'reason_missing')::boolean),
    'can_edit', p.locked_at IS NULL AND (admin OR public.dp_holds(a, p_region, 'entry')),
    'can_lock', p.locked_at IS NULL AND (admin OR public.dp_holds(a, p_region, 'approve')),
    'can_unlock', p.locked_at IS NOT NULL AND public.dp_may_unlock(a, p_region));
END $$;

-- GET /daily-plans?date=&region_id=: the plans of the day for the regions the actor sees (narrowed to p_regions when given).
CREATE OR REPLACE FUNCTION daily_plan_json(p_date date, p_regions integer[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); plans jsonb := '[]'::jsonb; rows jsonb := '[]'::jsonb; r record; rr jsonb; mine integer[];
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'daily plan: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_date IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/date', 'required', 'A date is required.'))); END IF;
  FOR r IN SELECT g.id FROM public.regions g WHERE public.app_region_check(g.id) AND (p_regions IS NULL OR g.id = ANY (p_regions)) ORDER BY g.id LOOP
    rr := public.dp_rows(r.id, p_date);
    plans := plans || public.dp_plan_head(r.id, p_date, rr);
    rows := rows || rr;
  END LOOP;
  SELECT coalesce(array_agg(g.id ORDER BY g.id), ARRAY[]::integer[]) INTO mine FROM public.regions g
  WHERE public.app_region_check(g.id) AND (public.dp_holds(a, g.id, 'entry') OR public.dp_holds(a, g.id, 'approve'));
  RETURN jsonb_build_object('date', p_date, 'today', public.cal_today(), 'is_workday', public.cal_is_workday(p_date),
    'next_working_day', public.cal_add_workdays(p_date, 1), 'previous_working_day', public.cal_add_workdays(p_date, -1),
    'my_region_ids', to_jsonb(mine), 'plans', plans, 'rows', rows);
END $$;

-- The header of a plan for a change: created when missing, locked for update, the version checked (NULL = any), visible and unlocked.
CREATE OR REPLACE FUNCTION dp_for_change(p_region integer, p_date date, p_version integer, p_allow_locked boolean DEFAULT false) RETURNS public.daily_plans
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'daily plan: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_region IS NULL OR p_date IS NULL OR NOT EXISTS (SELECT 1 FROM public.regions g WHERE g.id = p_region) OR NOT public.app_region_check(p_region) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The plan does not exist or is not visible to you.'));
  END IF;
  SELECT * INTO p FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> coalesce(p.version, 0) THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The plan changed since you read it. Reload and try again.'));
  END IF;
  IF p.locked_at IS NOT NULL AND NOT p_allow_locked THEN
    PERFORM public.wf_err('plan_locked', jsonb_build_object('detail', 'The day is locked: only an admin override reopens it.'));
  END IF;
  IF p.id IS NULL THEN
    INSERT INTO public.daily_plans (region_id, plan_date, version, created_by, updated_by)
    VALUES (p_region, p_date, 1, public.app_actor(), public.app_actor())
    ON CONFLICT (region_id, plan_date) DO NOTHING;
    SELECT * INTO p FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date FOR UPDATE;
    -- a new header starts at version 1, which every later change raises: the If-Match "0" of a plan without a header matched above
    UPDATE public.daily_plans SET version = 0 + 1 WHERE id = p.id RETURNING * INTO p;
    RETURN p;
  END IF;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION dp_require_entry(p_region integer) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (public.app_user_is_system_admin(public.app_actor()) OR public.dp_holds(public.app_actor(), p_region, 'entry')) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the L1 holders of the Daily Plan of this region edit its rows.'));
  END IF;
END $$;

-- The stored row of a site in a plan (NULL when none).
CREATE OR REPLACE FUNCTION dp_stored(p_plan uuid, p_site uuid) RETURNS public.daily_plan_rows
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT * FROM public.daily_plan_rows WHERE plan_id = p_plan AND site_id = p_site
$$;

-- Raises the version of a changed plan.
CREATE OR REPLACE FUNCTION dp_touch(p_plan uuid, p_existed boolean) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.daily_plans SET version = CASE WHEN p_existed THEN version + 1 ELSE version END, updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE id = p_plan
$$;

-- The view of one row for the audit (the stored part only: the auto values are recomputed, never stored).
CREATE OR REPLACE FUNCTION dp_audit_row(p public.daily_plan_rows) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p.id IS NULL THEN NULL
         ELSE jsonb_build_object('origin', p.origin, 'removed', p.removed, 'overrides', p.overrides, 'reason', p.reason, 'remark', p.remark) END
$$;

-- PATCH /daily-plans/{date}/regions/{region_id}/sites/{site_id}. p_body = {overrides: {key: text | null}, reason, remark} (closed; null in overrides = back to
-- the auto value); p_version = If-Match (NULL = *). L1 of the region (or a System Admin), unlocked day.
CREATE OR REPLACE FUNCTION dp_save_row(p_region integer, p_date date, p_site uuid, p_body jsonb, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.daily_plans%ROWTYPE; existed boolean; old public.daily_plan_rows%ROWTYPE; nr public.daily_plan_rows%ROWTYPE; errs jsonb := '[]'::jsonb; k text; v jsonb;
  ov jsonb; j jsonb; visible boolean; num numeric; s public.sites%ROWTYPE;
BEGIN
  existed := EXISTS (SELECT 1 FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date);
  p := public.dp_for_change(p_region, p_date, p_version);
  PERFORM public.dp_require_entry(p_region);
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  old := public.dp_stored(p.id, p_site);
  visible := s.id IS NOT NULL AND s.region_id = p_region
             AND ((old.id IS NOT NULL AND NOT old.removed AND (old.origin = 'added' OR EXISTS (SELECT 1 FROM public.dp_auto_sites(p_region, p_date) a WHERE a.site_id = p_site)))
                  OR (old.id IS NULL AND EXISTS (SELECT 1 FROM public.dp_auto_sites(p_region, p_date) a WHERE a.site_id = p_site)));
  IF NOT visible THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site is not in this plan.')); END IF;

  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with overrides, reason and remark.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('overrides', 'reason', 'remark') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  ov := coalesce(old.overrides, '{}'::jsonb);
  IF p_body ? 'overrides' THEN
    IF jsonb_typeof(p_body -> 'overrides') <> 'object' THEN
      errs := errs || public.reg_err_item('/overrides', 'invalid', 'An object of column: text, or null to go back to the auto value.');
    ELSE
      FOR k, v IN SELECT * FROM jsonb_each(p_body -> 'overrides') LOOP
        IF NOT k = ANY (public.dp_override_keys()) THEN
          errs := errs || public.reg_err_item('/overrides/' || k, CASE WHEN k IN ('site_code', 'region', 'site_name') THEN 'read_only' ELSE 'unknown_key' END,
                                              'This column cannot be changed by hand.');
        ELSIF jsonb_typeof(v) = 'null' THEN
          ov := ov - k;
        ELSIF jsonb_typeof(v) <> 'string' OR char_length(v #>> '{}') > (CASE WHEN k IN ('planned_work', 'actual_work') THEN 2000 ELSE 300 END) THEN
          errs := errs || public.reg_err_item('/overrides/' || k, 'invalid', 'Text of at most ' || (CASE WHEN k IN ('planned_work', 'actual_work') THEN 2000 ELSE 300 END) || ' characters.');
        ELSE
          IF k IN ('latitude', 'longitude') AND btrim(v #>> '{}') <> '' THEN
            BEGIN
              num := btrim(v #>> '{}')::numeric;
            EXCEPTION WHEN others THEN num := NULL;
            END;
            IF num IS NULL OR (k = 'latitude' AND (num < -90 OR num > 90)) OR (k = 'longitude' AND (num < -180 OR num > 180)) THEN
              errs := errs || public.reg_err_item('/overrides/' || k, 'invalid', CASE WHEN k = 'latitude' THEN 'A latitude from -90 to 90.' ELSE 'A longitude from -180 to 180.' END);
              CONTINUE;
            END IF;
          END IF;
          ov := ov || jsonb_build_object(k, btrim(v #>> '{}'));
        END IF;
      END LOOP;
    END IF;
  END IF;
  FOREACH k IN ARRAY ARRAY['reason', 'remark'] LOOP
    IF p_body ? k AND jsonb_typeof(p_body -> k) NOT IN ('string', 'null') THEN
      errs := errs || public.reg_err_item('/' || k, 'invalid', 'Text, or null.');
    ELSIF p_body ? k AND char_length(coalesce(p_body ->> k, '')) > 1000 THEN
      errs := errs || public.reg_err_item('/' || k, 'invalid', 'At most 1000 characters.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  INSERT INTO public.daily_plan_rows (plan_id, region_id, site_id, origin, overrides, reason, remark, updated_by, updated_at)
  VALUES (p.id, p_region, p_site, coalesce(old.origin, 'auto'), ov,
          CASE WHEN p_body ? 'reason' THEN nullif(btrim(p_body ->> 'reason'), '') ELSE old.reason END,
          CASE WHEN p_body ? 'remark' THEN nullif(btrim(p_body ->> 'remark'), '') ELSE old.remark END, public.app_actor(), clock_timestamp())
  ON CONFLICT (plan_id, site_id) DO UPDATE SET overrides = EXCLUDED.overrides, reason = EXCLUDED.reason, remark = EXCLUDED.remark,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  RETURNING * INTO nr;
  -- a row below target needs its reason (owner decision W7 4)
  j := public.dp_row_json(p_region, p_date, p_site, nr);
  IF (j ->> 'reason_missing')::boolean THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Actual Work is below Planned Work: give the reason.',
      'errors', public.reg_err_item('/reason', 'required', 'Reason (if not reach target) is required when Actual Work is below Planned Work.')));
  END IF;
  PERFORM public.dp_touch(p.id, existed);
  PERFORM public.log_audit_write('daily_plan.row_changed', 'daily_plan', p.id::text, public.dp_audit_row(old), public.dp_audit_row(nr) || jsonb_build_object('plan_date', p_date),
    NULL, p_site, p_region);
  RETURN public.daily_plan_json(p_date, ARRAY[p_region]);
END $$;

-- POST /daily-plans/{date}/regions/{region_id}/sites: add a site by hand (or bring back a removed auto row). L1 of the region, unlocked day.
CREATE OR REPLACE FUNCTION dp_add_site(p_region integer, p_date date, p_site_code text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; existed boolean; s public.sites%ROWTYPE; old public.daily_plan_rows%ROWTYPE; nr public.daily_plan_rows%ROWTYPE; auto boolean;
BEGIN
  existed := EXISTS (SELECT 1 FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date);
  p := public.dp_for_change(p_region, p_date, p_version);
  PERFORM public.dp_require_entry(p_region);
  SELECT * INTO s FROM public.sites WHERE upper(site_code) = upper(btrim(coalesce(p_site_code, ''))) AND is_active;
  IF s.id IS NULL OR s.region_id <> p_region THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_code', 'not_in_region', 'No active site with this Site ID in the region of the plan.')));
  END IF;
  old := public.dp_stored(p.id, s.id);
  auto := EXISTS (SELECT 1 FROM public.dp_auto_sites(p_region, p_date) a WHERE a.site_id = s.id);
  IF (old.id IS NOT NULL AND NOT old.removed) OR (old.id IS NULL AND auto) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'The site is already in the plan.'));
  END IF;
  IF old.id IS NOT NULL THEN
    UPDATE public.daily_plan_rows SET removed = false, origin = CASE WHEN auto THEN 'auto' ELSE 'added' END, updated_by = public.app_actor(), updated_at = clock_timestamp()
    WHERE id = old.id RETURNING * INTO nr;
  ELSE
    INSERT INTO public.daily_plan_rows (plan_id, region_id, site_id, origin, updated_by) VALUES (p.id, p_region, s.id, 'added', public.app_actor()) RETURNING * INTO nr;
  END IF;
  PERFORM public.dp_touch(p.id, existed);
  PERFORM public.log_audit_write('daily_plan.site_added', 'daily_plan', p.id::text, public.dp_audit_row(old),
    public.dp_audit_row(nr) || jsonb_build_object('plan_date', p_date, 'site_code', s.site_code), NULL, s.id, p_region);
  RETURN public.daily_plan_json(p_date, ARRAY[p_region]);
END $$;

-- DELETE /daily-plans/{date}/regions/{region_id}/sites/{site_id}: a site added by hand leaves the plan; an auto row is marked removed. L1, unlocked day.
CREATE OR REPLACE FUNCTION dp_remove_site(p_region integer, p_date date, p_site uuid, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; existed boolean; old public.daily_plan_rows%ROWTYPE; nr public.daily_plan_rows%ROWTYPE; auto boolean; code text;
BEGIN
  existed := EXISTS (SELECT 1 FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date);
  p := public.dp_for_change(p_region, p_date, p_version);
  PERFORM public.dp_require_entry(p_region);
  old := public.dp_stored(p.id, p_site);
  auto := EXISTS (SELECT 1 FROM public.dp_auto_sites(p_region, p_date) a WHERE a.site_id = p_site);
  IF NOT ((old.id IS NOT NULL AND NOT old.removed AND (old.origin = 'added' OR auto)) OR (old.id IS NULL AND auto)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site is not in this plan.'));
  END IF;
  SELECT site_code INTO code FROM public.sites WHERE id = p_site;
  IF old.id IS NOT NULL AND old.origin = 'added' AND NOT auto THEN
    DELETE FROM public.daily_plan_rows WHERE id = old.id;
  ELSE
    INSERT INTO public.daily_plan_rows (plan_id, region_id, site_id, origin, removed, updated_by) VALUES (p.id, p_region, p_site, 'auto', true, public.app_actor())
    ON CONFLICT (plan_id, site_id) DO UPDATE SET origin = 'auto', removed = true, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
    RETURNING * INTO nr;
  END IF;
  PERFORM public.dp_touch(p.id, existed);
  PERFORM public.log_audit_write('daily_plan.site_removed', 'daily_plan', p.id::text, public.dp_audit_row(old),
    CASE WHEN nr.id IS NULL THEN NULL ELSE public.dp_audit_row(nr) END || jsonb_build_object('plan_date', p_date, 'site_code', code), NULL, p_site, p_region);
  RETURN public.daily_plan_json(p_date, ARRAY[p_region]);
END $$;

-- Freezes every visible row of a plan (the lock): the stored rows get frozen, the auto rows without a stored row get one.
CREATE OR REPLACE FUNCTION dp_freeze(p_plan uuid, p_region integer, p_date date) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e jsonb; n integer := 0;
BEGIN
  FOR e IN SELECT x FROM jsonb_array_elements(public.dp_live_rows(p_region, p_date)) x LOOP
    INSERT INTO public.daily_plan_rows (plan_id, region_id, site_id, origin, frozen, updated_at)
    VALUES (p_plan, p_region, (e ->> 'site_id')::uuid, coalesce(e ->> 'origin', 'auto'), e, clock_timestamp())
    ON CONFLICT (plan_id, site_id) DO UPDATE SET frozen = EXCLUDED.frozen;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- POST /daily-plans/{date}/regions/{region_id}/lock: L2 of the region (or a System Admin). Every row below target needs its reason first.
CREATE OR REPLACE FUNCTION dp_lock(p_region integer, p_date date, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; existed boolean; live jsonb; errs jsonb; n integer;
BEGIN
  existed := EXISTS (SELECT 1 FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date);
  p := public.dp_for_change(p_region, p_date, p_version);
  IF NOT (public.app_user_is_system_admin(public.app_actor()) OR public.dp_holds(public.app_actor(), p_region, 'approve')) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the L2 holders of the Daily Plan of this region lock the day.'));
  END IF;
  live := public.dp_live_rows(p_region, p_date);
  SELECT coalesce(jsonb_agg(public.reg_err_item('/rows/' || (e ->> 'site_code') || '/reason', 'required', 'Reason (if not reach target) is required for ' || (e ->> 'site_code') || '.') -> 0
                            ORDER BY e ->> 'site_code'), '[]'::jsonb)
  INTO errs FROM jsonb_array_elements(live) e WHERE (e ->> 'reason_missing')::boolean;
  IF jsonb_array_length(errs) > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Some rows are below target without a reason: give the reasons before locking the day.', 'errors', errs));
  END IF;
  n := public.dp_freeze(p.id, p_region, p_date);
  UPDATE public.daily_plans SET locked_at = clock_timestamp(), locked_by = public.app_actor(), lock_kind = 'manual',
         version = CASE WHEN existed THEN version + 1 ELSE version END, updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE id = p.id;
  PERFORM public.log_audit_write('daily_plan.locked', 'daily_plan', p.id::text, jsonb_build_object('locked', false),
    jsonb_build_object('locked', true, 'lock_kind', 'manual', 'plan_date', p_date, 'rows', n), NULL, NULL, p_region);
  RETURN public.daily_plan_json(p_date, ARRAY[p_region]);
END $$;

-- POST /daily-plans/{date}/regions/{region_id}/unlock: the admin override (System Admin or a delegate of overrides.unlock for the region), reason, step-up.
CREATE OR REPLACE FUNCTION dp_unlock(p_region integer, p_date date, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; before jsonb;
BEGIN
  p := public.dp_for_change(p_region, p_date, p_version, true);
  IF NOT public.dp_may_unlock(public.app_actor(), p_region) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin, or a delegate of the unlock override for this region, reopens a locked day.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p.locked_at IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The day is not locked.')); END IF;
  before := jsonb_build_object('locked', true, 'lock_kind', p.lock_kind, 'locked_at', p.locked_at, 'locked_by', p.locked_by);
  -- back to the live values: the rows frozen only for the lock (no manual value) are dropped, the others lose their frozen copy
  DELETE FROM public.daily_plan_rows WHERE plan_id = p.id AND origin = 'auto' AND NOT removed AND overrides = '{}'::jsonb AND reason IS NULL AND remark IS NULL;
  UPDATE public.daily_plan_rows SET frozen = NULL WHERE plan_id = p.id;
  UPDATE public.daily_plans SET locked_at = NULL, locked_by = NULL, lock_kind = NULL, unlocked_at = clock_timestamp(), unlocked_by = public.app_actor(),
         version = version + 1, updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE id = p.id;
  PERFORM public.log_audit_write('daily_plan.unlocked', 'daily_plan', p.id::text, before, jsonb_build_object('locked', false, 'plan_date', p_date),
    btrim(p_reason), NULL, p_region, NULL, true);
  RETURN public.daily_plan_json(p_date, ARRAY[p_region]);
END $$;

-- GET /daily-plans/export: both tables of the sheet (the day and the next working day) for the regions asked, narrowed to the sites asked (the current view);
-- the export is audited.
CREATE OR REPLACE FUNCTION dp_export_json(p_date date, p_regions integer[], p_sites uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d jsonb; t jsonb; nxt date; keep jsonb;
BEGIN
  d := public.daily_plan_json(p_date, p_regions);
  nxt := (d ->> 'next_working_day')::date;
  t := public.daily_plan_json(nxt, p_regions);
  IF p_sites IS NOT NULL THEN
    d := jsonb_set(d, '{rows}', (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(d -> 'rows') e WHERE (e ->> 'site_id')::uuid = ANY (p_sites)));
    t := jsonb_set(t, '{rows}', (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(t -> 'rows') e WHERE (e ->> 'site_id')::uuid = ANY (p_sites)));
  END IF;
  keep := jsonb_build_object('progress', d, 'tomorrow', t);
  PERFORM public.log_audit_write('daily_plan.exported', 'daily_plan', p_date::text, NULL,
    jsonb_build_object('date', p_date, 'next_working_day', nxt, 'region_ids', to_jsonb(coalesce(p_regions, ARRAY[]::integer[])),
                       'progress_rows', jsonb_array_length(d -> 'rows'), 'tomorrow_rows', jsonb_array_length(t -> 'rows'), 'filtered', p_sites IS NOT NULL), NULL);
  RETURN keep;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The job (every 5 minutes): the automatic lock of today's plans after the set time, and the reminder of an empty next working day
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dp_local_now() RETURNS timestamp
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tz text := coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli');
BEGIN
  RETURN now() AT TIME ZONE tz;
EXCEPTION WHEN others THEN RETURN now() AT TIME ZONE 'Africa/Tripoli';
END $$;

CREATE OR REPLACE FUNCTION dp_tick() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cfg jsonb := public.dp_cfg(); loc timestamp := public.dp_local_now(); today date := public.cal_today(); nxt date; n integer := 0; g record;
  p public.daily_plans%ROWTYPE; frozen integer; holder record; sent integer;
BEGIN
  -- the automatic lock: today's plan of every region once the set time has passed (a working day, or a plan that has a header), and a past day that was never
  -- locked nor reopened by an admin override; a day reopened by an override is never locked again by the job
  IF jsonb_typeof(cfg -> 'auto_lock_time') = 'string' THEN
    FOR g IN
      SELECT r.id AS region_id, d.plan_date FROM public.regions r
      CROSS JOIN LATERAL (SELECT today AS plan_date WHERE loc::time >= (cfg ->> 'auto_lock_time')::time
                          UNION SELECT x.plan_date FROM public.daily_plans x WHERE x.region_id = r.id AND x.plan_date < today AND x.locked_at IS NULL AND x.unlocked_at IS NULL) d
      ORDER BY r.id, d.plan_date
    LOOP
      SELECT * INTO p FROM public.daily_plans WHERE region_id = g.region_id AND plan_date = g.plan_date FOR UPDATE;
      IF p.locked_at IS NOT NULL OR p.unlocked_at IS NOT NULL THEN CONTINUE; END IF;
      IF p.id IS NULL AND NOT public.cal_is_workday(g.plan_date) THEN CONTINUE; END IF;
      IF p.id IS NULL THEN
        INSERT INTO public.daily_plans (region_id, plan_date) VALUES (g.region_id, g.plan_date) ON CONFLICT (region_id, plan_date) DO NOTHING;
        SELECT * INTO p FROM public.daily_plans WHERE region_id = g.region_id AND plan_date = g.plan_date FOR UPDATE;
      END IF;
      frozen := public.dp_freeze(p.id, g.region_id, g.plan_date);
      UPDATE public.daily_plans SET locked_at = clock_timestamp(), locked_by = NULL, lock_kind = 'auto', version = version + 1, updated_at = clock_timestamp() WHERE id = p.id;
      INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, before, after, reason, actor_id)
      VALUES ('daily_plan.locked', 'daily_plan', p.id::text, g.region_id, jsonb_build_object('locked', false),
              jsonb_build_object('locked', true, 'lock_kind', 'auto', 'plan_date', g.plan_date, 'rows', frozen,
                                 'reason_missing', (SELECT count(*) FROM public.daily_plan_rows r WHERE r.plan_id = p.id AND (r.frozen ->> 'reason_missing')::boolean)),
              'Locked automatically after ' || (cfg ->> 'auto_lock_time') || ' (Settings > My Work > Daily Plan).', NULL);
      n := n + 1;
    END LOOP;
  END IF;

  -- the reminder: on a working day, from the set hour, the L1 holders of a region whose plan of the next working day is empty (once per region and day)
  IF jsonb_typeof(cfg -> 'reminder_hour') = 'number' AND extract(hour FROM loc) >= (cfg ->> 'reminder_hour')::integer AND public.cal_is_workday(today) THEN
    nxt := public.cal_add_workdays(today, 1);
    FOR g IN SELECT r.id AS region_id, r.name_en FROM public.regions r ORDER BY r.id LOOP
      SELECT * INTO p FROM public.daily_plans WHERE region_id = g.region_id AND plan_date = nxt FOR UPDATE;
      IF p.reminded_at IS NOT NULL OR jsonb_array_length(public.dp_rows(g.region_id, nxt)) > 0 THEN CONTINUE; END IF;
      IF p.id IS NULL THEN
        INSERT INTO public.daily_plans (region_id, plan_date) VALUES (g.region_id, nxt) ON CONFLICT (region_id, plan_date) DO NOTHING;
        SELECT * INTO p FROM public.daily_plans WHERE region_id = g.region_id AND plan_date = nxt FOR UPDATE;
      END IF;
      sent := 0;
      FOR holder IN SELECT h.user_id FROM public.dp_holders(g.region_id, 'entry') h LOOP
        INSERT INTO public.notifications (user_id, channel, kind, title, body, link, region_id, module_key)
        VALUES (holder.user_id, 'in_app', 'daily_plan_reminder', 'Tomorrow Plan is empty',
                'The plan of ' || g.name_en || ' for ' || to_char(nxt, 'YYYY-MM-DD') || ' has no site yet. Add the sites of the next working day.',
                '/my-work/daily-plan?tab=tomorrow&date=' || to_char(today, 'YYYY-MM-DD'), g.region_id, 'daily_plan');
        sent := sent + 1;
      END LOOP;
      UPDATE public.daily_plans SET reminded_at = clock_timestamp() WHERE id = p.id;
      INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, before, after, reason, actor_id)
      VALUES ('daily_plan.reminder_sent', 'daily_plan', p.id::text, g.region_id, NULL, jsonb_build_object('plan_date', nxt, 'recipients', sent),
              'The plan of the next working day was empty at ' || (cfg ->> 'reminder_hour') || ':00 (Settings > My Work > Daily Plan).', NULL);
      n := n + 1;
    END LOOP;
  END IF;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Saved views of the screen daily-plan (redefined from 0138; the lines marked 0149 are new)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_screen_module(p_screen text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_screen IS NULL THEN RETURN NULL; END IF;
  IF p_screen ~ '^register-[a-z0-9_]{2,60}$' THEN
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = substr(p_screen, 10) AND d.is_active);
  END IF;
  RETURN CASE p_screen
    WHEN 'sites' THEN 'sites'
    WHEN 'sites-stream' THEN 'sites'
    WHEN 'site-tasks' THEN 'sites'
    WHEN 'tasks-board' THEN 'sites' -- 0118 (F5)
    WHEN 'site360-master' THEN 'sites' -- 0138
    WHEN 'site360-design_acq' THEN 'sites' -- 0138
    WHEN 'site360-sow' THEN 'sites' -- 0138
    WHEN 'site360-cw' THEN 'sites' -- 0138
    WHEN 'site360-te' THEN 'sites' -- 0138
    WHEN 'site360-hoto' THEN 'sites' -- 0138
    WHEN 'site360-dismantle' THEN 'sites' -- 0138
    WHEN 'site360-om' THEN 'sites' -- 0138
    WHEN 'dashboard' THEN 'dashboard' -- 0138
    WHEN 'daily-plan' THEN 'daily_plan' -- 0149
    WHEN 'audit-log' THEN 'audit'
    WHEN 'field-changes' THEN 'audit'
    WHEN 'security-log' THEN 'admin.security_log'
    WHEN 'system-log' THEN 'admin.system_log'
    ELSE NULL END;
END $$;

CREATE OR REPLACE FUNCTION sv_module_ok(p_screen text, p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m text := public.sv_screen_module(p_screen);
BEGIN
  IF m IS NULL OR p_user IS NULL THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN true; END IF;
  IF p_user IS DISTINCT FROM public.app_actor() THEN RETURN false; END IF;  -- the resolver answers for the signed-in actor only
  IF m = 'admin.security_log' THEN RETURN public.app_has_permission(p_user, m, 'view_security_log'::"PermissionAction"); END IF;
  -- 0138: the dashboard filter reads site data, so a dashboard view also needs the Site Register right
  IF p_screen = 'dashboard' AND NOT public.app_has_permission(p_user, 'sites', 'view'::"PermissionAction") THEN RETURN false; END IF;
  -- 0149: the Daily Plan lists sites; the Site Register right opens it as well as its own module
  IF p_screen = 'daily-plan' THEN
    RETURN public.app_has_permission(p_user, 'daily_plan', 'view'::"PermissionAction") OR public.app_has_permission(p_user, 'sites', 'view'::"PermissionAction");
  END IF;
  RETURN public.app_has_permission(p_user, m, 'view'::"PermissionAction")
      OR (m = 'audit' AND public.app_has_permission(p_user, m, 'view_audit'::"PermissionAction"));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The setting daily_plan.settings changes only through its door (settings_guarded_keys of 0072, its own triggers as 0145 did)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TRIGGER b_settings_dp BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'daily_plan.settings') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dp_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'daily_plan.settings' OR NEW.key = 'daily_plan.settings') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_dp_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'daily_plan.settings') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('daily_plan_applied', 'workflow', NULL,
        jsonb_build_object('tables', 'daily_plans, daily_plan_rows (row security by region; doors only)',
                           'matrix_row', 'daily_plan: L1 Site Engineers (CW, TE), CW and TE Team Leads; L2 CW and TE Team Leads',
                           'setting', 'daily_plan.settings with admin_set_daily_plan_settings'),
        'Daily Plan (plan W7, migration 0149, contract 0.15.67).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'dp_columns_default(text)', 'dp_columns_known()', 'dp_override_keys()', 'dp_cfg()', 'dp_settings_json()', 'admin_set_daily_plan_settings(jsonb,text,integer)',
    'dp_holders(integer,text)', 'dp_holds(uuid,integer,text)', 'dp_may_unlock(uuid,integer)', 'dp_count_lines(text)', 'dp_site_auto(uuid,date)',
    'dp_auto_sites(integer,date)', 'dp_row_json(integer,date,uuid,daily_plan_rows)', 'dp_live_rows(integer,date)', 'dp_rows(integer,date)',
    'dp_plan_head(integer,date,jsonb)', 'daily_plan_json(date,integer[])', 'dp_for_change(integer,date,integer,boolean)', 'dp_require_entry(integer)',
    'dp_stored(uuid,uuid)', 'dp_touch(uuid,boolean)', 'dp_audit_row(daily_plan_rows)', 'dp_save_row(integer,date,uuid,jsonb,integer)',
    'dp_add_site(integer,date,text,integer)', 'dp_remove_site(integer,date,uuid,integer)', 'dp_freeze(uuid,integer,date)', 'dp_lock(integer,date,integer)',
    'dp_unlock(integer,date,text,integer)', 'dp_export_json(date,integer[],uuid[])', 'dp_local_now()', 'dp_tick()',
    'sv_screen_module(text)', 'sv_module_ok(text,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'dp_settings_json()', 'admin_set_daily_plan_settings(jsonb,text,integer)', 'daily_plan_json(date,integer[])', 'dp_save_row(integer,date,uuid,jsonb,integer)',
      'dp_add_site(integer,date,text,integer)', 'dp_remove_site(integer,date,uuid,integer)', 'dp_lock(integer,date,integer)', 'dp_unlock(integer,date,text,integer)',
      'dp_export_json(date,integer[],uuid[])', 'dp_tick()', 'sv_screen_module(text)', 'sv_module_ok(text,uuid)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
