-- 0161: the admin edits a user's display name and employee number (owner request 2026-11-25: "the admin should be able to edit the name, email and the ID").
--   * Display name: any admin with users.edit (all regions), reason, audit with old and new value.
--   * Employee number (4 digits, unique): the staff registry is keyed by it, so the change is stricter: not on your own row, not on a deleted or purged user,
--     refused when another account holds the number (409 duplicate), audited with old and new value. The API adds the step-up and the version check.
--   * E-mail and phone are NOT changed here: they stay on the verified request flow (the user proves the new address or number, the admin decides).
-- A privileged user (admin or delegate, now or before) can be changed only by a System Admin, as for every other user change (idm_assert_user_change_allowed).
CREATE OR REPLACE FUNCTION idm_set_user_identity(p_user uuid, p_name text, p_emp text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'edit'); u public.users%ROWTYPE; nm text := nullif(btrim(coalesce(p_name, '')), '');
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'edit');
  SELECT * INTO u FROM public.users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND OR u.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'user not found' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM public.idm_assert_user_change_allowed(p_user);
  IF p_name IS NOT NULL AND nm IS NULL THEN RAISE EXCEPTION 'the name cannot be empty'; END IF;
  IF p_emp IS NOT NULL THEN
    IF p_user = a THEN RAISE EXCEPTION 'you cannot change your own employee ID' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF p_emp !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'employee id is 4 digits'; END IF;
    IF EXISTS (SELECT 1 FROM public.users o WHERE o.employee_id = p_emp AND o.id <> p_user) THEN
      RAISE EXCEPTION 'employee_id_in_use' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  IF (nm IS NULL OR nm = u.display_name) AND (p_emp IS NULL OR p_emp IS NOT DISTINCT FROM u.employee_id) THEN RETURN; END IF;
  UPDATE public.users SET display_name = coalesce(nm, display_name), employee_id = coalesce(p_emp, employee_id), updated_at = now() WHERE id = p_user;
  PERFORM public.idm_audit('user_identity', 'user', p_user::text,
    jsonb_build_object('display_name', u.display_name, 'employee_id', u.employee_id),
    jsonb_build_object('display_name', coalesce(nm, u.display_name), 'employee_id', coalesce(p_emp, u.employee_id)), p_reason);
END $$;
ALTER FUNCTION idm_set_user_identity(uuid, text, text, text) OWNER TO pmis_identity_owner;
REVOKE ALL ON FUNCTION idm_set_user_identity(uuid, text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION idm_set_user_identity(uuid, text, text, text) TO pmis_app;
  END IF;
END $$;
