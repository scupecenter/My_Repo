import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Security, Support access (migration 0291, contract 0.15.191): off by default; an admin turns it on, grants a person a few rights for some hours, and revokes it. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/support' });
const submit = async (u: ReturnType<typeof userEvent.setup>, reason: string) => {
  await u.type(await screen.findByTestId('support-dialog-reason'), reason);
  await u.click(screen.getByTestId('support-dialog-submit'));
};

describe('Settings, Support access', () => {
  it('is off by default and cannot grant; turning it on lets an admin grant, list and revoke a support grant; revoke all ends the rest', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('page-support-access')).toBeInTheDocument();
    expect(screen.getByTestId('support-enabled')).not.toBeChecked();
    expect(screen.getByTestId('support-off')).toBeInTheDocument();
    expect(screen.getByTestId('support-grant')).toBeDisabled();
    expect(screen.getByTestId('support-save')).toBeDisabled();
    expect(await screen.findByTestId('support-none')).toBeInTheDocument();

    await u.click(screen.getByTestId('support-enabled'));
    await u.click(screen.getByTestId('support-save'));
    await api.post('/__mock/step-up');
    await submit(u, 'Support session for the template review');
    await waitFor(() => expect(screen.queryByTestId('support-off')).toBeNull());
    expect(screen.getByTestId('support-enabled')).toBeChecked();

    await u.type(screen.getByTestId('support-search'), 'Demo');
    const pick = await screen.findAllByTestId(/^support-pick-/);
    await u.click(pick[0]!);
    expect(screen.getByTestId('support-who')).toBeInTheDocument();
    expect(screen.getByTestId('support-grant')).toBeDisabled(); // no right chosen yet
    await u.click(screen.getByTestId('support-right-templates'));
    await u.clear(screen.getByTestId('support-hours'));
    await u.type(screen.getByTestId('support-hours'), '2');
    await u.click(screen.getByTestId('support-grant'));
    await submit(u, 'Template review with the vendor');
    const first = await screen.findByTestId(/^support-grant-sg-/);
    expect(first).toHaveTextContent(/Active/);
    expect(screen.getByTestId('support-revoke-all')).toBeEnabled();

    await u.click(within0(first).revoke);
    await submit(u, 'Finished early');
    await waitFor(() => expect(screen.getAllByTestId(/^support-state-/)[0]).toHaveTextContent(/Revoked/));
    expect(screen.getByTestId('support-revoke-all')).toBeDisabled();
  });

  it('turning it off again is as easy as turning it on', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('support-enabled')).toBeChecked();
    await u.click(screen.getByTestId('support-enabled'));
    await u.click(screen.getByTestId('support-save'));
    await api.post('/__mock/step-up');
    await submit(u, 'Back to normal');
    await waitFor(() => expect(screen.getByTestId('support-off')).toBeInTheDocument());
  });
});

function within0(el: HTMLElement) {
  return { revoke: el.querySelector('[data-testid^="support-revoke-"]') as HTMLElement };
}
