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

describe('Dashboard ops: quality, snags and NCR card (0.15.203, item 6)', () => {
  it('shows the open snags and NCRs, the closure ages and the first-time acceptance rate', async () => {
    await signIn('pm');
    dashPage();
    // the first render of the whole Dashboard is slow under CI load (1000 ms default is not enough)
    const card = await screen.findByTestId('dash-ops-quality', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Quality: snags and NCR');
    expect(screen.getByTestId('dash-quality-snags-open')).toHaveTextContent('34');
    expect(screen.getByTestId('dash-quality-snags-open')).toHaveTextContent('126');
    expect(screen.getByTestId('dash-quality-snags-open')).toHaveTextContent('5');
    expect(screen.getByTestId('dash-quality-snags-avg')).toHaveTextContent('9.6');
    expect(screen.getByTestId('dash-quality-ncrs-open')).toHaveTextContent('6');
    expect(screen.getByTestId('dash-quality-ncrs-open')).toHaveTextContent('41');
    expect(screen.getByTestId('dash-quality-ncrs-avg')).toHaveTextContent('14.2');
    expect(screen.getByTestId('dash-quality-first-pass')).toHaveTextContent('92.4%');
    expect(card).not.toHaveTextContent('$');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_quality')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_quality')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_quality')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_quality')).toBeChecked();
  }, 30_000);
});
