import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Security, Guest access (migration 0731, contract 0.15.730): off by default; an admin turns it on, creates a view-only guest, sees the password once, extends and ends it. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/guests' });
const submit = async (u: ReturnType<typeof userEvent.setup>, reason: string) => {
  await u.type(await screen.findByTestId('guest-dialog-reason'), reason);
  await u.click(screen.getByTestId('guest-dialog-submit'));
};

describe('Settings, Guest access', () => {
  it('is off by default and cannot create; turning it on lets an admin create a guest, see the password once, extend and end it', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('page-guest-access')).toBeInTheDocument();
    expect(screen.getByTestId('guest-enabled')).not.toBeChecked();
    expect(screen.getByTestId('guest-off')).toBeInTheDocument();
    expect(screen.getByTestId('guest-create')).toBeDisabled();
    expect(screen.getByTestId('guest-save')).toBeDisabled();
    expect(await screen.findByTestId('guest-none')).toBeInTheDocument();

    await u.click(screen.getByTestId('guest-enabled'));
    await u.click(screen.getByTestId('guest-save'));
    await api.post('/__mock/step-up');
    await submit(u, 'Client visit next week');
    await waitFor(() => expect(screen.queryByTestId('guest-off')).toBeNull());
    expect(screen.getByTestId('guest-enabled')).toBeChecked();

    await u.type(screen.getByTestId('guest-email'), 'client@example.test');
    await u.type(screen.getByTestId('guest-name'), 'Client Viewer');
    expect(screen.getByTestId('guest-create')).toBeDisabled(); // no region or module chosen yet
    await u.click(await screen.findByTestId('guest-region-1'));
    await u.click(screen.getByTestId('guest-module-sites'));
    await u.click(screen.getByTestId('guest-create'));
    await api.post('/__mock/step-up');
    await submit(u, 'Client visit next week');
    expect(await screen.findByTestId('guest-password')).toHaveTextContent('Tmp-guest');
    await u.click(screen.getByTestId('guest-password-done'));
    expect(screen.queryByTestId('guest-password')).toBeNull();

    const row = (await screen.findAllByTestId(/^guest-row-/))[0]!;
    expect(row).toHaveTextContent('client@example.test');
    const id = row.getAttribute('data-testid')!.replace('guest-row-', '');
    expect(screen.getByTestId(`guest-state-${id}`)).toHaveTextContent('Active');
    await u.click(screen.getByTestId(`guest-extend-${id}`));
    await api.post('/__mock/step-up');
    await submit(u, 'Visit moved');
    await waitFor(() => expect(screen.queryByTestId('guest-dialog-submit')).toBeNull());
    await u.click(screen.getByTestId(`guest-end-${id}`));
    await api.post('/__mock/step-up');
    await submit(u, 'Visit finished');
    await waitFor(() => expect(screen.getByTestId(`guest-state-${id}`)).toHaveTextContent('Ended'));
    expect(screen.queryByTestId(`guest-end-${id}`)).toBeNull();
  });
});
