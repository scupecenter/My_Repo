import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const dashPage = () =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });

describe('Dashboard ops: change requests and overdue meeting actions card (0.15.205, item 8)', () => {
  it('shows the pending changes with ages and kinds, and the overdue meeting actions', async () => {
    await signIn('pm');
    dashPage();
    // the first render of the whole Dashboard is slow under CI load (1000 ms default is not enough)
    const card = await screen.findByTestId('dash-ops-changes', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Change requests and overdue meeting actions');
    expect(screen.getByTestId('dash-changes-pending')).toHaveTextContent('7');
    expect(screen.getByTestId('dash-changes-approved')).toHaveTextContent('2');
    expect(screen.getByTestId('dash-changes-aging')).toHaveTextContent('38');
    expect(screen.getByTestId('dash-changes-kind-scope_change')).toHaveTextContent('Scope');
    expect(screen.getByTestId('dash-changes-kind-scope_change')).toHaveTextContent('4');
    expect(screen.getByTestId('dash-actions-open')).toHaveTextContent('19');
    expect(screen.getByTestId('dash-actions-overdue')).toHaveTextContent('8');
    expect(screen.getByTestId('dash-actions-nodue')).toHaveTextContent('3');
    expect(screen.getByTestId('dash-actions-aging')).toHaveTextContent('41');
    expect(card).not.toHaveTextContent('$');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_changes')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_changes')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_changes')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_changes')).toBeChecked();
  }, 30_000);
});
