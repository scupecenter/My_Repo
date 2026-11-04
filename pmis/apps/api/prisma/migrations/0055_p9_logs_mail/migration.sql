-- 0055_p9_logs_mail: logs, monitoring and the mail service (work package P9; owner answers Q165, Q167 to Q171 of 2026-11-04; contract 0.12.3;
-- CHANGELOG 81). Mirrored byte-identically as db/sql/054_p9_logs_mail.sql.
--   1. Q165: roles get managed capabilities (`audit_full_reader`, `team_lead`). The Audit Log reader scope (B4) reads them; the role-code settings
--      `logs.audit.full_reader_roles` and `logs.audit.team_lead_roles` are the fallback only while no role carries the capability. Team Lead reading
--      stays bounded by the modules, regions and validity dates of the assignment, and gives no security log. Set by a System Admin with step-up.
--   2. Q167: the outbound mail queue `mail_outbox` (retry with back-off, dead letter, purge). Security alerts are queued by mail to every active
--      System Admin when their severity reaches `email_min_severity`; other notification kinds go by mail only when listed in `mail.notification_kinds`
--      (empty during development). Every queued, sent, failed and given-up mail writes a System Log row; bodies are never logged.
--   3. Q168: a severity per alert rule (setting `security_alerts.severity`, mandatory rules fixed at critical), the new severity `info`, trusted
--      networks (`security_alerts.trusted_networks`) that soften a new-address alert by one level (the alert is still raised, the other rules are
--      unchanged), and the rule `break_glass_used` (critical: every use is logged and mailed).
--   4. Q170: exact row counts of an export (`log_audit_count`, `sec_log_count`) so an export above the cap is refused (422 `too_many_rows`), never cut.
--   5. Q169: `log_activity_workbook`, the extra sheets of the monthly xlsx (modules, exports, exceptions) within the caller's Audit Log scope.
--   6. Q171: the integrity check as a monitored job with progress (`log_integrity_runs`, start / step / finish), nightly and on demand, a stored result
--      with its range and the chain head anchored outside the database; a break or an anchor mismatch raises `audit_integrity_failure`.
--   7. pmis_app reads none of the new tables directly and writes them only through the functions below (db/sql/app_grants.sql).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings (data)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('mail.notification_kinds', '[]'::jsonb,
   'Notification kinds that are also sent by mail to the recipient. Security alerts are mailed by their own rule. Empty during development (owner answer Q167).', now()),
  ('mail.retry_minutes', '[1, 5, 15, 60, 240]'::jsonb, 'Minutes before each new attempt of a failed mail; after the last one the mail is given up and the System Admins are told in-app.', now()),
  ('mail.cap_per_recipient_per_hour', '30'::jsonb, 'Mails one address may receive per hour; the rest are suppressed (mandatory security alerts are never capped).', now()),
  ('mail.retention_days', '90'::jsonb, 'Days a sent, given-up or suppressed mail is kept in the outbox before it is purged.', now()),
  ('logs.integrity.sync_max_rows', '200000'::jsonb, 'Largest chain range the integrity button checks inside one request; a larger check runs as a job.', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q165: role capabilities
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}'
  CONSTRAINT roles_capabilities_check CHECK (capabilities <@ ARRAY['audit_full_reader', 'team_lead']::text[]);

-- The codes of today's settings become capabilities (PM reads everything; RFD_ACQ_TL, CW_TL and TE_TL are Team Leads).
UPDATE roles r SET capabilities = ARRAY(SELECT DISTINCT c FROM unnest(r.capabilities || ARRAY['audit_full_reader']) c ORDER BY c)
WHERE r.code IN (SELECT jsonb_array_elements_text(coalesce((SELECT value FROM settings WHERE key = 'logs.audit.full_reader_roles'), '["PM"]'::jsonb)));
UPDATE roles r SET capabilities = ARRAY(SELECT DISTINCT c FROM unnest(r.capabilities || ARRAY['team_lead']) c ORDER BY c)
WHERE r.code IN (SELECT jsonb_array_elements_text(coalesce((SELECT value FROM settings WHERE key = 'logs.audit.team_lead_roles'), '[]'::jsonb)));

UPDATE settings SET description = description || ' Fallback only: used while no role carries the capability audit_full_reader (migration 0055).'
WHERE key = 'logs.audit.full_reader_roles' AND description NOT LIKE '%migration 0055%';
UPDATE settings SET description = description || ' Fallback only: used while no role carries the capability team_lead (migration 0055).'
WHERE key = 'logs.audit.team_lead_roles' AND description NOT LIKE '%migration 0055%';

-- The role codes that carry a capability; the setting list only while no role (active or not) carries it.
CREATE OR REPLACE FUNCTION log_capability_roles(p_cap text, p_setting text, p_default jsonb) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.roles r WHERE p_cap = ANY (r.capabilities))
    THEN ARRAY(SELECT r.code FROM public.roles r WHERE p_cap = ANY (r.capabilities) ORDER BY r.code)
    ELSE ARRAY(SELECT x FROM jsonb_array_elements_text(public.log_setting(p_setting, p_default)) x) END
$$;

-- Same contract as 0045; only the two code lists come from the capabilities now.
CREATE OR REPLACE FUNCTION log_audit_scope(p_user uuid) RETURNS TABLE (module_key text, region_id integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE fullr text[]; leads text[];
BEGIN
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active') THEN RETURN; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN QUERY SELECT NULL::text, NULL::int; RETURN; END IF;
  fullr := public.log_capability_roles('audit_full_reader', 'logs.audit.full_reader_roles', '["PM"]'::jsonb);
  leads := public.log_capability_roles('team_lead', 'logs.audit.team_lead_roles', '[]'::jsonb);
  IF EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
             WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()) AND r.code = ANY (coalesce(fullr, '{}'))) THEN
    RETURN QUERY SELECT NULL::text, NULL::int; RETURN;
  END IF;
  RETURN QUERY
  WITH act AS (
    SELECT a.id, a.all_modules, a.all_regions, r.code
    FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  ), regs AS (
    SELECT act.id, NULL::int AS region_id FROM act WHERE act.all_regions
    UNION ALL SELECT ar.assignment_id, ar.region_id FROM public.user_role_assignment_regions ar JOIN act ON act.id = ar.assignment_id AND NOT act.all_regions
  ), mods AS (
    SELECT act.id, NULL::text AS module_key FROM act WHERE act.all_modules
    UNION ALL SELECT am.assignment_id, am.module_key FROM public.user_role_assignment_modules am JOIN act ON act.id = am.assignment_id AND NOT act.all_modules
  ), lead AS (
    SELECT m.module_key, g.region_id FROM act JOIN mods m ON m.id = act.id JOIN regs g ON g.id = act.id WHERE act.code = ANY (coalesce(leads, '{}'))
  ), granted AS (
    SELECT CASE WHEN pg.module_key = 'audit' THEN m.module_key ELSE pg.module_key END AS module_key, g.region_id
    FROM act
    JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = act.id
    JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
    JOIN public.permission_grants pg ON pg.profile_id = pp.id AND pg.action = 'view_audit'
    JOIN mods m ON m.id = act.id
    JOIN regs g ON g.id = act.id
    WHERE pg.module_key = 'audit' OR m.module_key IS NULL OR m.module_key = split_part(pg.module_key, '.', 1)
  ), deleg AS (
    SELECT CASE WHEN d.is_full OR dg.module_key = 'audit' THEN NULL ELSE dg.module_key END AS module_key, dr.region_id
    FROM public.app_user_delegations(p_user) x(id)
    JOIN public.delegations d ON d.id = x.id
    LEFT JOIN public.delegation_grants dg ON dg.delegation_id = d.id AND dg.action = 'view_audit'
    LEFT JOIN LATERAL (SELECT NULL::int AS region_id WHERE d.all_regions
                       UNION ALL SELECT r.region_id FROM public.delegation_regions r WHERE r.delegation_id = d.id AND NOT d.all_regions) dr ON true
    WHERE d.is_full OR dg.module_key IS NOT NULL
  )
  SELECT DISTINCT s.module_key, s.region_id FROM (SELECT * FROM lead UNION ALL SELECT * FROM granted UNION ALL SELECT * FROM deleg) s;
END $$;

-- Sets the capabilities of a role. System Admin only (it widens who reads the Audit Log), a reason and a fresh step-up; audited with before/after.
CREATE OR REPLACE FUNCTION idm_role_set_capabilities(p_role uuid, p_caps text[], p_reason text) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE o public.roles%ROWTYPE; nc text[];
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'role capabilities: System Admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'))));
  END IF;
  nc := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_caps, '{}'::text[])) x ORDER BY x);
  IF NOT nc <@ ARRAY['audit_full_reader', 'team_lead']::text[] THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/capabilities', 'code', 'invalid',
      'message', 'A capability is audit_full_reader or team_lead.'))));
  END IF;
  IF NOT public.log_actor_stepped_up() THEN PERFORM public.wf_err('step_up_required', '{}'::jsonb); END IF;
  SELECT * INTO o FROM public.roles WHERE id = p_role FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The role does not exist.')); END IF;
  IF o.capabilities = nc THEN RETURN nc; END IF;
  UPDATE public.roles SET capabilities = nc WHERE id = p_role;
  PERFORM public.log_audit_write('role_capabilities_set', 'role', p_role::text, jsonb_build_object('code', o.code, 'capabilities', to_jsonb(o.capabilities)),
    jsonb_build_object('code', o.code, 'capabilities', to_jsonb(nc)), p_reason);
  RETURN nc;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q167: the mail outbox
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mail_address_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) <= 254
     AND p ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
$$;

-- a***@domain: the form written to the System Log (the outbox keeps the full address for the admins).
CREATE OR REPLACE FUNCTION mail_mask(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p IS NULL OR position('@' IN p) < 2 THEN '***' ELSE left(p, 1) || '***' || substr(p, position('@' IN p)) END
$$;

CREATE TABLE mail_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind             text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,59}$'),
  to_address       text NOT NULL CHECK (mail_address_ok(to_address)),
  to_user_id       uuid,
  subject          text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200 AND subject !~ '[\r\n]'),
  body_text        text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 20000),
  sensitive        boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'dead', 'logged', 'suppressed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until     timestamptz,
  last_error       text,
  sent_at          timestamptz,
  message_id       text,
  dedup_key        text UNIQUE,
  source           jsonb,
  created_by       uuid
);
CREATE INDEX mail_outbox_due ON mail_outbox (next_attempt_at, created_at) WHERE status IN ('queued', 'sending');
CREATE INDEX mail_outbox_created ON mail_outbox (created_at DESC, id);
CREATE INDEX mail_outbox_to_created ON mail_outbox (to_address, created_at);
CREATE INDEX mail_outbox_status_created ON mail_outbox (status, created_at DESC);

-- Rows change only through the mail_* functions (owner pmis_definer) and are deleted only by the purge.
CREATE OR REPLACE FUNCTION mail_outbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'pmis_definer' AND NEW.id = OLD.id AND NEW.to_address = OLD.to_address AND NEW.subject = OLD.subject
     AND NEW.body_text = OLD.body_text AND NEW.kind = OLD.kind AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND current_user = 'pmis_definer' AND current_setting('pmis.log_purge', true) = 'mail_outbox' AND OLD.status IN ('sent', 'dead', 'logged', 'suppressed') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'mail_outbox: % blocked', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER mail_outbox_guard BEFORE UPDATE OR DELETE ON mail_outbox FOR EACH ROW EXECUTE FUNCTION mail_outbox_guard();
CREATE TRIGGER mail_outbox_no_truncate BEFORE TRUNCATE ON mail_outbox FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();

-- The one writer of the queue. Returns the id, or NULL when the dedup key was queued before. A mail above the hourly cap of its address is kept as
-- `suppressed` (never sent) unless p_source.mandatory is true. Writes one System Log row (masked address, never the body).
CREATE OR REPLACE FUNCTION mail_enqueue_internal(p_kind text, p_to text, p_user uuid, p_subject text, p_body text, p_dedup text, p_sensitive boolean,
  p_source jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nid uuid; cap int; st text := 'queued'; addr text := lower(trim(p_to)); subj text;
BEGIN
  IF p_kind IS NULL OR p_kind !~ '^[a-z][a-z0-9_.]{1,59}$' THEN RAISE EXCEPTION 'mail: kind is a lower-case code' USING ERRCODE = 'check_violation'; END IF;
  IF NOT public.mail_address_ok(addr) THEN RAISE EXCEPTION 'mail: not a valid address' USING ERRCODE = 'check_violation'; END IF;
  IF p_subject IS NULL OR p_subject ~ '[\r\n]' OR length(trim(p_subject)) = 0 THEN RAISE EXCEPTION 'mail: the subject is one line' USING ERRCODE = 'check_violation'; END IF;
  IF p_body IS NULL OR length(p_body) = 0 OR length(p_body) > 20000 THEN RAISE EXCEPTION 'mail: the body is 1 to 20000 characters' USING ERRCODE = 'check_violation'; END IF;
  IF p_source IS NOT NULL AND (jsonb_typeof(p_source) <> 'object' OR length(p_source::text) > 2000) THEN
    RAISE EXCEPTION 'mail: source must be a small object' USING ERRCODE = 'check_violation';
  END IF;
  subj := left(trim(p_subject), 200);
  IF NOT coalesce((p_source ->> 'mandatory')::boolean, false) THEN
    cap := coalesce((public.log_setting('mail.cap_per_recipient_per_hour', '30'::jsonb) #>> '{}')::int, 30);
    IF (SELECT count(*) FROM public.mail_outbox m WHERE m.to_address = addr AND m.created_at > now() - interval '1 hour' AND m.status <> 'suppressed') >= cap THEN
      st := 'suppressed';
    END IF;
  END IF;
  INSERT INTO public.mail_outbox (kind, to_address, to_user_id, subject, body_text, sensitive, status, dedup_key, source, created_by)
  VALUES (p_kind, addr, p_user, subj, p_body, coalesce(p_sensitive, false), st, left(p_dedup, 200), p_source, public.app_actor())
  ON CONFLICT (dedup_key) DO NOTHING RETURNING id INTO nid;
  IF nid IS NULL THEN RETURN NULL; END IF;
  PERFORM public.log_system_write(CASE st WHEN 'queued' THEN 'info' ELSE 'warn' END, 'mail', CASE st WHEN 'queued' THEN 'mail queued' ELSE 'mail suppressed (hourly cap)' END,
    jsonb_build_object('mail_id', nid, 'kind', p_kind, 'to', public.mail_mask(addr), 'subject', CASE WHEN coalesce(p_sensitive, false) THEN NULL ELSE subj END),
    p_user, NULL);
  RETURN nid;
END $$;

-- What the API calls (P8 and the notices): a mail to one active user, or to one address. A signed-in actor is required for an address; the kind
-- `security_alert` is reserved for the database. A mail never breaks the caller's change: it either queues or answers NULL.
CREATE OR REPLACE FUNCTION mail_send_to_user(p_kind text, p_user uuid, p_subject text, p_body text, p_dedup text DEFAULT NULL, p_sensitive boolean DEFAULT false)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e text;
BEGIN
  IF p_kind LIKE 'security_alert%' THEN RAISE EXCEPTION 'mail: kind % is reserved', p_kind USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT u.email INTO e FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL;
  IF e IS NULL OR NOT public.mail_address_ok(e) THEN RETURN NULL; END IF;
  RETURN public.mail_enqueue_internal(p_kind, e, p_user, p_subject, p_body, p_dedup, p_sensitive, jsonb_build_object('via', 'api'));
END $$;

CREATE OR REPLACE FUNCTION mail_send_to_address(p_kind text, p_to text, p_subject text, p_body text, p_dedup text DEFAULT NULL, p_sensitive boolean DEFAULT false)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'mail: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind LIKE 'security_alert%' THEN RAISE EXCEPTION 'mail: kind % is reserved', p_kind USING ERRCODE = 'insufficient_privilege'; END IF;
  -- one person cannot use the server to mail arbitrary addresses in bulk
  IF (SELECT count(*) FROM public.mail_outbox m WHERE m.created_by = a AND m.to_user_id IS NULL AND m.created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'mail: too many mails to addresses this hour' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.mail_enqueue_internal(p_kind, p_to, (SELECT u.id FROM public.users u WHERE u.email = lower(trim(p_to)) LIMIT 1), p_subject, p_body, p_dedup, p_sensitive,
    jsonb_build_object('via', 'api'));
END $$;

-- Every active System Admin with a valid address (the security and system types go to them only).
CREATE OR REPLACE FUNCTION mail_to_system_admins(p_kind text, p_subject text, p_body text, p_dedup text, p_source jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT DISTINCT x.id, x.email FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
           JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL ORDER BY x.id LOOP
    IF public.mail_address_ok(r.email) AND public.mail_enqueue_internal(p_kind, r.email, r.id, p_subject, p_body, p_dedup || ':' || r.id::text, false, p_source) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- The worker takes due mails (a mail left `sending` by a crashed worker is taken again when its lease ends); p_id takes that one mail only (the
-- test mail, sent inside its request).
CREATE OR REPLACE FUNCTION mail_claim(p_limit integer, p_lease_seconds integer DEFAULT 120, p_id uuid DEFAULT NULL)
  RETURNS TABLE (id uuid, kind text, to_address text, subject text, body_text text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  UPDATE public.mail_outbox m SET status = 'sending', attempts = m.attempts + 1,
    locked_until = clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
  WHERE m.id IN (SELECT x.id FROM public.mail_outbox x
                 WHERE (p_id IS NULL OR x.id = p_id)
                   AND ((x.status = 'queued' AND x.next_attempt_at <= clock_timestamp()) OR (x.status = 'sending' AND x.locked_until < clock_timestamp()))
                 ORDER BY x.next_attempt_at, x.created_at, x.id LIMIT least(greatest(coalesce(p_limit, 20), 1), 200) FOR UPDATE SKIP LOCKED)
  RETURNING m.id, m.kind, m.to_address, m.subject, m.body_text, m.attempts;
END $$;

-- The outcome of one attempt: sent, logged (no SMTP configured: nothing left the server), failed (retried with back-off, given up after the last
-- step), rejected (a permanent refusal: given up at once). Answers the new status.
CREATE OR REPLACE FUNCTION mail_mark(p_id uuid, p_outcome text, p_error text DEFAULT NULL, p_message_id text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.mail_outbox%ROWTYPE; steps jsonb := public.log_setting('mail.retry_minutes', '[1, 5, 15, 60, 240]'::jsonb); st text; wait int;
  err text := left(regexp_replace(coalesce(p_error, ''), '[\r\n\t]+', ' ', 'g'), 300); ctx jsonb;
BEGIN
  IF p_outcome NOT IN ('sent', 'logged', 'failed', 'rejected') THEN RAISE EXCEPTION 'mail: unknown outcome' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO m FROM public.mail_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'sending' THEN RETURN NULL; END IF;
  ctx := jsonb_build_object('mail_id', m.id, 'kind', m.kind, 'to', public.mail_mask(m.to_address), 'attempt', m.attempts);
  IF p_outcome = 'sent' THEN
    UPDATE public.mail_outbox SET status = 'sent', sent_at = clock_timestamp(), locked_until = NULL, last_error = NULL, message_id = left(p_message_id, 200) WHERE id = p_id;
    PERFORM public.log_system_write('info', 'mail', 'mail sent', ctx, m.to_user_id, NULL);
    RETURN 'sent';
  END IF;
  IF p_outcome = 'logged' THEN
    UPDATE public.mail_outbox SET status = 'logged', locked_until = NULL WHERE id = p_id;
    PERFORM public.log_system_write('info', 'mail', 'mail not sent: SMTP is not configured',
      ctx || jsonb_build_object('subject', CASE WHEN m.sensitive THEN NULL ELSE m.subject END), m.to_user_id, NULL);
    RETURN 'logged';
  END IF;
  IF jsonb_typeof(steps) <> 'array' THEN steps := '[1, 5, 15, 60, 240]'::jsonb; END IF;
  IF p_outcome = 'failed' AND m.attempts <= jsonb_array_length(steps) THEN
    wait := least(greatest(coalesce((steps ->> (m.attempts - 1))::int, 60), 1), 1440);
    UPDATE public.mail_outbox SET status = 'queued', locked_until = NULL, last_error = nullif(err, ''),
      next_attempt_at = clock_timestamp() + make_interval(mins => wait) WHERE id = p_id;
    PERFORM public.log_system_write('warn', 'mail', 'mail delivery failed, retrying', ctx || jsonb_build_object('error', err, 'retry_in_minutes', wait), m.to_user_id, NULL);
    RETURN 'queued';
  END IF;
  UPDATE public.mail_outbox SET status = 'dead', locked_until = NULL, last_error = nullif(err, '') WHERE id = p_id;
  PERFORM public.log_system_write('error', 'mail', 'mail given up', ctx || jsonb_build_object('error', err, 'permanent', p_outcome = 'rejected'), m.to_user_id, NULL);
  -- the System Admins learn it in-app (never by mail: the mail channel is what failed), at most once an hour
  IF NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.kind = 'system' AND n.link = '/admin/mail' AND n.created_at > now() - interval '1 hour') THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
    SELECT DISTINCT gm.user_id, 'in_app'::"NotifyChannel", 'system', 'An email could not be delivered', 'See Mail delivery in the System Log screens.', '/admin/mail', 'admin.system_log'
    FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
    JOIN public.users x ON x.id = gm.user_id AND x.status = 'active';
  END IF;
  RETURN 'dead';
END $$;

CREATE OR REPLACE FUNCTION mail_can_read() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.log_can_read_ops();
END $$;

-- The outbox for the admins (System Admin or view on admin.system_log). The body is never returned.
CREATE OR REPLACE FUNCTION mail_outbox_read(p jsonb, p_limit integer)
  RETURNS TABLE (id uuid, created_at timestamptz, kind text, to_address text, to_user_id uuid, subject text, sensitive boolean, status text, attempts integer,
                 next_attempt_at timestamptz, last_error text, sent_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.mail_can_read() THEN RAISE EXCEPTION 'mail outbox: System Admin or view on admin.system_log required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY
  SELECT m.id, m.created_at, m.kind, m.to_address, m.to_user_id, CASE WHEN m.sensitive THEN '(hidden)' ELSE m.subject END, m.sensitive, m.status, m.attempts,
         m.next_attempt_at, m.last_error, m.sent_at
  FROM public.mail_outbox m
  WHERE (p ->> 'status' IS NULL OR m.status = p ->> 'status' OR (p ->> 'status' = 'retrying' AND m.status = 'queued' AND m.attempts > 0))
    AND (p ->> 'kind' IS NULL OR m.kind = p ->> 'kind')
    AND (p ->> 'cursor_at' IS NULL OR (m.created_at, m.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::uuid))
  ORDER BY m.created_at DESC, m.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 201);
END $$;

-- Counts for the status card and the health check; `verified_at` is the last test mail sent with the current settings (fingerprint from the API).
CREATE OR REPLACE FUNCTION mail_stats(p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- the admins' status card, or the health check and the worker (no signed-in actor)
  IF public.app_actor() IS NOT NULL AND NOT public.mail_can_read() THEN
    RAISE EXCEPTION 'mail status: System Admin or view on admin.system_log required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT jsonb_build_object(
    'queued', count(*) FILTER (WHERE m.status = 'queued' AND m.attempts = 0),
    'retrying', count(*) FILTER (WHERE m.status = 'queued' AND m.attempts > 0),
    'sending', count(*) FILTER (WHERE m.status = 'sending'),
    'dead', count(*) FILTER (WHERE m.status = 'dead'),
    'dead_24h', count(*) FILTER (WHERE m.status = 'dead' AND m.created_at > now() - interval '24 hours'),
    'sent_24h', count(*) FILTER (WHERE m.status = 'sent' AND m.sent_at > now() - interval '24 hours'),
    'logged_24h', count(*) FILTER (WHERE m.status = 'logged' AND m.created_at > now() - interval '24 hours'),
    'suppressed_24h', count(*) FILTER (WHERE m.status = 'suppressed' AND m.created_at > now() - interval '24 hours'),
    'last_sent_at', public.log_ts_text(max(m.sent_at)),
    'last_error', (SELECT x.last_error FROM public.mail_outbox x WHERE x.last_error IS NOT NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1),
    'verified_at', public.log_ts_text(max(m.sent_at) FILTER (WHERE m.kind = 'mail.test' AND m.status = 'sent' AND m.source ->> 'fingerprint' = p_fingerprint)))
    FROM public.mail_outbox m);
END $$;

-- A test mail to the caller (System Admin only); the API sends it at once and reports the outcome. Its fingerprint (host, port, sender, TLS mode,
-- no secret) ties the verification to the settings it was sent with.
CREATE OR REPLACE FUNCTION mail_test_enqueue(p_fingerprint text, p_subject text, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); e text; nid uuid;
BEGIN
  IF a IS NULL OR NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'mail test: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT u.email INTO e FROM public.users u WHERE u.id = a;
  IF NOT public.mail_address_ok(e) THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Your account has no valid email address.')); END IF;
  nid := public.mail_enqueue_internal('mail.test', e, a, p_subject, p_body, NULL, false,
    jsonb_build_object('fingerprint', left(p_fingerprint, 200), 'mandatory', true));
  PERFORM public.log_audit_write('mail_test_sent', 'mail', nid::text, NULL, jsonb_build_object('to', public.mail_mask(e), 'fingerprint', left(p_fingerprint, 200)), NULL);
  RETURN nid;
END $$;

-- Puts a given-up mail back in the queue (System Admin only, a reason; audited).
CREATE OR REPLACE FUNCTION mail_retry(p_id uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.mail_outbox%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL OR NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'mail retry: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'))));
  END IF;
  SELECT * INTO m FROM public.mail_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The mail does not exist.')); END IF;
  IF m.status <> 'dead' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a mail that was given up can be sent again.')); END IF;
  UPDATE public.mail_outbox SET status = 'queued', attempts = 0, next_attempt_at = clock_timestamp(), last_error = NULL WHERE id = p_id;
  PERFORM public.log_audit_write('mail_retry', 'mail', p_id::text, jsonb_build_object('status', 'dead'), jsonb_build_object('status', 'queued', 'to', public.mail_mask(m.to_address)), p_reason);
  RETURN 'queued';
END $$;

CREATE OR REPLACE FUNCTION mail_purge() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE days int := greatest(coalesce((public.log_setting('mail.retention_days', '90'::jsonb) #>> '{}')::int, 90), 7); n bigint;
BEGIN
  PERFORM set_config('pmis.log_purge', 'mail_outbox', true);
  DELETE FROM public.mail_outbox WHERE status IN ('sent', 'dead', 'logged', 'suppressed') AND created_at < now() - make_interval(days => days);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('pmis.log_purge', '', true);
  RETURN n;
END $$;

-- A notification of a kind listed in mail.notification_kinds is also mailed to its recipient. A failure never breaks the change that notified.
CREATE OR REPLACE FUNCTION mail_on_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e text; kinds jsonb;
BEGIN
  -- security alerts are mailed by their own rule; the notice about a failed mail is never mailed
  IF NEW.channel <> 'in_app' OR NEW.kind = 'security_alert' OR NEW.link = '/admin/mail' THEN RETURN NULL; END IF;
  kinds := public.log_setting('mail.notification_kinds', '[]'::jsonb);
  IF jsonb_typeof(kinds) <> 'array' OR NOT kinds ? NEW.kind THEN RETURN NULL; END IF;
  SELECT u.email INTO e FROM public.users u WHERE u.id = NEW.user_id AND u.status = 'active' AND u.deleted_at IS NULL;
  IF e IS NULL OR NOT public.mail_address_ok(e) THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.mail_enqueue_internal('notification.' || NEW.kind, e, NEW.user_id, '[PMIS] ' || regexp_replace(left(NEW.title, 180), '[\r\n]+', ' ', 'g'),
      NEW.title || E'\n\n' || coalesce(NEW.body || E'\n\n', '') || CASE WHEN NEW.link IS NOT NULL THEN 'Open: {{app_url}}' || NEW.link || E'\n\n' ELSE '' END
        || 'GSDN PMIS. You receive this because the notification type is sent by email.',
      'notification:' || NEW.id::text, false, jsonb_build_object('notification_id', NEW.id));
  EXCEPTION WHEN others THEN
    PERFORM public.log_system_write('warn', 'mail', 'notification mail not queued', jsonb_build_object('notification_id', NEW.id, 'kind', NEW.kind, 'error', left(SQLERRM, 200)), NEW.user_id, NULL);
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER z_mail_on_notification AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION mail_on_notification();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q168: severities, trusted networks, the break-glass rule; Q167: alerts by mail
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE security_alerts DROP CONSTRAINT IF EXISTS security_alerts_severity_check;
ALTER TABLE security_alerts ADD CONSTRAINT security_alerts_severity_check CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));
ALTER TABLE security_alerts DROP CONSTRAINT IF EXISTS security_alerts_rule_check;
ALTER TABLE security_alerts ADD CONSTRAINT security_alerts_rule_check CHECK (rule IN ('failed_sign_ins', 'failed_sign_ins_ip', 'new_ip', 'large_export',
  'admin_set_changed', 'retention_reduced', 'alert_settings_weakened', 'audit_integrity_failure', 'malware_upload', 'break_glass_used'));

CREATE OR REPLACE FUNCTION log_severity_rank(p text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p WHEN 'info' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 WHEN 'critical' THEN 4 END
$$;

-- One level lower (a trusted network softens a new-address alert); info stays info.
CREATE OR REPLACE FUNCTION log_severity_soften(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p WHEN 'critical' THEN 'high' WHEN 'high' THEN 'medium' WHEN 'medium' THEN 'low' ELSE 'info' END
$$;

-- The default severity of each rule whose severity the admin may set. retention_reduced and audit_integrity_failure are mandatory: always critical.
CREATE OR REPLACE FUNCTION sec_rule_default_severities() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT '{"failed_sign_ins": "medium", "failed_sign_ins_ip": "medium", "new_ip": "low", "large_export": "medium", "admin_set_changed": "high",
           "alert_settings_weakened": "high", "malware_upload": "high", "break_glass_used": "critical"}'::jsonb
$$;

CREATE OR REPLACE FUNCTION sec_rule_severity(p_rule text, p_default text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v text;
BEGIN
  IF p_rule IN ('retention_reduced', 'audit_integrity_failure') THEN RETURN 'critical'; END IF;
  v := public.log_setting('security_alerts', '{}'::jsonb) #>> ARRAY['severity', p_rule];
  IF public.log_severity_rank(v) IS NOT NULL THEN RETURN v; END IF;
  v := public.sec_rule_default_severities() ->> p_rule;
  RETURN coalesce(v, CASE WHEN public.log_severity_rank(p_default) IS NOT NULL THEN p_default ELSE 'medium' END);
END $$;

-- An address inside one of the trusted networks of the alert settings (a malformed entry matches nothing).
CREATE OR REPLACE FUNCTION log_ip_trusted(p_ip text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n text; a inet;
BEGIN
  IF p_ip IS NULL THEN RETURN false; END IF;
  BEGIN a := p_ip::inet; EXCEPTION WHEN others THEN RETURN false; END;
  FOR n IN SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(public.log_setting('security_alerts', '{}'::jsonb) -> 'trusted_networks') = 'array'
                                              THEN public.log_setting('security_alerts', '{}'::jsonb) -> 'trusted_networks' ELSE '[]'::jsonb END) LOOP
    BEGIN
      IF a <<= n::cidr THEN RETURN true; END IF;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
  RETURN false;
END $$;

-- Raises one alert with a final severity (once per dedup key), tells every active System Admin in-app and, from email_min_severity up (default
-- low), queues a mail to each of them. The mail holds the rule, the severity, the title, the time and the link, never the alert data.
CREATE OR REPLACE FUNCTION sec_alert_raise_at(p_rule text, p_severity text, p_title text, p_detail jsonb, p_dedup text, p_user uuid, p_ip text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE aid uuid; u uuid; minsev text; t_at timestamptz; ttl text := regexp_replace(left(coalesce(p_title, p_rule), 300), '[\r\n]+', ' ', 'g');
BEGIN
  INSERT INTO public.security_alerts (rule, severity, title, detail, dedup_key, user_id, ip)
  VALUES (p_rule, p_severity, ttl, p_detail, p_dedup, p_user, p_ip)
  ON CONFLICT (dedup_key) DO NOTHING RETURNING id, created_at INTO aid, t_at;
  IF aid IS NULL THEN RETURN false; END IF;
  FOR u IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
           JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
    VALUES (u, 'in_app', 'security_alert', ttl, p_rule, '/admin/security-alerts?id=' || aid::text, 'admin.security_log');
  END LOOP;
  minsev := public.log_setting('security_alerts', '{}'::jsonb) ->> 'email_min_severity';
  IF public.log_severity_rank(minsev) IS NULL THEN minsev := 'low'; END IF;
  IF public.log_severity_rank(p_severity) >= public.log_severity_rank(minsev) THEN
    BEGIN
      PERFORM public.mail_to_system_admins('security_alert', left('[PMIS] ' || upper(p_severity) || ' security alert: ' || ttl, 200),
        'A security alert was raised in GSDN PMIS.' || E'\n' || 'تنبيه أمني في نظام GSDN PMIS.' || E'\n\n'
        || 'Severity: ' || p_severity || E'\n' || 'Rule: ' || p_rule || E'\n' || 'Alert: ' || ttl || E'\n' || 'Raised at: ' || public.log_ts_text(t_at) || ' (UTC)' || E'\n\n'
        || 'Open the alert: {{app_url}}/admin/security-alerts?id=' || aid::text || E'\n\n'
        || 'This mail holds no log details. Sign in to the PMIS to see them and to acknowledge the alert.',
        'security_alert:' || aid::text,
        jsonb_build_object('alert_id', aid, 'rule', p_rule, 'severity', p_severity, 'mandatory', p_rule IN ('retention_reduced', 'audit_integrity_failure', 'break_glass_used')));
    EXCEPTION WHEN others THEN
      PERFORM public.log_system_write('error', 'mail', 'security alert mail not queued', jsonb_build_object('alert_id', aid, 'error', left(SQLERRM, 200)), NULL, NULL);
    END;
  END IF;
  RETURN true;
END $$;

-- Same signature as 0045 (storage_malware_alert, log_verify_chain, log_set_retention and the rules call it): the severity of the settings wins.
CREATE OR REPLACE FUNCTION sec_alert_raise(p_rule text, p_severity text, p_title text, p_detail jsonb, p_dedup text, p_user uuid DEFAULT NULL, p_ip text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.sec_alert_raise_at(p_rule, public.sec_rule_severity(p_rule, p_severity), p_title, p_detail, p_dedup, p_user, p_ip);
END $$;

-- The rules of 0045 with the severities of the settings, the trusted networks for a new address (softened one level, still raised, the other
-- rules unchanged) and break-glass use. Idempotent; reads only the rows sealed since the last run.
CREATE OR REPLACE FUNCTION sec_alerts_evaluate() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg jsonb := public.log_setting('security_alerts', '{}'::jsonb); n int := 0; wa bigint; ws bigint; ha bigint; hs bigint; r record; sev text;
  fc int := coalesce((cfg #>> '{failed_sign_ins,count}')::int, 5); fm int := coalesce((cfg #>> '{failed_sign_ins,minutes}')::int, 15);
  ic int := coalesce((cfg #>> '{failed_by_ip,count}')::int, 20); im int := coalesce((cfg #>> '{failed_by_ip,minutes}')::int, 15);
  big numeric := coalesce((cfg ->> 'large_export_rows')::numeric, 5000); newip boolean := coalesce((cfg ->> 'new_ip')::boolean, true);
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('pmis.security_alerts')) THEN RETURN 0; END IF;
  SELECT value INTO wa FROM public.security_alert_state WHERE key = 'audit_seq' FOR UPDATE;
  SELECT value INTO ws FROM public.security_alert_state WHERE key = 'security_seq' FOR UPDATE;
  SELECT seq INTO ha FROM public.log_chain_heads WHERE log = 'audit';
  SELECT seq INTO hs FROM public.log_chain_heads WHERE log = 'security';

  FOR r IN
    SELECT 'id' AS k, coalesce(s.user_id::text, s.identifier_hash) AS key, max(s.at) AS last_at, max(s.user_id::text) AS uid
    FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
    WHERE c.seq > ws AND c.seq <= hs AND s.event IN ('sign_in_failed', 'two_factor_failed') AND coalesce(s.user_id::text, s.identifier_hash) IS NOT NULL
    GROUP BY 2
    UNION ALL
    SELECT 'ip', s.ip, max(s.at), NULL FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
    WHERE c.seq > ws AND c.seq <= hs AND s.event IN ('sign_in_failed', 'two_factor_failed') AND s.ip IS NOT NULL GROUP BY 2
  LOOP
    IF r.k = 'id' AND (SELECT count(*) FROM public.security_log s WHERE s.event IN ('sign_in_failed', 'two_factor_failed')
          AND coalesce(s.user_id::text, s.identifier_hash) = r.key AND s.at > r.last_at - make_interval(mins => fm) AND s.at <= r.last_at) >= fc THEN
      IF public.sec_alert_raise('failed_sign_ins', 'medium', 'Repeated failed sign-ins for one account or identifier',
           jsonb_build_object('key', r.key, 'count_at_least', fc, 'minutes', fm, 'last_at', r.last_at),
           'failed_sign_ins:' || r.key || ':' || floor(extract(epoch FROM r.last_at) / (fm * 60))::text, r.uid::uuid, NULL) THEN n := n + 1; END IF;
    ELSIF r.k = 'ip' AND (SELECT count(*) FROM public.security_log s WHERE s.event IN ('sign_in_failed', 'two_factor_failed')
          AND s.ip = r.key AND s.at > r.last_at - make_interval(mins => im) AND s.at <= r.last_at) >= ic THEN
      IF public.sec_alert_raise('failed_sign_ins_ip', 'medium', 'Repeated failed sign-ins from one address',
           jsonb_build_object('ip', r.key, 'count_at_least', ic, 'minutes', im, 'last_at', r.last_at, 'trusted_network', public.log_ip_trusted(r.key)),
           'failed_sign_ins_ip:' || r.key || ':' || floor(extract(epoch FROM r.last_at) / (im * 60))::text, NULL, r.key) THEN n := n + 1; END IF;
    END IF;
  END LOOP;

  IF newip THEN
    FOR r IN
      SELECT s.id, s.user_id, s.ip, s.at FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
      WHERE c.seq > ws AND c.seq <= hs AND s.event = 'sign_in_succeeded' AND s.user_id IS NOT NULL AND s.ip IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.security_log p WHERE p.user_id = s.user_id AND p.event = 'sign_in_succeeded' AND p.id < s.id)
        AND NOT EXISTS (SELECT 1 FROM public.security_log p WHERE p.user_id = s.user_id AND p.event = 'sign_in_succeeded' AND p.id < s.id AND p.ip = s.ip)
    LOOP
      sev := public.sec_rule_severity('new_ip', 'low');
      IF public.log_ip_trusted(r.ip) THEN sev := public.log_severity_soften(sev); END IF;
      IF public.sec_alert_raise_at('new_ip', sev, 'Sign-in from a new address',
           jsonb_build_object('ip', r.ip, 'at', r.at, 'security_log_id', r.id, 'trusted_network', public.log_ip_trusted(r.ip)),
           'new_ip:' || r.user_id::text || ':' || r.ip, r.user_id, r.ip) THEN n := n + 1; END IF;
    END LOOP;
  END IF;

  -- every use of the break-glass account (CLAUDE.md: logged and mailed)
  FOR r IN
    SELECT s.id, s.user_id, s.ip, s.at FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
    WHERE c.seq > ws AND c.seq <= hs AND s.event = 'break_glass_used'
  LOOP
    IF public.sec_alert_raise('break_glass_used', 'critical', 'The break-glass account was used', jsonb_build_object('security_log_id', r.id, 'at', r.at, 'ip', r.ip),
         'break_glass_used:' || r.id::text, r.user_id, r.ip) THEN n := n + 1; END IF;
  END LOOP;

  FOR r IN
    SELECT a.* FROM public.audit_log_chain c JOIN public.audit_log a ON a.id = c.audit_id WHERE c.seq > wa AND c.seq <= ha
      AND (a.action LIKE '%export%' OR a.action IN ('group_member_added', 'group_member_removed', 'admin_bootstrapped', 'log_retention_reduced', 'security_alert_settings_weakened'))
  LOOP
    IF r.action LIKE '%export%' AND coalesce(public.log_num(r.after, 'row_count'), public.log_num(r.after, 'file_count'), public.log_num(r.after, 'rows'),
         public.log_num(r.after, 'site_count'), 0) > big THEN
      IF public.sec_alert_raise('large_export', 'medium', 'A large export was started',
           jsonb_build_object('audit_id', r.id, 'action', r.action, 'rows', coalesce(public.log_num(r.after, 'row_count'), public.log_num(r.after, 'file_count'), public.log_num(r.after, 'rows'), public.log_num(r.after, 'site_count')), 'threshold', big),
           'large_export:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    ELSIF r.action = 'admin_bootstrapped' OR (r.action IN ('group_member_added', 'group_member_removed')
          AND EXISTS (SELECT 1 FROM public.groups g WHERE g.id::text = r.entity_id AND g.is_system_admins)) THEN
      IF public.sec_alert_raise('admin_set_changed', 'high', 'The System Admins changed', jsonb_build_object('audit_id', r.id, 'action', r.action, 'after', r.after),
           'admin_set_changed:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    ELSIF r.action = 'log_retention_reduced' THEN
      IF public.sec_alert_raise('retention_reduced', 'critical', 'Log retention was reduced', jsonb_build_object('audit_id', r.id, 'before', r.before, 'after', r.after),
           'retention_reduced:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    ELSIF r.action = 'security_alert_settings_weakened' THEN
      IF public.sec_alert_raise('alert_settings_weakened', 'high', 'Security alert thresholds were weakened', jsonb_build_object('audit_id', r.id, 'before', r.before, 'after', r.after),
           'alert_settings_weakened:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    END IF;
  END LOOP;

  UPDATE public.security_alert_state SET value = ha WHERE key = 'audit_seq';
  UPDATE public.security_alert_state SET value = hs WHERE key = 'security_seq';
  RETURN n;
END $$;

-- The alert settings with the 0055 fields: severity per rule (defaults filled in), email_min_severity, trusted_networks.
CREATE OR REPLACE FUNCTION log_alert_settings_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'failed_sign_ins', coalesce(v -> 'failed_sign_ins', '{"count": 5, "minutes": 15}'::jsonb),
    'failed_by_ip', coalesce(v -> 'failed_by_ip', '{"count": 20, "minutes": 15}'::jsonb),
    'large_export_rows', coalesce((v ->> 'large_export_rows')::int, 5000),
    'new_ip', coalesce((v ->> 'new_ip')::boolean, true),
    'severity', public.sec_rule_default_severities() || CASE WHEN jsonb_typeof(v -> 'severity') = 'object' THEN v -> 'severity' ELSE '{}'::jsonb END,
    'mandatory_severity', '{"retention_reduced": "critical", "audit_integrity_failure": "critical"}'::jsonb,
    'email_min_severity', coalesce(v ->> 'email_min_severity', 'low'),
    'trusted_networks', CASE WHEN jsonb_typeof(v -> 'trusted_networks') = 'array' THEN v -> 'trusted_networks' ELSE '[]'::jsonb END,
    'version', coalesce((v ->> 'version')::int, 1), 'updated_at', s.updated_at, 'updated_by', s.updated_by)
  FROM (SELECT coalesce((SELECT value FROM public.settings WHERE key = 'security_alerts'), '{}'::jsonb) AS v) x
  LEFT JOIN public.settings s ON s.key = 'security_alerts'
$$;

-- 0045 plus the optional 0055 fields (left out = kept). Weakening (a higher failure count, a shorter window, a higher export limit, new_ip off, a
-- lower rule severity, a higher email_min_severity, a trusted network added) needs a fresh step-up, is audited as security_alert_settings_weakened
-- and raises the high alert alert_settings_weakened.
CREATE OR REPLACE FUNCTION log_set_alert_settings(p jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; nv int; fc int; fm int; ic int; im int; big int; weakened boolean; sev jsonb; k text; v text; ems text; nets jsonb := '[]'::jsonb;
  n text; c text;
BEGIN
  IF NOT public.app_actor_is_admin('admin.settings', 'edit') THEN RAISE EXCEPTION 'alert settings: admin.settings edit required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN errs := errs || jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'); END IF;
  fc := public.log_num(p -> 'failed_sign_ins', 'count'); fm := public.log_num(p -> 'failed_sign_ins', 'minutes');
  ic := public.log_num(p -> 'failed_by_ip', 'count'); im := public.log_num(p -> 'failed_by_ip', 'minutes'); big := public.log_num(p, 'large_export_rows');
  IF fc IS NULL OR fc < 3 OR fc > 100 THEN errs := errs || jsonb_build_object('path', '/failed_sign_ins/count', 'code', 'out_of_range', 'message', 'From 3 to 100.'); END IF;
  IF fm IS NULL OR fm < 1 OR fm > 1440 THEN errs := errs || jsonb_build_object('path', '/failed_sign_ins/minutes', 'code', 'out_of_range', 'message', 'From 1 to 1440 minutes.'); END IF;
  IF ic IS NULL OR ic < 5 OR ic > 1000 THEN errs := errs || jsonb_build_object('path', '/failed_by_ip/count', 'code', 'out_of_range', 'message', 'From 5 to 1000.'); END IF;
  IF im IS NULL OR im < 1 OR im > 1440 THEN errs := errs || jsonb_build_object('path', '/failed_by_ip/minutes', 'code', 'out_of_range', 'message', 'From 1 to 1440 minutes.'); END IF;
  IF big IS NULL OR big < 100 OR big > 1000000 THEN errs := errs || jsonb_build_object('path', '/large_export_rows', 'code', 'out_of_range', 'message', 'From 100 to 1000000 rows.'); END IF;
  IF jsonb_typeof(p -> 'new_ip') IS DISTINCT FROM 'boolean' THEN errs := errs || jsonb_build_object('path', '/new_ip', 'code', 'invalid', 'message', 'true or false.'); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'security_alerts' FOR UPDATE;
  cur := public.log_alert_settings_json();
  sev := cur -> 'severity';
  IF p ? 'severity' THEN
    IF jsonb_typeof(p -> 'severity') <> 'object' THEN
      errs := errs || jsonb_build_object('path', '/severity', 'code', 'invalid', 'message', 'An object of rule to severity.');
    ELSE
      FOR k, v IN SELECT key, value #>> '{}' FROM jsonb_each(p -> 'severity') LOOP
        IF NOT public.sec_rule_default_severities() ? k THEN
          errs := errs || jsonb_build_object('path', '/severity/' || k, 'code', CASE WHEN k IN ('retention_reduced', 'audit_integrity_failure') THEN 'mandatory_locked' ELSE 'unknown_field' END,
            'message', CASE WHEN k IN ('retention_reduced', 'audit_integrity_failure') THEN 'This rule is always critical.' ELSE 'Unknown rule.' END);
        ELSIF public.log_severity_rank(v) IS NULL THEN
          errs := errs || jsonb_build_object('path', '/severity/' || k, 'code', 'invalid', 'message', 'info, low, medium, high or critical.');
        ELSE sev := sev || jsonb_build_object(k, v);
        END IF;
      END LOOP;
    END IF;
  END IF;
  ems := coalesce(p ->> 'email_min_severity', cur ->> 'email_min_severity');
  IF public.log_severity_rank(ems) IS NULL THEN errs := errs || jsonb_build_object('path', '/email_min_severity', 'code', 'invalid', 'message', 'info, low, medium, high or critical.'); END IF;
  IF p ? 'trusted_networks' THEN
    IF jsonb_typeof(p -> 'trusted_networks') <> 'array' OR jsonb_array_length(p -> 'trusted_networks') > 50 THEN
      errs := errs || jsonb_build_object('path', '/trusted_networks', 'code', 'invalid', 'message', 'A list of at most 50 networks.');
    ELSE
      FOR n IN SELECT value #>> '{}' FROM jsonb_array_elements(p -> 'trusted_networks') LOOP
        BEGIN
          c := n::cidr::text;
          IF NOT nets ? c THEN nets := nets || to_jsonb(c); END IF;
        EXCEPTION WHEN others THEN
          errs := errs || jsonb_build_object('path', '/trusted_networks', 'code', 'invalid', 'message', 'Not a network in CIDR form (for example 10.20.0.0/16): ' || left(coalesce(n, 'null'), 60));
        END;
      END LOOP;
    END IF;
  ELSE nets := cur -> 'trusted_networks';
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::int THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The settings changed since you read them.')); END IF;
  weakened := fc > public.log_num(cur -> 'failed_sign_ins', 'count') OR fm < public.log_num(cur -> 'failed_sign_ins', 'minutes')
           OR ic > public.log_num(cur -> 'failed_by_ip', 'count') OR im < public.log_num(cur -> 'failed_by_ip', 'minutes')
           OR big > public.log_num(cur, 'large_export_rows') OR (coalesce((cur ->> 'new_ip')::boolean, true) AND NOT (p ->> 'new_ip')::boolean)
           OR public.log_severity_rank(ems) > public.log_severity_rank(cur ->> 'email_min_severity')
           OR EXISTS (SELECT 1 FROM jsonb_each_text(sev) x WHERE public.log_severity_rank(x.value) < public.log_severity_rank(cur #>> ARRAY['severity', x.key]))
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(nets) x WHERE NOT (cur -> 'trusted_networks') ? x);
  IF weakened AND NOT public.log_actor_stepped_up() THEN PERFORM public.wf_err('step_up_required', '{}'::jsonb); END IF;
  nv := (cur ->> 'version')::int + 1;
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('security_alerts', jsonb_build_object('failed_sign_ins', jsonb_build_object('count', fc, 'minutes', fm), 'failed_by_ip', jsonb_build_object('count', ic, 'minutes', im),
    'large_export_rows', big, 'new_ip', (p ->> 'new_ip')::boolean, 'severity', sev, 'email_min_severity', ems, 'trusted_networks', nets, 'version', nv),
    'Security alert thresholds', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public.log_audit_write(CASE WHEN weakened THEN 'security_alert_settings_weakened' ELSE 'security_alert_settings_set' END, 'setting', 'security_alerts',
    cur - 'updated_at' - 'updated_by' - 'mandatory_severity', public.log_alert_settings_json() - 'updated_at' - 'updated_by' - 'mandatory_severity', p_reason);
  RETURN public.log_alert_settings_json();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q170: exact counts of an export (same filters and reader rules as log_audit_read and sec_log_read; not audited, the export is)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_audit_count(p jsonb) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sc jsonb := public.log_audit_scope_json(); isfull boolean;
BEGIN
  IF jsonb_array_length(sc) = 0 THEN RAISE EXCEPTION 'audit log: no reader right' USING ERRCODE = 'insufficient_privilege'; END IF;
  isfull := EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'm' IS NULL AND s ->> 'r' IS NULL);
  RETURN (SELECT count(*) FROM public.audit_log a
  WHERE (isfull OR (a.module_key IS NOT NULL AND public.log_in_scope(sc, a.module_key, a.region_id) AND (a.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
    AND (p ->> 'from' IS NULL OR a.at >= (p ->> 'from')::timestamptz)
    AND (p ->> 'to' IS NULL OR a.at < (p ->> 'to')::timestamptz)
    AND (p ->> 'actor_id' IS NULL OR a.actor_id = (p ->> 'actor_id')::uuid OR a.on_behalf_of = (p ->> 'actor_id')::uuid)
    AND (p ->> 'site_id' IS NULL OR a.site_id = (p ->> 'site_id')::uuid)
    AND (p ->> 'region_id' IS NULL OR a.region_id = (p ->> 'region_id')::int)
    AND (p ->> 'entity_type' IS NULL OR a.entity_type = p ->> 'entity_type')
    AND (p ->> 'entity_id' IS NULL OR a.entity_id = p ->> 'entity_id')
    AND (p ->> 'action' IS NULL OR a.action = p ->> 'action')
    AND (p ->> 'module_key' IS NULL OR a.module_key = p ->> 'module_key')
    AND (p ->> 'via' IS NULL OR a.via = p ->> 'via')
    AND (p ->> 'ip' IS NULL OR a.ip = p ->> 'ip')
    AND (p ->> 'session_id' IS NULL OR a.session_id = (p ->> 'session_id')::uuid)
    AND (p ->> 'batch_id' IS NULL OR a.batch_id = (p ->> 'batch_id')::uuid)
    AND (p ->> 'bulk_action_id' IS NULL OR a.after ->> 'bulk_action_id' = p ->> 'bulk_action_id')
    AND (p ->> 'admin_override' IS NULL OR a.is_admin_override = (p ->> 'admin_override')::boolean)
    AND (p ->> 'privileged' IS NULL OR public.log_is_privileged(a.action, a.entity_type, a.is_admin_override) = (p ->> 'privileged')::boolean)
    AND (p ->> 'q' IS NULL OR a.action ILIKE '%' || (p ->> 'q') || '%' OR a.entity_id ILIKE '%' || (p ->> 'q') || '%' OR a.reason ILIKE '%' || (p ->> 'q') || '%'
         OR a.request_id = p ->> 'q'));
END $$;

CREATE OR REPLACE FUNCTION sec_log_count(p jsonb) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE adm boolean := public.app_actor_is_system_admin(); ev text[];
BEGIN
  IF NOT public.sec_can_read() THEN RAISE EXCEPTION 'security log: System Admin or view_security_log required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF jsonb_typeof(p -> 'event') = 'array' THEN SELECT array_agg(x) INTO ev FROM jsonb_array_elements_text(p -> 'event') x; END IF;
  RETURN (SELECT count(*) FROM public.security_log s
  WHERE (p ->> 'from' IS NULL OR s.at >= (p ->> 'from')::timestamptz)
    AND (p ->> 'to' IS NULL OR s.at < (p ->> 'to')::timestamptz)
    AND (ev IS NULL OR s.event = ANY (ev))
    AND (p ->> 'outcome' IS NULL OR s.outcome = p ->> 'outcome')
    AND (p ->> 'user_id' IS NULL OR s.user_id = (p ->> 'user_id')::uuid)
    AND (p ->> 'ip' IS NULL OR (adm AND s.ip = p ->> 'ip'))
    AND (p ->> 'q' IS NULL OR s.identifier_hash = p ->> 'q' OR s.request_id = p ->> 'q'
         OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.user_id AND (u.display_name ILIKE '%' || (p ->> 'q') || '%' OR trim(u.employee_id) = p ->> 'q'))));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Q169: the extra sheets of the monthly activity workbook (modules, exports, exceptions) within the caller's Audit Log scope. The security log
--    is not part of it. Audited as report.activity_export with the row count (the large-export rule reads it).
-- ---------------------------------------------------------------------------------------------------------------------
-- The audit rows of [t0, t1) within an Audit Log scope, without the reads of the logs themselves. Internal (not granted to pmis_app).
CREATE OR REPLACE FUNCTION log_activity_rows(t0 timestamptz, t1 timestamptz, sc jsonb, isfull boolean) RETURNS SETOF audit_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT al.* FROM public.audit_log al WHERE al.at >= t0 AND al.at < t1
    AND (isfull OR (al.module_key IS NOT NULL AND public.log_in_scope(sc, al.module_key, al.region_id) AND (al.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
    AND al.action NOT IN ('audit_log.read', 'audit_log.field_changes_read', 'security_log.read', 'report.activity_read', 'report.activity_export')
$$;

CREATE OR REPLACE FUNCTION log_activity_workbook(p_month date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); sc jsonb; isfull boolean; t0 timestamptz; t1 timestamptz; mods jsonb; exps jsonb; exc jsonb; regs jsonb; n int;
  tz text := coalesce(public.log_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli');
BEGIN
  IF a IS NULL OR NOT public.app_has_permission(a, 'reports', 'view'::"PermissionAction") THEN
    RAISE EXCEPTION 'activity report: reports view required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  sc := public.log_audit_scope_json();
  IF jsonb_array_length(sc) = 0 THEN RAISE EXCEPTION 'activity report: no Audit Log reader right' USING ERRCODE = 'insufficient_privilege'; END IF;
  isfull := EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'm' IS NULL AND s ->> 'r' IS NULL);
  t0 := (date_trunc('month', p_month)::timestamp) AT TIME ZONE tz;
  t1 := ((date_trunc('month', p_month) + interval '1 month')::timestamp) AT TIME ZONE tz;
  SELECT coalesce(jsonb_agg(jsonb_build_object('module_key', m.module_key, 'actions', m.actions, 'approvals', m.approvals, 'users', m.users, 'overrides', m.overrides)
           ORDER BY m.actions DESC, m.module_key), '[]'::jsonb)
  INTO mods
  FROM (SELECT coalesce(v.module_key, '') AS module_key, count(*) AS actions, count(*) FILTER (WHERE v.action ~ 'approve') AS approvals,
               count(DISTINCT v.actor_id) AS users, count(*) FILTER (WHERE v.is_admin_override) AS overrides
        FROM public.log_activity_rows(t0, t1, sc, isfull) v WHERE v.actor_id IS NOT NULL GROUP BY 1) m;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', public.log_ts_text(x.at), 'actor_id', x.actor_id, 'action', x.action, 'entity_type', x.entity_type,
           'entity_id', x.entity_id, 'module_key', x.module_key, 'region_id', x.region_id,
           'rows', coalesce(public.log_num(x.after, 'row_count'), public.log_num(x.after, 'file_count'), public.log_num(x.after, 'rows'), public.log_num(x.after, 'site_count')))
           ORDER BY x.at, x.id), '[]'::jsonb)
  INTO exps
  FROM (SELECT * FROM public.log_activity_rows(t0, t1, sc, isfull) v WHERE v.action LIKE '%export%' OR v.action LIKE '%download%' ORDER BY v.at, v.id LIMIT 5000) x;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', public.log_ts_text(x.at), 'actor_id', x.actor_id, 'on_behalf_of', x.on_behalf_of, 'action', x.action,
           'entity_type', x.entity_type, 'entity_id', x.entity_id, 'module_key', x.module_key, 'region_id', x.region_id, 'reason', x.reason,
           'kind', CASE WHEN x.is_admin_override THEN 'override' WHEN x.after ->> 'self_approval' = 'true' THEN 'self_approval'
                        WHEN x.entity_type IN ('role', 'user_role_assignment', 'group', 'delegation', 'permission_profile') THEN 'roles'
                        WHEN x.entity_type IN ('matrix', 'matrix_cell') THEN 'matrix'
                        WHEN x.entity_type = 'setting' OR x.action LIKE '%setting%' OR x.action LIKE 'log_retention%' THEN 'settings' ELSE 'other' END)
           ORDER BY x.at, x.id), '[]'::jsonb)
  INTO exc
  FROM (SELECT * FROM public.log_activity_rows(t0, t1, sc, isfull) v
        WHERE v.is_admin_override OR v.after ->> 'self_approval' = 'true' OR public.log_is_privileged(v.action, v.entity_type, v.is_admin_override)
        ORDER BY v.at, v.id LIMIT 5000) x;

  regs := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL) THEN '"all"'::jsonb
               ELSE (SELECT coalesce(jsonb_agg(DISTINCT (s ->> 'r')::int), '[]'::jsonb) FROM jsonb_array_elements(sc) s) END;
  n := jsonb_array_length(mods) + jsonb_array_length(exps) + jsonb_array_length(exc);
  PERFORM public.log_audit_write('report.activity_export', 'report', to_char(p_month, 'YYYY-MM'), NULL,
    jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'format', 'xlsx', 'row_count', n), NULL);
  RETURN jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'from', public.log_ts_text(t0), 'to', public.log_ts_text(t1), 'time_zone', tz,
    'scope', CASE WHEN isfull THEN 'all' ELSE 'limited' END, 'regions', regs, 'modules', mods, 'exports', exps, 'exceptions', exc,
    'exports_truncated', jsonb_array_length(exps) >= 5000, 'exceptions_truncated', jsonb_array_length(exc) >= 5000);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q171: the integrity check as a monitored job (nightly and on demand), its stored result and the external anchor
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE log_integrity_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_run_id       uuid REFERENCES job_runs (id),
  log              text NOT NULL CHECK (log IN ('audit', 'security')),
  trigger          text NOT NULL CHECK (trigger IN ('nightly', 'manual')),
  requested_by     uuid,
  started_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'broken', 'failed')),
  from_seq         bigint NOT NULL,
  to_seq           bigint NOT NULL,
  checked_through  bigint NOT NULL,
  last_hash        char(64),
  row_count        bigint NOT NULL DEFAULT 0,
  break_count      integer NOT NULL DEFAULT 0,
  breaks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  head_hash        char(64),
  anchor_check     jsonb,
  anchor_ref       text,
  error            text
);
CREATE INDEX log_integrity_runs_started ON log_integrity_runs (started_at DESC, id);
CREATE INDEX log_integrity_runs_log_status ON log_integrity_runs (log, status, started_at DESC);

-- A run changes only while it runs (owner pmis_definer); afterwards only its anchor reference may be set, once.
CREATE OR REPLACE FUNCTION log_integrity_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'pmis_definer' AND NEW.id = OLD.id AND NEW.log = OLD.log AND NEW.from_seq = OLD.from_seq AND NEW.to_seq = OLD.to_seq
     AND NEW.started_at = OLD.started_at AND NEW.trigger = OLD.trigger THEN
    IF OLD.status = 'running' THEN RETURN NEW; END IF;
    IF OLD.anchor_ref IS NULL AND NEW.anchor_ref IS NOT NULL AND (to_jsonb(NEW) - 'anchor_ref') = (to_jsonb(OLD) - 'anchor_ref') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'log_integrity_runs: % blocked', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER log_integrity_runs_guard BEFORE UPDATE OR DELETE ON log_integrity_runs FOR EACH ROW EXECUTE FUNCTION log_integrity_runs_guard();
CREATE TRIGGER log_integrity_runs_no_truncate BEFORE TRUNCATE ON log_integrity_runs FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();

-- Chain positions a check of [p_from, p_to] covers (the button refuses a range above logs.integrity.sync_max_rows).
CREATE OR REPLACE FUNCTION log_integrity_span(p_log text, p_from bigint, p_to bigint) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h public.log_chain_heads%ROWTYPE;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'log integrity: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO h FROM public.log_chain_heads WHERE log = p_log;
  IF NOT FOUND THEN RETURN 0; END IF;
  RETURN greatest(0, least(coalesce(p_to, h.seq), h.seq) - greatest(coalesce(p_from, 1), h.purged_through + 1) + 1);
END $$;

-- Verifies chain positions (p_from .. p_to] after p_prev; the same checks as log_verify_chain. Internal (not granted to pmis_app).
CREATE OR REPLACE FUNCTION log_chain_verify_slice(p_log text, p_after bigint, p_to bigint, p_prev text)
  RETURNS TABLE (checked bigint, last_seq bigint, last_hash text, breaks jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prev text := p_prev; expected bigint := p_after + 1; cnt bigint := 0; ls bigint := p_after; brk jsonb := '[]'::jsonb; c record; calc text;
  ar public.audit_log%ROWTYPE; sr public.security_log%ROWTYPE;
BEGIN
  FOR c IN
    SELECT x.seq, x.audit_id AS row_id, x.prev_hash, x.hash FROM public.audit_log_chain x WHERE p_log = 'audit' AND x.seq > p_after AND x.seq <= p_to
    UNION ALL
    SELECT x.seq, x.security_id, x.prev_hash, x.hash FROM public.security_log_chain x WHERE p_log = 'security' AND x.seq > p_after AND x.seq <= p_to
    ORDER BY 1
  LOOP
    cnt := cnt + 1;
    IF c.seq <> expected AND jsonb_array_length(brk) < 100 THEN
      brk := brk || jsonb_build_object('seq', expected, 'kind', 'sequence_gap', 'row_id', NULL, 'expected_hash', NULL, 'found_hash', NULL);
    END IF;
    IF prev IS NOT NULL AND c.prev_hash <> prev AND jsonb_array_length(brk) < 100 THEN
      brk := brk || jsonb_build_object('seq', c.seq, 'kind', 'previous_hash_mismatch', 'row_id', c.row_id, 'expected_hash', prev, 'found_hash', c.prev_hash);
    END IF;
    calc := NULL;
    IF p_log = 'audit' THEN
      SELECT * INTO ar FROM public.audit_log WHERE id = c.row_id;
      IF FOUND THEN calc := public.log_chain_hash(c.prev_hash, public.audit_log_canonical(ar)); END IF;
    ELSE
      SELECT * INTO sr FROM public.security_log WHERE id = c.row_id;
      IF FOUND THEN calc := public.log_chain_hash(c.prev_hash, public.security_log_canonical(sr)); END IF;
    END IF;
    IF calc IS NULL AND jsonb_array_length(brk) < 100 THEN
      brk := brk || jsonb_build_object('seq', c.seq, 'kind', 'row_missing', 'row_id', c.row_id, 'expected_hash', c.hash, 'found_hash', NULL);
    ELSIF calc <> c.hash AND jsonb_array_length(brk) < 100 THEN
      brk := brk || jsonb_build_object('seq', c.seq, 'kind', 'hash_mismatch', 'row_id', c.row_id, 'expected_hash', c.hash, 'found_hash', calc);
    END IF;
    prev := c.hash;
    ls := c.seq;
    expected := c.seq + 1;
  END LOOP;
  IF ls < p_to AND jsonb_array_length(brk) < 100 THEN
    brk := brk || jsonb_build_object('seq', ls + 1, 'kind', 'sequence_gap', 'row_id', NULL, 'expected_hash', NULL, 'found_hash', NULL);
  END IF;
  RETURN QUERY SELECT cnt, p_to, prev, brk;
END $$;

-- Starts a check of the whole live chain (after the purged prefix, up to the head now). manual = a System Admin; nightly = the job (no actor).
-- One running check per log; a run left running for 6 hours is marked failed and replaced.
CREATE OR REPLACE FUNCTION log_integrity_start(p_log text, p_trigger text) RETURNS log_integrity_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h public.log_chain_heads%ROWTYPE; r public.log_integrity_runs%ROWTYPE; prev text; jr uuid; a uuid := public.app_actor();
BEGIN
  IF p_log NOT IN ('audit', 'security') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/log', 'code', 'invalid', 'message', 'audit or security.')))); END IF;
  IF p_trigger = 'manual' THEN
    IF a IS NULL OR NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'log integrity: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  ELSIF p_trigger = 'nightly' THEN
    IF a IS NOT NULL THEN RAISE EXCEPTION 'log integrity: the nightly check is started by the job only' USING ERRCODE = 'insufficient_privilege'; END IF;
  ELSE PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Unknown trigger.'));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.log_integrity'), hashtext(p_log));
  FOR r IN SELECT * FROM public.log_integrity_runs x WHERE x.log = p_log AND x.status = 'running' FOR UPDATE LOOP
    IF r.started_at > now() - interval '6 hours' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'An integrity check of this log is running already.', 'run_id', r.id));
    END IF;
    UPDATE public.log_integrity_runs SET status = 'failed', finished_at = clock_timestamp(), error = 'abandoned' WHERE id = r.id;
    PERFORM public.job_run_finish(r.job_run_id, 'failed', r.row_count, 'abandoned', NULL);
  END LOOP;
  SELECT * INTO h FROM public.log_chain_heads WHERE log = p_log;
  IF h.purged_through = 0 THEN prev := repeat('0', 64);
  ELSIF p_log = 'audit' THEN SELECT x.hash INTO prev FROM public.audit_log_chain x WHERE x.seq = h.purged_through;
  ELSE SELECT x.hash INTO prev FROM public.security_log_chain x WHERE x.seq = h.purged_through; END IF;
  jr := public.job_run_start('audit_integrity_check', NULL);
  INSERT INTO public.log_integrity_runs (job_run_id, log, trigger, requested_by, from_seq, to_seq, checked_through, last_hash)
  VALUES (jr, p_log, p_trigger, a, h.purged_through + 1, h.seq, h.purged_through, prev) RETURNING * INTO r;
  UPDATE public.job_runs SET detail = jsonb_build_object('run_id', r.id, 'log', p_log, 'trigger', p_trigger, 'from_seq', r.from_seq, 'to_seq', r.to_seq, 'progress', 0)
  WHERE id = jr AND outcome = 'running';
  IF p_trigger = 'manual' THEN
    PERFORM public.log_audit_write(CASE p_log WHEN 'audit' THEN 'audit_log.integrity_job_start' ELSE 'security_log.integrity_job_start' END,
      CASE p_log WHEN 'audit' THEN 'audit_log' ELSE 'security_log' END, r.id::text, NULL, jsonb_build_object('from_seq', r.from_seq, 'to_seq', r.to_seq), NULL);
  END IF;
  RETURN r;
END $$;

-- The run may be driven by its trigger: the job (no actor) for a nightly run, a System Admin for a manual one.
CREATE OR REPLACE FUNCTION log_integrity_driver_ok(r log_integrity_runs) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF r.trigger = 'nightly' THEN RETURN public.app_actor() IS NULL; END IF;
  RETURN public.app_actor() IS NOT NULL AND public.app_actor_is_system_admin();
END $$;

-- Checks the next positions (at most p_max_rows, 1 .. 50 000) and records the progress in the run and in its job_runs row.
CREATE OR REPLACE FUNCTION log_integrity_step(p_run uuid, p_max_rows integer) RETURNS log_integrity_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.log_integrity_runs%ROWTYPE; upto bigint; s record; nb jsonb;
BEGIN
  SELECT * INTO r FROM public.log_integrity_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The integrity check does not exist.')); END IF;
  IF NOT public.log_integrity_driver_ok(r) THEN RAISE EXCEPTION 'log integrity: not the driver of this check' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF r.status <> 'running' OR r.checked_through >= r.to_seq THEN RETURN r; END IF;
  upto := least(r.to_seq, r.checked_through + least(greatest(coalesce(p_max_rows, 10000), 1), 50000));
  SELECT * INTO s FROM public.log_chain_verify_slice(r.log, r.checked_through, upto, r.last_hash);
  nb := r.breaks;
  IF jsonb_array_length(nb) < 100 THEN
    nb := nb || (SELECT coalesce(jsonb_agg(q.b ORDER BY q.o), '[]'::jsonb)
                 FROM (SELECT e.value AS b, e.ordinality AS o FROM jsonb_array_elements(s.breaks) WITH ORDINALITY e ORDER BY e.ordinality LIMIT 100 - jsonb_array_length(r.breaks)) q);
  END IF;
  UPDATE public.log_integrity_runs SET checked_through = upto, last_hash = s.last_hash, row_count = r.row_count + s.checked, breaks = nb,
    break_count = r.break_count + jsonb_array_length(s.breaks), head_hash = coalesce(s.last_hash, r.head_hash)
  WHERE id = p_run RETURNING * INTO r;
  UPDATE public.job_runs SET rows = r.row_count, detail = jsonb_build_object('run_id', r.id, 'log', r.log, 'trigger', r.trigger, 'from_seq', r.from_seq, 'to_seq', r.to_seq,
    'checked_through', r.checked_through, 'break_count', r.break_count,
    'progress', CASE WHEN r.to_seq < r.from_seq THEN 100 ELSE floor(100.0 * (r.checked_through - r.from_seq + 1) / (r.to_seq - r.from_seq + 1)) END)
  WHERE id = r.job_run_id AND outcome = 'running';
  RETURN r;
END $$;

-- Ends a run: rows that never got a chain entry (unsealed), the previous external anchor (p_anchor {seq, hash, ref}: the chain must still hold that
-- hash at that position), the stored result, the job_runs row, the System Log, and the mandatory alert when anything broke.
CREATE OR REPLACE FUNCTION log_integrity_finish(p_run uuid, p_anchor jsonb DEFAULT NULL) RETURNS log_integrity_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.log_integrity_runs%ROWTYPE; u record; nb jsonb; ac jsonb; aseq bigint; ahash text; found_hash text; h public.log_chain_heads%ROWTYPE; st text; extra int := 0;
BEGIN
  SELECT * INTO r FROM public.log_integrity_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The integrity check does not exist.')); END IF;
  IF NOT public.log_integrity_driver_ok(r) THEN RAISE EXCEPTION 'log integrity: not the driver of this check' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF r.status <> 'running' THEN RETURN r; END IF;
  IF r.checked_through < r.to_seq THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The check has not reached the end of its range.')); END IF;
  nb := r.breaks;
  FOR u IN
    SELECT a.id FROM public.audit_log a WHERE r.log = 'audit' AND NOT EXISTS (SELECT 1 FROM public.audit_log_chain x WHERE x.audit_id = a.id)
    UNION ALL
    SELECT s.id FROM public.security_log s WHERE r.log = 'security' AND NOT EXISTS (SELECT 1 FROM public.security_log_chain x WHERE x.security_id = s.id)
    ORDER BY 1 LIMIT 100
  LOOP
    extra := extra + 1;
    IF jsonb_array_length(nb) < 100 THEN nb := nb || jsonb_build_object('seq', NULL, 'kind', 'unsealed', 'row_id', u.id, 'expected_hash', NULL, 'found_hash', NULL); END IF;
  END LOOP;
  IF p_anchor IS NOT NULL AND jsonb_typeof(p_anchor) = 'object' AND p_anchor ? 'seq' THEN
    aseq := public.log_num(p_anchor, 'seq');
    ahash := p_anchor ->> 'hash';
    SELECT * INTO h FROM public.log_chain_heads WHERE log = r.log;
    IF aseq IS NOT NULL AND aseq > h.purged_through THEN
      IF r.log = 'audit' THEN SELECT x.hash INTO found_hash FROM public.audit_log_chain x WHERE x.seq = aseq;
      ELSE SELECT x.hash INTO found_hash FROM public.security_log_chain x WHERE x.seq = aseq; END IF;
      ac := jsonb_build_object('seq', aseq, 'ref', left(p_anchor ->> 'ref', 200), 'ok', found_hash IS NOT NULL AND found_hash = ahash);
      IF found_hash IS DISTINCT FROM ahash THEN
        extra := extra + 1;
        IF jsonb_array_length(nb) < 100 THEN
          nb := nb || jsonb_build_object('seq', aseq, 'kind', 'anchor_mismatch', 'row_id', NULL, 'expected_hash', ahash, 'found_hash', found_hash);
        END IF;
      END IF;
    ELSE
      ac := jsonb_build_object('seq', aseq, 'ref', left(p_anchor ->> 'ref', 200), 'ok', NULL, 'note', 'purged or not given');
    END IF;
  END IF;
  st := CASE WHEN r.break_count + extra = 0 THEN 'ok' ELSE 'broken' END;
  UPDATE public.log_integrity_runs SET status = st, finished_at = clock_timestamp(), breaks = nb, break_count = r.break_count + extra, anchor_check = ac
  WHERE id = p_run RETURNING * INTO r;
  PERFORM public.job_run_finish(r.job_run_id, CASE WHEN st = 'ok' THEN 'ok' ELSE 'failed' END, r.row_count, CASE WHEN st = 'broken' THEN r.break_count::text || ' break(s)' END,
    jsonb_build_object('run_id', r.id, 'log', r.log, 'trigger', r.trigger, 'status', st, 'from_seq', r.from_seq, 'to_seq', r.to_seq, 'break_count', r.break_count,
      'head_hash', r.head_hash, 'progress', 100, 'anchor_ok', ac -> 'ok'));
  PERFORM public.log_system_write(CASE WHEN st = 'ok' THEN 'info' ELSE 'error' END, 'integrity', 'log integrity check ' || st,
    jsonb_build_object('run_id', r.id, 'log', r.log, 'trigger', r.trigger, 'row_count', r.row_count, 'from_seq', r.from_seq, 'to_seq', r.to_seq,
      'head_hash', r.head_hash, 'break_count', r.break_count, 'anchor', ac), r.requested_by, NULL);
  IF r.trigger = 'manual' THEN
    PERFORM public.log_audit_write(CASE r.log WHEN 'audit' THEN 'audit_log.integrity_check' ELSE 'security_log.integrity_check' END,
      CASE r.log WHEN 'audit' THEN 'audit_log' ELSE 'security_log' END, r.id::text, NULL,
      jsonb_build_object('status', st, 'row_count', r.row_count, 'first_seq', r.from_seq, 'last_seq', r.to_seq, 'head_hash', r.head_hash, 'break_count', r.break_count,
        'run_id', r.id, 'as_job', true), NULL);
  END IF;
  IF st = 'broken' THEN
    PERFORM public.sec_alert_raise('audit_integrity_failure', 'critical', 'Log integrity check found a break',
      jsonb_build_object('log', r.log, 'breaks', nb -> 0, 'break_count', r.break_count, 'run_id', r.id, 'trigger', r.trigger),
      'audit_integrity_failure:' || r.log || ':run:' || r.id::text, NULL, NULL);
  END IF;
  RETURN r;
END $$;

-- The reference of the line the API appended to the anchor file for this run (once).
CREATE OR REPLACE FUNCTION log_integrity_set_anchor(p_run uuid, p_ref text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.log_integrity_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.log_integrity_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND OR r.status = 'running' OR r.anchor_ref IS NOT NULL THEN RETURN; END IF;
  IF NOT public.log_integrity_driver_ok(r) THEN RAISE EXCEPTION 'log integrity: not the driver of this check' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9._-]{1,80}#[0-9]{1,9}:[0-9a-f]{16}$' THEN RAISE EXCEPTION 'log integrity: bad anchor reference' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.log_integrity_runs SET anchor_ref = p_ref WHERE id = p_run;
END $$;

-- A run the API could not finish (an error in a step).
CREATE OR REPLACE FUNCTION log_integrity_fail(p_run uuid, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.log_integrity_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.log_integrity_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' THEN RETURN; END IF;
  IF NOT public.log_integrity_driver_ok(r) THEN RAISE EXCEPTION 'log integrity: not the driver of this check' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.log_integrity_runs SET status = 'failed', finished_at = clock_timestamp(), error = left(p_error, 300) WHERE id = p_run;
  PERFORM public.job_run_finish(r.job_run_id, 'failed', r.row_count, left(p_error, 300), NULL);
  PERFORM public.log_system_write('error', 'integrity', 'log integrity check failed', jsonb_build_object('run_id', r.id, 'log', r.log, 'error', left(p_error, 300)), r.requested_by, NULL);
END $$;

-- Readers (System Admin or view on admin.system_log).
CREATE OR REPLACE FUNCTION log_integrity_runs_read(p jsonb, p_limit integer) RETURNS SETOF log_integrity_runs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.log_can_read_ops() THEN RAISE EXCEPTION 'log integrity: System Admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY SELECT x.* FROM public.log_integrity_runs x
  WHERE (p ->> 'id' IS NULL OR x.id = (p ->> 'id')::uuid) AND (p ->> 'log' IS NULL OR x.log = p ->> 'log') AND (p ->> 'status' IS NULL OR x.status = p ->> 'status')
    AND (p ->> 'cursor_at' IS NULL OR (x.started_at, x.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::uuid))
  ORDER BY x.started_at DESC, x.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 201);
END $$;

-- The latest finished result per log, for the health check (status only).
CREATE OR REPLACE FUNCTION log_integrity_latest() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_object_agg(l.log, jsonb_build_object('status', x.status, 'finished_at', public.log_ts_text(x.finished_at))), '{}'::jsonb)
  FROM (VALUES ('audit'), ('security')) l(log)
  LEFT JOIN LATERAL (SELECT r.status, r.finished_at FROM public.log_integrity_runs r WHERE r.log = l.log AND r.status IN ('ok', 'broken') ORDER BY r.finished_at DESC LIMIT 1) x ON true
$$;

-- Words only, for the external monitoring path (GET /health): failed job runs of the last 24 hours, the last integrity result per log, and when the
-- alert rules last ran.
CREATE OR REPLACE FUNCTION log_health() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'jobs_failed_24h', (SELECT count(*) FROM public.job_runs j WHERE j.outcome = 'failed' AND j.started_at > now() - interval '24 hours'),
    'integrity', public.log_integrity_latest(),
    'alerts_ran_at', public.log_ts_text((SELECT max(j.finished_at) FROM public.job_runs j WHERE j.name = 'security_alerts' AND j.outcome = 'ok')))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_outbox TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON log_integrity_runs TO pmis_definer;
GRANT SELECT ON audit_log_chain, security_log_chain, log_chain_heads TO pmis_definer;
GRANT SELECT ON notifications TO pmis_definer;
GRANT UPDATE (capabilities) ON roles TO pmis_identity_owner;
GRANT EXECUTE ON FUNCTION wf_err(text, jsonb) TO pmis_identity_owner;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'log_capability_roles(text,text,jsonb)', 'mail_enqueue_internal(text,text,uuid,text,text,text,boolean,jsonb)', 'mail_send_to_user(text,uuid,text,text,text,boolean)',
    'mail_send_to_address(text,text,text,text,text,boolean)', 'mail_to_system_admins(text,text,text,text,jsonb)', 'mail_claim(integer,integer,uuid)',
    'mail_mark(uuid,text,text,text)', 'mail_can_read()', 'mail_outbox_read(jsonb,integer)', 'mail_stats(text)', 'mail_test_enqueue(text,text,text)', 'mail_retry(uuid,text)',
    'mail_purge()', 'mail_on_notification()', 'sec_rule_severity(text,text)', 'log_ip_trusted(text)', 'sec_alert_raise_at(text,text,text,jsonb,text,uuid,text)',
    'log_audit_count(jsonb)', 'sec_log_count(jsonb)', 'log_activity_rows(timestamptz,timestamptz,jsonb,boolean)', 'log_activity_workbook(date)', 'log_integrity_span(text,bigint,bigint)',
    'log_chain_verify_slice(text,bigint,bigint,text)', 'log_integrity_start(text,text)', 'log_integrity_driver_ok(log_integrity_runs)', 'log_integrity_step(uuid,integer)',
    'log_integrity_finish(uuid,jsonb)', 'log_integrity_set_anchor(uuid,text)', 'log_integrity_fail(uuid,text)', 'log_integrity_runs_read(jsonb,integer)', 'log_integrity_latest()', 'log_health()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- helpers without rights of their own
  FOREACH f IN ARRAY ARRAY['mail_address_ok(text)', 'mail_mask(text)', 'log_severity_rank(text)', 'log_severity_soften(text)', 'sec_rule_default_severities()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
  END LOOP;
  ALTER FUNCTION idm_role_set_capabilities(uuid, text[], text) OWNER TO pmis_identity_owner;
  REVOKE ALL ON FUNCTION idm_role_set_capabilities(uuid, text[], text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION log_capability_roles(text, text, jsonb), log_actor_stepped_up() TO pmis_identity_owner;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON mail_outbox, log_integrity_runs FROM pmis_app;
    FOREACH f IN ARRAY ARRAY[
      'idm_role_set_capabilities(uuid,text[],text)', 'mail_send_to_user(text,uuid,text,text,text,boolean)', 'mail_send_to_address(text,text,text,text,text,boolean)',
      'mail_claim(integer,integer,uuid)', 'mail_mark(uuid,text,text,text)', 'mail_can_read()', 'mail_outbox_read(jsonb,integer)', 'mail_stats(text)', 'mail_test_enqueue(text,text,text)',
      'mail_retry(uuid,text)', 'mail_purge()', 'log_audit_count(jsonb)', 'sec_log_count(jsonb)', 'log_activity_workbook(date)', 'log_integrity_span(text,bigint,bigint)',
      'log_integrity_start(text,text)', 'log_integrity_step(uuid,integer)', 'log_integrity_finish(uuid,jsonb)', 'log_integrity_set_anchor(uuid,text)',
      'log_integrity_fail(uuid,text)', 'log_integrity_runs_read(jsonb,integer)', 'log_health()'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
