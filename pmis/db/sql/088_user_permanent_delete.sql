-- 0089: permanent delete of an already soft-deleted user that frees the identifiers
-- (owner decision 3 of 2026-11-12; amends decision B14 "never a hard delete"; contract 0.14.x `POST /users/{id}/purge`).
--
-- The users row is NEVER deleted. A purge turns a soft-deleted row into a tombstone: the row, its id and its display_name stay, so every
-- past entry, task step, comment and audit row keeps pointing at the same person. What is released is what identifies the account:
--   * email becomes the unique placeholder purged-<id>@purged.invalid (email stays NOT NULL and unique), employee_id, phone and the
--     Entra object id become NULL, so the unique indexes (users_email_key, users_employee_id_key, users_phone_key, users_m365_object_id_key)
--     no longer block a NEW account with the same data (idm_create_local_user then succeeds as it is);
--   * a masked copy of the old identifiers is kept in purged_identifiers (for the Users screen and for audit readers);
--   * credentials, TOTP secrets and recovery codes are deleted, sessions end, pending e-mail and phone changes are cancelled, group
--     memberships are removed, current and future role assignments are ended, delegations from or to the user are revoked, and the
--     user's own manager link, the links of people who reported to the user and the department are cleared.
-- Status stays 'disabled' (so the last-admin trigger of 0009 and users_deleted_is_disabled still hold; deleted_at stays set, so every
-- existing "deleted_at IS NULL" list and picker already hides the tombstone). A purged user cannot be restored.
--
-- Who: the System Admin only (a delegate of users.delete is refused), never on oneself, never the break-glass account, only a user that
-- is already soft-deleted. Needs a reason, step-up (checked by the API like idm_delete_user) and a typed confirmation: the employee ID
-- or the e-mail of the account (p_confirm). Audited with before and after. Removing the admin-group membership runs the deferred
-- last-admin trigger, so at least one active System Admin must remain.

ALTER TABLE users ADD COLUMN purged_at TIMESTAMPTZ(6);
ALTER TABLE users ADD COLUMN purged_by UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE users ADD COLUMN purge_reason TEXT CHECK (purge_reason IS NULL OR length(btrim(purge_reason)) BETWEEN 3 AND 500);
ALTER TABLE users ADD COLUMN purged_identifiers JSONB;
ALTER TABLE users ADD CONSTRAINT users_purged_is_deleted CHECK (purged_at IS NULL OR (deleted_at IS NOT NULL AND status = 'disabled'));
ALTER TABLE users ADD CONSTRAINT users_purged_has_no_identifiers CHECK (purged_at IS NULL OR (employee_id IS NULL AND phone IS NULL AND m365_object_id IS NULL));
CREATE INDEX users_purged_idx ON users (purged_at) WHERE purged_at IS NOT NULL;

-- Masked display of an e-mail or phone: first character and the domain / last two digits, nothing else.
CREATE OR REPLACE FUNCTION idm_mask_identifier(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN position('@' IN p) > 1 THEN left(p, 1) || '***' || substr(p, position('@' IN p))
    ELSE '***' || right(p, 2)
  END
$$;

CREATE OR REPLACE FUNCTION idm_purge_user(p_user uuid, p_reason text, p_confirm text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a uuid := public.idm_actor('users', 'delete');
  u public.users%ROWTYPE;
  n_groups int; n_assign int; n_deleg int; n_reports int; n_creds int;
  masked jsonb;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  IF length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'the reason is too long'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN
    RAISE EXCEPTION 'permanent delete is System Admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.idm_need_global('users', 'delete');
  IF p_user = a THEN RAISE EXCEPTION 'you cannot purge yourself' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO u FROM public.users WHERE id = p_user AND NOT is_break_glass FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  IF u.purged_at IS NOT NULL THEN RAISE EXCEPTION 'user already purged'; END IF;
  IF u.deleted_at IS NULL THEN RAISE EXCEPTION 'user is not deleted: soft-delete the account first'; END IF;
  -- Typed confirmation: the employee ID or the e-mail of the account (case-insensitive for the e-mail).
  IF coalesce(btrim(p_confirm), '') = '' OR NOT (
       (u.employee_id IS NOT NULL AND btrim(p_confirm) = btrim(u.employee_id)) OR lower(btrim(p_confirm)) = u.email) THEN
    RAISE EXCEPTION 'confirmation_mismatch: type the employee ID or the e-mail of the account';
  END IF;

  masked := jsonb_build_object('email', public.idm_mask_identifier(u.email), 'employee_id', btrim(u.employee_id), 'phone', public.idm_mask_identifier(u.phone));

  -- Sessions and credentials.
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'user_purged' WHERE user_id = p_user AND revoked_at IS NULL;
  DELETE FROM public.local_credentials WHERE user_id = p_user;
  GET DIAGNOSTICS n_creds = ROW_COUNT;
  DELETE FROM public.user_totp WHERE user_id = p_user;
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user;
  DELETE FROM public.auth_pending WHERE user_id = p_user;

  -- Pending self-service requests hold other e-mail addresses and phones: cancel them.
  UPDATE public.email_change_requests SET status = 'cancelled', decided_at = now() WHERE user_id = p_user AND status = 'pending';
  UPDATE public.phone_change_requests SET status = 'cancelled', decided_at = now() WHERE user_id = p_user AND status = 'pending';

  -- Rights: group memberships go (the deferred last-admin trigger checks the System Admins group), assignments end, delegations are revoked.
  DELETE FROM public.group_members WHERE user_id = p_user;
  GET DIAGNOSTICS n_groups = ROW_COUNT;
  UPDATE public.user_role_assignments SET valid_to = greatest(now(), valid_from + interval '1 millisecond'), is_primary = false
   WHERE user_id = p_user AND (valid_to IS NULL OR valid_to > now());
  GET DIAGNOSTICS n_assign = ROW_COUNT;
  WITH RECURSIVE d AS (
    SELECT id FROM public.delegations WHERE from_user_id = p_user OR target_user_id = p_user
    UNION
    SELECT c.id FROM public.delegations c JOIN d ON c.parent_delegation_id = d.id)
  UPDATE public.delegations x SET revoked = true, revoked_at = now(), revoked_by = a FROM d WHERE x.id = d.id AND NOT x.revoked;
  GET DIAGNOSTICS n_deleg = ROW_COUNT;

  -- Reporting lines: people who reported to the user lose that link.
  UPDATE public.users SET manager_id = NULL, updated_at = now() WHERE manager_id = p_user;
  GET DIAGNOSTICS n_reports = ROW_COUNT;

  -- The tombstone: identity released, name and history kept.
  UPDATE public.users SET
    email = 'purged-' || p_user::text || '@purged.invalid', employee_id = NULL, phone = NULL, m365_object_id = NULL, totp_secret_enc = NULL,
    manager_id = NULL, department_id = NULL,
    purged_at = now(), purged_by = a, purge_reason = btrim(p_reason), purged_identifiers = masked, updated_at = now()
   WHERE id = p_user;

  PERFORM public.idm_audit('user_purged', 'user', p_user::text,
    jsonb_build_object('display_name', u.display_name, 'status', u.status, 'deleted_at', u.deleted_at, 'email', public.idm_mask_identifier(u.email),
      'employee_id', btrim(u.employee_id), 'phone', public.idm_mask_identifier(u.phone), 'had_local_credentials', n_creds > 0),
    jsonb_build_object('display_name', u.display_name, 'purged', true, 'identifiers_released', true, 'email', 'purged-' || p_user::text || '@purged.invalid',
      'employee_id', NULL, 'phone', NULL, 'groups_removed', n_groups, 'assignments_ended', n_assign, 'delegations_revoked', n_deleg,
      'reports_unlinked', n_reports),
    p_reason);
END $$;

-- Restore: never for a purged tombstone, and a real conflict check against every other account (identifiers are unique, so this
-- reports the clash by name instead of a raw index error). Everything else is as in 0012.
CREATE OR REPLACE FUNCTION idm_restore_user(p_user uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'delete'); u public.users%ROWTYPE;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'delete');
  IF p_user = a THEN RAISE EXCEPTION 'you cannot restore yourself' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_assert_user_change_allowed(p_user);
  SELECT * INTO u FROM public.users WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  IF u.deleted_at IS NULL THEN RAISE EXCEPTION 'user is not deleted'; END IF;
  IF u.purged_at IS NOT NULL THEN RAISE EXCEPTION 'user is purged: a permanently deleted account cannot be restored'; END IF;
  IF EXISTS (SELECT 1 FROM public.users o WHERE o.id <> p_user AND lower(o.email) = lower(u.email)) THEN
    RAISE EXCEPTION 'restore_blocked: the e-mail now belongs to another account' USING ERRCODE = 'unique_violation';
  END IF;
  IF u.employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.users o WHERE o.id <> p_user AND o.employee_id = u.employee_id) THEN
    RAISE EXCEPTION 'restore_blocked: the employee ID now belongs to another account' USING ERRCODE = 'unique_violation';
  END IF;
  IF u.phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.users o WHERE o.id <> p_user AND o.phone = u.phone) THEN
    RAISE EXCEPTION 'restore_blocked: the phone now belongs to another account' USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE public.users SET status = coalesce(u.status_before_delete, 'pending_assignment'), deleted_at = NULL, deleted_by = NULL,
    delete_reason = NULL, status_before_delete = NULL, updated_at = now() WHERE id = p_user;
  UPDATE public.local_credentials SET enabled = true, failed_count = 0, locked_until = NULL WHERE user_id = p_user;
  PERFORM public.idm_audit('user_restored', 'user', p_user::text, jsonb_build_object('deleted', true),
    jsonb_build_object('status', coalesce(u.status_before_delete, 'pending_assignment')), p_reason);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['idm_purge_user(uuid,text,text)','idm_restore_user(uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
END $$;
