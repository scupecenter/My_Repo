import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { AcquisitionSiteLocation } from '@/components/AcquisitionSiteLocation';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';

/** A1: the selected acquisition candidate's coordinates are offered to the site through a Change Control proposal, never written directly. */
const cand = { selected: 'Yes', latitude: 32.9, longitude: 13.2, address: 'Candidate road' };

describe('Acquisition site location', () => {
  it('proposes the coordinates straight away when the site has none', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/sites/:id`, () => HttpResponse.json({ id: 's1', latitude: null, longitude: null })));
    let body: unknown = null;
    server.use(http.post(`${API_BASE}/sites/:id/change-proposals`, async ({ request }) => { body = await request.json(); return HttpResponse.json({ items: [{ change_id: 'CH-1' }] }); }));
    renderApp(<AcquisitionSiteLocation siteId="s1" data={cand} />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('acq-location-cand')).toHaveTextContent('32.9, 13.2');
    await u.click(screen.getByTestId('acq-location-send'));
    await waitFor(() => expect(body).toMatchObject({ identity: { latitude: 32.9, longitude: 13.2, address: 'Candidate road' } }));
  }, 30_000);

  it('asks before proposing different coordinates, and hides when they match', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/sites/:id`, () => HttpResponse.json({ id: 's1', latitude: 30, longitude: 10 })));
    let n = 0;
    server.use(http.post(`${API_BASE}/sites/:id/change-proposals`, () => { n += 1; return HttpResponse.json({ items: [{ change_id: 'CH-2' }] }); }));
    renderApp(<AcquisitionSiteLocation siteId="s1" data={cand} />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('acq-location-site')).toHaveTextContent('30, 10');
    expect(screen.queryByTestId('acq-location-send')).toBeNull();
    await u.click(screen.getByTestId('acq-location-ask'));
    expect(screen.getByTestId('acq-location-confirm')).toBeInTheDocument();
    await u.click(screen.getByTestId('acq-location-send'));
    await waitFor(() => expect(n).toBe(1));
  }, 30_000);

  it('proposes only the address when the coordinates match, and only what differs', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/sites/:id`, () => HttpResponse.json({ id: 's1', latitude: 32.9, longitude: 13.2, address: null })));
    let body: { identity?: Record<string, unknown> } | null = null;
    server.use(http.post(`${API_BASE}/sites/:id/change-proposals`, async ({ request }) => { body = (await request.json()) as typeof body; return HttpResponse.json({ items: [{ change_id: 'CH-3' }] }); }));
    renderApp(<AcquisitionSiteLocation siteId="s1" data={cand} />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('acq-location-send'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.identity).toEqual({ address: 'Candidate road' });
  }, 30_000);
});
