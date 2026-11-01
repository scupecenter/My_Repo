import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { AsBuiltItem, Page, StockLevel, StockMovement, WarehouseItem } from './types';

type Row = { id: string; version: number };
type List<T> = { items: T[] };
type Snap = { rollback: () => void };

export const useWhItems = (f: { q: string; include_inactive: boolean }, enabled = true) =>
  useQuery({ queryKey: ['wh-items', f], enabled, queryFn: () => api.get<Page<WarehouseItem>>('/warehouse/items', { query: { ...f, limit: 200 } }) });
export const useStock = (q: string) => useQuery({ queryKey: ['wh-stock', q], queryFn: () => api.get<Page<StockLevel>>('/warehouse/stock', { query: { q, limit: 200 } }) });
export const useMovements = (status: string) =>
  useQuery({ queryKey: ['wh-movements', status], queryFn: () => api.get<Page<StockMovement>>('/warehouse/movements', { query: { status, limit: 200 } }) });
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
