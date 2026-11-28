-- 0765 (contract 0.15.645): lessons learned that may apply to a new Issue. Additive: one read-only function, no table, no data change.
--
-- WHAT. lessons_suggest(site, text, limit) lists up to 5 (at most 10) approved, current Lessons Learned records that share words with what is being typed in a new Issue
-- (title, description, remark). A lesson needs to match at least two different words (one when the text has only one usable word); words shorter than 3 letters and the
-- common English words are ignored. Order: more matching words first, then closer text, then a lesson of the same site, then the newest. The words are matched whole and as typed
-- (no stemming, no translation; split on spaces and punctuation, so it does not depend on the database locale), so Arabic and English both work and neither is translated into the other.
-- RIGHTS. SECURITY INVOKER, like record_related(): only lessons in the regions where the caller holds the view right of the Lessons Learned register (the Matrix decides;
-- a System Admin sees all). A caller without that right gets an empty list, never an error. Nothing is stored, nothing is linked, the Issue is not changed.

CREATE OR REPLACE FUNCTION lessons_suggest(p_site uuid, p_text text, p_limit integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  regs int[];
  toks text[];
  need integer;
  lim integer := least(greatest(coalesce(p_limit, 5), 1), 10);
  stop text[] := ARRAY['the','and','for','with','that','this','from','was','were','are','has','have','had','not','but','all','any','can','will','would','should','could','been','being','than','then','there','their','they','them','its','our','out','off','into','onto','per','via','too','also','when','what','which','who','how','why','new','one','two'];
  out jsonb;
BEGIN
  regs := public.wf_actor_regions('lessons_learned', 'view');
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN RETURN '[]'::jsonb; END IF;
  toks := ARRAY(SELECT t FROM (SELECT DISTINCT t FROM regexp_split_to_table(lower(coalesce(left(p_text, 2000), '')), '[[:space:][:punct:]،؛؟«»“”]+') t) w
                 WHERE char_length(t) >= 3 AND NOT (t = ANY (stop)) ORDER BY t LIMIT 30);
  IF cardinality(toks) = 0 THEN RETURN '[]'::jsonb; END IF;
  need := least(2, cardinality(toks));
  SELECT coalesce(jsonb_agg(j ORDER BY m DESC, rnk DESC, same DESC, d DESC NULLS LAST), '[]'::jsonb) INTO out FROM (
    SELECT s.m, s.rnk, s.same, s.d,
           jsonb_build_object('id', s.id, 'entity_id', s.entity_id, 'title', s.title, 'category', s.category, 'lesson', left(s.lesson, 300), 'recommendation', left(s.rec, 300),
                              'lesson_date', s.d, 'site_code', s.site_code, 'same_site', s.same, 'matches', s.m) AS j
      FROM (
        SELECT x.id, x.entity_id, x.data ->> 'title' AS title, x.data ->> 'category' AS category, x.data ->> 'lesson' AS lesson, x.data ->> 'recommendation' AS rec,
               nullif(x.data ->> 'lesson_date', '') AS d, st.site_code, (x.site_id IS NOT DISTINCT FROM p_site AND p_site IS NOT NULL) AS same,
               (cardinality(ARRAY(SELECT unnest(toks) INTERSECT SELECT unnest(doc.v)))::numeric / sqrt(greatest(cardinality(doc.v), 1))) AS rnk,
               cardinality(ARRAY(SELECT unnest(toks) INTERSECT SELECT unnest(doc.v)))::int AS m
          FROM public.register_records x
          LEFT JOIN public.sites st ON st.id = x.site_id
          CROSS JOIN LATERAL (SELECT ARRAY(SELECT DISTINCT w FROM regexp_split_to_table(lower(coalesce(x.data ->> 'title', '') || ' ' || coalesce(x.data ->> 'lesson', '') || ' ' || coalesce(x.data ->> 'description', '')
                                                  || ' ' || coalesce(x.data ->> 'recommendation', '') || ' ' || coalesce(x.data ->> 'category', '')), '[[:space:][:punct:]،؛؟«»“”]+') w WHERE w <> '') AS v) doc
         WHERE x.register_key = 'lessons_learned' AND x.is_current AND x.state = 'approved'
           AND (regs IS NULL OR x.is_global OR x.region_id = ANY (regs))
           AND doc.v && toks
      ) s
     WHERE s.m >= need
     ORDER BY s.m DESC, s.rnk DESC, s.same DESC, s.d DESC NULLS LAST
     LIMIT lim
  ) z;
  RETURN out;
END $$;

DO $$
BEGIN
  ALTER FUNCTION lessons_suggest(uuid, text, integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION lessons_suggest(uuid, text, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION lessons_suggest(uuid, text, integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION lessons_suggest(uuid, text, integer) TO pmis_app; END IF;
END $$;
