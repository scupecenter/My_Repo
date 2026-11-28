import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings review gap 6 (contract 0.15.433): the read-only change log under the Dashboard settings and the Goals settings. */
const open = (route: string) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('settings change log', () => {
  it('lists who, why and what changed under the dashboard settings', async () => {
    await signIn('pm');
    open('/admin/settings/dashboard');
    const row = await screen.findByTestId('change-log-row');
    expect(row).toHaveTextContent('Quarterly review');
    expect(row).toHaveTextContent('10 → 12');
  });
  it('shows the goals scope and refuses another scope', async () => {
    await signIn('pm');
    open('/admin/settings/screens/goals');
    expect(await screen.findByText('dashboard.goals')).toBeInTheDocument();
    expect(await errCode(api.get('/settings/change-log', { query: { scope: 'sites' } }))).toBe('422:validation_failed');
  });
});
