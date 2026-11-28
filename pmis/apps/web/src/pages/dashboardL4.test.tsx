import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

describe('Dashboard ops: invoices, pending warehouse movements and stale open risks and issues (0.15.563, L4)', () => {
  it('shows the three cards with counts and ages, no amounts', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const inv = await screen.findByTestId('dash-ops-invoices', {}, { timeout: 8000 });
    expect(screen.getByTestId('dash-invoices-open')).toHaveTextContent('31');
    expect(screen.getByTestId('dash-invoices-overdue')).toHaveTextContent('9');
    expect(screen.getByTestId('dash-invoices-soon')).toHaveTextContent('6');
    expect(screen.getByTestId('dash-invoices-overdue-aging')).toHaveTextContent('52');
    expect(inv).not.toHaveTextContent('$');
    expect(screen.getByTestId('dash-warehouse-pending')).toHaveTextContent('12');
    expect(screen.getByTestId('dash-warehouse-state-in_review')).toHaveTextContent('4');
    expect(screen.getByTestId('dash-warehouse-aging')).toHaveTextContent('33');
    expect(screen.getByTestId('dash-stale-risks')).toHaveTextContent('5 stale of 14 open');
    expect(screen.getByTestId('dash-stale-issues')).toHaveTextContent('7 stale of 22 open');
    expect(screen.getByTestId('dash-stale-aging')).toHaveTextContent('91');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    for (const code of ['ops_invoices', 'ops_warehouse', 'ops_stale']) {
      expect(await screen.findByTestId(`dsettings-row-pmo-${code}`)).toBeInTheDocument();
      expect(screen.getByTestId(`dsettings-shown-pmo-${code}`)).toBeChecked();
    }
  }, 30_000);
});
