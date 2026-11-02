import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type { Job, Page, TaskDetail } from './types';
import type { components } from './schema';
import { trackRealJob } from '@/lib/hybrid';

type S = components['schemas'];
export type DocumentSlot = S['DocumentSlot'];
export type DocumentListItem = S['DocumentListItem'];
export type DocumentType = S['DocumentType'];
export type DocumentTypeInput = S['DocumentTypeInput'];
export type DocumentTypePatch = S['DocumentTypePatch'];
export type DocumentTypeVersion = S['DocumentTypeVersion'];
export type ZipExportRequest = S['ZipExportRequest'];
export type SlotSuggestion = { file_name: string; suggestions: { slot_id: string; doc_code: string; score: number }[] };

/** The reasons of a `file_rejected` answer (contract 0.6.0). */
export const REJECT_REASONS = ['format_not_allowed', 'executable', 'archive', 'macro', 'script', 'html', 'empty', 'unknown_type', 'too_many_files'] as const;

// ------------------------------------------------------------------------------------------------------------- slots of a task
export const useTaskSlots = (taskId: string | null) =>
  useQuery({ queryKey: ['task-slots', taskId], enabled: !!taskId, queryFn: () => api.get<{ items: DocumentSlot[] }>(`/tasks/${taskId}/slots`).then((r) => r.items) });

/** Who owns a set of slots: a task (`/tasks/{id}`) or a register record (`/registers/{key}/records/{id}`, Q131). */
export interface SlotTarget { base: string; refresh: string[][] }
export const taskTarget = (task: Pick<TaskDetail, 'id' | 'site_id'>): SlotTarget => ({
  base: `/tasks/${task.id}`, refresh: [['task', task.id], ['task-slots', task.id], ['site-tasks', task.site_id], ['documents']],
});
export const recordTarget = (key: string, id: string): SlotTarget => ({
  base: `/registers/${key}/records/${id}`, refresh: [['record-slots', key, id], ['register-record', key, id], ['documents']],
});
const asTarget = (t: Pick<TaskDetail, 'id' | 'site_id'> | SlotTarget): SlotTarget => ('base' in t ? t : taskTarget(t));

function useRefresh(target: SlotTarget) {
  const qc = useQueryClient();
  return () => { for (const k of target.refresh) void qc.invalidateQueries({ queryKey: k }); };
}

/** One file into one slot; a slot that holds a single file takes the new one as the next version (`replaces_file_group_id`). */
export function useSlotUpload(owner: Pick<TaskDetail, 'id' | 'site_id'> | SlotTarget) {
  const target = asTarget(owner);
  const refresh = useRefresh(target);
  return useMutation<unknown, ApiError, { slot: DocumentSlot; file: File }>({
    mutationFn: ({ slot, file }) => {
      const f = new FormData();
      f.append('file', file);
      const cur = slot.files.filter((x) => x.is_current);
      if (slot.max_files === 1 && cur.length === 1) f.append('replaces_file_group_id', cur[0]!.file_group_id);
      return api.post(`${target.base}/slots/${slot.id}/files`, { body: f });
    },
    onSettled: refresh,
  });
}

export function useWithdrawFile(owner: Pick<TaskDetail, 'id' | 'site_id'> | SlotTarget) {
  const target = asTarget(owner);
  const refresh = useRefresh(target);
  return useMutation<DocumentSlot, ApiError, { slotId: string; fileId: string }>({ mutationFn: ({ slotId, fileId }) => api.del(`${target.base}/slots/${slotId}/files/${fileId}`), onSettled: refresh });
}

export function useAddSlot(owner: Pick<TaskDetail, 'id' | 'site_id'> | SlotTarget) {
  const target = asTarget(owner);
  const refresh = useRefresh(target);
  return useMutation<DocumentSlot, ApiError, { doc_code: string; candidate_label?: string | null }>({ mutationFn: (body) => api.post(`${target.base}/slots`, { body }), onSettled: refresh });
}

/** The slots of a register record (keyed on its logical record), the task it is the source of and what Submit still needs (Q131). */
export type RegisterRecordSlots = S['RegisterRecordSlots'];
export const useRecordSlots = (key: string, id: string | null) =>
  useQuery({ queryKey: ['record-slots', key, id], enabled: !!id, queryFn: () => api.get<RegisterRecordSlots>(`/registers/${key}/records/${id}/slots`) });

export const suggestSlots = (taskId: string, file_names: string[]) =>
  api.post<{ items: SlotSuggestion[] }>(`/tasks/${taskId}/slots/suggest`, { body: { file_names } }).then((r) => r.items);

/** Download one file; the server audits it and names it SITE_TASK_DOC_APPROVEDDATE.ext. */
export const downloadDocument = (fileId: string) => downloadFile(`/files/${fileId}/download`);

// ------------------------------------------------------------------------------------------------------------- the site Documents tab
export interface DocFilters {
  site_id?: string; stage_code?: string; task_code?: string; doc_code?: string; kind?: string; slot_status?: string; q?: string; include_superseded?: boolean;
}
export const useDocuments = (f: DocFilters) =>
  useQuery({
    queryKey: ['documents', f],
    queryFn: () => api.get<Page<DocumentListItem>>('/documents', { query: { ...f, limit: 200 } }).then((r) => r.items),
  });

/** Bulk zip: starts the job, polls it, then downloads the file (audited). Resolves with the downloaded name. */
export async function zipDownload(scope: ZipExportRequest, onStart?: (id: string) => void, wait = 500): Promise<string> {
  const job = await api.post<Job>('/exports/zip', { idempotencyKey: crypto.randomUUID(), body: scope });
  trackRealJob(job.id);
  onStart?.(job.id);
  for (let i = 0; i < 600; i++) {
    const j = await api.get<Job>(`/jobs/${job.id}`);
    if (j.status === 'failed') throw new ApiError(500, j.error ?? ({ type: 'about:blank', title: 'Export failed', status: 500, code: 'unknown' } as never));
    if (j.status === 'done') return downloadFile(`/exports/zip/${job.id}/download`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('export timeout');
}

// ------------------------------------------------------------------------------------------------------------- the Document Library (admin)
export interface LibFilters { kind?: string; placement_ref?: string; include_inactive?: boolean }
export const useLibrary = (f: LibFilters) =>
  useQuery({ queryKey: ['library', f], queryFn: () => api.get<Page<DocumentType>>('/document-library', { query: { ...f, limit: 200 } }).then((r) => r.items) });

export function useLibraryItem(id: string | null) {
  return useQuery({
    queryKey: ['library-item', id], enabled: !!id,
    queryFn: async () => { let etag = 0; const d = await api.get<DocumentType>(`/document-library/${id}`, { onHeaders: (h) => { etag = Number((h.get('ETag') ?? '').replace(/"/g, '')) || 0; } }); return { doc: d, etag: etag || d.version }; },
  });
}
export const useLibraryVersions = (id: string | null) =>
  useQuery({ queryKey: ['library-versions', id], enabled: !!id, queryFn: () => api.get<{ items: DocumentTypeVersion[] }>(`/document-library/${id}/versions`).then((r) => r.items) });

function useLibRefresh() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['library'] }); void qc.invalidateQueries({ queryKey: ['library-item'] }); void qc.invalidateQueries({ queryKey: ['library-versions'] }); };
}
export function useCreateDoc() {
  const refresh = useLibRefresh();
  return useMutation<DocumentType, ApiError, DocumentTypeInput>({ mutationFn: (body) => api.post('/document-library', { body }), onSettled: refresh });
}
export function useSaveDoc() {
  const refresh = useLibRefresh();
  return useMutation<DocumentType, ApiError, { id: string; version: number; patch: DocumentTypePatch }>({ mutationFn: ({ id, version, patch }) => api.patch(`/document-library/${id}`, { version, body: patch }), onSettled: refresh });
}
export function usePublishDoc() {
  const refresh = useLibRefresh();
  return useMutation<{ published_version: number; affected_open_tasks: number }, ApiError, { id: string; version: number; reason: string; effective_from: string; apply_to: 'new_only' | 'open_too' }>({
    mutationFn: ({ id, version, ...body }) => api.post(`/document-library/${id}/publish`, { version, body }), onSettled: refresh,
  });
}
export function useBlankForm() {
  const refresh = useLibRefresh();
  return useMutation<DocumentType, ApiError, { id: string; version: number; file: File; reason: string }>({
    mutationFn: ({ id, version, file, reason }) => { const f = new FormData(); f.append('file', file); f.append('reason', reason); return api.post(`/document-library/${id}/blank-form`, { version, body: f }); },
    onSettled: refresh,
  });
}
