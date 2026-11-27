import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

/** Contract 0.15.331 (migration 0430): the editable rules of the registers (Settings > Register rules). */
export type RuleSpec = { register_key: string; key: string; type: 'boolean' | 'text'; default?: unknown; label_en: string; label_ar?: string };
export type RegisterRules = { register_key: string; name_en: string; name_ar?: string | null; rules: Record<string, unknown>; version: number };
const K = ['register-rules'] as const;

export const useRegisterRules = () =>
  useQuery({ queryKey: K, queryFn: () => api.get<{ catalogue: RuleSpec[]; items: RegisterRules[] }>('/settings/register-rules') });

export function useSetRegisterRules() {
  const qc = useQueryClient();
  return useMutation<{ register_key: string; rules: Record<string, unknown>; version: number }, ApiError, { key: string; version?: number; rules: Record<string, boolean | string>; reason: string }>({
    mutationFn: ({ key, version, ...body }) => api.put(`/settings/register-rules/${key}`, { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: K }); void qc.invalidateQueries({ queryKey: ['register-defs'] }); },
  });
}
