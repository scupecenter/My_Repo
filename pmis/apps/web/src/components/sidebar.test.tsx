import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { ErrorState, NoResults } from '@/components/States';
import { Sites } from '@/pages/Sites';
import { renderApp, signIn } from '@/test/utils';

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
    expect(screen.getByTestId('nav-group-toggle-site_register')).toHaveTextContent('Site Register');
    expect(screen.getByTestId('nav-group-toggle-registers')).toHaveTextContent('Registers & Logs');
    expect(screen.getByTestId('nav-sites')).toHaveTextContent('All sites');
    expect(screen.getByTestId('nav-group-work')).not.toContainElement(screen.getByTestId('nav-sites'));
    const sub = screen.getByTestId('nav-sites-views');
    expect([...sub.querySelectorAll('a')].map((a) => a.getAttribute('data-testid'))).toEqual(['nav-sites-stream-DESIGN_ACQ', 'nav-sites-stream-CW', 'nav-sites-stream-TE', 'nav-sites-stream-CLOSURE', 'nav-dismantle', 'nav-sites-view-OM']);
    expect(screen.getByTestId('nav-group-registers')).not.toContainElement(screen.getByTestId('nav-dismantle'));
    const regs = [...screen.getByTestId('nav-group-registers').querySelectorAll('a')].map((a) => a.getAttribute('data-testid'));
    expect(regs).toEqual(['procurement', 'gecol', 'hlc', 'permits_hse', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness', 'as_built', 'meetings', 'rf_design', 'acquisition', 'contractors', 'contractor_reports'].map((k) => `nav-${k}`));
    expect(screen.getByTestId('nav-change_control')).toHaveTextContent('Change Control Log');
  });

  it('opens each Site Register sub-menu on the right stream or view, titles the page and highlights the entry', async () => {
    const u = userEvent.setup();
    app();
    const cases: [string, string, string, string][] = [
      ['nav-sites-stream-DESIGN_ACQ', '/sites?stream=DESIGN_ACQ', 'stream-tab-DESIGN_ACQ', 'Design & Acquisition'],
      ['nav-sites-stream-CW', '/sites?stream=CW', 'stream-tab-CW', 'Civil Works'],
      ['nav-sites-stream-TE', '/sites?stream=TE', 'stream-tab-TE', 'Installation (TE)'],
      ['nav-sites-stream-CLOSURE', '/sites?stream=CLOSURE', 'stream-tab-CLOSURE', 'Handover & Closure'],
      ['nav-sites-view-OM', '/sites?view=OM', 'view-tabs-OM', 'O&M'],
    ];
    for (const [id, href, tab, title] of cases) {
      const link = await screen.findByTestId(id);
      expect(link).toHaveAttribute('href', href);
      await u.click(link);
      expect(await screen.findByTestId('page-sites')).toBeInTheDocument();
      expect(screen.getByTestId(tab)).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Site Register: ${title}`);
      expect(screen.getByTestId(id)).toHaveAttribute('aria-current', 'page');
      expect(screen.getByTestId('nav-sites')).not.toHaveAttribute('aria-current');
      expect(screen.getByTestId('nav-group-site_register')).toHaveAttribute('data-active', 'true');
    }
    await u.click(screen.getByTestId('nav-sites'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Site Register$/));
    expect(screen.getByTestId('nav-sites')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('stream-tab-ALL')).toHaveAttribute('aria-selected', 'true');
  });

  it('points the Dismantle sub-menu at the Dismantle register', async () => {
    app();
    expect(await screen.findByTestId('nav-dismantle')).toHaveAttribute('href', '/registers/dismantle');
  });

  it('keeps an old ?view=CW link working: the CW view opens, the page is titled and the Site Register entry stays active', async () => {
    app('/sites?view=CW');
    expect(await screen.findByTestId('page-sites')).toBeInTheDocument();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('view-tabs-CW')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Site Register: CW Register');
    expect(screen.getByTestId('nav-sites')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-group-site_register')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByTestId('nav-sites-view-CW')).not.toBeInTheDocument();
    expect(screen.getByTestId('breadcrumb')).toHaveTextContent('Site Register');
  });

  it('hides sub-menus and registers the caller may not use, as before', async () => {
    cleanup();
    await signIn('engineer');
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('nav-sites-stream-CW')).toBeInTheDocument();
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
    await screen.findByTestId('nav-sites-views');
    await u.click(screen.getByTestId('nav-sites-toggle'));
    expect(screen.queryByTestId('nav-sites-views')).not.toBeInTheDocument();
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
    expect(await screen.findByTestId('nav-sites-stream-CW')).toHaveTextContent('الأعمال المدنية');
    expect(screen.getByTestId('nav-sites-stream-DESIGN_ACQ')).toHaveTextContent('التصميم والاستحواذ');
    expect(screen.getByTestId('nav-sites-stream-TE')).toHaveTextContent('التركيبات');
    expect(screen.getByTestId('nav-sites-stream-CLOSURE')).toHaveTextContent('التسليم والإغلاق');
    expect(screen.getByTestId('nav-dismantle')).toHaveTextContent('الفك');
    expect(screen.getByTestId('nav-sites-view-OM')).toHaveTextContent('التشغيل والصيانة');
    expect(screen.getByTestId('nav-group-toggle-site_register')).toHaveTextContent('سجل المواقع');
    expect(screen.getByTestId('nav-group-toggle-registers')).toHaveTextContent('السجلات والقيود');
    expect(screen.getByTestId('nav-change_control')).toHaveTextContent('سجل التغييرات');
    expect(screen.getByTestId('nav-group-toggle-site_register')).toHaveAttribute('aria-expanded', 'true');
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
