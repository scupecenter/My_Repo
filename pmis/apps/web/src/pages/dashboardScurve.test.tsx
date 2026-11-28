import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const dashPage = () =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });

describe('Dashboard progress curve card (dashboard proposals item 2)', () => {
  it('shows planned vs actual, the plan index, the weekly velocity and the 100% forecast of the saved snapshots', async () => {
    await signIn('pm');
    dashPage();
    // the first render of the whole Dashboard is slow under CI load (1000 ms default is not enough)
    const card = await screen.findByTestId('dash-scurve', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Progress curve');
    expect(await screen.findByTestId('dash-scurve-actual')).toHaveTextContent('76.5%');
    expect(screen.getByTestId('dash-scurve-planned')).toHaveTextContent('90%');
    expect(screen.getByTestId('dash-scurve-spi')).toHaveTextContent('0.850');
    expect(screen.getByTestId('dash-scurve-velocity')).toHaveTextContent('+3.1%/week');
    // (100 - 76.5) at 3.125 %/week = 52.64 -> 53 days after the 2026-11-19 snapshot
    expect(screen.getByTestId('dash-scurve-forecast')).toHaveTextContent('Jan 11, 2027');
    expect(screen.getByTestId('dash-scurve-basis')).toHaveTextContent('14 saved weekly snapshots');
    expect(screen.getByTestId('dash-scurve-chart')).toHaveAttribute('role', 'img');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_scurve')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_scurve')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_scurve')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_scurve')).toBeChecked();
  }, 30_000);

  it('has the same dash.scurve keys in English and Arabic', () => {
    const keys = (d: unknown) => Object.keys((d as Record<string, Record<string, Record<string, unknown>>>).dash.scurve).sort();
    expect(keys(ar)).toEqual(keys(en));
  });
});

describe('Dashboard agile views (burn-up, cumulative flow, velocity, forecast cone)', () => {
  it('reads the frozen snapshot counts: scope change, pace, finish date and range', async () => {
    await signIn('pm');
    dashPage();
    await screen.findByTestId('dash-scurve', {}, { timeout: 8000 });
    const u = userEvent.setup();
    await u.click(screen.getByTestId('dash-scurve-mode-burnup'));
    expect(await screen.findByTestId('dash-agile-burnup')).toBeInTheDocument();
    expect(screen.getByTestId('dash-agile-done')).toHaveTextContent('840 / 1,560');
    expect(screen.getByTestId('dash-agile-scope-change')).toHaveTextContent('+60');
    // the last 4 weekly gaps (65, 60, 65, 65) average 63.75 items a week, shown as 63.8
    expect(screen.getByTestId('dash-agile-pace')).toHaveTextContent('63.8 items/week');
    expect(screen.getByTestId('dash-agile-pace')).toHaveAttribute('title');
    expect(screen.getByTestId('dash-agile-chart-burnup')).toHaveAttribute('role', 'img');
    await u.click(screen.getByTestId('dash-scurve-mode-cfd'));
    expect(await screen.findByTestId('dash-agile-sites')).toHaveTextContent('60');
    await u.click(screen.getByTestId('dash-scurve-mode-velocity'));
    expect(await screen.findByTestId('dash-agile-chart-velocity')).toBeInTheDocument();
    await u.click(screen.getByTestId('dash-scurve-mode-cone'));
    expect(await screen.findByTestId('dash-agile-range')).toBeInTheDocument();
    expect(screen.getByTestId('dash-agile-finish')).not.toHaveTextContent('–');
  }, 40_000);

  it('has English and Arabic keys for every agile string', () => {
    const k = Object.keys((en as { dash: { agile: Record<string, string> } }).dash.agile).sort();
    expect(Object.keys((ar as { dash: { agile: Record<string, string> } }).dash.agile).sort()).toEqual(k);
  });
});
