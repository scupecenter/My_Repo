import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

/** Contract 0.15.597 (migration 0668): my private note on a task or a register record. Nobody else can read it. */
export type PrivateNote = components['schemas']['PrivateNote'];
export type NoteEntity = 'task' | 'register_record';
const KEY = (t: NoteEntity, id: string) => ['private-note', t, id] as const;

export const usePrivateNote = (type: NoteEntity, id: string, enabled = true) =>
  useQuery({ queryKey: KEY(type, id), enabled, queryFn: () => api.get<PrivateNote>(`/me/private-notes/${type}/${id}`) });

export function useSavePrivateNote(type: NoteEntity, id: string) {
  const qc = useQueryClient();
  return useMutation<PrivateNote, ApiError, string>({
    mutationFn: (body) => api.put<PrivateNote>(`/me/private-notes/${type}/${id}`, { body: { body } }),
    onSuccess: (n) => qc.setQueryData(KEY(type, id), n),
  });
}
