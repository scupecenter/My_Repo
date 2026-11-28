-- 0641: the data reset preview shows the links that would dangle (contract 0.15.570). Information first, never blocking.
-- A record of a register that is NOT in the scope can point at a record that IS (today: data ->> 'procurement_record_id', the link the closure of the parts follows
-- for invoices, advances and car bookings). The closure already takes the parts that depend on a chosen part; this counts what is left outside it, per part that
-- points and per part pointed at, so the System Admin sees it before asking for the reset and can add the part to the scope with one click (the screen only changes the
-- chosen parts; the closure, the hash and the four-eyes approval stay exactly as they are). Nothing is deleted or blocked by this count; it is read only.
-- Additive: one read-only function and an in-place patch (from the stored text, asserted, idempotent) of data_reset_plan_json. No table, no grant on a table, no right.

CREATE OR REPLACE FUNCTION data_reset_dangling_links(p_parts text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH c AS (SELECT public.data_reset_closure(p_parts) AS parts),
  src AS (
    SELECT rr.id, rr.data ->> 'procurement_record_id' AS k,
           CASE WHEN rr.register_key = 'contractors' OR (rr.register_key = 'car_dispatcher' AND rr.record_type = 'vehicle') THEN NULL
                ELSE coalesce(public.data_reset_register_part(rr.register_key), 'sites') END AS sp
    FROM public.register_records rr WHERE rr.data ? 'procurement_record_id' AND coalesce(rr.data ->> 'procurement_record_id', '') <> ''
  ), hit AS (
    SELECT s.id, s.sp, coalesce(public.data_reset_register_part(t.register_key), 'sites') AS tp
    FROM src s CROSS JOIN c
    JOIN public.register_records t ON t.id::text = s.k OR t.entity_id::text = s.k
    WHERE s.sp IS NOT NULL AND NOT (s.sp = ANY (c.parts)) AND coalesce(public.data_reset_register_part(t.register_key), 'sites') = ANY (c.parts)
  ), g AS (SELECT sp, tp, count(DISTINCT id) AS n FROM hit GROUP BY sp, tp)
  SELECT coalesce(jsonb_agg(jsonb_build_object('source_part', g.sp, 'target_part', g.tp, 'links', g.n,
           'source_label_en', ps.label_en, 'source_label_ar', ps.label_ar, 'target_label_en', pt.label_en, 'target_label_ar', pt.label_ar)
         ORDER BY ps.ord, pt.ord), '[]'::jsonb)
  FROM g JOIN public.data_reset_parts() ps ON ps.code = g.sp JOIN public.data_reset_parts() pt ON pt.code = g.tp
$$;
COMMENT ON FUNCTION data_reset_dangling_links(text[]) IS '0641: links of records outside the scope that point at records inside it (read only, for the reset preview).';
REVOKE ALL ON FUNCTION data_reset_dangling_links(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_reset_dangling_links(text[]) TO pmis_reset_owner, pmis_definer, pmis_identity_owner;

DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan_json(text[])'::regprocedure);
  IF position('data_reset_dangling_links' IN def) = 0 THEN
    n := E'''error'', err,';
    IF length(def) - length(replace(def, n, '')) <> length(n) THEN RAISE EXCEPTION 'data_reset_plan_json: the error key is not there exactly once'; END IF;
    def := replace(def, n, n || E'\n    ''dangling_links'', public.data_reset_dangling_links(p_parts),');
    EXECUTE def;
  END IF;
END $$;
