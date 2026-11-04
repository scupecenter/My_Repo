-- 0069: the verified session context (P1-DB-03, ADR 0003 section 6).
--
-- Until now the API told the database who acts through plain session settings (app.user_id, app.region_ids, app.stepup, app.mfa, app.session_id,
-- app.auth_method, app.via ...). pmis_app can call set_config on every one of them, so SQL running as pmis_app (an injection, a bug) could name any
-- user, widen its regions to '*' or claim a step-up. From this migration the database trusts none of them.
--
-- 1. A secret context key (32 random bytes), kept in pmis_context_keys (only pmis_definer reads it) and in the environment of the API process
--    (PMIS_CONTEXT_KEY, hex). Several keys may exist: the API signs with one, every unexpired key verifies (rotation, see the RUNBOOK).
-- 2. app_begin(p_ctx jsonb, p_sig bytea) is the only door. The API calls it first in every transaction. p_sig = HMAC-SHA256(key, 'begin|' || txid_current() ||
--    '|' || canonical text of p_ctx), so a signature is valid only in the transaction it was made for. The function refuses a bad signature, an
--    issued_at older than 30 s (or more than 5 s in the future), and an unknown, suspended, disabled or deleted user. It then derives everything from data:
--    the region set (all regions for a System Admin, otherwise app_resolve_region_ids), the admin status, the delegation, the step-up state.
-- 3. STORAGE (decision (b) of the task, see ADR 0003 section 6): the derived context is written to the transaction-local settings app.ctx (the text) and
--    app.ctx_mac ('<key id>.<hex>' = HMAC(key, 'ctx|' || txid || '|' || app.ctx)). pmis_app can read and overwrite them, but cannot produce a MAC for a
--    different text, and a MAC made in another transaction does not verify. No TEMP table (ownership games, catalog churn per connection, parallel-unsafe
--    objects, a table that must be re-created on every pooled connection).
-- 4. Accessors read only the verified context: app_ctx_user, app_ctx_rset (region set), app_ctx_is_admin, app_ctx_stepup, app_ctx_get ... Without a valid
--    context the actor is NULL, the region set is empty (no row is visible) and step-up is false. The policies carry the region test as an expression over
--    (SELECT app_ctx_rset()) (rewritten below; a SQL function with a sub-SELECT is not inlined), so the planner evaluates the verification once per
--    statement (InitPlan), not once per row.
-- 5. The plain settings are honoured in ONE case: a session whose login role is a member of pmis_migrator (migrations, seeds, the superuser) and never a
--    member of pmis_app (app_ctx_legacy). Those sessions already own the tables. pmis_app can never reach this path (session_user cannot be changed).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Keys
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE pmis_context_keys (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         bytea NOT NULL UNIQUE CHECK (octet_length(key) = 32),
  fingerprint text GENERATED ALWAYS AS (left(encode(sha256(key), 'hex'), 12)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
COMMENT ON TABLE pmis_context_keys IS 'Secret keys that sign the session context (ADR 0003 section 6). Readable only by pmis_definer. Never printed or logged.';
ALTER TABLE pmis_context_keys OWNER TO pmis_definer;
ALTER TABLE pmis_context_keys ENABLE ROW LEVEL SECURITY;   -- no policy: nobody but the owner (and superusers) reads a row
REVOKE ALL ON pmis_context_keys FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON pmis_context_keys FROM pmis_app; END IF;
END $$;

-- Comparison of two 32-byte values whose timing says nothing about where they differ: both are hashed with a fresh random salt before the comparison,
-- so the (ordinary) equality works on values the caller cannot predict. Plain SQL: a byte loop in PL/pgSQL costs ten times more.
CREATE OR REPLACE FUNCTION ctx_eq(a bytea, b bytea) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(octet_length(a) = 32 AND octet_length(b) = 32
                  AND (SELECT sha256(x.r || a) = sha256(x.r || b) FROM (SELECT public.gen_random_bytes(16) AS r) x), false)
$$;

-- Installs a key (the installer and the test setup call it as the migration role or a superuser; pmis_app cannot). A key already present is kept as it
-- is. p_retire_after: every other key stops verifying after that interval (rotation), NULL leaves them alone.
CREATE OR REPLACE FUNCTION app_ctx_key_install(p_hex text, p_retire_after interval DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE kid integer;
BEGIN
  IF p_hex IS NULL OR p_hex !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'the context key must be 64 hexadecimal characters (32 bytes)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.pmis_context_keys (key) VALUES (decode(p_hex, 'hex')) ON CONFLICT (key) DO NOTHING;
  SELECT id INTO kid FROM public.pmis_context_keys WHERE key = decode(p_hex, 'hex');
  UPDATE public.pmis_context_keys SET expires_at = NULL WHERE id = kid AND expires_at IS NOT NULL;
  IF p_retire_after IS NOT NULL THEN
    UPDATE public.pmis_context_keys SET expires_at = now() + p_retire_after
    WHERE id <> kid AND (expires_at IS NULL OR expires_at > now() + p_retire_after);
  END IF;
  RETURN kid;
END $$;

-- Deletes the keys that stopped verifying a while ago.
CREATE OR REPLACE FUNCTION app_ctx_key_purge(p_older interval DEFAULT interval '7 days') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.pmis_context_keys WHERE expires_at IS NOT NULL AND expires_at < now() - p_older;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The context check and the accessors
-- ---------------------------------------------------------------------------------------------------------------------
-- True for the migration role, a superuser and the login roles that hold pmis_migrator (migrations, seeds, fixtures), and never for a login role that is
-- a (non-superuser) member of pmis_app. Decided on session_user (SET ROLE and SECURITY DEFINER do not change it).
CREATE OR REPLACE FUNCTION app_ctx_legacy() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_has_role(session_user, 'pmis_migrator', 'member')
     AND NOT EXISTS (SELECT 1 FROM pg_roles r, pg_roles me
                     WHERE r.rolname = 'pmis_app' AND me.rolname = session_user AND NOT me.rolsuper AND pg_has_role(session_user, r.oid, 'member'))
$$;

-- The verified context of this transaction, or NULL. No exception block (a subtransaction per call would be expensive) and no regular expression (a
-- pattern match costs more than the HMAC): the format of the MAC setting is checked with length and translate.
CREATE OR REPLACE FUNCTION app_ctx() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE raw text := current_setting('app.ctx', true); mac text := current_setting('app.ctx_mac', true); pz text;
        kid text; h text; k bytea; j jsonb; tx text; salt bytea;
BEGIN
  IF raw IS NULL OR raw = '' OR mac IS NULL THEN RETURN NULL; END IF;
  kid := split_part(mac, '.', 1);
  h := split_part(mac, '.', 2);
  IF length(kid) NOT BETWEEN 1 AND 9 OR translate(kid, '0123456789', '') <> '' OR length(h) <> 64 OR translate(h, '0123456789abcdef', '') <> '' THEN RETURN NULL; END IF;
  SELECT c.key INTO k FROM public.pmis_context_keys c WHERE c.id = kid::integer;
  IF k IS NULL THEN RETURN NULL; END IF;
  tx := txid_current()::text;
  -- both sides are hashed with a fresh salt before the comparison (the same idea as ctx_eq, inline: this runs on every accessor call)
  salt := public.gen_random_bytes(16);
  IF sha256(salt || public.hmac(convert_to('ctx|' || tx || '|' || raw, 'UTF8'), k, 'sha256')) <> sha256(salt || decode(h, 'hex')) THEN RETURN NULL; END IF;
  j := raw::jsonb;
  -- app_ctx_pause (definer code only): the actor is cleared for a few statements; the token is MAC-protected the same way.
  pz := current_setting('app.ctx_pause', true);
  IF pz IS NOT NULL AND pz <> '' THEN
    h := split_part(pz, '.', 2);
    IF split_part(pz, '.', 1) = kid AND length(h) = 64 AND translate(h, '0123456789abcdef', '') = ''
       AND sha256(salt || public.hmac(convert_to('pause|' || tx, 'UTF8'), k, 'sha256')) = sha256(salt || decode(h, 'hex')) THEN
      j := j || '{"u": null, "ad": false, "bu": null, "bh": null}'::jsonb;
    END IF;
  END IF;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION app_ctx_pause(p_on boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mac text := current_setting('app.ctx_mac', true); k bytea;
BEGIN
  IF NOT coalesce(p_on, false) THEN PERFORM set_config('app.ctx_pause', '', true); RETURN; END IF;
  IF public.app_ctx() IS NULL THEN RETURN; END IF;
  SELECT c.key INTO k FROM public.pmis_context_keys c WHERE c.id = split_part(mac, '.', 1)::integer;
  PERFORM set_config('app.ctx_pause', split_part(mac, '.', 1) || '.' || encode(public.hmac(convert_to('pause|' || txid_current()::text, 'UTF8'), k, 'sha256'), 'hex'), true);
END $$;

CREATE OR REPLACE FUNCTION app_ctx_user() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.app_ctx(); v text;
BEGIN
  IF c IS NOT NULL THEN RETURN nullif(c ->> 'u', '')::uuid; END IF;
  IF public.app_ctx_legacy() THEN
    v := current_setting('app.user_id', true);
    IF v ~ '^[0-9a-fA-F-]{36}$' THEN RETURN v::uuid; END IF;
  END IF;
  RETURN NULL;
END $$;

-- The region set: NULL = no valid context (nothing is visible), {} = a context with no region, {-1} = all regions ('*'), otherwise the region ids.
CREATE OR REPLACE FUNCTION app_ctx_rset() RETURNS integer[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.app_ctx(); r text;
BEGIN
  IF c IS NOT NULL THEN r := c ->> 'rg';
  ELSIF public.app_ctx_legacy() THEN r := current_setting('app.region_ids', true);
  ELSE RETURN NULL;
  END IF;
  IF r IS NULL THEN RETURN NULL; END IF;
  IF r = '*' THEN RETURN ARRAY[-1]; END IF;
  IF r ~ '^[0-9]+(,[0-9]+)*$' THEN RETURN string_to_array(r, ',')::integer[]; END IF;
  RETURN '{}'::integer[];
END $$;

CREATE OR REPLACE FUNCTION app_ctx_regions() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN s IS NULL THEN '' WHEN s @> ARRAY[-1] THEN '*' ELSE array_to_string(s, ',') END FROM (SELECT public.app_ctx_rset() AS s) x
$$;

CREATE OR REPLACE FUNCTION app_ctx_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT (c ->> 'ad')::boolean FROM (SELECT public.app_ctx() AS c) x), false)
$$;

CREATE OR REPLACE FUNCTION app_ctx_stepup() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT (c ->> 'su')::boolean FROM (SELECT public.app_ctx() AS c) x), false)
$$;

-- The delegation the actor works under (NULL: none) and the admin who delegated it.
CREATE OR REPLACE FUNCTION app_ctx_on_behalf() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT nullif((SELECT c ->> 'bh' FROM (SELECT public.app_ctx() AS c) x), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_ctx_on_behalf_user() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT nullif((SELECT c ->> 'bu' FROM (SELECT public.app_ctx() AS c) x), '')::uuid
$$;

-- app.via: the signed value, refined by the screen's hint (button, drag, bulk) when the signed value is the generic 'manual'. Audit labelling only.
CREATE OR REPLACE FUNCTION app_ctx_via() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.app_ctx(); v text; h text := nullif(current_setting('app.via', true), '');
BEGIN
  IF c IS NOT NULL THEN
    v := nullif(c ->> 'via', '');
    IF v = 'manual' AND h IN ('button', 'drag', 'bulk') THEN RETURN h; END IF;
    RETURN v;
  END IF;
  IF public.app_ctx_legacy() THEN RETURN h; END IF;
  RETURN NULL;
END $$;

-- The informational values of the context (audit rows): from the signed context only. user_id and region_ids are decisions, they have accessors above.
CREATE OR REPLACE FUNCTION app_ctx_get(p_name text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.app_ctx();
BEGIN
  IF p_name = 'via' THEN RETURN public.app_ctx_via(); END IF;
  IF c IS NOT NULL THEN
    RETURN nullif(CASE p_name
      WHEN 'ip' THEN c ->> 'ip' WHEN 'user_agent' THEN c ->> 'ua' WHEN 'request_id' THEN c ->> 'rid' WHEN 'session_id' THEN c ->> 'sid'
      WHEN 'auth_method' THEN c ->> 'am' WHEN 'mfa' THEN c ->> 'mfa' WHEN 'stepup' THEN coalesce(c ->> 'su', 'false')
      WHEN 'device' THEN c ->> 'dev' WHEN 'job_name' THEN c ->> 'job' WHEN 'on_behalf' THEN c ->> 'bh' END, '');
  END IF;
  IF public.app_ctx_legacy() THEN RETURN nullif(current_setting('app.' || p_name, true), ''); END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. app_begin
-- ---------------------------------------------------------------------------------------------------------------------
-- The text that is signed: the fixed fields in a fixed order, each as <length in bytes>:<value>, a missing value as '-'. The API builds the same text.
CREATE OR REPLACE FUNCTION app_ctx_canon(p_ctx jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT string_agg(CASE WHEN p_ctx -> t.k IS NULL OR jsonb_typeof(p_ctx -> t.k) = 'null' THEN '-'
                         ELSE octet_length(convert_to(p_ctx ->> t.k, 'UTF8'))::text || ':' || (p_ctx ->> t.k) END, '|' ORDER BY t.ord)
  FROM unnest(ARRAY['v', 'user_id', 'on_behalf', 'session_id', 'auth_method', 'mfa', 'stepup_until', 'via', 'request_id', 'ip', 'user_agent', 'device',
                    'job_name', 'issued_at']) WITH ORDINALITY AS t(k, ord)
$$;

CREATE OR REPLACE FUNCTION app_begin(p_ctx jsonb, p_sig bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tx text := txid_current()::text; canon text; msg bytea; kid integer; kk record; hit boolean;
  issued timestamptz; stepup_until timestamptz; uid uuid; urow record; admin boolean := false; regions text := ''; bh uuid; bu uuid;
  sid text; am text; via text; ip text; ua text; dev text; job text; rid text; mfa jsonb; derived jsonb; mac text; k bytea;
BEGIN
  IF p_ctx IS NULL OR jsonb_typeof(p_ctx) <> 'object' OR p_sig IS NULL THEN
    RAISE EXCEPTION 'session context refused' USING ERRCODE = '28000';
  END IF;
  -- only the known fields, only scalars: nothing unsigned can ride along
  IF EXISTS (SELECT 1 FROM jsonb_each(p_ctx) e WHERE e.key NOT IN ('v', 'user_id', 'on_behalf', 'session_id', 'auth_method', 'mfa', 'stepup_until', 'via',
       'request_id', 'ip', 'user_agent', 'device', 'job_name', 'issued_at') OR jsonb_typeof(e.value) NOT IN ('string', 'boolean', 'null')) OR p_ctx ->> 'v' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'session context refused: malformed' USING ERRCODE = '28000';
  END IF;
  canon := public.app_ctx_canon(p_ctx);
  msg := convert_to('begin|' || tx || '|' || canon, 'UTF8');
  hit := false;
  FOR kk IN SELECT c.id, c.key FROM public.pmis_context_keys c WHERE c.expires_at IS NULL OR c.expires_at > now() ORDER BY c.id LOOP
    IF public.ctx_eq(public.hmac(msg, kk.key, 'sha256'), p_sig) THEN hit := true; kid := kk.id; k := kk.key; END IF;
  END LOOP;
  IF NOT hit THEN RAISE EXCEPTION 'session context refused: bad signature' USING ERRCODE = '28000'; END IF;

  BEGIN issued := (p_ctx ->> 'issued_at')::timestamptz; EXCEPTION WHEN others THEN issued := NULL; END;
  IF issued IS NULL OR issued < clock_timestamp() - interval '30 seconds' OR issued > clock_timestamp() + interval '5 seconds' THEN
    RAISE EXCEPTION 'session context refused: expired' USING ERRCODE = '28000';
  END IF;

  -- who: from the signed user id, checked against the data
  IF nullif(p_ctx ->> 'user_id', '') IS NOT NULL THEN
    IF (p_ctx ->> 'user_id') !~ '^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'session context refused: unknown user' USING ERRCODE = '28000'; END IF;
    uid := (p_ctx ->> 'user_id')::uuid;
    SELECT u.id, u.status::text AS status, u.deleted_at INTO urow FROM public.users u WHERE u.id = uid;
    IF NOT FOUND OR urow.deleted_at IS NOT NULL OR urow.status NOT IN ('active', 'pending_assignment') THEN
      RAISE EXCEPTION 'session context refused: unknown or inactive user' USING ERRCODE = '28000';
    END IF;
    admin := coalesce(public.app_user_is_system_admin(uid), false);
    regions := CASE WHEN admin THEN '*' ELSE coalesce(public.app_resolve_region_ids(uid), '') END;
    IF nullif(p_ctx ->> 'on_behalf', '') IS NOT NULL THEN
      IF (p_ctx ->> 'on_behalf') !~ '^[0-9a-fA-F-]{36}$' OR NOT ((p_ctx ->> 'on_behalf')::uuid IN (SELECT public.app_user_delegations(uid))) THEN
        RAISE EXCEPTION 'session context refused: no such delegation' USING ERRCODE = '28000';
      END IF;
      bh := (p_ctx ->> 'on_behalf')::uuid;
      SELECT d.from_user_id INTO bu FROM public.delegations d WHERE d.id = bh;
    END IF;
  END IF;

  BEGIN stepup_until := (p_ctx ->> 'stepup_until')::timestamptz; EXCEPTION WHEN others THEN stepup_until := NULL; END;
  sid := CASE WHEN (p_ctx ->> 'session_id') ~ '^[0-9a-fA-F-]{36}$' THEN lower(p_ctx ->> 'session_id') END;
  am := CASE WHEN (p_ctx ->> 'auth_method') IN ('local', 'oidc', 'break_glass') THEN p_ctx ->> 'auth_method' END;
  via := CASE WHEN (p_ctx ->> 'via') IN ('manual', 'api', 'job', 'bulk', 'button', 'drag') THEN p_ctx ->> 'via' END;
  BEGIN ip := host((p_ctx ->> 'ip')::inet); EXCEPTION WHEN others THEN ip := NULL; END;
  ua := left(p_ctx ->> 'user_agent', 400);
  dev := left(p_ctx ->> 'device', 300);
  job := left(p_ctx ->> 'job_name', 80);
  rid := left(p_ctx ->> 'request_id', 64);
  mfa := CASE WHEN jsonb_typeof(p_ctx -> 'mfa') = 'boolean' THEN p_ctx -> 'mfa' ELSE 'null'::jsonb END;

  derived := jsonb_build_object('u', uid, 'ad', admin, 'rg', regions, 'bh', bh, 'bu', bu, 'sid', sid, 'am', am, 'mfa', mfa,
    'su', coalesce(stepup_until > clock_timestamp(), false), 'via', via, 'rid', rid, 'ip', ip, 'ua', ua, 'dev', dev, 'job', job);
  mac := kid::text || '.' || encode(public.hmac(convert_to('ctx|' || tx || '|' || derived::text, 'UTF8'), k, 'sha256'), 'hex');
  PERFORM set_config('app.ctx', derived::text, true);
  PERFORM set_config('app.ctx_mac', mac, true);
  PERFORM set_config('app.ctx_pause', '', true);
  RETURN jsonb_build_object('user_id', uid, 'admin', admin, 'regions', regions);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Ownership and rights of the new functions (PUBLIC revoked; the roles that run policies, triggers and the definer code may call the accessors)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN ('ctx_eq', 'app_ctx_key_install', 'app_ctx_key_purge', 'app_ctx_legacy', 'app_ctx', 'app_ctx_pause',
             'app_ctx_user', 'app_ctx_rset', 'app_ctx_regions', 'app_ctx_is_admin', 'app_ctx_stepup', 'app_ctx_on_behalf', 'app_ctx_on_behalf_user',
             'app_ctx_via', 'app_ctx_get', 'app_ctx_canon', 'app_begin')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer, pmis_identity_owner, pmis_migrator', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') AND f.proname NOT IN ('app_ctx_key_install', 'app_ctx_key_purge', 'app_ctx_pause', 'app_ctx_canon', 'ctx_eq') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig);
    END IF;
  END LOOP;
  -- app_begin is for the application role only (and the definer roles, which have no need of it): PUBLIC has no right to it.
  GRANT SELECT ON users, user_role_assignments, user_role_assignment_regions, delegations, group_members, groups TO pmis_definer;
  GRANT SELECT ON pmis_context_keys TO pmis_definer;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The accessors the rest of the database uses now read the verified context only
-- ---------------------------------------------------------------------------------------------------------------------
-- Region predicates (0003). The array operators keep the old meaning: a row with no region passes only for all regions (-1). (Policies do not call these
-- functions any more: see the rewrite below.)
CREATE OR REPLACE FUNCTION app_region_check(r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT public.app_ctx_rset()) && ARRAY[r, -1], false)
$$;

CREATE OR REPLACE FUNCTION app_region_read(g boolean, r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(CASE WHEN coalesce(g, false) THEN cardinality((SELECT public.app_ctx_rset())) > 0 ELSE (SELECT public.app_ctx_rset()) && ARRAY[r, -1] END, false)
$$;

CREATE OR REPLACE FUNCTION app_region_write(g boolean, r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(CASE WHEN coalesce(g, false) THEN (SELECT public.app_ctx_rset()) @> ARRAY[-1] ELSE (SELECT public.app_ctx_rset()) && ARRAY[r, -1] END, false)
$$;

CREATE OR REPLACE FUNCTION app_regions_check(a integer[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(CASE WHEN (SELECT public.app_ctx_rset()) @> ARRAY[-1] THEN true
                       WHEN a IS NULL OR cardinality(a) = 0 THEN false
                       ELSE a <@ (SELECT public.app_ctx_rset()) END, false)
$$;

CREATE OR REPLACE FUNCTION app_is_full_access() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT public.app_ctx_rset()) @> ARRAY[-1], false) $$;

CREATE OR REPLACE FUNCTION app_has_session() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(cardinality((SELECT public.app_ctx_rset())) > 0, false) $$;

-- The planner does NOT inline a SQL function whose body holds a sub-SELECT, so a policy that calls app_region_check(region_id) would verify the context
-- once per row. The policies are therefore rewritten to carry the expression itself: (SELECT app_ctx_rset()) has no outer reference, so the planner makes
-- it an InitPlan and the context is verified once per statement. The same goes for app_actor() in a policy (user_id = app_actor()). The functions above stay for code that calls them directly (same answer, per call).
-- A policy of a shape this does not know is left as it is (it still works, per row). A policy written by a later migration should use the same form.
CREATE OR REPLACE FUNCTION ctx_policy_expr(p_expr text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(p_expr,
    'app_region_check\(([A-Za-z_][A-Za-z_0-9.]*)\)',
    'coalesce(((SELECT public.app_ctx_rset()) && ARRAY[\1, -1]), false)', 'g'),
    'app_region_read\((true|false|[A-Za-z_][A-Za-z_0-9.]*), ([A-Za-z_][A-Za-z_0-9.]*)\)',
    'coalesce(CASE WHEN coalesce(\1, false) THEN cardinality((SELECT public.app_ctx_rset())) > 0 ELSE (SELECT public.app_ctx_rset()) && ARRAY[\2, -1] END, false)', 'g'),
    'app_region_write\((true|false|[A-Za-z_][A-Za-z_0-9.]*), ([A-Za-z_][A-Za-z_0-9.]*)\)',
    'coalesce(CASE WHEN coalesce(\1, false) THEN (SELECT public.app_ctx_rset()) @> ARRAY[-1] ELSE (SELECT public.app_ctx_rset()) && ARRAY[\2, -1] END, false)', 'g'),
    'app_regions_check\(([A-Za-z_][A-Za-z_0-9.]*)\)',
    'coalesce(CASE WHEN (SELECT public.app_ctx_rset()) @> ARRAY[-1] THEN true WHEN \1 IS NULL OR cardinality(\1) = 0 THEN false ELSE \1 <@ (SELECT public.app_ctx_rset()) END, false)', 'g'),
    'app_has_session\(\)', 'coalesce(cardinality((SELECT public.app_ctx_rset())) > 0, false)', 'g'),
    'app_is_full_access\(\)', 'coalesce((SELECT public.app_ctx_rset()) @> ARRAY[-1], false)', 'g'),
    '(?<!public\.)app_actor\(\)', '(SELECT public.app_actor())', 'g')
$$;

DO $$
DECLARE pol record; nq text; nw text; n int := 0; left_over int := 0;
BEGIN
  FOR pol IN
    SELECT p.polname, c.relname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'app_(region_check|region_read|region_write|regions_check|has_session|is_full_access|actor)\('
        OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'app_(region_check|region_read|region_write|regions_check|has_session|is_full_access|actor)\(')
  LOOP
    nq := public.ctx_policy_expr(pol.q);
    nw := public.ctx_policy_expr(pol.w);
    IF nq IS NOT DISTINCT FROM pol.q AND nw IS NOT DISTINCT FROM pol.w THEN CONTINUE; END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I%s%s', pol.polname, pol.relname,
      CASE WHEN nq IS NOT NULL THEN ' USING (' || nq || ')' ELSE '' END,
      CASE WHEN nw IS NOT NULL THEN ' WITH CHECK (' || nw || ')' ELSE '' END);
    n := n + 1;
    IF nq ~ 'app_(region_check|region_read|region_write|regions_check)\(' OR nw ~ 'app_(region_check|region_read|region_write|regions_check)\(' THEN left_over := left_over + 1; END IF;
  END LOOP;
  RAISE NOTICE '0069: % policies now carry the region check as an InitPlan expression (% with a shape left as a function call)', n, left_over;
END $$;

DROP FUNCTION ctx_policy_expr(text);

-- The actor (0004): the verified user, if still active.
CREATE OR REPLACE FUNCTION app_actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id FROM public.users u WHERE u.id = (SELECT public.app_ctx_user()) AND u.status = 'active'
$$;

-- Audit context helper (0045): the signed values only.
CREATE OR REPLACE FUNCTION log_ctx(p_name text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT nullif(public.app_ctx_get(p_name), '') $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Functions that read app.user_id / app.via directly (latest definitions, only the source of the value changes)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_add_task_to_open_sites(p_task uuid, p_sites uuid[], p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE td public.task_definitions%ROWTYPE; lv integer; n integer; rf int[];
BEGIN
  IF NOT public.app_actor_is_admin('task_definitions', 'edit') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering task_definitions.edit required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT * INTO td FROM public.task_definitions WHERE id = p_task AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'task definition not found or inactive'; END IF;
  SELECT coalesce(td.approval_levels, s.approval_levels) INTO lv FROM public.stage_definitions s WHERE s.id = td.stage_id;
  -- ceiling: only sites in the actor's delegated regions (NULL filter = unrestricted); an explicit list outside them is refused
  rf := public.app_actor_region_filter('task_definitions', 'edit');
  IF rf IS NOT NULL AND p_sites IS NOT NULL AND EXISTS (SELECT 1 FROM public.sites x WHERE x.id = ANY (p_sites) AND NOT (x.region_id = ANY (rf))) THEN
    RAISE EXCEPTION 'some of these sites are outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH ins AS (
    INSERT INTO public.task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
    SELECT s.id, s.region_id, td.id, 'locked', lv,
           public.sla_rule_for(td.id, s.delivery_scenario, s.region_id, current_date), now()
    FROM public.sites s
    WHERE s.is_active AND s.overall_status IN ('not_started', 'in_progress', 'on_hold')
      AND s.workflow_version_id = td.workflow_id
      AND (rf IS NULL OR s.region_id = ANY (rf))
      AND (p_sites IS NULL OR s.id = ANY (p_sites))
      AND NOT EXISTS (SELECT 1 FROM public.task_instances t WHERE t.site_id = s.id AND t.task_def_id = td.id)
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;

  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
  VALUES ('add_task_to_open_sites', 'task_definition', td.code, p_reason,
          jsonb_build_object('sites_added', n, 'restricted_to', to_jsonb(p_sites)), true,
          public.app_ctx_user());
  RETURN n;
END $function$;

CREATE OR REPLACE FUNCTION public.admin_repoint_sla(p_old uuid, p_new uuid, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE n integer; nt uuid;
BEGIN
  IF NOT public.app_actor_is_admin('sla_rules', 'edit') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering sla_rules.edit required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  -- ceiling: every affected (open) task must lie in the actor's delegated regions
  IF EXISTS (SELECT 1 FROM public.task_instances t WHERE t.sla_rule_id = p_old AND t.state <> 'approved'
             AND public.app_actor_region_filter('sla_rules', 'edit') IS NOT NULL
             AND NOT (t.region_id = ANY (public.app_actor_region_filter('sla_rules', 'edit')))) THEN
    RAISE EXCEPTION 'the re-point would affect tasks outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT task_def_id INTO nt FROM public.sla_rules WHERE id = p_new;
  IF nt IS NULL OR nt IS DISTINCT FROM (SELECT task_def_id FROM public.sla_rules WHERE id = p_old) THEN
    RAISE EXCEPTION 'both rules must exist and belong to the same task definition';
  END IF;
  WITH u AS (
    UPDATE public.task_instances SET sla_rule_id = p_new, updated_at = now()
    WHERE sla_rule_id = p_old AND state <> 'approved' RETURNING 1)
  SELECT count(*) INTO n FROM u;
  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, before, after, is_admin_override, actor_id)
  VALUES ('sla_repoint', 'sla_rule', p_new::text, p_reason, jsonb_build_object('rule', p_old), jsonb_build_object('rule', p_new, 'tasks', n), true,
          public.app_ctx_user());
  RETURN n;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_local_own_hash(p_user uuid)
 RETURNS TABLE(password_hash text, locked_until timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own credentials' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT c.password_hash, c.locked_until FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_local_set_own_password(p_user uuid, p_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own password' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.local_credentials SET password_hash = p_hash, must_change = false, set_at = now(), set_by = p_user,
    failed_count = 0, locked_until = NULL WHERE user_id = p_user AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'local sign-in is not enabled for this user'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, actor_id) VALUES ('password_changed', 'user', p_user::text, p_user);
END $function$;

CREATE OR REPLACE FUNCTION public.auth_pending_consume(p_token_hash text, p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own pending sign-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.auth_pending SET used_at = now()
    WHERE token_hash = p_token_hash AND user_id = p_user AND used_at IS NULL AND expires_at > now();
  RETURN FOUND;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_pending_create(p_user uuid, p_token_hash text, p_kind text, p_ip inet)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE until_at timestamptz := now() + interval '5 minutes';
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'pending sign-in must be created for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_kind NOT IN ('two_factor', 'enrol') THEN
    RAISE EXCEPTION 'invalid pending token' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass
                 AND u.status IN ('active', 'pending_assignment')) THEN
    RAISE EXCEPTION 'account may not sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                 AND (c.locked_until IS NULL OR c.locked_until <= now()) AND c.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'two_factor' AND NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'two-factor is not set up for this user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'enrol' AND NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NULL) THEN
    RAISE EXCEPTION 'two-factor is not waiting for enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.auth_pending WHERE user_id = p_user AND expires_at < now() - interval '1 day';
  INSERT INTO public.auth_pending (token_hash, user_id, kind, expires_at, ip) VALUES (p_token_hash, p_user, p_kind, until_at, p_ip);
  RETURN until_at;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_self_guard(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user IS NULL OR coalesce(public.app_ctx_user()::text, '') <> p_user::text OR public.app_actor() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'only your own two-factor, signed in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass) THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled) THEN
    RAISE EXCEPTION 'two-factor needs a local account with sign-in on';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_session_create(p_user uuid, p_token_hash text, p_method "AuthMethod", p_csrf text, p_ip inet, p_user_agent text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE sid uuid; two boolean := false;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'session must be created for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_csrf IS NULL OR length(p_csrf) < 32 THEN
    RAISE EXCEPTION 'invalid session token' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass
                 AND u.status IN ('active', 'pending_assignment')) THEN
    RAISE EXCEPTION 'account may not sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_method = 'local' THEN
    two := EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required);
    IF NOT two THEN
      IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                     AND (c.locked_until IS NULL OR c.locked_until <= now())
                     AND c.last_success_at > now() - interval '1 minute') THEN
        RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSE
      -- Two-factor is on: password (within 6 minutes: the pending sign-in lasts 5), then a code success after it (within 1 minute),
      -- then a pending sign-in consumed within the minute. Enrolment counts: confirming the first code is the code success.
      IF NOT EXISTS (SELECT 1 FROM public.local_credentials c JOIN public.user_totp t ON t.user_id = c.user_id
                     WHERE c.user_id = p_user AND c.enabled AND (c.locked_until IS NULL OR c.locked_until <= now())
                       AND c.last_success_at > now() - interval '6 minutes'
                       AND t.required AND t.secret_enc IS NOT NULL
                       AND t.last_success_at > now() - interval '1 minute' AND t.last_success_at >= c.last_success_at)
         OR NOT EXISTS (SELECT 1 FROM public.auth_pending p WHERE p.user_id = p_user AND p.used_at > now() - interval '1 minute') THEN
        RAISE EXCEPTION 'no recent successful sign-in with a code' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  ELSE
    -- M365 and break-glass sign-in are not built yet; they extend this function with their own proof.
    RAISE EXCEPTION 'sign-in method % not available', p_method USING ERRCODE = 'feature_not_supported';
  END IF;
  INSERT INTO public.user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at, ip, user_agent, two_factor)
  VALUES (p_token_hash, p_user, p_method, p_csrf, now() + interval '12 hours', p_ip, left(p_user_agent, 400), two)
  RETURNING id INTO sid;
  RETURN sid;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_totp_begin_enrol(p_user uuid, p_secret_enc text, p_owner text, p_code_hash text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r text;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_secret_enc IS NULL OR p_secret_enc !~ '^v1:[A-Za-z0-9+/=_-]{20,}$' THEN
    RAISE EXCEPTION 'invalid secret envelope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner IS NULL OR p_owner !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid pending sign-in' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM public.idm_need_enrol_code_hash(p_code_hash);
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NULL) THEN
    RAISE EXCEPTION 'two-factor is not waiting for enrolment, or another sign-in is enrolling' USING ERRCODE = 'insufficient_privilege';
  END IF;
  r := public.auth_totp_check_enrol_code(p_user, p_code_hash);
  IF r <> 'ok' THEN RETURN r; END IF;
  -- The first sign-in that starts an enrolment keeps it for 10 minutes: another sign-in (even with the right code)
  -- cannot replace the secret shown in that QR code. The same sign-in may restart it.
  UPDATE public.user_totp SET pending_secret_enc = p_secret_enc, pending_owner = p_owner, pending_started_at = now()
  WHERE user_id = p_user AND required AND secret_enc IS NULL
    AND (pending_owner IS NULL OR pending_owner = p_owner OR pending_started_at < now() - interval '10 minutes');
  IF NOT FOUND THEN RAISE EXCEPTION 'two-factor is not waiting for enrolment, or another sign-in is enrolling' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN 'ok';
END $function$;

CREATE OR REPLACE FUNCTION public.auth_totp_confirm_enrol(p_user uuid, p_step bigint, p_hashes text[], p_owner text, p_code_hash text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r text;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own enrolment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_step IS NULL OR p_hashes IS NULL OR cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION 'a step and 10 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM public.idm_need_enrol_code_hash(p_code_hash);
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  r := public.auth_totp_check_enrol_code(p_user, p_code_hash);
  IF r <> 'ok' THEN RETURN r; END IF;
  UPDATE public.user_totp SET secret_enc = pending_secret_enc, pending_secret_enc = NULL, pending_owner = NULL, pending_started_at = NULL,
    enrol_code_hash = NULL, enrol_code_expires_at = NULL,
    enrolled_at = now(), last_step = p_step, failed_count = 0, last_success_at = now()
    WHERE user_id = p_user AND required AND secret_enc IS NULL AND pending_secret_enc IS NOT NULL AND pending_owner = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to confirm' USING ERRCODE = 'insufficient_privilege'; END IF;
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  INSERT INTO public.user_recovery_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) h;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_enrolled', 'user', p_user::text, jsonb_build_object('two_factor', 'pending_enrolment', 'enrol_code', 'active'),
          jsonb_build_object('two_factor', 'on', 'recovery_codes_remaining', 10, 'enrol_code', 'used'), p_user);
  RETURN 'ok';
END $function$;

CREATE OR REPLACE FUNCTION public.auth_totp_regenerate_recovery(p_user uuid, p_hashes text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE before_n int;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own recovery codes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_hashes IS NULL OR cardinality(p_hashes) <> 10 THEN
    RAISE EXCEPTION '10 recovery code hashes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL
                 AND t.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'a valid code is required first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  before_n := public.auth_totp_remaining(p_user);
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  INSERT INTO public.user_recovery_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) h;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_recovery_regenerated', 'user', p_user::text, jsonb_build_object('recovery_codes_remaining', before_n),
          jsonb_build_object('recovery_codes_remaining', 10), p_user);
END $function$;

CREATE OR REPLACE FUNCTION public.auth_totp_result(p_user uuid, p_success boolean, p_step bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own two-factor code' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required) THEN RETURN 'bad'; END IF;
  IF NOT p_success THEN
    PERFORM public.auth_totp_note_failure(p_user);
    RETURN 'bad';
  END IF;
  IF p_step IS NULL THEN RAISE EXCEPTION 'a time step is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
  UPDATE public.user_totp SET last_step = p_step, failed_count = 0, last_success_at = now()
    WHERE user_id = p_user AND secret_enc IS NOT NULL AND (last_step IS NULL OR last_step < p_step);
  IF FOUND THEN RETURN 'ok'; END IF;
  PERFORM public.auth_totp_note_failure(p_user);
  RETURN 'replay';
END $function$;

CREATE OR REPLACE FUNCTION public.auth_totp_secret(p_user uuid)
 RETURNS TABLE(secret_enc text, pending_secret_enc text, last_step bigint, locked_until timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own two-factor secret' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT t.secret_enc, t.pending_secret_enc, t.last_step, c.locked_until
    FROM public.user_totp t JOIN public.local_credentials c ON c.user_id = t.user_id
    WHERE t.user_id = p_user AND t.required AND c.enabled;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_totp_use_recovery(p_user uuid, p_hash text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE left_n int;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'only your own recovery code' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.locked_until > now()) THEN RETURN 'locked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required AND t.secret_enc IS NOT NULL) THEN RETURN 'bad'; END IF;
  UPDATE public.user_recovery_codes SET used_at = now() WHERE user_id = p_user AND code_hash = p_hash AND used_at IS NULL;
  IF NOT FOUND THEN
    PERFORM public.auth_totp_note_failure(p_user);
    RETURN 'bad';
  END IF;
  UPDATE public.user_totp SET failed_count = 0, last_success_at = now() WHERE user_id = p_user;
  left_n := public.auth_totp_remaining(p_user);
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('two_factor_recovery_used', 'user', p_user::text, jsonb_build_object('recovery_codes_remaining', left_n + 1),
          jsonb_build_object('recovery_codes_remaining', left_n), p_user);
  RETURN 'ok';
END $function$;

CREATE OR REPLACE FUNCTION public.idm_cancel_email_change(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE a uuid := public.app_actor(); r public.email_change_requests%ROWTYPE;
BEGIN
  IF a IS NULL OR coalesce(public.app_ctx_user()::text, '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.email_change_requests WHERE id = p_id AND user_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'email change request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'this email change is not pending'; END IF;
  UPDATE public.email_change_requests SET status = 'cancelled', decided_at = now(), decided_by = a WHERE id = p_id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('email_change_cancelled', 'user', a::text, jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'pending'),
          jsonb_build_object('requested_email', r.new_email, 'request_id', r.id, 'status', 'cancelled'), a);
END $function$;

CREATE OR REPLACE FUNCTION public.idm_request_email_change(p_new_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE a uuid := public.app_actor(); e text := lower(btrim(coalesce(p_new_email, ''))); u public.users%ROWTYPE; rid uuid; d uuid;
BEGIN
  IF a IS NULL OR coalesce(public.app_ctx_user()::text, '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO u FROM public.users WHERE id = a AND deleted_at IS NULL AND NOT is_break_glass FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = a AND c.enabled AND c.last_success_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'email change: confirm your password first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(e) > 254 OR e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN RAISE EXCEPTION 'email: not a valid address'; END IF;
  IF e = u.email THEN RAISE EXCEPTION 'email: this is already your email'; END IF;
  IF EXISTS (SELECT 1 FROM public.email_change_requests r WHERE r.user_id = a AND r.status = 'pending') THEN
    RAISE EXCEPTION 'an email change is already pending: cancel it first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users o WHERE o.email = e)
     OR EXISTS (SELECT 1 FROM public.email_change_requests r WHERE r.new_email = e AND r.status = 'pending') THEN
    RAISE EXCEPTION 'email: already used by another account';
  END IF;
  INSERT INTO public.email_change_requests (user_id, old_email, new_email) VALUES (a, u.email, e) RETURNING id INTO rid;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, actor_id)
  VALUES ('email_change_requested', 'user', a::text, jsonb_build_object('email', u.email),
          jsonb_build_object('requested_email', e, 'request_id', rid, 'status', 'pending'), a);
  FOR d IN SELECT x FROM public.idm_email_change_deciders() x WHERE x <> a LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (d, 'in_app', 'email_change_requested', 'Email change to approve',
            u.display_name || coalesce(' (' || btrim(u.employee_id) || ')', '') || ' asks to change their email to ' || e || '.',
            '/admin/users?email_changes=pending');
  END LOOP;
  RETURN rid;
END $function$;

CREATE OR REPLACE FUNCTION public.idm_self_actor()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL OR coalesce(public.app_ctx_user()::text, '') <> a::text THEN
    RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN a;
END $function$;

CREATE OR REPLACE FUNCTION public.idm_set_employee_id(p_user uuid, p_emp text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'you can only set your own employee id' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_emp !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'employee id is 4 digits'; END IF;
  UPDATE public.users SET employee_id = p_emp, updated_at = now() WHERE id = p_user AND employee_id IS NULL AND status <> 'disabled';
  IF NOT FOUND THEN RAISE EXCEPTION 'employee id already set or user disabled'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id) VALUES ('employee_id_set', 'user', p_user::text, jsonb_build_object('employee_id', p_emp), p_user);
END $function$;

CREATE OR REPLACE FUNCTION public.wf_audit(p_action text, p_task uuid, p_before jsonb, p_after jsonb, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t public.task_instances%ROWTYPE; v text := nullif(public.app_ctx_via(), ''); a jsonb := p_after;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF v IN ('button', 'drag', 'bulk') AND p_action <> 'task_unlock' THEN a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', v); END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'task', p_task::text, t.site_id, t.region_id, p_before, a, p_reason, public.app_actor());
  IF p_action IN ('task_start', 'task_submit', 'task_review', 'task_approve', 'task_reject', 'task_unlock') THEN
    PERFORM public.x_notify_watchers(t.site_id, NULL, public.app_actor(), 'A followed site changed', public.wf_label(p_task) || ': ' || substr(p_action, 6), '/tasks/' || p_task::text, p_task, t.region_id, 'sites');
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.reg_audit(p_action text, p_record uuid, p_before jsonb, p_after jsonb, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.register_records%ROWTYPE; v text := nullif(public.app_ctx_via(), ''); a jsonb := p_after; br uuid := public.imp_current_row(); bid uuid;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF br IS NOT NULL THEN
    SELECT x.batch_id INTO bid FROM public.import_batch_rows x WHERE x.id = br;
    a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', 'batch', 'batch_id', bid, 'batch_row_id', br);
  ELSIF v IN ('button', 'drag', 'bulk') THEN
    a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', v);
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'register_record', p_record::text, r.site_id, r.region_id, p_before, a, p_reason, public.app_actor());
  IF p_action IN ('register_record_create', 'register_record_submit', 'register_record_review', 'register_record_approve', 'register_record_reject',
                  'register_record_void', 'register_record_new_version') THEN
    PERFORM public.x_notify_watchers(r.site_id, r.entity_id, public.app_actor(), 'A followed record changed', public.reg_label(p_record) || ': ' || substr(p_action, 17),
      '/registers/' || r.register_key || '/records/' || p_record::text, NULL, r.region_id, public.reg_module(r.register_key));
  END IF;
END $function$;

-- The legacy HLC migration paused the actor by clearing app.user_id; the verified context is paused instead (the token is MAC-protected, definer code only).
CREATE OR REPLACE FUNCTION public.hlc_legacy_to_drafts(p_dry_run boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); regs int[]; h record; items jsonb := '[]'::jsonb; outcome text; dup uuid; dup_rec uuid; ent uuid; rid uuid; pd date; pno text;
  data jsonb; n_create int := 0; n_link int := 0; n_done int := 0; lv int; uid text; dropped boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_admin('procurement', 'administer') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy HLC migration needs a System Admin or a delegation of administer on Procurement.'));
  END IF;
  IF NOT coalesce(p_dry_run, true) THEN PERFORM public.calc_require_reason(p_reason); END IF;
  regs := public.app_actor_region_filter('procurement', 'administer');
  SELECT d.approval_levels INTO lv FROM public.register_definitions d WHERE d.register_key = 'procurement';
  FOR h IN
    SELECT DISTINCT ON (x.entity_id) x.id, x.entity_id, x.site_id, x.region_id, s.site_code,
      nullif(btrim(coalesce(x.data ->> 'request_no', '')), '') AS request_no, x.data ->> 'request_date' AS request_date
    FROM public.register_records x JOIN public.sites s ON s.id = x.site_id
    WHERE x.register_key = 'hlc' AND x.state <> 'voided' AND (x.data ? 'request_no' OR x.data ? 'request_date')
      AND (regs IS NULL OR x.region_id = ANY (regs)) AND public.app_region_read(false, x.region_id)
    ORDER BY x.entity_id, x.is_current DESC, x.version_no DESC
  LOOP
    dup := NULL; dup_rec := NULL; rid := NULL; dropped := false;
    BEGIN pd := h.request_date::date; EXCEPTION WHEN others THEN pd := NULL; END;
    IF pd IS NOT NULL AND (pd < DATE '2020-01-01' OR pd > public.cal_today()) THEN pd := NULL; END IF;
    dropped := h.request_date IS NOT NULL AND pd IS NULL;
    pno := left(h.request_no, 2000);
    SELECT m.procurement_record_id INTO rid FROM public.hlc_legacy_migrations m WHERE m.hlc_entity_id = h.entity_id;
    IF rid IS NOT NULL THEN
      outcome := 'already_migrated'; n_done := n_done + 1;
    ELSE
      IF pno IS NOT NULL THEN
        SELECT p.entity_id, p.id INTO dup, dup_rec FROM public.register_records p
          WHERE p.register_key = 'procurement' AND p.site_id = h.site_id AND p.state <> 'voided' AND p.data ->> 'scope' = 'HLC'
            AND lower(btrim(coalesce(p.data ->> 'pr_no', ''))) = lower(pno)
          ORDER BY p.is_current DESC, p.version_no DESC LIMIT 1;
      END IF;
      IF dup IS NOT NULL THEN
        outcome := 'duplicate'; rid := dup_rec; n_link := n_link + 1;
        IF NOT coalesce(p_dry_run, true) THEN
          INSERT INTO public.hlc_legacy_migrations (hlc_entity_id, hlc_record_id, procurement_entity_id, procurement_record_id, outcome, request_no, request_date, site_id, region_id, migrated_by, reason)
          VALUES (h.entity_id, h.id, dup, dup_rec, 'linked_existing', pno, pd, h.site_id, h.region_id, actor, btrim(p_reason));
        END IF;
      ELSE
        outcome := 'create'; n_create := n_create + 1;
        IF NOT coalesce(p_dry_run, true) THEN
          data := jsonb_strip_nulls(jsonb_build_object('scope', 'HLC', 'pr_no', pno, 'pr_date', pd::text,
            'remark', 'Migrated from the legacy HLC request of the HLC register (Q139): complete it and submit it.'));
          ent := gen_random_uuid();
          -- the draft belongs to the HLC Fiber Team (the procurement_hlc row decides its entry level); it is created by this function, not typed by the actor,
          -- so the entry-holder guard of the scope rows (b_reg_scope_entry, 0042) is not asked for it: the actor is paused for this one insert (app_ctx_pause, 0069)
          PERFORM public.app_ctx_pause(true);
          INSERT INTO public.register_records (entity_id, register_key, site_id, region_id, is_global, levels_required, data, custom, created_by, level_opened_at)
          VALUES (ent, 'procurement', h.site_id, h.region_id, false, coalesce(lv, 2), data, '{}'::jsonb, actor, now())
          RETURNING id INTO rid;
          PERFORM public.app_ctx_pause(false);
          PERFORM public.reg_step(rid, 1, 'create', actor, 'migrated from the legacy HLC request (Q139)', NULL, 'entry', false, false);
          PERFORM public.log_audit_write('hlc_legacy_draft_created', 'register_record', rid::text, NULL,
            jsonb_build_object('data', data, 'legacy_hlc_record_id', h.id, 'legacy_request_no', h.request_no, 'legacy_request_date', h.request_date), btrim(p_reason), h.site_id, h.region_id);
          INSERT INTO public.hlc_legacy_migrations (hlc_entity_id, hlc_record_id, procurement_entity_id, procurement_record_id, outcome, request_no, request_date, site_id, region_id, migrated_by, reason)
          VALUES (h.entity_id, h.id, ent, rid, 'created', pno, pd, h.site_id, h.region_id, actor, btrim(p_reason));
        END IF;
      END IF;
    END IF;
    items := items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('hlc_record_id', h.id, 'hlc_entity_id', h.entity_id, 'site_id', h.site_id, 'site_code', h.site_code,
      'region_id', h.region_id, 'request_no', h.request_no, 'request_date', h.request_date, 'outcome', outcome, 'procurement_record_id', rid,
      'date_dropped', CASE WHEN dropped THEN true END)));
  END LOOP;
  IF NOT coalesce(p_dry_run, true) THEN
    PERFORM public.log_audit_write('hlc_legacy_migration_run', 'setting', 'hlc_legacy_to_drafts', NULL,
      jsonb_build_object('created', n_create, 'linked_existing', n_link, 'already_migrated', n_done), btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('dry_run', coalesce(p_dry_run, true), 'items', items,
    'counts', jsonb_build_object('create', n_create, 'duplicate', n_link, 'already_migrated', n_done));
END $function$;

-- app_begin is for the application role only.
REVOKE EXECUTE ON FUNCTION app_begin(jsonb, bytea) FROM pmis_definer, pmis_identity_owner, pmis_migrator;
