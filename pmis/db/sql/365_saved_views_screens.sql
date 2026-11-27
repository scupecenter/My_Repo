-- 0366: the saved-views bar reaches the Warehouse lists, the Library forms list, the Inbox and Messages (owner decision 35, review item 6).
--
-- WHAT. Saved views keep any screen key; sv_screen_module(screen) tells which module's regions bound a SHARED view that filters on regions. The new screen keys:
--   warehouse-items, warehouse-movements, warehouse-stock, warehouse-dispatch -> module warehouse; library-forms -> sites.documents (like library-archive).
--   inbox and messages are personal lists (no region scope), so they stay NULL like my-work.
-- HOW. The stored text of sv_screen_module is patched IN PLACE and idempotently (each WHEN line is added only if missing), never redefined whole, so no screen added by
-- another migration is lost. No table, no permission, no data change.
DO $$
DECLARE def text; k text; m text;
BEGIN
  def := pg_get_functiondef('public.sv_screen_module(text)'::regprocedure);
  FOR k, m IN SELECT * FROM (VALUES ('warehouse-items', 'warehouse'), ('warehouse-movements', 'warehouse'), ('warehouse-stock', 'warehouse'), ('warehouse-dispatch', 'warehouse'), ('library-forms', 'sites.documents')) v(k, m) LOOP
    IF position('WHEN ''' || k || ''' THEN' IN def) = 0 THEN
      IF position('ELSE NULL END' IN def) = 0 THEN RAISE EXCEPTION 'sv_screen_module: the ELSE branch was not found'; END IF;
      def := replace(def, 'ELSE NULL END', 'WHEN ''' || k || ''' THEN ''' || m || '''' || chr(10) || '    ELSE NULL END');
    END IF;
  END LOOP;
  EXECUTE def;
END $$;
