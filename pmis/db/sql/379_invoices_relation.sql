-- 0380_invoices_relation: the Invoices register (0185) links to the procurement record it bills. The link field procurement_record_id is listed in
-- record_related() (created by 0324) so the Related-records panel shows the invoices of an order and the order of an invoice. Patched in place and
-- idempotent (never a whole redefinition), so links added by other migrations stay. Mirror: db/sql/379_invoices_relation.sql (kept identical).
DO $$
DECLARE def text; marker text := E'\n    ) v(from_register, field, to_register)';
BEGIN
  def := pg_get_functiondef('public.record_related(text,uuid)'::regprocedure);
  IF position('''invoices''' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'record_related() has no link list to patch'; END IF;
    EXECUTE replace(def, marker, E',\n      (''invoices'',           ''procurement_record_id'', ''procurement'')' || marker);
  END IF;
END $$;
