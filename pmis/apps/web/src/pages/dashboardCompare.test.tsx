import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { DashboardSettings } from './settings/DashboardSettings';
import { quickValue, withQuickValue } from './dashboardQuickFilters';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const dashPage = () =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });

describe('Dashboard ops: comparison card and quick site filters (0.15.207, item 10)', () => {
  it('compares the regions and the contractors side by side', async () => {
    await signIn('pm');
    dashPage();
    const card = await screen.findByTestId('dash-ops-compare', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Comparison: regions and contractors');
    expect(await screen.findByTestId('dash-compare-contractors')).toBeInTheDocument();
    expect(screen.getByTestId('dash-compare-party-00000000-0000-4000-8000-000000000201')).toHaveTextContent('A&T Global');
    expect(screen.getByTestId('dash-compare-party-00000000-0000-4000-8000-000000000201')).toHaveTextContent('14 / 12');
    expect(screen.getByTestId('dash-compare-regions').querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(screen.getByTestId('dash-compare-best')).toBeInTheDocument();
  }, 30_000);

  it('offers the four quick filters and writes the same filter tree', async () => {
    await signIn('pm');
    dashPage();
    const phase = (await screen.findByTestId('dash-quick-project_phase')) as HTMLSelectElement;
    expect(screen.getByTestId('dash-quick-delivery_batch')).toBeInTheDocument();
    expect(screen.getByTestId('dash-quick-site_type')).toBeInTheDocument();
    expect(screen.getByTestId('dash-quick-tower_owner')).toBeInTheDocument();
    fireEvent.change(phase, { target: { value: 'Phase 2' } });
    await waitFor(() => expect((screen.getByTestId('dash-quick-project_phase') as HTMLSelectElement).value).toBe('Phase 2'));
  }, 30_000);

  it('is registered in Settings > Dashboard', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/settings/dashboard" element={<DashboardSettings />} /></Routes>, { route: '/settings/dashboard' });
    expect(await screen.findByTestId('dsettings-row-pmo-ops_compare')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-cw-ops_compare')).toBeInTheDocument();
    expect(screen.getByTestId('dsettings-row-te-ops_compare')).toBeInTheDocument();
  }, 30_000);
});

describe('quick filter tree helpers', () => {
  it('sets, replaces and clears a condition without touching the others', () => {
    const t1 = withQuickValue(null, 'site_type', 'Macro');
    expect(quickValue(t1, 'site_type')).toBe('Macro');
    const t2 = withQuickValue({ op: 'and', items: [{ field: 'name', operator: 'contains', value: 'x' }, ...t1.items] }, 'site_type', 'Micro');
    expect(quickValue(t2, 'site_type')).toBe('Micro');
    expect(t2.items).toHaveLength(2);
    expect(withQuickValue(t2, 'site_type', '').items).toHaveLength(1);
  });
  it('keeps an OR tree as one group', () => {
    const or = { op: 'or' as const, items: [{ field: 'name', operator: 'is' as const, value: 'a' }, { field: 'name', operator: 'is' as const, value: 'b' }] };
    const r = withQuickValue(or, 'tower_owner', 'Own');
    expect(r.op).toBe('and');
    expect(r.items).toHaveLength(2);
  });
});
