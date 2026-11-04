import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

/** P10 (contract 0.12.12, owner answers Q115 and Q117): saved views on the server and the caller's drafts. The server decides who sees what. */
type S = components['schemas'];
export type SavedView = S['SavedView'];
export type SavedViewColumns = S['SavedViewColumns'];
export type SavedViewSort = S['SavedViewSort'];
export type SavedViewAudience = S['SavedViewAudience'];
export type SavedViewInput = S['SavedViewInput'];
export type SavedViewPatch = S['SavedViewPatch'];
export type Draft = S['Draft'];
export type SavedViewList = { items: SavedView[]; can_share: 'none' | 'limited' | 'all'; can_manage: boolean };

const KEY = (screen: string) => ['saved-views', screen] as const;

export const useSavedViews = (screen: string) =>
  useQuery({ queryKey: KEY(screen), queryFn: () => api.get<SavedViewList>('/saved-views', { query: { screen_key: screen } }) });

export function useSavedViewOps(screen: string) {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: KEY(screen) });
  return {
    create: useMutation<SavedView, ApiError, Omit<SavedViewInput, 'screen_key'>>({ mutationFn: (b) => api.post('/saved-views', { body: { ...b, screen_key: screen } }), onSuccess: settle }),
    update: useMutation<SavedView, ApiError, { view: SavedView; patch: SavedViewPatch }>({
      mutationFn: ({ view, patch }) => api.patch(`/saved-views/${view.id}`, { body: patch, version: view.version }), onSuccess: settle,
    }),
    deactivate: useMutation<SavedView, ApiError, { view: SavedView; reason?: string }>({
      mutationFn: ({ view, reason }) => api.post(`/saved-views/${view.id}/deactivate`, { body: reason ? { reason } : {}, version: view.version }), onSuccess: settle,
    }),
    transfer: useMutation<SavedView, ApiError, { view: SavedView; owner_id: string; reason: string }>({
      mutationFn: ({ view, owner_id, reason }) => api.post(`/saved-views/${view.id}/transfer`, { body: { owner_id, reason }, version: view.version }), onSuccess: settle,
    }),
  };
}

export type LocalView = { id: string; name: string; filter: unknown };
/** First use of a screen: the views the browser kept locally move to the server (idempotent per local id). */
export const importLocalViews = (screen: string, items: LocalView[]) =>
  api.post<{ imported: number; skipped: number; items: SavedView[] }>('/saved-views/import', {
    body: { screen_key: screen, items: items.slice(0, 50).map((v) => ({ local_id: String(v.id).slice(0, 100), name: String(v.name).slice(0, 120) || 'View', filters: (v.filter && typeof v.filter === 'object' ? v.filter : {}) as Record<string, unknown> })) },
  });

// ---------------------------------------------------------------------------------------------------------------- drafts (Q115)
const dpath = (key: string) => `/me/drafts/${key}`;
export const getDraft = (key: string) => api.get<Draft>(dpath(key)).catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) return null; throw e; });
export const saveDraft = (key: string, payload: Record<string, unknown>, base: number | null) => api.put<Draft>(dpath(key), { body: { payload, base_version: base } });
export const discardDraft = (key: string) => api.del<void>(dpath(key));
