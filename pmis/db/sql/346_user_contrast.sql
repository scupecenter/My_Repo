-- 0347: the appearance dimensions gain `contrast` (item 19 of the 2026-11-27 batch, the high-contrast mode; owner approval 2026-11-27
-- relayed by Main). Mirror: prisma/migrations/0347_user_contrast/migration.sql (kept identical to this file).
--
-- WHY. Low-vision users and bright-site conditions need stronger text and borders than the standard tokens give. The personal
-- appearance framework of 0241 already carries every per-user appearance choice (users.ui_prefs, organization defaults, the
-- admin personal-choice lock, the audited idm_update_own_profile door, the Settings > Identity editors): a contrast choice is one
-- more appearance dimension, so it joins that framework instead of growing a parallel column and door of its own.
--
-- WHAT THIS ADDS. `contrast` ('standard' = today's look, 'high' = stronger ink and lines) in ui_pref_options() and
-- ui_pref_defaults(). Everything else follows the framework unchanged: ui_prefs_sanitize() reads the options list, so the new
-- dimension is accepted, validated, audited, defaulted by the organization, locked by the personal-choice switch and resolved by
-- ui_effective_prefs() with no further code. The web paints it as data-ui-contrast="high" (styles/appearance.css).
--
-- The rewrite is the idempotent in-place patch of 0361: the stored function text is edited only when the dimension is missing, so
-- whichever order the migrations run in, no other dimension is dropped. Safe to run twice. No table, no column, no permission,
-- no role or grant change (CREATE OR REPLACE keeps the owner and the grants of 0241).

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.ui_pref_options()'::regprocedure);
  IF position('contrast' IN def) = 0 THEN
    IF position($c$'amber'])$c$ IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_options: the accent list was not found'; END IF;
    def := replace(def, $c$'amber'])$c$, $c$'amber'],
    'contrast', ARRAY['standard', 'high'])$c$);
    EXECUTE def;
  END IF;

  def := pg_get_functiondef('public.ui_pref_defaults()'::regprocedure);
  IF position('contrast' IN def) = 0 THEN
    IF position('"accent": "default"}' IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_defaults: the accent default was not found'; END IF;
    def := replace(def, '"accent": "default"}', '"accent": "default", "contrast": "standard"}');
    EXECUTE def;
  END IF;
END $$;
