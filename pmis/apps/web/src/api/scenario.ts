import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

/** Contract 0.12.0 (P1, migration 0052): scenario applicability, scope exceptions, the gate history, scenario rules and the SLA sheet columns. */
type S = components['schemas'];
export type SiteApplicability = S['SiteApplicability'];
export type ApplicabilityApplyResult = S['ApplicabilityApplyResult'];
export type GateEvent = S['GateEvent'];
export type ScenarioRule = S['ScenarioRule'];
export type ScenarioRuleList = S['ScenarioRuleList'];
export type SlaMasterColumn = S['SlaMasterColumn'];

export const useSiteApplicability = (siteId: string, on = true) =>
  useQuery({ queryKey: ['site-applicability', siteId], enabled: on && !!siteId, queryFn: () => api.get<SiteApplicability>(`/sites/${siteId}/applicability`) });

export const useGateEvents = (siteId: string, on = true) =>
  useQuery({ queryKey: ['site-gate-events', siteId], enabled: on && !!siteId, queryFn: () => api.get<{ items: GateEvent[] }>(`/sites/${siteId}/gate-events`).then((r) => r.items) });

function useRefresh(siteId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['site-applicability', siteId] });
    void qc.invalidateQueries({ queryKey: ['site-gate-events', siteId] });
    void qc.invalidateQueries({ queryKey: ['site', siteId] });
    void qc.invalidateQueries({ queryKey: ['site-tasks', siteId] });
    void qc.invalidateQueries({ queryKey: ['task'] });
  };
}

export function useApplyApplicability(siteId: string) {
  const refresh = useRefresh(siteId);
  return useMutation<ApplicabilityApplyResult, ApiError, { reason: string }>({
    mutationFn: (body) => api.post(`/sites/${siteId}/applicability/apply`, { body }),
    onSettled: refresh,
  });
}

export function useAddScopeException(siteId: string) {
  const refresh = useRefresh(siteId);
  return useMutation<SiteApplicability, ApiError, { task_code: string; reason: string; change_request_id?: string | null }>({
    mutationFn: (body) => api.post(`/sites/${siteId}/scope-exceptions`, { body }),
    onSettled: refresh,
  });
}

export function useRevokeScopeException(siteId: string) {
  const refresh = useRefresh(siteId);
  return useMutation<SiteApplicability, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`/sites/${siteId}/scope-exceptions/${id}/revoke`, { body: { reason } }),
    onSettled: refresh,
  });
}

export const useScenarioRules = () => useQuery({ queryKey: ['scenario-rules'], queryFn: () => api.get<ScenarioRuleList>('/settings/scenario-rules') });
export const useSlaMasterColumns = () =>
  useQuery({ queryKey: ['sla-master-columns'], staleTime: 300_000, queryFn: () => api.get<{ items: SlaMasterColumn[] }>('/settings/sla-master-columns').then((r) => r.items) });
