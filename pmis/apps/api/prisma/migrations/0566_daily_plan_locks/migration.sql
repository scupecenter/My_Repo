-- Migration 0566 (hardening layer 1b, owner choices relayed 2026-11-27): locks for the Daily Plan on the model of 0565 (entity_locks,
-- entity_column_locks; kinds daily_plan and daily_plan_row; the same administer right (dp_right), reason, audit and step-up).
-- Additive. Mirror: db/sql/565_daily_plan_locks.sql (kept identical). No new table: 0565 holds the lock tables and the check functions.
--   1. dp_for_change (the door of every plan write, also of the template import 0564): a locked plan refuses the write, except from a System Admin.
--   2. dp_save_row / dp_remove_site / dp_add_site: a locked row (kind daily_plan_row) refuses the write; dp_save_row also refuses a locked column
--      (an override key, or reason / remark) named in the body.
--   3. dp_plan_head gains plan_id and entity_locked, and can_edit is false for a non-admin on a locked plan; dp_row_json gains row_id (null until the row is stored).
-- All patched in place from the stored text (pg_get_functiondef), idempotent. The day lock of 0149 (dp_lock / dp_unlock) is unchanged.
DO $$
DECLARE def text; spec record; pos int;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('public.dp_for_change(integer,date,integer,boolean)',
      E'The day is locked: only an admin override reopens it.''));\n  END IF;',
      E'\n  IF p.id IS NOT NULL AND NOT p_allow_locked THEN PERFORM public.ent_lock_check(''daily_plan'', p.id, NULL); END IF;'),
    ('public.dp_save_row(integer,date,uuid,jsonb,integer)',
      'old := public.dp_stored(p.id, p_site);',
      E'\n  IF jsonb_typeof(p_body) = ''object'' THEN PERFORM public.ent_lock_check(''daily_plan_row'', old.id, coalesce(p_body -> ''overrides'', ''{}''::jsonb) || (p_body - ''overrides'')); END IF;'),
    ('public.dp_remove_site(integer,date,uuid,integer)',
      'old := public.dp_stored(p.id, p_site);',
      E'\n  PERFORM public.ent_lock_check(''daily_plan_row'', old.id, NULL);'),
    ('public.dp_add_site(integer,date,text,integer)',
      'old := public.dp_stored(p.id, s.id);',
      E'\n  PERFORM public.ent_lock_check(''daily_plan_row'', old.id, NULL);'),
    ('public.dp_plan_head(integer,date,jsonb)',
      '''region_id'', p_region, ''region_code'', rg.code,',
      NULL),
    ('public.dp_row_json(integer,date,uuid,public.daily_plan_rows)',
      '''region_id'', p_region, ''site_id'', p_site,',
      NULL)
  ) v(fn, anchor, line) LOOP
    def := pg_get_functiondef(spec.fn::regprocedure);
    IF position('ent_lock_check' IN def) = 0 AND position('entity_locked' IN def) = 0 AND position('''row_id''' IN def) = 0 THEN
      pos := position(spec.anchor IN def);
      IF pos = 0 THEN RAISE EXCEPTION '%: anchor not found', spec.fn; END IF;
      IF spec.line IS NOT NULL THEN
        def := overlay(def PLACING spec.anchor || spec.line FROM pos FOR length(spec.anchor));
      ELSIF spec.fn LIKE 'public.dp_plan_head%' THEN
        def := overlay(def PLACING '''plan_id'', p.id, ''entity_locked'', EXISTS (SELECT 1 FROM public.entity_locks l WHERE l.target_kind = ''daily_plan'' AND l.target_id = p.id AND l.unlocked_at IS NULL), ' || spec.anchor FROM pos FOR length(spec.anchor));
        def := replace(def, '''can_edit'', p.locked_at IS NULL AND (admin OR', '''can_edit'', p.locked_at IS NULL AND (admin OR (NOT EXISTS (SELECT 1 FROM public.entity_locks l WHERE l.target_kind = ''daily_plan'' AND l.target_id = p.id AND l.unlocked_at IS NULL) AND');
        def := replace(def, 'public.dp_holds(a, p_region, ''entry'')),', 'public.dp_holds(a, p_region, ''entry''))),');
      ELSE
        def := overlay(def PLACING '''row_id'', p_row.id, ' || spec.anchor FROM pos FOR length(spec.anchor));
      END IF;
      EXECUTE def;
    END IF;
  END LOOP;
END $$;
