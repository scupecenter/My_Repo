import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings review gap 3 (contract 0.15.430): the weekday of the weekly dashboard snapshot, editable in Settings > Dashboard with its own reason and audit. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('weekly snapshot day', () => {
  it('shows Thursday by default, offers the seven days, saves with a reason and moves the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const sel = await screen.findByTestId('snapshot-schedule-weekday');
    expect(sel).toHaveValue('4');
    expect(sel.querySelectorAll('option')).toHaveLength(7);
    expect(screen.getByTestId('snapshot-schedule-save')).toBeDisabled();
    await u.selectOptions(sel, '0');
    await u.click(screen.getByTestId('snapshot-schedule-save'));
    await u.type(await screen.findByTestId('snapshot-schedule-dialog-reason'), 'Owner moved the snapshot to Sunday');
    await u.click(screen.getByTestId('snapshot-schedule-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('snapshot-schedule-version')).toHaveTextContent('1'));
    expect(screen.getByTestId('snapshot-schedule-weekday')).toHaveValue('0');
  }, 30_000);

  it('the server refuses a day outside 0 to 6, a missing reason and a stale version', async () => {
    await signIn('pm');
    const cur = await api.get<{ version: number }>('/settings/dashboard/snapshot-schedule');
    expect(await errCode(api.put('/settings/dashboard/snapshot-schedule', { version: cur.version, body: { weekday: 7, reason: 'Range test' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/snapshot-schedule', { version: cur.version, body: { weekday: 2, reason: '' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/dashboard/snapshot-schedule', { version: cur.version + 5, body: { weekday: 2, reason: 'Stale test' } }))).toBe('412:precondition_failed');
  });
});
