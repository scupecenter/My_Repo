import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { LegacyConversionInput, LegacyConversionProposal, ListCatalogue, ListCatalogueInput, ListCataloguePatch, ListValueInput, ListValuePatch, RegisterRecord } from './types';

/** Contract 0.12.5 (Q104): the list catalogue. Anyone signed in reads it; the System Admin or a delegate of fields edit writes it. */
export const useListCatalogues = (includeInactive = true) =>
  useQuery({ queryKey: ['list-catalogues', includeInactive], queryFn: () => api.get<{ items: ListCatalogue[] }>('/list-catalogues', { query: { include_inactive: includeInactive } }).then((r) => r.items) });

function useListWrite<V>(fn: (v: V) => Promise<ListCatalogue>) {
  const qc = useQueryClient();
  return useMutation<ListCatalogue, ApiError, V>({
    mutationFn: fn,
    // the forms read the list values through GET /registers
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['list-catalogues'] }); void qc.invalidateQueries({ queryKey: ['register-defs'] }); },
  });
}
export const useCreateList = () => useListWrite<ListCatalogueInput>((body) => api.post('/list-catalogues', { body }));
export const useUpdateList = () => useListWrite<{ code: string; version: number; body: ListCataloguePatch }>(({ code, version, body }) => api.patch(`/list-catalogues/${code}`, { version, body }));
export const useAddListValue = () => useListWrite<{ code: string; body: ListValueInput }>(({ code, body }) => api.post(`/list-catalogues/${code}/values`, { body }));
export const useUpdateListValue = () =>
  useListWrite<{ code: string; id: string; version: number; body: ListValuePatch }>(({ code, id, version, body }) => api.patch(`/list-catalogues/${code}/values/${id}`, { version, body }));

/** Q111: the proposal from the old free text of a meeting (nothing is saved) and the reviewed conversion (once per meeting). */
export const useLegacyProposal = (key: string, id: string | null, enabled: boolean) =>
  useQuery({ queryKey: ['legacy-conversion', key, id], enabled: enabled && !!id, queryFn: () => api.get<LegacyConversionProposal>(`/registers/${key}/records/${id}/legacy-conversion`) });
export const useApplyLegacy = (key: string) => {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; body: LegacyConversionInput }>({
    mutationFn: ({ record, body }) => api.post(`/registers/${key}/records/${record.id}/legacy-conversion`, { version: record.version, body }),
    onSuccess: (r) => qc.setQueryData(['register-record', key, r.id], r),
    onSettled: (_r, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['register-record', key, v.record.id] });
      void qc.invalidateQueries({ queryKey: ['legacy-conversion', key, v.record.id] });
      void qc.invalidateQueries({ queryKey: ['register-records', key] });
    },
  });
};
