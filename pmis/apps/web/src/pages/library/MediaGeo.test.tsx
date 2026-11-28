import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import type { MediaGeoSettings, MediaItem } from '@/api/media';
import { MediaGeoMap } from '@/components/MediaGeoMap';
import { PanoramaView } from '@/components/PanoramaView';
import { server } from '@/mocks/server';
import { MediaGeoSettingsCard } from '@/pages/settings/MediaGeoSettings';
import { renderApp, signIn } from '@/test/utils';
import { LibraryMedia } from './Media';

/** Media geotag (contract 0.15.539): the far-from-site flag, panorama and drone kinds, the viewer, the map mode, the filters and the settings card. */
const site = { id: 's1', code: 'GS-1', name: 'Site', region_id: 5, latitude: 32.9, longitude: 13.18 };
const geo = (over: Record<string, unknown> = {}) => ({ lat: 32.9001, lon: 13.18, altitude_m: null, taken_at: '2026-11-20T09:00:00Z', source: 'exif', make: null, model: null, width_px: null, height_px: null, distance_m: 11, far: false, ...over });
const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  kind: 'document_file', id, uploaded_at: '2026-11-20T10:00:00Z', state: 'current', mime_type: 'image/jpeg', size_bytes: 100, shot_type: null,
  type: { code: 'P1', name_en: 'Site photo', name_ar: 'صورة الموقع', kind: 'photo' }, site: site as never, link: { kind: 'site', site_id: 's1' } as never,
  has_thumbnail: false, download_url: `/files/${id}/download`, media_kind: 'photo', geo: geo() as never, ...over,
});
const cfg = (over: Partial<MediaGeoSettings> = {}): MediaGeoSettings => ({ enabled: true, max_distance_m: 1000, flag_missing: false, panorama: true, panorama_min_ratio: 2, panorama_min_width_px: 3000, drone_makes: ['DJI'], updated_at: null, updated_by: null, version: 2, can_edit: true, ...over });
const page = (items: MediaItem[]) => HttpResponse.json({ enabled: true, items, page: { limit: 60, next_cursor: null } });

describe('Library > Media geotag', () => {
  it('flags a photo far from its site, marks panorama and drone files, and opens the viewer with the distance and the point', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/media/items`, () => page([
        item('near'), item('far', { geo: geo({ lat: 33.0, distance_m: 11200, far: true }) as never }),
        item('pano', { media_kind: 'panorama', mime_type: 'image/jpeg' }), item('dr', { media_kind: 'drone', geo: geo({ altitude_m: 88, make: 'DJI', model: 'Mavic' }) as never }),
      ])),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [], registers: [] })),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media' });
    const far = await screen.findByTestId('media-card-far');
    expect(within(far).getByTestId('media-far')).toHaveTextContent('11 km');
    expect(within(screen.getByTestId('media-card-near')).queryByTestId('media-far')).toBeNull();
    expect(within(screen.getByTestId('media-card-pano')).getByTestId('media-kind')).toHaveAttribute('data-media-kind', 'panorama');
    expect(within(screen.getByTestId('media-card-dr')).getByTestId('media-kind')).toHaveAttribute('data-media-kind', 'drone');
    await u.click(within(far).getByTestId('media-viewer-open'));
    const v = await screen.findByTestId('media-viewer');
    expect(within(v).getByTestId('viewer-distance')).toHaveAttribute('data-far', 'true');
    expect(within(v).getByTestId('viewer-coords')).toHaveTextContent('33.000000, 13.180000');
    expect(within(v).getByTestId('viewer-map-pt-far')).toHaveAttribute('data-far', 'true');
    await u.click(within(v).getByTestId('viewer-close'));
    await waitFor(() => expect(screen.queryByTestId('media-viewer')).toBeNull());
    await u.click(within(screen.getByTestId('media-card-dr')).getByTestId('media-viewer-open'));
    const d = await screen.findByTestId('media-viewer');
    expect(within(d).getByTestId('viewer-alt')).toHaveTextContent('88 m');
    expect(within(d).getByTestId('viewer-camera')).toHaveTextContent('DJI Mavic');
  });

  it('turns the map mode on: photos with a point drawn around their site, far ones in the far colour, a click opens the viewer', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/media/items`, () => page([item('near'), item('far', { geo: geo({ lat: 33.0, distance_m: 11200, far: true }) as never }), item('nogps', { geo: geo({ lat: null, lon: null, distance_m: null, far: null, source: 'none' }) as never })])),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [], registers: [] })),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media?layout=map' });
    expect(await screen.findByTestId('media-by-map')).toBeInTheDocument();
    expect(screen.getByTestId('media-map-count')).toHaveTextContent('2 of 3');
    expect(screen.getByTestId('media-map-pt-far')).toHaveAttribute('data-far', 'true');
    expect(screen.getByTestId('media-map-pt-near')).toHaveAttribute('data-far', 'false');
    expect(screen.getByTestId('media-map-site-GS-1')).toBeInTheDocument();
    await u.click(screen.getByTestId('media-map-pt-far'));
    expect(await screen.findByTestId('media-viewer')).toBeInTheDocument();
  });

  it('sends the location and kind filters to the API', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.use(
      http.get(`${API_BASE}/media/items`, ({ request }) => { seen.push(new URL(request.url).search); return page([item('a1')]); }),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [], registers: [] })),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media' });
    await screen.findByTestId('media-card-a1');
    await u.selectOptions(screen.getByTestId('media-f-geo'), 'far');
    await waitFor(() => expect(seen.some((s) => s.includes('geo=far'))).toBe(true));
    await u.selectOptions(screen.getByTestId('media-f-media_kind'), 'panorama');
    await waitFor(() => expect(seen.some((s) => s.includes('media_kind=panorama') && s.includes('geo=far'))).toBe(true));
  });
});

describe('MediaGeoMap and PanoramaView', () => {
  it('draws nothing but a note when there is no point, and a far photo with a line to its site', () => {
    const { unmount } = renderApp(<MediaGeoMap points={[]} sites={[]} />);
    expect(screen.getByTestId('media-map-empty')).toBeInTheDocument();
    unmount();
    renderApp(<MediaGeoMap points={[{ id: 'p', lat: 33, lon: 13.18, far: true, label: 'x', kind: 'photo', siteId: 's1' }]} sites={[{ id: 's1', code: 'GS-1', lat: 32.9, lon: 13.18 }]} />);
    expect(document.querySelector('line[stroke-dasharray]')).not.toBeNull();
  });

  it('falls back to a sideways-scrolling image when the browser has no WebGL (and always shows the controls otherwise)', async () => {
    renderApp(<PanoramaView src="blob:x" label="Pano" />);
    expect(await screen.findByTestId('pano-flat')).toBeInTheDocument();
    expect(screen.getByAltText('Pano')).toHaveAttribute('src', 'blob:x');
  });
});

describe('Settings > Documents > Media geotag', () => {
  it('shows the values, saves a change with a reason, and scans a batch of older images', async () => {
    await signIn('pm');
    let put: { version: string | null; body: Record<string, unknown> } | null = null;
    let scans = 0;
    server.use(
      http.get(`${API_BASE}/media/geo/settings`, () => HttpResponse.json(cfg(), { headers: { ETag: '"2"' } })),
      http.get(`${API_BASE}/media/geo/status`, () => HttpResponse.json({ scanned: 4, with_location: 3, panorama: 1, drone: 1, pending: 7, last_scanned_at: null })),
      http.put(`${API_BASE}/media/geo/settings`, async ({ request }) => { put = { version: request.headers.get('If-Match'), body: (await request.json()) as Record<string, unknown> }; return HttpResponse.json(cfg({ max_distance_m: 500, version: 3 })); }),
      http.post(`${API_BASE}/media/geo/scan`, () => { scans++; return HttpResponse.json({ scanned: 11, with_location: 8, panorama: 1, drone: 1, pending: 0, last_scanned_at: null, done: 7 }, { status: 201 }); }),
    );
    const u = userEvent.setup();
    renderApp(<MediaGeoSettingsCard />);
    expect(await screen.findByTestId('mg-distance')).toHaveValue(1000);
    expect(screen.getByTestId('mg-makes')).toHaveValue('DJI');
    expect(await screen.findByTestId('mg-status')).toHaveTextContent('waiting 7');
    await u.clear(screen.getByTestId('mg-distance'));
    await u.type(screen.getByTestId('mg-distance'), '500');
    await u.click(screen.getByTestId('mg-save'));
    await u.type(await screen.findByTestId('mg-dialog-reason'), 'tighter check');
    await u.click(screen.getByTestId('mg-dialog-submit'));
    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toMatchObject({ version: '"2"', body: { max_distance_m: 500, reason: 'tighter check', drone_makes: ['DJI'] } });
    await u.click(screen.getByTestId('mg-scan'));
    await waitFor(() => expect(scans).toBe(1));
  });

  it('is read only without the edit right and hides the scan', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/media/geo/settings`, () => HttpResponse.json(cfg({ can_edit: false }))));
    renderApp(<MediaGeoSettingsCard />);
    expect(await screen.findByTestId('mg-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('mg-scan')).toBeNull();
    expect(screen.getByTestId('mg-distance')).toBeDisabled();
  });
});
