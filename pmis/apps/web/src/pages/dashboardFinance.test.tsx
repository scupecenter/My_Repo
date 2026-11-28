import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const dashPage = () =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });

describe('Dashboard ops: restricted financial summary card (0.15.206, item 9)', () => {
  it('shows the advances, the amounts and the disbursed amount against completion to a configured reader', async () => {
    await signIn('pm');
    dashPage();
    const card = await screen.findByTestId('dash-ops-finance', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Restricted financial summary');
    expect(screen.getByTestId('dash-finance-total')).toHaveTextContent('14');
    expect(screen.getByTestId('dash-finance-open')).toHaveTextContent('9');
    expect(screen.getByTestId('dash-finance-hidden')).toHaveTextContent('1');
    expect(screen.getByTestId('dash-finance-disbursed')).toHaveTextContent('151,500');
    expect(screen.getByTestId('dash-finance-aging')).toHaveTextContent('52');
    expect(screen.getByTestId('dash-finance-completed')).toHaveTextContent('3 (37.5%)');
    expect(screen.getByTestId('dash-finance-on-open')).toHaveTextContent('103,300');
    expect(card).toHaveTextContent('Invoice ages are not shown');
  }, 30_000);

  it('is registered in Settings > Dashboard and the readers can be chosen there (off by default)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_finance')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_finance')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_finance')).toBeInTheDocument();
    const on = await screen.findByTestId('dsettings-finance-enabled');
    expect(on).not.toBeChecked();
    expect(screen.getByTestId('dsettings-finance-role-PM')).toBeChecked();
    expect(screen.getByTestId('dsettings-finance-role-FIN_OFFICER')).toBeChecked();
    expect(screen.getByTestId('dsettings-finance-role-MANAGEMENT')).not.toBeChecked();
    expect(screen.getByTestId('dsettings-finance-save')).toBeDisabled();
    fireEvent.click(on);
    expect(screen.getByTestId('dsettings-finance-save')).toBeEnabled();
  }, 30_000);
});
