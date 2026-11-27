import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

describe('Dashboard ops: phase scope card (0.15.367)', () => {
  it('shows the sites per phase with progress and the targets derived from the scope', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const card = await screen.findByTestId('dash-ops-phase', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Phase scope');
    expect(screen.getByTestId('dash-phase-total')).toHaveTextContent('105');
    expect(screen.getByTestId('dash-phase-onair')).toHaveTextContent('27');
    expect(screen.getByTestId('dash-phase-monthly')).toHaveTextContent('20');
    expect(screen.getByTestId('dash-phase-row-0')).toHaveTextContent('Phase 1');
    expect(screen.getByTestId('dash-phase-row-0')).toHaveTextContent('40');
    expect(screen.getByTestId('dash-phase-row-2')).toHaveTextContent('No phase recorded');
    expect(card.querySelector('input')).toBeNull();
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_phase')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ops_phase')).toBeChecked();
  }, 30_000);
});
