import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '@/api/hooks';

/** The tabs of the "Users & Roles" screen, in order. Each one shows only to holders of its module (effective.nav). */
export const PEOPLE_TABS = [
  { key: 'admin.users', to: '/admin/users', label: 'peopleAdmin.tab_users' },
  { key: 'admin.roles', to: '/admin/roles', label: 'nav.admin.roles' },
  { key: 'admin.groups', to: '/admin/groups', label: 'nav.admin.groups' },
  { key: 'admin.delegation', to: '/admin/delegation', label: 'nav.admin.delegation' },
  { key: 'admin.matrix', to: '/admin/matrix', label: 'nav.admin.matrix' },
] as const;

export const PEOPLE_KEYS: ReadonlySet<string> = new Set(PEOPLE_TABS.map((p) => p.key));

/** First tab this person may open, or null when they may open none. */
export function firstPeopleTab(nav: readonly string[] | undefined): string | null {
  const allowed = new Set(nav ?? []);
  return PEOPLE_TABS.find((p) => allowed.has(p.key))?.to ?? null;
}

/** One screen, "Users & Roles", with Users, Roles, Groups, Delegation and Responsibility Matrix as tabs (URLs unchanged). */
export function PeopleAdminLayout() {
  const { t } = useTranslation();
  const me = useMe(true);
  const loc = useLocation();
  const allowed = new Set(me.data?.effective.nav ?? []);
  const tabs = PEOPLE_TABS.filter((p) => allowed.has(p.key));
  const here = PEOPLE_TABS.find((p) => loc.pathname === p.to || loc.pathname.startsWith(`${p.to}/`));
  // A tab the person may not open sends them to the first one they may (the page itself still enforces access).
  if (me.data && here && !allowed.has(here.key) && tabs[0]) return <Navigate to={tabs[0].to} replace />;
  return (
    <div data-testid="page-people-admin">
      <h1 className="text-2xl font-bold">{t('nav.admin.users')}</h1>
      <nav role="tablist" aria-label={t('nav.admin.users')} className="mb-4 mt-3 flex flex-wrap gap-1 border-b border-line" data-testid="people-tabs">
        {tabs.map((p) => (
          <NavLink key={p.key} to={p.to} role="tab" aria-selected={here?.key === p.key} data-testid={`people-tab-${p.key.slice(6)}`}
            className={() => `-mb-px border-b-2 px-3 py-2 text-sm ${here?.key === p.key ? 'border-accent font-semibold text-ink' : 'border-transparent text-mute hover:text-ink'}`}>
            {t(p.label)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
