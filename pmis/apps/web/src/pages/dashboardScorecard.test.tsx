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

describe('Dashboard ops: contractor and supplier scorecard card (0.15.202, item 5)', () => {
  it('shows the level counts, the on-time and rejection rates, the average delay and the five worst parties, no amounts', async () => {
    await signIn('pm');
    dashPage();
    // the first render of the whole Dashboard is slow under CI load (1000 ms default is not enough)
    const card = await screen.findByTestId('dash-ops-scorecard', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Contractor and supplier scorecard');
    expect(screen.getByTestId('dash-scorecard-parties')).toHaveTextContent('12');
    expect(screen.getByTestId('dash-scorecard-level-ok')).toHaveTextContent('7');
    expect(screen.getByTestId('dash-scorecard-level-amber')).toHaveTextContent('3');
    expect(screen.getByTestId('dash-scorecard-level-red')).toHaveTextContent('1');
    expect(screen.getByTestId('dash-scorecard-level-insufficient')).toHaveTextContent('1');
    expect(screen.getByTestId('dash-scorecard-on-time')).toHaveTextContent('81.2%');
    expect(screen.getByTestId('dash-scorecard-avg-delay')).toHaveTextContent('6.4');
    expect(screen.getByTestId('dash-scorecard-quality')).toHaveTextContent('4.8%');
    expect(screen.getByTestId('dash-scorecard-quality')).toHaveTextContent('6 / 125');
    expect(screen.getByTestId('dash-scorecard-snags')).toHaveTextContent('30');
    const worst = screen.getByTestId('dash-scorecard-worst');
    expect(worst).toHaveTextContent('A&T Global');
    expect(worst).toHaveTextContent('Delta Towers');
    expect(worst).toHaveTextContent('Med Links');
    expect(card).not.toHaveTextContent('$');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_contractors')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_contractors')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_contractors')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_contractors')).toBeChecked();
  }, 30_000);
});
