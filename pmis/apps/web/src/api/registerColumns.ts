import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { RegisterColumnCreate, RegisterColumnImpact, RegisterColumnPatch, RegisterColumnResult, RegisterColumnsScreen, RegisterColumnType } from './types';

/**
 * Contract 0.15.15: the admin manages the columns, sections and the name of a register. Every call is a `fields.edit` door with a reason; a delete, a type
 * change and a deactivation also pass the step-up (the client resumes the request after it). A change issues the new template version, so the register
 * catalogue, the register templates and the open drawers are refreshed together.
 */
const K = (key: string) => ['register-columns', key] as const;

export const useRegisterColumns = (key: string, enabled = true) =>
  useQuery({ queryKey: K(key), enabled: enabled && !!key, queryFn: () => api.get<RegisterColumnsScreen>(`/registers/${key}/fields`) });

/** Usage, delete mode and (with `field_type`) the conversion preview of a type change. */
export const useColumnImpact = (key: string, code: string | null, type?: RegisterColumnType) =>
  useQuery({
    queryKey: [...K(key), 'impact', code, type ?? ''], enabled: !!code, staleTime: 0,
    queryFn: () => api.get<RegisterColumnImpact>(`/registers/${key}/fields/${code}/impact`, { query: type ? { field_type: type } : undefined }),
  });

function useSettle(key: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: K(key) });
    void qc.invalidateQueries({ queryKey: ['register-defs'] });
    void qc.invalidateQueries({ queryKey: ['templates'] });
  };
}

export function useCreateColumn(key: string) {
  const settle = useSettle(key);
  return useMutation<RegisterColumnResult, ApiError, RegisterColumnCreate>({ mutationFn: (body) => api.post(`/registers/${key}/fields`, { body }), onSettled: settle });
}
export function useUpdateColumn(key: string) {
  const settle = useSettle(key);
  return useMutation<RegisterColumnResult, ApiError, { code: string; version?: number; patch: RegisterColumnPatch }>({
    mutationFn: ({ code, version, patch }) => api.patch(`/registers/${key}/fields/${code}`, { version, body: patch }), onSettled: settle,
  });
}
export function useDeleteColumn(key: string) {
  const settle = useSettle(key);
  return useMutation<{ mode: 'deleted' | 'deactivated' }, ApiError, { code: string; reason: string }>({
    mutationFn: ({ code, reason }) => api.del(`/registers/${key}/fields/${code}`, { body: { reason } }), onSettled: settle,
  });
}
export function useReorderColumns(key: string) {
  const settle = useSettle(key);
  return useMutation<{ ordered: number }, ApiError, { codes: string[]; reason: string }>({ mutationFn: (body) => api.put(`/registers/${key}/fields-order`, { body }), onSettled: settle });
}
export function useSaveSection(key: string) {
  const settle = useSettle(key);
  return useMutation<{ id: string; version: number }, ApiError, { id?: string; version?: number; name_en?: string; name_ar?: string | null; sort_order?: number; reason: string }>({
    mutationFn: ({ id, version, ...body }) => (id ? api.patch(`/registers/${key}/sections/${id}`, { version, body }) : api.post(`/registers/${key}/sections`, { body })), onSettled: settle,
  });
}
export function useDeleteSection(key: string) {
  const settle = useSettle(key);
  return useMutation<{ deleted: boolean }, ApiError, { id: string; reason: string }>({ mutationFn: ({ id, reason }) => api.del(`/registers/${key}/sections/${id}`, { body: { reason } }), onSettled: settle });
}
export function useRenameRegister(key: string) {
  const settle = useSettle(key);
  return useMutation<{ register_key: string; version: number }, ApiError, { version?: number; name_en?: string; name_ar?: string | null; reason: string }>({
    mutationFn: ({ version, ...body }) => api.patch(`/registers/${key}`, { version, body }), onSettled: settle,
  });
}

/** 0.15.103: the default value of a column (null clears it), prefilled by the register form on a new record. */
export function useSetColumnDefault(key: string) {
  const settle = useSettle(key);
  return useMutation<{ code: string; version: number; default_value?: unknown }, ApiError, { code: string; version?: number; value: unknown; reason: string }>({
    mutationFn: ({ code, version, value, reason }) => api.put(`/registers/${key}/fields/${code}/default`, { version, body: { value, reason } }), onSettled: settle,
  });
}
