import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];

/** Contract 0.15.76 (P6): the extra columns of the item master, kept in `field_definitions` of the warehouse item (the engine that already exists). */
export type ItemColumn = S['WarehouseItemColumn'];
export type ItemColumnCreate = S['WarehouseItemColumnCreate'];
export type ItemColumnPatch = S['WarehouseItemColumnPatch'];

/** The active columns draw the item form and table (whoever reads the items); `all` adds the hidden ones (the column admin). */
export const useItemColumns = (all = false) =>
  useQuery({ queryKey: ['wh-item-columns', all], retry: false, queryFn: () => api.get<{ items: ItemColumn[] }>('/warehouse/item-columns', { query: all ? { include_inactive: true } : {} }).then((r) => r.items) });

/** After any write (a refused one too) the columns are read again, so the next attempt carries the current version. */
export function useSaveItemColumn() {
  const qc = useQueryClient();
  return useMutation<ItemColumn, ApiError, { col?: ItemColumn; body: ItemColumnCreate | ItemColumnPatch }>({
    mutationFn: ({ col, body }) => (col ? api.patch<ItemColumn>(`/warehouse/item-columns/${col.code}`, { version: col.version, body }) : api.post<ItemColumn>('/warehouse/item-columns', { body })),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['wh-item-columns'] }); void qc.invalidateQueries({ queryKey: ['wh-items'] }); },
  });
}
