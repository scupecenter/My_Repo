import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

/** Contract 0.15.342 (migration 0413): reorder limits and supplier returns (RMA) of the Warehouse. */
export type ReorderLimit = { item_id: string; item_code: string; item_name: string; uom: string | null; reorder_level: number; reorder_qty: number | null; available: number; below_reorder: boolean; version: number };
export type Rma = { id: string; rma_no: string; item_id: string; item_code: string; item_name: string; qty: number; supplier: string; status: 'sent' | 'replaced' | 'credited' | 'rejected' | 'closed'; reason: string; movement_id: string | null; sent_on: string; resolved_on: string | null; resolution_note: string | null; version: number; created_at: string };

export const useReorderLimits = (enabled = true) => useQuery({ queryKey: ['wh-reorder'], enabled, queryFn: () => api.get<{ items: ReorderLimit[] }>('/warehouse/reorder-limits') });
export function useSaveReorderLimit() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { item_id: string; version?: number; reorder_level: number | null; reorder_qty: number | null; reason: string }>({
    mutationFn: ({ item_id, version, reorder_level, reorder_qty, reason }) => api.put(`/warehouse/reorder-limits/${item_id}`, { body: { reorder_level, reorder_qty, reason }, ...(version ? { version } : {}) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wh-reorder'] }); },
  });
}
export const useRmaList = (status: string) => useQuery({ queryKey: ['wh-rma', status], queryFn: () => api.get<{ items: Rma[] }>('/warehouse/rma', { query: status ? { status } : {} }) });
export function useCreateRma() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { item_id: string; qty: number; supplier: string; reason: string }>({
    mutationFn: (body) => api.post('/warehouse/rma', { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wh-rma'] }); },
  });
}
export function useSetRmaStatus() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { id: string; version: number; status: 'replaced' | 'credited' | 'rejected' | 'closed'; note: string }>({
    mutationFn: ({ id, version, status, note }) => api.post(`/warehouse/rma/${id}/status`, { body: { status, ...(note ? { note } : {}) }, version }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wh-rma'] }); },
  });
}
