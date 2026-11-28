import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, fetchBlob } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type MediaSettings = S['MediaSettings'];
export type MediaSettingsInput = S['MediaSettingsInput'];
export type MediaItem = S['MediaItem'];
export type MediaFacets = {
  document_types: { code: string; name_en: string; name_ar?: string | null; count: number }[];
  snag_types: { code: string; name_en: string; name_ar?: string | null }[];
  registers: string[];
};
/** The filters of the Media tab; each one is a query parameter of GET /media/items (contract 0.15.292). */
export type MediaFilter = { q: string; source: '' | 'documents' | 'snags'; status: '' | 'withdrawn' | 'pending_evidence'; doc_code: string; snag_type: string; uploaded_from: string; uploaded_to: string; geo: '' | 'far' | 'near' | 'has' | 'missing' | 'unscanned'; media_kind: '' | 'photo' | 'panorama' | 'drone' };
export const EMPTY_MEDIA_FILTER: MediaFilter = { q: '', source: '', status: '', doc_code: '', snag_type: '', uploaded_from: '', uploaded_to: '', geo: '', media_kind: '' };

export const useMediaSettings = () => useQuery({ queryKey: ['media-settings'], queryFn: () => api.get<MediaSettings>('/media/settings') });
export const useSetMediaSettings = () => {
  const qc = useQueryClient();
  return useMutation<MediaSettings, ApiError, { version: number } & MediaSettingsInput>({
    mutationFn: ({ version, ...body }) => api.put('/media/settings', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['media-settings'] }); void qc.invalidateQueries({ queryKey: ['media-items'] }); void qc.invalidateQueries({ queryKey: ['media-facets'] }); },
  });
};

export type MediaGeoSettings = S['MediaGeoSettings'];
export type MediaGeoSettingsInput = S['MediaGeoSettingsInput'];
export type MediaGeoStatus = S['MediaGeoStatus'];
/** The location block of a gallery item (contract 0.15.539); null until the image is scanned. */
export type MediaGeo = NonNullable<MediaItem['geo']>;
export type MediaSite = { id: string; code?: string | null; name?: string | null; region_id?: number | null; latitude?: number | null; longitude?: number | null };
export const useMediaGeoSettings = () => useQuery({ queryKey: ['media-geo-settings'], queryFn: () => api.get<MediaGeoSettings>('/media/geo/settings') });
export const useSetMediaGeoSettings = () => {
  const qc = useQueryClient();
  return useMutation<MediaGeoSettings, ApiError, { version: number } & MediaGeoSettingsInput>({
    mutationFn: ({ version, ...body }) => api.put('/media/geo/settings', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['media-geo-settings'] }); void qc.invalidateQueries({ queryKey: ['media-items'] }); void qc.invalidateQueries({ queryKey: ['media-geo-status'] }); },
  });
};
export const useMediaGeoStatus = (enabled: boolean) => useQuery({ queryKey: ['media-geo-status'], enabled, queryFn: () => api.get<MediaGeoStatus>('/media/geo/status') });
/** Reads the location of older images, a batch at a time; the screen calls it again while `pending` is above 0. */
export const useScanMediaGeo = () => {
  const qc = useQueryClient();
  return useMutation<MediaGeoStatus & { done: number }, ApiError, void>({
    mutationFn: () => api.post('/media/geo/scan', { body: { limit: 100 } }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['media-geo-status'] }); void qc.invalidateQueries({ queryKey: ['media-items'] }); },
  });
};
export const useMediaFacets = () => useQuery({ queryKey: ['media-facets'], queryFn: () => api.get<MediaFacets>('/media/facets') });

const clean = (f: MediaFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
/** Newest first, a page at a time (keyset cursor). */
export const useMediaItems = (f: MediaFilter) =>
  useInfiniteQuery({
    queryKey: ['media-items', f], initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<{ enabled: boolean; items: MediaItem[]; page: { limit: number; next_cursor: string | null } }>('/media/items', { query: { ...clean(f), ...(pageParam ? { cursor: pageParam } : {}) } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });

/** A page asks for up to a page-size of thumbnails at once; each one holds a database transaction while it is made, so they go through a short queue (2 at a time) and never starve the list request. */
const MAX_THUMBS = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_THUMBS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await run(); } finally { running--; waiting.shift()?.(); }
}

/** The thumbnail through the session cookie, as an object URL; null when the item has none or it cannot be made (the card then shows a type icon). */
export const useMediaThumb = (it: MediaItem, size: 'small' | 'medium') =>
  useQuery({
    queryKey: ['media-thumb', it.kind, it.id, size], enabled: it.has_thumbnail, staleTime: 5 * 60_000, retry: false,
    queryFn: () => slot(async () => { try { return URL.createObjectURL(await fetchBlob(`/media/items/${it.kind}/${it.id}/thumbnail`, { size })); } catch { return null; } }),
  });

/** Where the owning record is shown. */
export function mediaLinkTo(l: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof l[k] === 'string' ? (l[k] as string) : null);
  if (l.kind === 'register' && s('register_key')) return s('record_id') ? `/registers/${s('register_key')}?record=${s('record_id')}` : `/registers/${s('register_key')}`;
  return s('site_id') ? `/sites/${s('site_id')}` : null;
}

/** The original image through the session cookie (the audited download route), as an object URL, for the viewer. */
export const useMediaOriginal = (it: MediaItem, enabled: boolean) =>
  useQuery({ queryKey: ['media-original', it.kind, it.id], enabled, staleTime: 5 * 60_000, retry: false, queryFn: async () => URL.createObjectURL(await fetchBlob(it.download_url)) });
