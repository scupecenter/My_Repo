import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { AsBuiltItem, Page, SiteDispatch, StockLevel, StockMovement, WarehouseConfigGaps, WarehouseItem } from './types';

type Row = { id: string; version: number };
type List<T> = { items: T[] };
type Snap = { rollback: () => void };

export const useWhItems = (f: { q: string; include_inactive: boolean }, enabled = true) =>
  useQuery({ queryKey: ['wh-items', f], enabled, queryFn: () => api.get<Page<WarehouseItem>>('/warehouse/items', { query: { ...f, limit: 200 } }) });
export const useStock = (q: string) => useQuery({ queryKey: ['wh-stock', q], queryFn: () => api.get<Page<StockLevel>>('/warehouse/stock', { query: { q, limit: 200 } }) });
export const useMovements = (status: string) =>
  useQuery({ queryKey: ['wh-movements', status], queryFn: () => api.get<Page<StockMovement>>('/warehouse/movements', { query: { status, limit: 200 } }) });
// Migration 0053 (P7): the TE dispatch of the sites (D6) and the owner data still missing (Q107).
export const useDispatchList = (need_status: string) =>
  useQuery({ queryKey: ['wh-dispatch', need_status], queryFn: () => api.get<Page<SiteDispatch>>('/warehouse/dispatch-status', { query: { ...(need_status ? { need_status } : {}), limit: 200 } }) });
export const useSiteDispatch = (siteId: string) =>
  useQuery({ queryKey: ['wh-dispatch-site', siteId], enabled: !!siteId, retry: false, queryFn: () => api.get<SiteDispatch>(`/warehouse/dispatch-status/${siteId}`) });
/** Q270 (contract 0.13.1): takes quarantined stock out again; the document waits for L2 like every warehouse document. */
export type QuarantineExitBody = { exit_kind: 'repaired' | 'written_off' | 'returned_to_supplier'; reason: string; lines: { item_id: string; qty: number; serials?: string[] }[] };
export function useQuarantineExit() {
  const qc = useQueryClient();
  return useMutation<StockMovement, ApiError, QuarantineExitBody>({
    mutationFn: (body) => api.post<StockMovement>('/warehouse/quarantine-exits', { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wh-stock'] }); void qc.invalidateQueries({ queryKey: ['wh-movements'] }); },
  });
}
export const useConfigGaps = () => useQuery({ queryKey: ['wh-gaps'], queryFn: () => api.get<WarehouseConfigGaps>('/warehouse/config-gaps') });
export const useAsBuiltItems = (f: { section: string; include_inactive: boolean }) =>
  useQuery({ queryKey: ['asbuilt-items', f], queryFn: () => api.get<List<AsBuiltItem>>('/as-built/items', { query: f }) });

/** Create (no `item`) or edit/deactivate (`item`) an admin-list row. The edit shows in the list at once and goes back if the server refuses. */
export function useSaveItem<T extends Row>(base: string, key: string) {
  const qc = useQueryClient();
  return useMutation<T, ApiError, { item?: T; body: Record<string, unknown> }, Snap | undefined>({
    mutationFn: ({ item, body }) => (item ? api.patch<T>(`${base}/${item.id}`, { version: item.version, body }) : api.post<T>(base, { body })),
    onMutate: async ({ item, body }) => {
      if (!item) return undefined;
      await qc.cancelQueries({ queryKey: [key] });
      const snaps = qc.getQueriesData<List<T>>({ queryKey: [key] });
      const { reason: _r, ...rest } = body; void _r;
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.map((x) => (x.id === item.id ? { ...x, ...rest } : x)) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => void qc.invalidateQueries({ queryKey: [key] }),
  });
}
