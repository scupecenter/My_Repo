import { screen } from '@testing-library/react';
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

describe('Dashboard ops: procurement and materials card (0.15.96, item 1)', () => {
  it('shows the open orders, the PR/PO aging buckets, the receive rate and the shortage per contractor', async () => {
    await signIn('pm');
    dashPage();
    // the first render of the whole Dashboard in this file is slow under CI load (1000 ms default was not enough on main a7f79df2)
    const card = await screen.findByTestId('dash-ops-procurement', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Procurement and materials');
    expect(screen.getByTestId('dash-ops-open-orders')).toHaveTextContent('14');
    expect(screen.getByTestId('dash-ops-pr-waiting')).toHaveTextContent('7');
    expect(screen.getByTestId('dash-ops-pr-aging-bucket-over_30')).toHaveTextContent('1');
    expect(screen.getByTestId('dash-ops-po-aging-bucket-d0_7')).toHaveTextContent('4');
    expect(screen.getByTestId('dash-ops-receive')).toHaveTextContent('62.5%');
    expect(screen.getByTestId('dash-ops-sites-short')).toHaveTextContent('3');
    expect(screen.getByTestId('dash-ops-short-TR101-PWR-001')).toHaveTextContent('Rectifier module');
    expect(screen.getByTestId('dash-ops-short-TR101-PWR-001')).toHaveTextContent('A&T Global');
    // A10: the line suggests a draft purchase request: a link to the new Procurement form with the site and the remark (nothing is created by the link)
    const draft = screen.getByTestId('dash-ops-draft-TR101-PWR-001');
    expect(draft.getAttribute('href')).toContain('/registers/procurement?record=new&from=shortage&site=');
    expect(decodeURIComponent(draft.getAttribute('href') ?? '').replace(/\+/g, ' ')).toContain('Shortage of PWR-001 Rectifier module: missing');
    expect(screen.getByTestId('dash-ops-contractor-00000000-0000-4000-8000-000000000201')).toHaveTextContent('6 missing');
    expect(screen.getByTestId('dash-ops-contractor-none')).toHaveTextContent('Unattributed');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_procurement')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_procurement')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_procurement')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_procurement')).toBeChecked();
  }, 30_000);

  it('has the same dash.ops keys in English and Arabic', () => {
    const keys = (d: unknown) => Object.keys(((d as Record<string, Record<string, Record<string, unknown>>>).dash.ops)).sort();
    expect(keys(ar)).toEqual(keys(en));
  });
});
