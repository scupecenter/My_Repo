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

describe('Dashboard ops: pending approvals bottleneck card (0.15.204, item 7)', () => {
  it('shows the waiting counts, the review and approve split and the ages per role', async () => {
    await signIn('pm');
    dashPage();
    const card = await screen.findByTestId('dash-ops-approvals');
    expect(card).toHaveTextContent('Pending approvals bottleneck');
    expect(screen.getByTestId('dash-approvals-total')).toHaveTextContent('23');
    expect(screen.getByTestId('dash-approvals-review')).toHaveTextContent('14');
    expect(screen.getByTestId('dash-approvals-approve')).toHaveTextContent('9');
    expect(screen.getByTestId('dash-approvals-unassigned')).toHaveTextContent('3');
    const waiting = screen.getByTestId('dash-approvals-waiting');
    expect(waiting).toHaveTextContent('47');
    const roles = screen.getByTestId('dash-approvals-roles');
    expect(roles).toHaveTextContent('Project Manager');
    expect(roles).toHaveTextContent('QC Engineer');
    expect(roles).toHaveTextContent('Finance Officer');
    const pm = screen.getByTestId('dash-approvals-aging-00000000-0000-4000-8000-000000000301');
    expect(pm).toHaveTextContent('9');
    expect(pm).toHaveTextContent('47');
    expect(card).not.toHaveTextContent('$');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_approvals')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_approvals')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_approvals')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_approvals')).toBeChecked();
  }, 30_000);
});
