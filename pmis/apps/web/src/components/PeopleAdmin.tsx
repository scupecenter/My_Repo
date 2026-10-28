import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import type { Me } from '@/api/types';
import { hasGrant } from '@/lib/perm';

/**
 * The pages of the "Users & Roles" screen, in tab order. Each one opens only for holders of its module (effective.nav), or
 * of its grant when it has one (Online now: `manage_users`, as in the old sidebar). A page with `under` is a sub-tab of
 * that tab (Online now sits under Users, beside Deleted) and has no tab of its own.
 */
export const PEOPLE_TABS: readonly { key: string; to: string; label: string; grant?: string; under?: string }[] = [
  { key: 'admin.users', to: '/admin/users', label: 'peopleAdmin.tab_users' },
  { key: 'admin.online', to: '/admin/online', label: 'nav.admin.online', grant: 'manage_users', under: 'admin.users' },
  { key: 'admin.roles', to: '/admin/roles', label: 'nav.admin.roles' },
  { key: 'admin.groups', to: '/admin/groups', label: 'nav.admin.groups' },
  { key: 'admin.delegation', to: '/admin/delegation', label: 'nav.admin.delegation' },
  { key: 'admin.matrix', to: '/admin/matrix', label: 'nav.admin.matrix' },
];

export const PEOPLE_KEYS: ReadonlySet<string> = new Set(PEOPLE_TABS.map((p) => p.key));

/** Whether this person may open the tab. */
export function peopleTabAllowed(me: Me | undefined, tab: (typeof PEOPLE_TABS)[number]): boolean {
  if (!me) return false;
  return tab.grant ? hasGrant(me, tab.grant) : me.effective.nav.includes(tab.key as never);
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
