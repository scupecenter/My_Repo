import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

/** Users and Roles merge (2026-11-25): Assignments sit under Users, Permission profiles under Roles; the routes are unchanged. */
describe('Users & Roles merge', () => {
  beforeEach(async () => { await signIn('pm'); });

  it('Assignments opens under the Users tab with a second row', async () => {
    renderApp(<App />, { route: '/admin/assignments' });
    expect(await screen.findByTestId('people-subtabs')).toBeInTheDocument();
    expect(screen.getByTestId('people-tab-users')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('people-sub-assignments')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('people-tab-assignments')).toBeNull();
  });

  it('Permission profiles open under one Roles and profiles tab', async () => {
    renderApp(<App />, { route: '/admin/profiles' });
    expect(await screen.findByTestId('people-sub-profiles')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('people-tab-roles')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('people-tab-roles')).toHaveTextContent('Roles and profiles');
    expect(screen.queryByTestId('people-tab-profiles')).toBeNull();
    expect(screen.getByTestId('people-sub-roles')).toHaveAttribute('aria-selected', 'false');
  });
});
