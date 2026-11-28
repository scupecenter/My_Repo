import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/** Contract 0.15.640 (migration 0760): the expiry radar of Settings > Alerts. */
export type ExpiryRadarSetting = components['schemas']['ExpiryRadarSetting'];
export type ExpiryRadarRegister = components['schemas']['ExpiryRadarRegister'];
export type ExpiryRadarCandidate = components['schemas']['ExpiryRadarCandidate'];
export interface ExpiryRadarInput { enabled: boolean; registers: { register_key: string; field: string; lead_days: number[] }[] }

export const useExpiryRadar = () => useQuery({ queryKey: ['expiry-radar'], queryFn: () => api.get<ExpiryRadarSetting>('/settings/expiry-radar') });

/** PUT /settings/expiry-radar: System Admin or a delegate of admin.settings for all regions, a reason and If-Match. */
export function useSaveExpiryRadar() {
  const qc = useQueryClient();
  return useMutation<ExpiryRadarSetting, ApiError, ExpiryRadarInput & { version: number; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put<ExpiryRadarSetting>('/settings/expiry-radar', { version, body }),
    onSuccess: (r) => qc.setQueryData(['expiry-radar'], r),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['expiry-radar'] }),
  });
}
