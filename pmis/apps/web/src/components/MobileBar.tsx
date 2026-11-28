import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { ICONS, ICON_PROPS } from '@/lib/icons';
import type { NAV } from './navItems';

type NavItem = (typeof NAV)[number];

/** The keys the bottom bar offers, in order; only those this person may see are shown (the same nav the sidebar shows). */
export const MOBILE_BAR_KEYS = ['my_work', 'inbox', 'approvals', 'dashboard'] as const;

/**
 * Item 12: below the md breakpoint the main places sit in a bar at the bottom of the screen, within thumb reach, and "More" opens the full menu drawer.
 * It adds no route and no permission: it only links to items the sidebar already lists for this person.
 */
export function MobileBar({ items, unread, onMore }: { items: NavItem[]; unread: number; onMore: () => void }) {
  const { t } = useTranslation();
  const shown = MOBILE_BAR_KEYS.map((k) => items.find((i) => i.key === k)).filter((i): i is NavItem => !!i).slice(0, 4);
  return (
    <nav aria-label={t('mobile.bar')} data-testid="mobile-bar" className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      {shown.map((i) => {
        const Icon = ICONS[i.icon];
        return (
          <NavLink key={i.key} to={i.to} data-testid={`mobile-bar-${i.key}`} className={({ isActive }) => `relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs ${isActive ? 'font-semibold text-accentText' : 'text-mute'}`}>
            {Icon && <Icon {...ICON_PROPS} size={20} aria-hidden />}
            <span className="max-w-full truncate">{t(`nav.${i.key}`)}</span>
            {i.key === 'inbox' && unread > 0 && <span className="absolute end-1/4 top-1 rounded-full bg-accent px-1 text-[10px] text-white" data-testid="mobile-bar-unread">{unread}</span>}
          </NavLink>
        );
      })}
      <button type="button" className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs text-mute" data-testid="mobile-bar-more" aria-label={t('mobile.more')} onClick={onMore}>
        <MoreHorizontal size={20} aria-hidden /><span>{t('mobile.more')}</span>
      </button>
    </nav>
  );
}
