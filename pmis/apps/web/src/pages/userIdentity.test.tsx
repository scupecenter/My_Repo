import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { DEMO_PASSWORDS } from '@/mocks/db';
import { uid } from '@/mocks/ids';
import { renderApp } from '@/test/utils';
import { UserDetailPage } from './UserDetail';

/** 0161: the admin edits a user's display name and employee number; e-mail and phone are not in the dialog. */
describe('Admin edits name and employee number', () => {
  beforeEach(async () => { await api.post('/auth/local/login', { body: { identifier: '1001', password: DEMO_PASSWORDS.pm } }); });
  it('opens the dialog with the two fields and a note about e-mail and phone', async () => {
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('user-edit-identity'));
    expect(await screen.findByTestId('identity-name')).toBeInTheDocument();
    expect(screen.getByTestId('identity-emp')).toBeInTheDocument();
    expect(screen.getByTestId('identity-note')).toHaveTextContent(/E-mail and phone/);
    await waitFor(() => expect(screen.queryByTestId('identity-email')).toBeNull());
  });
});
