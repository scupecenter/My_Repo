import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/** Owner decision 2026-11-12 (2), contract 0.15.6: direct admin edits of a site and of a task date, and their revert. All three need a reason and a step-up (handled by the API client). */
type S = components['schemas'];
export type AdminOverride = S['Override'];
export type SiteAdminEditBody = S['SiteAdminEditRequest'];
export type DateField = 'planned_date' | 'actual_start' | 'actual_date' | 'baseline_date';
export const OVERRIDE_DATE_FIELDS: DateField[] = ['planned_date', 'actual_start', 'actual_date', 'baseline_date'];

const settle = (qc: ReturnType<typeof useQueryClient>, siteId: string, taskId?: string) => {
  for (const k of ['site', 'sites', 'site-tasks', 'task', 'task-history', 'my-work', 'approvals']) void qc.invalidateQueries({ queryKey: k === 'site' || k === 'site-tasks' ? [k, siteId] : [k] });
  if (taskId) void qc.invalidateQueries({ queryKey: ['task', taskId] });
};

export function useAdminEditSite(siteId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, SiteAdminEditBody>({ mutationFn: (body) => api.post(`/sites/${siteId}/admin-edits`, { body }), onSettled: () => settle(qc, siteId) });
}

export function useCreateTaskOverride(task: { id: string; site_id: string; version: number }) {
  const qc = useQueryClient();
  return useMutation<AdminOverride, ApiError, { date_field: DateField; new_date: string | null; reason: string }>({
    mutationFn: (b) => api.post(`/tasks/${task.id}/overrides`, { version: task.version, body: { kind: 'edit_date', ...b } }),
    onSettled: () => settle(qc, task.site_id, task.id),
  });
}

export function useRevertOverride(siteId: string, taskId?: string) {
  const qc = useQueryClient();
  return useMutation<AdminOverride, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`/overrides/${id}/revert`, { body: { reason } }),
    onSettled: () => settle(qc, siteId, taskId),
  });
}
