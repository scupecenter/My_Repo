import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';
import type { RegisterRecord } from './types';

/**
 * Work package P4c (contract 0.12.11, migration 0063): the HLC purchase requests of an HLC record (Q150), the Dismantle order picker (Q114), the one-time
 * migration of the legacy HLC requests (Q139) and the GECOL order warnings (Q151).
 */
type S = components['schemas'];
export type HlcPurchaseRequests = S['HlcPurchaseRequests'];
export type HlcLegacyMigration = S['HlcLegacyMigration'];
export type DismantleOrderOption = S['DismantleOrderOption'];
export type GecolOrderWarnings = S['GecolOrderWarnings'];
export type GecolOrderWarningsInput = S['GecolOrderWarningsInput'];

/** PUT /registers/hlc/records/{id}/purchase-requests (If-Match = record version). */
export function useSetHlcPurchaseRequests() {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; ids: string[] }>({
    mutationFn: ({ record, ids }) => api.put(`/registers/hlc/records/${record.id}/purchase-requests`, { version: record.version, body: { procurement_entity_ids: ids } }),
    onSuccess: (r) => qc.setQueryData(['register-record', 'hlc', r.id], r),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['register-records', 'hlc'] }),
  });
}

/** GET /registers/dismantle/order-options: the approved, active orders of the site for the part. */
export const useDismantleOrders = (siteId: string | null | undefined, part: string | null | undefined) =>
  useQuery({
    queryKey: ['dismantle-orders', siteId, part], enabled: !!siteId && (part === 'cw' || part === 'te'),
    queryFn: () => api.get<{ items: DismantleOrderOption[] }>('/registers/dismantle/order-options', { query: { site_id: siteId!, record_type: part! } }).then((r) => r.items),
  });

/** POST /registers/hlc/legacy-migration: the preview (dry_run) or the run (reason; the server asks for a step-up). */
export function useHlcLegacyMigration() {
  const qc = useQueryClient();
  return useMutation<HlcLegacyMigration, ApiError, { dry_run: boolean; reason?: string }>({
    mutationFn: (body) => api.post('/registers/hlc/legacy-migration', { body }),
    onSettled: (_d, _e, v) => { if (!v.dry_run) void qc.invalidateQueries({ queryKey: ['register-records', 'procurement'] }); },
  });
}

export const useGecolOrderWarnings = () => useQuery({ queryKey: ['gecolOrderWarnings'], queryFn: () => api.get<GecolOrderWarnings>('/settings/gecol-order-warnings') });
export function useSetGecolOrderWarnings() {
  const qc = useQueryClient();
  return useMutation<GecolOrderWarnings, ApiError, { version: number; body: GecolOrderWarningsInput & { reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/settings/gecol-order-warnings', { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['gecolOrderWarnings'] }),
  });
}
