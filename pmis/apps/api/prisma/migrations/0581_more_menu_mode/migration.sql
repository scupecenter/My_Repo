-- 0581: the appearance dimensions gain `more_menu` (the More menu of the table screens as a list or an icon grid with search; proposal item 10).
-- Mirror of this file: apps/api/prisma/migrations/0581_more_menu_mode/migration.sql (kept byte-identical).
--
-- WHY. Every table screen has a "..." menu for its secondary tools. The personal appearance framework of 0241 already carries each per-user
-- appearance choice (users.ui_prefs, organization defaults, the admin personal-choice lock, the audited idm_update_own_profile door, the
-- Settings > Identity editors), so this choice joins it as one dimension instead of a column and a door of its own.
--
-- WHAT THIS ADDS. `more_menu` ('list' = today, 'grid' = icon tiles with a search box) in ui_pref_options() and ui_pref_defaults().
-- ui_prefs_sanitize() reads the options list, so the new dimension is accepted, validated, audited, defaulted by the organization,
-- locked by the personal-choice switch and resolved by ui_effective_prefs() with no further code.
--
-- Idempotent in-place patch (as 0347 and 0526): the stored function text is edited only when the dimension is missing, so whichever
-- order the migrations run in, no other dimension is dropped. Safe to run twice. No table, no column, no permission, no role or grant change.

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.ui_pref_options()'::regprocedure);
  IF position('more_menu' IN def) = 0 THEN
    IF position($c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'])$c$ IN def) > 0 THEN
      def := replace(def, $c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'])$c$, $c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'],
    'more_menu', ARRAY['list', 'grid'])$c$);
    ELSIF position($c$'contrast', ARRAY['standard', 'high'])$c$ IN def) > 0 THEN
      def := replace(def, $c$'contrast', ARRAY['standard', 'high'])$c$, $c$'contrast', ARRAY['standard', 'high'],
    'more_menu', ARRAY['list', 'grid'])$c$);
    ELSE
      RAISE EXCEPTION 'ui_pref_options: no known last dimension was found';
    END IF;
    EXECUTE def;
  END IF;

  def := pg_get_functiondef('public.ui_pref_defaults()'::regprocedure);
  IF position('more_menu' IN def) = 0 THEN
    IF position('"contrast": "standard"' IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_defaults: the contrast default was not found'; END IF;
    def := replace(def, '"contrast": "standard"', '"contrast": "standard", "more_menu": "list"');
    EXECUTE def;
  END IF;
END $$;
