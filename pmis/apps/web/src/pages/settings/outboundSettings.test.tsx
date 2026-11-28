import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** D8 (contract 0.15.475): outbound notifications, Settings > Alerts > Outbound. Off by default; every change has a reason. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/alerts/outbound' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('outbound notifications', () => {
  it('is off by default and turns on with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    expect(await screen.findByTestId('outbound-state')).toHaveTextContent(/OFF|متوقف/);
    await u.click(screen.getByTestId('outbound-toggle'));
    await u.type(await screen.findByTestId('outbound-enabled-dialog-reason'), 'Owner approved outbound alerts');
    await u.click(screen.getByTestId('outbound-enabled-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('outbound-state')).toHaveTextContent(/ON|مفعّل/));
  }, 30_000);

  it('the server refuses an http webhook, a missing secret, no events and a stale version', async () => {
    await signIn('pm');
    const cur = await api.get<{ version: number }>('/settings/integrations/outbound');
    const base = { kind: 'webhook', label: 'Ops', target: 'http://example.test/hook', secret: 'x'.repeat(20), events: ['task_assigned'], active: true, reason: 'Test destination' };
    expect(await errCode(api.post('/settings/integrations/outbound/destinations', { body: base }))).toBe('422:validation_failed');
    expect(await errCode(api.post('/settings/integrations/outbound/destinations', { body: { ...base, target: 'https://example.test/hook', secret: undefined } }))).toBe('422:validation_failed');
    expect(await errCode(api.post('/settings/integrations/outbound/destinations', { body: { ...base, target: 'https://example.test/hook', events: [] } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/integrations/outbound/enabled', { version: cur.version + 5, body: { enabled: true, reason: 'Stale test' } }))).toBe('412:precondition_failed');
  });
});
