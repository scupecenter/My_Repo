-- 0654: the appearance dimensions gain `app_banner` (the app banner on small screens: show or hide) and `first_use_tour` (auto = opens once by itself, manual = only when replayed); proposal item 12.
-- Mirror of this file: apps/api/prisma/migrations/0654_mobile_banner_tour/migration.sql (kept byte-identical).
--
-- WHY. The personal appearance framework of 0241 already carries every per-user appearance choice (users.ui_prefs, organization defaults, the admin
-- personal-choice lock, the audited idm_update_own_profile door, the Settings > Identity editors), so these two choices join it as dimensions instead of a
-- column and a door of their own. No new route and no new permission.
--
-- WHAT THIS ADDS. `app_banner` ('show' = default, 'hide') and `first_use_tour` ('auto' = default, 'manual') in ui_pref_options() and ui_pref_defaults().
-- Idempotent in-place patch (as 0347, 0526, 0581 and 0653): the stored function text is edited only when a dimension is missing, whichever order the
-- migrations run in, so no other dimension is dropped. No table, no column, no permission, no role or grant change.

DO $$
DECLARE def text; anchor text; extra text;
BEGIN
  def := pg_get_functiondef('public.ui_pref_options()'::regprocedure);
  IF position('first_use_tour' IN def) = 0 THEN
    extra := E',\n    \'app_banner\', ARRAY[\'show\', \'hide\'],\n    \'first_use_tour\', ARRAY[\'auto\', \'manual\'])';
    FOREACH anchor IN ARRAY ARRAY[
      $c$'followup_checklist', ARRAY['show', 'hide'])$c$,
      $c$'more_menu', ARRAY['list', 'grid'])$c$,
      $c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'])$c$,
      $c$'contrast', ARRAY['standard', 'high'])$c$] LOOP
      IF position(anchor IN def) > 0 THEN
        def := replace(def, anchor, left(anchor, length(anchor) - 1) || extra);
        EXIT;
      END IF;
    END LOOP;
    IF position('first_use_tour' IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_options: no known last dimension was found'; END IF;
    EXECUTE def;
  END IF;

  def := pg_get_functiondef('public.ui_pref_defaults()'::regprocedure);
  IF position('first_use_tour' IN def) = 0 THEN
    IF position('"contrast": "standard"' IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_defaults: the contrast default was not found'; END IF;
    def := replace(def, '"contrast": "standard"', '"contrast": "standard", "app_banner": "show", "first_use_tour": "auto"');
    EXECUTE def;
  END IF;
END $$;
