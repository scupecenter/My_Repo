import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Sites } from './Sites';

describe('SITE 360 menus on the Sites page', () => {
  it('draws the CW menu as a grid with the three header rows and the totals row', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    const grid = await screen.findByTestId('site360-grid');
    expect(grid.getAttribute('data-menu')).toBe('cw');
    expect(screen.getByTestId('site360-grid-band-row')).toBeTruthy();
    expect(screen.getByTestId('site360-grid-group-row')).toBeTruthy();
    expect(screen.getByTestId('site360-grid-field-row')).toBeTruthy();
    expect(screen.getByTestId('site360-grid-totals')).toBeTruthy();
  });

  it('switches to the vertical list and back to the grid', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    await screen.findByTestId('site360-grid');
    fireEvent.click(screen.getByTestId('site360-layout-vertical'));
    expect(screen.queryByTestId('site360-grid')).toBeNull();
    expect(screen.getByTestId('site360-layout-vertical').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('site360-layout-grid'));
    expect(await screen.findByTestId('site360-grid')).toBeTruthy();
  });

  it('shows the Arabic labels of the layout toggle in the Arabic locale', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw', locale: 'ar' });
    await screen.findByTestId('site360-grid');
    expect(screen.getByTestId('site360-layout-grid')).toHaveTextContent('شبكة');
    expect(screen.getByTestId('site360-layout-vertical')).toHaveTextContent('عمودي');
  });

  it('keeps the list when no menu is chosen', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    await screen.findByTestId('page-sites');
    expect(screen.queryByTestId('site360-grid')).toBeNull();
    expect(screen.queryByTestId('site360-layout')).toBeNull();
  });

  it('sends the status filter of the grid as `status`, the name the API reads (audit A finding 11)', { timeout: 30_000 }, async () => {
    await signIn('pm');
    const seen: URLSearchParams[] = [];
    const on = ({ request }: { request: Request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/site360/cw/rows')) seen.push(u.searchParams); };
    server.events.on('request:start', on);
    try {
      renderApp(<Sites />, { route: '/sites?section=cw&overall_status=on_hold' });
      await screen.findByTestId('site360-grid');
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
      const { unmount } = renderApp(<Sites />, { route: '/sites?milestone_reached=MS6&ref_date=2026-10-29&cluster_code=CL-TR-01' });
      await screen.findByTestId('page-sites');
      await waitFor(() => expect(seen.length).toBeGreaterThan(0));
      expect(seen[0]!.get('ref_date')).toBe('2026-10-29');
      expect(seen[0]!.get('cluster_code')).toBe('CL-TR-01');
      expect(await screen.findByText('As of 2026-10-29')).toBeTruthy();
      unmount();
      renderApp(<Sites />, { route: '/sites?dashboard_status=on_hold', locale: 'ar' });
      expect(await screen.findByText(/حالة لوحة المؤشرات/)).toBeTruthy();
    } finally {
      server.events.removeListener('request:start', on);
    }
  });
});
