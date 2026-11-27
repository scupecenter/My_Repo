import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const dashPage = () =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });

describe('Dashboard: Project Status detail table (0.15.366)', () => {
  it('shows the main rows closed, opens one row, then expands and collapses all', async () => {
    await signIn('pm');
    dashPage();
    const card = await screen.findByTestId('dash-ps-table', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Project Status detail');
    expect(screen.getByTestId('dash-pst-row-A1')).toHaveTextContent('82');
    expect(screen.getByTestId('dash-pst-row-A1')).toHaveTextContent('12%');
    expect(screen.getByTestId('dash-pst-row-A1')).toHaveTextContent('33 / 40');
    expect(screen.queryByTestId('dash-pst-item-A1.1')).not.toBeInTheDocument();
    const t = screen.getByTestId('dash-pst-toggle-A1');
    expect(t).toHaveAttribute('aria-expanded', 'false');
    expect(t).toHaveAttribute('title');
    fireEvent.click(t);
    expect(screen.getByTestId('dash-pst-item-A1.1')).toHaveTextContent('Site survey');
    expect(screen.getByTestId('dash-pst-item-A1.1')).toHaveTextContent('18 / 20');
    expect(screen.queryByTestId('dash-pst-item-A4.1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dash-pst-expand'));
    expect(screen.getByTestId('dash-pst-item-A4.3')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dash-pst-collapse'));
    expect(screen.queryByTestId('dash-pst-item-A1.1')).not.toBeInTheDocument();
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ps_detail')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-ps_detail')).toBeChecked();
  }, 30_000);
});
