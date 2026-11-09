import { ChevronDown, ChevronRight, ChevronUp, Pencil, Star, X } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode, type RefObject, type KeyboardEvent as KE, type PointerEvent as PE } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useNavLayout } from '@/api/settings';
import { useStreams, useViews } from '@/api/sites';
import { ICONS, ICON_PROPS } from '@/lib/icons';
import { loadPref, savePref } from '@/lib/localPref';
import { headingIcon, headingName, keysOf, resolveLayout, type NavHead, type NavSub } from '@/lib/navLayout';
import { DEFAULT_STREAMS, DEFAULT_VIEWS, streamName, viewName, withDismantle } from '@/lib/streams';
import { NavLayoutEditor } from './NavLayoutEditor';
import { SITE_OM_VIEW, SITE_STREAM_SUBMENUS, type NavItem } from './navItems';

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 240;
const K = { collapsed: 'pmis.nav.collapsed', sites: 'pmis.nav.sites_open', favs: 'pmis.nav.favs', recent: 'pmis.nav.recent' };
const RECENT_MAX = 5;

/** Stored list of strings, tolerant of anything else that may sit in localStorage. */
const loadList = (key: string): string[] => { const v = loadPref<unknown>(key, []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; };

/** What the Site Register URL selects: a stream (`?stream=`), a work view (`?view=`) or everything. */
export function siteSelection(pathname: string, search: string): { stream: string; view: string } {
  if (!pathname.startsWith('/sites')) return { stream: '', view: '' };
  const p = new URLSearchParams(search);
  return { stream: p.get('stream') ?? '', view: p.get('view') ?? '' };
}

/** Sub-menus of the Site Register (owner request 2026-11-05): four streams, Dismantle (its own register), O&M (the OM view). */
function SiteSubmenus({ onNavigate, dismantle }: { onNavigate?: () => void; dismantle: NavItem | undefined }) {
  const { t, i18n } = useTranslation();
  const streamsQ = useStreams();
  const viewsQ = useViews();
  const loc = useLocation();
  const sel = siteSelection(loc.pathname, loc.search);
  const known = withDismantle(streamsQ.data);
  const streams = SITE_STREAM_SUBMENUS.map((code) => known.find((x) => x.code === code) ?? DEFAULT_STREAMS.find((x) => x.code === code)!);
  const om = (viewsQ.data?.length ? viewsQ.data : DEFAULT_VIEWS).find((v) => v.code === SITE_OM_VIEW) ?? DEFAULT_VIEWS.find((v) => v.code === SITE_OM_VIEW)!;
  const item = (testid: string, to: string, on: boolean, text: string) => (
    <Link key={testid} to={to} onClick={onNavigate} data-testid={testid} aria-current={on ? 'page' : undefined}
      className={`block rounded-md px-2 py-1.5 text-sm ${on ? 'bg-sideOn font-semibold text-accentText' : 'text-mute hover:bg-hover'}`}>{text}</Link>
  );
  return (
    <div className="ms-6 border-s border-line ps-1" role="group" aria-label={t('nav.site_submenus')} data-testid="nav-sites-views">
      {streams.map((st) => item(`nav-sites-stream-${st.code}`, `/sites?stream=${st.code}`, sel.stream === st.code && !sel.view, streamName(t, i18n.language, st)))}
      {dismantle && item('nav-dismantle', dismantle.to, loc.pathname.startsWith(dismantle.to), t('nav.dismantle'))}
      {item(`nav-sites-view-${om.code}`, `/sites?view=${om.code}`, sel.view === om.code && !sel.stream, viewName(i18n.language, om))}
    </div>
  );
}

/** Collapsible tree, favourites, recent items, filter, icon-only mode. Nav items arrive already filtered by the server's permission list. */
export function SidebarBody({ items, compact, unread, alerts = 0, activeKey, onNavigate }: { items: NavItem[]; compact: boolean; unread: number; alerts?: number; activeKey: string | undefined; onNavigate?: () => void }) {
  const { t, i18n } = useTranslation();
  const loc = useLocation();
  // The shared layout of the menu (contract 0.15.1): the default of the code until a System Admin saves one, or when it cannot be read.
  const navQ = useNavLayout();
  const saved = navQ.data?.layout ?? null;
  const layout = useMemo(() => resolveLayout(saved), [saved]);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(() => loadList(K.collapsed));
  const [sitesOpen, setSitesOpen] = useState<boolean>(() => loadPref<boolean>(K.sites, true) !== false);
  const [favs, setFavs] = useState<string[]>(() => loadList(K.favs));
  const [recent, setRecent] = useState<string[]>(() => loadList(K.recent));
  const [q, setQ] = useState('');
  const label = (n: NavItem) => t(n.key === 'sites' ? 'nav.sites_all' : `nav.${n.key}`);
  const byKey = (k: string) => items.find((i) => i.key === k);
  const sel = siteSelection(loc.pathname, loc.search);
  const subOn = SITE_STREAM_SUBMENUS.some((c) => c === sel.stream && !sel.view) || (sel.view === SITE_OM_VIEW && !sel.stream);

  // Recent items: adjust state while rendering when the active page changes (no effect needed).
  const [seen, setSeen] = useState<string | undefined>();
  if (activeKey && activeKey !== seen) {
    setSeen(activeKey);
    const n = [activeKey, ...recent.filter((x) => x !== activeKey)].slice(0, RECENT_MAX);
    setRecent(n);
    savePref(K.recent, n);
  }

  const toggleGroup = (g: string) => setCollapsed((c) => { const n = c.includes(g) ? c.filter((x) => x !== g) : [...c, g]; savePref(K.collapsed, n); return n; });
  const toggleSites = () => setSitesOpen((o) => { savePref(K.sites, !o); return !o; });
  const saveFavs = (n: string[]) => { setFavs(n); savePref(K.favs, n); };
  const togglePin = (k: string) => saveFavs(favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k]);
  const move = (k: string, d: -1 | 1) => { const i = favs.indexOf(k); const j = i + d; if (i < 0 || j < 0 || j >= favs.length) return; const n = [...favs]; [n[i], n[j]] = [n[j], n[i]]; saveFavs(n); };

  const linkCls = (isActive: boolean) => `flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-sm ${isActive ? 'border-s-2 border-accent bg-sideOn font-semibold' : 'hover:bg-hover'}`;
  const inner = (n: NavItem, badge: boolean) => {
    const Icon = ICONS[n.icon];
    return (
      <>
        <Icon {...ICON_PROPS} size={18} className="shrink-0" />
        {!compact && <span className="flex-1 truncate">{label(n)}</span>}
        {badge && n.key === 'messages' && unread > 0 && (compact
          ? <span data-testid="messages-badge" aria-label={t('messages.unread_count', { count: unread })} className="h-2 w-2 rounded-full bg-accent" />
          : <span data-testid="messages-badge" aria-label={t('messages.unread_count', { count: unread })} className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-xs text-accentInk">{unread}</span>)}
        {n.key === 'logs.alerts' && alerts > 0 && (compact
          ? <span data-testid="alerts-badge" aria-label={t('logs.open_alerts', { count: alerts })} className="h-2 w-2 rounded-full bg-late" />
          : <span data-testid="alerts-badge" aria-label={t('logs.open_alerts', { count: alerts })} className="grid h-5 min-w-5 place-items-center rounded-full bg-late px-1 text-xs text-white">{alerts}</span>)}
      </>
    );
  };
  const row = (n: NavItem, opts: { testid: string; extra?: ReactNode; active?: boolean; plain?: boolean }) => (
    <div key={opts.testid} className="group flex items-center">
      {opts.plain
        ? <Link to={n.to} onClick={onNavigate} data-testid={opts.testid} aria-current={opts.active ? 'page' : undefined} className={linkCls(!!opts.active)}>{inner(n, true)}</Link>
        : (
          <NavLink to={n.to} onClick={onNavigate} data-testid={opts.testid} {...(compact ? { title: label(n), 'aria-label': label(n) } : {})}
            className={({ isActive }) => linkCls(opts.active ?? (isActive || n.key === activeKey))}>{inner(n, opts.testid === `nav-${n.key}`)}</NavLink>
        )}
      {opts.extra}
    </div>
  );
  const pin = (n: NavItem) => !compact && (
    <button type="button" data-testid={`nav-pin-${n.key}`} aria-pressed={favs.includes(n.key)} aria-label={t(favs.includes(n.key) ? 'nav.unpin' : 'nav.pin')} title={t(favs.includes(n.key) ? 'nav.unpin' : 'nav.pin')}
      onClick={() => togglePin(n.key)} className="rounded-md p-1 text-faint hover:bg-hover hover:text-ink">
      <Star size={14} strokeWidth={1.75} aria-hidden className={favs.includes(n.key) ? 'fill-current text-accentText' : ''} />
    </button>
  );

  const needle = q.trim().toLowerCase();
  const matches = needle ? items.filter((i) => label(i).toLowerCase().includes(needle)) : [];
  const favItems = favs.map(byKey).filter((x): x is NavItem => !!x);
  const recentItems = recent.filter((k) => k !== activeKey).map(byKey).filter((x): x is NavItem => !!x);

  /** A screen of a heading. The Site Register entry carries its sub-menus; Dismantle sits among them when it is in the same heading as the Site Register. */
  const itemNode = (k: string, siblings: string[]) => {
    const n = byKey(k);
    if (!n) return null;
    const hasSites = !compact && siblings.includes('sites') && !!byKey('sites');
    if (n.key === 'dismantle' && hasSites) return null; // shown among the Site Register sub-menus
    if (n.key !== 'sites' || compact) return row(n, { testid: `nav-${n.key}`, extra: pin(n) });
    const dm = siblings.includes('dismantle') ? byKey('dismantle') : undefined;
    return (
      <div key={n.key}>
        {row(n, {
          testid: `nav-${n.key}`,
          active: loc.pathname.startsWith('/sites') && !subOn, plain: true,
          extra: (
            <>
              <button type="button" data-testid="nav-sites-toggle" aria-expanded={sitesOpen} aria-label={`${t(sitesOpen ? 'nav.collapse' : 'nav.expand')}: ${label(n)}`} onClick={toggleSites} className="rounded-md p-1 text-faint hover:bg-hover">
                <ChevronRight size={14} aria-hidden className={`${sitesOpen ? 'rotate-90 rtl:-rotate-90' : 'rtl:rotate-180'}`} />
              </button>
              {pin(n)}
            </>
          ),
        })}
        {sitesOpen && <SiteSubmenus onNavigate={onNavigate} dismantle={dm} />}
      </div>
    );
  };
  /** A main heading or a sub-heading of the shared layout, hidden when none of its screens is open to the caller (the filter applies after the layout). */
  const renderHeading = (h: NavHead | NavSub, sub: boolean): ReactNode => {
    const visible = keysOf(h).filter((k) => byKey(k));
    if (!visible.length) return null;
    const open = compact || !collapsed.includes(h.id);
    const hasActive = visible.some((k) => k === activeKey) || (visible.includes('sites') && loc.pathname.startsWith('/sites'));
    const concept = headingIcon(h);
    const Icon = concept ? ICONS[concept] : null;
    const direct = (h.children as (string | NavSub)[]).filter((c): c is string => typeof c === 'string');
    return (
      <div key={h.id} className={sub ? 'mb-1 ms-3' : 'mb-3'} data-testid={`nav-group-${h.id}`} data-active={hasActive || undefined} data-depth={sub ? 2 : 1}>
        {compact
          ? (!sub && <div className="mx-2 my-1 border-t border-line" aria-hidden />)
          : (
            <button type="button" data-testid={`nav-group-toggle-${h.id}`} aria-expanded={open} onClick={() => toggleGroup(h.id)}
              className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold hover:bg-hover ${hasActive ? 'text-accentText' : 'text-mute'}`}>
              <ChevronRight size={14} aria-hidden className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90 rtl:-rotate-90' : 'rtl:rotate-180'}`} />
              {Icon && <Icon {...ICON_PROPS} size={14} className="shrink-0" />}
              {headingName(h, i18n.language)}
            </button>
          )}
        {open && h.children.map((c) => (typeof c === 'string' ? itemNode(c, direct) : renderHeading(c, true)))}
      </div>
    );
  };

  if (editing && !compact) return <NavLayoutEditor setting={navQ.data} onDone={() => setEditing(false)} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!compact && (
        <div className="px-3 pb-2">
          <input type="search" className="input py-1.5" data-testid="nav-search" placeholder={t('nav.search')} aria-label={t('nav.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <nav aria-label={t('nav.sidebar_label')} className="flex-1 overflow-y-auto px-2">
        {needle ? (
          <div data-testid="nav-results">
            {matches.map((n) => row(n, { testid: `nav-${n.key}`, extra: pin(n) }))}
            {!matches.length && <p className="p-2 text-sm text-mute" data-testid="nav-no-match">{t('nav.no_match')}</p>}
          </div>
        ) : (
          <>
            {!compact && favItems.length > 0 && (
              <div className="mb-3" data-testid="nav-favourites">
                <div className="px-2 py-1 text-xs font-semibold text-mute">{t('nav.favourites')}</div>
                {favItems.map((n, i) => row(n, {
                  testid: `nav-fav-${n.key}`,
                  extra: (
                    <span className="flex">
                      <button type="button" data-testid={`fav-up-${n.key}`} disabled={i === 0} aria-label={`${t('nav.move_up')}: ${label(n)}`} onClick={() => move(n.key, -1)} className="rounded-md p-1 text-faint hover:bg-hover disabled:opacity-30"><ChevronUp size={14} aria-hidden /></button>
                      <button type="button" data-testid={`fav-down-${n.key}`} disabled={i === favItems.length - 1} aria-label={`${t('nav.move_down')}: ${label(n)}`} onClick={() => move(n.key, 1)} className="rounded-md p-1 text-faint hover:bg-hover disabled:opacity-30"><ChevronDown size={14} aria-hidden /></button>
                      <button type="button" data-testid={`fav-remove-${n.key}`} aria-label={`${t('nav.unpin')}: ${label(n)}`} onClick={() => togglePin(n.key)} className="rounded-md p-1 text-faint hover:bg-hover"><X size={14} aria-hidden /></button>
                    </span>
                  ),
                }))}
              </div>
            )}
            {!compact && recentItems.length > 0 && (
              <div className="mb-3" data-testid="nav-recent">
                <div className="px-2 py-1 text-xs font-semibold text-mute">{t('nav.recent')}</div>
                {recentItems.map((n) => row(n, { testid: `nav-recent-${n.key}`, active: false }))}
              </div>
            )}
            {layout.headings.map((h) => renderHeading(h, false))}
          </>
        )}
      </nav>
      {!compact && navQ.data?.can_edit && (
        <div className="px-3 pt-2">
          <button type="button" className="btn btn-sm w-full justify-center" data-testid="nav-edit" onClick={() => { setQ(''); setEditing(true); }}>
            <Pencil size={14} aria-hidden />{t('navEdit.edit')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Keyboard-accessible vertical splitter (WAI-ARIA window splitter). The sidebar sits at the inline start, so RTL inverts the arrow direction. */
export function SidebarSplitter({ width, onChange, asideRef }: { width: number; onChange: (w: number) => void; asideRef: RefObject<HTMLElement> }) {
  const { t } = useTranslation();
  const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
  const rtl = () => document.dir === 'rtl';
  const key = (e: KE) => {
    const step = e.shiftKey ? 48 : 16;
    const dir = rtl() ? -1 : 1;
    if (e.key === 'ArrowRight') onChange(clamp(width + dir * step));
    else if (e.key === 'ArrowLeft') onChange(clamp(width - dir * step));
    else if (e.key === 'Home') onChange(SIDEBAR_MIN);
    else if (e.key === 'End') onChange(SIDEBAR_MAX);
    else return;
    e.preventDefault();
  };
  const drag = useRef(false);
  const down = (e: PE) => { drag.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const moveP = (e: PE) => {
    if (!drag.current || !asideRef.current) return;
    const r = asideRef.current.getBoundingClientRect();
    onChange(clamp(rtl() ? r.right - e.clientX : e.clientX - r.left));
  };
  return (
    <div role="separator" aria-orientation="vertical" tabIndex={0} aria-label={t('nav.resize')} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={width}
      data-testid="sidebar-resizer" onKeyDown={key} onPointerDown={down} onPointerMove={moveP} onPointerUp={() => { drag.current = false; }}
      className="absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none hover:bg-accentSoft focus-visible:bg-accentSoft" />
  );
}
