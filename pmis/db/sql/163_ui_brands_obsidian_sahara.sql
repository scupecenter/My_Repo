-- 0164: two more UI designs, `obsidian` and `sahara` (owner approval 2026-11-26 00:57, contract 0.15.81).
-- Visual only: the web tokens of each design (styles/tokens.css) never touch the status colours. The four existing designs, the light/dark theme and
-- the storage (users.ui_brand, setting ui.identity) are unchanged; this only widens the list of allowed names.
--   * users_ui_brand_check now allows the six names. Every existing value stays valid, so no row changes.
--   * ui_brands() (the list the helpers and the write doors check against) returns the six. CREATE OR REPLACE keeps its owner and grants.
-- No new table, no grant, no role or default change. The organization default stays what it is today.
ALTER TABLE users DROP CONSTRAINT users_ui_brand_check;
ALTER TABLE users ADD CONSTRAINT users_ui_brand_check
  CHECK (ui_brand IS NULL OR ui_brand IN ('current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara'));
COMMENT ON COLUMN users.ui_brand IS '0130/0164: the UI design the user chose (current, aljeel, executive, field, obsidian, sahara); null = follow the organization default (setting ui.identity). Written only by idm_update_own_profile.';

CREATE OR REPLACE FUNCTION ui_brands() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara']::text[]
$$;
