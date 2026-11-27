-- 0345_record_edit_presence (contract 0.15.246): a soft "… is editing this record" notice (owner request 2026-11-27, item 17 of the
-- PM-platforms research; Google Docs style presence, advisory only). Mirror: db/sql/344_record_edit_presence.sql (kept identical).
--
-- Additive. A notice, never a lock: nothing is blocked, hidden or widened. The signal is the editor's own heartbeat; a reader sees only the
-- display name of another editor of the same record, exactly what a colleague already sees on the record itself. No grant, role, permission,
-- visibility or audit change (personal activity signal, like the online/idle presence of user_state).
--   1. record_edit_presence: one row per user and edited entity, refreshed by the heartbeat (30 s), stale after 2 minutes.
--   2. edit_presence_ping(text, text): upsert the caller's row (kind 'record' = a register record, 'task' = a workflow task) and sweep stale rows.
--   3. edit_presence_list(text, text): the other current editors of the entity (id, display name, since), freshest first.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE record_edit_presence (
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  entity_kind text NOT NULL CHECK (entity_kind IN ('record', 'task')),
  entity_id   uuid NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_kind, entity_id)
);
CREATE INDEX record_edit_presence_entity ON record_edit_presence (entity_kind, entity_id);

ALTER TABLE record_edit_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_edit_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON record_edit_presence FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON record_edit_presence FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Heartbeat (also sweeps stale rows)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edit_presence_ping(p_kind text, p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  DELETE FROM public.record_edit_presence p WHERE p.seen_at < now() - interval '2 minutes';
  INSERT INTO public.record_edit_presence (user_id, entity_kind, entity_id) VALUES (a, p_kind, p_entity)
  ON CONFLICT (user_id, entity_kind, entity_id) DO UPDATE SET seen_at = now();
  RETURN jsonb_build_object('ok', true);
END $$;

-- The caller stops editing (closed the editor): the row goes at once instead of fading out.
CREATE OR REPLACE FUNCTION edit_presence_stop(p_kind text, p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  DELETE FROM public.record_edit_presence p WHERE p.user_id = a AND p.entity_kind = p_kind AND p.entity_id = p_entity;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The other current editors
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edit_presence_list(p_kind text, p_entity uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', btrim(u.employee_id), 'since', p.started_at) ORDER BY p.started_at), '[]'::jsonb)
  FROM public.record_edit_presence p JOIN public.users u ON u.id = p.user_id
  WHERE p.entity_kind = p_kind AND p.entity_id = p_entity AND p.user_id <> public.sv_actor() AND p.seen_at > now() - interval '2 minutes'
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and grants (0166 pattern)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE record_edit_presence OWNER TO pmis_definer;
  ALTER FUNCTION edit_presence_ping(text, uuid) OWNER TO pmis_definer;
  ALTER FUNCTION edit_presence_stop(text, uuid) OWNER TO pmis_definer;
  ALTER FUNCTION edit_presence_list(text, uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION edit_presence_ping(text, uuid), edit_presence_stop(text, uuid), edit_presence_list(text, uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION edit_presence_ping(text, uuid), edit_presence_stop(text, uuid), edit_presence_list(text, uuid) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON record_edit_presence TO pmis_app;
    GRANT EXECUTE ON FUNCTION edit_presence_ping(text, uuid), edit_presence_stop(text, uuid), edit_presence_list(text, uuid) TO pmis_app;
  END IF;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- Data reset coverage (0152): record_edit_presence is transient runtime state with a FK only to users (KEEP, with user_sessions).
-- data_reset_plan() is an accumulating function: patch the stored text idempotently (0361 pattern), never redefine it from an old base.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''record_edit_presence''' IN def) = 0 THEN
    IF position('''user_sessions''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''user_sessions''', '''user_sessions'', ''record_edit_presence''');
  END IF;
  EXECUTE def;
END $$;

-- the reset role reads every classified table and takes the share lock of a KEEP table (0152 privilege check)
GRANT SELECT, UPDATE ON public.record_edit_presence TO pmis_reset_owner;
