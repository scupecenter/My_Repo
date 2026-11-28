import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/** Report Center (contract 0.15.598): the ready report library and a run of one report. Reads only. */
type S = components['schemas'];
export type ReportLibrary = S['ReportLibrary'];
export type ReportRunInput = S['ReportRunInput'];
export type ReportRun = S['ReportRun'];

export const useReportLibrary = () => useQuery({ queryKey: ['report-library'], queryFn: () => api.get<ReportLibrary>('/reports/library') });
export const useRunReport = () => useMutation<ReportRun, ApiError, { key: string; params?: ReportRunInput }>({
  mutationFn: ({ key, params }) => api.post<ReportRun>(`/reports/${key}/run`, { body: params ?? {} }),
});
