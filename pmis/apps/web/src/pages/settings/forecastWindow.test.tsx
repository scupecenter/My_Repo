import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings review gap 4 (contract 0.15.431): the number of weeks the dashboard forecast averages, editable in Settings > Dashboard with its own reason and audit. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('forecast window', () => {
  it('shows 4 weeks by default, offers 2 to 12, saves with a reason and moves the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const sel = await screen.findByTestId('forecast-window-weeks');
    expect(sel).toHaveValue('4');
    expect(sel.querySelectorAll('option')).toHaveLength(11);
    expect(screen.getByTestId('forecast-window-save')).toBeDisabled();
    await u.selectOptions(sel, '8');
    await u.click(screen.getByTestId('forecast-window-save'));
    await u.type(await screen.findByTestId('forecast-window-dialog-reason'), 'Owner widened the forecast window');
    await u.click(screen.getByTestId('forecast-window-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('forecast-window-version')).toHaveTextContent('1'));
    expect(screen.getByTestId('forecast-window-weeks')).toHaveValue('8');
  }, 30_000);

  it('the server refuses a number of weeks outside 2 to 12, a missing reason and a stale version', async () => {
    await signIn('pm');
    const cur = await api.get<{ version: number }>('/settings/dashboard/forecast-window');
    expect(await errCode(api.put('/settings/dashboard/forecast-window', { version: cur.version, body: { weeks: 13, reason: 'Range test' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/forecast-window', { version: cur.version, body: { weeks: 6, reason: '' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/forecast-window', { version: cur.version + 5, body: { weeks: 6, reason: 'Stale test' } }))).toBe('412:precondition_failed');
  });
});
