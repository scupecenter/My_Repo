-- 0015_workflow_engine: the approval engine (Entry -> Review -> Approve) in the database. Mirror: db/sql/014_workflow_engine.sql (kept identical).
--
-- Why in the database: pmis_app is read-mostly (CLAUDE.md, ADR 0003 item 7). Every write of the engine goes through the
-- wf_* SECURITY DEFINER functions below (owner pmis_definer, BYPASSRLS). Each function takes the actor from app_actor() (never
-- from an argument), checks region and module scope itself (the definer bypasses RLS), locks the task row, checks the
-- If-Match version, applies one transition, writes workflow_steps and audit_log (before and after values) in the same
-- transaction and bumps the version. Errors are raised as P0001 with the message  wf:<code>:<json>  that the API maps to a
-- problem (404 not_found, 412 precondition_failed, 409 already_claimed, 422 note_required ...).
--
-- Rules implemented (CLAUDE.md "Workflow rules", ADR 0004, gate report B5, B6, B7, B10):
--   * path snapshot (B7): levels_required and path_frozen_at are set at the FIRST submission and never change afterwards;
--     before it the live level count of the task/stage is used.
--   * holders: matrix cell (most specific: task+region > task > stage+region > stage) expanded to people (users; roles through
--     active assignment rows of enough level that include the site's region and module `sites`; active groups), all of them
--     active and in scope. Matrix level 1 = entry, 2 = review, 3 = approve whatever the number of levels of the task.
--   * auto-skip: after a person completes level L the next level is skipped when they are an eligible holder of it (rule
--     any_one); each skip is a workflow_steps row (auto_skip) and an audit row. Reaching the final level this way is a
--     self-approval (B5): flagged on the steps, on the task and in the audit, and needs step-up.
--   * rejection (B6): back one level with a mandatory note; if that level was skipped, to the level where the same person last
--     ACTED, pinned to that person (ball_in_court_user_id) while they are still eligible.
--   * no holder (B10): a level with no eligible holder is never skipped; System Admins are notified and may act on it.
--   * groups: any_one = claim / first action pins the task to one member; all_members = every member at the moment the level
--     opened must vote (task_level_voters), one rejection rejects the task.
--
-- Contents: 1 enum values  2 columns  3 streams (owner decision 2026-10-29)  4 new tables  5 backstops and grants
--           6 resolvers  7 transitions  8 ownership and execute rights.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Enum values (used only inside function bodies, so the same transaction may add and reference them)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TYPE "WorkflowAction" ADD VALUE IF NOT EXISTS 'start';
ALTER TYPE "WorkflowAction" ADD VALUE IF NOT EXISTS 'review';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN path_frozen_at   TIMESTAMPTZ(6),                -- B7: set at the first submission; levels_required is final from then on
  ADD COLUMN level_round      INTEGER NOT NULL DEFAULT 0,    -- counts how often a level was opened (all_members votes belong to a round)
  ADD COLUMN level_opened_at  TIMESTAMPTZ(6),                -- "waiting since" of the inbox
  ADD COLUMN return_count     INTEGER NOT NULL DEFAULT 0,    -- rejections so far (first-time approval KPI)
  ADD COLUMN last_return_note TEXT,
  ADD COLUMN self_approval    BOOLEAN NOT NULL DEFAULT false;-- B5: approved through a self-skip chain, or a single-level task
-- ball_in_court_user_id is the person the current level is pinned to: the claimant of a group level, or the person a
-- rejection returned the task to (B6). NULL = whoever the matrix cell resolves to.
COMMENT ON COLUMN task_instances.levels_required IS 'Number of levels (1..3). Final once path_frozen_at is set (first submission, B7); before that the API shows the live value of the task or stage.';

ALTER TABLE workflow_steps ADD COLUMN self_approval BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Streams (owner decision 2026-10-29): a stream groups stages for the Site Register sub-sections. Versioned with the workflow.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE workflow_streams (
  workflow_id UUID    NOT NULL REFERENCES workflow_definitions (id) ON DELETE CASCADE ON UPDATE CASCADE,
  code        TEXT    NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name_en     TEXT    NOT NULL,
  name_ar     TEXT,
  sort_order  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, code)
);
CREATE UNIQUE INDEX workflow_streams_workflow_id_sort_order_key ON workflow_streams (workflow_id, sort_order);

ALTER TABLE stage_definitions ADD COLUMN stream_code TEXT;
ALTER TABLE stage_definitions ADD CONSTRAINT stage_definitions_workflow_id_stream_code_fkey
  FOREIGN KEY (workflow_id, stream_code) REFERENCES workflow_streams (workflow_id, code) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX stage_definitions_stream_idx ON stage_definitions (workflow_id, stream_code);

-- A new draft version starts with the streams of the previous version, and a new stage takes the stream of the stage with the
-- same code in the previous version (admin_create_workflow_draft copies stages column by column and knows nothing of streams).
CREATE OR REPLACE FUNCTION workflow_streams_inherit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.workflow_streams (workflow_id, code, name_en, name_ar, sort_order)
    SELECT NEW.id, s.code, s.name_en, s.name_ar, s.sort_order
    FROM public.workflow_streams s
    WHERE s.workflow_id = (SELECT w.id FROM public.workflow_definitions w WHERE w.version < NEW.version ORDER BY w.version DESC LIMIT 1);
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_streams_inherit AFTER INSERT ON workflow_definitions FOR EACH ROW EXECUTE FUNCTION workflow_streams_inherit();

CREATE OR REPLACE FUNCTION stage_stream_inherit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.stream_code IS NULL THEN
    SELECT p.stream_code INTO NEW.stream_code
    FROM public.stage_definitions p JOIN public.workflow_definitions pw ON pw.id = p.workflow_id
    WHERE p.code = NEW.code AND pw.version < (SELECT w.version FROM public.workflow_definitions w WHERE w.id = NEW.workflow_id)
      AND EXISTS (SELECT 1 FROM public.workflow_streams x WHERE x.workflow_id = NEW.workflow_id AND x.code = p.stream_code)
    ORDER BY pw.version DESC LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_stream_inherit BEFORE INSERT ON stage_definitions FOR EACH ROW EXECUTE FUNCTION stage_stream_inherit();

-- Configuration table: everyone reads, writes need workflow_versions rights (same as stage_definitions, 008).
ALTER TABLE workflow_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON workflow_streams FOR SELECT USING (true);
CREATE POLICY rls_insert ON workflow_streams FOR INSERT WITH CHECK (app_can('workflow_versions', 'create') OR app_is_seeding());
CREATE POLICY rls_update ON workflow_streams FOR UPDATE USING (app_can('workflow_versions', 'edit') OR app_is_seeding()) WITH CHECK (app_can('workflow_versions', 'edit') OR app_is_seeding());
CREATE POLICY rls_delete ON workflow_streams FOR DELETE USING (app_can('workflow_versions', 'delete') OR app_is_seeding());

-- Seed: default streams for every existing version (owner decision 2026-10-29). Names in Arabic are proposals.
INSERT INTO workflow_streams (workflow_id, code, name_en, name_ar, sort_order)
SELECT w.id, v.code, v.name_en, v.name_ar, v.sort_order
FROM workflow_definitions w
CROSS JOIN (VALUES
  ('DESIGN_ACQ', 'Design & Acquisition', 'التصميم والاستحواذ', 1),
  ('CW',         'Civil Works',          'الأعمال المدنية',     2),
  ('TE',         'Installation',         'التركيب',             3),
  ('CLOSURE',    'Handover & Closure',   'التسليم والإغلاق',    4)
) AS v(code, name_en, name_ar, sort_order)
ON CONFLICT (workflow_id, code) DO NOTHING;

UPDATE stage_definitions SET stream_code = CASE
    WHEN seq = 1 THEN 'DESIGN_ACQ'
    WHEN seq BETWEEN 2 AND 4 THEN 'CW'
    WHEN seq BETWEEN 5 AND 8 THEN 'TE'
    ELSE 'CLOSURE' END
WHERE stream_code IS NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. New tables
-- ---------------------------------------------------------------------------------------------------------------------
-- Who handled each level in the current pass: 'acted' (a real submit / review / approve) or 'skipped' (auto-skip by the same
-- person). Decides where a rejection goes (B6). Rows from the returned level upwards are removed on rejection.
CREATE TABLE task_level_actors (
  task_id  UUID        NOT NULL REFERENCES task_instances (id) ON DELETE CASCADE ON UPDATE CASCADE,
  level    INTEGER     NOT NULL,
  user_id  UUID        NOT NULL,
  how      TEXT        NOT NULL CHECK (how IN ('acted', 'skipped')),
  acted_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, level)
);
-- Members who must vote at a level under the rule all_members, fixed when the level opens (ADR 0004 section 7).
CREATE TABLE task_level_voters (
  task_id  UUID    NOT NULL REFERENCES task_instances (id) ON DELETE CASCADE ON UPDATE CASCADE,
  level    INTEGER NOT NULL,
  round    INTEGER NOT NULL,
  user_id  UUID    NOT NULL,
  voted_at TIMESTAMPTZ(6),
  PRIMARY KEY (task_id, level, round, user_id)
);
CREATE TABLE comment_mentions (
  comment_id UUID NOT NULL REFERENCES comments (id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id    UUID NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX task_level_voters_user_idx ON task_level_voters (user_id);

-- Read follows the parent task / comment (which RLS already filters by region); nobody but the definer writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_level_actors', 'task_level_voters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id))', t);
  END LOOP;
  ALTER TABLE comment_mentions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE comment_mentions FORCE ROW LEVEL SECURITY;
  CREATE POLICY rls_select ON comment_mentions FOR SELECT USING (EXISTS (SELECT 1 FROM comments p WHERE p.id = comment_id));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Backstop and grants: only the wf_* functions (owner pmis_definer) and the migration role write the workflow tables.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_definer' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION '% is written only through wf_* functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON task_instances FOR EACH ROW EXECUTE FUNCTION wf_backstop();
CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON workflow_steps FOR EACH ROW EXECUTE FUNCTION wf_backstop();
CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON comments FOR EACH ROW EXECUTE FUNCTION wf_backstop();

GRANT SELECT, INSERT, UPDATE, DELETE ON task_level_actors, task_level_voters, comment_mentions, workflow_streams TO pmis_definer;
GRANT SELECT, UPDATE, INSERT ON task_instances TO pmis_definer;
GRANT SELECT, INSERT ON workflow_steps, comments, notifications TO pmis_definer;
GRANT SELECT, UPDATE ON document_slots, document_files TO pmis_definer;
GRANT SELECT ON sites, users, groups, group_members, roles, user_role_assignments, user_role_assignment_regions, user_role_assignment_modules,
  user_role_assignment_profiles, permission_profiles, permission_grants, delegations, delegation_grants, delegation_regions,
  matrix_cells, matrix_cell_assignees, task_definitions, stage_definitions, task_predecessors, snags, snag_types,
  document_types, document_type_placements TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON task_instances, workflow_steps, comments, task_level_actors, task_level_voters, comment_mentions FROM pmis_app;
    GRANT SELECT ON task_level_actors, task_level_voters, comment_mentions, workflow_streams TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Resolvers
-- ---------------------------------------------------------------------------------------------------------------------
-- Error with a code the API understands.
CREATE OR REPLACE FUNCTION wf_err(p_code text, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RAISE EXCEPTION 'wf:%:%', p_code, p_extra::text USING ERRCODE = 'P0001'; END $$;

-- Regions in which the caller holds (module, action), judged tuple by tuple (decision B3: each assignment is limited to its own
-- regions and modules; scopes never cross). NULL = every region (System Admin, or an all-regions assignment or delegation);
-- an empty array = none.
CREATE OR REPLACE FUNCTION wf_actor_regions(p_module text, p_action "PermissionAction") RETURNS int[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); allr boolean; regs int[];
BEGIN
  IF a IS NULL THEN RETURN ARRAY[]::int[]; END IF;
  IF public.app_user_is_system_admin(a) THEN RETURN NULL; END IF;
  WITH act AS (
    SELECT ua.id, ua.all_regions FROM public.user_role_assignments ua
    WHERE ua.user_id = a AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
      AND EXISTS (SELECT 1 FROM public.user_role_assignment_profiles ap
                  JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
                  JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = p_action
                  WHERE ap.assignment_id = ua.id AND (p_module = g.module_key OR p_module LIKE g.module_key || '.%')
                    AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m
                                                   WHERE m.assignment_id = ua.id AND m.module_key = split_part(g.module_key, '.', 1))))
  ), del AS (
    SELECT d.id, d.all_regions FROM public.app_user_delegations(a) x(id) JOIN public.delegations d ON d.id = x.id
    WHERE public.deleg_covers(d.id, p_module, p_action)
  )
  SELECT EXISTS (SELECT 1 FROM act WHERE act.all_regions) OR EXISTS (SELECT 1 FROM del WHERE del.all_regions),
         coalesce((SELECT array_agg(DISTINCT q.r) FROM (
                     SELECT ar.region_id AS r FROM public.user_role_assignment_regions ar JOIN act ON act.id = ar.assignment_id
                     UNION SELECT dr.region_id FROM public.delegation_regions dr JOIN del ON del.id = dr.delegation_id) q), ARRAY[]::int[])
  INTO allr, regs;
  IF allr THEN RETURN NULL; END IF;
  RETURN regs;
END $$;

-- Is the user active and able to see sites of this region in the Sites module (any of their assignments, or a System Admin)?
CREATE OR REPLACE FUNCTION wf_user_in_scope(p_user uuid, p_region int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass)
     AND (public.app_user_is_system_admin(p_user)
          OR EXISTS (SELECT 1 FROM public.user_role_assignments ua
                     WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                       AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
                       AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = 'sites'))))
$$;

CREATE OR REPLACE FUNCTION wf_kind(p_levels int, p_level int) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_level <= 1 THEN 'entry' WHEN p_level >= p_levels THEN 'approve' ELSE 'review' END $$;

-- The live number of levels of a task: its own setting, else its stage's (1..3). Used until the first submission (B7).
CREATE OR REPLACE FUNCTION wf_levels_live(p_task uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT least(greatest(coalesce(td.approval_levels, st.approval_levels), 1), 3)
  FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id JOIN public.stage_definitions st ON st.id = td.stage_id
  WHERE t.id = p_task
$$;

CREATE OR REPLACE FUNCTION wf_task_levels(p_task uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN t.path_frozen_at IS NULL THEN public.wf_levels_live(t.id) ELSE t.levels_required END FROM public.task_instances t WHERE t.id = p_task
$$;

-- The matrix cell that decides a level for a task: task+region > task > stage+region > stage (ADR 0004 section 4).
CREATE OR REPLACE FUNCTION wf_cell(p_task uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id
  FROM public.task_instances t
  JOIN public.task_definitions td ON td.id = t.task_def_id
  JOIN public.matrix_cells c ON c.stage_id = td.stage_id
       AND c.level = CASE p_kind WHEN 'entry' THEN 1 WHEN 'review' THEN 2 ELSE 3 END
       AND (c.task_def_id IS NULL OR c.task_def_id = td.id)
       AND (c.region_id IS NULL OR c.region_id = t.region_id)
  WHERE t.id = p_task AND public.app_region_check(t.region_id)
  ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION wf_rule(p_task uuid, p_kind text) RETURNS "MatrixRule"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_kind = 'entry' THEN 'any_one'::"MatrixRule"
              ELSE coalesce((SELECT c.rule FROM public.matrix_cells c WHERE c.id = public.wf_cell(p_task, p_kind)), 'any_one'::"MatrixRule") END
$$;

-- The people who may act on a level (MX-02b): users; roles through assignment rows with enough level that include the site's
-- region and the module `sites`; active groups. Everybody active and in scope. via_group = a group that brought them in.
CREATE OR REPLACE FUNCTION wf_eligible(p_task uuid, p_kind text) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; cell uuid; need public."PermissionLevel";
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN RETURN; END IF;
  cell := public.wf_cell(p_task, p_kind);
  IF cell IS NULL THEN RETURN; END IF;
  need := p_kind::public."PermissionLevel";
  RETURN QUERY
  WITH ex AS (
    SELECT a.ref_id AS uid, NULL::uuid AS gid
      FROM public.matrix_cell_assignees a WHERE a.cell_id = cell AND a.kind = 'user'
    UNION ALL
    SELECT ua.user_id, NULL::uuid
      FROM public.matrix_cell_assignees a
      JOIN public.roles r ON r.id = a.ref_id AND r.is_active AND r.can_hold_matrix_levels
      JOIN public.user_role_assignments ua ON ua.role_id = r.id
      WHERE a.cell_id = cell AND a.kind = 'role'
        AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
        AND ua.permission_level >= need
        AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rr WHERE rr.assignment_id = ua.id AND rr.region_id = t.region_id))
        AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules mm WHERE mm.assignment_id = ua.id AND mm.module_key = 'sites'))
    UNION ALL
    SELECT gm.user_id, g.id
      FROM public.matrix_cell_assignees a
      JOIN public.groups g ON g.id = a.ref_id AND g.is_active
      JOIN public.group_members gm ON gm.group_id = g.id
      WHERE a.cell_id = cell AND a.kind = 'group'
  )
  SELECT ex.uid, (array_agg(ex.gid) FILTER (WHERE ex.gid IS NOT NULL))[1]
  FROM ex
  WHERE public.wf_user_in_scope(ex.uid, t.region_id)
  GROUP BY ex.uid;
END $$;

CREATE OR REPLACE FUNCTION wf_is_eligible(p_task uuid, p_kind text, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.wf_eligible(p_task, p_kind) e WHERE e.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION wf_has_holder(p_task uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.wf_eligible(p_task, p_kind))
$$;

-- Where the task lands when `p_actor` completes level p_from: the next level that really needs somebody, the levels skipped
-- on the way (same holder, rule any_one), and whether the chain reaches the final level (B5). Used by the transitions and
-- as the preview of the API (allowed_actions.will_skip_to, ApprovalItem.will_self_skip).
CREATE OR REPLACE FUNCTION wf_chain(p_task uuid, p_from int, p_actor uuid) RETURNS TABLE (next_level int, skipped int[], is_final boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int := public.wf_task_levels(p_task); lvl int := p_from; sk int[] := ARRAY[]::int[]; nxt int; k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id)) THEN RETURN; END IF;
  LOOP
    IF lvl >= n THEN RETURN QUERY SELECT NULL::int, sk, true; RETURN; END IF;
    nxt := lvl + 1;
    k := public.wf_kind(n, nxt);
    IF public.wf_rule(p_task, k) = 'any_one' AND public.wf_is_eligible(p_task, k, p_actor) THEN
      sk := sk || nxt;
      lvl := nxt;
    ELSE
      RETURN QUERY SELECT nxt, sk, false;
      RETURN;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Internals of the transitions
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_snap(p_task uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('state', t.state, 'current_level', t.current_level, 'levels_required', t.levels_required,
    'path_frozen', t.path_frozen_at IS NOT NULL, 'pinned_to', t.ball_in_court_user_id, 'actual_start', t.actual_start,
    'actual_date', t.actual_date, 'planned_date', t.planned_date, 'submitted_date', t.submitted_date, 'approved_date', t.approved_date,
    'return_count', t.return_count, 'self_approval', t.self_approval, 'version', t.version)
  FROM public.task_instances t WHERE t.id = p_task
$$;

CREATE OR REPLACE FUNCTION wf_audit(p_action text, p_task uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'task', p_task::text, t.site_id, t.region_id, p_before, p_after, p_reason, public.app_actor());
END $$;

CREATE OR REPLACE FUNCTION wf_step(p_task uuid, p_level int, p_action text, p_actor uuid, p_note text, p_before "TaskState", p_after "TaskState",
  p_stepup boolean, p_self boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid;
BEGIN
  -- clock_timestamp(): the steps of one transaction (a submit and its auto-skips) must keep their order in the history
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
  VALUES (p_task, p_level, p_action::public."WorkflowAction", p_actor, p_note, p_before, p_after, coalesce(p_stepup, false), coalesce(p_self, false), clock_timestamp())
  RETURNING id INTO sid;
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION wf_label(p_task uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.site_code || ' / ' || td.code || ' ' || td.name_en
  FROM public.task_instances t JOIN public.sites s ON s.id = t.site_id JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.id = p_task
$$;

CREATE OR REPLACE FUNCTION wf_notify(p_user uuid, p_kind text, p_title text, p_body text, p_task uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link) VALUES (p_user, 'in_app', p_kind, p_title, p_body, p_task, '/tasks/' || p_task::text)
$$;

CREATE OR REPLACE FUNCTION wf_notify_admins(p_kind text, p_title text, p_body text, p_task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
           JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND NOT x.is_break_glass LOOP
    PERFORM public.wf_notify(u, p_kind, p_title, p_body, p_task);
  END LOOP;
END $$;

-- Opens level p_level: state, current level, pin, round, voters; alerts the System Admins when nobody can act (B10).
CREATE OR REPLACE FUNCTION wf_open_level(p_task uuid, p_level int, p_pin uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; k text; st public."TaskState"; rl public."MatrixRule";
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  k := public.wf_kind(t.levels_required, p_level);
  st := CASE k WHEN 'entry' THEN 'entry' WHEN 'review' THEN 'in_review' ELSE 'in_approval' END;
  rl := public.wf_rule(p_task, k);
  UPDATE public.task_instances SET state = st, current_level = p_level, level_round = level_round + 1, level_opened_at = now(),
    ball_in_court_user_id = CASE WHEN rl = 'any_one' THEN p_pin END, updated_at = now()
  WHERE id = p_task;
  IF rl = 'all_members' THEN
    INSERT INTO public.task_level_voters (task_id, level, round, user_id)
      SELECT p_task, p_level, t.level_round + 1, e.user_id FROM public.wf_eligible(p_task, k) e;
  END IF;
  IF NOT public.wf_has_holder(p_task, k) THEN
    PERFORM public.wf_notify_admins('no_eligible_holder', 'No holder for a task level',
      public.wf_label(p_task) || ': nobody can act on the ' || k || ' level.', p_task);
  END IF;
END $$;

-- Successors whose predecessors are all approved (or N/A, skipped, or not on this site) go from locked to open.
CREATE OR REPLACE FUNCTION wf_unlock_successors(p_task uuid) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; s record; ids uuid[] := ARRAY[]::uuid[]; before jsonb; h record;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  FOR s IN
    SELECT si.id FROM public.task_predecessors tp
    JOIN public.task_instances si ON si.site_id = t.site_id AND si.task_def_id = tp.task_def_id AND si.state = 'locked'
    WHERE tp.predecessor_id = t.task_def_id
      AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p2
                      JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = p2.predecessor_id
                      WHERE p2.task_def_id = si.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped'))
    ORDER BY si.id
  LOOP
    before := public.wf_snap(s.id);
    UPDATE public.task_instances SET state = 'open', current_level = 1, level_opened_at = now(), lock_reason = NULL, version = version + 1, updated_at = now()
    WHERE id = s.id;
    PERFORM public.wf_audit('task_unlock', s.id, before, public.wf_snap(s.id), 'predecessor ' || public.wf_label(p_task) || ' approved');
    ids := ids || s.id;
    FOR h IN SELECT e.user_id FROM public.wf_eligible(s.id, 'entry') e LIMIT 20 LOOP
      PERFORM public.wf_notify(h.user_id, 'task_assigned', 'A task is ready to start', public.wf_label(s.id), s.id);
    END LOOP;
    IF NOT public.wf_has_holder(s.id, 'entry') THEN
      PERFORM public.wf_notify_admins('no_eligible_holder', 'No holder for a task level', public.wf_label(s.id) || ': nobody can act on the entry level.', s.id);
    END IF;
  END LOOP;
  RETURN ids;
END $$;

CREATE OR REPLACE FUNCTION wf_lock_task(p_task uuid, p_version int) RETURNS public.task_instances
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; regs int[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  regs := public.wf_actor_regions('sites', 'view');
  IF regs IS NOT NULL AND NOT (t.region_id = ANY (regs)) THEN PERFORM public.wf_err('not_found'); END IF;
  IF p_version IS NOT NULL AND p_version <> t.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  RETURN t;
END $$;

CREATE OR REPLACE FUNCTION wf_require_grant(p_region int, p_action "PermissionAction") RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE regs int[] := public.wf_actor_regions('sites', p_action);
BEGIN
  IF regs IS NOT NULL AND NOT (p_region = ANY (regs)) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need ' || p_action::text || ' on sites in this region.'));
  END IF;
END $$;

-- May the caller act on the level the task is at? Returns how: 'holder', 'vote' (all_members) or 'admin' (nobody holds the level,
-- B10: the System Admins' inbox). Raises not_eligible_holder / already_claimed / invalid_transition.
CREATE OR REPLACE FUNCTION wf_require_actor(p_task uuid, p_kind text, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; rl public."MatrixRule"; is_admin boolean; has_holder boolean;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  rl := public.wf_rule(p_task, p_kind);
  is_admin := public.app_user_is_system_admin(p_actor);
  has_holder := public.wf_has_holder(p_task, p_kind);
  IF rl = 'all_members' THEN
    IF EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = p_task AND v.level = t.current_level AND v.round = t.level_round AND v.user_id = p_actor AND v.voted_at IS NULL) THEN
      RETURN 'vote';
    END IF;
    IF EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = p_task AND v.level = t.current_level AND v.round = t.level_round AND v.user_id = p_actor) THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'You have already voted on this level.'));
    END IF;
    IF is_admin AND NOT EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = p_task AND v.level = t.current_level AND v.round = t.level_round) THEN
      RETURN 'admin';
    END IF;
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF NOT (public.wf_is_eligible(p_task, p_kind, p_actor) OR (is_admin AND NOT has_holder)) THEN
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF t.ball_in_court_user_id IS NOT NULL AND t.ball_in_court_user_id <> p_actor AND public.wf_is_eligible(p_task, p_kind, t.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', t.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN public.wf_is_eligible(p_task, p_kind, p_actor) THEN 'holder' ELSE 'admin' END;
END $$;

-- Slots the task still needs before it can be submitted: mandatory document types placed on the task, without a usable slot.
CREATE OR REPLACE FUNCTION wf_missing_slots(p_task uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT dt.code ORDER BY dt.code), ARRAY[]::text[])
  FROM public.task_instances t
  JOIN public.document_type_placements pl ON pl.task_def_id = t.task_def_id AND pl.kind = 'task'
  JOIN public.document_types dt ON dt.id = pl.doc_type_id AND dt.is_active AND dt.is_mandatory
  WHERE t.id = p_task AND public.app_region_check(t.region_id)
    AND NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = t.id AND s.doc_type_id = dt.id AND s.status IN ('uploaded', 'in_review', 'approved'))
    AND (dt.condition_rule IS NULL OR EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = t.id AND s.doc_type_id = dt.id))
$$;

-- Submit (level 1), pass a review level, or give the final approval: one function for the three (they differ only in the level).
CREATE OR REPLACE FUNCTION wf_complete(p_task uuid, p_version int, p_action text, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; n int; lvl int; k text; mode text;
  ch record; before jsonb; step_ids uuid[] := ARRAY[]::uuid[]; sk int; self boolean; unlocked uuid[] := ARRAY[]::uuid[];
  missing_f text[] := ARRAY[]::text[]; missing_s text[]; after_state public."TaskState"; v_left int; n_snags int; sid uuid; first boolean;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF (p_action = 'submit' AND t.state <> 'entry') OR (p_action = 'review' AND t.state <> 'in_review') OR (p_action = 'approve' AND t.state <> 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is ' || t.state::text || ': ' || p_action || ' is not possible now.'));
  END IF;
  before := public.wf_snap(p_task);
  first := t.path_frozen_at IS NULL;
  n := public.wf_task_levels(p_task);
  lvl := t.current_level;
  k := public.wf_kind(n, lvl);
  IF p_action = 'review' AND k <> 'review' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is at the approve level.')); END IF;
  IF p_action = 'approve' AND k <> 'approve' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is not at the approve level.')); END IF;
  PERFORM public.wf_require_grant(t.region_id, CASE k WHEN 'entry' THEN 'edit' WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  mode := public.wf_require_actor(p_task, k, actor);

  IF p_action = 'submit' THEN
    IF t.actual_date IS NULL THEN missing_f := ARRAY['actual_date']; END IF;
    IF cardinality(missing_f) > 0 THEN PERFORM public.wf_err('mandatory_fields_missing', jsonb_build_object('missing', to_jsonb(missing_f))); END IF;
    missing_s := public.wf_missing_slots(p_task);
    IF cardinality(missing_s) > 0 THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(missing_s))); END IF;
    IF first THEN
      UPDATE public.task_instances SET levels_required = n, path_frozen_at = now() WHERE id = p_task;   -- B7
    END IF;
  END IF;

  -- all_members: record the vote; the level completes with the last vote
  IF mode = 'vote' THEN
    UPDATE public.task_level_voters SET voted_at = now() WHERE task_id = p_task AND level = lvl AND round = t.level_round AND user_id = actor;
    SELECT count(*) INTO v_left FROM public.task_level_voters WHERE task_id = p_task AND level = lvl AND round = t.level_round AND voted_at IS NULL;
    IF v_left > 0 THEN
      sid := public.wf_step(p_task, lvl, p_action, actor, p_note, t.state, t.state, false, false);
      UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = p_task;
      PERFORM public.wf_audit('task_' || p_action || '_vote', p_task, before, public.wf_snap(p_task), p_note);
      RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb, 'votes_missing', v_left);
    END IF;
  END IF;

  SELECT * INTO ch FROM public.wf_chain(p_task, lvl, actor);
  IF ch.is_final THEN
    IF k <> 'approve' THEN PERFORM public.wf_require_grant(t.region_id, 'approve'); END IF;
    IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- B5 and the final approval
    SELECT count(*) INTO n_snags FROM public.snags s JOIN public.snag_types st ON st.id = s.snag_type_id
      WHERE s.task_id = p_task AND s.status IN ('open', 'fix_uploaded', 'in_review') AND st.blocks_preliminary_acceptance;
    IF n_snags > 0 THEN PERFORM public.wf_err('open_snags', jsonb_build_object('count', n_snags)); END IF;
  END IF;

  self := ch.is_final AND (n = 1 OR n = ANY (ch.skipped));
  after_state := CASE WHEN ch.is_final THEN 'approved'
                      ELSE CASE public.wf_kind(n, ch.next_level) WHEN 'review' THEN 'in_review' WHEN 'approve' THEN 'in_approval' ELSE 'entry' END END;

  sid := public.wf_step(p_task, lvl, p_action, actor, p_note, t.state, after_state, coalesce(p_stepup, false) AND ch.is_final, self);
  step_ids := step_ids || sid;
  INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, lvl, actor, 'acted')
    ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  FOREACH sk IN ARRAY ch.skipped LOOP
    sid := public.wf_step(p_task, sk, 'auto_skip', actor, 'level skipped: same holder', t.state, after_state, false, self);
    step_ids := step_ids || sid;
    INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, sk, actor, 'skipped')
      ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'skipped', acted_at = now();
  END LOOP;

  IF p_action = 'submit' THEN
    UPDATE public.task_instances SET submitted_date = current_date WHERE id = p_task;
    UPDATE public.document_slots SET status = 'in_review', reject_reason = NULL WHERE task_id = p_task AND status = 'uploaded';
  END IF;

  IF ch.is_final THEN
    UPDATE public.task_instances SET state = 'approved', current_level = n, approved_date = current_date, ball_in_court_user_id = NULL,
      level_opened_at = NULL, self_approval = self WHERE id = p_task;
    UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
    UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
      WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
    unlocked := public.wf_unlock_successors(p_task);
  ELSE
    PERFORM public.wf_open_level(p_task, ch.next_level, NULL);
  END IF;
  UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = p_task;

  PERFORM public.wf_audit('task_' || p_action, p_task, before,
    public.wf_snap(p_task) || jsonb_build_object('skipped_levels', to_jsonb(ch.skipped), 'self_approval_flag', self), p_note);
  FOREACH sk IN ARRAY ch.skipped LOOP
    PERFORM public.wf_audit('task_auto_skip', p_task, jsonb_build_object('level', sk, 'holder', actor),
      jsonb_build_object('level', sk, 'skipped', true, 'reason', 'same holder', 'self_approval', self), 'level skipped: same holder');
  END LOOP;

  RETURN jsonb_build_object('step_ids', to_jsonb(step_ids), 'skipped_levels', to_jsonb(ch.skipped), 'unlocked_task_ids', to_jsonb(unlocked));
END $$;

CREATE OR REPLACE FUNCTION wf_submit(p_task uuid, p_version int, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT public.wf_complete(p_task, p_version, 'submit', p_note, p_stepup) $$;
CREATE OR REPLACE FUNCTION wf_review(p_task uuid, p_version int, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT public.wf_complete(p_task, p_version, 'review', p_note, p_stepup) $$;
CREATE OR REPLACE FUNCTION wf_approve(p_task uuid, p_version int, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT public.wf_complete(p_task, p_version, 'approve', p_note, p_stepup) $$;

-- Reject one level back with a note (B6, B10).
CREATE OR REPLACE FUNCTION wf_reject(p_task uuid, p_version int, p_note text, p_rejected_slots jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; n int; lvl int; k text; tgt int; pin uuid; how text; before jsonb; sid uuid;
  r jsonb; cid uuid; h record;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF coalesce(btrim(p_note), '') = '' THEN PERFORM public.wf_err('note_required'); END IF;
  IF t.state NOT IN ('in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a task in review or approval can be rejected.'));
  END IF;
  before := public.wf_snap(p_task);
  n := public.wf_task_levels(p_task);
  lvl := t.current_level;
  k := public.wf_kind(n, lvl);
  PERFORM public.wf_require_grant(t.region_id, CASE k WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  PERFORM public.wf_require_actor(p_task, k, actor);

  -- target level and the person it returns to (B6)
  tgt := lvl - 1;
  SELECT a.how, a.user_id INTO how, pin FROM public.task_level_actors a WHERE a.task_id = p_task AND a.level = tgt;
  IF how = 'skipped' THEN
    SELECT a.level, a.user_id INTO tgt, pin FROM public.task_level_actors a WHERE a.task_id = p_task AND a.level < lvl AND a.how = 'acted' ORDER BY a.level DESC LIMIT 1;
    IF NOT FOUND THEN tgt := 1; pin := NULL; END IF;
  END IF;
  IF pin IS NOT NULL AND NOT public.wf_is_eligible(p_task, public.wf_kind(n, tgt), pin) THEN pin := NULL; END IF;
  DELETE FROM public.task_level_actors WHERE task_id = p_task AND level >= tgt;

  -- document slots: the ones named are rejected with their reason, the others go back to "uploaded"
  IF p_rejected_slots IS NOT NULL AND jsonb_typeof(p_rejected_slots) = 'array' THEN
    FOR r IN SELECT * FROM jsonb_array_elements(p_rejected_slots) LOOP
      UPDATE public.document_slots SET status = 'rejected', reject_reason = r->>'reason' WHERE id = (r->>'slot_id')::uuid AND task_id = p_task;
      IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'A rejected slot does not belong to this task.')); END IF;
    END LOOP;
  END IF;
  UPDATE public.document_slots SET status = 'uploaded' WHERE task_id = p_task AND status = 'in_review';

  PERFORM public.wf_open_level(p_task, tgt, pin);
  UPDATE public.task_instances SET return_count = return_count + 1, last_return_note = p_note, version = version + 1, updated_at = now() WHERE id = p_task;
  sid := public.wf_step(p_task, lvl, 'reject', actor, p_note, t.state, (SELECT state FROM public.task_instances WHERE id = p_task), false, false);
  INSERT INTO public.comments (task_id, region_id, author_id, body, is_rejection_note) VALUES (p_task, t.region_id, actor, p_note, true) RETURNING id INTO cid;
  PERFORM public.wf_audit('task_reject', p_task, before, public.wf_snap(p_task) || jsonb_build_object('returned_to_level', tgt), p_note);

  IF pin IS NOT NULL THEN
    PERFORM public.wf_notify(pin, 'task_rejected', 'A task was returned to you', public.wf_label(p_task) || ': ' || p_note, p_task);
  ELSE
    FOR h IN SELECT e.user_id FROM public.wf_eligible(p_task, public.wf_kind(n, tgt)) e LIMIT 20 LOOP
      PERFORM public.wf_notify(h.user_id, 'task_rejected', 'A task was returned', public.wf_label(p_task) || ': ' || p_note, p_task);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb, 'returned_to_level', tgt);
END $$;

-- Pending -> Ongoing with a start date. A group level is claimed by whoever starts (first action claims).
CREATE OR REPLACE FUNCTION wf_start(p_task uuid, p_version int, p_start date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; sid uuid; d date := coalesce(p_start, current_date); pin uuid; cnt int;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF t.state <> 'open' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a pending task can be started (it is ' || t.state::text || ').'));
  END IF;
  IF d > current_date OR d < DATE '2020-01-01' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/actual_start', 'code', 'invalid_date', 'message', 'The start date cannot be in the future.'))));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(p_task, 'entry', actor);
  before := public.wf_snap(p_task);
  SELECT count(*) INTO cnt FROM public.wf_eligible(p_task, 'entry');
  pin := CASE WHEN cnt > 1 THEN actor ELSE t.ball_in_court_user_id END;
  UPDATE public.task_instances SET state = 'entry', current_level = 1, actual_start = d, ball_in_court_user_id = pin, version = version + 1, updated_at = now() WHERE id = p_task;
  sid := public.wf_step(p_task, 1, 'start', actor, NULL, t.state, 'entry', false, false);
  PERFORM public.wf_audit('task_start', p_task, before, public.wf_snap(p_task), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

-- Claim a group level (any one member) and release it again.
CREATE OR REPLACE FUNCTION wf_claim(p_task uuid, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; sid uuid; k text; n int;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF t.state NOT IN ('open', 'entry', 'in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A task that is ' || t.state::text || ' cannot be claimed.'));
  END IF;
  n := public.wf_task_levels(p_task);
  k := public.wf_kind(n, greatest(t.current_level, 1));
  IF public.wf_rule(p_task, k) = 'all_members' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This level needs every member to vote; there is nothing to claim.'));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, CASE k WHEN 'entry' THEN 'edit' WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  IF t.ball_in_court_user_id = actor THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'You already hold this task.'));
  END IF;
  PERFORM public.wf_require_actor(p_task, k, actor);   -- not_eligible_holder / already_claimed
  before := public.wf_snap(p_task);
  UPDATE public.task_instances SET ball_in_court_user_id = actor, version = version + 1, updated_at = now() WHERE id = p_task;
  sid := public.wf_step(p_task, greatest(t.current_level, 1), 'claim', actor, NULL, t.state, t.state, false, false);
  PERFORM public.wf_audit('task_claim', p_task, before, public.wf_snap(p_task), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION wf_release(p_task uuid, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; sid uuid;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF t.ball_in_court_user_id IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nobody holds a claim on this task.'));
  END IF;
  IF t.ball_in_court_user_id <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who holds the claim can release it.'));
  END IF;
  before := public.wf_snap(p_task);
  UPDATE public.task_instances SET ball_in_court_user_id = NULL, version = version + 1, updated_at = now() WHERE id = p_task;
  sid := public.wf_step(p_task, greatest(t.current_level, 1), 'release', actor, NULL, t.state, t.state, false, false);
  PERFORM public.wf_audit('task_release', p_task, before, public.wf_snap(p_task), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

-- Save entry data (dates, values) at level 1. Keys present in p_patch are applied; an explicit null clears.
CREATE OR REPLACE FUNCTION wf_save_entry(p_task uuid, p_version int, p_patch jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; k text; d date; errs jsonb := '[]'::jsonb; cnt int; pin uuid; key text;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Entry data can be saved only while the task is pending or ongoing (it is ' || t.state::text || ').'));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(p_task, 'entry', actor);
  FOREACH key IN ARRAY ARRAY['actual_start', 'actual_date', 'planned_date'] LOOP
    IF p_patch ? key AND jsonb_typeof(p_patch->key) <> 'null' THEN
      d := (p_patch->>key)::date;
      IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'));
      ELSIF key <> 'planned_date' AND d > current_date THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'future_date', 'message', 'An actual date cannot be in the future.'));
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := public.wf_snap(p_task);
  SELECT count(*) INTO cnt FROM public.wf_eligible(p_task, 'entry');
  pin := CASE WHEN t.ball_in_court_user_id IS NULL AND cnt > 1 THEN actor ELSE t.ball_in_court_user_id END;
  UPDATE public.task_instances SET
    actual_start = CASE WHEN p_patch ? 'actual_start' THEN (p_patch->>'actual_start')::date ELSE actual_start END,
    actual_date  = CASE WHEN p_patch ? 'actual_date'  THEN (p_patch->>'actual_date')::date  ELSE actual_date END,
    planned_date = CASE WHEN p_patch ? 'planned_date' THEN (p_patch->>'planned_date')::date ELSE planned_date END,
    values = CASE WHEN p_patch ? 'values' AND jsonb_typeof(p_patch->'values') = 'object' THEN coalesce(values, '{}'::jsonb) || (p_patch->'values') ELSE values END,
    ball_in_court_user_id = pin, version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.wf_audit('task_entry_update', p_task, before, public.wf_snap(p_task) || jsonb_build_object('values', (SELECT values FROM public.task_instances WHERE id = p_task)), NULL);
END $$;

-- Comment with optional mentions. Anybody who can see the task may comment.
CREATE OR REPLACE FUNCTION wf_add_comment(p_task uuid, p_body text, p_mentions uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; cid uuid; m uuid;
BEGIN
  t := public.wf_lock_task(p_task, NULL);
  IF coalesce(btrim(p_body), '') = '' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The comment is empty.')); END IF;
  INSERT INTO public.comments (task_id, region_id, author_id, body) VALUES (p_task, t.region_id, actor, p_body) RETURNING id INTO cid;
  FOREACH m IN ARRAY coalesce(p_mentions, ARRAY[]::uuid[]) LOOP
    IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = m AND u.status = 'active') AND m <> actor THEN
      INSERT INTO public.comment_mentions (comment_id, user_id) VALUES (cid, m) ON CONFLICT DO NOTHING;
      PERFORM public.wf_notify(m, 'mention', 'You were mentioned', public.wf_label(p_task) || ': ' || left(p_body, 200), p_task);
    END IF;
  END LOOP;
  PERFORM public.wf_audit('task_comment', p_task, NULL, jsonb_build_object('comment_id', cid, 'body', p_body, 'mentions', to_jsonb(coalesce(p_mentions, ARRAY[]::uuid[]))), NULL);
  RETURN cid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'workflow_streams_inherit()', 'stage_stream_inherit()',
    'wf_err(text,jsonb)', 'wf_actor_regions(text,"PermissionAction")', 'wf_user_in_scope(uuid,int)', 'wf_kind(int,int)', 'wf_levels_live(uuid)', 'wf_task_levels(uuid)',
    'wf_cell(uuid,text)', 'wf_rule(uuid,text)', 'wf_eligible(uuid,text)', 'wf_is_eligible(uuid,text,uuid)', 'wf_has_holder(uuid,text)', 'wf_chain(uuid,int,uuid)',
    'wf_snap(uuid)', 'wf_audit(text,uuid,jsonb,jsonb,text)', 'wf_step(uuid,int,text,uuid,text,"TaskState","TaskState",boolean,boolean)', 'wf_label(uuid)',
    'wf_notify(uuid,text,text,text,uuid)', 'wf_notify_admins(text,text,text,uuid)', 'wf_open_level(uuid,int,uuid)', 'wf_unlock_successors(uuid)',
    'wf_lock_task(uuid,int)', 'wf_require_grant(int,"PermissionAction")', 'wf_require_actor(uuid,text,uuid)', 'wf_missing_slots(uuid)',
    'wf_complete(uuid,int,text,text,boolean)', 'wf_submit(uuid,int,text,boolean)', 'wf_review(uuid,int,text,boolean)', 'wf_approve(uuid,int,text,boolean)',
    'wf_reject(uuid,int,text,jsonb)', 'wf_start(uuid,int,date)', 'wf_claim(uuid,int)', 'wf_release(uuid,int)', 'wf_save_entry(uuid,int,jsonb)', 'wf_add_comment(uuid,text,uuid[])'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  ALTER FUNCTION wf_backstop() OWNER TO pmis_definer;
  -- what the API calls: the transitions, the read helpers of the task view and the inbox
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'wf_actor_regions(text,"PermissionAction")', 'wf_kind(int,int)', 'wf_levels_live(uuid)', 'wf_task_levels(uuid)', 'wf_cell(uuid,text)', 'wf_rule(uuid,text)',
      'wf_eligible(uuid,text)', 'wf_is_eligible(uuid,text,uuid)', 'wf_has_holder(uuid,text)', 'wf_chain(uuid,int,uuid)', 'wf_missing_slots(uuid)',
      'wf_submit(uuid,int,text,boolean)', 'wf_review(uuid,int,text,boolean)', 'wf_approve(uuid,int,text,boolean)', 'wf_reject(uuid,int,text,jsonb)',
      'wf_start(uuid,int,date)', 'wf_claim(uuid,int)', 'wf_release(uuid,int)', 'wf_save_entry(uuid,int,jsonb)', 'wf_add_comment(uuid,text,uuid[])'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
