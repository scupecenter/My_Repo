-- 0526: the appearance dimensions gain `inbox_panel` and `inbox_anchor` (the floating Inbox / notification panel, task relayed by Main
-- 2026-11-27). Mirror of this file: apps/api/prisma/migrations/0526_inbox_panel_mode/migration.sql (kept byte-identical).
--
-- WHY. The notification panel behind the bell (ui.features panel, item 8) can be opened and closed. This adds a per-user choice: keep
-- it as an overlay (today), open it as a floating window that can be moved, or dock it at the inline-end edge. The personal
-- appearance framework of 0241 already carries every per-user appearance choice (users.ui_prefs, organization defaults, the admin
-- personal-choice lock, the audited idm_update_own_profile door, the Settings > Identity editors), so both choices join it as
-- dimensions instead of growing a column and a door of their own.
--
-- WHAT THIS ADDS. `inbox_panel` ('overlay' = today, 'floating', 'docked') and `inbox_anchor` ('end-top' standard, 'end-bottom',
-- 'start-top', 'start-bottom': the corner of the floating panel; a drag snaps to the nearest corner, the arrow keys move it; "start"
-- and "end" are the inline sides so the choice mirrors in RTL) in ui_pref_options() and ui_pref_defaults(). ui_prefs_sanitize() reads
-- the options list, so the new dimensions are accepted, validated, audited, defaulted by the organization, locked by the
-- personal-choice switch and resolved by ui_effective_prefs() with no further code.
--
-- The rewrite is the idempotent in-place patch of 0347: the stored function text is edited only when a dimension is missing, so
-- whichever order the migrations run in, no other dimension is dropped. Safe to run twice. No table, no column, no permission,
-- no role or grant change (CREATE OR REPLACE keeps the owner and the grants of 0241).

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.ui_pref_options()'::regprocedure);
  IF position('inbox_panel' IN def) = 0 THEN
    IF position($c$'contrast', ARRAY['standard', 'high'])$c$ IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_options: the contrast list was not found'; END IF;
    def := replace(def, $c$'contrast', ARRAY['standard', 'high'])$c$, $c$'contrast', ARRAY['standard', 'high'],
    'inbox_panel', ARRAY['overlay', 'floating', 'docked'],
    'inbox_anchor', ARRAY['end-top', 'end-bottom', 'start-top', 'start-bottom'])$c$);
    EXECUTE def;
  END IF;

  def := pg_get_functiondef('public.ui_pref_defaults()'::regprocedure);
  IF position('inbox_panel' IN def) = 0 THEN
    IF position('"contrast": "standard"}' IN def) = 0 THEN RAISE EXCEPTION 'ui_pref_defaults: the contrast default was not found'; END IF;
    def := replace(def, '"contrast": "standard"}', '"contrast": "standard", "inbox_panel": "overlay", "inbox_anchor": "end-top"}');
    EXECUTE def;
  END IF;
END $$;
