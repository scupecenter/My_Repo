import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import type { MediaItem, MediaSettings } from '@/api/media';
import { server } from '@/mocks/server';
import { SettingsRoutes } from '@/pages/settings/Settings';
import { renderApp, signIn } from '@/test/utils';
import { LibraryMedia } from './Media';

/** Library > Media and Settings > Documents > Media (owner decisions GAL-1 and LIB-1). */
const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  kind: 'snag_photo', id, uploaded_at: '2026-11-20T10:00:00Z', state: 'current', mime_type: 'image/png', size_bytes: 100, shot_type: null,
  type: { code: 'S1', name_en: 'Cable snag', name_ar: 'ملاحظة كابل', kind: 'photo' }, site: { id: 's1', code: 'GS-1' } as never, link: { kind: 'snag', snag_id: 'x', site_id: 's1' } as never,
  has_thumbnail: false, download_url: `/files/${id}/download`, ...over,
});
const settings = (): MediaSettings => ({
  enabled: true, snag_photos: true, document_kinds: ['photo'], register_keys: [], include_site_documents: true, exclude_doc_codes: [], image_only: true, show_withdrawn: false, page_size: 60, export_max_mb: 500, notify_new_photo: true, notify_min_photos: true, notify_export_ready: true, min_photos_after_hours: 24, min_photos_repeat_days: 7,
  thumbnails: { enabled: true, small_px: 320, medium_px: 960, quality: 78, format: 'webp', max_source_mb: 25 }, version: 3, can_edit: true, thumbnails_available: true,
});

describe('Library > Media', () => {
  it('shows a card per item with a link to its record, and sends a filter to the API', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.use(
      http.get(`${API_BASE}/media/items`, ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ enabled: true, items: [item('a1'), item('a2', { state: 'withdrawn' })], page: { limit: 60, next_cursor: null } }); }),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [{ code: 'S1', name_en: 'Cable snag' }], registers: [] })),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media' });
    expect(await screen.findByTestId('media-card-a1')).toHaveAttribute('data-kind', 'snag_photo');
    expect(screen.getByTestId('media-card-a2')).toHaveAttribute('data-state', 'withdrawn');
    expect(screen.getAllByTestId('media-open')[0]).toHaveAttribute('href', '/sites/s1');
    await u.selectOptions(screen.getByTestId('media-f-source'), 'snags');
    await waitFor(() => expect(seen.some((s) => s.includes('source=snags'))).toBe(true));
  });

  it('switches the view mode from the Layout panel: list, by site and by date', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/media/items`, () => HttpResponse.json({ enabled: true, items: [item('a1'), item('a2', { site: { id: 's2', code: 'GS-2' } as never, uploaded_at: '2026-11-21T10:00:00Z' }), item('a3', { site: null })], page: { limit: 60, next_cursor: null } })),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [], registers: [] })),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media' });
    expect(await screen.findByTestId('media-grid')).toBeInTheDocument();
    await u.click(screen.getByTestId('media-view'));
    await u.click(await screen.findByTestId('media-layout-list'));
    expect(await screen.findByTestId('media-row-a1')).toBeInTheDocument();
    await u.click(screen.getByTestId('media-view'));
    await u.click(await screen.findByTestId('media-layout-site'));
    expect(await screen.findByTestId('media-group-GS-1')).toBeInTheDocument();
    expect(screen.getByTestId('media-group-GS-2')).toBeInTheDocument();
    expect(screen.getByTestId('media-group-none')).toBeInTheDocument();
    await u.click(screen.getByTestId('media-view'));
    await u.click(await screen.findByTestId('media-layout-date'));
    expect(await screen.findByTestId('media-group-2026-11-21')).toBeInTheDocument();
    expect(screen.getByTestId('media-group-2026-11-20')).toBeInTheDocument();
  });

  it('exports the chosen photos: a job is started with the picked items and the zip is downloaded when it is done', async () => {
    await signIn('pm');
    let sent: { items?: { kind: string; id: string }[] } = {};
    server.use(
      http.get(`${API_BASE}/media/items`, () => HttpResponse.json({ enabled: true, items: [item('a1'), item('a2')], page: { limit: 60, next_cursor: null } })),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [], registers: [] })),
      http.post(`${API_BASE}/media/exports`, async ({ request }) => { sent = (await request.json()) as typeof sent; return HttpResponse.json({ id: 'j1', kind: 'media_export', status: 'queued', progress: 0, created_at: '2026-11-28T00:00:00Z', finished_at: null }, { status: 202 }); }),
      http.get(`${API_BASE}/media/exports/j1`, () => HttpResponse.json({ id: 'j1', kind: 'media_export', status: 'running', progress: 0.5, created_at: '2026-11-28T00:00:00Z', finished_at: null })),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media' });
    expect(await screen.findByTestId('media-card-a1')).toBeInTheDocument();
    expect(screen.getByTestId('media-export')).toBeDisabled();
    await u.click(screen.getByTestId('media-pick-a2'));
    expect(screen.getByTestId('media-export')).toBeEnabled();
    await u.click(screen.getByTestId('media-export'));
    await waitFor(() => expect(sent.items).toEqual([{ kind: 'snag_photo', id: 'a2' }]));
    await waitFor(() => expect(screen.getByTestId('media-export')).toBeDisabled());   // preparing: one export at a time
  });

  it('says so when the gallery is switched off', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/media/items`, () => HttpResponse.json({ enabled: false, items: [], page: { limit: 60, next_cursor: null } })),
      http.get(`${API_BASE}/media/facets`, () => HttpResponse.json({ document_types: [], snag_types: [], registers: [] })),
    );
    renderApp(<Routes><Route path="/library/media" element={<LibraryMedia />} /></Routes>, { route: '/library/media' });
    expect(await screen.findByTestId('media-off')).toBeInTheDocument();
  });
});

describe('Settings > Documents > Media', () => {
  it('sits under Documents, links to the document types and saves with a reason', async () => {
    await signIn('pm');
    let put: { version?: string | null; body?: Record<string, unknown> } = {};
    server.use(
      http.get(`${API_BASE}/media/settings`, () => HttpResponse.json(settings())),
      http.put(`${API_BASE}/media/settings`, async ({ request }) => { put = { version: request.headers.get('If-Match'), body: (await request.json()) as Record<string, unknown> }; return HttpResponse.json({ ...settings(), version: 4 }); }),
    );
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/documents/media' });
    await screen.findByTestId('page-media-settings');
    expect(screen.getByTestId('settings-section-documents-media')).toBeInTheDocument();
    expect(screen.getByTestId('ms-types-link')).toHaveAttribute('href', '/admin/settings/documents/types');
    await u.click(screen.getByTestId('ms-image-only'));
    await u.click(screen.getByTestId('ms-kind-scanned_document'));
    await u.click(screen.getByTestId('ms-save'));
    await u.type(await screen.findByTestId('ms-dialog-reason'), 'Owner request 2026-11-27');
    await u.click(screen.getByTestId('ms-dialog-submit'));
    await waitFor(() => expect(put.body).toBeDefined());
    expect(put.body).toMatchObject({ image_only: false, document_kinds: ['photo', 'scanned_document'], reason: 'Owner request 2026-11-27' });
  });
});
