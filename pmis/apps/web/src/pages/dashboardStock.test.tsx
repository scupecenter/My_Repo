import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';
import { Warehouse } from './Warehouse';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

describe('Dashboard: warehouse stock card (0.15.593)', () => {
  it('shows received, issued, returned, on hand and available per item group, with the period and the regional split', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const card = await screen.findByTestId('dash-stock', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Warehouse stock');
    expect(await screen.findByTestId('dash-stock-row-0')).toHaveTextContent('Antennas');
    expect(screen.getByTestId('dash-stock-row-0')).toHaveTextContent('120'); // received over 30 days
    expect(screen.getByTestId('dash-stock-total-on_hand')).toHaveTextContent('9,690');
    expect(screen.getByTestId('dash-stock-mixed-1')).toBeInTheDocument();
    expect(screen.getByTestId('dash-stock-link')).toHaveAttribute('href', '/warehouse?tab=stock');
    await u.click(screen.getByTestId('dash-stock-period-7'));
    await waitFor(() => expect(screen.getByTestId('dash-stock-row-0')).toHaveTextContent('28')); // 120 * 7/30
    await waitFor(() => expect(screen.getByTestId('dash-stock-row-0')).toHaveTextContent('340')); // on hand does not change with the period
    await u.click(screen.getByTestId('dash-stock-row-0'));
    expect(screen.getByTestId('dash-stock-regions-0')).toHaveTextContent('Issued');
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-warehouse_stock')).toBeInTheDocument();
  }, 30_000);

  it('the link opens Warehouse on its Stock tab', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/warehouse" element={<Warehouse />} /></Routes>, { route: '/warehouse?tab=stock' });
    expect(await screen.findByTestId('wh-stock-table', {}, { timeout: 8000 })).toBeInTheDocument();
  }, 30_000);
});
