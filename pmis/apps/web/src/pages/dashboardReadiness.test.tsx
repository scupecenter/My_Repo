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

describe('Dashboard ops: power and fiber readiness card (0.15.201, item 4)', () => {
  it('shows the scoped sites, the done counts, the headline waits and the aging buckets per utility', async () => {
    await signIn('pm');
    dashPage();
    const card = await screen.findByTestId('dash-ops-readiness', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Power and fiber readiness');
    expect(screen.getByTestId('dash-gecol-in-scope')).toHaveTextContent('18');
    expect(screen.getByTestId('dash-gecol-done')).toHaveTextContent('9');
    expect(screen.getByTestId('dash-gecol-no-record')).toHaveTextContent('2');
    expect(screen.getByTestId('dash-gecol-headline')).toHaveTextContent('3');
    expect(screen.getByTestId('dash-gecol-aging-bucket-over_30')).toHaveTextContent('2');
    expect(screen.getByTestId('dash-hlc-in-scope')).toHaveTextContent('21');
    expect(screen.getByTestId('dash-hlc-done')).toHaveTextContent('12');
    expect(screen.getByTestId('dash-hlc-headline')).toHaveTextContent('2');
    expect(screen.getByTestId('dash-hlc-aging-bucket-d0_7')).toHaveTextContent('3');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_gecol_hlc')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_gecol_hlc')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_gecol_hlc')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_gecol_hlc')).toBeChecked();
  }, 30_000);
});
