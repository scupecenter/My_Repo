import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { keyBytes } from '@/api/push';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Profile } from './Profile';
import { SettingsRoutes } from './settings/Settings';

/** Item 13 (contract 0.15.105): Web Push is off until the server has keys, and says so in Profile and in Settings > Alerts > Web push. */
const settings = (locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/alerts/push', locale });

describe('Web Push', () => {
  it('Profile says device alerts are not turned on while the server has no keys', async () => {
    await signIn('pm');
    renderApp(<Profile />, { route: '/profile' });
    expect(await screen.findByTestId('push-off')).toBeInTheDocument();
    expect(screen.queryByTestId('push-enable')).toBeNull();
  });

  it('Settings shows off with the clear message, then on with counts', async () => {
    server.use(http.get(`${API_BASE}/admin/web-push`, () => HttpResponse.json({ enabled: false, subscriptions: 0, users: 0, last_pushed_at: null })));
    await signIn('pm');
    const first = settings();
    expect(await screen.findByTestId('wps-off')).toHaveTextContent('VAPID_PUBLIC_KEY');
    first.unmount();
    server.use(http.get(`${API_BASE}/admin/web-push`, () => HttpResponse.json({ enabled: true, subscriptions: 5, users: 3, last_pushed_at: null })));
    settings('ar');
    expect(await screen.findByTestId('wps-on')).toBeInTheDocument();
    expect(screen.getByTestId('wps-browsers')).toHaveTextContent('5');
  });

  it('decodes the public key bytes', () => {
    expect(Array.from(keyBytes('AQID'))).toEqual([1, 2, 3]);
  });
});
