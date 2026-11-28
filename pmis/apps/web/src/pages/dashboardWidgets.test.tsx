import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { effectiveLayout, templateLayouts, tabRows } from './dashboardLayout';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

type Tabs = { tabs: Record<string, { order: string[]; hidden: string[]; version: number }> };
const renderDash = () => renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });

describe('per-user dashboard widgets (0.15.585): layout rules', () => {
  const global = { pmo: { order: ['headline'], hidden: ['regions'] } };
  it('the own layout wins, then the global one, then the counters default off the PMO tab', () => {
    expect(effectiveLayout('pmo', { pmo: { order: ['sla'], hidden: [] } }, global)).toEqual({ order: ['sla'], hidden: [] });
    expect(effectiveLayout('pmo', undefined, global)).toEqual(global.pmo);
    expect(effectiveLayout('pmo', undefined, undefined)).toBeUndefined();
    expect(effectiveLayout('cw', undefined, global)).toEqual({ order: [], hidden: ['counters'] });
  });
  it('a template keeps the layout in force of every tab and the rows being edited for the open tab', () => {
    const rows = tabRows({ order: ['sla', 'headline'], hidden: [] }, ['headline', 'sla', 'regions']).map((r) => (r.code === 'regions' ? { ...r, shown: false } : r));
    const out = templateLayouts(['pmo', 'cw', 'te'], { te: { order: ['streams'], hidden: [] } }, global, { tab: 'pmo', rows });
    expect(out.pmo).toEqual({ order: ['sla', 'headline'], hidden: ['regions'] });
    expect(out.cw).toEqual({ order: [], hidden: ['counters'] });
    expect(out.te).toEqual({ order: ['streams'], hidden: [] });
  });
});

describe('per-user dashboard widgets (0.15.585): the dashboard', () => {
  it('hides and moves cards for the caller only, and resets to the global layout', async () => {
    await signIn('pm');
    renderDash();
    await userEvent.click(await screen.findByTestId('dash-widgets-toggle'));
    expect(await screen.findByTestId('dash-widgets-source')).toHaveTextContent('follows the layout set in Settings');
    await screen.findByTestId('dash-site-map');
    await userEvent.click(await screen.findByTestId('dw-shown-site_map'));
    await userEvent.click(screen.getByTestId('dw-down-headline'));
    await userEvent.click(screen.getByTestId('dw-save'));
    await waitFor(async () => expect(Object.keys((await api.get<Tabs>('/me/dashboard-layout')).tabs)).toEqual(['pmo']));
    const saved = (await api.get<Tabs>('/me/dashboard-layout')).tabs.pmo!;
    expect(saved.hidden).toContain('site_map');
    expect(saved.version).toBe(1);
    await waitFor(() => expect(screen.queryByTestId('dash-site-map')).toBeNull());
    expect(screen.getByTestId('dash-widgets-source')).toHaveTextContent('Your own layout');
    await userEvent.click(screen.getByTestId('dw-reset'));
    await waitFor(() => expect(screen.getByTestId('dash-site-map')).toBeInTheDocument());
    expect((await api.get<Tabs>('/me/dashboard-layout')).tabs).toEqual({});
  }, 40_000);

  it('saves, applies and deletes a named template; a stale version is refused', async () => {
    await signIn('pm');
    renderDash();
    await userEvent.click(await screen.findByTestId('dash-widgets-toggle'));
    await userEvent.click(await screen.findByTestId('dw-shown-site_map'));
    await userEvent.type(screen.getByTestId('dw-template-name'), 'Field view');
    await userEvent.click(screen.getByTestId('dw-template-save'));
    const item = await screen.findByText('Field view');
    const li = item.closest('li') as HTMLElement;
    expect((await api.get<{ items: { name: string; layouts: Record<string, { hidden: string[] }> }[] }>('/me/dashboard-templates')).items[0]!.layouts.pmo!.hidden).toContain('site_map');
    expect(within(li).getByRole('button', { name: /Delete template Field view/ })).toBeInTheDocument();
    await userEvent.click(within(li).getByText('Apply'));
    await waitFor(() => expect(screen.queryByTestId('dash-site-map')).toBeNull());
    const err = await api.put('/me/dashboard-layout/pmo', { body: { order: [], hidden: [], version: 0 } }).catch((e: { status?: number }) => e);
    expect((err as { status?: number }).status).toBe(412);
    await userEvent.click(within(li).getByRole('button', { name: /Delete template/ }));
    await waitFor(() => expect(screen.queryByText('Field view')).toBeNull());
  }, 40_000);

  it('needs the dashboard module and keeps the layout personal', async () => {
    await signIn('pm');
    await api.put('/me/dashboard-layout/cw', { body: { order: ['sla'], hidden: [], version: 0 } });
    expect(Object.keys((await api.get<Tabs>('/me/dashboard-layout')).tabs)).toEqual(['cw']);
    await signIn('engineer');
    const e = await api.get('/me/dashboard-layout').catch((x: { status?: number }) => x);
    expect((e as { status?: number }).status).toBe(403);
  }, 30_000);

  it('has the same dashWidgets keys in English and Arabic', () => {
    const keys = (d: unknown) => Object.keys((d as Record<string, Record<string, unknown>>).dashWidgets).sort();
    expect(keys(ar)).toEqual(keys(en));
  });
});
