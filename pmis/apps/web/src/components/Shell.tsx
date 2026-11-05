import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Download, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, LogOut, Lock, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { useLogout, useMe, useNotifications, useSession } from '@/api/hooks';
import { useUnreadTotal } from '@/api/msg';
import { useOpenAlertCount } from '@/api/logs';
import { hasGrant, isAdmin } from '@/lib/perm';
import { notificationTarget } from '@/lib/x';
import { applyLocale, applyTheme, currentLocale, currentTheme } from '@/i18n';
import { HYBRID } from '@/lib/hybrid';
import { loadPref, savePref as storePref } from '@/lib/localPref';
import { ExportDialog } from './ExportDialog';
import { CommandPalette } from './CommandPalette';
import { firstPeopleTab, PEOPLE_KEYS, PEOPLE_TABS } from './PeopleAdmin';
import { ADMIN_ONLY, ANY_OF, BY_GRANT, NAV } from './navItems';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SidebarBody, SidebarSplitter } from './Sidebar';

export { NAV };
const WIDTH_KEY = 'pmis.nav.width';
const ICONS_KEY = 'pmis.nav.icons';

export function Shell() {
  const { t } = useTranslation();
  const me = useMe(true);
  const notes = useNotifications(true);
  const session = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const logout = useLogout();
  const [compact, setCompact] = useState<boolean>(() => loadPref<boolean>(ICONS_KEY, false) === true);
  const [width, setWidth] = useState<number>(() => { const w = Number(loadPref(WIDTH_KEY, SIDEBAR_DEFAULT)); return Number.isFinite(w) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)) : SIDEBAR_DEFAULT; });
  // The drawer is tied to the page it was opened on, so it closes by itself on navigation.
  const here = loc.pathname + loc.search;
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawer = drawerAt === here;
  const setDrawer = (o: boolean) => setDrawerAt(o ? here : null);
  const asideRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [palette, setPalette] = useState(false);
  const [exp, setExp] = useState(false);
  const [theme, setTheme] = useState(currentTheme());
  const [lang, setLang] = useState(currentLocale());

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const allowed = new Set(me.data?.effective.nav ?? []);
  const unread = useUnreadTotal(allowed.has('messages')).data ?? 0;
  const items = NAV.filter((n) => (BY_GRANT[n.key] ? hasGrant(me.data, BY_GRANT[n.key]) : ANY_OF[n.key] ? ANY_OF[n.key]!.some((m) => allowed.has(m)) : ADMIN_ONLY.has(n.key) ? isAdmin(me.data) : allowed.has(n.key)));
  const alerts = useOpenAlertCount(isAdmin(me.data)).data ?? 0;
  // Users, Online now, Roles, Groups, Delegation and the Matrix are tabs of one screen: one sidebar entry, opening the first allowed tab.
  const peopleTo = firstPeopleTab(me.data);
  const inPeople = PEOPLE_TABS.some((p) => loc.pathname === p.to || loc.pathname.startsWith(`${p.to}/`));
  const sideItems = NAV.flatMap((n) => {
    if (n.key === 'admin.users') return peopleTo ? [{ ...n, to: peopleTo }] : [];
    if (PEOPLE_KEYS.has(n.key)) return [];
    return items.some((i) => i.key === n.key) ? [n] : [];
  });
  const pending = notes.data?.unread_count ?? 0;
  const current = inPeople ? NAV.find((n) => n.key === 'admin.users') : NAV.find((n) => loc.pathname.startsWith(n.to));
  const savePref = (p: { locale?: 'en' | 'ar'; theme?: 'light' | 'dark' }) => void api.patch('/me/preferences', { body: p }).catch(() => {});

  const resize = (w: number) => { setWidth(w); storePref(WIDTH_KEY, w); };
  const toggleCompact = () => setCompact((c) => { storePref(ICONS_KEY, !c); return !c; });
  useEffect(() => {
    if (!drawer) return;
    closeRef.current?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerAt(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [drawer]);
  const activeKey = current && sideItems.some((i) => i.key === current.key) ? current.key : undefined;
  const siteSub = loc.pathname.startsWith('/sites') ? new URLSearchParams(loc.search) : null;
  const stream = siteSub?.get('stream') ?? null;
  const view = siteSub?.get('view') ?? null;
  const groupFirst = current ? sideItems.find((i) => i.group === current.group) : undefined;
  const brand = (
    <div className="flex items-center gap-2 px-4 py-4 font-bold">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-accentInk">G</span>{!compact && t('app.name')}
    </div>
  );

  const switchLang = () => { const l = lang === 'en' ? 'ar' : 'en'; applyLocale(l); setLang(l); savePref({ locale: l }); };
  const switchTheme = () => { const n = theme === 'light' ? 'dark' : 'light'; applyTheme(n); setTheme(n); savePref({ theme: n }); };

  return (
    <div className="flex min-h-screen">
      <aside ref={asideRef} data-testid="sidebar" aria-label={t('nav.sidebar_label')} style={{ width: compact ? 56 : width }}
        className="sticky top-0 hidden h-screen shrink-0 flex-col border-e border-line bg-side md:flex">
        {brand}
        <SidebarBody items={sideItems} compact={compact} unread={unread} alerts={alerts} activeKey={activeKey} />
        {!compact && <div className="border-t border-line px-4 py-3 text-xs text-faint">Synthetic data</div>}
        {!compact && <SidebarSplitter width={width} onChange={resize} asideRef={asideRef} />}
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-50 md:hidden" data-testid="sidebar-drawer-root">
          <button className="absolute inset-0 bg-scrim" aria-label={t('nav.close_menu')} tabIndex={-1} onClick={() => setDrawer(false)} />
          <div role="dialog" aria-modal="true" aria-label={t('nav.sidebar_label')} data-testid="sidebar-drawer" className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col border-e border-line bg-card">
            <div className="flex items-center justify-between pe-2">
              <div className="flex items-center gap-2 px-4 py-4 font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk">G</span>{t('app.name')}</div>
              <button ref={closeRef} className="btn min-h-11 min-w-11" data-testid="drawer-close" aria-label={t('nav.close_menu')} onClick={() => setDrawer(false)}><X size={16} aria-hidden /></button>
            </div>
            <SidebarBody items={sideItems} compact={false} unread={unread} alerts={alerts} activeKey={activeKey} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-line bg-card px-4 py-2">
          <button className="btn min-h-11 min-w-11 md:hidden" data-testid="topbar-menu" aria-label={t('nav.open_menu')} aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={16} aria-hidden /></button>
          <button className="btn hidden md:inline-flex" data-testid="topbar-collapse" aria-label={t(compact ? 'nav.full_menu' : 'nav.icons_only')} title={t(compact ? 'nav.full_menu' : 'nav.icons_only')} aria-pressed={compact} onClick={toggleCompact}>{compact ? <PanelLeftOpen size={16} aria-hidden className="rtl:-scale-x-100" /> : <PanelLeftClose size={16} aria-hidden className="rtl:-scale-x-100" />}</button>
          <nav aria-label="breadcrumb" data-testid="breadcrumb" className="min-w-0 text-sm text-mute">
            <ol className="flex flex-wrap items-center gap-1">
              <li><Link className="hover:text-ink" to="/my-work">{t('app.name')}</Link></li>
              {current && groupFirst && <li className="flex gap-1"><span aria-hidden>/</span><Link className="hover:text-ink" to={groupFirst.to}>{t(`nav.group_${current.group}`)}</Link></li>}
              {current && <li className="flex gap-1"><span aria-hidden>/</span>{view || stream
                ? <Link className="hover:text-ink" to={sideItems.find((i) => i.key === current.key)?.to ?? current.to}>{t(`nav.${current.key}`)}</Link>
                : <b className="text-ink" aria-current="page">{t(`nav.${current.key}`)}</b>}</li>}
              {current && (view || stream) && <li className="flex gap-1"><span aria-hidden>/</span><b className="text-ink" aria-current="page" data-testid="breadcrumb-sub">{stream && !view ? t(`stream.${stream}`, { defaultValue: stream }) : view}</b></li>}
            </ol>
          </nav>
          <div className="flex-1" />
          <button className="btn min-w-60 justify-start font-normal text-mute" data-testid="topbar-search" onClick={() => setPalette(true)}>
            <Search size={16} /><span className="flex-1 text-start">{t('top.search')}</span><kbd className="mono rounded border border-line px-1 text-xs">Ctrl K</kbd>
          </button>
          <button className="btn" data-testid="topbar-export" onClick={() => setExp(true)}><Download size={16} />{t('export.open')}</button>
          <button className="btn" data-testid="topbar-lang" aria-label={t('top.language')} onClick={switchLang}>{lang === 'en' ? 'ع' : 'EN'}</button>
          <button className="btn" data-testid="topbar-theme" aria-label={t('top.theme')} onClick={switchTheme}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</button>
          <NotificationBell count={pending} />
          <Popover.Root>
            <Popover.Trigger asChild>
              <button className="flex items-center gap-2 rounded-full border border-line px-2 py-1 text-sm" data-testid="topbar-user" aria-label={t('top.account')}>
                <span className="grid h-6 w-6 place-items-center rounded-full bg-accent text-xs font-bold text-accentInk">{(me.data?.user.display_name ?? '?').split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>
                {me.data?.user.display_name}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} data-testid="user-menu" className="card z-50 w-56 p-2">
                <Popover.Close asChild><button className="btn w-full justify-start" data-testid="user-menu-profile" onClick={() => nav('/profile')}><UserRound size={14} />{t('top.my_profile')}</button></Popover.Close>
                {session.data?.auth_method === 'local'
                  ? <Popover.Close asChild><button className="btn w-full justify-start" data-testid="user-menu-change-password" onClick={() => nav('/change-password')}><Lock size={14} />{t('top.change_password')}</button></Popover.Close>
                  : <p className="p-2 text-sm text-mute">{t('top.no_password')}</p>}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button className="btn" data-testid="topbar-signout" aria-label={t('top.sign_out')} onClick={() => logout.mutate(undefined, { onSuccess: () => { void qc.invalidateQueries({ queryKey: ['session'] }); nav('/login'); } })}><LogOut size={16} /></button>
        </header>
        {HYBRID && <div role="status" data-testid="hybrid-banner" className="border-b border-line bg-waitBg px-4 py-1 text-xs text-waitInk">{t('hybrid.banner')}</div>}
        <main className="p-6"><Outlet /></main>
      </div>
      <ExportDialog open={exp} onClose={() => setExp(false)} />
      <CommandPalette open={palette} onOpenChange={setPalette} items={items.map((i) => ({ key: i.key, to: i.to }))} />
    </div>
  );
}

function NotificationBell({ count }: { count: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const n = useNotifications(true);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const readAll = () => api.post<void>('/notifications/read-all').then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  const go = (x: { id: string; read_at?: string | null; link?: string | null; entity_type?: string | null; entity_id?: string | null }) => {
    setOpen(false);
    if (!x.read_at) void api.post(`/notifications/${x.id}/read`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }), () => {});
    const to = notificationTarget(x);
    if (to) nav(to);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="btn relative" data-testid="topbar-bell" aria-label={t('top.notifications')}>
          <Bell size={16} />
          {count > 0 && <span data-testid="bell-count" className="absolute -top-2 -end-2 grid h-5 min-w-5 place-items-center rounded-full bg-late px-1 text-xs text-accentInk">{count}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} data-testid="bell-panel" className="card z-50 w-80 p-2">
          <button className="btn mb-2 w-full" onClick={() => void readAll()}><Check size={14} />{t('top.mark_all_read')}</button>
          {(n.data?.items ?? []).length === 0 && <p className="p-2 text-mute">{t('top.no_notifications')}</p>}
          {n.data?.items.slice(0, 8).map((x) => (
            <button key={x.id} data-testid={`bell-item-${x.id}`} onClick={() => go(x)} className={`block w-full rounded-md p-2 text-start text-sm hover:bg-hover ${x.read_at ? 'text-mute' : 'font-semibold'}`}>{x.title}</button>
          ))}
          <Link to="/inbox" data-testid="bell-open-inbox" onClick={() => setOpen(false)} className="mt-1 block rounded-md p-2 text-center text-sm font-semibold text-link hover:bg-hover">{t('top.open_inbox')}</Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
