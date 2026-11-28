import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api, setCsrfToken } from '@/api/client';
import { DEMO_PASSWORDS } from '@/mocks/db';
import { renderApp } from '@/test/utils';
import { Profile } from './Profile';

// D4 (contract 0.15.460): Profile > My calendar feed. Off by default; the link is shown once; a new link replaces it; turning off removes it.
async function localSignIn() {
  const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
  setCsrfToken(s.csrf_token);
}

describe('calendar feed section', () => {
  it('turns on, shows the link once with a named copy button, rotates and turns off', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Profile />);
    expect(await screen.findByTestId('calfeed-state')).toHaveTextContent('The feed is off');
    expect(screen.queryByTestId('calfeed-link')).toBeNull();
    await u.click(screen.getByTestId('calfeed-enable'));
    const first = (await screen.findByTestId('calfeed-link')) as HTMLInputElement;
    const firstUrl = first.value;
    expect(firstUrl).toMatch(/\/me\/calendar-feed\/.+\.ics$/);
    expect(first).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('calfeed-copy')).toHaveAttribute('aria-label', 'Copy the link');
    await waitFor(() => expect(screen.getByTestId('calfeed-state')).toHaveTextContent('The feed is on'));
    await u.click(screen.getByTestId('calfeed-rotate'));
    await waitFor(() => expect((screen.getByTestId('calfeed-link') as HTMLInputElement).value).not.toBe(firstUrl));
    await u.click(screen.getByTestId('calfeed-disable'));
    await waitFor(() => expect(screen.getByTestId('calfeed-state')).toHaveTextContent('The feed is off'));
    expect(screen.queryByTestId('calfeed-link')).toBeNull();
  });

  it('works in Arabic (RTL)', async () => {
    await localSignIn();
    renderApp(<Profile />, { locale: 'ar' });
    expect(await screen.findByTestId('calfeed-state')).toHaveTextContent('الخلاصة');
  });
});
