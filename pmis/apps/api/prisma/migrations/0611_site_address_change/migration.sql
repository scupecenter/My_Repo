-- 0611_site_address_change (contract 0.15.471): the address of a site can be proposed through Change Control (A1b), like the Arabic name.
-- Mirror: db/sql/610_site_address_change.sql (kept byte-identical to prisma/migrations/0611_site_address_change/migration.sql).
--
--   * New Change Control field item site.address (sites.address). Same rules as site.name_ar: an empty text or (none) clears it, the text is stripped of control
--     characters and spaces at both ends, at most 500 characters (the limit of site creation), shown as (none) when empty.
--   * Proposal: POST /sites/{id}/change-proposals takes the optional identity.address; the System Admin direct edit takes it too (same field, same rules).
--     One Change Control draft per field, as for the other identity items. No new path, no new table, no grant and no permission change: the right to propose or
--     approve a name change is the right to propose or approve an address change, and the identity guard trigger is not touched.
--   * The functions below are patched in place from their stored text (each anchor is asserted, a second run changes nothing):
--     si_identity_items, si_parsed_text, si_site_cols, p4a_site_current, p4a_site_parse, p4a_site_change_errors, si_apply_identity, site_propose_identity,
--     ao_site_apply, site_admin_edit.

CREATE OR REPLACE FUNCTION pg_temp.a1b_patch(p_sig text, p_marker text, p_pairs text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE def text; i int;
BEGIN
  def := pg_get_functiondef(p_sig::regprocedure);
  IF position(p_marker IN def) > 0 THEN RETURN; END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) / 2 LOOP
    IF position(p_pairs[2 * i - 1] IN def) = 0 THEN RAISE EXCEPTION '% has no anchor % to patch', p_sig, p_pairs[2 * i - 1]; END IF;
    def := replace(def, p_pairs[2 * i - 1], p_pairs[2 * i]);
  END LOOP;
  EXECUTE def;
END $$;

SELECT pg_temp.a1b_patch('public.si_identity_items()', 'site.address', ARRAY[
  $a$'site.cluster']$a$, $a$'site.cluster', 'site.address']$a$]);

SELECT pg_temp.a1b_patch('public.si_parsed_text(text,jsonb)', 'site.address', ARRAY[
  $a$WHEN 'site.coordinates'$a$, $a$WHEN 'site.address' THEN CASE WHEN p_v = 'null'::jsonb THEN '(none)' ELSE p_v #>> '{}' END
    WHEN 'site.coordinates'$a$]);

SELECT pg_temp.a1b_patch('public.si_site_cols(uuid,text)', 'site.address', ARRAY[
  $a$WHEN 'site.coordinates'$a$, $a$WHEN 'site.address' THEN jsonb_build_object('address', s.address)
    WHEN 'site.coordinates'$a$]);

SELECT pg_temp.a1b_patch('public.p4a_site_current(uuid,text)', 'site.address', ARRAY[
  $a$IF p_item = 'site.coordinates' THEN$a$, $a$IF p_item = 'site.address' THEN RETURN coalesce(s.address, '(none)'); END IF;
  IF p_item = 'site.coordinates' THEN$a$]);

SELECT pg_temp.a1b_patch('public.p4a_site_parse(uuid,text,text)', 'site.address', ARRAY[
  $a$ELSIF p_item = 'site.coordinates' THEN$a$, $a$ELSIF p_item = 'site.address' THEN
    t := btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', '', 'g'));
    IF t IN ('', '(none)') THEN RETURN 'null'::jsonb; END IF;
    IF char_length(t) > 500 THEN PERFORM public.si_fail('/data/new_value', 'too_long', 'The address is at most 500 characters.'); END IF;
    RETURN to_jsonb(t);

  ELSIF p_item = 'site.coordinates' THEN$a$]);

SELECT pg_temp.a1b_patch('public.p4a_site_change_errors(uuid,jsonb)', 'site.address', ARRAY[
  $a$site.name_ar, site.coordinates$a$, $a$site.name_ar, site.address, site.coordinates$a$]);

SELECT pg_temp.a1b_patch('public.si_apply_identity(uuid)', 'site.address', ARRAY[
  $a$ELSIF item = 'site.coordinates' THEN$a$, $a$ELSIF item = 'site.address' THEN
    UPDATE public.sites SET address = CASE WHEN v = 'null'::jsonb THEN NULL ELSE v #>> '{}' END, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.coordinates' THEN$a$]);

SELECT pg_temp.a1b_patch('public.site_propose_identity(uuid,jsonb,text)', '''address''', ARRAY[
  $a$ARRAY['name', 'name_ar', 'latitude'$a$, $a$ARRAY['name', 'name_ar', 'address', 'latitude'$a$,
  $a$FOREACH k IN ARRAY ARRAY['name', 'name_ar'] LOOP$a$, $a$FOREACH k IN ARRAY ARRAY['name', 'name_ar', 'address'] LOOP$a$]);

SELECT pg_temp.a1b_patch('public.ao_site_apply(uuid,jsonb)', 'site.address', ARRAY[
  $a$ELSIF item = 'site.coordinates' THEN$a$, $a$ELSIF item = 'site.address' THEN
      UPDATE public.sites SET address = CASE WHEN v = 'null'::jsonb THEN NULL ELSE v #>> '{}' END, updated_at = clock_timestamp() WHERE id = p_site;
    ELSIF item = 'site.coordinates' THEN$a$]);

SELECT pg_temp.a1b_patch('public.site_admin_edit(uuid,timestamptz,jsonb,text)', '''address''', ARRAY[
  $a$ARRAY['name', 'name_ar', 'latitude'$a$, $a$ARRAY['name', 'name_ar', 'address', 'latitude'$a$,
  $a$FOREACH k IN ARRAY ARRAY['name', 'name_ar'] LOOP$a$, $a$FOREACH k IN ARRAY ARRAY['name', 'name_ar', 'address'] LOOP$a$]);
