import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';

// the charts are not under test here; a canvas chart in jsdom has no 2d context
vi.mock('@/components/EChart', () => ({ EChart: () => null }));

/** Contract 0.15.208 (migration 0510): the server-wide dashboard view defaults in Settings, overridden by the user's own choice. */
describe('Dashboard view defaults', () => {
  beforeEach(() => { localStorage.removeItem('dash.exportFormat'); for (const k of Object.keys(localStorage)) if (k.startsWith('dash.collapsed')) localStorage.removeItem(k); });
  it('Settings shows the defaults, a change needs a reason and is saved', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    const fmt = await screen.findByTestId('dsettings-view-format', {}, { timeout: 8000 });
    expect(fmt).toHaveValue('xlsx');
    expect(screen.getByTestId('dsettings-view-collapse')).toHaveValue('open');
    expect(screen.getByTestId('dsettings-view-save')).toBeDisabled();
    fireEvent.change(fmt, { target: { value: 'csv' } });
    expect(screen.getByTestId('dsettings-view-save')).toBeEnabled();
  });
  it('the dashboard starts from the server default and the own choice overrides it', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const sel = await screen.findByTestId('dash-export-format', {}, { timeout: 8000 });
    expect(sel).toHaveValue('xlsx');
    fireEvent.change(sel, { target: { value: 'csv' } });
    expect(sel).toHaveValue('csv');
    expect(localStorage.getItem('dash.exportFormat')).toBe('"csv"');
  });
});
