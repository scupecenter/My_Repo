-- 0583_notification_personal (contract 0.15.531): the personal layer on top of the applied policy (B1, 0530). Item 4 and item 7 of the 2026-11-27 batch
-- (event x channel notification matrix, scheduled do-not-disturb). Mirror: db/sql/582_notification_personal.sql (kept identical).
--
-- B1 already applies the org policy (switch, matrix by channel, rate cap, role/group columns, reminders, retention) in the trigger z_notifications_policy_gate.
-- This migration adds ONLY what B1 does not have, and reuses its catalogue (notif_catalogue()), its time zone (notif_policy_view) and its trigger chain:
--   1. notification_user_prefs: one row per person. Per type (the catalogue) the person may turn the bell and the e-mail off; a scheduled do-not-disturb
--      (days, start, end, time zone) and a snooze until a time. A mandatory type (no_holder, security_alert, mfa_exemption) can never be turned off or held.
--   2. Quiet time (do-not-disturb or snooze) holds the e-mail and the browser push. The bell always receives the notice. Push waits and is sent when quiet ends;
--      an e-mail written in quiet time is not sent (the notice stays in the bell).
--   3. Cross-transaction dedupe: the same unread notice (person, kind, title, link, channel) inside the dedupe window is not written again (B1 only dedupes
--      inside one transaction). Window and switch are org settings (notifications.personal), 10 minutes by default, 0 = off.
--   4. notification_decisions: one row for every notice the personal layer stopped or held (the reason is shown to the person), kept for the org retention
--      (default 30 days, purged by the hourly step of B1).
--   5. Test notice: notif_my_test() writes one notice of the ungoverned kind system to the caller, with a 30 second pause between tests.
-- Additive. No permission, grant-to-role or audit-meaning change; the org settings change is audited. SAFE TO REPEAT.

CREATE TABLE IF NOT EXISTS notification_user_prefs (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
  types          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(types) = 'object'),
  dnd_enabled    boolean NOT NULL DEFAULT false,
  dnd_start      smallint NOT NULL DEFAULT 1320 CHECK (dnd_start BETWEEN 0 AND 1439),
  dnd_end        smallint NOT NULL DEFAULT 420 CHECK (dnd_end BETWEEN 0 AND 1439),
  dnd_days       smallint[] NOT NULL DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[] CHECK (dnd_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  dnd_timezone   text CHECK (dnd_timezone IS NULL OR length(dnd_timezone) BETWEEN 1 AND 64),
  snooze_until   timestamptz,
  version        integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
  kind        text NOT NULL,
  channel     text NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('type_off', 'duplicate', 'quiet_mail')),
  title       text,
  link        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_decisions_user ON notification_decisions (user_id, created_at DESC);

ALTER TABLE notification_user_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_user_prefs FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON notification_user_prefs;
CREATE POLICY rls_select ON notification_user_prefs FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
DROP POLICY IF EXISTS rls_seed_write ON notification_user_prefs;
CREATE POLICY rls_seed_write ON notification_user_prefs FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
DROP POLICY IF EXISTS rls_select ON notification_decisions;
CREATE POLICY rls_select ON notification_decisions FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
DROP POLICY IF EXISTS rls_seed_write ON notification_decisions;
CREATE POLICY rls_seed_write ON notification_decisions FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- The org settings of the personal layer (Settings > Alerts > Policy). Defaults when never saved.
CREATE OR REPLACE FUNCTION notif_personal_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('allow_personal', true, 'allow_dnd', true, 'dedupe_minutes', 10, 'decision_retention_days', 30)
         || coalesce((SELECT s.value - 'version' FROM public.settings s WHERE s.key = 'notifications.personal' AND jsonb_typeof(s.value) = 'object'), '{}'::jsonb)
$$;

-- Is the type of this kind mandatory (no_holder, security_alert, mfa_exemption)? A kind the catalogue does not list is not governed and is treated as mandatory here.
CREATE OR REPLACE FUNCTION notif_kind_mandatory(p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = p_kind)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = p_kind AND coalesce((t ->> 'mandatory')::boolean, false))
$$;

-- Quiet time of a person at an instant: a snooze that has not ended, or inside the scheduled do-not-disturb window (the window may cross midnight; its day is the
-- day it starts). The org switch allow_dnd = false turns the schedule off for everybody (a snooze stays).
CREATE OR REPLACE FUNCTION notif_user_quiet(p_user uuid, p_at timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.notification_user_prefs%ROWTYPE; cfg jsonb := public.notif_personal_cfg(); tz text; loc timestamp; m integer; d integer; pd integer;
BEGIN
  IF coalesce((cfg ->> 'allow_personal')::boolean, true) IS NOT TRUE THEN RETURN false; END IF;
  SELECT * INTO p FROM public.notification_user_prefs x WHERE x.user_id = p_user;
  IF p.user_id IS NULL THEN RETURN false; END IF;
  IF p.snooze_until IS NOT NULL AND p.snooze_until > p_at THEN RETURN true; END IF;
  IF NOT p.dnd_enabled OR coalesce((cfg ->> 'allow_dnd')::boolean, true) IS NOT TRUE THEN RETURN false; END IF;
  tz := coalesce(p.dnd_timezone, public.notif_policy_view(public.notif_policy_raw()) ->> 'timezone', 'UTC');
  BEGIN
    loc := p_at AT TIME ZONE tz;
  EXCEPTION WHEN others THEN
    loc := p_at AT TIME ZONE 'UTC';
  END;
  m := extract(hour FROM loc)::integer * 60 + extract(minute FROM loc)::integer;
  d := extract(dow FROM loc)::integer;
  pd := (d + 6) % 7;
  IF p.dnd_start = p.dnd_end THEN RETURN false; END IF;
  IF p.dnd_start < p.dnd_end THEN
    RETURN m >= p.dnd_start AND m < p.dnd_end AND d = ANY (p.dnd_days);
  END IF;
  RETURN (m >= p.dnd_start AND d = ANY (p.dnd_days)) OR (m < p.dnd_end AND pd = ANY (p.dnd_days));
END $$;

-- 1 and 3: the personal gate. A second BEFORE INSERT trigger, fired after B1's z_notifications_policy_gate (trigger names fire in alphabetical order).
CREATE OR REPLACE FUNCTION notifications_user_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cfg jsonb := public.notif_personal_cfg(); types jsonb; p jsonb; win integer; why text;
BEGIN
  IF coalesce((cfg ->> 'allow_personal')::boolean, true) IS NOT TRUE THEN RETURN NEW; END IF;
  IF public.notif_kind_mandatory(NEW.kind) THEN RETURN NEW; END IF;
  SELECT jsonb_agg(t) INTO types FROM jsonb_array_elements(public.notif_catalogue()) t WHERE t ->> 'kind' = NEW.kind;
  SELECT x.types INTO p FROM public.notification_user_prefs x WHERE x.user_id = NEW.user_id;
  IF p IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(types) t
       WHERE coalesce((p -> (t ->> 'code') ->> NEW.channel::text)::boolean, true)) THEN
    why := 'type_off';
  END IF;
  win := CASE WHEN (cfg ->> 'dedupe_minutes') ~ '^[0-9]{1,4}$' THEN (cfg ->> 'dedupe_minutes')::integer ELSE 10 END;
  IF why IS NULL AND win > 0 AND EXISTS (
       SELECT 1 FROM public.notifications x
       WHERE x.user_id = NEW.user_id AND x.kind = NEW.kind AND x.channel = NEW.channel AND x.title = NEW.title AND x.link IS NOT DISTINCT FROM NEW.link
         AND x.read_at IS NULL AND x.created_at > NEW.created_at - win * interval '1 minute') THEN
    why := 'duplicate';
  END IF;
  IF why IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.notification_decisions (user_id, kind, channel, reason, title, link) VALUES (NEW.user_id, NEW.kind, NEW.channel::text, why, left(NEW.title, 300), NEW.link);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS z_notifications_user_gate ON notifications;
CREATE TRIGGER z_notifications_user_gate BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_user_gate();

-- 2 (e-mail): true when the notice must not be mailed now (quiet time, a governed kind). Written as a decision so the person can see it.
CREATE OR REPLACE FUNCTION notif_user_mail_blocked(p_user uuid, p_kind text, p_title text, p_link text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.notif_kind_mandatory(p_kind) OR NOT public.notif_user_quiet(p_user) THEN RETURN false; END IF;
  INSERT INTO public.notification_decisions (user_id, kind, channel, reason, title, link) VALUES (p_user, p_kind, 'email', 'quiet_mail', left(p_title, 300), p_link);
  RETURN true;
END $$;

DO $$
DECLARE def text; anchor text := 'IF coalesce(public.notif_policy_email(NEW.kind)';
BEGIN
  def := pg_get_functiondef('public.mail_on_notification()'::regprocedure);
  IF position('notif_user_mail_blocked' IN def) = 0 THEN
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'mail_on_notification: the policy anchor (0530) was not found'; END IF;
    EXECUTE replace(def, anchor, 'IF public.notif_user_mail_blocked(NEW.user_id, NEW.kind, NEW.title, NEW.link) THEN RETURN NULL; END IF; ' || anchor);
  END IF;
END $$;

-- 2 (push): a browser is woken when its person is not in quiet time, or when a mandatory notice waits; push_due keeps the cursor, so the rest is sent when quiet ends.
DO $$
DECLARE def text; anchor text := 'AND (n.snoozed_until IS NULL OR n.snoozed_until <= now())';
BEGIN
  def := pg_get_functiondef('public.push_due(integer)'::regprocedure);
  IF position('notif_user_quiet' IN def) = 0 THEN
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'push_due: the snooze anchor (0256) was not found'; END IF;
    EXECUTE replace(def, anchor, anchor || ' AND (NOT public.notif_user_quiet(s.user_id) OR public.notif_kind_mandatory(n.kind))');
  END IF;
END $$;

-- 4: the decisions are purged by the hourly step of B1 (patched in place, idempotent).
DO $$
DECLARE def text; anchor text := 'DELETE FROM public.notifications WHERE created_at < p_now - retain * interval ''1 day'';';
BEGIN
  def := pg_get_functiondef('public.notif_policy_tick(timestamptz)'::regprocedure);
  IF position('notification_decisions' IN def) = 0 THEN
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'notif_policy_tick: the retention anchor (0530) was not found'; END IF;
    EXECUTE replace(def, anchor, anchor || ' DELETE FROM public.notification_decisions WHERE created_at < p_now - coalesce((public.notif_personal_cfg() ->> ''decision_retention_days'')::integer, 30) * interval ''1 day'';');
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The person's own doors
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notif_my_prefs() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); p public.notification_user_prefs%ROWTYPE; cfg jsonb := public.notif_personal_cfg(); cat jsonb;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO p FROM public.notification_user_prefs x WHERE x.user_id = a;
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', t ->> 'code', 'label_en', t ->> 'label_en', 'label_ar', t ->> 'label_ar', 'kind', t ->> 'kind', 'category', t ->> 'category',
           'mandatory', coalesce((t ->> 'mandatory')::boolean, false), 'in_app', coalesce(p.types -> (t ->> 'code') ->> 'in_app', 'true')::boolean,
           'email', coalesce(p.types -> (t ->> 'code') ->> 'email', 'true')::boolean)), '[]'::jsonb)
    INTO cat FROM jsonb_array_elements(public.notif_catalogue()) t
    WHERE NOT coalesce((t ->> 'system_admins_only')::boolean, false) OR public.app_user_is_system_admin(a);
  RETURN jsonb_build_object(
    'version', coalesce(p.version, 0), 'types', cat,
    'dnd', jsonb_build_object('enabled', coalesce(p.dnd_enabled, false), 'start', coalesce(p.dnd_start, 1320), 'end', coalesce(p.dnd_end, 420),
            'days', to_jsonb(coalesce(p.dnd_days, ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[])), 'timezone', p.dnd_timezone,
            'effective_timezone', coalesce(p.dnd_timezone, public.notif_policy_view(public.notif_policy_raw()) ->> 'timezone', 'UTC')),
    'snooze_until', p.snooze_until, 'quiet_now', public.notif_user_quiet(a),
    'org', jsonb_build_object('allow_personal', cfg -> 'allow_personal', 'allow_dnd', cfg -> 'allow_dnd', 'dedupe_minutes', cfg -> 'dedupe_minutes'));
END $$;

CREATE OR REPLACE FUNCTION notif_my_prefs_set(p_types jsonb, p_dnd jsonb, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); cur public.notification_user_prefs%ROWTYPE; clean jsonb := '{}'::jsonb; t jsonb; code text; ok boolean; s integer; e integer; days smallint[]; tz text;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF coalesce((public.notif_personal_cfg() ->> 'allow_personal')::boolean, true) IS NOT TRUE THEN
    RAISE EXCEPTION 'personal notification settings are switched off by the administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.notification_user_prefs (user_id) VALUES (a) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO cur FROM public.notification_user_prefs x WHERE x.user_id = a FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> cur.version THEN RAISE EXCEPTION 'precondition_failed' USING ERRCODE = '40001'; END IF;
  IF p_types IS NOT NULL THEN
    IF jsonb_typeof(p_types) <> 'object' THEN RAISE EXCEPTION 'types must be an object' USING ERRCODE = 'check_violation'; END IF;
    FOR code IN SELECT jsonb_object_keys(p_types) LOOP
      SELECT x INTO t FROM jsonb_array_elements(public.notif_catalogue()) x WHERE x ->> 'code' = code;
      IF t IS NULL THEN RAISE EXCEPTION 'unknown notification type %', code USING ERRCODE = 'check_violation'; END IF;
      IF jsonb_typeof(p_types -> code) <> 'object' THEN RAISE EXCEPTION 'type % must be an object', code USING ERRCODE = 'check_violation'; END IF;
      -- a mandatory type is never stored; only the two channels are kept, and only when they differ from the default (on)
      IF NOT coalesce((t ->> 'mandatory')::boolean, false) THEN
        ok := false;
        IF jsonb_typeof(p_types -> code -> 'in_app') = 'boolean' AND (p_types -> code ->> 'in_app')::boolean IS FALSE THEN ok := true; END IF;
        IF jsonb_typeof(p_types -> code -> 'email') = 'boolean' AND (p_types -> code ->> 'email')::boolean IS FALSE THEN ok := true; END IF;
        IF ok THEN
          clean := clean || jsonb_build_object(code, jsonb_build_object(
            'in_app', coalesce(CASE WHEN jsonb_typeof(p_types -> code -> 'in_app') = 'boolean' THEN (p_types -> code ->> 'in_app')::boolean END, true),
            'email', coalesce(CASE WHEN jsonb_typeof(p_types -> code -> 'email') = 'boolean' THEN (p_types -> code ->> 'email')::boolean END, true)));
        END IF;
      END IF;
    END LOOP;
    UPDATE public.notification_user_prefs SET types = clean WHERE user_id = a;
  END IF;
  IF p_dnd IS NOT NULL THEN
    IF jsonb_typeof(p_dnd) <> 'object' THEN RAISE EXCEPTION 'dnd must be an object' USING ERRCODE = 'check_violation'; END IF;
    s := CASE WHEN (p_dnd ->> 'start') ~ '^[0-9]{1,4}$' THEN (p_dnd ->> 'start')::integer ELSE cur.dnd_start END;
    e := CASE WHEN (p_dnd ->> 'end') ~ '^[0-9]{1,4}$' THEN (p_dnd ->> 'end')::integer ELSE cur.dnd_end END;
    IF s NOT BETWEEN 0 AND 1439 OR e NOT BETWEEN 0 AND 1439 THEN RAISE EXCEPTION 'the window must be inside one day' USING ERRCODE = 'check_violation'; END IF;
    IF jsonb_typeof(p_dnd -> 'days') = 'array' THEN
      SELECT coalesce(array_agg(DISTINCT d::smallint ORDER BY d::smallint), ARRAY[]::smallint[]) INTO days FROM jsonb_array_elements_text(p_dnd -> 'days') d WHERE d ~ '^[0-6]$';
    ELSE
      days := cur.dnd_days;
    END IF;
    tz := CASE WHEN p_dnd ? 'timezone' THEN nullif(p_dnd ->> 'timezone', '') ELSE cur.dnd_timezone END;
    IF tz IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = tz) THEN RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'check_violation'; END IF;
    UPDATE public.notification_user_prefs SET
      dnd_enabled = CASE WHEN jsonb_typeof(p_dnd -> 'enabled') = 'boolean' THEN (p_dnd ->> 'enabled')::boolean ELSE dnd_enabled END,
      dnd_start = s, dnd_end = e, dnd_days = days, dnd_timezone = tz
    WHERE user_id = a;
  END IF;
  UPDATE public.notification_user_prefs SET version = version + 1, updated_at = now() WHERE user_id = a;
  RETURN public.notif_my_prefs();
END $$;

-- Snooze all personal e-mail and push until a time (at most 14 days); NULL clears it.
CREATE OR REPLACE FUNCTION notif_my_snooze(p_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF coalesce((public.notif_personal_cfg() ->> 'allow_personal')::boolean, true) IS NOT TRUE THEN
    RAISE EXCEPTION 'personal notification settings are switched off by the administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_until IS NOT NULL AND (p_until <= now() OR p_until > now() + interval '14 days') THEN RAISE EXCEPTION 'the snooze must end within 14 days from now' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO public.notification_user_prefs (user_id, snooze_until) VALUES (a, p_until)
  ON CONFLICT (user_id) DO UPDATE SET snooze_until = p_until, version = public.notification_user_prefs.version + 1, updated_at = now();
  RETURN public.notif_my_prefs();
END $$;

-- 5: the test notice. Kind system is not governed by the policy, so it reaches the bell whatever the matrix says.
CREATE OR REPLACE FUNCTION notif_my_test() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); nid uuid;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF EXISTS (SELECT 1 FROM public.notifications x WHERE x.user_id = a AND x.kind = 'system' AND x.title = 'Test notification' AND x.created_at > now() - interval '30 seconds') THEN
    RAISE EXCEPTION 'wait 30 seconds between tests' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  VALUES (a, 'in_app', 'system', 'Test notification', 'This is a test of your notification settings.', '/profile')
  RETURNING id INTO nid;
  RETURN jsonb_build_object('notification_id', nid, 'quiet_now', public.notif_user_quiet(a));
END $$;

CREATE OR REPLACE FUNCTION notif_my_decisions(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'channel', d.channel, 'reason', d.reason, 'title', d.title, 'link', d.link, 'created_at', d.created_at) ORDER BY d.created_at DESC, d.id DESC)
    FROM (SELECT * FROM public.notification_decisions x WHERE x.user_id = a ORDER BY x.created_at DESC, x.id DESC LIMIT greatest(1, least(coalesce(p_limit, 50), 200))) d), '[]'::jsonb));
END $$;

-- The org settings of the personal layer (System Admin, audited).
CREATE OR REPLACE FUNCTION notif_personal_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN public.notif_personal_cfg() || jsonb_build_object('version', coalesce((SELECT (s.value ->> 'version')::integer FROM public.settings s WHERE s.key = 'notifications.personal'), 0));
END $$;

CREATE OR REPLACE FUNCTION notif_personal_set(p_cfg jsonb, p_version integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bef jsonb; nv integer; d integer; r integer; ap boolean; ad boolean;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF jsonb_typeof(p_cfg) <> 'object' THEN RAISE EXCEPTION 'the settings must be an object' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('notifications.personal', '{"version": 0}'::jsonb, 'Item 4 (0583): switches and limits of the personal notification layer (own type choices, do-not-disturb, snooze, dedupe window).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'notifications.personal' FOR UPDATE;
  bef := public.notif_personal_get();
  IF p_version IS NOT NULL AND p_version <> (bef ->> 'version')::integer THEN RAISE EXCEPTION 'precondition_failed' USING ERRCODE = '40001'; END IF;
  ap := CASE WHEN jsonb_typeof(p_cfg -> 'allow_personal') = 'boolean' THEN (p_cfg ->> 'allow_personal')::boolean ELSE (bef ->> 'allow_personal')::boolean END;
  ad := CASE WHEN jsonb_typeof(p_cfg -> 'allow_dnd') = 'boolean' THEN (p_cfg ->> 'allow_dnd')::boolean ELSE (bef ->> 'allow_dnd')::boolean END;
  d := CASE WHEN (p_cfg ->> 'dedupe_minutes') ~ '^[0-9]{1,4}$' THEN (p_cfg ->> 'dedupe_minutes')::integer WHEN p_cfg ? 'dedupe_minutes' THEN -1 ELSE (bef ->> 'dedupe_minutes')::integer END;
  r := CASE WHEN (p_cfg ->> 'decision_retention_days') ~ '^[0-9]{1,4}$' THEN (p_cfg ->> 'decision_retention_days')::integer WHEN p_cfg ? 'decision_retention_days' THEN -1 ELSE (bef ->> 'decision_retention_days')::integer END;
  IF d NOT BETWEEN 0 AND 1440 THEN RAISE EXCEPTION 'dedupe_minutes is 0 to 1440' USING ERRCODE = 'check_violation'; END IF;
  IF r NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'decision_retention_days is 1 to 365' USING ERRCODE = 'check_violation'; END IF;
  nv := (bef ->> 'version')::integer + 1;
  UPDATE public.settings SET value = jsonb_build_object('allow_personal', ap, 'allow_dnd', ad, 'dedupe_minutes', d, 'decision_retention_days', r, 'version', nv), updated_at = now()
  WHERE key = 'notifications.personal';
  PERFORM public.log_audit_write('notification_personal_update', 'setting', 'notifications.personal', bef, public.notif_personal_get(), p_reason);
  RETURN public.notif_personal_get();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants (0166 pattern)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  ALTER TABLE notification_user_prefs OWNER TO pmis_definer;
  ALTER TABLE notification_decisions OWNER TO pmis_definer;
  FOREACH f IN ARRAY ARRAY['notif_personal_cfg()', 'notif_kind_mandatory(text)', 'notif_user_quiet(uuid,timestamptz)', 'notifications_user_gate()', 'notif_user_mail_blocked(uuid,text,text,text)',
                           'notif_my_prefs()', 'notif_my_prefs_set(jsonb,jsonb,integer)', 'notif_my_snooze(timestamptz)', 'notif_my_test()', 'notif_my_decisions(integer)',
                           'notif_personal_get()', 'notif_personal_set(jsonb,integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  GRANT SELECT, INSERT, UPDATE, DELETE ON notification_user_prefs, notification_decisions TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON notification_user_prefs, notification_decisions TO pmis_app;
    GRANT EXECUTE ON FUNCTION notif_my_prefs(), notif_my_prefs_set(jsonb, jsonb, integer), notif_my_snooze(timestamptz), notif_my_test(), notif_my_decisions(integer),
      notif_personal_get(), notif_personal_set(jsonb, integer, text) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): the personal choices are a personal preference (KEEP); the decisions are a journal of the notices the layer stopped (LOG, kept on a
-- reset, purged by retention). data_reset_plan() is an accumulating function: patched in place, idempotently, never redefined from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''notification_user_prefs''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''notification_user_prefs''');
  END IF;
  IF position('''notification_decisions''' IN def) = 0 THEN
    IF position('''job_runs''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the log list anchor was not found'; END IF;
    def := replace(def, '''job_runs''', '''job_runs'', ''notification_decisions''');
  END IF;
  EXECUTE def;
END $$;
GRANT SELECT, UPDATE ON public.notification_user_prefs, public.notification_decisions TO pmis_reset_owner;
