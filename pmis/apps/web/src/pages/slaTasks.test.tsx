import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.85: Settings > SLA > "Tasks and their SLA": every task with its status, the not-decided count, the explicit "no SLA" choice. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/sla/rules' });

describe('Settings, SLA status of every task', () => {
  it('lists a task of every status, counts the undecided ones and lists the draft task in its own group', async () => {
    await signIn('pm');
    page();
    const panel = await screen.findByTestId('sla-tasks');
    expect(await within(panel).findByTestId('sla-task-A1')).toHaveAttribute('data-mode', 'set');
    expect(within(panel).getByTestId('sla-task-A2')).toHaveAttribute('data-mode', 'undecided');
    expect(within(panel).getByTestId('sla-task-B1')).toHaveAttribute('data-mode', 'none');
    expect(within(panel).getByTestId('sla-task-NEW9')).toHaveAttribute('data-draft', 'true');
    expect(within(panel).getByTestId('sla-task-edit-NEW9')).toHaveAttribute('href', '/admin/workflow');
    expect(within(panel).getByTestId('sla-tasks-banner')).toHaveAttribute('data-undecided', '2');
  });

  it('marks a task as having no SLA with a reason, and can undo it (nothing is deleted)', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('sla-task-none-A2'));
    expect(screen.getByTestId('sla-tasks-save')).toBeDisabled();
    await u.type(screen.getByTestId('sla-tasks-reason'), 'Approval is outside our clock');
    await u.click(screen.getByTestId('sla-tasks-save'));
    await waitFor(() => expect(screen.getByTestId('sla-task-A2')).toHaveAttribute('data-mode', 'none'));
    await u.click(screen.getByTestId('sla-task-clear-A2'));
    await u.type(screen.getByTestId('sla-tasks-reason'), 'Decided later');
    await u.click(screen.getByTestId('sla-tasks-save'));
    await waitFor(() => expect(screen.getByTestId('sla-task-A2')).toHaveAttribute('data-mode', 'undecided'));
  });
});
