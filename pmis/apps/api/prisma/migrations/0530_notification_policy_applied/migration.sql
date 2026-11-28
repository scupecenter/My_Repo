-- 0530 (B1): the notification policy (setting notifications.policy, Settings > Alerts > Policy, 0145) is APPLIED. Until now it was stored and edited but nothing read it.
--
-- WHAT IS APPLIED, WHERE (one rule for every emitter, because it sits on the notifications table and not in each of the 36 places that write to it)
--   1. SWITCH. policy.enabled = false: governed in-app notices are not written. A governed notice is a kind of the catalogue (notif_catalogue()). Kinds that carry a
--      mandatory type (no_holder, security_alert, mfa_exemption) always pass. Kinds the catalogue does not list (mention, delegation, snags, digests) are not governed.
--   2. CHANNELS. A notice is written only when the matrix of the types of its kind has the channel on (stored row, else the catalogue default). E-mail: mail_on_notification
--      (0055) mails a kind that is in mail.notification_kinds OR whose stored matrix row has e-mail on; a stored row with e-mail off stops it.
--   3. RATE CAP. thresholds.rate_cap_per_hour: more than that many in-app notices to one person in the last hour are not written, except types of the categories
--      approvals and security (they have their own cadence) and mandatory ones.
--   4. COLUMNS (type x role/group). A stored cell that is on adds the members of that role or group (active, in the region of the notice) as recipients of every notice of that type.
--      The people who were already told, and the same notice twice in one transaction, are not repeated.
--   5. REMINDER (thresholds.approval_remind_hours), ESCALATION (approval_escalate_days, working days of the policy) and NO HOLDER: notif_policy_tick() writes the kind
--      approval_due to the holders, then to the Team Leads of the region (people with the reassign grant there; the System Admins when there is none), and no_holder
--      to the System Admins for a level nobody can act on. Once per level opening and person. Nothing changes in the task or record.
--   6. IDLE TASK: kind idle_task_alert to the Team Leads when a task is idle for the working days of dashboard.settings.stale_idle_days and the switch tasks.idle_alert is on.
--   7. RETENTION: thresholds.retention_days deletes older notices.
--   8. DIGEST HOUR: notif_digest_due() says when the policy hour has come in the policy time zone; the hourly job runs the approval digest and the weekly digest then
--      (they moved from the 02:00 daily run).
-- The kind task_returned of the notification kind list is an old alias: the engine writes task_rejected (0015), which the catalogue governs.
-- Reads and writes of the policy itself are unchanged (admin_set_notification_policy, 0145). SAFE TO REPEAT.

GRANT SELECT ON users, groups, group_members, roles, user_role_assignments, regions, sla_rules, audit_log, workflow_steps, comments, document_slots, document_files TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON notifications TO pmis_definer;

CREATE OR REPLACE FUNCTION notif_policy_raw() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT s.value FROM public.settings s WHERE s.key = 'notifications.policy'), '{}'::jsonb)
$$;

-- The stored e-mail decision for a kind: NULL when the admin never saved a matrix row for it, else true when any type of the kind has e-mail on.
CREATE OR REPLACE FUNCTION notif_policy_email(p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT bool_or(coalesce((m -> 'channels' ->> 'email')::boolean, false))
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(public.notif_policy_raw() -> 'matrix') = 'array' THEN public.notif_policy_raw() -> 'matrix' ELSE '[]'::jsonb END) m
  WHERE m ->> 'type_code' IN (SELECT t ->> 'code' FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = p_kind)
$$;

-- 1 to 3: the gate. BEFORE INSERT, after notifications_scope (0040) has set region_id and module_key.
CREATE OR REPLACE FUNCTION notifications_policy_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; types jsonb; cap integer; n integer; ch_ok boolean;
BEGIN
  SELECT jsonb_agg(t) INTO types FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = NEW.kind;
  IF types IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(types) t WHERE (t ->> 'mandatory')::boolean) THEN RETURN NEW; END IF;
  c := public.notif_policy_raw();
  IF coalesce(CASE WHEN jsonb_typeof(c -> 'enabled') = 'boolean' THEN (c ->> 'enabled')::boolean END, true) IS NOT TRUE THEN RETURN NULL; END IF;
  ch_ok := EXISTS (
    SELECT 1 FROM jsonb_array_elements(types) t
    WHERE coalesce(
      (SELECT (m -> 'channels' ->> NEW.channel::text)::boolean
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c -> 'matrix') = 'array' THEN c -> 'matrix' ELSE '[]'::jsonb END) m
         WHERE m ->> 'type_code' = t ->> 'code' LIMIT 1),
      (t -> 'default_channels' ->> NEW.channel::text)::boolean, true));
  IF NOT ch_ok THEN RETURN NULL; END IF;
  -- the same notice twice in one transaction (a person who is both a holder and a column member)
  IF EXISTS (SELECT 1 FROM public.notifications x WHERE x.user_id = NEW.user_id AND x.kind = NEW.kind AND x.title = NEW.title
             AND x.link IS NOT DISTINCT FROM NEW.link AND x.created_at = NEW.created_at AND x.channel = NEW.channel) THEN RETURN NULL; END IF;
  IF NEW.channel = 'in_app' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(types) t WHERE t ->> 'category' IN ('approvals', 'security')) THEN
    cap := CASE WHEN (c -> 'thresholds' ->> 'rate_cap_per_hour') ~ '^[0-9]{1,6}$' THEN (c -> 'thresholds' ->> 'rate_cap_per_hour')::integer ELSE 50 END;
    SELECT count(*) INTO n FROM public.notifications x WHERE x.user_id = NEW.user_id AND x.channel = 'in_app' AND x.created_at > NEW.created_at - interval '1 hour';
    IF n >= cap THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END $$;

-- 4: the columns of the matrix add recipients.
CREATE OR REPLACE FUNCTION notifications_policy_fanout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb;
BEGIN
  IF NEW.channel <> 'in_app' OR coalesce(current_setting('pmis.notif_fanout', true), '') = '1' THEN RETURN NULL; END IF;
  c := public.notif_policy_raw();
  IF jsonb_typeof(c -> 'matrix') <> 'array' THEN RETURN NULL; END IF;
  PERFORM set_config('pmis.notif_fanout', '1', true);
  INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link)
  SELECT DISTINCT m.uid, 'in_app'::public."NotifyChannel", NEW.kind, NEW.title, NEW.body, NEW.task_id, NEW.link
  FROM (
    SELECT ua.user_id AS uid
    FROM jsonb_array_elements(c -> 'matrix') mx
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mx -> 'cells') = 'array' THEN mx -> 'cells' ELSE '[]'::jsonb END) cl
    JOIN public.roles r ON r.id::text = cl ->> 'id' AND r.is_active
    JOIN public.user_role_assignments ua ON ua.role_id = r.id AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
    WHERE mx ->> 'type_code' IN (SELECT t ->> 'code' FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = NEW.kind)
      AND cl ->> 'kind' = 'role' AND coalesce((cl ->> 'on')::boolean, false)
    UNION
    SELECT gm.user_id
    FROM jsonb_array_elements(c -> 'matrix') mx
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mx -> 'cells') = 'array' THEN mx -> 'cells' ELSE '[]'::jsonb END) cl
    JOIN public.groups g ON g.id::text = cl ->> 'id' AND g.is_active
    JOIN public.group_members gm ON gm.group_id = g.id
    WHERE mx ->> 'type_code' IN (SELECT t ->> 'code' FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = NEW.kind)
      AND cl ->> 'kind' = 'group' AND coalesce((cl ->> 'on')::boolean, false)
  ) m
  JOIN public.users u ON u.id = m.uid AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
  WHERE m.uid <> NEW.user_id
    AND (NEW.region_id IS NULL OR public.app_user_is_system_admin(m.uid) OR public.wf_user_in_scope(m.uid, NEW.region_id));
  PERFORM set_config('pmis.notif_fanout', '', true);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS z_notifications_policy_gate ON notifications;
CREATE TRIGGER z_notifications_policy_gate BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_policy_gate();
DROP TRIGGER IF EXISTS z_notifications_policy_fanout ON notifications;
CREATE TRIGGER z_notifications_policy_fanout AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_policy_fanout();

-- 2 (e-mail): patch the stored text of mail_on_notification in place (idempotent), so any later redefinition is kept.
DO $$
DECLARE def text; mark text := 'IF jsonb_typeof(kinds) <> ''array'' OR NOT kinds ? NEW.kind THEN RETURN NULL; END IF;';
BEGIN
  def := pg_get_functiondef('public.mail_on_notification()'::regprocedure);
  IF position('notif_policy_email' IN def) = 0 AND position(mark IN def) > 0 THEN
    EXECUTE replace(def, mark, 'IF coalesce(public.notif_policy_email(NEW.kind), jsonb_typeof(kinds) = ''array'' AND kinds ? NEW.kind) IS NOT TRUE THEN RETURN NULL; END IF;');
  END IF;
END $$;

-- 5 to 6: who waits, who leads.
-- Items waiting at a review or approval level (tasks and register records), with the Matrix cell that decides the level; the same rule as approval_digest_notify (0362).
CREATE OR REPLACE FUNCTION notif_waiting_items() RETURNS TABLE (src text, id uuid, region_id integer, kind text, level_opened_at timestamptz, claimant uuid, cell uuid, module text, link text, label text, task_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT 'task'::text, t.id, t.region_id, CASE t.state::text WHEN 'in_review' THEN 'review' ELSE 'approve' END, t.level_opened_at, t.ball_in_court_user_id,
         (SELECT c.id FROM public.task_definitions td JOIN public.matrix_cells c ON c.stage_id = td.stage_id
            WHERE td.id = t.task_def_id AND c.level = CASE t.state::text WHEN 'in_review' THEN 2 ELSE 3 END
              AND (c.task_def_id IS NULL OR c.task_def_id = td.id) AND (c.region_id IS NULL OR c.region_id = t.region_id)
            ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id LIMIT 1),
         'sites'::text, '/tasks/' || t.id::text, public.wf_label(t.id), t.id
  FROM public.task_instances t WHERE t.state::text IN ('in_review', 'in_approval')
  UNION ALL
  SELECT 'record', r.id, r.region_id, CASE r.state WHEN 'in_review' THEN 'review' ELSE 'approve' END, r.level_opened_at, r.ball_in_court_user_id,
         CASE WHEN r.task_id IS NOT NULL THEN
           (SELECT c.id FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id JOIN public.matrix_cells c ON c.stage_id = td.stage_id
              WHERE t.id = r.task_id AND c.level = CASE r.state WHEN 'in_review' THEN 2 ELSE 3 END
                AND (c.task_def_id IS NULL OR c.task_def_id = td.id) AND (c.region_id IS NULL OR c.region_id = t.region_id)
              ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id LIMIT 1)
         ELSE public.reg_cell_row(r.register_key, r.region_id, CASE r.state WHEN 'in_review' THEN 'review' ELSE 'approve' END) END,
         CASE WHEN r.task_id IS NOT NULL THEN 'sites' ELSE public.reg_module(r.register_key) END,
         '/registers/' || r.register_key || '/records/' || r.id::text, public.reg_label(r.id), NULL::uuid
  FROM public.register_records r WHERE r.state IN ('in_review', 'in_approval') AND r.voided_at IS NULL
$$;

CREATE OR REPLACE FUNCTION notif_admin_users() RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
  JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL AND NOT x.is_break_glass
$$;

-- The Team Leads of a region: people with the reassign grant there and in scope; the System Admins when there is none.
CREATE OR REPLACE FUNCTION notif_escalation_targets(p_region integer) RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH leads AS (
    SELECT u.id AS uid FROM public.users u
    WHERE u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass AND NOT public.app_user_is_system_admin(u.id)
      AND p_region IS NOT NULL AND public.ss_holds_reassign(u.id, p_region) AND public.wf_user_in_scope(u.id, p_region))
  SELECT uid FROM leads UNION ALL SELECT a.user_id FROM public.notif_admin_users() a WHERE NOT EXISTS (SELECT 1 FROM leads)
$$;

-- 8: the policy hour has come (in the policy time zone) and the policy is on.
CREATE OR REPLACE FUNCTION notif_digest_due(p_now timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb := public.notif_policy_view(public.notif_policy_raw());
BEGIN
  RETURN (v ->> 'enabled')::boolean AND extract(hour FROM p_now AT TIME ZONE (v ->> 'timezone'))::integer >= (v ->> 'digest_hour')::integer;
END $$;

-- The hourly step. Returns the counts written.
CREATE OR REPLACE FUNCTION notif_policy_tick(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := public.notif_policy_view(public.notif_policy_raw());
  tz text := v ->> 'timezone'; enabled boolean := (v ->> 'enabled')::boolean;
  remind_h integer := coalesce((v -> 'thresholds' ->> 'approval_remind_hours')::integer, 48);
  esc_d integer := coalesce((v -> 'thresholds' ->> 'approval_escalate_days')::integer, 5);
  retain integer := coalesce((v -> 'thresholds' ->> 'retention_days')::integer, 180);
  workdays integer[] := ARRAY(SELECT jsonb_array_elements_text(v -> 'work_days')::integer);
  today date := (p_now AT TIME ZONE tz)::date;
  idle_on boolean := coalesce((SELECT (s.value ->> 'enabled')::boolean FROM public.settings s WHERE s.key = 'tasks.idle_alert'), true);
  idle_n integer := public.task_stale_idle_days();
  n_rem integer := 0; n_esc integer := 0; n_nh integer := 0; n_idle integer := 0; n_purged integer := 0;
BEGIN
  IF enabled THEN
    -- reminder to the holders of the level
    INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link)
    SELECT DISTINCT e.user_id, 'in_app'::public."NotifyChannel", 'approval_due', 'Approval reminder',
           i.label || ': waiting for your ' || i.kind || ' for more than ' || remind_h::text || ' hours.', i.task_id, i.link
    FROM public.notif_waiting_items() i
    CROSS JOIN LATERAL public.reg_eligible_cell(i.cell, i.region_id, i.module, i.kind::public."PermissionLevel") e
    WHERE i.cell IS NOT NULL AND i.level_opened_at IS NOT NULL AND (i.claimant IS NULL OR i.claimant = e.user_id)
      AND i.level_opened_at <= p_now - remind_h * interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = e.user_id AND nt.kind = 'approval_due' AND nt.title = 'Approval reminder'
                      AND nt.link = i.link AND nt.created_at >= i.level_opened_at);
    GET DIAGNOSTICS n_rem = ROW_COUNT;
    -- escalation to the Team Lead of the region
    INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link)
    SELECT DISTINCT g.user_id, 'in_app'::public."NotifyChannel", 'approval_due', 'Approval escalated',
           i.label || ': waiting at the ' || i.kind || ' level for more than ' || esc_d::text || ' working days.', i.task_id, i.link
    FROM public.notif_waiting_items() i
    CROSS JOIN LATERAL public.notif_escalation_targets(i.region_id) g
    WHERE i.level_opened_at IS NOT NULL
      AND (SELECT count(*) FROM generate_series((i.level_opened_at AT TIME ZONE tz)::date + 1, today, interval '1 day') d WHERE extract(dow FROM d)::integer = ANY (workdays)) >= esc_d
      AND NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = g.user_id AND nt.kind = 'approval_due' AND nt.title = 'Approval escalated'
                      AND nt.link = i.link AND nt.created_at >= i.level_opened_at);
    GET DIAGNOSTICS n_esc = ROW_COUNT;
    -- idle tasks to the Team Lead
    IF idle_on THEN
      INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link)
      SELECT DISTINCT g.user_id, 'in_app'::public."NotifyChannel", 'idle_task_alert', 'Task idle', public.wf_label(x.id) || ': no activity for ' || x.wd::text || ' working days.', x.id, '/tasks/' || x.id::text
      FROM (
        SELECT t.id, t.region_id, la.at,
               public.cal_workdays_between(public.cal_local_date(la.at), public.cal_today(), r.calendar_id) AS wd
        FROM public.task_instances t
        LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
        CROSS JOIN LATERAL (SELECT coalesce(greatest(
             t.level_opened_at,
             (SELECT max(a.at) FROM public.audit_log a WHERE a.entity_type = 'task' AND a.entity_id = t.id::text AND a.actor_id IS NOT NULL),
             (SELECT max(w.created_at) FROM public.workflow_steps w WHERE w.task_id = t.id AND w.acted_by IS NOT NULL),
             (SELECT max(c.created_at) FROM public.comments c WHERE c.task_id = t.id),
             (SELECT max(f.uploaded_at) FROM public.document_slots ds JOIN public.document_files f ON f.slot_id = ds.id WHERE ds.task_id = t.id)), t.updated_at) AS at) la
        WHERE t.state::text IN ('open', 'entry', 'in_review', 'in_approval')) x
      CROSS JOIN LATERAL public.notif_escalation_targets(x.region_id) g
      WHERE x.wd >= idle_n
        AND NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = g.user_id AND nt.kind = 'idle_task_alert' AND nt.task_id = x.id AND nt.created_at >= x.at);
      GET DIAGNOSTICS n_idle = ROW_COUNT;
    END IF;
  END IF;
  -- a level nobody can act on: to the System Admins, whatever the switch (the kind is mandatory)
  INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link)
  SELECT DISTINCT a.user_id, 'in_app'::public."NotifyChannel", 'no_holder', 'Level has no holder', i.label || ': nobody can act on the ' || i.kind || ' level.', i.task_id, i.link
  FROM public.notif_waiting_items() i
  CROSS JOIN public.notif_admin_users() a
  WHERE i.cell IS NOT NULL AND i.level_opened_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.reg_eligible_cell(i.cell, i.region_id, i.module, i.kind::public."PermissionLevel") e WHERE i.claimant IS NULL OR i.claimant = e.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = a.user_id AND nt.kind = 'no_holder' AND nt.title = 'Level has no holder'
                    AND nt.link = i.link AND nt.created_at >= i.level_opened_at);
  GET DIAGNOSTICS n_nh = ROW_COUNT;
  IF retain >= 1 THEN
    DELETE FROM public.notifications WHERE created_at < p_now - retain * interval '1 day';
    GET DIAGNOSTICS n_purged = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('reminders', n_rem, 'escalations', n_esc, 'idle', n_idle, 'no_holder', n_nh, 'purged', n_purged);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['notif_policy_raw()', 'notif_policy_email(text)', 'notifications_policy_gate()', 'notifications_policy_fanout()', 'notif_waiting_items()',
                           'notif_admin_users()', 'notif_escalation_targets(integer)', 'notif_digest_due(timestamptz)', 'notif_policy_tick(timestamptz)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION notif_digest_due(timestamptz), notif_policy_tick(timestamptz) TO pmis_app;
  END IF;
END $$;
