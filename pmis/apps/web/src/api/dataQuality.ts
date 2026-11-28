import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type DataQualitySettings = S['DataQualitySettings'];
export type DataQualityReport = S['DataQualityReport'];
export type DataQualityInput = Omit<S['DataQualitySettingsInput'], 'reason'> & { reason: string };

export const DQ_CHECKS = ['site_required_empty', 'dates_out_of_order', 'site_without_contractor', 'orphan_ids', 'missing_photos'] as const;
export const DQ_FIELDS = ['name_ar', 'latitude', 'longitude', 'address', 'site_type', 'site_scenario', 'sub_region', 'cluster_id', 'rf_survey_date', 'acquisition_date', 'project_phase'] as const;

export const useDataQualitySettings = () => useQuery({ queryKey: ['dq-settings'], queryFn: () => api.get<DataQualitySettings>('/settings/data-quality') });
export const useSetDataQualitySettings = () => {
  const qc = useQueryClient();
  return useMutation<DataQualitySettings, ApiError, { version: number } & DataQualityInput>({
    mutationFn: ({ version, ...body }) => api.put('/settings/data-quality', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['dq-settings'] }); void qc.invalidateQueries({ queryKey: ['dq-report'] }); },
  });
};
/** Read-only: GET /reports/data-quality (contract 0.15.538). `check` and `region` narrow it. */
export const useDataQualityReport = (check: string, region: string, enabled: boolean) => useQuery({
  queryKey: ['dq-report', check, region], enabled,
  queryFn: () => api.get<DataQualityReport>('/reports/data-quality', { query: { ...(check ? { check } : {}), ...(region ? { region_id: region } : {}) } }),
});
