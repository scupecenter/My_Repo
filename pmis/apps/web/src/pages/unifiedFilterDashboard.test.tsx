import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { decodeFilter } from '@/api/views';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';

// ECharts draws in the browser; here the chart is a placeholder.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const page = (route = '/dashboard', locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route, locale });

/** The `filter` parameter of every dashboard request, by path. */
function watchDashboard(): { path: string; filter: string }[] {
  const seen: { path: string; filter: string }[] = [];
  server.events.on('request:start', ({ request }) => {
    const u = new URL(request.url);
    const f = u.searchParams.get('filter');
    if (f && u.pathname.includes('/dashboard')) seen.push({ path: u.pathname, filter: f });
  });
  return seen;
}

describe('Dashboard unified filter', () => {
  it('replaces the region, cluster and scenario selects and passes the tree to the dashboard queries', async () => {
    await signIn('pm');
    const seen = watchDashboard();
    const u = userEvent.setup();
    page();
    await screen.findByTestId('dash-progress-value');
    expect(screen.queryByTestId('dash-filter-region')).toBeNull();
    expect(screen.queryByTestId('dash-filter-cluster')).toBeNull();
    expect(screen.queryByTestId('dash-filter-scenario')).toBeNull();
    expect(screen.getByTestId('dash-ref-date')).toBeInTheDocument(); // the reference date stays separate
    await u.click(await screen.findByTestId('filter-add'));
    await u.click(await screen.findByTestId('filter-field-region_id'));
    await u.click(await screen.findByTestId('filter-value-opt-5'));
    await waitFor(() => expect(seen.some((x) => x.path.endsWith('/dashboard') && decodeFilter(x.filter)?.items.length === 1)).toBe(true));
    await waitFor(() => expect(seen.some((x) => x.path.endsWith('/dashboard/extras'))).toBe(true));
    expect(decodeFilter(seen.find((x) => x.path.endsWith('/dashboard'))!.filter)).toEqual({ op: 'and', items: [{ field: 'region_id', operator: 'in', value: ['5'] }] });
    expect(screen.getByTestId('filter-chip-0')).toHaveTextContent('Region: Benghazi');
    // the reset button clears the tree too
    await u.click(screen.getByTestId('dash-reset'));
    await waitFor(() => expect(screen.queryByTestId('filter-chips')).toBeNull());
  }, 30_000);

  it('advanced (AND / OR) opens from the dashboard filter and its tree is sent', async () => {
    await signIn('pm');
    const seen = watchDashboard();
    const u = userEvent.setup();
    page();
    await screen.findByTestId('dash-progress-value');
    await u.click(await screen.findByTestId('filter-add'));
    await u.click(screen.getByTestId('filter-advanced'));
    const dlg = await screen.findByTestId('filter-dialog');
    await u.click(within(dlg).getByTestId('filter-add-group'));
    await u.selectOptions(within(dlg).getByTestId('filter-group-0-cond-0-field'), 'overall_status');
    await u.click(within(dlg).getByTestId('filter-dialog-submit'));
    await waitFor(() => expect(seen.some((x) => x.path.endsWith('/dashboard'))).toBe(true));
    expect(decodeFilter(seen[seen.length - 1]!.filter)).toEqual({ op: 'and', items: [{ op: 'or', items: [{ field: 'overall_status', operator: 'is', value: 'not_started' }] }] });
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent('( Overall status is Not started )');
  }, 30_000);

  it('Arabic: the dashboard filter button and groups', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page('/dashboard', 'ar');
    await screen.findByTestId('dash-progress-value');
    const add = await screen.findByTestId('filter-add');
    expect(add).toHaveTextContent('تصفية');
    await u.click(add);
    expect(await screen.findByRole('group', { name: 'الحالة والمرحلة' })).toBeInTheDocument();
  }, 30_000);
});
