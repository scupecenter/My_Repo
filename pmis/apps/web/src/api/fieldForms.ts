import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { FieldForms, FieldFormSubmission } from './types';

/** 0.15.596 (migration 0667): the field form kinds (Settings > Screens > Field forms), and the filled forms of a site. */
export const useFieldForms = () => useQuery({ queryKey: ['field-forms'], queryFn: () => api.get<FieldForms>('/settings/field-forms') });
export const useSiteFieldForms = (siteId: string | null | undefined) => useQuery({
  queryKey: ['field-forms-site', siteId], enabled: !!siteId, retry: false,
  queryFn: async () => (await api.get<{ items: FieldFormSubmission[] }>(`/sites/${siteId}/field-forms`)).items,
});
export const useSetFieldForms = () => {
  const qc = useQueryClient();
  return useMutation<FieldForms, ApiError, { version: number; forms: FieldForms['forms']; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/field-forms', { version, body }), onSettled: () => { void qc.invalidateQueries({ queryKey: ['field-forms'] }); },
  });
};
