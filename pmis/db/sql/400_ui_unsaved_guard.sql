-- 0401_ui_unsaved_guard: Decision 11 (the unsaved-changes guard for the whole system) joins the guarded ui.features setting as the section
-- "unsaved_guard". Mirror: db/sql/400_ui_unsaved_guard.sql (kept byte-identical). Additive: only ui_features_seed() and ui_features_validate() are replaced,
-- with the bodies of 0400 (the Data hub) plus the new section (nothing of an earlier section is dropped). No table, no new function, no permission change, nothing public.
-- A stored value without the section takes the seed, so nothing has to be backfilled.
--
--   unsaved_guard  {enabled, settings, dialogs, drawers, inline, composers, navigation: boolean}
--
-- The seed turns the guard on everywhere. `enabled` is the master switch; each other key switches one area (Settings pages, form dialogs, drawers, inline edits,
-- comment and message composers, in-app navigation with the browser Back button and closing the tab).

SELECT set_config('app.region_ids', '*', true);

CREATE OR REPLACE FUNCTION ui_features_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"avatars": {"style": "gradient", "shape": "circle", "palette": "varied", "in_lists": true},
           "new_badge": {"enabled": true, "days": 14},
           "inbox": {"tabs_enabled": true, "default_tab": "all",
                     "priority_kinds": ["mention", "approval_due", "task_returned", "task_rejected", "idle_task_alert", "no_holder", "absence_alert"]},
           "panel": {"mode": "popover", "width": "medium", "show_tabs": true},
           "data_hub": {"widgets": {"quick_bar": true, "batches": true, "template_changes": true, "recent": true, "health": true, "admin": true},
                        "badge": true,
                        "default_view": {"templates": "cards", "uploads": "table", "exports": "table", "master_import": "table"}},
           "unsaved_guard": {"enabled": true, "settings": true, "dialogs": true, "drawers": true, "inline": true, "composers": true, "navigation": true}}'::jsonb
$$;

-- Checks every section object; appends field errors to errs. This is the validator of 0400 (data_hub) with the "unsaved_guard" branch added.
CREATE OR REPLACE FUNCTION ui_features_validate(p_sections jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; s jsonb; kk text; n integer; el jsonb; w jsonb; v jsonb;
BEGIN
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'object' THEN
    RETURN public.reg_err_item('/sections', 'required', 'An object of sections.') || '[]'::jsonb;
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_sections) LOOP
    IF k NOT IN ('avatars', 'new_badge', 'inbox', 'panel', 'data_hub', 'unsaved_guard') THEN errs := errs || public.reg_err_item('/sections/' || k, 'unknown_key', 'Unknown section.'); END IF;
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

  s := p_sections -> 'panel';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/panel', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('mode', 'width', 'show_tabs') THEN errs := errs || public.reg_err_item('/sections/panel/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'mode') IS DISTINCT FROM 'string' OR (s ->> 'mode') NOT IN ('popover', 'side_panel') THEN
        errs := errs || public.reg_err_item('/sections/panel/mode', 'invalid', 'popover or side_panel.'); END IF;
      IF jsonb_typeof(s -> 'width') IS DISTINCT FROM 'string' OR (s ->> 'width') NOT IN ('narrow', 'medium', 'wide') THEN
        errs := errs || public.reg_err_item('/sections/panel/width', 'invalid', 'narrow, medium or wide.'); END IF;
      IF jsonb_typeof(s -> 'show_tabs') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/panel/show_tabs', 'invalid', 'true or false.'); END IF;
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
  s := p_sections -> 'unsaved_guard';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/unsaved_guard', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('enabled', 'settings', 'dialogs', 'drawers', 'inline', 'composers', 'navigation') THEN errs := errs || public.reg_err_item('/sections/unsaved_guard/' || kk, 'unknown_key', 'Unknown key.'); END IF;
        IF kk IN ('enabled', 'settings', 'dialogs', 'drawers', 'inline', 'composers', 'navigation') AND jsonb_typeof(s -> kk) IS DISTINCT FROM 'boolean' THEN
          errs := errs || public.reg_err_item('/sections/unsaved_guard/' || kk, 'invalid', 'true or false.'); END IF;
      END LOOP;
      FOREACH kk IN ARRAY ARRAY['enabled', 'settings', 'dialogs', 'drawers', 'inline', 'composers', 'navigation'] LOOP
        IF NOT jsonb_exists(s, kk) THEN errs := errs || public.reg_err_item('/sections/unsaved_guard/' || kk, 'required', 'true or false.'); END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN errs;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ui_features_unsaved_guard_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'section unsaved_guard added to ui.features'),
        'Unsaved-changes guard setting (migration 0401, Decision 11).');
