import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Sites } from './Sites';

describe('Site Master menus on the Sites page', () => {
  it('draws the CW menu as a grid with the three header rows and the totals row when ?layout=grid is in the URL', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw&layout=grid' });
    const grid = await screen.findByTestId('site-master-grid');
    expect(grid.getAttribute('data-menu')).toBe('cw');
    expect(screen.getByTestId('site-master-grid-band-row')).toBeTruthy();
    expect(screen.getByTestId('site-master-grid-group-row')).toBeTruthy();
    expect(screen.getByTestId('site-master-grid-field-row')).toBeTruthy();
    expect(screen.getByTestId('site-master-grid-totals')).toBeTruthy();
  });

  it('shows the list by default in a sub-menu, with no Grid/Vertical toggle and the sub-menu name in the title', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    expect(await screen.findByTestId('site-master-list')).toBeTruthy();
    expect(screen.queryByTestId('site-master-grid')).toBeNull();
    expect(screen.queryByTestId('site-master-grid-band-row')).toBeNull();
    expect(screen.queryByTestId('site-master-layout')).toBeNull();
    expect(screen.queryByTestId('site-master-layout-grid')).toBeNull();
    expect(screen.queryByTestId('site-master-layout-vertical')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Site Master: CW');
  });

  it('a sub-menu lists ITS OWN columns (named by the column header, the group only as a tooltip), not the generic ones', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    await screen.findByTestId('site-row-S360-001');
    const head = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(head).toEqual(expect.arrayContaining(['Site ID', 'Site Name', 'Pre-CW Readiness', 'CW Delivery Model', 'Current Milestone', 'Remark']));
    expect(head).not.toContain('Pipeline'); // a column of the generic list
    expect(head).not.toContain('TE Access Date'); // a column of another menu
    expect(screen.getAllByRole('columnheader').find((h) => h.textContent === 'CW Delivery Model')).toHaveAttribute('title', 'PRE-CW / CW Procurement');
    expect(within(screen.getByTestId('site-row-S360-001')).getByText('outsourced')).toBeTruthy();
    expect(screen.getByTestId('site-select-S360-001')).toBeTruthy();
  });

  it('TE shows its date column, read-only and formatted as a date', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=te' });
    const row = await screen.findByTestId('site-row-S360-001');
    expect(within(row).getByText('10 Mar 2026')).toBeTruthy();
    expect(row.querySelector('input')).toBeNull();
  });

  it('Site Master (no section) shows the generic list with the pipeline and the quick filters, not the Excel grid (owner answer 2026-11-22)', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    expect(await screen.findByTestId('sites-list')).toBeTruthy();
    expect(screen.queryByTestId('site-master-list')).toBeNull();
    expect(screen.queryByTestId('site-master-grid')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Site Master$/);
  });

  it('a click on a row opens the site page', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    const row = await screen.findByTestId('site-row-S360-002');
    expect(row.getAttribute('href')).toBe('/sites/a0000000-0000-4000-8000-000000000002');
  });

  it('writes the sub-menu name in the Arabic title', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw', locale: 'ar' });
    await screen.findByTestId('site-master-list');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('الأعمال المدنية');
  });

  it('keeps the generic list of a stream sub-menu (?stream=), with no grid and no toggle', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?stream=CW' });
    await screen.findByTestId('page-sites');
    expect(screen.queryByTestId('site-master-grid')).toBeNull();
    expect(screen.queryByTestId('site-master-list')).toBeNull();
    expect(screen.queryByTestId('site-master-layout')).toBeNull();
  });

  it('sends the status filter of the grid as `status`, the name the API reads (audit A finding 11)', { timeout: 30_000 }, async () => {
    await signIn('pm');
    const seen: URLSearchParams[] = [];
    const on = ({ request }: { request: Request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/site360/cw/rows')) seen.push(u.searchParams); };
    server.events.on('request:start', on);
    try {
      renderApp(<Sites />, { route: '/sites?section=cw&layout=grid&overall_status=on_hold' });
      await screen.findByTestId('site-master-grid');
      await waitFor(() => expect(seen.length).toBeGreaterThan(0));
      expect(seen[0]!.get('status')).toBe('on_hold');
      expect(seen[0]!.has('overall_status')).toBe(false);
    } finally {
      server.events.removeListener('request:start', on);
    }
  });

  it('passes a dashboard drill-down to the list and shows it as filters (EN and AR)', { timeout: 30_000 }, async () => {
    await signIn('pm');
    const seen: URLSearchParams[] = [];
    const on = ({ request }: { request: Request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/sites') && u.searchParams.has('milestone_reached')) seen.push(u.searchParams); };
    server.events.on('request:start', on);
    try {
      const { unmount } = renderApp(<Sites />, { route: '/sites?layout=list&milestone_reached=MS6&ref_date=2026-10-29&cluster_code=CL-TR-01' });
      await screen.findByTestId('page-sites');
      await waitFor(() => expect(seen.length).toBeGreaterThan(0));
      expect(seen[0]!.get('ref_date')).toBe('2026-10-29');
      expect(seen[0]!.get('cluster_code')).toBe('CL-TR-01');
      expect(await screen.findByText('As of 2026-10-29')).toBeTruthy();
      unmount();
      renderApp(<Sites />, { route: '/sites?layout=list&dashboard_status=on_hold', locale: 'ar' });
      expect(await screen.findByText(/حالة لوحة المؤشرات/)).toBeTruthy();
    } finally {
      server.events.removeListener('request:start', on);
    }
  });
});
