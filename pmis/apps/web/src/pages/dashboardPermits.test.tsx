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

describe('Dashboard ops: permits and HSE card (0.15.200, item 3)', () => {
  it('shows the status mix, the validity pressure, the stop-work count and the PTW check gaps', async () => {
    await signIn('pm');
    dashPage();
    const card = await screen.findByTestId('dash-ops-permits');
    expect(card).toHaveTextContent('Permits and HSE');
    expect(screen.getByTestId('dash-permits-waiting')).toHaveTextContent('7');
    expect(screen.getByTestId('dash-permits-expiring')).toHaveTextContent('4');
    expect(screen.getByTestId('dash-permits-no-permit')).toHaveTextContent('5');
    expect(screen.getByTestId('dash-permits-expired')).toHaveTextContent('2');
    expect(screen.getByTestId('dash-permits-stop-work')).toHaveTextContent('1');
    expect(screen.getByTestId('dash-permits-status-Approved')).toHaveTextContent('15');
    expect(screen.getByTestId('dash-permits-ptw-open')).toHaveTextContent('9');
    expect(screen.getByTestId('dash-permits-ptw-with-gaps')).toHaveTextContent('4');
    expect(screen.getByTestId('dash-permits-gap-loto')).toHaveTextContent('3');
    expect(screen.getByTestId('dash-permits-gap-rescue_plan')).toHaveTextContent('2');
    expect(screen.queryByTestId('dash-permits-gap-jsa_tra')).not.toBeInTheDocument();
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_permits_hse')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_permits_hse')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_permits_hse')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_permits_hse')).toBeChecked();
  }, 30_000);
});
