-- 0440: the role code is editable (owner decision D51). Additive: the immutability check leaves roles_guard, the format and the
-- built-in protection become functions, and idm_role_save (patched in place) writes the audit event role_code_changed.
-- History, saved filters and exports that quote the old code are not rewritten (the dialog says so).

CREATE OR REPLACE FUNCTION role_code_valid(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p ~ '^[A-Z][A-Z0-9_]{1,40}$'
$$;

-- Codes the platform names in its own rules (seeded roles and the ones referenced by registers): locked.
CREATE OR REPLACE FUNCTION role_code_protected(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p = ANY (ARRAY['PM','RFD_ACQ_TL','CW_TL','TE_TL','INV_SUP','PROJ_SUPPORT','MANAGEMENT','RF_ENG','MW_ENG','ACQ_TEAM','POWER_ENG',
    'GECOL_TEAM','HLC_TEAM','SITE_ENG_CW','SITE_ENG_TE','HOTO_ENG','PROC_TEAM','QC_GENERAL','FLEET_DISPATCHER','FIN_OFFICER'])
$$;

CREATE OR REPLACE FUNCTION roles_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF role_in_use(OLD.id) THEN
      RAISE EXCEPTION 'role % is assigned or referenced: deactivate it instead of deleting', OLD.code USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code IS DISTINCT FROM OLD.code THEN
    IF NOT role_code_valid(NEW.code) THEN
      RAISE EXCEPTION 'role code must be 2 to 41 characters: A-Z, 0-9 and _, starting with a letter' USING ERRCODE = 'check_violation';
    END IF;
    IF role_code_protected(OLD.code) THEN
      RAISE EXCEPTION 'role code % is used by the platform by name and cannot be changed', OLD.code USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION idm_role_save(p_id uuid, p_code text, p_name_en text, p_name_ar text, p_desc_en text, p_desc_ar text, p_parent uuid, p_team "TeamKind",
  p_default_profile uuid, p_default_all_regions boolean, p_default_all_modules boolean, p_can_hold boolean, p_sort int, p_active boolean, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid; rid uuid := p_id; o public.roles%ROWTYPE; newcode text := nullif(btrim(p_code), '');
BEGIN
  IF p_parent IS NOT NULL THEN
    RAISE EXCEPTION 'roles are flat: a role cannot have a parent' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('roles', CASE WHEN p_id IS NULL THEN 'create' ELSE 'edit' END::"PermissionAction");
  IF NOT public.app_actor_is_system_admin() THEN
    IF coalesce(p_default_all_regions, false) THEN RAISE EXCEPTION 'default_all_regions is System-Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF coalesce(p_default_all_modules, false) AND NOT public.idm_actor_all_modules() THEN RAISE EXCEPTION 'you cannot make a role default to all modules' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;
  IF p_default_profile IS NOT NULL AND NOT public.idm_profile_within_actor(p_default_profile) THEN
    RAISE EXCEPTION 'default profile is wider than your own rights' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    a := public.idm_actor('roles', 'create');
    INSERT INTO public.roles (code, name_en, name_ar, description_en, description_ar, team, default_profile_id, default_all_regions,
      default_all_modules, can_hold_matrix_levels, sort, is_active)
    VALUES (p_code, p_name_en, p_name_ar, p_desc_en, p_desc_ar, coalesce(p_team, 'none'), p_default_profile, coalesce(p_default_all_regions, false),
      coalesce(p_default_all_modules, false), coalesce(p_can_hold, true), coalesce(p_sort, 0), coalesce(p_active, true)) RETURNING id INTO rid;
    PERFORM public.idm_audit('role_created', 'role', rid::text, NULL, jsonb_build_object('code', p_code, 'name_en', p_name_en), p_reason);
  ELSE
    a := public.idm_actor('roles', 'edit');
    SELECT * INTO o FROM public.roles WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
    IF p_default_profile IS DISTINCT FROM o.default_profile_id AND public.idm_actor_holds_role(p_id) THEN
      RAISE EXCEPTION 'you cannot change the default profile of a role you hold' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF newcode IS NOT NULL AND newcode IS DISTINCT FROM o.code THEN
      -- 0440: the code is editable (owner decision D51). The platform refers to a few codes by name, so those stay locked.
      IF NOT public.role_code_valid(newcode) THEN
        RAISE EXCEPTION 'role code must be 2 to 41 characters: A-Z, 0-9 and _, starting with a letter' USING ERRCODE = 'check_violation';
      END IF;
      IF public.role_code_protected(o.code) THEN
        RAISE EXCEPTION 'role code % is used by the platform by name and cannot be changed', o.code USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM public.roles WHERE code = newcode AND id <> p_id) THEN
        RAISE EXCEPTION 'role code % already exists', newcode USING ERRCODE = 'unique_violation';
      END IF;
    END IF;
    UPDATE public.roles SET code = coalesce(newcode, code), name_en = coalesce(p_name_en, name_en), name_ar = p_name_ar, description_en = p_desc_en, description_ar = p_desc_ar,
      team = coalesce(p_team, team), default_profile_id = p_default_profile,
      default_all_regions = coalesce(p_default_all_regions, default_all_regions), default_all_modules = coalesce(p_default_all_modules, default_all_modules),
      can_hold_matrix_levels = coalesce(p_can_hold, can_hold_matrix_levels), sort = coalesce(p_sort, sort), is_active = coalesce(p_active, is_active)
    WHERE id = p_id;
    PERFORM public.idm_audit('role_updated', 'role', p_id::text, to_jsonb(o), jsonb_build_object('name_en', p_name_en, 'is_active', p_active), p_reason);
    IF newcode IS NOT NULL AND newcode IS DISTINCT FROM o.code THEN
      PERFORM public.idm_audit('role_code_changed', 'role', p_id::text, jsonb_build_object('code', o.code), jsonb_build_object('code', newcode), p_reason);
    END IF;
  END IF;
  PERFORM public.idm_assert_role_within_actor(rid); -- post-state
  RETURN rid;
END $$;
