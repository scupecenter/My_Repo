import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/**
 * Contract 0.15.138 (migration 0381): switch a whole register on or off and lock it. Disabling hides (nothing is touched); locking refuses new and changed records
 * for everyone but the System Admins. A reason is required and the change is audited; the register catalogue is refreshed after every change.
 */
export type RegisterState = components['schemas']['RegisterState'];
const K = ['register-state'] as const;

export const useRegisterStates = () =>
  useQuery({ queryKey: K, queryFn: () => api.get<{ items: RegisterState[] }>('/settings/register-state') });

export function useSetRegisterState() {
  const qc = useQueryClient();
  return useMutation<{ register_key: string; enabled: boolean; locked: boolean; version: number }, ApiError, { key: string; version?: number; enabled?: boolean; locked?: boolean; reason: string }>({
    mutationFn: ({ key, version, ...body }) => api.put(`/settings/register-state/${key}`, { version, body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: K });
      void qc.invalidateQueries({ queryKey: ['register-defs'] });
      void qc.invalidateQueries({ queryKey: ['register-columns'] });
    },
  });
}
