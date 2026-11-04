-- 0065_p10_saved_views: server-side saved views, shared with roles, groups, users or everyone, and server-side drafts (P10, owner answers
-- Q115 and Q117 of 2026-11-04, binding by D0).
-- Mirror: db/sql/064_p10_saved_views.sql (kept identical to prisma/migrations/0065_p10_saved_views/migration.sql).
--
-- Q117 (who may share). Every user keeps private views of their own; nobody else reads a private view (not even a System Admin: the
-- functions answer "not found"). Sharing a view with others needs the right views.share, stored as the grant (views, create): seeded on
-- the System Admin, Team Lead and Project Manager profiles, and delegable like any grant. The creator chooses the audience within their
-- own scope only:
--   * "everyone" needs the right for all regions (a System Admin, a delegation with all regions, or an all-regions assignment);
--   * a region-limited holder shares with chosen roles, groups and users only;
--   * a view is only offered to a recipient who may open the screen's module (view right), and its filters run with the recipient's own
--     rights, so a shared view never widens what anyone sees;
--   * hidden columns are stripped server-side for each reader: a `f:<code>` column (or filter, or sort key) of a register screen whose
--     field is unknown, deactivated or hidden for the reader by a field rule never leaves the database.
-- The grant is counted on any active assignment, whatever its module list, because views is not a data module (a CW Team Lead limited
-- to the CW modules still shares views). Open question Q420.
-- Managing other people's shared views (edit, deactivate, restore, transfer ownership) needs views.manage, stored as (views, administer)
-- for all regions (app_can): a System Admin, or a delegate. The owner always edits and deactivates their own views.
-- Ownership moves when the creator leaves: when an active user becomes suspended, disabled or deleted, their active shared views move to
-- their direct manager when that manager is active; otherwise they stay with a "owner left" flag and views.manage transfers them.
--
-- Lifecycle. A view is never deleted: it is versioned (saved_view_versions keeps every state with who, when, what and why) and
-- deactivated or restored. Every create, edit, share change, deactivation, restore, transfer and import writes an Audit Log row through
-- log_audit_write (before and after values). Imports of the browser's old local views are idempotent (local_ref).
--
-- Q115 (drafts). Unsaved input stays in memory with a leave guard in the browser and no work data is stored in localStorage. A user may
-- save a draft of a form on the server (user_drafts): it belongs to that user only, is never a submission, an approval or an input of any
-- calculation, and is kept for drafts.retention_days (setting, default 30, between 1 and 365). Only the owner reads, saves, lists and
-- discards it. The API checks that the user may still read the task or record of the draft before it saves or returns it.
--
-- pmis_app keeps SELECT only on the four new tables (row security: own rows only) and writes through the functions below
-- (SECURITY DEFINER, owner pmis_definer, SET search_path). db/sql/app_grants.sql repeats the narrowing.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE saved_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  screen_key      text NOT NULL CHECK (screen_key ~ '^[a-z][a-z0-9_-]{1,80}$'),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object' AND length(filters::text) <= 16000),
  columns         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(columns) = 'object' AND length(columns::text) <= 16000),
  sort            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sort) = 'array' AND jsonb_array_length(sort) <= 5),
  share_everyone  boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  local_ref       text CHECK (local_ref IS NULL OR length(local_ref) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL REFERENCES users(id),
  deactivated_at  timestamptz,
  deactivated_by  uuid REFERENCES users(id),
  CONSTRAINT saved_views_inactive_stamp CHECK (is_active = (deactivated_at IS NULL))
);
CREATE INDEX saved_views_owner_screen ON saved_views (owner_id, screen_key);
CREATE INDEX saved_views_screen ON saved_views (screen_key) WHERE is_active;
CREATE UNIQUE INDEX saved_views_local_ref ON saved_views (owner_id, local_ref) WHERE local_ref IS NOT NULL;

-- The audience of a shared view (besides share_everyone): roles, groups and single users.
CREATE TABLE saved_view_targets (
  view_id     uuid NOT NULL REFERENCES saved_views(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK (target_kind IN ('role', 'group', 'user')),
  target_id   uuid NOT NULL,
  PRIMARY KEY (view_id, target_kind, target_id)
);
CREATE INDEX saved_view_targets_target ON saved_view_targets (target_kind, target_id);

-- Every state a view has had (version 1 = as created). Append-only.
CREATE TABLE saved_view_versions (
  view_id     uuid NOT NULL REFERENCES saved_views(id) ON DELETE RESTRICT,
  version     integer NOT NULL,
  change      text NOT NULL CHECK (change IN ('create', 'edit', 'deactivate', 'restore', 'transfer', 'import', 'owner_left')),
  snapshot    jsonb NOT NULL,
  reason      text,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, version)
);

CREATE TABLE user_drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_key   text NOT NULL CHECK (draft_key ~ '^(task|record|form)\.[A-Za-z0-9_.-]{1,200}$'),
  payload     jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND length(payload::text) <= 65536),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  saved_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, draft_key)
);

CREATE OR REPLACE FUNCTION sv_versions_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'saved_view_versions is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER saved_view_versions_append_only BEFORE UPDATE OR DELETE ON saved_view_versions FOR EACH ROW EXECUTE FUNCTION sv_versions_append_only();
-- A view is deactivated, never deleted.
CREATE TRIGGER saved_views_no_delete BEFORE DELETE ON saved_views FOR EACH ROW EXECUTE FUNCTION sv_versions_append_only();

-- Row security: pmis_app reads its own rows only (the shared views of others come through sv_list / sv_get, with hidden columns stripped).
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
ALTER TABLE saved_view_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE saved_view_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE user_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON saved_views FOR SELECT USING (app_is_seeding() OR owner_id = app_actor());
CREATE POLICY rls_select ON saved_view_targets FOR SELECT USING (app_is_seeding() OR EXISTS (SELECT 1 FROM saved_views v WHERE v.id = view_id));
CREATE POLICY rls_select ON saved_view_versions FOR SELECT USING (app_is_seeding() OR EXISTS (SELECT 1 FROM saved_views v WHERE v.id = view_id));
CREATE POLICY rls_select ON user_drafts FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON saved_views FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
CREATE POLICY rls_seed_write ON saved_view_targets FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
CREATE POLICY rls_seed_write ON saved_view_versions FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
CREATE POLICY rls_seed_write ON user_drafts FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The grant views.share (views, create) on the seeded System Admin, Team Lead and Project Manager profiles (Q117). An admin's later
--    removal is respected: a profile the admin already changed keeps what it has when this runs again (ON CONFLICT DO NOTHING).
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO permission_grants (profile_id, module_key, action)
SELECT p.id, 'views', 'create'::"PermissionAction" FROM permission_profiles p WHERE p.code IN ('system_admin', 'team_lead', 'project_manager')
ON CONFLICT DO NOTHING;
INSERT INTO permission_grants (profile_id, module_key, action)
SELECT p.id, 'views', 'administer'::"PermissionAction" FROM permission_profiles p WHERE p.code = 'system_admin'
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value, updated_at) VALUES ('drafts.retention_days', '30'::jsonb, now()) ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- Raises the error shape the API maps (wf:<code>:<json>, see apps/api/src/common/db-errors.ts).
CREATE OR REPLACE FUNCTION sv_fail(p_code text, p_detail text, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '%', 'wf:' || p_code || ':' || (coalesce(p_extra, '{}'::jsonb) || jsonb_build_object('detail', p_detail))::text;
END $$;

CREATE OR REPLACE FUNCTION sv_ts(p timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- The module a list screen belongs to (its view right decides who may see a view of the screen). NULL = not a known list screen.
CREATE OR REPLACE FUNCTION sv_screen_module(p_screen text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_screen IS NULL THEN RETURN NULL; END IF;
  IF p_screen ~ '^register-[a-z0-9_]{2,60}$' THEN
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = substr(p_screen, 10) AND d.is_active);
  END IF;
  RETURN CASE p_screen
    WHEN 'sites' THEN 'sites'
    WHEN 'sites-stream' THEN 'sites'
    WHEN 'site-tasks' THEN 'sites'
    WHEN 'audit-log' THEN 'audit'
    WHEN 'field-changes' THEN 'audit'
    WHEN 'security-log' THEN 'admin.security_log'
    ELSE NULL END;
END $$;

-- May the user open the screen's module? (A System Admin always may; the audit screens also open with view_audit, as the Audit Log does.)
CREATE OR REPLACE FUNCTION sv_module_ok(p_screen text, p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m text := public.sv_screen_module(p_screen);
BEGIN
  IF m IS NULL OR p_user IS NULL THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN true; END IF;
  IF p_user IS DISTINCT FROM public.app_actor() THEN RETURN false; END IF;  -- the resolver answers for the signed-in actor only
  IF m = 'admin.security_log' THEN RETURN public.app_has_permission(p_user, m, 'view_security_log'::"PermissionAction"); END IF;
  RETURN public.app_has_permission(p_user, m, 'view'::"PermissionAction")
      OR (m = 'audit' AND public.app_has_permission(p_user, m, 'view_audit'::"PermissionAction"));
END $$;

-- The share scope of a user for views.share = (views, create): 'all' (every region: System Admin, an all-regions delegation or an
-- all-regions assignment), 'limited' (only region-limited holdings) or 'none'. Assignment module lists are not applied (see the header).
CREATE OR REPLACE FUNCTION sv_share_scope(p_user uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE any_all boolean := false; any_some boolean := false;
BEGIN
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL) THEN RETURN 'none'; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN 'all'; END IF;
  SELECT coalesce(bool_or(d.all_regions), false), count(*) > 0 INTO any_all, any_some
    FROM public.app_user_delegations(p_user) x(id) JOIN public.delegations d ON d.id = x.id
    WHERE public.deleg_covers(d.id, 'views', 'create'::"PermissionAction");
  IF any_all THEN RETURN 'all'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_role_assignments ua
    JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = ua.id
    JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
    JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = 'create'::"PermissionAction" AND g.module_key = 'views'
    WHERE ua.user_id = p_user AND ua.all_regions AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())) THEN RETURN 'all'; END IF;
  IF any_some OR EXISTS (
    SELECT 1 FROM public.user_role_assignments ua
    JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = ua.id
    JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
    JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = 'create'::"PermissionAction" AND g.module_key = 'views'
    WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())) THEN RETURN 'limited'; END IF;
  RETURN 'none';
END $$;

-- views.manage = (views, administer) for all regions (System Admin or a delegate): edits, deactivates and transfers other people's shared views.
CREATE OR REPLACE FUNCTION sv_is_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_actor() IS NOT NULL AND public.app_can('views', 'administer'::"PermissionAction")
$$;

-- Is the view addressed to the user (everyone, the user, a role the user holds through an active assignment, a group the user is in)?
CREATE OR REPLACE FUNCTION sv_addressed_to(p_view uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND v.share_everyone)
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t WHERE t.view_id = p_view AND t.target_kind = 'user' AND t.target_id = p_user)
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t JOIN public.user_role_assignments a ON a.role_id = t.target_id AND a.user_id = p_user
                 WHERE t.view_id = p_view AND t.target_kind = 'role' AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t JOIN public.group_members gm ON gm.group_id = t.target_id AND gm.user_id = p_user
                 JOIN public.groups g ON g.id = gm.group_id AND g.is_active
                 WHERE t.view_id = p_view AND t.target_kind = 'group')
$$;

CREATE OR REPLACE FUNCTION sv_is_shared(p_view uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND v.share_everyone)
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t WHERE t.view_id = p_view)
$$;

-- Read: the owner, or (active, shared with the reader, and the reader may open the screen's module).
CREATE OR REPLACE FUNCTION sv_can_read(p_view uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND v.owner_id = p_user)
      OR EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND v.is_active AND v.owner_id <> p_user
                 AND public.sv_addressed_to(v.id, p_user) AND public.sv_module_ok(v.screen_key, p_user))
$$;

-- Must this column (or filter or sort key) be stripped for the actor? Only the `f:<code>` columns of a register screen are field columns:
-- unknown or deactivated fields and custom fields that a field rule hides from the actor are stripped.
CREATE OR REPLACE FUNCTION sv_hidden_column(p_screen text, p_col text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c text; rk text; ent text; fid uuid; acc text;
BEGIN
  IF p_col IS NULL OR p_col !~ '^f:' THEN RETURN false; END IF;
  IF p_screen IS NULL OR p_screen !~ '^register-' THEN RETURN true; END IF;
  c := substr(p_col, 3); rk := substr(p_screen, 10);
  IF EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = rk AND f.code = c AND f.is_active) THEN RETURN false; END IF;
  ent := '{"procurement":"procurement","gecol":"gecol","hlc":"hlc","permits_hse":"permit","quality":"quality","issues":"issue","risks":"risk",
           "change_control":"change_request","readiness_handover":"readiness","as_built":"as_built","meetings":"meeting","rf_design":"rf_design",
           "acquisition":"acquisition","contractors":"external_party"}'::jsonb ->> rk;
  IF ent IS NULL THEN RETURN true; END IF;
  SELECT f.id INTO fid FROM public.field_definitions f WHERE f.entity_type::text = ent AND f.code = c AND f.is_active AND f.task_code IS NULL;
  IF fid IS NULL THEN RETURN true; END IF;
  IF public.app_actor_is_system_admin() THEN RETURN false; END IF;
  acc := public.app_resolve_field_access(public.app_actor(), fid)::text;
  RETURN coalesce(acc = 'hidden', false);  -- NULL = no field rule: the entity right decides
END $$;

-- The content of a view as the actor may see it: hidden columns removed from filters, columns (order, hidden, width) and sort.
CREATE OR REPLACE FUNCTION sv_strip(p_screen text, p_filters jsonb, p_columns jsonb, p_sort jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE gone text[] := ARRAY[]::text[]; f jsonb := '{}'::jsonb; c jsonb := coalesce(p_columns, '{}'::jsonb); s jsonb := '[]'::jsonb; k text; e jsonb;
BEGIN
  FOR k IN SELECT jsonb_object_keys(coalesce(p_filters, '{}'::jsonb)) LOOP
    IF public.sv_hidden_column(p_screen, k) THEN gone := gone || k; ELSE f := f || jsonb_build_object(k, p_filters -> k); END IF;
  END LOOP;
  IF jsonb_typeof(c -> 'order') = 'array' THEN
    SELECT coalesce(jsonb_agg(x ORDER BY o), '[]'::jsonb) INTO e FROM jsonb_array_elements_text(c -> 'order') WITH ORDINALITY q(x, o) WHERE NOT public.sv_hidden_column(p_screen, x);
    SELECT gone || coalesce(array_agg(x), ARRAY[]::text[]) INTO gone FROM jsonb_array_elements_text(c -> 'order') q(x) WHERE public.sv_hidden_column(p_screen, x);
    c := jsonb_set(c, '{order}', e);
  END IF;
  IF jsonb_typeof(c -> 'hidden') = 'array' THEN
    SELECT coalesce(jsonb_agg(x ORDER BY o), '[]'::jsonb) INTO e FROM jsonb_array_elements_text(c -> 'hidden') WITH ORDINALITY q(x, o) WHERE NOT public.sv_hidden_column(p_screen, x);
    c := jsonb_set(c, '{hidden}', e);
  END IF;
  IF jsonb_typeof(c -> 'width') = 'object' THEN
    SELECT coalesce(jsonb_object_agg(w.key, w.value), '{}'::jsonb) INTO e FROM jsonb_each(c -> 'width') w WHERE NOT public.sv_hidden_column(p_screen, w.key);
    c := jsonb_set(c, '{width}', e);
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p_sort, '[]'::jsonb)) q(x) LOOP
    IF public.sv_hidden_column(p_screen, e ->> 'id') THEN gone := gone || (e ->> 'id'); ELSE s := s || jsonb_build_array(e); END IF;
  END LOOP;
  RETURN jsonb_build_object('filters', f, 'columns', c, 'sort', s,
    'stripped', (SELECT count(DISTINCT g) FROM unnest(gone) g));
END $$;

-- The audience of a view as a JSON object (ids and names).
CREATE OR REPLACE FUNCTION sv_audience(p_view uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'everyone', coalesce((SELECT v.share_everyone FROM public.saved_views v WHERE v.id = p_view), false),
    'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name_en', r.name_en, 'name_ar', r.name_ar) ORDER BY r.code COLLATE "C", r.id)
                       FROM public.saved_view_targets t JOIN public.roles r ON r.id = t.target_id WHERE t.view_id = p_view AND t.target_kind = 'role'), '[]'::jsonb),
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.id)
                       FROM public.saved_view_targets t JOIN public.groups g ON g.id = t.target_id WHERE t.view_id = p_view AND t.target_kind = 'group'), '[]'::jsonb),
    'users', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', btrim(u.employee_id)) ORDER BY u.id)
                       FROM public.saved_view_targets t JOIN public.users u ON u.id = t.target_id WHERE t.view_id = p_view AND t.target_kind = 'user'), '[]'::jsonb))
$$;

-- The full state of a view for the versions table and the audit (no stripping: only the owner and views.manage read it).
CREATE OR REPLACE FUNCTION sv_snapshot(p_view uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('owner_id', v.owner_id, 'screen_key', v.screen_key, 'name', v.name, 'filters', v.filters, 'columns', v.columns, 'sort', v.sort,
    'is_active', v.is_active, 'audience', public.sv_audience(v.id), 'version', v.version)
  FROM public.saved_views v WHERE v.id = p_view
$$;

-- What the API answers for one view, as the actor sees it.
CREATE OR REPLACE FUNCTION sv_dto(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); v public.saved_views%ROWTYPE; o public.users%ROWTYPE; st jsonb; mine boolean; shared boolean; mgr boolean;
BEGIN
  SELECT * INTO v FROM public.saved_views WHERE id = p_view;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM public.users WHERE id = v.owner_id;
  mine := v.owner_id = a; shared := public.sv_is_shared(v.id); mgr := shared AND public.sv_is_manager();
  st := public.sv_strip(v.screen_key, v.filters, v.columns, v.sort);
  RETURN jsonb_build_object(
    'id', v.id, 'screen_key', v.screen_key, 'name', v.name,
    'filters', st -> 'filters', 'columns', st -> 'columns', 'sort', st -> 'sort', 'stripped_columns', (st ->> 'stripped')::int,
    'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name, 'employee_id', btrim(o.employee_id)),
    'owner_left', o.status <> 'active' OR o.deleted_at IS NOT NULL,
    'is_owner', mine, 'shared', shared,
    'audience', CASE WHEN mine OR mgr THEN public.sv_audience(v.id) ELSE NULL END,
    'can_edit', mine OR mgr, 'can_share', (mine AND public.sv_share_scope(a) <> 'none') OR mgr,
    'is_active', v.is_active, 'version', v.version, 'imported', v.local_ref IS NOT NULL,
    'created_at', public.sv_ts(v.created_at), 'updated_at', public.sv_ts(v.updated_at));
END $$;

CREATE OR REPLACE FUNCTION sv_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'saved views: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN a;
END $$;

-- The row for a change by the actor: it must exist and be readable; changing it needs ownership or views.manage on a shared view.
CREATE OR REPLACE FUNCTION sv_for_change(p_view uuid, p_version integer) RETURNS public.saved_views
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.saved_views WHERE id = p_view FOR UPDATE;
  IF NOT FOUND OR NOT (v.owner_id = a OR (public.sv_is_shared(v.id) AND (public.sv_is_manager() OR public.sv_can_read(v.id, a)))) THEN
    PERFORM public.sv_fail('not_found', 'The view does not exist or is not visible to you.');
  END IF;
  IF v.owner_id <> a AND NOT public.sv_is_manager() THEN
    PERFORM public.sv_fail('action_forbidden', 'Only the owner of a view, or views.manage, changes a shared view.');
  END IF;
  IF p_version IS NOT NULL AND p_version <> v.version THEN
    PERFORM public.sv_fail('precondition_failed', 'The view changed since you read it. Reload and try again.');
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION sv_record(p_view uuid, p_change text, p_before jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE snap jsonb := public.sv_snapshot(p_view); a uuid := public.app_actor();
BEGIN
  INSERT INTO public.saved_view_versions (view_id, version, change, snapshot, reason, changed_by)
  VALUES (p_view, (snap ->> 'version')::int, p_change, snap, nullif(btrim(coalesce(p_reason, '')), ''), a);
  IF a IS NOT NULL THEN
    PERFORM public.log_audit_write('saved_view.' || p_change, 'saved_view', p_view::text, p_before, snap, nullif(btrim(coalesce(p_reason, '')), ''));
  ELSE
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('saved_view.' || p_change, 'saved_view', p_view::text, p_before, snap, nullif(btrim(coalesce(p_reason, '')), ''), NULL);
  END IF;
END $$;

-- Validates and writes the audience of a view (p_aud: {everyone, role_ids, group_ids, user_ids}); NULL keeps it. Checks the share scope.
CREATE OR REPLACE FUNCTION sv_set_audience(p_view uuid, p_aud jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); scope text; everyone boolean; k text; ids uuid[]; i uuid; v public.saved_views%ROWTYPE; empty boolean;
  same boolean; mgr boolean := public.sv_is_manager();
BEGIN
  IF p_aud IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_aud) <> 'object' THEN PERFORM public.sv_fail('validation_failed', 'The audience is not valid.', '{"errors":[{"path":"/audience","code":"invalid"}]}'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_aud) LOOP
    IF k NOT IN ('everyone', 'role_ids', 'group_ids', 'user_ids') THEN
      PERFORM public.sv_fail('validation_failed', 'Unknown audience field.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k, 'code', 'unknown_field'))));
    END IF;
    IF k <> 'everyone' AND (jsonb_typeof(p_aud -> k) <> 'array' OR jsonb_array_length(p_aud -> k) > 100) THEN
      PERFORM public.sv_fail('validation_failed', 'The audience is not valid.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k, 'code', 'invalid'))));
    END IF;
  END LOOP;
  everyone := coalesce((p_aud ->> 'everyone')::boolean, false);
  SELECT * INTO v FROM public.saved_views WHERE id = p_view;
  empty := NOT everyone AND coalesce(jsonb_array_length(p_aud -> 'role_ids'), 0) + coalesce(jsonb_array_length(p_aud -> 'group_ids'), 0)
           + coalesce(jsonb_array_length(p_aud -> 'user_ids') - (CASE WHEN (p_aud -> 'user_ids') ? a::text THEN 1 ELSE 0 END), 0) = 0;
  -- the same audience as now needs no right (an owner who lost views.share still edits the filters of a view already shared)
  same := v.share_everyone = everyone
    AND NOT EXISTS ((SELECT t.target_kind, t.target_id FROM public.saved_view_targets t WHERE t.view_id = p_view)
                    EXCEPT (SELECT 'role', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'role_ids', '[]')) x
                            UNION SELECT 'group', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'group_ids', '[]')) x
                            UNION SELECT 'user', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'user_ids', '[]')) x WHERE x <> a::text))
    AND NOT EXISTS ((SELECT 'role'::text, x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'role_ids', '[]')) x
                     UNION SELECT 'group', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'group_ids', '[]')) x
                     UNION SELECT 'user', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'user_ids', '[]')) x WHERE x <> a::text)
                    EXCEPT (SELECT t.target_kind, t.target_id FROM public.saved_view_targets t WHERE t.view_id = p_view));
  IF NOT empty AND NOT same AND NOT (mgr AND v.owner_id <> a) THEN
    scope := public.sv_share_scope(a);
    IF scope = 'none' THEN PERFORM public.sv_fail('action_forbidden', 'Sharing a view needs the views.share right.'); END IF;
    IF everyone AND scope <> 'all' THEN PERFORM public.sv_fail('action_forbidden', 'Sharing with everyone needs views.share for all regions; choose roles, groups or users.'); END IF;
  END IF;
  DELETE FROM public.saved_view_targets WHERE view_id = p_view;
  UPDATE public.saved_views SET share_everyone = everyone WHERE id = p_view;
  FOREACH k IN ARRAY ARRAY['role', 'group', 'user'] LOOP
    BEGIN
      SELECT coalesce(array_agg(DISTINCT x::uuid), ARRAY[]::uuid[]) INTO ids FROM jsonb_array_elements_text(coalesce(p_aud -> (k || '_ids'), '[]')) x;
    EXCEPTION WHEN invalid_text_representation THEN
      PERFORM public.sv_fail('validation_failed', 'An audience id is not valid.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k || '_ids', 'code', 'invalid'))));
    END;
    FOREACH i IN ARRAY ids LOOP
      IF k = 'user' AND i = v.owner_id THEN CONTINUE; END IF;
      IF (k = 'role' AND NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = i AND r.is_active))
         OR (k = 'group' AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = i AND g.is_active))
         OR (k = 'user' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = i AND u.status = 'active' AND u.deleted_at IS NULL)) THEN
        PERFORM public.sv_fail('validation_failed', 'An audience entry does not exist or is not active.',
          jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k || '_ids', 'code', 'not_found', 'message', i::text))));
      END IF;
      INSERT INTO public.saved_view_targets (view_id, target_kind, target_id) VALUES (p_view, k, i);
    END LOOP;
  END LOOP;
END $$;

-- Validates the content fields of a view body (screen_key, name, filters, columns, sort).
CREATE OR REPLACE FUNCTION sv_check_body(p_body jsonb, p_create boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE k text; e jsonb;
BEGIN
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN PERFORM public.sv_fail('validation_failed', 'The body is not valid.'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('screen_key', 'name', 'filters', 'columns', 'sort', 'audience') OR (k = 'screen_key' AND NOT p_create) THEN
      PERFORM public.sv_fail('validation_failed', 'Unknown field.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'unknown_field'))));
    END IF;
  END LOOP;
  IF p_create AND (p_body ->> 'screen_key' IS NULL OR public.sv_screen_module(p_body ->> 'screen_key') IS NULL) THEN
    PERFORM public.sv_fail('validation_failed', 'Not a list screen with saved views.', '{"errors":[{"path":"/screen_key","code":"invalid"}]}');
  END IF;
  IF (p_create OR p_body ? 'name') AND (jsonb_typeof(p_body -> 'name') IS DISTINCT FROM 'string' OR length(btrim(p_body ->> 'name')) NOT BETWEEN 1 AND 120) THEN
    PERFORM public.sv_fail('validation_failed', 'A name of 1 to 120 characters is required.', '{"errors":[{"path":"/name","code":"invalid"}]}');
  END IF;
  IF p_body ? 'filters' AND (jsonb_typeof(p_body -> 'filters') <> 'object' OR length((p_body -> 'filters')::text) > 16000) THEN
    PERFORM public.sv_fail('validation_failed', 'The filters are not valid.', '{"errors":[{"path":"/filters","code":"invalid"}]}');
  END IF;
  IF p_body ? 'columns' AND (jsonb_typeof(p_body -> 'columns') <> 'object' OR length((p_body -> 'columns')::text) > 16000) THEN
    PERFORM public.sv_fail('validation_failed', 'The columns are not valid.', '{"errors":[{"path":"/columns","code":"invalid"}]}');
  END IF;
  IF p_body ? 'sort' THEN
    IF jsonb_typeof(p_body -> 'sort') <> 'array' OR jsonb_array_length(p_body -> 'sort') > 5 THEN
      PERFORM public.sv_fail('validation_failed', 'The sort is not valid.', '{"errors":[{"path":"/sort","code":"invalid"}]}');
    END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_body -> 'sort') q(x) LOOP
      IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'id') IS DISTINCT FROM 'string' OR coalesce(e ->> 'dir', '') NOT IN ('asc', 'desc') THEN
        PERFORM public.sv_fail('validation_failed', 'The sort is not valid.', '{"errors":[{"path":"/sort","code":"invalid"}]}');
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Entry points of the API (granted to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
-- Views of a screen the actor may see: their own (p_scope 'mine'), those shared with them ('shared'), both ('all', default), or, for
-- views.manage, every shared view of the screen whose owner left ('orphaned'). Inactive views only of the actor's own (p_inactive).
CREATE OR REPLACE FUNCTION sv_list(p_screen text, p_scope text DEFAULT 'all', p_inactive boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); sc text := coalesce(p_scope, 'all');
BEGIN
  IF sc NOT IN ('all', 'mine', 'shared', 'orphaned') THEN PERFORM public.sv_fail('validation_failed', 'Unknown scope.', '{"errors":[{"path":"/scope","code":"invalid"}]}'); END IF;
  IF p_screen IS NOT NULL AND public.sv_screen_module(p_screen) IS NULL THEN
    PERFORM public.sv_fail('validation_failed', 'Not a list screen with saved views.', '{"errors":[{"path":"/screen_key","code":"invalid"}]}');
  END IF;
  IF sc = 'orphaned' THEN
    IF NOT public.sv_is_manager() THEN PERFORM public.sv_fail('action_forbidden', 'Only views.manage lists the views whose owner left.'); END IF;
    RETURN coalesce((SELECT jsonb_agg(public.sv_dto(v.id) ORDER BY v.screen_key COLLATE "C", v.id)
      FROM public.saved_views v JOIN public.users u ON u.id = v.owner_id
      WHERE (p_screen IS NULL OR v.screen_key = p_screen) AND v.is_active AND public.sv_is_shared(v.id) AND (u.status <> 'active' OR u.deleted_at IS NOT NULL)), '[]'::jsonb);
  END IF;
  RETURN coalesce((SELECT jsonb_agg(public.sv_dto(v.id) ORDER BY (v.owner_id = a) DESC, lower(v.name) COLLATE "C", v.id)
    FROM public.saved_views v
    WHERE (p_screen IS NULL OR v.screen_key = p_screen)
      AND ((sc IN ('all', 'mine') AND v.owner_id = a AND (v.is_active OR coalesce(p_inactive, false)))
        OR (sc IN ('all', 'shared') AND v.owner_id <> a AND v.is_active AND public.sv_can_read(v.id, a)))), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION sv_get(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  IF NOT (public.sv_can_read(p_view, a) OR (public.sv_is_shared(p_view) AND public.sv_is_manager() AND EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view))) THEN
    PERFORM public.sv_fail('not_found', 'The view does not exist or is not visible to you.');
  END IF;
  RETURN public.sv_dto(p_view);
END $$;

-- Create (p_view NULL) or edit. Body: screen_key (create only), name, filters, columns, sort, audience. p_version NULL = any version.
CREATE OR REPLACE FUNCTION sv_save(p_view uuid, p_version integer, p_body jsonb, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE; nid uuid; before jsonb; scr text; nm text;
BEGIN
  PERFORM public.sv_check_body(p_body, p_view IS NULL);
  IF p_view IS NULL THEN
    scr := p_body ->> 'screen_key'; nm := btrim(p_body ->> 'name');
    IF NOT public.sv_module_ok(scr, a) THEN PERFORM public.sv_fail('action_forbidden', 'You cannot open this screen.'); END IF;
    IF (SELECT count(*) FROM public.saved_views x WHERE x.owner_id = a AND x.screen_key = scr AND x.is_active) >= 50 THEN
      PERFORM public.sv_fail('validation_failed', 'At most 50 active views per screen.', '{"errors":[{"path":"/name","code":"too_many"}]}');
    END IF;
    IF EXISTS (SELECT 1 FROM public.saved_views x WHERE x.owner_id = a AND x.screen_key = scr AND x.is_active AND lower(x.name) = lower(nm)) THEN
      PERFORM public.sv_fail('duplicate', 'You already have a view with this name on this screen.');
    END IF;
    INSERT INTO public.saved_views (owner_id, screen_key, name, filters, columns, sort, created_by, updated_by)
    VALUES (a, scr, nm, coalesce(p_body -> 'filters', '{}'), coalesce(p_body -> 'columns', '{}'), coalesce(p_body -> 'sort', '[]'), a, a)
    RETURNING id INTO nid;
    PERFORM public.sv_set_audience(nid, p_body -> 'audience');
    PERFORM public.sv_record(nid, 'create', NULL, p_reason);
    RETURN public.sv_dto(nid);
  END IF;
  v := public.sv_for_change(p_view, p_version);
  IF NOT v.is_active THEN PERFORM public.sv_fail('invalid_transition', 'Restore the view before changing it.'); END IF;
  IF v.owner_id <> a AND length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.sv_fail('validation_failed', 'A reason is required to change somebody else''s view.', '{"errors":[{"path":"/reason","code":"required"}]}');
  END IF;
  nm := coalesce(btrim(p_body ->> 'name'), v.name);
  IF lower(nm) <> lower(v.name) AND EXISTS (SELECT 1 FROM public.saved_views x WHERE x.owner_id = v.owner_id AND x.screen_key = v.screen_key AND x.is_active AND x.id <> v.id AND lower(x.name) = lower(nm)) THEN
    PERFORM public.sv_fail('duplicate', 'The owner already has a view with this name on this screen.');
  END IF;
  before := public.sv_snapshot(v.id);
  UPDATE public.saved_views SET name = nm, filters = coalesce(p_body -> 'filters', filters), columns = coalesce(p_body -> 'columns', columns),
    sort = coalesce(p_body -> 'sort', sort), version = version + 1, updated_at = now(), updated_by = a
  WHERE id = v.id;
  PERFORM public.sv_set_audience(v.id, p_body -> 'audience');
  PERFORM public.sv_record(v.id, 'edit', before, p_reason);
  RETURN public.sv_dto(v.id);
END $$;

-- Deactivate (p_active false) or restore (true). Never a delete.
CREATE OR REPLACE FUNCTION sv_set_active(p_view uuid, p_version integer, p_active boolean, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE; before jsonb;
BEGIN
  IF p_active IS NULL THEN PERFORM public.sv_fail('validation_failed', 'active is required.'); END IF;
  v := public.sv_for_change(p_view, p_version);
  IF v.is_active = p_active THEN PERFORM public.sv_fail('invalid_transition', CASE WHEN p_active THEN 'The view is already active.' ELSE 'The view is already deactivated.' END); END IF;
  IF v.owner_id <> a AND length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.sv_fail('validation_failed', 'A reason is required to change somebody else''s view.', '{"errors":[{"path":"/reason","code":"required"}]}');
  END IF;
  IF p_active AND EXISTS (SELECT 1 FROM public.saved_views x WHERE x.owner_id = v.owner_id AND x.screen_key = v.screen_key AND x.is_active AND x.id <> v.id AND lower(x.name) = lower(v.name)) THEN
    PERFORM public.sv_fail('duplicate', 'An active view with this name exists on this screen; rename it first.');
  END IF;
  before := public.sv_snapshot(v.id);
  UPDATE public.saved_views SET is_active = p_active, deactivated_at = CASE WHEN p_active THEN NULL ELSE now() END,
    deactivated_by = CASE WHEN p_active THEN NULL ELSE a END, version = version + 1, updated_at = now(), updated_by = a
  WHERE id = v.id;
  PERFORM public.sv_record(v.id, CASE WHEN p_active THEN 'restore' ELSE 'deactivate' END, before, p_reason);
  RETURN public.sv_dto(v.id);
END $$;

-- Moves a shared view to another owner (the owner hands it over, or views.manage when its creator left). The new owner must be active and
-- hold views.share. A private view is never handed to someone else.
CREATE OR REPLACE FUNCTION sv_transfer(p_view uuid, p_version integer, p_owner uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); v public.saved_views%ROWTYPE; before jsonb;
BEGIN
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.sv_fail('validation_failed', 'A reason is required.', '{"errors":[{"path":"/reason","code":"required"}]}');
  END IF;
  v := public.sv_for_change(p_view, p_version);
  IF NOT public.sv_is_shared(v.id) THEN PERFORM public.sv_fail('invalid_transition', 'A private view is not handed over.'); END IF;
  IF p_owner IS NULL OR p_owner = v.owner_id THEN
    PERFORM public.sv_fail('validation_failed', 'Choose another owner.', '{"errors":[{"path":"/owner_id","code":"invalid"}]}');
  END IF;
  IF public.sv_share_scope(p_owner) = 'none' THEN
    PERFORM public.sv_fail('validation_failed', 'The new owner must be an active user who holds views.share.', '{"errors":[{"path":"/owner_id","code":"not_eligible"}]}');
  END IF;
  before := public.sv_snapshot(v.id);
  DELETE FROM public.saved_view_targets WHERE view_id = v.id AND target_kind = 'user' AND target_id = p_owner;
  UPDATE public.saved_views SET owner_id = p_owner, version = version + 1, updated_at = now(), updated_by = a WHERE id = v.id;
  PERFORM public.sv_record(v.id, 'transfer', before, p_reason);
  RETURN public.sv_dto(v.id);
END $$;

-- The version history of a view (owner, or views.manage on a shared view).
CREATE OR REPLACE FUNCTION sv_versions(p_view uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND (v.owner_id = a OR (public.sv_is_shared(v.id) AND public.sv_is_manager()))) THEN
    PERFORM public.sv_fail('not_found', 'The view does not exist or is not visible to you.');
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('version', x.version, 'change', x.change, 'snapshot', x.snapshot, 'reason', x.reason,
      'changed_by', CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', btrim(u.employee_id)) END,
      'changed_at', public.sv_ts(x.changed_at)) ORDER BY x.version DESC)
    FROM public.saved_view_versions x LEFT JOIN public.users u ON u.id = x.changed_by WHERE x.view_id = p_view), '[]'::jsonb);
END $$;

-- First use of a screen: the browser hands over the views it kept locally (items: [{local_id, name, filters, columns, sort}]). Each becomes a
-- private view of the actor. Idempotent: an item already imported (same local_id) is skipped; a name already used gets " (2)", " (3)" ...
CREATE OR REPLACE FUNCTION sv_import(p_screen text, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); it jsonb; ref text; nm text; base text; n int; nid uuid; done jsonb := '[]'::jsonb; skipped int := 0; imported int := 0;
BEGIN
  IF public.sv_screen_module(p_screen) IS NULL THEN
    PERFORM public.sv_fail('validation_failed', 'Not a list screen with saved views.', '{"errors":[{"path":"/screen_key","code":"invalid"}]}');
  END IF;
  IF NOT public.sv_module_ok(p_screen, a) THEN PERFORM public.sv_fail('action_forbidden', 'You cannot open this screen.'); END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 50 THEN
    PERFORM public.sv_fail('validation_failed', 'At most 50 items.', '{"errors":[{"path":"/items","code":"invalid"}]}');
  END IF;
  FOR it IN SELECT x FROM jsonb_array_elements(p_items) q(x) LOOP
    IF jsonb_typeof(it) <> 'object' OR jsonb_typeof(it -> 'local_id') IS DISTINCT FROM 'string' OR length(it ->> 'local_id') NOT BETWEEN 1 AND 100 THEN
      PERFORM public.sv_fail('validation_failed', 'Every item needs a local_id.', '{"errors":[{"path":"/items","code":"invalid"}]}');
    END IF;
    PERFORM public.sv_check_body(jsonb_build_object('name', it -> 'name') || (it - 'local_id' - 'name'), false);
    ref := p_screen || ':' || (it ->> 'local_id');
    IF EXISTS (SELECT 1 FROM public.saved_views x WHERE x.owner_id = a AND x.local_ref = ref) THEN skipped := skipped + 1; CONTINUE; END IF;
    base := left(btrim(it ->> 'name'), 110); nm := base; n := 1;
    WHILE EXISTS (SELECT 1 FROM public.saved_views x WHERE x.owner_id = a AND x.screen_key = p_screen AND x.is_active AND lower(x.name) = lower(nm)) LOOP
      n := n + 1; nm := base || ' (' || n || ')';
    END LOOP;
    IF (SELECT count(*) FROM public.saved_views x WHERE x.owner_id = a AND x.screen_key = p_screen AND x.is_active) >= 50 THEN skipped := skipped + 1; CONTINUE; END IF;
    INSERT INTO public.saved_views (owner_id, screen_key, name, filters, columns, sort, local_ref, created_by, updated_by)
    VALUES (a, p_screen, nm, coalesce(it -> 'filters', '{}'), coalesce(it -> 'columns', '{}'), coalesce(it -> 'sort', '[]'), ref, a, a)
    RETURNING id INTO nid;
    PERFORM public.sv_record(nid, 'import', NULL, 'imported from the browser');
    imported := imported + 1;
    done := done || jsonb_build_array(public.sv_dto(nid));
  END LOOP;
  RETURN jsonb_build_object('imported', imported, 'skipped', skipped, 'items', done);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership moves when the creator leaves (Q117): to the active direct manager, else the view keeps a "owner left" flag.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_owner_left() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; mgr uuid; before jsonb;
BEGIN
  IF NOT (OLD.status = 'active' AND OLD.deleted_at IS NULL AND (NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL)) THEN RETURN NULL; END IF;
  SELECT u.id INTO mgr FROM public.users u WHERE u.id = NEW.manager_id AND u.status = 'active' AND u.deleted_at IS NULL;
  IF mgr IS NULL THEN RETURN NULL; END IF;
  FOR r IN SELECT v.id FROM public.saved_views v WHERE v.owner_id = NEW.id AND v.is_active AND public.sv_is_shared(v.id) ORDER BY v.id LOOP
    before := public.sv_snapshot(r.id);
    DELETE FROM public.saved_view_targets WHERE view_id = r.id AND target_kind = 'user' AND target_id = mgr;
    UPDATE public.saved_views SET owner_id = mgr, version = version + 1, updated_at = now() WHERE id = r.id;
    PERFORM public.sv_record(r.id, 'owner_left', before, 'owner left: moved to the direct manager');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER zz_saved_views_owner_left AFTER UPDATE OF status, deleted_at ON users FOR EACH ROW EXECUTE FUNCTION sv_owner_left();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Drafts (Q115): the user's own, on the server; never a submission, an approval or an input of a calculation.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dr_retention_days() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(s.value) = 'number' AND (s.value #>> '{}')::numeric BETWEEN 1 AND 365 THEN (s.value #>> '{}')::numeric::int END
                     FROM public.settings s WHERE s.key = 'drafts.retention_days'), 30)
$$;

CREATE OR REPLACE FUNCTION dr_dto(d public.user_drafts, p_payload boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('key', d.draft_key, 'version', d.version, 'saved_at', public.sv_ts(d.saved_at), 'created_at', public.sv_ts(d.created_at),
    'expires_at', public.sv_ts(d.saved_at + make_interval(days => public.dr_retention_days())))
    || CASE WHEN p_payload THEN jsonb_build_object('payload', d.payload) ELSE '{}'::jsonb END
$$;

CREATE OR REPLACE FUNCTION dr_get(p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); d public.user_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.user_drafts WHERE user_id = a AND draft_key = p_key AND saved_at > now() - make_interval(days => public.dr_retention_days());
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN public.dr_dto(d, true);
END $$;

-- p_base: the version the browser last saw (NULL = first save of this form); another tab's newer save answers precondition_failed.
CREATE OR REPLACE FUNCTION dr_save(p_key text, p_payload jsonb, p_base integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); d public.user_drafts%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p_key !~ '^(task|record|form)\.[A-Za-z0-9_.-]{1,200}$' THEN
    PERFORM public.sv_fail('validation_failed', 'The draft key is not valid.', '{"errors":[{"path":"/key","code":"invalid"}]}');
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR length(p_payload::text) > 65536 THEN
    PERFORM public.sv_fail('validation_failed', 'The draft is not valid or larger than 64 KB.', '{"errors":[{"path":"/payload","code":"invalid"}]}');
  END IF;
  DELETE FROM public.user_drafts WHERE user_id = a AND saved_at <= now() - make_interval(days => public.dr_retention_days());
  SELECT * INTO d FROM public.user_drafts WHERE user_id = a AND draft_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF p_base IS NOT NULL AND p_base <> d.version THEN
      PERFORM public.sv_fail('precondition_failed', 'This draft was saved from another window. Reload it first.');
    END IF;
    UPDATE public.user_drafts SET payload = p_payload, version = version + 1, saved_at = now() WHERE id = d.id RETURNING * INTO d;
  ELSE
    IF (SELECT count(*) FROM public.user_drafts x WHERE x.user_id = a) >= 200 THEN
      PERFORM public.sv_fail('validation_failed', 'At most 200 drafts; discard some first.', '{"errors":[{"path":"/key","code":"too_many"}]}');
    END IF;
    INSERT INTO public.user_drafts (user_id, draft_key, payload) VALUES (a, p_key, p_payload) RETURNING * INTO d;
  END IF;
  RETURN public.dr_dto(d, false);
END $$;

CREATE OR REPLACE FUNCTION dr_discard(p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  DELETE FROM public.user_drafts WHERE user_id = a AND draft_key = p_key;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION dr_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(public.dr_dto(d, false) ORDER BY d.saved_at DESC, d.id) FROM public.user_drafts d
    WHERE d.user_id = a AND d.saved_at > now() - make_interval(days => public.dr_retention_days())), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and rights. Everything runs as pmis_definer; pmis_app calls only the entry points and reads its own rows.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON saved_views, user_drafts TO pmis_definer;
GRANT DELETE ON user_drafts TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON saved_view_targets TO pmis_definer;
GRANT SELECT, INSERT ON saved_view_versions TO pmis_definer;
GRANT SELECT ON register_definitions, register_fields, field_definitions, roles, groups, group_members, users, settings, permission_profiles,
  permission_grants, user_role_assignments, user_role_assignment_profiles, delegations TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'sv\_%' OR p.proname LIKE 'dr\_%')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    IF f.proname NOT IN ('sv_versions_append_only', 'sv_ts') THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION sv_list(text, text, boolean), sv_get(uuid), sv_save(uuid, integer, jsonb, text), sv_set_active(uuid, integer, boolean, text),
      sv_transfer(uuid, integer, uuid, text), sv_versions(uuid), sv_import(text, jsonb), sv_share_scope(uuid), sv_is_manager(), sv_screen_module(text),
      dr_get(text), dr_save(text, jsonb, integer), dr_discard(text), dr_list(), dr_retention_days() TO pmis_app;
    -- read only, own rows (row security): every write goes through the functions above
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON saved_views, saved_view_targets, saved_view_versions, user_drafts FROM pmis_app;
    GRANT SELECT ON saved_views, saved_view_targets, saved_view_versions, user_drafts TO pmis_app;
  END IF;
END $$;
