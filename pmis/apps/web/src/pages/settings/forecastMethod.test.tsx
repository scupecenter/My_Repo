import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Phase 5 (contract 0.15.474): the method of the dashboard forecast, editable in Settings > Dashboard with its own reason and audit. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('forecast method', () => {
  it('shows the mean by default, offers mean and linear, saves with a reason and moves the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const sel = await screen.findByTestId('forecast-method-method');
    expect(sel).toHaveValue('mean');
    expect(sel.querySelectorAll('option')).toHaveLength(2);
    expect(screen.getByTestId('forecast-method-save')).toBeDisabled();
    await u.selectOptions(sel, 'linear');
    await u.click(screen.getByTestId('forecast-method-save'));
    await u.type(await screen.findByTestId('forecast-method-dialog-reason'), 'Owner chose the straight line fit');
    await u.click(screen.getByTestId('forecast-method-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('forecast-method-version')).toHaveTextContent('1'));
    expect(screen.getByTestId('forecast-method-method')).toHaveValue('linear');
  }, 30_000);

  it('the server refuses a value other than mean or linear, a missing reason and a stale version', async () => {
    await signIn('pm');
    const cur = await api.get<{ version: number }>('/settings/dashboard/forecast-method');
    expect(await errCode(api.put('/settings/dashboard/forecast-method', { version: cur.version, body: { method: 'median', reason: 'Value test' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/forecast-method', { version: cur.version, body: { method: 'linear', reason: '' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/forecast-method', { version: cur.version + 5, body: { method: 'linear', reason: 'Stale test' } }))).toBe('412:precondition_failed');
  });
});
