import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];

export type PlanRules = S['PlanRules'];
export type PlannedDates = S['PlannedDates'];
export type PlannedDateItem = PlannedDates['items'][number];

/** Settings > SLA and time > Planned dates (A4, contract 0.15.463). */
export const usePlanRules = () => useQuery({ queryKey: ['planRules'], queryFn: () => api.get<PlanRules>('/settings/plan-rules') });

export function useSetPlanRules() {
  const qc = useQueryClient();
  return useMutation<PlanRules, ApiError, { version: number; body: { enabled: boolean; basis: 'max' | 'min'; cascade: boolean; reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/settings/plan-rules', { version, body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['planRules'] });
      void qc.invalidateQueries({ queryKey: ['plannedDates'] });
    },
  });
}

/** The proposals of one site, computed on read. */
export const usePlannedDates = (siteId: string) =>
  useQuery({ queryKey: ['plannedDates', siteId], queryFn: () => api.get<PlannedDates>(`/sites/${siteId}/planned-dates`) });

export function useApplyPlannedDates(siteId: string) {
  const qc = useQueryClient();
  return useMutation<{ applied: number; skipped: number }, ApiError, string[]>({
    mutationFn: (task_ids) => api.post(`/sites/${siteId}/planned-dates/apply`, { body: { task_ids } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['plannedDates', siteId] });
      void qc.invalidateQueries({ queryKey: ['site', siteId] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
