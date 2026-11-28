import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/**
 * Contract 0.15.533: admin-defined custom registers. A register is created disabled, gets its columns from the ordinary column screen and is enabled
 * (menu key, template, permission module). Hiding keeps the records and the grants. Every change refreshes the register catalogue, the menu and the grid.
 */
export type CustomRegister = components['schemas']['CustomRegister'];
export type CustomRegisterInput = components['schemas']['CustomRegisterInput'];
export type CustomRegisterPatch = components['schemas']['CustomRegisterPatch'];
export type CustomRegisterList = { items: CustomRegister[]; limit: { max: number; active: number } };

const K = ['custom-registers'] as const;

export const useCustomRegisters = () => useQuery({ queryKey: K, queryFn: () => api.get<CustomRegisterList>('/custom-registers') });

function useSettle() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: K });
    void qc.invalidateQueries({ queryKey: ['register-defs'] });
    void qc.invalidateQueries({ queryKey: ['templates'] });
    void qc.invalidateQueries({ queryKey: ['nav'] });
    void qc.invalidateQueries({ queryKey: ['permissions'] });
  };
}

export function useCreateCustomRegister() {
  const settle = useSettle();
  return useMutation<CustomRegister, ApiError, CustomRegisterInput>({ mutationFn: (body) => api.post('/custom-registers', { body }), onSettled: settle });
}
export function useUpdateCustomRegister() {
  const settle = useSettle();
  return useMutation<CustomRegister, ApiError, { key: string; version: number; patch: CustomRegisterPatch }>({
    mutationFn: ({ key, version, patch }) => api.patch(`/custom-registers/${key}`, { version, body: patch }), onSettled: settle,
  });
}
export function useEnableCustomRegister() {
  const settle = useSettle();
  return useMutation<CustomRegister, ApiError, { key: string; version: number; reason: string }>({
    mutationFn: ({ key, version, reason }) => api.post(`/custom-registers/${key}/enable`, { version, body: { reason } }), onSettled: settle,
  });
}
