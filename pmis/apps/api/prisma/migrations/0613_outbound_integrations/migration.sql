-- 0613_outbound_integrations (contract 0.15.475): outbound notifications to a webhook or an email address, off by default (spec D8).
-- Mirror: db/sql/612_outbound_integrations.sql (kept byte-identical).
--
-- Nothing leaves the system unless an admin turns the switch on in Settings > Integrations. Then, for each new in-app notification whose kind an
-- active destination listens to, one delivery row is queued. A destination is an https webhook (HMAC-signed, secret encrypted by the API with the existing
-- key) or an email address (sent through the existing mail outbox). The payload carries the notification kind, its title and the ids and link only, never
-- the recipient or the body. The disable_export lock blocks every delivery. A webhook is tried 3 times, then marked dead. A destination is archived, never deleted.
--   Tables: outbound_destinations (configuration, KEEP in a reset), outbound_deliveries (a log). Setting: integrations.outbound_enabled (default off).
--   Doors (admin.settings, all regions, a reason, audited): admin_outbound_overview, admin_save_outbound_enabled, admin_save_outbound_destination,
--   admin_archive_outbound_destination, admin_outbound_deliveries. Worker doors (no user, called by the API job): outbound_claim, outbound_mark.

CREATE TABLE IF NOT EXISTS outbound_destinations (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('webhook', 'email')),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  target text NOT NULL CHECK (char_length(target) BETWEEN 5 AND 500),
  secret_enc text,
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'webhook' OR target ~ '^https://[^/[:space:]]+'),
  CHECK (kind <> 'webhook' OR secret_enc IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES outbound_destinations(id),
  event text NOT NULL,
  notification_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'dead', 'blocked')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (destination_id, notification_id)
);
CREATE INDEX IF NOT EXISTS outbound_deliveries_due_idx ON outbound_deliveries (next_attempt_at) WHERE status = 'queued';
REVOKE ALL ON outbound_destinations, outbound_deliveries FROM PUBLIC;

-- The notification kinds an admin may listen to (the existing kinds only).
CREATE OR REPLACE FUNCTION outbound_event_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY['task_assigned', 'task_rejected', 'reassigned', 'assignment_request', 'followed_change', 'site_draft_assigned', 'site_draft_approved',
               'site_draft_returned', 'absence_alert', 'import_batch']::text[]
$$;

CREATE OR REPLACE FUNCTION outbound_enabled_now() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT value #>> '{}' FROM public.settings WHERE key = 'integrations.outbound_enabled'), 'false') = 'true'
     AND NOT public.security_lock_active('disable_export')
$$;

CREATE OR REPLACE FUNCTION outbound_overview_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'integrations.outbound_enabled';
  RETURN jsonb_build_object(
    'enabled', coalesce(s.value #>> '{}', 'false') = 'true',
    'locked', public.security_lock_active('disable_export'),
    'version', CASE WHEN s.updated_by IS NULL THEN 0 ELSE floor(extract(epoch FROM s.updated_at))::int END,
    'updated_at', CASE WHEN s.updated_by IS NULL THEN NULL ELSE s.updated_at END,
    'event_kinds', to_jsonb(public.outbound_event_kinds()),
    'destinations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'label', d.label, 'target', d.target,
        'has_secret', d.secret_enc IS NOT NULL, 'events', d.events, 'active', d.active, 'archived_at', d.archived_at,
        'updated_at', d.updated_at,
        'queued', (SELECT count(*) FROM public.outbound_deliveries q WHERE q.destination_id = d.id AND q.status = 'queued'),
        'dead', (SELECT count(*) FROM public.outbound_deliveries q WHERE q.destination_id = d.id AND q.status = 'dead'))
        ORDER BY d.archived_at IS NOT NULL, d.created_at) FROM public.outbound_destinations d), '[]'::jsonb));
END
$$;

CREATE OR REPLACE FUNCTION admin_outbound_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  RETURN public.outbound_overview_json();
END
$$;

CREATE OR REPLACE FUNCTION admin_save_outbound_enabled(p_enabled boolean, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; v int;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(public.reg_err_item('/enabled', 'required', 'true or false.'))));
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('integrations.outbound_enabled', 'false'::jsonb, 'D8: outbound notifications (webhook and email) are sent only when this is true. Off by default.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'integrations.outbound_enabled' FOR UPDATE;
  cur := public.outbound_overview_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  before := jsonb_build_object('enabled', cur -> 'enabled');
  UPDATE public.settings SET value = to_jsonb(p_enabled), updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'integrations.outbound_enabled';
  after := public.outbound_overview_json();
  PERFORM public.log_audit_write('outbound_enabled_update', 'setting', 'integrations.outbound_enabled', before, jsonb_build_object('enabled', after -> 'enabled'), btrim(p_reason));
  RETURN after;
END
$$;

-- p_id is generated by the API (it is the AAD of the encrypted secret). p_secret_enc NULL keeps the stored secret on an update.
CREATE OR REPLACE FUNCTION admin_save_outbound_destination(p_id uuid, p_kind text, p_label text, p_target text, p_secret_enc text, p_events text[],
  p_active boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb; cur public.outbound_destinations; before jsonb; after jsonb; ev text[]; tgt text := btrim(coalesce(p_target, ''));
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO cur FROM public.outbound_destinations WHERE id = p_id FOR UPDATE;
  IF FOUND AND p_kind IS DISTINCT FROM cur.kind THEN
    errs := errs || public.reg_err_item('/kind', 'immutable', 'The kind of a destination cannot change.');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('webhook', 'email') THEN errs := errs || public.reg_err_item('/kind', 'invalid', 'webhook or email.'); END IF;
  IF char_length(btrim(coalesce(p_label, ''))) NOT BETWEEN 1 AND 120 THEN errs := errs || public.reg_err_item('/label', 'invalid', 'A label of 1 to 120 characters.'); END IF;
  IF p_kind = 'webhook' AND tgt !~ '^https://[^/[:space:]]+' THEN errs := errs || public.reg_err_item('/target', 'invalid', 'An https URL.'); END IF;
  IF p_kind = 'email' AND NOT public.mail_address_ok(lower(tgt)) THEN errs := errs || public.reg_err_item('/target', 'invalid', 'A valid email address.'); END IF;
  IF p_kind = 'webhook' AND p_secret_enc IS NULL AND cur.id IS NULL THEN errs := errs || public.reg_err_item('/secret', 'required', 'A secret is required for a webhook.'); END IF;
  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), '{}') INTO ev FROM unnest(coalesce(p_events, '{}')) e;
  IF cardinality(ev) = 0 OR EXISTS (SELECT 1 FROM unnest(ev) e WHERE e <> ALL (public.outbound_event_kinds())) THEN
    errs := errs || public.reg_err_item('/events', 'invalid', 'One or more of the listed notification kinds.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF cur.id IS NULL THEN
    INSERT INTO public.outbound_destinations (id, kind, label, target, secret_enc, events, active, created_by)
    VALUES (p_id, p_kind, btrim(p_label), CASE WHEN p_kind = 'email' THEN lower(tgt) ELSE tgt END, p_secret_enc, ev, coalesce(p_active, true), public.app_actor());
    before := NULL;
  ELSE
    IF cur.archived_at IS NOT NULL THEN PERFORM public.wf_err('conflict'); END IF;
    before := jsonb_build_object('label', cur.label, 'target', cur.target, 'events', cur.events, 'active', cur.active, 'secret_changed', false);
    UPDATE public.outbound_destinations SET label = btrim(p_label), target = CASE WHEN p_kind = 'email' THEN lower(tgt) ELSE tgt END,
      secret_enc = coalesce(p_secret_enc, secret_enc), events = ev, active = coalesce(p_active, active), updated_at = clock_timestamp() WHERE id = p_id;
  END IF;
  SELECT * INTO cur FROM public.outbound_destinations WHERE id = p_id;
  after := jsonb_build_object('kind', cur.kind, 'label', cur.label, 'target', cur.target, 'events', cur.events, 'active', cur.active, 'secret_changed', p_secret_enc IS NOT NULL);
  PERFORM public.log_audit_write('outbound_destination_save', 'outbound_destination', p_id::text, before, after, btrim(p_reason));
  RETURN public.outbound_overview_json();
END
$$;

CREATE OR REPLACE FUNCTION admin_archive_outbound_destination(p_id uuid, p_archived boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur public.outbound_destinations;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO cur FROM public.outbound_destinations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  UPDATE public.outbound_destinations SET archived_at = CASE WHEN coalesce(p_archived, true) THEN coalesce(archived_at, now()) ELSE NULL END,
    active = CASE WHEN coalesce(p_archived, true) THEN false ELSE active END, updated_at = clock_timestamp() WHERE id = p_id;
  PERFORM public.log_audit_write('outbound_destination_archive', 'outbound_destination', p_id::text, jsonb_build_object('archived', cur.archived_at IS NOT NULL),
    jsonb_build_object('archived', coalesce(p_archived, true)), btrim(p_reason));
  RETURN public.outbound_overview_json();
END
$$;

CREATE OR REPLACE FUNCTION admin_outbound_deliveries(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  RETURN coalesce((SELECT jsonb_agg(r ORDER BY r.created_at DESC) FROM (
    SELECT l.id, d.label AS destination, d.kind, l.event, l.status, l.attempts, l.last_status, l.last_error, l.created_at, l.sent_at
      FROM public.outbound_deliveries l JOIN public.outbound_destinations d ON d.id = l.destination_id
     ORDER BY l.created_at DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)) r), '[]'::jsonb);
END
$$;

-- The enqueue: one delivery per (destination, notification). Only when the switch is on and the export lock is off.
CREATE OR REPLACE FUNCTION outbound_on_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d record; pl jsonb; did uuid;
BEGIN
  IF NOT public.outbound_enabled_now() THEN RETURN NEW; END IF;
  IF NEW.kind <> ALL (public.outbound_event_kinds()) THEN RETURN NEW; END IF;
  pl := jsonb_build_object('event', NEW.kind, 'title', left(NEW.title, 300), 'notification_id', NEW.id, 'task_id', NEW.task_id, 'link', NEW.link, 'at', NEW.created_at);
  FOR d IN SELECT * FROM public.outbound_destinations WHERE active AND archived_at IS NULL AND NEW.kind = ANY (events) LOOP
    INSERT INTO public.outbound_deliveries (destination_id, event, notification_id, payload) VALUES (d.id, NEW.kind, NEW.id, pl)
    ON CONFLICT (destination_id, notification_id) DO NOTHING RETURNING id INTO did;
    IF did IS NOT NULL AND d.kind = 'email' THEN
      BEGIN
        PERFORM public.mail_enqueue_internal('outbound.event', d.target, NULL, left(NEW.title, 200), NEW.title || coalesce(E'\n' || NEW.link, ''),
          'outbound:' || did::text, false, jsonb_build_object('outbound_delivery', did));
        UPDATE public.outbound_deliveries SET status = 'sent', attempts = 1, sent_at = now() WHERE id = did;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.outbound_deliveries SET status = 'dead', attempts = 1, last_error = left(SQLERRM, 300) WHERE id = did;
      END;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS notifications_outbound ON notifications;
CREATE TRIGGER notifications_outbound AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION outbound_on_notification();

-- The worker: claim due webhook deliveries (a lease of 2 minutes), then mark each result. Nothing is returned when the switch is off or the lock is on.
CREATE OR REPLACE FUNCTION outbound_claim(p_limit integer) RETURNS TABLE (id uuid, destination_id uuid, url text, secret_enc text, payload jsonb, attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.outbound_enabled_now() THEN RETURN; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT l.id FROM public.outbound_deliveries l JOIN public.outbound_destinations d ON d.id = l.destination_id
     WHERE l.status = 'queued' AND l.next_attempt_at <= now() AND d.kind = 'webhook' AND d.active AND d.archived_at IS NULL
     ORDER BY l.next_attempt_at LIMIT least(greatest(coalesce(p_limit, 10), 1), 50) FOR UPDATE OF l SKIP LOCKED)
  UPDATE public.outbound_deliveries l SET attempts = l.attempts + 1, next_attempt_at = now() + interval '2 minutes'
    FROM due, public.outbound_destinations d
   WHERE l.id = due.id AND d.id = l.destination_id
  RETURNING l.id, l.destination_id, d.target, d.secret_enc, l.payload, l.attempts;
END
$$;

CREATE OR REPLACE FUNCTION outbound_mark(p_id uuid, p_ok boolean, p_http integer, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a int;
BEGIN
  SELECT attempts INTO a FROM public.outbound_deliveries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_ok THEN
    UPDATE public.outbound_deliveries SET status = 'sent', sent_at = now(), last_status = p_http, last_error = NULL WHERE id = p_id;
  ELSIF a >= 3 THEN
    UPDATE public.outbound_deliveries SET status = 'dead', last_status = p_http, last_error = left(p_error, 300) WHERE id = p_id;
  ELSE
    UPDATE public.outbound_deliveries SET last_status = p_http, last_error = left(p_error, 300),
      next_attempt_at = now() + (CASE a WHEN 1 THEN interval '1 minute' ELSE interval '5 minutes' END) WHERE id = p_id;
  END IF;
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['outbound_event_kinds()', 'outbound_enabled_now()', 'outbound_overview_json()', 'admin_outbound_overview()', 'admin_save_outbound_enabled(boolean,text,integer)',
    'admin_save_outbound_destination(uuid,text,text,text,text,text[],boolean,text)', 'admin_archive_outbound_destination(uuid,boolean,text)', 'admin_outbound_deliveries(integer)',
    'outbound_on_notification()', 'outbound_claim(integer)', 'outbound_mark(uuid,boolean,integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  GRANT SELECT, INSERT, UPDATE ON outbound_destinations, outbound_deliveries TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['admin_outbound_overview()', 'admin_save_outbound_enabled(boolean,text,integer)',
      'admin_save_outbound_destination(uuid,text,text,text,text,text[],boolean,text)', 'admin_archive_outbound_destination(uuid,boolean,text)',
      'admin_outbound_deliveries(integer)', 'outbound_claim(integer)', 'outbound_mark(uuid,boolean,integer,text)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;

-- Data reset: destinations are configuration (KEEP), deliveries a log. data_reset_plan() is an accumulating function: patched in place, idempotently.
GRANT SELECT, UPDATE ON outbound_destinations, outbound_deliveries TO pmis_reset_owner;
DO $$
DECLARE def text; n1 text := '''workflow_definitions'', '; n2 text := '''mail_outbox'', ';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('outbound_destinations' IN def) = 0 THEN
    IF position(n1 IN def) = 0 OR position(n2 IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the configuration or log list was not found'; END IF;
    def := replace(def, n1, n1 || '''outbound_destinations'', ');
    def := replace(def, n2, n2 || '''outbound_deliveries'', ');
    EXECUTE def;
  END IF;
END $$;
