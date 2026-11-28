import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

/** Personal record templates (contract 0.15.621). Everything here is the caller's own. */
export type RecordTemplate = components['schemas']['RecordTemplate'];
export type RecordTemplateInput = components['schemas']['RecordTemplateInput'];

export const useRecordTemplates = (registerKey: string, enabled = true) =>
  useQuery({ queryKey: ['record-templates', registerKey], enabled, retry: false, staleTime: 30_000, queryFn: () => api.get<{ items: RecordTemplate[] }>('/record-templates', { query: { register_key: registerKey } }).then((r) => r.items) });

export function useRecordTemplateOps(registerKey: string) {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: ['record-templates', registerKey] });
  return {
    save: useMutation<RecordTemplate, ApiError, RecordTemplateInput>({ mutationFn: (body) => api.post('/record-templates', { body }), onSuccess: settle }),
    archive: useMutation<RecordTemplate, ApiError, string>({ mutationFn: (id) => api.post(`/record-templates/${id}/archive`), onSuccess: settle }),
  };
}
