import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { mockInvitationToken, resetMockInvitations } from '@/mocks/handlers.invitations';
import { renderApp, signIn } from '@/test/utils';

// Decision 5 (migration 0091, contract: users/invitations and the public /invitations/{token} routes).
beforeEach(() => resetMockInvitations());

const inviteFromUsersPage = async (email: string) => {
  await signIn('pm');
  const u = userEvent.setup();
  renderApp(<App />, { route: '/admin/users' });
  await u.click(await screen.findByTestId('users-invite'));
  await u.type(screen.getByTestId('invite-name'), 'Layla Test');
  await u.type(screen.getByTestId('invite-email'), email);
  await u.click(screen.getByTestId('invite-add-role'));
  await u.selectOptions(screen.getByTestId('invite-role-0'), (await within(screen.getByTestId('invite-role-0')).findAllByRole('option'))[1]!);
  await u.type(screen.getByTestId('invite-dialog-reason'), 'New engineer joining');
  await u.click(screen.getByTestId('invite-dialog-submit'));
  return u;
};

describe('invitations', () => {
  it('an admin invites with a role, sees it in the Invitations tab, resends and revokes it', async () => {
    const u = await inviteFromUsersPage('layla.test@example.test');
    await waitFor(() => expect(screen.queryByTestId('invite-dialog')).toBeNull());
    await u.click(screen.getByTestId('users-tab-invitations'));
    const row = await screen.findByTestId('invitation-row-layla.test@example.test');
    expect(within(row).getByTestId('invitation-status-layla.test@example.test')).toHaveTextContent('Pending');
    await u.click(within(row).getByTestId('invitation-resend-layla.test@example.test'));
    await u.type(screen.getByTestId('invitation-act-dialog-reason'), 'Sent to the wrong inbox');
    await u.click(screen.getByTestId('invitation-act-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('invitation-act-dialog')).toBeNull());
    await u.click(await screen.findByTestId('invitation-revoke-layla.test@example.test'));
    await u.type(screen.getByTestId('invitation-act-dialog-reason'), 'Not needed any more');
    await u.click(screen.getByTestId('invitation-act-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('invitation-status-layla.test@example.test')).toHaveTextContent('Revoked'));
    expect(screen.queryByTestId('invitation-revoke-layla.test@example.test')).toBeNull();
  });

  it('the accept page shows the invited person, enforces the password rules and works once', async () => {
    await inviteFromUsersPage('omar.test@example.test');
    await waitFor(() => expect(mockInvitationToken('omar.test@example.test')).toBeTruthy());
    const token = mockInvitationToken('omar.test@example.test')!;
    const u = userEvent.setup();
    renderApp(<App />, { route: `/invite/${token}` });
    expect(await screen.findByTestId('invite-facts')).toHaveTextContent('omar.test@example.test');
    await u.type(screen.getByTestId('invite-password'), 'short');
    await u.type(screen.getByTestId('invite-confirm'), 'short');
    await u.click(screen.getByTestId('invite-submit'));
    expect(await screen.findByTestId('invite-password-error')).toBeInTheDocument();
    await u.clear(screen.getByTestId('invite-password')); await u.clear(screen.getByTestId('invite-confirm'));
    await u.type(screen.getByTestId('invite-password'), 'Violet-Harbor-Lantern-77');
    await u.type(screen.getByTestId('invite-confirm'), 'Violet-Harbor-Lantern-77');
    await u.click(screen.getByTestId('invite-submit'));
    expect(await screen.findByTestId('invite-done')).toBeInTheDocument();
    renderApp(<App />, { route: `/invite/${token}` });
    expect((await screen.findAllByTestId('invite-invalid')).length).toBeGreaterThan(0);
  });

  it('a link that does not exist shows the one generic page, in Arabic too', async () => {
    renderApp(<App />, { route: '/invite/' + 'z'.repeat(43), locale: 'ar' });
    expect(await screen.findByTestId('invite-invalid')).toHaveTextContent('هذا الرابط لا يعمل');
  });
});
