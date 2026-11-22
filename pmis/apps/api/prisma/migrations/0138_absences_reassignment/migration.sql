-- 0138_absences_reassignment: staff absence and the lead decisions on a task (CLAUDE.md decision B12b, B14; contract 0.15.45; CHANGELOG 184).
-- Mirror: db/sql/137_absences_reassignment.sql (kept byte-identical).
--
-- WHAT THIS ADDS. The seven routes the web app calls (GET/POST /absences, DELETE /absences/{id}, GET /reassignments/alerts, GET /reassignments/eligible-users,
-- POST /tasks/reassign, POST /tasks/{id}/act-on-behalf) and GET/PATCH /absences/{id}, on the existing approval engine (0015) without a parallel path:
--   1. absences: informational absence records (annual, sick, emergency, other). Nothing moves when one is recorded (B12b). An employee records only their own
--      annual leave; the lead of the person (the `reassign` grant, overrides.reassign + administer, for a region of the person, B12b) or a System Admin
--      records any kind, for anyone they lead. Two absences of one person never overlap (exclusion constraint). The leads of the person are told in the inbox.
--   2. task_cover_decisions: the lead decisions per task (keep, reassign, act_on_behalf from POST /tasks/reassign; acted_on_behalf from the act-on-behalf
--      route), one bulk_action_id per request. A keep or an act_on_behalf decision silences the absent / deactivated alert of the task for the idle window.
--   3. "The task is on a person" (rsn_task_on): the person its current level is pinned to (claimed, started, returned to them, reassigned to them), else the
--      only eligible holder of the level, else (nobody eligible) the deactivated or deleted user the Matrix cell names (B14). A level shared by several
--      eligible people is on nobody (any of them may take it), and an all-members level is on nobody (open question Q-B12b-1).
--   4. Reassign = a task-level holder change: the current level is pinned to the new person (ball_in_court_user_id; for an all-members level the person's
--      vote moves). The Responsibility Matrix is not changed; data, documents, comments, the SLA start, its rule and version, the level, its opening time
--      and stage progress are untouched (B12b). The target must be an eligible holder of the level (wf_is_eligible), active and not absent today.
--   5. Act on behalf: ops_act_on_behalf writes a transaction marker (a row of hgd_marks, kind rsn_cover, written only by definer code; 0127) and then calls the
--      unchanged transitions wf_complete / wf_reject. wf_require_actor (redefined from 0125, one branch added) lets the marked caller act at the current
--      level; wf_step (from 0051) and wf_audit (from 0069) stamp on_behalf_of = the person the level was on and on_behalf_kind = assignee. Everything else
--      is the normal engine: grants per level, step-up for a final approval, the self-skip chain and the self-approval flag (B5), unlocks, notices.
--   6. Alerts (rsn_alerts): absent (the task is on a person with an absence today), holder_deactivated (on a deactivated or deleted account, B14) and idle
--      (no activity for N working days, N = dashboard setting stale_idle_days, default 2, the same limit as the stale badge, 0116), scoped to the regions
--      the caller leads and sees.
--
-- SEPARATION OF DUTIES (security review of 2026-11-22). The act-on-behalf marker names the task, the caller AND the level it was granted for; wf_require_actor
-- honours it only at that level, so a cover granted at L1 is never usable at L2. When one person completes two levels of the same pass of a task through a cover
-- (covered L1 and then approves L2 as a holder, or submitted L1 as a holder and then covers L2), the final approval is a self-approval (B5): step-up and the
-- self_approval flag on the step, the task and the audit row (wf_complete_hw, redefined from 0073, one line marked 0138). A task on nobody (no single holder)
-- cannot be covered: that is the "no holder" path to the System Admins (B10). No absence or idle precondition (B12b: the lead decides); the audit row of the
-- cover records whether the holder was absent, deactivated or idle at that moment.
-- LEAD SCOPE. A person's regions come from their assignments only (never from System Admin status); a person with an all-regions assignment, or a System
-- Admin, is "all regions". A regional lead leads a person only when EVERY region of the person is one of the lead's regions; an all-regions person is led only
-- by a System Admin or an all-regions lead; a person with no region is led only by them too. The same rule (rsn_leads_person) governs the absences (read,
-- record, change, remove), the alerts, the eligible people, the reassignment and the cover; in a reassignment both the person a task is on and the person
-- named in from_user_id (whose pin or all-members vote moves) must be led.
--
-- SECURITY. Every function is SECURITY DEFINER, search_path pg_catalog, public, pg_temp, owner pmis_definer, PUBLIC revoked. pmis_app may execute only the
-- doors: ops_save_absence, ops_delete_absence, ops_reassign_tasks, ops_act_on_behalf (writes) and rsn_visible_absences, rsn_alerts, rsn_eligible_users,
-- rsn_holder_absent, rsn_open_task_counts (reads). The two tables have row security forced and no right for pmis_app (db/sql/app_grants.sql). Each door
-- takes the actor from app_actor(), checks the lead right per region itself and audits every write with before and after.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE absences (
  id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind        text           NOT NULL CHECK (kind IN ('annual', 'sick', 'emergency', 'other')),
  from_date   date           NOT NULL,
  to_date     date           NOT NULL,
  note        text           CHECK (note IS NULL OR char_length(note) <= 500),
  recorded_by uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  version     integer        NOT NULL DEFAULT 1,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT absences_dates_check CHECK (to_date >= from_date),
  CONSTRAINT absences_no_overlap EXCLUDE USING gist (user_id WITH =, daterange(from_date, to_date, '[]') WITH &&)
);
CREATE INDEX absences_dates_idx ON absences (from_date, to_date);

CREATE TABLE task_cover_decisions (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  bulk_action_id uuid           NOT NULL,
  task_id        uuid           NOT NULL REFERENCES task_instances (id) ON DELETE CASCADE ON UPDATE CASCADE,
  region_id      integer        NOT NULL REFERENCES regions (id),
  decision       text           NOT NULL CHECK (decision IN ('keep', 'reassign', 'act_on_behalf', 'acted_on_behalf')),
  level          integer        NOT NULL,
  from_user_id   uuid,
  to_user_id     uuid,
  action         text           CHECK (action IS NULL OR action IN ('submit', 'review', 'approve', 'reject')),
  decided_by     uuid           NOT NULL,
  reason         text           NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  created_at     timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX task_cover_decisions_task_idx ON task_cover_decisions (task_id, created_at DESC);
CREATE INDEX task_cover_decisions_bulk_idx ON task_cover_decisions (bulk_action_id);

-- Row security: absences belong to a person, not to a region; they are read only through rsn_visible_absences (own, the people one leads, or all for a
-- System Admin). The decisions follow the region of their task. pmis_app has no right on either table (also in db/sql/app_grants.sql).
ALTER TABLE absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE absences FORCE ROW LEVEL SECURITY;
ALTER TABLE task_cover_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_cover_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON task_cover_decisions FOR SELECT USING (public.app_region_check(region_id));
REVOKE ALL ON absences, task_cover_decisions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON absences, task_cover_decisions TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON absences, task_cover_decisions FROM pmis_app; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Who leads whom, and whom a task is on
-- ---------------------------------------------------------------------------------------------------------------------
-- The regions in which the user is a lead (B12b): the `reassign` grant there (ss_holds_reassign, 0072) and the Sites module there. NULL = every region (System Admin).
CREATE OR REPLACE FUNCTION rsn_lead_regions(p_user uuid) RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_user IS NULL THEN ARRAY[]::integer[]
              WHEN public.app_user_is_system_admin(p_user) THEN NULL
              ELSE coalesce((SELECT array_agg(r.id ORDER BY r.id) FROM public.regions r
                             WHERE public.ss_holds_reassign(p_user, r.id) AND public.wf_user_in_scope(p_user, r.id)), ARRAY[]::integer[]) END
$$;

CREATE OR REPLACE FUNCTION rsn_is_lead(p_user uuid, p_region integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_user IS NOT NULL AND (public.app_user_is_system_admin(p_user)
         OR (public.ss_holds_reassign(p_user, p_region) AND public.wf_user_in_scope(p_user, p_region)))
$$;

-- The regions a person works in, from their active assignments only (whatever the account status, so a deactivated person keeps their leads): every
-- assignment, whatever its module, counts, so a lead never misses a region of the person. NULL = all regions: an all-regions assignment, or a System Admin
-- (who can be led only by a System Admin or an all-regions lead). An empty array = no region.
CREATE OR REPLACE FUNCTION rsn_user_regions(p_user uuid) RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN public.app_user_is_system_admin(p_user)
      OR EXISTS (SELECT 1 FROM public.user_role_assignments ua
                 WHERE ua.user_id = p_user AND ua.all_regions AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())) THEN NULL
    ELSE coalesce((SELECT array_agg(DISTINCT x.region_id ORDER BY x.region_id)
                   FROM public.user_role_assignments ua JOIN public.user_role_assignment_regions x ON x.assignment_id = ua.id
                   WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())), ARRAY[]::integer[]) END
$$;

-- Does p_lead lead p_person? A System Admin or an all-regions lead leads everyone; a regional lead leads a person whose regions are ALL among the lead's
-- regions (never an all-regions person, never a person with no region).
CREATE OR REPLACE FUNCTION rsn_leads_person(p_lead uuid, p_person uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE lr integer[] := public.rsn_lead_regions(p_lead); pr integer[];
BEGIN
  IF p_lead IS NULL OR p_person IS NULL THEN RETURN false; END IF;
  IF lr IS NULL OR lr @> (SELECT array_agg(r.id) FROM public.regions r) THEN RETURN true; END IF;
  IF cardinality(lr) = 0 THEN RETURN false; END IF;
  pr := public.rsn_user_regions(p_person);
  RETURN pr IS NOT NULL AND cardinality(pr) > 0 AND pr <@ lr;
END $$;

-- The stages whose Matrix cells may hold the user (named, through a role they hold, or through a group they are in): a cheap pre-filter of rsn_task_on.
CREATE OR REPLACE FUNCTION rsn_candidate_stages(p_user uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT c.stage_id), ARRAY[]::uuid[])
  FROM public.matrix_cells c JOIN public.matrix_cell_assignees a ON a.cell_id = c.id
  WHERE (a.kind = 'user' AND a.ref_id = p_user)
     OR (a.kind = 'role' AND a.ref_id IN (SELECT ua.role_id FROM public.user_role_assignments ua
                                          WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())))
     OR (a.kind = 'group' AND a.ref_id IN (SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = p_user))
$$;

-- The person an open task is on (see the header, item 3); NULL when it is shared, all-members, not open or not visible to the caller.
CREATE OR REPLACE FUNCTION rsn_task_on(p_task uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; k text; n integer; u uuid;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.state NOT IN ('open', 'entry', 'in_review', 'in_approval') OR NOT public.app_region_check(t.region_id) THEN RETURN NULL; END IF;
  IF t.ball_in_court_user_id IS NOT NULL THEN RETURN t.ball_in_court_user_id; END IF;
  k := public.wf_kind(public.wf_task_levels(p_task), greatest(t.current_level, 1));
  IF public.wf_rule(p_task, k) = 'all_members' THEN RETURN NULL; END IF;
  SELECT count(*), (array_agg(e.user_id))[1] INTO n, u FROM public.wf_eligible(p_task, k) e;
  IF n = 1 THEN RETURN u; END IF;
  IF n = 0 THEN
    RETURN (SELECT a.ref_id FROM public.matrix_cell_assignees a JOIN public.users x ON x.id = a.ref_id
            WHERE a.cell_id = public.wf_cell(p_task, k) AND a.kind = 'user' AND (x.status IN ('suspended', 'disabled') OR x.deleted_at IS NOT NULL)
            ORDER BY a.ref_id LIMIT 1);
  END IF;
  RETURN NULL;
END $$;

-- The absence of a person on a day, if any (two absences never overlap).
CREATE OR REPLACE FUNCTION rsn_absence_on(p_user uuid, p_day date) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ab.id FROM public.absences ab WHERE ab.user_id = p_user AND p_day BETWEEN ab.from_date AND ab.to_date LIMIT 1
$$;

-- A keep or act_on_behalf decision of the last idle window (N working days) silences the absent and deactivated alerts of the task.
CREATE OR REPLACE FUNCTION rsn_recently_decided(p_task uuid, p_cal uuid, p_days integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.task_cover_decisions d
                 WHERE d.task_id = p_task AND d.decision IN ('keep', 'act_on_behalf')
                   AND public.cal_workdays_between(public.cal_local_date(d.created_at), public.cal_today(), p_cal) < p_days)
$$;

-- The act-on-behalf marker of this transaction for the task and the caller (key task|caller|level|holder): the person the level was on, NULL when not
-- covering. Read only by the definer (hgd_marks has no right for pmis_app and is written only through hgd_mark, closed to PUBLIC). rsn_covering stamps the
-- steps and audit rows of the transition; rsn_covering_at authorises, and only at the level the cover was granted for.
CREATE OR REPLACE FUNCTION rsn_covering(p_task uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT split_part(m.key, '|', 4) FROM public.hgd_marks m
  WHERE m.xid = txid_current() AND m.kind = 'rsn_cover'
    AND split_part(m.key, '|', 1) = p_task::text AND split_part(m.key, '|', 2) = public.app_actor()::text
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION rsn_covering_at(p_task uuid, p_level integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.hgd_marks m
                 WHERE m.xid = txid_current() AND m.kind = 'rsn_cover' AND p_level IS NOT NULL
                   AND split_part(m.key, '|', 1) = p_task::text AND split_part(m.key, '|', 2) = public.app_actor()::text
                   AND split_part(m.key, '|', 3) = p_level::text AND split_part(m.key, '|', 4) <> '')
$$;

-- B5 through a cover: the caller already completed a lower level of this pass (task_level_actors keeps only the current pass; a rejection clears it), and
-- either acts now through a cover, or acted there through a cover (the acted_on_behalf decision of that level, written in the same transaction as the act).
CREATE OR REPLACE FUNCTION rsn_cover_twice(p_task uuid, p_level integer, p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.task_level_actors a
    WHERE a.task_id = p_task AND a.level < p_level AND a.user_id = p_actor AND a.how = 'acted'
      AND (public.rsn_covering(p_task) IS NOT NULL
           OR EXISTS (SELECT 1 FROM public.task_cover_decisions d
                      WHERE d.task_id = p_task AND d.decided_by = p_actor AND d.decision = 'acted_on_behalf' AND d.level = a.level AND d.created_at >= a.acted_at)))
$$;

CREATE OR REPLACE FUNCTION rsn_absence_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('id', ab.id, 'user_id', ab.user_id, 'kind', ab.kind, 'from_date', ab.from_date, 'to_date', ab.to_date, 'note', ab.note,
                            'recorded_by', ab.recorded_by, 'version', ab.version)
  FROM public.absences ab WHERE ab.id = p_id
$$;

-- The leads of the person are told (inbox, kind absence_alert); when nobody leads the person, the System Admins are (B12b, as ss_notify_region_move).
CREATE OR REPLACE FUNCTION rsn_notify_absence(p_absence uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ab public.absences%ROWTYPE; who text; recipients uuid[]; u uuid; a uuid := public.app_actor();
BEGIN
  SELECT * INTO ab FROM public.absences WHERE id = p_absence;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT x.display_name || coalesce(' (' || btrim(x.employee_id) || ')', '') INTO who FROM public.users x WHERE x.id = ab.user_id;
  SELECT coalesce(array_agg(l.id), ARRAY[]::uuid[]) INTO recipients FROM public.users l
  WHERE l.id <> ab.user_id AND l.id IS DISTINCT FROM a AND l.status = 'active' AND l.deleted_at IS NULL AND NOT l.is_break_glass
    AND NOT public.app_user_is_system_admin(l.id)
    -- cheap pre-filter: someone who holds the reassign grant through an assignment profile, or who has a delegation at all
    AND (EXISTS (SELECT 1 FROM public.user_role_assignments ua
                 JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = ua.id
                 JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
                 JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = 'administer'
                 WHERE ua.user_id = l.id AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                   AND ('overrides.reassign' = g.module_key OR 'overrides.reassign' LIKE g.module_key || '.%'))
         OR EXISTS (SELECT 1 FROM public.app_user_delegations(l.id)))
    AND public.rsn_leads_person(l.id, ab.user_id);
  IF cardinality(recipients) = 0 THEN
    SELECT coalesce(array_agg(DISTINCT gm.user_id), ARRAY[]::uuid[]) INTO recipients
    FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
         JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL AND NOT x.is_break_glass
    WHERE gm.user_id IS DISTINCT FROM a AND gm.user_id <> ab.user_id;
  END IF;
  FOREACH u IN ARRAY recipients LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (u, 'in_app', 'absence_alert', 'Absence recorded: ' || coalesce(who, 'a person'),
            coalesce(who, 'A person') || ' is absent (' || ab.kind || ') from ' || ab.from_date || ' to ' || ab.to_date
              || '. Nothing moves automatically: their open tasks stay with them until you keep, reassign or act on them (B12b).', '/absence');
  END LOOP;
  RETURN cardinality(recipients);
END $$;

-- The two kinds this release starts writing (absence_alert to the leads, reassigned to the new and the former holder) join the mail catalogue (latest 0072:
-- "added here by the release that starts writing them"). Redefined in full; only the last two kinds are new.
CREATE OR REPLACE FUNCTION mail_kind_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('kind', k, 'recommended', ord <= 6) ORDER BY ord)
  FROM unnest(ARRAY[
    'task_assigned', 'register_assigned', 'snag_review', 'task_rejected', 'register_rejected', 'snag_rejected',
    'email_change_decided', 'email_change_requested', 'followed_change', 'gate_closed_again', 'holiday_tentative', 'import_batch', 'levels_converted', 'mention',
    'no_eligible_holder', 'order_team_mismatch', 'party_type_review', 'permit_transferred', 'phone_change_decided', 'phone_change_requested', 'site_draft_approved',
    'site_draft_assigned', 'site_draft_returned', 'site_region_moved', 'sla_negative_duration', 'snag_closed', 'snag_raised', 'team_safety_cert',
    'absence_alert', 'reassigned'
  ]) WITH ORDINALITY AS t(k, ord)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The engine learns "lead on behalf of the assignee" (redefined in full; only the lines marked 0138 are new)
-- ---------------------------------------------------------------------------------------------------------------------
-- wf_require_actor (latest 0125)
CREATE OR REPLACE FUNCTION public.wf_require_actor(p_task uuid, p_kind text, p_actor uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t public.task_instances%ROWTYPE; rl public."MatrixRule"; is_admin boolean; has_holder boolean;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  -- 0138 (B12b choice 3): the lead acts at the current level for its holder; only ops_act_on_behalf writes the marker, after checking the lead right
  IF p_actor = public.app_actor() AND public.rsn_covering_at(p_task, t.current_level) THEN RETURN 'cover'; END IF;
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
    IF p_kind = 'entry' AND p_actor = public.app_actor() AND public.hrf_override_ok(p_task, NULL, NULL) THEN RETURN 'admin'; END IF;   -- 0125
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF NOT (public.wf_is_eligible(p_task, p_kind, p_actor) OR (is_admin AND NOT has_holder))
     AND NOT (p_kind = 'entry' AND p_actor = public.app_actor() AND public.hrf_override_ok(p_task, NULL, NULL)) THEN   -- 0125: the historical direct approval
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF t.ball_in_court_user_id IS NOT NULL AND t.ball_in_court_user_id <> p_actor AND public.wf_is_eligible(p_task, p_kind, t.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', t.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN public.wf_is_eligible(p_task, p_kind, p_actor) THEN 'holder' ELSE 'admin' END;
END $function$;

-- wf_step (latest 0051)
CREATE OR REPLACE FUNCTION public.wf_step(p_task uuid, p_level integer, p_action text, p_actor uuid, p_note text, p_before "TaskState", p_after "TaskState", p_stepup boolean, p_self boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE sid uuid; cov text := CASE WHEN p_actor = public.app_actor() THEN public.rsn_covering(p_task) END;   -- 0138
BEGIN
  -- clock_timestamp(): the steps of one transaction (a submit and its auto-skips) must keep their order in the history
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, on_behalf_of, note, before_state, after_state, stepup_verified, self_approval, batch_row_id, created_at)
  VALUES (p_task, p_level, p_action::public."WorkflowAction", p_actor, nullif(cov, '')::uuid, p_note, p_before, p_after, coalesce(p_stepup, false), coalesce(p_self, false),
          (SELECT r.id FROM public.import_batch_rows r WHERE r.id = public.imp_current_row() AND r.task_instance_id = p_task), clock_timestamp())
  RETURNING id INTO sid;
  RETURN sid;
END $function$;

-- wf_audit (latest 0069)
CREATE OR REPLACE FUNCTION public.wf_audit(p_action text, p_task uuid, p_before jsonb, p_after jsonb, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t public.task_instances%ROWTYPE; v text := nullif(public.app_ctx_via(), ''); a jsonb := p_after; cov text := public.rsn_covering(p_task);   -- 0138
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF v IN ('button', 'drag', 'bulk') AND p_action <> 'task_unlock' THEN a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', v); END IF;
  -- 0138: "lead on behalf of the assignee" (B12b choice 3)
  IF cov IS NOT NULL THEN a := coalesce(a, '{}'::jsonb) || jsonb_build_object('on_behalf_kind', 'assignee', 'on_behalf_of', nullif(cov, '')); END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, on_behalf_of)
  VALUES (p_action, 'task', p_task::text, t.site_id, t.region_id, p_before, a, p_reason, public.app_actor(), nullif(cov, '')::uuid);
  IF p_action IN ('task_start', 'task_submit', 'task_review', 'task_approve', 'task_reject', 'task_unlock') THEN
    PERFORM public.x_notify_watchers(t.site_id, NULL, public.app_actor(), 'A followed site changed', public.wf_label(p_task) || ': ' || substr(p_action, 6), '/tasks/' || p_task::text, p_task, t.region_id, 'sites');
  END IF;
END $function$;

-- wf_complete_hw (latest 0073)
CREATE OR REPLACE FUNCTION public.wf_complete_hw(p_task uuid, p_version integer, p_action text, p_note text, p_stepup boolean, p_batch_row uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; n int; lvl int; k text; mode text;
  ch record; before jsonb; step_ids uuid[] := ARRAY[]::uuid[]; sk int; self boolean; unlocked uuid[] := ARRAY[]::uuid[];
  missing_f text[] := ARRAY[]::text[]; missing_s text[]; after_state public."TaskState"; v_left int; n_snags int; v_scope text; sid uuid; first boolean;
  hw_batch uuid;   -- 0073: the batch whose mark covers this submit
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

  -- E6 / Q25: the four acceptances are blocked by the open snags of their own stream, whatever the action (submit, review, approve).
  v_scope := public.wf_snag_scope_of(p_task);
  IF v_scope IS NOT NULL THEN
    n_snags := public.wf_open_snags_of(p_task);
    IF n_snags > 0 THEN PERFORM public.wf_err('open_snags', jsonb_build_object('count', n_snags, 'scope', v_scope)); END IF;
  END IF;

  IF p_action = 'submit' THEN
    IF t.actual_date IS NULL THEN missing_f := ARRAY['actual_date']; END IF;
    IF cardinality(missing_f) > 0 THEN PERFORM public.wf_err('mandatory_fields_missing', jsonb_build_object('missing', to_jsonb(missing_f))); END IF;
    missing_s := public.wf_missing_slots(p_task);
    IF cardinality(missing_s) > 0 THEN
      hw_batch := public.hw_row_waiver(p_task, p_batch_row);   -- 0073 (Q462): NULL unless the batch is marked, the waiver is open and the actual date is on or before the cutoff
      IF hw_batch IS NULL THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(missing_s))); END IF;
    END IF;
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
  END IF;

  self := ch.is_final AND (n = 1 OR n = ANY (ch.skipped) OR public.rsn_cover_twice(p_task, lvl, actor));   -- 0138: two levels by one person through a cover (B5)
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
  IF hw_batch IS NOT NULL THEN PERFORM public.hw_flag_task(p_task, hw_batch, p_batch_row, missing_s); END IF;   -- 0073

  PERFORM public.wf_audit('task_' || p_action, p_task, before,
    public.wf_snap(p_task) || jsonb_build_object('skipped_levels', to_jsonb(ch.skipped), 'self_approval_flag', self), p_note);
  FOREACH sk IN ARRAY ch.skipped LOOP
    PERFORM public.wf_audit('task_auto_skip', p_task, jsonb_build_object('level', sk, 'holder', actor),
      jsonb_build_object('level', sk, 'skipped', true, 'reason', 'same holder', 'self_approval', self), 'level skipped: same holder');
  END LOOP;

  RETURN jsonb_build_object('step_ids', to_jsonb(step_ids), 'skipped_levels', to_jsonb(ch.skipped), 'unlocked_task_ids', to_jsonb(unlocked));
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Reads (doors of the API)
-- ---------------------------------------------------------------------------------------------------------------------
-- The absences the caller may read: their own, those of the people they lead, all for a System Admin.
CREATE OR REPLACE FUNCTION rsn_visible_absences() RETURNS SETOF absences
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY SELECT ab.* FROM public.absences ab WHERE ab.user_id = a OR public.rsn_leads_person(a, ab.user_id);
END $$;

-- The open tasks (visible to the caller) that are on each person.
CREATE OR REPLACE FUNCTION rsn_open_task_counts(p_users uuid[]) RETURNS TABLE (user_id uuid, n integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY
  WITH p AS (SELECT DISTINCT x.uid, public.rsn_candidate_stages(x.uid) AS st FROM unnest(p_users) x(uid) WHERE x.uid IS NOT NULL)
  SELECT p.uid, (SELECT count(*)::integer FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
                 WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval') AND public.app_region_check(ti.region_id)
                   AND (ti.ball_in_court_user_id = p.uid OR (ti.ball_in_court_user_id IS NULL AND td.stage_id = ANY (p.st)))
                   AND public.rsn_task_on(ti.id) = p.uid)
  FROM p;
END $$;

-- The "absent" badge of a task: the person it is on has an absence today. Nothing when nobody is absent today.
CREATE OR REPLACE FUNCTION rsn_holder_absent(p_tasks uuid[]) RETURNS TABLE (task_id uuid, absence_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d date := public.cal_today();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.absences ab WHERE d BETWEEN ab.from_date AND ab.to_date) THEN RETURN; END IF;
  RETURN QUERY
  SELECT x.tid, public.rsn_absence_on(x.uid, d)
  FROM (SELECT DISTINCT y.tid, public.rsn_task_on(y.tid) AS uid FROM unnest(p_tasks) y(tid)) x
  WHERE x.uid IS NOT NULL AND public.rsn_absence_on(x.uid, d) IS NOT NULL;
END $$;

-- The tasks that need a lead decision, in the regions the caller leads and sees (contract GET /reassignments/alerts).
CREATE OR REPLACE FUNCTION rsn_alerts(p_cause text, p_user uuid, p_region integer)
RETURNS TABLE (task_id uuid, cause text, holder_id uuid, absence_id uuid, idle_wd integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); lr integer[]; see integer[]; n integer := public.task_stale_idle_days(); d date := public.cal_today();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  lr := public.rsn_lead_regions(a);
  IF lr IS NOT NULL AND cardinality(lr) = 0 THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a lead (the reassign grant) or a System Admin sees these alerts.'));
  END IF;
  see := public.wf_actor_regions('sites', 'view');
  RETURN QUERY
  WITH sc AS (
    SELECT ti.id, ti.ball_in_court_user_id AS pinned, td.stage_id, r.calendar_id
    FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id
    LEFT JOIN public.sla_rules r ON r.id = ti.sla_rule_id
    WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval')
      AND (lr IS NULL OR ti.region_id = ANY (lr)) AND (see IS NULL OR ti.region_id = ANY (see)) AND public.app_region_check(ti.region_id)
      AND (p_region IS NULL OR ti.region_id = p_region)
  ), people AS (
    SELECT ab.user_id AS uid, ab.id AS aid, 'absent'::text AS c FROM public.absences ab
    WHERE (p_cause IS NULL OR p_cause = 'absent') AND d BETWEEN ab.from_date AND ab.to_date
    UNION ALL
    SELECT u.id, NULL::uuid, 'holder_deactivated' FROM public.users u
    WHERE (p_cause IS NULL OR p_cause = 'holder_deactivated') AND (u.status IN ('suspended', 'disabled') OR u.deleted_at IS NOT NULL)
  ), ps AS (
    SELECT people.*, public.rsn_candidate_stages(people.uid) AS st FROM people WHERE p_user IS NULL OR people.uid = p_user
  ), held AS (
    SELECT sc.id, ps.c, ps.uid, ps.aid, sc.calendar_id
    FROM ps JOIN sc ON sc.pinned = ps.uid OR (sc.pinned IS NULL AND sc.stage_id = ANY (ps.st))
    WHERE public.rsn_task_on(sc.id) = ps.uid
  )
  SELECT h.id, h.c, h.uid, h.aid,
         public.cal_workdays_between(public.cal_local_date(public.task_last_activity(h.id)), d, h.calendar_id)
  FROM held h WHERE NOT public.rsn_recently_decided(h.id, h.calendar_id, n) AND public.rsn_leads_person(a, h.uid)
  UNION ALL
  SELECT x.id, 'idle'::text, x.uid, NULL::uuid, x.wd
  FROM (SELECT sc.id, public.rsn_task_on(sc.id) AS uid,
               public.cal_workdays_between(public.cal_local_date(public.task_last_activity(sc.id)), d, sc.calendar_id) AS wd
        FROM sc WHERE p_cause IS NULL OR p_cause = 'idle') x
  WHERE x.wd >= n AND (p_user IS NULL OR x.uid = p_user) AND (x.uid IS NULL OR public.rsn_leads_person(a, x.uid));
END $$;

-- People who may receive the task(s): eligible holders of the level in the Matrix, region and module (wf_eligible), active, not absent today, not the
-- person the task is on. With a task: that task. Otherwise the tasks on p_from (on one site with p_site) in the regions the caller leads: anyone eligible
-- for at least one of them (a task the person cannot hold is reported in the result of the reassignment).
CREATE OR REPLACE FUNCTION rsn_eligible_users(p_task uuid, p_site uuid, p_from uuid) RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); lr integer[]; see integer[]; t public.task_instances%ROWTYPE; d date := public.cal_today(); ids uuid[]; st uuid[];
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  lr := public.rsn_lead_regions(a);
  IF lr IS NOT NULL AND cardinality(lr) = 0 THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a lead (the reassign grant) or a System Admin reassigns tasks.'));
  END IF;
  see := public.wf_actor_regions('sites', 'view');
  IF p_from IS NOT NULL AND NOT public.rsn_leads_person(a, p_from) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You lead this person only when every region of theirs is one of yours.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT * INTO t FROM public.task_instances WHERE id = p_task;
    IF NOT FOUND OR NOT public.app_region_check(t.region_id) OR (see IS NOT NULL AND NOT t.region_id = ANY (see)) THEN PERFORM public.wf_err('not_found'); END IF;
    IF NOT public.rsn_is_lead(a, t.region_id)
       OR (public.rsn_task_on(p_task) IS NOT NULL AND NOT public.rsn_leads_person(a, public.rsn_task_on(p_task))) THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need the reassign grant for the region of this task and for every region of the person it is on.'));
    END IF;
    ids := ARRAY[p_task];
  ELSE
    IF p_from IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/from_user_id', 'code', 'required', 'message', 'Pass task_id, or from_user_id (with site_id for one site).'))));
    END IF;
    st := public.rsn_candidate_stages(p_from);
    SELECT coalesce(array_agg(ti.id), ARRAY[]::uuid[]) INTO ids
    FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
    WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval')
      AND (lr IS NULL OR ti.region_id = ANY (lr)) AND (see IS NULL OR ti.region_id = ANY (see)) AND public.app_region_check(ti.region_id)
      AND (p_site IS NULL OR ti.site_id = p_site)
      AND (ti.ball_in_court_user_id = p_from OR (ti.ball_in_court_user_id IS NULL AND td.stage_id = ANY (st)))
      AND public.rsn_task_on(ti.id) = p_from;
  END IF;
  RETURN QUERY
  SELECT DISTINCT e.user_id
  FROM unnest(ids) x(tid)
  JOIN public.task_instances ti ON ti.id = x.tid AND ti.state IN ('open', 'entry', 'in_review', 'in_approval')
  CROSS JOIN LATERAL public.wf_eligible(x.tid, public.wf_kind(public.wf_task_levels(x.tid), greatest(ti.current_level, 1))) e
  WHERE e.user_id IS DISTINCT FROM coalesce(p_from, public.rsn_task_on(x.tid))
    AND public.rsn_absence_on(e.user_id, d) IS NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Writes (doors of the API)
-- ---------------------------------------------------------------------------------------------------------------------
-- Records (p_id NULL) or changes an absence. Informational: nothing moves (B12b).
CREATE OR REPLACE FUNCTION ops_save_absence(p_id uuid, p_version integer, p_body jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a uuid := public.app_actor(); r public.absences%ROWTYPE; tgt uuid; k text; f date; t date; nt text; lead boolean; nid uuid; clash uuid;
  errs jsonb := '[]'::jsonb; before jsonb;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The body is not an object.')); END IF;
  BEGIN
    IF p_id IS NULL THEN
      tgt := coalesce(nullif(p_body ->> 'user_id', '')::uuid, a);
      k := p_body ->> 'kind'; f := (p_body ->> 'from_date')::date; t := (p_body ->> 'to_date')::date; nt := nullif(btrim(p_body ->> 'note'), '');
    ELSE
      SELECT * INTO r FROM public.absences WHERE id = p_id FOR UPDATE;
      IF NOT FOUND OR NOT (r.user_id = a OR public.rsn_leads_person(a, r.user_id)) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The absence does not exist or is not visible to you.')); END IF;
      IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
      tgt := r.user_id;
      k := coalesce(p_body ->> 'kind', r.kind);
      f := coalesce((p_body ->> 'from_date')::date, r.from_date);
      t := coalesce((p_body ->> 'to_date')::date, r.to_date);
      nt := CASE WHEN p_body ? 'note' THEN nullif(btrim(p_body ->> 'note'), '') ELSE r.note END;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'A date or an id is not valid.'));
  END;
  IF NOT EXISTS (SELECT 1 FROM public.users x WHERE x.id = tgt AND x.deleted_at IS NULL) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No such person.'));
  END IF;
  lead := public.rsn_leads_person(a, tgt);
  -- B12b: an employee records their own annual leave; sick, emergency or other leave, and the leave of others, is recorded by the lead or a System Admin
  IF NOT lead THEN
    IF tgt <> a THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a lead of this person (the reassign grant for one of their regions) or a System Admin records their absence.'));
    END IF;
    IF k IS DISTINCT FROM 'annual' THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You record only your own annual leave; your lead records sick, emergency or other leave.'));
    END IF;
    IF p_id IS NOT NULL AND r.recorded_by <> a THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Your lead recorded this absence; ask them to change it.'));
    END IF;
  END IF;
  IF k IS NULL OR k NOT IN ('annual', 'sick', 'emergency', 'other') THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/kind', 'code', 'invalid', 'message', 'kind is annual, sick, emergency or other.')); END IF;
  IF f IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/from_date', 'code', 'required', 'message', 'from_date is required.')); END IF;
  IF t IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/to_date', 'code', 'required', 'message', 'to_date is required.')); END IF;
  IF f IS NOT NULL AND t IS NOT NULL AND t < f THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/to_date', 'code', 'before_from_date', 'message', 'to_date is before from_date.')); END IF;
  IF f < DATE '2020-01-01' OR t > DATE '2035-12-31' THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/from_date', 'code', 'invalid_date', 'message', 'The dates must be between 2020-01-01 and 2035-12-31.')); END IF;
  IF char_length(coalesce(nt, '')) > 500 THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/note', 'code', 'too_long', 'message', 'The note has at most 500 characters.')); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  -- one person is never absent twice on the same day (the exclusion constraint is the backstop)
  PERFORM pg_advisory_xact_lock(hashtext('absence:' || tgt::text));
  SELECT ab.id INTO clash FROM public.absences ab
  WHERE ab.user_id = tgt AND ab.id IS DISTINCT FROM p_id AND daterange(ab.from_date, ab.to_date, '[]') && daterange(f, t, '[]') LIMIT 1;
  IF clash IS NOT NULL THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This person already has an absence on these dates.', 'existing_id', clash));
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.absences (user_id, kind, from_date, to_date, note, recorded_by) VALUES (tgt, k, f, t, nt, a) RETURNING id INTO nid;
    PERFORM public.log_audit_write('absence.recorded', 'absence', nid::text, NULL, public.rsn_absence_json(nid), 'absence recorded (informational, B12b)', NULL, NULL, NULL, false);
    PERFORM public.rsn_notify_absence(nid);
  ELSE
    before := public.rsn_absence_json(p_id);
    UPDATE public.absences SET kind = k, from_date = f, to_date = t, note = nt, version = version + 1, updated_at = now() WHERE id = p_id;
    nid := p_id;
    PERFORM public.log_audit_write('absence.changed', 'absence', nid::text, before, public.rsn_absence_json(nid), 'absence changed (informational, B12b)', NULL, NULL, NULL, false);
  END IF;
  RETURN nid;
END $$;

CREATE OR REPLACE FUNCTION ops_delete_absence(p_id uuid, p_version integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); r public.absences%ROWTYPE; before jsonb;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.absences WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT (r.user_id = a OR public.rsn_leads_person(a, r.user_id)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The absence does not exist or is not visible to you.'));
  END IF;
  IF NOT public.rsn_leads_person(a, r.user_id) AND r.recorded_by <> a THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Your lead recorded this absence; ask them to remove it.'));
  END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  before := public.rsn_absence_json(p_id);
  DELETE FROM public.absences WHERE id = p_id;
  PERFORM public.log_audit_write('absence.removed', 'absence', p_id::text, before, NULL, 'absence removed (informational, B12b)', NULL, NULL, NULL, false);
END $$;

-- The lead decision for one task, one site or all of a person's open tasks (B12b): keep, reassign or act_on_behalf. Returns the BulkResult.
CREATE OR REPLACE FUNCTION ops_reassign_tasks(p_req jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a uuid := public.app_actor(); sc text; dc text; rs text; dry boolean; v_task uuid; v_site uuid; v_from uuid; v_to uuid;
  lr integer[]; see integer[]; bulk uuid := gen_random_uuid(); done jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb;
  t public.task_instances%ROWTYPE; k text; rl public."MatrixRule"; on_u uuid; tid uuid; ids uuid[]; before jsonb; tu public.users%ROWTYPE; lvl integer;
  d date := public.cal_today(); st uuid[];
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_req IS NULL OR jsonb_typeof(p_req) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The body is not an object.')); END IF;
  sc := p_req ->> 'scope'; dc := p_req ->> 'decision'; rs := btrim(coalesce(p_req ->> 'reason', ''));
  dry := coalesce((p_req ->> 'dry_run')::boolean, false);
  BEGIN
    v_task := nullif(p_req ->> 'task_id', '')::uuid; v_site := nullif(p_req ->> 'site_id', '')::uuid;
    v_from := nullif(p_req ->> 'from_user_id', '')::uuid; v_to := nullif(p_req ->> 'to_user_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'An id is not valid.'));
  END;
  IF sc IS NULL OR sc NOT IN ('task', 'site', 'person') OR dc IS NULL OR dc NOT IN ('reassign', 'act_on_behalf', 'keep') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/scope', 'code', 'invalid', 'message', 'scope is task, site or person; decision is reassign, act_on_behalf or keep.'))));
  END IF;
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A short reason (3 to 1000 characters) is required.'))));
  END IF;
  IF (sc = 'task' AND v_task IS NULL) OR (sc <> 'task' AND v_from IS NULL) OR (sc = 'site' AND v_site IS NULL) OR (dc = 'reassign' AND v_to IS NULL) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', CASE WHEN dc = 'reassign' AND v_to IS NULL THEN '/to_user_id' WHEN sc = 'task' THEN '/task_id' WHEN v_from IS NULL THEN '/from_user_id' ELSE '/site_id' END,
      'code', 'required', 'message', 'task needs task_id; site needs site_id and from_user_id; person needs from_user_id; reassign needs to_user_id.'))));
  END IF;
  lr := public.rsn_lead_regions(a);
  IF lr IS NOT NULL AND cardinality(lr) = 0 THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a lead (the reassign grant for the module and region) or a System Admin decides on these tasks.'));
  END IF;
  see := public.wf_actor_regions('sites', 'view');
  -- the person named as the one the tasks are on (whose pin or all-members vote moves) must be led by the caller, in every scope
  IF v_from IS NOT NULL AND NOT public.rsn_leads_person(a, v_from) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You lead this person only when every region of theirs is one of yours.'));
  END IF;
  IF dc = 'reassign' THEN
    SELECT * INTO tu FROM public.users WHERE id = v_to;
    IF NOT FOUND OR tu.status <> 'active' OR tu.deleted_at IS NOT NULL OR tu.is_break_glass OR v_to = v_from OR public.rsn_absence_on(v_to, d) IS NOT NULL THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'This person cannot receive the task (not active, absent today, or the same person).', 'target', true));
    END IF;
  END IF;

  IF sc = 'task' THEN
    SELECT * INTO t FROM public.task_instances WHERE id = v_task;
    IF NOT FOUND OR NOT public.app_region_check(t.region_id) OR (see IS NOT NULL AND NOT t.region_id = ANY (see)) THEN PERFORM public.wf_err('not_found'); END IF;
    IF NOT public.rsn_is_lead(a, t.region_id)
       OR (public.rsn_task_on(v_task) IS NOT NULL AND NOT public.rsn_leads_person(a, public.rsn_task_on(v_task))) THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need the reassign grant for the region of this task and for every region of the person it is on.'));
    END IF;
    ids := ARRAY[v_task];
  ELSE
    st := public.rsn_candidate_stages(v_from);
    SELECT coalesce(array_agg(ti.id ORDER BY ti.id), ARRAY[]::uuid[]) INTO ids
    FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
    WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval')
      AND (lr IS NULL OR ti.region_id = ANY (lr)) AND (see IS NULL OR ti.region_id = ANY (see)) AND public.app_region_check(ti.region_id)
      AND (sc = 'person' OR ti.site_id = v_site)
      AND (ti.ball_in_court_user_id = v_from OR (ti.ball_in_court_user_id IS NULL AND td.stage_id = ANY (st)))
      AND public.rsn_task_on(ti.id) = v_from;
  END IF;

  FOREACH tid IN ARRAY ids LOOP
    SELECT * INTO t FROM public.task_instances WHERE id = tid FOR UPDATE;
    IF t.state NOT IN ('open', 'entry', 'in_review', 'in_approval') THEN
      failed := failed || jsonb_build_array(jsonb_build_object('ref', tid, 'code', 'invalid_transition', 'message', 'The task is not open (it is ' || t.state::text || ').'));
      CONTINUE;
    END IF;
    lvl := greatest(t.current_level, 1);
    k := public.wf_kind(public.wf_task_levels(tid), lvl);
    rl := public.wf_rule(tid, k);
    on_u := coalesce(public.rsn_task_on(tid), v_from);
    IF dc = 'reassign' THEN
      IF NOT public.wf_is_eligible(tid, k, v_to) THEN
        failed := failed || jsonb_build_array(jsonb_build_object('ref', tid, 'code', 'not_eligible_holder', 'message', 'This person is not an eligible holder of the level in the Responsibility Matrix, region and module.'));
        CONTINUE;
      END IF;
      IF rl = 'all_members' THEN
        IF v_from IS NULL OR NOT EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = tid AND v.level = t.current_level AND v.round = t.level_round AND v.user_id = v_from AND v.voted_at IS NULL) THEN
          failed := failed || jsonb_build_array(jsonb_build_object('ref', tid, 'code', 'invalid_transition', 'message', 'Every member votes on this level: name the member (from_user_id) whose vote moves.'));
          CONTINUE;
        END IF;
        IF EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = tid AND v.level = t.current_level AND v.round = t.level_round AND v.user_id = v_to) THEN
          skipped := skipped || jsonb_build_array(jsonb_build_object('ref', tid, 'code', 'already_assigned', 'message', 'This person already votes on this level.'));
          CONTINUE;
        END IF;
      ELSIF on_u IS NOT DISTINCT FROM v_to THEN
        skipped := skipped || jsonb_build_array(jsonb_build_object('ref', tid, 'code', 'already_assigned', 'message', 'The task is already with this person.'));
        CONTINUE;
      END IF;
      IF NOT dry THEN
        before := public.wf_snap(tid);
        IF rl = 'all_members' THEN
          UPDATE public.task_level_voters SET user_id = v_to WHERE task_id = tid AND level = t.current_level AND round = t.level_round AND user_id = v_from;
        ELSE
          -- a task-level holder change: the current level is pinned to the new person; nothing else of the task changes (B12b)
          UPDATE public.task_instances SET ball_in_court_user_id = v_to WHERE id = tid;
        END IF;
        UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = tid;
        PERFORM public.wf_step(tid, lvl, 'reassign', a, rs, t.state, t.state, false, false);
        INSERT INTO public.task_cover_decisions (bulk_action_id, task_id, region_id, decision, level, from_user_id, to_user_id, decided_by, reason)
        VALUES (bulk, tid, t.region_id, 'reassign', lvl, on_u, v_to, a, rs);
        PERFORM public.wf_audit('task_reassign', tid, before || jsonb_build_object('holder', on_u),
          public.wf_snap(tid) || jsonb_build_object('holder', v_to, 'bulk_action_id', bulk, 'decision', 'reassign', 'scope', sc, 'matrix_changed', false), rs);
        PERFORM public.wf_notify(v_to, 'reassigned', 'A task was reassigned to you', public.wf_label(tid) || ': ' || rs, tid);
        IF on_u IS NOT NULL AND on_u <> v_to THEN
          PERFORM public.wf_notify(on_u, 'reassigned', 'A task of yours was reassigned', public.wf_label(tid) || ': ' || rs, tid);
        END IF;
      END IF;
    ELSIF NOT dry THEN
      INSERT INTO public.task_cover_decisions (bulk_action_id, task_id, region_id, decision, level, from_user_id, decided_by, reason)
      VALUES (bulk, tid, t.region_id, dc, lvl, on_u, a, rs);
      PERFORM public.wf_audit('task_cover_' || dc, tid, public.wf_snap(tid),
        public.wf_snap(tid) || jsonb_build_object('holder', on_u, 'bulk_action_id', bulk, 'decision', dc, 'scope', sc), rs);
    END IF;
    done := done || jsonb_build_array(jsonb_build_object('id', tid));
  END LOOP;
  RETURN jsonb_build_object('bulk_action_id', bulk, 'dry_run', dry, 'done', done, 'skipped', skipped, 'failed', failed);
END $$;

-- B12b choice 3: the lead performs the current level for the person it is on. The transition is the engine's own (wf_complete / wf_reject).
CREATE OR REPLACE FUNCTION ops_act_on_behalf(p_task uuid, p_version integer, p_action text, p_level integer, p_reason text, p_note text, p_stepup boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a uuid := public.app_actor(); t public.task_instances%ROWTYPE; k text; holder uuid; res jsonb; rs text := btrim(coalesce(p_reason, '')); hs jsonb; cal uuid;
  hu public.users%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  t := public.wf_lock_task(p_task, p_version);   -- 404 outside the caller's regions, 412 on a stale version
  IF NOT public.rsn_is_lead(a, t.region_id) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need the reassign grant for the region of this task to act on behalf of its holder.'));
  END IF;
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A short reason (3 to 1000 characters) is required.'))));
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('submit', 'review', 'approve', 'reject') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'action is submit, review, approve or reject.'))));
  END IF;
  IF t.state NOT IN ('entry', 'in_review', 'in_approval') OR p_level IS DISTINCT FROM t.current_level THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is at another level or state; reload it.'));
  END IF;
  k := public.wf_kind(public.wf_task_levels(p_task), greatest(t.current_level, 1));
  IF public.wf_rule(p_task, k) = 'all_members' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Every member votes on this level: reassign the vote instead of acting on it.'));
  END IF;
  holder := public.rsn_task_on(p_task);
  -- a level on nobody (shared, or no eligible holder) is not covered: that is the "no holder" path to the System Admins (B10)
  IF holder IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This level has no single holder to act for; any eligible holder may take it, and a level with no holder goes to the System Admins.'));
  END IF;
  IF NOT public.rsn_leads_person(a, holder) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You lead the holder of this task only when every region of theirs is one of yours.'));
  END IF;
  IF holder = a THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is with you: act on it directly.'));
  END IF;
  -- informational (B12b: the lead decides, no precondition): the holder's state at this moment
  SELECT * INTO hu FROM public.users WHERE id = holder;
  SELECT r.calendar_id INTO cal FROM public.sla_rules r WHERE r.id = t.sla_rule_id;
  hs := jsonb_build_object('holder', holder, 'holder_absent', public.rsn_absence_on(holder, public.cal_today()) IS NOT NULL,
          'holder_deactivated', hu.status IN ('suspended', 'disabled') OR hu.deleted_at IS NOT NULL,
          'idle_working_days', public.cal_workdays_between(public.cal_local_date(public.task_last_activity(p_task)), public.cal_today(), cal),
          'idle_limit', public.task_stale_idle_days());
  -- the marker names the level: a cover granted at this level is never usable at another one
  PERFORM public.hgd_mark('rsn_cover', p_task::text || '|' || a::text || '|' || t.current_level::text || '|' || holder::text);
  IF p_action = 'reject' THEN
    res := public.wf_reject(p_task, p_version, p_note, '[]'::jsonb);
  ELSE
    res := public.wf_complete(p_task, p_version, p_action, p_note, p_stepup);
  END IF;
  INSERT INTO public.task_cover_decisions (bulk_action_id, task_id, region_id, decision, level, from_user_id, action, decided_by, reason)
  VALUES (gen_random_uuid(), p_task, t.region_id, 'acted_on_behalf', t.current_level, holder, p_action, a, rs);
  PERFORM public.wf_audit('task_act_on_behalf', p_task, jsonb_build_object('level', t.current_level, 'state', t.state) || hs,
    public.wf_snap(p_task) || jsonb_build_object('action', p_action, 'step_ids', res -> 'step_ids', 'skipped_levels', res -> 'skipped_levels') || hs, rs);
  PERFORM public.hgd_unmark('rsn_cover');
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE absences OWNER TO pmis_definer;
ALTER TABLE task_cover_decisions OWNER TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  -- internal: never callable by pmis_app
  FOREACH f IN ARRAY ARRAY[
    'rsn_lead_regions(uuid)', 'rsn_is_lead(uuid,integer)', 'rsn_user_regions(uuid)', 'rsn_leads_person(uuid,uuid)', 'rsn_candidate_stages(uuid)',
    'rsn_task_on(uuid)', 'rsn_absence_on(uuid,date)', 'rsn_recently_decided(uuid,uuid,integer)', 'rsn_covering(uuid)', 'rsn_covering_at(uuid,integer)',
    'rsn_cover_twice(uuid,integer,uuid)', 'rsn_absence_json(uuid)',
    'rsn_notify_absence(uuid)', 'mail_kind_catalogue()',
    'wf_require_actor(uuid,text,uuid)', 'wf_step(uuid,integer,text,uuid,text,"TaskState","TaskState",boolean,boolean)', 'wf_audit(text,uuid,jsonb,jsonb,text)',
    'wf_complete_hw(uuid,integer,text,text,boolean,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
  -- the doors of the API
  FOREACH f IN ARRAY ARRAY[
    'rsn_visible_absences()', 'rsn_open_task_counts(uuid[])', 'rsn_holder_absent(uuid[])', 'rsn_alerts(text,uuid,integer)', 'rsn_eligible_users(uuid,uuid,uuid)',
    'ops_save_absence(uuid,integer,jsonb)', 'ops_delete_absence(uuid,integer)', 'ops_reassign_tasks(jsonb)',
    'ops_act_on_behalf(uuid,integer,text,integer,text,text,boolean)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;
