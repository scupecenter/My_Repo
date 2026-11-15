-- 0099 (plan F4, contract 0.15.16): global search (Ctrl+K) with Arabic normalisation.
-- Search is read only. It adds no right: the API checks each group's module and region (access.regions, as the list screens do),
-- and row-level security still applies. This migration adds the matching rules and one indexed, generated search column per searched table.
--
-- Normalisation (search_norm, the same text on both sides of a match): Latin diacritics removed (unaccent), tashkeel, tatweel and
-- zero-width marks removed, alef forms (أ إ آ ٱ) to bare alef, taa marbuta to haa, alef maqsura and hamza-on-yaa to yaa, hamza-on-waw
-- to waw, Arabic-Indic and Persian digits to Latin digits, lower case. Immutable, so it can be used in a generated column.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() itself is STABLE and cannot be used in a generated column; this wrapper pins the dictionary.
CREATE OR REPLACE FUNCTION search_unaccent(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;

CREATE OR REPLACE FUNCTION search_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT lower(translate(
    regexp_replace(search_unaccent(coalesce(t, '')), '[\u064B-\u065F\u0670\u0640\u200C-\u200F]', '', 'g'),
    'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
    'اااايهوي01234567890123456789'))
$$;

-- The values of a jsonb object as one text (register records keep their fields in data). Keys are sorted, so the text is stable.
CREATE OR REPLACE FUNCTION search_jsonb_text(d jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(string_agg(e.v, ' ' ORDER BY e.k), '') FROM jsonb_each_text(coalesce(d, '{}'::jsonb)) AS e(k, v)
$$;

-- One generated column and one trigram GIN index per searched table.
ALTER TABLE sites ADD COLUMN search_text text GENERATED ALWAYS AS (
  search_norm(coalesce(site_code, '') || ' ' || coalesce(owner_site_id, '') || ' ' || coalesce(name, '') || ' ' || coalesce(name_ar, ''))
) STORED;
CREATE INDEX sites_search_trgm ON sites USING gin (search_text gin_trgm_ops);

ALTER TABLE register_records ADD COLUMN search_text text GENERATED ALWAYS AS (
  search_norm(coalesce(register_key, '') || ' ' || coalesce(record_type, '') || ' ' || search_jsonb_text(data))
) STORED;
CREATE INDEX register_records_search_trgm ON register_records USING gin (search_text gin_trgm_ops);

ALTER TABLE document_files ADD COLUMN search_text text GENERATED ALWAYS AS (
  search_norm(coalesce(original_name, '') || ' ' || coalesce(stored_name, ''))
) STORED;
CREATE INDEX document_files_search_trgm ON document_files USING gin (search_text gin_trgm_ops);

ALTER TABLE meetings ADD COLUMN search_text text GENERATED ALWAYS AS (search_norm(coalesce(title, ''))) STORED;
CREATE INDEX meetings_search_trgm ON meetings USING gin (search_text gin_trgm_ops);

ALTER TABLE users ADD COLUMN search_text text GENERATED ALWAYS AS (
  search_norm(coalesce(display_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(employee_id, ''))
) STORED;
CREATE INDEX users_search_trgm ON users USING gin (search_text gin_trgm_ops);

ALTER TABLE external_parties ADD COLUMN search_text text GENERATED ALWAYS AS (
  search_norm(coalesce(name, '') || ' ' || coalesce(contract_ref, ''))
) STORED;
CREATE INDEX external_parties_search_trgm ON external_parties USING gin (search_text gin_trgm_ops);
