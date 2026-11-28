-- 0740_personal_labels (contract 0.15.620): coloured labels on records (improvement list item 2).
-- Mirror: apps/api/prisma/migrations/0740_personal_labels/migration.sql (kept byte-identical).
--
-- Additive and personal. A label belongs to the person who made it and only that person sees it and the records it is on, so no one learns anything about
-- anyone else and no permission is widened. Labels are hidden (archived), never deleted; taking a label off a record removes only that link.
--   1. user_labels: name, colour from a fixed palette, active flag. At most 30 active labels per person, names unique per person among the active ones.
--   2. user_label_links: a label on a site or a register record (kind + id). No foreign key to the record: a record the person cannot read shows nothing
--      but their own label id, and the screens read the records through their own checks.
--   3. label_list(), label_save(), label_archive(), label_assign(), label_links().

CREATE TABLE user_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  colour      text NOT NULL CHECK (colour IN ('red','orange','amber','green','teal','blue','purple','pink','grey')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_labels_name_uq ON user_labels (user_id, lower(btrim(name))) WHERE is_active;

CREATE TABLE user_label_links (
  label_id    uuid NOT NULL REFERENCES user_labels(id) ON UPDATE CASCADE ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('site','register_record')),
  ref_id      uuid NOT NULL,
  context     text CHECK (context IS NULL OR context ~ '^[a-z][a-z0-9_-]{0,80}$'), -- the register key of a register record, so a list can link back to it
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (label_id, kind, ref_id)
);
CREATE INDEX user_label_links_ref ON user_label_links (user_id, kind, ref_id);

ALTER TABLE user_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON user_labels FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON user_labels FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE user_label_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_label_links FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON user_label_links FOR SELECT USING (app_is_seeding() OR user_id = app_actor());
CREATE POLICY rls_seed_write ON user_label_links FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

CREATE OR REPLACE FUNCTION label_json(l public.user_labels) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id', l.id, 'name', l.name, 'colour', l.colour, 'is_active', l.is_active,
    'link_count', (SELECT count(*) FROM public.user_label_links k WHERE k.label_id = l.id))
$$;

CREATE OR REPLACE FUNCTION label_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(public.label_json(l) ORDER BY lower(l.name)) FROM public.user_labels l WHERE l.user_id = a AND l.is_active), '[]'::jsonb);
END $$;

-- p_id NULL creates; otherwise renames or recolours one of the caller's own active labels.
CREATE OR REPLACE FUNCTION label_save(p_id uuid, p_name text, p_colour text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); l public.user_labels%ROWTYPE; n text := btrim(coalesce(p_name, ''));
BEGIN
  IF p_id IS NULL THEN
    IF n = '' OR char_length(n) > 40 THEN PERFORM public.sv_fail('validation_failed', 'A label name has 1 to 40 characters.'); END IF;
    IF p_colour IS NULL OR p_colour NOT IN ('red','orange','amber','green','teal','blue','purple','pink','grey') THEN PERFORM public.sv_fail('validation_failed', 'Choose a colour from the list.'); END IF;
    IF (SELECT count(*) FROM public.user_labels x WHERE x.user_id = a AND x.is_active) >= 30 THEN PERFORM public.sv_fail('validation_failed', 'At most 30 labels. Hide one you no longer use.'); END IF;
    IF EXISTS (SELECT 1 FROM public.user_labels x WHERE x.user_id = a AND x.is_active AND lower(btrim(x.name)) = lower(n)) THEN PERFORM public.sv_fail('duplicate', 'You already have a label with this name.'); END IF;
    INSERT INTO public.user_labels (user_id, name, colour) VALUES (a, n, p_colour) RETURNING * INTO l;
  ELSE
    SELECT * INTO l FROM public.user_labels x WHERE x.id = p_id AND x.user_id = a AND x.is_active;
    IF l.id IS NULL THEN PERFORM public.sv_fail('not_found', 'The label does not exist.'); END IF;
    IF p_name IS NOT NULL THEN
      IF n = '' OR char_length(n) > 40 THEN PERFORM public.sv_fail('validation_failed', 'A label name has 1 to 40 characters.'); END IF;
      IF EXISTS (SELECT 1 FROM public.user_labels x WHERE x.user_id = a AND x.is_active AND x.id <> l.id AND lower(btrim(x.name)) = lower(n)) THEN PERFORM public.sv_fail('duplicate', 'You already have a label with this name.'); END IF;
    END IF;
    IF p_colour IS NOT NULL AND p_colour NOT IN ('red','orange','amber','green','teal','blue','purple','pink','grey') THEN PERFORM public.sv_fail('validation_failed', 'Choose a colour from the list.'); END IF;
    UPDATE public.user_labels x SET name = CASE WHEN p_name IS NULL THEN x.name ELSE n END, colour = coalesce(p_colour, x.colour), updated_at = now() WHERE x.id = l.id RETURNING * INTO l;
  END IF;
  RETURN public.label_json(l);
END $$;

-- Hide (never delete): the label and its links stay in the table and drop out of every list.
CREATE OR REPLACE FUNCTION label_archive(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor(); l public.user_labels%ROWTYPE;
BEGIN
  UPDATE public.user_labels x SET is_active = false, updated_at = now() WHERE x.id = p_id AND x.user_id = a AND x.is_active RETURNING * INTO l;
  IF l.id IS NULL THEN PERFORM public.sv_fail('not_found', 'The label does not exist.'); END IF;
  RETURN public.label_json(l);
END $$;

CREATE OR REPLACE FUNCTION label_assign(p_label uuid, p_kind text, p_ref uuid, p_on boolean, p_context text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('site','register_record') OR p_ref IS NULL THEN PERFORM public.sv_fail('validation_failed', 'Give the kind and the id of the record.'); END IF;
  IF p_context IS NOT NULL AND (p_kind <> 'register_record' OR p_context !~ '^[a-z][a-z0-9_-]{0,80}$') THEN PERFORM public.sv_fail('validation_failed', 'The context is the register key of a register record.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_labels x WHERE x.id = p_label AND x.user_id = a AND x.is_active) THEN PERFORM public.sv_fail('not_found', 'The label does not exist.'); END IF;
  IF p_on THEN
    INSERT INTO public.user_label_links (label_id, user_id, kind, ref_id, context) VALUES (p_label, a, p_kind, p_ref, p_context) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.user_label_links k WHERE k.label_id = p_label AND k.user_id = a AND k.kind = p_kind AND k.ref_id = p_ref;
  END IF;
  RETURN jsonb_build_object('label_id', p_label, 'kind', p_kind, 'ref_id', p_ref, 'on', p_on, 'context', p_context);
END $$;

-- The caller's labels on records of one kind (optionally one record), active labels only: [{ref_id, label_ids}].
CREATE OR REPLACE FUNCTION label_links(p_kind text, p_ref uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.sv_actor();
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('site','register_record') THEN PERFORM public.sv_fail('validation_failed', 'Give the kind of the record.'); END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('ref_id', g.ref_id, 'context', g.ctx, 'label_ids', g.ids) ORDER BY g.ref_id)
    FROM (SELECT k.ref_id, max(k.context) AS ctx, jsonb_agg(k.label_id ORDER BY k.created_at, k.label_id) AS ids
          FROM public.user_label_links k JOIN public.user_labels l ON l.id = k.label_id AND l.is_active
          WHERE k.user_id = a AND k.kind = p_kind AND (p_ref IS NULL OR k.ref_id = p_ref) GROUP BY k.ref_id) g), '[]'::jsonb);
END $$;

-- Ownership and grants (0166 pattern)
DO $$
BEGIN
  ALTER TABLE user_labels OWNER TO pmis_definer;
  ALTER TABLE user_label_links OWNER TO pmis_definer;
  ALTER FUNCTION label_json(public.user_labels) OWNER TO pmis_definer;
  ALTER FUNCTION label_list() OWNER TO pmis_definer;
  ALTER FUNCTION label_save(uuid, text, text) OWNER TO pmis_definer;
  ALTER FUNCTION label_archive(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION label_assign(uuid, text, uuid, boolean, text) OWNER TO pmis_definer;
  ALTER FUNCTION label_links(text, uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION label_json(public.user_labels), label_list(), label_save(uuid, text, text), label_archive(uuid), label_assign(uuid, text, uuid, boolean, text), label_links(text, uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION label_json(public.user_labels), label_list(), label_save(uuid, text, text), label_archive(uuid), label_assign(uuid, text, uuid, boolean, text), label_links(text, uuid) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON user_labels, user_label_links TO pmis_app;
    GRANT EXECUTE ON FUNCTION label_list(), label_save(uuid, text, text), label_archive(uuid), label_assign(uuid, text, uuid, boolean, text), label_links(text, uuid) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): personal display data, KEPT with saved_views. Patch the accumulating function idempotently (0361 pattern).
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''user_labels''' IN def) = 0 THEN
    IF position('''saved_views''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    def := replace(def, '''saved_views''', '''saved_views'', ''user_labels'', ''user_label_links''');
  END IF;
  EXECUTE def;
END $$;

-- The reset owner may read and clear them (every table needs it, 0152).
GRANT SELECT, UPDATE ON public.user_labels TO pmis_reset_owner;
GRANT SELECT, UPDATE ON public.user_label_links TO pmis_reset_owner;
