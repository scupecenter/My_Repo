import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

/** Migration 0565: locks of the Warehouse (item, movement) and the Daily Plan (plan, row), on the model of the register locks (0103). */
export type EntityLockKind = 'wh_item' | 'wh_movement' | 'daily_plan' | 'daily_plan_row';
export type EntityColumnKind = 'wh_item' | 'wh_movement' | 'daily_plan_row';
export type EntityLock = { id: string; kind: EntityLockKind; target_id: string; reason: string; locked_at: string; locked_by: string | null; label: string | null };
export type EntityColumnLock = { id: string; kind: EntityColumnKind; field: string; reason: string; locked_at: string; locked_by: string | null };

export function useEntityLocks(kind: EntityLockKind, enabled = true) {
  return useQuery({
    queryKey: ['entity-locks', kind], enabled,
    queryFn: () => api.get<{ records: EntityLock[]; columns: EntityColumnLock[] }>('/entity-locks', { query: { kind } }),
  });
}

export function useSetEntityLock(kind: EntityLockKind) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { id: string; locked: boolean; reason: string }>({
    mutationFn: ({ id, locked, reason }) => (locked
      ? api.post(`/entity-locks/${kind}/${id}`, { body: { reason } })
      : api.del(`/entity-locks/${kind}/${id}`, { body: { reason } })),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['entity-locks'] }); },
  });
}

export function useSetEntityColumnLock(kind: EntityColumnKind) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { field: string; locked: boolean; reason: string }>({
    mutationFn: ({ field, locked, reason }) => (locked
      ? api.post(`/entity-locks/columns/${kind}/${field}`, { body: { reason } })
      : api.del(`/entity-locks/columns/${kind}/${field}`, { body: { reason } })),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['entity-locks'] }); },
  });
}
