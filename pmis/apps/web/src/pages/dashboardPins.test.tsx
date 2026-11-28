import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { RegisterPage } from './Register';
import { DashboardSettings } from './settings/DashboardSettings';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/** 0.15.245 (migration 0344; owner request 2026-11-27, research item 16): pin a saved view as a card on the home dashboard. */
const makeView = async (name: string) => {
  const v = await api.post<{ id: string }>('/saved-views', { body: { screen_key: 'register-issues', name, filters: {} } });
  return v.id;
};

describe('Pinned views card (0.15.245, item 16)', () => {
  it('shows the pinned views with the counter of the screen and opens the screen with the view applied', async () => {
    await signIn('pm');
    const id = await makeView('Late issues');
    await api.post(`/saved-views/${id}/pin`, { body: {} });
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const card = await screen.findByTestId('dash-pinned-views');
    expect(card).toHaveTextContent('Pinned views');
    const row = await screen.findByTestId(`pin-row-${id}`);
    expect(row).toHaveTextContent('Late issues');
    expect(screen.getByTestId(`pin-count-${id}`)).toHaveTextContent(/[0-9]/);
    expect(screen.getByTestId(`pin-link-${id}`).getAttribute('href')).toBe(`/registers/issues?view_id=${id}`);
  }, 30_000);

  it('sets and removes a personal watch on a pinned view and reports the count once the card has it (0.15.487)', async () => {
    await signIn('pm');
    const id = await makeView('Watched issues');
    await api.post(`/saved-views/${id}/pin`, { body: {} });
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    await userEvent.click(await screen.findByTestId(`pin-watch-${id}`));
    const input = await screen.findByTestId(`pin-watch-min-${id}`);
    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(screen.getByTestId(`pin-watch-save-${id}`)).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, '1');
    await userEvent.click(screen.getByTestId(`pin-watch-save-${id}`));
    await waitFor(async () => expect((await api.get<{ items: { view_id: string; min_rows: number }[] }>('/me/view-watches')).items.find((w) => w.view_id === id)?.min_rows).toBe(1));
    await userEvent.click(await screen.findByTestId(`pin-watch-${id}`));
    await userEvent.click(await screen.findByTestId(`pin-watch-remove-${id}`));
    await waitFor(async () => expect((await api.get<{ items: unknown[] }>('/me/view-watches')).items).toHaveLength(0));
  }, 30_000);

  it('the watch report notifies at the limit once a day at most, only for a watched view (0.15.487)', async () => {
    await signIn('pm');
    const id = await makeView('Daily alert');
    await api.post(`/saved-views/${id}/pin`, { body: {} });
    const rep = (count: number) => api.post<{ notified: boolean }>(`/saved-views/${id}/watch-report`, { body: { count } });
    expect((await rep(50)).notified).toBe(false);
    await api.post(`/saved-views/${id}/watch`, { body: { min_rows: 5 } });
    expect((await rep(4)).notified).toBe(false);
    expect((await rep(5)).notified).toBe(true);
    expect((await rep(9)).notified).toBe(false);
    await api.post(`/saved-views/${id}/watch`, { body: { min_rows: 3 } });
    expect((await rep(9)).notified).toBe(true);
  }, 30_000);

  it('pins and unpins from the view toolbar of the register screen', async () => {
    await signIn('pm');
    const id = await makeView('My pins test');
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: '/registers/issues' });
    const tab = await screen.findByTestId(`views-tab-register-issues-${id}`);
    await userEvent.click(tab);
    const toggle = await screen.findByTestId('views-pin-home');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
    expect((await api.get<{ items: { view_id: string }[] }>('/me/home-pins')).items.map((p) => p.view_id)).toContain(id);
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'));
    expect((await api.get<{ items: { view_id: string }[] }>('/me/home-pins')).items.map((p) => p.view_id)).not.toContain(id);
  }, 30_000);

  it('is registered in Settings > Dashboard (visibility and order per tab)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-pinned_views')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-pinned_views')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-pinned_views')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-shown-pmo-pinned_views')).toBeChecked();
  }, 30_000);

  it('has the same savedViews pin and dash.pins keys in English and Arabic', () => {
    const sv = (d: Record<string, Record<string, unknown>>) => Object.keys(d.savedViews).filter((k) => k.includes('pin')).sort();
    expect(sv(ar as never)).toEqual(sv(en as never));
    const pins = (d: unknown) => Object.keys((d as Record<string, Record<string, Record<string, unknown>>>).dash.pins).sort();
    expect(pins(ar)).toEqual(pins(en));
  });
});
