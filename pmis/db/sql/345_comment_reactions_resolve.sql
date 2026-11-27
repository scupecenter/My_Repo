-- 0346: reactions on comments (a 👍 "acknowledged") and marking a comment resolved (PM-platforms proposal item 18, owner approval 2026-11-27 relayed by Main). Mirror of pmis/apps/api/prisma/migrations/0346_comment_reactions_resolve/migration.sql (identical content).
-- owner approval 2026-11-27 relayed by Main). Mirror of this file: pmis/db/sql/345_comment_reactions_resolve.sql (identical content).
--
-- WHY. On a construction project a comment often needs only an acknowledgement, not a reply, and an open point needs a clear
-- "resolved" mark instead of a follow-up comment saying so. Nothing existing changes: old comments simply have no reactions
-- and are unresolved. No permission is widened: the bar to react or resolve is the same bar as commenting, reading the thread.
--
-- WHAT THIS ADDS.
--   1. comments.resolved_at / resolved_by: who closed the point and when; NULL while open.
--   2. comment_reactions: one row per (comment, user, emoji). The emoji list starts with 👍 only (the proposal's "acknowledged");
--      widening it is a data change here plus the same list in the web client.
--   3. comment_visible(uuid): the shared read check of a comment - a task comment follows the task's region scope (like
--      wf_lock_task without the lock), a register-record comment follows the record's module view scope (like reg_add_comment).
--      Anything else, and any comment the caller cannot read, raises not_found so its existence is not revealed.
--   4. comment_react(uuid,text) / comment_unreact(uuid,text) / comment_set_resolved(uuid,boolean): the only write doors,
--      definer-owned like the rest of the engine; reactions and the resolved flag are light state and deliberately unaudited.
-- Reactions and resolution are intentionally not audited: they are lightweight thread state, not workflow decisions.

ALTER TABLE public.comments ADD COLUMN resolved_at timestamptz, ADD COLUMN resolved_by uuid REFERENCES public.users(id);

CREATE TABLE public.comment_reactions (
  comment_id uuid NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (emoji IN ('👍')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comment_reactions_pkey PRIMARY KEY (comment_id, user_id, emoji)
);
CREATE INDEX comment_reactions_user_idx ON public.comment_reactions (user_id);

ALTER TABLE public.comment_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reactions FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON public.comment_reactions FOR SELECT USING (EXISTS (SELECT 1 FROM public.comments p WHERE p.id = comment_id));

CREATE TRIGGER a_wf_backstop BEFORE INSERT OR UPDATE OR DELETE ON public.comment_reactions FOR EACH ROW EXECUTE FUNCTION public.wf_backstop();

CREATE OR REPLACE FUNCTION public.comment_visible(p_comment uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); c public.comments%ROWTYPE; rr public.register_records%ROWTYPE; regs int[]; mod text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO c FROM public.comments WHERE id = p_comment;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
  IF c.task_id IS NOT NULL THEN
    regs := public.wf_actor_regions('sites', 'view');
    IF regs IS NOT NULL AND NOT (c.region_id = ANY (regs)) THEN PERFORM public.wf_err('not_found'); END IF;
  ELSIF c.entity_type = 'register_record' THEN
    SELECT * INTO rr FROM public.register_records WHERE entity_id = c.entity_id LIMIT 1;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    mod := public.reg_module(rr.register_key);
    regs := CASE WHEN mod IS NULL THEN ARRAY[]::int[] ELSE public.wf_actor_regions(mod, 'view') END;
    IF regs IS NOT NULL AND (cardinality(regs) = 0 OR NOT (c.region_id = ANY (regs))) THEN PERFORM public.wf_err('not_found'); END IF;
  ELSE
    PERFORM public.wf_err('not_found');
  END IF;
  RETURN actor;
END $$;

CREATE OR REPLACE FUNCTION public.comment_react(p_comment uuid, p_emoji text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid;
BEGIN
  actor := public.comment_visible(p_comment);
  IF p_emoji NOT IN ('👍') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Only the thumbs-up reaction is supported.')); END IF;
  INSERT INTO public.comment_reactions (comment_id, user_id, emoji) VALUES (p_comment, actor, p_emoji) ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public.comment_unreact(p_comment uuid, p_emoji text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.comment_visible(p_comment);
  DELETE FROM public.comment_reactions WHERE comment_id = p_comment AND user_id = public.app_actor() AND emoji = p_emoji;
END $$;

CREATE OR REPLACE FUNCTION public.comment_set_resolved(p_comment uuid, p_resolved boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid;
BEGIN
  actor := public.comment_visible(p_comment);
  UPDATE public.comments
     SET resolved_at = CASE WHEN p_resolved THEN now() ELSE NULL END,
         resolved_by = CASE WHEN p_resolved THEN actor ELSE NULL END
   WHERE id = p_comment;
END $$;

GRANT SELECT, INSERT, DELETE ON public.comment_reactions TO pmis_definer;
GRANT UPDATE (resolved_at, resolved_by) ON public.comments TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['comment_visible(uuid)', 'comment_react(uuid,text)', 'comment_unreact(uuid,text)', 'comment_set_resolved(uuid,boolean)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.comment_react(uuid, text), public.comment_unreact(uuid, text), public.comment_set_resolved(uuid, boolean) TO pmis_app;
    REVOKE ALL ON FUNCTION public.comment_visible(uuid) FROM pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.comment_reactions FROM pmis_app;
    GRANT SELECT ON public.comment_reactions TO pmis_app;
  END IF;
END $$;
