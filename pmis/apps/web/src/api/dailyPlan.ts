import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type { components } from './schema';

/** My Work > Daily Plan (plan W7, contract 0.15.67). One plan per region per day; the server fills the rows and decides who edits, locks and unlocks. */
type S = components['schemas'];
export type DailyPlanDay = S['DailyPlanDay'];
export type DailyPlanRow = S['DailyPlanRow'];
export type DailyPlanRegion = S['DailyPlanRegion'];
export type DailyPlanRowInput = S['DailyPlanRowInput'];
export type DailyPlanSettings = S['DailyPlanSettings'];
export type DailyPlanSettingsInput = S['DailyPlanSettingsInput'];
export type DailyPlanColumn = S['DailyPlanColumn'];

export const useDailyPlan = (date: string | null | undefined) =>
  useQuery({ queryKey: ['daily-plan', date], enabled: !!date, queryFn: () => api.get<DailyPlanDay>('/daily-plans', { query: { date: date ?? undefined } }) });

const refresh = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: ['daily-plan'] });
const base = (date: string, region: number) => `/daily-plans/${date}/regions/${region}`;

/** The row, site and lock changes of one plan; each carries the plan version as If-Match. */
export function useDailyPlanOps() {
  const qc = useQueryClient();
  const opts = { onSettled: () => refresh(qc) };
  return {
    save: useMutation<DailyPlanDay, ApiError, { date: string; region: number; site: string; version: number; body: DailyPlanRowInput }>({
      mutationFn: ({ date, region, site, version, body }) => api.patch(`${base(date, region)}/sites/${site}`, { version, body }), ...opts }),
    add: useMutation<DailyPlanDay, ApiError, { date: string; region: number; version: number; site_code: string }>({
      mutationFn: ({ date, region, version, site_code }) => api.post(`${base(date, region)}/sites`, { version, body: { site_code } }), ...opts }),
    remove: useMutation<DailyPlanDay, ApiError, { date: string; region: number; site: string; version: number }>({
      mutationFn: ({ date, region, site, version }) => api.del(`${base(date, region)}/sites/${site}`, { version }), ...opts }),
    lock: useMutation<DailyPlanDay, ApiError, { date: string; region: number; version: number }>({
      mutationFn: ({ date, region, version }) => api.post(`${base(date, region)}/lock`, { version }), ...opts }),
    unlock: useMutation<DailyPlanDay, ApiError, { date: string; region: number; version: number; reason: string }>({
      mutationFn: ({ date, region, version, reason }) => api.post(`${base(date, region)}/unlock`, { version, body: { reason } }), ...opts }),
  };
}

/** Excel of both tables (the day and the next working day) in the owner's column order; `sites` keeps the rows of the current view. */
export const exportDailyPlan = (date: string, regions: number[], sites?: string[]) =>
  downloadFile('/daily-plans/export', { date, region_id: regions, site_id: sites && sites.length ? sites : undefined });

export const useDailyPlanSettings = () => useQuery({ queryKey: ['daily-plan-settings'], queryFn: () => api.get<DailyPlanSettings>('/settings/daily-plan') });
export const useSetDailyPlanSettings = () => {
  const qc = useQueryClient();
  return useMutation<DailyPlanSettings, ApiError, DailyPlanSettingsInput & { version: number; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/daily-plan', { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['daily-plan-settings'] }),
  });
};
