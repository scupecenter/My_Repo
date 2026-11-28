-- 0702_module_no_grants_notice: a module with registers and no permission grants is told to the System Admins once, and listed on the Matrix coverage screen (L8; contract 0.15.562).
-- Mirror: db/sql/701_module_no_grants_notice.sql (kept identical to prisma/migrations/0702_module_no_grants_notice/migration.sql).
--
--   WHY. A module added by a migration (for example invoices, 0185) has no permission grant seeded (no permission widening), so nobody can open it until a System Admin
--   grants it in the permission profiles. Nothing told the admin. This only tells; it grants nothing and changes no profile, role or Matrix cell. Seeds stay empty.
--   modules_without_grants_json()  read only: the modules of the active registers (register_definitions.module_key) that have no row in permission_grants (any profile,
--                                  any action), each with its registers. A module that gets one grant leaves the list.
--   modules_no_grants_notify()     called by the daily job (jobs.service, the contractors_daily_alerts pattern): one in-app notification per System Admin and module, the
--                                  first time the module is seen without grants (the notifications table is the memory: a module already notified to that admin is skipped,
--                                  so a repeat run writes nothing). Title and body in the admin's users.locale (English fallback). Link: the Matrix (/admin/matrix).
--   COVERED: every module of an active register. EXCLUDED, unchanged: modules that have no register (the permission catalogue modules with screens only), and the screen keys.
--   No table, no column, no setting, no grant to a user role, nothing deleted. The job runs with no signed-in actor.

CREATE OR REPLACE FUNCTION modules_without_grants_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('module_key', m.module_key, 'registers', m.regs) ORDER BY m.module_key), '[]'::jsonb)
  FROM (
    SELECT d.module_key, jsonb_agg(jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar) ORDER BY d.sort_order, d.register_key) AS regs
    FROM public.register_definitions d
    WHERE d.is_active AND d.module_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.permission_grants g WHERE g.module_key = d.module_key)
    GROUP BY d.module_key
  ) m
$$;

CREATE OR REPLACE FUNCTION modules_no_grants_notify() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer := 0; k integer; m jsonb; mk text; nm text;
BEGIN
  FOR m IN SELECT * FROM jsonb_array_elements(public.modules_without_grants_json()) LOOP
    mk := m ->> 'module_key';
    nm := (SELECT string_agg(x ->> 'name_en', ', ') FROM jsonb_array_elements(m -> 'registers') x);
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
    SELECT u.user_id, 'in_app', 'module_no_grants',
           CASE WHEN u.loc = 'ar' THEN 'وحدة بلا صلاحيات: ' || mk ELSE 'Module without permissions: ' || mk END,
           CASE WHEN u.loc = 'ar' THEN 'الوحدة ' || mk || ' (' || nm || ') لا تملك أي صلاحية ممنوحة لأي ملف صلاحيات، لذا لا يستطيع أحد فتحها. افتح المصفوفة ومنح الصلاحيات.'
                ELSE 'The module ' || mk || ' (' || nm || ') has no permission granted in any profile, so nobody can open it. Open the Matrix and grant it.' END,
           '/admin/matrix', mk
    FROM (
      SELECT DISTINCT gm.user_id, CASE WHEN ux.locale = 'ar' THEN 'ar' ELSE 'en' END AS loc
      FROM public.group_members gm
        JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
        JOIN public.users ux ON ux.id = gm.user_id AND ux.status = 'active' AND ux.deleted_at IS NULL AND NOT ux.is_break_glass
    ) u
    WHERE NOT EXISTS (SELECT 1 FROM public.notifications x WHERE x.user_id = u.user_id AND x.kind = 'module_no_grants' AND x.module_key = mk);
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;
  END LOOP;
  RETURN n;
END $$;

ALTER FUNCTION public.modules_without_grants_json() OWNER TO pmis_definer;
ALTER FUNCTION public.modules_no_grants_notify() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION public.modules_without_grants_json() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.modules_no_grants_notify() FROM PUBLIC;
GRANT SELECT ON public.permission_grants, public.register_definitions, public.group_members, public.groups, public.users TO pmis_definer;
GRANT INSERT, SELECT ON public.notifications TO pmis_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION public.modules_without_grants_json(), public.modules_no_grants_notify() TO pmis_app;
  END IF;
END $$;
