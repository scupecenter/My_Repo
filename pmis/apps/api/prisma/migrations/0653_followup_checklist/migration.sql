-- 0653: the appearance dimensions gain `followup_checklist` (the profile-completion checklist of the follow-up hub: show or hide; proposal item 11).
-- Mirror of this file: apps/api/prisma/migrations/0653_followup_checklist/migration.sql (kept byte-identical).
--
-- WHY. The personal appearance framework of 0241 already carries every per-user appearance choice (users.ui_prefs, organization defaults, the admin
-- personal-choice lock, the audited idm_update_own_profile door, the Settings > Identity editors), so this choice joins it as one dimension instead of a
-- column and a door of its own. The hub itself reads data the person already may read; no new route and no new permission.
--
-- WHAT THIS ADDS. `followup_checklist` ('show' = default, 'hide') in ui_pref_options() and ui_pref_defaults(). Idempotent in-place patch (as 0347, 0526
-- and 0581): the stored function text is edited only when the dimension is missing, whichever order the migrations run in, so no other dimension is dropped.
-- No table, no column, no permission, no role or grant change.

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.ui_pref_options()'::regprocedure);
  IF position('followup_checklist' IN def) = 0 THEN
    IF position($c$'more_menu', ARRAY['list', 'grid'])$c$ IN def) > 0 THEN
      def := replace(def, $c$'more_menu', ARRAY['list', 'grid'])$c$, $c$'more_menu', ARRAY['list', 'grid'],
    'followup_checklist', ARRAY['show', 'hide'])$c$);
    ELSIF position($c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'])$c$ IN def) > 0 THEN
      def := replace(def, $c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'])$c$, $c$'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'],
    'followup_checklist', ARRAY['show', 'hide'])$c$);
    ELSIF position($c$'contrast', ARRAY['standard', 'high'])$c$ IN def) > 0 THEN
      def := replace(def, $c$'contrast', ARRAY['standard', 'high'])$c$, $c$'contrast', ARRAY['standard', 'high'],
    'followup_checklist', ARRAY['show', 'hide'])$c$);
    ELSE
      RAISE EXCEPTION 'ui_pref_options: no known last dimension was found';
    END IF;
    EXECUTE def;
  END IF;

  def := pg_get_functiondef('public.ui_pref_defaults()'::regprocedure);
  IF position('followup_checklist' IN def) = 0 THEN
    IF position('"contrast": "standard"' IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_defaults: the contrast default was not found'; END IF;
    def := replace(def, '"contrast": "standard"', '"contrast": "standard", "followup_checklist": "show"');
    EXECUTE def;
  END IF;
END $$;
