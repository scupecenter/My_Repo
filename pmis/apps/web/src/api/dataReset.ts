import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type DataResetState = S['DataResetState'];
export type DataResetRequest = S['DataResetRequest'];
export type DataResetSettings = S['DataResetSettings'];
export type DataResetPlanTable = S['DataResetPlanTable'];
export type DataResetPlan = S['DataResetPlan'];
export type DataResetPart = S['DataResetPart'];
export type DataResetScope = S['DataResetScope'];

/**
 * Contract 0.15.71 (migration 0152): the closure of a choice as the screen shows it before asking the server (every part that depends on a chosen part
 * is added, until nothing changes). The server computes the same closure and is the authority: the request stores the server's, never this one.
 */
export function closureOf(chosen: readonly string[], catalogue: readonly Pick<DataResetPart, 'code' | 'depends_on'>[]): string[] {
  const s = new Set(chosen);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of catalogue) if (!s.has(p.code) && p.depends_on.some((d) => s.has(d))) { s.add(p.code); grew = true; }
  }
  return [...s].sort();
}

/** The dry run of a chosen scope (null = everything): counts per part and per table. */
export const useDataResetPlan = (parts: string[] | null, enabled = true) =>
  useQuery({
    queryKey: ['data-reset', 'plan', parts?.join(',') ?? '*'], enabled: enabled && (parts === null || parts.length > 0), retry: false, refetchOnWindowFocus: false,
    queryFn: () => api.get<DataResetPlan>('/settings/data-reset/plan', { query: { parts: parts?.join(',') } }),
  });

/** Statuses during which the screen polls (the run happens in the background on the server). */
export const RUNNING = new Set(['running', 'files_pending']);

/**
 * Contract 0.15.62 (migration 0146): the project data reset in Settings. A System Admin only (the server refuses everyone else). While a run is open the
 * screen polls with `X-PMIS-Live: 1` (a timer never extends the idle timeout); those reads are the only routes answered during the run.
 */
export const useDataReset = (enabled = true) =>
  useQuery({ queryKey: ['data-reset'], enabled, retry: false, refetchOnWindowFocus: false, queryFn: () => api.get<DataResetState>('/settings/data-reset') });

/** The open request while it runs: polled every 2 s (the plan is not counted during a run, so the screen follows the request itself). */
export const useDataResetRequest = (id: string | null, poll: boolean) =>
  useQuery({
    queryKey: ['data-reset', 'request', id], enabled: !!id && poll, retry: false,
    queryFn: () => api.get<DataResetRequest>(`/settings/data-reset/requests/${id}`, { headers: { 'X-PMIS-Live': '1' } }),
    refetchInterval: (q) => (!q.state.data || q.state.data.status === 'running' ? 2000 : q.state.data.status === 'files_pending' ? 10_000 : false),
  });

function useAct<B>(fn: (b: B) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, B>({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: ['data-reset'] }) });
}

export const useRequestDataReset = () =>
  useAct((b: { reason: string; confirm_text: string; parts?: string[]; require_backup?: boolean; no_backup_confirm?: string }) =>
    api.post('/settings/data-reset/requests', { body: b }));
/** Contract 0.15.72: a request made without a backup (`require_backup` false); a missing field (an older server) means a backup is required. */
export const requiresBackup = (r: Pick<DataResetRequest, 'require_backup'> | null | undefined) => r?.require_backup !== false;
/** The approver sends the scope hash they saw (0.15.71): a request whose scope is not that one is refused (409 scope_changed). */
export const useApproveDataReset = () =>
  useAct((b: { id: string; version: number; reason: string; scope_hash?: string | null }) =>
    api.post(`/settings/data-reset/requests/${b.id}/approve`, { body: b.scope_hash ? { reason: b.reason, scope_hash: b.scope_hash } : { reason: b.reason }, version: b.version }));
export const useCancelDataReset = () =>
  useAct((b: { id: string; version: number; reason: string }) => api.post(`/settings/data-reset/requests/${b.id}/cancel`, { body: { reason: b.reason }, version: b.version }));
export const useRunDataReset = () =>
  useAct((b: { id: string; version: number; confirm_text: string }) => api.post(`/settings/data-reset/requests/${b.id}/run`, { body: { confirm_text: b.confirm_text }, version: b.version }));
export const useRetryDataResetFiles = () =>
  useAct((b: { id: string; reason: string }) => api.post(`/settings/data-reset/requests/${b.id}/retry-files`, { body: { reason: b.reason } }));
export const useSetDataResetSettings = () =>
  useAct((b: { version: number; reason: string; request_expiry_minutes: number; backup_max_age_hours: number }) =>
    api.put('/settings/data-reset/settings', { body: { reason: b.reason, request_expiry_minutes: b.request_expiry_minutes, backup_max_age_hours: b.backup_max_age_hours }, version: b.version }));
