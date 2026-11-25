-- 0158_site_master_db_names: the database names "site360..." become "site_master..." (owner approval 2026-11-25 16:52, PR #214; contract 0.15.75).
-- Mirror: db/sql/157_site_master_db_names.sql (kept byte-identical).
--
--   1. master_columns.site360_sections becomes site_master_sections, with its CHECK constraint.
--   2. The views site360_master_values and site360_task_cells become site_master_values and site_master_task_cells (ALTER ... RENAME:
--      owner, grants, security_invoker and the views that read them follow by object id).
--   3. Every function named site360_* is renamed with ALTER FUNCTION ... RENAME (owner, grants, SECURITY DEFINER and search_path stay as they are;
--      a function is never dropped and created again, because that would lose its grants).
--   4. Every function in public whose text still holds the old name (the Master doors, the saved-view functions with the screen keys
--      site360-<menu>, the Daily Plan copy) is rewritten in place with CREATE OR REPLACE (same name, same grants): site360_ -> site_master_,
--      site360- -> site-master-, site360. -> site_master. (the audit action of new events), "SITE 360" in a message -> "Site Master".
--   5. Saved views: saved_views.screen_key site360-<menu> becomes site-master-<menu>. The versions of a view (append-only snapshots)
--      and the audit log keep what was said at the time and are not rewritten. The API still accepts the old screen key for one release
--      and reads it as the new one.
-- Nothing is kept under the old database names: they are called only by the API of the same release.
ALTER TABLE master_columns RENAME COLUMN site360_sections TO site_master_sections;
ALTER TABLE master_columns RENAME CONSTRAINT master_columns_site360_sections_chk TO master_columns_site_master_sections_chk;
ALTER VIEW site360_master_values RENAME TO site_master_values;
ALTER VIEW site360_task_cells RENAME TO site_master_task_cells;

DO $$
DECLARE r record; def text; nd text; n integer := 0;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.proname LIKE 'site360\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER FUNCTION %s RENAME TO %I', r.sig, replace(r.proname, 'site360_', 'site_master_'));
  END LOOP;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.prokind = 'f' AND (p.prosrc LIKE '%site360%' OR p.prosrc LIKE '%SITE 360%') ORDER BY p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    nd := replace(replace(replace(replace(replace(def, 'site360_', 'site_master_'), 'site360-', 'site-master-'), 'site360.', 'site_master.'), 'SITE 360', 'Site Master'), 'site360', 'site_master');
    IF nd <> def THEN EXECUTE nd; n := n + 1; END IF;
  END LOOP;
  RAISE NOTICE '0158: % functions rewritten', n;
END $$;

UPDATE saved_views SET screen_key = 'site-master-' || substr(screen_key, 8) WHERE screen_key LIKE 'site360-%';
