-- 0668: private notes on a record (item 7 of the approved suggestion list, relayed by main 2026-11-28; contract 0.15.597).
-- Mirror: apps/api/prisma/migrations/0668_private_notes/migration.sql (kept byte-identical).
--
-- A note the caller keeps on a task or a register record that nobody else can read: not the owner of the record, not a System Admin through the app.
-- One note per person and record; saving an empty text keeps the row with an empty body (hide, never delete). Additive; no permission is widened.
--   1. private_notes: door table, written and read only by the two functions below (owner pmis_definer, RLS on, the API role has no table right).
--   2. private_note_get(type, id) and private_note_set(type, id, body): always the caller's own row; the record must exist.
-- Data reset: KEEP (it is a person's own text), like the other personal tables.

CREATE TABLE IF NOT EXISTS private_notes (
  user_id      uuid NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('task', 'register_record')),
  entity_id    uuid NOT NULL,
  body         text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);
COMMENT ON TABLE private_notes IS 'Private notes (contract 0.15.597): one note per person and record, readable only by its author. Door table: written and read only by private_note_get() and private_note_set().';
ALTER TABLE private_notes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'private_notes' AND policyname = 'private_notes_door') THEN
    CREATE POLICY private_notes_door ON private_notes FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private_note_get(p_type text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); n public.private_notes%ROWTYPE;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO n FROM public.private_notes x WHERE x.user_id = a AND x.entity_type = p_type AND x.entity_id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('entity_type', p_type, 'entity_id', p_id, 'body', '', 'updated_at', NULL); END IF;
  RETURN jsonb_build_object('entity_type', n.entity_type, 'entity_id', n.entity_id, 'body', n.body, 'updated_at', n.updated_at);
END $$;

CREATE OR REPLACE FUNCTION private_note_set(p_type text, p_id uuid, p_body text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); b text := coalesce(p_body, ''); ok boolean;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_type = 'task' THEN ok := EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = p_id);
  ELSIF p_type = 'register_record' THEN ok := EXISTS (SELECT 1 FROM public.register_records r WHERE r.id = p_id);
  ELSE ok := false; END IF;
  IF NOT ok THEN PERFORM public.wf_err('not_found'); END IF;
  IF char_length(b) > 4000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/body', 'too_long', 'A note is up to 4000 characters.')));
  END IF;
  INSERT INTO public.private_notes (user_id, entity_type, entity_id, body, updated_at) VALUES (a, p_type, p_id, b, now())
  ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET body = EXCLUDED.body, updated_at = now();
  RETURN public.private_note_get(p_type, p_id);
END $$;

-- data reset: personal text (KEEP), patched in place (0361 pattern)
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''private_notes''' IN def) = 0 THEN
    IF position('''phase_gate_rules''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    EXECUTE replace(def, '''phase_gate_rules''', '''phase_gate_rules'', ''private_notes''');
  END IF;
END $$;

ALTER TABLE public.private_notes OWNER TO pmis_definer;
REVOKE ALL ON public.private_notes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.private_notes TO pmis_definer;
GRANT SELECT ON public.task_instances, public.register_records TO pmis_definer;
GRANT SELECT, UPDATE ON public.private_notes TO pmis_reset_owner;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['private_note_get(text,uuid)', 'private_note_set(text,uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION private_note_get(text, uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION private_note_set(text, uuid, text) TO pmis_app;
  END IF;
END $$;
