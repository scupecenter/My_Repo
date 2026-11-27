import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

/** Users and Roles merge (2026-11-25): Assignments sit under Users, Permission profiles under Roles; the routes are unchanged. */
describe('Users & Roles merge', () => {
  beforeEach(async () => { await signIn('pm'); });

  it('Assignments is a tab of the one strip (P1: no second row)', async () => {
    renderApp(<App />, { route: '/admin/assignments' });
    expect(await screen.findByTestId('people-tab-assignments')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('people-tab-users')).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByTestId('people-subtabs')).toBeNull();
  });

  it('Permission profiles open under one Roles and profiles tab', async () => {
    renderApp(<App />, { route: '/admin/profiles' });
    expect(await screen.findByTestId('people-sub-profiles')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('people-tab-roles')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('people-tab-roles')).toHaveTextContent('Roles and profiles');
    expect(screen.queryByTestId('people-tab-profiles')).toBeNull();
    expect(screen.getByTestId('people-sub-roles')).toHaveAttribute('aria-selected', 'false');
  });

  it('P1: Email and Phone changes sit in the Invitations menu; Deleted is a Status value; same /admin/users URL', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/admin/users' });
    await u.click(await screen.findByTestId('users-tab-invitations-menu'));
    await u.click(screen.getByTestId('users-tab-email_changes'));
    expect(await screen.findByTestId('email-changes')).toBeInTheDocument();
    expect(screen.getByTestId('users-tab-invitations')).toHaveAttribute('aria-selected', 'true');
    await u.click(screen.getByTestId('people-tab-users'));
    expect(await screen.findByTestId('users-list')).toBeInTheDocument();
    expect(screen.queryByTestId('users-tab-deleted')).toBeNull();
    expect(screen.getByTestId('users-filter-status')).toHaveTextContent('Deleted');
  });
});
