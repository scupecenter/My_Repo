-- 0212_party_contract_dates_derived: the contract dates of an external party have ONE source, its contracts (external_party_contracts).
-- Mirror: db/sql/211_party_contract_dates_derived.sql (kept identical to prisma/migrations/0212_party_contract_dates_derived/migration.sql).
--
--   Before: external_parties.contract_start / contract_end were written from the company record, and external_party_contracts.start_date / end_date from the same record and
--   from the Contractors "contract" records, so a company with a later contract showed two different end dates (the performance view used the contract first and the company
--   date as a fallback). Now: the contracts table is the source; the party columns are kept (nothing is removed, old readers keep working) but are a MIRROR the database
--   rebuilds on every change of a contract: contract_start = the earliest start and contract_end = the latest end of the party's active contracts (an active contract without
--   an end date, an open-ended contract, leaves contract_end empty). A party with no active contract row keeps what it has (older data is never cleared).
--   Additive: one function, one trigger, one backfill of the mirror. No new field or table, no permission change.

CREATE OR REPLACE FUNCTION party_contract_dates_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pid uuid := coalesce(NEW.party_id, OLD.party_id); s date; e date; n int; open_ended boolean;
BEGIN
  SELECT count(*)::int, min(c.start_date), max(c.end_date), bool_or(c.end_date IS NULL)
    INTO n, s, e, open_ended
    FROM public.external_party_contracts c WHERE c.party_id = pid AND c.status = 'active';
  IF n > 0 THEN
    UPDATE public.external_parties p SET contract_start = s, contract_end = CASE WHEN open_ended THEN NULL ELSE e END
      WHERE p.id = pid AND (p.contract_start IS DISTINCT FROM s OR p.contract_end IS DISTINCT FROM (CASE WHEN open_ended THEN NULL ELSE e END));
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.party_id IS DISTINCT FROM NEW.party_id THEN
    SELECT count(*)::int, min(c.start_date), max(c.end_date), bool_or(c.end_date IS NULL)
      INTO n, s, e, open_ended
      FROM public.external_party_contracts c WHERE c.party_id = OLD.party_id AND c.status = 'active';
    IF n > 0 THEN
      UPDATE public.external_parties p SET contract_start = s, contract_end = CASE WHEN open_ended THEN NULL ELSE e END WHERE p.id = OLD.party_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_party_contract_dates AFTER INSERT OR UPDATE OR DELETE ON external_party_contracts
  FOR EACH ROW EXECUTE FUNCTION party_contract_dates_sync();

ALTER FUNCTION party_contract_dates_sync() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION party_contract_dates_sync() FROM PUBLIC;

-- Backfill of the mirror from the contracts that already exist.
UPDATE external_parties p SET contract_start = x.s, contract_end = CASE WHEN x.open_ended THEN NULL ELSE x.e END
FROM (SELECT c.party_id, min(c.start_date) AS s, max(c.end_date) AS e, bool_or(c.end_date IS NULL) AS open_ended
        FROM external_party_contracts c WHERE c.status = 'active' GROUP BY c.party_id) x
WHERE p.id = x.party_id AND (p.contract_start IS DISTINCT FROM x.s OR p.contract_end IS DISTINCT FROM (CASE WHEN x.open_ended THEN NULL ELSE x.e END));
