import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Security, Lock keys (migration 0290, contract 0.15.190): both locks are off; an admin turns one on with a reason and a step-up; others see it read-only. */
const locks = (opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/locks', ...opts });

describe('Settings, Lock keys', () => {
  it('shows both locks off, saves one with a reason after the step-up, and shows it in force', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    locks();
    expect(await screen.findByTestId('page-security-locks')).toBeInTheDocument();
    expect(screen.getByTestId('locks-sharing')).not.toBeChecked();
    expect(screen.getByTestId('locks-export')).not.toBeChecked();
    expect(screen.getByTestId('locks-save')).toBeDisabled();
    await u.click(screen.getByTestId('locks-export'));
    await u.click(screen.getByTestId('locks-save'));
    await api.post('/__mock/step-up');
    await u.type(await screen.findByTestId('locks-dialog-reason'), 'Owner decision 2026-11-27');
    await u.click(screen.getByTestId('locks-dialog-submit'));
    expect(await screen.findByTestId('locks-export-in-force')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('locks-sharing-in-force')).toBeNull());
    expect(screen.getByTestId('locks-updated')).toHaveTextContent(/Last changed by/);
    // turning it off again is as easy
    await u.click(screen.getByTestId('locks-export'));
    await u.click(screen.getByTestId('locks-save'));
    await u.type(await screen.findByTestId('locks-dialog-reason'), 'Back to normal');
    await u.click(screen.getByTestId('locks-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('locks-export-in-force')).toBeNull());
  });
});
