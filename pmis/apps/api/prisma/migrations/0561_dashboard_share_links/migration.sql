-- 0561_dashboard_share_links: durable, revocable share links to a read-only dashboard view (owner decision 2026-11-26 00:51).
--
-- A link is only an envelope: it stores a label and the dashboard query (ref_date, region, cluster, scenario, stream,
-- view). Opening it needs a signed-in user and the data is the normal GET /dashboard of THAT user, so role and region
-- visibility are always the opener's own (nothing in this migration bypasses app_dashboard_tabs / dash_overview).
-- Additive. Writes go through definer doors that check the right, take a reason and audit:
--   dashboard_share_created / dashboard_share_revoked / dashboard_share_opened (audit_log via idm_audit).

CREATE TABLE dashboard_share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 20 AND 64),
  label         text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
  params        jsonb NOT NULL,
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users (id),
  revoke_reason text,
  open_count    integer NOT NULL DEFAULT 0,
  last_opened_at timestamptz
);
CREATE INDEX dashboard_share_links_creator ON dashboard_share_links (created_by);
COMMENT ON TABLE dashboard_share_links IS '0561: share links to a read-only dashboard view. The link grants nothing by itself: opening needs a session and the data is scoped to the opener.';

-- The query a link may carry: only the GET /dashboard parameters, each validated.
CREATE OR REPLACE FUNCTION dashboard_share_params_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN
           ('ref_date','region_id','cluster_code','scenario','stream','view','exclude_overrides'))
     AND (p ->> 'ref_date' IS NULL OR p ->> 'ref_date' ~ '^\d{4}-\d{2}-\d{2}$')
     AND (p ->> 'region_id' IS NULL OR p ->> 'region_id' ~ '^[1-7]$')
     AND (p ->> 'cluster_code' IS NULL OR char_length(p ->> 'cluster_code') BETWEEN 1 AND 40)
     AND (p ->> 'scenario' IS NULL OR p ->> 'scenario' = ANY (ARRAY['new_build','expansion','hot_swap','cold_swap','relocation']))
     AND (p ->> 'stream' IS NULL OR p ->> 'stream' ~ '^[A-Z][A-Z0-9_]{1,30}$')
     AND (p ->> 'view' IS NULL OR char_length(p ->> 'view') BETWEEN 1 AND 40)
     AND (p ->> 'exclude_overrides' IS NULL OR p ->> 'exclude_overrides' = ANY (ARRAY['true','false','1','0']))
$$;

CREATE OR REPLACE FUNCTION dashboard_share_create(p jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor();
  t text := btrim(coalesce(p ->> 'token', ''));
  lbl text := btrim(coalesce(p ->> 'label', ''));
  params jsonb := coalesce(p -> 'params', '{}'::jsonb);
  days int := coalesce((p ->> 'days')::int, 30);
  rid uuid;
BEGIN
  IF actor IS NULL THEN PERFORM public.wf_err('unauthenticated'); END IF;
  IF coalesce(array_length(public.app_dashboard_tabs(actor), 1), 0) = 0 THEN
    RAISE EXCEPTION 'dashboard share: dashboard.view required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF char_length(t) < 20 OR char_length(t) > 64 THEN PERFORM public.wf_err('validation_failed'); END IF;
  IF NOT public.dashboard_share_params_ok(params) THEN PERFORM public.wf_err('validation_failed'); END IF;
  IF days < 1 OR days > 365 THEN PERFORM public.wf_err('validation_failed'); END IF;
  INSERT INTO dashboard_share_links (token, label, params, created_by, expires_at)
  VALUES (t, lbl, params, actor, now() + make_interval(days => days))
  RETURNING id INTO rid;
  PERFORM public.idm_audit('dashboard_share_created', 'dashboard_share_link', rid::text, NULL,
    jsonb_build_object('label', lbl, 'params', params, 'days', days), p_reason);
  RETURN jsonb_build_object('id', rid, 'token', t, 'label', lbl, 'params', params,
    'expires_at', now() + make_interval(days => days));
END $$;

CREATE OR REPLACE FUNCTION dashboard_share_revoke(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor();
  r dashboard_share_links%ROWTYPE;
BEGIN
  IF actor IS NULL THEN PERFORM public.wf_err('unauthenticated'); END IF;
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO r FROM dashboard_share_links WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  IF r.created_by <> actor AND NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'dashboard share: only the creator or a System Admin revokes a link' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.revoked_at IS NOT NULL THEN PERFORM public.wf_err('conflict'); END IF;
  UPDATE dashboard_share_links SET revoked_at = now(), revoked_by = actor, revoke_reason = p_reason WHERE id = p_id;
  PERFORM public.idm_audit('dashboard_share_revoked', 'dashboard_share_link', p_id::text,
    jsonb_build_object('label', r.label, 'params', r.params), jsonb_build_object('revoked', true), p_reason);
  RETURN jsonb_build_object('id', p_id, 'revoked', true);
END $$;

-- Opening a link: any signed-in user. Unknown token is not_found, an expired or revoked one is gone (410).
CREATE OR REPLACE FUNCTION dashboard_share_resolve(p_token text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor();
  r dashboard_share_links%ROWTYPE;
BEGIN
  IF actor IS NULL THEN PERFORM public.wf_err('unauthenticated'); END IF;
  SELECT * INTO r FROM dashboard_share_links WHERE token = p_token;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  IF r.revoked_at IS NOT NULL OR (r.expires_at IS NOT NULL AND r.expires_at <= now()) THEN
    PERFORM public.idm_audit('dashboard_share_refused', 'dashboard_share_link', r.id::text, NULL,
      jsonb_build_object('reason', CASE WHEN r.revoked_at IS NOT NULL THEN 'revoked' ELSE 'expired' END), NULL);
    PERFORM public.wf_err('gone');
  END IF;
  UPDATE dashboard_share_links SET open_count = open_count + 1, last_opened_at = now() WHERE id = r.id;
  PERFORM public.idm_audit('dashboard_share_opened', 'dashboard_share_link', r.id::text, NULL,
    jsonb_build_object('label', r.label), NULL);
  RETURN jsonb_build_object('id', r.id, 'label', r.label, 'params', r.params, 'expires_at', r.expires_at,
    'created_by', (SELECT display_name FROM users WHERE id = r.created_by));
END $$;

GRANT SELECT ON dashboard_share_links TO pmis_app;
GRANT EXECUTE ON FUNCTION dashboard_share_create(jsonb, text) TO pmis_app;
GRANT EXECUTE ON FUNCTION dashboard_share_revoke(uuid, text) TO pmis_app;
GRANT EXECUTE ON FUNCTION dashboard_share_resolve(text) TO pmis_app;
