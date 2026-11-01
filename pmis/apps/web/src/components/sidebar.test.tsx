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

  it('opens the CW / TE / O&M shortcuts as ?view= on the Site Register, and highlights parent and child', async () => {
    const u = userEvent.setup();
    app();
    const cw = await screen.findByTestId('nav-sites-view-CW');
    expect(cw).toHaveAttribute('href', '/sites?view=CW');
    expect(screen.getByTestId('nav-sites-view-TE')).toHaveAttribute('href', '/sites?view=TE');
    expect(screen.getByTestId('nav-sites-view-OM')).toHaveAttribute('href', '/sites?view=OM');
    await u.click(cw);
    expect(await screen.findByTestId('page-sites')).toBeInTheDocument();
    expect(screen.getByTestId('view-tabs-CW')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('nav-sites-view-CW')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-sites')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-group-work')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('breadcrumb')).toHaveTextContent('Site Register');
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
    expect(await screen.findByTestId('nav-sites-view-CW')).toHaveTextContent('سجل الأعمال المدنية');
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
