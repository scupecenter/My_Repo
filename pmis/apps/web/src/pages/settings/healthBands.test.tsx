import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { bandsInvalid } from './HealthBands';
import { SettingsRoutes } from './Settings';

/** Settings review gap 8 (contract 0.15.435): the health index bands, editable in Settings > Dashboard with their own reason and audit. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('health index bands', () => {
  it('the rule: whole numbers, green from 1 to 100, amber from 0 to 99, green above amber', () => {
    expect(bandsInvalid(85, 70)).toBe(false);
    expect(bandsInvalid(70, 70)).toBe(true);
    expect(bandsInvalid(60, 70)).toBe(true);
    expect(bandsInvalid(101, 70)).toBe(true);
    expect(bandsInvalid(85, -1)).toBe(true);
    expect(bandsInvalid(85.5, 70)).toBe(true);
    expect(bandsInvalid(NaN, 70)).toBe(true);
  });

  it('shows the stored bands, blocks an invalid pair, saves with a reason and moves the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const green = await screen.findByTestId('health-bands-green');
    expect(green).toHaveValue(85);
    expect(screen.getByTestId('health-bands-amber')).toHaveValue(70);
    expect(screen.getByTestId('health-bands-red')).toHaveTextContent('Red below 70');
    expect(screen.getByTestId('health-bands-save')).toBeDisabled();
    await u.clear(green); await u.type(green, '65');
    expect(screen.getByTestId('health-bands-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('health-bands-save')).toBeDisabled();
    await u.clear(green); await u.type(green, '90');
    expect(screen.queryByTestId('health-bands-invalid')).toBeNull();
    await u.click(screen.getByTestId('health-bands-save'));
    await u.type(await screen.findByTestId('health-bands-dialog-reason'), 'Owner raised the green line');
    await u.click(screen.getByTestId('health-bands-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('health-bands-version')).toHaveTextContent('1'));
    expect(screen.getByTestId('health-bands-green')).toHaveValue(90);
  }, 30_000);

  it('the server refuses a bad order, a missing reason and a stale version', async () => {
    await signIn('pm');
    const cur = await api.get<{ version: number }>('/settings/dashboard/health-bands');
    expect(await errCode(api.put('/settings/dashboard/health-bands', { version: cur.version, body: { green: 60, amber: 70, reason: 'Order test' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/health-bands', { version: cur.version, body: { green: 90, amber: 70, reason: '' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/health-bands', { version: cur.version + 5, body: { green: 90, amber: 70, reason: 'Stale test' } }))).toBe('412:precondition_failed');
  });
});
