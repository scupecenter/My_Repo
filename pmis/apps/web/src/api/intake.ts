import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/**
 * Contract 0.15.600 (migration 0730): public intake forms. The managers' side is signed in; the public side (`/public/intake/{token}`) has no session, and its
 * answers never carry the site, the register, the owner or a record.
 */
export type IntakeForm = components['schemas']['IntakeForm'];
export type IntakeFormWithToken = components['schemas']['IntakeFormWithToken'];
export type IntakeFormCreate = components['schemas']['IntakeFormCreate'];
export type IntakeFormPatch = components['schemas']['IntakeFormPatch'];
export type IntakeSubmission = components['schemas']['IntakeSubmission'];
export type PublicIntakeForm = components['schemas']['PublicIntakeForm'];
export type PublicIntakeSubmit = components['schemas']['PublicIntakeSubmit'];
export type IntakeFormList = { sharing_locked: boolean; items: IntakeForm[] };

const K = ['intake-forms'] as const;

export const useIntakeForms = () => useQuery({ queryKey: K, queryFn: () => api.get<IntakeFormList>('/intake-forms') });
export const useIntakeSubmissions = (id: string, enabled = true) =>
  useQuery({ queryKey: [...K, id, 'submissions'], enabled: enabled && !!id, queryFn: () => api.get<{ items: IntakeSubmission[] }>(`/intake-forms/${id}/submissions`).then((r) => r.items) });

function useSettle() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: K }); };
}
export function useCreateIntakeForm() {
  const settle = useSettle();
  return useMutation<IntakeFormWithToken, ApiError, IntakeFormCreate>({ mutationFn: (body) => api.post('/intake-forms', { body }), onSettled: settle });
}
export function useUpdateIntakeForm() {
  const settle = useSettle();
  return useMutation<IntakeFormWithToken, ApiError, { id: string; version: number; patch: IntakeFormPatch }>({
    mutationFn: ({ id, version, patch }) => api.patch(`/intake-forms/${id}`, { version, body: patch }), onSettled: settle,
  });
}
export function useReplaceIntakeLink() {
  const settle = useSettle();
  return useMutation<IntakeFormWithToken, ApiError, { id: string; version: number }>({ mutationFn: ({ id, version }) => api.post(`/intake-forms/${id}/replace-link`, { version }), onSettled: settle });
}
export function useDeleteIntakeForm() {
  const settle = useSettle();
  return useMutation<void, ApiError, string>({ mutationFn: (id) => api.del(`/intake-forms/${id}`), onSettled: settle });
}

/** The shared page: no retry (an unknown link must show its one answer at once), nothing kept. */
export const usePublicIntakeForm = (token: string) =>
  useQuery({ queryKey: ['public-intake', token], retry: false, gcTime: 0, staleTime: 0, queryFn: () => api.get<PublicIntakeForm>(`/public/intake/${encodeURIComponent(token)}`) });
export const useSubmitPublicIntake = (token: string) =>
  useMutation<{ ok: true; thanks_en?: string | null; thanks_ar?: string | null }, ApiError, PublicIntakeSubmit>({ mutationFn: (body) => api.post(`/public/intake/${encodeURIComponent(token)}`, { body }) });
