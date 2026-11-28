-- 0631_stock_reorder_draft_pr: the low-stock kind opens a prefilled purchase request (extras item 3; contract 0.15.490). Additive, notifications only.
-- Mirror: db/sql/630_stock_reorder_draft_pr.sql (kept identical to prisma/migrations/0631_stock_reorder_draft_pr/migration.sql).
--
--   stock_below_reorder (0475) gains one optional param: {draft_pr: true}. The notification of such a rule links to the new Procurement form with the request
--   type PR and a remark that names the item, the available stock, the level and the suggested quantity (the reorder quantity of the item, when set). The link is
--   a form: nothing is created until a person who may create Procurement records submits it, so the Matrix, the grants and the approval chain apply as for any
--   request (the same way as the Draft button of a shortage line). The rule never creates a record. Without the param, the behaviour of 0475 is unchanged.
-- url_enc_basic(text): percent-encodes the characters that break a query string. The params check and alert_rules_run() are patched in place and idempotently
-- (anchor checks raise when missing). No table, no reset-plan change, no grant to a user role.

CREATE OR REPLACE FUNCTION url_enc_basic(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '%', '%25'), ' ', '%20'), '&', '%26'), '#', '%23'), '+', '%2B'), '?', '%3F'), '=', '%3D'), '/', '%2F'), ',', '%2C'), ':', '%3A')
$$;

-- 1. the params check of the kind
DO $$
DECLARE def text; pat text := 'p_kind = ''stock_below_reorder'' THEN(\s+)IF p_params <> ''\{\}''::jsonb THEN';
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('draft_pr' IN def) = 0 THEN
    IF regexp_replace(def, pat, 'X') = def THEN RAISE EXCEPTION 'alert_rule_params_errs: the stock_below_reorder anchor was not found'; END IF;
    EXECUTE regexp_replace(def, pat, 'p_kind = ''stock_below_reorder'' THEN\1IF p_params - ''draft_pr'' <> ''{}''::jsonb OR (p_params ? ''draft_pr'' AND jsonb_typeof(p_params -> ''draft_pr'') <> ''boolean'') THEN');
  END IF;
END $$;

-- 2. the link of the notification
DO $$
DECLARE def text; old text := 'coalesce(r.link, ''/warehouse''), ''warehouse'');';
BEGIN
  def := pg_get_functiondef('public.alert_rules_run(date)'::regprocedure);
  IF position('from=reorder' IN def) = 0 THEN
    IF position(old IN def) = 0 THEN RAISE EXCEPTION 'alert_rules_run: the stock_below_reorder link anchor was not found'; END IF;
    EXECUTE replace(def, old, 'CASE WHEN coalesce(r.params ->> ''draft_pr'', ''false'') = ''true'' THEN ''/registers/procurement?record=new&from=reorder&remark='' || public.url_enc_basic(''Reorder '' || c.item_code || '': available '' || c.available::text || '', level '' || c.reorder_level::text || coalesce('', suggested quantity '' || c.reorder_qty::text, '''')) ELSE coalesce(r.link, ''/warehouse'') END, ''warehouse'');');
  END IF;
END $$;

DO $$
BEGIN
  ALTER FUNCTION url_enc_basic(text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION url_enc_basic(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION url_enc_basic(text) TO pmis_definer;
END $$;
