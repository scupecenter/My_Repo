-- 0169_issue_owner_role: package 2 of the issue work. An issue can be owned by a ROLE (who holds the solution), not only by a person or an external party.
-- Mirror: db/sql/168_issue_owner_role.sql (kept identical).
--
--   1. List IssueOwnerRole: one value per ACTIVE role at the time of this migration (code = the role code, labels = the role names). Status pending, not critical.
--      It is a normal list: add, rename, reorder, merge or hide values in Settings > Registers > Lists. A role created or renamed later is added there by hand;
--      the list is a copy, it does not follow Roles & Responsibilities, and it grants nothing.
--   2. Field owner_role on the Issues register (list_code, optional, in the list and the filters), section Issue, next to the person owner.
--   3. The submit rule of an issue (Q70) says "an Aljeel person or an external party". It now says "a person, a role or an external party". Nothing else in the
--      validation changes. The function is patched in place from its stored definition (one condition and its message), so it keeps its owner and settings.
-- A role owner sends no notification and gives nobody access or approval rights: it is a label for PMO. Existing issues are not changed.
-- Not here (separate packages): the dashboard grouping by owner or category, the derived "stopped at" rows.

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('IssueOwnerRole', 'Issue owner role', 'دور مالك المشكلة', false, 'pending', false, 'The role that holds the solution of an issue. Copied from the active roles; edit it here, it does not follow Roles & Responsibilities.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order)
SELECT 'IssueOwnerRole', r.code, r.name_en, coalesce(nullif(btrim(r.name_ar), ''), r.name_en), (row_number() OVER (ORDER BY r.sort, r.code)) * 10
FROM roles r WHERE r.is_active
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('issues', 'owner_role', 'Owner role', 'دور المالك', 'list_code', false, false, false, NULL, true, 'Issue', 21, 'IssueOwnerRole')
ON CONFLICT (register_key, code) DO NOTHING;

DO $$
DECLARE def text; patched text;
BEGIN
  def := pg_get_functiondef('public.reg_validate_catalog(uuid)'::regprocedure);
  patched := replace(def,
    $a$IF NOT (d ? 'owner_user') AND r.external_party_id IS NULL THEN errs := errs || public.reg_err_item('/data/owner_user', 'required', 'The issue needs an owner: an Aljeel person or an external party (Q70).'); END IF;$a$,
    $b$IF NOT (d ? 'owner_user') AND NOT (d ? 'owner_role') AND r.external_party_id IS NULL THEN errs := errs || public.reg_err_item('/data/owner_user', 'required', 'The issue needs an owner: an Aljeel person, a role or an external party (Q70).'); END IF;$b$);
  IF patched = def THEN RAISE EXCEPTION '0169: the issue owner rule was not found in reg_validate_catalog'; END IF;
  EXECUTE patched;
END $$;
