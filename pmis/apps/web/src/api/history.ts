import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ApiError } from './client';

/** Migration 0567 (contract 0.15.410): one entry of an audit trail with the field changes. */
export interface HistoryEntry {
  id: string; at: string; action: string; actor?: { display_name?: string } | null; reason?: string | null;
  changes: { field: string; from?: unknown; to?: unknown }[];
}

export const useItemHistory = (id: string | null) =>
  useQuery({ queryKey: ['history', 'item', id], enabled: !!id, queryFn: () => api.get<HistoryEntry[]>(`/warehouse/items/${id}/history`) });

export const usePlanHistory = (date: string | null, region: number | null) =>
  useQuery({ queryKey: ['history', 'plan', date, region], enabled: !!date && region !== null, queryFn: () => api.get<HistoryEntry[]>(`/daily-plans/${date}/regions/${region}/history`) });

/** Claim and triage state of a plan day (target: region + date). */
export interface PlanTriage {
  region_id: number; plan_date: string; triage_state: 'pending' | 'accepted' | 'deferred' | null; triage_note?: string | null;
  triage_by?: { display_name?: string } | null; triage_at?: string | null; claimed_by?: { display_name?: string } | null; claimed_at?: string | null; can_triage: boolean;
}

const key = ['plan-triage'];
export const usePlanTriage = (date: string | null, region: number | null) =>
  useQuery({ queryKey: [...key, date, region], enabled: !!date && region !== null, queryFn: () => api.get<PlanTriage>(`/daily-plans/${date}/regions/${region}/triage`) });

export function usePlanTriageOps(date: string, region: number) {
  const qc = useQueryClient();
  const base = `/daily-plans/${date}/regions/${region}`;
  const opts = { onSettled: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['history'] }); } };
  return {
    claim: useMutation<PlanTriage, ApiError, void>({ mutationFn: () => api.post<PlanTriage>(`${base}/claim`), ...opts }),
    release: useMutation<PlanTriage, ApiError, void>({ mutationFn: () => api.del<PlanTriage>(`${base}/claim`), ...opts }),
    decide: useMutation<PlanTriage, ApiError, { state: 'accepted' | 'deferred'; note: string }>({ mutationFn: (body) => api.post<PlanTriage>(`${base}/triage`, { body }), ...opts }),
  };
}
