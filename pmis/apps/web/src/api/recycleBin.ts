import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type RecycleBin = S['RecycleBin'];
export type RecycleBinItem = RecycleBin['items'][number];

/** 0.15.98: the recycle bin of voided register records (System Admin only). */
export const useRecycleBin = () => useQuery({ queryKey: ['recycleBin'], queryFn: () => api.get<RecycleBin>('/recycle-bin') });

const refresh = (qc: ReturnType<typeof useQueryClient>) => { void qc.invalidateQueries({ queryKey: ['recycleBin'] }); void qc.invalidateQueries({ queryKey: ['registers'] }); };

export const useRestoreRecord = () => {
  const qc = useQueryClient();
  return useMutation<{ id: string; register_key: string; state: 'entry'; version: number }, ApiError, { id: string; version: number; reason: string }>({
    mutationFn: ({ id, version, reason }) => api.post(`/recycle-bin/${id}/restore`, { body: { reason }, version }),
    onSettled: () => refresh(qc),
  });
};

export const useSetRecycleRetention = () => {
  const qc = useQueryClient();
  return useMutation<{ retention_days: number; version: number }, ApiError, { version: number; retention_days: number; reason: string }>({
    mutationFn: ({ version, retention_days, reason }) => api.put('/recycle-bin/retention', { body: { retention_days, reason }, version }),
    onSettled: () => refresh(qc),
  });
};
