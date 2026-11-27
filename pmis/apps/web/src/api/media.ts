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
export type MediaFilter = { q: string; source: '' | 'documents' | 'snags'; status: '' | 'withdrawn' | 'pending_evidence'; doc_code: string; snag_type: string; uploaded_from: string; uploaded_to: string };
export const EMPTY_MEDIA_FILTER: MediaFilter = { q: '', source: '', status: '', doc_code: '', snag_type: '', uploaded_from: '', uploaded_to: '' };

export const useMediaSettings = () => useQuery({ queryKey: ['media-settings'], queryFn: () => api.get<MediaSettings>('/media/settings') });
export const useSetMediaSettings = () => {
  const qc = useQueryClient();
  return useMutation<MediaSettings, ApiError, { version: number } & MediaSettingsInput>({
    mutationFn: ({ version, ...body }) => api.put('/media/settings', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['media-settings'] }); void qc.invalidateQueries({ queryKey: ['media-items'] }); void qc.invalidateQueries({ queryKey: ['media-facets'] }); },
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

/** The thumbnail through the session cookie, as an object URL; null when the item has none or it cannot be made (the card then shows a type icon). */
export const useMediaThumb = (it: MediaItem, size: 'small' | 'medium') =>
  useQuery({
    queryKey: ['media-thumb', it.kind, it.id, size], enabled: it.has_thumbnail, staleTime: 5 * 60_000, retry: false,
    queryFn: async () => { try { return URL.createObjectURL(await fetchBlob(`/media/items/${it.kind}/${it.id}/thumbnail`, { size })); } catch { return null; } },
  });

/** Where the owning record is shown. */
export function mediaLinkTo(l: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof l[k] === 'string' ? (l[k] as string) : null);
  if (l.kind === 'register' && s('register_key')) return `/registers/${s('register_key')}`;
  return s('site_id') ? `/sites/${s('site_id')}` : null;
}
