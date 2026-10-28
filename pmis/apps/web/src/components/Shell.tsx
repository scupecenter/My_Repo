import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Inbox, LayoutGrid, Home, BarChart3, FileText, Users, Table2, Settings, Download, KeyRound, UsersRound, UserX, ShieldCheck, Eye, Activity, ScrollText, MessageSquare, Megaphone, Menu, Moon, Search, Sun, LogOut, Lock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { useLogout, useMe, useNotifications, useSession } from '@/api/hooks';
import { useUnreadTotal } from '@/api/msg';
import { hasGrant } from '@/lib/perm';
import { applyLocale, applyTheme, currentLocale, currentTheme } from '@/i18n';
import { HYBRID } from '@/lib/hybrid';
import { ExportDialog } from './ExportDialog';
import { CommandPalette } from './CommandPalette';
import { firstPeopleTab, PEOPLE_KEYS, PEOPLE_TABS } from './PeopleAdmin';

export const NAV: { key: string; to: string; icon: ReactNode; group: 'work' | 'data' | 'admin' }[] = [
  { key: 'my_work', to: '/my-work', icon: <Home size={18} />, group: 'work' },
  { key: 'approvals', to: '/approvals', icon: <Inbox size={18} />, group: 'work' },
  { key: 'sites', to: '/sites', icon: <LayoutGrid size={18} />, group: 'work' },
  { key: 'dashboard', to: '/dashboard', icon: <BarChart3 size={18} />, group: 'work' },
  { key: 'messages', to: '/messages', icon: <MessageSquare size={18} />, group: 'work' },
  { key: 'templates', to: '/templates', icon: <FileText size={18} />, group: 'data' },
  { key: 'admin.users', to: '/admin/users', icon: <Users size={18} />, group: 'admin' },
  { key: 'admin.roles', to: '/admin/roles', icon: <KeyRound size={18} />, group: 'admin' },
  { key: 'admin.groups', to: '/admin/groups', icon: <UsersRound size={18} />, group: 'admin' },
  { key: 'admin.delegation', to: '/admin/delegation', icon: <ShieldCheck size={18} />, group: 'admin' },
  { key: 'absence', to: '/absence', icon: <UserX size={18} />, group: 'work' },
  { key: 'admin.matrix', to: '/admin/matrix', icon: <Table2 size={18} />, group: 'admin' },
  { key: 'admin.settings', to: '/admin/settings', icon: <Settings size={18} />, group: 'admin' },
  { key: 'admin.security_log', to: '/admin/security-log', icon: <ScrollText size={18} />, group: 'admin' },
  { key: 'admin.online', to: '/admin/online', icon: <Activity size={18} />, group: 'admin' },
  { key: 'announcements', to: '/admin/announcements', icon: <Megaphone size={18} />, group: 'admin' },
  { key: 'audit', to: '/audit', icon: <Eye size={18} />, group: 'admin' },
];

/** Entries opened by a grant rather than by the server's module list (security log, online now). */
const BY_GRANT: Record<string, string> = { 'admin.security_log': 'view_security_log', 'admin.online': 'manage_users' };

export function Shell() {
  const { t } = useTranslation();
  const me = useMe(true);
  const notes = useNotifications(true);
  const session = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const logout = useLogout();
  const [side, setSide] = useState(true);
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
  const items = NAV.filter((n) => (BY_GRANT[n.key] ? hasGrant(me.data, BY_GRANT[n.key]) : allowed.has(n.key)));
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

  const switchLang = () => { const l = lang === 'en' ? 'ar' : 'en'; applyLocale(l); setLang(l); savePref({ locale: l }); };
  const switchTheme = () => { const n = theme === 'light' ? 'dark' : 'light'; applyTheme(n); setTheme(n); savePref({ theme: n }); };

  return (
    <div className="flex min-h-screen">
      {side && (
        <aside data-testid="sidebar" className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-e border-line bg-side">
          <div className="flex items-center gap-2 px-4 py-4 font-bold">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk">G</span>{t('app.name')}
          </div>
          <nav className="flex-1 overflow-y-auto px-2">
            {(['work', 'data', 'admin'] as const).map((g) => {
              const list = sideItems.filter((i) => i.group === g);
              if (!list.length) return null;
              return (
                <div key={g} className="mb-3">
                  <div className="px-2 py-1 text-xs font-semibold text-mute">{t(`nav.group_${g}`)}</div>
                  {list.map((n) => (
                    <NavLink key={n.key} to={n.to} data-testid={`nav-${n.key}`}
                      className={({ isActive }) => `flex items-center gap-3 rounded-md px-2 py-2 text-sm ${isActive || (n.key === 'admin.users' && inPeople) ? 'border-s-2 border-accent bg-sideOn font-semibold' : 'hover:bg-hover'}`}>
                      {n.icon}<span className="flex-1">{t(`nav.${n.key}`)}</span>
                      {n.key === 'messages' && unread > 0 && <span data-testid="messages-badge" aria-label={t('messages.unread_count', { count: unread })} className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-xs text-accentInk">{unread}</span>}
                    </NavLink>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="border-t border-line px-4 py-3 text-xs text-faint">Synthetic data</div>
        </aside>
      )}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-card px-4 py-2">
          <button className="btn" aria-label={t('nav.open_menu')} onClick={() => setSide((s) => !s)}><Menu size={16} /></button>
          <div className="text-sm text-mute">{t('app.name')} / <b className="text-ink">{current ? t(`nav.${current.key}`) : ''}</b></div>
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
  const readAll = () => api.post<void>('/notifications/read-all').then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  return (
    <Popover.Root>
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
          {n.data?.items.map((x) => (
            <button key={x.id} onClick={() => x.link && nav(x.link)} className={`block w-full rounded-md p-2 text-start text-sm hover:bg-hover ${x.read_at ? 'text-mute' : 'font-semibold'}`}>{x.title}</button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
