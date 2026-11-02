import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, downloadFile } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type Dashboard = S['Dashboard'];
export type DashboardMilestone = S['DashboardMilestone'];
export type DashboardStream = S['DashboardStream'];
export type DashboardRegion = S['DashboardRegion'];

/** The query of `GET /dashboard` (contract 0.7.2). Empty values are not sent. */
export interface DashboardQuery {
  ref_date?: string;
  region_id?: string;
  cluster_code?: string;
  scenario?: string;
  stream?: string;
}

const clean = (q: DashboardQuery): Record<string, string> => Object.fromEntries(Object.entries(q).filter(([, v]) => !!v)) as Record<string, string>;

export const useDashboard = (q: DashboardQuery) =>
  useQuery({
    queryKey: ['dashboard', clean(q)],
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<Dashboard>('/dashboard', { query: clean(q) }),
  });

/** Downloads exactly the view on screen as CSV (`GET /dashboard/export`, needs the export right; the server audits it). */
export const downloadDashboard = (q: DashboardQuery) => downloadFile('/dashboard/export', clean(q));
