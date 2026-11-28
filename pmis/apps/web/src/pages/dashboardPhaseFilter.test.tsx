import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';

// ECharts draws in the browser; here the chart is a placeholder.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const page = (route = '/dashboard') =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route });

// 0.15.368: the phase quick filter narrows every dashboard endpoint, and Project Status groups by phase.
describe('Dashboard phase quick filter and group-by phase', () => {
  it('offers the phases of filters.phases, sends project_phase to the dashboard endpoints and shows the by-phase breakdown', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const u = new URL(request.url);
      if (u.searchParams.get('project_phase') === 'Phase 1') seen.push(u.pathname);
    });
    const u = userEvent.setup();
    page();
    await screen.findByTestId('dash-progress-value');
    const sel = screen.getByTestId('dash-filter-phase');
    expect(within(sel).getByRole('option', { name: 'Phase 1' })).toBeInTheDocument();
    expect(within(sel).getByRole('option', { name: 'Phase 2' })).toBeInTheDocument();
    await u.selectOptions(sel, 'Phase 1');
    await waitFor(() => expect(seen.some((p) => p.endsWith('/dashboard'))).toBe(true));
    await waitFor(() => expect(seen.some((p) => p.endsWith('/dashboard/ops'))).toBe(true));
    await waitFor(() => expect(seen.some((p) => p.endsWith('/dashboard/extras'))).toBe(true));
    await waitFor(() => expect(seen.some((p) => p.endsWith('/project-status'))).toBe(true));
    // the Project Status card groups by phase
    const grp = await screen.findByTestId('dash-ps-by-phase');
    expect(within(grp).getByTestId('dash-ps-phase-Phase 1')).toHaveTextContent('61.4');
    expect(within(grp).getByTestId('dash-ps-phase-Phase 2')).toHaveTextContent('23.8');
    // the reset button clears the phase too
    await u.click(screen.getByTestId('dash-reset'));
    await waitFor(() => expect((screen.getByTestId('dash-filter-phase') as HTMLSelectElement).value).toBe(''));
  }, 30_000);
});
