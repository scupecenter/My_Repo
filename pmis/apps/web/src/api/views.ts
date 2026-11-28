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

// ---------------------------------------------------------------------------------------------------------------- default view per screen (0.15.582)
export type DefaultView = { screen_key: string; view_id: string; name: string };
const DEF_KEY = ['default-views'] as const;
/** The caller's default saved view of each screen (one per screen). */
export const useDefaultViews = () =>
  useQuery({ queryKey: DEF_KEY, staleTime: 60_000, queryFn: async () => (await api.get<{ items: DefaultView[] }>('/me/default-views')).items });

export function useDefaultViewOps() {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: DEF_KEY });
  return {
    set: useMutation<{ view_id: string; screen_key: string; is_default: boolean }, ApiError, string>({ mutationFn: (id) => api.post(`/saved-views/${id}/set-default`, { body: {} }), onSuccess: settle }),
    clear: useMutation<{ view_id: string; screen_key: string | null; is_default: boolean }, ApiError, string>({ mutationFn: (id) => api.post(`/saved-views/${id}/clear-default`, { body: {} }), onSuccess: settle }),
  };
}

// ---------------------------------------------------------------------------------------------------------------- home pins (0.15.245, item 16)
export type HomeViewPin = S['HomeViewPin'];

const PIN_KEY = ['home-pins'] as const;
/** The caller's pinned home views (id, name, screen), in the pin order. */
export const useHomePins = () =>
  useQuery({ queryKey: PIN_KEY, staleTime: 60_000, queryFn: async () => (await api.get<{ items: HomeViewPin[] }>('/me/home-pins')).items });

export function useHomePinOps() {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: PIN_KEY });
  return {
    pin: useMutation<{ view_id: string; pinned_home: boolean }, ApiError, string>({ mutationFn: (id) => api.post(`/saved-views/${id}/pin`, { body: {} }), onSuccess: settle }),
    unpin: useMutation<{ view_id: string; pinned_home: boolean }, ApiError, string>({ mutationFn: (id) => api.post(`/saved-views/${id}/unpin`, { body: {} }), onSuccess: settle }),
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

// ---------------------------------------------------------------------------------------------------------------- filter builder (F3, 0.15.31)
export type FilterTree = S['FilterTree'];
export type FilterSubGroup = S['FilterSubGroup'];
export type FilterCondition = S['FilterCondition'];
export type FilterValue = S['FilterValue'];
export type FilterOperator = S['FilterOperator'];
export type FilterField = S['FilterField'];
export type FilterFieldList = S['FilterFieldList'];

/** The screens whose lists accept the `filter` parameter (the others keep their simple filters). */
export const hasFilterBuilder = (screen: string) =>
  screen === 'sites' || screen === 'sites-stream' || screen === 'site-tasks' || screen === 'tasks-board' || screen === 'dashboard' || /^register-[a-z0-9_]{2,60}$/.test(screen) || /^site360-[a-z0-9_]{2,40}$/.test(screen);

/** 0.15.45: a field also carries its `group` (key and two labels) and `truncated` (the option list was cut; the search narrows it). */
export type UnifiedField = FilterField;

/** The whitelist of the screen for the caller (the server leaves hidden fields out). */
export const useFilterFields = (screen: string, enabled = true) =>
  useQuery({ queryKey: ['filter-fields', screen], enabled: enabled && hasFilterBuilder(screen), staleTime: 300_000,
    queryFn: () => api.get<FilterFieldList>('/saved-views/filter-fields', { query: { screen_key: screen } }) });

export type FilterFieldValues = S['FilterFieldValues'];

/** 0.15.49: the values of a truncated enum field that match `q`, searched on the server (the caller debounces `q`). */
export const useFilterFieldValues = (screen: string, field: string, q: string, enabled = true) =>
  useQuery({ queryKey: ['filter-field-values', screen, field, q], enabled: enabled && !!screen && !!field && q.trim() !== '', staleTime: 60_000, placeholderData: (prev) => prev,
    queryFn: () => api.get<FilterFieldValues>(`/saved-views/filter-fields/${encodeURIComponent(field)}/values`, { query: { screen_key: screen, q: q.trim(), limit: 50 } }) });

/** A tree for the URL and the `filter` parameter; an empty tree is no filter. */
export const encodeFilter = (t: FilterTree | null | undefined): string => (t && t.items.length ? JSON.stringify(t) : '');
export function decodeFilter(s: string | null | undefined): FilterTree | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as FilterTree;
    return v && (v.op === 'and' || v.op === 'or') && Array.isArray(v.items) ? v : null;
  } catch {
    return null;
  }
}
