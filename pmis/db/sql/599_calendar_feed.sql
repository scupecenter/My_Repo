-- 0600_calendar_feed: the personal, revocable calendar feed (D4, contract 0.15.460). Mirror: db/sql/599_calendar_feed.sql (kept identical).
-- Additive: one table and four functions, no change to an existing table.
--   * calendar_feed_tokens holds at most one feed per person: only the SHA-256 hash of the secret link is stored (the secret itself is shown once, when it is made).
--   * Nothing is public by default: a person has no feed until they turn it on in their own settings; they can rotate (the old link stops at once) or revoke.
--   * The feed lists only the person's own dates: open tasks pinned to them with a planned date, and the Valid To date of the approved permits they created
--     (own rows only; no other person's data, and no site or record detail beyond site code and title). A person with no row in the table gets nothing.
--   * The feed read is a definer function keyed by the token hash, so a calendar app (which cannot sign in) can read it without a session. It runs no
--     statement as a person and widens no right.

CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  last_read_at timestamptz,
  read_count   integer NOT NULL DEFAULT 0
);

ALTER TABLE calendar_feed_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_feed_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON calendar_feed_tokens;
CREATE POLICY rls_select ON calendar_feed_tokens FOR SELECT USING (user_id = app_actor());

-- Own feed state (never the hash).
CREATE OR REPLACE FUNCTION calendar_feed_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := public.app_actor(); r public.calendar_feed_tokens;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.calendar_feed_tokens WHERE user_id = v_actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('enabled', false); END IF;
  RETURN jsonb_build_object('enabled', true, 'created_at', r.created_at, 'rotated_at', r.rotated_at, 'last_read_at', r.last_read_at, 'read_count', r.read_count);
END $$;

-- Turn on or rotate: the API makes the secret and passes its SHA-256 hash; a new hash replaces the old one, so the old link stops at once.
CREATE OR REPLACE FUNCTION calendar_feed_set(p_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := public.app_actor(); v_was boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  v_was := EXISTS (SELECT 1 FROM public.calendar_feed_tokens WHERE user_id = v_actor);
  INSERT INTO public.calendar_feed_tokens (user_id, token_hash) VALUES (v_actor, p_hash)
  ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, rotated_at = now(), last_read_at = NULL, read_count = 0;
  RETURN jsonb_build_object('enabled', true, 'rotated', v_was);
END $$;

-- Revoke (turn off): the row is removed, the link stops at once.
CREATE OR REPLACE FUNCTION calendar_feed_revoke() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := public.app_actor(); v_n integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  DELETE FROM public.calendar_feed_tokens WHERE user_id = v_actor;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('enabled', false, 'removed', v_n);
END $$;

-- The feed read for a calendar app (no session): the events of the person the token hash belongs to, or NULL when no such feed exists (turned off or rotated).
CREATE OR REPLACE FUNCTION calendar_feed_events(p_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_user uuid; v_out jsonb;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  SELECT t.user_id INTO v_user FROM public.calendar_feed_tokens t
  JOIN public.users u ON u.id = t.user_id AND u.deleted_at IS NULL AND u.purged_at IS NULL AND u.status::text = 'active'
  WHERE t.token_hash = p_hash;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  UPDATE public.calendar_feed_tokens SET last_read_at = now(), read_count = read_count + 1 WHERE user_id = v_user;
  SELECT coalesce(jsonb_agg(e ORDER BY e->>'date', e->>'uid'), '[]'::jsonb) INTO v_out FROM (
    SELECT jsonb_build_object('uid', 'task-' || x.id::text, 'kind', 'planned', 'date', x.planned_date::text, 'site_code', s.site_code, 'title', td.name_en, 'code', td.code) AS e
    FROM public.task_instances x
    JOIN public.sites s ON s.id = x.site_id
    JOIN public.task_definitions td ON td.id = x.task_def_id
    WHERE x.ball_in_court_user_id = v_user AND x.planned_date IS NOT NULL AND x.state::text IN ('open', 'entry', 'in_review', 'in_approval')
    UNION ALL
    SELECT jsonb_build_object('uid', 'permit-' || r.id::text, 'kind', 'permit_expiry', 'date', r.data->>'valid_to', 'site_code', s.site_code, 'title', 'Permit expires', 'code', coalesce(r.data->>'permit_type', ''))
    FROM public.register_records r
    JOIN public.sites s ON s.id = r.site_id
    WHERE r.register_key = 'permits_hse' AND r.is_current AND r.created_by = v_user AND r.data->>'valid_to' ~ '^\d{4}-\d{2}-\d{2}$'
  ) q;
  RETURN v_out;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['calendar_feed_status()', 'calendar_feed_set(text)', 'calendar_feed_revoke()', 'calendar_feed_events(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  ALTER TABLE calendar_feed_tokens OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION calendar_feed_status(), calendar_feed_set(text), calendar_feed_revoke(), calendar_feed_events(text) TO pmis_app;
    GRANT SELECT ON calendar_feed_tokens TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON calendar_feed_tokens FROM pmis_app;
  END IF;
END $$;

-- Data reset coverage: calendar_feed_tokens is identity and access state of people, so KEEP (the stored function text is patched in place, idempotent).
DO $$
DECLARE def text; marker text := '''local_credentials'',';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('calendar_feed_tokens' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan() has no local_credentials row to patch'; END IF;
    EXECUTE replace(def, marker, marker || ' ''calendar_feed_tokens'',');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_reset_owner') THEN
    EXECUTE 'GRANT SELECT, UPDATE ON public.calendar_feed_tokens TO pmis_reset_owner';
  END IF;
END $$;
