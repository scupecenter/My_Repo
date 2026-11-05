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

// ------------------------------------------------------------------------------------------------- Q225 (contract 0.12.10): a rule-affecting site field is proposed; Q473 (0.14.1): so is the identity
export type SiteChangeProposalResult = S['SiteChangeProposalResult'];
/** Contract 0.14.1 (Q473): the identity of the site, proposed as Change Control drafts (region and cluster for a System Admin only; the Site ID is never changed). */
export type SiteIdentityProposal = S['SiteIdentityProposal'];
export function useProposeSiteChange(siteId: string) {
  const qc = useQueryClient();
  return useMutation<SiteChangeProposalResult, ApiError, { custom?: Record<string, unknown>; identity?: SiteIdentityProposal; reason: string }>({
    mutationFn: (body) => api.post(`/sites/${siteId}/change-proposals`, { body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site', siteId] });
      void qc.invalidateQueries({ queryKey: ['register-records'] });
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

// ------------------------------------------------------------------------------------------------- P6 (contract 0.12.4): severities, evidence, settings
export type SnagSeverity = S['SnagSeverity'];
export type SnagSeverityList = S['SnagSeverityList'];
export type DocumentsQcSettings = S['DocumentsQcSettings'];

export const useSnagSeverities = () =>
  useQuery({ queryKey: ['snag-severities'], staleTime: 300_000, queryFn: () => api.get<SnagSeverityList>('/snag-severities') });

export function useSaveSnagSeverities() {
  const qc = useQueryClient();
  return useMutation<SnagSeverityList, ApiError, { version: number; reason: string; items: { code: string; name_en: string; name_ar?: string | null; blocks: boolean; is_active?: boolean }[] }>({
    mutationFn: ({ version, ...body }) => api.put('/snag-severities', { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['snag-severities'] }),
  });
}

export const useDocumentsQcSettings = () => useQuery({ queryKey: ['documents-qc-settings'], queryFn: () => api.get<DocumentsQcSettings>('/settings/documents-qc') });

export function useSaveDocumentsQcSettings() {
  const qc = useQueryClient();
  return useMutation<DocumentsQcSettings, ApiError, { version: number; reason: string; new_version_inherit?: boolean; exif_tolerance_hours?: number }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/documents-qc', { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['documents-qc-settings'] }),
  });
}

/** Q232: L2 accepts or rejects a fix photo kept as pending evidence. */
export function useDecideEvidence(siteId: string) {
  const refresh = useSnagRefresh(siteId);
  return useMutation<Snag, ApiError, { snag: Snag; photoId: string; decision: 'accept' | 'reject'; note: string }>({
    mutationFn: ({ snag, photoId, decision, note }) => api.post(`/snags/${snag.id}/photos/${photoId}/evidence`, { body: { decision, note } }),
    onSettled: refresh,
  });
}

export type SnagOp = 'submit' | 'approve' | 'reject';
export function useSnagOp(siteId: string) {
  const refresh = useSnagRefresh(siteId);
  return useMutation<Snag, ApiError, { snag: Snag; op: SnagOp; note?: string }>({
    mutationFn: ({ snag, op, note }) => api.post(`/snags/${snag.id}/${op}`, { version: snag.version, body: op === 'reject' ? { note } : {} }),
    onSettled: refresh,
  });
}
