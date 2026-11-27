import type { Me } from '@/api/types';
import { firstPeopleTab, PEOPLE_KEYS } from '@/components/PeopleAdmin';
import { ADMIN_ONLY, ANY_OF, BY_GRANT, BY_MODULE_VIEW, NAV, type NavItem } from '@/components/navItems';
import { canViewModule, hasGrant, isAdmin } from '@/lib/perm';

/**
 * The side-menu screens the caller may open: the permission filter of the server list, the grant-opened entries, then the
 * Users & Roles tabs folded into the one `admin.users` entry (the same list the Shell draws; the personal-sidebar editor of
 * My profile offers exactly these screens, 0197).
 */
/** The NAV entries the caller may open, before the Users & Roles tabs are folded into the one `admin.users` entry. */
export function permittedNavItems(me: Me | undefined): NavItem[] {
  const allowed = new Set(me?.effective.nav ?? []);
  return NAV.filter((n) => (BY_GRANT[n.key] ? hasGrant(me, BY_GRANT[n.key]) : BY_MODULE_VIEW[n.key] ? canViewModule(me, BY_MODULE_VIEW[n.key]) : ANY_OF[n.key] ? ANY_OF[n.key]!.some((m) => allowed.has(m)) : ADMIN_ONLY.has(n.key) ? isAdmin(me) : allowed.has(n.key)));
}

export function visibleNavItems(me: Me | undefined): NavItem[] {
  const items = permittedNavItems(me);
  const peopleTo = firstPeopleTab(me);
  return NAV.flatMap((n) => {
    if (n.key === 'admin.users') return peopleTo ? [{ ...n, to: peopleTo }] : [];
    if (PEOPLE_KEYS.has(n.key)) return [];
    return items.some((i) => i.key === n.key) ? [n] : [];
  });
}
