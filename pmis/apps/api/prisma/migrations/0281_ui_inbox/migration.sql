-- 0281_ui_inbox: item 6 of the 2026-11-27 PM-platforms research (the notification inbox with tabs and priority) joins the guarded ui.features setting as the
-- section "inbox". Mirror: db/sql/280_ui_inbox.sql (kept byte-identical). Additive: only ui_features_seed() and ui_features_validate() are replaced; no table,
-- no new function, no permission change, nothing public. A stored value without the section takes the seed, so nothing has to be backfilled.
--
--   inbox  {tabs_enabled: boolean, default_tab: all | priority | mentions | tasks | approvals | system, priority_kinds: [notification kind, ...]}
--
-- priority_kinds is the list of notification kinds that count as priority (the Priority tab and the priority marker); the seed is the list the web app used
-- before this setting existed, so nothing changes until an admin edits it.

SELECT set_config('app.region_ids', '*', true);

CREATE OR REPLACE FUNCTION ui_features_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"avatars": {"style": "gradient", "shape": "circle", "palette": "varied", "in_lists": true},
           "new_badge": {"enabled": true, "days": 14},
           "inbox": {"tabs_enabled": true, "default_tab": "all",
                     "priority_kinds": ["mention", "approval_due", "task_returned", "task_rejected", "idle_task_alert", "no_holder", "absence_alert"]}}'::jsonb
$$;

-- Checks every section object; appends field errors to errs. This is the validator of 0280 with the "inbox" branch added.
CREATE OR REPLACE FUNCTION ui_features_validate(p_sections jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; s jsonb; kk text; n integer; el jsonb;
BEGIN
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'object' THEN
    RETURN public.reg_err_item('/sections', 'required', 'An object of sections.') || '[]'::jsonb;
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_sections) LOOP
    IF k NOT IN ('avatars', 'new_badge', 'inbox') THEN errs := errs || public.reg_err_item('/sections/' || k, 'unknown_key', 'Unknown section.'); END IF;
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
  RETURN errs;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_features_inbox_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'section inbox added to ui.features'),
        'Inbox tabs and priority setting (migration 0281, contract 0.15.250).');
