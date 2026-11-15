-- 0099 (plan F4, contract 0.15.16): global search (Ctrl+K) with Arabic normalisation.
-- Search is read only. It adds no right: the API checks each group's module and region (access.regions, as the list screens do),
-- and row-level security still applies. This migration adds the matching rules and one immutable search function and one GIN trigram index on it per searched table. No stored column: a stored generated column reads as NULL
-- in a BEFORE UPDATE trigger, so the whole-row guards of 0009 and 0038 would reject every update of users and document_files.
--
-- Normalisation (search_norm, the same text on both sides of a match): Latin diacritics removed (unaccent), tashkeel, tatweel and
-- zero-width marks removed, alef forms (أ إ آ ٱ) to bare alef, taa marbuta to haa, alef maqsura and hamza-on-yaa to yaa, hamza-on-waw
-- to waw, Arabic-Indic and Persian digits to Latin digits, lower case. Immutable, so it can be used in an index expression.

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
-- Per-table search text (IMMUTABLE, used by the GIN indexes below and by the same calls in search.service.ts).
CREATE OR REPLACE FUNCTION search_sites_text(site_code text, owner_site_id text, name text, name_ar text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT search_norm(coalesce(site_code, '') || ' ' || coalesce(owner_site_id, '') || ' ' || coalesce(name, '') || ' ' || coalesce(name_ar, ''))
$$;
CREATE OR REPLACE FUNCTION search_register_text(register_key text, record_type text, data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT search_norm(coalesce(register_key, '') || ' ' || coalesce(record_type, '') || ' ' || search_jsonb_text(data))
$$;
-- original_name only: stored_name may change on a stored file (guard in 0038)
CREATE OR REPLACE FUNCTION search_document_text(original_name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT search_norm(coalesce(original_name, ''))
$$;
CREATE OR REPLACE FUNCTION search_meeting_text(title text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT search_norm(coalesce(title, ''))
$$;
CREATE OR REPLACE FUNCTION search_user_text(display_name text, email text, employee_id text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT search_norm(coalesce(display_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(employee_id, ''))
$$;
CREATE OR REPLACE FUNCTION search_party_text(name text, contract_ref text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT search_norm(coalesce(name, '') || ' ' || coalesce(contract_ref, ''))
$$;

CREATE INDEX sites_search_trgm ON sites USING gin (search_sites_text(site_code, owner_site_id, name, name_ar) gin_trgm_ops);
CREATE INDEX register_records_search_trgm ON register_records USING gin (search_register_text(register_key, record_type, data) gin_trgm_ops);
CREATE INDEX document_files_search_trgm ON document_files USING gin (search_document_text(original_name) gin_trgm_ops);
CREATE INDEX meetings_search_trgm ON meetings USING gin (search_meeting_text(title) gin_trgm_ops);
CREATE INDEX users_search_trgm ON users USING gin (search_user_text(display_name, email, employee_id) gin_trgm_ops);
CREATE INDEX external_parties_search_trgm ON external_parties USING gin (search_party_text(name, contract_ref) gin_trgm_ops);
