import * as Popover from '@radix-ui/react-popover';
import { AutoHints } from './AutoHints';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Palette, Plus, Menu, Moon, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Search, Sun, LogOut, Lock, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { useLogout, useMe, useNotifications, useSession } from '@/api/hooks';
import { useMenuCounts, useUnreadTotal } from '@/api/msg';
import { useUiIdentity } from '@/api/settings';
import { useOpenAlertCount } from '@/api/logs';
import { useFieldPwaSettings } from '@/api/fieldPwa';
import { fieldPendingCount } from '@/lib/fieldOutbox';
import { wipeFieldData } from '@/lib/fieldPwa';
import { isAdmin } from '@/lib/perm';
import { applyLocale, applyTheme, currentLocale, currentTheme } from '@/i18n';
import { HYBRID } from '@/lib/hybrid';
import { loadPref, savePref as storePref } from '@/lib/localPref';
import { applyAppearance } from '@/lib/appearance';
import { API_BASE } from '@/api/client';
import { sanitizeUiNav, type UiNav } from '@/lib/sidebarPrefs';
import { useUpdateMyProfile } from '@/api/profile';
import { applyBrand } from '@/lib/brands';
import { ExportDialog } from './ExportDialog';
import { CommandPalette } from './CommandPalette';
import { RowActions } from './RowActions';
import { NotificationBell } from './NotificationPanel';
import { ShortcutsHelp } from './ShortcutsHelp';
import { Avatar } from './Avatar';
import { QuickTour } from './QuickTour';
import { PEOPLE_TABS } from './PeopleAdmin';
import { permittedNavItems, visibleNavItems } from '@/lib/visibleNav';
import { NAV } from './navItems';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SidebarBody, SidebarSplitter } from './Sidebar';

export { NAV };
const WIDTH_KEY = 'pmis.nav.width';
const LOGO_KEY = 'pmis.identity.logo';
const ICONS_KEY = 'pmis.nav.icons';
/** The menu hides by itself (a narrow rail that opens on hover) unless it is pinned; kept in the browser like the width and the icons-only choice. */
const AUTO_KEY = 'pmis.nav.auto';

export function Shell() {
  const { t } = useTranslation();
  const me = useMe(true);
  const notes = useNotifications(true);
  const session = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const logout = useLogout();
  // 0241: the menu style of the appearance profile is the default while the user has not switched the rail/pin in this browser
  const menuStyle = me.data?.user.appearance?.menu_style;
  const [compactOwn, setCompact] = useState<boolean | null>(null);
  const [autoOwn, setAuto] = useState<boolean | null>(null);
  const compact = compactOwn ?? loadPref<boolean | null>(ICONS_KEY, null) ?? (menuStyle === 'rail');
  const auto = autoOwn ?? loadPref<boolean | null>(AUTO_KEY, null) ?? (menuStyle === 'autohide');
  const [hover, setHover] = useState(false);
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

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // 0130: the UI design follows the signed-in user's effective design (independent of the light/dark theme)
  const userBrand = me.data?.user.brand;
  useEffect(() => { if (userBrand) applyBrand(userBrand); }, [userBrand]);
  // 0241: the appearance profile follows the signed-in user (own choices, else the organization defaults)
  const userAppearance = me.data?.user.appearance;
  // 0243: the workspace logo of the identity replaces the built-in badge; nothing changes without an enabled logo.
  // ui_identity_state is readable by every signed-in user; the last seen state is cached so a reload does not flash the badge.
  const ident = useUiIdentity();
  useEffect(() => {
    if (ident.data) storePref(LOGO_KEY, ident.data.logo?.enabled ? { version: ident.data.logo.version } : null);
  }, [ident.data]);
  const logo: { version: number } | null = ident.data ? (ident.data.logo?.enabled ? { version: ident.data.logo.version } : null) : loadPref(LOGO_KEY, null);
  const brandMark = logo
    ? <img src={`${API_BASE}/ui/assets/logo?v=${logo.version}`} alt="" data-testid="sidebar-logo" className="h-8 w-8 shrink-0 rounded-md object-contain" />
    : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-accentInk">G</span>;
  useEffect(() => { if (userAppearance) applyAppearance(userAppearance); }, [userAppearance]);

  // 0242 (proposal item 4): the personal sidebar of the profile. The pins of a browser that had them only locally
  // (pmis.nav.favs) move into the profile once, so they follow the user to every device.
  const side: UiNav = sanitizeUiNav(me.data?.user.ui_prefs?.sidebar ?? {});
  const updateProfile = useUpdateMyProfile();
  const savePins = (pins: string[]) => {
    const v = me.data?.user.version;
    if (v === undefined) return;
    updateProfile.mutate({ version: Number(v), patch: { ui_prefs: { sidebar: { ...side, pins } } } });
  };
  const migratedPins = useRef(false);
  useEffect(() => {
    if (!me.data || migratedPins.current) return;
    migratedPins.current = true;
    const stored = me.data.user.ui_prefs?.sidebar;
    if (stored?.pins !== undefined) return;
    let local: string[] = [];
    try { const raw = JSON.parse(localStorage.getItem('pmis.nav.favs') ?? '[]'); if (Array.isArray(raw)) local = raw.filter((x): x is string => typeof x === 'string'); } catch { /* nothing to move */ }
    if (local.length) savePins(local.slice(0, 20));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.user.id]);

  // 0.15.42: the language and theme saved on the server follow the user to a new device
  const userTheme = me.data?.user.theme;
  const userLocale = me.data?.user.locale;
  // a choice already made in this browser stays; a browser with none (a new device) takes the saved one
  const theme: 'light' | 'dark' = localStorage.getItem('pmis.theme') === null && (userTheme === 'light' || userTheme === 'dark') ? userTheme : currentTheme();
  const lang: 'en' | 'ar' = localStorage.getItem('pmis.locale') === null && (userLocale === 'en' || userLocale === 'ar') ? userLocale : currentLocale();
  useEffect(() => { if (theme !== currentTheme()) applyTheme(theme); }, [theme]);
  useEffect(() => { if (lang !== currentLocale()) applyLocale(lang); }, [lang]);

  const allowed = new Set(me.data?.effective.nav ?? []);
  const unread = useUnreadTotal(allowed.has('messages')).data ?? 0;
  const waiting = useMenuCounts(allowed.has('approvals'), allowed.has('my_work'));
  const counts = { approvals: waiting.approvals, my_work: waiting.my_work };
  const alerts = useOpenAlertCount(isAdmin(me.data)).data ?? 0;
  // Users, Online now, Roles, Groups, Delegation and the Matrix are tabs of one screen: one sidebar entry, opening the first allowed tab.
  const inPeople = PEOPLE_TABS.some((p) => loc.pathname === p.to || loc.pathname.startsWith(`${p.to}/`));
  // Field mode (0411): its menu entry shows only while a System Admin has turned it on
  const fieldOn = useFieldPwaSettings().enabled;
  const sideItems = visibleNavItems(me.data).filter((n) => n.key !== 'field' || fieldOn);
  const paletteItems = permittedNavItems(me.data).filter((n) => n.key !== 'field' || fieldOn);
  const pending = notes.data?.unread_count ?? 0;
  const current = inPeople ? NAV.find((n) => n.key === 'admin.users') : [...NAV].sort((a, b) => b.to.length - a.to.length).find((n) => loc.pathname.startsWith(n.to));
  // saved on the server (PATCH /me/preferences, 0.15.42); the cached /me is updated so the effects above do not switch it back
  const savePref = (p: { locale?: 'en' | 'ar'; theme?: 'light' | 'dark' }) => {
    qc.setQueryData<typeof me.data>(['me'], (d) => (d ? { ...d, user: { ...d.user, ...p } } : d));
    void api.patch('/me/preferences', { body: p }).catch(() => {});
  };

  const resize = (w: number) => { setWidth(w); storePref(WIDTH_KEY, w); };
  const togglePin = () => { storePref(AUTO_KEY, !auto); setAuto(!auto); setHover(false); };
  /** the rail shows icons only; it opens over the page (no push) while the pointer or the keyboard is in it */
  const open = !auto || hover;
  const rail = compact || !open;
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
      {brandMark}{!rail && t('app.name')}
      {!rail && <button className="btn ms-auto hidden min-h-8 min-w-8 md:inline-flex" data-testid="sidebar-pin" aria-pressed={!auto} aria-label={t(auto ? 'nav.pin_menu' : 'nav.autohide_menu')} title={t(auto ? 'nav.pin_menu' : 'nav.autohide_menu')} onClick={togglePin}>{auto ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}</button>}
    </div>
  );

  const switchLang = () => { const l = lang === 'en' ? 'ar' : 'en'; applyLocale(l); savePref({ locale: l }); };
  const switchTheme = () => { const n = theme === 'light' ? 'dark' : 'light'; applyTheme(n); savePref({ theme: n }); };

  // TV mode (/dashboard?tv=1): the Dashboard alone, larger, refreshed every minute, for a wall screen. Esc or the button leaves it. Same data and permissions as the normal page.
  const tv = loc.pathname === '/dashboard' && new URLSearchParams(loc.search).get('tv') === '1';
  useEffect(() => {
    if (!tv) return;
    const id = window.setInterval(() => { void qc.invalidateQueries(); }, 60_000);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') nav('/dashboard'); };
    window.addEventListener('keydown', esc);
    return () => { window.clearInterval(id); window.removeEventListener('keydown', esc); };
  }, [tv, qc, nav]);
  if (tv) {
    return (
      <div className="min-h-screen bg-bg p-6" data-testid="tv-mode" style={{ zoom: 1.2 }}>
        <button className="btn fixed end-4 top-4 z-50" data-testid="tv-exit" onClick={() => nav('/dashboard')}><X size={16} />{t('dash.tv_exit')}</button>
        <Outlet context={{ items: sideItems }} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {auto && <div className="hidden shrink-0 md:block" style={{ width: 56 }} aria-hidden />}
      <aside ref={asideRef} data-testid="sidebar" data-auto={auto ? 'true' : 'false'} aria-label={t('nav.sidebar_label')} style={{ width: rail ? 56 : width }}
        onMouseEnter={auto ? () => setHover(true) : undefined} onMouseLeave={auto ? () => setHover(false) : undefined}
        onFocus={auto ? () => setHover(true) : undefined} onBlur={auto ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false); } : undefined}
        className={`side-scope ${auto ? 'fixed start-0 z-40' : 'sticky'} top-0 hidden h-screen shrink-0 flex-col border-e border-line bg-side md:flex`}>
        {brand}
        <SidebarBody items={sideItems} compact={rail} unread={unread} alerts={alerts} counts={counts} activeKey={activeKey} side={side} onPinsChange={savePins} />
        {/* the sample-data label only in the pure mock build (P0 of the 2026-11-17 audit: it also showed against the real server) */}
        {!rail && import.meta.env.VITE_USE_MOCKS === 'true' && !HYBRID && <div className="border-t border-line px-4 py-3 text-xs text-faint">Synthetic data</div>}
        {!rail && <SidebarSplitter width={width} onChange={resize} asideRef={asideRef} />}
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-50 md:hidden" data-testid="sidebar-drawer-root">
          <button className="absolute inset-0 bg-scrim" aria-label={t('nav.close_menu')} tabIndex={-1} onClick={() => setDrawer(false)} />
          <div role="dialog" aria-modal="true" aria-label={t('nav.sidebar_label')} data-testid="sidebar-drawer" className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col border-e border-line bg-card">
            <div className="flex items-center justify-between pe-2">
              <div className="flex items-center gap-2 px-4 py-4 font-bold">{brandMark}{t('app.name')}</div>
              <button ref={closeRef} className="btn min-h-11 min-w-11" data-testid="drawer-close" aria-label={t('nav.close_menu')} onClick={() => setDrawer(false)}><X size={16} aria-hidden /></button>
            </div>
            <SidebarBody items={sideItems} compact={false} unread={unread} alerts={alerts} counts={counts} activeKey={activeKey} onNavigate={() => setDrawer(false)} side={side} onPinsChange={savePins} />
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
              {current && groupFirst && t(`nav.group_${current.group}`) !== t(`nav.${current.key}`) && <li className="flex gap-1"><span aria-hidden>/</span><Link className="hover:text-ink" to={groupFirst.to}>{t(`nav.group_${current.group}`)}</Link></li>}
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
          <QuickCreate me={me.data} allowed={allowed} />
          <NotificationBell count={pending} />
          <Popover.Root>
            <Popover.Trigger asChild>
              <button className="flex items-center gap-2 rounded-full border border-line px-2 py-1 text-sm" data-testid="topbar-user" aria-label={t('top.account')}>
                <Avatar name={me.data?.user.display_name} size="sm" />
                {me.data?.user.display_name}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} data-testid="user-menu" className="card z-50 w-56 p-2">
                <Popover.Close asChild><button className="btn w-full justify-start" data-testid="user-menu-profile" onClick={() => nav('/profile')}><UserRound size={14} />{t('top.my_profile')}</button></Popover.Close>
                <Popover.Close asChild><button className="btn w-full justify-start" data-testid="user-menu-appearance" onClick={() => nav('/profile#pf-brand')}><Palette size={14} />{t('top.appearance')}</button></Popover.Close>
                {session.data?.auth_method === 'local'
                  ? <Popover.Close asChild><button className="btn w-full justify-start" data-testid="user-menu-change-password" onClick={() => nav('/change-password')}><Lock size={14} />{t('top.change_password')}</button></Popover.Close>
                  : <p className="p-2 text-sm text-mute">{t('top.no_password')}</p>}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button className="btn" data-testid="topbar-signout" aria-label={t('top.sign_out')} onClick={() => { void (async () => { const n = await fieldPendingCount(me.data?.user.id); if (n > 0 && !window.confirm(t('field.signout_warn', { count: n }))) return; logout.mutate(undefined, { onSuccess: () => { void wipeFieldData(); void qc.invalidateQueries({ queryKey: ['session'] }); nav('/login'); } }); })(); }}><LogOut size={16} /></button>
        </header>
        {HYBRID && <div role="status" data-testid="hybrid-banner" className="border-b border-line bg-waitBg px-4 py-1 text-xs text-waitInk">{t('hybrid.banner')}</div>}
        <AutoHints />
        <main className="p-6"><Outlet context={{ items: sideItems }} /></main>
      </div>
      <ExportDialog open={exp} onClose={() => setExp(false)} />
      <ShortcutsHelp />
      <RowActions />
      {me.data?.user.id && <QuickTour userId={me.data.user.id} />}
      <CommandPalette open={palette} onOpenChange={setPalette} items={paletteItems.map((i) => ({ key: i.key, to: i.to }))} />
    </div>
  );
}

/** The "+" of the top bar: shortcuts to the things this person may start. Each one only opens its page; the page and the server still check the permission. */
function QuickCreate({ me, allowed }: { me: ReturnType<typeof useMe>['data']; allowed: Set<string> }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const canSite = isAdmin(me) || !!me?.effective.grants.some((g) => g.module_key === 'sites' && (g.action as string) === 'create');
  const items = [
    canSite ? { key: 'site', to: '/sites/new', label: t('top.qc_site') } : null,
    allowed.has('status_updates') ? { key: 'status', to: '/status-updates', label: t('top.qc_status') } : null,
    allowed.has('messages') ? { key: 'message', to: '/messages', label: t('top.qc_message') } : null,
    allowed.has('absence') ? { key: 'absence', to: '/absence', label: t('top.qc_absence') } : null,
  ].filter((x): x is { key: string; to: string; label: string } => x !== null);
  if (items.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="btn" data-testid="topbar-quick-create" aria-label={t('top.quick_create')} title={t('top.quick_create')}><Plus size={16} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} data-testid="quick-create-menu" className="card z-50 w-56 p-2">
          {items.map((i) => <Popover.Close asChild key={i.key}><button className="btn w-full justify-start" data-testid={`qc-${i.key}`} onClick={() => nav(i.to)}><Plus size={14} />{i.label}</button></Popover.Close>)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
