-- 0323_site_code_references: the fields that name another site by its code are checked against the Site Register (RF & Design backup_site, Risks affected_site_ids).
-- Mirror: db/sql/322_site_code_references.sql (kept identical to prisma/migrations/0323_site_code_references/migration.sql).
--
--   The far-end site of a microwave link (mw_far_end_site) already has this rule (DQ04, 0025). The other two fields that hold site codes as typed text did not: a typo was kept.
--   The web form now picks them from the Site Register; this trigger makes the database agree. The stored value does not change (a site code, or codes joined by ", "), so
--   old records, the exports and every reader stay as they are. Additive: one row trigger, no new field, no table, no permission change, nothing deleted.
--   Rules (blocking, on a version in entry, and ONLY when the value differs from the previous version of the same row, so an old record with an unknown code is never blocked
--   by an edit of something else): every code must be an existing site (`unknown_site`); the backup site is another site than the record's own (`self_link`).
--   `N/A` and an empty value mean no site. `site_owner_id` is NOT a site reference (it is the tower owner's own ID of the site) and `cluster_id` has no list yet: both stay text.

CREATE OR REPLACE FUNCTION site_code_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  errs jsonb := '[]'::jsonb; k text; v text; c text; own text;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  k := CASE NEW.register_key WHEN 'rf_design' THEN 'backup_site' ELSE 'affected_site_ids' END;
  v := btrim(coalesce(NEW.data ->> k, ''));
  IF v = '' OR upper(v) = 'N/A' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND btrim(coalesce(OLD.data ->> k, '')) = v THEN RETURN NEW; END IF;
  SELECT s.site_code INTO own FROM public.sites s WHERE s.id = NEW.site_id;
  FOREACH c IN ARRAY regexp_split_to_array(v, '\s*[,;]\s*') LOOP
    CONTINUE WHEN btrim(c) = '' OR upper(btrim(c)) = 'N/A';
    IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.site_code = btrim(c)) THEN
      errs := errs || public.reg_err_item('/data/' || k, 'unknown_site', 'Every code must be an existing site: ' || btrim(c) || '.');
    ELSIF k = 'backup_site' AND btrim(c) = own THEN
      errs := errs || public.reg_err_item('/data/' || k, 'self_link', 'The backup must be another site.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_site_code_references BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key IN ('rf_design', 'risks')) EXECUTE FUNCTION site_code_references();

ALTER FUNCTION site_code_references() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION site_code_references() FROM PUBLIC;
