import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';
import type { SiteDetail } from './types';

type S = components['schemas'];
export type Snag = S['Snag'];
export type SnagPhoto = S['SnagPhoto'];
export type SnagType = S['SnagType'];
export type SnagInput = S['SnagInput'];
export type SiteCustomField = S['SiteCustomField'];

// ------------------------------------------------------------------------------------------------- Q130: the site's custom fields (near_airport)
export function useUpdateSite(siteId: string) {
  const qc = useQueryClient();
  return useMutation<SiteDetail, ApiError, { version: number; custom: Record<string, unknown>; reason?: string }>({
    mutationFn: ({ version, custom, reason }) => api.patch(`/sites/${siteId}`, { version, body: { custom, ...(reason ? { reason } : {}) } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site', siteId] });
      // conditional documents that read a site field (A3 civil aviation permit) follow on the next read of the slots
      void qc.invalidateQueries({ queryKey: ['task'] });
      void qc.invalidateQueries({ queryKey: ['task-slots'] });
      void qc.invalidateQueries({ queryKey: ['site-tasks', siteId] });
    },
  });
}

// ------------------------------------------------------------------------------------------------- Q132: QC snags and the photos of the fix
export const useSnagTypes = () => useQuery({ queryKey: ['snag-types'], staleTime: 300_000, queryFn: () => api.get<{ items: SnagType[] }>('/snag-types').then((r) => r.items) });
export const useSiteSnags = (siteId: string) =>
  useQuery({ queryKey: ['site-snags', siteId], queryFn: () => api.get<{ items: Snag[]; open_count?: number }>(`/sites/${siteId}/snags`, { query: { limit: 200 } }) });

function useSnagRefresh(siteId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['site-snags', siteId] });
    void qc.invalidateQueries({ queryKey: ['site', siteId] });
    // an open snag of a stream blocks its PAC / FAC: the lock reasons of the tasks change with it
    void qc.invalidateQueries({ queryKey: ['site-tasks', siteId] });
    void qc.invalidateQueries({ queryKey: ['task'] });
  };
}

export function useRaiseSnag(siteId: string) {
  const refresh = useSnagRefresh(siteId);
  return useMutation<Snag, ApiError, SnagInput>({ mutationFn: (body) => api.post(`/sites/${siteId}/snags`, { body }), onSettled: refresh });
}

export function useSnagPhoto(siteId: string) {
  const refresh = useSnagRefresh(siteId);
  return useMutation<SnagPhoto, ApiError, { snag: Snag; file: File; shot_type?: string | null }>({
    mutationFn: ({ snag, file, shot_type }) => {
      const f = new FormData();
      f.append('file', file);
      if (shot_type) f.append('shot_type', shot_type);
      return api.post(`/snags/${snag.id}/photos`, { body: f });
    },
    onSettled: refresh,
  });
}

export function useWithdrawSnagPhoto(siteId: string) {
  const refresh = useSnagRefresh(siteId);
  return useMutation<Snag, ApiError, { snag: Snag; photoId: string }>({ mutationFn: ({ snag, photoId }) => api.del(`/snags/${snag.id}/photos/${photoId}`), onSettled: refresh });
}

export type SnagOp = 'submit' | 'approve' | 'reject';
export function useSnagOp(siteId: string) {
  const refresh = useSnagRefresh(siteId);
  return useMutation<Snag, ApiError, { snag: Snag; op: SnagOp; note?: string }>({
    mutationFn: ({ snag, op, note }) => api.post(`/snags/${snag.id}/${op}`, { version: snag.version, body: op === 'reject' ? { note } : {} }),
    onSettled: refresh,
  });
}
