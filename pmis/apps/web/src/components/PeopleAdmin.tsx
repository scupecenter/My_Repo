import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import type { Me } from '@/api/types';
import { hasGrant, isAdmin } from '@/lib/perm';

/**
 * The pages of the "Users & Roles" screen, in tab order. Each one opens only for holders of its module (effective.nav), or
 * of its grant when it has one (Online now: `manage_users`, as in the old sidebar). A page with `under` is a sub-tab of
 * that tab and has no tab of its own (Online now sits under Users, beside Deleted; Assignments also sits under Users, and Permission profiles under
 * Roles, shown as a small second row, merge of 2026-11-25: routes and rights unchanged).
 */
export const PEOPLE_TABS: readonly { key: string; to: string; label: string; grant?: string; under?: string; navAny?: readonly string[] }[] = [
  { key: 'admin.users', to: '/admin/users', label: 'peopleAdmin.tab_users' },
  { key: 'admin.online', to: '/admin/online', label: 'nav.admin.online', grant: 'manage_users', under: 'admin.users' },
  { key: 'admin.assignments', to: '/admin/assignments', label: 'peopleAdmin.tab_assignments', navAny: ['admin.users'], under: 'admin.users' },
  { key: 'admin.roles', to: '/admin/roles', label: 'peopleAdmin.tab_roles_profiles' },
  { key: 'admin.profiles', to: '/admin/profiles', label: 'peopleAdmin.tab_profiles', navAny: ['admin.roles'], under: 'admin.roles' },
  { key: 'admin.groups', to: '/admin/groups', label: 'nav.admin.groups' },
  { key: 'admin.delegation', to: '/admin/delegation', label: 'nav.admin.delegation' },
  { key: 'admin.matrix', to: '/admin/matrix', label: 'nav.admin.matrix' },
];

export const PEOPLE_KEYS: ReadonlySet<string> = new Set(PEOPLE_TABS.map((p) => p.key));

/** The list views of the Users page that now sit in the top tab strip (`/admin/users?view=`); the page has no tab row of its own. */
export type UsersView = 'departments' | 'invitations' | 'email_changes' | 'phone_changes';
export const USERS_VIEWS: readonly UsersView[] = ['departments', 'invitations', 'email_changes', 'phone_changes'];

/** Who decides e-mail and phone changes (the server checks again: System Admin, or a delegate holding users.edit for all regions). */
export function canDecideChanges(me: Me | undefined): boolean {
  return isAdmin(me) || !!me?.effective.grants.some((g) => (g.action as string) === 'edit' && ['users', 'admin.users', '*'].includes(g.module_key as string) && g.region_ids === 'all');
}

/** Whether this person may open the tab. */
export function peopleTabAllowed(me: Me | undefined, tab: (typeof PEOPLE_TABS)[number]): boolean {
  if (!me) return false;
  if (tab.grant) return hasGrant(me, tab.grant);
  return [tab.key, ...(tab.navAny ?? [])].some((k) => me.effective.nav.includes(k as never));
}

/** First tab this person may open, or null when they may open none. */
export function firstPeopleTab(me: Me | undefined): string | null {
  return PEOPLE_TABS.find((p) => peopleTabAllowed(me, p))?.to ?? null;
}

/** One screen, "Users & Roles", with Users, Roles, Groups, Delegation and Responsibility Matrix as tabs (URLs unchanged). */
export function PeopleAdminLayout() {
  const { t } = useTranslation();
  const me = useMe(true);
  const loc = useLocation();
  const [sp] = useSearchParams();
  const [more, setMore] = useState(false);
  const open = PEOPLE_TABS.filter((p) => peopleTabAllowed(me.data, p));
  // One tab per top-level page; it links to its own page, or to its first open sub-page when only that one is open.
  const tabs = PEOPLE_TABS.filter((p) => !p.under).flatMap((p) => {
    const first = open.find((o) => o.key === p.key || o.under === p.key);
    return first ? [{ ...p, to: first.to }] : [];
  });
  const page = PEOPLE_TABS.find((p) => loc.pathname === p.to || loc.pathname.startsWith(`${p.to}/`));
  const here = page?.under ? PEOPLE_TABS.find((p) => p.key === page.under) : page;
  // A tab the person may not open sends them to the first one they may (the page itself still enforces access).
  if (me.data && page && !peopleTabAllowed(me.data, page) && tabs[0]) return <Navigate to={tabs[0].to} replace />;
  // Sub-pages of a tab: Assignments and Online now are tabs of the one strip; only Roles keeps its small Profiles row.
  const subs = here && here.key === 'admin.roles' ? PEOPLE_TABS.filter((p) => !p.grant && (p.key === here.key || p.under === here.key)).filter((p) => peopleTabAllowed(me.data, p)) : [];
  const canList = !!me.data?.effective.nav.includes('admin.users' as never);
  const onUsers = loc.pathname === '/admin/users';
  const view = onUsers ? (sp.get('view') ?? (sp.has('email_changes') ? 'email_changes' : sp.has('phone_changes') ? 'phone_changes' : '')) : '';
  const decide = canDecideChanges(me.data);
  const tabCls = (on: boolean) => `-mb-px border-b-2 px-3 py-2 text-sm ${on ? 'border-accent font-semibold text-ink' : 'border-transparent text-mute hover:text-ink'}`;
  const usersOn = here?.key === 'admin.users' && !view && !loc.pathname.startsWith('/admin/online') && loc.pathname !== '/admin/assignments';
  const assign = PEOPLE_TABS.find((p) => p.key === 'admin.assignments');
  const online = PEOPLE_TABS.find((p) => p.key === 'admin.online');
  return (
    <div data-testid="page-people-admin">
      <h1 className="text-2xl font-bold">{t('nav.admin.users')}</h1>
      <nav role="tablist" aria-label={t('nav.admin.users')} className="mb-4 mt-3 flex flex-wrap gap-1 border-b border-line" data-testid="people-tabs">
        {tabs.map((p) => (
          <NavLink key={p.key} to={p.to} role="tab" aria-selected={p.key === 'admin.users' ? usersOn : here?.key === p.key} data-testid={`people-tab-${p.key.slice(6)}`}
            className={() => tabCls(p.key === 'admin.users' ? usersOn : here?.key === p.key)}>
            {t(p.label)}
          </NavLink>
        ))}
        {assign && peopleTabAllowed(me.data, assign) && (
          <NavLink to={assign.to} role="tab" aria-selected={page?.key === 'admin.assignments'} data-testid="people-tab-assignments" className={() => tabCls(page?.key === 'admin.assignments')}>{t(assign.label)}</NavLink>
        )}
        {canList && (
          <NavLink to="/admin/users?view=departments" role="tab" aria-selected={view === 'departments'} data-testid="users-tab-departments" className={() => tabCls(view === 'departments')}>{t('dept.tab')}</NavLink>
        )}
        {canList && (
          <span className="relative inline-flex">
            <NavLink to="/admin/users?view=invitations" role="tab" aria-selected={view === 'invitations' || view === 'email_changes' || view === 'phone_changes'} data-testid="users-tab-invitations"
              className={() => `${tabCls(view === 'invitations' || view === 'email_changes' || view === 'phone_changes')} pe-1`}>{t('users.tab_invitations')}</NavLink>
            {decide && (
              <>
                <button type="button" className={`${tabCls(false)} ps-0`} aria-haspopup="menu" aria-expanded={more} aria-label={t('users.tab_more')} title={t('users.tab_more')} data-testid="users-tab-invitations-menu" onClick={() => setMore((v) => !v)}><ChevronDown size={14} /></button>
                {more && (
                  <div role="menu" className="absolute end-0 top-full z-20 mt-1 min-w-44 rounded-md border border-line bg-card p-1 shadow-lg" data-testid="users-tab-invitations-items">
                    {(['invitations', 'email_changes', 'phone_changes'] as const).map((k) => (
                      <NavLink key={k} role="menuitem" to={`/admin/users?view=${k}`} data-testid={k === 'invitations' ? 'users-menu-invitations' : `users-tab-${k}`} onClick={() => setMore(false)}
                        className="block rounded px-3 py-2 text-sm hover:bg-hover">{t(k === 'invitations' ? 'users.tab_invitations' : k === 'email_changes' ? 'emailChange.tab' : 'phoneChange.tab')}</NavLink>
                    ))}
                  </div>
                )}
              </>
            )}
          </span>
        )}
        {online && peopleTabAllowed(me.data, online) && (
          <NavLink to={online.to} role="tab" aria-selected={page?.key === 'admin.online'} data-testid="users-tab-online" className={() => tabCls(page?.key === 'admin.online')}>{t(online.label)}</NavLink>
        )}
      </nav>
      {subs.length > 1 && (
        <nav role="tablist" aria-label={t(here?.label ?? 'nav.admin.users')} className="mb-3 flex flex-wrap gap-1" data-testid="people-subtabs">
          {subs.map((p) => (
            <NavLink key={p.key} to={p.to} role="tab" aria-selected={page?.key === p.key} data-testid={`people-sub-${p.key.slice(6)}`} className={() => `btn ${page?.key === p.key ? 'btn-accent' : ''}`}>
              {t(p.key === here?.key && p.key === 'admin.roles' ? 'nav.admin.roles' : p.label)}
            </NavLink>
          ))}
        </nav>
      )}
      <Outlet />
    </div>
  );
}
