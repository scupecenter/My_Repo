import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Security, Limits (migration 0402, contract 0.15.263): every limit shows its default; an admin changes one with a reason and a step-up. */
const page = (opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/limits', ...opts });

describe('Settings, Limits', () => {
  it('shows the defaults, refuses a bad value, saves a change with a reason after the step-up and can go back to the default', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('page-ops-limits')).toBeInTheDocument();
    expect(screen.getByTestId('oplimits-session_idle_hours')).toHaveValue('8');
    expect(screen.getByTestId('oplimits-session_absolute_hours')).toHaveValue('12');
    expect(screen.getByTestId('oplimits-stepup_seconds')).toHaveValue('300');
    expect(screen.getByTestId('oplimits-export_max_rows')).toHaveValue('100000');
    expect(screen.getByTestId('oplimits-save')).toBeDisabled();
    await u.clear(screen.getByTestId('oplimits-stepup_seconds'));
    await u.type(screen.getByTestId('oplimits-stepup_seconds'), '5');
    expect(screen.getByTestId('oplimits-stepup_seconds-error')).toBeInTheDocument();
    expect(screen.getByTestId('oplimits-save')).toBeDisabled();
    await u.clear(screen.getByTestId('oplimits-stepup_seconds'));
    await u.type(screen.getByTestId('oplimits-stepup_seconds'), '120');
    await u.click(screen.getByTestId('oplimits-save'));
    await api.post('/__mock/step-up');
    await u.type(await screen.findByTestId('oplimits-dialog-reason'), 'Shorter window');
    await u.click(screen.getByTestId('oplimits-dialog-submit'));
    expect(await screen.findByTestId('oplimits-stepup_seconds-custom')).toBeInTheDocument();
    expect(screen.getByTestId('oplimits-stepup_seconds')).toHaveValue('120');
    expect(screen.getByTestId('oplimits-updated')).toHaveTextContent(/Last changed by/);
    await u.click(screen.getByTestId('oplimits-stepup_seconds-reset'));
    await u.click(screen.getByTestId('oplimits-save'));
    await u.type(await screen.findByTestId('oplimits-dialog-reason'), 'Back to default');
    await u.click(screen.getByTestId('oplimits-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('oplimits-stepup_seconds-custom')).toBeNull());
  });

  it('refuses an absolute session shorter than the idle sign-out', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    await screen.findByTestId('page-ops-limits');
    await u.clear(screen.getByTestId('oplimits-session_absolute_hours'));
    await u.type(screen.getByTestId('oplimits-session_absolute_hours'), '4');
    expect(screen.getByTestId('oplimits-session-error')).toBeInTheDocument();
    expect(screen.getByTestId('oplimits-save')).toBeDisabled();
  });
});
