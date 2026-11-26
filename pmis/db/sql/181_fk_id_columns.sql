-- 0182_fk_id_columns: foreign keys for id columns that had none (relations map PR 254, section 4 item 5).
-- Mirror: db/sql/181_fk_id_columns.sql (kept identical to prisma/migrations/0182_fk_id_columns/migration.sql).
--
--   Six id columns hold the id of a company, a team or a snag but had no REFERENCES constraint, so the database could not refuse a dangling id. Each constraint is
--   added only after an orphan check: when the column holds no orphan the constraint is added NOT VALID and then VALIDATEd; when it does hold orphans the constraint
--   is still added NOT VALID (every NEW or changed row is checked, the old rows are not touched) and a NOTICE names the count, so the migration never fails on
--   existing data and never deletes or edits a row. The action on delete is RESTRICT for companies and teams (hidden, never deleted); for quality_inspections.snag_id it is SET NULL, because the data reset deletes snags before inspections (an inspection keeps its own record code). On update NO ACTION.
--   No permission, grant, policy or table change. Re-run the check later with fk_orphan_report().

CREATE OR REPLACE FUNCTION fk_orphan_report() RETURNS TABLE (constraint_name text, orphans bigint, validated boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c record; n bigint;
BEGIN
  FOR c IN SELECT k.conname, k.convalidated, k.conrelid::regclass AS child, k.confrelid::regclass AS parent, a.attname AS ccol, b.attname AS pcol
           FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] JOIN pg_attribute b ON b.attrelid = k.confrelid AND b.attnum = k.confkey[1]
           WHERE k.conname LIKE '%\_idfk' ORDER BY k.conname LOOP
    EXECUTE format('SELECT count(*) FROM %s ch WHERE ch.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE p.%I = ch.%I)', c.child, c.ccol, c.parent, c.pcol, c.ccol) INTO n;
    constraint_name := c.conname; orphans := n; validated := c.convalidated; RETURN NEXT;
  END LOOP;
END $$;

DO $$
DECLARE
  d record; n bigint;
BEGIN
  FOR d IN SELECT * FROM (VALUES
    ('procurement_records',  'party_id',            'external_parties', 'id', 'RESTRICT'),
    ('procurement_records',  'team_id',             'external_teams',   'id', 'RESTRICT'),
    ('snags',                'responsible_party_id','external_parties', 'id', 'RESTRICT'),
    ('issues',               'party_id',            'external_parties', 'id', 'RESTRICT'),
    ('quality_inspections',  'party_id',            'external_parties', 'id', 'RESTRICT'),
    ('quality_inspections',  'snag_id',             'snags',            'id', 'SET NULL'),
    ('external_teams',       'party_id',            'external_parties', 'id', 'RESTRICT')
  ) AS v(child, col, parent, pcol, on_delete) LOOP
    -- skip a column that already has a foreign key, and a table or column that does not exist
    CONTINUE WHEN to_regclass('public.' || d.child) IS NULL OR to_regclass('public.' || d.parent) IS NULL;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = d.child AND column_name = d.col);
    CONTINUE WHEN EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                          WHERE k.contype = 'f' AND k.conrelid = ('public.' || d.child)::regclass AND k.confrelid = ('public.' || d.parent)::regclass AND a.attname = d.col AND cardinality(k.conkey) = 1);
    EXECUTE format('SELECT count(*) FROM public.%I ch WHERE ch.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = ch.%I)', d.child, d.col, d.parent, d.pcol, d.col) INTO n;
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I (%I) ON DELETE ' || d.on_delete || ' NOT VALID', d.child, d.child || '_' || d.col || '_idfk', d.col, d.parent, d.pcol);
    IF n = 0 THEN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', d.child, d.child || '_' || d.col || '_idfk');
    ELSE
      RAISE NOTICE 'fk %.%: % orphan row(s), constraint left NOT VALID (new rows are checked); see fk_orphan_report()', d.child, d.col, n;
    END IF;
  END LOOP;
END $$;

ALTER FUNCTION fk_orphan_report() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION fk_orphan_report() FROM PUBLIC;
