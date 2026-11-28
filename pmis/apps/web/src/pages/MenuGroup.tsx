import { Navigate, Link, useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useNavLayout } from '@/api/settings';
import type { NavItem } from '@/components/navItems';
import { ICONS, ICON_PROPS } from '@/lib/icons';
import { useMe } from '@/api/hooks';
import { applySidebarOverlay, sanitizeUiNav } from '@/lib/sidebarPrefs';
import { headingName, resolveLayout, type NavSub } from '@/lib/navLayout';

/**
 * The page of a menu group (Registers, the Logs...): the same screens the menu lists, as cards, so a parent entry opens its own page like Site Master does. It reads the
 * shared menu layout and the permission-filtered screens the menu already has; nothing of its own is stored.
 */
export function MenuGroup() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const { items } = useOutletContext<{ items: NavItem[] }>();
  const navQ = useNavLayout();
  const me = useMe(true);
  // the page lists what the menu lists: the personal hide and order apply here too
  const layout = applySidebarOverlay(resolveLayout(navQ.data?.layout ?? null), sanitizeUiNav(me.data?.user.ui_prefs?.sidebar ?? {}));
  const head = layout.headings.find((h) => h.id === id);
  if (!head) return navQ.isLoading ? null : <Navigate to="/my-work" replace />;
  const byKey = (k: string) => items.find((i) => i.key === k);
  const label = (n: NavItem) => t(n.key === 'sites' ? 'nav.sites_all' : `nav.${n.key}`);
  const cards = (keys: string[]) => keys.map(byKey).filter((n): n is NavItem => !!n).map((n) => {
    const Icon = ICONS[n.icon];
    return (
      <Link key={n.key} to={n.to} data-testid={`menu-card-${n.key}`} className="card flex items-center gap-3 p-4 hover:bg-hover">
        <Icon {...ICON_PROPS} size={18} className="shrink-0" /><span className="min-w-0 flex-1 truncate font-semibold">{label(n)}</span>
      </Link>
    );
  });
  const direct = head.children.filter((c): c is string => typeof c === 'string');
  const subs = head.children.filter((c): c is NavSub => typeof c !== 'string');
  const grid = 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3';
  return (
    <section className="space-y-4" data-testid="page-menu-group" data-group={head.id}>
      <h1 className="text-xl font-bold">{headingName(head, i18n.language)}</h1>
      <div className={grid}>{cards(direct)}</div>
      {subs.map((s) => (
        <div key={s.id} className="space-y-2" data-testid={`menu-sub-${s.id}`}>
          <h2 className="text-sm font-semibold text-mute">{headingName(s, i18n.language)}</h2>
          <div className={grid}>{cards(s.children)}</div>
        </div>
      ))}
    </section>
  );
}
