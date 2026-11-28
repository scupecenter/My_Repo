import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** F4 follow-up 1 (contract 0.15.470): Project Status items read the Deliverables register; a switch per item, auto or manual only, with its own reason and audit. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('Project Status from the Deliverables register', () => {
  it('shows each item with its kind, mode and counts, turns one back to manual with a reason, and moves the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const mode = await screen.findByTestId('ps-deliv-mode-1.3');
    expect(mode).toHaveValue('auto');
    expect(screen.getByTestId('ps-deliv-kind-1.3')).toHaveValue('HLD');
    expect(screen.getByTestId('ps-deliv-count-1.3')).toHaveTextContent('2');
    expect(screen.getByTestId('ps-deliv-save')).toBeDisabled();
    await u.selectOptions(mode, 'manual');
    await u.click(screen.getByTestId('ps-deliv-save'));
    await u.type(await screen.findByTestId('ps-deliv-dialog-reason'), 'Owner turned HLD back to manual');
    await u.click(screen.getByTestId('ps-deliv-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('ps-deliv-version')).toHaveTextContent('1'));
    expect(screen.getByTestId('ps-deliv-mode-1.3')).toHaveValue('manual');
    expect(screen.getByTestId('ps-deliv-count-1.3')).toHaveTextContent(/manual/i);
  });

  it('auto without a kind cannot be saved, and the server refuses unknown items, a missing kind, duplicates and a missing If-Match or reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const kind = await screen.findByTestId('ps-deliv-kind-1.5');
    await u.selectOptions(kind, '');
    expect(await screen.findByTestId('ps-deliv-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('ps-deliv-save')).toBeDisabled();

    const cur = await api.get<{ version: number }>('/settings/dashboard/ps-deliverables');
    const put = (body: object, version = cur.version) => errCode(api.put('/settings/dashboard/ps-deliverables', { version, body }));
    expect(await put({ reason: 'Rule test', items: [{ item_code: '9.99', kind: 'HLD', mode: 'auto' }] })).toBe('422:validation_failed');
    expect(await put({ reason: 'Rule test', items: [{ item_code: '1.3', mode: 'auto' }] })).toBe('422:validation_failed');
    expect(await put({ reason: 'Rule test', items: [{ item_code: '1.3', kind: 'HLD', mode: 'auto' }, { item_code: '1.3', kind: 'HLD', mode: 'auto' }] })).toBe('422:validation_failed');
    expect(await put({ reason: '', items: [] })).toBe('422:validation_failed');
    expect(await put({ reason: 'Stale version', items: [] }, cur.version + 5)).toBe('412:precondition_failed');
  });
});
