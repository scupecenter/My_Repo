import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type ExportSchedule = S['ExportSchedule'];
export type ExportScheduleInput = S['ExportScheduleInput'];

/** 0.15.99: the caller's scheduled Master exports. They start when the owner next opens Exports (no job runs as a person). */
export const useExportSchedules = () => useQuery({ queryKey: ['exportSchedules'], queryFn: () => api.get<{ items: ExportSchedule[] }>('/exports/schedules').then((r) => r.items) });

export const useSaveExportSchedule = () => {
  const qc = useQueryClient();
  return useMutation<{ items: ExportSchedule[] }, ApiError, ExportScheduleInput>({ mutationFn: (body) => api.put('/exports/schedules', { body }), onSettled: () => void qc.invalidateQueries({ queryKey: ['exportSchedules'] }) });
};

export const useDeleteExportSchedule = () => {
  const qc = useQueryClient();
  return useMutation<{ items: ExportSchedule[] }, ApiError, string>({ mutationFn: (id) => api.del(`/exports/schedules/${id}`), onSettled: () => void qc.invalidateQueries({ queryKey: ['exportSchedules'] }) });
};
