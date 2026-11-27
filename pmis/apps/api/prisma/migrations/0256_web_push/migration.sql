-- 0256: Web Push for field engineers (contract 0.15.156). Additive: one table and seven functions, no change to existing tables.
-- push_subscriptions holds one row per browser a person turned notifications on for. A person sees and changes only their own rows (RLS plus definer doors).
-- The sender (API job) wakes a browser when the person has new unread in-app notifications. The push carries no title and no body, only "you have something
-- new", so nothing about a site or a record leaves the server; the inbox applies its own module and region filter when the person opens it.
-- The bell and the e-mail are untouched. Web Push stays off until the VAPID keys are set in the environment (the keys are never stored in the database).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint             text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 10 AND 2048 AND endpoint LIKE 'https://%'),
  p256dh               text NOT NULL CHECK (length(p256dh) BETWEEN 10 AND 200),
  auth                 text NOT NULL CHECK (length(auth) BETWEEN 8 AND 100),
  user_agent           text CHECK (length(user_agent) <= 300),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_notification_at timestamptz NOT NULL DEFAULT now(),
  last_pushed_at       timestamptz,
  failed_count         integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON push_subscriptions;
CREATE POLICY rls_select ON push_subscriptions FOR SELECT USING (user_id = app_actor());

-- Turn on for this browser. A browser that was used by another person is moved to the signed-in person (one browser, one owner).
CREATE OR REPLACE FUNCTION push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := public.app_actor(); v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (v_actor, p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
  ON CONFLICT (endpoint) DO UPDATE SET user_id = v_actor, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent,
    last_notification_at = now(), failed_count = 0
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'count', (SELECT count(*) FROM public.push_subscriptions WHERE user_id = v_actor));
END $$;

-- Turn off for this browser (own row only).
CREATE OR REPLACE FUNCTION push_unsubscribe(p_endpoint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := public.app_actor(); v_n integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint AND user_id = v_actor;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('removed', v_n, 'count', (SELECT count(*) FROM public.push_subscriptions WHERE user_id = v_actor));
END $$;

-- Own devices count, and whether the asking browser is among them.
CREATE OR REPLACE FUNCTION push_my_status(p_endpoint text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := public.app_actor();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object('count', (SELECT count(*) FROM public.push_subscriptions WHERE user_id = v_actor),
    'this_browser', p_endpoint IS NOT NULL AND EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = v_actor AND endpoint = p_endpoint));
END $$;

-- Settings > Alerts > Web push (System Admin): how many people and browsers are subscribed.
CREATE OR REPLACE FUNCTION push_admin_status_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'web push: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object('subscriptions', (SELECT count(*) FROM public.push_subscriptions),
    'users', (SELECT count(DISTINCT user_id) FROM public.push_subscriptions),
    'last_pushed_at', (SELECT max(last_pushed_at) FROM public.push_subscriptions));
END $$;

-- For the sender job (no actor): the browsers with unread, visible-in-time in-app notifications newer than their cursor. Counts only, no text.
CREATE OR REPLACE FUNCTION push_due(p_limit integer)
RETURNS TABLE (sub_id uuid, endpoint text, p256dh text, auth text, newest timestamptz, n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id, s.endpoint, s.p256dh, s.auth, max(n.created_at), count(*)::int
  FROM public.push_subscriptions s
  JOIN public.users u ON u.id = s.user_id AND u.deleted_at IS NULL AND u.purged_at IS NULL
  JOIN public.notifications n ON n.user_id = s.user_id AND n.channel = 'in_app' AND n.read_at IS NULL
       AND n.created_at > s.last_notification_at AND (n.snoozed_until IS NULL OR n.snoozed_until <= now())
  GROUP BY s.id, s.endpoint, s.p256dh, s.auth
  ORDER BY min(n.created_at) LIMIT greatest(1, least(p_limit, 200));
$$;

-- For the sender job: the result of one push. ok moves the cursor; gone (404/410) removes the browser; any other failure counts and removes after 10.
CREATE OR REPLACE FUNCTION push_mark(p_sub uuid, p_up_to timestamptz, p_outcome text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_outcome NOT IN ('ok', 'gone', 'failed') THEN RAISE EXCEPTION 'push_mark: bad outcome'; END IF;
  IF p_outcome = 'ok' THEN
    UPDATE public.push_subscriptions SET last_notification_at = p_up_to, last_pushed_at = now(), failed_count = 0 WHERE id = p_sub;
  ELSIF p_outcome = 'gone' THEN
    DELETE FROM public.push_subscriptions WHERE id = p_sub;
  ELSE
    UPDATE public.push_subscriptions SET failed_count = failed_count + 1 WHERE id = p_sub;
    DELETE FROM public.push_subscriptions WHERE id = p_sub AND failed_count >= 10;
  END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['push_subscribe(text,text,text,text)', 'push_unsubscribe(text)', 'push_my_status(text)', 'push_admin_status_json()', 'push_due(integer)', 'push_mark(uuid,timestamptz,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  ALTER TABLE push_subscriptions OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION push_subscribe(text, text, text, text), push_unsubscribe(text), push_my_status(text), push_admin_status_json(), push_due(integer), push_mark(uuid, timestamptz, text) TO pmis_app;
    GRANT SELECT ON push_subscriptions TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON push_subscriptions FROM pmis_app;
  END IF;
END $$;

-- Data reset coverage: data_reset_core stops (and the Settings reset refuses) on a table without a decision in data_reset_plan(). push_subscriptions holds
-- the browsers of people, which is identity and access state, so KEEP. The stored function text is patched in place (idempotent), never rebuilt from an
-- old base, so every table and part added by other migrations stays.
DO $$
DECLARE def text; marker text := '''local_credentials'',';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('push_subscriptions' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no local_credentials row to patch'; END IF;
    EXECUTE replace(def, marker, marker || ' ''push_subscriptions'',');
  END IF;
END $$;

-- the reset role reads every table and takes the share lock of a KEEP table (UPDATE)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_reset_owner') THEN
    EXECUTE 'GRANT SELECT, UPDATE ON public.push_subscriptions TO pmis_reset_owner';
  END IF;
END $$;
