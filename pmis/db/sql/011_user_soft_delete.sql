-- 011: soft delete and restore of users (decision B14, contract 0.2.5 `POST /users/{id}/delete|restore`, `GET /users/deleted`).
--
-- A delete never removes the row: it records who, when and why, disables the account (status 'disabled', so it cannot
-- sign in and the last-admin trigger of 008 still applies), ends its sessions and turns local sign-in off. Assignments,
-- groups, tasks and history stay. A restore brings back the status the account had before the delete and turns local
-- sign-in back on. Email, employee ID and phone stay unique while deleted, so a restore never collides.

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ(6);
ALTER TABLE users ADD COLUMN deleted_by UUID REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE users ADD COLUMN delete_reason TEXT CHECK (delete_reason IS NULL OR length(btrim(delete_reason)) BETWEEN 3 AND 500);
ALTER TABLE users ADD COLUMN status_before_delete "UserStatus";
ALTER TABLE users ADD CONSTRAINT users_deleted_is_disabled CHECK (deleted_at IS NULL OR status = 'disabled');
CREATE INDEX users_deleted_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION idm_delete_user(p_user uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.idm_actor('users', 'delete'); u public.users%ROWTYPE;
BEGIN
  PERFORM public.idm_need_reason(p_reason);
  PERFORM public.idm_need_global('users', 'delete');
  IF p_user = a THEN RAISE EXCEPTION 'you cannot delete yourself' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.idm_assert_user_change_allowed(p_user);
  SELECT * INTO u FROM public.users WHERE id = p_user AND NOT is_break_glass;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  IF u.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'user already deleted'; END IF;
  UPDATE public.users SET deleted_at = now(), deleted_by = a, delete_reason = btrim(p_reason), status_before_delete = u.status,
    status = 'disabled', updated_at = now() WHERE id = p_user;
  UPDATE public.user_sessions SET revoked_at = now(), revoked_by = a, revoke_reason = 'user_deleted' WHERE user_id = p_user AND revoked_at IS NULL;
  UPDATE public.local_credentials SET enabled = false WHERE user_id = p_user;
  PERFORM public.idm_audit('user_deleted', 'user', p_user::text, jsonb_build_object('status', u.status),
    jsonb_build_object('status', 'disabled', 'deleted', true), p_reason);
END $$;

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
  UPDATE public.users SET status = coalesce(u.status_before_delete, 'pending_assignment'), deleted_at = NULL, deleted_by = NULL,
    delete_reason = NULL, status_before_delete = NULL, updated_at = now() WHERE id = p_user;
  UPDATE public.local_credentials SET enabled = true, failed_count = 0, locked_until = NULL WHERE user_id = p_user;
  PERFORM public.idm_audit('user_restored', 'user', p_user::text, jsonb_build_object('deleted', true),
    jsonb_build_object('status', coalesce(u.status_before_delete, 'pending_assignment')), p_reason);
END $$;

GRANT UPDATE ON user_sessions, local_credentials TO pmis_identity_owner;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['idm_delete_user(uuid,text)','idm_restore_user(uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
END $$;
