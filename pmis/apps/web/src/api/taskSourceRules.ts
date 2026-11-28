import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

/** Contract 0.15.646 (migration 0770, automation item 4): the task source rules of the registers (Settings > Registers). */
export type TaskSourceRule = {
  register_key: string; task_code: string; date_field: string; data_eq: Record<string, string>; data_in: Record<string, string[]>; sort_order: number; is_active: boolean;
};
export type TaskSourceField = { code: string; label_en: string; label_ar?: string | null; field_type: string; options?: string[] | null };
export type TaskSourceRules = {
  rows: TaskSourceRule[];
  registers: { register_key: string; name_en: string; name_ar?: string | null; fields: TaskSourceField[] }[];
  tasks: { code: string; name_en: string; name_ar?: string | null }[];
  version: number; can_edit: boolean;
};
const K = ['task-source-rules'] as const;

export const useTaskSourceRules = () => useQuery({ queryKey: K, queryFn: () => api.get<TaskSourceRules>('/settings/task-source-rules') });
export const useSaveTaskSourceRules = () => {
  const qc = useQueryClient();
  return useMutation<TaskSourceRules, ApiError, { version: number; body: { reason: string; rows: Partial<TaskSourceRule>[] } }>({
    mutationFn: ({ version, body }) => api.put('/settings/task-source-rules', { body, version }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: K }); },
  });
};
