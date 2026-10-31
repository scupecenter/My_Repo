-- Harness objects for the security suite. Run as the superuser, in the scratch database only (never in a real one).
-- secsuite_ids maps the fixture names to the generated ids; the runner reads it and fills the {{NAME}} placeholders.
CREATE TABLE IF NOT EXISTS public.secsuite_ids (name text PRIMARY KEY, value text NOT NULL);

-- A digest per table, computed as the superuser (who sees every row). A refused case must leave every digest unchanged.
CREATE OR REPLACE FUNCTION public.secsuite_snapshot()
RETURNS TABLE (tbl text, digest text)
LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'user_role_assignments', 'user_role_assignment_regions', 'user_role_assignment_modules',
    'user_role_assignment_profiles', 'groups', 'group_members', 'delegations', 'delegation_grants', 'delegation_regions',
    'roles', 'role_default_regions', 'role_default_modules', 'permission_profiles', 'permission_grants', 'field_permissions',
    'local_credentials', 'user_sessions', 'departments', 'message_threads', 'message_participants', 'messages',
    'announcements', 'announcement_targets', 'announcement_recipients', 'announcement_responses', 'audit_log', 'clusters'
  ] LOOP
    tbl := t;
    EXECUTE format(
      'SELECT coalesce(md5(string_agg(x::text, chr(10) ORDER BY x::text)), ''empty'') || '':'' || count(*)::text FROM %I x', t)
      INTO digest;
    RETURN NEXT;
  END LOOP;
END $$;
