import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

/** The "+" of the top bar and the Appearance entry of the user menu: shortcuts that only open pages; the server still checks every permission. */
describe('top bar quick create', () => {
  it('lists the things a project manager may start and opens the page', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/my-work' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('topbar-quick-create'));
    expect(await screen.findByTestId('qc-message')).toBeInTheDocument();
    expect(screen.getByTestId('qc-status')).toBeInTheDocument();
  });
  it('the user menu has an Appearance entry', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/my-work' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('topbar-user'));
    expect(await screen.findByTestId('user-menu-appearance')).toBeInTheDocument();
  });
  it('P7: Sign out lives in the user menu, not in the top bar, and signs out', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/my-work' });
    const u = userEvent.setup();
    await screen.findByTestId('topbar-user');
    expect(screen.queryByTestId('topbar-signout')).toBeNull();
    await u.click(screen.getByTestId('topbar-user'));
    await u.click(await screen.findByTestId('user-menu-signout'));
    expect(await screen.findByTestId('login-identifier')).toBeInTheDocument();
  });

  it('P5: the top bar entry is the Exports centre and Sites has no second whole-project Export item', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/sites' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('topbar-export')).toHaveTextContent('Exports centre');
    await screen.findByTestId('sites-export-view'); // the one screen-level export (current view)
    await u.click(await screen.findByTestId('more-menu'));
    await screen.findByTestId('sites-reset-cols');
    expect(screen.queryByTestId('sites-export')).toBeNull();
  });
});
