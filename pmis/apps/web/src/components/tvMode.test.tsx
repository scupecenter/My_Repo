import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

/** TV mode of the Dashboard (?tv=1): no sidebar or top bar, an exit button; the normal page keeps both. */
describe('Dashboard TV mode', () => {
  it('?tv=1 shows the Dashboard without the menu, with an exit button', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard?tv=1' });
    expect(await screen.findByTestId('tv-exit')).toBeInTheDocument();
    expect(screen.getByTestId('tv-mode')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).toBeNull();
  });
  it('the normal page has the menu and the TV mode button', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard' });
    expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
    expect(await screen.findByTestId('dash-tv')).toBeInTheDocument();
    expect(screen.queryByTestId('tv-mode')).toBeNull();
  });
});
