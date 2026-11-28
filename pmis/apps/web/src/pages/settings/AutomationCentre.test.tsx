import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Alerts, Automation (0.15.473): rules as when / then, the runs by the system, and a template that adds a normal alert rule through the reason dialog. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/alerts/automation' });

describe('Settings, automation centre', () => {
  it('shows the rule as when / then with its last run, the templates and the system as the runner', async () => {
    await signIn('pm');
    page();
    const card = await screen.findByTestId('au-rule-weekly-status-missing');
    expect(card).toHaveTextContent('When');
    expect(card).toHaveTextContent('notify the System Admins');
    expect(screen.getByTestId('au-tpl-weekly-status')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('au-run-2')).toHaveTextContent('System'));
    expect(screen.getByTestId('au-last-weekly-status-missing')).toHaveTextContent('3 target(s)');
    expect(screen.getByTestId('au-audit-link')).toBeTruthy();
  });

  it('adds a template as a normal alert rule after a reason', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('au-use-issue-stuck'));
    expect(await screen.findByTestId('au-dialog')).toHaveTextContent('tpl-issue-stuck');
  });
});
