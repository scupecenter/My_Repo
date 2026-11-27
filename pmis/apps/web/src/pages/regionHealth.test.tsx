import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { StatusUpdates } from './StatusUpdates';
import { SettingsRoutes } from './settings/Settings';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/**
 * Item 12 (contract 0.15.110): the region health board of the Weekly status page, the region_health dashboard card (registered in the
 * Dashboard Settings catalogue) and the missing-update flag. The mock seeds a current-week update for Tripoli (on track) and Benghazi (at risk).
 */
describe('Region health (item 12)', () => {
  it('the Weekly status page opens with the health of every region and flags the missing updates', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/status-updates" element={<StatusUpdates />} /></Routes>, { route: '/status-updates' });
    const board = await screen.findByTestId('region-health-board');
    const rows = within(board).getAllByTestId(/^region-health-\d+$/);
    expect(rows).toHaveLength(7);
    expect(within(board).getByTestId('region-health-chip-1')).toHaveTextContent('On track');
    expect(within(board).getByTestId('region-health-chip-5')).toHaveTextContent('At risk');
    expect(within(board).getByTestId('region-health-chip-2')).toHaveTextContent('Missing update');
    expect(within(board).getByTestId('region-health-2')).toHaveAttribute('data-health', 'missing');
    expect(within(board).getByTestId('region-health-summary-1')).toHaveTextContent('Civil works on plan in Tripoli.');
  });

  it('the dashboard card shows the same health and links to the Weekly status page', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const card = await screen.findByTestId('dash-region-health');
    expect(await within(card).findByTestId('dash-region-health-chip-1')).toHaveTextContent('On track');
    expect(within(card).getByTestId('dash-region-health-chip-2')).toHaveTextContent('Missing update');
    expect(within(card).getByTestId('dash-region-health-link')).toHaveAttribute('href', '/status-updates');
  }, 30_000);

  it('the card is registered in the Dashboard Settings catalogue', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
    expect(await screen.findByTestId('page-dashboard-settings')).toBeInTheDocument();
    expect(await screen.findAllByText('Region health')).not.toHaveLength(0);
  }, 30_000);
});
