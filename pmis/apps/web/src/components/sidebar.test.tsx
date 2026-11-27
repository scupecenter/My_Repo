import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { ErrorState, NoResults } from '@/components/States';
import { Sites } from '@/pages/Sites';
import { MenuGroup } from '@/pages/MenuGroup';
import { renderApp, signIn } from '@/test/utils';
import { db, save } from '@/mocks/db';

/** The six sub-menus under "Site Master" (owner request 2026-11-22): the Master section is the parent entry, not a sub-menu. */
const SUBMENU_KEYS = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'om'] as const;
const SUBMENU_TESTIDS = SUBMENU_KEYS.map((k) => `nav-site-master-${k}`);

const app = (route = '/my-work', locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route element={<Shell />}><Route path="/sites" element={<Sites />} /><Route path="*" element={<div />} /></Route></Routes>, { route, locale });

describe('Sidebar tree (N1-N12)', () => {
  beforeEach(async () => { await signIn('pm'); });

  it('collapses a group and remembers it after a reload', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-warehouse');
    await u.click(screen.getByTestId('nav-group-toggle-registers'));
    expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('pmis.nav.collapsed') ?? '[]')).toEqual(['registers']);
    cleanup();
    app();
    await screen.findByTestId('nav-my_work');
    expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-group-toggle-registers')).toHaveAttribute('aria-expanded', 'false');
    await u.click(screen.getByTestId('nav-group-toggle-registers'));
    expect(await screen.findByTestId('nav-warehouse')).toBeInTheDocument();
  });

  it('hides the menu by itself: a rail that opens on hover, and a pin that keeps it, remembered after a reload', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-my_work');
    const side = screen.getByTestId('sidebar');
    expect(side).toHaveAttribute('data-auto', 'false');
    await u.click(screen.getByTestId('sidebar-pin'));
    expect(side).toHaveAttribute('data-auto', 'true');
    expect(side).toHaveStyle({ width: '56px' });
    expect(screen.queryByTestId('sidebar-pin')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('pmis.nav.auto') ?? 'false')).toBe(true);
    await u.hover(side);
    expect(await screen.findByTestId('sidebar-pin')).toHaveAttribute('aria-pressed', 'false');
    expect(side).not.toHaveStyle({ width: '56px' });
    await u.unhover(side);
    expect(side).toHaveStyle({ width: '56px' });
    cleanup();
    app();
    await screen.findByTestId('nav-my_work');
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-auto', 'true');
    await u.hover(screen.getByTestId('sidebar'));
    fireEvent.click(await screen.findByTestId('sidebar-pin'));
    await waitFor(() => expect(screen.getByTestId('sidebar')).toHaveAttribute('data-auto', 'false'));
  });

  it('opens the Site Master sub-menus on hover when the arrow has them closed, and in the icon rail', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-sites');
    await u.click(screen.getByTestId('nav-sites-toggle'));
    expect(screen.queryByTestId('nav-site-master-te')).not.toBeInTheDocument();
    await u.hover(screen.getByTestId('nav-sites'));
    expect(await screen.findByTestId('nav-flyout-sites')).toBeInTheDocument();
    expect(screen.getByTestId('nav-site-master-te')).toHaveAttribute('href', '/sites?section=te');
    await u.unhover(screen.getByTestId('nav-sites'));
    await waitFor(() => expect(screen.queryByTestId('nav-flyout-sites')).not.toBeInTheDocument());
    // the arrow still opens them in place, and then there is no flyout
    await u.click(screen.getByTestId('nav-sites-toggle'));
    await u.hover(screen.getByTestId('nav-sites'));
    expect(screen.queryByTestId('nav-flyout-sites')).not.toBeInTheDocument();
    // the icon rail has no arrow: the hover is the way
    await u.click(screen.getByTestId('topbar-collapse'));
    await u.hover(screen.getByTestId('nav-sites'));
    expect(await screen.findByTestId('nav-flyout-sites')).toBeInTheDocument();
  });

  it('opens a collapsed heading on hover with the same links, for every parent heading', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-warehouse');
    await u.click(screen.getByTestId('nav-group-toggle-registers'));
    expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
    await u.unhover(screen.getByTestId('nav-group-toggle-registers'));
    await u.hover(screen.getByTestId('nav-group-toggle-registers'));
    expect(await screen.findByTestId('nav-flyout-registers-warehouse')).toHaveAttribute('href', '/warehouse');
    await u.unhover(screen.getByTestId('nav-group-toggle-registers'));
    await waitFor(() => expect(screen.queryByTestId('nav-flyout-registers')).not.toBeInTheDocument());
    // an open heading shows its items already: no flyout
    await u.click(screen.getByTestId('nav-group-toggle-registers'));
    await u.unhover(screen.getByTestId('nav-group-toggle-registers'));
    await u.hover(screen.getByTestId('nav-group-toggle-registers'));
    expect(screen.queryByTestId('nav-flyout-registers')).not.toBeInTheDocument();
  });

  it('puts Dashboard first, on its own, and shows the waiting counts the lists already give', async () => {
    app();
    const first = await screen.findByTestId('nav-dashboard');
    expect(screen.getByTestId('nav-group-home')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-group-toggle-home')).not.toBeInTheDocument(); // one entry: no heading row
    expect(screen.getByTestId('nav-group-work')).not.toContainElement(first);
    const all = [...document.querySelectorAll('[data-testid^="nav-group-"][data-depth="1"], [data-testid="nav-dashboard"]')].map((e) => e.getAttribute('data-testid'));
    expect(all.indexOf('nav-dashboard')).toBeGreaterThan(-1);
    expect(screen.getByTestId('sidebar').querySelector('[data-testid^="nav-group-"]')).toHaveAttribute('data-testid', 'nav-group-home');
    // the numbers come from the two lists' own totals (Approvals, My Work do-now)
    await waitFor(() => expect(screen.getByTestId('nav-approvals')).toHaveTextContent(/\d/));
  });

  it('a parent heading opens its own page: Registers lists its screens as cards, the arrow still opens and closes the list', async () => {
    const u = userEvent.setup();
    renderApp(<Routes><Route element={<Shell />}><Route path="/menu/:id" element={<MenuGroup />} /><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work' });
    await screen.findByTestId('nav-group-open-registers');
    await u.click(screen.getByTestId('nav-group-open-registers'));
    const page = await screen.findByTestId('page-menu-group');
    expect(page).toHaveAttribute('data-group', 'registers');
    expect(within(page).getByTestId('menu-card-warehouse')).toHaveAttribute('href', '/warehouse');
    expect(within(page).getByTestId('menu-card-gecol')).toBeInTheDocument();
    await u.click(screen.getByTestId('nav-group-toggle-logs'));
    expect(screen.getByTestId('nav-group-toggle-logs')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps working when localStorage is blocked', async () => {
    const u = userEvent.setup();
    const real = { get: Storage.prototype.getItem, set: Storage.prototype.setItem };
    const deny = (k: string) => { if (k.startsWith('pmis.nav')) throw new Error('denied'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) { deny(k); return real.get.call(this, k); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) { deny(k); real.set.call(this, k, v); });
    try {
      app();
      await screen.findByTestId('nav-warehouse');
      await u.click(screen.getByTestId('nav-group-toggle-registers'));
      expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
    } finally { vi.restoreAllMocks(); }
  });

  it('pins favourites, reorders them with buttons and remembers the order', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-approvals');
    await u.click(screen.getByTestId('nav-pin-approvals'));
    await u.click(screen.getByTestId('nav-pin-messages'));
    const order = () => [...screen.getByTestId('nav-favourites').querySelectorAll('a')].map((a) => a.getAttribute('data-testid'));
    expect(order()).toEqual(['nav-fav-approvals', 'nav-fav-messages']);
    await u.click(screen.getByTestId('fav-up-messages'));
    expect(order()).toEqual(['nav-fav-messages', 'nav-fav-approvals']);
    expect(JSON.parse(localStorage.getItem('pmis.nav.favs') ?? '[]')).toEqual(['messages', 'approvals']);
    cleanup();
    app();
    await screen.findByTestId('nav-fav-messages');
    expect(order()).toEqual(['nav-fav-messages', 'nav-fav-approvals']);
    await u.click(screen.getByTestId('fav-remove-messages'));
    expect(screen.queryByTestId('nav-fav-messages')).not.toBeInTheDocument();
  });

  it('never shows a favourite the server nav does not allow', async () => {
    localStorage.setItem('pmis.nav.favs', JSON.stringify(['warehouse', 'nope']));
    cleanup();
    await signIn('engineer');
    app();
    await screen.findByTestId('nav-my_work');
    expect(screen.queryByTestId('nav-fav-warehouse')).not.toBeInTheDocument();
  });

  it('filters the menu by name and says when nothing matches', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-warehouse');
    await u.type(screen.getByTestId('nav-search'), 'ware');
    expect(screen.getByTestId('nav-warehouse')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-my_work')).not.toBeInTheDocument();
    await u.clear(screen.getByTestId('nav-search'));
    await u.type(screen.getByTestId('nav-search'), 'zzzz');
    expect(screen.getByTestId('nav-no-match')).toBeInTheDocument();
  });

  it('lists recent items without the current page', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-approvals');
    await u.click(screen.getByTestId('nav-approvals'));
    await waitFor(() => expect(screen.getByTestId('nav-recent-my_work')).toBeInTheDocument());
    expect(screen.queryByTestId('nav-recent-approvals')).not.toBeInTheDocument();
  });

  it('has the two main menus with their sub-menus, and Dismantle sits under the Site Register', async () => {
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('nav-group-toggle-registers')).toHaveTextContent('Registers & Logs');
    expect(screen.getByTestId('nav-sites')).toHaveTextContent('Site Master');
    expect(screen.getByTestId('nav-group-work')).not.toContainElement(screen.getByTestId('nav-sites'));
    const sub = screen.getByTestId('nav-site-master-menus');
    expect([...sub.querySelectorAll('a')].map((a) => a.getAttribute('data-testid'))).toEqual(SUBMENU_TESTIDS);
    expect(screen.getByTestId('nav-group-site_register')).not.toContainElement(screen.getByTestId('nav-dismantle'));
    const regs = [...screen.getByTestId('nav-group-registers').querySelectorAll('a')].filter((a) => !a.getAttribute('data-testid')?.startsWith('nav-group-open-')).map((a) => a.getAttribute('data-testid'));
    expect(regs).toEqual(['dismantle', 'procurement', 'gecol', 'hlc', 'permits_hse', 'incidents', 'lessons_learned', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness', 'as_built', 'meetings', 'rf_design', 'acquisition', 'contractors', 'car_dispatcher', 'financial_advances', 'contractor_reports'].map((k) => `nav-${k}`));
    expect(screen.getByTestId('nav-change_control')).toHaveTextContent('Change Control Log');
  });

  it('shows one "Site Master" entry with exactly the 6 sub-menus (no Dismantle), and no older stream or view links', async () => {
    app();
    const entry = await screen.findByTestId('nav-sites');
    expect(entry).toHaveTextContent(/^Site Master$/);
    // the group heading is not drawn a second time: the entry is the only row with this name
    expect(screen.queryByTestId('nav-group-toggle-site_register')).not.toBeInTheDocument();
    expect(screen.getAllByText('Site Master')).toHaveLength(1);
    expect(screen.queryByTestId('nav-site-master-master')).not.toBeInTheDocument();
    const menus = screen.getByTestId('nav-site-master-menus');
    expect([...menus.querySelectorAll('a')].map((a) => a.getAttribute('data-testid'))).toEqual(SUBMENU_TESTIDS);
    expect([...menus.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Design & Acquisition', 'SOW', 'CW', 'TE', 'HOTO', 'O&M']);
    expect(screen.queryByTestId('nav-site-master-dismantle')).not.toBeInTheDocument();
    expect(SUBMENU_KEYS).toHaveLength(6);
    expect([...menus.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(SUBMENU_KEYS.map((k) => `/sites?section=${k}`));
    expect(document.querySelector('[data-testid^="nav-sites-stream-"]')).toBeNull();
    expect(document.querySelector('[data-testid^="nav-sites-view-"]')).toBeNull();
    expect(screen.queryByTestId('nav-sites-views')).not.toBeInTheDocument();
  });

  it('opens each Site Master menu on its section and highlights the entry', async () => {
    const u = userEvent.setup();
    app();
    for (const key of SUBMENU_KEYS) {
      const link = await screen.findByTestId(`nav-site-master-${key}`);
      await u.click(link);
      await waitFor(() => expect(screen.getByTestId(`nav-site-master-${key}`)).toHaveAttribute('aria-current', 'page'));
      expect(screen.getByTestId('nav-sites')).not.toHaveAttribute('aria-current');
      expect(screen.getByTestId('nav-group-site_register')).toHaveAttribute('data-active', 'true');
      expect(screen.getByTestId('page-sites')).toBeInTheDocument();
    }
  });

  it('names the renamed registers in English: GECOL Power, Quality Control, RF & Design', async () => {
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('nav-gecol')).toHaveTextContent('GECOL Power');
    expect(screen.getByTestId('nav-quality')).toHaveTextContent('Quality Control');
    expect(screen.getByTestId('nav-rf_design')).toHaveTextContent('RF & Design');
  });

  it('points the Dismantle sub-menu at the Dismantle register', async () => {
    app();
    expect(await screen.findByTestId('nav-dismantle')).toHaveAttribute('href', '/registers/dismantle');
  });

  it('keeps an old ?view=CW link working: the CW view opens, the page is titled and the Site Register entry stays active', async () => {
    app('/sites?view=CW');
    expect(await screen.findByTestId('page-sites')).toBeInTheDocument();
    await screen.findByTestId('nav-sites');
    expect(screen.queryByTestId('view-tabs')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Site Master: Civil Works');
    expect(screen.getByTestId('nav-sites')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-group-site_register')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByTestId('nav-sites-view-CW')).not.toBeInTheDocument();
    expect(screen.getByTestId('breadcrumb')).toHaveTextContent('Site Master');
  });

  it('hides sub-menus and registers the caller may not use, as before', async () => {
    cleanup();
    await signIn('engineer');
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('nav-site-master-cw')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-dismantle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-group-registers')).not.toBeInTheDocument();
    cleanup();
    await signIn('reviewer');
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('nav-dismantle')).toBeInTheDocument();
    expect(screen.getByTestId('nav-procurement')).toBeInTheDocument();
    expect(screen.getByTestId('nav-contractor_reports')).toBeInTheDocument(); // ANY_OF procurement or contractors
    expect(screen.queryByTestId('nav-contractors')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-quality')).not.toBeInTheDocument();
  });

  it('collapses the Site Register node and remembers it', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-site-master-menus');
    await u.click(screen.getByTestId('nav-sites-toggle'));
    expect(screen.queryByTestId('nav-site-master-menus')).not.toBeInTheDocument();
    expect(localStorage.getItem('pmis.nav.sites_open')).toBe('false');
  });

  it('resizes with the keyboard inside min and max, and saves the width', async () => {
    app();
    const sep = await screen.findByTestId('sidebar-resizer');
    expect(sep).toHaveAttribute('role', 'separator');
    expect(sep).toHaveAttribute('aria-valuenow', '240');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '256');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(sep).toHaveAttribute('aria-valuenow', '400');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '400');
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(sep).toHaveAttribute('aria-valuenow', '200');
    expect(localStorage.getItem('pmis.nav.width')).toBe('200');
  });

  it('goes icon-only with accessible names, and back', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-my_work');
    await u.click(screen.getByTestId('topbar-collapse'));
    const link = screen.getByTestId('nav-my_work');
    expect(link).toHaveAttribute('aria-label', 'My Work');
    expect(link).toHaveAttribute('title', 'My Work');
    expect(screen.queryByTestId('nav-search')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('topbar-collapse'));
    expect(screen.getByTestId('nav-search')).toBeInTheDocument();
  });

  it('opens a mobile drawer with the same menu and closes it on Escape', async () => {
    const u = userEvent.setup();
    app();
    await screen.findByTestId('nav-my_work');
    await u.click(screen.getByTestId('topbar-menu'));
    const drawer = await screen.findByTestId('sidebar-drawer');
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId('sidebar-drawer')).not.toBeInTheDocument();
  });

  it('works in Arabic', async () => {
    app('/my-work', 'ar');
    expect(await screen.findByTestId('nav-site-master-cw')).toHaveTextContent('الأعمال المدنية');
    expect(screen.getByTestId('nav-site-master-design_acq')).toHaveTextContent('التصميم والاستحواذ');
    expect(screen.getByTestId('nav-site-master-te')).toHaveTextContent('التركيبات');
    expect(screen.getByTestId('nav-site-master-hoto')).toHaveTextContent('التسليم والإغلاق');
    expect(screen.queryByTestId('nav-site-master-dismantle')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-gecol')).toHaveTextContent('كهرباء GECOL');
    expect(screen.getByTestId('nav-quality')).toHaveTextContent('ضبط الجودة');
    expect(screen.getByTestId('nav-rf_design')).toHaveTextContent('الترددات والتصميم');
    expect(screen.getByTestId('nav-site-master-om')).toHaveTextContent('التشغيل والصيانة');
    expect(screen.getByTestId('nav-dismantle')).toHaveTextContent('الفك');
    expect(screen.getByTestId('nav-sites')).toHaveTextContent('ماستر المواقع');
    expect(screen.getByTestId('nav-group-toggle-registers')).toHaveTextContent('السجلات والقيود');
    expect(screen.getByTestId('nav-change_control')).toHaveTextContent('سجل التغييرات');
    expect(screen.getByTestId('nav-sites-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('nav-group-toggle-work')).toHaveTextContent('العمل');
  });
});

describe('Shared states', () => {
  it('NoResults offers Clear and ErrorState offers Retry', async () => {
    const u = userEvent.setup();
    const clear = vi.fn(), retry = vi.fn();
    renderApp(<><NoResults onClear={clear} /><ErrorState onRetry={retry} /></>);
    await u.click(screen.getByTestId('state-no-results-clear'));
    await u.click(screen.getByTestId('state-error-retry'));
    expect(clear).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });
});

/** 0242 (owner approval 2026-11-27, the PM-platforms proposal item 4): the personal sidebar of the profile. */
describe('the personal sidebar (0197)', () => {
  beforeEach(async () => { await signIn('pm'); });
  const seedSide = (sidebar: Record<string, unknown>) => {
    db().profiles.pm = { ...(db().profiles.pm ?? { version: 1 }), ui_prefs: { sidebar }, version: db().profiles.pm?.version ?? 1 };
    save();
  };

  it('hides and reorders the screens of the menu, and the pins of the profile sit in favourites', async () => {
    seedSide({ hidden: ['warehouse'], order: ['inbox', 'my_work'], pins: ['approvals'] });
    app();
    await screen.findByTestId('nav-my_work');
    expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
    const work = screen.getByTestId('nav-group-work');
    const ids = [...work.querySelectorAll('[data-testid^="nav-"]')].map((e) => e.getAttribute('data-testid'));
    expect(ids.indexOf('nav-inbox')).toBeGreaterThan(-1);
    expect(ids.indexOf('nav-inbox')).toBeLessThan(ids.indexOf('nav-my_work'));
    expect(await screen.findByTestId('nav-fav-approvals')).toBeInTheDocument();
    // the server list won over the browser cache
    expect(JSON.parse(localStorage.getItem('pmis.nav.favs') ?? '[]')).toEqual(['approvals']);
  });

  it('badge style dot: a dot instead of the number', async () => {
    seedSide({ badge_style: 'dot', pins: [] });
    app();
    await screen.findByTestId('nav-approvals');
    const badge = await screen.findByTestId('approvals-badge');
    await waitFor(() => expect(badge).toHaveClass('h-2', 'w-2'));
    expect(badge.textContent).toBe('');
  });

  it('the browser-only favourites move into the profile once', async () => {
    localStorage.setItem('pmis.nav.favs', JSON.stringify(['warehouse']));
    app();
    await screen.findByTestId('nav-fav-warehouse');
    await waitFor(() => {
      const side = db().profiles.pm?.ui_prefs?.sidebar as { pins?: string[] } | undefined;
      expect(side?.pins).toEqual(['warehouse']);
    });
  });
});
