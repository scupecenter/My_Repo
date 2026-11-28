import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

/** Personal coloured labels on records (contract 0.15.620). Everything here is the caller's own. */
type S = components['schemas'];
export type Label = S['Label'];
export type LabelColour = S['LabelColour'];
export type LabelKind = 'site' | 'register_record';
export type LabelLinkRow = { ref_id: string; context: string | null; label_ids: string[] };
export const LABEL_COLOURS: LabelColour[] = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'grey'];

export const useLabels = () => useQuery({ queryKey: ['labels'], retry: false, staleTime: 30_000, queryFn: () => api.get<{ items: Label[] }>('/labels').then((r) => r.items) });
export const useLabelLinks = (kind: LabelKind) =>
  useQuery({ queryKey: ['label-links', kind], retry: false, staleTime: 30_000, queryFn: () => api.get<{ items: LabelLinkRow[] }>('/labels/links', { query: { kind } }).then((r) => r.items) });

export function useLabelOps() {
  const qc = useQueryClient();
  const settle = () => { void qc.invalidateQueries({ queryKey: ['labels'] }); void qc.invalidateQueries({ queryKey: ['label-links'] }); };
  return {
    create: useMutation<Label, ApiError, { name: string; colour: LabelColour }>({ mutationFn: (body) => api.post('/labels', { body }), onSuccess: settle }),
    update: useMutation<Label, ApiError, { id: string; name?: string; colour?: LabelColour }>({ mutationFn: ({ id, ...body }) => api.patch(`/labels/${id}`, { body }), onSuccess: settle }),
    archive: useMutation<Label, ApiError, string>({ mutationFn: (id) => api.post(`/labels/${id}/archive`), onSuccess: settle }),
    assign: useMutation<unknown, ApiError, { id: string; kind: LabelKind; ref_id: string; context?: string; on: boolean }>({
      mutationFn: ({ id, on, ...body }) => api.post(`/labels/${id}/${on ? 'assign' : 'unassign'}`, { body }),
      onSuccess: settle,
    }),
  };
}
