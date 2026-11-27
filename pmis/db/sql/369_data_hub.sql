-- 0370_data_hub: the Data hub (Data entry group renamed, owner decision 2026-11-27). Two additions, both additive:
--  1. the section "data_hub" of the guarded ui.features setting (Settings > Screens > Data hub): which widgets of the hub landing page show, the badge on
--     Uploads & batches, and the default view of each hub list screen (cards, rows, table, compact). A stored value without the section takes the seed.
--     Only ui_features_seed() and ui_features_validate() are replaced; no table, no permission change, nothing public.
--  2. data_hub_my_downloads(): the caller's own last download of each template (version and time), read from the audit rows template_download that
--     every download already writes. It reads only rows whose actor is the caller, so it opens nothing new ("Your last downloads" on the hub).
-- Mirror: db/sql/369_data_hub.sql (kept byte-identical).

SELECT set_config('app.region_ids', '*', true);

CREATE OR REPLACE FUNCTION ui_features_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"avatars": {"style": "gradient", "shape": "circle", "palette": "varied", "in_lists": true},
           "new_badge": {"enabled": true, "days": 14},
           "inbox": {"tabs_enabled": true, "default_tab": "all",
                     "priority_kinds": ["mention", "approval_due", "task_returned", "task_rejected", "idle_task_alert", "no_holder", "absence_alert"]},
           "data_hub": {"widgets": {"quick_bar": true, "batches": true, "template_changes": true, "recent": true, "health": true, "admin": true},
                        "badge": true,
                        "default_view": {"templates": "cards", "uploads": "table", "exports": "table", "master_import": "table"}}}'::jsonb
$$;

-- Checks every section object; appends field errors to errs. This is the validator of 0281 with the "data_hub" branch added.
CREATE OR REPLACE FUNCTION ui_features_validate(p_sections jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; s jsonb; kk text; n integer; el jsonb; w jsonb; v jsonb;
BEGIN
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'object' THEN
    RETURN public.reg_err_item('/sections', 'required', 'An object of sections.') || '[]'::jsonb;
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_sections) LOOP
    IF k NOT IN ('avatars', 'new_badge', 'inbox', 'data_hub') THEN errs := errs || public.reg_err_item('/sections/' || k, 'unknown_key', 'Unknown section.'); END IF;
  END LOOP;

  s := p_sections -> 'avatars';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/avatars', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('style', 'shape', 'palette', 'in_lists') THEN errs := errs || public.reg_err_item('/sections/avatars/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'style') IS DISTINCT FROM 'string' OR (s ->> 'style') NOT IN ('initials', 'gradient', 'geometric', 'none') THEN
        errs := errs || public.reg_err_item('/sections/avatars/style', 'invalid', 'initials, gradient, geometric or none.'); END IF;
      IF jsonb_typeof(s -> 'shape') IS DISTINCT FROM 'string' OR (s ->> 'shape') NOT IN ('circle', 'rounded') THEN
        errs := errs || public.reg_err_item('/sections/avatars/shape', 'invalid', 'circle or rounded.'); END IF;
      IF jsonb_typeof(s -> 'palette') IS DISTINCT FROM 'string' OR (s ->> 'palette') NOT IN ('brand', 'varied') THEN
        errs := errs || public.reg_err_item('/sections/avatars/palette', 'invalid', 'brand or varied.'); END IF;
      IF jsonb_typeof(s -> 'in_lists') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/avatars/in_lists', 'invalid', 'true or false.'); END IF;
    END IF;
  END IF;

  s := p_sections -> 'new_badge';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/new_badge', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('enabled', 'days') THEN errs := errs || public.reg_err_item('/sections/new_badge/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'enabled') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/new_badge/enabled', 'invalid', 'true or false.'); END IF;
      IF jsonb_typeof(s -> 'days') IS DISTINCT FROM 'number' OR (s ->> 'days') !~ '^[0-9]+$' THEN
        errs := errs || public.reg_err_item('/sections/new_badge/days', 'invalid', 'A whole number of days from 1 to 90.');
      ELSE
        n := (s ->> 'days')::integer;
        IF n < 1 OR n > 90 THEN errs := errs || public.reg_err_item('/sections/new_badge/days', 'out_of_range', 'From 1 to 90 days.'); END IF;
      END IF;
    END IF;
  END IF;

  s := p_sections -> 'inbox';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/inbox', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('tabs_enabled', 'default_tab', 'priority_kinds') THEN errs := errs || public.reg_err_item('/sections/inbox/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'tabs_enabled') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/inbox/tabs_enabled', 'invalid', 'true or false.'); END IF;
      IF jsonb_typeof(s -> 'default_tab') IS DISTINCT FROM 'string' OR (s ->> 'default_tab') NOT IN ('all', 'priority', 'mentions', 'tasks', 'approvals', 'system') THEN
        errs := errs || public.reg_err_item('/sections/inbox/default_tab', 'invalid', 'all, priority, mentions, tasks, approvals or system.'); END IF;
      IF jsonb_typeof(s -> 'priority_kinds') IS DISTINCT FROM 'array' THEN
        errs := errs || public.reg_err_item('/sections/inbox/priority_kinds', 'invalid', 'A list of notification kinds.');
      ELSE
        FOR el IN SELECT * FROM jsonb_array_elements(s -> 'priority_kinds') LOOP
          IF jsonb_typeof(el) <> 'string' OR (el #>> '{}') NOT IN ('mention', 'followed_change', 'task_assigned', 'task_returned', 'task_rejected', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'system') THEN
            errs := errs || public.reg_err_item('/sections/inbox/priority_kinds', 'invalid', 'Unknown notification kind.'); EXIT;
          END IF;
        END LOOP;
        IF jsonb_array_length(s -> 'priority_kinds') > 12 THEN errs := errs || public.reg_err_item('/sections/inbox/priority_kinds', 'out_of_range', 'At most 12 kinds.'); END IF;
      END IF;
    END IF;
  END IF;

  s := p_sections -> 'data_hub';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/data_hub', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('widgets', 'badge', 'default_view') THEN errs := errs || public.reg_err_item('/sections/data_hub/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'badge') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/data_hub/badge', 'invalid', 'true or false.'); END IF;
      w := s -> 'widgets';
      IF jsonb_typeof(w) IS DISTINCT FROM 'object' THEN
        errs := errs || public.reg_err_item('/sections/data_hub/widgets', 'invalid', 'An object of widgets.');
      ELSE
        FOR kk IN SELECT jsonb_object_keys(w) LOOP
          IF kk NOT IN ('quick_bar', 'batches', 'template_changes', 'recent', 'health', 'admin') THEN errs := errs || public.reg_err_item('/sections/data_hub/widgets/' || kk, 'unknown_key', 'Unknown widget.');
          ELSIF jsonb_typeof(w -> kk) IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/sections/data_hub/widgets/' || kk, 'invalid', 'true or false.'); END IF;
        END LOOP;
      END IF;
      v := s -> 'default_view';
      IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN
        errs := errs || public.reg_err_item('/sections/data_hub/default_view', 'invalid', 'An object of screens.');
      ELSE
        FOR kk IN SELECT jsonb_object_keys(v) LOOP
          IF kk NOT IN ('templates', 'uploads', 'exports', 'master_import') THEN errs := errs || public.reg_err_item('/sections/data_hub/default_view/' || kk, 'unknown_key', 'Unknown screen.');
          ELSIF jsonb_typeof(v -> kk) IS DISTINCT FROM 'string' OR (v ->> kk) NOT IN ('cards', 'rows', 'table', 'compact') THEN errs := errs || public.reg_err_item('/sections/data_hub/default_view/' || kk, 'invalid', 'cards, rows, table or compact.'); END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;
  RETURN errs;
END $$;


-- The caller's last download of each template: [{template_id, version, prefill, at}], newest first. Rows of other users are never read.
CREATE OR REPLACE FUNCTION data_hub_my_downloads(p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'data hub: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('template_id', x.entity_id, 'version', x.v, 'prefill', x.prefill, 'at', x.at) ORDER BY x.at DESC)
    FROM (
      SELECT * FROM (
        SELECT DISTINCT ON (al.entity_id) al.entity_id, nullif(al.after ->> 'version', '')::integer AS v, coalesce((al.after ->> 'prefill')::boolean, false) AS prefill, al.at
        FROM public.audit_log al
        WHERE al.action = 'template_download' AND al.actor_id = a AND al.at >= now() - interval '400 days'
        ORDER BY al.entity_id, al.at DESC, al.id DESC
      ) d ORDER BY d.at DESC LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
    ) x), '[]'::jsonb);
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('data_hub_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'section data_hub added to ui.features', 'door', 'data_hub_my_downloads()'),
        'Data hub setting section and last-downloads reader (migration 0370, contract 0.15.270).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_features_seed()', 'ui_features_validate(jsonb)', 'data_hub_my_downloads(integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION data_hub_my_downloads(integer) TO pmis_app;
  END IF;
END $$;
