import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type { components } from './schema';

export type StructureProposal = components['schemas']['StructureProposal'];
export type StructureItem = StructureProposal['items'][number];

/** Contract 0.15.401 (migration 0560): structure proposals, the review and approval of a change of a register's columns made from a modified template. */
export const useStructureProposals = (enabled = true) =>
  useQuery({ queryKey: ['structure-proposals'], enabled, retry: false, refetchOnWindowFocus: false, queryFn: () => api.get<{ items: StructureProposal[] }>('/structure-proposals').then((r) => r.items) });

function useAct<B, R = StructureProposal>(fn: (b: B) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, ApiError, B>({
    mutationFn: fn,
    // an applied proposal changes the columns and issues a new template version
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['structure-proposals'] }); void qc.invalidateQueries({ queryKey: ['templates'] }); void qc.invalidateQueries({ queryKey: ['register-fields'] }); },
  });
}

/** The edited template goes up as a file with a reason; nothing is written to the register until a System Admin approves the proposal it makes. */
export const useUploadStructure = () =>
  useAct((b: { file: File; reason: string }) => {
    const fd = new FormData();
    fd.append('file', b.file); fd.append('reason', b.reason);
    return api.post<StructureProposal>('/structure-proposals/upload', { body: fd, idempotencyKey: crypto.randomUUID() });
  });
/** Approve needs a System Admin (the step-up dialog opens by itself); reject needs a note. */
export const useDecideStructure = () =>
  useAct((b: { id: string; action: 'approve' | 'reject'; note?: string }) => api.post<StructureProposal>(`/structure-proposals/${b.id}/decision`, { body: b.note ? { action: b.action, note: b.note } : { action: b.action } }));
export const useRevertStructure = () =>
  useAct((b: { id: string; reason: string }) => api.post<StructureProposal>(`/structure-proposals/${b.id}/revert`, { body: { reason: b.reason } }));
/** The differences of a proposal as an .xlsx. Returns the file name. */
export const downloadStructureDifferences = (id: string): Promise<string> => downloadFile(`/structure-proposals/${id}/differences`);

export type StructurePolicy = components['schemas']['StructurePolicy'];
export type StructurePolicyInput = components['schemas']['StructurePolicyInput'];

/** Contract 0.15.403 (migration 0562): the rules of structure changes (who proposes, who approves, the second person, the size limit, the two notices). Every signed-in user may read them. */
export const useStructurePolicy = () =>
  useQuery({ queryKey: ['structure-policy'], retry: false, refetchOnWindowFocus: false, queryFn: () => api.get<StructurePolicy>('/settings/structure-policy') });
/** The change needs a reason, If-Match and the step-up (the dialog opens by itself). */
export const useSetStructurePolicy = () => {
  const qc = useQueryClient();
  return useMutation<StructurePolicy, ApiError, { version: number } & StructurePolicyInput>({
    mutationFn: ({ version, ...body }) => api.put<StructurePolicy>('/settings/structure-policy', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['structure-policy'] }); void qc.invalidateQueries({ queryKey: ['structure-proposals'] }); },
  });
};
