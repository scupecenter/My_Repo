-- 0591: doc_live_spec listed every placement twice for a task that exists in both workflow v1 and the seeded draft v2
-- (0547 copied document_type_placements to the v2 task rows, so the join matched both versions' rows of the same task
-- code). The library screen showed A2, B9, ... with their task placement doubled. Dedupe identical placements.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.doc_live_spec(uuid)'::regprocedure);
  IF position('SELECT DISTINCT k, p FROM' IN def) > 0 THEN RETURN; END IF;
  IF position(E'SELECT coalesce(jsonb_agg(x.p ORDER BY x.k), \'[]\'::jsonb) INTO pl FROM (' IN def) = 0
     OR position(E'WHERE p.doc_type_id = p_id) x;' IN def) = 0 THEN
    RAISE EXCEPTION 'doc_live_spec() has no placements anchor to patch';
  END IF;
  def := replace(def,
    E'SELECT coalesce(jsonb_agg(x.p ORDER BY x.k), \'[]\'::jsonb) INTO pl FROM (',
    E'SELECT coalesce(jsonb_agg(x.p ORDER BY x.k), \'[]\'::jsonb) INTO pl FROM (SELECT DISTINCT k, p FROM (');
  def := replace(def, E'WHERE p.doc_type_id = p_id) x;', E'WHERE p.doc_type_id = p_id) d) x;');
  EXECUTE def;
END $$;
