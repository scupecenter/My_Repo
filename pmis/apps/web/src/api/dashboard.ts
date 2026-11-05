import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadFile } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type Dashboard = S['Dashboard'];
export type DashboardMilestone = S['DashboardMilestone'];
export type DashboardStream = S['DashboardStream'];
export type DashboardRegion = S['DashboardRegion'];
export type ManualItemList = S['ManualItemList'];
export type ManualItem = S['ManualItem'];
export type ManualItemValue = S['ManualItemValue'];
export type DelayPeriodList = S['DelayPeriodList'];
export type DelayPeriod = S['DelayPeriod'];
export type DelayParty = S['DelayParty'];
export type SnapshotKind = S['SnapshotKind'];
export type PipelineVariant = S['PipelineVariant'];
export type ManualPlanPoint = S['ManualPlanPoint'];
export type ManualPlan = S['ManualPlan'];

/** The query of `GET /dashboard` (contract 0.7.2; `view` 0.11.0). Empty values are not sent. */
export interface DashboardQuery {
  ref_date?: string;
  region_id?: string;
  cluster_code?: string;
  scenario?: string;
  stream?: string;
  view?: string;
}

export type ExportFormat = 'xlsx' | 'csv';

const clean = (q: DashboardQuery): Record<string, string> => Object.fromEntries(Object.entries(q).filter(([, v]) => !!v)) as Record<string, string>;

export const useDashboard = (q: DashboardQuery) =>
  useQuery({
    queryKey: ['dashboard', clean(q)],
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<Dashboard>('/dashboard', { query: clean(q) }),
  });

/** Downloads exactly the view on screen (`GET /dashboard/export`, needs the export right; the server audits it). Excel by default (Q127), CSV as an option. */
export const downloadDashboard = (q: DashboardQuery, format: ExportFormat = 'xlsx') => downloadFile('/dashboard/export', { ...clean(q), format });

// ---------------------------------------------------------------- 0.14.5: the site map (OV-12, SC-10)
export type SiteMap = S['SiteMap'];
export type SiteMapItem = S['SiteMapItem'];
/** The sites of the map: the caller's dashboard.view regions that are also sites.view regions. Filters are applied in the browser (lib/siteMap). */
export const useSiteMap = (enabled = true) =>
  useQuery({ queryKey: ['dashboard-site-map'], staleTime: 60_000, enabled, queryFn: () => api.get<SiteMap>('/dashboard/site-map') });

// ---------------------------------------------------------------- Q118: manual percentage of the central Project Status items
export const useManualItems = () =>
  useQuery({ queryKey: ['manual-items'], queryFn: () => api.get<ManualItemList>('/project-status/manual-items') });

export function useAddManualValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; value_pct: number; effective_date: string; reason: string; source: string }) =>
      api.post<ManualItemValue>(`/project-status/manual-items/${encodeURIComponent(code)}/values`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['manual-items'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ---------------------------------------------------------------- Q177: the plan of a central item (points, or a target date with an optional start)
export function useSetManualPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; reason: string; source: string } & ({ points: ManualPlanPoint[] } | { target_date: string; start_date?: string })) =>
      api.post<ManualPlan>(`/project-status/manual-items/${encodeURIComponent(code)}/plan`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['manual-items'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ---------------------------------------------------------------- Q116: the pipeline style (A rings, B flat track)
export function useSetPipelineVariant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { variant: PipelineVariant; reason: string }) => api.put<{ variant: PipelineVariant }>('/dashboard/pipeline-variant', { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dashboard'] }),
  });
}

// ---------------------------------------------------------------- Q122: delay attribution periods of a task
export const useDelayPeriods = (taskId: string) =>
  useQuery({ queryKey: ['delay-periods', taskId], queryFn: () => api.get<DelayPeriodList>(`/tasks/${taskId}/delay-periods`) });

export function useAddDelayPeriod(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { from_date: string; to_date: string; party: DelayParty; external_party_id?: string | null; reason: string; evidence?: string | null }) =>
      api.post<DelayPeriod>(`/tasks/${taskId}/delay-periods`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['delay-periods', taskId] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useVoidDelayPeriod(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<DelayPeriod>(`/tasks/${taskId}/delay-periods/${id}/void`, { body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['delay-periods', taskId] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Q182, Q184: approve or reject a proposed period (never one's own; a rejection needs a note; a contractor or external one needs its party). */
export function useDecideDelayPeriod(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; decision: 'approve' | 'reject'; note?: string | null; external_party_id?: string | null }) =>
      api.post<DelayPeriod>(`/tasks/${taskId}/delay-periods/${id}/decision`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['delay-periods', taskId] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
